/* Bounded, read-only JSON-RPC batches. No wallet requests or retries. */
(function (root) {
  'use strict';
  const READ_RPC = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getStorageAt', 'eth_getCode', 'eth_call',
    'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_gasPrice', 'eth_estimateGas']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function failure(code = 'READ_QUERY_FAILED_OR_UNKNOWN') { const error = new Error(code); error.code = code; return error; }
  function bounded(value, fallback, ceiling) {
    return value === undefined ? fallback : Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : 0;
  }
  function createAnubisReadRpc(options = {}) {
    const { url } = options, fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const timeoutMs = bounded(options.timeoutMs, 12000, 12000), batchSize = bounded(options.maxBatchSize, 8, 8);
    const concurrency = bounded(options.maxConcurrentBatches, 2, 2);
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || typeof fetchImpl !== 'function' || !timeoutMs || !batchSize || !concurrency)
      throw failure();
    let nextId = 0, generation = 0, scheduled = false, httpRequests = 0, rpcCalls = 0;
    const queue = [], active = new Set();
    function settle(item, error, value) {
      if (item.settled) return;
      item.settled = true;
      if (error) item.reject(failure(error)); else item.resolve(value);
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; pump(); });
    }
    function finish(batch, code, results) {
      if (batch.done) return;
      batch.done = true; clearTimeout(batch.timer); active.delete(batch);
      for (const item of batch.items) {
        const entry = results?.get(item.id);
        settle(item, code || (entry && own(entry, 'error') ? 'READ_QUERY_FAILED_OR_UNKNOWN' : null), entry?.result);
      }
      schedule();
    }
    function validate(data, items) {
      if (!Array.isArray(data) || data.length !== items.length) throw failure('READ_BATCH_RESPONSE_INVALID');
      const wanted = new Set(items.map(item => item.id)), results = new Map();
      for (const entry of data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.jsonrpc !== '2.0' ||
          !wanted.has(entry.id) || results.has(entry.id) || own(entry, 'result') === own(entry, 'error'))
          throw failure('READ_BATCH_RESPONSE_INVALID');
        if (own(entry, 'error') && (!entry.error || typeof entry.error !== 'object' ||
          !Number.isInteger(entry.error.code) || typeof entry.error.message !== 'string'))
          throw failure('READ_BATCH_RESPONSE_INVALID');
        results.set(entry.id, entry);
      }
      return results;
    }
    function pump() {
      while (queue.length && active.size < concurrency) {
        const items = queue.splice(0, batchSize), controller = new AbortController();
        const batch = { items, controller, done: false, timer: null, generation };
        active.add(batch);
        batch.timer = setTimeout(() => { finish(batch, 'READ_QUERY_FAILED_OR_UNKNOWN'); controller.abort(); }, timeoutMs);
        Promise.resolve().then(() => {
          if (batch.done || batch.generation !== generation) return null;
          httpRequests++;
          return fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items.map(item => ({ jsonrpc: '2.0', id: item.id, method: item.method, params: item.params }))),
            credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
        }).then(async response => {
          if (batch.done || batch.generation !== generation) return;
          if (!response?.ok) throw failure();
          const data = await response.json();
          if (batch.done || batch.generation !== generation) return;
          finish(batch, null, validate(data, items));
        }).catch(error => {
          if (!batch.done) finish(batch, error?.code === 'READ_BATCH_RESPONSE_INVALID' ? error.code : 'READ_QUERY_FAILED_OR_UNKNOWN');
        });
      }
    }
    function rpc(method, params = []) {
      if (!READ_RPC.has(method)) return Promise.reject(failure('READ_ONLY_RPC_REJECTED'));
      if (!Array.isArray(params) || nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(failure());
      rpcCalls++;
      return new Promise((resolve, reject) => { queue.push({ id: ++nextId, method, params, resolve, reject, settled: false }); schedule(); });
    }
    rpc.abortAll = function () {
      generation++;
      for (const item of queue.splice(0)) settle(item, 'READ_QUERY_FAILED_OR_UNKNOWN');
      for (const batch of Array.from(active)) { finish(batch, 'READ_QUERY_FAILED_OR_UNKNOWN'); batch.controller.abort(); }
    };
    rpc.stats = () => Object.freeze({ httpRequests, rpcCalls, queued: queue.length, inFlightBatches: active.size });
    return rpc;
  }
  root.createAnubisReadRpc = createAnubisReadRpc;
  if (typeof module !== 'undefined' && module.exports) module.exports = createAnubisReadRpc;
})(typeof window !== 'undefined' ? window : globalThis);
