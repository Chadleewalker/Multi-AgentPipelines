// Frozen acceptance test — repo-djf.56: align specification heading references with preparation
// provenance resolution. This is the RED half of the suite; `guard.js` beside it carries the
// "existing behaviour X still holds" invariants this change must PRESERVE (they are green at the
// fork point and labelled as guards there). Between the two files every criterion is covered in
// BOTH directions.
//
// WHY THIS FILE IS RED TODAY (the reproduced gap). Two adapters were already built against an
// earlier draft: `productionAdapters.deriveDesignReferenceCandidates` GENERATES GitHub-style
// Markdown-slug anchors from headings (e.g. `## Agent Instructions` -> `<file>#agent-instructions`)
// and `productionAdapters.validateDesignReference` ACCEPTS those slugs at the pinned commit. But
// the canonical resolver `runner/design-ref.js` — the one PREPARATION runs (`resolveIssue`, see
// scripts/prepare-batch.js and scripts/design-provenance.js) — only matches a literal heading
// title, a section-number prefix, or an explicit HTML id/name. Its `hasAnchor` has NO Markdown-slug
// alias, so a spec issue whose `--design` field the specifier generated and serialized from those
// slug candidates is REFUSED (`missing-anchor`) the moment preparation tries to resolve it. The
// specification side and the preparation side disagree. The fix teaches the shared resolver the
// same slug alias the generator/validator already use, WITHOUT replacing the generator, serializer,
// parser or resolver — so the exact `--design` a real `beadsCreate` emits resolves at commit P.
//
// CRITERION PAIRING — every check names its own criterion, every criterion names >=1 check here or
// in guard.js:
//   C1  derive slug candidates at P (incl. Agent Instructions, Kickoff intake, punctuation/multiple
//       whitespace) -> each passes production validateDesignReference -> beadsCreate serializes them
//       into the exact bdJson `--design` boundary argument -> persist/reload unchanged -> that issue
//       resolves through runner/design-ref.resolveIssue at P with the exact path/anchor set + count.
//                                                                                 -> T1, T2
//   C2  pinned-commit isolation + refusal reason codes preserved.        -> guard G1, G2
//   C3  literal / section-prefix / HTML anchor forms still resolve at P.  -> guard G3
//
// COMPOSITION. It COMPOSES the real production adapters and replaces ONLY the external Beads bdJson
// boundary (to capture the exact `--design` argument without a Beads database). Candidate discovery,
// slug validation and `--design` serialization all run production code against a real Git repo, and
// resolution runs the real `runner/design-ref.resolveIssue`, exactly as preparation calls it. No
// execute(), no checkout lifecycle: direct adapter composition, as criterion 1 permits.
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case. No provider key, no Beads
// binary, no network, no container engine. It resolves the repository as the tree it sits in
// (__dirname/../../..), never the cwd.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const specify = require(path.join(ROOT, 'scripts', 'specify-proposal.js'));
const designApi = require(path.join(ROOT, 'runner', 'design-ref.js'));

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_BD_CMD']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf56-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// The three headings the fixture pins, and the slug anchors independently expected from them.
// Written out here (not derived by the code under test) so the generator is judged against an
// independent expectation, exactly as criterion 1 requires. "Punctuation, Whitespace &   Stuff!"
// exercises punctuation removal and multiple-whitespace collapse.
const HEADINGS = [
  ['# Agent Instructions', 'agent-instructions'],
  ['## Kickoff intake', 'kickoff-intake'],
  ['### Punctuation, Whitespace &   Stuff!', 'punctuation-whitespace-stuff'],
];
const EXPECTED_CANDIDATES = HEADINGS.map(([, slug]) => `DESIGN.md#${slug}`);
const EXPECTED_DESIGN = EXPECTED_CANDIDATES.map((ref) => `design-ref: ${ref}`).join('\n');

// A real Git repo whose integration branch `main` has DESIGN.md with the three headings at HEAD
// (= the pinned commit P), plus a valid run config (codexAuth chatgpt).
function makeWorld(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf56-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.56 fixture');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'DESIGN.md'),
    `${HEADINGS.map(([h]) => `${h}\n\nBody paragraph for ${h}.\n`).join('\n')}`);
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'integration base');
  const P = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-djf56-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 15000, wallClockMinutes: 2,
  }, null, 2)}\n`);
  assert(/^[0-9a-f]{40}$/.test(P), `fixture ${tag} did not pin a 40-hex integration commit: ${P}`);
  return { root, target, configPath, P };
}

// Compose the REAL production adapters, replacing ONLY the external Beads bdJson boundary so the
// exact `--design` argument can be captured with no Beads database. Everything else is production.
function makeAdapters(w) {
  const captured = { calls: [] };
  const bdJson = (cfg, args) => {
    const i = args.indexOf('--design');
    captured.calls.push({ verb: args[0], args, design: i >= 0 ? args[i + 1] : null });
    return { ok: true, data: [{ id: 'bd-djf56-created' }] };
  };
  const adapters = specify.productionAdapters({ configPath: w.configPath }, { bdJson });
  return { adapters, captured };
}

const sortedKeys = (arr) => arr.map((r) => `${r.path}#${r.anchor}`).sort();

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 the FULL production round-trip: deriveDesignReferenceCandidates(P) yields the independently expected slug anchors (Agent Instructions, Kickoff intake, punctuation/multiple-whitespace); each passes production validateDesignReference at P; production beadsCreate serializes them into the exact bdJson --design argument; that value persists/reloads unchanged; and runner/design-ref.resolveIssue resolves that issue at P with the exact reference path/anchor set and count', async () => {
  const w = makeWorld('c1');
  const { adapters, captured } = makeAdapters(w);

  // 1. Generate — the slug anchors, independently expected.
  const candidates = await adapters.deriveDesignReferenceCandidates(w.P);
  assert.deepStrictEqual(candidates, EXPECTED_CANDIDATES,
    `deriveDesignReferenceCandidates did not yield the expected slug anchors: ${JSON.stringify(candidates)}`);

  // 2. Every generated candidate passes production validateDesignReference at P.
  for (const ref of candidates) {
    const v = await adapters.validateDesignReference(ref, w.P);
    assert(v && v.ok === true, `production validateDesignReference rejected its own candidate ${ref} at P: ${JSON.stringify(v)}`);
  }

  // 3. Call production beadsCreate with those candidates together; capture only the external
  //    bdJson boundary's exact --design argument.
  const request = {
    title: 'repo-djf.56 spec', description: 'spec body', acceptanceCriteria: ['resolves at P'],
    designReferences: candidates, difficulty: 'medium', priority: 2,
    kickoffHash: `sha256:${'0'.repeat(64)}`, specHash: `sha256:${'0'.repeat(64)}`,
    externalRef: 'kickoff-spec:djf56', metadata: {},
  };
  const issueId = await adapters.beadsCreate(request);
  assert.strictEqual(captured.calls.length, 1, `beadsCreate must cross the bdJson boundary exactly once, saw ${captured.calls.length}`);
  assert.strictEqual(captured.calls[0].verb, 'create', 'the captured bdJson call was not a create');
  assert.strictEqual(captured.calls[0].design, EXPECTED_DESIGN,
    `the captured --design argument was not the expected serialization: ${JSON.stringify(captured.calls[0].design)}`);
  assert(issueId && issueId.id === 'bd-djf56-created', `beadsCreate did not return the issue identity: ${JSON.stringify(issueId)}`);

  // 4. Persist/reload that exact value unchanged.
  const designFile = path.join(w.root, 'design-field.txt');
  fs.writeFileSync(designFile, captured.calls[0].design);
  const reloaded = fs.readFileSync(designFile, 'utf8');
  assert.strictEqual(reloaded, captured.calls[0].design, 'the --design value did not persist/reload unchanged');

  // 5. Pass that issue to runner/design-ref.resolveIssue with repository and commit P, as
  //    preparation does. RED TODAY: the shared resolver has no Markdown-slug alias, so it refuses
  //    the slug anchors the specifier generated. It must resolve — success, commit P, exact set.
  const resolution = designApi.resolveIssue({ design: reloaded }, { repoPath: w.target, commit: w.P });
  assert.strictEqual(resolution.ok, true,
    `runner/design-ref.resolveIssue refused the specifier's own slug references at P: reasons=${JSON.stringify(resolution.reasons)} refs=${JSON.stringify(resolution.refs)}`);
  assert.strictEqual(resolution.commit, w.P, 'resolveIssue did not report the pinned commit P');
  assert.strictEqual((resolution.refs || []).length, EXPECTED_CANDIDATES.length,
    `resolveIssue did not resolve the exact count of references: ${JSON.stringify(resolution.refs)}`);
  assert(resolution.refs.every((r) => r.ok === true), `not every reference resolved: ${JSON.stringify(resolution.refs)}`);
  assert.deepStrictEqual(sortedKeys(resolution.refs), [...EXPECTED_CANDIDATES].sort(),
    `resolveIssue did not resolve the exact path/anchor set: ${JSON.stringify(sortedKeys(resolution.refs))}`);
});

// ── T2 / C1 ──────────────────────────────────────────────────────────────────────────────────
// The minimal statement of the alignment: EACH generated slug candidate, serialized exactly as
// preparation stores and reads it (`design-ref: <file>#<slug>`), resolves on its own through the
// shared resolver at P. RED today for the same missing-slug-alias reason; it isolates the resolver
// from the round-trip so a regression points straight at runner/design-ref.
test('T2 C1 each generated Markdown-slug design reference resolves individually through runner/design-ref.resolveIssue at P (the specification-side generator and the preparation-side resolver agree)', async () => {
  const w = makeWorld('c1b');
  const { adapters } = makeAdapters(w);
  const candidates = await adapters.deriveDesignReferenceCandidates(w.P);
  assert.deepStrictEqual(candidates, EXPECTED_CANDIDATES, `unexpected candidates: ${JSON.stringify(candidates)}`);

  for (const ref of candidates) {
    const resolution = designApi.resolveIssue(
      { design: `design-ref: ${ref}` }, { repoPath: w.target, commit: w.P });
    assert.strictEqual(resolution.ok, true,
      `the shared resolver refused the slug reference ${ref} at P: reasons=${JSON.stringify(resolution.reasons)}`);
    assert.strictEqual(resolution.commit, w.P, `resolveIssue did not report commit P for ${ref}`);
    assert.strictEqual((resolution.refs || []).length, 1, `expected exactly one resolved ref for ${ref}`);
    assert.strictEqual(`${resolution.refs[0].path}#${resolution.refs[0].anchor}`, ref,
      `the resolved reference identity drifted for ${ref}: ${JSON.stringify(resolution.refs[0])}`);
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
