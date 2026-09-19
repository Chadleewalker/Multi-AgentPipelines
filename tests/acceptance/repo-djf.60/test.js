// Frozen acceptance test — repo-djf.60: support bounded design discovery for the conveyor
// repository. This is the RED half of the suite; `guard.js` beside it pins the "existing
// behaviour X still holds" invariants this change must PRESERVE (those are green at the fork
// point and labelled as guards there). Between the two files every criterion is covered in BOTH
// directions.
//
// WHY THIS FILE IS RED TODAY (the reproduced limitation). `scripts/specify-proposal.js` today
// caps design-reference discovery at MAX_DESIGN_FILE_BYTES = 256*1024 (262144) per file,
// MAX_DESIGN_CANDIDATES = 128 candidates, and MAX_DESIGN_CANDIDATE_BYTES = 32*1024 (32768)
// serialized-candidate-array JSON bytes. The conveyor repository has grown past all three
// (DESIGN.md and docs/change-log.md are each larger than 262144 bytes, and the repository yields
// far more than 128 design-reference candidates), so BOTH production discovery
// (`deriveDesignReferenceCandidates`) and consumer validation (`validDesignReferenceCandidates`)
// refuse the real tree and any synthetic tree that reaches the approved larger bounds. The change
// must raise exactly those three ceilings to per-design-file 1048576 bytes, candidate count 1024,
// and serialized candidate-array JSON 131072 bytes — and NOTHING else: the 128-file tree
// enumeration, the 262144-byte tree-enumeration buffer, and the 1024-byte per-reference ceiling
// stay put. Until the expansion lands, every non-guard check below fails: production discovery
// throws before the planner is ever launched.
//
// COMPOSITION. Each check drives REAL production discovery (`deriveDesignReferenceCandidates`) and
// REAL `execute` against synthetic pinned Git repositories, substituting ONLY the external planner
// (`launchCodex`) and external Beads operations (`beadsFind`/`beadsCreate`) — never a replacement
// discovery, validation, integration-resolution, checkout or design-validation seam. Generated
// references are ASCII under the existing rules, so byte boundaries are exercised through the
// serialized JSON bytes and exact blob sizes, not through unreachable Unicode reference fixtures.
//
// CRITERION PAIRING — every check names its criterion, every criterion names >=1 check here or in
// guard.js:
//   C1  a committed fixture with a >262144 & <1048576 Markdown blob and >=730 valid references
//       whose JSON is >32768 & <=131072 is admitted whole, in deterministic order, and the no-tool
//       planner may pick a late docs/control-plane.md member successfully.        -> T1
//   C2  only the three ceilings expand; producer discovery and consumer validation agree; the
//       unchanged ceilings and all safety filtering are preserved.        -> T2,T3,T4 (+ guards G4,G7)
//   C3  inclusive boundary + one-unit overflow, independently, for each expanded ceiling, with the
//       other ceilings kept below their limits and overflow refused before any side effect. -> T2,T3,T4
//   C4  preserved refusals and fail-closed ordering; pinned-commit determinism.  -> guards G1,G2,G3
//   C5  the real conveyor repository enumerates a complete valid list at its pinned HEAD without a
//       live model/network; compatibility of the surrounding contracts.       -> T5 (+ guard G5)
//   C6  the frozen repo-djf.38 numeric caps are intentionally superseded; new independent overflow
//       coverage exists (T2/T3/T4) while the frozen file and safety semantics stay.   -> guard G6
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case. No provider key, no real
// Beads binary or host Beads database, no network, no container engine. Every durable store is
// re-aimed into a disposable temp tree via PIPELINE_STATE_DIR.
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
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf60-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

// The three ceilings this task expands, and the three it must leave alone. Named here so each
// boundary check reads against the contract, not a bare magic number.
const NEW_FILE_BYTES = 1048576;        // per-design-file, was 262144
const NEW_CANDIDATES = 1024;           // candidate count, was 128
const NEW_CANDIDATE_JSON_BYTES = 131072; // serialized candidate-array JSON bytes, was 32768
const OLD_TREE_BYTES = 262144;         // tree-enumeration buffer — UNCHANGED
const PER_REF_BYTES = 1024;            // per-reference ceiling — UNCHANGED

const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// Serialized candidate-array JSON byte length, computed exactly as production does
// (`Buffer.byteLength(JSON.stringify(list), 'utf8')`).
const jsonBytes = (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');

// A Markdown blob of EXACTLY `targetBytes` UTF-8 bytes, carrying one ASCII heading and a body of
// multibyte, non-heading content. The multibyte body is the byte-vs-character discriminator the
// spec demands: its character count is far below its byte count, so an accounting that measured
// characters instead of bytes would misjudge the ceiling. Padding is single-byte ASCII on its own
// line so the exact byte target is hit without disturbing the multibyte proof or inventing a
// second heading.
function mdOfExactBytes(targetBytes, headingText) {
  const head = `# ${headingText}\n`;
  let content = head;
  const mbChunk = `x${'☃'.repeat(1000)}\n`; // 3-byte snowmen, line starts with 'x' (not '#')
  while (Buffer.byteLength(content + mbChunk, 'utf8') <= targetBytes - mbChunk.length * 3) {
    content += mbChunk;
  }
  const pad = targetBytes - Buffer.byteLength(content, 'utf8');
  content += 'y'.repeat(pad); // 1 byte each; new line begins with 'y', never a heading
  assert.strictEqual(Buffer.byteLength(content, 'utf8'), targetBytes,
    `mdOfExactBytes missed its byte target: ${Buffer.byteLength(content, 'utf8')} != ${targetBytes}`);
  assert(content.length < targetBytes,
    'the fixture must be multibyte: its character count must be below its byte count');
  return content;
}

// A single Markdown file holding exactly `n` distinct, valid, short references. Keeps the JSON-byte
// and file-byte ceilings comfortably below their limits, so the ONLY ceiling a count boundary can
// reach is the count itself.
function countFixtureFile(n) {
  const refs = [];
  const lines = [];
  for (let i = 0; i < n; i++) {
    const slug = `h${String(i).padStart(6, '0')}`;
    refs.push(`gen.md#${slug}`);
    lines.push(`# ${slug}`);
  }
  return { file: 'gen.md', content: `${lines.join('\n')}\n`, refs };
}

// A single Markdown file whose serialized candidate-array JSON is EXACTLY `targetBytes`, with the
// count and per-file bytes kept below their limits. References are ASCII (as the generator's always
// are), so the exact limit is measured on the serialized JSON, never on invented Unicode.
function jsonFixtureFile(targetBytes) {
  const prefix = 'gen.md#';
  const refOfLen = (i, total) => {
    const slugLen = total - prefix.length;
    const base = `k${i.toString(36)}-`;
    assert(base.length <= slugLen, 'index too long for the requested reference length');
    return `${prefix}${base}${'z'.repeat(slugLen - base.length)}`;
  };
  const refs = [];
  let i = 0;
  const BODY_LEN = 200;
  // Fill with fixed-length references, leaving a ~400-byte gap so the exact target can be reached
  // by a single final reference whose length stays within the unchanged 1024-byte per-reference cap.
  while (jsonBytes([...refs, refOfLen(i, BODY_LEN)]) <= targetBytes - 400) {
    refs.push(refOfLen(i, BODY_LEN)); i += 1;
  }
  // Choose the final reference length so the serialized JSON lands exactly on the target.
  let hit = false;
  for (let total = prefix.length + 4; total <= PER_REF_BYTES; total += 1) {
    if (jsonBytes([...refs, refOfLen(i, total)]) === targetBytes) { refs.push(refOfLen(i, total)); hit = true; break; }
  }
  assert(hit, `could not construct a candidate array of exactly ${targetBytes} JSON bytes`);
  assert.strictEqual(new Set(refs).size, refs.length,
    'the JSON-boundary fixture must contain distinct references before discovery deduplicates');
  assert.strictEqual(jsonBytes(refs), targetBytes, 'jsonFixtureFile missed its JSON byte target');
  assert(refs.length <= NEW_CANDIDATES, 'the JSON-boundary fixture must keep the count below its limit');
  const content = `${refs.map((r) => `# ${r.slice(prefix.length)}`).join('\n')}\n`;
  return { file: 'gen.md', content, refs };
}

function writeKickoff(targetRepoPath, tag) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1', title: `repo-djf.60 fixture ${tag}`, description: '',
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

// A real Git repository whose integration branch `main` has HEAD (= the pinned commit A) carrying
// the given Markdown files, a valid run config (codexAuth chatgpt), and a durable kickoff record.
// core.autocrlf is disabled so a committed blob's byte length equals exactly the bytes written —
// the only way an exact-byte boundary means anything on the Windows reference host.
function makeWorld(tag, files, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf60-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.60 fixture');
  git(target, 'config', 'core.autocrlf', 'false');
  git(target, 'config', 'core.safecrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(target, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'pinned design fixture');
  const A = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(A), `fixture ${tag} did not pin a 40-hex integration commit: ${A}`);
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-djf60-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 15000, wallClockMinutes: 2, ...extraCfg,
  }, null, 2)}\n`);
  const k = writeKickoff(target, tag);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash,
    title: k.title, priority: k.priority, externalRef: `kickoff-spec:${k.hash}` };
}

// The REAL production adapters for a fixture world. `launchCodex`, `beadsFind` and `beadsCreate`
// are the ONLY seams a test may replace (the external planner and external Beads operations);
// integration resolution, candidate discovery, the read-only checkout lifecycle, design validation
// and receipt persistence all run production code.
function prodAdapters(w) {
  return specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
}

function readyProposal(designRef) {
  return {
    spec: 'Bounded design-discovery specification fixture for repo-djf.60.',
    acceptanceCriteria: ['discovery admits the approved larger bounds'],
    designReferences: [designRef], difficulty: 'medium', status: 'ready',
  };
}

// A local mirror of the module's (unexported) `validDesignReferenceCandidates`, using the expanded
// ceilings, so "a complete valid list" is asserted by the same rule production consumes under.
function validCandidates(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > NEW_CANDIDATES) return false;
  if (jsonBytes(list) > NEW_CANDIDATE_JSON_BYTES) return false;
  const seen = new Set();
  for (const c of list) {
    if (typeof c !== 'string' || !c.trim() || Buffer.byteLength(c, 'utf8') > PER_REF_BYTES) return false;
    if (!/^[^\s:#][^\r\n]*#[^\r\n#]+$/.test(c) || seen.has(c)) return false;
    seen.add(c);
  }
  return true;
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 a committed fixture with a Markdown blob larger than 262144 and below 1048576 bytes and at least 730 valid references (serialized JSON above 32768 and within 131072) is discovered whole in deterministic order, and the no-tool planner receives the complete list and successfully selects the late docs/control-plane.md member (RED today: production discovery throws before the planner is launched)', async () => {
  const files = {};
  const refFileHeadings = [];
  const expectedRefs = [];
  const N = 780;
  for (let i = 0; i < N; i++) {
    const base = `ref${i.toString(36)}-`;
    const slug = `${base}${'a'.repeat(45 - base.length)}`; // ASCII slug, ~45 chars
    refFileHeadings.push(`# ${slug}`);
    expectedRefs.push(`a-refs.md#${slug}`);
  }
  files['a-refs.md'] = `${refFileHeadings.join('\n')}\n`;                 // sorts first
  files['big.md'] = mdOfExactBytes(600000, 'big blob anchor');            // 262144 < 600000 < 1048576
  files['docs/control-plane.md'] = '# late control plane anchor\n';       // sorts last -> late member

  const w = makeWorld('t1', files);
  const controlPlaneRef = 'docs/control-plane.md#late-control-plane-anchor';
  const bigRef = 'big.md#big-blob-anchor';
  expectedRefs.push(bigRef, controlPlaneRef);
  assert.strictEqual(new Set(expectedRefs).size, N + 2,
    'the large fixture must contain every intended distinct reference');

  const adapters = prodAdapters(w);
  const cands = await adapters.deriveDesignReferenceCandidates(w.A);
  const cands2 = await adapters.deriveDesignReferenceCandidates(w.A);
  assert.deepStrictEqual(cands, expectedRefs,
    'discovery omitted, invented or reordered a reference from the committed fixture');

  assert(cands.length >= 730, `discovery did not surface at least 730 references: ${cands.length}`);
  assert(cands.length <= NEW_CANDIDATES, `discovery exceeded the candidate ceiling: ${cands.length}`);
  const bytes = jsonBytes(cands);
  assert(bytes > 32768 && bytes <= NEW_CANDIDATE_JSON_BYTES,
    `serialized candidate JSON must exceed 32768 and stay within 131072: ${bytes}`);
  assert.deepStrictEqual(cands, cands2, 'discovery order is not deterministic across two reads');
  assert(cands.includes(bigRef), 'the >262144-byte blob was not admitted at the expanded file ceiling');
  assert(cands.includes(controlPlaneRef), 'the late docs/control-plane.md reference was not preserved');
  assert.strictEqual(cands[cands.length - 1], controlPlaneRef,
    'the late docs/control-plane.md reference is not preserved in deterministic (late) order');
  assert(validCandidates(cands), 'the discovered list is not a valid candidate array under the expanded bounds');

  let created = null; let launchedList = null;
  adapters.launchCodex = async (plan) => { launchedList = plan.designReferenceCandidates; return JSON.stringify(readyProposal(controlPlaneRef)); };
  adapters.beadsFind = async () => null;
  adapters.beadsCreate = async (req) => { created = req; return { id: `bd-${sha256(req.externalRef).slice(7, 19)}` }; };

  const result = await specify.execute({ configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);
  assert.strictEqual(result.status, 'ready', `execute did not complete against the large fixture: ${JSON.stringify(result)}`);
  assert.deepStrictEqual(launchedList, expectedRefs, 'the no-tool planner did not receive the complete fixture reference list');
  assert(created && created.designReferences.includes(controlPlaneRef),
    'the planner could not successfully choose the late docs/control-plane.md member');
});

// ── T2 / C3,C2 (per-design-file byte ceiling: 1048576) ─────────────────────────────────────────
test('T2 C3,C2 the per-design-file byte ceiling expands to exactly 1048576: a file at 1048576 bytes is discovered and execute reaches ready, while a one-byte overflow (1048577) is refused before any checkout, planner launch or Beads mutation — with byte, not character, accounting and the other two ceilings kept below their limits (RED today: the ceiling-sized file is refused by the old 262144 limit)', async () => {
  // Inclusive: a file at exactly the ceiling is admitted. The small companion file supplies the
  // reference the planner selects, so design validation never re-reads the huge blob.
  const inclusiveBlob = mdOfExactBytes(NEW_FILE_BYTES, 'at the file byte ceiling');
  assert.strictEqual(Buffer.byteLength(inclusiveBlob, 'utf8'), NEW_FILE_BYTES);
  assert(inclusiveBlob.length < NEW_FILE_BYTES, 'the inclusive fixture must exercise multibyte (byte != char) content');
  const wi = makeWorld('t2-in', { 'bigfile.md': inclusiveBlob, 'small.md': '# small pick\n' });
  const ai = prodAdapters(wi);
  const cands = await ai.deriveDesignReferenceCandidates(wi.A);
  assert(cands.includes('bigfile.md#at-the-file-byte-ceiling'), 'a file AT the byte ceiling was not admitted');
  assert(cands.includes('small.md#small-pick'), 'the companion reference was lost');
  assert(cands.length < NEW_CANDIDATES && jsonBytes(cands) < NEW_CANDIDATE_JSON_BYTES,
    'the file-ceiling case must keep the count and JSON ceilings below their limits');
  ai.launchCodex = async () => JSON.stringify(readyProposal('small.md#small-pick'));
  ai.beadsFind = async () => null;
  ai.beadsCreate = async (req) => ({ id: `bd-${sha256(req.externalRef).slice(7, 19)}` });
  const okResult = await specify.execute({ configPath: wi.configPath, proposalId: wi.proposalId }, {}, ai);
  assert.strictEqual(okResult.status, 'ready', `a file at the byte ceiling was not accepted end-to-end: ${JSON.stringify(okResult)}`);

  // Overflow: one byte over the ceiling is refused BEFORE any checkout, planner launch or Beads
  // mutation. Byte accounting, not character accounting: byteLength is 1048577, character length
  // far below, so a character-counting ceiling would wrongly admit it.
  const overflowBlob = mdOfExactBytes(NEW_FILE_BYTES + 1, 'over the file byte ceiling');
  assert.strictEqual(Buffer.byteLength(overflowBlob, 'utf8'), NEW_FILE_BYTES + 1);
  assert(overflowBlob.length <= NEW_FILE_BYTES, 'the overflow fixture must have fewer characters than bytes');
  const wo = makeWorld('t2-over', { 'bigfile.md': overflowBlob, 'small.md': '# small pick\n' });
  const ao = prodAdapters(wo);
  await assert.rejects(ao.deriveDesignReferenceCandidates(wo.A),
    'a file one byte over the ceiling was not refused by production discovery');
  let checkouts = 0; let launches = 0; let creates = 0;
  const realCheckout = ao.createReadOnlyCheckout;
  ao.createReadOnlyCheckout = async (c) => { checkouts += 1; return realCheckout(c); };
  ao.launchCodex = async () => { launches += 1; return JSON.stringify(readyProposal('small.md#small-pick')); };
  ao.beadsFind = async () => null;
  ao.beadsCreate = async () => { creates += 1; return { id: 'must-not-create' }; };
  const refused = await specify.execute({ configPath: wo.configPath, proposalId: wo.proposalId }, {}, ao);
  assert.strictEqual(refused.status, 'refused', `a one-byte file overflow was not refused: ${JSON.stringify(refused)}`);
  assert.strictEqual(checkouts, 0, 'the overflow created a checkout before refusing');
  assert.strictEqual(launches, 0, 'the overflow launched the planner before refusing');
  assert.strictEqual(creates, 0, 'the overflow mutated Beads before refusing');
});

// ── T3 / C3,C2 (candidate-count ceiling: 1024) ─────────────────────────────────────────────────
test('T3 C3,C2 the candidate-count ceiling expands to exactly 1024: 1024 short references are discovered and execute reaches ready, while a 1025th reference is refused before any checkout, planner launch or Beads mutation — with the file-byte and JSON ceilings kept below their limits (RED today: 1024 candidates are refused by the old 128 limit)', async () => {
  const inc = countFixtureFile(NEW_CANDIDATES);
  const wi = makeWorld('t3-in', { [inc.file]: inc.content });
  const ai = prodAdapters(wi);
  const cands = await ai.deriveDesignReferenceCandidates(wi.A);
  assert.strictEqual(cands.length, NEW_CANDIDATES, `exactly ${NEW_CANDIDATES} references must be admitted: ${cands.length}`);
  assert(jsonBytes(cands) < NEW_CANDIDATE_JSON_BYTES && Buffer.byteLength(inc.content, 'utf8') < NEW_FILE_BYTES,
    'the count case must keep the JSON and file-byte ceilings below their limits');
  ai.launchCodex = async () => JSON.stringify(readyProposal(cands[0]));
  ai.beadsFind = async () => null;
  ai.beadsCreate = async (req) => ({ id: `bd-${sha256(req.externalRef).slice(7, 19)}` });
  const okResult = await specify.execute({ configPath: wi.configPath, proposalId: wi.proposalId }, {}, ai);
  assert.strictEqual(okResult.status, 'ready', `1024 candidates were not accepted end-to-end: ${JSON.stringify(okResult)}`);

  const over = countFixtureFile(NEW_CANDIDATES + 1);
  const wo = makeWorld('t3-over', { [over.file]: over.content });
  const ao = prodAdapters(wo);
  await assert.rejects(ao.deriveDesignReferenceCandidates(wo.A),
    'a 1025th candidate was not refused by production discovery');
  let checkouts = 0; let launches = 0; let creates = 0;
  const realCheckout = ao.createReadOnlyCheckout;
  ao.createReadOnlyCheckout = async (c) => { checkouts += 1; return realCheckout(c); };
  ao.launchCodex = async () => { launches += 1; return JSON.stringify(readyProposal(over.refs[0])); };
  ao.beadsFind = async () => null;
  ao.beadsCreate = async () => { creates += 1; return { id: 'must-not-create' }; };
  const refused = await specify.execute({ configPath: wo.configPath, proposalId: wo.proposalId }, {}, ao);
  assert.strictEqual(refused.status, 'refused', `a one-item count overflow was not refused: ${JSON.stringify(refused)}`);
  assert.strictEqual(checkouts, 0, 'the count overflow created a checkout before refusing');
  assert.strictEqual(launches, 0, 'the count overflow launched the planner before refusing');
  assert.strictEqual(creates, 0, 'the count overflow mutated Beads before refusing');
});

// ── T4 / C3,C2 (serialized candidate-array JSON-byte ceiling: 131072) ──────────────────────────
test('T4 C3,C2 the serialized candidate-array JSON-byte ceiling expands to exactly 131072: a valid ASCII candidate array whose JSON is exactly 131072 bytes is discovered and execute reaches ready, while a 131073-byte array is refused before any checkout, planner launch or Beads mutation — with the count and file-byte ceilings kept below their limits (RED today: a 131072-byte JSON list is refused by the old 32768 limit)', async () => {
  const inc = jsonFixtureFile(NEW_CANDIDATE_JSON_BYTES);
  assert.strictEqual(jsonBytes(inc.refs), NEW_CANDIDATE_JSON_BYTES);
  const wi = makeWorld('t4-in', { [inc.file]: inc.content });
  const ai = prodAdapters(wi);
  const cands = await ai.deriveDesignReferenceCandidates(wi.A);
  assert.strictEqual(jsonBytes(cands), NEW_CANDIDATE_JSON_BYTES,
    `discovery did not admit a candidate array of exactly 131072 JSON bytes: ${jsonBytes(cands)}`);
  assert(cands.length < NEW_CANDIDATES && Buffer.byteLength(inc.content, 'utf8') < NEW_FILE_BYTES,
    'the JSON case must keep the count and file-byte ceilings below their limits');
  ai.launchCodex = async () => JSON.stringify(readyProposal(cands[0]));
  ai.beadsFind = async () => null;
  ai.beadsCreate = async (req) => ({ id: `bd-${sha256(req.externalRef).slice(7, 19)}` });
  const okResult = await specify.execute({ configPath: wi.configPath, proposalId: wi.proposalId }, {}, ai);
  assert.strictEqual(okResult.status, 'ready', `a 131072-byte JSON list was not accepted end-to-end: ${JSON.stringify(okResult)}`);

  const over = jsonFixtureFile(NEW_CANDIDATE_JSON_BYTES + 1);
  assert.strictEqual(jsonBytes(over.refs), NEW_CANDIDATE_JSON_BYTES + 1);
  const wo = makeWorld('t4-over', { [over.file]: over.content });
  const ao = prodAdapters(wo);
  await assert.rejects(ao.deriveDesignReferenceCandidates(wo.A),
    'a candidate array one byte over the JSON ceiling was not refused by production discovery');
  let checkouts = 0; let launches = 0; let creates = 0;
  const realCheckout = ao.createReadOnlyCheckout;
  ao.createReadOnlyCheckout = async (c) => { checkouts += 1; return realCheckout(c); };
  ao.launchCodex = async () => { launches += 1; return JSON.stringify(readyProposal(over.refs[0])); };
  ao.beadsFind = async () => null;
  ao.beadsCreate = async () => { creates += 1; return { id: 'must-not-create' }; };
  const refused = await specify.execute({ configPath: wo.configPath, proposalId: wo.proposalId }, {}, ao);
  assert.strictEqual(refused.status, 'refused', `a one-byte JSON overflow was not refused: ${JSON.stringify(refused)}`);
  assert.strictEqual(checkouts, 0, 'the JSON overflow created a checkout before refusing');
  assert.strictEqual(launches, 0, 'the JSON overflow launched the planner before refusing');
  assert.strictEqual(creates, 0, 'the JSON overflow mutated Beads before refusing');
});

// ── T5 / C5 ────────────────────────────────────────────────────────────────────────────────────
test('T5 C5 the current conveyor repository at its pinned committed HEAD enumerates a complete, valid candidate list through production discovery without a live model or network — a list larger than the old 128-candidate cap and within the expanded bounds, including a docs/control-plane.md reference (RED today: the real tree exceeds the old ceilings and discovery throws)', async () => {
  // The container mounts this known fixture with a different owner. Trust only this exact
  // checkout for this test's Git children; never change global Git configuration or product code.
  const configCount = Number(process.env.GIT_CONFIG_COUNT || 0);
  assert(Number.isSafeInteger(configCount) && configCount >= 0, 'invalid inherited Git config count');
  const configKey = `GIT_CONFIG_KEY_${configCount}`;
  const configValue = `GIT_CONFIG_VALUE_${configCount}`;
  const savedGitEnv = new Map(['GIT_CONFIG_COUNT', configKey, configValue]
    .map((key) => [key, process.env[key]]));
  process.env[configKey] = 'safe.directory';
  process.env[configValue] = ROOT;
  process.env.GIT_CONFIG_COUNT = String(configCount + 1);
  try {
  const commit = String(run('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(commit), `could not pin the conveyor repository HEAD: ${commit}`);
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'djf60-real-state-'));
  temps.push(stateHome);
  const adapters = specify.productionAdapters({ configPath: 'unused.json' }, {
    loadConfig: () => ({ codexAuth: 'chatgpt', targetRepoPath: ROOT, gitTimeoutMs: 60000 }),
    kickoffApi: { statePathsFor: () => ({ state: stateHome }) },
    bdJson: () => ({ ok: true, data: [] }),
    resolveBranch: () => ({ ok: true, branch: 'HEAD' }),
  });

  const cands = await adapters.deriveDesignReferenceCandidates(commit);
  // Independent oracle from the pinned Git objects, never from discovery's own result or helpers.
  // Keep existing path/heading eligibility and deduplication semantics; compare the entire list.
  const tree = git(ROOT, 'ls-tree', '-r', '--name-only', '-z', commit);
  assert.strictEqual(tree.status, 0, 'could not enumerate the pinned completeness oracle');
  const expectedRefs = [];
  for (const file of tree.stdout.split('\0').filter(Boolean)) {
    if (!/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/i.test(file)) continue;
    const blob = git(ROOT, 'show', `${commit}:${file}`);
    assert.strictEqual(blob.status, 0, `could not read pinned oracle document ${file}`);
    for (const line of blob.stdout.split(/\r?\n/)) {
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (!heading) continue;
      const anchor = heading[1].trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-').replace(/-+/g, '-');
      const ref = `${file}#${anchor}`;
      if (anchor && Buffer.byteLength(ref, 'utf8') <= PER_REF_BYTES) expectedRefs.push(ref);
    }
  }
  assert.deepStrictEqual(cands, [...new Set(expectedRefs)],
    'production discovery did not preserve the complete pinned repository reference list');
  assert(validCandidates(cands), 'the conveyor repository did not enumerate a valid candidate list under the expanded bounds');
  assert(cands.length > 128, `the enumeration did not exceed the old 128-candidate cap (so it would not be red today): ${cands.length}`);
  assert(cands.some((c) => c.startsWith('docs/control-plane.md#')),
    'the enumeration did not include a docs/control-plane.md reference');
  // Read entirely from committed Git objects: no worktree, no planner, no Beads, no network.
  assert(cands.every((c) => typeof c === 'string' && c.includes('#')), 'a malformed reference leaked into the list');
  } finally {
    for (const [key, value] of savedGitEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
