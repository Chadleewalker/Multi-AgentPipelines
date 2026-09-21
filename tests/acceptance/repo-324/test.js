// Frozen acceptance test — repo-324: pipeline-first agent writes are the default
// (Beads issue repo-324, criteria C1–C10; the issue text is canonical, not the planning
// draft that produced it). Written before implementation, from the criteria alone.
// Plain Node, Docker-free, node built-ins plus `git` — a task container has both and
// neither a Docker daemon nor a network.
//
// PAIRING. Every criterion below names the section that proves it and every section names
// the criterion it serves:
//
//   C1  §C1   protection on by default, absence unprotected, no in-tree opt-out,
//             host opt-out target-scoped, session-scoped, visible and revocable
//   C2  §C2   the interactive attack matrix, both clients' hooks, read-only still usable
//   C3  §C3   host-owned role leases and the seven ways a lease fails to authorize
//   C4  §C4   the role/path matrix, cross-target and cross-role
//   C5  §C5   install/status/uninstall for Claude and Codex, honest status
//   C6  §C6   admission inspects before mutation and refuses without mutating
//   C7  §C7   the recovery worktree, its manifest, idempotence and collision safety
//   C8  §C8   one machine-readable contract, no duplicated vocabulary, one source of truth
//   C9  §C9   non-vacuity pairing and other-target isolation  (and `guard.js`, which pins
//             the "existing session-guard suites remain green" half as behaviour)
//   C10 §C10  the seven documents state the same thing, and the change-log row exists
//
// ── THE FROZEN INTERFACE ──────────────────────────────────────────────────────────────
//
// contracts/write-protection.json   the ONE machine-readable contract (C8). Object with
//   `version` (integer), `roles` (object keyed by role name), `pathClasses` (object keyed
//   by class name, each an array of repository-relative globs), `denyReasons` (array of
//   strings), `clientStates` (the five status words). Roles include planner, test-author,
//   probe, task, interactive. Path classes include planning, product, frozen, config,
//   control.
//
//   Every consumer resolves the contract from ITS OWN installation — the tree the script
//   sits in — never from the checkout being judged. A guard that read its policy out of the
//   tree it is judging would let a session widen its own permissions with one edit; the
//   admission backstop (C6) is what catches an edit to the contract instead. §C8 proves
//   this by copying the tooling out and editing only the COPY's contract.
//
// scripts/write-guard.js            the decision engine. ONE JSON request object on stdin:
//     {cwd, sessionId?, token?, action:"write"|"shell"|"patch"|"read", path?, command?, patch?}
//   `read`, and any action the engine has no opinion about, always allows.
//   ONE JSON object on stdout: {"decision":"allow"|"deny","reason":<string>,
//   "protected":<boolean>}. Exit 0 allow, exit 2 deny. Every deny's `reason` is a member of
//   the contract's `denyReasons`. Three reason codes are pinned by name because their
//   distinction is the criterion: `pipeline-first`, `unknown-shell-form`, `role-path`.
//
// scripts/write-guard-bridge.js     the host-side hook translator for BOTH clients, chosen
//   by payload shape. Claude: {session_id, cwd, tool_name, tool_input}. Codex:
//   {session_id, cwd, hook:"apply_patch"|"unified_exec", input:{patch}|{command:[...]}}.
//   Exit 0 allow, exit 2 deny, reason on stderr.
//
// scripts/write-protection.js       the host CLI. Subcommands: `install`, `status`,
//   `uninstall`, `lease --grant`, `allow-writes`, `revoke`, `admit`, `recover`. `--json`
//   makes stdout a single JSON object. The shapes this suite depends on, and only these:
//
//     status --json    {"clients":{"claude":{"state":<one of the five>},"codex":{…}},
//                       "enforcementComplete":<boolean>,
//                       "limitations":[…],            (each mentions the client it is about)
//                       "optOuts":[{"target":…,"session":…}]}   (or "allowWrites")
//     lease --grant    {"leaseId":…,"token":…,"file":<absolute path to the host record>}
//                      --target --role --issue --run --workspace --pid --minutes
//     allow-writes     --target --session --minutes ; `revoke` takes --target --session
//     admit --json     {"admit":<boolean>,"refusals":[{"path":<repo-relative>,
//                       "state":"staged"|"unstaged"|"untracked"}]}   exit 0 admit, non-0 refuse
//     recover --json   {"worktree":<absolute>,"manifest":<absolute>}, the manifest being
//                      {"entries":[{"path":<repo-relative>,"kind":"patch"|"copy"}]}
//
//   The lease record at `file` is JSON carrying `target`, `gitCommonDir`, `role`, `issueId`,
//   `runId`, `controllerPid`, `controllerStart`, `pathClasses`, `expiresAt` and `token`.
//
// Host seams, all three directories outside any repository:
//   WRITE_PROTECTION_HOST_STATE_DIR   leases and opt-out records
//   WRITE_PROTECTION_CLAUDE_DIR       the Claude client config directory
//   WRITE_PROTECTION_CODEX_DIR        the Codex client config directory
//
// ── WHY THE FIXTURES ARE TEMP TREES ───────────────────────────────────────────────────
// Every decision here is asked about a throwaway repository under the OS temp dir, never
// about this checkout. The guard is a pure decision function, but a suite that names this
// repo's own frozen paths as write targets is one bug away from touching them. The CONTRACT
// still comes from the real tree — a guard must not read its policy from the tree it is
// judging, or a session widens its own permissions by editing a file — so §C8 proves the
// single-source property by copying the tooling out and editing the copy's contract.
//
// ── DELIBERATELY NOT FROZEN ───────────────────────────────────────────────────────────
// Prose, ordering, the shape of the human diagnostics beyond the substrings named, the
// internal format of a lease record beyond the fields the criteria name, and where a
// recovery worktree is placed. Outcomes freeze; formatting decisions do not.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONTRACT = path.join(REPO, 'contracts', 'write-protection.json');
const GUARD = path.join(REPO, 'scripts', 'write-guard.js');
const BRIDGE = path.join(REPO, 'scripts', 'write-guard-bridge.js');
const CLI = path.join(REPO, 'scripts', 'write-protection.js');

const ISSUE = 'repo-324';
const CLIENT_STATES = ['enforced', 'degraded', 'disabled', 'unsupported', 'uninstalled'];
// The seven documents C10 names. C5's managed-Codex clause is checked against the same set,
// because the issue names no file for it and this is the set it governs.
const DOCS = ['DESIGN.md', 'PLANNING.md', 'ONBOARDING.md', 'docs/parallel-sessions.md',
  'docs/control-plane.md', 'AGENTS.md', 'CLAUDE.md'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-324-'));
const HOST = path.join(tmp, 'host-state');
fs.mkdirSync(HOST, { recursive: true });

// A child never inherits the operator's own seams: a real installation on this machine must
// not be able to turn any assertion below green or red.
function envWith(extra) {
  const e = { ...process.env };
  for (const k of ['WRITE_PROTECTION_HOST_STATE_DIR', 'WRITE_PROTECTION_CLAUDE_DIR',
    'WRITE_PROTECTION_CODEX_DIR', 'CLAUDE_CONFIG_DIR', 'SESSION_GUARD_CONFIG_DIR']) delete e[k];
  return { ...e, WRITE_PROTECTION_HOST_STATE_DIR: HOST, ...extra };
}

function lastJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through to the last line */ }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep walking back */ }
  }
  return null;
}

function node(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: envWith(opts.env || {}), cwd: opts.cwd || tmp, input: opts.input,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: lastJson(r.stdout) };
}

function git(dir, args) {
  return spawnSync('git', ['-C', dir, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', timeout: 120000, windowsHide: true });
}

// One decision from the engine.
function decide(req, env) {
  return node(GUARD, [], { input: JSON.stringify(req), env });
}
// One decision from the host-side hook translator.
function bridge(payload, env) {
  return node(BRIDGE, [], { input: JSON.stringify(payload), env });
}

// Deny reasons are read from the contract rather than retyped, so the enum lives in exactly
// one place — which is C8's whole claim. A missing contract leaves this empty and every
// deny assertion below fails, which is the correct answer at the fork point.
let contract = null;
try { contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')); } catch { contract = null; }
const DENY_REASONS = new Set(
  contract && Array.isArray(contract.denyReasons) ? contract.denyReasons.map(String) : []
);

function denied(label, res, reason) {
  const r = res.json || {};
  const okShape = res.status === 2 && r.decision === 'deny' && typeof r.reason === 'string';
  const okReason = okShape && DENY_REASONS.has(r.reason) && (!reason || r.reason === reason);
  check(`${label} — DENIED${reason ? ` with reason \`${reason}\`` : ''} (exit ${res.status}, got ${show(r.reason)})`,
    okShape && okReason);
  return okShape && okReason;
}
function allowed(label, res) {
  const r = res.json || {};
  check(`${label} — ALLOWED (exit ${res.status}, got ${show(r.decision || res.stderr.trim().slice(0, 120))})`,
    res.status === 0 && r.decision === 'allow');
  return res.status === 0 && r.decision === 'allow';
}

// A byte-level view of project files, used wherever a criterion says "changes nothing".
// Git's common-directory worktree registry is bookkeeping, not an original project file;
// gitState() separately proves that the index, worktree status, HEAD and stash are unchanged.
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      if (e.isDirectory()) { map.set(`${rel}/`, 'dir'); walk(p); }
      else map.set(rel, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
const sameSnapshot = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// "It changed nothing" and "it named nothing it should not" are both true of a command that
// never ran, so every negative assertion below is conjoined with evidence that the thing
// under test actually executed. Without this the whole C5/C6/C7 half would report green at
// the fork point against tooling that does not exist — the vacuous-success shape this
// project already has a rule about.
const ran = (res) => Boolean(res) && res.status !== null && res.status !== 127
  && !/Cannot find module|MODULE_NOT_FOUND/.test(res.stderr || '');

// Everything git itself would report as movable state: the index, the working tree, HEAD and
// the shared stash stack. C6 says refusal never resets, cleans, stashes, overwrites, commits
// or moves — that is four different verbs and one observation covers all of them.
function gitState(dir) {
  return [
    git(dir, ['status', '--porcelain', '-uall']).stdout,
    git(dir, ['rev-parse', 'HEAD']).stdout,
    git(dir, ['stash', 'list']).stdout,
    git(dir, ['diff', '--cached', '--name-status']).stdout,
  ].join(' ');
}

// ---------------------------------------------------------------------------------------
// the fixture repository
// ---------------------------------------------------------------------------------------

const ISSUE_A = 'fix-a1';   // the suite the fixture's test-author role owns
const ISSUE_B = 'fix-b2';   // somebody else's suite

// The real project's frozen list, READ rather than retyped, plus one entry that exists
// nowhere in this repo. `vendor/pinned.txt` is what proves the frozen class is resolved from
// the target's own pipeline.config.json instead of a list baked into the guard.
let realFrozen = [];
try { realFrozen = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')).frozenPaths || []; }
catch { realFrozen = []; }

const FIXTURE_CONFIG = JSON.stringify({
  verifyCommand: 'sh tools/run-acceptance.sh',
  regressionCommand: 'bash scripts/test-ci.sh',
  regressionPolicy: 'required',
  defaultBranch: 'main',
  frozenPaths: [...realFrozen, 'vendor/pinned.txt'],
  dependencies: {},
}, null, 2);

const FIXTURE_FILES = {
  'README.md': '# fixture target\n',
  '.gitignore': 'runs/\n',
  'PLANNING.md': '# planning\n',
  'AGENTS.md': '# agents\n',
  'pipeline.config.json': FIXTURE_CONFIG,
  'runner/run.js': '// product: the runner\n',
  'runner/control-plane.js': '// control\n',
  'scripts/batch.js': '// product: the batch driver\n',
  'contracts/control-plane.json': '{}\n',
  'tools/run-acceptance.sh': '# frozen verifier\n',
  'vendor/pinned.txt': 'pinned by this project only\n',
  'docs/planning-draft-2020-01-01-fixture.md': '# planning draft\n',
  [`tests/acceptance/${ISSUE_A}/test.js`]: '// this issue\'s suite\n',
  [`tests/acceptance/${ISSUE_B}/test.js`]: '// another issue\'s suite\n',
  'runs/keep.json': '{"host":"artifact"}\n',
};

// `opts.config:false` builds the same tree WITHOUT pipeline.config.json — C1's unprotected
// half, and the paired control every deny in §C9 is measured against.
function makeTarget(name, opts = {}) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
    if (opts.config === false && rel === 'pipeline.config.json') continue;
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['add', '-A', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

function addWorktree(target, name, branch) {
  const dir = path.join(tmp, name);
  git(target, ['worktree', 'add', '-q', '-b', branch, dir]);
  return dir;
}

// ---------------------------------------------------------------------------------------

const p = (dir, rel) => path.join(dir, ...rel.split('/'));

try {
  check('C8 contracts/write-protection.json exists', fs.existsSync(CONTRACT));
  check('C1 scripts/write-guard.js exists', fs.existsSync(GUARD));
  check('C2 scripts/write-guard-bridge.js exists', fs.existsSync(BRIDGE));
  check('C5 scripts/write-protection.js exists', fs.existsSync(CLI));

  const PROT = makeTarget('target-protected');
  const OPEN = makeTarget('target-unprotected', { config: false });
  const OTHER = makeTarget('target-other');
  const WT1 = addWorktree(PROT, 'wt-one', 'session-one');
  const WT2 = addWorktree(PROT, 'wt-two', 'session-two');

  // THE FIRST ASSERTION IS THE HARNESS ITSELF. A fixture repository that never got a commit,
  // or a worktree git declined to create, would make half of C1–C4 answer about nothing while
  // still looking like a verdict about the guard.
  for (const [label, dir] of [['protected', PROT], ['unprotected', OPEN], ['other', OTHER],
    ['worktree one', WT1], ['worktree two', WT2]]) {
    const head = git(dir, ['rev-parse', 'HEAD']);
    check(`harness: the ${label} fixture is a real checkout with a commit (git said ${show((head.stdout || head.stderr || '').trim().slice(0, 60))})`,
      head.status === 0 && /^[0-9a-f]{7,}$/.test((head.stdout || '').trim()));
  }
  check('harness: the protected fixture carries pipeline.config.json and the unprotected one does not',
    fs.existsSync(p(PROT, 'pipeline.config.json')) && !fs.existsSync(p(OPEN, 'pipeline.config.json')));

  // =====================================================================================
  // C1 — protection is ON by default where the config is, OFF where it is not, and the only
  //      way out is a host record the model cannot write.
  // =====================================================================================

  const c1Write = (dir, extra = {}) => decide({ cwd: dir, action: 'write', path: p(dir, 'runner/run.js'), ...extra });

  const protectedWrite = c1Write(PROT);
  denied('C1 a product write in a checkout carrying pipeline.config.json is refused with no configuration at all', protectedWrite, 'pipeline-first');
  check(`C1 and the verdict says so: "protected": true (got ${show(protectedWrite.json && protectedWrite.json.protected)})`,
    Boolean(protectedWrite.json) && protectedWrite.json.protected === true);

  const openWrite = c1Write(OPEN);
  allowed('C1 the same write in a checkout with no pipeline.config.json is untouched — absence is unprotected', openWrite);
  check(`C1 and that verdict says so too: "protected": false (got ${show(openWrite.json && openWrite.json.protected)})`,
    Boolean(openWrite.json) && openWrite.json.protected === false);

  const plainDir = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plainDir, { recursive: true });
  allowed('C1 a folder that is not a repository at all is unprotected', decide({ cwd: plainDir, action: 'write', path: path.join(plainDir, 'scratch.txt') }));

  // Protection is decided at the SELECTED INTEGRATION FORK POINT, not from the working tree
  // a model can edit. Deleting the config from the tree is the cheapest possible opt-out and
  // must not work.
  const DELETED = makeTarget('target-config-deleted');
  fs.rmSync(p(DELETED, 'pipeline.config.json'));
  denied('C1 deleting pipeline.config.json from the working tree does NOT disable protection — the fork point is what counts',
    c1Write(DELETED), 'pipeline-first');

  // Neither does any marker that lives in the tree, tracked or not. The existing guard's
  // `.session-guard-off` is named explicitly because it is the marker that exists today and
  // the one a model would reach for first.
  for (const marker of ['.session-guard-off', '.write-protection-off', '.pipeline-writes-allowed']) {
    const MARKED = makeTarget(`target-marker-${marker.replace(/[^a-z]/g, '')}`);
    fs.writeFileSync(p(MARKED, marker), '');
    git(MARKED, ['add', '-A', '.']);
    git(MARKED, ['commit', '-q', '-m', 'marker']);
    denied(`C1 a tracked, model-editable \`${marker}\` marker does NOT opt out`, c1Write(MARKED), 'pipeline-first');
  }

  // The one bypass: a host record, granted by a person, for ONE target and ONE session.
  const SESSION = 'session-alpha';
  const OTHERSESSION = 'session-beta';
  const beforeGrant = snapshot(PROT);
  const grant = node(CLI, ['allow-writes', '--target', PROT, '--session', SESSION, '--minutes', '30', '--json']);
  check(`C1 \`allow-writes\` records an explicit, user-authorized opt-out (exit ${grant.status}: ${grant.stderr.trim().slice(0, 160)})`,
    grant.status === 0);
  check('C1 and it writes NOTHING into the target checkout — the record is host-owned',
    grant.status === 0 && sameSnapshot(beforeGrant, snapshot(PROT)));

  allowed('C1 the granted session may then write a product path in that target',
    c1Write(PROT, { sessionId: SESSION }));
  denied('C1 but a DIFFERENT session in the same target still cannot — the opt-out is session-scoped',
    c1Write(PROT, { sessionId: OTHERSESSION }), 'pipeline-first');
  denied('C1 and the granted session cannot write a DIFFERENT target — the opt-out is target-scoped',
    decide({ cwd: OTHER, action: 'write', path: p(OTHER, 'runner/run.js'), sessionId: SESSION }), 'pipeline-first');

  const st = node(CLI, ['status', '--json']);
  const grants = (st.json && (st.json.optOuts || st.json.allowWrites)) || [];
  check(`C1 \`status --json\` makes the opt-out VISIBLE — one record naming target and session (got ${show(grants).slice(0, 240)})`,
    Array.isArray(grants) && grants.some((g) => g && String(g.session || g.sessionId) === SESSION
      && String(g.target || '').toLowerCase().includes(path.basename(PROT).toLowerCase())));

  const revoke = node(CLI, ['revoke', '--target', PROT, '--session', SESSION]);
  check(`C1 \`revoke\` exits 0 (got ${revoke.status}: ${revoke.stderr.trim().slice(0, 160)})`, revoke.status === 0);
  denied('C1 and after revocation that same session is refused again', c1Write(PROT, { sessionId: SESSION }), 'pipeline-first');

  // =====================================================================================
  // C2 — the plain interactive session, in the shared checkout AND in an ordinary worktree.
  // =====================================================================================

  const PATCH_TEXT = [
    '*** Begin Patch',
    '*** Update File: runner/run.js',
    '@@',
    '-// product: the runner',
    '+// product: taken over',
    '*** End Patch',
    '',
  ].join('\n');

  // The planted attempts. Each is a request built for a working directory; the LABEL names
  // the technique the criterion lists. `pair` marks the ones §C9 re-runs unprotected.
  function attempts(dir) {
    return [
      { label: 'a direct file-tool write', pair: true, req: { cwd: dir, action: 'write', path: 'runner/run.js' } },
      { label: 'a Codex apply_patch', pair: true, req: { cwd: dir, action: 'patch', patch: PATCH_TEXT } },
      { label: 'a shell redirection (`printf ... > runner/run.js`)', pair: true, req: { cwd: dir, action: 'shell', command: 'printf taken > runner/run.js' } },
      { label: 'an appending redirection with no space (`>>runner/run.js`)', pair: true, req: { cwd: dir, action: 'shell', command: 'printf taken >>runner/run.js' } },
      { label: 'a heredoc write through `tee`', pair: true, req: { cwd: dir, action: 'shell', command: 'tee runner/run.js <<EOF\ntaken\nEOF' } },
      { label: 'an in-place stream edit (`sed -i`)', pair: true, req: { cwd: dir, action: 'shell', command: "sed -i 's/product/taken/' runner/run.js" } },
      { label: 'an interpreter write (`node -e`)', pair: true, req: { cwd: dir, action: 'shell', command: 'node -e "require(\'fs\').writeFileSync(\'runner/run.js\',\'taken\')"' } },
      { label: 'an interpreter write through python', pair: true, req: { cwd: dir, action: 'shell', command: 'python -c "open(\'runner/run.js\',\'w\').write(\'taken\')"' } },
      { label: 'an ABSOLUTE path into the protected checkout', pair: true, req: { cwd: plainDir, action: 'write', path: p(dir, 'runner/run.js') } },
      { label: 'a TRAVERSAL out of a scratch folder and back in', pair: true, req: { cwd: path.join(dir, 'docs'), action: 'write', path: path.join('..', 'runner', 'run.js') } },
      { label: 'a RENAMED copy of an interpreter (`./n0de -e ...`)', pair: false, req: { cwd: dir, action: 'shell', command: './n0de -e "writeFileSync(\'runner/run.js\',\'taken\')"' } },
      { label: 'a RENAMED copy of an in-place editor (`myed -i`)', pair: false, req: { cwd: dir, action: 'shell', command: 'myed -i s/product/taken/ runner/run.js' } },
      { label: 'an entirely unknown command with a mutating look', pair: false, req: { cwd: dir, action: 'shell', command: 'frobnicate --output runner/run.js --write' } },
      { label: 'a destructive Git command (`git reset --hard`)', pair: false, req: { cwd: dir, action: 'shell', command: 'git reset --hard' } },
      { label: 'a destructive Git command (`git clean -fdx`)', pair: false, req: { cwd: dir, action: 'shell', command: 'git clean -fdx' } },
      { label: 'a config write (pipeline.config.json)', pair: true, req: { cwd: dir, action: 'write', path: 'pipeline.config.json' } },
      { label: 'a frozen-path write (tools/run-acceptance.sh)', pair: true, req: { cwd: dir, action: 'write', path: 'tools/run-acceptance.sh' } },
      { label: 'a frozen-path write named only by THIS project\'s config (vendor/pinned.txt)', pair: true, req: { cwd: dir, action: 'write', path: 'vendor/pinned.txt' } },
      { label: 'a frozen acceptance-suite write', pair: true, req: { cwd: dir, action: 'write', path: `tests/acceptance/${ISSUE_A}/test.js` } },
    ];
  }

  const PAIRED = [];
  for (const [where, dir] of [['the shared checkout', PROT], ['an ordinary worktree', WT1]]) {
    for (const a of attempts(dir)) {
      denied(`C2 in ${where}: ${a.label}`, decide(a.req));
      if (a.pair && dir === PROT) PAIRED.push(a);
    }
  }

  // The cross-worktree case is its own technique: another session's folder, reached from a
  // folder that is legitimately yours.
  denied('C2 from one worktree, a write into ANOTHER session\'s worktree',
    decide({ cwd: WT1, action: 'write', path: p(WT2, 'runner/run.js') }));
  denied('C2 from a worktree, a write back into the shared checkout',
    decide({ cwd: WT1, action: 'write', path: p(PROT, 'runner/run.js') }));

  // Fail CLOSED is a specific claim, not just "deny": an unrecognised shell form has to be
  // refused for being unrecognised, and say so.
  denied('C2 an unknown shell form fails CLOSED and names itself as such',
    decide({ cwd: PROT, action: 'shell', command: 'frobnicate --output runner/run.js --write' }), 'unknown-shell-form');
  denied('C2 a renamed interpreter fails CLOSED the same way',
    decide({ cwd: PROT, action: 'shell', command: './n0de -e "x"' }), 'unknown-shell-form');

  // Read-only inspection has to stay usable, or the guard is a wall and gets switched off.
  // These allows are also what makes every deny above non-vacuous (C9).
  const READ_ONLY = [
    'git status', 'git status --porcelain', 'git diff', 'git log --oneline -5',
    'git show HEAD --stat', 'ls', 'cat README.md', 'node --version',
  ];
  for (const command of READ_ONLY) {
    allowed(`C2 read-only inspection remains usable: \`${command}\``, decide({ cwd: PROT, action: 'shell', command }));
  }
  allowed('C2 a read of a protected file is not a write', decide({ cwd: PROT, action: 'read', path: 'runner/run.js' }));
  allowed('C2 an ignored host artifact (runs/) stays writable — existing policy, unchanged',
    decide({ cwd: PROT, action: 'write', path: 'runs/latest.json' }));

  // The same refusals through the host-side hooks each client actually calls.
  const hookCases = [
    ['Claude Write', { session_id: 'sX', cwd: PROT, tool_name: 'Write', tool_input: { file_path: p(PROT, 'runner/run.js'), content: 'taken' } }],
    ['Claude Edit', { session_id: 'sX', cwd: PROT, tool_name: 'Edit', tool_input: { file_path: 'runner/run.js', old_string: 'a', new_string: 'b' } }],
    ['Claude NotebookEdit', { session_id: 'sX', cwd: PROT, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'runner/run.js' } }],
    ['Claude Bash', { session_id: 'sX', cwd: PROT, tool_name: 'Bash', tool_input: { command: 'printf taken > runner/run.js' } }],
    ['Codex apply_patch', { session_id: 'sX', cwd: PROT, hook: 'apply_patch', input: { patch: PATCH_TEXT } }],
    ['Codex unified_exec', { session_id: 'sX', cwd: PROT, hook: 'unified_exec', input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } }],
  ];
  for (const [label, payload] of hookCases) {
    const r = bridge(payload);
    check(`C2 the ${label} hook refuses — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }
  const readHook = bridge({ session_id: 'sX', cwd: PROT, tool_name: 'Read', tool_input: { file_path: 'runner/run.js' } });
  check(`C2 the same hook allows a Read — exit 0 (got ${readHook.status})`, readHook.status === 0);
  const inspectHook = bridge({ session_id: 'sX', cwd: PROT, tool_name: 'Bash', tool_input: { command: 'git status' } });
  check(`C2 and allows read-only inspection through the shell hook — exit 0 (got ${inspectHook.status})`, inspectHook.status === 0);

  // =====================================================================================
  // C3 — leases are host-owned, bound to everything that identifies the run, and fail every
  //      other way.
  // =====================================================================================

  function grantLease(target, role, opts = {}) {
    const args = ['lease', '--grant', '--target', target, '--role', role,
      '--pid', String(opts.pid === undefined ? process.pid : opts.pid),
      '--minutes', String(opts.minutes === undefined ? 30 : opts.minutes), '--json'];
    if (opts.issue) args.push('--issue', opts.issue);
    if (opts.run) args.push('--run', opts.run);
    if (opts.workspace) args.push('--workspace', opts.workspace);
    return node(CLI, args);
  }

  const leaseA = grantLease(PROT, 'probe', { issue: ISSUE_A, run: 'run-0001' });
  check(`C3 \`lease --grant\` issues a lease and reports it as JSON (exit ${leaseA.status}: ${leaseA.stderr.trim().slice(0, 200)})`,
    leaseA.status === 0 && Boolean(leaseA.json));
  const lease = leaseA.json || {};
  check(`C3 the lease carries an unguessable ownership token — at least 32 opaque characters (got ${show(String(lease.token || '').length)})`,
    typeof lease.token === 'string' && lease.token.length >= 32 && /^[A-Za-z0-9_-]+$/.test(lease.token));
  const leaseA2 = grantLease(PROT, 'probe', { issue: ISSUE_A, run: 'run-0002' });
  check('C3 two grants never share a token',
    Boolean(leaseA2.json) && leaseA2.json.token !== lease.token);
  check(`C3 the lease record is a HOST file, outside the target checkout (got ${show(lease.file)})`,
    typeof lease.file === 'string' && fs.existsSync(lease.file)
      && path.resolve(lease.file).toLowerCase().startsWith(path.resolve(HOST).toLowerCase())
      && !path.resolve(lease.file).toLowerCase().startsWith(path.resolve(PROT).toLowerCase()));

  let record = null;
  try { record = JSON.parse(fs.readFileSync(lease.file, 'utf8')); } catch { record = null; }
  const bound = record || {};
  for (const [field, why] of [
    ['target', 'the canonical target'],
    ['gitCommonDir', 'the Git common dir'],
    ['role', 'the role'],
    ['issueId', 'the issue identity'],
    ['runId', 'the run identity'],
    ['controllerPid', 'the controller PID'],
    ['controllerStart', 'the process-start identity that survives PID reuse'],
    ['pathClasses', 'the allowed path classes'],
    ['expiresAt', 'the expiry'],
  ]) {
    check(`C3 the lease binds ${why} (field \`${field}\`)`,
      Object.prototype.hasOwnProperty.call(bound, field) && bound[field] !== null && bound[field] !== '');
  }

  allowed('C3 a live, matching lease authorizes the write it was granted for',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: lease.token }));

  // Every way a lease fails. Each mutates a FRESH grant, so no case can be satisfied by an
  // earlier one having already poisoned the state.
  function mutatedLease(name, mutate, opts = {}) {
    const g = grantLease(PROT, 'probe', { issue: ISSUE_A, run: `run-${name}`, ...opts });
    if (!g.json || !g.json.file) return null;
    if (mutate) {
      const before = JSON.parse(fs.readFileSync(g.json.file, 'utf8'));
      const after = mutate(before);
      fs.writeFileSync(g.json.file, typeof after === 'string' ? after : JSON.stringify(after, null, 2));
    }
    return g.json;
  }

  denied('C3 MISSING: no token at all in a protected target',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js' }), 'pipeline-first');

  const staleL = mutatedLease('stale', (r) => ({ ...r, expiresAt: new Date(Date.UTC(2020, 0, 1)).toISOString() }));
  denied('C3 STALE: an expired lease authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: staleL && staleL.token }));

  const badL = mutatedLease('malformed', () => '{ this is not json');
  denied('C3 MALFORMED: an unparseable lease record authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: badL && badL.token }));

  denied('C3 COPIED: a lease issued for one target authorizes nothing in another',
    decide({ cwd: OTHER, action: 'write', path: p(OTHER, 'runner/run.js'), token: lease.token }));

  const mismatchL = mutatedLease('mismatch', (r) => ({ ...r, gitCommonDir: path.join(OTHER, '.git') }));
  denied('C3 MISMATCHED: a lease whose Git common dir names another checkout authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: mismatchL && mismatchL.token }));

  // A dead controller. The pid comes from a process that has already exited, so a lease
  // bound to it can only pass if the guard checks nothing — and if the pid has been reused,
  // the process-start identity is the second lock that must still hold.
  const corpse = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const deadPid = corpse.pid;
  const deadL = grantLease(PROT, 'probe', { issue: ISSUE_A, run: 'run-dead', pid: deadPid });
  denied('C3 DEAD CONTROLLER: a lease bound to a pid that is gone authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: deadL.json && deadL.json.token }));

  denied('C3 WRONG TOKEN: a well-formed guess against a live lease authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: `${'0'.repeat(48)}` }));

  // A lease the MODEL could write, in the tree it is being judged in, is not a lease.
  const plantedToken = 'z'.repeat(48);
  const planted = { version: 1, leaseId: 'planted', target: PROT, gitCommonDir: path.join(PROT, '.git'),
    role: 'probe', issueId: ISSUE_A, runId: 'run-planted', controllerPid: process.pid,
    controllerStart: 'whatever', pathClasses: ['product', 'config', 'frozen', 'control'],
    expiresAt: new Date(Date.now() + 3600e3).toISOString(), token: plantedToken };
  for (const rel of ['.pipeline-lease.json', '.pipeline/lease.json', 'contracts/lease.json']) {
    const f = p(PROT, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(planted, null, 2));
  }
  denied('C3 MODEL-CREATED: a well-formed lease planted inside the repository authorizes nothing',
    decide({ cwd: PROT, action: 'write', path: 'runner/run.js', token: plantedToken }));
  for (const rel of ['.pipeline-lease.json', '.pipeline/lease.json', 'contracts/lease.json']) {
    fs.rmSync(p(PROT, rel), { force: true });
  }

  denied('C3 worktree membership ALONE never authorizes a write',
    decide({ cwd: WT2, action: 'write', path: p(WT2, 'runner/run.js') }), 'pipeline-first');

  // =====================================================================================
  // C4 — one role, one set of paths. Every allow here is what makes the denies non-vacuous.
  // =====================================================================================

  function asRole(role, opts) {
    const g = grantLease(opts.target || PROT, role, opts);
    return (req) => decide({ cwd: opts.cwd || opts.target || PROT, token: g.json && g.json.token, ...req });
  }

  const planner = asRole('planner', { target: PROT, issue: ISSUE_A, run: 'run-plan' });
  allowed('C4 planner MAY change a declared planning path (docs/planning-draft-*.md)',
    planner({ action: 'write', path: 'docs/planning-draft-2020-01-01-fixture.md' }));
  allowed('C4 planner MAY change PLANNING.md', planner({ action: 'write', path: 'PLANNING.md' }));
  denied('C4 planner may NOT change a product path', planner({ action: 'write', path: 'runner/run.js' }), 'role-path');
  denied('C4 planner may NOT change config', planner({ action: 'write', path: 'pipeline.config.json' }), 'role-path');
  denied('C4 planner may NOT change a frozen path', planner({ action: 'write', path: 'tools/run-acceptance.sh' }), 'role-path');
  denied('C4 cross-role: planner may NOT write an acceptance suite',
    planner({ action: 'write', path: `tests/acceptance/${ISSUE_A}/test.js` }), 'role-path');

  const author = asRole('test-author', { target: PROT, issue: ISSUE_A, run: 'run-author' });
  allowed('C4 test-author MAY change the exact new issue acceptance suite',
    author({ action: 'write', path: `tests/acceptance/${ISSUE_A}/test.js` }));
  allowed('C4 test-author MAY write that suite\'s receipt',
    author({ action: 'write', path: `tests/acceptance/${ISSUE_A}/.freeze-gate.json` }));
  denied('C4 test-author may NOT touch another issue\'s suite',
    author({ action: 'write', path: `tests/acceptance/${ISSUE_B}/test.js` }), 'role-path');
  denied('C4 test-author may NOT change product paths',
    author({ action: 'write', path: 'runner/run.js' }), 'role-path');
  denied('C4 test-author may NOT change config',
    author({ action: 'write', path: 'pipeline.config.json' }), 'role-path');
  denied('C4 cross-role: test-author may NOT change a planning path',
    author({ action: 'write', path: 'PLANNING.md' }), 'role-path');

  const probe = asRole('probe', { target: PROT, issue: ISSUE_A, run: 'run-probe' });
  allowed('C4 probe MAY change product paths', probe({ action: 'write', path: 'runner/run.js' }));
  allowed('C4 probe MAY change another product path', probe({ action: 'write', path: 'scripts/batch.js' }));
  denied('C4 probe may NOT change frozen paths', probe({ action: 'write', path: 'tools/run-acceptance.sh' }), 'role-path');
  denied('C4 probe may NOT change a frozen path this project alone declares',
    probe({ action: 'write', path: 'vendor/pinned.txt' }), 'role-path');
  denied('C4 probe may NOT change config', probe({ action: 'write', path: 'pipeline.config.json' }), 'role-path');
  denied('C4 probe may NOT change control files', probe({ action: 'write', path: 'runner/control-plane.js' }), 'role-path');
  denied('C4 probe may NOT change the frozen acceptance suite',
    probe({ action: 'write', path: `tests/acceptance/${ISSUE_A}/test.js` }), 'role-path');

  // Task execution is scoped to the workspace the pipeline created for it, which is a
  // different checkout from the target — that is the whole point of the workspace.
  const WORKSPACE = makeTarget('task-workspace');
  const task = asRole('task', { target: PROT, issue: ISSUE_A, run: 'run-task', workspace: WORKSPACE, cwd: WORKSPACE });
  allowed('C4 task execution MAY change a product path inside the pipeline-created workspace',
    task({ cwd: WORKSPACE, action: 'write', path: p(WORKSPACE, 'runner/run.js') }));
  denied('C4 task execution may NOT change product paths in the target checkout',
    task({ cwd: PROT, action: 'write', path: p(PROT, 'runner/run.js') }), 'role-path');
  denied('C4 task execution may NOT change frozen paths even inside its own workspace',
    task({ cwd: WORKSPACE, action: 'write', path: p(WORKSPACE, 'tools/run-acceptance.sh') }), 'role-path');
  denied('C4 task execution may NOT change config even inside its own workspace',
    task({ cwd: WORKSPACE, action: 'write', path: p(WORKSPACE, 'pipeline.config.json') }), 'role-path');
  denied('C4 task execution may NOT change control files inside its own workspace',
    task({ cwd: WORKSPACE, action: 'write', path: p(WORKSPACE, 'contracts/control-plane.json') }), 'role-path');
  denied('C4 task execution may NOT change the frozen acceptance suite inside its own workspace',
    task({ cwd: WORKSPACE, action: 'write', path: p(WORKSPACE, `tests/acceptance/${ISSUE_A}/test.js`) }), 'role-path');

  // Cross-target: the same probe lease, pointed at a checkout it was never issued for.
  denied('C4 cross-target: a probe lease for one target authorizes nothing in another',
    probe({ cwd: OTHER, action: 'write', path: p(OTHER, 'runner/run.js') }));

  // =====================================================================================
  // C9 — the pairing that makes every deny above mean something, and other targets left alone
  // =====================================================================================

  check(`C9 the attack matrix actually ran a paired set (got ${PAIRED.length})`, PAIRED.length >= 10);
  for (const a of PAIRED) {
    const req = { ...a.req };
    // The identical request, aimed at the identical tree WITHOUT the config. If this denies
    // too, the refusal above was never about protection and proves nothing.
    if (typeof req.cwd === 'string' && req.cwd.startsWith(PROT)) req.cwd = req.cwd.replace(PROT, OPEN);
    if (typeof req.path === 'string' && req.path.startsWith(PROT)) req.path = req.path.replace(PROT, OPEN);
    if (req.cwd === plainDir && typeof req.path === 'string') req.path = req.path.replace(PROT, OPEN);
    allowed(`C9 non-vacuous: ${a.label} is allowed when the same tree is UNPROTECTED`, decide(req));
  }

  const hostBefore = snapshot(HOST);
  const otherBefore = snapshot(OTHER);
  const otherGit = gitState(OTHER);
  const isoGrant = node(CLI, ['allow-writes', '--target', PROT, '--session', 'session-gamma', '--minutes', '5', '--json']);
  const isoLease = grantLease(PROT, 'probe', { issue: ISSUE_A, run: 'run-isolation' });
  const hostAfter = snapshot(HOST);
  check(`C9 granting for one target does add host records (${hostBefore.size} -> ${hostAfter.size} entries)`,
    isoGrant.status === 0 && isoLease.status === 0 && hostAfter.size > hostBefore.size);
  check('C9 other targets are untouched by another target\'s grants and leases — tree unchanged',
    isoGrant.status === 0 && sameSnapshot(otherBefore, snapshot(OTHER)));
  check('C9 and their Git state (index, worktree, HEAD, stash) is unchanged too',
    isoGrant.status === 0 && gitState(OTHER) === otherGit);
  denied('C9 and a write in the other target is still refused on its own terms',
    decide({ cwd: OTHER, action: 'write', path: p(OTHER, 'runner/run.js'), sessionId: 'session-gamma' }), 'pipeline-first');
  check('C9 and no host record of the other target was rewritten by any of it',
    isoGrant.status === 0 && [...hostBefore].every(([k, v]) => hostAfter.get(k) === v));

  // =====================================================================================
  // C5 — install / status / uninstall, two clients, no collateral damage, honest words.
  // =====================================================================================

  const CLAUDE = path.join(tmp, 'client-claude');
  const CODEX = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.mkdirSync(CODEX, { recursive: true });

  // Both clients arrive with configuration that is NOT ours and must survive everything.
  const UNRELATED_CMD = 'node /opt/somebody-elses/checker.js';
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['Bash(ls *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: UNRELATED_CMD }] }] },
  }, null, 2)}\n`);
  const CODEX_KEEP = '[features]\nhooks = true\n\n[unrelated]\nkeep_me = "yes"\n';
  fs.writeFileSync(path.join(CODEX, 'config.toml'), CODEX_KEEP);

  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE, WRITE_PROTECTION_CODEX_DIR: CODEX };

  const before = node(CLI, ['status', '--json'], { env: clientEnv });
  const beforeClients = (before.json && before.json.clients) || {};
  check(`C5 before installing, status names both clients as uninstalled (got ${show(beforeClients)})`,
    beforeClients.claude && beforeClients.codex
      && beforeClients.claude.state === 'uninstalled' && beforeClients.codex.state === 'uninstalled');

  const install = node(CLI, ['install'], { env: clientEnv });
  check(`C5 \`install\` supports both clients in one run (exit ${install.status}: ${install.stderr.trim().slice(0, 200)})`,
    install.status === 0);

  const after = node(CLI, ['status', '--json'], { env: clientEnv });
  const clients = (after.json && after.json.clients) || {};
  check(`C5 status reports a state per client, each drawn from the five words (got ${show(clients)})`,
    clients.claude && clients.codex
      && CLIENT_STATES.includes(clients.claude.state) && CLIENT_STATES.includes(clients.codex.state));
  check('C5 Claude is enforced after a clean install', clients.claude && clients.claude.state === 'enforced');

  const claudeSettings = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const claudeCommands = ((claudeSettings.hooks && claudeSettings.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || []).map((h) => String((h && h.command) || ''));
  const ourClaudeHook = claudeCommands.some((c) => /write-guard|write-protection/.test(c));
  check(`C5 install added OUR Claude hook entry (got ${show(claudeCommands)})`, install.status === 0 && ourClaudeHook);
  check(`C5 the unrelated Claude hook is still there, unclobbered (got ${show(claudeCommands)})`,
    ourClaudeHook && claudeCommands.includes(UNRELATED_CMD));
  check('C5 the unrelated Claude permissions block survived too',
    ourClaudeHook && claudeSettings.permissions && Array.isArray(claudeSettings.permissions.allow)
      && claudeSettings.permissions.allow.includes('Bash(ls *)'));
  const codexAfterInstall = fs.readFileSync(path.join(CODEX, 'config.toml'), 'utf8');
  check(`C5 install wrote a Codex hook entry too (config is ${codexAfterInstall.length} bytes)`,
    install.status === 0 && codexAfterInstall !== CODEX_KEEP);
  check('C5 the unrelated Codex configuration survived',
    codexAfterInstall !== CODEX_KEEP && codexAfterInstall.includes('keep_me = "yes"'));

  // Honesty. Codex hooks live in a config the model on this host can rewrite, so a clean
  // install is not a claim of complete enforcement — and the limitation is named, not implied.
  check(`C5 the system does NOT claim complete enforcement while a client's hooks are locally mutable (got ${show(after.json && after.json.enforcementComplete)})`,
    Boolean(after.json) && after.json.enforcementComplete === false);
  const limits = (after.json && after.json.limitations) || [];
  check(`C5 and it says which client and why (got ${show(limits).slice(0, 300)})`,
    Array.isArray(limits) && limits.length > 0
      && limits.some((l) => JSON.stringify(l).toLowerCase().includes('codex')));

  // The criterion's last clause: an organization that needs non-disableable local policy has
  // to be told how. The issue names no file for it, so this asks only that it is written down
  // somewhere in the document set C10 governs, near the client it is about.
  const managed = DOCS.some((rel) => {
    let text = '';
    try { text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'); } catch { return false; }
    return text.split(/\r?\n/).some((line, i, all) => /managed/i.test(line)
      && all.slice(Math.max(0, i - 8), i + 9).some((l) => /codex/i.test(l)));
  });
  check('C5 managed Codex-hook guidance is documented, for organizations needing non-disableable local policy', managed);

  // A tool path the installed matcher does not cover is `degraded`, never `enforced`.
  const degraded = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  for (const g of (degraded.hooks && degraded.hooks.PreToolUse) || []) {
    for (const h of (g && g.hooks) || []) {
      if (String(h.command || '').includes('write-guard') || String(h.command || '').includes('write-protection')) {
        g.matcher = 'Write';
      }
    }
  }
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), `${JSON.stringify(degraded, null, 2)}\n`);
  const uncovered = node(CLI, ['status', '--json'], { env: clientEnv });
  check(`C5 a matcher that leaves a supported tool path uncovered is reported degraded, never enforced (got ${show(uncovered.json && uncovered.json.clients && uncovered.json.clients.claude)})`,
    uncovered.json && uncovered.json.clients && uncovered.json.clients.claude
      && uncovered.json.clients.claude.state === 'degraded');
  check('C5 and enforcement is not called complete then either',
    Boolean(uncovered.json) && uncovered.json.enforcementComplete === false);

  // A malformed settings file is a state, not a crash and not silence.
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), '{ not json at all');
  const malformed = node(CLI, ['status', '--json'], { env: clientEnv });
  const mClaude = (malformed.json && malformed.json.clients && malformed.json.clients.claude) || {};
  check(`C5 malformed client configuration is reported, not ignored (got ${show(mClaude.state)})`,
    ['degraded', 'disabled'].includes(mClaude.state));
  check('C5 and enforcement is not claimed complete over a malformed config',
    Boolean(malformed.json) && malformed.json.enforcementComplete === false);

  // A client that cannot carry hooks at all is `unsupported`/`disabled`, never `enforced`.
  fs.writeFileSync(path.join(CODEX, 'config.toml'), '[features]\nhooks = false\n');
  const noHooks = node(CLI, ['status', '--json'], { env: clientEnv });
  const nCodex = (noHooks.json && noHooks.json.clients && noHooks.json.clients.codex) || {};
  check(`C5 a client with hooks switched off is unsupported or disabled, never enforced (got ${show(nCodex.state)})`,
    ['unsupported', 'disabled'].includes(nCodex.state));

  // Reinstall onto the repaired config, then uninstall and check what is left behind.
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['Bash(ls *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: UNRELATED_CMD }] }] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(CODEX, 'config.toml'), CODEX_KEEP);
  node(CLI, ['install'], { env: clientEnv });
  const uninstall = node(CLI, ['uninstall'], { env: clientEnv });
  check(`C5 \`uninstall\` exits 0 (got ${uninstall.status}: ${uninstall.stderr.trim().slice(0, 200)})`, uninstall.status === 0);
  const gone = node(CLI, ['status', '--json'], { env: clientEnv });
  const goneClients = (gone.json && gone.json.clients) || {};
  check(`C5 after uninstall both clients report uninstalled (got ${show(goneClients)})`,
    goneClients.claude && goneClients.codex
      && goneClients.claude.state === 'uninstalled' && goneClients.codex.state === 'uninstalled');
  const leftover = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const leftoverCommands = ((leftover.hooks && leftover.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || []).map((h) => String((h && h.command) || ''));
  const uninstalledBoth = goneClients.claude && goneClients.codex
    && goneClients.claude.state === 'uninstalled' && goneClients.codex.state === 'uninstalled';
  check(`C5 uninstall removes only our entry — the unrelated hook is still there (got ${show(leftoverCommands)})`,
    uninstalledBoth && !leftoverCommands.some((c) => /write-guard|write-protection/.test(c))
      && leftoverCommands.includes(UNRELATED_CMD));
  check('C5 and the unrelated Codex configuration is still there',
    uninstalledBoth && fs.readFileSync(path.join(CODEX, 'config.toml'), 'utf8').includes('keep_me = "yes"'));

  // =====================================================================================
  // C6 — admission looks at the real checkout before anything mutates it, and refuses without
  //      touching a byte.
  // =====================================================================================

  const DIRTY = makeTarget('target-dirty');
  // staged product change
  fs.writeFileSync(p(DIRTY, 'runner/run.js'), '// product: edited by hand\n');
  git(DIRTY, ['add', 'runner/run.js']);
  // unstaged config change
  fs.writeFileSync(p(DIRTY, 'pipeline.config.json'), `${FIXTURE_CONFIG}\n`);
  // untracked product file
  fs.writeFileSync(p(DIRTY, 'scripts/new-thing.js'), '// untracked product\n');
  // somebody else's frozen suite, which has no provenance for THIS issue
  fs.writeFileSync(p(DIRTY, `tests/acceptance/${ISSUE_B}/test.js`), '// edited by hand\n');
  // the three that must NOT be refused
  fs.writeFileSync(p(DIRTY, 'runs/host.json'), '{"ignored":"host artifact"}\n');
  fs.writeFileSync(p(DIRTY, 'docs/planning-draft-2020-01-01-fixture.md'), '# planning draft, revised\n');
  fs.writeFileSync(p(DIRTY, `tests/acceptance/${ISSUE_A}/test.js`), '// this issue\'s suite, revised\n');

  const REFUSED_PATHS = ['runner/run.js', 'pipeline.config.json', 'scripts/new-thing.js', `tests/acceptance/${ISSUE_B}/test.js`];
  const ADMITTED_PATHS = ['runs/host.json', 'docs/planning-draft-2020-01-01-fixture.md', `tests/acceptance/${ISSUE_A}/test.js`];
  const HOST_ARTIFACT = ADMITTED_PATHS[0];

  // Again, the harness before the verdict: if the fixture is not dirty in all three ways, a
  // refusal that names nothing and a checkout with nothing to refuse are the same output.
  const porcelain = git(DIRTY, ['status', '--porcelain', '-uall']).stdout || '';
  check(`harness: the dirty fixture really is staged, unstaged and untracked at once (git said ${show(porcelain.trim().slice(0, 300))})`,
    /^M\s/m.test(porcelain) && /^\sM/m.test(porcelain) && /^\?\?/m.test(porcelain));
  check('harness: and its ignored host artifact is genuinely ignored',
    git(DIRTY, ['check-ignore', '-q', '--', HOST_ARTIFACT]).status === 0);

  const dirtyTree = snapshot(DIRTY);
  const dirtyGit = gitState(DIRTY);
  const admitJson = node(CLI, ['admit', '--target', DIRTY, '--issue', ISSUE_A, '--json']);
  check(`C6 admission REFUSES a checkout carrying protected changes with no provenance (exit ${admitJson.status})`,
    admitJson.status !== 0 && Boolean(admitJson.json) && admitJson.json.admit === false);
  const refusals = (admitJson.json && admitJson.json.refusals) || [];
  const refusedNames = new Set(refusals.map((r) => String((r && (r.path || r)) || '')));
  // The refusal list has to be REAL before "it does not name X" means anything.
  const refusalReal = ran(admitJson) && admitJson.status !== 0 && refusals.length > 0;
  for (const rel of REFUSED_PATHS) {
    check(`C6 the refusal names \`${rel}\` exactly (got ${show([...refusedNames])})`, refusedNames.has(rel));
  }
  for (const rel of ADMITTED_PATHS) {
    check(`C6 and does NOT name \`${rel}\` — it has planning or frozen-test provenance, or is an ignored host artifact`,
      refusalReal && !refusedNames.has(rel));
  }
  const states = new Set(refusals.map((r) => String((r && r.state) || '')));
  check(`C6 staged, unstaged and untracked are all seen (got ${show([...states])})`,
    ['staged', 'unstaged', 'untracked'].every((s) => states.has(s)));

  const admitText = node(CLI, ['admit', '--target', DIRTY, '--issue', ISSUE_A]);
  const diagnostic = `${admitText.stdout}\n${admitText.stderr}`;
  const diagnosticReal = ran(admitText) && admitText.status !== 0
    && REFUSED_PATHS.every((rel) => diagnostic.includes(rel));
  for (const rel of REFUSED_PATHS) {
    check(`C6 the human diagnostic lists the exact path \`${rel}\``, diagnostic.includes(rel));
  }
  for (const rel of ADMITTED_PATHS) {
    check(`C6 the human diagnostic does not list \`${rel}\``, diagnosticReal && !diagnostic.includes(rel));
  }
  check(`C6 the diagnostic names the recovery command (got ${show(diagnostic.slice(0, 400))})`,
    /write-protection(\.js)?\s+recover/.test(diagnostic));

  check('C6 refusal changed NOTHING on disk — no reset, clean, stash, overwrite, commit or move',
    refusalReal && sameSnapshot(dirtyTree, snapshot(DIRTY)));
  check('C6 and nothing in Git: index, working tree, HEAD and the stash stack are byte-identical',
    refusalReal && gitState(DIRTY) === dirtyGit);

  // Non-vacuity: a clean checkout is admitted, so the refusal above is about the changes.
  const CLEAN = makeTarget('target-clean');
  fs.writeFileSync(p(CLEAN, 'runs/host.json'), '{"ignored":"host artifact"}\n');
  const admitClean = node(CLI, ['admit', '--target', CLEAN, '--issue', ISSUE_A, '--json']);
  check(`C6 a clean checkout is admitted, ignored host artifacts and all (exit ${admitClean.status}: ${admitClean.stderr.trim().slice(0, 200)})`,
    admitClean.status === 0 && Boolean(admitClean.json) && admitClean.json.admit === true);

  // The three stages the criterion names have to actually call it, or the CLI is a museum
  // piece that admits nothing in production.
  const WIRED = [
    ['prepare', ['scripts/prepare-batch.js', 'scripts/prepare-batch-worker.js']],
    ['freeze', ['scripts/freeze.js']],
    ['dispatch', ['runner/queue.js', 'runner/run.js']],
  ];
  for (const [stage, candidates] of WIRED) {
    const wired = candidates.some((rel) => {
      try { return /write-protection/.test(fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8')); }
      catch { return false; }
    });
    check(`C6 the ${stage} stage reaches the admission check (one of ${candidates.join(', ')} references it)`, wired);
  }

  // =====================================================================================
  // C7 — recovery: a dedicated worktree and a manifest, originals left where they are.
  // =====================================================================================

  const untrackedBytes = fs.readFileSync(p(DIRTY, 'scripts/new-thing.js'));
  const beforeRecover = snapshot(DIRTY);
  const beforeRecoverGit = gitState(DIRTY);

  const rec1 = node(CLI, ['recover', '--target', DIRTY, '--issue', ISSUE_A, '--json']);
  check(`C7 \`recover\` exits 0 and reports what it made (exit ${rec1.status}: ${rec1.stderr.trim().slice(0, 200)})`,
    rec1.status === 0 && Boolean(rec1.json));
  const r1 = rec1.json || {};
  check(`C7 it created a DEDICATED recovery worktree (got ${show(r1.worktree)})`,
    typeof r1.worktree === 'string' && fs.existsSync(r1.worktree)
      && path.resolve(r1.worktree).toLowerCase() !== path.resolve(DIRTY).toLowerCase());
  const wtList = git(DIRTY, ['worktree', 'list', '--porcelain']).stdout || '';
  check('C7 and Git knows it as a worktree of that target',
    typeof r1.worktree === 'string'
      && wtList.split(/\r?\n/).some((l) => l.startsWith('worktree ')
        && path.resolve(l.slice('worktree '.length).trim()).toLowerCase() === path.resolve(r1.worktree).toLowerCase()));

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(r1.manifest, 'utf8')); } catch { manifest = null; }
  check(`C7 it wrote a patch/copy manifest (got ${show(r1.manifest)})`,
    manifest !== null && Array.isArray(manifest.entries) && manifest.entries.length > 0);
  const entries = (manifest && manifest.entries) || [];
  const byPath = new Map(entries.map((e) => [String(e && e.path), e]));
  for (const rel of REFUSED_PATHS) {
    check(`C7 the manifest carries \`${rel}\``, byPath.has(rel));
  }
  check(`C7 every entry declares whether it is a patch or a copy (got ${show([...new Set(entries.map((e) => e && e.kind))])})`,
    entries.length > 0 && entries.every((e) => ['patch', 'copy'].includes(String(e && e.kind))));
  check('C7 the untracked file is carried as a COPY, because a patch cannot represent it',
    byPath.has('scripts/new-thing.js') && String(byPath.get('scripts/new-thing.js').kind) === 'copy');
  let recovered = null;
  try { recovered = fs.readFileSync(path.join(r1.worktree, 'scripts', 'new-thing.js')); } catch { recovered = null; }
  check('C7 and its bytes are preserved in the recovery worktree',
    recovered !== null && Buffer.compare(recovered, untrackedBytes) === 0);

  check('C7 the ORIGINALS are left exactly where they were — recovery removes nothing',
    rec1.status === 0 && sameSnapshot(beforeRecover, snapshot(DIRTY)));
  check('C7 and the target\'s Git state is untouched',
    rec1.status === 0 && gitState(DIRTY) === beforeRecoverGit);

  const rec2 = node(CLI, ['recover', '--target', DIRTY, '--issue', ISSUE_A, '--json']);
  const rec3 = node(CLI, ['recover', '--target', DIRTY, '--issue', ISSUE_A, '--json']);
  check(`C7 running it again is not an error (exits ${rec2.status}, ${rec3.status})`,
    rec2.status === 0 && rec3.status === 0);
  const homes = [r1.worktree, rec2.json && rec2.json.worktree, rec3.json && rec3.json.worktree].map((w) => String(w || ''));
  const distinct = new Set(homes.map((w) => path.resolve(w).toLowerCase()));
  check(`C7 it is collision-safe: every successful run takes a distinct home, never half-overwriting one (got ${show([...distinct])})`,
    homes.every(Boolean) && distinct.size === homes.length);
  check('C7 and every home it reported still exists at the end', homes.every((w) => w && fs.existsSync(w)));
  let manifest2 = null;
  try { manifest2 = JSON.parse(fs.readFileSync(r1.manifest, 'utf8')); } catch { manifest2 = null; }
  check('C7 the first run\'s manifest is still readable and still lists the same paths',
    manifest2 !== null && Array.isArray(manifest2.entries)
      && REFUSED_PATHS.every((rel) => manifest2.entries.some((e) => String(e && e.path) === rel)));
  check('C7 and after three runs the originals are STILL intact',
    rec1.status === 0 && rec2.status === 0 && rec3.status === 0
      && sameSnapshot(beforeRecover, snapshot(DIRTY)));

  // =====================================================================================
  // C8 — one contract, read by everything, duplicated nowhere.
  // =====================================================================================

  check('C8 the contract parses as JSON', contract !== null && typeof contract === 'object');
  check(`C8 it carries an integer version (got ${show(contract && contract.version)})`,
    Boolean(contract) && Number.isInteger(contract.version));
  const roles = (contract && contract.roles) || {};
  for (const role of ['planner', 'test-author', 'probe', 'task', 'interactive']) {
    check(`C8 the role vocabulary lives here and includes \`${role}\``,
      Object.prototype.hasOwnProperty.call(roles, role));
  }
  const classes = (contract && contract.pathClasses) || {};
  for (const cls of ['planning', 'product', 'frozen', 'config', 'control']) {
    check(`C8 the path-class vocabulary lives here and includes \`${cls}\``,
      Object.prototype.hasOwnProperty.call(classes, cls) && Array.isArray(classes[cls]));
  }
  check(`C8 the deny reasons are enumerated here (got ${show([...DENY_REASONS]).slice(0, 300)})`,
    DENY_REASONS.size >= 3
      && ['pipeline-first', 'unknown-shell-form', 'role-path'].every((r) => DENY_REASONS.has(r)));
  check(`C8 the five status words are enumerated here too (got ${show(contract && contract.clientStates)})`,
    Boolean(contract) && Array.isArray(contract.clientStates)
      && CLIENT_STATES.every((s) => contract.clientStates.includes(s))
      && contract.clientStates.length === CLIENT_STATES.length);

  // The vocabulary is not retyped into prose. AGENTS.md gets a generated block instead, and
  // the block is short and points at the two commands a stuck session needs.
  const agents = fs.existsSync(path.join(REPO, 'AGENTS.md'))
    ? fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8') : '';
  const globs = Object.values(classes).flat().map(String);
  const leaked = globs.filter((g) => g.length > 3 && agents.includes(g));
  check(`C8 no path-class glob is copied into AGENTS.md (leaked: ${show(leaked).slice(0, 200)})`,
    globs.length > 0 && leaked.length === 0);
  const rolesInAgents = Object.keys(roles).filter((r) => new RegExp(`\\b${r}\\b`).test(agents));
  check(`C8 the role roster is not enumerated in AGENTS.md either (found: ${show(rolesInAgents)})`,
    Object.keys(roles).length > 0 && rolesInAgents.length <= 1);

  const blockMatch = /<!--\s*BEGIN WRITE PROTECTION\s*-->([\s\S]*?)<!--\s*END WRITE PROTECTION\s*-->/.exec(agents);
  check('C8 AGENTS.md carries a generated write-protection block, delimited by markers', Boolean(blockMatch));
  const block = blockMatch ? blockMatch[1] : '';
  check(`C8 the generated block is CONCISE — at most 30 lines (got ${block.split(/\r?\n/).length})`,
    Boolean(blockMatch) && block.split(/\r?\n/).length <= 30);
  check('C8 and it points at status and at recovery',
    /write-protection\.js\s+status/.test(block) && /write-protection\.js\s+recover/.test(block));

  // The single-source claim, proved by CHANGING the contract and watching two independent
  // consumers move together. The tooling is copied out so the real tree is never edited.
  const COPY = path.join(tmp, 'tooling-copy');
  for (const rel of ['scripts', 'runner', 'contracts', 'pipeline', 'tools']) {
    try { fs.cpSync(path.join(REPO, rel), path.join(COPY, rel), { recursive: true }); } catch { /* reported below */ }
  }
  try { fs.copyFileSync(path.join(REPO, 'pipeline.config.json'), path.join(COPY, 'pipeline.config.json')); } catch { /* ditto */ }
  const copiedContract = path.join(COPY, 'contracts', 'write-protection.json');
  check('C8 the tooling copy carries its own contract', fs.existsSync(copiedContract));
  if (fs.existsSync(copiedContract)) {
    const edited = JSON.parse(fs.readFileSync(copiedContract, 'utf8'));
    edited.pathClasses = { ...edited.pathClasses, product: [...(edited.pathClasses.product || []), 'vendor/**'] };
    fs.writeFileSync(copiedContract, JSON.stringify(edited, null, 2));

    const VEND = makeTarget('target-vendor');
    const g = node(path.join(COPY, 'scripts', 'write-protection.js'),
      ['lease', '--grant', '--target', VEND, '--role', 'probe', '--issue', ISSUE_A,
        '--run', 'run-vendor', '--pid', String(process.pid), '--minutes', '30', '--json']);
    const vendorToken = g.json && g.json.token;
    const beforeEdit = decide({ cwd: VEND, action: 'write', path: 'vendor/pinned.txt', token: vendorToken });
    // Note: `vendor/pinned.txt` is a FROZEN path in the fixture config, so the real contract
    // still denies it. The copy widens `product`, and frozen wins — so the discriminating
    // path is a vendor file that is not frozen.
    fs.writeFileSync(p(VEND, 'vendor/loose.txt'), 'loose\n');
    git(VEND, ['add', '-A', '.']);
    git(VEND, ['commit', '-q', '-m', 'loose']);
    const withReal = decide({ cwd: VEND, action: 'write', path: 'vendor/loose.txt', token: vendorToken });
    const withEdited = node(path.join(COPY, 'scripts', 'write-guard.js'), [],
      { input: JSON.stringify({ cwd: VEND, action: 'write', path: 'vendor/loose.txt', token: vendorToken }) });
    check(`C8 the shipped contract does not classify \`vendor/loose.txt\` as product, so the probe is refused (got ${show(withReal.json && withReal.json.decision)})`,
      withReal.status === 2);
    check(`C8 editing ONE file — the contract — turns the same probe write into an allow, so the guard reads its policy from the contract (got exit ${withEdited.status})`,
      withEdited.status === 0 && Boolean(withEdited.json) && withEdited.json.decision === 'allow');
    check('C8 (and the frozen class still wins over the widened product class)', beforeEdit.status === 2);

    // The second consumer: admission, over the same edited contract.
    fs.writeFileSync(p(VEND, 'vendor/loose.txt'), 'edited by hand\n');
    const admitReal = node(CLI, ['admit', '--target', VEND, '--issue', ISSUE_A, '--json']);
    const admitEdited = node(path.join(COPY, 'scripts', 'write-protection.js'),
      ['admit', '--target', VEND, '--issue', ISSUE_A, '--json']);
    check(`C8 admission under the shipped contract does not treat that file as protected product (exit ${admitReal.status})`,
      admitReal.status === 0);
    check(`C8 admission under the EDITED contract refuses it — one contract, two consumers, one edit (exit ${admitEdited.status})`,
      admitEdited.status !== 0 && Boolean(admitEdited.json) && admitEdited.json.admit === false);
  }

  // =====================================================================================
  // C10 — the documents say the same thing, and the change-log row exists.
  // =====================================================================================

  // One token per fact the criterion lists, matched case-insensitively: the default, the
  // opt-out, the admission backstop, the recovery flow, the hook limitation, and the command
  // that reports status.
  const TOKENS = [
    ['the pipeline-first default', /pipeline-first/i],
    ['the explicit opt-out', /allow-writes/i],
    ['the admission backstop', /admission/i],
    ['the recovery flow, by the command that performs it', /write-protection(\.js)?\s+recover/i],
    ['where to see enforcement honestly', /write-protection(\.js)?\s+status/i],
    ['the hook limitation', /hook/i],
  ];
  for (const rel of DOCS) {
    let text = '';
    try { text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'); } catch { text = ''; }
    for (const [what, re] of TOKENS) {
      check(`C10 ${rel} states ${what}`, re.test(text));
    }
  }

  // The change-log row. DESIGN.md §12 puts the rows in docs/change-log.md and the citation in
  // DESIGN.md, so either file carrying the row satisfies "append a DESIGN.md change-log row".
  const rowRe = new RegExp(`\\|\\s*${ISSUE}\\s*\\|`);
  let logText = '';
  try { logText = fs.readFileSync(path.join(REPO, 'docs', 'change-log.md'), 'utf8'); } catch { logText = ''; }
  let designText = '';
  try { designText = fs.readFileSync(path.join(REPO, 'DESIGN.md'), 'utf8'); } catch { designText = ''; }
  check(`C10 a change-log row keyed \`${ISSUE}\` was appended`, rowRe.test(logText) || rowRe.test(designText));
  check(`C10 and DESIGN.md carries the pinned citation change-log row \`${ISSUE}\``,
    designText.includes(`change-log row \`${ISSUE}\``));
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  // Cleanup is never a verdict. Registered worktrees hold handles on Windows, so this is
  // best-effort by design.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* disposable */ }
}
process.exit(failed);
