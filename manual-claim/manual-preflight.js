/* Read-only planning and real eligibility checks for one reviewed manual claim. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createManualClaimPreflight = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (options) {
  'use strict';
  const { rpc, walletRead, ethers: E, policy: P, profile: F } = options;
  function stage(name, details = {}) { try { options.onStage?.(name, details); } catch (_) { /* Diagnostics never authorize or interrupt a check. */ } }
  function observedChain(kind, value) {
    if ((typeof value === 'string' && /^(?:0x[0-9a-f]{1,13}|[0-9]{1,15})$/i.test(value)) || Number.isSafeInteger(value))
      stage('CHAIN_ACCOUNT', { [kind]: BigInt(value).toString() });
    return value;
  }
  const fields = ['daiValue', 'capBps', 'burnedLgns', 'releasedDaiValue', 'claimedLgns', 'lastAccReleasedFrac', 'lastAccLgnsPerDai', 'depositTimestamp', 'mode'];
  const identityFields = ['daiValue', 'capBps', 'burnedLgns', 'depositTimestamp', 'mode'];
  const bond = new E.Interface([
    'function getUserDeposits(address) view returns (tuple(uint256 daiValue,uint256 capBps,uint256 burnedLgns,uint256 releasedDaiValue,uint256 claimedLgns,uint256 lastAccReleasedFrac,uint256 lastAccLgnsPerDai,uint256 depositTimestamp,uint8 mode)[])',
    'function getClaimable(address,uint256) view returns (uint256)',
    'function lgns() view returns (address)', 'function dai() view returns (address)', 'function treasury() view returns (address)'
  ]);
  const token = new E.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
  const abi = E.AbiCoder.defaultAbiCoder();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const need = (ok, code) => { if (!ok) fail(code); };
  const address = value => { need(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value), 'INVALID_ADDRESS'); return value.toLowerCase(); };
  const hashText = value => E.sha256(E.toUtf8Bytes(value));
  const hex = value => '0x' + BigInt(value).toString(16);
  function sourceCheck(source, canonical, head, startedWall, startedMono) {
    const now = Date.now(), elapsed = performance.now() - startedMono;
    const stamp = Number(BigInt(source.timestamp)) * 1000, headStamp = Number(BigInt(head.timestamp)) * 1000;
    need(canonical && canonical.hash === source.hash && canonical.number === source.number && canonical.timestamp === source.timestamp, 'SOURCE_REORG');
    need(stamp <= now + P.maxFutureSkewMs && headStamp <= now + P.maxFutureSkewMs, 'SOURCE_FUTURE');
    need(BigInt(head.number) >= BigInt(source.number) && headStamp >= stamp, 'HEAD_REGRESSED');
    need(now < stamp + P.quoteMaxAgeMs && headStamp - stamp < P.quoteMaxAgeMs && elapsed < P.quoteMaxAgeMs, 'SOURCE_EXPIRED');
    need(Math.abs((now - startedWall) - elapsed) <= P.maxFutureSkewMs, 'CLOCK_CHANGED');
    return stamp + P.quoteMaxAgeMs;
  }
  async function call(to, iface, name, args, tag) {
    return iface.decodeFunctionResult(name, await rpc('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag]))[0];
  }
  async function collect(expectedWallet) {
    const startedWall = Date.now(), startedMono = performance.now(), wallet = address(expectedWallet);
    stage('LOCAL_POLICY');
    need(P.chainId === '6714' && Number.isSafeInteger(P.quoteMaxAgeMs) && P.quoteMaxAgeMs > 0 && P.quoteMaxAgeMs <= 30000 &&
      Number.isSafeInteger(P.maxFutureSkewMs) && P.maxFutureSkewMs >= 0 && P.maxFutureSkewMs <= 2000, 'POLICY_CLOCK_INVALID');
    need(P.feeEvidence === 'scoped-pragmatic-fee-review-2026-11-11' &&
      typeof P.claimOtherApplicableFeeCapRaw === 'string' && /^\d+$/.test(P.claimOtherApplicableFeeCapRaw) &&
      typeof P.saleOtherApplicableFeeCapRaw === 'string' && /^\d+$/.test(P.saleOtherApplicableFeeCapRaw), 'OTHER_FEE_SCOPE_UNVERIFIED');
    need(P.planningCreditBps === 5000 && P.testedMinOutBps === 9900 && BigInt(P.planningRoundDownRaw) === 10n ** 16n &&
      F.hypothetical_eoa_swap_gas_limit === 1000000 && F.router_inner_call_gas_cap === 900000, 'VALUATION_POLICY_CHANGED');
    need(hashText(wallet) === P.walletCommitment, 'WALLET_OUTSIDE_APPROVED_TRIAL');
    need(P.profileHelperSha256 === '31b0f7a14a1e5915bc3c50d929adbccff6ee1b2febae6ff91bd84841cc8218be' &&
      F.chain_id === 6714 && F.version === 2 && F.helper_runtime_sha256 === P.profileHelperSha256 &&
      E.sha256(F.helper_runtime) === '0x' + P.profileHelperSha256, 'PROFILE_CHANGED');
    need(Object.keys(F.runtime_sha256_pins).length === 16 && Object.keys(F.eip1967_slot_pins).length === 6, 'PIN_SET_INCOMPLETE');
    for (const name of ['bond', 'lgns', 'dai']) need(address(F.addresses[name]) === address(P[name]), 'PROFILE_ADDRESS_CHANGED');
    stage('CHAIN_ACCOUNT');
    const initial = await Promise.all([rpc('eth_chainId').then(v => observedChain('rpcChainId', v)),
      walletRead('eth_chainId').then(v => observedChain('walletChainId', v)), walletRead('eth_accounts'), rpc('eth_getBlockByNumber', ['latest', false])]);
    need(BigInt(initial[0]) === 6714n && BigInt(initial[1]) === 6714n, 'CHAIN_MISMATCH');
    need(initial[2]?.length && address(initial[2][0]) === wallet, 'ACCOUNT_MISMATCH');
    const source = initial[3]; need(source && /^0x[0-9a-f]{64}$/i.test(source.hash), 'SOURCE_MISSING');
    sourceCheck(source, source, source, startedWall, startedMono);
    const tag = source.number;
    stage('SOURCE_PINS');
    await Promise.all([
      ...Object.entries(F.runtime_sha256_pins).map(async ([a, h]) => need(E.sha256(await rpc('eth_getCode', [a, tag])) === '0x' + h, 'RUNTIME_CHANGED')),
      ...Object.entries(F.eip1967_slot_pins).map(async ([a, h]) => need((await rpc('eth_getStorageAt', [a, F.eip1967_implementation_slot, tag])).toLowerCase() === h, 'IMPLEMENTATION_CHANGED'))
    ]);
    const control = '0x32a4586797e3f561f41c0f47ca57ed08d64f3dc0';
    stage('ORDERS_AND_FEE_LEDGER');
    const reads = await Promise.all([
      call(P.bond, bond, 'getUserDeposits', [wallet], tag), rpc('eth_getCode', [wallet, tag]),
      rpc('eth_getTransactionCount', [wallet, tag]), rpc('eth_getTransactionCount', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'pending']),
      rpc('eth_getBalance', [wallet, tag]), call(P.dai, token, 'balanceOf', [wallet], tag),
      rpc('eth_getBalance', [control, tag]), call(P.dai, token, 'balanceOf', [control], tag),
      call(P.lgns, token, 'decimals', [], tag), call(P.dai, token, 'decimals', [], tag),
      call(P.lgns, token, 'allowance', [wallet, F.addresses.router], tag), rpc('eth_gasPrice'),
      call(P.bond, bond, 'lgns', [], tag), call(P.bond, bond, 'dai', [], tag), call(P.bond, bond, 'treasury', [], tag),
      ...['0xb5fb0640', '0x440f3da3', '0xf4f9e5b6', '0xa07fa7a1'].map(data => rpc('eth_call', [{ to: P.bond, data }, tag]))
    ]);
    need(reads[1] === '0x', 'EOA_ONLY');
    need([reads[2], reads[3], reads[4]].every(n => BigInt(n) === BigInt(P.expectedNonce)), 'NONCE_CHANGED_OR_PENDING');
    need(BigInt(reads[5]) === reads[6] && BigInt(reads[7]) === reads[8] && reads[6] > 0n && reads[8] > 0n, 'FEE_LEDGER_MAPPING_CHANGED');
    need(reads[9] === 9n && reads[10] === 18n, 'DECIMALS_CHANGED');
    need(address(reads[13]) === P.lgns && address(reads[14]) === P.dai && address(reads[15]) === P.treasury, 'CONTRACT_RELATION_CHANGED');
    const records = reads[0].map(r => Object.fromEntries(fields.map(k => [k, r[k].toString()])));
    need(records.length === P.expectedOrderCount, 'ORDER_COUNT_CHANGED');
    const identities = records.map(r => identityFields.map(k => r[k]).join(':'));
    need(new Set(identities).size === identities.length, 'AMBIGUOUS_ORDER_IDENTITY');
    const wanted = identities.map((s, i) => hashText(s) === P.expectedOrderIdentityCommitment ? i : -1).filter(i => i >= 0);
    need(wanted.length === 1 && wanted[0] === P.validatedOrderIndex, 'VALIDATED_ORDER_MOVED_OR_MISSING');
    stage('REWARD_NET_MODEL');
    const claimables = await Promise.all(records.map((_, i) => call(P.bond, bond, 'getClaimable', [wallet, i], tag)));
    async function quote(index, minOut = 0n) {
      need(reads[11] >= claimables[index], 'MODEL_EXISTING_ALLOWANCE_INSUFFICIENT');
      const overrides = { [wallet]: { code: F.helper_runtime }, [P.bond]: { stateDiff: { ['0x' + '0'.repeat(62) + 'ae']: '0x' + '0'.repeat(64) } } };
      const raw = await rpc('eth_call', [{ from: wallet, to: wallet, gas: '0x7a1200', gasPrice: '0x0', value: '0x0', data: abi.encode(['uint256', 'uint256'], [minOut, index]) }, tag, overrides]);
      need(/^0x[0-9a-f]{128}$/i.test(raw), 'MODEL_RESPONSE_INVALID');
      const [claimed, out] = abi.decode(['uint256', 'uint256'], raw);
      need(claimed === claimables[index] && claimed > 0n && out > 0n, 'MODEL_AMOUNT_INVALID');
      return { index, claimed, out };
    }
    const models = await Promise.all(claimables.map((n, i) => n > 0n ? quote(i) : null));
    const ranked = models.filter(Boolean).sort((a, b) => a.out === b.out ? a.index - b.index : a.out > b.out ? -1 : 1);
    need(ranked.length > 0 && ranked[0].index === P.validatedOrderIndex, 'BEST_ORDER_OUTSIDE_VALIDATED_SCOPE');
    const best = ranked[0], testedMinOut = best.out * BigInt(P.testedMinOutBps) / 10000n;
    const repeat = await quote(best.index, testedMinOut); need(repeat.out === best.out, 'MODEL_NOT_DETERMINISTIC');
    const saleGasCap = BigInt(F.hypothetical_eoa_swap_gas_limit) * BigInt(P.maxGasPrice);
    const saleOther = BigInt(P.saleOtherApplicableFeeCapRaw), claimOther = BigInt(P.claimOtherApplicableFeeCapRaw);
    const afterSale = testedMinOut > saleGasCap + saleOther ? testedMinOut - saleGasCap - saleOther : 0n;
    const rounding = BigInt(P.planningRoundDownRaw);
    const minimumNet = (afterSale * BigInt(P.planningCreditBps) / 10000n) / rounding * rounding;
    const maximumFee = BigInt(P.gasLimit) * BigInt(P.maxGasPrice) + claimOther;
    const periodSecs = BigInt(reads[16]), cap = BigInt(reads[17]), storedPeriod = BigInt(reads[18]), storedUsed = BigInt(reads[19]);
    need(periodSecs > 0n && cap > 0n, 'TRIAL_REQUIRES_VERIFIED_QUOTA_PERIOD');
    const period = BigInt(source.timestamp) / periodSecs, used = storedPeriod === period ? storedUsed : 0n;
    need(used <= cap, 'INVALID_QUOTA');
    let remaining = cap - used;
    const blockers = [];
    if (best.claimed > remaining) blockers.push('GLOBAL_QUOTA_INSUFFICIENT');
    if (minimumNet <= 0n || maximumFee * 10n > minimumNet) blockers.push('FEE_OVER_TEN_PERCENT');
    if (BigInt(reads[12]) > BigInt(P.maxGasPrice)) blockers.push('OBSERVED_GAS_PRICE_ABOVE_FIXED_CAP');
    if (BigInt(reads[5]) < maximumFee) blockers.push('FEE_BALANCE_INSUFFICIENT');
    const transaction = { from: wallet, to: P.bond, chainId: '0x1a3a', type: '0x0', nonce: hex(P.expectedNonce),
      value: '0x0', data: '0x379607f5' + best.index.toString(16).padStart(64, '0'), gas: hex(P.gasLimit), gasPrice: hex(P.maxGasPrice) };
    let actualClaimCallPassed = false, gasEstimate = null;
    stage('LATEST_ELIGIBILITY');
    const post = await Promise.all([
      rpc('eth_getBlockByNumber', [tag, false]), rpc('eth_getBlockByNumber', ['latest', false]),
      walletRead('eth_chainId'), walletRead('eth_accounts'), rpc('eth_chainId'),
      rpc('eth_getTransactionCount', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'pending'])
    ]);
    need(BigInt(post[2]) === 6714n && BigInt(post[4]) === 6714n && post[3]?.length && address(post[3][0]) === wallet, 'POST_CHAIN_OR_ACCOUNT_CHANGED');
    need(BigInt(post[5]) === BigInt(P.expectedNonce) && BigInt(post[6]) === BigInt(P.expectedNonce), 'POST_NONCE_CHANGED');
    sourceCheck(source, post[0], post[1], startedWall, startedMono);
    // Pricing may take several blocks. Recheck real eligibility and pins at the
    // newest observed head rather than mistaking a 30-second price TTL for quota.
    const eligibilityHead = post[1], currentTag = eligibilityHead.number;
    await Promise.all([
      ...Object.entries(F.runtime_sha256_pins).map(async ([a, h]) => need(E.sha256(await rpc('eth_getCode', [a, currentTag])) === '0x' + h, 'LATEST_RUNTIME_CHANGED')),
      ...Object.entries(F.eip1967_slot_pins).map(async ([a, h]) => need((await rpc('eth_getStorageAt', [a, F.eip1967_implementation_slot, currentTag])).toLowerCase() === h, 'LATEST_IMPLEMENTATION_CHANGED'))
    ]);
    const current = await Promise.all([
      ...['0xb5fb0640', '0x440f3da3', '0xf4f9e5b6', '0xa07fa7a1'].map(data => rpc('eth_call', [{ to: P.bond, data }, currentTag])),
      call(P.bond, bond, 'getUserDeposits', [wallet], currentTag), call(P.bond, bond, 'getClaimable', [wallet, best.index], currentTag),
      rpc('eth_getBalance', [wallet, currentTag]), call(P.dai, token, 'balanceOf', [wallet], currentTag),
      ...['lgns', 'dai', 'treasury'].map(name => call(P.bond, bond, name, [], currentTag)), rpc('eth_gasPrice')
    ]);
    need(BigInt(current[0]) === periodSecs && BigInt(current[1]) === cap, 'QUOTA_CONFIGURATION_CHANGED');
    const currentPeriod = BigInt(eligibilityHead.timestamp) / periodSecs;
    if (currentPeriod !== period) blockers.push('PERIOD_CHANGED_PREPARE_NEW_CARD');
    const currentUsed = BigInt(current[2]) === currentPeriod ? BigInt(current[3]) : 0n;
    need(currentUsed <= cap, 'LATEST_QUOTA_INVALID'); remaining = cap - currentUsed;
    if (best.claimed > remaining && !blockers.includes('GLOBAL_QUOTA_INSUFFICIENT')) blockers.push('GLOBAL_QUOTA_INSUFFICIENT');
    const latestIdentity = current[4][best.index] && identityFields.map(k => current[4][best.index][k].toString()).join(':');
    need(current[4].length === records.length && latestIdentity === identities[best.index] && current[5] === best.claimed, 'LATEST_ORDER_OR_AMOUNT_CHANGED');
    need(BigInt(current[6]) === current[7] && current[7] >= maximumFee, 'LATEST_FEE_LEDGER_CHANGED');
    need(address(current[8]) === P.lgns && address(current[9]) === P.dai && address(current[10]) === P.treasury, 'LATEST_CONTRACT_RELATION_CHANGED');
    if (BigInt(current[11]) > BigInt(P.maxGasPrice) && !blockers.includes('OBSERVED_GAS_PRICE_ABOVE_FIXED_CAP')) blockers.push('OBSERVED_GAS_PRICE_ABOVE_FIXED_CAP');
    // No override on this actual claim or its estimate. The wallet may remain
    // open afterwards; its human confirmation cannot be made atomic with quota.
    if (blockers.length === 0) {
      const txCall = Object.fromEntries(Object.entries(transaction).filter(([k]) => !['nonce', 'type', 'chainId'].includes(k)));
      try {
        await rpc('eth_call', [txCall, currentTag]); actualClaimCallPassed = true;
        gasEstimate = BigInt(await rpc('eth_estimateGas', [txCall, currentTag]));
        if (gasEstimate > BigInt(P.gasLimit)) blockers.push('GAS_ESTIMATE_EXCEEDS_FIXED_LIMIT');
      } catch (_) { blockers.push('REAL_CLAIM_SIMULATION_FAILED'); }
    }
    stage('FINAL_STATE');
    const final = await Promise.all([rpc('eth_getBlockByNumber', [currentTag, false]), rpc('eth_getBlockByNumber', ['latest', false]),
      walletRead('eth_chainId'), walletRead('eth_accounts'), rpc('eth_getTransactionCount', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'pending']),
      rpc('eth_getBlockByNumber', [tag, false])]);
    need(final[0]?.hash === eligibilityHead.hash && final[0]?.timestamp === eligibilityHead.timestamp, 'LATEST_ELIGIBILITY_REORG');
    need(BigInt(final[2]) === 6714n && final[3]?.length && address(final[3][0]) === wallet, 'FINAL_WALLET_CHANGED');
    need(BigInt(final[4]) === BigInt(P.expectedNonce) && BigInt(final[5]) === BigInt(P.expectedNonce), 'FINAL_NONCE_CHANGED');
    if (BigInt(final[1].timestamp) / periodSecs !== period && !blockers.includes('PERIOD_CHANGED_PREPARE_NEW_CARD')) blockers.push('PERIOD_CHANGED_PREPARE_NEW_CARD');
    const validUntilMs = sourceCheck(source, final[6], final[1], startedWall, startedMono);
    return Object.freeze({ wallet, transaction: Object.freeze(transaction), period: period.toString(), orderIndex: best.index,
      orderIdentity: identities[best.index], claimableRaw: best.claimed.toString(), minimumNetRaw: minimumNet.toString(), maxFeeRaw: maximumFee.toString(),
      sourceBlock: Object.freeze({ number: source.number, hash: source.hash, timestamp: source.timestamp }), validUntilMs,
      eligible: blockers.length === 0, blockers: Object.freeze(blockers),
      checks: Object.freeze({ runtimePins: Object.keys(F.runtime_sha256_pins).length, implementationPins: Object.keys(F.eip1967_slot_pins).length,
        feeEvidenceScope: P.feeScope, claimOtherFeeCapRaw: claimOther.toString(), saleOtherFeeCapRaw: saleOther.toString(),
        modelOutputRaw: best.out.toString(), testedMinOutRaw: testedMinOut.toString(), hypotheticalSaleGasCapRaw: saleGasCap.toString(),
        planningCreditBps: P.planningCreditBps, futurePriceGuaranteed: false, actualClaimCallPassed,
        realEligibilityBlock: { number: currentTag, hash: eligibilityHead.hash, timestamp: eligibilityHead.timestamp },
        gasEstimate: gasEstimate === null ? null : gasEstimate.toString(), feeLedgerBalanceRaw: reads[6].toString(),
        quotaRemainingRaw: remaining.toString(), quotaWindowSeconds: periodSecs.toString(),
        nextQuotaPeriodTimestamp: ((period + 1n) * periodSecs).toString(), netRankedOrderIndices: ranked.map(q => q.index),
        knownMaximumFeeWithinTenPercent: minimumNet > 0n && maximumFee * 10n <= minimumNet,
        originalEOA: true, fixedNonce: P.expectedNonce, actualSwapRequested: false })
    });
  }
  return Object.freeze({ collect });
});
