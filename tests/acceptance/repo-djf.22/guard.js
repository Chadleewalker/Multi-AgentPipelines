// Frozen acceptance [guard] — repo-djf.22: existing managed-session safety remains intact.
// PAIRING: C1 -> G1 single-login exclusivity; C3 -> G2 failed-refresh recovery;
// C4 -> G3 mandatory-profile declaration and G4 owned-lifecycle cleanup.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const auth = require(path.join(REPO, 'runner', 'codex-auth.js'));
const lock = require(path.join(REPO, 'runner', 'lock.js'));
const runner = require(path.join(REPO, 'runner', 'run.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function session(token) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: token } });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-guard-'));
  try {
    const lane = path.join(root, 'lane');
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, 'auth.json'), session('guard-before'));
    const first = await auth.stageTaskCache({ cacheRoot: lane, taskId: 'first' });
    let busy = null;
    try {
      await auth.stageTaskCache({ cacheRoot: lane, taskId: 'must-wait', wait: false,
        timeoutMs: 15, retryMs: 2 });
    } catch (error) { busy = error; }
    const copiesWhileHeld = fs.readdirSync(path.join(lane, 'tasks')).length;
    check('G1 C1 [guard] one saved ChatGPT login grants one exclusive handoff and never clones it concurrently',
      !!first && /credential lane is busy/i.test(String(busy && busy.message)) && copiesWhileHeld === 1,
      JSON.stringify({ busy: busy && busy.message, copiesWhileHeld }));

    fs.writeFileSync(path.join(first.hostPath, 'auth.json'), '{ invalid refresh');
    let releaseError = null;
    try { await auth.releaseTaskCache(first); } catch (error) { releaseError = error; }
    check('G2 C3 [guard] failed refresh preserves both the prior durable cache and recoverable task copy',
      !!releaseError
        && fs.readFileSync(path.join(lane, 'auth.json'), 'utf8') === session('guard-before')
        && fs.existsSync(first.hostPath),
      String(releaseError && releaseError.message));

    // Repair the retained handoff so this guard itself leaves no lane lock or task copy.
    fs.writeFileSync(path.join(first.hostPath, 'auth.json'), session('guard-recovered'));
    await auth.releaseTaskCache(first);

    const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    const regression = String(project.regressionCommand || '').trim().split(/\s+/).pop();
    check('G3 C4 [guard] the complete mandatory regression profile remains required and names an existing command',
      project.regressionPolicy === 'required' && !!regression
        && fs.existsSync(path.resolve(REPO, regression.replace(/^[\'\"]|[\'\"]$/g, ''))),
      JSON.stringify({ policy: project.regressionPolicy, command: project.regressionCommand }));

    const target = path.join(root, 'owned-target');
    fs.mkdirSync(target, { recursive: true });
    const held = lock.acquire(REPO, target, 'accept-djf22-guard-owner');
    let downs = 0;
    const cleanup = held.ok && runner.cleanupOwnedLifecycle(
      { targetRepoPath: target }, REPO, { error() {} }, 'accept-djf22-guard/cleanup', {
        ownership: held.ownership,
        networkDown: () => { downs += 1; return { ok: true }; },
      });
    const reacquired = held.ok && lock.acquire(REPO, target, 'accept-djf22-guard-observer');
    check('G4 C4 [guard] owned lifecycle cleanup tears down its network before releasing the exact observer lock',
      !!held.ok && cleanup && cleanup.ok === true && downs === 1 && reacquired && reacquired.ok === true,
      JSON.stringify({ held: held.ok, cleanup, downs, reacquired: reacquired && reacquired.ok }));
    if (reacquired && reacquired.ok) lock.release(REPO, target, reacquired.ownership);
  } catch (error) {
    check('G1-G4 C1/C3/C4 [guard] fork-point fixture completes', false, error.stack || String(error));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  process.exitCode = failed;
}
main().catch((error) => {
  check('G1-G4 C1/C3/C4 [guard] fork-point fixture settles', false, error.stack || String(error));
  process.exitCode = 1;
});
