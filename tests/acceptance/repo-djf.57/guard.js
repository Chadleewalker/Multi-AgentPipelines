// Frozen acceptance test — repo-djf.57, the [guard] half: the behaviour the "make kickoff task
// lookup compatible with the installed Beads CLI" change must NOT alter.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the lookup fix (see test.js) has to PRESERVE while it teaches production beadsFind a
// valid query, every-status and no-truncation semantics: a failed or malformed lookup still
// aborts BEFORE any issue creation or receipt and leaves durable evidence intact (C3); the runner
// subprocess time bound still kills a wedged bd call and surfaces it loudly (C3); pinned design
// validation still resolves a present reference and refuses an absent one at the pinned commit
// (C3); production beadsCreate still crosses the real runner/bd JSON boundary, carries native
// fields, and returns the parsed JSON identity regardless of --silent (C3); the installed bd CLI
// is reachable read-only for a separate smoke (C1); and the CLI-faithful fixture the RED suite
// leans on never simply succeeds regardless of argv — it refuses the current queryless invocation,
// a missing --json and an unknown verb (C1, C3). Nothing red belongs here — a [guard] file red at
// the fork point is a stale pin and refuses the freeze.
//
// SELF-CONTAINED: Node built-ins, a real local Git repo, and the same child-process bd fixture the
// RED suite uses (reached through the REAL runner/bd JSON boundary). No provider key, no real Beads
// binary or host Beads database (the installed-CLI smoke is read-only and touches no database), no
// network, no container engine. Durable state is re-aimed into a temp tree via PIPELINE_STATE_DIR.
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
const bdmod = require(path.join(ROOT, 'runner', 'bd.js'));

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'BD_FIXTURE_DB', 'BD_FIXTURE_SEARCH',
  'BD_FIXTURE_CREATE']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf57g-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// The same CLI-faithful bd fixture as test.js (see its header for the full rationale): a real
// child process, reached through the production runner/bd boundary, modelling installed bd 1.1.2.
const FIXTURE_SRC = [
  "'use strict';",
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  'const argv = process.argv.slice(1);',
  'argv[0] = require("path").relative(process.cwd(), argv[0]);',
  'const write = (s) => fs.writeSync(1, s);',
  'const fail = (code, msg) => { if (msg) fs.writeSync(2, msg); process.exit(code); };',
  'const verb = argv[0];',
  'const SEARCH_MODE = process.env.BD_FIXTURE_SEARCH || "ok";',
  'const CREATE_MODE = process.env.BD_FIXTURE_CREATE || "ok";',
  'const DB = process.env.BD_FIXTURE_DB;',
  'if (verb === "search" && SEARCH_MODE === "hang") {',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);',
  '  process.exit(0);',
  '}',
  'if (!argv.includes("--json")) fail(2, "bd fixture: the runner must always request --json");',
  'function flagValuesAll(name) {',
  '  const out = [];',
  '  for (let i = 1; i < argv.length; i++) {',
  '    const a = argv[i];',
  '    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);',
  '    else if (a.indexOf(name + "=") === 0) out.push(a.slice(name.length + 1));',
  '  }',
  '  return out;',
  '}',
  'const flagValue = (name) => { const v = flagValuesAll(name); return v.length ? v[0] : undefined; };',
  'const hasBool = (name) => argv.indexOf(name) >= 0;',
  'function readDb() { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch (e) { return { rows: [], creates: [] }; } }',
  'function writeDb(db) { fs.writeFileSync(DB, JSON.stringify(db)); }',
  'if (verb === "search") {',
  "  const VALUED = new Set([\"--external-contains\", \"--status\", \"--limit\", \"--query\", \"-s\", \"-n\"]);",
  "  const flags = {};",
  "  let query = null;",
  "  for (let i = 1; i < argv.length; i++) {",
  "    const a = argv[i];",
  "    if (a === \"--json\" || a === \"--readonly\") continue;",
  "    const eq = a.startsWith(\"--\") ? a.indexOf(\"=\") : -1;",
  "    const name = eq >= 0 ? a.slice(0, eq) : a;",
  "    if (VALUED.has(name)) {",
  "      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];",
  "      if (value === undefined) fail(2, \"bd search: missing flag value\");",
  "      flags[name === \"-s\" ? \"--status\" : name === \"-n\" ? \"--limit\" : name] = value;",
  "      continue;",
  "    }",
  "    if (a.startsWith(\"-\")) fail(2, \"bd search: unknown flag \" + a);",
  "    if (query !== null) fail(2, \"bd search: too many query arguments\");",
  "    query = a;",
  "  }",
  "  if (flags[\"--query\"] !== undefined) query = flags[\"--query\"];",
  "  if (query === null || !String(query).trim()) fail(2, \"bd search: a non-empty query is required\");",
  "  const external = flags[\"--external-contains\"];",
  "  if (typeof external !== \"string\" || !external.length) fail(2, \"fixture contract: external-reference filter is required\");",
  "  const ext = external.toLowerCase();",
  "  const requestedStatus = flags[\"--status\"];",
  "  const requestedLimit = flags[\"--limit\"] === undefined ? 50 : Number(flags[\"--limit\"]);",
  "  if (!Number.isInteger(requestedLimit)) fail(2, \"bd search: invalid limit\");",
  "  const limit = requestedLimit <= 0 ? Infinity : requestedLimit;",
  "  // Observed bd 1.1.2 title search uses SQL LIKE: % and _ are wildcards, * is literal.",
  "  const pattern = Array.from(String(query), c => c === \"%\" ? \".*\" : c === \"_\" ? \".\" : \"\\\\^$.*+?()[]{}|\".includes(c) ? \"\\\\\" + c : c).join(\"\");",
  "  const titleQuery = new RegExp(pattern, \"i\");",
  "  const db = readDb();",
  "  const matched = (db.rows || []).filter((r) => {",
  "    const ref = r.external_ref !== undefined ? r.external_ref : r.externalRef;",
  "    const contains = typeof ref === \"string\" && ref.toLowerCase().indexOf(ext) >= 0;",
  "    const status = r.status || \"open\";",
  "    const statusMatches = requestedStatus === \"all\" || (requestedStatus === undefined ? status !== \"closed\" : status === requestedStatus);",
  "    return contains && titleQuery.test(String(r.title || \"\")) && statusMatches;",
  "  });",
  "  const rows = limit === Infinity ? matched : matched.slice(0, limit);",
  '  if (SEARCH_MODE === "nonzero") fail(1, "bd search: injected non-zero exit");',
  '  if (SEARCH_MODE === "malformed") { write("{ not valid json"); process.exit(0); }',
  '  write(JSON.stringify(rows));',
  '  process.exit(0);',
  '}',
  'if (verb === "create") {',
  '  const ref = flagValue("--external-ref");',
  '  const title = (argv[1] && argv[1].indexOf("-") !== 0) ? argv[1] : null;',
  '  const db = readDb();',
  '  const id = "bd-created-" + crypto.createHash("sha256").update(String(ref) + ":" + (db.creates || []).length).digest("hex").slice(0, 12);',
  '  const row = { id: id, external_ref: ref, title: title, status: "open" };',
  '  const persist = () => { (db.rows = db.rows || []).push(row); (db.creates = db.creates || []).push({ id: id, external_ref: ref, argv: argv }); writeDb(db); };',
  '  if (CREATE_MODE === "nonzero") fail(1, "bd create: injected non-zero exit");',
  '  if (CREATE_MODE === "malformed") { write("not json"); process.exit(0); }',
  '  if (CREATE_MODE === "persist-then-nonzero") { persist(); fail(1, "bd create: response failed after the issue was persisted"); }',
  '  if (CREATE_MODE === "persist-then-malformed") { persist(); write("}{ not json"); process.exit(0); }',
  '  persist();',
  '  write(JSON.stringify(row));',
  '  process.exit(0);',
  '}',
  'fail(2, "bd fixture: unsupported verb " + String(verb));',
].join('\n');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djf57g-bdfix-'));
temps.push(fixtureDir);
const FIXTURE_PATH = path.join(fixtureDir, 'bd-fixture.js');
fs.writeFileSync(FIXTURE_PATH, FIXTURE_SRC);
const FIXTURE_REQUIRE = FIXTURE_PATH.split(path.sep).join('/');

async function withBdFixture(opts, fn) {
  const saved = {};
  const env = {
    PIPELINE_BD_CMD: process.execPath,
    PIPELINE_IMAGE_BD_CMD: undefined,
    BD_FIXTURE_DB: opts.db,
    BD_FIXTURE_SEARCH: opts.search || 'ok',
    BD_FIXTURE_CREATE: opts.create || 'ok',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require "${FIXTURE_REQUIRE}"`,
  };
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

function newDb(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djf57g-db-')), 'bd.json');
  temps.push(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify({ rows: rows || [], creates: [] }));
  return p;
}
const readDb = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function writeKickoff(targetRepoPath, tag) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1', title: `repo-djf.57 guard ${tag}`, description: '',
    constraints: [], examples: [], nonGoals: [], priority: 2, relations: [], origin: null,
  };
  const intent = JSON.stringify(intentObj);
  const record = {
    version: 'kickoff-intake/1', id, target: paths.target, hash: sha256(intent), intent,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { id, hash: record.hash, title: intentObj.title, priority: intentObj.priority };
}

function makeWorld(tag, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf57g-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.57 guard');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'README.md'),
    '# pipeline-fixture\n\nThe pinned design-reference fixture heading for repo-djf.57.\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'integration base');
  const A = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-djf57-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 15000, wallClockMinutes: 2, ...extraCfg,
  }, null, 2)}\n`);
  const k = writeKickoff(target, tag);
  assert(/^[0-9a-f]{40}$/.test(A), `guard fixture ${tag} did not pin a 40-hex integration commit: ${A}`);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash, title: k.title, priority: k.priority,
    externalRef: `kickoff-spec:${k.hash}` };
}

const READY = {
  spec: 'Resolve the immutable kickoff intent into one canonical specification for repo-djf.57.',
  acceptanceCriteria: ['the design reference resolves at the pinned integration commit'],
  designReferences: ['README.md#pipeline-fixture'],
  difficulty: 'medium',
  status: 'ready',
};

function makeAdapters(w, overrides = {}) {
  const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
  adapters.launchCodex = async () => JSON.stringify(READY);
  for (const key of Object.keys(overrides)) adapters[key] = overrides[key];
  return adapters;
}

const receiptsDir = (target) => path.join(kickoffApi.statePathsFor(target).state, 'specification', 'receipts');

// ── G1 / C3 [guard] ─────────────────────────────────────────────────────────────────────────
test('G1 C3 [guard] a lookup CLI failure — both a non-zero exit and malformed search JSON — aborts before any issue creation or receipt and leaves existing durable evidence intact', async () => {
  for (const mode of ['nonzero', 'malformed']) {
    const w = makeWorld(`g1-${mode}`);
    const db = newDb([]);
    // Existing, unrelated durable evidence that a lookup failure must not disturb.
    fs.mkdirSync(receiptsDir(w.target), { recursive: true });
    const evidence = path.join(receiptsDir(w.target), 'unrelated-kickoff.json');
    fs.writeFileSync(evidence, JSON.stringify({ kept: true, mode }));
    const before = fs.readFileSync(evidence);

    await assert.rejects(
      withBdFixture({ db, search: mode }, () => specify.execute(
        { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w))),
      `execute did not abort on a ${mode} lookup`);

    assert.strictEqual(readDb(db).creates.length, 0, `a ${mode} lookup created an issue before failing`);
    const receipt = await withBdFixture({ db }, () => makeAdapters(w).readReceipt(w.kickoffHash));
    assert.strictEqual(receipt, null, `a ${mode} lookup published a receipt`);
    assert(before.equals(fs.readFileSync(evidence)), `a ${mode} lookup disturbed existing durable evidence`);
  }
});

// ── G2 / C3 [guard] ─────────────────────────────────────────────────────────────────────────
test('G2 C3 [guard] the runner subprocess time bound still governs a wedged bd lookup: a bd child that never returns is killed at bdTimeoutMs and surfaced as a loud, self-describing timeout failure rather than hanging the run', async () => {
  const w = makeWorld('g2', { bdTimeoutMs: 1500 });
  const db = newDb([]);
  const adapters = makeAdapters(w);
  const started = Date.now();
  let threw = null;
  try {
    await withBdFixture({ db, search: 'hang' }, () => adapters.beadsFind(w.externalRef));
  } catch (e) { threw = e; }
  const elapsed = Date.now() - started;
  assert(threw, 'a wedged bd lookup did not surface as a failure');
  assert(/timed out/i.test(threw.message || ''), `the timeout was not surfaced loudly: ${threw && threw.message}`);
  assert(elapsed < 30000, `the bound did not actually fire (elapsed ${elapsed}ms); the call really hung`);
});

// ── G3 / C3 [guard] ─────────────────────────────────────────────────────────────────────────
test('G3 C3 [guard] pinned design validation is unchanged: production validateDesignReference resolves a reference present at the pinned commit A and refuses a neighbouring absent anchor', async () => {
  const w = makeWorld('g3');
  const adapters = makeAdapters(w);
  const present = await adapters.validateDesignReference('README.md#pipeline-fixture', w.A);
  assert(present && present.ok === true, `a present reference was refused at A: ${JSON.stringify(present)}`);
  const absent = await adapters.validateDesignReference('README.md#no-such-anchor', w.A);
  assert(absent && absent.ok === false, `an absent anchor was accepted at A: ${JSON.stringify(absent)}`);
});

// ── G4 / C3 [guard] ─────────────────────────────────────────────────────────────────────────
test('G4 C3 [guard] production beadsCreate still crosses the REAL runner/bd JSON boundary: it carries the native title/design/priority/external-ref/metadata fields, and returns the identity parsed from the CLI JSON output — even though it also passes --silent', async () => {
  const w = makeWorld('g4');
  const db = newDb([]);
  const adapters = makeAdapters(w);
  const request = {
    title: 'guard create title', description: 'guard body',
    acceptanceCriteria: ['crosses the real bd boundary'],
    designReferences: ['README.md#pipeline-fixture'], difficulty: 'medium',
    priority: 2, kickoffHash: w.kickoffHash, specHash: sha256('spec'),
    externalRef: w.externalRef, metadata: { kickoffHash: w.kickoffHash, integrationCommit: w.A },
  };
  const issue = await withBdFixture({ db }, () => adapters.beadsCreate(request));
  const persisted = readDb(db);
  assert.strictEqual(persisted.creates.length, 1, `beadsCreate did not cross the boundary exactly once: ${persisted.creates.length}`);
  const created = persisted.creates[0];
  assert(issue && issue.id === created.id, `beadsCreate did not return the JSON identity: ${JSON.stringify(issue)}`);
  const cargv = created.argv;
  const at = (flag) => cargv[cargv.indexOf(flag) + 1];
  assert.strictEqual(cargv[0], 'create', 'the captured bd call was not a create');
  assert.strictEqual(at('--external-ref'), w.externalRef, '--external-ref did not carry the external reference');
  assert.strictEqual(at('--priority'), '2', '--priority did not carry the native priority');
  assert(String(at('--design')).includes('README.md#pipeline-fixture'), '--design did not carry the native design reference');
  assert(cargv.includes('--silent'), 'beadsCreate no longer passes --silent (the guard pins the observed invocation)');
  assert(cargv.includes('--json'), 'the create did not cross the JSON boundary');
});

// ── G5 / C1 [guard] ─────────────────────────────────────────────────────────────────────────
test('G5 C1 [guard] read-only installed-CLI smoke, recorded separately: the runner bd probe reports either no host bd or a reachable one, and where present it answers a read-only, database-free invocation', async () => {
  const w = makeWorld('g5');
  const cfg = { targetRepoPath: w.target, bdTimeoutMs: 15000 };
  const spec = bdmod.hostBdSpec();
  assert(spec === null || (spec && typeof spec.cmd === 'string' && Array.isArray(spec.pre)),
    `the host bd probe returned an unexpected shape: ${JSON.stringify(spec)}`);
  if (spec === null) {
    console.log('[guard] G5 SMOKE: no host bd installed — the read-only installed-CLI smoke is recorded as not-applicable');
    return;
  }
  // A read-only, database-free invocation of the installed CLI (prints help; opens no database).
  const result = bdmod.bdOnHost(cfg, ['--help']);
  assert(result && typeof result === 'object', 'the installed bd did not answer a read-only --help invocation');
  console.log(`[guard] G5 SMOKE: installed host bd reachable read-only via ${spec.cmd} (--help status ${JSON.stringify(result.status)})`);
});

// ── G6 / C1,C3 [guard] ──────────────────────────────────────────────────────────────────────
test('G6 C1,C3 [guard] the CLI-faithful bd fixture never simply succeeds regardless of argv: through the REAL runner/bd boundary it refuses the current adapter queryless search, an unknown verb, and a search missing --json — which is exactly why the RED suite fails at the fork point', async () => {
  const w = makeWorld('g6');
  const db = newDb([{ id: 'bd-x', external_ref: w.externalRef, title: 't', status: 'open' }]);
  const cfg = { targetRepoPath: w.target, bdTimeoutMs: 15000 };

  // The exact queryless invocation the current production beadsFind emits.
  const queryless = await withBdFixture({ db }, () => bdmod.bdJson(cfg, ['search', '--external-contains', w.externalRef]));
  assert.strictEqual(queryless.ok, false, `the fixture accepted the queryless search the current adapter emits: ${JSON.stringify(queryless)}`);

  const unknown = await withBdFixture({ db }, () => bdmod.bdJson(cfg, ['frobnicate', '--external-contains', w.externalRef]));
  assert.strictEqual(unknown.ok, false, `the fixture accepted an unknown verb: ${JSON.stringify(unknown)}`);

  // Missing --json: bd() (not bdJson) does not append --json, so the fixture sees no --json.
  const noJson = await withBdFixture({ db }, () => bdmod.bd(cfg, ['search', w.externalRef, '--external-contains', w.externalRef]));
  assert(noJson.status !== 0, `the fixture accepted a call that did not request --json: status ${JSON.stringify(noJson.status)}`);

  // And a well-formed query IS accepted — proving the refusals above are about faithfulness, not a
  // fixture that fails everything.
  const wellFormed = await withBdFixture({ db }, () => bdmod.bdJson(cfg,
    ['search', '%', '--external-contains', w.externalRef, '--status', 'all', '--limit', '1000']));
  assert.strictEqual(wellFormed.ok, true, `the fixture refused a well-formed query: ${JSON.stringify(wellFormed)}`);
  assert(Array.isArray(wellFormed.data) && wellFormed.data.some((r) => r.external_ref === w.externalRef),
    `a well-formed query did not return the seeded row: ${JSON.stringify(wellFormed.data)}`);

  for (const query of ['*', w.externalRef]) {
    const wrongQuery = await withBdFixture({ db }, () => bdmod.bdJson(cfg,
      ['search', query, '--external-contains', w.externalRef, '--status', 'all', '--limit', '0']));
    assert(wrongQuery.ok && wrongQuery.data.length === 0,
      'the fixture ignored a title query that cannot match the seeded title');
  }
  for (const unsupported of ['--all', '--external-ref', '--external']) {
    const refused = await withBdFixture({ db }, () => bdmod.bdJson(cfg,
      ['search', '%', '--external-contains', w.externalRef, unsupported, 'unused']));
    assert.strictEqual(refused.ok, false, 'the fixture accepted an unsupported search flag');
  }
  const pagedDb = newDb(Array.from({ length: 60 }, (_, i) => ({
    id: 'bd-page-' + i, external_ref: w.externalRef, title: 'fixture title ' + i,
    status: i === 59 ? 'closed' : 'open',
  })));
  for (const [flags, count] of [
    [[], 50],
    [['--status', 'all'], 50],
    [['--status', 'all', '--limit', '0'], 60],
    [['--status', 'closed', '--limit', '0'], 1],
    [['--status', 'open', '--limit', '0'], 59],
    [['--status', '*', '--limit', '0'], 0],
  ]) {
    const page = await withBdFixture({ db: pagedDb }, () => bdmod.bdJson(cfg,
      ['search', '%', '--external-contains', w.externalRef, ...flags]));
    assert(page.ok && page.data.length === count,
      'the fixture conflated status selection or explicit unlimited results with the default page');
  }
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
