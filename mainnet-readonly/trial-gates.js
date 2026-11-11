/* Readable candidate policy. Production execution is deliberately unavailable. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnubisTrialGates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAINNET_EXECUTION_ENABLED = false;
  const BROADCAST_ENABLED = false;
  const CHAIN_ID = 6714n;
  const BOND = '0x11b10c9827c5b7071e96fcaa143b4e6e86b17c69';
  const CLAIM_SELECTOR = '0x379607f5';
  const IDENTITY_FIELDS = ['daiValue', 'capBps', 'burnedLgns', 'depositTimestamp', 'mode'];
  const UNRESOLVED = new Set(['reserved', 'sign_requested', 'signed', 'armed', 'broadcast_unknown', 'pending']);
  const TERMINAL = new Set(['confirmed_success', 'confirmed_failure', 'aborted_unsigned']);
  class GateError extends Error { constructor(code) { super(code); this.name = 'GateError'; this.code = code; } }
  function requireGate(condition, code) { if (!condition) throw new GateError(code); }
  function uint(value) {
    requireGate(typeof value === 'bigint' || (typeof value === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) || (Number.isSafeInteger(value) && value >= 0), 'INVALID_UINT');
    const n = BigInt(value); requireGate(n >= 0n, 'INVALID_UINT'); return n;
  }
  function address(value) { requireGate(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value), 'INVALID_ADDRESS'); return value.toLowerCase(); }
  function hash(value) { requireGate(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value), 'INVALID_HASH'); return value.toLowerCase(); }
  function identity(record) { return IDENTITY_FIELDS.map(k => uint(record[k]).toString()).join(':'); }
  function locateUnique(records, wantedIdentity) {
    const hits = records.map((r, i) => identity(r) === wantedIdentity ? i : -1).filter(i => i >= 0);
    requireGate(hits.length === 1, 'ORDER_NOT_UNIQUE'); return hits[0];
  }
  function claimData(index) { return CLAIM_SELECTOR + uint(index).toString(16).padStart(64, '0'); }
  function quotaAt(quota, timestamp) {
    const length = uint(quota.windowSeconds), cap = uint(quota.limitUnits);
    if (cap === 0n) return { period: null, length, cap, used: 0n, unlimited: true, remaining: null };
    requireGate(length > 0n, 'QUOTA_WINDOW_ZERO');
    const period = uint(timestamp) / length;
    const used = uint(quota.storedPeriod) === period ? uint(quota.storedUsedUnits) : 0n;
    requireGate(cap === 0n || used <= cap, 'INVALID_QUOTA');
    return { period, length, cap, used, unlimited: cap === 0n, remaining: cap === 0n ? null : cap - used };
  }
  function quoteGate(quote, context) {
    requireGate(quote && quote.pinsValid === true && quote.modelAudited === true, 'QUOTE_UNVERIFIED');
    requireGate(hash(quote.sourceBlockHash) === hash(context.blockHash), 'QUOTE_BLOCK_MISMATCH');
    requireGate(uint(quote.sourceBlockNumber) === uint(context.blockNumber), 'QUOTE_BLOCK_MISMATCH');
    requireGate(uint(quote.ts) === uint(context.blockTimestamp), 'QUOTE_TIMESTAMP_MISMATCH');
    const sourceValidity = sourceFreshnessGate({ number: context.blockNumber, hash: context.blockHash, timestamp: context.blockTimestamp },
      { nowMs: context.nowMs, maxAgeMs: context.maxAgeMs, maxFutureSkewMs: context.maxFutureSkewMs || 0 });
    requireGate(uint(quote.claimedRaw) === uint(context.claimableRaw) && uint(quote.claimedRaw) > 0n, 'QUOTE_AMOUNT_MISMATCH');
    requireGate(Number.isSafeInteger(quote.observedAtMs) && Number.isSafeInteger(quote.validUntilMs), 'QUOTE_CLOCK_INVALID');
    requireGate(quote.observedAtMs === sourceValidity.sourceTimestampMs && quote.validUntilMs <= sourceValidity.validUntilMs, 'QUOTE_VALIDITY_EXTENDED');
    requireGate(context.nowMs + (context.maxFutureSkewMs || 0) >= quote.observedAtMs && context.nowMs < quote.validUntilMs && context.nowMs - quote.observedAtMs <= context.maxAgeMs, 'QUOTE_STALE');
    requireGate(quote.feeAssetMappingVerified === true && quote.liquidityVerified === true && quote.pathVerified === true, 'QUOTE_PATH_UNVERIFIED');
    const minimum = uint(quote.reliableMinimumNetRaw), expected = uint(quote.netFeeAssetRaw);
    requireGate(minimum > 0n && minimum <= expected, 'QUOTE_LOWER_BOUND_INVALID');
    return minimum;
  }
  function rankOrders(records, claimables, quotes, context) {
    requireGate(records.length > 0 && records.length === claimables.length && records.length === quotes.length, 'QUOTE_SET_INCOMPLETE');
    const ranked = records.map((record, index) => {
      const claimableRaw = uint(claimables[index]);
      if (claimableRaw === 0n) return { index, identity: identity(record), claimableRaw, minimumNetRaw: 0n };
      const minimumNetRaw = quoteGate(quotes[index], { ...context, claimableRaw });
      return { index, identity: identity(record), claimableRaw, minimumNetRaw };
    });
    ranked.sort((a, b) => a.minimumNetRaw === b.minimumNetRaw ? a.index - b.index : a.minimumNetRaw > b.minimumNetRaw ? -1 : 1);
    requireGate(ranked[0].minimumNetRaw > 0n, 'NOTHING_CLAIMABLE');
    locateUnique(records, ranked[0].identity);
    return ranked;
  }
  function feeGate({ gasLimit, maximumUnitPrice, otherFeeCapRaw, otherFeesVerified, minimumNetRaw }) {
    requireGate(otherFeesVerified === true, 'OTHER_FEES_UNKNOWN');
    const gas = uint(gasLimit), price = uint(maximumUnitPrice), other = uint(otherFeeCapRaw), value = uint(minimumNetRaw);
    requireGate(gas > 0n && price > 0n && value > 0n, 'FEE_INPUT_INVALID');
    const maximumFeeRaw = gas * price + other;
    requireGate(maximumFeeRaw * 10n <= value, 'FEE_OVER_TEN_PERCENT');
    return maximumFeeRaw;
  }
  function freshnessGate(snapshot, { nowMs, maxAgeMs, currentBlockHash }) {
    requireGate(snapshot && snapshot.codePinsValid === true && snapshot.identityUnique === true && snapshot.nonceVerified === true, 'SNAPSHOT_UNVERIFIED');
    requireGate(Number.isSafeInteger(snapshot.observedAtMs) && nowMs >= snapshot.observedAtMs && nowMs - snapshot.observedAtMs <= maxAgeMs, 'SNAPSHOT_STALE');
    requireGate(hash(snapshot.blockHash) === hash(currentBlockHash), 'SNAPSHOT_BLOCK_MISMATCH');
    return true;
  }
  function sourceFreshnessGate(sourceBlock, { nowMs, maxAgeMs = 30000, maxFutureSkewMs = 2000, latestBlock = sourceBlock }) {
    requireGate(Number.isSafeInteger(nowMs) && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && Number.isSafeInteger(maxFutureSkewMs) && maxFutureSkewMs >= 0, 'FRESHNESS_CLOCK_INVALID');
    const timestamp = uint(sourceBlock.timestamp), sourceTimestampMs = Number(timestamp) * 1000;
    const latestTimestampMs = Number(uint(latestBlock.timestamp)) * 1000;
    requireGate(Number.isSafeInteger(sourceTimestampMs) && Number.isSafeInteger(latestTimestampMs), 'BLOCK_TIMESTAMP_INVALID');
    requireGate(sourceTimestampMs <= nowMs + maxFutureSkewMs && latestTimestampMs <= nowMs + maxFutureSkewMs, 'BLOCK_TIMESTAMP_FUTURE');
    requireGate(nowMs < sourceTimestampMs + maxAgeMs && latestTimestampMs - sourceTimestampMs < maxAgeMs, 'SOURCE_BLOCK_STALE');
    requireGate(uint(latestBlock.number) >= uint(sourceBlock.number) && latestTimestampMs >= sourceTimestampMs, 'LATEST_BLOCK_REGRESSED');
    if (uint(latestBlock.number) === uint(sourceBlock.number)) requireGate(hash(latestBlock.hash) === hash(sourceBlock.hash), 'REORG_DETECTED');
    return Object.freeze({ sourceTimestampMs, validUntilMs: sourceTimestampMs + maxAgeMs, sourceAgeMs: nowMs - sourceTimestampMs });
  }
  function readOnlyCompletionGate({ sourceBlock, canonicalBlock, latestBlock, wallet, walletChain, publicChain, accounts, initialNonce, latestNonce, pendingNonce,
    nowMs, startedWallTimeMs, elapsedMonotonicMs, maxAgeMs = 30000, maxFutureSkewMs = 2000 }) {
    requireGate(canonicalBlock && hash(canonicalBlock.hash) === hash(sourceBlock.hash) && uint(canonicalBlock.number) === uint(sourceBlock.number) && uint(canonicalBlock.timestamp) === uint(sourceBlock.timestamp), 'REORG_DETECTED');
    requireGate(uint(walletChain) === CHAIN_ID && uint(publicChain) === CHAIN_ID, 'POST_CHAIN_MISMATCH');
    requireGate(Array.isArray(accounts) && accounts.length > 0 && address(accounts[0]) === address(wallet), 'POST_ACCOUNT_MISMATCH');
    requireGate(uint(initialNonce) === uint(latestNonce) && uint(initialNonce) === uint(pendingNonce), 'POST_NONCE_CHANGED');
    requireGate(Number.isSafeInteger(startedWallTimeMs) && Number.isFinite(elapsedMonotonicMs) && elapsedMonotonicMs >= 0 && elapsedMonotonicMs < maxAgeMs, 'READ_CYCLE_EXPIRED');
    requireGate(Math.abs((nowMs - startedWallTimeMs) - elapsedMonotonicMs) <= maxFutureSkewMs, 'WALL_CLOCK_CHANGED');
    return sourceFreshnessGate(sourceBlock, { nowMs, maxAgeMs, maxFutureSkewMs, latestBlock });
  }
  function timingGate({ armed, blockTimestamp, targetTimestamp, periodSeconds, fresh, feeAllowed, quotaSufficient }) {
    requireGate(armed === true, 'NOT_ARMED');
    const block = uint(blockTimestamp), target = uint(targetTimestamp), length = uint(periodSeconds);
    requireGate(length > 0n && target > 0n && target % length === 0n, 'TARGET_INVALID');
    requireGate(fresh === true && feeAllowed === true, 'CACHE_OR_FEE_INVALID');
    if (block < target - 1n) return 'WAIT';
    requireGate(block < target + length, 'TARGET_PERIOD_MISSED');
    if (block === target - 1n) return 'LAST_OLD_BLOCK_CANDIDATE';
    requireGate(quotaSufficient === true, 'NEW_PERIOD_QUOTA_INSUFFICIENT');
    return 'NEW_PERIOD_REVALIDATED_CANDIDATE';
  }
  function txTemplate({ wallet, index, nonce, gasLimit, gasPrice }) {
    return Object.freeze({ from: address(wallet), to: BOND, chainId: '0x1a3a', nonce: '0x' + uint(nonce).toString(16),
      value: '0x0', data: claimData(index), type: '0x0', gas: '0x' + uint(gasLimit).toString(16), gasPrice: '0x' + uint(gasPrice).toString(16) });
  }
  function decodeSignedTransaction(raw, wanted, ethers) {
    // Never return raw or an underlying ethers exception: those may include signed data.
    try {
      requireGate(typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) && raw.length > 66 && raw.length < 8192, 'SIGNED_FORMAT');
      const tx = ethers.Transaction.from(raw);
      requireGate(tx.isSigned() && tx.type === 0 && tx.chainId === CHAIN_ID, 'SIGNED_CHAIN_TYPE');
      requireGate(address(tx.from) === address(wanted.from) && address(tx.to) === BOND && address(wanted.to) === BOND, 'SIGNED_ADDRESS');
      requireGate(uint(tx.nonce) === uint(wanted.nonce) && tx.value === 0n && uint(wanted.value) === 0n, 'SIGNED_NONCE_VALUE');
      requireGate(tx.data.toLowerCase() === wanted.data.toLowerCase() && /^0x379607f5[0-9a-f]{64}$/i.test(tx.data), 'SIGNED_CALLDATA');
      requireGate(tx.gasLimit === uint(wanted.gas) && tx.gasPrice === uint(wanted.gasPrice), 'SIGNED_FEE');
      return Object.freeze({ txHash: hash(tx.hash), from: address(tx.from), to: BOND, chainId: '6714', nonce: uint(tx.nonce).toString(),
        gasLimit: tx.gasLimit.toString(), gasPrice: tx.gasPrice.toString(), data: tx.data, value: '0' });
    } catch (error) { throw new GateError(error instanceof GateError ? error.code : 'SIGNED_DECODE_FAILED'); }
  }
  function assertExecutionEnabled() { requireGate(MAINNET_EXECUTION_ENABLED, 'MAINNET_EXECUTION_DISABLED'); }
  function assertBroadcastEnabled() { assertExecutionEnabled(); requireGate(BROADCAST_ENABLED, 'BROADCAST_DISABLED'); }
  function checkedMetadata(value) {
    const allowed = new Set(['wallet', 'chainId', 'quotaContract', 'period', 'nonce', 'txHash', 'state', 'updatedAtMs']);
    requireGate(value && Object.keys(value).every(k => allowed.has(k)), 'METADATA_FIELDS_INVALID');
    requireGate(UNRESOLVED.has(value.state) || TERMINAL.has(value.state), 'METADATA_STATE_INVALID');
    const out = { wallet: address(value.wallet), chainId: uint(value.chainId).toString(), quotaContract: address(value.quotaContract),
      period: uint(value.period).toString(), nonce: uint(value.nonce).toString(), txHash: value.txHash === null ? null : hash(value.txHash), state: value.state,
      updatedAtMs: value.updatedAtMs };
    requireGate(out.chainId === '6714' && out.quotaContract === BOND && Number.isSafeInteger(out.updatedAtMs), 'METADATA_INVALID');
    requireGate(!['broadcast_unknown', 'pending', 'confirmed_success', 'confirmed_failure'].includes(out.state) || out.txHash !== null, 'TX_HASH_REQUIRED');
    return Object.freeze(out);
  }
  function reserveGate(history, { wallet, period }) {
    requireGate(period !== null && period !== undefined, 'QUOTA_PERIOD_REQUIRED');
    const same = history.map(checkedMetadata).filter(r => r.wallet === address(wallet));
    requireGate(!same.some(r => UNRESOLVED.has(r.state)), 'UNRESOLVED_TRANSACTION');
    requireGate(!same.some(r => r.period === uint(period).toString()), 'PERIOD_ALREADY_ATTEMPTED');
    return true;
  }
  function receiptState(receipt, expectedHash) {
    if (receipt === null) return 'pending';
    requireGate(hash(receipt.transactionHash) === hash(expectedHash), 'RECEIPT_HASH_MISMATCH');
    if (uint(receipt.status) === 1n) return 'confirmed_success';
    requireGate(uint(receipt.status) === 0n, 'RECEIPT_STATUS_UNKNOWN'); return 'confirmed_failure';
  }
  function advanceMetadata(oldValue, newValue) {
    const old = checkedMetadata(oldValue), next = checkedMetadata(newValue);
    requireGate(['wallet', 'chainId', 'quotaContract', 'period', 'nonce'].every(key => old[key] === next[key]), 'ATTEMPT_IDENTITY_CHANGED');
    requireGate(old.txHash === null || old.txHash === next.txHash, 'ATTEMPT_HASH_CHANGED');
    const allowed = {
      reserved: ['sign_requested', 'aborted_unsigned'], sign_requested: ['signed'], signed: ['armed'],
      armed: ['broadcast_unknown'], broadcast_unknown: ['pending', 'confirmed_success', 'confirmed_failure'],
      pending: ['pending', 'confirmed_success', 'confirmed_failure'], confirmed_success: [], confirmed_failure: [], aborted_unsigned: []
    };
    requireGate(allowed[old.state].includes(next.state), 'STATE_TRANSITION_REJECTED');
    requireGate(next.updatedAtMs >= old.updatedAtMs, 'METADATA_CLOCK_REGRESSED');
    return next;
  }
  function createMetadataLedger(storage, wallet) {
    wallet = address(wallet); const key = 'anubis-trial:6714:' + wallet;
    function read() {
      try { const text = storage.getItem(key); if (text === null) return []; const values = JSON.parse(text);
        requireGate(Array.isArray(values), 'METADATA_CORRUPT');
        return values.map(value => { const item = checkedMetadata(value); requireGate(item.wallet === wallet, 'METADATA_WALLET_MISMATCH'); return item; });
      } catch (_) { throw new GateError('METADATA_CORRUPT_OR_UNAVAILABLE'); }
    }
    return Object.freeze({ read, save(value) {
      const item = checkedMetadata(value); requireGate(item.wallet === wallet, 'METADATA_WALLET_MISMATCH');
      const history = read(), index = history.findIndex(row => row.period === item.period);
      if (index < 0) { reserveGate(history, item); requireGate(item.state === 'reserved', 'RESERVE_FIRST'); history.push(item); }
      else history[index] = advanceMetadata(history[index], item);
      try { storage.setItem(key, JSON.stringify(history)); } catch (_) { throw new GateError('METADATA_WRITE_FAILED_STOP'); }
      return item;
    } });
  }
  function createDormantCandidate({ provider, chainRpc, persistMetadata, ethers }) {
    // Future workflow skeleton. raw exists only inside this closure. Both execution gates remain false.
    let raw = null, armed = false, sendAttempted = false, meta = null, stopped = false;
    return Object.freeze({
      async sign(wanted, approvedMetadata) {
        assertExecutionEnabled(); requireGate(!stopped && raw === null && !meta, 'ALREADY_USED');
        meta = checkedMetadata({ ...approvedMetadata, state: 'sign_requested' }); persistMetadata(meta);
        try {
          // No eth_sendTransaction fallback is permitted.
          raw = await provider.request({ method: 'eth_signTransaction', params: [wanted] });
          requireGate(!stopped, 'STOPPED_DURING_SIGNATURE');
          const decoded = decodeSignedTransaction(raw, wanted, ethers);
          meta = checkedMetadata({ ...meta, txHash: decoded.txHash, state: 'signed' }); persistMetadata(meta);
          return decoded;
        } catch (_) { raw = null; throw new GateError('SIGN_RESULT_UNKNOWN_STOP'); }
      },
      arm() { assertExecutionEnabled(); requireGate(raw && !stopped && !sendAttempted, 'NO_SIGNED_TRANSACTION'); armed = true; },
      async broadcastOnce(timing) {
        assertBroadcastEnabled(); requireGate(raw && armed && !stopped && !sendAttempted, 'NOT_READY');
        const decision = timingGate({ ...timing, armed }); requireGate(decision !== 'WAIT', 'TOO_EARLY');
        sendAttempted = true; armed = false;
        // Persist the known hash BEFORE any network request. A timeout stays unknown; never rebuild or resend.
        meta = checkedMetadata({ ...meta, state: 'broadcast_unknown' }); persistMetadata(meta);
        try {
          const result = await chainRpc('eth_sendRawTransaction', [raw]);
          requireGate(hash(result) === meta.txHash, 'BROADCAST_HASH_MISMATCH');
          meta = checkedMetadata({ ...meta, state: 'pending' }); persistMetadata(meta);
          return meta;
        } catch (_) { throw new GateError('BROADCAST_UNKNOWN_CHECK_RECEIPT_NONCE'); }
        finally { raw = null; }
      },
      emergencyStop() { stopped = true; armed = false; raw = null; return 'LOCAL_COPY_CLEARED_SIGNATURE_NOT_REVOKED'; },
      getStatus() { return Object.freeze({ armed, stopped, sendAttempted, metadata: meta }); }
    });
  }
  return Object.freeze({ MAINNET_EXECUTION_ENABLED, BROADCAST_ENABLED, BOND, CHAIN_ID, GateError, uint, address, hash, identity,
    locateUnique, claimData, quotaAt, quoteGate, rankOrders, feeGate, freshnessGate, sourceFreshnessGate, readOnlyCompletionGate, timingGate, txTemplate,
    decodeSignedTransaction, assertExecutionEnabled, assertBroadcastEnabled, checkedMetadata, reserveGate, receiptState, advanceMetadata, createMetadataLedger, createDormantCandidate });
});
