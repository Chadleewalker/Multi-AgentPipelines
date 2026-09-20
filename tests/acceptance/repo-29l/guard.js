// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
// [guard] repo-29l — the legacy live-run dashboard contract must survive this change.
//
// Serves criterion CC1's "preserves legacy /state schema and behavior ... refuses unknown
// routes" clause. This is an EXISTING-BEHAVIOUR pin, so it is GREEN at the fork point by
// construction and stays green once GET /conveyor-state is added beside it. It is run ALONE
// by the freeze gate's guard subset, so it requires nothing from its sibling test.js: it
// spawns the real scripts/dashboard.js exactly as the host does, over an empty runs root,
// and asserts only what the /state dashboard already promises today.
//
// Pairing: CC1 (legacy /state preserved; unknown routes refused). Every other CC1 clause and
// every other criterion is proved by the red test.js beside this file.

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dashboard.js');
const READY_RE = /^dashboard: http:\/\/127\.0\.0\.1:(\d+)\/$/m;

let failed = 0;
const kids = [];
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return !!cond;
}

function childEnv(overrides) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k === 'NODE_DEBUG') continue;
    if (/^DASHBOARD_/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, overrides);
}

function startDashboard(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false }); }, 15000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(READY_RE); if (m) finish({ ok: true, port: Number(m[1]), child }); });
    child.on('error', () => finish({ ok: false }));
    child.on('exit', () => finish({ ok: false }));
  });
}
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    try { child.kill(); } catch { resolve(); }
  });
}
function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  if (!check('CC1 [guard] scripts/dashboard.js exists at the fork point', fs.existsSync(SCRIPT))) return;
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-29l-'));
  const started = await startDashboard(childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: '0' }));
  if (!check('CC1 [guard] the legacy dashboard starts and announces a loopback port', started.ok)) return;
  const { port, child } = started;
  try {
    const state = await get(port, '/state');
    let st = null;
    try { st = JSON.parse(state.body); } catch { /* asserted below */ }
    check('CC1 [guard] GET /state answers 200 application/json',
      state.status === 200 && String(state.headers['content-type'] || '').startsWith('application/json'));
    check('CC1 [guard] GET /state is served Cache-Control: no-store',
      String(state.headers['cache-control'] || '') === 'no-store');
    check('CC1 [guard] /state carries the frozen legacy shape { schema:1, now, projects:[] }',
      !!st && st.schema === 1 && typeof st.now === 'string' && !Number.isNaN(Date.parse(st.now)) && Array.isArray(st.projects));

    const page = await get(port, '/');
    check('CC1 [guard] GET / answers 200 text/html',
      page.status === 200 && String(page.headers['content-type'] || '').startsWith('text/html'));

    const miss = await get(port, '/definitely-not-a-real-route-29l');
    check('CC1 [guard] an unknown route is refused with 404 and the exact body "not found\\n"',
      miss.status === 404 && miss.body === 'not found\n');
  } finally {
    await stop(child);
  }
}

main().then(() => {
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(failed);
}, (e) => {
  console.log(`FAIL - guard threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});
