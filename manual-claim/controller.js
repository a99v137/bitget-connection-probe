/* One explicit Bitget sign-and-send request. No timer, retry, presigning, or backend. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createManualClaimController = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (options) {
  'use strict';
  const { provider, preflight, rpc, ethers: E, policy: P, storage, locks, onState = () => {}, now = Date.now,
    walletRequestTimeoutMs = 90000, setTimer = setTimeout, clearTimer = clearTimeout } = options;
  const BOND = '0x11b10c9827c5b7071e96fcaa143b4e6e86b17c69', SELECTOR = '0x379607f5';
  const TX_FIELDS = ['from', 'to', 'chainId', 'type', 'nonce', 'value', 'data', 'gas', 'gasPrice'];
  const KEY = 'anubis-manual-one-shot:v1:' + String(P.walletCommitment).toLowerCase();
  let busy = false, stopped = false, walletRequested = false, card = null, record = null, releaseUnknownWait = null;
  class ManualError extends Error { constructor(code) { super(code); this.name = 'ManualError'; this.code = code; } }
  // Exact reviewed public diagnostic codes only. Never forward arbitrary provider/RPC messages or payloads.
  const SAFE_PUBLIC_CODES = new Set([
    'ACCOUNT_MISMATCH', 'AMBIGUOUS_ORDER_IDENTITY', 'BEST_ORDER_OUTSIDE_VALIDATED_SCOPE', 'CHAIN_MISMATCH', 'CLOCK_CHANGED',
    'CONTRACT_RELATION_CHANGED', 'DECIMALS_CHANGED', 'EOA_ONLY', 'FEE_BALANCE_INSUFFICIENT', 'FEE_LEDGER_MAPPING_CHANGED',
    'FEE_OVER_TEN_PERCENT', 'FINAL_NONCE_CHANGED', 'FINAL_WALLET_CHANGED', 'GAS_ESTIMATE_EXCEEDS_FIXED_LIMIT',
    'GLOBAL_QUOTA_INSUFFICIENT', 'HEAD_REGRESSED', 'IMPLEMENTATION_CHANGED', 'INVALID_ADDRESS', 'INVALID_QUOTA',
    'LATEST_CONTRACT_RELATION_CHANGED', 'LATEST_ELIGIBILITY_REORG', 'LATEST_FEE_LEDGER_CHANGED', 'LATEST_IMPLEMENTATION_CHANGED',
    'LATEST_ORDER_OR_AMOUNT_CHANGED', 'LATEST_QUOTA_INVALID', 'LATEST_RUNTIME_CHANGED', 'MODEL_AMOUNT_INVALID',
    'MODEL_EXISTING_ALLOWANCE_INSUFFICIENT', 'MODEL_NOT_DETERMINISTIC', 'MODEL_RESPONSE_INVALID', 'NONCE_CHANGED_OR_PENDING',
    'OBSERVED_GAS_PRICE_ABOVE_FIXED_CAP', 'ORDER_COUNT_CHANGED', 'OTHER_FEE_SCOPE_UNVERIFIED', 'PERIOD_CHANGED_PREPARE_NEW_CARD',
    'PIN_SET_INCOMPLETE', 'POLICY_CLOCK_INVALID', 'POST_CHAIN_OR_ACCOUNT_CHANGED', 'POST_NONCE_CHANGED', 'PROFILE_ADDRESS_CHANGED',
    'PROFILE_CHANGED', 'QUOTA_CONFIGURATION_CHANGED', 'REAL_CLAIM_SIMULATION_FAILED', 'RUNTIME_CHANGED', 'SOURCE_EXPIRED',
    'SOURCE_FUTURE', 'SOURCE_MISSING', 'SOURCE_REORG', 'TRIAL_REQUIRES_VERIFIED_QUOTA_PERIOD', 'VALIDATED_ORDER_MOVED_OR_MISSING',
    'VALUATION_POLICY_CHANGED', 'WALLET_OUTSIDE_APPROVED_TRIAL', 'READ_QUERY_FAILED_OR_UNKNOWN', 'READ_ONLY_RPC_REJECTED', 'READ_BATCH_RESPONSE_INVALID',
    'BITGET_PROVIDER_REQUIRED', 'SECURE_CONTEXT_AND_LOCKS_REQUIRED', 'WALLET_READ_REJECTED'
  ]);
  function safeErrorCode(error, fallback) {
    if (error instanceof ManualError) return error.code;
    if (error?.code === 4001 || error?.code === '4001') return 'CONNECTION_REJECTED';
    for (const candidate of [error?.code, error?.message]) if (typeof candidate === 'string' && SAFE_PUBLIC_CODES.has(candidate)) return candidate;
    return fallback;
  }
  const must = (ok, code) => { if (!ok) throw new ManualError(code); };
  function uint(value) { must(typeof value === 'bigint' || (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)), 'INVALID_UINT'); const n = BigInt(value); must(n >= 0n, 'INVALID_UINT'); return n; }
  function address(value) { must(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value), 'INVALID_ADDRESS'); return value.toLowerCase(); }
  function hash(value) { must(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value), 'INVALID_HASH'); return value.toLowerCase(); }
  const commitment = text => E.sha256(E.toUtf8Bytes(text));
  function jsonCopy(value) { return JSON.parse(JSON.stringify(value)); }
  function emit(kind, detail = {}) { onState(Object.freeze({ kind, stopped, walletRequested, ...detail })); }
  function txFields(tx) {
    must(tx && typeof tx === 'object' && Object.keys(tx).every(k => TX_FIELDS.includes(k)) && TX_FIELDS.every(k => Object.prototype.hasOwnProperty.call(tx, k)), 'TRANSACTION_FIELDS_MISSING');
    const out = { from: address(tx.from), to: address(tx.to) };
    for (const key of ['chainId', 'type', 'nonce', 'value', 'gas', 'gasPrice']) out[key] = '0x' + uint(tx[key]).toString(16);
    must(typeof tx.data === 'string' && /^0x379607f5[0-9a-f]{64}$/i.test(tx.data), 'CLAIM_CALLDATA_REQUIRED'); out.data = tx.data.toLowerCase();
    must(out.to === BOND && uint(out.chainId) === 6714n && uint(out.type) === 0n && uint(out.value) === 0n, 'TRANSACTION_SCOPE_MISMATCH');
    must(uint(out.nonce) === uint(P.expectedNonce) && uint(out.gas) === uint(P.gasLimit) && uint(out.gasPrice) > 0n && uint(out.gasPrice) <= uint(P.maxGasPrice), 'TRANSACTION_FEE_OR_NONCE_MISMATCH');
    must(out.data === SELECTOR + '0'.repeat(64), 'ONLY_VALIDATED_ORDER_ZERO');
    must(commitment(out.from) === hash(P.walletCommitment), 'WALLET_COMMITMENT_MISMATCH');
    return Object.freeze(out);
  }
  function clockValid(snapshot) {
    const time = now(), sourceTime = Number(uint(snapshot.sourceBlock.timestamp)) * 1000;
    const until = Number(uint(String(snapshot.validUntilMs)));
    must(Number.isSafeInteger(sourceTime) && Number.isSafeInteger(until), 'SOURCE_CLOCK_INVALID');
    must(sourceTime <= time + P.maxFutureSkewMs && time < until && until <= sourceTime + P.quoteMaxAgeMs, 'REVIEW_EXPIRED');
    return until;
  }
  function reviewClockValid(value) {
    const created = Number(uint(value.reviewCreatedAtMs)), until = Number(uint(value.reviewValidUntilMs)), time = now();
    must(Number.isSafeInteger(created) && Number.isSafeInteger(until) && until > created && until - created <= 300000 && time + P.maxFutureSkewMs >= created && time < until, 'REVIEW_APPROVAL_EXPIRED');
    return until;
  }
  function makeCard(snapshot, wallet) {
    must(snapshot && snapshot.eligible === true && Array.isArray(snapshot.blockers) && snapshot.blockers.length === 0, 'PREFLIGHT_BLOCKED');
    const tx = txFields(snapshot.transaction); must(tx.from === address(wallet) && address(snapshot.wallet) === tx.from, 'PREFLIGHT_WALLET_MISMATCH');
    must(uint(snapshot.orderIndex) === 0n && typeof snapshot.orderIdentity === 'string' && commitment(snapshot.orderIdentity) === hash(P.expectedOrderIdentityCommitment), 'ORDER_IDENTITY_MISMATCH');
    const period = uint(snapshot.period).toString(), claimableRaw = uint(snapshot.claimableRaw).toString(), minimumNetRaw = uint(snapshot.minimumNetRaw).toString(), maxFeeRaw = uint(snapshot.maxFeeRaw).toString();
    must(uint(claimableRaw) > 0n && uint(minimumNetRaw) > 0n && uint(maxFeeRaw) >= uint(tx.gas) * uint(tx.gasPrice) && uint(maxFeeRaw) * 10n <= uint(minimumNetRaw), 'TEN_PERCENT_POLICY_FAILED');
    const sourceBlock = { number: '0x' + uint(snapshot.sourceBlock.number).toString(16), hash: hash(snapshot.sourceBlock.hash), timestamp: uint(snapshot.sourceBlock.timestamp).toString() };
    const body = { wallet: tx.from, transaction: tx, period, orderIdentity: snapshot.orderIdentity, orderIndex: '0', claimableRaw, minimumNetRaw, maxFeeRaw };
    must(Number.isSafeInteger(P.reviewMaxAgeMs) && P.reviewMaxAgeMs > 0 && P.reviewMaxAgeMs <= 300000, 'REVIEW_POLICY_INVALID');
    return Object.freeze({ ...body, reviewDigest: commitment(JSON.stringify(body)), sourceBlock, validUntilMs: String(clockValid(snapshot)),
      reviewCreatedAtMs: String(now()), reviewValidUntilMs: String(now() + P.reviewMaxAgeMs) });
  }
  function checkedRecord(value) {
    const allowed = ['version', 'scope', 'walletCommitment', 'state', 'txHash', 'card', 'requestedAtMs', 'updatedAtMs', 'lastStatusCode', 'confirmations', 'receiptGasFeeRaw', 'claimedLGNSRaw'];
    must(value && Object.keys(value).every(key => allowed.includes(key)) && value.version === 1 && value.scope === 'manual-one-shot', 'JOURNAL_CORRUPT');
    must(hash(value.walletCommitment) === hash(P.walletCommitment), 'JOURNAL_WALLET_MISMATCH');
    must(['wallet_requested_unknown', 'pending', 'confirmed_success', 'confirmed_failure', 'mined_unverified'].includes(value.state), 'JOURNAL_STATE_INVALID');
    const cardKeys = ['wallet', 'transaction', 'period', 'orderIdentity', 'orderIndex', 'claimableRaw', 'minimumNetRaw', 'maxFeeRaw', 'reviewDigest', 'sourceBlock', 'validUntilMs', 'reviewCreatedAtMs', 'reviewValidUntilMs', 'handoffValidUntilMs', 'handoffSourceBlock'];
    must(value.card && Object.keys(value.card).every(key => cardKeys.includes(key)), 'JOURNAL_CARD_FIELDS_INVALID');
    must(value.card.sourceBlock && Object.keys(value.card.sourceBlock).every(key => ['number', 'hash', 'timestamp'].includes(key)), 'JOURNAL_BLOCK_FIELDS_INVALID');
    if (value.card.handoffSourceBlock) must(Object.keys(value.card.handoffSourceBlock).every(key => ['number', 'hash', 'timestamp'].includes(key)), 'JOURNAL_HANDOFF_BLOCK_FIELDS_INVALID');
    must(value.card && txFields(value.card.transaction).nonce === '0x' + uint(P.expectedNonce).toString(16), 'JOURNAL_NONCE_MISMATCH');
    if (value.txHash !== null) hash(value.txHash);
    return jsonCopy(value);
  }
  function loadRecord() {
    try { const text = storage.getItem(KEY); return text === null ? null : checkedRecord(JSON.parse(text)); }
    catch (_) { throw new ManualError('JOURNAL_CORRUPT_OR_UNAVAILABLE_STOP'); }
  }
  function persist(next) {
    const safe = checkedRecord(next), text = JSON.stringify(safe);
    try { storage.setItem(KEY, text); must(storage.getItem(KEY) === text, 'JOURNAL_WRITE_NOT_CONFIRMED'); }
    catch (_) { throw new ManualError('JOURNAL_WRITE_FAILED_NO_WALLET_REQUEST'); }
    record = safe; return safe;
  }
  async function exclusive(wallet, run) {
    must(locks && typeof locks.request === 'function', 'WEB_LOCKS_REQUIRED');
    return locks.request('anubis-wallet:6714:' + address(wallet), { mode: 'exclusive', ifAvailable: true }, async lock => {
      must(lock, 'WALLET_BUSY_IN_ANOTHER_TAB'); return run();
    });
  }
  function markWalletUnknown(code) {
    let current = record;
    try { current = loadRecord() || record; } catch (_) {}
    if (current) {
      const state = current.txHash ? (current.state === 'wallet_requested_unknown' ? 'pending' : current.state) : 'wallet_requested_unknown';
      const next = { ...current, state, updatedAtMs: String(now()), lastStatusCode: code };
      record = checkedRecord(next); // Retain known hash in memory even if persistent storage has failed.
      try { persist(next); } catch (_) {}
    }
    emit('wallet_requested_unknown', { record: record ? jsonCopy(record) : null, code });
    return record ? jsonCopy(record) : null;
  }
  async function requestWalletOnce(approved) {
    let timer = null, settleUnknown;
    const unknownSignal = new Promise(resolve => { settleUnknown = resolve; });
    releaseUnknownWait = code => { const saved = markWalletUnknown(code); settleUnknown(saved); };
    timer = setTimer(() => releaseUnknownWait?.('WALLET_REQUEST_TIMEOUT_UNKNOWN_NO_RETRY'), walletRequestTimeoutMs);
    const providerOutcome = (async () => {
      try {
        must(!stopped, 'STOPPED_BEFORE_WALLET_HANDOFF');
        // Exactly one call. The wallet may sign and broadcast inside this request.
        const response = await provider.request({ method: 'eth_sendTransaction', params: [jsonCopy(approved.transaction)] });
        const txHash = hash(response);
        let current = record;
        try { current = loadRecord() || record; } catch (_) {}
        must(current && (current.txHash === null || current.txHash === txHash), 'LATE_WALLET_HASH_CONFLICT_STOP');
        const next = { ...current, txHash, state: current.txHash === null ? 'pending' : current.state, updatedAtMs: String(now()),
          lastStatusCode: stopped ? 'HASH_RECEIVED_AFTER_LOCAL_STOP' : 'WALLET_HASH_RECEIVED' };
        record = checkedRecord(next); persist(next);
        emit(record.state, { record: jsonCopy(record) }); return jsonCopy(record);
      } catch (_) { return markWalletUnknown('WALLET_OUTCOME_UNKNOWN_NO_RETRY'); }
    })();
    try { return await Promise.race([providerOutcome, unknownSignal]); }
    finally { clearTimer(timer); releaseUnknownWait = null; }
    // providerOutcome remains observed after a timeout/stop; a late hash is persisted and never causes another send.
  }
  function noPreviousRequest() {
    const saved = loadRecord(); if (saved) record = saved;
    must(!walletRequested && !record, 'ONE_SHOT_ALREADY_REQUESTED_CHECK_STATUS');
  }
  async function prepare(walletInput) {
    must(!busy && !stopped, 'CONTROLLER_BUSY_OR_STOPPED'); noPreviousRequest();
    const wallet = address(walletInput); must(commitment(wallet) === hash(P.walletCommitment), 'WALLET_COMMITMENT_MISMATCH');
    busy = true; card = null; emit('preparing');
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts', params: [] });
      must(Array.isArray(accounts) && accounts.length && address(accounts[0]) === wallet, 'CONNECTED_ACCOUNT_MISMATCH');
      return await exclusive(wallet, async () => {
        noPreviousRequest(); const snapshot = await preflight.collect(wallet); must(!stopped, 'STOPPED_BEFORE_REQUEST');
        if (!snapshot.eligible) { emit('blocked', { snapshot: jsonCopy(snapshot) }); return { eligible: false, snapshot: jsonCopy(snapshot) }; }
        card = makeCard(snapshot, wallet); emit('prepared', { card: jsonCopy(card), executionEnabled: P.executionEnabled === true });
        return { eligible: true, card: jsonCopy(card) };
      });
    } catch (error) { card = null; const code = safeErrorCode(error, 'PREPARATION_FAILED'); emit('error', { code }); throw new ManualError(code); }
    finally { busy = false; }
  }
  async function sendApproved({ acknowledged, reviewDigest }) {
    must(P.executionEnabled === true, 'MANUAL_EXECUTION_DISABLED');
    must(!busy && !stopped && card, 'NO_READY_REVIEW_CARD'); must(acknowledged === true && hash(reviewDigest) === card.reviewDigest, 'EXPLICIT_SIGN_AND_SEND_ACK_REQUIRED');
    noPreviousRequest(); reviewClockValid(card); busy = true; const approved = card;
    try {
      return await exclusive(approved.wallet, async () => {
        noPreviousRequest(); must(!stopped, 'STOPPED_BEFORE_REQUEST');
        const fresh = makeCard(await preflight.collect(approved.wallet), approved.wallet);
        const exact = JSON.stringify(fresh.transaction) === JSON.stringify(approved.transaction) && fresh.period === approved.period && fresh.orderIdentity === approved.orderIdentity && fresh.orderIndex === approved.orderIndex && fresh.claimableRaw === approved.claimableRaw && fresh.maxFeeRaw === approved.maxFeeRaw;
        must(exact && uint(fresh.minimumNetRaw) >= uint(approved.minimumNetRaw), 'CARD_CHANGED_PREPARE_NEW_CARD');
        reviewClockValid(approved); clockValid(fresh); must(!stopped, 'STOPPED_BEFORE_REQUEST');
        const handoffCard = { ...approved, handoffValidUntilMs: fresh.validUntilMs, handoffSourceBlock: fresh.sourceBlock };
        persist({ version: 1, scope: 'manual-one-shot', walletCommitment: hash(P.walletCommitment), state: 'wallet_requested_unknown', txHash: null,
          card: jsonCopy(handoffCard), requestedAtMs: String(now()), updatedAtMs: String(now()), lastStatusCode: 'WALLET_REQUEST_MAY_SIGN_AND_BROADCAST' });
        walletRequested = true; card = null; emit('wallet_requested_unknown', { record: jsonCopy(record) });
        return requestWalletOnce(approved);
      });
    } catch (error) { if (!walletRequested) card = null; const code = safeErrorCode(error, 'FINAL_PREFLIGHT_FAILED'); emit('error', { code }); throw new ManualError(code); }
    finally { busy = false; }
  }
  function matchesReturnedTx(tx, expected, expectedHash) {
    must(tx && hash(tx.hash) === hash(expectedHash), 'RPC_TRANSACTION_UNAVAILABLE_OR_HASH_MISMATCH');
    const actual = txFields({ from: tx.from, to: tx.to, chainId: tx.chainId, type: tx.type, nonce: tx.nonce, value: tx.value, data: tx.input, gas: tx.gas, gasPrice: tx.gasPrice });
    must(JSON.stringify(actual) === JSON.stringify(expected), 'WALLET_TRANSACTION_DIFFERS_FROM_APPROVED_CARD');
    return true;
  }
  function verifiedClaim(receipt, expected) {
    // Observed current-runtime treasury payout schema. Its official event name is unverified.
    const payoutTopic = '0x889d364b5102aee044ff370e2e6a836584e5618a16dce4f5b191459cf3903e58';
    const transferTopic = E.id('Transfer(address,address,uint256)');
    const wallet = address(expected.wallet), token = address(P.lgns), treasury = address(P.treasury);
    const topicAddress = value => { must(typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value), 'NONCANONICAL_EVENT_ADDRESS'); return address('0x' + value.slice(-40)); };
    let paid = 0n, transferred = 0n;
    for (const log of receipt.logs || []) {
      try {
        if (log.removed === true) continue;
        if (!Array.isArray(log.topics) || !/^0x[0-9a-f]{64}$/i.test(log.data)) continue;
        if (address(log.address) === treasury && log.topics.length === 4 && hash(log.topics[0]) === payoutTopic
          && topicAddress(log.topics[1]) === token && topicAddress(log.topics[2]) === wallet && topicAddress(log.topics[3]) === BOND) paid += uint(log.data);
        if (address(log.address) === token && log.topics.length === 3 && hash(log.topics[0]) === transferTopic
          && topicAddress(log.topics[1]) === treasury && topicAddress(log.topics[2]) === wallet) transferred += uint(log.data);
      } catch (_) { /* unrelated or malformed logs cannot establish success */ }
    }
    must(paid > 0n && paid >= uint(expected.claimableRaw) && transferred === paid, 'SUCCESS_RECEIPT_PAYOUT_OR_TRANSFER_UNVERIFIED'); return paid;
  }
  async function checkStatus(manualHash = '') {
    must(!busy, 'CONTROLLER_BUSY'); record = loadRecord(); must(record, 'NO_ATTEMPT_JOURNAL'); busy = true;
    let observedMinedReceipt = false;
    try {
      return await exclusive(record.card.wallet, async () => {
        let queryHash = record.txHash;
        const pasted = String(manualHash).trim(); if (pasted) {
          const txHash = hash(pasted); must(record.txHash === null || record.txHash === txHash, 'HASH_CONFLICT_STOP');
          queryHash = txHash; // Do not bind an unverified pasted hash to the attempt.
        }
        const [chain, latestNonce, pendingNonce] = await Promise.all([rpc('eth_chainId', []), rpc('eth_getTransactionCount', [record.card.wallet, 'latest']), rpc('eth_getTransactionCount', [record.card.wallet, 'pending'])]);
        must(uint(chain) === 6714n, 'RPC_CHAIN_MISMATCH');
        const observation = { latestNonce: uint(latestNonce).toString(), pendingNonce: uint(pendingNonce).toString(), nonceAloneProvesSuccess: false };
        if (!queryHash) { emit('wallet_requested_unknown', { record: jsonCopy(record), observation }); return { record: jsonCopy(record), observation }; }
        const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [queryHash]), rpc('eth_getTransactionReceipt', [queryHash])]);
        if (!tx) {
          if (['confirmed_success', 'confirmed_failure'].includes(record.state)) persist({ ...record, state: 'mined_unverified', updatedAtMs: String(now()), lastStatusCode: 'PREVIOUSLY_CONFIRMED_TRANSACTION_NOT_VISIBLE' });
          emit('status_unverified', { record: jsonCopy(record), observation, code: 'TRANSACTION_NOT_VISIBLE_NO_RETRY' }); return { record: jsonCopy(record), observation };
        }
        matchesReturnedTx(tx, record.card.transaction, queryHash);
        if (record.txHash === null) persist({ ...record, txHash: queryHash, state: 'pending', updatedAtMs: String(now()), lastStatusCode: 'USER_HASH_TRANSACTION_FIELDS_VERIFIED' });
        if (!receipt) {
          const state = ['confirmed_success', 'confirmed_failure', 'mined_unverified'].includes(record.state) ? 'mined_unverified' : 'pending';
          persist({ ...record, state, updatedAtMs: String(now()), lastStatusCode: state === 'mined_unverified' ? 'PREVIOUS_RECEIPT_NO_LONGER_VISIBLE' : 'TRANSACTION_SEEN_RECEIPT_PENDING' });
          emit(state === 'mined_unverified' ? 'status_unverified' : 'pending', { record: jsonCopy(record), observation, code: state === 'mined_unverified' ? 'RECEIPT_MISSING_RECHECK_NO_RETRY' : 'RECEIPT_PENDING' }); return { record: jsonCopy(record), observation };
        }
        observedMinedReceipt = true;
        must(hash(receipt.transactionHash) === record.txHash && uint(receipt.blockNumber) === uint(tx.blockNumber) && hash(receipt.blockHash) === hash(tx.blockHash), 'RECEIPT_TRANSACTION_MISMATCH');
        const [canonical, latest] = await Promise.all([rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', ['latest', false])]);
        must(canonical && hash(canonical.hash) === hash(receipt.blockHash) && uint(latest.number) >= uint(receipt.blockNumber), 'RECEIPT_REORG_OR_HEIGHT_UNKNOWN');
        const confirmations = uint(latest.number) - uint(receipt.blockNumber) + 1n;
        if (confirmations < BigInt(P.confirmations)) { emit('pending', { record: jsonCopy(record), observation, confirmations: confirmations.toString(), code: 'WAIT_MORE_CANONICAL_BLOCKS_MANUAL_CHECK' }); return { record: jsonCopy(record), observation, confirmations: confirmations.toString() }; }
        const status = uint(receipt.status); must(status === 0n || status === 1n, 'RECEIPT_STATUS_UNKNOWN');
        const gasFee = uint(receipt.gasUsed) * uint(receipt.effectiveGasPrice); must(gasFee <= uint(record.card.maxFeeRaw), 'RECEIPT_GAS_FEE_OVER_APPROVED_MAX');
        let claimed = null; if (status === 1n) claimed = verifiedClaim(receipt, record.card);
        persist({ ...record, state: status === 1n ? 'confirmed_success' : 'confirmed_failure', updatedAtMs: String(now()), confirmations: confirmations.toString(),
          receiptGasFeeRaw: gasFee.toString(), claimedLGNSRaw: claimed === null ? '0' : claimed.toString(), lastStatusCode: status === 1n ? 'TREASURY_PAYOUT_AND_TRANSFER_VERIFIED' : 'ONCHAIN_FAILED_PERIOD_CONSUMED' });
        emit(record.state, { record: jsonCopy(record), observation }); return { record: jsonCopy(record), observation };
      });
    } catch (error) {
      if (record && (observedMinedReceipt || ['confirmed_success', 'confirmed_failure'].includes(record.state))) {
        try { persist({ ...record, state: 'mined_unverified', updatedAtMs: String(now()), lastStatusCode: 'MINED_RESULT_REQUIRES_REVERIFICATION' }); } catch (_) {}
      }
      emit('status_unverified', { code: error instanceof ManualError ? error.code : 'STATUS_QUERY_UNKNOWN_NO_RETRY', record: record ? jsonCopy(record) : null }); throw new ManualError(error instanceof ManualError ? error.code : 'STATUS_QUERY_UNKNOWN_NO_RETRY'); }
    finally { busy = false; }
  }
  function stop() { stopped = true; card = null;
    if (releaseUnknownWait) releaseUnknownWait('LOCAL_STOP_OUTCOME_UNKNOWN_NOT_CANCELLED');
    else emit(record ? 'wallet_requested_unknown' : 'stopped', { record: record ? jsonCopy(record) : null, code: 'LOCAL_STOP_DOES_NOT_CANCEL_WALLET_OR_REVOKE_TRANSACTION' }); }
  record = loadRecord(); if (record) { walletRequested = true; emit('restored_attempt', { record: jsonCopy(record) }); }
  return Object.freeze({ prepare, sendApproved, checkStatus, stop, getState: () => ({ busy, stopped, walletRequested, card: card ? jsonCopy(card) : null, record: record ? jsonCopy(record) : null }),
    helpers: Object.freeze({ makeCard, txFields, matchesReturnedTx, verifiedClaim }) });
});
