/* One manual wallet send. RPC client is read-only; no signed bytes are handled here. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), E = window.ethers, P = window.ANUBIS_MANUAL_POLICY;
  const READ_RPC = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getStorageAt', 'eth_getCode', 'eth_call',
    'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_gasPrice', 'eth_estimateGas']);
  let provider = null, controller = null, review = null, active = false, id = 0, lastReadStage = '尚未查詢';
  const observedNetworks = {};
  const requests = new Set();
  function say(text) { $('status').textContent = text; }
  function brief(text) { if ($('brief')) $('brief').textContent = text; }
  function diagnostic() {
    return '最後階段：' + lastReadStage + '；錢包 Chain ID：' + (observedNetworks.walletChainId || '未讀到') +
      '；RPC Chain ID：' + (observedNetworks.rpcChainId || '未讀到') + '；需要 Anubis 6714。';
  }
  function errorExplanation(code) {
    const messages = { CHAIN_MISMATCH: '目前錢包網路不是 Anubis 6714，請先在 Bitget 切換網路。',
      ACCOUNT_MISMATCH: '目前連接的錢包地址與輸入地址不同。', CONNECTED_ACCOUNT_MISMATCH: '目前連接的錢包地址與輸入地址不同。',
      CONNECTION_REJECTED: '錢包連線沒有獲得同意。', SOURCE_EXPIRED: '唯讀查詢超過30秒或來源已過期，未準備交易。',
      SOURCE_FUTURE: '來源區塊時間與裝置時間不符。', CLOCK_CHANGED: '裝置時間在檢查途中變動。',
      READ_QUERY_FAILED_OR_UNKNOWN: '唯讀 RPC 查詢未完成；可能是連線、逾時或伺服器拒絕，尚未確認原因。',
      NONCE_CHANGED_OR_PENDING: 'nonce已變動或存在待處理交易，請先查明交易狀態。' };
    return (messages[code] || '這一輪檢查未完成。') + ' ' + diagnostic();
  }
  function errorCode(error) { if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)) return error.code; return typeof error?.message === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'OPERATION_NOT_VERIFIED'; }
  function clearReview(text) { review = null; brief(''); $('review').textContent = text; $('send-consent').checked = false; $('send-consent').disabled = true; $('send').disabled = true; }
  function setActive(value) { active = value; const state = controller?.getState(); $('prepare').disabled = value || !!state?.stopped || !!state?.walletRequested; $('check').disabled = value || !state?.record; updateSend(); }
  function updateSend() { $('send').disabled = active || !review || P?.executionEnabled !== true || !$('send-consent').checked || !!controller?.getState().stopped || !!controller?.getState().walletRequested; }
  function readableCard(card) {
    return { mode: '單次 Bitget 簽署並送出；沒有預簽或自動重試', wallet: card.wallet, chainId: '6714', contract: card.transaction.to,
      function: 'claim(uint256)', orderIndex: card.orderIndex, orderIdentity: card.orderIdentity,
      claimableLGNS: E.formatUnits(card.claimableRaw, 9), nonce: BigInt(card.transaction.nonce).toString(),
      gasLimit: BigInt(card.transaction.gas).toString(), gasPriceGwei: E.formatUnits(card.transaction.gasPrice, 9),
      maximumFeeGasDAI: E.formatUnits(card.maxFeeRaw, 18), reliableMinimumNetGasDAI: E.formatUnits(card.minimumNetRaw, 18),
      feeAtMostTenPercent: BigInt(card.maxFeeRaw) * 10n <= BigInt(card.minimumNetRaw),
      minimumNetNote: '當前已核路徑的保守估值，已扣假設出售成本與折減；本筆只claim，不會出售',
      historicalSourceBlock: card.sourceBlock, historicalQuoteExpiresAtUTC: new Date(Number(card.validUntilMs)).toISOString(),
      reviewApprovalExpiresAtUTC: new Date(Number(card.reviewValidUntilMs)).toISOString(),
      latestWalletConfirmationDeadlineUTC: card.handoffValidUntilMs ? new Date(Number(card.handoffValidUntilMs)).toISOString() : '請求前才重新核對最新30秒資料',
      latestWalletConfirmationDeadlineDeviceTime: card.handoffValidUntilMs ? new Date(Number(card.handoffValidUntilMs)).toLocaleString('zh-TW', { hour12: false }) : '請求前才重新核對',
      latestHandoffSourceBlock: card.handoffSourceBlock || null,
      reviewDigest: card.reviewDigest, transaction: card.transaction };
  }
  function render(event) {
    if (event.record) { $('journal').textContent = JSON.stringify({ record: event.record, observation: event.observation || null, code: event.code || null }, null, 2); if (event.record.txHash) $('tx-hash').value = event.record.txHash; }
    if (event.kind === 'prepared') {
      review = event.card; $('review').textContent = JSON.stringify(readableCard(review), null, 2); $('blockers').textContent = '';
      brief('第0筆可領 ' + E.formatUnits(review.claimableRaw, 9) + ' LGNS；本筆最高費用 ' + E.formatUnits(review.maxFeeRaw, 18) +
        ' gasDAI；保守規劃價值 ' + E.formatUnits(review.minimumNetRaw, 18) + ' gasDAI。按下簽送前會重新核對。');
      $('send-consent').disabled = P.executionEnabled !== true; say(P.executionEnabled === true ? '核對卡已備妥；尚未請求簽署或廣播。' : '唯讀核對卡已備妥；此草稿尚未啟用主網簽送。');
    } else if (event.kind === 'blocked') {
      clearReview('預檢未通過，沒有可批准的交易核對卡。');
      const explanations = { GLOBAL_QUOTA_INSUFFICIENT: '全域領取額度不足，本輪不送出交易。', FEE_OVER_TEN_PERCENT: '最高費用超過保守估值的10%，本輪停止。',
        OBSERVED_GAS_PRICE_ABOVE_FIXED_CAP: '目前Gas單價高於固定上限，不會自動加價。', FEE_BALANCE_INSUFFICIENT: '費用餘額不足。',
        PERIOD_CHANGED_PREPARE_NEW_CARD: '額度時段已變動，請重新準備核對卡。', GAS_ESTIMATE_EXCEEDS_FIXED_LIMIT: 'Gas需求高於固定上限，本輪停止。', REAL_CLAIM_SIMULATION_FAILED: '實際領取模擬未通過，本輪停止。' };
      $('blockers').textContent = (event.snapshot.blockers || []).map(value => explanations[value] || String(value).slice(0, 400)).join('\n');
      if (event.snapshot.checks?.quotaRemainingRaw !== undefined && event.snapshot.claimableRaw)
        brief('目前全域剩額 ' + E.formatUnits(event.snapshot.checks.quotaRemainingRaw, 9) + ' LGNS；本筆可領 ' + E.formatUnits(event.snapshot.claimableRaw, 9) + ' LGNS。');
      $('review').textContent = JSON.stringify({ eligible: false, blockers: event.snapshot.blockers || [], checks: event.snapshot.checks || {}, sourceBlock: event.snapshot.sourceBlock || null }, null, 2);
      say('本輪已停止：額度、估價或費用等必要條件未通過。沒有請求簽署或廣播。');
    } else if (event.kind === 'preparing') { clearReview('正在做唯讀預檢，舊核對卡不再使用。'); $('blockers').textContent = ''; say('正在準備唯讀核對卡。'); }
    else if (event.kind === 'wallet_requested_unknown') { clearReview('一次錢包簽送請求已提出／結果未知；不可再請求。');
      if (event.record?.card) $('review').textContent = JSON.stringify(readableCard(event.record.card), null, 2);
      say('請在 Bitget 核對或拒絕該請求；若核對卡已過期請取消。這一步可能簽署並廣播，停止／90秒逾時不等於取消；未知時只能查狀態，不能重試。'); }
    else if (event.kind === 'pending') { clearReview('已有交易 hash；禁止再次請求簽送。'); say('交易待確認；按「查一次收據與 nonce」做唯讀核對。'); }
    else if (event.kind === 'confirmed_success') { clearReview('本次交易已核對，不再提供新簽送。'); say('已驗證此筆領取的收據、確認區塊、金庫支付事件與LGNS轉入。'); }
    else if (event.kind === 'confirmed_failure') { clearReview('本次上鏈失敗，已占用此次嘗試；不會自動重試。'); say('收據顯示交易失敗，可能已耗Gas。本頁不會再送交易。'); }
    else if (event.kind === 'restored_attempt') { clearReview('已恢復本次請求紀錄，不可再次簽送。'); say('已有先前請求紀錄，請只查詢狀態。'); }
    else if (event.kind === 'stopped') { clearReview('本頁已停止新操作。'); say('本機停止不能取消錢包請求或撤回已送交易。'); }
    else if (event.kind === 'status_unverified') say('交易狀態未能完整驗證：' + event.code + '。禁止重送。');
    else if (event.kind === 'error') { clearReview('此輪無可批准核對卡；需要重新唯讀準備。'); say('已停止：' + event.code + '。沒有自動重試。'); }
    updateSend();
  }
  async function rpc(method, params = []) {
    if (!READ_RPC.has(method)) throw Error('READ_ONLY_RPC_REJECTED');
    const requestId = ++id, abort = new AbortController(); requests.add(abort); const timeout = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetch(P.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
      if (!response.ok) throw Error(); const data = await response.json(); if (data.id !== requestId || data.error || !Object.prototype.hasOwnProperty.call(data, 'result')) throw Error(); return data.result;
    } catch (_) { throw Error('READ_QUERY_FAILED_OR_UNKNOWN'); }
    finally { clearTimeout(timeout); requests.delete(abort); }
  }
  function getProvider() {
    const specific = window.bitkeep?.ethereum || window.bitget?.ethereum;
    if (specific?.request) return specific;
    if ((window.ethereum?.isBitKeep || window.ethereum?.isBitget) && window.ethereum.request) return window.ethereum;
    throw Error('BITGET_PROVIDER_REQUIRED');
  }
  function buildController() {
    if (controller) return controller;
    if (!window.isSecureContext || !navigator.locks?.request || !E || !P) throw Error('SECURE_CONTEXT_AND_LOCKS_REQUIRED');
    const bridge = { request(args) {
      if (!provider) {
        provider = getProvider();
        if (provider.on) {
          provider.on('accountsChanged', accounts => { if (!accounts?.length || accounts[0].toLowerCase() !== $('wallet').value.trim().toLowerCase()) controller?.stop(); });
          provider.on('chainChanged', () => controller?.stop()); provider.on('disconnect', () => controller?.stop());
        }
      }
      return provider.request(args);
    } };
    const walletRead = async method => { if (!['eth_accounts', 'eth_chainId'].includes(method)) throw Error('WALLET_READ_REJECTED'); return bridge.request({ method, params: [] }); };
    const preflight = window.createManualClaimPreflight({ rpc, walletRead, ethers: E, policy: P, profile: window.ANUBIS_QUOTE_PROFILE,
      onStage(name, details = {}) {
        const stages = { LOCAL_POLICY: '本次測試設定', CHAIN_ACCOUNT: '網路與錢包', SOURCE_PINS: '合約程式碼',
          ORDERS_AND_FEE_LEDGER: '訂單與費用餘額', REWARD_NET_MODEL: '獎勵淨估價', LATEST_ELIGIBILITY: '最新額度與可領狀態', FINAL_STATE: '最後狀態核對' };
        if (!Object.prototype.hasOwnProperty.call(stages, name)) return;
        lastReadStage = stages[name];
        for (const key of ['walletChainId', 'rpcChainId']) if (typeof details[key] === 'string' && /^[0-9]{1,16}$/.test(details[key])) observedNetworks[key] = details[key];
        if (active) say('正在唯讀核對：' + diagnostic());
      } });
    controller = window.createManualClaimController({ provider: bridge, preflight, rpc, ethers: E, policy: P, storage: localStorage, locks: navigator.locks, onState: render });
    return controller;
  }
  $('prepare').onclick = async () => {
    if (active) return; if (!$('read-consent').checked) { say('請先同意公開地址唯讀查詢。'); return; }
    try { const engine = buildController(); lastReadStage = '錢包連線'; delete observedNetworks.walletChainId; delete observedNetworks.rpcChainId; setActive(true); await engine.prepare($('wallet').value.trim()); }
    catch (error) { clearReview('無可批准核對卡。'); const code = errorCode(error); say('未能完成唯讀準備：' + code + '。' + errorExplanation(code)); }
    finally { setActive(false); }
  };
  $('send-consent').onchange = updateSend;
  $('wallet').oninput = () => { if (!active) clearReview('地址欄已變更，請重新做唯讀預檢。'); };
  $('send').onclick = async () => {
    if (active || !review || !$('send-consent').checked || P.executionEnabled !== true) return;
    const approved = review;
    try { setActive(true); await controller.sendApproved({ acknowledged: true, reviewDigest: approved.reviewDigest }); }
    catch (error) { clearReview('核對卡未通過最後驗證，未自動套用新參數。'); say('已停止：' + errorCode(error) + '。請先查狀態或重新唯讀準備。'); }
    finally { setActive(false); }
  };
  $('check').onclick = async () => {
    if (active) return;
    try { setActive(true); await buildController().checkStatus($('tx-hash').value); }
    catch (error) { say('狀態未能完整驗證：' + errorCode(error) + '。不要重送。'); }
    finally { setActive(false); }
  };
  $('stop').onclick = () => { for (const abort of requests) abort.abort(); controller?.stop(); clearReview('本頁停止新簽送；若錢包仍顯示請求，請在Bitget拒絕。'); say('停止不會取消已產生或已送出的交易；已有請求只能查狀態。'); setActive(active); };
  if (!E || !P || typeof window.createManualClaimPreflight !== 'function') { $('prepare').disabled = true; $('mode').textContent = '草稿元件尚未齊備，無法請求錢包。'; say('尚未完成本機整合。'); return; }
  $('mode').textContent = P.executionEnabled === true ? '此版本允許經核對卡與明確同意後，請求一次主網簽署並送出。' : 'executionEnabled=false：此本機草稿僅能唯讀準備，主網簽送停用。';
  try {
    const engine = buildController(), saved = engine.getState().record;
    if (saved) { $('wallet').value = saved.card.wallet; setActive(false); }
    else say('程式已載入。尚未連接錢包、簽署或廣播。');
  } catch (error) { $('prepare').disabled = true; say('本機紀錄或環境未能驗證：' + errorCode(error) + '。請勿重新送出既有交易。'); }
})();
