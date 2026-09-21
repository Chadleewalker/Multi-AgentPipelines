// Frozen acceptance test — repo-djf.57: make kickoff task lookup compatible with the installed
// Beads CLI. This is the RED half of the suite; `guard.js` beside it carries the "existing
// behaviour X still holds" invariants this change must PRESERVE (they are green at the fork point
// and labelled as guards there). Between the two files every criterion is covered in BOTH
// directions.
//
// WHY THIS FILE IS RED TODAY (the reproduced defect). `scripts/specify-proposal.js`'s production
// `beadsFind` adapter looks a spec up with
//     bdJson(cfg, ['search', '--external-contains', externalRef])
// — a QUERYLESS `bd search`. The installed bd 1.1.2 CLI refuses a search with no query term, so
// against a CLI-faithful process the current call fails outright; and even where it did not, the
// call passes NO status filter (so a closed issue is invisible) and NO --limit (so a match past
// the default 50-row page is truncated away). The fix must issue a valid non-empty query WITH its
// external-reference filter, include every status, and lift the 50-row default, while keeping the
// exact case-sensitive `external_ref`/`externalRef` identity match the adapter already performs.
// Until then every check below fails: the CLI-faithful fixture rejects the queryless invocation.
//
// COMPOSITION. These checks call the REAL production adapter and the REAL runner/bd JSON boundary
// (`runner/bd.js` bdJson -> bd -> the `PIPELINE_BD_CMD` child process), never a replacement
// beadsFind. The only seams substituted are external: the model provider (`launchCodex`), the
// Beads CLI itself (a real child-process fixture reached through `PIPELINE_BD_CMD`), and the
// crash injection point (`crash`, a test seam the module already exposes). The child-process
// fixture models the observed installed bd 1.1.2 command semantics — it never simply returns
// success regardless of argv.
//
// CRITERION PAIRING — every check names its criterion, every criterion names >=1 check here or in
// guard.js:
//   C1  lookup uses a valid non-empty query + external-reference filter, every status, no 50-row
//       truncation, exact case-sensitive external_ref/externalRef identity.  -> T1, T1neg
//                                                                    (+ guard G5 smoke, G6 fixture)
//   C2  through production execute+beadsFind/beadsCreate (only external seams substituted): reuse
//       an exact closed issue beyond 50 rows without creating; else create once retaining native
//       fields, return the real JSON identity, write a valid receipt; receipt replay creates
//       nothing; crash-after-create restart reuses the same external-reference issue; snake_case
//       and camelCase exact-reference fields.       -> T2a, T2b, T2c, T2d, T2e
//   C3  lookup/create failure aborts before creation/receipt and leaves evidence intact; a failed
//       or malformed create publishes no receipt, and a create that persisted before failing is
//       recovered on restart through the exact external-reference path without a duplicate.
//                                                    -> T3 (+ guards G1,G2,G3,G4,G6)
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case. No provider key, no real
// Beads binary or host Beads database, no network, no container engine, no recursive runner.
// Every durable store is re-aimed into a disposable temp tree via PIPELINE_STATE_DIR.
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

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'BD_FIXTURE_DB', 'BD_FIXTURE_SEARCH',
  'BD_FIXTURE_CREATE']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf57-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

// The module's own hash formula, reproduced (it is not exported) so a receipt's validity and the
// derived external reference can be asserted the same way `execute` computes them.
const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The CLI-faithful `bd` fixture. Written to a temp file and reached as a REAL child process
// through the production runner/bd boundary. `runner/bd.js` spawns `PIPELINE_BD_CMD` with the bare
// bd argument vector; we set PIPELINE_BD_CMD to the Node binary and preload this file via
// NODE_OPTIONS=--require, so it sees the exact argv, answers, and exits before Node ever tries to
// load the phantom "search"/"create" main module. It models installed bd 1.1.2: a queryless
// search is refused, the default page is 50 rows, closed issues are hidden unless every status is
// requested, and the external-reference filter narrows by substring. It NEVER simply succeeds
// regardless of argv.
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
  '// A search hang must block BEFORE anything else, so the runner spawn timeout is what ends it.',
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

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djf57-bdfix-'));
temps.push(fixtureDir);
const FIXTURE_PATH = path.join(fixtureDir, 'bd-fixture.js');
fs.writeFileSync(FIXTURE_PATH, FIXTURE_SRC);
const FIXTURE_REQUIRE = FIXTURE_PATH.split(path.sep).join('/');

// Run `fn` with the real bd boundary wired to the child-process fixture. NODE_OPTIONS is set only
// for the duration of the call and restored afterwards; the only Node child a specify-proposal run
// spawns is bd itself (everything else is git), so the preload reaches nothing else.
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
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djf57-db-')), 'bd.json');
  temps.push(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify({ rows: rows || [], creates: [] }));
  return p;
}
const readDb = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// >50 candidate rows that all satisfy an `--external-contains <externalRef>` filter, with the one
// exact-identity issue placed LAST (index 57, beyond the default 50-row page) and marked closed.
// The distractors exercise every wrong way to match: substring supersets of the reference, a
// case-folded reference, and a same-title row. Only the last row's external reference is exactly
// equal to `externalRef`.
function seedBeyond50(externalRef, exact, sameTitle) {
  const rows = [];
  for (let i = 0; i < 55; i++) {
    rows.push({ id: `bd-dup-${i}`, external_ref: `${externalRef}-dup-${i}`, title: `distractor ${i}`, status: 'open' });
  }
  rows.push({ id: 'bd-case-folded', external_ref: externalRef.toUpperCase(), title: 'case distractor', status: 'open' });
  rows.push({ id: 'bd-title-twin', external_ref: `zz-prefix-${externalRef}`, title: sameTitle || 'title distractor', status: 'open' });
  rows.push(exact);
  return rows;
}

function writeKickoff(targetRepoPath, tag) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1', title: `repo-djf.57 fixture ${tag}`, description: '',
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

// A real Git repo whose integration branch `main` has README.md#pipeline-fixture at HEAD (= the
// pinned commit A), a valid run config (codexAuth chatgpt), and a durable kickoff record.
function makeWorld(tag, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf57-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.57 fixture');
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
  assert(/^[0-9a-f]{40}$/.test(A), `fixture ${tag} did not pin a 40-hex integration commit: ${A}`);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash, title: k.title, priority: k.priority,
    externalRef: `kickoff-spec:${k.hash}` };
}

// The one ready proposal, whose single design reference is exactly the candidate production
// discovery derives from README.md#pipeline-fixture at commit A (so REAL validateDesignReference
// resolves it, and execute reaches the Beads lookup under test).
const READY = {
  spec: 'Resolve the immutable kickoff intent into one canonical specification for repo-djf.57.',
  acceptanceCriteria: ['the design reference resolves at the pinned integration commit'],
  designReferences: ['README.md#pipeline-fixture'],
  difficulty: 'medium',
  status: 'ready',
};

// Compose the REAL production adapters, substituting only external seams: the model provider and
// (optionally) the crash injection point. beadsFind/beadsCreate, integration resolution, checkout
// lifecycle, candidate discovery, design validation and receipt persistence all run production
// code; the bd CLI is the real child-process fixture reached through PIPELINE_BD_CMD.
function makeAdapters(w, overrides = {}) {
  const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
  adapters.launchCodex = async () => JSON.stringify(READY);
  for (const key of Object.keys(overrides)) adapters[key] = overrides[key];
  return adapters;
}

// A local mirror of the module's (unexported) validReceipt, so "one valid receipt" is asserted by
// the same rule execute persists under.
function validReceipt(r, kickoffHash) {
  if (!r || typeof r !== 'object' || r.kickoffHash !== kickoffHash) return false;
  if (!specify.validateProposal(r.proposal) || r.proposal.status !== 'ready') return false;
  if (r.specHash !== sha256(r.proposal)) return false;
  if (!(typeof r.issueId === 'string' && r.issueId.trim().length > 0)) return false;
  if (!/^[0-9a-f]{40}$/.test(r.integrationCommit || '')) return false;
  if (r.receiptHash !== undefined) {
    const body = { ...r }; delete body.receiptHash;
    if (r.receiptHash !== sha256(body)) return false;
  }
  return true;
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 production beadsFind — through the REAL runner/bd JSON boundary and a CLI-faithful bd fixture — returns the exact-identity closed issue that sits beyond the default 50-row page, for both a snake_case external_ref row and a camelCase externalRef row, never a substring/case-folded/same-title distractor (RED today: the queryless invocation is refused by the installed-CLI-faithful fixture)', async () => {
  for (const style of ['external_ref', 'externalRef']) {
    const w = makeWorld(`t1-${style}`);
    const exact = { id: `bd-exact-${style}`, title: 'the genuinely matching spec', status: 'closed' };
    exact[style] = w.externalRef;
    const db = newDb(seedBeyond50(w.externalRef, exact, 'the genuinely matching spec'));
    const adapters = makeAdapters(w);

    const found = await withBdFixture({ db }, () => adapters.beadsFind(w.externalRef));
    assert(found && typeof found === 'object',
      `beadsFind did not return the exact closed issue beyond row 50 for ${style}: ${JSON.stringify(found)}`);
    assert.strictEqual(found.id, exact.id,
      `beadsFind returned the wrong row for ${style} (a distractor or truncated page?): ${JSON.stringify(found)}`);
    const ref = found.external_ref !== undefined ? found.external_ref : found.externalRef;
    assert.strictEqual(ref, w.externalRef, `the returned row is not the exact external reference: ${JSON.stringify(found)}`);
  }
});

// ── T1neg / C1 ───────────────────────────────────────────────────────────────────────────────
test('T1neg C1 production beadsFind returns null when the candidate page holds only substring, case-folded and same-title distractors and no exact-identity row — identity is exact and case-sensitive, not substring, case-folded or title (RED today: the queryless invocation is refused before any matching can happen)', async () => {
  const w = makeWorld('t1neg');
  const rows = [
    { id: 'bd-substr', external_ref: `${w.externalRef}-suffix`, title: 'substring distractor', status: 'open' },
    { id: 'bd-case', external_ref: w.externalRef.toUpperCase(), title: 'case-folded distractor', status: 'closed' },
    { id: 'bd-title', external_ref: 'kickoff-spec:unrelated', title: w.title, status: 'open' },
  ];
  const db = newDb(rows);
  const adapters = makeAdapters(w);

  const found = await withBdFixture({ db }, () => adapters.beadsFind(w.externalRef));
  assert.strictEqual(found, null,
    `beadsFind matched a non-exact distractor by substring, case-fold or title: ${JSON.stringify(found)}`);
});

// ── T2a / C2 (reuse, snake_case, beyond 50 rows) ────────────────────────────────────────────
test('T2a C2 production execute (only model+CLI seams substituted) reuses an existing exact closed issue that sits beyond the 50-row page — matched on a snake_case external_ref — creating no issue and persisting a receipt that names the reused issue and commit A, despite substring/case/same-title distractors', async () => {
  const w = makeWorld('t2a');
  const exact = { id: 'bd-reused-snake', external_ref: w.externalRef, title: 'the reused spec', status: 'closed' };
  const db = newDb(seedBeyond50(w.externalRef, exact, w.title));
  const adapters = makeAdapters(w);

  const result = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters));

  assert.strictEqual(result.status, 'ready', `execute did not reuse the existing issue: ${JSON.stringify(result)}`);
  assert.strictEqual(result.issueId, 'bd-reused-snake', JSON.stringify(result));
  assert.strictEqual(readDb(db).creates.length, 0, 'a duplicate issue was created for an existing external reference');
  assert(validReceipt(result.receipt, w.kickoffHash), `the receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.issueId, 'bd-reused-snake', 'the receipt does not name the reused issue');
  assert.strictEqual(result.receipt.integrationCommit, w.A, 'the receipt does not name pinned commit A');
});

// ── T2b / C2 (reuse, camelCase) ─────────────────────────────────────────────────────────────
test('T2b C2 production execute reuses an existing exact closed issue matched on a camelCase externalRef field, creating no issue and persisting a matching receipt', async () => {
  const w = makeWorld('t2b');
  const exact = { id: 'bd-reused-camel', externalRef: w.externalRef, title: 'the reused spec', status: 'closed' };
  const db = newDb(seedBeyond50(w.externalRef, exact, w.title));
  const adapters = makeAdapters(w);

  const result = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters));

  assert.strictEqual(result.status, 'ready', `execute did not reuse the camelCase issue: ${JSON.stringify(result)}`);
  assert.strictEqual(result.issueId, 'bd-reused-camel', JSON.stringify(result));
  assert.strictEqual(readDb(db).creates.length, 0, 'a duplicate issue was created for an existing camelCase external reference');
  assert(validReceipt(result.receipt, w.kickoffHash), `the receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.issueId, 'bd-reused-camel', 'the receipt does not name the reused issue');
});

// ── T2c / C2 (create once, native fields, real JSON identity) ────────────────────────────────
test('T2c C2 with no exact match, production execute creates exactly one issue through the real bd boundary — carrying the native title/description/design/priority/provenance fields — returns the real JSON issue identity and writes a valid receipt', async () => {
  const w = makeWorld('t2c');
  const db = newDb([]);
  const adapters = makeAdapters(w);

  const result = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters));

  assert.strictEqual(result.status, 'ready', `execute did not create a ready issue: ${JSON.stringify(result)}`);
  const persisted = readDb(db);
  assert.strictEqual(persisted.creates.length, 1, `exactly one issue must be created, saw ${persisted.creates.length}`);
  const created = persisted.creates[0];
  // The returned identity is the one the CLI emitted as JSON and the real beadsCreate parsed back.
  assert.strictEqual(result.issueId, created.id, `execute did not return the real JSON issue identity: ${JSON.stringify(result)}`);
  // Native fields crossed the real runner/bd boundary intact.
  const cargv = created.argv;
  const at = (flag) => cargv[cargv.indexOf(flag) + 1];
  assert.strictEqual(cargv[0], 'create', 'the captured bd call was not a create');
  assert.strictEqual(created.external_ref, w.externalRef, 'the create did not carry the derived external reference');
  assert.strictEqual(at('--external-ref'), w.externalRef, '--external-ref did not carry the derived external reference');
  assert.strictEqual(at('--priority'), String(w.priority), '--priority did not carry the native kickoff priority');
  assert(String(at('--design')).includes('README.md#pipeline-fixture'), '--design did not carry the native design reference');
  const meta = JSON.parse(at('--metadata'));
  assert.strictEqual(meta.kickoffHash, w.kickoffHash, 'provenance metadata did not carry the kickoff hash');
  assert.strictEqual(meta.integrationCommit, w.A, 'provenance metadata did not carry the pinned integration commit');
  assert(typeof meta.specHash === 'string' && meta.specHash.startsWith('sha256:'), 'provenance metadata did not carry a spec hash');
  assert(validReceipt(result.receipt, w.kickoffHash), `the receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.issueId, created.id, 'the receipt does not name the created issue');
  assert.strictEqual(result.receipt.integrationCommit, w.A, 'the receipt does not name pinned commit A');
});

// ── T2d / C2 (receipt replay creates nothing) ───────────────────────────────────────────────
test('T2d C2 replaying a completed kickoff creates nothing: a first execute creates one issue and a receipt, and a second execute (fresh adapters, same durable state) returns the same issue from the receipt without crossing the Beads boundary again', async () => {
  const w = makeWorld('t2d');
  const db = newDb([]);

  const first = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w)));
  assert.strictEqual(first.status, 'ready', `first execute did not create a ready issue: ${JSON.stringify(first)}`);
  assert.strictEqual(readDb(db).creates.length, 1, 'first execute did not create exactly one issue');

  const second = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w)));
  assert.strictEqual(second.status, 'ready', `replay did not return ready: ${JSON.stringify(second)}`);
  assert.strictEqual(second.issueId, first.issueId, 'replay returned a different issue identity');
  assert.strictEqual(readDb(db).creates.length, 1, 'replay created another issue instead of reusing the receipt');
});

// ── T2e / C2 (crash after create, before receipt → restart reuses) ──────────────────────────
test('T2e C2 a simulated crash after a successful create but before the receipt leaves the created issue persisted and no receipt; restarting execute reuses that same external-reference issue through the lookup — exactly one create total, no duplicate', async () => {
  const w = makeWorld('t2e');
  const db = newDb([]);

  const crashing = makeAdapters(w, { crash: async (tag) => { throw new Error(`simulated crash: ${tag}`); } });
  await assert.rejects(
    withBdFixture({ db }, () => specify.execute({ configPath: w.configPath, proposalId: w.proposalId }, {}, crashing)),
    /simulated crash/, 'execute did not surface the injected crash after create');
  assert.strictEqual(readDb(db).creates.length, 1, 'the crash test did not persist exactly one created issue');
  const createdId = readDb(db).creates[0].id;
  assert.strictEqual(await withBdFixture({ db }, () => makeAdapters(w).readReceipt(w.kickoffHash)), null,
    'a receipt was published despite the crash before receipt');

  const restart = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w)));
  assert.strictEqual(restart.status, 'ready', `restart did not complete: ${JSON.stringify(restart)}`);
  assert.strictEqual(restart.issueId, createdId, 'restart did not reuse the issue persisted before the crash');
  assert.strictEqual(readDb(db).creates.length, 1, 'restart created a duplicate issue instead of reusing the persisted one');
  assert(validReceipt(restart.receipt, w.kickoffHash), `the restart receipt is not valid: ${JSON.stringify(restart.receipt)}`);
});

// ── T3 / C3 (failed create publishes no receipt; persisted-before-failure recovers on restart) ─
test('T3 C3 a create that persists the issue and then returns a malformed response publishes no receipt; a restart recovers that same issue through the exact external-reference lookup path with no duplicate creation and a valid receipt', async () => {
  const w = makeWorld('t3');
  const db = newDb([]);

  await assert.rejects(
    withBdFixture({ db, create: 'persist-then-malformed' }, () => specify.execute(
      { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w))),
    'execute did not surface the malformed create response as a failure');
  const afterFail = readDb(db);
  assert.strictEqual(afterFail.creates.length, 1, 'the CLI-persisted-before-failure create was not recorded exactly once');
  assert.strictEqual(await withBdFixture({ db }, () => makeAdapters(w).readReceipt(w.kickoffHash)), null,
    'a failed/malformed create published a receipt');
  const persistedId = afterFail.creates[0].id;

  const restart = await withBdFixture({ db }, () => specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, makeAdapters(w)));
  assert.strictEqual(restart.status, 'ready', `restart did not recover the persisted issue: ${JSON.stringify(restart)}`);
  assert.strictEqual(restart.issueId, persistedId, 'restart did not recover the issue the CLI persisted before failing');
  assert.strictEqual(readDb(db).creates.length, 1, 'restart created a duplicate instead of recovering through the lookup');
  assert(validReceipt(restart.receipt, w.kickoffHash), `the restart receipt is not valid: ${JSON.stringify(restart.receipt)}`);
  assert.strictEqual(restart.receipt.issueId, persistedId, 'the recovered receipt does not name the persisted issue');
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
