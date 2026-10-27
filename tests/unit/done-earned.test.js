#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for "a success is earned, not defaulted" — runner/queue.js's
// missingSuccessEvidence and the place runner/run.js applies it, plus where task
// workspaces live (DESIGN.md §4.11, §4.2; change-log row `done-earned`; STATUS defect 15).
//
// THE DEFECT: a task's bind-mounted workspace vanished after the verifier ran, every write
// after it failed non-fatally, the container exited 0, and outcomeFor mapped exit 0 to
// `done` on the exit code alone — closing the issue with no commits, no PR and no
// evidence. The two fixtures the STATUS entry names are both here and both driven through
// the real runOneTask, not just the helper: a stub container that exits 0 and leaves
// nothing at all, and one that records a pass but leaves no commits. Both must come out
// `failed` with the issue BLOCKED, never closed. They are read against the ordinary pass
// fixture, which must still come out `done` with a PR — without it, a runner that marks
// everything failed would pass this suite.
//
// Plain Node, no framework, no Docker, no network, no real `bd` or `gh`: Beads goes through
// the PIPELINE_BD_CMD seam (a `.js` stub preloaded via NODE_OPTIONS into process.execPath),
// the container through PIPELINE_EXEC_STUB (run as `bash <stub>`), and the PR through
// PIPELINE_GH_CMD. Every fixture lives under one throwaway OS temp directory, and so do the
// workspaces — PIPELINE_WORKSPACE_ROOT points there, which is itself one of the checks.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
let count = 0;
function check(label, ok) {
  count += 1;
  if (ok) console.log(`ok - ${label}`);
  else { failed += 1; console.log(`FAIL - ${label}`); }
}
const show = (v) => JSON.stringify(v);
const fwd = (p) => p.split(path.sep).join('/');
const q = (s) => `"${s}"`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'done-earned-test-'));
const wsRoot = path.join(tmp, 'workspaces');

// ==== 1. the helper itself ==============================================================
const queue = require(path.join(ROOT, 'runner', 'queue.js'));
const workspace = require(path.join(ROOT, 'runner', 'workspace.js'));
check('runner/queue.js exports missingSuccessEvidence', typeof queue.missingSuccessEvidence === 'function');

const PASS_STATUS = { issueId: 'app-1', attempts: [{ number: 1, verifierResult: 'pass', timestamp: '2020-01-01T00:00:00.000Z' }] };
const PASS_VERIFY = { acceptance: 'pass', regressions: 'absent' };
const done = { status: 'done', beads: 'closed' };
const partial = { status: 'partial', beads: 'closed' };
const gap = (outcome, ev) => (typeof queue.missingSuccessEvidence === 'function'
  ? queue.missingSuccessEvidence(outcome, ev) : 'helper missing');

check('full evidence: done is earned (null)',
  gap(done, { status: PASS_STATUS, verify: PASS_VERIFY, hasCommits: true }) === null);
check('full evidence: partial is earned (null)',
  gap(partial, { status: PASS_STATUS, verify: { acceptance: 'pass', regressions: 'fail' }, hasCommits: true }) === null);
const nothing = gap(done, { status: null, verify: null, hasCommits: false });
check(`nothing collected: names all three gaps (got ${show(nothing)})`,
  typeof nothing === 'string' && /status\.json/.test(nothing) && /verify\.json/.test(nothing) && /no commits/.test(nothing));
check('a failing-only attempt history is not a pass',
  typeof gap(done, { status: { attempts: [{ number: 1, verifierResult: 'fail' }] }, verify: PASS_VERIFY, hasCommits: true }) === 'string');
check('status.json with no attempts array is not a pass',
  typeof gap(done, { status: { issueId: 'app-1' }, verify: PASS_VERIFY, hasCommits: true }) === 'string');
check('verify.json acceptance "error" is not a pass',
  typeof gap(done, { status: PASS_STATUS, verify: { acceptance: 'error', regressions: 'absent' }, hasCommits: true }) === 'string');
check('a pass with no commits is not earned',
  typeof gap(done, { status: PASS_STATUS, verify: PASS_VERIFY, hasCommits: false }) === 'string');
for (const o of [{ status: 'stuck', beads: 'blocked' }, { status: 'tampered', beads: 'blocked' },
  { status: 'paused', beads: null }, { status: 'failed', beads: 'blocked' }]) {
  check(`a non-success outcome (${o.status}) needs no evidence`, gap(o, { status: null, verify: null, hasCommits: false }) === null);
}
// outcomeFor's own contract is frozen (tests/acceptance/repo-4d8 D3) and must not move.
check('outcomeFor(0, null) is still done — the evidence check lives outside it',
  show(queue.outcomeFor(0, null)) === show(done));

check('an older passing attempt cannot override a failing latest attempt',
  typeof gap(done, { status: { attempts: [{ verifierResult: 'pass' }, { verifierResult: 'fail' }] }, verify: PASS_VERIFY, hasCommits: true }) === 'string');
check('explicit failed required-build evidence cannot earn done',
  typeof gap(done, { status: PASS_STATUS, verify: { ...PASS_VERIFY, build: 'fail' }, hasCommits: true }) === 'string');
check('explicit errored-build evidence cannot earn done',
  typeof gap(done, { status: PASS_STATUS, verify: { ...PASS_VERIFY, build: 'error' }, hasCommits: true }) === 'string');

// ==== 2. where workspaces live ===========================================================
const savedRoot = process.env.PIPELINE_WORKSPACE_ROOT;
delete process.env.PIPELINE_WORKSPACE_ROOT;
const defRoot = typeof workspace.workspaceRoot === 'function' ? workspace.workspaceRoot() : '';
check(`default workspace root is <pipeline root>/workspaces (got ${show(defRoot)})`,
  path.resolve(defRoot) === path.join(ROOT, 'workspaces'));
check('default workspace root is not under the OS temp directory',
  Boolean(defRoot) && !path.resolve(defRoot).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
check('.gitignore ignores workspaces/', ignore.includes('workspaces/'));
check('runner/workspace.js no longer reads os.tmpdir()',
  !/os\.tmpdir\(\)\s*,/.test(fs.readFileSync(path.join(ROOT, 'runner', 'workspace.js'), 'utf8')));
process.env.PIPELINE_WORKSPACE_ROOT = wsRoot;

// ==== 3. the real runOneTask, through its seams ==========================================
const runmod = require(path.join(ROOT, 'runner', 'run.js'));

// The bd stub reaches EVERY node child (CLAUDE.md, NODE_OPTIONS convention), so its first
// statement stands aside unless this process really is a bd call: those have a bd
// subcommand, never a .js script, in argv[1].
const bdStub = path.join(tmp, 'bd-stub.js');
fs.writeFileSync(bdStub, [
  "'use strict';",
  '(function () {',
  "  if (/\\.js$/i.test(String(process.argv[1] || ''))) return;",
  "  const sfs = require('fs');",
  // node resolves argv[1] to an absolute path before the preload sees it, so the
  // subcommand is compared by its last path segment.
  "  const a = process.argv.slice(1).map((s) => String(s).replace(/\\\\/g, '/').split('/').pop());",
  "  sfs.appendFileSync(process.env.BD_LOG, JSON.stringify(a) + '\\n');",
  "  if (a.includes('show')) {",
  '    sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "invented fixture task",',
  '      description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.11" }]));',
  "  } else { sfs.writeSync(1, '[]'); }",
  '  process.exit(0);',
  '})();',
  '',
].join('\n'));
const ghStub = path.join(tmp, 'gh-stub.js');
fs.writeFileSync(ghStub, "'use strict';process.stdout.write('https://example.invalid/pr/1\\n');process.exit(0);\n");

// One stub container, configured per drive through the environment: which artifacts it
// leaves in .run/, and whether it commits anything. Exit 0 every time — that is the point.
const execStub = path.join(tmp, 'exec-stub.sh');
fs.writeFileSync(execStub, [
  'mkdir -p "$RUN_DIR"',
  '[ -n "$STUB_STATUS_SRC" ] && cp "$STUB_STATUS_SRC" "$RUN_DIR/status.json"',
  '[ -n "$STUB_VERIFY_SRC" ] && cp "$STUB_VERIFY_SRC" "$RUN_DIR/verify.json"',
  'if [ "$STUB_COMMIT" = 1 ]; then',
  '  echo work > work.txt',
  '  git add work.txt',
  '  git -c user.email=t@example.invalid -c user.name=t commit -q -m work',
  'fi',
  'exit 0',
  '',
].join('\n'));

async function drive(name, { status, verify, commit, defaultRoot = false }) {
  const dir = path.join(tmp, name);
  const remote = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8', timeout: 60000 });
  g(seed, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
  }, null, 2));
  g(seed, ['add', '-A']);
  g(seed, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
  g(seed, ['remote', 'add', 'origin', remote]);
  g(seed, ['push', '-q', 'origin', 'main']);

  const env = {
    PIPELINE_BD_CMD: process.execPath,
    NODE_OPTIONS: `--require "${fwd(bdStub)}"`,
    BD_ISSUE_ID: 'app-777',
    BD_LOG: path.join(dir, 'bd.log'),
    PIPELINE_EXEC_STUB: execStub,
    PIPELINE_GH_CMD: `${q(process.execPath)} ${q(fwd(ghStub))}`,
    STUB_STATUS_SRC: '',
    STUB_VERIFY_SRC: '',
    STUB_COMMIT: commit ? '1' : '0',
    PIPELINE_WORKSPACE_ROOT: defaultRoot ? '' : wsRoot,
  };
  if (status) {
    env.STUB_STATUS_SRC = fwd(path.join(dir, 'status-src.json'));
    fs.writeFileSync(env.STUB_STATUS_SRC, JSON.stringify(status) + '\n');
  }
  if (verify) {
    env.STUB_VERIFY_SRC = fwd(path.join(dir, 'verify-src.json'));
    fs.writeFileSync(env.STUB_VERIFY_SRC, JSON.stringify(verify) + '\n');
  }
  fs.writeFileSync(env.BD_LOG, '');
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }

  const lines = [];
  const log = {
    info(t, m) { lines.push(`INFO ${m}`); }, error(t, m) { lines.push(`ERROR ${m}`); },
    runId: 'run-fixture', trace: (id) => `run-fixture/${id}`, taskDir: () => dir, dir,
  };
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15, maxPauseCycles: 96, concurrency: 1,
  };
  const gate = { waits: 0, cycles: 0, exhausted: false, admit: async () => true, reportLimit: async () => ({ resumed: false, exhausted: true }) };
  let row = null;
  try { row = await runmod.runOneTask(cfg, { id: 'app-777', title: 'invented fixture task', priority: 1 }, log, 'tok', gate); } catch (e) { lines.push(`THREW ${e && e.message}`); }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  const bdCalls = fs.readFileSync(env.BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const closed = bdCalls.some((a) => a.includes('close'));
  const blocked = bdCalls.some((a) => a.includes('update') && a.includes('blocked'));
  return { row, lines, closed, blocked, bdCalls };
}

(async () => {
  // The ordinary pass: must stay done, closed, with a PR. Read every not-done check
  // below against this one.
  const ok = await drive('pass', { status: PASS_STATUS, verify: PASS_VERIFY, commit: true });
  if (process.env.DEBUG_DRIVE) console.log(ok.lines.join('\n'), JSON.stringify(ok.bdCalls));
  check(`ordinary pass: outcome done (got ${show(ok.row && ok.row.outcome)})`, Boolean(ok.row) && ok.row.outcome === 'done');
  check('ordinary pass: issue closed, not blocked', ok.closed && !ok.blocked);
  check(`ordinary pass: a PR was opened (got ${show(ok.row && ok.row.prUrl)})`, Boolean(ok.row) && ok.row.prUrl === 'https://example.invalid/pr/1');
  const wsLine = ok.lines.find((l) => l.includes('workspace ready: ')) || '';
  check(`ordinary pass: the workspace was made under PIPELINE_WORKSPACE_ROOT (${show(wsLine.slice(0, 160))})`,
    wsLine.toLowerCase().includes(path.join(wsRoot, 'pipeline-app-777-').toLowerCase()));
  check('ordinary pass: no "without the evidence" error logged', !ok.lines.some((l) => /without the evidence/.test(l)));

  const defaultRun = await drive('default-root', { status: PASS_STATUS, verify: PASS_VERIFY, commit: true, defaultRoot: true });
  const defaultLine = defaultRun.lines.find((l) => l.includes('workspace ready: ')) || '';
  check('actual default-root task succeeds with earned evidence', defaultRun.row?.outcome === 'done');
  check('actual default-root clone is under the pipeline workspaces directory',
    defaultLine.includes(path.join(ROOT, 'workspaces', 'pipeline-app-777-')));

  // Defect 15, shape 1: the workspace vanished — exit 0 and nothing left behind.
  const gone = await drive('vanished', { status: null, verify: null, commit: false });
  check(`exit 0, nothing collected: outcome failed (got ${show(gone.row && gone.row.outcome)})`, Boolean(gone.row) && gone.row.outcome === 'failed');
  check('exit 0, nothing collected: issue blocked, never closed', gone.blocked && !gone.closed);
  check('exit 0, nothing collected: the reason is logged as an error',
    gone.lines.some((l) => l.startsWith('ERROR ') && /claimed done without the evidence/.test(l) && /status\.json/.test(l)));
  check('exit 0, nothing collected: the reason reaches the Beads issue as a note',
    gone.bdCalls.some((a) => a.includes('note') && a.some((s) => /without success evidence/.test(s))));
  check('exit 0, nothing collected: exitCode 0 is still recorded on the row', Boolean(gone.row) && gone.row.exitCode === 0);

  // Defect 15, shape 2: a pass recorded, verify.json says pass, but no commits.
  const empty = await drive('no-commits', { status: PASS_STATUS, verify: PASS_VERIFY, commit: false });
  check(`pass recorded, no commits: outcome failed (got ${show(empty.row && empty.row.outcome)})`, Boolean(empty.row) && empty.row.outcome === 'failed');
  check('pass recorded, no commits: issue blocked, never closed', empty.blocked && !empty.closed);
  check('pass recorded, no commits: the reason names the missing commits',
    empty.lines.some((l) => /without the evidence/.test(l) && /no commits/.test(l)));

  // Commits and a pass on record, but the verifier itself did not say pass.
  const err = await drive('verify-error', { status: PASS_STATUS, verify: { acceptance: 'error', regressions: 'absent' }, commit: true });
  check(`verify acceptance error: outcome failed (got ${show(err.row && err.row.outcome)})`, Boolean(err.row) && err.row.outcome === 'failed');
  check('verify acceptance error: no PR opened for it', Boolean(err.row) && !err.row.prUrl);

  // Partial still works when its evidence is there.
  const part = await drive('partial', { status: PASS_STATUS, verify: { acceptance: 'pass', regressions: 'fail' }, commit: true });
  check(`full evidence with regressions fail: outcome partial (got ${show(part.row && part.row.outcome)})`, Boolean(part.row) && part.row.outcome === 'partial');

  const leftover = fs.existsSync(wsRoot) ? fs.readdirSync(wsRoot) : [];
  check(`every workspace was discarded after its task (left: ${show(leftover)})`, leftover.length === 0);

  if (savedRoot === undefined) delete process.env.PIPELINE_WORKSPACE_ROOT; else process.env.PIPELINE_WORKSPACE_ROOT = savedRoot;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`${count - failed}/${count} checks passed`);
  process.exit(failed ? 1 : 0);
})();
