// Frozen acceptance test — repo-3ec: Git-authoritative executable modes for conveyor
// publication (see docs/design/provenance/repo-3ec.md). This is the RED half of the suite;
// the companion guard.js beside it pins the "existing behaviour X still holds" invariants the
// change must PRESERVE (green at the fork point, declared as guards there). Between the two
// files every criterion below is covered in BOTH directions.
//
// THE LIMITATION THIS REPRODUCES. On a Windows-hosted conveyor run the coding model produced
// executable-required shell scripts whose Git index/tree mode was 100644. A Docker bind mount
// reported those files executable, so a filesystem-only `test -x` assertion PASSED even though
// the published tree was wrong; and an explicit `git update-index --chmod=+x` intent that DID
// set mode 100755 was not honoured as the thing verified and published. The fix must judge the
// candidate's contents and Git-AUTHORITATIVE modes together — where the workspace permission
// bits cannot be trusted (Windows bind mount), by MATERIALIZING that candidate into a native
// POSIX tree — refuse a 100644 executable-required file, refuse an index-only frozen-mode
// mutation, refuse stale evidence after a post-verification mutation, fail closed on a
// materialization/verifier operation error, and preserve explicit 100755 through
// staging/commit/docs/publication. Executability is never inferred from an extension, a shebang,
// an apparent bind-mount bit, or a blanket chmod. Mechanism is the implementation's choice; these
// tests observe only real production outcomes — the real verifier's verdict, the real host's
// collected artifacts / computed outcome / publication, the resulting committed Git modes on the
// PUSHED bare remote, native POSIX execution of that published commit, and whether a PR is
// created — never an invented field or API (no ctx.verify.publishable, no executableRequired, no
// new verify/status schema field).
//
// PRODUCTION PATHS EXERCISED (nothing hand-built that production owns):
//   * the REAL verifier            pipeline/verify.js       — T1,T2,T3
//   * the REAL container entrypoint pipeline/entrypoint.sh   — T5,T6,T7 (as the external
//                                    execution stand-in, run nested; it does the real
//                                    staging/commit/docs/final-verify and returns its true
//                                    artifacts/exit); also guard.js G10
//   * the REAL host task body       runner/run.js runOneTask — T5,T6,T7 (real clone, real
//                                    collectArtifacts + artifact-schema validation + outcomeFor,
//                                    real runner/publish.js push + PR); also guard.js G10
//   * the REAL canonical proof      scripts/prove-tests.js runGate -> scripts/freeze-gate.js — T9
//                                    (via runGate's own external Docker-command adapter
//                                    FREEZE_GATE_DOCKER_CMD, mount-address translation only)
// Only the external model CLI (PIPELINE_AGENT_CMD), the external Beads CLI (PIPELINE_BD_CMD) and
// the external GitHub CLI (PIPELINE_GH_CMD) are replaced. The materialization/verifier-operation
// error case and its scoped git pass-through/fault adapter moved to guard.js G10 (re-author
// correction 2). No provider key, no network, no container engine; every durable store is a
// disposable temp tree.
//
// PLATFORM HONESTY (the brief's rule, not a narrowing of scope). The canonical two-direction
// gate runs this suite inside its configured Linux Docker image, where os.tmpdir() is a native
// POSIX filesystem, `git checkout`/`git archive` apply the exec bit from the Git mode, and
// `test -x` reflects the committed mode. The RED-side author check runs on the Windows host, where
// MSYS `test -x` treats a shebang script as executable regardless of Git mode. Every verdict /
// committed-mode / PR-count assertion below discriminates on the Linux host; the assertions that
// REQUIRE a native POSIX exec bit (T2's and T5's native execution, and T9's whole body) are gated
// behind `POSIX` and reported as SKIPPED on win32 rather than faked. The suite is still RED on
// win32 via T1, T3, T5, T6, T7 and the win32-visible T9 premise, so the local author check
// discriminates too.
//
// CRITERION PAIRING — every check names its criterion, every criterion names >=1 check here or
// in guard.js. (C1..C6 are the six frozen criterion sentences in the issue.)
//   C1 a core.filemode=false / apparent-exec-bit / index-100644 fixture fails the unchanged
//      executable assertion in the real verifier and is refused for publication (0 PRs). -> T1,T5
//   C2 an explicit-100755 fixture passes executable verification in a native POSIX
//      materialization, and the published commit retains 100755.                         -> T2,T5
//   C3 ordinary files stay 100644, pre-existing executables stay 100755, explicit removal yields
//      100644; no extension/shebang/bind-mount/blanket-chmod inference.       -> T1,T5 (+G1,G2,G3)
//   C4 proof/implementation bind BOTH content and Git modes to the candidate; changed content or
//      modes invalidate prior evidence and block a reused verdict or publication.    -> T3,T6,T7
//   C5 index-only changes to frozen modes are refused, not repaired, while frozen content,
//      symlinks, configuration, regression policy, credential scanning and ownership boundaries
//      stay preserved. C5 is entirely PRESERVED behaviour, so it pairs to guards.  -> G2,G4,G5,G7
//   C6 deterministic integration exercises the canonical verifier AND publication entrypoints for
//      the negative, positive, ordinary, stale-evidence and materialization-error paths, while
//      existing frozen tests remain unchanged.   -> T5,T6,T7,T9 (+G6 surface, +G10 mat-error guard)
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VERIFY = path.join(ROOT, 'pipeline', 'verify.js');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const PIPE = path.join(ROOT, 'pipeline');
const runmod = require(path.join(ROOT, 'runner', 'run.js'));
const logmod = require(path.join(ROOT, 'runner', 'log.js'));
const proveTests = require(path.join(ROOT, 'scripts', 'prove-tests.js'));
const { createPauseGate } = require(path.join(ROOT, 'runner', 'pause.js'));
// Production constants, imported rather than reinvented (the criteria forbid inventing an
// outcome map or verifier fields): what publication treats as PR-eligible, and how an exit code
// becomes an outcome. A test that duplicated these would drift from the code it judges.
const { PR_ELIGIBLE_OUTCOMES } = require(path.join(ROOT, 'runner', 'publish.js'));
const { outcomeFor } = require(path.join(ROOT, 'runner', 'queue.js'));

const POSIX = process.platform !== 'win32';
const ISSUE = 'exec-fixture';

// A Git Bash on the Windows reference host; a plain `bash` everywhere the canonical gate runs.
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');

const temps = [];
const tests = [];
function test(name, body) { tests.push({ name, body }); }

// ── environment isolation (C5's env clause, and general hygiene) ─────────────────────────────
// Correction 8: NOT "an unused BASE_ENV copy" — the sanitized env is threaded into EVERY git()
// and every spawned production path below, so the inherited global/system Git config (a
// developer's core.fileMode=true, autocrlf, aliases or GIT_CONFIG_* redirection) cannot change a
// mode/tamper verdict, and the Node loader/test seams a parent runner may have set (NODE_OPTIONS,
// NODE_TEST_CONTEXT) cannot preload into the real verifier, entrypoint or gate we spawn. Provider
// credentials and pipeline CLI seams are stripped so nothing here can reach a live model, Beads or
// GitHub. The host process environment is left as found after each fixture.
//
// An EMPTY CONFIG FILE, not os.devNull, neutralises the inherited global/system config: it works
// identically on Linux and on the Windows author host, where pointing GIT_CONFIG_GLOBAL at the NUL
// device breaks every git config read.
const NULL_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3ec-nullcfg-')), 'null.gitconfig');
fs.writeFileSync(NULL_GITCONFIG, '');
function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_GH_CMD',
    'PIPELINE_EXEC_STUB', 'PIPELINE_AGENT_CMD', 'PIPELINE_MODEL', 'PIPELINE_KEEP_WORKSPACE',
    'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'FREEZE_GATE_CMD', 'FREEZE_GATE_DOCKER_CMD',
    'FREEZE_GATE_DOCKER_IMAGE', 'PIPELINE_TESTING_FREEZE_GATE_SEAM',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  env.GIT_CONFIG_GLOBAL = NULL_GITCONFIG;
  env.GIT_CONFIG_SYSTEM = NULL_GITCONFIG;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return { ...env, ...extra };
}
const BASE_ENV = isolatedEnv();

function run(cmd, args, options = {}) {
  // Correction 8: setup/assertion/materialization subprocesses inherit the sanitized env unless a
  // caller overrides it explicitly.
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, windowsHide: true, env: BASE_ENV, ...options });
}
function git(dir, ...args) {
  return run('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir });
}
function mkTemp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `r3ec-${tag}-`)); temps.push(d); return d; }
const posix = (p) => p.split(path.sep).join('/');
// Compare two directory paths by their (unique mkdtemp) basename, robust to the git-bash `pwd`
// giving `/c/…/r3ec-XXXX` where Node holds `C:\…\r3ec-XXXX`: a raw string compare would always
// differ on win32 and silently pass the "distinct materialization" check. mkdtemp basenames are
// unique, so equal basename here means the same directory.
const dirBase = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

// The executable assertion the criteria name — `test -x bin/tool.sh` — run UNCHANGED by the real
// verifier's configured command. A sentinel records that the assertion ACTUALLY executed, the
// directory it executed IN (so a materialization that runs it in a native POSIX tree distinct from
// the workspace is observable, correction 6), and whether the README docs delta was visible at
// that moment (so "final verification ran after the docs delta" is observable, correction 6). One
// line per execution, so the number of executions is the line count.
const VERIFY_EXEC = '#!/bin/sh\n'
  + 'if [ -n "$EXEC_SENTINEL" ]; then\n'
  + '  if grep -q "executable-mode workflow" README.md 2>/dev/null; then rd=1; else rd=0; fi\n'
  + '  printf \'ran %s readme=%s\\n\' "$(pwd)" "$rd" >> "$EXEC_SENTINEL"\n'
  + 'fi\n'
  + 'test -x bin/tool.sh\n';
// A command that always passes, so a fixture whose ONLY discriminator is a Git mode (T4's
// frozen-mode mutation) is not confounded by the executable assertion.
const VERIFY_OK = '#!/bin/sh\nexit 0\n';
const TOOL = '#!/bin/sh\necho conveyor-tool\n';

// The `git ls-tree` mode of a path at a commit: '100644' ordinary, '100755' executable, '120000'
// symlink. A Git-object property, identical on every host, so it means the same on the Windows
// author check and inside the Linux canonical gate. `gitDir` lets it read a bare remote directly.
function treeMode(dir, commit, file, gitDir) {
  const pre = gitDir ? ['--git-dir', gitDir] : [];
  const r = git(dir, ...pre, 'ls-tree', commit, '--', file);
  const m = /^(\d{6}) /.exec((r.stdout || '').trim());
  return m ? m[1] : null;
}
// A native POSIX materialization of a commit: `git archive | tar -x` restores the Git mode onto a
// real filesystem, so `test -x` there reflects the committed mode rather than a bind-mount bit.
// POSIX-only; the caller skips it (and says so) on win32. `gitDir` reads a bare remote.
function nativeExecutable(dir, commit, file, gitDir) {
  const out = mkTemp('mat');
  const pre = gitDir ? `--git-dir "${posix(gitDir)}" ` : '';
  const ar = run('sh', ['-c', `git ${pre}archive --format=tar ${commit} | tar -x -C "${posix(out)}"`], { cwd: dir });
  if (ar.status !== 0) return { ok: false, why: `materialization failed: ${(ar.stderr || '').trim()}` };
  const target = path.join(out, file);
  if (!fs.existsSync(target)) return { ok: false, why: `materialized tree is missing ${file}` };
  const x = run('sh', ['-c', `test -x "${posix(target)}"`]);
  return { ok: true, executable: x.status === 0 };
}

// ═══ verifier-level fixtures (drive the REAL pipeline/verify.js, as tests/unit/verify-buffer) ═══
// `mode` is the Git index/tree mode staged for bin/tool.sh; `worktreeExec` sets the apparent
// filesystem bit AFTER commit (the untrusted signal the fix must not believe). core.filemode is
// disabled exactly as the reproduced Windows host has it.
function makeVerifyRepo(tag, { verifyCommand = 'sh verify-exec.sh', mode = '100644', worktreeExec = false } = {}) {
  const dir = mkTemp(tag);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec fixture');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand, frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'verify-exec.sh'), VERIFY_EXEC);
  fs.writeFileSync(path.join(dir, 'verify-ok.sh'), VERIFY_OK);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool.sh'), TOOL);
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  git(dir, 'add', '-A');
  if (mode === '100755') git(dir, 'update-index', '--chmod=+x', '--', 'bin/tool.sh');
  git(dir, 'commit', '-qm', 'pinned fixture');
  const head = (git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(head), `${tag} did not pin a commit: ${head}`);
  assert.strictEqual(treeMode(dir, 'HEAD', 'bin/tool.sh'), mode, `${tag} did not commit bin/tool.sh at ${mode}`);
  if (worktreeExec) { try { fs.chmodSync(path.join(dir, 'bin', 'tool.sh'), 0o755); } catch { /* Windows no-op */ } }
  return { dir, head };
}

// Run the REAL verifier against a fixture HEAD, exactly as verify-buffer.test.js does, under the
// isolated environment. Returns the parsed verify.json, the exit code, the sentinel records (a
// list of {dir, readme} where the executable assertion ran), and stderr.
function runVerifier(dir, extraEnv = {}) {
  const sentinel = path.join(mkTemp('sentinel'), 'ran.txt');
  const r = run(process.execPath, [VERIFY], {
    cwd: dir,
    env: { ...BASE_ENV, WORKSPACE: dir, ISSUE_ID: ISSUE, EXEC_SENTINEL: sentinel, ...extraEnv },
  });
  let json = null;
  try { json = JSON.parse(fs.readFileSync(path.join(dir, '.run', 'verify.json'), 'utf8')); }
  catch { /* left null — the checks report it */ }
  const ran = fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : '';
  const records = ran.split('\n').filter(Boolean).map((line) => {
    const m = /^ran (.*) readme=(\d)$/.exec(line);
    return m ? { dir: m[1], readme: m[2] === '1' } : { dir: line, readme: false };
  });
  return { rc: r.status, json, records, runs: records.length, stderr: r.stderr };
}

// Save the candidate's workspace bytes + POSIX mode immediately before verification, so an
// in-place chmod workaround (correction 6) cannot pass as materialization: a correct fix judges a
// SEPARATE native materialization and leaves the original workspace file byte- and mode-identical.
function captureWorkspaceState(dir, file) {
  const abs = path.join(dir, file);
  return { abs, bytes: fs.readFileSync(abs), mode: POSIX ? (fs.statSync(abs).mode & 0o777) : null };
}
function assertWorkspaceUnchanged(before, label) {
  assert(Buffer.compare(fs.readFileSync(before.abs), before.bytes) === 0,
    `${label}: the candidate workspace bytes must be untouched by verification (no in-place rewrite)`);
  if (POSIX) {
    assert.strictEqual(fs.statSync(before.abs).mode & 0o777, before.mode,
      `${label}: the candidate workspace POSIX mode must be untouched by verification (no in-place chmod)`);
  }
}

// ── T1 / C1, C3 ───────────────────────────────────────────────────────────────────────────
test('T1 C1,C3 the real verifier REFUSES a core.filemode=false candidate whose executable-required bin/tool.sh has an apparent worktree exec bit (a shebang script) but Git mode 100644: the unchanged `test -x bin/tool.sh` assertion executes in a native materialization DISTINCT from the untrusted workspace, fails there, and the verdict is not pass; the workspace bytes/mode are left untouched (no in-place chmod), and extension/shebang/bind-mount executability is never inferred (RED today: the verifier trusts the untrusted worktree bit / MSYS shebang, runs the assertion in the workspace, and reports pass)', () => {
  const w = makeVerifyRepo('t1-neg', { mode: '100644', worktreeExec: true });
  assert.strictEqual(treeMode(w.dir, 'HEAD', 'bin/tool.sh'), '100644', 'the negative control must be committed at 100644');
  const before = captureWorkspaceState(w.dir, 'bin/tool.sh');
  const v = runVerifier(w.dir);
  assert(v.json, `the verifier wrote no result (stderr: ${(v.stderr || '').trim().slice(-400)})`);
  assert(v.runs >= 1, 'the unchanged executable assertion did not actually execute');
  // Correction 6: for a mismatched-mode fixture the assertion must run in a native materialized
  // candidate, NOT in the untrusted workspace (which is where an unfixed verifier runs it, and
  // where MSYS `test -x` wrongly passes a shebang script).
  assert(v.records.every((rec) => dirBase(rec.dir) !== dirBase(w.dir)),
    `the executable assertion must run in a materialized candidate distinct from the workspace, ran in: ${v.records.map((r) => r.dir).join('; ')}`);
  assert.strictEqual(v.json.acceptance, 'fail',
    `a 100644 executable-required file must FAIL the executable assertion, got acceptance=${v.json.acceptance} rc=${v.rc}`);
  assert.notStrictEqual(v.rc, 0, `the verifier must not exit 0 for a refused candidate (rc=${v.rc})`);
  assertWorkspaceUnchanged(before, 'T1');
});

// ── T2 / C2 ─────────────────────────────────────────────────────────────────────────────────
test('T2 C2 the real verifier ACCEPTS an explicit-100755 candidate through a native POSIX materialization: the same `test -x bin/tool.sh` assertion passes when the committed Git mode is 100755 (even though the workspace file carries no exec bit), the assertion runs in a materialized candidate distinct from the workspace, the workspace bytes/mode are left untouched, and the committed tree retains 100755 (RED today: the verifier judges the non-executable workspace bit, so the explicit 100755 intent is not what is verified)', () => {
  const w = makeVerifyRepo('t2-pos', { mode: '100755', worktreeExec: false });
  const before = captureWorkspaceState(w.dir, 'bin/tool.sh');
  const v = runVerifier(w.dir);
  assert(v.json, `the verifier wrote no result (stderr: ${(v.stderr || '').trim().slice(-400)})`);
  assert(v.runs >= 1, 'the unchanged executable assertion did not actually execute');
  assert(v.records.every((rec) => dirBase(rec.dir) !== dirBase(w.dir)),
    `the executable assertion must run in a materialized candidate distinct from the workspace, ran in: ${v.records.map((r) => r.dir).join('; ')}`);
  assert.strictEqual(v.json.acceptance, 'pass',
    `an explicit-100755 file must PASS via native materialization, got acceptance=${v.json.acceptance} rc=${v.rc}`);
  assert.strictEqual(v.rc, 0, `the verifier must exit 0 for the accepted 100755 candidate (rc=${v.rc})`);
  assert.strictEqual(treeMode(w.dir, 'HEAD', 'bin/tool.sh'), '100755',
    'verification must leave the published Git mode at 100755, never repair or drop it');
  assertWorkspaceUnchanged(before, 'T2');
  if (POSIX) {
    const nat = nativeExecutable(w.dir, 'HEAD', 'bin/tool.sh');
    assert(nat.ok, nat.why);
    assert(nat.executable, 'a native POSIX checkout of the 100755 commit must satisfy `test -x`');
  } else {
    console.log('    (native POSIX `test -x` skipped on win32 — exercised by the canonical Linux gate)');
  }
});

// ── T3 / C4 ─────────────────────────────────────────────────────────────────────────────────
test('T3 C4 verification binds evidence to BOTH content and Git modes: with the workspace bit held constant, a candidate at Git mode 100755 verifies pass and the same content re-committed at 100644 verifies fail, so a prior pass cannot survive a mode change (RED today: the verdict depends only on the unchanged workspace bit, so the two modes are indistinguishable and the stale pass is reused)', () => {
  const w = makeVerifyRepo('t3-bind', { mode: '100755', worktreeExec: true });
  const before = runVerifier(w.dir);
  assert(before.json, 'the verifier wrote no result for the 100755 candidate');
  assert.strictEqual(before.json.acceptance, 'pass', `the 100755 candidate must verify pass first, got ${before.json.acceptance}`);
  // The candidate's publishable Git mode changes to 100644 (content byte-identical, workspace bit
  // untouched). The earlier pass must NOT carry over.
  git(w.dir, 'update-index', '--chmod=-x', '--', 'bin/tool.sh');
  git(w.dir, 'commit', '-qm', 'drop executable mode');
  assert.strictEqual(treeMode(w.dir, 'HEAD', 'bin/tool.sh'), '100644', 'the mode change did not land');
  const after = runVerifier(w.dir);
  assert(after.json, 'the verifier wrote no result after the mode change');
  assert.strictEqual(after.json.acceptance, 'fail',
    `after the publishable mode changed to 100644 the executable assertion must fail — the prior pass is stale, got ${after.json.acceptance}`);
});

// NOTE — the index-only frozen-mode refusal (C5) lives in guard.js as [guard] G7, not here. The
// reviewed candidate's T4 asserted it was RED at the fork point on the premise that "the
// worktree-only tamper diff misses an index mode change with core.filemode=false". That premise is
// false on real git: with core.filemode=false git takes the effective worktree mode from the INDEX,
// so `git diff <forkPoint> -- tests/acceptance/` already reports an index-only `--chmod` change and
// the current verifier already refuses it as `tampered` (exit 3). It is therefore PRESERVED
// behaviour — a correct executable-mode fix must keep refusing (and not silently repair) it — which
// is exactly a guard. Moving it keeps C5 honest (a green check must be a labelled guard) and is
// reported as a defect in the re-author correction. See guard.js G7.

// ═══ integration fixtures — the REAL entrypoint driven by the REAL runOneTask host body ═══════
// The external execution stand-in (PIPELINE_EXEC_STUB) sets the reproduced host premise
// (core.filemode=false) in the REAL cloned WORKSPACE, then INVOKES THE REAL ENTRYPOINT nested and
// returns its true exit/artifacts; production then does the real clone, artifact collection +
// schema validation, outcome calculation and publication. Only the model / Beads / GitHub CLIs are
// replaced. Modelled on tests/unit/events.test.js's
// runOneTask fixture (proven Docker-free on this host), with a smarter bd stand-aside so the
// entrypoint's own `node -e` / `node <file>.js` children run untouched.

// The Beads seam. This preload reaches EVERY node child (NODE_OPTIONS=--require), so it must not
// disturb the entrypoint's own node calls: `node <path>.js`, `node -e '<script>' "<path-arg>"`,
// and bare `node -e '<script>'` all reach here. It answers ONLY a bd invocation — which the
// runner makes as PIPELINE_BD_CMD=node <verb> …, so `process.argv[1]` is a BARE LOWERCASE VERB
// (show/update/ready/export/remember/…) that node would otherwise try to load as a missing
// module. Every real node child's argv[1] is a path (contains a slash/dot), a flag, or absent, so
// it never matches the verb shape and is handed straight through untouched.
// Node ABSOLUTISES argv[1] before a --require preload sees it, so a bd verb `update` arrives here
// as `<cwd>/update` — a bare-verb regex on argv[1] never fires (the defect in the reviewed
// candidate, which made every claim/finish fall through to "stand aside" and node then try to load
// the verb as a module). Key on the BASENAME instead: stand aside for a `.js` script child and for
// anything whose basename is not one of the finite bd verbs the runner actually calls, and handle
// only real bd invocations. The entrypoint's own `node <file>.js` and `node -e '<script>' <arg>`
// children (arg basenames like docs-paths.z or the workspace dir) are never a bd verb, so they run
// untouched.
const BD_STUB = [
  "'use strict';",
  'const sfs = require("fs");',
  'const bn = (s) => String(s || "").replace(/\\\\/g, "/").split("/").pop();',
  'const VERBS = new Set(["show", "update", "ready", "note", "remember", "export", "create", "close", "list"]);',
  'const a1 = bn(process.argv[1]);',
  'if (/\\.js$/i.test(a1) || !VERBS.has(a1)) { /* real node child: stand aside */ } else {',
  '  const a = process.argv.slice(1).map(bn);',
  '  if (process.env.BD_CALLS) sfs.appendFileSync(process.env.BD_CALLS, a.join(" ") + "\\n");',
  '  if (a.includes("show")) {',
  '    sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "executable-mode fixture", description: "repo-3ec", acceptance_criteria: "a", design: "DESIGN.md 4.4" }]));',
  '  } else { sfs.writeSync(1, "[]"); }',
  '  process.exit(0);',
  '}',
  '',
].join('\n');

// The model stand-in. Two phases, detected from the prompt the entrypoint pipes in.
//   docs phase  — edits an ALLOWED root-level Markdown file (README.md), records its actual
//                 worktree/Git identity (cwd, whether HEAD is detached, and whether it is a LINKED
//                 worktree — git-dir != git-common-dir) to a path OUTSIDE any worktree, so docs
//                 running in an isolated detached worktree is provable (correction 6), and prints
//                 only a change summary.
//   code phase  — creates bin/tool.sh and expresses one of the mode intentions via SCEN, and
//                 records that the model was invoked (correction 2).
const AGENT = [
  "'use strict';",
  'const fs = require("fs");',
  'const cp = require("child_process");',
  'let prompt = ""; try { prompt = fs.readFileSync(0, "utf8"); } catch { prompt = ""; }',
  'const git = (...a) => cp.spawnSync("git", a, { encoding: "utf8" });',
  'const scen = process.env.SCEN || "";',
  'const gt = (...a) => String((git(...a).stdout) || "").trim();',
  'if (/change summary/i.test(prompt) || /in-repo documentation/i.test(prompt)) {',
  '  try { fs.appendFileSync("README.md", "\\nDocumented the explicit git update-index --chmod executable-mode workflow.\\n"); } catch {}',
  '  if (process.env.DOCS_ID_FILE) {',
  '    const gitDir = gt("rev-parse", "--absolute-git-dir");',
  '    const commonDir = gt("rev-parse", "--git-common-dir");',
  '    const detached = git("symbolic-ref", "-q", "HEAD").status !== 0;',
  '    try { fs.writeFileSync(process.env.DOCS_ID_FILE, JSON.stringify({ cwd: process.cwd(), gitDir, commonDir, detached })); } catch {}',
  '  }',
  // correction 5: append to the SHARED execution sentinel so one ordered trace records
  // implementation-verify (readme=0) -> isolated docs write (this line) -> final-verify
  // (readme=1). The bare line count and a readme=1 last line cannot prove that ordering.
  '  if (process.env.EXEC_SENTINEL) { try { fs.appendFileSync(process.env.EXEC_SENTINEL, "docs " + process.cwd() + "\\n"); } catch {} }',
  '  process.stdout.write("Documented the explicit git update-index --chmod=+x/-x executable-mode workflow.\\n");',
  '  process.exit(0);',
  '}',
  'if (process.env.MODEL_CALLS) { try { fs.appendFileSync(process.env.MODEL_CALLS, "code " + process.cwd() + "\\n"); } catch {} }',
  'fs.mkdirSync("bin", { recursive: true });',
  'fs.writeFileSync("bin/tool.sh", "#!/bin/sh\\necho conveyor-tool\\n");',
  'if (scen === "neg") {',
  // The reproduced bug: staged at Git mode 100644 (no --chmod) but carrying an apparent
  // workspace exec bit — core.filemode=false, so the bind-mount/shebang bit is the only "exec"
  // signal and the Git mode stays 100644.
  '  git("add", "--", "bin/tool.sh");',
  '  try { fs.chmodSync("bin/tool.sh", 0o755); } catch {}',
  '} else if (scen === "pos") {',
  '  fs.writeFileSync("plain.txt", "ordinary content\\n");',            // ordinary -> 100644
  '  git("update-index", "--chmod=-x", "--", "bin/drop.sh");',          // explicit removal -> 100644
  '  git("add", "--", "bin/tool.sh", "plain.txt");',
  '  git("update-index", "--chmod=+x", "--", "bin/tool.sh");',          // explicit addition -> 100755
  '} else {',                                                            // stale-* : genuinely verifies pass at 100755
  '  git("add", "--", "bin/tool.sh");',
  '  git("update-index", "--chmod=+x", "--", "bin/tool.sh");',
  // A real workspace exec bit too, so the candidate verifies pass TODAY on both hosts before the
  // adapter mutates it — the stale-evidence refusal must attach to the post-verify mutation, not
  // to a candidate that never verified.
  '  try { fs.chmodSync("bin/tool.sh", 0o755); } catch {}',
  '}',
  'process.exit(0);',
  '',
].join('\n');

// The container stand-in: establish the reproduced host premise, run the REAL entrypoint, then —
// only for a stale-evidence case — mutate the ALREADY-VERIFIED committed candidate immediately
// before returning to the host, WITHOUT re-running the verifier. `content` changes bytes only;
// `mode` changes the Git mode only. Every mutation command's success is recorded, and the passing
// evidence bytes + the verify-run counter are captured before and after the mutation so a re-run
// of verification (which must NOT happen) would be observable (correction 3).
const EXEC_STUB = [
  '#!/bin/sh',
  '# correction 2: production runOneTask clones the bare remote, so the seed\'s core.filemode does',
  '# not transfer. Establish and record the reproduced host premise in the REAL workspace.',
  'git config core.filemode false 2>/dev/null',
  'git config --bool core.filemode > "$R3EC_FILEMODE" 2>/dev/null',
  'pwd > "$R3EC_WSID" 2>/dev/null',
  '"$R3EC_SHELL" "$R3EC_ENTRYPOINT"',
  'RC=$?',
  '# correction 5: unconditionally capture the candidate committed mode, the apparent',
  '# workspace exec bit and the final verifier evidence in the REAL clone, before the host',
  '# discards the workspace — so the negative control can prove staged 100644 + apparent',
  '# exec bit + assertion execution, not merely an unrelated refusal.',
  '[ -n "$R3EC_HEAD_TREE" ] && git ls-tree HEAD -- bin/tool.sh > "$R3EC_HEAD_TREE" 2>/dev/null',
  '[ -n "$R3EC_WS_EXEC" ] && { if [ -x bin/tool.sh ]; then echo yes; else echo no; fi > "$R3EC_WS_EXEC"; }',
  '[ -n "$R3EC_FINAL_EVID" ] && [ -f .run/verify.json ] && cp .run/verify.json "$R3EC_FINAL_EVID" 2>/dev/null',
  'if [ "$RC" -eq 0 ] && [ -n "$R3EC_MUTATE" ]; then',
  '  git config user.email fixture@example.invalid >/dev/null 2>&1',
  '  git config user.name "repo-3ec fixture" >/dev/null 2>&1',
  '  # capture pre-mutation passing evidence + candidate identity + verify-run counter',
  '  [ -f .run/verify.json ] && cp .run/verify.json "$R3EC_PRE_EVID" 2>/dev/null',
  '  git rev-parse "HEAD:bin/tool.sh" > "$R3EC_PRE_BLOB" 2>/dev/null',
  '  git ls-tree HEAD -- bin/tool.sh > "$R3EC_PRE_TREE" 2>/dev/null',
  '  if [ -f "$EXEC_SENTINEL" ]; then grep -c \'^ran .* readme=[01]$\' "$EXEC_SENTINEL" > "$R3EC_PRE_RUNS"; else echo 0 > "$R3EC_PRE_RUNS"; fi',
  '  ok=1',
  '  if [ "$R3EC_MUTATE" = "content" ]; then',
  '    printf \'echo stale-content\\n\' >> bin/tool.sh || ok=0',
  '    git add -- bin/tool.sh || ok=0',
  '    git commit -q --amend --no-edit || ok=0',
  '  elif [ "$R3EC_MUTATE" = "mode" ]; then',
  '    git update-index --chmod=-x -- bin/tool.sh || ok=0',
  '    git commit -q --amend --no-edit || ok=0',
  '  fi',
  '  # capture post-mutation observations (verification must NOT have re-run)',
  '  [ -f .run/verify.json ] && cp .run/verify.json "$R3EC_POST_EVID" 2>/dev/null',
  '  git rev-parse "HEAD:bin/tool.sh" > "$R3EC_POST_BLOB" 2>/dev/null',
  '  git ls-tree HEAD -- bin/tool.sh > "$R3EC_POST_TREE" 2>/dev/null',
  '  if [ -f "$EXEC_SENTINEL" ]; then grep -c \'^ran .* readme=[01]$\' "$EXEC_SENTINEL" > "$R3EC_POST_RUNS"; else echo 0 > "$R3EC_POST_RUNS"; fi',
  '  [ "$ok" -eq 1 ] && echo ok > "$R3EC_MUTSTAT" || echo fail > "$R3EC_MUTSTAT"',
  'fi',
  'exit $RC',
  '',
].join('\n');

// NOTE — the materialization / verifier-operation-error case moved to guard.js (G10), per the
// re-author correction 2: a scoped fault at an EXISTING production verifier operation (the
// frozen-config read `git show <forkPoint>:pipeline.config.json`) is already handled by the real
// verifier's fail-closed try/catch at the fork point, so it is PRESERVED behaviour a correct
// executable-mode fix must keep — which is a guard, not a RED requirement. The old T8 faulted
// `git archive` / `git checkout-index`, which prescribed a future materializer's implementation
// (a fix using `-C`/`-c`, a worktree or another operation could not satisfy it). See guard.js G10.

// A target repo + bare remote for the exec-mode conveyor. The seed carries the verifier command,
// the frozen suite placeholder, README.md (an allowed docs surface), and two PRE-EXISTING
// executables — bin/keep.sh (left untouched -> stays 100755) and bin/drop.sh (explicitly de-x'd
// by the model -> 100644). core.filemode is disabled on the seed, matching the reproduced host
// (the clone re-establishes it in EXEC_STUB, since the config does not transfer through a clone).
function seedTarget(tag) {
  const root = mkTemp(tag);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  git(seed, 'config', 'user.name', 'repo-3ec fixture');
  git(seed, 'config', 'core.filemode', 'false');
  git(seed, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-exec.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(seed, 'verify-exec.sh'), VERIFY_EXEC);
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'bin', 'keep.sh'), '#!/bin/sh\necho keep\n');
  fs.writeFileSync(path.join(seed, 'bin', 'drop.sh'), '#!/bin/sh\necho drop\n');
  fs.mkdirSync(path.join(seed, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  git(seed, 'add', '-A');
  git(seed, 'update-index', '--chmod=+x', '--', 'bin/keep.sh');
  git(seed, 'update-index', '--chmod=+x', '--', 'bin/drop.sh');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  return { root, remote, seed };
}

// Drive one issue through the REAL runOneTask against a fixture target. Returns the manifest row,
// the number of GitHub PR-creation calls the real publication actually made, the bare-remote tip
// of the task branch (or null), the sentinel records, the recorded docs identity, the recorded
// workspace premise, and — for stale cases — the captured pre/post observations.
async function conveyor(tag, { scen, mutate = '' }) {
  const world = seedTarget(tag);
  const bdStub = path.join(world.root, 'bd-stub.js');
  const agent = path.join(world.root, 'agent.js');
  const execStub = path.join(world.root, 'exec-stub.sh');
  const ghLog = path.join(world.root, 'gh-calls.txt');
  const bdCalls = path.join(world.root, 'bd-calls.txt');
  const sentinel = path.join(world.root, 'exec-sentinel.txt');
  const scratchHome = mkTemp('home');
  const cap = (name) => path.join(world.root, name);
  fs.writeFileSync(bdStub, BD_STUB);
  fs.writeFileSync(agent, AGENT);
  fs.writeFileSync(execStub, EXEC_STUB);

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { saved[k] = process.env[k]; delete process.env[k]; };
  // Isolate Git global/system config and strip parent Node loader/test seams for every subprocess
  // (correction 8). Isolate HOME so the entrypoint's ~/.claude.json write hits scratch, not the
  // operator's home.
  set('GIT_CONFIG_GLOBAL', NULL_GITCONFIG); set('GIT_CONFIG_SYSTEM', NULL_GITCONFIG);
  set('GIT_CONFIG_NOSYSTEM', '1'); set('GIT_TERMINAL_PROMPT', '0');
  del('GIT_CONFIG_COUNT'); del('GIT_CONFIG_KEY_0'); del('GIT_CONFIG_VALUE_0');
  set('HOME', scratchHome);
  del('NODE_TEST_CONTEXT'); del('PIPELINE_KEEP_WORKSPACE');
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_CHATGPT_AUTH', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_MODEL', 'GIT_CONFIG_PARAMETERS',
    'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) del(k);
  // The bd seam needs its preload to reach every node child; the smart stand-aside keeps the
  // entrypoint's own node calls untouched.
  set('PIPELINE_BD_CMD', process.execPath);
  set('NODE_OPTIONS', `--require "${posix(bdStub)}"`);
  set('BD_ISSUE_ID', ISSUE);
  set('BD_CALLS', posix(bdCalls));
  // The container stand-in -> the real entrypoint. cwd/WORKSPACE/RUN_DIR are set by executeTask;
  // the entrypoint reads these from the environment we seed here.
  set('PIPELINE_EXEC_STUB', execStub);
  set('R3EC_SHELL', SHELL);
  set('R3EC_ENTRYPOINT', ENTRYPOINT);
  set('R3EC_MUTATE', mutate);
  set('PIPELINE_DIR', PIPE);
  set('PIPELINE_AGENT_CMD', `node "${posix(agent)}"`);
  set('PIPELINE_TESTING_NESTED_ENTRYPOINT', '1');
  set('PIPELINE_MAX_ATTEMPTS', '1');
  set('SCEN', scen);
  set('EXEC_SENTINEL', posix(sentinel));
  set('MODEL_CALLS', posix(cap('model-calls.txt')));
  set('DOCS_ID_FILE', posix(cap('docs-id.json')));
  set('R3EC_FILEMODE', posix(cap('filemode.txt')));
  set('R3EC_WSID', posix(cap('wsid.txt')));
  set('R3EC_PRE_EVID', posix(cap('pre-evid.json')));
  set('R3EC_POST_EVID', posix(cap('post-evid.json')));
  set('R3EC_PRE_BLOB', posix(cap('pre-blob.txt')));
  set('R3EC_POST_BLOB', posix(cap('post-blob.txt')));
  set('R3EC_PRE_TREE', posix(cap('pre-tree.txt')));
  set('R3EC_POST_TREE', posix(cap('post-tree.txt')));
  set('R3EC_PRE_RUNS', posix(cap('pre-runs.txt')));
  set('R3EC_POST_RUNS', posix(cap('post-runs.txt')));
  set('R3EC_MUTSTAT', posix(cap('mutstat.txt')));
  // correction 5: the candidate's committed mode, apparent workspace exec bit and final verifier
  // evidence, captured in the REAL clone before the host discards it.
  set('R3EC_HEAD_TREE', posix(cap('head-tree.txt')));
  set('R3EC_WS_EXEC', posix(cap('ws-exec.txt')));
  set('R3EC_FINAL_EVID', posix(cap('final-evid.json')));
  // The real GitHub PR-creation seam: count every call and hand back a URL. openPr never being
  // called is the observable the negative / stale cases require.
  set('PIPELINE_GH_CMD', `printf 'call\\n' >> "${posix(ghLog)}"; printf 'https://example.test/pr/1\\n'`);

  const log = logmod.startRun(path.join(world.root, 'runs'), `r3ec-${tag}`);
  const cfg = {
    targetRepoPath: world.seed,
    targetRepoRemote: world.remote,
    image: 'unused:local',
    wallClockMinutes: 60,
    maxAttempts: 1,
    probeIntervalMinutes: 15,
    maxPauseCycles: 96,
    concurrency: 1,
    gitTimeoutMs: 120000,
    bdTimeoutMs: 120000,
    lifecycleTimeoutMs: 120000,
  };
  const gate = createPauseGate(cfg, log, { sleepFn: async () => {}, token: 'r3ec-token' });
  let row = null;
  let threw = null;
  try {
    row = await runmod.runOneTask(cfg, { id: ISSUE, title: 'executable-mode fixture', priority: 1 }, log, 'r3ec-token', gate);
  } catch (e) { threw = e; } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  const readTxt = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const readTrim = (p) => readTxt(p).trim();
  const prCalls = readTxt(ghLog).split('\n').filter(Boolean).length;
  const branch = row && row.branch ? row.branch : `task/${ISSUE}`;
  const tipR = git(world.root, '--git-dir', world.remote, 'rev-parse', '--verify', `refs/heads/${branch}`);
  const tip = tipR.status === 0 ? (tipR.stdout || '').trim() : null;
  const ran = readTxt(sentinel);
  const verifierRecords = ran.split('\n').filter((line) => /^ran .* readme=[01]$/.test(line));
  let docsId = null;
  try { docsId = JSON.parse(readTxt(cap('docs-id.json'))); } catch { docsId = null; }
  return {
    world, row, threw, prCalls, branch, tip, ran,
    sentinelRuns: verifierRecords.length,
    sentinelReadmeLast: (verifierRecords.at(-1) || '').endsWith('readme=1'),
    filemode: readTrim(cap('filemode.txt')),
    wsid: readTrim(cap('wsid.txt')),
    modelCode: /(^|\n)code /.test(readTxt(cap('model-calls.txt'))),
    docsId,
    mutStat: readTrim(cap('mutstat.txt')),
    preEvid: readTxt(cap('pre-evid.json')),
    postEvid: readTxt(cap('post-evid.json')),
    preBlob: readTrim(cap('pre-blob.txt')),
    postBlob: readTrim(cap('post-blob.txt')),
    preTreeMode: (/^(\d{6}) /.exec(readTrim(cap('pre-tree.txt'))) || [])[1] || null,
    postTreeMode: (/^(\d{6}) /.exec(readTrim(cap('post-tree.txt'))) || [])[1] || null,
    preRuns: readTrim(cap('pre-runs.txt')),
    postRuns: readTrim(cap('post-runs.txt')),
    headTreeMode: (/^(\d{6}) /.exec(readTrim(cap('head-tree.txt'))) || [])[1] || null,
    wsExec: readTrim(cap('ws-exec.txt')),
    finalEvid: readTxt(cap('final-evid.json')),
    sentinelRecords: ran.split('\n').filter(Boolean),
  };
}

// ── T5 / C6, C1, C2, C3 ───────────────────────────────────────────────────────────────────
test('T5 C6,C1,C2,C3 deterministic integration through the REAL runOneTask (real clone, real entrypoint staging/commit/docs/final-verify, real artifact collection + schema validation + outcome, real publication): the reproduced host premise (core.filemode=false) is set and observed in the REAL cloned workspace and the model was invoked; the negative index-100644 control reaches NO verified-success outcome and makes ZERO PR-creation calls, while the explicit-100755 control reaches a verified "done" that publishes; the PUSHED bare-remote tip retains 100755 for the added executable, 100644 for an ordinary file, 100755 for the untouched pre-existing executable and 100644 for the explicitly removed one; the docs model edited allowed Markdown in an ISOLATED DETACHED LINKED worktree, final verification ran AFTER that delta and observed the README delta, and a native POSIX checkout of the published commit is executable (RED today: the negative control is wrongly verified and OPENS a PR, and the explicit-100755 candidate is not judged / published by its Git mode)', async () => {
  // Negative control — refused: branch may be pushed for review, but never a PR.
  const neg = await conveyor('t5-neg', { scen: 'neg' });
  assert(!neg.threw, `the negative control threw: ${neg.threw && neg.threw.stack}`);
  assert.strictEqual(neg.filemode, 'false',
    `correction 2: core.filemode must be established false in the real cloned workspace, got ${JSON.stringify(neg.filemode)}`);
  assert(neg.wsid && neg.wsid !== posix(neg.world.seed),
    'the real cloned workspace identity (not the seed) must be recorded');
  assert(neg.modelCode, 'the code-phase model stand-in must have been invoked');
  // correction 5: this must be the EXECUTABLE-NEGATIVE control, not an unrelated refusal — capture,
  // from the real task clone, that the candidate was staged at Git mode 100644, carried an apparent
  // executable workspace bit, under core.filemode=false, and that the unchanged executable assertion
  // actually executed against it.
  assert.strictEqual(neg.headTreeMode, '100644',
    `the negative control must commit bin/tool.sh at Git mode 100644 (the reproduced bug), got ${neg.headTreeMode}`);
  assert.strictEqual(neg.wsExec, 'yes',
    'the negative control must carry an apparent executable workspace bit — the untrusted signal the fix must not believe');
  assert(neg.sentinelRuns >= 1, 'the unchanged executable assertion must actually execute against the negative candidate');
  assert(neg.row && !PR_ELIGIBLE_OUTCOMES.has(neg.row.outcome),
    `the negative control must not reach a verified-success outcome, got ${neg.row && neg.row.outcome}`);
  assert.strictEqual(neg.row.prUrl || null, null, 'the negative control must not obtain a PR url');
  assert.strictEqual(neg.prCalls, 0, `the refused negative control must make zero PR-creation calls, got ${neg.prCalls}`);

  // Positive control — verified, published, all four mode intentions preserved on the pushed tip.
  const pos = await conveyor('t5-pos', { scen: 'pos' });
  assert(!pos.threw, `the positive control threw: ${pos.threw && pos.threw.stack}`);
  assert.strictEqual(pos.filemode, 'false', 'the positive control workspace must also carry the reproduced premise');
  assert(pos.row && PR_ELIGIBLE_OUTCOMES.has(pos.row.outcome),
    `the positive control must reach a verified-success outcome, got ${pos.row && pos.row.outcome} (${pos.row && pos.row.error})`);
  assert(pos.prCalls >= 1, `the verified positive control must create a PR, got ${pos.prCalls} calls`);
  assert(pos.tip, 'the positive control must push its branch to the bare remote');
  const mode = (f) => treeMode(pos.world.root, pos.tip, f, pos.world.remote);
  assert.strictEqual(mode('bin/tool.sh'), '100755', 'the added executable must be published at 100755');
  assert.strictEqual(mode('plain.txt'), '100644', 'an ordinary file must be published at 100644');
  assert.strictEqual(mode('bin/keep.sh'), '100755', 'an untouched pre-existing executable must stay 100755');
  assert.strictEqual(mode('bin/drop.sh'), '100644', 'an explicitly removed executable must become 100644');
  // Docs ran in an ISOLATED DETACHED LINKED worktree (correction 6: not merely a directory-name
  // regex): detached HEAD, and a linked worktree whose git-dir differs from the common git-dir.
  assert(pos.docsId, `the docs model must record its worktree identity, got ${JSON.stringify(pos.docsId)}`);
  assert(/pipeline-docs\./.test(String(pos.docsId.cwd).replace(/\\/g, '/')),
    `the docs model must run in the disposable docs workspace, ran in: ${pos.docsId.cwd}`);
  assert.strictEqual(pos.docsId.detached, true, 'the docs worktree must be a DETACHED checkout');
  assert(pos.docsId.gitDir && pos.docsId.commonDir
    && path.resolve(pos.docsId.gitDir) !== path.resolve(pos.docsId.commonDir),
    `the docs worktree must be a LINKED worktree (git-dir != git-common-dir), got ${JSON.stringify(pos.docsId)}`);
  const readme = git(pos.world.root, '--git-dir', pos.world.remote, 'show', `${pos.tip}:README.md`).stdout || '';
  assert(/executable-mode workflow/.test(readme), 'the published tip must carry the docs Markdown edit');
  // correction 5: ONE SHARED ORDERED TRACE, not "count>=2 plus last readme=1". The sentinel records,
  // in append order, implementation verification (README not yet written -> readme=0), the isolated
  // docs write (a `docs <cwd>` line), then final verification observing the transferred README bytes
  // (readme=1). Prove that exact ordering — implementation-verify BEFORE the docs delta, final-verify
  // AFTER it and seeing it.
  const recs = pos.sentinelRecords;
  const firstImplVerify = recs.findIndex((l) => /^ran .* readme=0$/.test(l));
  const docsIdx = recs.findIndex((l) => /^docs /.test(l));
  const finalVerify = recs
    .map((l, i) => (/^ran .* readme=1$/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  assert(firstImplVerify >= 0,
    `implementation verification (before the README docs delta) must run first, trace: ${JSON.stringify(recs)}`);
  assert(docsIdx > firstImplVerify,
    `the isolated docs write must follow implementation verification, trace: ${JSON.stringify(recs)}`);
  assert(finalVerify !== undefined && finalVerify > docsIdx,
    `final verification observing the transferred README delta must run AFTER the docs write, trace: ${JSON.stringify(recs)}`);
  if (POSIX) {
    // Natively materialize THAT pushed commit and exercise all four mode intentions, not only
    // bin/tool.sh (correction 5): the added executable and the retained executable satisfy
    // `test -x`; the ordinary file and the explicitly de-executed file fail it.
    const nat = nativeExecutable(pos.world.root, pos.tip, 'bin/tool.sh', pos.world.remote);
    assert(nat.ok && nat.executable, `the published added executable must be natively executable: ${nat.why || 'not executable'}`);
    const keepNat = nativeExecutable(pos.world.root, pos.tip, 'bin/keep.sh', pos.world.remote);
    assert(keepNat.ok && keepNat.executable, `the retained pre-existing executable must stay natively executable: ${keepNat.why || 'not executable'}`);
    const plainNat = nativeExecutable(pos.world.root, pos.tip, 'plain.txt', pos.world.remote);
    assert(plainNat.ok && !plainNat.executable, 'an ordinary file must be non-executable in a native materialization');
    const dropNat = nativeExecutable(pos.world.root, pos.tip, 'bin/drop.sh', pos.world.remote);
    assert(dropNat.ok && !dropNat.executable, 'an explicitly de-executed file must be non-executable in a native materialization');
  } else {
    console.log('    (native POSIX `test -x`/`! -x` on the published commit skipped on win32 — exercised by the canonical Linux gate)');
  }
});

// ── T6 / C4 (stale CONTENT) ─────────────────────────────────────────────────────────────────
test('T6 C4 stale content evidence is refused: a candidate genuinely verifies pass (the unmutated equivalent actually publishes), then the external execution adapter changes bin/tool.sh CONTENT only immediately before returning to the host WITHOUT re-running the verifier — every mutation command succeeded, the passing evidence bytes and the verification-invocation counter are unchanged after the mutation, and the candidate blob really changed while its mode stayed 100755; the real host publication path must not report a verified-success outcome and must make ZERO PR-creation calls (RED today: the host trusts the stale verify.json, reports done and opens a PR)', async () => {
  // The unmutated equivalent must actually publish successfully (correction 3).
  const base = await conveyor('t6-base', { scen: 'stale', mutate: '' });
  assert(!base.threw, `the unmutated stale-base threw: ${base.threw && base.threw.stack}`);
  assert(base.row && PR_ELIGIBLE_OUTCOMES.has(base.row.outcome) && base.prCalls >= 1,
    `the unmutated equivalent must publish successfully, got outcome=${base.row && base.row.outcome} prCalls=${base.prCalls}`);

  const s = await conveyor('t6-stale-content', { scen: 'stale', mutate: 'content' });
  assert(!s.threw, `the stale-content case threw: ${s.threw && s.threw.stack}`);
  assert.strictEqual(s.mutStat, 'ok', 'every stale-content mutation command must have succeeded');
  // correction 5: the stale path must begin from a REAL successful verification, and verification
  // must actually have run — parse the captured pre-mutation evidence as pass and require a positive
  // verification-invocation count BEFORE asserting the counter did not move.
  let preParsed6 = null;
  try { preParsed6 = JSON.parse(s.preEvid || 'null'); } catch { preParsed6 = null; }
  assert(preParsed6 && preParsed6.acceptance === 'pass',
    `the pre-mutation evidence must be a real passing verification, got ${s.preEvid && s.preEvid.slice(0, 120)}`);
  assert(Number(s.preRuns) >= 1, `verification must actually have run before the mutation (count ${s.preRuns})`);
  assert(s.preBlob && s.postBlob && s.preBlob !== s.postBlob,
    `the content mutation must actually change the candidate blob, got ${s.preBlob} -> ${s.postBlob}`);
  assert.strictEqual(s.postTreeMode, '100755', 'the content mutation must leave the Git mode 100755');
  assert(s.preEvid && s.preEvid === s.postEvid, 'the passing evidence bytes must be unchanged by the mutation');
  assert(s.preRuns && s.preRuns === s.postRuns,
    `verification must NOT have re-run after the mutation (counter ${s.preRuns} -> ${s.postRuns})`);
  assert(s.row && !PR_ELIGIBLE_OUTCOMES.has(s.row.outcome),
    `stale content must block a verified-success outcome, got ${s.row && s.row.outcome}`);
  assert.strictEqual(s.row.prUrl || null, null, 'stale content must not obtain a PR url');
  assert.strictEqual(s.prCalls, 0, `stale content must make zero PR-creation calls, got ${s.prCalls}`);
});

// ── T7 / C4, C1 (stale MODE) ────────────────────────────────────────────────────────────────
test('T7 C4,C1 stale mode evidence is refused: a candidate genuinely verifies pass at Git mode 100755, then the external execution adapter changes only the Git MODE to 100644 immediately before returning to the host WITHOUT re-running the verifier — every mutation command succeeded, the passing evidence bytes and the verification-invocation counter are unchanged, and the candidate blob is identical while its mode changed 100755 -> 100644; the real host publication path must not report a verified-success outcome and must make ZERO PR-creation calls (RED today: the host trusts the stale verify.json, reports done and opens a PR)', async () => {
  const s = await conveyor('t7-stale-mode', { scen: 'stale', mutate: 'mode' });
  assert(!s.threw, `the stale-mode case threw: ${s.threw && s.threw.stack}`);
  assert.strictEqual(s.mutStat, 'ok', 'every stale-mode mutation command must have succeeded');
  // correction 5: begin from a REAL successful verification with a positive invocation count.
  let preParsed7 = null;
  try { preParsed7 = JSON.parse(s.preEvid || 'null'); } catch { preParsed7 = null; }
  assert(preParsed7 && preParsed7.acceptance === 'pass',
    `the pre-mutation evidence must be a real passing verification, got ${s.preEvid && s.preEvid.slice(0, 120)}`);
  assert(Number(s.preRuns) >= 1, `verification must actually have run before the mutation (count ${s.preRuns})`);
  assert(s.preBlob && s.postBlob && s.preBlob === s.postBlob,
    `the mode mutation must leave the candidate blob identical, got ${s.preBlob} -> ${s.postBlob}`);
  assert.strictEqual(s.preTreeMode, '100755', 'the candidate must have verified pass at mode 100755');
  assert.strictEqual(s.postTreeMode, '100644', 'the mode mutation must change the Git mode to 100644');
  assert(s.preEvid && s.preEvid === s.postEvid, 'the passing evidence bytes must be unchanged by the mutation');
  assert(s.preRuns && s.preRuns === s.postRuns,
    `verification must NOT have re-run after the mutation (counter ${s.preRuns} -> ${s.postRuns})`);
  // Where a branch is pushed (today, and where the fix keeps the evidence-preserving recovery
  // push), the mutation must have landed as Git mode 100644 on the tip. A fix that refuses BEFORE
  // pushing leaves no tip, which is also a refusal; so the tip-mode check is conditional and the
  // outcome/PR checks are the gate.
  if (s.tip) {
    assert.strictEqual(treeMode(s.world.root, s.tip, 'bin/tool.sh', s.world.remote), '100644',
      'the post-verification mutation must have changed the published Git mode to 100644');
  }
  assert(s.row && !PR_ELIGIBLE_OUTCOMES.has(s.row.outcome),
    `stale mode must block a verified-success outcome, got ${s.row && s.row.outcome}`);
  assert.strictEqual(s.row.prUrl || null, null, 'stale mode must not obtain a PR url');
  assert.strictEqual(s.prCalls, 0, `stale mode must make zero PR-creation calls, got ${s.prCalls}`);
});

// ── (materialization / verifier-operation-error moved to guard.js G10) ────────────────────────
// Per re-author correction 2, a scoped fault at an EXISTING production verifier operation is
// ALREADY handled at the fork point (the verifier's fail-closed try/catch on the frozen-config
// read), so it is PRESERVED behaviour — a guard, not a RED requirement — and lives in guard.js
// G10. The old T8 faulted `git archive`/`git checkout-index`, prescribing how a future materializer
// must be written; that RED requirement is withdrawn.

// ── T9 / C6 (canonical proof: prove-tests.runGate -> scripts/freeze-gate.js mode semantics) ────
// Correction 1: drive the exported production prove-tests.runGate, letting it invoke the real
// freeze-gate with its configured Linux-image arguments through the external Docker-command adapter
// (FREEZE_GATE_DOCKER_CMD), a MOUNT-ADDRESS TRANSLATOR only. Baseline and probe are GENUINELY
// DIFFERENT candidates with byte-identical suite/test files: the baseline stages bin/tool.sh at Git
// mode 100644 with an apparent workspace exec bit, the probe at explicit 100755 with the workspace
// bit absent. Under the fix, freeze-gate judges by the Git mode (materialized): the baseline suite
// is RED and the probe suite is GREEN, both controls green, so the verdict is `red` (exit 0). Today
// the gate judges the non-executable workspace bit, the probe fails too, and the verdict is
// `unreachable` (exit 3). POSIX-only — MSYS `test -x` cannot see the Git mode.
function buildGateTree(tag, root, { mode, worktreeExec, observer }) {
  const dir = path.join(root, tag);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec fixture');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh run-tests.sh', frozenPaths: [] }, null, 2)}\n`);
  // The project's acceptance runner: run each *.sh in the given directory FROM THE REPO ROOT, so
  // the control directory's trivially-passing test proves the harness works, while the suite's own
  // test is the discriminator (it checks the candidate's executable mode). Correction 4: it FAILS
  // on an empty test population — a runner that passes with zero tests would let the gate bless a
  // vacuous suite, the exact vacuous-success shape freeze-gate exists to catch.
  fs.writeFileSync(path.join(dir, 'run-tests.sh'),
    '#!/bin/sh\nd="$1"\nn=0\nfor f in "$d"*.sh; do [ -e "$f" ] || continue; n=$((n+1)); sh "$f" || exit 1; done\n'
    + '[ "$n" -gt 0 ] || { echo "no test files in $d" >&2; exit 1; }\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool.sh'), TOOL);
  // The conventional control the gate needs to prove the harness works: one trivially-passing test.
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', '_control', 'ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  // The suite's own discriminating test: the unchanged executable assertion, judged from the repo
  // root. The absolute observer is outside both candidates and identical in both suite copies.
  // Record the actual execution directory and native result, even when production runs the suite
  // in a separate materialization. Nothing has to copy evidence back into either source checkout.
  const observerArg = `'${posix(observer).replace(/'/g, `'"'"'`)}'`;
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, '01-exec.sh'),
    '#!/bin/sh\ntest -x bin/tool.sh\nrc=$?\n'
    + `printf '%s\\t%s\\n' "$(pwd -P)" "$rc" >> ${observerArg} || exit 2\nexit "$rc"\n`);
  git(dir, 'add', '-A');
  if (mode === '100755') git(dir, 'update-index', '--chmod=+x', '--', 'bin/tool.sh');
  git(dir, 'commit', '-qm', 'gate fixture');
  assert.strictEqual(treeMode(dir, 'HEAD', 'bin/tool.sh'), mode, `${tag} did not commit bin/tool.sh at ${mode}`);
  // Correction 4: assert the actual initial INDEX mode, not only the HEAD tree mode — the gate
  // materializes from the committed candidate, and a fixture whose index disagreed with HEAD would
  // measure something other than the pinned candidate.
  const idx = git(dir, 'ls-files', '--stage', '--', 'bin/tool.sh');
  const im = /^(\d{6}) /.exec((idx.stdout || '').trim());
  assert(im && im[1] === mode, `${tag} index mode for bin/tool.sh must be ${mode}, got ${im && im[1]}`);
  fs.chmodSync(path.join(dir, 'bin', 'tool.sh'), worktreeExec ? 0o755 : 0o644);
  const native = run('sh', ['-c', 'test -x bin/tool.sh'], { cwd: dir });
  assert.strictEqual(native.status, worktreeExec ? 0 : 1,
    `${tag} must start with native executable access ${worktreeExec ? 'present' : 'absent'}, got ${native.status}`);
  return dir;
}
test('T9 C6 the canonical proof (prove-tests.runGate -> scripts/freeze-gate.js) binds Git-authoritative modes: driven through runGate\'s own external Docker-command adapter (mount-address translation only), a byte-identical baseline staged at Git mode 100644 (with an apparent workspace exec bit) and a probe staged at explicit 100755 (workspace exec bit absent) are handed to the REAL freeze-gate; only once the gate judges the candidate by its Git mode (materialized) is the baseline RED and the probe GREEN on controls green in both, so the verdict is `red` (exit 0). Today the gate judges the apparent workspace bit, the baseline passes, and the verdict is `green` (exit 1). POSIX-only — skipped and reported on win32.\n// NOTE: the four component exits (baseline suite / control / probe suite / control) are NOT observed by a direct verifyCommand run, because a direct `test -x` reads the apparent workspace bit and a baseline "exit 1" exists only AFTER the gate materializes — which is the very fix under test and must not be reimplemented in the adapter. The real gate verdict through runGate is the discriminator; a mount-only adapter and the gate\'s own control-vs-suite logic prevent a fabricated or empty-runner pass (a broken harness returns indeterminate, never red).', () => {
  if (!POSIX) {
    console.log('    (freeze-gate mode discrimination skipped on win32 — MSYS `test -x` cannot see the Git mode; exercised by the canonical Linux gate)');
    return;
  }
  const root = mkTemp('t9');
  const observer = path.join(root, 'assertion-observations.tsv');
  const baseline = buildGateTree('baseline', root, { mode: '100644', worktreeExec: true, observer });
  const probe = buildGateTree('probe', root, { mode: '100755', worktreeExec: false, observer });
  // Assert the starting premise the gate will judge: identical suite bytes, different Git modes.
  assert.strictEqual(treeMode(baseline, 'HEAD', 'bin/tool.sh'), '100644', 'the baseline must be staged at 100644');
  assert.strictEqual(treeMode(probe, 'HEAD', 'bin/tool.sh'), '100755', 'the probe must be staged at 100755');
  assert(fs.readFileSync(path.join(baseline, 'tests', 'acceptance', ISSUE, '01-exec.sh'))
    .equals(fs.readFileSync(path.join(probe, 'tests', 'acceptance', ISSUE, '01-exec.sh'))),
  'the baseline and probe must execute byte-identical assertions');
  // Correction 4: the small runner must FAIL on an empty test population, so the gate's control
  // (one passing test) genuinely discriminates and cannot be satisfied by "no tests found".
  const emptyDir = mkTemp('t9-empty');
  const emptyRun = run('sh', ['-c', `sh run-tests.sh "${posix(emptyDir)}/"`], { cwd: baseline });
  assert.notStrictEqual(emptyRun.status, 0,
    `the acceptance runner must reject an empty test population, got exit ${emptyRun.status}`);

  // The external Docker-command adapter, a SINGLE executable. It translates production's
  // `docker run … -v <host>:/workspace … --entrypoint sh <image> -c "<script>" freeze-gate <dir>`
  // into `sh -c "<script>" freeze-gate <dir>` run in <host>, and answers the `rm -f` cleanup call.
  // Mount-address translation ONLY — no materialization, chmod, mode repair, verdict or policy.
  const adapter = path.join(root, 'docker-adapter.sh');
  const envObserver = path.join(root, 'child-environment.txt');
  const strippedKeys = ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_GH_CMD',
    'PIPELINE_AGENT_CMD', 'PIPELINE_MODEL', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'FREEZE_GATE_CMD'];
  const childKeys = [...strippedKeys, 'PIPELINE_TESTING_FREEZE_GATE_SEAM',
    'FREEZE_GATE_DOCKER_CMD', 'FREEZE_GATE_DOCKER_IMAGE'];
  // Observe variable presence in the actual adapter child without printing inherited values.
  const envObservation = `printf '${childKeys.map((k) => `${k}=[%s]`).join(' ')}\\n' `
    + childKeys.map((k) => `"\${${k}+present}"`).join(' ')
    + ` >> '${posix(envObserver).replace(/'/g, `'"'"'`)}' || exit 2`;
  fs.writeFileSync(adapter, [
    '#!/bin/sh',
    '[ "$1" = "rm" ] && exit 0',
    envObservation,
    'mount=""',
    'script=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -v) mount="${2%%:/workspace}"; shift 2 ;;',
    '    -c) script="$2"; shift 2; break ;;',       // remaining "$@" = freeze-gate <testDir>
    '    *) shift ;;',
    '  esac',
    'done',
    '[ -n "$mount" ] || exit 1',
    'cd "$mount" || exit 1',
    'exec sh -c "$script" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(adapter, 0o755);

  // Drive the exported production runGate. It spawns the real freeze-gate with --repo baseline
  // --tests suite --green probe and its configured image, keeping FREEZE_GATE_DOCKER_CMD because
  // the seam flag is set. The env changes are made on process.env (runGate reads it) and restored.
  const saved = {};
  const set = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { if (!(k in saved)) saved[k] = process.env[k]; delete process.env[k]; };
  // Poison observable inherited inputs first. In particular FREEZE_GATE_CMD would bypass the
  // real configured verifier and Docker adapter while the deliberate seam capability is enabled.
  set('FREEZE_GATE_CMD', 'exit 0');
  set('NODE_OPTIONS', '--no-warnings'); set('NODE_TEST_CONTEXT', 'poison-t9');
  set('GIT_CONFIG_COUNT', '1'); set('GIT_CONFIG_KEY_0', 'core.autocrlf'); set('GIT_CONFIG_VALUE_0', 'input');
  set('ANTHROPIC_API_KEY', 'poison-t9-key'); set('PIPELINE_AGENT_CMD', 'exit 0');
  // correction 6: runGate builds freeze-gate's environment from an EXPLICIT COPY of process.env, so
  // this suite's BASE_ENV never reaches it. Sanitize the inherited Git global/system config,
  // provider credentials, pipeline CLI seams and the Node loader/test seams ON process.env — the
  // actual boundary the child inherits — and restore every one in the finally below. Without this a
  // developer's global core.fileMode/autocrlf, a GIT_CONFIG_* redirection, or a parent
  // NODE_OPTIONS=--require preload would reach the real freeze-gate node process the gate spawns.
  set('GIT_CONFIG_GLOBAL', NULL_GITCONFIG); set('GIT_CONFIG_SYSTEM', NULL_GITCONFIG);
  set('GIT_CONFIG_NOSYSTEM', '1'); set('GIT_TERMINAL_PROMPT', '0');
  for (const k of strippedKeys) del(k);
  set('PIPELINE_TESTING_FREEZE_GATE_SEAM', '1');
  set('FREEZE_GATE_DOCKER_CMD', adapter);
  set('FREEZE_GATE_DOCKER_IMAGE', 'repo-3ec/fixture:local');
  let g;
  try {
    g = proveTests.runGate(
      { id: ISSUE, suiteId: ISSUE, cfg: { image: 'repo-3ec/fixture:local', wallClockMinutes: 60 } },
      { baseline, probe },
      run);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  assert.notStrictEqual(g.status, 2,
    `the gate must be able to run the fixture through the adapter (indeterminate=2 is a harness fault): ${((g.stdout || '') + (g.stderr || '')).slice(-500)}`);
  const childEnvs = fs.existsSync(envObserver) ? fs.readFileSync(envObserver, 'utf8').split('\n').filter(Boolean) : [];
  assert(childEnvs.length >= 1, 'the real freeze-gate must invoke the adapter child, not an inherited command override');
  const expectedEnv = childKeys.map((k) => `${k}=[]`).join(' ');
  assert(childEnvs.every((line) => line === expectedEnv),
    `the actual gate adapter child must receive no poisoned inputs or test seams: ${JSON.stringify(childEnvs)}`);
  // Correction 4: OBSERVE the four component exits the production gate PRINTS, not merely the final
  // code — the gate itself reports baseline-suite / control / probe-suite / probe-control, and only
  // suite=1, control=0, probe=0, probe-control=0 yields red. Reading them proves the red verdict
  // came from the mode discrimination and not from a broken control or an empty run coerced to 0.
  const out = String(g.stdout || '');
  assert(/\breal run\s+exit\s+1\b/.test(out),
    `the baseline suite must be observed RED (exit 1) in the gate's report: ${out.slice(-500)}`);
  assert(/\bcontrol run\s+exit\s+0\b/.test(out),
    `the fork-point control must be observed GREEN (exit 0): ${out.slice(-500)}`);
  assert(/\bprobe run\s+exit\s+0\b/.test(out),
    `the probe suite must be observed GREEN (exit 0): ${out.slice(-500)}`);
  assert(/\bprobe control\s+exit\s+0\b/.test(out),
    `the probe control must be observed GREEN (exit 0): ${out.slice(-500)}`);
  assert(/^RED:/m.test(out), `the gate's printed verdict must be RED: ${out.slice(-500)}`);
  assert.strictEqual(g.status, 0,
    `the canonical gate must judge the 100755 candidate by its Git mode and return red (0); got exit ${g.status}: ${(out + (g.stderr || '')).slice(-500)}`);
  // The printed component exits bind these native observations to the two genuine candidates.
  // Their directories are evidence, not a requirement about where production materializes them.
  const observations = fs.existsSync(observer) ? fs.readFileSync(observer, 'utf8').split('\n').filter(Boolean)
    .map((line) => { const [cwd, rc] = line.split('\t'); return { cwd, rc: Number(rc) }; }) : [];
  assert(observations.length >= 2 && observations.every((o) => path.isAbsolute(o.cwd) && [0, 1].includes(o.rc)),
    `both assertions must execute and report their actual directory/native result: ${JSON.stringify(observations)}`);
  assert(observations.some((o) => o.rc === 1), 'the baseline executable assertion must actually execute and fail');
  assert(observations.some((o) => o.rc === 0), 'the probe executable assertion must actually execute and pass');
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`ok - ${item.name}`); }
    catch (error) { failed = 1; console.log(`FAIL - ${item.name} — ${error && error.message ? error.message : error}`); }
  }
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  }
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
