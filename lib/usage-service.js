const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { parseWindow } = require('./usage');

let worker = null;
let sequence = 0;
let generation = 0;
const pending = new Map();
const inflight = new Map();

function failWorker(instance, error) {
  if (worker !== instance) return;
  worker = null;
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(error);
  }
  pending.clear();
  inflight.clear();
  void instance.terminate();
}

function getWorker() {
  if (worker) return worker;
  const instance = new Worker(path.join(__dirname, 'usage-worker.js'));
  worker = instance;
  instance.on('message', ({ id, data, error }) => {
    if (worker !== instance) return;
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    clearTimeout(task.timer);
    if (error) task.reject(new Error(error));
    else task.resolve(data);
    if (!pending.size) instance.unref();
  });
  instance.on('error', (error) => failWorker(instance, error));
  instance.on('exit', (code) => failWorker(instance, new Error('Usage worker exited: ' + code)));
  instance.unref();
  return instance;
}

function request(action, opts) {
  const instance = getWorker();
  const id = ++sequence;
  instance.ref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failWorker(instance, new Error('Usage worker timed out')), 120000);
    pending.set(id, { resolve, reject, timer });
    try {
      instance.postMessage({ id, action, opts });
    } catch (error) {
      failWorker(instance, error);
    }
  });
}

function collectUsage(opts = {}) {
  const normalized = { window: parseWindow(opts.window ?? opts.days), force: !!opts.force };
  const key = generation + ':' + normalized.window + ':' + normalized.force;
  if (inflight.has(key)) return inflight.get(key);
  const task = request('collect', normalized).finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

function clearUsageCache() {
  generation++;
  if (!worker) return Promise.resolve();
  return request('clear');
}

async function closeUsageWorker() {
  if (!worker) return;
  const instance = worker;
  worker = null;
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error('Usage worker closed'));
  }
  pending.clear();
  inflight.clear();
  await instance.terminate();
}

module.exports = { collectUsage, clearUsageCache, closeUsageWorker };
