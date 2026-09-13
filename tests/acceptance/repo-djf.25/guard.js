// Frozen acceptance [guard] — repo-djf.25: existing lifecycle and mandatory-profile ownership.
// PAIRING (criterion -> tests): C1 -> G3,T1; C2 -> T2,T3,T4,T6;
// C3 -> T2,T3,T4,T5; C4 -> G1,T5,T6; C5 -> G1,G2,G3,T1,T6.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const runner = require(path.join(REPO, 'runner', 'run.js'));
const { resolveHostShell } = require(path.join(REPO, 'runner', 'host-shell.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf25-guard-'));
let removed = false;
try {
  const effects = [];
  let downs = 0;
  let releases = 0;
  const cleanup = runner.cleanupOwnedLifecycle(
    { targetRepoPath: path.join(root, 'target') }, REPO,
    { error(_trace, message) { effects.push(`error:${message}`); } },
    'accept-djf25-guard/cleanup', {
      ownership: { token: 'opaque-fixture-owner' },
      networkDown() { downs += 1; effects.push('network.down'); return { ok: true }; },
      releaseLock() { releases += 1; effects.push('lock.release'); },
    }
  );
  check('G1 C4/C5 [guard] owned lifecycle cleanup tears down the network then releases the target lock exactly once',
    cleanup && cleanup.ok === true && downs === 1 && releases === 1
      && effects.join(',') === 'network.down,lock.release',
    JSON.stringify({ cleanup, downs, releases, effects }));

  const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
  const hostShell = resolveHostShell();
  const listed = hostShell.ok ? spawnSync(hostShell.command, ['scripts/test-ci.sh', '--list'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 20000,
  }) : { status: null, stdout: '', error: new Error(hostShell.reason) };
  const suites = String(listed.stdout || '').split(/\r?\n/).filter(Boolean);
  check('G2 C5 [guard] the required publication profile still names exactly 42 distinct mandatory suites',
    listed.status === 0 && !listed.error
      && project.regressionPolicy === 'required'
      && project.regressionCommand === 'bash scripts/test-ci.sh'
      && suites.length === 42 && new Set(suites).size === 42
      && suites.every((name) => /^test-[A-Za-z0-9._-]+\.sh$/.test(name)
        && fs.existsSync(path.join(REPO, 'scripts', name))),
    JSON.stringify({ status: listed.status, error: listed.error && listed.error.message,
      policy: project.regressionPolicy, command: project.regressionCommand,
      count: suites.length, distinct: new Set(suites).size }));

  const shapes = ['repo-djf.22', 'repo-djf.23', 'repo-djf.24'].map((suite) => ({
    suite,
    guard: fs.existsSync(path.join(REPO, 'tests', 'acceptance', suite, 'guard.js')),
    test: fs.existsSync(path.join(REPO, 'tests', 'acceptance', suite, 'test.js')),
  }));
  check('G3 C1/C5 [guard] all three predecessor contracts retain their complete two-file frozen shape',
    shapes.every((item) => item.guard && item.test), JSON.stringify(shapes));
} catch (error) {
  check('G1-G3 C1/C4/C5 [guard] fork-point fixture completes', false,
    String(error && error.stack || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  removed = !fs.existsSync(root);
}
check('G1 C5 [guard] the lifecycle guard removes its private fixture tree', removed);
process.exitCode = failed;
