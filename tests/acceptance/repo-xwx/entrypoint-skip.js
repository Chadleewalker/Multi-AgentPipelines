#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Frozen acceptance test — skip the final re-verification when the docs phase changed
// nothing (DESIGN.md §4.3; amends change-log row `repo-cl9`).
//
// Drives the REAL pipeline/entrypoint.sh, under `bash` exactly as runner/container.js
// launches it, and the REAL pipeline/verify.js against a throwaway git repository, with a
// stub agent standing in for both agent phases. Nothing here calls a model, Docker or the
// network.
//
// How the verifier is counted without touching it: PIPELINE_DIR points at a temp folder
// holding copies of the real status.js and envelope.js and a WRAPPER verify.js that
// appends the HEAD it ran on to a log, then hands over to the real verifier by absolute
// path. The folder holds only those files on purpose — the existing frozen tests that
// drive the entrypoint (repo-1cy, repo-52m, repo-wxh) build the same minimal folder, so
// an entrypoint that needed a new helper file under pipeline/ would break them.
//
// How "fail closed" is proven: a `git` shim first on PATH passes every call through to the
// real git, except that once a marker file exists it fails ONE call of the chosen
// subcommand (exit 128, no output) and deletes the marker. The docs stub creates the
// marker as its last act, so the failed call is the first one the skip decision makes.
//
// The child environment is built explicitly: an inherited RUN_DIR would redirect
// status.js, and an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would redirect git,
// into whatever outer task is running this test.
//
// Criteria served (see the planning draft's coverage table): C1, C2, C3, C4, C6a, C8.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ISSUE = 'T-skip';
const SKIP_PHRASE = 'final re-verification skipped';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-skip-reverify-'));
let failed = 0;
let count = 0;
let scenarioFailed = false;
function check(label, ok) {
  count += 1;
  if (ok) console.log(`ok - ${label}`);
  else { failed += 1; scenarioFailed = true; console.log(`FAIL - ${label}`); }
}
const show = (v) => JSON.stringify(v);
function shellPath(p) {
  const r = spawnSync('cygpath', ['-u', p], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : p.replace(/\\/g, '/');
}
// Test-side git never goes through the shim and never inherits a redirecting variable.
const CLEAN_ENV = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^GIT_/i.test(k) || /^PIPELINE_/i.test(k) || ['RUN_DIR', 'WORKSPACE', 'ISSUE_ID', 'NODE_OPTIONS', 'TASK_DIR'].includes(k.toUpperCase())) delete e[k];
  }
  return e;
})();
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const statusSchema = readJson(path.join(ROOT, 'schemas', 'status.schema.json')) || { properties: {} };
const SHA = /^[0-9a-f]{40}$/;

// ---- the seed repository every scenario clones -----------------------------------------
const seed = path.join(tmp, 'seed');
fs.mkdirSync(seed);
git(seed, 'init', '-q', '-b', 'main');
git(seed, 'config', 'user.email', 'test@example.invalid');
git(seed, 'config', 'user.name', 'test');
git(seed, 'config', 'core.autocrlf', 'false');
put(seed, 'pipeline.config.json', JSON.stringify({
  verifyCommand: 'sh tools/test.sh', defaultBranch: 'main',
  frozenPaths: ['tools/test.sh'], dependencies: {},
}, null, 2) + '\n');
put(seed, 'tools/test.sh', '#!/bin/sh\nfor f in "$1"*.sh; do sh "$f" || exit 1; done\n');
put(seed, `tests/acceptance/${ISSUE}/test.sh`, '#!/bin/sh\ngrep -q done out.txt || { echo "out.txt lacks done"; exit 1; }\n');
put(seed, 'README.md', '# fixture\n');
put(seed, 'docs/guide.md', 'guide\n');
git(seed, 'add', '-A');
git(seed, 'commit', '-qm', 'frozen baseline');
const FORK = git(seed, 'rev-parse', 'HEAD');

// ---- the git shim (its directory name contains "gitshim", which is how it removes
// itself from PATH before handing over to the real git) ---------------------------------
const shimDir = path.join(tmp, 'gitshim-bin');
fs.mkdirSync(shimDir);
fs.writeFileSync(path.join(shimDir, 'git'), [
  '#!/bin/sh',
  'if [ -n "$GIT_SHIM_MARKER" ] && [ -f "$GIT_SHIM_MARKER" ] && [ "$1" = "$GIT_SHIM_FAIL" ]; then',
  '  rm -f "$GIT_SHIM_MARKER"',
  '  echo "git shim: simulated failure of git $1" >&2',
  '  exit 128',
  'fi',
  "PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -v gitshim | paste -sd: -)",
  'export PATH',
  'exec git "$@"',
  '',
].join('\n'), { mode: 0o755 });

// ---- the stub agent: code phase writes out.txt; docs phase does what DOCS_MODE says ----
// The docs phase is recognised by its prompt ("Verification for task ... just passed").
// Several modes print a summary that LIES about what they did: the decision must come
// from the tree, never from the agent's own report (criterion C4).
// PLANT writes a plausible verifiedCommit (the current HEAD) straight into status.json,
// as an agent can: the entrypoint must not leave it standing on a path that records none.
const PLANT = 'node -e \'const f=".run/status.json";const fs=require("fs");const o=JSON.parse(fs.readFileSync(f,"utf8"));'
  + 'o.verifiedCommit=require("child_process").execSync("git rev-parse HEAD",{encoding:"utf8"}).trim();fs.writeFileSync(f,JSON.stringify(o,null,2))\'';
const agent = path.join(tmp, 'agent.sh');
fs.writeFileSync(agent, [
  '#!/bin/sh',
  'PROMPT=$(cat)',
  'case "$PROMPT" in',
  '  *"Verification for task"*)',
  '    case "$DOCS_MODE" in',
  '      none)        echo "Created out.txt with the done marker." ;;',
  '      liar)        echo "Updated README.md and docs/guide.md to describe the change." ;;',
  '      revert)      echo "extra" >> README.md; git checkout -q -- README.md; echo "No change." ;;',
  '      fail-clean)  echo "docs agent crashed" >&2; exit 1 ;;',
  '      edit-quiet)  echo "docs line" >> README.md; echo "No files were changed." ;;',
  '      new-file)    echo "new page" > docs/new.md; echo "No files were changed." ;;',
  '      delete)      rm -f docs/guide.md; echo "No files were changed." ;;',
  '      self-commit) echo "docs line" >> README.md; git add README.md; git commit -qm "agent docs commit"; echo "Summary." ;;',
  '      empty-commit) git commit -q --allow-empty -m "agent empty commit"; echo "Summary." ;;',
  '      fail-dirty)  echo "docs line" >> README.md; echo "docs agent crashed" >&2; exit 1 ;;',
  '      fail-untracked) echo "new page" > docs/new.md; echo "docs agent crashed" >&2; exit 1 ;;',
  '      fail-staged) echo "docs line" >> README.md; git add README.md; echo "docs agent crashed" >&2; exit 1 ;;',
  `      plant-dirty) ${PLANT}; echo "docs line" >> README.md; exit 1 ;;`,
  `      plant-break) ${PLANT}; rm -f out.txt; echo "Summary." ;;`,
  '      break)       rm -f out.txt; echo "Summary." ;;',
  `      tamper)      echo "exit 0" > tests/acceptance/${ISSUE}/test.sh; echo "Summary." ;;`,
  '      git-fails)   echo "No change."; : > "$GIT_SHIM_MARKER" ;;',
  '      *)           echo "unknown DOCS_MODE" >&2; exit 2 ;;',
  '    esac ;;',
  '  *"attempt 1 of"*)',
  '    if [ "$CODE_MODE" = late ]; then echo "not yet" > out.txt; else echo done > out.txt; fi ;;',
  '  *) echo done > out.txt ;;',
  'esac',
  '',
].join('\n'));

// ---- run one scenario --------------------------------------------------------------------
function scenario(name, docsMode, { codeMode = '', shimFail = '' } = {}) {
  scenarioFailed = false;
  const base = path.join(tmp, name);
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  const pipe = path.join(base, 'pipe');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pipe, { recursive: true });
  spawnSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', seed, ws], { encoding: 'utf8', env: CLEAN_ENV });
  git(ws, 'config', 'user.email', 'test@example.invalid');
  git(ws, 'config', 'user.name', 'test');
  git(ws, 'checkout', '-qb', `task/${ISSUE}`);
  put(ws, '.run/issue.md', `# ${ISSUE}\n\n## Description\nCreate out.txt containing the word done.\n`);

  for (const f of ['status.js', 'envelope.js']) {
    fs.copyFileSync(path.join(ROOT, 'pipeline', f), path.join(pipe, f));
  }
  const verifyLog = path.join(base, 'verify-calls.log');
  fs.writeFileSync(verifyLog, '');
  fs.writeFileSync(path.join(pipe, 'verify.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    "const h = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
    `fs.appendFileSync(${JSON.stringify(verifyLog)}, ((h.stdout || '').trim() || 'NO-HEAD') + '\\n');`,
    `require(${JSON.stringify(path.join(ROOT, 'pipeline', 'verify.js'))});`,
    '',
  ].join('\n'));

  const marker = path.join(base, 'git-shim.marker');
  // Windows spells it Path, Linux PATH; pass exactly one key so the child cannot pick the other.
  const pathKey = Object.keys(CLEAN_ENV).find((k) => k.toUpperCase() === 'PATH');
  const basePath = pathKey ? CLEAN_ENV[pathKey] : '';
  const childEnv = { ...CLEAN_ENV };
  for (const k of Object.keys(childEnv)) if (k.toUpperCase() === 'PATH') delete childEnv[k];
  const r = spawnSync('bash', [shellPath(path.join(ROOT, 'pipeline', 'entrypoint.sh'))], {
    cwd: ws, encoding: 'utf8', timeout: 300000,
    env: {
      ...childEnv,
      PATH: shimFail ? `${shimDir}${path.delimiter}${basePath}` : basePath,
      HOME: shellPath(home), WORKSPACE: shellPath(ws), PIPELINE_DIR: shellPath(pipe),
      PIPELINE_AGENT_CMD: `sh ${shellPath(agent)}`, ISSUE_ID: ISSUE,
      PIPELINE_FORK_POINT: FORK, PIPELINE_MAX_ATTEMPTS: '3',
      DOCS_MODE: docsMode, CODE_MODE: codeMode,
      GIT_SHIM_MARKER: shimFail ? shellPath(marker) : '', GIT_SHIM_FAIL: shimFail,
    },
  });
  const status = readJson(path.join(ws, '.run', 'status.json')) || {};
  const verifies = fs.readFileSync(verifyLog, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  let head = '';
  try { head = git(ws, 'rev-parse', 'HEAD'); } catch { head = ''; }
  let headSubject = '';
  try { headSubject = git(ws, 'log', '-1', '--format=%s'); } catch { headSubject = ''; }
  let porcelain = '';
  try { porcelain = git(ws, 'status', '--porcelain'); } catch { porcelain = 'ERR'; }
  return { name, rc: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}`, status, verifies, head, headSubject,
    porcelain, markerLeft: fs.existsSync(marker) };
}

// Print what the entrypoint said whenever a scenario fails, so a failure carries its cause.
function explain(s) {
  if (!scenarioFailed) return;
  console.log(`--- ${s.name}: entrypoint output (rc ${s.rc}) ---`);
  console.log(s.out.split('\n').slice(-40).join('\n'));
  console.log(`--- ${s.name}: status.json ---\n${show(s.status)}`);
}

// Status keys must stay inside status.schema.json (additionalProperties: false), and the
// two new keys must satisfy it — the host suite's ajv check is not available in here.
function schemaChecks(s) {
  const props = statusSchema.properties || {};
  const extra = Object.keys(s.status).filter((k) => !(k in props));
  check(`${s.name}: every status.json key is declared in status.schema.json (extra: ${show(extra)})`, extra.length === 0);
  const fv = props.finalVerification || {};
  if ('finalVerification' in s.status) {
    check(`${s.name}: finalVerification is one of the schema's values`,
      Array.isArray(fv.enum) && fv.enum.includes(s.status.finalVerification));
  }
  const vc = props.verifiedCommit || {};
  if ('verifiedCommit' in s.status) {
    check(`${s.name}: verifiedCommit satisfies the schema pattern`,
      typeof vc.pattern === 'string' && new RegExp(vc.pattern).test(s.status.verifiedCommit));
  }
}

// ---- C1 / C3 / C4: the tree is unchanged -> exactly one verification, outcome is its pass ----
function expectSkipped(s, { attempts = ['pass'], docsError = false } = {}) {
  const verifyRuns = attempts.length;
  check(`${s.name}: exit 0 (got ${s.rc})`, s.rc === 0);
  check(`${s.name}: the verifier ran ${verifyRuns} time(s), no final re-verification (got ${s.verifies.length})`,
    s.verifies.length === verifyRuns);
  check(`${s.name}: attempts are ${show(attempts)} (got ${show((s.status.attempts || []).map((a) => a.verifierResult))})`,
    show((s.status.attempts || []).map((a) => a.verifierResult)) === show(attempts));
  check(`${s.name}: status.json finalVerification is "skipped-unchanged" (got ${show(s.status.finalVerification)})`,
    s.status.finalVerification === 'skipped-unchanged');
  check(`${s.name}: the entrypoint's output says "${SKIP_PHRASE}"`, s.out.includes(SKIP_PHRASE));
  check(`${s.name}: verifiedCommit is a full sha equal to the branch head (got ${show(s.status.verifiedCommit)}, head ${s.head})`,
    SHA.test(String(s.status.verifiedCommit)) && s.status.verifiedCommit === s.head);
  check(`${s.name}: that head is the commit made straight after the passing verification (subject ${show(s.headSubject)})`,
    new RegExp(`^Task ${ISSUE}: implementation \\(verified on attempt ${verifyRuns}\\)$`).test(s.headSubject));
  check(`${s.name}: working tree clean at exit (got ${show(s.porcelain)})`, s.porcelain === '');
  if (docsError) {
    check(`${s.name}: docsPhaseError recorded, success stands`, typeof s.status.docsPhaseError === 'string' && s.status.docsPhaseError.length > 0);
  }
  schemaChecks(s);
  explain(s);
}

// ---- C2 / C3 / C4 / C8: anything changed (or could not be proven unchanged) ->
// the final re-verification runs, as today ----
function expectReverified(s, { rc, verifiedCommit }) {
  check(`${s.name}: exit ${rc} (got ${s.rc})`, s.rc === rc);
  check(`${s.name}: the final re-verification ran — verifier called twice (got ${s.verifies.length})`, s.verifies.length === 2);
  check(`${s.name}: status.json finalVerification is "ran" (got ${show(s.status.finalVerification)})`,
    s.status.finalVerification === 'ran');
  check(`${s.name}: the entrypoint's output does not claim a skip`, !s.out.includes(SKIP_PHRASE));
  if (verifiedCommit === 'head') {
    check(`${s.name}: verifiedCommit equals the commit the final verification ran on (got ${show(s.status.verifiedCommit)}, ran on ${show(s.verifies[1])})`,
      SHA.test(String(s.status.verifiedCommit)) && s.status.verifiedCommit === s.verifies[1]);
    check(`${s.name}: ...which is the branch head`, s.status.verifiedCommit === s.head);
  } else {
    check(`${s.name}: no verifiedCommit recorded (got ${show(s.status.verifiedCommit)})`, !('verifiedCommit' in s.status));
  }
  schemaChecks(s);
  explain(s);
}

try {
  // C6a: the status schema itself, probed with fixed strings (never only with the values
  // the implementation produced, which would measure the schema against itself).
  const sp = statusSchema.properties || {};
  const vcPat = sp.verifiedCommit && typeof sp.verifiedCommit.pattern === 'string' ? new RegExp(sp.verifiedCommit.pattern) : null;
  check('status.schema.json: verifiedCommit accepts a 40-hex sha and rejects 39 hex, uppercase and "HEAD"',
    Boolean(vcPat) && vcPat.test('a'.repeat(40)) && !vcPat.test('a'.repeat(39)) && !vcPat.test('A'.repeat(40)) && !vcPat.test('HEAD'));
  const fvEnum = sp.finalVerification && Array.isArray(sp.finalVerification.enum) ? sp.finalVerification.enum : null;
  check(`status.schema.json: finalVerification is exactly ["skipped-unchanged","ran"] (got ${show(fvEnum)})`,
    Boolean(fvEnum) && fvEnum.length === 2 && fvEnum.includes('skipped-unchanged') && fvEnum.includes('ran'));

  // C1: nothing changed.
  expectSkipped(scenario('unchanged', 'none'));
  // C4: the agent CLAIMS it edited docs but changed nothing -> still skipped.
  expectSkipped(scenario('claims-change', 'liar'));
  // C1: edited and restored byte for byte -> the tree is the certified tree.
  expectSkipped(scenario('edit-reverted', 'revert'));
  // C3: a failed docs phase that left the tree unchanged -> no re-verification, success stands.
  expectSkipped(scenario('docs-fail-clean', 'fail-clean'), { docsError: true });
  // C1: the passing verification is the second attempt's, not the first's.
  expectSkipped(scenario('pass-on-attempt-2', 'none', { codeMode: 'late' }), { attempts: ['fail', 'pass'] });

  // C2 + C4: a tracked file changed while the agent says nothing changed.
  expectReverified(scenario('edit-claims-none', 'edit-quiet'), { rc: 0, verifiedCommit: 'head' });
  // C2: a new file.
  expectReverified(scenario('new-file', 'new-file'), { rc: 0, verifiedCommit: 'head' });
  // C2: a deleted file.
  expectReverified(scenario('deleted-file', 'delete'), { rc: 0, verifiedCommit: 'head' });
  // C2: the agent committed its own change.
  expectReverified(scenario('agent-commit', 'self-commit'), { rc: 0, verifiedCommit: 'head' });
  // C2: the agent moved HEAD with a commit that changes no file.
  expectReverified(scenario('empty-commit', 'empty-commit'), { rc: 0, verifiedCommit: 'head' });
  // C2 + C3: the docs phase FAILED, so the entrypoint commits nothing and HEAD does not
  // move: only the working-copy check can see these. An unstaged edit, an untracked new
  // file, and a staged-but-uncommitted edit each re-verify. The final verification ran on
  // uncommitted files, so no commit can be named for it.
  for (const [name, mode] of [['docs-fail-dirty', 'fail-dirty'], ['docs-fail-untracked', 'fail-untracked'], ['docs-fail-staged', 'fail-staged']]) {
    const s = scenario(name, mode);
    expectReverified(s, { rc: 0, verifiedCommit: 'none' });
    check(`${name}: docsPhaseError recorded, success stands`, typeof s.status.docsPhaseError === 'string');
  }
  // C2: today's failing outcomes are unchanged.
  const broke = scenario('docs-broke-tests', 'break');
  expectReverified(broke, { rc: 30, verifiedCommit: 'none' });
  check('docs-broke-tests: the revoked pass is recorded in docsPhaseError', typeof broke.status.docsPhaseError === 'string');
  expectReverified(scenario('docs-tampered', 'tamper'), { rc: 11, verifiedCommit: 'none' });
  // C6a: a verifiedCommit the agent planted in status.json does not survive a path that
  // records none.
  expectReverified(scenario('planted-then-dirty', 'plant-dirty'), { rc: 0, verifiedCommit: 'none' });
  expectReverified(scenario('planted-then-broke', 'plant-break'), { rc: 30, verifiedCommit: 'none' });

  // C8: fail closed. Nothing changed, but the decision's first `git status` (or first
  // `git rev-parse`) fails with no output. That must re-verify, never read as unchanged.
  for (const sub of ['status', 'rev-parse']) {
    const s = scenario(`git-${sub}-fails`, 'git-fails', { shimFail: sub });
    check(`git-${sub}-fails: the shim's failure was actually consumed by the run (marker gone)`, !s.markerLeft);
    expectReverified(s, { rc: 0, verifiedCommit: 'head' });
  }
} catch (e) {
  check(`harness ran without throwing (${e && e.message})`, false);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
