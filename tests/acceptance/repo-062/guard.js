// Frozen acceptance test — repo-062, the [guard] half: the behaviour the "preserve kickoff
// constraints and enforce explicit no-documentation scope" change must NOT alter.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the scope feature (see test.js) has to PRESERVE while it adds one documentation
// exception and one publication check: the existing issue export shape for a normal issue (C6);
// the host PR body's existing Spec/Change-summary/Verification sections and its real
// documentation-FAILURE warning, which the intentional-omission note must not impersonate (C6);
// normal publication of a verified product change with no scope — pushed and a PR opened — so the
// new Markdown-surface check cannot regress it (C6, C3); the unrestricted docs phase still running
// the docs model to completion IN AN ISOLATED, DETACHED, LINKED WORKTREE and transferring an
// allowed Markdown delta to the final candidate through real verification (C6); the existing
// root/docs Markdown surface the publication check reuses — proven through the REAL docs-boundary
// behaviour (root and docs/ Markdown accepted, src/README.md excluded), not a copied predicate or
// a source-shape regex (C2); the existing serialization identity metadata (kickoffHash, specHash,
// external ref) an unrestricted task still produces (C1); and the existing kickoff fail-closed on
// tampered intake intent plus the untouched status/verifier schemas (C3, C6). Nothing red belongs
// here — a [guard] file red at the fork point refuses the freeze.
//
// LOCAL-EXECUTION HONESTY: G4's isolated-worktree observation uses a delegating `git` observer and
// the real entrypoint, authored for the canonical Linux gate. Where a native command observation
// cannot run on the Windows reference host it is reported and deferred to that gate rather than
// weakened; the authoritative green side is the Linux gate.
//
// SELF-CONTAINED: Node built-ins, a real local Git repo per case, and a stateful external `bd`
// CLI adapter. No provider key, no real Beads binary or host Beads database, no network, no
// container engine. Durable state is re-aimed into a temp tree via PIPELINE_STATE_DIR.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const specify = require(path.join(ROOT, 'scripts', 'specify-proposal.js'));
const kickoffApi = require(path.join(ROOT, 'scripts', 'kickoff.js'));
const queue = require(path.join(ROOT, 'runner', 'queue.js'));
const publishMod = require(path.join(ROOT, 'runner', 'publish.js'));

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_DOCS_SCOPE', 'NODE_OPTIONS',
  'BD_STORE', 'BD_CALLS', 'GIT_OBS_LOG', 'GIT_OBS_REALPATH']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

const hashOf = (intent) => `sha256:${crypto.createHash('sha256').update(Buffer.from(intent, 'utf8')).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const onLinux = process.platform !== 'win32';

// ── the narrow, delegating external-command observer (same shape as test.js) ─────────────────
// A `git` shim first on PATH: it counts `worktree add` and `push` and delegates every invocation
// unchanged to the real git resolved from the PATH with the shim removed. Used by G4 to observe
// that the unrestricted docs phase DOES create its isolated worktree (the allowed control that
// makes test.js's "zero worktree-add" observations non-vacuous).
function makeGitObserver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-gitobs-'));
  temps.push(dir);
  const logFile = path.join(dir, 'git-commands.log');
  fs.writeFileSync(logFile, '');
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    '# delegating git observer: count two verbs, pass everything through unchanged',
    'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then printf "worktree-add\\n" >> "$GIT_OBS_LOG"; fi',
    'if [ "$1" = "push" ]; then printf "push\\n" >> "$GIT_OBS_LOG"; fi',
    'PATH="$GIT_OBS_REALPATH" exec git "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return { dir, logFile };
}
function installGitObserver() {
  const obs = makeGitObserver();
  const saved = {
    PATH: process.env.PATH, GIT_OBS_LOG: process.env.GIT_OBS_LOG, GIT_OBS_REALPATH: process.env.GIT_OBS_REALPATH,
  };
  process.env.GIT_OBS_LOG = obs.logFile;
  process.env.GIT_OBS_REALPATH = saved.PATH;
  process.env.PATH = `${obs.dir}${path.delimiter}${saved.PATH}`;
  return {
    counts() {
      const t = fs.readFileSync(obs.logFile, 'utf8');
      return {
        worktreeAdd: (t.match(/^worktree-add$/gm) || []).length,
        push: (t.match(/^push$/gm) || []).length,
        raw: t,
      };
    },
    restore() {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    },
  };
}

// The same correctly-keyed stateful bd CLI adapter test.js uses.
const BD_STUB = String.raw`
'use strict';
const _b = String(process.argv[1] || '').replace(/\\/g, '/').split('/').pop();
if (/\.js$/i.test(_b)) { /* another node child: stand aside */ } else {
  const fs = require('fs');
  const crypto = require('crypto');
  const store = process.env.BD_STORE;
  const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return { records: [] }; } };
  const save = (d) => fs.writeFileSync(store, JSON.stringify(d));
  const args = process.argv.slice(1);
  const verb = _b;
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const emit = (o) => { fs.writeSync(1, JSON.stringify(o)); };
  if (verb === 'create') {
    const d = load();
    let meta = {}; try { meta = JSON.parse(val('--metadata') || '{}'); } catch { meta = {}; }
    const extRef = val('--external-ref');
    const id = process.env.BD_FORCE_ID || ('bd-' + crypto.createHash('sha256').update(String(extRef)).digest('hex').slice(0, 12));
    const rec = { id, title: args[1], description: val('-d'), acceptance_criteria: val('--acceptance'),
      design: val('--design'), priority: Number(val('--priority')), external_ref: extRef, metadata: meta, status: 'open' };
    d.records.push(rec); save(d); emit(rec); process.exit(0);
  }
  if (verb === 'search') { const d = load(); const ref = val('--external-contains'); emit(d.records.filter((r) => !ref || r.external_ref === ref)); process.exit(0); }
  if (verb === 'show') { const d = load(); const id = args[1]; emit(d.records.filter((r) => r.id === id)); process.exit(0); }
  emit([]); process.exit(0);
}
`;

async function withBd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-bd-'));
  temps.push(dir);
  const stub = path.join(dir, 'bd-stub.js');
  const store = path.join(dir, 'store.json');
  fs.writeFileSync(stub, BD_STUB);
  fs.writeFileSync(store, JSON.stringify({ records: [] }));
  const saved = { PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD, NODE_OPTIONS: process.env.NODE_OPTIONS, BD_STORE: process.env.BD_STORE };
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  process.env.BD_STORE = store;
  try { return await fn({ store, dir }); }
  finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const readStore = (store) => JSON.parse(fs.readFileSync(store, 'utf8'));

function writeKickoff(targetRepoPath, tag, arrays = {}) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = { version: 'kickoff-intake/1', title: `repo-062 guard ${tag}`, description: 'fix',
    constraints: arrays.constraints || [], examples: arrays.examples || [], nonGoals: arrays.nonGoals || [],
    priority: 2, relations: [], origin: null };
  const intent = JSON.stringify(intentObj);
  const record = { version: 'kickoff-intake/1', id, target: paths.target, hash: hashOf(intent), intent, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { id, hash: record.hash, intent };
}

function makeWorld(tag, arrays = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repo062g-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-062 guard');
  git(target, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'DESIGN.md'), '# Architecture\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'seed');
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git', image: 'x:local', codexAuth: 'chatgpt', gitTimeoutMs: 120000, bdTimeoutMs: 30000, wallClockMinutes: 2 }, null, 2)}\n`);
  const k = writeKickoff(target, tag, arrays);
  return { root, target, configPath, proposalId: k.id, kickoffHash: k.hash };
}

// ── G1 / C6 [guard] ───────────────────────────────────────────────────────────────────────────
test('G1 C6 [guard] exportIssue still renders the existing issue markdown for a normal issue: a legacy record with no new scope metadata exports ok with the title, description, acceptance criteria and design reference in place', async () => {
  await withBd(({ store }) => {
    const cfg = { targetRepoPath: fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-exp-')), bdTimeoutMs: 30000 };
    const d = readStore(store);
    d.records.push({ id: 'bd-legacy', title: 'a normal task', description: 'the body text',
      acceptance_criteria: 'it works', design: 'design-ref: DESIGN.md#architecture', priority: 2,
      external_ref: 'kickoff-spec:x', metadata: {}, status: 'open' });
    fs.writeFileSync(store, JSON.stringify(d));
    const out = queue.exportIssue(cfg, 'bd-legacy');
    assert(out && out.ok === true, `a normal issue did not export: ${JSON.stringify(out)}`);
    for (const needle of ['a normal task', 'the body text', 'it works', 'DESIGN.md#architecture']) {
      assert(out.markdown.includes(needle), `export markdown lost "${needle}"`);
    }
  });
});

// ── G2 / C6 [guard] ───────────────────────────────────────────────────────────────────────────
test('G2 C6 [guard] the host PR body keeps its existing sections and its real documentation-FAILURE warning: with no scope, a normal task renders Spec, Change summary and Verification evidence, and a docsPhaseError still renders the "Documentation phase warning" that the intentional-omission note must never impersonate', () => {
  const normal = publishMod.buildPrBody({ issueMarkdown: '# t: task', status: { changeSummary: 'did the work', attempts: [{ number: 1, verifierResult: 'pass' }] },
    verify: { acceptance: 'pass', regressions: 'pass' }, outcome: { status: 'done' }, branch: 'task/t', runId: 'run-1' });
  for (const section of ['## Spec', '## Change summary', '## Verification evidence']) {
    assert(normal.includes(section), `the PR body lost its ${section} section`);
  }
  const failed = publishMod.buildPrBody({ issueMarkdown: '# t: task',
    status: { changeSummary: 'did the work', docsPhaseError: 'docs agent failed (see docs-out.txt)', attempts: [{ number: 1, verifierResult: 'pass' }] },
    verify: { acceptance: 'pass', regressions: 'pass' }, outcome: { status: 'done' }, branch: 'task/t', runId: 'run-1' });
  assert(/Documentation phase warning/i.test(failed), 'the real documentation-failure warning was lost');
});

// ── G3 / C6,C3 [guard] ────────────────────────────────────────────────────────────────────────
test('G3 C6,C3 [guard] normal publication of a verified product change with no scope still pushes the branch and opens a PR, so the new Markdown-surface check cannot regress the unrestricted path', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-pub-'));
  temps.push(base);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const dir = path.join(base, 'ws');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-062 guard');
  fs.writeFileSync(path.join(dir, 'src.js'), 'code\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fork');
  const forkPoint = String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-q', '-b', 'task/g3');
  fs.appendFileSync(path.join(dir, 'src.js'), 'feature\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'product change');
  const ws = { dir, forkPoint, branch: 'task/g3', defaultBranch: 'main', regressionPolicy: null, memoryCount: 0 };
  const ghCalls = path.join(base, 'gh.txt');
  fs.writeFileSync(ghCalls, '');
  const saved = process.env.PIPELINE_GH_CMD;
  process.env.PIPELINE_GH_CMD = `printf called >> ${ghCalls.split(path.sep).join('/')}; printf 'https://example.test/pr/1\\n'`;
  try {
    const out = publishMod.publish({ targetRepoPath: base, gitTimeoutMs: 60000, defaultBranch: 'main' }, {
      ws, outcome: { status: 'done' }, hasCommits: true, issueMarkdown: '# g3', status: { changeSummary: 's' },
      verify: { acceptance: 'pass', regressions: 'pass' }, issue: { id: 'bd-g3', title: 'g3' }, runId: 'run-1', secrets: ['tok'],
    }, { info() {}, error() {}, event() {} }, 'tr');
    assert(out && out.ok === true && out.pushed === true && out.prUrl, `normal publication regressed: ${JSON.stringify(out)}`);
    assert(/called/.test(fs.readFileSync(ghCalls, 'utf8')), 'no PR was opened on the normal path');
  } finally { if (saved === undefined) delete process.env.PIPELINE_GH_CMD; else process.env.PIPELINE_GH_CMD = saved; }
});

// ── the nested entrypoint fixture (real pipeline dir), real verifier/status writers ─────────────
// The acceptance suite committed at the fork point passes iff feature.txt exists, and — when
// TRACE_FILE is set — appends one record per verifier invocation naming whether feature.txt and
// README.md are present. That trace is how G4 proves the ORDER: implementation verification sees
// no docs bytes, final verification (after the isolated docs delta transfers) sees them.
function installTaskRepo(base, issueId) {
  const task = path.join(base, 'task');
  fs.mkdirSync(path.join(task, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'run-acceptance.sh'), path.join(task, 'tools', 'run-acceptance.sh'));
  fs.writeFileSync(path.join(task, 'pipeline.config.json'), `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.mkdirSync(path.join(task, 'tests', 'acceptance', issueId), { recursive: true });
  fs.writeFileSync(path.join(task, 'tests', 'acceptance', issueId, 'test.js'),
    "'use strict';const fs=require('fs');const p=require('path');\n"
    + "const ws=process.env.WORKSPACE||process.cwd();\n"
    + "const feat=fs.existsSync(p.join(ws,'feature.txt'));\n"
    + "const rp=p.join(ws,'README.md');\n"
    + "const readme=fs.existsSync(rp)?fs.readFileSync(rp,'utf8'):'';\n"
    + "if(process.env.TRACE_FILE){try{fs.appendFileSync(process.env.TRACE_FILE,JSON.stringify({feat,readme})+'\\n');}catch(e){}}\n"
    + "if(feat){console.log('ok - feature present');process.exit(0);}\n"
    + "console.log('FAIL - feature.txt missing');process.exit(1);\n");
  fs.writeFileSync(path.join(task, '.gitignore'), '.run/\n');
  fs.mkdirSync(path.join(task, '.run'), { recursive: true });
  fs.writeFileSync(path.join(task, '.run', 'issue.md'), `# ${issueId}: guard task\n`);
  git(task, 'init', '-q', '-b', 'main');
  git(task, 'config', 'user.email', 'fixture@example.invalid');
  git(task, 'config', 'user.name', 'repo-062 guard');
  git(task, 'config', 'core.autocrlf', 'false');
  git(task, 'add', '-A');
  git(task, 'commit', '-qm', 'base');
  git(task, 'checkout', '-q', '-b', `task/${issueId}`);
  return task;
}

// The implementation branch always writes feature.txt; the docs branch runs the supplied JS body
// (which writes documentation files, and may record an isolation probe) before emitting a summary.
function writeAgent(file, callsLog, docsBody) {
  fs.writeFileSync(file,
    "'use strict';const fs=require('fs');const cp=require('child_process');const p=require('path');\n"
    + "const prompt=fs.readFileSync(0,'utf8');const docs=prompt.includes('Verification for task');\n"
    + `fs.appendFileSync(${JSON.stringify(callsLog)}, (docs?'docs':'impl')+'\\n');\n`
    + "const emit=(t)=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:t}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');};\n"
    + "if(!docs){fs.writeFileSync('feature.txt','verified\\n');emit('Implemented the change.');process.exit(0);}\n"
    + `${docsBody}\n`
    + "emit('Documented the change.');process.exit(0);\n");
}

function runGuardEntrypoint(base, issueId, docsBody, extraEnv = {}) {
  const task = installTaskRepo(base, issueId);
  const agent = path.join(base, 'agent.js');
  const calls = path.join(base, 'calls.txt');
  fs.writeFileSync(calls, '');
  writeAgent(agent, calls, docsBody);
  const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const env = { ...process.env, WORKSPACE: task, ISSUE_ID: issueId, PIPELINE_DIR: path.join(ROOT, 'pipeline'),
    PIPELINE_PROVIDER: 'codex', PIPELINE_AGENT_CMD: `${quote(process.execPath)} ${quote(agent)}`,
    PIPELINE_TESTING_NESTED_ENTRYPOINT: '1', PIPELINE_MAX_ATTEMPTS: '1', GIT_CONFIG_COUNT: '0',
    PIPELINE_DOCS_USER: '', ...extraEnv };
  delete env.NODE_OPTIONS; delete env.PIPELINE_DOCS_SCOPE;
  const result = run(SHELL, [path.join(ROOT, 'pipeline', 'entrypoint.sh')], { cwd: task, env, timeout: 120000 });
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  return {
    task, result,
    status: readJson(path.join(task, '.run', 'status.json')),
    verify: readJson(path.join(task, '.run', 'verify.json')),
    calls: fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean),
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

// ── G4 / C6 [guard] ───────────────────────────────────────────────────────────────────────────
test('G4 C6 [guard] an unrestricted task (no scope imposed) still runs the documentation model to completion through the real entrypoint: the docs model is invoked in an ISOLATED, DETACHED, LINKED worktree at the verified implementation commit (a real git worktree-add COMMAND is observed), an allowed README delta is written there and TRANSFERRED to the final candidate, and the ordered trace shows implementation verification seeing no docs bytes then final verification seeing them — verified, with real status/verify artifacts and no docsPhaseError', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-ep-'));
  temps.push(base);
  const issueId = 'repo-062gep';
  const probe = path.join(base, 'docs-probe.json');
  const trace = path.join(base, 'verify-trace.txt');
  const docsBody = "fs.writeFileSync('README.md','docs delta bytes\\n');"
    + `try{const head=cp.execSync('git rev-parse HEAD',{encoding:'utf8'}).trim();`
    + `const st=fs.statSync(p.join(process.cwd(),'.git'));`
    + `fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({cwd:process.cwd(),head,gitIsFile:st.isFile()}));}`
    + `catch(e){fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({error:String(e&&e.message||e)}));}`;

  const obs = installGitObserver();
  let fx;
  try {
    fx = runGuardEntrypoint(base, issueId, docsBody, { TRACE_FILE: trace });
  } finally {
    obs.restore();
  }
  const counts = obs.counts();
  assert.strictEqual(fx.result.status, 0, `the unrestricted entrypoint did not succeed: ${fx.combined.slice(-600)}`);
  assert(fx.calls.includes('impl'), 'the implementation model was not invoked');
  assert(fx.calls.includes('docs'), `the documentation model was not invoked on the unrestricted path: ${JSON.stringify(fx.calls)}`);
  // Real status/verify artifacts, no docsPhaseError, verified outcome.
  assert(fx.verify && fx.verify.acceptance === 'pass', `the real verifier did not record a pass: ${JSON.stringify(fx.verify)}`);
  assert(fx.status && !fx.status.docsPhaseError, `the unrestricted docs phase reported a docsPhaseError: ${JSON.stringify(fx.status && fx.status.docsPhaseError)}`);
  // The allowed docs delta was transferred to the final candidate and its commit is on the branch.
  const readme = path.join(fx.task, 'README.md');
  assert(fs.existsSync(readme) && /docs delta bytes/.test(fs.readFileSync(readme, 'utf8')),
    'the allowed docs delta was not transferred to the final candidate');
  assert(/Task repo-062gep: docs/.test(String(git(fx.task, 'log', '--format=%s').stdout || '')),
    'no isolated docs commit reached the final candidate');

  // The isolated docs worktree: a real worktree-add COMMAND (allowed control for test.js's zero
  // counts), detached at the verified implementation commit, isolated from the task checkout, and
  // a linked worktree (its .git is a file). Reported honestly where the host cannot observe it.
  if (onLinux) {
    assert(counts.worktreeAdd >= 1, `the unrestricted docs phase created no git worktree (worktree-add commands: ${counts.worktreeAdd})`);
    const verifiedHead = String(git(fx.task, 'rev-parse', 'HEAD~1').stdout || '').trim();
    const p4 = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert(!p4.error, `the docs isolation probe did not run: ${p4.error}`);
    assert(p4.cwd && path.resolve(p4.cwd) !== path.resolve(fx.task), `the docs model ran in the task checkout, not an isolated worktree: ${p4.cwd}`);
    assert.strictEqual(p4.head, verifiedHead, `the docs worktree was not detached at the verified implementation commit: ${p4.head} != ${verifiedHead}`);
    assert.strictEqual(p4.gitIsFile, true, 'the docs worktree was not a linked worktree (.git is not a file)');
  } else {
    console.log('  (note) G4: local host cannot observe the isolated worktree git commands off Linux; deferring to the canonical gate');
  }

  // Ordered trace: implementation verification saw no docs bytes; final verification saw them.
  const traceLines = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert(traceLines.length >= 2, `expected implementation and final verification passes in the trace: ${JSON.stringify(traceLines)}`);
  assert(traceLines.every((t) => t.feat === true), `a verification pass ran without the implementation present: ${JSON.stringify(traceLines)}`);
  assert.strictEqual(traceLines[0].readme, '', `implementation verification already saw the docs bytes: ${JSON.stringify(traceLines[0])}`);
  assert(/docs delta bytes/.test(traceLines[traceLines.length - 1].readme),
    `final verification did not see the transferred docs bytes: ${JSON.stringify(traceLines[traceLines.length - 1])}`);
});

// ── G5 / C2 [guard] ───────────────────────────────────────────────────────────────────────────
test('G5 C2 [guard] the root/docs Markdown surface the publication check reuses is exactly the existing docs-agent surface — proven through REAL docs-boundary behaviour, not a copied predicate or a source regex: a docs delta to root-level Markdown and Markdown under docs/ is accepted and transferred, while a docs delta to src/README.md (a Markdown file OUTSIDE the surface) is refused as a non-documentation path with the verified implementation left standing', () => {
  // Allowed direction: root Markdown (README.md) and docs/ Markdown (docs/guide.md) are the docs
  // surface — accepted, transferred, no docsPhaseError.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-g5a-'));
    temps.push(base);
    const issueId = 'repo-062g5a';
    const docsBody = "fs.mkdirSync('docs',{recursive:true});"
      + "fs.writeFileSync('docs/guide.md','guide delta\\n');fs.writeFileSync('README.md','root delta\\n');";
    const fx = runGuardEntrypoint(base, issueId, docsBody);
    assert.strictEqual(fx.result.status, 0, `the allowed-surface docs run did not succeed: ${fx.combined.slice(-600)}`);
    assert(fx.status && !fx.status.docsPhaseError, `an allowed root/docs Markdown delta was rejected: ${JSON.stringify(fx.status && fx.status.docsPhaseError)}`);
    assert(fs.existsSync(path.join(fx.task, 'README.md')) && fs.existsSync(path.join(fx.task, 'docs', 'guide.md')),
      'the allowed root/docs Markdown delta was not transferred to the final candidate');
  }
  // Excluded direction: src/README.md is a Markdown file OUTSIDE the surface. A docs delta to it
  // is refused as a non-documentation path; the verified implementation still stands (exit 0) and
  // src/README.md never reaches the final candidate.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062g-g5b-'));
    temps.push(base);
    const issueId = 'repo-062g5b';
    const docsBody = "fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/README.md','src readme delta\\n');";
    const fx = runGuardEntrypoint(base, issueId, docsBody);
    assert.strictEqual(fx.result.status, 0, `the excluded-path docs run did not leave the verified implementation standing: ${fx.combined.slice(-600)}`);
    assert(fx.verify && fx.verify.acceptance === 'pass', `the verified implementation was lost: ${JSON.stringify(fx.verify)}`);
    assert(fx.status && typeof fx.status.docsPhaseError === 'string' && /(non-documentation|discard)/i.test(fx.status.docsPhaseError),
      `a docs delta to src/README.md was not refused as a non-documentation path: ${JSON.stringify(fx.status && fx.status.docsPhaseError)}`);
    assert(!fs.existsSync(path.join(fx.task, 'src', 'README.md')),
      'the refused src/README.md docs delta reached the final candidate');
  }
});

// ── G6 / C1,C3 [guard] ────────────────────────────────────────────────────────────────────────
test('G6 C1,C3 [guard] the existing serialization identity and fail-closed intake are preserved: an unrestricted task still serializes an issue keyed on kickoff-spec:<hash> with its kickoffHash and specHash metadata, kickoff.verifyRecord still refuses tampered intake intent, and the status/verifier schemas still parse', async () => {
  await withBd(async ({ store }) => {
    const w = makeWorld('g6', {});
    const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
    adapters.launchCodex = async () => JSON.stringify({ spec: 'do it', acceptanceCriteria: ['ok'], designReferences: ['DESIGN.md#architecture'], difficulty: 'medium', status: 'ready' });
    const result = await specify.execute({ configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);
    assert.strictEqual(result.status, 'ready', `unrestricted execute did not complete: ${JSON.stringify(result)}`);
    const rec = readStore(store).records.find((r) => r.id === result.issueId);
    assert(rec && rec.external_ref === `kickoff-spec:${w.kickoffHash}`, `the external-ref identity changed: ${rec && rec.external_ref}`);
    assert(rec.metadata && rec.metadata.kickoffHash === w.kickoffHash && typeof rec.metadata.specHash === 'string',
      `the existing identity metadata was lost: ${JSON.stringify(rec.metadata)}`);
  });

  // Existing fail-closed on a tampered intake record (the binding the feature builds on).
  const intentObj = { version: 'kickoff-intake/1', title: 't', description: '', constraints: ['x'], examples: [], nonGoals: [], priority: 2, relations: [], origin: null };
  const intent = JSON.stringify(intentObj);
  const record = { version: 'kickoff-intake/1', id: 'kp-0000000000000000', target: '/t', hash: hashOf(intent), intent, createdAt: '2026-01-01T00:00:00.000Z' };
  assert.doesNotThrow(() => kickoffApi.verifyRecord(record, 'kp-0000000000000000', '/t'), 'a valid intake record was refused');
  const tampered = { ...record, intent: JSON.stringify({ ...intentObj, constraints: [] }) }; // hash retained
  assert.throws(() => kickoffApi.verifyRecord(tampered, 'kp-0000000000000000', '/t'), 'tampered intake intent under the old hash was not refused');

  for (const name of ['status.schema.json', 'verify.schema.json']) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', name), 'utf8'));
    assert(schema && typeof schema === 'object', `${name} did not parse as a schema`);
  }
  const verifySchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'verify.schema.json'), 'utf8'));
  const req = verifySchema.required || (verifySchema.properties && Object.keys(verifySchema.properties)) || [];
  assert(req.includes('acceptance') && req.includes('regressions'), 'the verifier schema no longer fixes acceptance/regressions');
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
  if (savedStateDir === undefined) delete process.env.PIPELINE_STATE_DIR;
  else process.env.PIPELINE_STATE_DIR = savedStateDir;
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
