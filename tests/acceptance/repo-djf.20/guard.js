// Frozen acceptance [guard] — repo-djf.20: existing host and regression coverage stays green.
// CRITERION MAP: C4 real Windows-host wrapper integration -> C4.1 below.
// CRITERION MAP: C4 focused offline guards + mandatory profile -> C4.2-C4.5 below.
// C1-C3 are served only by test.js; no C1-C3 check in this file is grandfathered green.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const state = require(path.join(REPO, 'runner', 'preparation-state.js'));
const coordinator = require(path.join(REPO, 'scripts', 'prepare-batch.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function same(left, right) {
  return state.canonicalStringify(left) === state.canonicalStringify(right);
}
function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

async function windowsIntegration() {
  if (process.platform !== 'win32') {
    check('C4.1 [guard] real platform integration is registered for an actual Windows host', true,
      `not exercised on ${process.platform}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf20-win-'));
  const root = path.join(tmp, 'preparations');
  const batch = 'repo-djf20-real-windows';
  const id = 'repo-djf20-real-wrapper';
  let wrapper = null; let startedInput = null; let persisted = null; let whileLive = null;
  try {
    state.createManifest(root, batch, { issues: [{ id }] });
    const recordingState = {
      ...state,
      createWorkerNonce: () => 'a'.repeat(32),
      writeWorkerStarted: (...args) => {
        startedInput = args[3];
        persisted = state.writeWorkerStarted(...args);
        whileLive = state.deriveState(root, batch);
        return persisted;
      },
    };
    const running = coordinator.runWorker(root, batch, {
      id, action: 'author-proof', built: { cfg: {} },
    }, 'fixture.json', recordingState, {
      spawn: () => {
        wrapper = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(() => {}, 1000)'], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        });
        return wrapper;
      },
      ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
    });
    check('C4.1 [guard] real Windows platform path observes its live spawned wrapper',
      persisted && startedInput && persisted.pid === wrapper.pid
        && persisted.process && persisted.process.pid === persisted.pid
        && same(persisted.process, startedInput.process)
        && whileLive && whileLive.issues[0].state === 'authoring'
        && whileLive.issues[0].liveness.worker === 'live',
      JSON.stringify({ startedInput, persisted, issue: whileLive && whileLive.issues[0] }));
    try { wrapper.kill('SIGKILL'); } catch {}
    await running;
    wrapper = null;
  } finally {
    if (wrapper) try { wrapper.kill('SIGKILL'); } catch {}
    rmrf(tmp);
  }
}

async function main() {
  await windowsIntegration();
  const focused = [
    ['C4.2 [guard] shared lock liveness remains green offline', 'tests/unit/lock.test.js'],
    ['C4.3 [guard] preparation-state records remain green offline', 'tests/unit/preparation-state.test.js'],
    ['C4.4 [guard] preparation coordinator remains green offline', 'tests/unit/prepare-batch.test.js'],
  ];
  for (const [name, relative] of focused) {
    const result = spawnSync(process.execPath, [path.join(REPO, relative)], {
      encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    check(name, result.status === 0 && !result.error,
      String(result.stderr || result.stdout || result.error || '').slice(-1600));
  }
  check('C4.5 [guard] the mandatory regression profile remains separately required', (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
      return cfg.regressionPolicy === 'required'
        && cfg.regressionCommand === 'bash scripts/test-ci.sh'
        && fs.existsSync(path.join(REPO, 'scripts', 'test-ci.sh'));
    } catch { return false; }
  })());
}

main().then(() => { process.exitCode = failed; }).catch((error) => {
  check('C4 [guard] host integration fixture completes', false, error.stack || String(error));
  process.exitCode = 1;
});
