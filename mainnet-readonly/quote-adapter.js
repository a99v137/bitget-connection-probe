/* Read-only counterfactual eth_call adapter. Outputs are not yet trusted signing valuations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createAnubisQuoteAdapter = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (options) {
  'use strict';
  let { rpc, ethers, profile, wallet, gates: G, lifetimeMs = 30000, maxFutureSkewMs = 2000 } = options;
  wallet = G.address(wallet);
  let checkedBlockHash = null;
  let pendingBlockHash = null, pendingPinCheck = null;
  const MODEL_AUDITED_FOR_SIGNING = false;
  async function checkPins(block) {
    if (checkedBlockHash === block.hash) return;
    if (pendingBlockHash === block.hash && pendingPinCheck) return pendingPinCheck;
    pendingBlockHash = block.hash;
    pendingPinCheck = verifyPins(block);
    return pendingPinCheck;
  }
  async function verifyPins(block) {
    if (ethers.sha256(profile.helper_runtime) !== '0x' + profile.helper_runtime_sha256) throw new G.GateError('HELPER_HASH_MISMATCH');
    if (await rpc('eth_getCode', [wallet, block.number]) !== '0x') throw new G.GateError('QUOTE_WALLET_MUST_HAVE_NO_CODE');
    await Promise.all([
      ...Object.entries(profile.runtime_sha256_pins).map(async ([address, expected]) => {
        if (ethers.sha256(await rpc('eth_getCode', [address, block.number])) !== '0x' + expected) throw new G.GateError('QUOTE_CALLEE_CODE_CHANGED');
      }),
      ...Object.entries(profile.eip1967_slot_pins).map(async ([address, expected]) => {
        if ((await rpc('eth_getStorageAt', [address, profile.eip1967_implementation_slot, block.number])).toLowerCase() !== expected) throw new G.GateError('QUOTE_IMPLEMENTATION_CHANGED');
      })
    ]);
    checkedBlockHash = G.hash(block.hash);
  }
  return Object.freeze({
    ready: true, trustedForSigning: false,
    async quoteAt(block, index, minOutRaw) {
      const sourceValidity = G.sourceFreshnessGate(block, { nowMs: Date.now(), maxAgeMs: lifetimeMs, maxFutureSkewMs });
      await checkPins(block);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [G.uint(minOutRaw), G.uint(index)]);
      const overrides = {
        [wallet]: { code: profile.helper_runtime },
        [profile.addresses.bond]: { stateDiff: { '0x00000000000000000000000000000000000000000000000000000000000000ae': '0x' + '0'.repeat(64) } }
      };
      const response = await rpc('eth_call', [{ from: wallet, to: wallet, data, value: '0x0', gas: '0x7a1200', gasPrice: '0x0' }, block.number, overrides]);
      if (!/^0x[0-9a-f]{128}$/i.test(response)) throw new G.GateError('QUOTE_RESPONSE_INVALID');
      const [claimedRaw, netFeeAssetRaw] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], response);
      G.sourceFreshnessGate(block, { nowMs: Date.now(), maxAgeMs: lifetimeMs, maxFutureSkewMs });
      // Receiving a response never extends the source block's validity.
      const observedAtMs = sourceValidity.sourceTimestampMs;
      return Object.freeze({ claimedRaw, netFeeAssetRaw, reliableMinimumNetRaw: G.uint(minOutRaw), sourceBlockHash: G.hash(block.hash),
        sourceBlockNumber: G.uint(block.number), ts: G.uint(block.timestamp), observedAtMs, receivedAtMs: Date.now(), validUntilMs: sourceValidity.validUntilMs,
        pinsValid: true, modelAudited: MODEL_AUDITED_FOR_SIGNING, feeAssetMappingVerified: false, liquidityVerified: false, pathVerified: false,
        actualMainnetQuotaChecked: false, executionReady: false,
        counterfactual: 'wallet code override plus bond used-slot reset; current real quota must be checked separately' });
    }
  });
});
