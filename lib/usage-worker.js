const { parentPort } = require('node:worker_threads');
const usage = require('./usage');

parentPort.on('message', ({ id, action, opts }) => {
  try {
    const data = action === 'clear' ? usage.clearUsageCache() : usage.collectUsage(opts);
    parentPort.postMessage({ id, data });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || String(error) });
  }
});
