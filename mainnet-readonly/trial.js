/* No signing/broadcast UI is wired. The only active network client is read-only. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const G = window.AnubisTrialGates, C = window.ANUBIS_TRIAL_CONFIG, E = window.ethers;
  let stopped = false, busy = false, provider = null, epoch = 0, expirationTimer = null, displayedValidUntilMs = null;
  const activeRequests = new Set();
  // A reviewed same-origin adapter is created only after the user enters a public wallet.
  // Never take an adapter, bytecode, or execution flag from URL params/localStorage/window injection.
  const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getStorageAt', 'eth_getCode',
    'eth_call', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_gasPrice', 'eth_estimateGas']);
  const WALLET_READ_METHODS = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId']);
  const bondAbi = [
    'function getUserDeposits(address) view returns (tuple(uint256 daiValue,uint256 capBps,uint256 burnedLgns,uint256 releasedDaiValue,uint256 claimedLgns,uint256 lastAccReleasedFrac,uint256 lastAccLgnsPerDai,uint256 depositTimestamp,uint8 mode)[])',
    'function getClaimable(address,uint256) view returns (uint256)',
    'function lgns() view returns (address)', 'function dai() view returns (address)', 'function treasury() view returns (address)'
  ];
  const bond = new E.Interface(bondAbi), token = new E.Interface(['function decimals() view returns (uint8)']);
  function say(message) { $('status').textContent = message; }
  function invalidateResults(reason) {
    clearTimeout(expirationTimer); expirationTimer = null; displayedValidUntilMs = null;
    $('summary').textContent = '無可用即時快照（先前結果已清除／過期）。' + reason;
    $('quote-status').textContent = '無可用即時估價；反事實模型結果已清除。簽署與廣播仍停用。';
  }
  function displayResults(summary, validity) {
    displayedValidUntilMs = validity.validUntilMs;
    summary.sourceBlockAgeMsAtCompletion = validity.sourceAgeMs;
    summary.expiresAtUTC = new Date(validity.validUntilMs).toISOString();
    summary.freshnessLimitSeconds = C.quoteMaxAgeMs / 1000;
    $('summary').textContent = JSON.stringify(summary, null, 2);
    clearTimeout(expirationTimer);
    expirationTimer = setTimeout(() => { invalidateResults('來源區塊已超過30秒有效期，請重新查詢。'); if (!stopped) say('快照已過期；沒有可用即時估價。'); }, Math.max(0, validity.validUntilMs - Date.now()));
  }
  function safeError(error) { return error instanceof G.GateError ? error.code : 'READ_ONLY_CHECK_FAILED'; }
  function abortAll() { for (const controller of activeRequests) controller.abort(); activeRequests.clear(); }
  function stop(reason) {
    stopped = true; epoch++; abortAll(); $('inspect').disabled = true;
    invalidateResults('本頁已停止。');
    say(reason + ' 本頁不再發起新請求；本機停止不會撤銷已存在的簽章或交易。');
  }
  function bitgetProvider() {
    const specific = window.bitkeep?.ethereum || window.bitget?.ethereum;
    if (specific?.request) return specific;
    if ((window.ethereum?.isBitKeep || window.ethereum?.isBitget) && window.ethereum.request) return window.ethereum;
    throw new G.GateError('BITGET_PROVIDER_NOT_FOUND');
  }
  async function rpc(method, params = []) {
    G.uint('6714');
    if (stopped) throw new G.GateError('PAGE_STOPPED');
    if (!READ_METHODS.has(method)) throw new G.GateError('READ_ONLY_RPC_REJECTED');
    const controller = new AbortController(); activeRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(C.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), credentials: 'omit', redirect: 'error',
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new G.GateError('RPC_HTTP_ERROR');
      const data = await response.json();
      if (data.id !== 1 || data.error || !Object.prototype.hasOwnProperty.call(data, 'result')) throw new G.GateError('RPC_CALL_FAILED');
      return data.result;
    } catch (error) { throw new G.GateError(error instanceof G.GateError ? error.code : 'RPC_TIMEOUT_OR_NETWORK_UNKNOWN'); }
    finally { clearTimeout(timer); activeRequests.delete(controller); }
  }
  async function walletRead(method) {
    if (stopped || !WALLET_READ_METHODS.has(method)) throw new G.GateError('WALLET_READ_ONLY_REJECTED');
    try { return await provider.request({ method, params: [] }); }
    catch (_) { throw new G.GateError('WALLET_REQUEST_NOT_COMPLETED'); }
  }
  async function call(address, iface, method, args, block) {
    const raw = await rpc('eth_call', [{ to: address, data: iface.encodeFunctionData(method, args) }, block]);
    return iface.decodeFunctionResult(method, raw)[0];
  }
  function readHistory(wallet) {
    let raw;
    try { raw = localStorage.getItem('anubis-trial:6714:' + wallet); }
    catch (_) { throw new G.GateError('METADATA_STORAGE_UNAVAILABLE'); }
    if (raw === null) return [];
    try { const data = JSON.parse(raw); if (!Array.isArray(data)) throw Error(); return data.map(G.checkedMetadata); }
    catch (_) { throw new G.GateError('METADATA_CORRUPT_STOP'); }
  }
  async function codePins(block) {
    const slot = await rpc('eth_getStorageAt', [C.bond, C.implementationSlot, block]);
    if (G.address('0x' + slot.slice(-40)) !== C.implementation) throw new G.GateError('BOND_IMPLEMENTATION_CHANGED');
    for (const pin of C.pins) {
      const code = await rpc('eth_getCode', [pin.address, block]);
      if (E.sha256(code) !== pin.sha256) throw new G.GateError('RUNTIME_PIN_CHANGED');
    }
  }
  async function collect(wallet, tokenEpoch) {
    if (typeof performance !== 'object' || typeof performance.now !== 'function') throw new G.GateError('MONOTONIC_CLOCK_UNAVAILABLE');
    const startedWallTimeMs = Date.now(), startedMonotonicMs = performance.now();
    const [walletChain, publicChain] = await Promise.all([walletRead('eth_chainId'), rpc('eth_chainId')]);
    if (G.uint(walletChain) !== G.CHAIN_ID || G.uint(publicChain) !== G.CHAIN_ID) throw new G.GateError('CHAIN_MISMATCH');
    const accounts = await walletRead('eth_accounts');
    if (!accounts?.length || G.address(accounts[0]) !== wallet) throw new G.GateError('WALLET_ADDRESS_MISMATCH');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    G.hash(block.hash); const blockTag = block.number;
    G.sourceFreshnessGate(block, { nowMs: Date.now(), maxAgeMs: C.quoteMaxAgeMs, maxFutureSkewMs: C.maxFutureSkewMs });
    await codePins(blockTag);
    const reads = await Promise.all([
      call(C.bond, bond, 'lgns', [], blockTag), call(C.bond, bond, 'dai', [], blockTag), call(C.bond, bond, 'treasury', [], blockTag),
      call(C.lgns, token, 'decimals', [], blockTag), call(C.dai, token, 'decimals', [], blockTag),
      call(C.bond, bond, 'getUserDeposits', [wallet], blockTag), rpc('eth_getCode', [wallet, blockTag]),
      rpc('eth_getTransactionCount', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'pending']),
      ...['0xb5fb0640', '0x440f3da3', '0xf4f9e5b6', '0xa07fa7a1'].map(data => rpc('eth_call', [{ to: C.bond, data }, blockTag]))
    ]);
    if (G.address(reads[0]) !== C.lgns || G.address(reads[1]) !== C.dai || G.address(reads[2]) !== C.treasury) throw new G.GateError('CONTRACT_RELATION_CHANGED');
    if (reads[3] !== 9n || reads[4] !== 18n) throw new G.GateError('TOKEN_DECIMALS_CHANGED');
    if (reads[6] !== '0x') throw new G.GateError('EOA_ONLY_NO_ACCOUNT_CODE');
    if (G.uint(reads[7]) !== G.uint(reads[8])) throw new G.GateError('PENDING_NONCE_BLOCKS_NEW_OPERATION');
    const records = reads[5].map(r => Object.fromEntries(['daiValue', 'capBps', 'burnedLgns', 'releasedDaiValue', 'claimedLgns', 'lastAccReleasedFrac', 'lastAccLgnsPerDai', 'depositTimestamp', 'mode'].map(k => [k, r[k].toString()])));
    if (records.length !== C.expectedOrderCount) throw new G.GateError('ORDER_COUNT_CHANGED_REVIEW_REQUIRED');
    for (const record of records) G.locateUnique(records, G.identity(record));
    const claimables = await Promise.all(records.map((_, index) => call(C.bond, bond, 'getClaimable', [wallet, index], blockTag)));
    const quota = G.quotaAt({ windowSeconds: reads[9], limitUnits: reads[10], storedPeriod: reads[11], storedUsedUnits: reads[12] }, block.timestamp);
    const history = readHistory(wallet);
    if (quota.period !== null) G.reserveGate(history, { wallet, period: quota.period });
    if (stopped || tokenEpoch !== epoch) throw new G.GateError('STALE_REQUEST_DISCARDED');
    const summary = { version: '0.1', executionEnabled: false, chainId: '6714', wallet,
      blockNumber: G.uint(blockTag).toString(), blockHash: block.hash, blockTimestamp: G.uint(block.timestamp).toString(),
      contract: C.bond, implementation: C.implementation, codePinsChecked: C.pins.length,
      nonce: G.uint(reads[8]).toString(), quotaPeriod: quota.period === null ? 'cap=0，未定義額度時段；不可預約正式交易' : quota.period.toString(), quotaLengthSeconds: quota.length.toString(),
      quotaRemainingLGNS: quota.unlimited ? '鏈上 cap=0，目前不限制' : E.formatUnits(quota.remaining, 9),
      orders: records.map((record, index) => ({ index, provisionalIdentity: G.identity(record), claimableLGNS: E.formatUnits(claimables[index], 9) })),
      ranking: '尚未取得每筆可靠淨估值，未選定正式交易', signOrBroadcastRequested: false };
    const quoteAdapter = window.createAnubisQuoteAdapter({ rpc, ethers: E, profile: window.ANUBIS_QUOTE_PROFILE, wallet, gates: G,
      lifetimeMs: C.quoteMaxAgeMs, maxFutureSkewMs: C.maxFutureSkewMs });
    if (!quoteAdapter.ready) throw new G.GateError('QUOTE_ADAPTER_UNAVAILABLE');
    // Future adapter: quoteAt(block,index,minOut) must be same-block, pinned, model-audited and return conservative net output.
    const quotes = await Promise.all(records.map((_, index) => claimables[index] > 0n ? quoteAdapter.quoteAt(block, index, 0n) : null));
    // The entire model batch must finish BEFORE this canonicality / clock / wallet check.
    const post = await Promise.all([
      rpc('eth_getBlockByNumber', [blockTag, false]), rpc('eth_getBlockByNumber', ['latest', false]),
      walletRead('eth_chainId'), rpc('eth_chainId'), walletRead('eth_accounts'),
      rpc('eth_getTransactionCount', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'pending'])
    ]);
    const completedAtMs = Date.now();
    const validity = G.readOnlyCompletionGate({ sourceBlock: block, canonicalBlock: post[0], latestBlock: post[1], wallet,
      walletChain: post[2], publicChain: post[3], accounts: post[4], initialNonce: reads[8], latestNonce: post[5], pendingNonce: post[6],
      nowMs: completedAtMs, startedWallTimeMs, elapsedMonotonicMs: performance.now() - startedMonotonicMs,
      maxAgeMs: C.quoteMaxAgeMs, maxFutureSkewMs: C.maxFutureSkewMs });
    for (let index = 0; index < quotes.length; index++) {
      const quote = quotes[index]; if (quote === null) continue;
      if (quote.claimedRaw !== claimables[index] || quote.sourceBlockHash !== block.hash || G.uint(quote.sourceBlockNumber) !== G.uint(blockTag)
        || G.uint(quote.ts) !== G.uint(block.timestamp) || quote.validUntilMs !== validity.validUntilMs || completedAtMs >= quote.validUntilMs) throw new G.GateError('MODEL_QUOTE_SOURCE_OR_AMOUNT_MISMATCH');
    }
    if (stopped || tokenEpoch !== epoch) throw new G.GateError('STALE_REQUEST_DISCARDED');
    if (!quoteAdapter.trustedForSigning) {
      summary.modelQuotes = quotes.map((quote, index) => quote === null ? { index, zeroClaimable: true } : {
        index, claimedLGNS: E.formatUnits(quote.claimedRaw, 9), counterfactualNetDAI: E.formatUnits(quote.netFeeAssetRaw, 18),
        claimedMatchesRead: quote.claimedRaw === claimables[index], eligibleUnderRealQuota: quota.unlimited || quota.remaining >= claimables[index],
        trustedForSigning: false
      });
      summary.ranking = '已顯示七筆反事實估值；尚未核准模型、保守最低淨額或 gasDAI 費用對應，不選定正式交易';
      displayResults(summary, validity);
      $('quote-status').textContent = '此為 eth_call 暫態覆寫模型（不會上鏈）；不能當作目前額度下可成功領取。模型尚未核准，簽署與廣播保持硬停用。';
      return;
    }
    G.rankOrders(records, claimables, quotes, { blockHash: block.hash, blockNumber: G.uint(blockTag), blockTimestamp: block.timestamp,
      nowMs: Date.now(), maxAgeMs: C.quoteMaxAgeMs, maxFutureSkewMs: C.maxFutureSkewMs });
    throw new G.GateError('ADAPTER_REVIEW_REQUIRED_EXECUTION_STILL_DISABLED');
  }
  $('stop').onclick = () => stop('使用者已緊急停止。');
  $('inspect').onclick = async function () {
    if (busy || stopped) return;
    if (!$('consent').checked) { say('請先確認公開地址查詢同意。'); return; }
    let wallet;
    try { wallet = G.address($('expected').value.trim()); }
    catch (_) { say('請輸入完整公開錢包地址。'); return; }
    if (!window.isSecureContext || !navigator.locks?.request) { say('此環境缺少安全內容或跨分頁 navigator.locks；本原型停止操作。'); return; }
    busy = true; $('inspect').disabled = true; const tokenEpoch = ++epoch;
    invalidateResults('正在查詢新快照，舊結果不再使用。');
    try {
      provider = bitgetProvider(); say('等待 Bitget 連接確認；此步不請求簽署。');
      const accounts = await walletRead('eth_requestAccounts');
      if (!accounts?.length || G.address(accounts[0]) !== wallet) throw new G.GateError('WALLET_ADDRESS_MISMATCH');
      if (provider.on) {
        provider.on('accountsChanged', () => stop('帳戶已變更。'));
        provider.on('chainChanged', () => stop('網路已變更。'));
        provider.on('disconnect', () => stop('錢包已斷線。'));
      }
      await navigator.locks.request('anubis-trial:6714:' + wallet, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new G.GateError('ANOTHER_TAB_HAS_WALLET_LOCK');
        say('正在核對鏈、程式碼、訂單與額度；尚未請求簽署。');
        await collect(wallet, tokenEpoch);
      });
      if (!stopped) say('唯讀快照與反事實模型查詢完成；模型尚未核准，主網執行仍停用。');
    } catch (error) { invalidateResults('此次預檢沒有通過完整核對。'); if (!stopped) say('已停止此輪預檢：' + safeError(error) + '。沒有請求簽署或廣播。'); }
    finally { busy = false; $('inspect').disabled = stopped; }
  };
  window.addEventListener?.('pageshow', () => { if (displayedValidUntilMs !== null && Date.now() >= displayedValidUntilMs) invalidateResults('頁面恢復時來源區塊已過期。'); });
  document.addEventListener?.('visibilitychange', () => { if (!document.hidden && displayedValidUntilMs !== null && Date.now() >= displayedValidUntilMs) invalidateResults('頁面恢復時來源區塊已過期。'); });
  // No sign/arm/broadcast listeners. Buttons remain disabled even if HTML attributes are edited.
  say('程式已載入。主網簽署與廣播均為硬停用；尚未連接錢包。');
})();
