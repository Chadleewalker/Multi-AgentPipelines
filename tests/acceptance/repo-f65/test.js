// Frozen acceptance test — repo-f65: make concurrent task PRs mergeable as a batch.
// This is the RED half; `guard.js` beside it is the whole of C5 and carries the checks that are
// already green at the fork point and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  a deterministic fixture runs two sibling task branches from ONE fork point that both
//       require shared-document updates, and the coordinator answers with a conflict-free
//       review sequence OR a single separately reviewable docs integration change carrying
//       both contributions — and nothing either task contributed is lost from the result.
//   C2  product/code commits stay isolated per task and may complete and publish
//       independently, and documentation coordination does not delay the first code PR from
//       becoming reviewable — proven where it counts, on the fixture whose docs reconciliation
//       FAILS.
//   C3  no automatic merge to the integration branch ever happens, and a failed rebase or a
//       failed docs reconciliation leaves explicit recoverable evidence and the affected issue
//       open or blocked.
//   C4  a batch-level report names pairwise merge readiness, shared paths, and any required
//       review order.
//
//   C5 is proven ENTIRELY by `guard.js` — it is a criterion about what did NOT change, so it is
//   green at the fork point by construction and a red file is the wrong home for it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module, function or command surface (see SPEC
// DEFECT 1 below), so this suite fixes one. Node built-ins and `git` only — synchronous, no
// container engine, no network, no `gh`, no `bd`. It is placed in `runner/` beside
// `runner/publish.js`, the publication boundary it extends, and beside `runner/lock.js`, whose
// host-side-only shape it copies; `scripts/` in this project is CLIs, and no criterion here
// names a command line.
//
// `runner/batch-merge.js` exports:
//
//   isSharedDocument(repoRelativePath) -> boolean
//     TRUE for exactly the paths a task's docs phase is allowed to write — a root-level
//     Markdown file (`^[^/]+\.md$`) or a Markdown file under `docs/` (`^docs/.+\.md$`), the
//     literal boundary `pipeline/entrypoint.sh`'s `docs_paths_allowed` already enforces. Every
//     other path is a PRODUCT path. One rule, one place: a coordinator that partitioned a
//     branch on a different boundary from the one the docs phase writes through would lift the
//     wrong bytes.
//
//   ISSUE_STATES = ['open', 'blocked']   exactly these two, in this order — the only states
//     this coordinator may ever ask for. It never closes an issue; closing is the runner's
//     settlement act (DESIGN.md §4.11).
//   EVIDENCE_VERSION = 1
//
//   plan({ repoDir, integrationBranch, batch, tasks }) -> BatchPlan | { ok: false, error }
//     `tasks` is [{ issueId, branch }], in the order the batch was run. A PURE READER: it
//     creates, moves and deletes no ref, touches no index and no working tree, and SIMULATES
//     every merge it reports (`git merge-tree --write-tree`, the `docs/threads/merge-order.md`
//     decision) rather than predicting it from changed-file overlap.
//
//     BatchPlan =
//       { ok: true, batch, integrationBranch, integrationHead, forkPoint,
//         autoMerge: false,                      // never anything else; C3
//         tasks: [ { issueId, branch, head, codeTip, mixed,
//                    productPaths: [...], sharedPaths: [...] } ],
//         sharedPaths: [...],                    // shared documents touched by MORE THAN ONE
//                                                // task, sorted, de-duplicated
//         pairwise: [ { a, b, ready, sharedPaths: [...], conflicts: [...] } ],
//         reviewSequence: [ { position, kind, ref, blockedBy: [...],
//                             issueId?, contributions? } ],
//         docsIntegration: { required, branch, contributions: [ { issueId, paths } ] } }
//
//     `codeTip` is the NEWEST commit already on the task branch whose diff from the fork point
//     touches product paths only — for a branch the pipeline produced, the
//     `Task <id>: implementation` commit that precedes the `Task <id>: docs` commit. It is an
//     EXISTING commit, never a rewrite: the code PR the runner already published stays exactly
//     what it was. `mixed` is true, and `codeTip` null, when no such commit exists because a
//     single commit mixes product and shared-document paths — a violation of C2's isolation
//     that is REPORTED rather than papered over.
//     `pairwise[].ready` is whether the two task branches AS PUBLISHED merge cleanly WITH EACH
//     OTHER, and `conflicts` the paths that conflicted in that simulation (SPEC DEFECT 5).
//     `reviewSequence[].kind` is 'code' or 'docs-integration'. `ref` is a rev this repository
//     can resolve for a code step, and for the docs step it is the branch name `integrateDocs`
//     will create — so the plan predicts it and the two cannot drift. `blockedBy` lists the
//     refs a step must not precede.
//
//   integrateDocs({ repoDir, integrationBranch, batch, tasks, deps })
//     -> { ok: true,  branch, commit, contributions: [ { issueId, paths } ] }
//     -> { ok: false, reason: 'docs-reconciliation', paths: [...], evidence, issues, error }
//     Creates ONE new branch off the integration branch carrying EVERY task's shared-document
//     contribution and no product bytes — the "single separately reviewable docs integration
//     change" of C1. ALL OR NOTHING: a reconciliation that cannot carry every contribution
//     creates no branch at all, because a half-reconciled docs branch is not separately
//     reviewable.
//
//   rebaseTask({ repoDir, integrationBranch, batch, task, deps })
//     -> { ok: true,  branch, commit }      // a NEW ref; the task's own branch never moves
//     -> { ok: false, reason: 'rebase', paths: [...], evidence, issues, error }
//
//   renderReport(plan) -> markdown string          // C4
//   evidenceDir({ repoDir }) -> absolute path      // PIPELINE_BATCH_EVIDENCE_DIR when set,
//                                                  // else <repoDir>/runs/merge-batch
//   listEvidence({ repoDir }) -> [ record ]        // oldest first, readable by a LATER process
//
//   `evidence` is the absolute path of one record inside `evidenceDir`, JSON on disk:
//     { version: 1, kind: 'docs-reconciliation' | 'rebase', batch, at, integrationBranch,
//       integrationHead, forkPoint,
//       paths: [...],                            // what would not reconcile, named
//       tasks:  [ { issueId, branch, head } ],
//       issues: [ { issueId, state, reason } ],  // state ∈ ISSUE_STATES
//       recover: '<one line a person can act on>' }
//
//   `deps.setIssueState(issueId, state, reason)` is the Beads seam. Supplied: it is called
//   once per entry of `issues`, and never with any state outside ISSUE_STATES. Absent: the
//   transition is still recorded in the evidence and in `result.issues`, so a coordinator run
//   on a host with no `bd` degrades by naming rather than by forgetting.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// SPEC DEFECTS, REPORTED NOT PAPERED OVER.
//
//  1. THE ISSUE NAMES NO SURFACE. Not a module, not a function, not a flag — only behaviour
//     ("the coordinator produces…", "a batch-level report names…"). A frozen suite cannot
//     assert behaviour without naming the thing that behaves, so the block above IS the missing
//     half of the spec and every check below is written against it. An implementation that
//     satisfies the criteria through a differently-named surface is not wrong about the issue;
//     it is wrong about this suite, and the suite is what freezes.
//
//  2. C1's "OR" IS A REAL DISJUNCTION AND IS TESTED AS ONE. "a conflict-free review sequence or
//     a single separately reviewable docs integration change containing both contributions"
//     names two different artifacts and is satisfied by either, so the C1 verdict check below
//     is `sequence-arm OR docs-arm`, with both arms' findings printed in its detail, rather
//     than a conjunction this suite would be inventing. What IS asserted unconditionally is the
//     thing both arms exist to deliver and neither states outright: that nothing either task
//     contributed is lost from the batch result. A coordinator that satisfies an arm by
//     dropping a contribution has answered the letter and not the issue, and that check is
//     where this suite says so.
//
//  3. C1's FIXTURE IS UNDER-SPECIFIED. "two sibling task branches … that both require
//     shared-document updates" does not say whether those updates COLLIDE. If they do not,
//     ordinary `git merge` already produces a conflict-free sequence and the criterion is
//     satisfied by an empty implementation — non-discriminating, which is the exact failure
//     `scripts/freeze-gate.js` exists to catch. So the fixture below is the hard reading, and
//     the suite PROVES it is hard before it asks the coordinator for anything: both branches
//     append a row at the same end-of-file position of `docs/change-log.md`, so a plain merge
//     of the two task branches CONFLICTS. That is not invented — it is the case
//     `docs/planning-draft-2026-08-26-doc-contention.md` measured, where "three of the four
//     were resolved by making the identical edit: keep both change-log rows".
//
//  4. THE FIXTURE DELIBERATELY CARRIES NO `.gitattributes`. This repository marks its own
//     `docs/change-log.md` `merge=union`, which resolves exactly the collision in defect 3 —
//     but that is a property of THIS repository, and the coordinator is being frozen against
//     target repositories generally. A fixture that shipped the union attribute would be
//     measuring git, not the coordinator.
//
//  5. "PAIRWISE MERGE READINESS" (C4) DOES NOT SAY WHICH TWO THINGS ARE MERGED. Two task
//     branches as published, or the two code tips this coordinator separates out? It is read
//     as the FIRST — readiness is a fact about the PRs a reviewer is holding, and a report that
//     said "ready" about an artifact the reviewer cannot see would be worse than silent. So in
//     the fixture below the one pair is NOT ready and its conflict is `docs/change-log.md`,
//     which the suite verifies by running that merge itself.
//
//  6. C3's "the affected issue" IS SINGULAR AND THE FAILURE IS NOT. A docs reconciliation that
//     will not carry two contributions has two candidate owners. Read as: at least one of the
//     batch's issues is left in a state from ISSUE_STATES, none is closed, and every issue the
//     coordinator names is one of the batch's own. Naming both is legal; naming none is not.
//
//  7. C3's "no automatic merge to the integration branch" IS READ AS A MEASUREMENT, not a
//     promise. Every entry point below is called between two snapshots of the repository, and
//     the integration branch's sha, HEAD, the symbolic ref, the porcelain status and the
//     absence of an in-progress merge/rebase/cherry-pick must be identical across the call.
//     Creating the docs integration branch is a NEW ref and is not a merge to the integration
//     branch; `plan` may create no ref at all, because it is a reader.
//
//  8. C5's SUITES ARE FROZEN PATHS. `guard.js` explains what it does about that.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BATCH_MERGE = path.join(REPO, 'runner', 'batch-merge.js');

// Fixtures are routinely owned by another uid inside a container, and a frozen test must not
// depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}
function rmrf(target) {
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walk(path.join(p, n));
    }
  };
  walk(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}
const fwd = (p) => String(p).split(path.sep).join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-f65-'));
const savedEvidenceEnv = process.env.PIPELINE_BATCH_EVIDENCE_DIR;
delete process.env.PIPELINE_BATCH_EVIDENCE_DIR;

// The coordinator, loaded defensively. Every product call goes through `call`, so a module that
// is absent, unloadable or throwing produces one named FAILURE PER CRITERION instead of a
// single stack that says nothing about which criterion went.
let coordinator = null;
let loadError = '';
try { coordinator = require(BATCH_MERGE); }
catch (e) { coordinator = null; loadError = (e && e.message) || String(e); }
const hasFn = (name) => !!coordinator && typeof coordinator[name] === 'function';
function call(name, arg) {
  if (!hasFn(name)) {
    return { ok: false, error: `runner/batch-merge.js does not export ${name}()${loadError ? ` (${loadError})` : ''}` };
  }
  try {
    const answer = coordinator[name](arg);
    // Answers pass through as they are — `evidenceDir` returns a string and `listEvidence` an
    // array. Only "nothing at all" is turned into a refusal, so no check reads a property of
    // undefined and reports a stack instead of a criterion.
    return (answer === undefined || answer === null)
      ? { ok: false, error: `${name}() answered nothing` } : answer;
  } catch (e) { return { ok: false, error: `${name}() threw: ${(e && e.message) || e}` }; }
}

// ---- git helpers the suite computes its own answers with ------------------------------------
// Everything this suite claims about a merge is a merge it RAN, in the fixture, from the same
// repository the coordinator was pointed at. Nothing is taken on the coordinator's word.

const write = (dir, rel, text) => {
  const full = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
const sha = (dir, rev) => String(git(dir, 'rev-parse', rev).stdout || '').trim();
const show = (dir, ref, rel) => {
  const r = git(dir, 'show', `${ref}:${rel}`);
  return r.status === 0 ? String(r.stdout || '') : null;
};
const namesIn = (dir, from, to) => String(git(dir, 'diff', '--name-only', from, to).stdout || '')
  .split('\n').map((s) => s.trim()).filter(Boolean).sort();
function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  return sha(dir, 'HEAD');
}
function refMap(dir) {
  const out = {};
  for (const line of String(git(dir, 'show-ref').stdout || '').split('\n').filter(Boolean)) {
    const space = line.indexOf(' ');
    out[line.slice(space + 1)] = line.slice(0, space);
  }
  return out;
}
const sameRefs = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]))
  === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD',
  'rebase-merge', 'rebase-apply'];
function snapshot(dir, integrationBranch) {
  return JSON.stringify({
    integration: sha(dir, integrationBranch),
    head: sha(dir, 'HEAD'),
    symbolic: String(git(dir, 'symbolic-ref', '-q', 'HEAD').stdout || '').trim(),
    porcelain: String(git(dir, 'status', '--porcelain').stdout || '').trim(),
    inProgress: IN_PROGRESS.filter((f) => fs.existsSync(path.join(dir, '.git', f))),
  });
}

// `git merge-tree --write-tree` performs the merge in memory and names every conflicted path;
// exit 0 is clean, 1 is conflicted, anything else is the tool failing rather than answering.
function mergeTree(dir, base, other) {
  const r = git(dir, 'merge-tree', '--write-tree', '--name-only', base, other);
  const out = String(r.stdout || '');
  const tree = (out.split('\n')[0] || '').trim();
  if (r.status === 0) return { ran: true, clean: true, tree, out };
  if (r.status === 1) return { ran: true, clean: false, tree, out };
  return {
    ran: false, clean: false, tree: '', out,
    error: `merge-tree exited ${r.status}: ${String(r.stderr || '').trim()}`,
  };
}
function commitTree(dir, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  return String(git(dir, ...args).stdout || '').trim();
}
// Chain the simulation through `commit-tree`, so step N is merged into the tree steps 1..N-1
// actually produced. Every conflict reported below is one that HAPPENED.
function simulate(dir, start, refs) {
  let cur = start;
  for (const ref of refs) {
    if (!ref || !/^[0-9a-f]{40}$/.test(sha(dir, String(ref)))) {
      return { ok: false, clean: false, why: `step ref ${JSON.stringify(ref)} does not resolve in the fixture` };
    }
    const m = mergeTree(dir, cur, String(ref));
    if (!m.ran) return { ok: false, clean: false, why: m.error };
    if (!m.clean) {
      return {
        ok: true, clean: false, head: cur,
        why: `conflict merging ${ref}: ${m.out.split('\n').slice(1, 4).join(' ')}`,
      };
    }
    cur = commitTree(dir, m.tree, [cur, String(ref)], 'f65 simulation');
    if (!/^[0-9a-f]{40}$/.test(cur)) return { ok: false, clean: false, why: `commit-tree failed after ${ref}` };
  }
  return { ok: true, clean: true, why: 'every step merged clean', head: cur };
}
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;
function conflictMarkersIn(dir, ref) {
  const files = String(git(dir, 'ls-tree', '-r', '--name-only', ref).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return files.filter((f) => CONFLICT_MARKER.test(show(dir, ref, f) || ''));
}
// The docs-phase boundary, restated here because the suite must be able to disagree with the
// module about it — `isSharedDocument` is itself under test.
const shared = (p) => /^[^/]+\.md$/i.test(p) || /^docs\/.+\.md$/i.test(p);
const within = (parent, child) => {
  const rel = path.relative(path.resolve(String(parent)), path.resolve(String(child)));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// ---- the fixture ------------------------------------------------------------------------------

const DESIGN = [
  '# Design', '',
  '## 1. Intake',
  'intake line one', 'intake line two',
  'INTAKE-BODY',
  'intake line three', 'intake line four', '',
  '## 2. Queue',
  'queue line one', 'queue line two', 'queue line three', 'queue line four', 'queue line five', '',
  '## 3. Review',
  'review line one', 'review line two',
  'REVIEW-BODY',
  'review line three', 'review line four', '',
].join('\n');
const CHANGELOG = [
  '| Date | Ref | What |',
  '|---|---|---|',
  '| 2026-08-01 | seed | the row that was already here |',
  '',
].join('\n');
const STATUS = (stamp) => ['# Status', '', `_Last updated: ${stamp}_`, '',
  'Everything upstream of the merge pass has scaffolding.', ''].join('\n');
const BASE = {
  // `runs/` is where host-only output goes (DESIGN.md §5), so evidence written there must not
  // dirty the target working copy. Ignoring it is what makes C3's porcelain snapshot honest.
  '.gitignore': 'runs/\n',
  'pipeline.config.json': `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'true',
    regressionPolicy: 'required',
    defaultBranch: 'main',
    frozenPaths: ['tools/run-acceptance.sh'],
  }, null, 2)}\n`,
  'runner/alpha.js': '// alpha v0\n',
  'runner/beta.js': '// beta v0\n',
  'runner/gamma.js': '// gamma v0\n',
  'DESIGN.md': DESIGN,
  'docs/change-log.md': CHANGELOG,
  'docs/STATUS.md': STATUS('2026-09-01'),
};

function target(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'f65 fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, text] of Object.entries(BASE)) write(dir, rel, text);
  const fork = commitAll(dir, 'integration base');
  return { dir, fork };
}
// One task branch in the shape `pipeline/entrypoint.sh` actually produces: an implementation
// commit, then a separate `Task <id>: docs` commit. `mix` collapses the two, which is the C2
// isolation violation the plan has to report rather than assume away.
function taskBranch(dir, issueId, base, codeEdits, docsEdits, mix = false) {
  const branch = `task/${issueId}`;
  git(dir, 'checkout', '-q', '-b', branch, base);
  for (const [rel, text] of Object.entries(codeEdits)) write(dir, rel, text);
  const code = mix ? null : commitAll(dir, `Task ${issueId}: implementation (verified on attempt 1)`);
  for (const [rel, text] of Object.entries(docsEdits)) write(dir, rel, text);
  const head = commitAll(dir, mix
    ? `Task ${issueId}: implementation and docs in one commit`
    : `Task ${issueId}: docs`);
  git(dir, 'checkout', '-q', 'main');
  return { issueId, branch, code, head };
}
const taskArg = (t) => ({ issueId: t.issueId, branch: t.branch });

const ALPHA_CODE = { 'runner/alpha.js': '// alpha v1 — the alpha task\n' };
const BETA_CODE = { 'runner/beta.js': '// beta v1 — the beta task\n' };
const ALPHA_DOCS = {
  'DESIGN.md': DESIGN.replace('INTAKE-BODY', 'INTAKE-BODY, amended by the alpha task'),
  'docs/change-log.md': `${CHANGELOG}| 2026-09-08 | f65-alpha | the alpha row |\n`,
};
const BETA_DOCS = {
  'DESIGN.md': DESIGN.replace('REVIEW-BODY', 'REVIEW-BODY, amended by the beta task'),
  'docs/change-log.md': `${CHANGELOG}| 2026-09-08 | f65-beta | the beta row |\n`,
};

function body() {
  // FIXTURE ONE — the reconcilable batch. Two siblings off ONE fork point, disjoint product
  // files, both amending `DESIGN.md` (in different sections) and both appending a row at the
  // same end-of-file position of `docs/change-log.md`.
  const one = target('reconcilable');
  const oneAlpha = taskBranch(one.dir, 'f65-alpha', one.fork, ALPHA_CODE, ALPHA_DOCS);
  const oneBeta = taskBranch(one.dir, 'f65-beta', one.fork, BETA_CODE, BETA_DOCS);
  const ONE_TASKS = [taskArg(oneAlpha), taskArg(oneBeta)];

  // FIXTURE TWO — the irreconcilable batch. Identical, except that both docs commits also
  // rewrite the SAME `_Last updated:` line of `docs/STATUS.md` to different values. That is an
  // edit/edit collision on one line: git will not resolve it, and neither may a coordinator —
  // `docs/planning-draft-2026-08-26-doc-contention.md` records keeping both copies of an
  // amended line as "the option that looks cheapest and is the most dangerous".
  const two = target('irreconcilable');
  const twoAlpha = taskBranch(two.dir, 'f65-alpha', two.fork, ALPHA_CODE,
    { ...ALPHA_DOCS, 'docs/STATUS.md': STATUS('2026-09-07, by the alpha task') });
  const twoBeta = taskBranch(two.dir, 'f65-beta', two.fork, BETA_CODE,
    { ...BETA_DOCS, 'docs/STATUS.md': STATUS('2026-09-08, by the beta task') });
  const TWO_TASKS = [taskArg(twoAlpha), taskArg(twoBeta)];

  // FIXTURE THREE — the integration branch moved under the batch, conflicting with one task's
  // product commit and not with the other's.
  const three = target('moved');
  const threeAlpha = taskBranch(three.dir, 'f65-alpha', three.fork, ALPHA_CODE, ALPHA_DOCS);
  const threeBeta = taskBranch(three.dir, 'f65-beta', three.fork, BETA_CODE, BETA_DOCS);
  git(three.dir, 'checkout', '-q', 'main');
  write(three.dir, 'runner/alpha.js', '// alpha v1 — somebody else got there first\n');
  const threeMoved = commitAll(three.dir, 'integration moved on');

  // FIXTURE FOUR — one task whose single commit mixes a product path and a shared document.
  const four = target('mixed');
  const fourAlpha = taskBranch(four.dir, 'f65-alpha', four.fork, ALPHA_CODE, ALPHA_DOCS);
  const fourGamma = taskBranch(four.dir, 'f65-gamma', four.fork,
    { 'runner/gamma.js': '// gamma v1 — the gamma task\n' },
    { 'DESIGN.md': DESIGN.replace('queue line three', 'queue line three, amended by the gamma task') },
    true);

  // ---- C1 · the fixture is the hard case, and it is honest about being one ---------------------

  check('C1 harness: the two task branches are siblings off ONE fork point',
    sha(one.dir, `${oneAlpha.branch}~2`) === one.fork
    && sha(one.dir, `${oneBeta.branch}~2`) === one.fork
    && String(git(one.dir, 'merge-base', oneAlpha.branch, oneBeta.branch).stdout || '').trim() === one.fork,
    `fork ${one.fork}`);
  check('C1 harness: BOTH task branches require shared-document updates, and the same ones',
    namesIn(one.dir, one.fork, oneAlpha.branch).filter(shared).join(',') === 'DESIGN.md,docs/change-log.md'
    && namesIn(one.dir, one.fork, oneBeta.branch).filter(shared).join(',') === 'DESIGN.md,docs/change-log.md',
    `${namesIn(one.dir, one.fork, oneAlpha.branch)} / ${namesIn(one.dir, one.fork, oneBeta.branch)}`);
  check('C1 harness: their PRODUCT changes are disjoint, so nothing but the documents collides',
    namesIn(one.dir, one.fork, oneAlpha.branch).filter((p) => !shared(p)).join(',') === 'runner/alpha.js'
    && namesIn(one.dir, one.fork, oneBeta.branch).filter((p) => !shared(p)).join(',') === 'runner/beta.js');
  const plainMerge = mergeTree(one.dir, oneAlpha.head, oneBeta.head);
  check('C1 harness: merge-tree can simulate a merge in this fixture at all', plainMerge.ran,
    plainMerge.error);
  check('C1 harness: a PLAIN merge of the two task branches CONFLICTS — the fixture is the hard case',
    plainMerge.ran && plainMerge.clean === false && /docs\/change-log\.md/.test(plainMerge.out),
    plainMerge.out.split('\n').slice(0, 4).join(' | '));

  // ---- C1 · what the coordinator answers -------------------------------------------------------

  const oneRefsBeforePlan = refMap(one.dir);
  const oneSnapBefore = snapshot(one.dir, 'main');
  const onePlan = call('plan', {
    repoDir: one.dir, integrationBranch: 'main', batch: 'f65-one', tasks: ONE_TASKS,
  });
  const oneRefsAfterPlan = refMap(one.dir);
  check('C1 the coordinator plans the batch and names the single fork point it read',
    onePlan.ok === true && onePlan.batch === 'f65-one' && onePlan.integrationBranch === 'main'
    && onePlan.forkPoint === one.fork && onePlan.integrationHead === sha(one.dir, 'main'),
    onePlan.error || JSON.stringify({ batch: onePlan.batch, forkPoint: onePlan.forkPoint }));

  const oneDocs = call('integrateDocs', {
    repoDir: one.dir, integrationBranch: 'main', batch: 'f65-one', tasks: ONE_TASKS,
  });
  const planDocs = onePlan.docsIntegration || {};
  check('C1 a reconcilable batch yields ONE docs integration branch the plan predicted by name',
    oneDocs.ok === true && typeof oneDocs.branch === 'string' && oneDocs.branch.length > 0
    && planDocs.required === true && planDocs.branch === oneDocs.branch
    && (planDocs.contributions || []).map((c) => c && c.issueId).sort().join(',') === 'f65-alpha,f65-beta',
    oneDocs.error || JSON.stringify({ made: oneDocs.branch, planned: planDocs }));

  const docsRef = (oneDocs.ok && oneDocs.branch) ? refMap(one.dir)[`refs/heads/${oneDocs.branch}`] : null;
  const contributions = Array.isArray(oneDocs.contributions) ? oneDocs.contributions : [];
  check('C1 that branch exists as a real reviewable ref and credits BOTH tasks as contributors',
    /^[0-9a-f]{40}$/.test(String(docsRef || ''))
    && contributions.map((c) => c && c.issueId).sort().join(',') === 'f65-alpha,f65-beta',
    `ref ${docsRef} contributions ${JSON.stringify(contributions)}`);

  const docsDesign = docsRef ? show(one.dir, oneDocs.branch, 'DESIGN.md') : null;
  const docsLog = docsRef ? show(one.dir, oneDocs.branch, 'docs/change-log.md') : null;
  check('C1 the docs integration change carries BOTH tasks\' shared-document contributions',
    !!docsDesign && /amended by the alpha task/.test(docsDesign) && /amended by the beta task/.test(docsDesign)
    && !!docsLog && /\| f65-alpha \|/.test(docsLog) && /\| f65-beta \|/.test(docsLog),
    JSON.stringify({ design: docsDesign, log: docsLog }).slice(0, 400));
  check('C1 it is REVIEWABLE — no conflict marker survives anywhere in its tree',
    !!docsRef && conflictMarkersIn(one.dir, oneDocs.branch).length === 0,
    docsRef ? conflictMarkersIn(one.dir, oneDocs.branch).join(',') : 'no branch');
  const docsOnlyPaths = docsRef ? namesIn(one.dir, 'main', oneDocs.branch) : [];
  check('C1 it is SEPARATE — it differs from the integration branch in shared documents only',
    !!docsRef && docsOnlyPaths.length > 0 && docsOnlyPaths.every(shared)
    && docsOnlyPaths.includes('DESIGN.md') && docsOnlyPaths.includes('docs/change-log.md'),
    docsOnlyPaths.join(','));
  const docsOntoIntegration = docsRef ? mergeTree(one.dir, 'main', oneDocs.branch)
    : { ran: false, clean: false, out: 'no branch' };
  check('C1 and it merges onto the integration branch by itself, with no judgment left over',
    docsOntoIntegration.ran && docsOntoIntegration.clean === true,
    String(docsOntoIntegration.out || docsOntoIntegration.error).split('\n').slice(0, 4).join(' | '));

  // The sequence arm, simulated step by step from the integration branch in the order the
  // coordinator gave. Nothing here is taken on the plan's word: every merge is run.
  const oneSeq = Array.isArray(onePlan.reviewSequence) ? onePlan.reviewSequence : [];
  const oneSeqRefs = oneSeq.map((s) => s && s.ref);
  const oneSim = oneSeq.length ? simulate(one.dir, sha(one.dir, 'main'), oneSeqRefs)
    : { ok: false, clean: false, why: 'the plan named no review sequence' };
  const armSequence = oneSim.ok === true && oneSim.clean === true;
  const armDocs = oneDocs.ok === true && !!docsRef
    && contributions.map((c) => c && c.issueId).sort().join(',') === 'f65-alpha,f65-beta'
    && docsOntoIntegration.clean === true;
  check('C1 the coordinator answers this batch with a conflict-free review sequence OR one separately reviewable docs integration change',
    armSequence || armDocs,
    `sequence arm: ${oneSim.why} (${JSON.stringify(oneSeqRefs)}); docs arm: ${armDocs ? 'present' : (oneDocs.error || 'absent or incomplete')}`);

  // SPEC DEFECT 2: neither arm is required to be lossless, and the issue title is about the
  // batch being mergeable. This is where that is asserted, against whichever arm answered.
  let oneFinal = armSequence ? oneSim.head : null;
  let lossWhy = oneSim.why;
  if (!oneFinal) {
    const tips = (Array.isArray(onePlan.tasks) ? onePlan.tasks : []).map((t) => t && t.codeTip);
    const refs = [...tips, oneDocs.ok ? oneDocs.branch : null].filter(Boolean);
    const fallback = refs.length ? simulate(one.dir, sha(one.dir, 'main'), refs)
      : { ok: false, clean: false, why: 'the coordinator produced nothing to simulate' };
    lossWhy = `${lossWhy}; code-tips-then-docs: ${fallback.why}`;
    oneFinal = (fallback.ok && fallback.clean) ? fallback.head : null;
  }
  check('C1 nothing either task contributed is lost from the batch result',
    !!oneFinal
    && /alpha v1/.test(show(one.dir, oneFinal, 'runner/alpha.js') || '')
    && /beta v1/.test(show(one.dir, oneFinal, 'runner/beta.js') || '')
    && /amended by the alpha task/.test(show(one.dir, oneFinal, 'DESIGN.md') || '')
    && /amended by the beta task/.test(show(one.dir, oneFinal, 'DESIGN.md') || '')
    && /\| f65-alpha \|/.test(show(one.dir, oneFinal, 'docs/change-log.md') || '')
    && /\| f65-beta \|/.test(show(one.dir, oneFinal, 'docs/change-log.md') || ''),
    oneFinal ? `merged tree of ${oneFinal}` : `no conflict-free batch result was produced — ${lossWhy}`);

  // ---- C2 · product commits stay isolated per task and publish independently --------------------

  const boundaryDirectories = ['', 'docs', 'docs/threads', 'runner', 'tools',
    'tests/acceptance/repo-f65'];
  const boundaryNames = ['DESIGN', 'change-log', 'pipeline-map', 'test'];
  // The docs phase deliberately accepts Markdown case-insensitively. Keep uppercase in this
  // corpus so a coordinator cannot silently drift to a narrower, case-sensitive partition.
  const boundaryExtensions = ['.md', '.MD', '.txt', '.html', '.js', '.json'];
  const boundaryCorpus = boundaryDirectories.flatMap((dir) => boundaryNames.flatMap((name) =>
    boundaryExtensions.map((ext) => `${dir ? `${dir}/` : ''}${name}${ext}`)));
  const docsPhaseOwns = (p) => /^[^/]+\.md$/i.test(p) || /^docs\/.+\.md$/i.test(p);
  check('C2 the shared-document boundary is exactly the one the docs phase writes through',
    hasFn('isSharedDocument')
    && boundaryCorpus.every((p) => coordinator.isSharedDocument(p) === docsPhaseOwns(p)),
    'isSharedDocument must match the docs phase case-insensitively and nothing else');

  const onePlanTasks = Array.isArray(onePlan.tasks) ? onePlan.tasks : [];
  const byId = (id) => onePlanTasks.find((t) => t && t.issueId === id) || {};
  const rowA = byId('f65-alpha');
  const rowB = byId('f65-beta');
  const tipA = rowA.codeTip;
  const tipB = rowB.codeTip;
  const isAncestor = (dir, a, b) => !!a && !!b
    && git(dir, 'merge-base', '--is-ancestor', String(a), String(b)).status === 0;
  check('C2 each task\'s code tip is an EXISTING commit on its own branch, not a rewrite',
    isAncestor(one.dir, tipA, oneAlpha.branch) && isAncestor(one.dir, tipB, oneBeta.branch)
    && tipA === oneAlpha.code && tipB === oneBeta.code && rowA.mixed === false && rowB.mixed === false,
    JSON.stringify({ tipA, expectedA: oneAlpha.code, tipB, expectedB: oneBeta.code }));
  check('C2 that code tip is BEFORE the docs commit — the two are not the same commit',
    !!tipA && !!tipB && tipA !== oneAlpha.head && tipB !== oneBeta.head
    && rowA.head === oneAlpha.head && rowB.head === oneBeta.head,
    JSON.stringify({ tipA, headA: oneAlpha.head, tipB, headB: oneBeta.head }));
  check('C2 a code tip carries no shared-document bytes at all',
    !!tipA && !!tipB
    && namesIn(one.dir, one.fork, tipA).every((p) => !shared(p))
    && namesIn(one.dir, one.fork, tipB).every((p) => !shared(p)),
    JSON.stringify({
      a: tipA ? namesIn(one.dir, one.fork, tipA) : null,
      b: tipB ? namesIn(one.dir, one.fork, tipB) : null,
    }));
  check('C2 and it is isolated per task — neither code tip touches the other task\'s paths',
    !!tipA && !!tipB
    && namesIn(one.dir, one.fork, tipA).join(',') === 'runner/alpha.js'
    && namesIn(one.dir, one.fork, tipB).join(',') === 'runner/beta.js');
  check('C2 the plan says which paths of each task are product and which are shared documents',
    (rowA.productPaths || []).slice().sort().join(',') === 'runner/alpha.js'
    && (rowA.sharedPaths || []).slice().sort().join(',') === 'DESIGN.md,docs/change-log.md'
    && (rowB.productPaths || []).slice().sort().join(',') === 'runner/beta.js'
    && (rowB.sharedPaths || []).slice().sort().join(',') === 'DESIGN.md,docs/change-log.md',
    JSON.stringify({ rowA, rowB }));

  const soloA = tipA ? mergeTree(one.dir, 'main', String(tipA)) : { ran: false, clean: false, out: 'no code tip' };
  const soloB = tipB ? mergeTree(one.dir, 'main', String(tipB)) : { ran: false, clean: false, out: 'no code tip' };
  const orderAB = (tipA && tipB) ? simulate(one.dir, sha(one.dir, 'main'), [tipA, tipB])
    : { ok: false, clean: false, why: 'the plan named no code tips' };
  const orderBA = (tipA && tipB) ? simulate(one.dir, sha(one.dir, 'main'), [tipB, tipA])
    : { ok: false, clean: false, why: 'the plan named no code tips' };
  check('C2 either code PR may complete independently — each merges onto the integration branch alone',
    soloA.ran && soloA.clean === true && soloB.ran && soloB.clean === true,
    `${soloA.out || soloA.error} / ${soloB.out || soloB.error}`);
  check('C2 ... and in either order, so neither waits on the other',
    orderAB.ok === true && orderAB.clean === true && orderBA.ok === true && orderBA.clean === true,
    `${orderAB.why} / ${orderBA.why}`);

  const firstStep = oneSeq[0] || {};
  const docsSteps = oneSeq.filter((s) => s && s.kind === 'docs-integration');
  const codeSteps = oneSeq.filter((s) => s && s.kind === 'code');
  const plannedTaskCount = Array.isArray(onePlan.tasks) ? onePlan.tasks.length : 0;
  check('C2 documentation coordination does not delay the first code PR — the first step is code, blocked by nothing',
    firstStep.kind === 'code' && Array.isArray(firstStep.blockedBy) && firstStep.blockedBy.length === 0,
    JSON.stringify(firstStep));
  check('C2 no code step is made to wait on the docs integration step',
    plannedTaskCount === ONE_TASKS.length
    && codeSteps.length === plannedTaskCount
    && docsSteps.length === Number(Boolean(onePlan.docsIntegration && onePlan.docsIntegration.required))
    && codeSteps.every((s) => Array.isArray(s.blockedBy)
      && !s.blockedBy.includes(docsSteps[0].ref) && !s.blockedBy.includes('docs-integration')),
    JSON.stringify(oneSeq));

  // The case that actually decides C2: the docs will NOT reconcile, and the code PRs must be
  // unaffected — reviewable, independent, and still first.
  const twoPlan = call('plan', {
    repoDir: two.dir, integrationBranch: 'main', batch: 'f65-two', tasks: TWO_TASKS,
  });
  const twoTips = (Array.isArray(twoPlan.tasks) ? twoPlan.tasks : []).map((t) => t && t.codeTip);
  const twoSeq = Array.isArray(twoPlan.reviewSequence) ? twoPlan.reviewSequence : [];
  const twoCode = twoSeq.filter((s) => s && s.kind === 'code');
  const twoTaskCount = Array.isArray(twoPlan.tasks) ? twoPlan.tasks.length : 0;
  const twoCodeSim = (twoTips.length === twoTaskCount && twoTips.every(Boolean))
    ? simulate(two.dir, sha(two.dir, 'main'), twoTips)
    : { ok: false, clean: false, why: 'the plan named no code tips' };
  check('C2 a batch whose docs will not reconcile still plans, and still names both code PRs first',
    twoPlan.ok === true && twoTaskCount === TWO_TASKS.length
    && twoCode.length === twoTaskCount
    && twoSeq.slice(0, twoTaskCount).every((s) => s && s.kind === 'code')
    && twoCode.every((s) => Array.isArray(s.blockedBy) && s.blockedBy.length === 0),
    twoPlan.error || JSON.stringify(twoSeq));
  check('C2 ... and those code PRs are still mergeable as a batch on their own',
    twoCodeSim.ok === true && twoCodeSim.clean === true, twoCodeSim.why);

  // The isolation claim needs a detector for its violation, or the plan could assert isolation
  // without ever having looked.
  const fourPlan = call('plan', {
    repoDir: four.dir, integrationBranch: 'main', batch: 'f65-four',
    tasks: [taskArg(fourAlpha), taskArg(fourGamma)],
  });
  const gammaRow = (Array.isArray(fourPlan.tasks) ? fourPlan.tasks : [])
    .find((t) => t && t.issueId === 'f65-gamma') || {};
  check('C2 a task whose single commit MIXES product and shared-document paths is reported, not assumed clean',
    fourPlan.ok === true && gammaRow.mixed === true && gammaRow.codeTip === null
    && !(Array.isArray(fourPlan.reviewSequence) ? fourPlan.reviewSequence : [])
      .some((s) => s && s.kind === 'code' && s.issueId === 'f65-gamma'),
    fourPlan.error || JSON.stringify(gammaRow));

  // ---- C3 · nothing is merged automatically, and every failure leaves recoverable evidence ------

  check('C3 the plan says in so many words that it merged nothing', onePlan.autoMerge === false,
    JSON.stringify({ autoMerge: onePlan.autoMerge }));
  check('C3 planning is a pure read — it created, moved and deleted no ref',
    sameRefs(oneRefsBeforePlan, oneRefsAfterPlan),
    `${JSON.stringify(Object.keys(oneRefsBeforePlan))} -> ${JSON.stringify(Object.keys(oneRefsAfterPlan))}`);
  check('C3 a SUCCESSFUL docs integration still does not merge to the integration branch',
    snapshot(one.dir, 'main') === oneSnapBefore,
    `${oneSnapBefore} -> ${snapshot(one.dir, 'main')}`);

  // A failed docs reconciliation. The Beads seam is injected and every call recorded.
  const twoSnapBefore = snapshot(two.dir, 'main');
  const twoRefsBefore = refMap(two.dir);
  const beadsCalls = [];
  const twoDocs = call('integrateDocs', {
    repoDir: two.dir, integrationBranch: 'main', batch: 'f65-two', tasks: TWO_TASKS,
    deps: { setIssueState: (issueId, state, reason) => { beadsCalls.push({ issueId, state, reason }); } },
  });
  check('C3 a docs reconciliation that cannot carry both contributions is REFUSED, and names the document',
    twoDocs.ok === false && twoDocs.reason === 'docs-reconciliation'
    && /docs\/STATUS\.md/.test(`${twoDocs.error || ''} ${JSON.stringify(twoDocs.paths || [])}`),
    JSON.stringify(twoDocs));
  check('C3 ... all or nothing: no half-reconciled docs branch is left behind',
    sameRefs(twoRefsBefore, refMap(two.dir)),
    `${JSON.stringify(Object.keys(twoRefsBefore))} -> ${JSON.stringify(Object.keys(refMap(two.dir)))}`);
  check('C3 ... and the integration branch, HEAD and working tree are exactly as they were',
    snapshot(two.dir, 'main') === twoSnapBefore, `${twoSnapBefore} -> ${snapshot(two.dir, 'main')}`);

  let twoEvidence = null;
  try { twoEvidence = JSON.parse(fs.readFileSync(String(twoDocs.evidence), 'utf8')); }
  catch { twoEvidence = null; }
  const twoEvidenceHome = call('evidenceDir', { repoDir: two.dir });
  check('C3 the refusal leaves an EXPLICIT evidence record on disk, versioned and machine-readable',
    !!twoEvidence && coordinator.EVIDENCE_VERSION === 1 && twoEvidence.version === 1
    && twoEvidence.kind === 'docs-reconciliation' && twoEvidence.batch === 'f65-two'
    && twoEvidence.integrationBranch === 'main' && twoEvidence.forkPoint === two.fork,
    `${twoDocs.evidence}: ${JSON.stringify(twoEvidence)}`);
  check('C3 that record lives in the coordinator\'s own evidence directory, not loose in the target',
    typeof twoEvidenceHome === 'string' && within(twoEvidenceHome, String(twoDocs.evidence)),
    `${JSON.stringify(twoEvidenceHome)} vs ${JSON.stringify(twoDocs.evidence)}`);
  check('C3 the evidence names the document that would not reconcile, and both branch tips',
    !!twoEvidence && Array.isArray(twoEvidence.paths) && twoEvidence.paths.includes('docs/STATUS.md')
    && Array.isArray(twoEvidence.tasks)
    && twoEvidence.tasks.map((t) => t && t.head).sort().join(',')
      === [twoAlpha.head, twoBeta.head].sort().join(','),
    JSON.stringify(twoEvidence && { paths: twoEvidence.paths, tasks: twoEvidence.tasks }));
  check('C3 the evidence is RECOVERABLE — it names one line a person can act on',
    !!twoEvidence && typeof twoEvidence.recover === 'string' && twoEvidence.recover.trim().length > 0,
    JSON.stringify(twoEvidence && twoEvidence.recover));

  const stateOf = (rows) => (Array.isArray(rows) ? rows : []).map((r) => r && r.state);
  const idsOf = (rows) => (Array.isArray(rows) ? rows : []).map((r) => r && r.issueId);
  const batchIds = ['f65-alpha', 'f65-beta'];
  check('C3 the affected issue is left open or blocked — never closed, and never an issue outside the batch',
    Array.isArray(twoDocs.issues) && twoDocs.issues.length > 0
    && stateOf(twoDocs.issues).every((s) => s === 'open' || s === 'blocked')
    && idsOf(twoDocs.issues).every((id) => batchIds.includes(id))
    && Array.isArray(coordinator && coordinator.ISSUE_STATES)
    && coordinator.ISSUE_STATES.join(',') === 'open,blocked',
    JSON.stringify({ issues: twoDocs.issues, states: coordinator && coordinator.ISSUE_STATES }));
  check('C3 ... and the Beads seam was actually driven to that state, once per named issue',
    beadsCalls.length > 0
    && beadsCalls.length === (Array.isArray(twoDocs.issues) ? twoDocs.issues.length : -1)
    && beadsCalls.every((c) => (c.state === 'open' || c.state === 'blocked') && batchIds.includes(c.issueId)),
    JSON.stringify(beadsCalls));
  check('C3 the same evidence records that transition, so a host with no `bd` degrades by naming',
    !!twoEvidence && Array.isArray(twoEvidence.issues) && twoEvidence.issues.length > 0
    && stateOf(twoEvidence.issues).every((s) => s === 'open' || s === 'blocked'),
    JSON.stringify(twoEvidence && twoEvidence.issues));

  // Recoverable means it outlives the process that wrote it, so a LATER process reads it back.
  const rivalEnv = { ...process.env };
  delete rivalEnv.NODE_OPTIONS;
  const rival = spawnSync(process.execPath, ['-e', [
    `const m = require(${JSON.stringify(fwd(BATCH_MERGE))});`,
    `process.stdout.write(JSON.stringify(m.listEvidence({ repoDir: ${JSON.stringify(fwd(two.dir))} })));`,
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let recovered = null;
  try { recovered = JSON.parse(rival.stdout || 'null'); } catch { recovered = null; }
  check('C3 a later, separate process can list that evidence and see the same failure',
    Array.isArray(recovered) && recovered.length === 1
    && recovered[0].kind === 'docs-reconciliation' && recovered[0].batch === 'f65-two'
    && Array.isArray(recovered[0].paths) && recovered[0].paths.includes('docs/STATUS.md'),
    `exit ${rival.status}: ${String(rival.stderr || '').trim().split('\n').slice(-2).join(' ')} :: ${rival.stdout}`);

  // A failed rebase, which C3 names beside the docs half.
  const threeSnapBefore = snapshot(three.dir, 'main');
  const threeAlphaBefore = sha(three.dir, threeAlpha.branch);
  const rebaseCalls = [];
  const badRebase = call('rebaseTask', {
    repoDir: three.dir, integrationBranch: 'main', batch: 'f65-three', task: taskArg(threeAlpha),
    deps: { setIssueState: (issueId, state, reason) => { rebaseCalls.push({ issueId, state, reason }); } },
  });
  let rebaseEvidence = null;
  try { rebaseEvidence = JSON.parse(fs.readFileSync(String(badRebase.evidence), 'utf8')); }
  catch { rebaseEvidence = null; }
  check('C3 a rebase onto a moved integration branch that conflicts is refused with its own evidence',
    badRebase.ok === false && badRebase.reason === 'rebase'
    && !!rebaseEvidence && rebaseEvidence.version === 1 && rebaseEvidence.kind === 'rebase'
    && Array.isArray(rebaseEvidence.paths) && rebaseEvidence.paths.includes('runner/alpha.js')
    && rebaseEvidence.integrationHead === threeMoved,
    JSON.stringify({ badRebase, rebaseEvidence }));
  check('C3 ... it leaves that issue open or blocked, and drives the seam there',
    Array.isArray(badRebase.issues) && badRebase.issues.length > 0
    && stateOf(badRebase.issues).every((s) => s === 'open' || s === 'blocked')
    && idsOf(badRebase.issues).join(',') === 'f65-alpha'
    && rebaseCalls.length === badRebase.issues.length
    && rebaseCalls.every((c) => c.issueId === 'f65-alpha' && (c.state === 'open' || c.state === 'blocked')),
    JSON.stringify({ issues: badRebase.issues, calls: rebaseCalls }));
  check('C3 ... and it moves nothing: not the task branch, not the integration branch, no rebase left in progress',
    sha(three.dir, threeAlpha.branch) === threeAlphaBefore
    && snapshot(three.dir, 'main') === threeSnapBefore,
    `${threeSnapBefore} -> ${snapshot(three.dir, 'main')}`);

  // A rebase that CAN succeed must, or "a failure leaves evidence" is satisfied by never
  // succeeding at all.
  const threeBetaBefore = sha(three.dir, threeBeta.branch);
  const goodRebase = call('rebaseTask', {
    repoDir: three.dir, integrationBranch: 'main', batch: 'f65-three', task: taskArg(threeBeta),
  });
  const rebasedRef = (goodRebase.ok && goodRebase.branch)
    ? refMap(three.dir)[`refs/heads/${goodRebase.branch}`] : null;
  check('C3 a rebase that CAN succeed does, onto a NEW ref, with the task\'s own branch left where it was',
    goodRebase.ok === true && /^[0-9a-f]{40}$/.test(String(rebasedRef || ''))
    && goodRebase.branch !== threeBeta.branch
    && sha(three.dir, threeBeta.branch) === threeBetaBefore
    && isAncestor(three.dir, threeMoved, goodRebase.branch)
    && /beta v1/.test(show(three.dir, goodRebase.branch, 'runner/beta.js') || ''),
    JSON.stringify({ goodRebase, rebasedRef }));
  check('C3 ... and even a successful rebase does not merge to the integration branch',
    sha(three.dir, 'main') === threeMoved
    && String(git(three.dir, 'symbolic-ref', '-q', 'HEAD').stdout || '').trim() === 'refs/heads/main'
    && String(git(three.dir, 'status', '--porcelain').stdout || '').trim() === ''
    && IN_PROGRESS.every((f) => !fs.existsSync(path.join(three.dir, '.git', f))),
    snapshot(three.dir, 'main'));
  const threeEvidence = call('listEvidence', { repoDir: three.dir });
  check('C3 a successful rebase leaves NO evidence of its own — a record means something went wrong',
    Array.isArray(threeEvidence) && threeEvidence.length === 1 && threeEvidence[0].kind === 'rebase'
    && threeEvidence[0].batch === 'f65-three',
    JSON.stringify(threeEvidence));

  // ---- C4 · the batch-level report --------------------------------------------------------------

  const pairs = Array.isArray(onePlan.pairwise) ? onePlan.pairwise : [];
  const pair = pairs[0] || {};
  check('C4 the plan holds one pairwise merge-readiness entry per unordered pair of tasks',
    pairs.length === 1 && typeof pair.ready === 'boolean'
    && [pair.a, pair.b].sort().join(',') === 'f65-alpha,f65-beta',
    JSON.stringify(pairs));
  check('C4 that readiness is the merge the reviewer faces, and it is NOT ready here',
    pair.ready === false && Array.isArray(pair.conflicts)
    && pair.conflicts.includes('docs/change-log.md'),
    JSON.stringify(pair));
  check('C4 that entry names the shared paths the pair actually contends over',
    Array.isArray(pair.sharedPaths)
    && pair.sharedPaths.slice().sort().join(',') === 'DESIGN.md,docs/change-log.md',
    JSON.stringify(pair.sharedPaths));
  check('C4 the plan\'s batch-level shared-path set is the documents MORE THAN ONE task touched',
    Array.isArray(onePlan.sharedPaths)
    && onePlan.sharedPaths.slice().sort().join(',') === 'DESIGN.md,docs/change-log.md',
    JSON.stringify(onePlan.sharedPaths));

  let report = 'runner/batch-merge.js does not export renderReport()';
  if (hasFn('renderReport')) {
    try { report = String(coordinator.renderReport(onePlan)); }
    catch (e) { report = `renderReport() THREW: ${(e && e.message) || e}`; }
  }
  check('C4 the report names PAIRWISE MERGE READINESS, naming the pair and its verdict',
    /pairwise\s+merge\s+readiness/i.test(report)
    && /f65-alpha/.test(report) && /f65-beta/.test(report)
    && /\b(ready|conflict)/i.test(report),
    report.slice(0, 400));
  check('C4 the report names the SHARED PATHS, every one of them',
    /shared\s+paths?/i.test(report)
    && (Array.isArray(onePlan.sharedPaths) ? onePlan.sharedPaths : ['DESIGN.md', 'docs/change-log.md'])
      .every((p) => report.includes(p)),
    report.slice(0, 400));
  // Order is read from the review-order SECTION, not from the whole report: every issue id also
  // appears in the readiness and shared-path sections, and a first-occurrence scan over the
  // whole document would be measuring the section layout instead of the order. The docs step
  // has no issue id, so it is located by the ref the plan named for it or by the literal
  // `docs-integration` — never by the bare word "code", which any prose would match.
  const orderAt = report.search(/review\s+order/i);
  const orderSection = orderAt >= 0 ? report.slice(orderAt) : '';
  const labelsFor = (s) => (s && s.issueId ? [String(s.issueId)]
    : [s && s.ref, 'docs-integration', 'docs integration'].filter(Boolean).map(String));
  const posOf = (s) => labelsFor(s).reduce((best, l) => {
    const i = orderSection.indexOf(l);
    return (i >= 0 && (best < 0 || i < best)) ? i : best;
  }, -1);
  const positions = oneSeq.map(posOf);
  check('C4 the report names the REQUIRED REVIEW ORDER, in the order the plan computed',
    orderAt >= 0 && oneSeq.length > 0
    && positions.every((p) => p >= 0)
    && positions.every((p, i) => i === 0 || positions[i - 1] < p),
    `${JSON.stringify(positions)} :: ${orderSection.slice(0, 600) || report.slice(0, 600)}`);
  check('C4 the report is a BATCH-level artifact — it names the batch and every task in it',
    report.includes('f65-one') && report.includes('f65-alpha') && report.includes('f65-beta'),
    report.slice(0, 300));
}

try {
  body();
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  if (savedEvidenceEnv === undefined) delete process.env.PIPELINE_BATCH_EVIDENCE_DIR;
  else process.env.PIPELINE_BATCH_EVIDENCE_DIR = savedEvidenceEnv;
  rmrf(tmp);
  process.exit(failed);
}
