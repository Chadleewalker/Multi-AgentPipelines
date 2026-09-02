// Frozen acceptance test — repo-324, the [guard] half: pipeline-first enforcement is added
// BESIDE the existing machine-level session guard, not on top of its grave.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It pins
// the slice of C9 that says "existing session-guard ... suites remain green" — stated here
// as behaviour rather than as a call into `scripts/test-session-guard.sh`, because that
// script is a frozen path and a frozen suite must never depend on running one.
//
// C9 is the only criterion this file serves. Nothing red belongs here: a [guard] file that
// is red at the fork point is a stale pin and refuses the freeze outright.
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a flat scratch
// directory beside the suite, so this file requires nothing from its own folder. It resolves
// the repository the same way every suite here does — the tree it sits in, never the cwd.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SESSION_GUARD = path.join(REPO, 'scripts', 'session-guard.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

// One decision from the EXISTING guard, in its own vocabulary: a JSON object on stdin, a
// verdict in the exit code. 0 allowed, 2 refused.
function judge(payload, cwd) {
  return spawnSync(process.execPath, [SESSION_GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    timeout: 60000,
    windowsHide: true,
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-324-'));

try {
  check('C9 the existing write guard is still present at scripts/session-guard.js',
    fs.existsSync(SESSION_GUARD));

  // The machine-level rules are about the HOST, not about any repository, so they answer in
  // a plain directory that is not a checkout at all. Pipeline-first protection is a
  // repository-scoped policy and has no business removing them.
  const catastrophic = judge({ cwd: tmp, action: 'shell', command: 'rm -rf ~' }, tmp);
  check(`C9 the existing guard still REFUSES a machine-level catastrophic delete (\`rm -rf ~\`) — exit 2, got ${catastrophic.status}`,
    catastrophic.status === 2);

  // The other edge of the same rule, and the one that gets a guard uninstalled when it goes:
  // read-only inspection is not a write, and refusing it would be over-blocking.
  const inspect = judge({ cwd: tmp, action: 'shell', command: 'git status' }, tmp);
  check(`C9 the existing guard still ALLOWS read-only inspection (\`git status\`) — exit 0, got ${inspect.status}`,
    inspect.status === 0);

  // A folder that is not a repository belongs to no project, and every other project on this
  // host must stay unaffected by anything this issue installs.
  const elsewhere = judge({ cwd: tmp, action: 'write', path: path.join(tmp, 'scratch.txt') }, tmp);
  check(`C9 the existing guard still ALLOWS an ordinary write in a folder that is not a repository — exit 0, got ${elsewhere.status}`,
    elsewhere.status === 0);

  // Host-only paths stay writable in this project's own checkout. C6 says ignored host
  // artifacts remain governed by existing policy; this is what "existing policy" is.
  const hostArtifact = judge({ cwd: REPO, action: 'write', path: path.join(REPO, 'runs', 'guard-probe.json') }, REPO);
  check(`C9 the existing guard still ALLOWS a write to an ignored host path (runs/) in this checkout — exit 0, got ${hostArtifact.status}`,
    hostArtifact.status === 0);

  // The tracked-hook boundary this repo already enforces: nothing tracked here configures an
  // agent hook, because every tracked file is cloned into a task container that has no agent
  // CLI. C5 installs hooks for two clients; it must keep installing them HOST-SIDE.
  let claudeSettings = null;
  try {
    claudeSettings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  } catch { claudeSettings = null; }
  check('C9 the tracked .claude/settings.json still declares no agent hook',
    claudeSettings !== null && !Object.prototype.hasOwnProperty.call(claudeSettings, 'hooks'));

  // The freeze contract this suite is written against. Protection work must not quietly
  // unfreeze the paths that make the freeze mean anything.
  let policy = null;
  try {
    policy = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
  } catch { policy = null; }
  const frozen = new Set((policy && policy.frozenPaths) || []);
  for (const pinned of ['tools/run-acceptance.sh', 'tests/unit/', 'contracts/control-plane.json', 'runner/control-plane.js']) {
    check(`C9 pipeline.config.json still freezes \`${pinned}\``, frozen.has(pinned));
  }
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
}
process.exit(failed);
