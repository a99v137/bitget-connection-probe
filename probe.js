export const EXPECTED_CHAIN = 6714n;
const ALLOWED = new Set(['eth_requestAccounts', 'eth_chainId', 'eth_accounts']);
export function selectProvider(w) {
  const candidates = [w.bitkeep?.ethereum, w.bitget?.ethereum,
    ...(Array.isArray(w.ethereum?.providers) ? w.ethereum.providers.filter(p => p?.isBitKeep || p?.isBitget) : []),
    (w.ethereum?.isBitKeep || w.ethereum?.isBitget) ? w.ethereum : null];
  return candidates.find(p => p && typeof p.request === 'function') || null;
}
export function normalizeChain(raw) {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) throw new Error('invalid_chain');
  return BigInt(raw);
}
export function validateAccounts(raw) {
  if (!Array.isArray(raw) || raw.length > 100 || raw.some(a => typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error('invalid_accounts');
  return [...raw];
}
export async function safeRequest(provider, method, userConsent = false) {
  if (!ALLOWED.has(method)) throw new Error('blocked_method');
  if (method === 'eth_requestAccounts' && !userConsent) throw new Error('consent_required');
  return provider.request({method});
}
export async function readSnapshot(provider, requestConnection = false) {
  const before = normalizeChain(await safeRequest(provider, 'eth_chainId'));
  // No connection prompt on a mismatched chain.
  if (before !== EXPECTED_CHAIN) return {chain: before.toString(), matched: false, accounts: []};
  const accounts = validateAccounts(await safeRequest(provider, requestConnection ? 'eth_requestAccounts' : 'eth_accounts', requestConnection));
  const after = normalizeChain(await safeRequest(provider, 'eth_chainId'));
  if (before !== after) throw new Error('chain_changed');
  return {chain: after.toString(), matched: true, accounts};
}
