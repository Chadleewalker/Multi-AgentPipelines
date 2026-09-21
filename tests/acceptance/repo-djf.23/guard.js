// Frozen acceptance [guard] — repo-djf.23: existing single-lane ownership stays intact.
// PAIRING (criterion -> tests): C1 -> G1,T1,T2; C2 -> G2,T3,T5;
// C3 -> G3,T3,T4; C4 -> G4,G5,G6,T1,T2,T3,T4,T5,T6.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const auth = require(path.join(REPO, 'runner', 'codex-auth.js'));
const report = require(path.join(REPO, 'runner', 'report.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function session(token) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: token } });
}
function safe(value, secrets) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return !secrets.some((secret) => secret && text.includes(secret));
}

async function main() {
  const secrets = ['djf23-guard-before', 'djf23-guard-repaired'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf23-guard-'));
  let removed = false;
  try {
    const lane = path.join(root, 'lane');
    fs.mkdirSync(lane, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lane, 'auth.json'), session(secrets[0]), { mode: 0o600 });
    const canonical = fs.realpathSync(lane);
    const pre = await auth.preflight({ mode: 'chatgpt', cacheRoot: canonical,
      wait: false, timeoutMs: 20, retryMs: 2 });
    check('G1 C1 [guard] an existing absolute private single-lane root preflights canonically without disclosure',
      !!pre && pre.ok === true && path.resolve(pre.cacheRoot) === path.resolve(canonical)
        && safe(pre, secrets),
      JSON.stringify({ ok: pre && pre.ok, canonical: pre && path.resolve(pre.cacheRoot || '') === path.resolve(canonical) }));

    const first = await auth.stageTaskCache({ cacheRoot: lane, taskId: 'guard-owner' });
    const lock = path.join(lane, '.lane.lock');
    const lockBefore = fs.readFileSync(lock, 'utf8');
    let busy = null;
    try {
      await auth.stageTaskCache({ cacheRoot: lane, taskId: 'guard-contender', wait: false,
        timeoutMs: 15, retryMs: 2 });
    } catch (error) { busy = error; }
    const lockAfter = fs.readFileSync(lock, 'utf8');
    const copies = fs.readdirSync(path.join(lane, 'tasks'));
    check('G3 C3 [guard] a second owner is refused without replacing the live owner lock or cloning its handoff',
      /credential lane is busy/i.test(String(busy && busy.message))
        && lockAfter === lockBefore && copies.length === 1,
      JSON.stringify({ busy: !!busy, sameLock: lockAfter === lockBefore, copies: copies.length }));

    fs.writeFileSync(path.join(first.hostPath, 'auth.json'), '{ invalid refresh');
    let refreshError = null;
    try { await auth.releaseTaskCache(first); } catch (error) { refreshError = error; }
    check('G2 C2 [guard] a failed refresh preserves the prior durable bytes and retained task copy',
      !!refreshError
        && fs.readFileSync(path.join(lane, 'auth.json'), 'utf8') === session(secrets[0])
        && fs.existsSync(first.hostPath) && !fs.existsSync(lock),
      JSON.stringify({ refreshFailed: !!refreshError, retained: fs.existsSync(first.hostPath),
        lockReleased: !fs.existsSync(lock) }));

    fs.writeFileSync(path.join(first.hostPath, 'auth.json'), session(secrets[1]));
    await auth.releaseTaskCache(first);
    const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    const regression = String(project.regressionCommand || '').trim().split(/\s+/).pop();
    const rendered = report.renderReport({
      runId: 'repo-djf23-guard', startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z', tasks: [{
        issueId: 'guard', outcome: 'failed', attempts: 1,
        error: String(busy && busy.message || ''),
      }],
    });
    check('G4 C4 [guard] existing errors and generated reports disclose no session bytes and cleanup owns no lane artifact',
      safe({ pre, busy: busy && busy.message, refreshError: refreshError && refreshError.message,
        rendered }, secrets)
        && !fs.existsSync(lock)
        && (!fs.existsSync(path.join(lane, 'tasks'))
          || fs.readdirSync(path.join(lane, 'tasks')).length === 0),
      JSON.stringify({ safe: safe(rendered, secrets), lock: fs.existsSync(lock) }));
    check('G5 C4 [guard] the complete mandatory regression profile remains required and names an existing command',
      project.regressionPolicy === 'required' && !!regression
        && fs.existsSync(path.resolve(REPO, regression.replace(/^[\'\"]|[\'\"]$/g, ''))),
      JSON.stringify({ policy: project.regressionPolicy, command: project.regressionCommand }));
  } catch (error) {
    check('G1-G6 C1-C4 [guard] fork-point fixture completes', false,
      String(error && error.stack || error).replace(/djf23-guard-(before|repaired)/g, '[redacted]'));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    removed = !fs.existsSync(root);
  }
  check('G6 C4 [guard] the focused guard removes its private fixture tree', removed);
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - G1-G6 C1-C4 [guard] fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
