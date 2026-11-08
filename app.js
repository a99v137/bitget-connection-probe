import {selectProvider, readSnapshot} from './probe.js';
const $ = id => document.getElementById(id);
let provider = null, generation = 0, busy = false, subscribed = null;
const msg = text => { $('status').textContent = text; };
function wipe() { generation++; $('address').textContent = '未讀取'; $('chain').textContent = '未讀取'; }
function invalidated() { wipe(); msg('錢包或網路狀態已變更。請重新檢查，舊資料不再有效。'); }
function detach() {
  if (subscribed && typeof subscribed.removeListener === 'function') {
    for (const event of ['accountsChanged','chainChanged','disconnect']) subscribed.removeListener(event, invalidated);
  }
  subscribed = null;
}
function detect() {
  detach(); wipe(); provider = selectProvider(window);
  $('provider').textContent = provider ? '找到 Bitget／BitKeep 注入介面（不是品牌真偽認證）' : '找不到 Bitget 注入介面';
  if (provider && typeof provider.on === 'function' && typeof provider.removeListener === 'function') {
    subscribed = provider;
    for (const event of ['accountsChanged','chainChanged','disconnect']) provider.on(event, invalidated);
  }
  msg(provider ? '尚未讀取帳戶。請先確認來源網址，再按下方按鈕。' : '請用 Bitget Wallet 內建 DApp 瀏覽器開啟此網址，再點重新偵測。Safari／Chrome 沒有注入介面是正常的。');
}
async function run(connect) {
  if (busy) return;
  if (!provider) { detect(); if (!provider) return; }
  if (!window.isSecureContext) { msg('需要 HTTPS 或本機 localhost；不在不安全頁面請求連接。'); return; }
  if (connect && !$('consent').checked) { msg('請先閱讀並勾選公開地址分享說明。'); return; }
  busy = true; $('connect').disabled = $('read').disabled = true;
  wipe(); const ticket = generation;
  msg('等待錢包回應。可在錢包拒絕；不要簽署交易或訊息。');
  // Timeout only affects this page. It cannot cancel a wallet prompt already open.
  let timer;
  try {
    const result = await Promise.race([readSnapshot(provider, connect), new Promise((_,reject) => {timer=setTimeout(()=>reject(new Error('timeout')),60000);})]);
    if (ticket !== generation) return;
    $('chain').textContent = result.chain + (result.matched ? '，符合預期 6714' : '，不符預期 6714；已停止，不會自動切換');
    $('address').textContent = result.accounts.length ? result.accounts[0] : '未提供帳戶';
    msg(!result.matched ? '請自行在錢包選擇已核實的 Anubis 網路，再檢查。' : result.accounts.length ? '連線讀取完成。這不證明預簽、交易、領取或鎖屏執行可用。' : '目前未授權帳戶；可在需要時按「請求連接」。');
  } catch (e) {
    if (ticket !== generation) return;
    const code = Number.isInteger(e?.code) ? e.code : null;
    msg(e?.message === 'timeout' ? '等候逾時。請先回錢包處理或取消尚未完成的彈窗，再重試。' : code === 4001 ? '你已拒絕連接，沒有簽署或送出交易。' : code === -32002 ? '錢包已有待處理請求，請先回錢包處理。' : '無法完成讀取。可能網路／帳戶切換或回應格式不符。未顯示原始錯誤，避免暴露額外資訊。');
  } finally { clearTimeout(timer); busy=false; $('connect').disabled=$('read').disabled=false; }
}
$('connect').onclick = () => run(true);
$('read').onclick = () => run(false);
$('detect').onclick = () => { if (!busy) detect(); };
$('clear').onclick = () => {wipe(); $('consent').checked=false; msg('已清除本頁顯示；這不是撤銷錢包授權。請在 Bitget 的已連接網站設定中自行移除。若有彈窗仍需自行取消。');};
window.addEventListener('pagehide', () => {wipe(); detach();});
window.addEventListener('pageshow', detect);
