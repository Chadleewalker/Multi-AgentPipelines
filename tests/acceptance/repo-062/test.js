// Frozen acceptance test — repo-062: preserve kickoff constraints and enforce explicit
// no-documentation scope. This is the RED half of the suite; guard.js beside it pins the
// existing behaviours this change must PRESERVE (green at the fork point). Between the two
// files every criterion is covered in BOTH directions. This file carries NO classification
// marker in its header: it is the FEATURE half, and every check below is expected to fail at
// the fork point. (The literal guard token lives only in guard.js, so the canonical Linux gate
// runs exactly guard.js in its green subset and this file in its red subset.)
//
// WHY THIS FILE IS RED TODAY (the missing feature). Nothing in the pipeline yet preserves the
// immutable kickoff `constraints`/`nonGoals` through canonical Beads serialization AND the
// exported task text the container mounts, derives a documentation scope from the two exact
// directives, validates that scope as a host-owned snapshot, skips the documentation phase for a
// documentation-prohibited task, or refuses a protected-Markdown-surface delta before publication.
// So:
//   * scripts/specify-proposal.js serializes a Beads issue whose metadata carries NEITHER the
//     original intent NOR a derived scope, and queue.exportIssue renders a markdown task text
//     that carries neither the original constraints/nonGoals nor the kickoff hash (T1, T2);
//   * runner/queue.js `exportIssue` performs no host-side scope binding and never fails closed
//     on tampered or partial intent/hash/scope metadata (T3);
//   * pipeline/entrypoint.sh always runs the docs model and creates a docs worktree (T4);
//   * runner/run.js -> runner/publish.js push and open PRs for a docs-prohibited task that
//     touched the protected Markdown surface, never transport the derived scope from the
//     canonical export into publication, and never carry the omission into the run log or PR
//     body as an intentional note (T5, T6, T7).
// Every check below therefore fails until the feature lands.
//
// COMPOSITION. Each check drives the REAL production interface end to end — real
// specify-proposal `execute`, real Beads serialization/export through a stateful external `bd`
// CLI adapter, real `exportIssue`, the real `pipeline/` directory and real verifier/status
// writers in a nested entrypoint fixture, real `runOneTask`, and real `publish` with real Git
// deltas — substituting ONLY the external model command, the external `bd`/`gh` CLIs, and a
// narrow DELEGATING `git` observer that counts `worktree add`/`push` attempts and passes every
// invocation through to the real git unchanged. The stateful `bd` adapter returns what the
// production serializer created; it does not invent a different issue for export. The integrated
// cases NEVER inject the derived scope into the entrypoint environment — production must
// transport it from the canonical export.
//
// A FIXTURE PRECONDITION (`bdSelfTest`) runs before any feature assertion and proves the
// stateful external `bd` adapter round-trips create/search/show through the real production seam
// (runner/bd.js). A failure there is a loud `harness — FIXTURE SETUP` line, never a feature RED.
//
// CRITERION PAIRING — every check names its criterion; every criterion names >=1 check here or
// in guard.js:
//   C1 canonical serialization AND the real queue.exportIssue the host consumes (both the issue
//      metadata AND the mounted task markdown) retain the exact original constraints, nonGoals
//      and kickoff hash even when the planner omits or contradicts them.       -> T1 (+ T6)
//   C2 only an exact standalone directive array item (in constraints OR nonGoals) activates
//      documentation preservation; substrings, casing, the examples/title/description fields and
//      planner prose bullets do not, and the alias binds documentation only.  -> T2 (+ guard G5)
//   C3 new malformed, partial or tampered intent/hash/scope metadata fails closed at the host
//      consumer; legacy tasks with no new metadata keep prior behaviour; container-editable
//      artifacts cannot weaken the host snapshot.                                  -> T3 (+ T6)
//   C4 a documentation-prohibited task skips the docs model and docs worktree while preserving
//      the implementation verification and summary, and records an honest omission (not a
//      docsPhaseError) in the run log and PR body.                    -> T4 (+ T6, T7, guard G4)
//   C5 publication refuses every protected-Markdown-surface delta kind (add/modify/delete/mode/
//      rename, uppercase extension, space/tab/newline/quoted paths); a Git-inspection failure
//      refuses; a refusal pushes nothing, opens no PR and retains the workspace; src/README.md
//      stays allowed.                                                        -> T5 (+ T6, guard G3)
//   C6 scoped product-only changes stay publishable and unrestricted work keeps normal docs and
//      publication; existing policies and frozen suites stay unchanged.  -> T7, guards G1,G2,G3,G4,G6
//   C7 deterministic real-Git fixtures cover preserved omitted intent, exact-directive matching,
//      tampering (host + container), documentation skipping and publication refusal.  -> T1..T7
//
// SELF-CONTAINED: Node built-ins and real local Git repositories. No provider key, no real Beads
// binary or host Beads database, no network, no container engine. Every durable store is re-aimed
// into a disposable temp tree via PIPELINE_STATE_DIR.
//
// LOCAL-EXECUTION HONESTY: the integrated `runOneTask`/entrypoint cases and the delegating `git`
// observer are authored for the canonical Linux gate. The shim `git` (a POSIX script with no
// `.exe`) is resolved by Node and by bash on Linux; on the Windows reference host a host-level
// `spawnSync('git')` resolves `git.exe` instead and the shim only intercepts the bash entrypoint.
// The authoritative RED/GREEN is the Linux gate; local Windows observation of host-level git is
// reported as unsupported rather than silently weakened.
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
const runmod = require(path.join(ROOT, 'runner', 'run.js'));
const logmod = require(path.join(ROOT, 'runner', 'log.js'));
const bdModule = require(path.join(ROOT, 'runner', 'bd.js'));

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_DOCS_SCOPE', 'NODE_OPTIONS',
  'BD_STORE', 'BD_CALLS', 'GIT_OBS_LOG', 'GIT_OBS_REALPATH']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

// ── the two exact directives and the deterministic derivation, as the criteria fix them ──────
const DIRECTIVE_ALIAS = 'pipeline:docs=preserve';
const DIRECTIVE_DEMO = 'Do not add documentation or package-management files.';
// Exact standalone array-element match against constraints ∪ nonGoals — never a substring, a
// casing variant, or any other field. The derived scope binds documentation ONLY.
function deriveScope(intentObj) {
  const items = [...(intentObj.constraints || []), ...(intentObj.nonGoals || [])];
  const hit = items.find((x) => x === DIRECTIVE_ALIAS || x === DIRECTIVE_DEMO);
  return hit ? { documentation: 'preserve', directive: hit } : { documentation: 'normal', directive: null };
}
// Byte-exact kickoff hash, identical to scripts/kickoff.js `hashOf`.
const hashOf = (intent) => `sha256:${crypto.createHash('sha256').update(Buffer.from(intent, 'utf8')).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });

// The bash a nested entrypoint fixture runs under — Git Bash on the Windows reference host, the
// system bash on the canonical Linux gate.
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const onLinux = process.platform !== 'win32';

// ── the narrow, delegating external-command observer ─────────────────────────────────────────
// A `git` shim placed FIRST on PATH. It appends the verb it was asked to run to a log for exactly
// two subcommands — `worktree add` and `push` — and then delegates EVERY invocation, unchanged,
// to the real git resolved from the PATH with the shim directory removed. Real Git behaviour is
// preserved; only those two verbs are counted, so "zero docs worktree creation calls" and "zero
// push attempts" become observations of actual external commands rather than of an absent commit
// or a missing remote ref. Install it AROUND the call under test only, so fixture-setup pushes
// (seeding a bare remote's main) never enter the count.
function makeGitObserver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-gitobs-'));
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

// A stateful external `bd` CLI adapter: `create` records the serialized issue (metadata and all)
// into a JSON store; `search`/`show` return exactly what was recorded — never an independently
// invented issue. Correctly keyed on the BASENAME of argv[1] (Node absolutises the script arg
// before a preload sees it, so dispatching on the raw `args[0]` — '/abs/show' — matched no verb
// and returned [] for every export under PIPELINE_BD_CMD=node): the stand-aside test is basename
// `.js`, and the verb is that basename `_b`.
const BD_STUB = String.raw`
'use strict';
const _b = String(process.argv[1] || '').replace(/\\/g, '/').split('/').pop();
if (/\.js$/i.test(_b)) { /* another node child (gh stub, node -e): stand aside */ } else {
  const fs = require('fs');
  const crypto = require('crypto');
  const store = process.env.BD_STORE;
  const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return { records: [] }; } };
  const save = (d) => fs.writeFileSync(store, JSON.stringify(d));
  const args = process.argv.slice(1);
  // The VERB is the basename of argv[1] (computed as _b above), NOT args[0]. Node resolves
  // the "script" argument (create/show/search) to an ABSOLUTE path before this preload runs,
  // so args[0] is '/abs/show' and the old 'args[0] === "show"' dispatch was always false —
  // every create/show/search fell through to emit([]) and export saw an empty issue. The real
  // bd argument vector still begins at args[1] (args[1] is the create title, the show id).
  const verb = _b;
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  if (process.env.BD_CALLS) {
    const shown = args.map((a) => String(a).replace(/\\/g, '/').split('/').pop());
    fs.appendFileSync(process.env.BD_CALLS, shown.join(' ') + '\n');
  }
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
  if (verb === 'search') {
    const d = load(); const ref = val('--external-contains');
    emit(d.records.filter((r) => !ref || r.external_ref === ref)); process.exit(0);
  }
  if (verb === 'show') {
    const d = load(); const id = args[1];
    emit(d.records.filter((r) => r.id === id)); process.exit(0);
  }
  emit([]); process.exit(0);
}
`;

// Aim a fresh, independent bd store and preload the adapter for every child node process. Async
// so the environment stays aimed for the whole awaited body and is only restored afterwards.
async function withBd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-bd-'));
  temps.push(dir);
  const stub = path.join(dir, 'bd-stub.js');
  const store = path.join(dir, 'store.json');
  fs.writeFileSync(stub, BD_STUB);
  fs.writeFileSync(store, JSON.stringify({ records: [] }));
  const saved = {
    PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    BD_STORE: process.env.BD_STORE,
  };
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  process.env.BD_STORE = store;
  try { return await fn({ store, dir }); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}
const readStore = (store) => JSON.parse(fs.readFileSync(store, 'utf8'));

// ── FIXTURE PRECONDITION: prove the stateful external `bd` adapter end to end through the
// PRODUCTION invocation seam (runner/bd.js `bdJson`) BEFORE any feature assertion. ─────────────
async function bdSelfTest() {
  await withBd(({ store, dir }) => {
    const calls = path.join(dir, 'bd-calls.txt');
    fs.writeFileSync(calls, '');
    const savedCalls = process.env.BD_CALLS;
    process.env.BD_CALLS = calls;
    try {
      const cfg = { targetRepoPath: dir, bdTimeoutMs: 30000 };
      const extRef = `kickoff-spec:selftest-${crypto.randomBytes(6).toString('hex')}`;
      const meta = { probe: 'value', n: 7 };
      const created = bdModule.bdJson(cfg, ['create', 'probe title', '-d', 'probe body',
        '--acceptance', 'crit', '--design', 'design-ref: DESIGN.md#architecture', '--priority', '2',
        '--external-ref', extRef, '--metadata', JSON.stringify(meta), '--silent']);
      if (!created.ok) throw new Error(`bd create did not return parseable JSON through the production seam: ${created.error}`);
      const rec = Array.isArray(created.data) ? created.data[0] : created.data;
      if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error(`bd create returned no issue identity: ${JSON.stringify(created.data)}`);
      if (rec.external_ref !== extRef) throw new Error(`bd create did not store the external ref: ${JSON.stringify(rec)}`);
      if (!rec.metadata || rec.metadata.probe !== 'value' || rec.metadata.n !== 7) throw new Error(`bd create did not store the metadata: ${JSON.stringify(rec.metadata)}`);

      const found = bdModule.bdJson(cfg, ['search', '%', '--external-contains', extRef, '--status', 'all', '--limit', '0']);
      if (!found.ok || !Array.isArray(found.data)) throw new Error(`bd search did not return a JSON array: ${JSON.stringify(found)}`);
      if (!found.data.some((r) => r && r.external_ref === extRef && r.id === rec.id)) {
        throw new Error(`bd search did not return the record just created: ${JSON.stringify(found.data)}`);
      }

      const shown = bdModule.bdJson(cfg, ['show', rec.id]);
      const shownRec = shown.ok && (Array.isArray(shown.data) ? shown.data[0] : shown.data);
      if (!shownRec || shownRec.id !== rec.id) throw new Error(`bd show did not return the created id: ${JSON.stringify(shown)}`);
      if (!shownRec.metadata || shownRec.metadata.probe !== 'value') throw new Error(`bd show lost the stored metadata: ${JSON.stringify(shownRec)}`);

      const observed = fs.readFileSync(calls, 'utf8');
      for (const verb of ['create', 'search', 'show']) {
        if (!new RegExp(`(^|\\n)${verb}(\\s|$)`).test(observed)) {
          throw new Error(`the bd adapter never observed a leading "${verb}" command (argv dispatch is wrong): ${JSON.stringify(observed)}`);
        }
      }
    } finally {
      if (savedCalls === undefined) delete process.env.BD_CALLS; else process.env.BD_CALLS = savedCalls;
    }
  });
}

// A committed kickoff intake record on the canonical target, with the given constraints/nonGoals
// (and, when a negative case needs it, an explicit title/description carrying a directive string).
function writeKickoff(targetRepoPath, tag, { constraints = [], examples = [], nonGoals = [], title, description } = {}) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1',
    title: title !== undefined ? title : `repo-062 fixture ${tag}`,
    description: description !== undefined ? description : 'implement the fix',
    constraints, examples, nonGoals, priority: 2, relations: [], origin: null,
  };
  const intent = JSON.stringify(intentObj);
  const record = { version: 'kickoff-intake/1', id, target: paths.target, hash: hashOf(intent), intent,
    createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { id, hash: record.hash, intent, intentObj };
}

// A real target repo (integration branch `main` carrying a DESIGN.md heading and a run config),
// plus a durable kickoff record carrying the given intake arrays.
function makeWorld(tag, arrays, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repo062-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-062 fixture');
  git(target, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'DESIGN.md'), '# Architecture\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'seed');
  const A = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(A), `world ${tag} did not pin a 40-hex commit: ${A}`);
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-repo062-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 30000, wallClockMinutes: 2, ...extraCfg,
  }, null, 2)}\n`);
  const k = writeKickoff(target, tag, arrays);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash,
    kickoffIntent: k.intent, intentObj: k.intentObj };
}

// A planner proposal that deliberately CONTRADICTS the original intake — it names its own
// constraints in prose and drops the directive — so a serializer that copied the planner rather
// than the immutable intent would be caught.
function contradictingProposal() {
  return JSON.stringify({
    spec: 'Rework the module. The planner asserts there are no documentation constraints and that '
      + `${DIRECTIVE_ALIAS} does not apply.`,
    acceptanceCriteria: ['the reworked module passes its suite'],
    designReferences: ['DESIGN.md#architecture'], difficulty: 'medium', status: 'ready',
  });
}

// A planner proposal whose SPEC PROSE contains both exact directives as standalone bullet lines.
// With the original arrays unrestricted this must NOT activate scope: directive activation reads
// only exact elements of the original kickoff arrays, never planner prose (C2 negative).
function proposalWithDirectiveBullets() {
  return JSON.stringify({
    spec: `Rework the module.\n- ${DIRECTIVE_DEMO}\n- ${DIRECTIVE_ALIAS}\n`,
    acceptanceCriteria: ['the reworked module passes its suite'],
    designReferences: ['DESIGN.md#architecture'], difficulty: 'medium', status: 'ready',
  });
}

// Drive real specify-proposal `execute` through the stateful bd CLI, substituting only the
// external model. Returns the created store record (what the production serializer wrote).
async function runExecuteWith(w, plannerJson) {
  const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
  adapters.launchCodex = async () => plannerJson;
  return specify.execute({ configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);
}
async function runExecute(w) { return runExecuteWith(w, contradictingProposal()); }

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 canonical Beads serialization AND the real queue.exportIssue the host consumes retain the exact original constraints, nonGoals and immutable kickoff hash even when the planner omits and contradicts them: the serialized issue metadata carries the immutable intent (hash-bound) and a derived documentation scope, and the exported MARKDOWN the container mounts carries each original constraint, nonGoal and the kickoff hash', async () => {
  await withBd(({ store }) => {
    return (async () => {
      const w = makeWorld('t1', {
        constraints: [DIRECTIVE_ALIAS, 'keep the public API stable'],
        nonGoals: ['no new dependencies'],
      });
      const result = await runExecute(w);
      assert.strictEqual(result.status, 'ready', `execute did not complete: ${JSON.stringify(result)}`);
      const rec = readStore(store).records.find((r) => r.id === result.issueId);
      assert(rec, 'the serialized issue was not written to the Beads store');
      const meta = rec.metadata || {};
      // The immutable intent survives serialization, hash-bound, regardless of the planner.
      assert.strictEqual(typeof meta.intent, 'string', 'serialized metadata carries no immutable intent');
      assert.strictEqual(meta.intent, w.kickoffIntent, 'the serialized intent is not the immutable kickoff intent');
      assert.strictEqual(meta.kickoffHash, w.kickoffHash, 'the serialized kickoff hash is wrong');
      assert.strictEqual(hashOf(meta.intent), meta.kickoffHash, 'serialized intent is not bound to its recorded hash');
      const parsed = JSON.parse(meta.intent);
      assert.deepStrictEqual(parsed.constraints, w.intentObj.constraints,
        'the original constraints were not preserved verbatim through serialization');
      assert.deepStrictEqual(parsed.nonGoals, w.intentObj.nonGoals,
        'the original nonGoals were not preserved verbatim through serialization');
      // The deterministically derived scope travels with the issue and the planner cannot relax it.
      assert.deepStrictEqual(meta.scope, deriveScope(w.intentObj),
        `the derived documentation scope was not serialized: ${JSON.stringify(meta.scope)}`);
      assert.strictEqual(meta.scope.documentation, 'preserve',
        'a constraints directive did not derive a documentation-preserve scope');

      // The HOST CONSUMER re-reads the SAME serializer-created record through the real production
      // export (queue.exportIssue). This is the export half of C1: preservation must survive not
      // only serialization but the export the host execution actually consumes — BOTH the scope
      // snapshot and the metadata, AND the mounted task MARKDOWN, because runOneTask mounts
      // exported.markdown at .run/issue.md as the implementation input, not exported.issue.metadata.
      const exported = queue.exportIssue({ targetRepoPath: w.target, bdTimeoutMs: 30000 }, result.issueId);
      assert(exported && exported.ok === true, `the host export refused the serialized issue: ${JSON.stringify(exported)}`);
      assert(exported.scope && exported.scope.documentation === 'preserve',
        `the host export did not carry the documentation-preserve scope snapshot: ${JSON.stringify(exported.scope)}`);
      const exMeta = (exported.issue && exported.issue.metadata) || {};
      assert.strictEqual(exMeta.intent, w.kickoffIntent, 'the exported issue lost the immutable kickoff intent');
      assert.strictEqual(exMeta.kickoffHash, w.kickoffHash, 'the exported issue lost the immutable kickoff hash');
      // The MOUNTED TASK TEXT — the implementation input — carries each original constraint and
      // nonGoal verbatim and the immutable kickoff hash. Metadata surviving while the mounted task
      // omits the original intent must fail.
      assert.strictEqual(typeof exported.markdown, 'string', 'the host export produced no mounted task markdown');
      for (const c of w.intentObj.constraints) {
        assert(exported.markdown.includes(c),
          `the mounted task text (exported.markdown) dropped the original constraint ${JSON.stringify(c)}`);
      }
      for (const n of w.intentObj.nonGoals) {
        assert(exported.markdown.includes(n),
          `the mounted task text (exported.markdown) dropped the original nonGoal ${JSON.stringify(n)}`);
      }
      assert(exported.markdown.includes(w.kickoffHash),
        'the mounted task text (exported.markdown) does not carry the immutable kickoff hash');
    })();
  });
});

// ── T2 / C2 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C2 documentation preservation activates ONLY for an exact standalone directive array item, in constraints or nonGoals, and never for a substring, a casing variant, the examples field, the original title or description, or planner prose bullets — and the alias binds documentation only, not package management', async () => {
  const cases = [
    // The FOUR positive combinations: each exact directive as a standalone element of EACH
    // original array (constraints ∪ nonGoals) activates documentation preservation.
    { tag: 'c-alias', arrays: { constraints: [DIRECTIVE_ALIAS] }, want: 'preserve', dir: DIRECTIVE_ALIAS },
    { tag: 'c-demo', arrays: { constraints: [DIRECTIVE_DEMO] }, want: 'preserve', dir: DIRECTIVE_DEMO },
    { tag: 'n-alias', arrays: { nonGoals: [DIRECTIVE_ALIAS] }, want: 'preserve', dir: DIRECTIVE_ALIAS },
    { tag: 'n-demo', arrays: { nonGoals: [DIRECTIVE_DEMO] }, want: 'preserve', dir: DIRECTIVE_DEMO },
    // Negatives that do not activate: a substring, a casing variant, the examples field, and
    // unrelated prose. runExecute's planner prose already MENTIONS DIRECTIVE_ALIAS, so these also
    // prove a directive in planner prose (not an original array element) does not activate scope.
    { tag: 'substr', arrays: { constraints: [`note: ${DIRECTIVE_ALIAS} applies here`] }, want: 'normal', dir: null },
    { tag: 'case', arrays: { constraints: ['PIPELINE:DOCS=PRESERVE'] }, want: 'normal', dir: null },
    { tag: 'demo-substr', arrays: { nonGoals: [`${DIRECTIVE_DEMO} (paraphrased)`] }, want: 'normal', dir: null },
    { tag: 'example', arrays: { examples: [DIRECTIVE_ALIAS] }, want: 'normal', dir: null },
    { tag: 'prose', arrays: { constraints: ['do not add documentation'] }, want: 'normal', dir: null },
    // NEW negatives (C2 completion): the exact directive in the original TITLE or DESCRIPTION with
    // unrestricted arrays never activates — only the constraints/nonGoals arrays do.
    { tag: 'title-dir', arrays: { title: `Repo task ${DIRECTIVE_ALIAS}`, constraints: [], nonGoals: [] }, want: 'normal', dir: null, runDocs: true },
    { tag: 'desc-dir', arrays: { description: `${DIRECTIVE_DEMO}`, constraints: [], nonGoals: [] }, want: 'normal', dir: null, runDocs: true },
    // NEW negative (C2 completion): the planner SPEC PROSE lists both exact directives as bullets
    // while the original arrays are unrestricted — normal docs behaviour must be retained.
    { tag: 'prose-bullet', arrays: { constraints: [], nonGoals: [] }, planner: proposalWithDirectiveBullets, want: 'normal', dir: null, runDocs: true },
  ];
  for (const c of cases) {
    await withBd(({ store }) => (async () => {
      const w = makeWorld(`t2-${c.tag}`, c.arrays);
      const result = c.planner ? await runExecuteWith(w, c.planner()) : await runExecute(w);
      assert.strictEqual(result.status, 'ready', `${c.tag}: execute did not complete: ${JSON.stringify(result)}`);
      const rec = readStore(store).records.find((r) => r.id === result.issueId);
      const scope = rec && rec.metadata && rec.metadata.scope;
      assert(scope && typeof scope === 'object', `${c.tag}: no derived scope was serialized`);
      assert.strictEqual(scope.documentation, c.want,
        `${c.tag}: expected documentation=${c.want}, got ${JSON.stringify(scope)}`);
      assert.strictEqual(scope.directive, c.dir, `${c.tag}: wrong recorded directive: ${JSON.stringify(scope)}`);
      // The alias binds documentation ONLY: the scope object never grows a package-management or
      // arbitrary natural-language restriction key.
      assert.deepStrictEqual(Object.keys(scope).sort(), ['directive', 'documentation'],
        `${c.tag}: the derived scope enforces more than documentation: ${JSON.stringify(scope)}`);
      if (c.runDocs) {
        // Consume this SAME serializer-created issue through the production host/container path.
        // A normal metadata value alone cannot prove that a directive in prose leaves docs enabled.
        const fx = await runIntegratedScoped({ tag: `t2-${c.tag}`, rogue: false, docsChange: true,
          serialized: { world: w, result } });
        assertNormalDocs(fx, c.tag);
      }
    })());
  }
});

// ── T3 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T3 C3 the host export binds the scope snapshot and fails closed on malformed, partial or tampered issue metadata: a valid docs-prohibited issue yields a host-owned scope snapshot; an intent mutated while retaining its old hash, a mutated hash, a derived scope that disagrees with the intent, and each PARTIAL new-format record (missing intent, hash, or scope while carrying the other new fields) are refused; a legacy issue with NO new metadata keeps prior behaviour (exports, scope absent)', async () => {
  const intentObj = { version: 'kickoff-intake/1', title: 't', description: 'd',
    constraints: [DIRECTIVE_ALIAS], examples: [], nonGoals: [], priority: 2, relations: [], origin: null };
  const intent = JSON.stringify(intentObj);
  const goodMeta = { intent, kickoffHash: hashOf(intent), scope: deriveScope(intentObj) };
  const mutIntent = (() => { const t = JSON.parse(intent); t.constraints = []; return JSON.stringify(t); })();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-exp-'));
  temps.push(root);
  const cfg = { targetRepoPath: root, bdTimeoutMs: 30000 };
  // Each PARTIAL new-format record still carries at least one of the new fields, so it is
  // DISTINGUISHABLE from a truly legacy record (which carries none). The presence of any new
  // field is the new-format marker; a record that presents itself as new but is incomplete or
  // internally inconsistent must fail closed, while a record with no new fields at all stays
  // unrestricted legacy data.
  const seeds = [
    ['bd-ok', goodMeta],
    ['bd-mutint', { intent: mutIntent, kickoffHash: goodMeta.kickoffHash, scope: goodMeta.scope }],
    ['bd-muthash', { intent, kickoffHash: `sha256:${'0'.repeat(64)}`, scope: goodMeta.scope }],
    ['bd-mutscope', { intent, kickoffHash: goodMeta.kickoffHash, scope: { documentation: 'normal', directive: null } }],
    ['bd-partial-noscope', { intent, kickoffHash: goodMeta.kickoffHash }],
    ['bd-partial-nohash', { intent, scope: goodMeta.scope }],
    ['bd-partial-nointent', { kickoffHash: goodMeta.kickoffHash, scope: goodMeta.scope }],
    ['bd-legacy', {}],
  ];
  await withBd(({ store }) => {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    for (const [id, metadata] of seeds) {
      d.records.push({ id, title: 'scoped task', description: 'body', acceptance_criteria: 'a',
        design: 'design-ref: DESIGN.md#architecture', priority: 2, external_ref: `kickoff-spec:${id}`, metadata, status: 'open' });
    }
    fs.writeFileSync(store, JSON.stringify(d));

    const ok = queue.exportIssue(cfg, 'bd-ok');
    assert(ok && ok.ok === true, `a valid scoped issue did not export: ${JSON.stringify(ok)}`);
    assert(ok.scope && ok.scope.documentation === 'preserve',
      `the host-owned scope snapshot was not returned: ${JSON.stringify(ok.scope)}`);

    for (const id of ['bd-mutint', 'bd-muthash', 'bd-mutscope',
      'bd-partial-noscope', 'bd-partial-nohash', 'bd-partial-nointent']) {
      const out = queue.exportIssue(cfg, id);
      assert(out && out.ok === false, `${id}: malformed/partial/tampered scope metadata was not refused fail-closed: ${JSON.stringify(out)}`);
    }

    const legacy = queue.exportIssue(cfg, 'bd-legacy');
    assert(legacy && legacy.ok === true, `a legacy issue with no new metadata was not exported: ${JSON.stringify(legacy)}`);
    assert(!legacy.scope || legacy.scope.documentation !== 'preserve',
      `a legacy issue was treated as documentation-prohibited: ${JSON.stringify(legacy.scope)}`);
  });
});

// ── the nested entrypoint fixture (real pipeline dir, real verifier/status writers) ─────────────
const IMPL_SUMMARY = 'Implemented the verified conveyor repair without touching documentation.';

function installTaskRepo(base, issueId) {
  const task = path.join(base, 'task');
  fs.mkdirSync(path.join(task, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'run-acceptance.sh'), path.join(task, 'tools', 'run-acceptance.sh'));
  fs.writeFileSync(path.join(task, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  // A real acceptance suite, committed at the fork point, that passes iff the implementation
  // agent created feature.txt. The verifier runs it for real; nothing here manufactures a pass.
  fs.mkdirSync(path.join(task, 'tests', 'acceptance', issueId), { recursive: true });
  fs.writeFileSync(path.join(task, 'tests', 'acceptance', issueId, 'test.js'),
    "'use strict';const fs=require('fs');const p=require('path');\n"
    + "const f=p.join(process.env.WORKSPACE||process.cwd(),'feature.txt');\n"
    + "if(fs.existsSync(f)){console.log('ok - feature present');process.exit(0);}\n"
    + "console.log('FAIL - feature.txt missing');process.exit(1);\n");
  fs.writeFileSync(path.join(task, '.gitignore'), '.run/\n');
  fs.mkdirSync(path.join(task, '.run'), { recursive: true });
  fs.writeFileSync(path.join(task, '.run', 'issue.md'), `# ${issueId}: scoped task\n`);
  git(task, 'init', '-q', '-b', 'main');
  git(task, 'config', 'user.email', 'fixture@example.invalid');
  git(task, 'config', 'user.name', 'repo-062 fixture');
  git(task, 'config', 'core.autocrlf', 'false');
  git(task, 'add', '-A');
  git(task, 'commit', '-qm', 'base');
  git(task, 'checkout', '-q', '-b', `task/${issueId}`);
  return task;
}

// The external model command: creates the implementation on the code phase; on the docs phase it
// records that it was asked to document (a documentation-prohibited task must never reach here).
function installAgent(file, callsLog) {
  fs.writeFileSync(file,
    "'use strict';const fs=require('fs');\n"
    + "const prompt=fs.readFileSync(0,'utf8');const docs=prompt.includes('Verification for task');\n"
    + `fs.appendFileSync(${JSON.stringify(callsLog)}, (docs?'docs':'impl')+'\\n');\n`
    + "const emit=(t)=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:t}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');};\n"
    + `if(!docs){fs.writeFileSync('feature.txt','verified change\\n');emit(${JSON.stringify(IMPL_SUMMARY)});process.exit(0);}\n`
    + "fs.writeFileSync('README.md','docs delta\\n');emit('docs summary');process.exit(0);\n");
}

function runEntrypoint(base, issueId, scopeEnv) {
  const task = installTaskRepo(base, issueId);
  const agent = path.join(base, 'agent.js');
  const calls = path.join(base, 'agent-calls.txt');
  fs.writeFileSync(calls, '');
  installAgent(agent, calls);
  const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const env = {
    ...process.env,
    WORKSPACE: task, ISSUE_ID: issueId, PIPELINE_DIR: path.join(ROOT, 'pipeline'),
    PIPELINE_PROVIDER: 'codex',
    PIPELINE_AGENT_CMD: `${quote(process.execPath)} ${quote(agent)}`,
    PIPELINE_TESTING_NESTED_ENTRYPOINT: '1', PIPELINE_MAX_ATTEMPTS: '1', GIT_CONFIG_COUNT: '0',
    PIPELINE_DOCS_USER: '',
  };
  delete env.NODE_OPTIONS; // the bd adapter must not preload into the real entrypoint's node children
  if (scopeEnv) env.PIPELINE_DOCS_SCOPE = scopeEnv; else delete env.PIPELINE_DOCS_SCOPE;
  const result = run(SHELL, [path.join(ROOT, 'pipeline', 'entrypoint.sh')],
    { cwd: task, env, timeout: 120000 });
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  return {
    task, result,
    status: readJson(path.join(task, '.run', 'status.json')),
    verify: readJson(path.join(task, '.run', 'verify.json')),
    calls: fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean),
    log: String(git(task, 'log', '--format=%s').stdout || ''),
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

// ── T4 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T4 C4 a documentation-prohibited task runs implementation and its real verifier but skips the docs model and — observed as an actual zero git-worktree-add COMMAND count, not merely an absent docs commit — never creates the docs worktree, preserving the verified implementation summary and adding no docsPhaseError; the host PR body records the omission as an explicit note rather than a documentation-failure warning', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-ep-skip-'));
  temps.push(base);
  const obs = installGitObserver();
  let fx;
  try {
    fx = runEntrypoint(base, 'repo-062ep', 'preserve');
  } finally {
    obs.restore();
  }
  const counts = obs.counts();
  assert.strictEqual(fx.result.status, 0,
    `the documentation-prohibited entrypoint did not succeed: ${fx.combined.slice(-600)}`);
  assert(fx.calls.includes('impl'), 'the implementation model was never invoked');
  assert(!fx.calls.includes('docs'),
    `the documentation model was invoked for a documentation-prohibited task: ${JSON.stringify(fx.calls)}`);
  // Non-vacuity: an ABSENT docs commit is insufficient. Require zero actual worktree-creation
  // COMMANDS on the authoritative Linux gate (the delegating observer counts real `git worktree
  // add` invocations). Reported honestly on a host where the shim cannot intercept host git.
  if (onLinux) {
    assert.strictEqual(counts.worktreeAdd, 0,
      `a docs worktree was created for a documentation-prohibited task (worktree-add calls: ${counts.worktreeAdd})`);
  } else {
    console.log('  (note) T4: local host cannot observe git worktree-add commands off Linux; deferring that count to the canonical gate');
  }
  assert(!/Task repo-062ep: docs/.test(fx.log),
    'a docs commit was created for a documentation-prohibited task (docs worktree ran)');
  assert(fx.status && fx.status.changeSummary === IMPL_SUMMARY,
    `the verified implementation summary was not preserved: ${JSON.stringify(fx.status)}`);
  assert(fx.status && !fx.status.docsPhaseError,
    `an intentional omission was recorded as a docsPhaseError: ${JSON.stringify(fx.status)}`);
  assert(fx.verify && fx.verify.acceptance === 'pass',
    `the real verifier did not record a pass: ${JSON.stringify(fx.verify)}`);

  // The host-generated PR body records the omission as an explicit note, distinct from the
  // documentation-failure warning wording.
  const body = publishMod.buildPrBody({
    issueMarkdown: '# repo-062ep: scoped task', status: { changeSummary: IMPL_SUMMARY,
      attempts: [{ number: 1, verifierResult: 'pass' }] },
    verify: { acceptance: 'pass', regressions: 'pass' }, outcome: { status: 'done' },
    branch: 'task/repo-062ep', runId: 'run-1', scope: { documentation: 'preserve', directive: DIRECTIVE_ALIAS },
  });
  assert(/documentation/i.test(body) && /(intentionally|omitted|preserv|skipp)/i.test(body),
    'the PR body carries no explicit documentation-omission note');
  assert(!/Documentation phase warning/i.test(body),
    'the intentional omission was rendered as a documentation-failure warning');
});

// ── publication fixtures: a workspace with a fork point and a task branch whose delta we control ─
function makeRemote(base) {
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  return remote;
}

function makeWorkspace(base, remote, seedFiles, mutate) {
  const dir = path.join(base, `ws-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-062 fixture');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.fileMode', 'true');
  for (const [rel, content] of Object.entries(seedFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fork point');
  const forkPoint = String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const branch = `task/${path.basename(dir)}`;
  git(dir, 'checkout', '-q', '-b', branch);
  mutate(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'task change');
  return { dir, forkPoint, branch, defaultBranch: 'main', regressionPolicy: null,
    memoryCount: 0 };
}

function silentLog() { return { info() {}, error() {}, event() {} }; }

function publishScoped(ws, cfg) {
  const saved = process.env.PIPELINE_GH_CMD;
  const ghCalls = `${ws.dir}.gh`;
  fs.writeFileSync(ghCalls, '');
  process.env.PIPELINE_GH_CMD = `printf called >> ${ghCalls.split(path.sep).join('/')}; printf 'https://example.test/pr/1\\n'`;
  try {
    const out = publishMod.publish(cfg, {
      ws, outcome: { status: 'done' }, hasCommits: true,
      issueMarkdown: '# scoped', status: { changeSummary: IMPL_SUMMARY }, verify: { acceptance: 'pass', regressions: 'pass' },
      issue: { id: 'bd-scoped', title: 'scoped' }, runId: 'run-1', secrets: ['tok'],
      scope: { documentation: 'preserve', directive: DIRECTIVE_ALIAS },
    }, silentLog(), 'tr');
    return { out, gh: fs.readFileSync(ghCalls, 'utf8') };
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_GH_CMD; else process.env.PIPELINE_GH_CMD = saved;
  }
}

// ── T5 / C5 ──────────────────────────────────────────────────────────────────────────────────
test('T5 C5 publication of a documentation-prohibited task refuses every protected-Markdown-surface delta kind — additions, modifications, deletions, mode changes and renames into/out of the surface, including uppercase extensions and whitespace-bearing paths — with ZERO actual git push COMMANDS observed, opening no PR and retaining the workspace; a Git-inspection failure refuses; a scoped product-only change publishes normally and its push IS observed; src/README.md stays allowed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-pub-'));
  temps.push(base);
  const remote = makeRemote(base);
  const cfg = { targetRepoPath: base, gitTimeoutMs: 60000, defaultBranch: 'main' };

  const seed = {
    'README.md': 'root readme\n', 'docs/guide.md': 'guide\n', 'docs/old.md': 'to remove\n',
    'src/app.js': 'code\n', 'src/README.md': 'src readme allowed\n', 'mode.md': 'mode target\n',
    'rename-src.txt': 'to become docs\n', 'docs/rename-out.md': 'to become code\n',
  };
  // `linux: true` marks a delta kind only the authoritative Linux gate can REPRESENT in a Git
  // index — an executable-bit flip, and space/tab/newline/quoted paths. On Windows those mutate
  // to no delta and are skipped locally; on Linux each MUST produce a delta and is asserted.
  const forbidden = [
    { label: 'add root .md (uppercase ext)', linux: false, mutate: (d) => fs.writeFileSync(path.join(d, 'NEWNOTES.MD'), 'new\n') },
    { label: 'modify docs .md', linux: false, mutate: (d) => fs.appendFileSync(path.join(d, 'docs/guide.md'), 'more\n') },
    { label: 'delete docs .md', linux: false, mutate: (d) => fs.rmSync(path.join(d, 'docs/old.md')) },
    { label: 'mode change root .md', linux: true, mutate: (d) => { try { fs.chmodSync(path.join(d, 'mode.md'), 0o755); } catch { /* filemode is Linux-authoritative */ } } },
    { label: 'rename into surface', linux: false, mutate: (d) => { git(d, 'mv', 'rename-src.txt', 'docs/renamed.md'); } },
    { label: 'rename out of surface', linux: false, mutate: (d) => { git(d, 'mv', 'docs/rename-out.md', 'src/moved.js'); } },
    { label: 'space+tab-bearing docs .md', linux: true, mutate: (d) => { try { fs.writeFileSync(path.join(d, 'docs/a b\tc.md'), 'ws\n'); } catch { /* whitespace/tab paths are Linux-authoritative */ } } },
    { label: 'newline-bearing docs .md', linux: true, mutate: (d) => { try { fs.writeFileSync(path.join(d, 'docs/line\none.md'), 'nl\n'); } catch { /* newline paths are Linux-authoritative */ } } },
    { label: 'quoted-name root .md', linux: true, mutate: (d) => { try { fs.writeFileSync(path.join(d, 'a "quoted" note.md'), 'q\n'); } catch { /* quoted paths are Linux-authoritative */ } } },
  ];
  let exercised = 0;
  for (const { label, linux, mutate } of forbidden) {
    const ws = makeWorkspace(base, remote, seed, mutate);
    // Robust, byte-safe delta read against the pinned integration baseline (`-z`, `-M` exposes
    // renames): the authoritative form the publication check must also use.
    const changed = String(git(ws.dir, 'diff', '--name-status', '-M', '-z', ws.forkPoint, 'HEAD').stdout || '');
    if (!changed) {
      assert(!onLinux || !linux, `${label}: the intended Git delta did not materialise on the authoritative Linux fixture`);
      continue;
    }
    exercised += 1;
    // Observe ZERO real push COMMANDS on a refused protected delta — not merely a missing remote
    // ref. The observer wraps only the publish call, so no fixture-setup push is counted.
    const obs = installGitObserver();
    let res;
    try {
      res = publishScoped(ws, cfg);
    } finally {
      obs.restore();
    }
    const counts = obs.counts();
    const { out, gh } = res;
    assert(out && out.ok === false && out.pushed === false && !out.prUrl,
      `${label}: a protected-Markdown delta was not refused: ${JSON.stringify(out)}`);
    assert.strictEqual(gh, '', `${label}: a PR was opened despite the refusal`);
    if (onLinux) {
      assert.strictEqual(counts.push, 0, `${label}: a git push was attempted for a refused protected delta (push calls: ${counts.push})`);
    }
    const onRemote = run('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${ws.branch}`]);
    assert.notStrictEqual(onRemote.status, 0, `${label}: the refused branch reached the remote`);
    assert(fs.existsSync(ws.dir), `${label}: the recoverable workspace was discarded`);
  }
  assert(exercised >= 5, `too few protected-Markdown delta kinds were exercisable: ${exercised}`);
  assert(!onLinux || exercised === forbidden.length,
    `the Linux gate did not exercise every protected-Markdown delta kind: ${exercised}/${forbidden.length}`);

  // A Git-inspection failure refuses rather than allowing publication: aim the delta inspection at
  // a non-existent fork point so the Git read cannot succeed.
  {
    const ws = makeWorkspace(base, remote, seed, (d) => fs.appendFileSync(path.join(d, 'src/app.js'), 'x\n'));
    const bad = { ...ws, forkPoint: '0'.repeat(40) };
    const res = publishScoped(bad, cfg);
    assert(res.out && res.out.ok === false && res.out.pushed === false,
      `a failed Git inspection did not fail closed: ${JSON.stringify(res.out)}`);
  }

  // A scoped product-only change (no protected-Markdown delta, src/README.md untouched) is
  // published normally: pushed and a PR opened — and the push COMMAND IS observed, so the
  // zero-push observations above are not vacuous.
  {
    const ws = makeWorkspace(base, remote, seed, (d) => fs.appendFileSync(path.join(d, 'src/app.js'), 'feature\n'));
    const obs = installGitObserver();
    let res;
    try { res = publishScoped(ws, cfg); } finally { obs.restore(); }
    const counts = obs.counts();
    const { out, gh } = res;
    assert(out && out.ok === true && out.pushed === true && out.prUrl,
      `a scoped product-only change was not published: ${JSON.stringify(out)}`);
    assert(/called/.test(gh), 'a scoped product-only change opened no PR');
    if (onLinux) {
      assert(counts.push >= 1, `the allowed product-only publication was expected to push, but no push command was observed: ${counts.push}`);
    }
  }

  // src/README.md is a Markdown file OUTSIDE the protected surface (only ROOT Markdown and
  // Markdown beneath docs/ are protected). ACTUALLY modifying it under a documentation-preserve
  // scope must still publish — proven through the real delta inspection and host publication.
  {
    const ws = makeWorkspace(base, remote, seed, (d) => fs.appendFileSync(path.join(d, 'src/README.md'), 'more src readme\n'));
    const changed = String(git(ws.dir, 'diff', '--name-status', '-M', ws.forkPoint, 'HEAD').stdout || '').trim();
    assert(/src\/README\.md/.test(changed), `src/README.md was not actually modified in the fixture: ${changed}`);
    const { out, gh } = publishScoped(ws, cfg);
    assert(out && out.ok === true && out.pushed === true && out.prUrl,
      `an allowed src/README.md change under a docs-preserve scope was wrongly refused: ${JSON.stringify(out)}`);
    assert(/called/.test(gh), 'the allowed src/README.md change opened no PR');
  }
});

// ── the real runOneTask fixture (host owns the scope snapshot end to end) ─────────────────────
// The seed the host clones carries the REAL verifier (tools/run-acceptance.sh) and a REAL
// acceptance suite the real verifier runs, so nothing authors a pass — the verifier genuinely
// passes iff the implementation created feature.txt.
function seedRunRepo(tmp, issueId, traceFile) {
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'tools'), { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'f@test.local');
  git(seed, 'config', 'user.name', 'f');
  git(seed, 'config', 'core.autocrlf', 'false');
  fs.copyFileSync(path.join(ROOT, 'tools', 'run-acceptance.sh'), path.join(seed, 'tools', 'run-acceptance.sh'));
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed root readme\n');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(seed, 'tests', 'acceptance', issueId), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tests', 'acceptance', issueId, 'test.js'),
    "'use strict';const fs=require('fs');const p=require('path');\n"
    + "const f=p.join(process.env.WORKSPACE||process.cwd(),'feature.txt');\n"
    + `fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({kind:'verify',cwd:process.cwd(),`
    + "feature:fs.existsSync(f),readme:fs.readFileSync(p.join(p.dirname(f),'README.md'),'utf8')})+'\\n');\n"
    + "if(fs.existsSync(f)){console.log('ok - feature present');process.exit(0);}\n"
    + "console.log('FAIL - feature.txt missing');process.exit(1);\n");
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  return { remote, seed };
}

// The external model command for the runOneTask container. On the implementation phase it always
// makes the verified product change (feature.txt); when `rogue` it ALSO writes a protected
// README.md delta and rewrites its own mounted issue file to try to drop the directive. On any
// documentation phase it records that it was asked to document and can make an allowed README
// change for the unrestricted controls. It captures the ACTUAL implementation stdin and mounted
// issue bytes before any tamper. The host snapshot must not budge. The tamper write is NOT
// swallowed: the mounted .run/issue.md must exist and
// the rewrite must succeed, so the test can re-read its changed bytes from the retained workspace.
function installRunAgent(file, callsLog, { rogue, docsChange, inputFile, traceFile }) {
  const lines = [
    "'use strict';const fs=require('fs');",
    "const prompt=fs.readFileSync(0,'utf8');const docs=prompt.includes('Verification for task');",
    `fs.appendFileSync(${JSON.stringify(callsLog)}, (docs?'docs':'impl')+'\\n');`,
    "const emit=(t)=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:t}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');};",
    'if(docs){',
    ...(docsChange ? ["  fs.writeFileSync('README.md','normal documentation delta\\n');"] : []),
    `  fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({kind:'docs',cwd:process.cwd()})+'\\n');`,
    "  emit('Reviewed documentation.');process.exit(0);",
    '}',
    `fs.writeFileSync(${JSON.stringify(inputFile)},JSON.stringify({cwd:process.cwd(),prompt,`
      + "mountedTask:fs.readFileSync('.run/issue.md','utf8')}));",
    "fs.writeFileSync('feature.txt','verified change\\n');",
  ];
  if (rogue) {
    lines.push("fs.writeFileSync('README.md','rogue container touched the protected docs surface\\n');");
    lines.push("fs.mkdirSync('.run',{recursive:true});");
    lines.push("fs.writeFileSync('.run/issue.md','tampered, no directive\\n');");
  }
  lines.push(`emit(${JSON.stringify(IMPL_SUMMARY)});process.exit(0);`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// The PIPELINE_EXEC_STUB the host launches in place of `docker run`: it drops the bd preload (so
// the real entrypoint's own node children are untouched) and execs the REAL pipeline entrypoint,
// which runs the REAL implementation, REAL verifier and REAL status/verify writers in the host's
// prepared workspace. Only the external model command and the external gh CLI are substituted.
const LAUNCHER_STUB = [
  '#!/bin/sh',
  'unset NODE_OPTIONS',
  'exec "$ACCEPTANCE_BASH_BIN" "$PIPELINE_DIR/entrypoint.sh"',
  '',
].join('\n');

// ONE parameterized integrated fixture for both directions. It drives the REAL serializer
// (execute), or consumes the same already-serialized issue from T2's unrestricted controls.
// Its default task has immutable constraints the planner contradicts. In every case it uses real
// queue.exportIssue -> runOneTask -> real entrypoint/verifier/status writers -> host collection
// -> real publish. The derived scope is NEVER injected into the entrypoint environment: production
// must transport it from the canonical export. Only the external model command, the external gh
// CLI and the delegating `git` observer are substituted.
async function runIntegratedScoped({ tag, rogue, ghCmd = "printf 'https://example.test/pr/2\\n'",
  bodyFile, serialized = null, docsChange = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `repo062-run-${tag}-`));
  temps.push(tmp);
  const w = serialized ? serialized.world : makeWorld(`run-${tag}`, {
    constraints: [DIRECTIVE_ALIAS, 'Keep the conveyor fixture public input contract stable.'],
    nonGoals: ['Do not introduce conveyor fixture runtime dependencies.'],
  });
  const result = serialized ? serialized.result : await runExecute(w);
  assert.strictEqual(result.status, 'ready', `${tag}: execute did not serialize the scoped issue: ${JSON.stringify(result)}`);
  const issueId = result.issueId;
  const traceFile = path.join(tmp, 'implementation-docs-verify.jsonl');
  const inputFile = path.join(tmp, 'implementation-input.json');
  const { remote, seed } = seedRunRepo(tmp, issueId, traceFile);

  const execStub = path.join(tmp, 'run-stub.sh');
  fs.writeFileSync(execStub, LAUNCHER_STUB);
  const agent = path.join(tmp, 'agent.js');
  const agentCalls = path.join(tmp, 'agent-calls.txt');
  fs.writeFileSync(agentCalls, '');
  installRunAgent(agent, agentCalls, { rogue, docsChange, inputFile, traceFile });
  const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('PIPELINE_EXEC_STUB', execStub);
  set('PIPELINE_DIR', path.join(ROOT, 'pipeline'));
  set('PIPELINE_PROVIDER', 'codex');
  set('PIPELINE_AGENT_CMD', `${quote(process.execPath)} ${quote(agent)}`);
  set('PIPELINE_TESTING_NESTED_ENTRYPOINT', '1');
  set('PIPELINE_MAX_ATTEMPTS', '1');
  set('PIPELINE_DOCS_USER', '');
  set('GIT_CONFIG_COUNT', '0');
  set('ACCEPTANCE_BASH_BIN', SHELL);
  set('PIPELINE_GH_CMD', ghCmd);
  const savedKeep = process.env.PIPELINE_KEEP_WORKSPACE; delete process.env.PIPELINE_KEEP_WORKSPACE;

  const log = logmod.startRun(path.join(tmp, 'runs-root'), `unit-repo062-${tag}`);
  const cfg = { targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 1, probeIntervalMinutes: 15, maxPauseCycles: 96, concurrency: 1 };
  const gate = { admit: async () => true, reportLimit: async () => ({ resumed: false }) };

  const obs = installGitObserver();
  let row = null; let threw = null;
  try {
    row = await runmod.runOneTask(cfg, { id: issueId, title: 'scoped', priority: 1 }, log, 'tok', gate);
  } catch (e) { threw = e; } finally {
    obs.restore();
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (savedKeep === undefined) delete process.env.PIPELINE_KEEP_WORKSPACE; else process.env.PIPELINE_KEEP_WORKSPACE = savedKeep;
  }
  const counts = obs.counts();
  const calls = fs.readFileSync(agentCalls, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const logText = fs.existsSync(log.logFile) ? fs.readFileSync(log.logFile, 'utf8') : '';
  const bodyDelivered = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
  const implementationInput = fs.existsSync(inputFile) ? JSON.parse(fs.readFileSync(inputFile, 'utf8')) : null;
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const publishedReadme = row && row.pushed && row.branch
    ? git(tmp, '--git-dir', remote, 'show', `refs/heads/${row.branch}:README.md`) : null;
  return { tmp, remote, seed, issueId, row, threw, counts, calls, log, logText,
    implementationInput, intentObj: w.intentObj, kickoffHash: w.kickoffHash, trace, publishedReadme, bodyDelivered };
}

function assertNormalDocs(fx, tag) {
  assert.strictEqual(fx.threw, null, `${tag}: runOneTask threw: ${fx.threw && fx.threw.stack}`);
  assert(fx.calls.includes('impl') && fx.calls.includes('docs'),
    `${tag}: unrestricted work must invoke implementation and documentation models: ${JSON.stringify(fx.calls)}`);
  if (onLinux) assert(fx.counts.worktreeAdd >= 1, `${tag}: normal docs must create a real docs worktree`);
  assert(fx.row && fx.row.verification && fx.row.verification.acceptance === 'pass' && !fx.row.docsPhaseError,
    `${tag}: normal docs must retain real verification without a docs error: ${JSON.stringify(fx.row)}`);
  assert(fx.row.pushed && fx.row.prUrl, `${tag}: the unrestricted docs change must publish`);
  assert(fx.publishedReadme && fx.publishedReadme.status === 0
    && fx.publishedReadme.stdout === 'normal documentation delta\n',
  `${tag}: the actual published branch must contain the allowed README delta`);
  const implVerify = fx.trace.findIndex((t) => t.kind === 'verify' && t.feature && t.readme === 'seed root readme\n');
  const docs = fx.trace.findIndex((t) => t.kind === 'docs');
  const finalVerify = fx.trace.findIndex((t, i) => i > docs && t.kind === 'verify'
    && t.feature && t.readme === 'normal documentation delta\n');
  assert(implVerify >= 0 && docs > implVerify && finalVerify > docs,
    `${tag}: real verification must bracket the docs delta: ${JSON.stringify(fx.trace)}`);
  assert(fx.implementationInput && path.resolve(fx.trace[docs].cwd) !== path.resolve(fx.implementationInput.cwd),
    `${tag}: the documentation model must run outside the implementation checkout`);
}

function assertImplementationIntent(fx) {
  const originalItems = [...fx.intentObj.constraints, ...fx.intentObj.nonGoals];
  assert(fx.intentObj.constraints.length > 1 && fx.intentObj.nonGoals.length > 0,
    'the integrated fixture must have original intent beyond the directive mentioned in planner prose');
  assert(originalItems.some((item) => !contradictingProposal().includes(item))
    && fx.intentObj.nonGoals.every((item) => !contradictingProposal().includes(item))
    && !contradictingProposal().includes(fx.kickoffHash),
  'the original nonGoals and kickoff hash must not be recoverable from the planner prose');
  assert(fx.implementationInput, 'the actual implementation model captured no input before tampering');
  for (const field of ['prompt', 'mountedTask']) {
    const text = fx.implementationInput[field];
    assert(typeof text === 'string', `the implementation model recorded no ${field}`);
    for (const item of originalItems) {
      assert(text.includes(item), `${field} dropped the exact original intent item ${JSON.stringify(item)}`);
    }
    assert(text.includes(fx.kickoffHash), `${field} dropped the exact original kickoff hash`);
  }
}

// ── T6 / C4,C3,C5 ─────────────────────────────────────────────────────────────────────────────
test('T6 C4,C3,C5 the FULL production path — real specification/serialization -> real queue.exportIssue -> real runOneTask -> real entrypoint/verifier -> real publish — transports the canonical exported scope as a host-owned snapshot into publication: a documentation-prohibited task whose container edits the protected Markdown surface AND rewrites its own mounted issue file is refused publication (ZERO push COMMANDS, ZERO PR CLI calls, workspace retained, no remote branch), while running the implementation (feature.txt, real verifier pass, exact IMPL_SUMMARY, no docsPhaseError) with ZERO docs model calls and ZERO docs worktree-add commands, the original intent reaches the mounted implementation input before the tamper, the container tamper is proven by re-reading the changed bytes, and the run log carries a bounded explicit documentation-omission line distinct from the publication error; a candidate that derives scope in a helper but leaves the host->publish connection missing cannot pass this', async () => {
  await withBd(async () => {
    const ghCmd = "printf called >> \"$PWD/.gh-called\"; printf 'https://example.test/pr/9\\n'";
    const fx = await runIntegratedScoped({ tag: 't6', rogue: true, ghCmd });
    assert.strictEqual(fx.threw, null, `runOneTask threw: ${fx.threw && fx.threw.stack}`);
    const row = fx.row;
    assert(row, 'runOneTask returned no manifest row');

    // The external model itself observed both actual inputs before rewriting its mounted issue.
    assertImplementationIntent(fx);

    // C4 through the collected canonical result (runner/run.js projections): the implementation is
    // verified, the exact IMPL_SUMMARY is retained, and there is NO docsPhaseError — intentional
    // omission is not a docs failure.
    assert(row.verification && row.verification.acceptance === 'pass',
      `the collected verification is not a real pass: ${JSON.stringify(row.verification)}`);
    assert.strictEqual(row.changeSummary, IMPL_SUMMARY,
      `the exact implementation change summary was not retained: ${JSON.stringify(row.changeSummary)}`);
    assert(!row.docsPhaseError,
      `an intentional documentation omission was recorded as a docsPhaseError: ${JSON.stringify(row.docsPhaseError)}`);

    // The actual agent-call trace: implementation ran, the docs model was never called.
    assert(fx.calls.includes('impl'), `the implementation model was never invoked: ${JSON.stringify(fx.calls)}`);
    assert(!fx.calls.includes('docs'), `the docs model was invoked for a documentation-prohibited task: ${JSON.stringify(fx.calls)}`);
    if (onLinux) {
      assert.strictEqual(fx.counts.worktreeAdd, 0,
        `a docs worktree was created (worktree-add commands: ${fx.counts.worktreeAdd})`);
    }

    // C5/C3: publication refused — zero push commands, zero PR CLI calls, workspace retained, no
    // remote branch. A container-editable issue file cannot weaken the host snapshot.
    assert.strictEqual(row.pushed, false, `the documentation-prohibited task pushed a protected-Markdown delta: ${JSON.stringify(row)}`);
    assert(!row.prUrl, `a PR was opened for a refused publication: ${JSON.stringify(row)}`);
    assert(typeof row.recoveryWorkspace === 'string' && fs.existsSync(row.recoveryWorkspace),
      `the recoverable workspace was not retained: ${JSON.stringify(row)}`);
    if (onLinux) {
      assert.strictEqual(fx.counts.push, 0, `a git push was attempted for a refused publication (push commands: ${fx.counts.push})`);
    }
    const ghMarker = path.join(row.recoveryWorkspace, '.gh-called');
    assert(!fs.existsSync(ghMarker) || fs.readFileSync(ghMarker, 'utf8') === '',
      'the external PR CLI was called despite the publication refusal (.gh-called marker present)');
    const onRemote = git(fx.tmp, '--git-dir', fx.remote, 'rev-parse', '--verify', `refs/heads/task/${fx.issueId}`);
    assert.notStrictEqual(onRemote.status, 0, 'the refused branch reached the remote');

    // The container tamper actually occurred: re-read the changed bytes of the mounted issue file
    // from the retained workspace (a swallowed catch would not prove this).
    const tamperedIssue = path.join(row.recoveryWorkspace, '.run', 'issue.md');
    assert(fs.existsSync(tamperedIssue), 'the retained workspace has no mounted issue file to inspect');
    const tamperedBytes = fs.readFileSync(tamperedIssue, 'utf8');
    assert(/tampered, no directive/.test(tamperedBytes) && !tamperedBytes.includes(DIRECTIVE_ALIAS),
      `the container issue-file tamper did not land in the mounted file: ${JSON.stringify(tamperedBytes)}`);

    // C4: a BOUNDED, EXPLICIT intentional-omission line — NOT merely any line mentioning
    // documentation. The publication-refusal error also names documentation, so require a
    // dedicated, short omission line that is NOT the publication/refusal/failure line.
    const lines = fx.logText.split(/\r?\n/);
    const omissionCandidates = lines.filter((l) => /document/i.test(l) && /(omit|skip|preserv|prohibit)/i.test(l));
    const cleanOmission = omissionCandidates.find((l) => l.length <= 300
      && !/(publish|publication|\bpush\b|refus|surface|\bPR\b|blocked|fail|incomplete|reject)/i.test(l));
    assert(cleanOmission,
      `the run log has no bounded explicit intentional-omission line distinct from the publication error: ${JSON.stringify(omissionCandidates)}`);
    try { fs.rmSync(row.recoveryWorkspace, { recursive: true, force: true }); } catch { /* temp */ }
  });
});

// The Spec can contain arbitrary documentation directives. Remove its exact captured bytes before
// looking for a bounded statement that the documentation phase was intentionally omitted. No new
// heading or exact sentence is prescribed; an embedded constraint is not a report of an omission.
function documentationOmissionOutsideSpec(body, mountedTask) {
  const spec = mountedTask.trim();
  if (!spec || !body.includes(spec)) return null;
  return body.split(spec).join('').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length <= 300
    && /\b(documentation|docs)\b/i.test(line)
    && (/\b(omitted|skipped|preserved|prohibited)\b/i.test(line) || /\bnot (run|invoked|performed)\b/i.test(line))
    && !/\b(error|failed|failure|warning|incomplete)\b/i.test(line)) || null;
}

// ── T7 / C4,C6 ───────────────────────────────────────────────────────────────────────────────
test('T7 C4,C6 the SAME full production path for a SUCCESSFUL documentation-prohibited scoped publication: a scoped product-only candidate is published by the host (real push observed, real PR CLI called) with ZERO docs model calls and ZERO docs worktree-add commands, the collected result retains the exact IMPL_SUMMARY, a real verifier pass and no docsPhaseError, and the PR_BODY the host delivers to the real gh CLI seam carries a bounded explicit documentation-omission note — never the existing "Documentation phase warning" — with the implementation change summary preserved verbatim; a hand-invented direct publish call does not substitute for this connected observation', async () => {
  await withBd(async () => {
    const tmpBody = fs.mkdtempSync(path.join(os.tmpdir(), 'repo062-prbody-'));
    temps.push(tmpBody);
    const bodyFile = path.join(tmpBody, 'pr-body.txt');
    fs.writeFileSync(bodyFile, '');
    const ghCmd = `printf called >> "$PWD/.gh-called"; printf '%s' "$PR_BODY" > ${bodyFile.split(path.sep).join('/')}; printf 'https://example.test/pr/7\\n'`;
    const fx = await runIntegratedScoped({ tag: 't7', rogue: false, ghCmd, bodyFile });
    assert.strictEqual(fx.threw, null, `runOneTask threw: ${fx.threw && fx.threw.stack}`);
    const row = fx.row;
    assert(row, 'runOneTask returned no manifest row');
    assertImplementationIntent(fx);

    // The implementation ran; the docs model and the docs worktree did not.
    assert(fx.calls.includes('impl'), `the implementation model was never invoked: ${JSON.stringify(fx.calls)}`);
    assert(!fx.calls.includes('docs'), `the docs model was invoked for a documentation-prohibited task: ${JSON.stringify(fx.calls)}`);
    if (onLinux) {
      assert.strictEqual(fx.counts.worktreeAdd, 0,
        `a docs worktree was created (worktree-add commands: ${fx.counts.worktreeAdd})`);
    }

    // The collected canonical result: verified pass, exact IMPL_SUMMARY retained, no docsPhaseError.
    assert(row.verification && row.verification.acceptance === 'pass',
      `the collected verification is not a real pass: ${JSON.stringify(row.verification)}`);
    assert.strictEqual(row.changeSummary, IMPL_SUMMARY,
      `the exact implementation change summary was not retained: ${JSON.stringify(row.changeSummary)}`);
    assert(!row.docsPhaseError,
      `an intentional documentation omission was recorded as a docsPhaseError: ${JSON.stringify(row.docsPhaseError)}`);

    // C6: the allowed product-only candidate is actually published — real push observed and the
    // real PR CLI called.
    assert.strictEqual(row.pushed, true, `the scoped product-only candidate was not pushed: ${JSON.stringify(row)}`);
    assert(row.prUrl, `the scoped product-only candidate opened no PR: ${JSON.stringify(row)}`);
    if (onLinux) {
      assert(fx.counts.push >= 1, `the allowed publication was expected to push, but no push command was observed: ${fx.counts.push}`);
    }

    // The PR_BODY the host delivered to the real gh CLI seam carries a bounded explicit
    // documentation-omission note, never the existing failure warning, and preserves the exact
    // implementation change summary.
    const body = fx.bodyDelivered;
    assert(body && body.length > 0, 'the gh PR CLI seam received no PR body at all');
    const mountedTask = fx.implementationInput.mountedTask;
    assert(body.includes(mountedTask.trim()), 'the delivered PR body must contain the actual mounted task Spec');
    const specOnlyBody = `## Spec\n\n${mountedTask.trim()}\n\n## Change summary\n\n${IMPL_SUMMARY}`
      + '\n\n## Verification evidence\n\n- Acceptance tests: **pass**\n';
    assert.strictEqual(documentationOmissionOutsideSpec(specOnlyBody, mountedTask), null,
      'a PR body containing documentation constraints in Spec but no omission note must fail the note predicate');
    assert(documentationOmissionOutsideSpec(specOnlyBody + '\nDocumentation intentionally omitted by request.\n', mountedTask),
      'the omission predicate must accept an explicit note outside Spec');
    assert(documentationOmissionOutsideSpec(body, mountedTask),
      `the delivered PR body carries no bounded explicit documentation-omission note outside Spec: ${body.slice(-800)}`);
    assert(!/Documentation phase warning/i.test(body),
      'the intentional omission was rendered as the existing documentation-FAILURE warning');
    assert(body.includes(IMPL_SUMMARY), 'the delivered PR body lost the exact implementation change summary');
  });
});

(async () => {
  // The fixture precondition runs FIRST. A failure here is a harness/setup defect, printed as a
  // `harness` line so it can never be mistaken for a discriminating feature RED, and the suite
  // stops before any feature assertion runs against a broken adapter.
  try {
    await bdSelfTest();
  } catch (error) {
    console.log(`FAIL - harness — FIXTURE SETUP: the stateful bd adapter did not round-trip through the production seam: ${error && error.message ? error.message : error}`);
    for (const dir of temps.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
    }
    if (savedStateDir === undefined) delete process.env.PIPELINE_STATE_DIR;
    else process.env.PIPELINE_STATE_DIR = savedStateDir;
    process.exit(1);
  }

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
