// Frozen acceptance test — repo-djf.56, the [guard] half: the behaviour the "align specification
// heading references with preparation provenance resolution" change must NOT alter.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the new Markdown-slug alias (see test.js) has to PRESERVE in runner/design-ref.js's
// shared resolver: pinned-commit isolation and the exact refusal reason codes for missing paths,
// absent anchors and operator-local paths (C2); and the continued resolution of literal heading
// titles, section-number-prefix forms and explicit HTML id/name anchors at the pinned commit, with
// section-prefix boundaries and exact HTML anchor identity intact and neighbouring nonexistent
// section numbers / HTML ids still refused (C3). Nothing red belongs here — a [guard] file red at
// the fork point is a stale pin and refuses the freeze. These checks deliberately reference NO
// Markdown slug: adding the slug alias must leave every one of them unchanged.
//
// SELF-CONTAINED: Node built-ins and a real local Git repo. It composes the REAL runner/design-ref
// resolver exactly as preparation calls it (`resolveIssue(issue, { repoPath, commit })`) and needs
// no provider key, Beads binary, network or container. It resolves the repository as the tree it
// sits in (__dirname/../../..), never the cwd.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const designApi = require(path.join(ROOT, 'runner', 'design-ref.js'));

const temps = [];
const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// P's DESIGN.md: a literal-title heading (`# Glossary`), a section-number-prefix heading
// (`## 4.10 …`, matched by the `#§4.10` form after the resolver strips the marker), and explicit
// HTML id/name anchors. NO heading here slugifies to any anchor the negative checks reference.
const DESIGN_AT_P = [
  '# Glossary',
  '',
  'Body for the glossary.',
  '',
  '## 4.10 Sole writer rule',
  '',
  'The host is the sole Beads writer.',
  '',
  '<a id="html-anchor-id"></a>',
  '',
  '<a name="named-anchor"></a>',
  '',
  'Trailing body.',
  '',
].join('\n');

// One world: commit P (the pinned commit), then a later commit Q that adds a document and a
// heading, then UNCOMMITTED working-tree content that adds another document and heading.
function makeWorld(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf56g-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.56 guard');
  fs.writeFileSync(path.join(target, 'DESIGN.md'), DESIGN_AT_P);
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'integration base');
  const P = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();

  // Commit Q: a new document and a new single-word heading, present ONLY from Q onward.
  fs.writeFileSync(path.join(target, 'LATER.md'), '# LaterDoc\n\nAdded only in commit Q.\n');
  fs.writeFileSync(path.join(target, 'DESIGN.md'), `${DESIGN_AT_P}\n## QAnchor\n\nAdded in Q.\n`);
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'advance to Q');
  const Q = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();

  // Uncommitted working-tree content: a new document and a new heading, committed to NOTHING.
  fs.writeFileSync(path.join(target, 'NEWWT.md'), '# WorkTreeDoc\n\nUncommitted.\n');
  fs.appendFileSync(path.join(target, 'DESIGN.md'), '\n## WorkingOnly\n\nUncommitted heading.\n');

  assert(/^[0-9a-f]{40}$/.test(P) && /^[0-9a-f]{40}$/.test(Q) && P !== Q,
    `guard fixture ${tag} did not pin two distinct 40-hex commits: ${P} ${Q}`);
  return { root, target, P, Q };
}

// The shared resolver, invoked exactly as preparation invokes it.
const resolveAt = (w, design, commit) =>
  designApi.resolveIssue({ id: 'djf56-guard', design }, { repoPath: w.target, commit });

// ── G1 / C2 guard: the refusal reason codes for missing paths, absent anchors and operator-local
//    paths are unchanged. None of these anchors is a Markdown slug of any heading, so adding the
//    slug alias must leave every refusal exactly as it is. ───────────────────────────────────────
test('G1 C2 [guard] at pinned commit P a missing repository path is refused missing-path, an absent anchor is refused missing-anchor, and every operator-local path spelling (absolute POSIX, Windows drive, home-relative, file URL, parent-relative) is refused operator-local', async () => {
  const w = makeWorld('g1');

  const missingPath = resolveAt(w, 'design-ref: docs/does-not-exist.md#Glossary', w.P);
  assert.strictEqual(missingPath.ok, false, 'a missing repository path must be refused');
  assert(missingPath.reasons.includes('missing-path'), `expected missing-path: ${JSON.stringify(missingPath.reasons)}`);

  const absentAnchor = resolveAt(w, 'design-ref: DESIGN.md#totally-absent-anchor', w.P);
  assert.strictEqual(absentAnchor.ok, false, 'an absent anchor must be refused');
  assert(absentAnchor.reasons.includes('missing-anchor'), `expected missing-anchor: ${JSON.stringify(absentAnchor.reasons)}`);

  const localSpellings = ['/etc/design.md', ['C:', 'Users', 'op', 'design.md'].join('/'), '~/notes/design.md',
    'file:///tmp/design.md', '../outside/design.md'];
  for (const spelling of localSpellings) {
    const res = resolveAt(w, `design-ref: ${spelling}#Glossary`, w.P);
    assert.strictEqual(res.ok, false, `an operator-local path must be refused: ${spelling}`);
    assert(res.reasons.includes('operator-local'),
      `expected operator-local for ${spelling}: ${JSON.stringify(res.reasons)}`);
  }
});

// ── G2 / C2 guard: pinned-commit isolation. Content present only in uncommitted working tree or
//    only in a later commit Q is refused at P; the Q-only references genuinely resolve at Q, which
//    proves the P refusal is isolation, not malformed data. ─────────────────────────────────────
test('G2 C2 [guard] a path or anchor added only in uncommitted working-tree content, or only in a later commit Q, is refused at pinned commit P — while the same Q-only path and anchor resolve at Q, and the uncommitted ones remain refused even at Q, proving pinned-commit isolation rather than malformed data', async () => {
  const w = makeWorld('g2');

  // Q-only: refused at P, resolved at Q.
  const qPathAtP = resolveAt(w, 'design-ref: LATER.md#LaterDoc', w.P);
  assert.strictEqual(qPathAtP.ok, false, 'a document added only in Q must be refused at P');
  assert(qPathAtP.reasons.includes('missing-path'), `expected missing-path at P: ${JSON.stringify(qPathAtP.reasons)}`);
  const qAnchorAtP = resolveAt(w, 'design-ref: DESIGN.md#QAnchor', w.P);
  assert.strictEqual(qAnchorAtP.ok, false, 'an anchor added only in Q must be refused at P');
  assert(qAnchorAtP.reasons.includes('missing-anchor'), `expected missing-anchor at P: ${JSON.stringify(qAnchorAtP.reasons)}`);

  const qPathAtQ = resolveAt(w, 'design-ref: LATER.md#LaterDoc', w.Q);
  assert.strictEqual(qPathAtQ.ok, true, `the Q-only document must resolve at Q: ${JSON.stringify(qPathAtQ.reasons)}`);
  assert.strictEqual(qPathAtQ.commit, w.Q, 'resolveIssue did not report commit Q');
  const qAnchorAtQ = resolveAt(w, 'design-ref: DESIGN.md#QAnchor', w.Q);
  assert.strictEqual(qAnchorAtQ.ok, true, `the Q-only anchor must resolve at Q: ${JSON.stringify(qAnchorAtQ.reasons)}`);

  // Uncommitted: refused at P and still refused at Q (it is committed to nothing).
  for (const commit of [w.P, w.Q]) {
    const wtPath = resolveAt(w, 'design-ref: NEWWT.md#WorkTreeDoc', commit);
    assert.strictEqual(wtPath.ok, false, 'an uncommitted document must never resolve from a commit');
    assert(wtPath.reasons.includes('missing-path'), `expected missing-path: ${JSON.stringify(wtPath.reasons)}`);
    const wtAnchor = resolveAt(w, 'design-ref: DESIGN.md#WorkingOnly', commit);
    assert.strictEqual(wtAnchor.ok, false, 'an uncommitted anchor must never resolve from a commit');
    assert(wtAnchor.reasons.includes('missing-anchor'), `expected missing-anchor: ${JSON.stringify(wtAnchor.reasons)}`);
  }
});

// ── G3 / C3 guard: the existing anchor forms still resolve at P, and their boundaries hold. A
//    literal heading title, a section-number-prefix form and explicit HTML id/name anchors all
//    resolve; a neighbouring nonexistent section number and a neighbouring nonexistent HTML id
//    remain refused. This file asserts NOTHING about Markdown slugs, so the new alias neither
//    satisfies nor breaks these. ────────────────────────────────────────────────────────────────
test('G3 C3 [guard] at pinned commit P a literal heading title, a section-number-prefix reference and explicit HTML id and name anchors all resolve, while a neighbouring nonexistent section number and a neighbouring nonexistent HTML id remain refused missing-anchor — section-prefix boundaries and exact HTML anchor identity preserved', async () => {
  const w = makeWorld('g3');

  const literal = resolveAt(w, 'design-ref: DESIGN.md#Glossary', w.P);
  assert.strictEqual(literal.ok, true, `a literal heading title must resolve at P: ${JSON.stringify(literal.reasons)}`);
  assert.strictEqual(literal.commit, w.P, 'resolveIssue did not report commit P');

  const section = resolveAt(w, 'design-ref: DESIGN.md#§4.10', w.P);
  assert.strictEqual(section.ok, true, `a section-number-prefix reference must resolve at P: ${JSON.stringify(section.reasons)}`);

  // Boundary: a neighbouring section number that is a textual prefix of no heading is refused.
  const sectionNeighbour = resolveAt(w, 'design-ref: DESIGN.md#§4.1', w.P);
  assert.strictEqual(sectionNeighbour.ok, false, 'a neighbouring nonexistent section number must be refused');
  assert(sectionNeighbour.reasons.includes('missing-anchor'),
    `expected missing-anchor for the neighbouring section number: ${JSON.stringify(sectionNeighbour.reasons)}`);

  const htmlId = resolveAt(w, 'design-ref: DESIGN.md#html-anchor-id', w.P);
  assert.strictEqual(htmlId.ok, true, `an explicit HTML id anchor must resolve at P: ${JSON.stringify(htmlId.reasons)}`);
  const htmlName = resolveAt(w, 'design-ref: DESIGN.md#named-anchor', w.P);
  assert.strictEqual(htmlName.ok, true, `an explicit HTML name anchor must resolve at P: ${JSON.stringify(htmlName.reasons)}`);

  // Exact HTML anchor identity: a neighbouring id that is not present is refused.
  const htmlNeighbour = resolveAt(w, 'design-ref: DESIGN.md#html-anchor-idX', w.P);
  assert.strictEqual(htmlNeighbour.ok, false, 'a neighbouring nonexistent HTML id must be refused');
  assert(htmlNeighbour.reasons.includes('missing-anchor'),
    `expected missing-anchor for the neighbouring HTML id: ${JSON.stringify(htmlNeighbour.reasons)}`);

  // Case-only variants are different HTML identities, for both id and name attributes.
  for (const anchor of ['HTML-anchor-id', 'NAMED-anchor']) {
    const caseVariant = resolveAt(w, `design-ref: DESIGN.md#${anchor}`, w.P);
    assert.strictEqual(caseVariant.ok, false, `a case-only HTML anchor variant must be refused: ${anchor}`);
    assert(caseVariant.reasons.includes('missing-anchor'),
      `expected missing-anchor for the case-only HTML variant: ${JSON.stringify(caseVariant.reasons)}`);
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
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
