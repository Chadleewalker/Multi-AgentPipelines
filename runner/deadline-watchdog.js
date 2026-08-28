// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// An active-container deadline that does not share the orchestrator's event loop.
//
// A runner worker can be inside a bounded synchronous clone, Beads write, or publication
// call when another container reaches its wall-clock deadline. A setTimeout in the main
// thread cannot fire until that call returns. This worker owns the clock and the bounded
// `docker kill`, so the workload is stopped on time even while orchestration is blocked.
'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { runSync, failureText } = require('./process');

const WORKER_MARKER = 'pipeline-container-deadline';

if (!isMainThread && workerData && workerData.marker === WORKER_MARKER) {
  let timer = setTimeout(() => {
    parentPort.postMessage({ type: 'deadline' });
    const result = runSync(workerData.command, workerData.args, {
      timeoutMs: workerData.timeoutMs,
      label: workerData.label,
      env: workerData.env,
    });
    parentPort.postMessage({
      type: 'result',
      ok: result.status === 0,
      status: result.status,
      timedOut: !!result.timedOut,
      error: result.status === 0 ? '' : failureText(result, `${workerData.label} failed`),
    });
    timer = null;
  }, workerData.delayMs);

  parentPort.on('message', (message) => {
    if (message !== 'cancel') return;
    if (timer) clearTimeout(timer);
    timer = null;
    parentPort.postMessage({ type: 'cancelled' });
    parentPort.close();
  });
}

function createDeadlineWatchdog(options) {
  const worker = new Worker(__filename, {
    workerData: {
      marker: WORKER_MARKER,
      delayMs: Math.max(0, Number(options.delayMs) || 0),
      command: options.command,
      args: options.args || [],
      timeoutMs: options.timeoutMs,
      label: options.label || 'deadline action',
      env: options.env,
    },
  });
  let fired = false;
  let completed = false;
  let result = null;

  worker.on('message', (message) => {
    if (message.type === 'deadline') {
      fired = true;
      if (options.onDeadline) options.onDeadline();
    } else if (message.type === 'result') {
      completed = true;
      result = message;
      if (options.onResult) options.onResult(message);
    }
  });

  async function cancel() {
    if (completed) {
      await worker.terminate();
      return;
    }
    try { worker.postMessage('cancel'); } catch { /* worker already exited */ }
    await worker.terminate();
  }

  return {
    get fired() { return fired; },
    get completed() { return completed; },
    get result() { return result; },
    cancel,
  };
}

module.exports = { createDeadlineWatchdog, WORKER_MARKER };
