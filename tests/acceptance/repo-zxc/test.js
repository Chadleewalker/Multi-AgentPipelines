// Frozen acceptance test — repo-zxc: approved design references are resolvable at preparation.
// This is the RED half; `guard.js` beside it is the whole of C5 and carries the checks that are
// already green at the fork point and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  preparation or freeze REFUSES an issue whose structured design reference cannot be
//       resolved from the exact integration commit being frozen, naming the missing path or
//       anchor and the remedy, before any suite is published.
//   C2  the planning workflow has a PIPELINE-OWNED way to publish approved design provenance,
//       or embeds an immutable self-contained design snapshot in the canonical issue, before
//       acceptance freeze.
//   C3  a deterministic test proves an implementation workspace CLONED ONLY from the frozen
//       integration commit can resolve every design reference for its task, with no
//       operator-local files.
//   C4  concurrent planning sessions cannot overwrite or silently diverge the provenance
//       another frozen task references.
//
//   C5 is proven ENTIRELY by `guard.js` — it is a criterion about what did NOT change, so it is
//   green at the fork point by construction and a red file is the wrong home for it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module, function, command or field grammar (see
// SPEC DEFECTS below), so this suite fixes one. Node built-ins and `git` only, synchronous, no
// container engine and no network.
//
// `runner/design-ref.js` — the resolver BOTH entry points share, so "is this reference
// resolvable?" has exactly one implementation:
//
//   REASONS = ['absent', 'unparsable', 'operator-local', 'missing-path', 'missing-anchor',
//              'snapshot-mismatch']            (exactly these six, in this order)
//   PROVENANCE_DIR = 'docs/design/provenance'  (target-repo-relative, POSIX separators)
//
//   parse(designField)
//     -> { ok: true,  refs: [ref], snapshot: { sha256, body } | null }
//     -> { ok: false, reason, error }
//     `designField` is the string Beads returns in `design` (`beads/issue-template.md`: the
//     native design field, written by `scripts/new-issue.sh` as `design-ref: <ref>`), or an
//     issue object carrying it.
//     A `ref` is { raw, path, anchor, local } where `anchor` is null when none was written.
//     THE GRAMMAR, one reference per line, any number of lines:
//         design-ref: <path>#<anchor>
//         design-ref: <path> <anchor>
//         design-ref: <path>
//     `<path>` is a single whitespace-free token that does not begin with '#' or '§'.
//     `<anchor>` is the rest of the line, trimmed, and must be non-empty when written.
//     A field with no `design-ref:` and no `design-snapshot:` line is reason 'absent'.
//     A `design-ref:` line whose first token is missing, or is an anchor rather than a path
//     — `design-ref: §4.10`, the shape this project's own issues carry today — is reason
//     'unparsable'. That is the point of the word "structured" in the criterion: a section
//     number with no document is not a reference anything can resolve.
//     A path that is absolute, drive-lettered, UNC, '~'-rooted, a `file://` URL, or escapes
//     the repository through '..' parses with `local: true`. It names an OPERATOR-LOCAL file
//     and is never resolvable from a commit (C3).
//
//   resolveRef(ref, { repoPath, commit, readBlob })
//     -> { ok: true,  ref, path, anchor, blob }
//     -> { ok: false, ref, path, anchor, reason, remedy }
//     `readBlob(commit, path) -> { ok: true, text } | { ok: false }` defaults to
//     `git cat-file blob <commit>:<path>` inside `repoPath`, bounded, so resolution is a
//     question about ONE COMMIT and never about the working tree or the index.
//     A `local` ref is refused as 'operator-local' WITHOUT calling `readBlob` at all.
//     ANCHOR RESOLUTION: the anchor, with any leading '#' and '§' removed, must match a
//     MARKDOWN HEADING line (`/^#{1,6}\s/`) in that blob — equal to the heading text, or a
//     prefix of it terminated by whitespace — or an explicit `<a id="...">` / `<a name="...">`.
//     A match anywhere else in the body does not count: a reference that resolves to a passing
//     mention is not a resolvable reference.
//     `remedy` is a non-empty sentence naming `scripts/design-provenance.js publish`.
//
//   resolveIssue(issue, { repoPath, commit, readBlob })
//     -> { ok, commit, refs: [result], reasons: [reason], remedies: [string] }
//     `ok` is true only when the field parses AND every ref resolves, or when the field carries
//     a VALID self-contained snapshot. `reasons` holds every distinct refusal reason.
//     THE SNAPSHOT ARM (C2's second half). A field containing
//         design-snapshot: sha256:<64 hex>
//     followed by a fenced block (a line of three backticks, an optional info string, the body,
//     a closing line of three backticks) is self-contained: `snapshotBody` is every line
//     strictly between the fences joined with '\n' plus one trailing '\n', and the declared
//     digest must be the sha256 of those UTF-8 bytes. A valid snapshot resolves with NO
//     repository access whatever — `readBlob` is never called and `repoPath` need not exist.
//     A digest that does not match its body is reason 'snapshot-mismatch' and is NEVER treated
//     as resolvable.
//
//   refusalLines(resolution, { issueId }) -> [string]
//     Every unresolved ref contributes at least one line carrying the issue id, the missing
//     path, the anchor when the reason is 'missing-anchor', the reason word, and the remedy.
//     This is the one refusal text used by preparation and the explicit verification command.
//
// `scripts/design-provenance.js` — the PIPELINE-OWNED publication path (C2). It lives in the
// pipeline repo, is driven by the planning session, and is the only pipeline writer of
// `PROVENANCE_DIR` in the target:
//
//   main(argv, out, err) -> exit code. Verbs `publish` and `verify`; `--help` exits 0 and
//     prints a usage naming both. Exit codes EXIT_OK 0, EXIT_REFUSED 1, EXIT_USAGE 2,
//     EXIT_UNKNOWN 3 — the same four `scripts/freeze.js` already uses.
//       node scripts/design-provenance.js publish <issue-id> --config <cfg> --source <file>
//            [--anchor <anchor>] [--expected-head <sha>]
//       node scripts/design-provenance.js verify <issue-id>... --config <cfg> [--commit <sha>]
//
//   publish(opts, io, seams) -> { ok: true, path, anchor, sha256, commit, designField, unchanged }
//                             | { ok: false, reason, error }
//     `opts` = { id, config, source, anchor, expectedHead }. It writes the approved text from
//     `--source` to `<PROVENANCE_DIR>/<issue-id>.md` in the integration checkout, commits that
//     ONE path on the integration branch, pushes to `cfg.targetRepoRemote`, and returns the
//     `design-ref:` field the canonical issue must carry — which resolves, by construction,
//     from the commit it just made.
//     `seams.updateIssue(cfg, id, designField) -> { ok }` is the Beads write, so the host stays
//     the sole Beads writer and a frozen suite can drive publication without a database.
//     REFUSAL REASONS, and nothing is written, committed or pushed on any of them:
//       'locked'            another planning session holds this canonical target's authority
//                           (`runner/lock.js`), and the refusal NAMES that holder.
//       'raced'             `expectedHead` is not the checkout's HEAD; the refusal names both.
//       'already-published' the provenance path already exists at HEAD with DIFFERENT bytes;
//                           the refusal names the path and the issue that owns it.
//       'missing-anchor'    `--anchor` does not resolve inside the source text itself.
//       'no-source'         `--source` is absent or empty.
//       'not-on-branch'     the checkout is not on the integration branch, or its index is dirty.
//     Publishing the SAME bytes again is idempotent: { ok: true, unchanged: true } and no new
//     commit.
//
//   verify(opts, io, seams) -> { ok, issues: [{ id, resolution }] }
//     Resolves every named issue's design references from the EXACT commit (`--commit`, else
//     the checkout's HEAD) and answers EXIT_REFUSED with `refusalLines` when any cannot be.
//     This is the "before acceptance freeze" gate C2 asks for.
//
// THE WIRING (C1). Preparation consults the resolver without growing a flag.
//   `scripts/prepare-batch.js`
//     * `classifyBuilt(id, built)` maps `built.design && built.design.ok === false` to outcome
//       'needs-design' with NO action, so no worker, worktree or suite is ever started for it.
//     * `execute` re-resolves each issue against the PINNED integration head through
//       `seams.resolveDesign(issue, { repoPath, commit })` (default `resolveIssue`), records
//       `designCommit` and `designReasons` on the `issue.snapshotted` event, and returns
//       EXIT_ATTENTION. 'needs-design' joins 'attention', 'collision' and 'needs-criteria' in
//       the attention set.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// SPEC DEFECTS, REPORTED NOT PAPERED OVER.
//
//  1. THE ISSUE NAMES NO SURFACE. Not a module, not a command, not a field grammar — only
//     behaviour ("a structured design reference", "a pipeline-owned way to publish"). A frozen
//     suite cannot assert behaviour without naming the thing that behaves, so the block above
//     IS the missing half of the spec and every check below is written against it. An
//     implementation that satisfies the criteria through a differently-named surface is not
//     wrong about the issue; it is wrong about this suite, and the suite is what freezes.
//
//  2. C2 IS A DISJUNCTION. "has a pipeline-owned way to publish approved design provenance, OR
//     embeds an immutable self-contained design snapshot in the canonical issue" is two
//     designs, and a suite that accepted either half would be non-discriminating on both: an
//     implementation could satisfy it by doing neither well. This suite freezes the FIRST arm
//     as the mandatory one and the second as an accepted resolver input, because C1 and C4
//     have no subject without the first: C1 requires a REMEDY for an unresolvable reference,
//     and a remedy has to name something a planner can run; C4 speaks of "the provenance
//     another frozen task references", which presupposes published provenance that concurrent
//     sessions could contend over. A snapshot embedded in one issue is contended by nobody.
//
//  3. C3 NAMES A TEST AS THE DELIVERABLE. "A deterministic test proves an implementation
//     workspace cloned only from the frozen integration commit can resolve every design
//     reference" — in a frozen acceptance suite that is circular, because THIS suite is the
//     deterministic test the criterion asks for. Asserting that some other test file exists
//     would freeze a filename and prove nothing. So C3 is discharged by performing the proof
//     here: a real clone of the frozen commit, and resolution inside it.
//
//  4. C1 SAYS "PREPARATION OR FREEZE". This suite chooses PREPARATION as the authoritative
//     admission point. Re-resolving provenance during freeze would retroactively change the
//     established outcomes of already-prepared and already-frozen suites; preparation stops
//     unresolved work before any worker or suite exists, while `verify` remains available for
//     an explicit pre-freeze audit.
//
//  5. C1's "before any suite is published" is measured as MUTATION, never as access: the
//     target's HEAD, its porcelain listing, the remote's branch head, the index, and whether a
//     freeze receipt appeared. Reading the issue and the config is unavoidable and is not the
//     harm.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DESIGN_REF = path.join(REPO, 'runner', 'design-ref.js');
const PROVENANCE = path.join(REPO, 'scripts', 'design-provenance.js');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const LOCK = path.join(REPO, 'runner', 'lock.js');

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
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-zxc-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
};
// Both host-global authorities re-aimed at the scratch tree, so running this file can never
// disturb a live run on the same machine.
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'lockauth');
process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
delete process.env.PIPELINE_CHILD_AUTHORITY;

// ---- the surfaces under test, loaded so an ABSENT one is a named failure --------------------
// The two new modules do not exist at the fork point. Requiring them at top level would abort
// the file with a stack trace that says nothing about which criterion went unproven, so every
// call goes through `callD`/`callP`, which answer a sentinel a check can never mistake for a
// result.
function safeRequire(file) {
  try { return require(file); } catch { return null; }
}
const D = safeRequire(DESIGN_REF);
const P = safeRequire(PROVENANCE);
const lock = safeRequire(LOCK);
const prepare = safeRequire(PREPARE_BATCH);

const ABSENT = { ok: 'module-absent' };
function callD(name, ...args) {
  if (!D || typeof D[name] !== 'function') return { ...ABSENT, missing: `runner/design-ref.js ${name}` };
  try { return D[name](...args); } catch (e) { return { ok: 'threw', error: (e && e.message) || String(e) }; }
}
function callP(name, ...args) {
  if (!P || typeof P[name] !== 'function') return { ...ABSENT, missing: `scripts/design-provenance.js ${name}` };
  try { return P[name](...args); } catch (e) { return { ok: 'threw', error: (e && e.message) || String(e) }; }
}
const why = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

// ---- fixtures ------------------------------------------------------------------------------

function project(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}
function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return String(git(root, 'rev-parse', 'HEAD').stdout || '').trim();
}
function headOf(root) {
  return String(git(root, 'rev-parse', 'HEAD').stdout || '').trim();
}
function remoteHead(bare, branch) {
  return String(git(bare, 'rev-parse', `refs/heads/${branch}`).stdout || '').trim();
}
function porcelain(root) {
  return String(git(root, 'status', '--porcelain').stdout || '').trim();
}
function blobAt(root, commit, rel) {
  const r = git(root, 'cat-file', 'blob', `${commit}:${rel}`);
  return r.status === 0 ? String(r.stdout) : null;
}

// A design document shaped like this project's own: `### 3.10 …` section headings, which is
// what a `§`-anchored reference has to be able to hit.
const APPROVED_DESIGN = [
  '# zxc approved design',
  '',
  '## 2. The resolvable half',
  '',
  'Prose that merely mentions 2.4 in passing, which must not count as an anchor.',
  '',
  '### 2.4 Design references resolve from the frozen commit',
  '',
  'The approved text for zxc-alpha.',
  '',
].join('\n');
const REVISED_DESIGN = APPROVED_DESIGN.replace('The approved text for zxc-alpha.',
  'A SECOND session rewrote this after the first task froze.');

// The integration checkout and its remote. `pipeline.config.json` is committed so the
// integration branch resolves offline, and `git init --bare -b main` gives the remote a HEAD
// symref for the same reason.
const bare = project('zxc-remote.git');
git(bare, 'init', '-q', '--bare', '-b', 'main');
const target = project('zxc-target');
git(target, 'init', '-q', '-b', 'main');
git(target, 'config', 'user.email', 'fixture@test.local');
git(target, 'config', 'user.name', 'fixture');
git(target, 'config', 'commit.gpgsign', 'false');
write(target, 'pipeline.config.json', `${JSON.stringify({
  verifyCommand: 'sh tools/run-acceptance.sh',
  defaultBranch: 'main',
  frozenPaths: ['tools/run-acceptance.sh'],
}, null, 2)}\n`);
write(target, 'README.md', '# zxc fixture target\n');
// A design document that IS committed, and one that is only ever in the working tree.
write(target, 'docs/design/committed.md', APPROVED_DESIGN);
const HEAD_WITH_DOC = commitAll(target, 'fixture: committed design doc');
git(target, 'push', '-q', fwd(bare), 'HEAD:refs/heads/main');
// ... and then deleted, so "the exact integration commit" has two answers to compare.
fs.rmSync(path.join(target, 'docs', 'design', 'committed.md'));
const HEAD_WITHOUT_DOC = commitAll(target, 'fixture: the doc is gone at this commit');
git(target, 'push', '-q', fwd(bare), 'HEAD:refs/heads/main');
// Present on the operator's desk at this instant, in no commit anywhere.
write(target, 'docs/design/only-on-my-desk.md', APPROVED_DESIGN);
// The operator's own notes, OUTSIDE the repository. Referenced through a '..' escape rather
// than an absolute path so the reference itself is whitespace-free whatever `os.tmpdir()`
// happens to be on this host; the absolute and drive-lettered spellings are covered by the
// grammar checks below, which need no file to exist.
const OPERATOR_LOCAL_DOC = write(project('zxc-operator-home'), 'notes/approved.md', APPROVED_DESIGN);
const OPERATOR_LOCAL_REL = '../zxc-operator-home/notes/approved.md';

function configFor(name, root, remote, extra = {}) {
  const file = path.join(tmp, `run.config.${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    targetRepoPath: fwd(root),
    targetRepoRemote: fwd(remote),
    image: 'pipeline-zxc:latest',
    bdTimeoutMs: 5000,
    gitTimeoutMs: 30000,
    lifecycleTimeoutMs: 10000,
    ...extra,
  }, null, 2)}\n`);
  return file;
}
const CONFIG = configFor('zxc', target, bare);
const say = () => {
  const lines = [];
  return { lines, fn: (...a) => lines.push(a.join(' ')), text: () => lines.join('\n') };
};

// A bd stub, reached the only way this repo reaches one: `PIPELINE_BD_CMD = process.execPath`
// with a `--require` preload, because a `.js` file and an npm shim are both unspawnable on the
// Windows host. The explicit verification command reads design fields through this database.
function bdStub(issues) {
  const file = path.join(tmp, `bd-stub-${crypto.randomBytes(6).toString('hex')}.js`);
  fs.writeFileSync(file, [
    "'use strict';",
    'const fs = require("fs");',
    `const ISSUES = ${JSON.stringify(issues)};`,
    'const argv = process.argv.slice(1);',
    '// The preload also runs for the node invocation that loads this file as a --require',
    '// target; only the argv of a real bd call names a verb.',
    'if (argv.length && /\\.js$/i.test(String(argv[0])) && fs.existsSync(String(argv[0]))) return;',
    'const verbIndex = argv.findIndex((a) => /^(show|ready|update|note|close|create)$/.test(String(a).replace(/\\\\/g, "/").split("/").pop()));',
    'const verb = verbIndex < 0 ? null : String(argv[verbIndex]).replace(/\\\\/g, "/").split("/").pop();',
    'if (verb === "show") {',
    '  const id = argv[verbIndex + 1];',
    '  const found = ISSUES.filter((i) => i.id === id);',
    '  // fs.writeSync(1, ...), never process.stdout.write: a pipe write on Windows is',
    '  // asynchronous and process.exit() would truncate it, which reads as an empty answer.',
    '  fs.writeSync(1, JSON.stringify(found));',
    '  process.exit(found.length ? 0 : 1);',
    '}',
    'if (verb === "ready") { fs.writeSync(1, "[]"); process.exit(0); }',
    'process.exit(0);',
  ].join('\n'));
  return file;
}
function withBd(stub, fn) {
  const savedCmd = process.env.PIPELINE_BD_CMD;
  const savedOpts = process.env.NODE_OPTIONS;
  process.env.PIPELINE_BD_CMD = process.execPath;
  // Forward slashes: NODE_OPTIONS strips the surrounding quotes and the temp dir may contain
  // spaces.
  process.env.NODE_OPTIONS = `--require "${fwd(stub)}"`;
  try { return fn(); } finally {
    if (savedCmd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = savedCmd;
    if (savedOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOpts;
  }
}

// The design fields the checks below resolve. Spelled once so a grammar change is one edit.
const REF_RESOLVABLE = 'design-ref: docs/design/committed.md#§2.4';
const REF_NO_ANCHOR = 'design-ref: docs/design/committed.md#§9.9';
const REF_NO_PATH_IN_COMMIT = 'design-ref: docs/design/only-on-my-desk.md#§2.4';
const REF_SECTION_ONLY = 'design-ref: §4.10';
const REF_OPERATOR_LOCAL = `design-ref: ${OPERATOR_LOCAL_REL}#§2.4`;

const snapshotBody = 'The whole approved design, carried in the issue itself.\n';
const SNAPSHOT_GOOD = [
  `design-snapshot: sha256:${sha256(snapshotBody)}`,
  '',
  '```markdown',
  snapshotBody.replace(/\n$/, ''),
  '```',
  '',
].join('\n');
const SNAPSHOT_BAD = SNAPSHOT_GOOD.replace(sha256(snapshotBody), 'f'.repeat(64));
const REQUIRED_RESOLVER_EXPORTS = ['parse', 'resolveRef', 'resolveIssue', 'refusalLines'];
const REQUIRED_PUBLISHER_EXPORTS = ['main', 'parseArgs', 'publish', 'verify'];
const EXPECTED_MANY_REFS = ['docs/design/committed.md#§2.4', 'docs/design/committed.md#§9.9'];

async function body() {
  // ---- the surfaces themselves ------------------------------------------------------------
  check('C1 `runner/design-ref.js` exists and exports the shared resolver',
    !!D && REQUIRED_RESOLVER_EXPORTS.every((n) => typeof (D || {})[n] === 'function'),
    D ? `exports: ${Object.keys(D).join(', ')}` : 'the module is absent');
  check('C1 ... and its refusal vocabulary and provenance location are fixed data',
    !!D && Array.isArray(D.REASONS)
    && D.REASONS.join(',') === 'absent,unparsable,operator-local,missing-path,missing-anchor,snapshot-mismatch'
    && D.PROVENANCE_DIR === 'docs/design/provenance',
    why(D && { reasons: D.REASONS, dir: D.PROVENANCE_DIR }));
  check('C2 `scripts/design-provenance.js` exists and exports the pipeline-owned publisher',
    !!P && REQUIRED_PUBLISHER_EXPORTS.every((n) => typeof (P || {})[n] === 'function')
    && P.EXIT_OK === 0 && P.EXIT_REFUSED === 1 && P.EXIT_USAGE === 2 && P.EXIT_UNKNOWN === 3,
    P ? `exports: ${Object.keys(P).join(', ')}` : 'the module is absent');

  // ---- C1: the grammar of a STRUCTURED reference -------------------------------------------
  const parsed = callD('parse', REF_RESOLVABLE);
  check('C1 a structured reference parses into a path and an anchor',
    parsed.ok === true && Array.isArray(parsed.refs) && parsed.refs.length === 1
    && parsed.refs[0].path === 'docs/design/committed.md' && parsed.refs[0].anchor === '§2.4'
    && parsed.refs[0].local === false, why(parsed));
  const parsedMany = callD('parse', `${REF_RESOLVABLE}\n${REF_NO_ANCHOR}`);
  check('C1 an issue may carry more than one reference and every one is parsed',
    parsedMany.ok === true && Array.isArray(parsedMany.refs)
    && parsedMany.refs.every((r) => EXPECTED_MANY_REFS.includes(`${r.path}#${r.anchor}`))
    && EXPECTED_MANY_REFS.every((key) => parsedMany.refs.some((r) => `${r.path}#${r.anchor}` === key)), why(parsedMany));
  const parsedBare = callD('parse', REF_SECTION_ONLY);
  check('C1 a section number with no document is UNPARSABLE, not a reference',
    parsedBare.ok === false && parsedBare.reason === 'unparsable', why(parsedBare));
  const parsedAbsent = callD('parse', 'a paragraph of prose that cites nothing at all');
  check('C1 a design field that cites nothing is reason `absent`',
    parsedAbsent.ok === false && parsedAbsent.reason === 'absent', why(parsedAbsent));
  const localSpellings = ['/absolute/approved.md', 'C:' + '/absolute/approved.md',
    '~/notes/approved.md', 'file:///absolute/approved.md', OPERATOR_LOCAL_REL];
  const localParses = localSpellings.map((p) => callD('parse', `design-ref: ${p}#§2.4`));
  check('C1 every OPERATOR-LOCAL spelling parses as local rather than as a repository path',
    localParses.every((r) => r.ok === true && !!r.refs && r.refs.length === 1
      && r.refs[0].local === true),
    why(localSpellings.map((p, i) => [p, localParses[i].ok, localParses[i].refs
      && localParses[i].refs[0] && localParses[i].refs[0].local])));

  // ---- C1: resolution is a question about ONE COMMIT ---------------------------------------
  const atDoc = callD('resolveIssue', { id: 'zxc-alpha', design: REF_RESOLVABLE },
    { repoPath: target, commit: HEAD_WITH_DOC });
  check('C1 a reference whose document and anchor are in the commit resolves',
    atDoc.ok === true && atDoc.commit === HEAD_WITH_DOC
    && Array.isArray(atDoc.refs) && atDoc.refs.every((r) => r.ok === true), why(atDoc));
  const atLaterCommit = callD('resolveIssue', { id: 'zxc-alpha', design: REF_RESOLVABLE },
    { repoPath: target, commit: HEAD_WITHOUT_DOC });
  check('C1 the SAME reference is refused at the commit the document was deleted in',
    atLaterCommit.ok === false && (atLaterCommit.reasons || []).includes('missing-path'),
    why(atLaterCommit));
  const onlyOnDisk = callD('resolveIssue', { id: 'zxc-beta', design: REF_NO_PATH_IN_COMMIT },
    { repoPath: target, commit: HEAD_WITHOUT_DOC });
  check('C1 a document that exists only in the WORKING TREE is `missing-path`, not resolvable',
    onlyOnDisk.ok === false && (onlyOnDisk.reasons || []).includes('missing-path'), why(onlyOnDisk));
  const noAnchor = callD('resolveIssue', { id: 'zxc-gamma', design: REF_NO_ANCHOR },
    { repoPath: target, commit: HEAD_WITH_DOC });
  check('C1 a document that is present with the anchor absent is `missing-anchor`',
    noAnchor.ok === false && (noAnchor.reasons || []).includes('missing-anchor'), why(noAnchor));
  const passingMention = callD('resolveRef',
    { raw: 'x', path: 'docs/design/committed.md', anchor: '§2.4', local: false },
    { repoPath: target, commit: HEAD_WITH_DOC });
  check('C1 an anchor resolves against a HEADING, and the same text in prose is not one',
    passingMention.ok === true, why(passingMention));
  const proseOnly = callD('resolveRef',
    { raw: 'x', path: 'docs/design/committed.md', anchor: '§in passing', local: false },
    { repoPath: target, commit: HEAD_WITH_DOC });
  check('C1 ... so an anchor matching only body prose is refused as `missing-anchor`',
    proseOnly.ok === false && proseOnly.reason === 'missing-anchor', why(proseOnly));

  // The refusal a person has to act on: the path, the anchor, the reason and the remedy.
  const lines = callD('refusalLines', noAnchor, { issueId: 'zxc-gamma' });
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines && lines.missing || lines);
  check('C1 the one refusal text names the issue, the missing anchor and the document',
    Array.isArray(lines) && lines.length > 0 && /zxc-gamma/.test(text)
    && /docs\/design\/committed\.md/.test(text) && /§9\.9/.test(text), text);
  check('C1 ... and it names the remedy, which is a command a planner can run',
    /design-provenance\.js publish/.test(text), text);
  const missingPathLines = callD('refusalLines', onlyOnDisk, { issueId: 'zxc-beta' });
  check('C1 a missing DOCUMENT is refused with its own path and the same remedy',
    Array.isArray(missingPathLines)
    && /docs\/design\/only-on-my-desk\.md/.test(missingPathLines.join('\n'))
    && /design-provenance\.js publish/.test(missingPathLines.join('\n')),
    why(missingPathLines));

  // ---- C1: preparation refuses, and starts nothing -----------------------------------------
  // ONE config object on both sides of `sameConfigIdentity`: preparation compares the brief's
  // config with the locked batch config by canonical hash, and two equivalent-but-different
  // literals would be refused for that instead of for the design reference under test.
  const PREP_CFG = { targetRepoPath: target, allowHalfProven: false };
  const builtFor = (id, design) => ({
    ok: true, id, state: 'write', branch: 'main', text: `brief for ${id}`,
    cfg: PREP_CFG,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder: { dir: path.join(tmp, `freeze-${id}`), branch: `freeze-${id}`, exists: true },
    criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id, title: id, priority: 2, dependencies: [], design },
    design: design === undefined ? undefined : { ok: false, reasons: ['missing-path'] },
  });
  check('C1 preparation classifies an unresolvable design reference as `needs-design`, with no action',
    (() => {
      if (!prepare) return false;
      const classified = prepare.classifyBuilt('zxc-delta', builtFor('zxc-delta', REF_NO_PATH_IN_COMMIT));
      return classified.outcome === 'needs-design' && !classified.action;
    })(),
    prepare ? why(prepare.classifyBuilt('zxc-delta', builtFor('zxc-delta', REF_NO_PATH_IN_COMMIT))) : 'prepare-batch absent');

  async function runPreparation(id, design, resolution) {
    const events = []; const workers = [];
    const state = {
      preparationRoot: () => 'R', validateBatchId: () => true, validateIssueId: () => true,
      createManifest: (_r, _b, input) => ({ ...input }),
      appendEvent: (_r, _b, type, payload) => events.push([type, payload]),
      readWorkerRecords: () => [], readEvents: () => [], createWorkerNonce: () => 'a'.repeat(32),
      writeWorkerStarted() {}, writeWorkerResult() {}, deriveState: () => ({ ok: true, issues: [] }),
      canonicalHash: () => 'H', redactConfig: (v) => v,
    };
    const seen = [];
    const code = await prepare.execute(
      { mode: 'start', batch: 'zxcwave', config: CONFIG, issues: [id], concurrency: 1 },
      { out() {}, err() {} },
      {
        state, preparationRoot: () => 'R',
        loadConfig: () => PREP_CFG,
        acquire: () => ({ ok: true, tookOver: false, ownership: {} }),
        release() {},
        runSync: () => ({ status: 0, stdout: HEAD_WITHOUT_DOC, stderr: '' }),
        inspectIntegration: () => ({ ok: true, branch: 'main', head: HEAD_WITHOUT_DOC }),
        readyQueue: () => ({ ok: true, issues: [] }),
        buildBrief: () => builtFor(id, design),
        resolveDesign: (issue, opts) => { seen.push({ issue, opts }); return resolution; },
        runWorker: (_root, _batch, item) => { workers.push(item.id); return { id: item.id, ok: true, outcome: 'proven' }; },
      },
    );
    return { code, events, workers, seen };
  }

  const refusedPrep = prepare ? await runPreparation('zxc-delta', REF_NO_PATH_IN_COMMIT, {
    ok: false, commit: HEAD_WITHOUT_DOC, reasons: ['missing-path'],
    refs: [{ ok: false, path: 'docs/design/only-on-my-desk.md', anchor: '§2.4', reason: 'missing-path',
      remedy: 'publish it: node scripts/design-provenance.js publish zxc-delta --config <config> --source <file>' }],
  }) : { code: null, events: [], workers: [], seen: [] };
  const prepEvents = refusedPrep.events.filter((e) => e[0] === 'issue.snapshotted').map((e) => e[1]);
  check('C1 preparation resolves the design against the PINNED integration commit, in the target checkout',
    refusedPrep.seen.length === 1 && !!refusedPrep.seen[0].opts
    && refusedPrep.seen[0].opts.commit === HEAD_WITHOUT_DOC
    && path.resolve(String(refusedPrep.seen[0].opts.repoPath)) === path.resolve(target),
    why(refusedPrep.seen.map((s) => s.opts)));
  check(`C1 preparation refuses the issue and needs attention — exit ${refusedPrep.code}`,
    !!prepare && refusedPrep.code === prepare.EXIT_ATTENTION);
  check('C1 ... its durable record says `needs-design` and names the missing path and the remedy',
    prepEvents.some((p) => p.state === 'needs-design'
      && /only-on-my-desk\.md/.test(String(p.error || ''))
      && /design-provenance\.js publish/.test(String(p.error || ''))),
    why(prepEvents));
  check('C1 ... it records the exact commit the design was judged against',
    prepEvents.some((p) => p.designCommit === HEAD_WITHOUT_DOC), why(prepEvents));
  check('C1 ... and NO worker, worktree or suite was ever started for it',
    refusedPrep.workers.length === 0, why(refusedPrep.workers));

  const admittedPrep = prepare ? await runPreparation('zxc-epsilon', REF_RESOLVABLE, {
    ok: true, commit: HEAD_WITHOUT_DOC, reasons: [], refs: [{ ok: true }],
  }) : { code: null, events: [], workers: [], seen: [] };
  const admittedEvents = admittedPrep.events.filter((e) => e[0] === 'issue.snapshotted').map((e) => e[1]);
  check('C1 an issue whose design DOES resolve is prepared, and the commit is recorded anyway',
    admittedPrep.workers.join(',') === 'zxc-epsilon'
    && admittedEvents.some((p) => p.designCommit === HEAD_WITHOUT_DOC),
    why({ workers: admittedPrep.workers, events: admittedEvents }));

  // ---- C2: the pipeline-owned publication path ---------------------------------------------
  const help = say();
  check('C2 the publisher is a command with two verbs and its own usage',
    !!P && P.main(['--help'], help.fn, () => {}) === 0
    && /publish/.test(help.text()) && /verify/.test(help.text()), help.text().slice(0, 300));

  const sourceFile = write(project('zxc-approved'), 'alpha.md', APPROVED_DESIGN);
  let updated = null;
  const beforePublish = headOf(target);
  const published = callP('publish',
    { id: 'zxc-alpha', config: CONFIG, source: sourceFile, anchor: '§2.4' },
    { out() {}, err() {} },
    { updateIssue: (_cfg, id, field) => { updated = { id, field }; return { ok: true }; } });
  check('C2 publish commits the approved design at the canonical provenance path',
    published.ok === true
    && published.path === 'docs/design/provenance/zxc-alpha.md'
    && published.sha256 === sha256(APPROVED_DESIGN)
    && /^[0-9a-f]{40,64}$/.test(String(published.commit || ''))
    && published.commit !== beforePublish, why(published));
  check('C2 ... and returns the structured field the canonical issue must carry',
    published.designField === 'design-ref: docs/design/provenance/zxc-alpha.md#§2.4',
    why(published.designField));
  check('C2 ... which it writes back to the issue through the host, the sole Beads writer',
    !!updated && updated.id === 'zxc-alpha' && updated.field === published.designField,
    why(updated));
  const touched = published.ok === true
    ? String(git(target, 'show', '--name-only', '--format=', String(published.commit)).stdout || '')
      .split(/\r?\n/).filter(Boolean).join(',')
    : '(publication never happened)';
  check('C2 ... the commit it made touches that ONE path and nothing else',
    touched === 'docs/design/provenance/zxc-alpha.md', touched);
  check('C2 ... it is pushed, so the frozen integration commit on the remote carries it',
    published.ok === true && remoteHead(bare, 'main') === String(published.commit),
    why({ remote: remoteHead(bare, 'main'), commit: published.commit }));
  const roundTrip = callD('resolveIssue', { id: 'zxc-alpha', design: published.designField },
    { repoPath: target, commit: published.commit });
  check('C2 published provenance RESOLVES from the commit publication created — the round trip',
    roundTrip.ok === true, why(roundTrip));

  const badAnchor = callP('publish',
    { id: 'zxc-noanchor', config: CONFIG, source: sourceFile, anchor: '§8.8' },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  check('C2 publish refuses an anchor that does not resolve inside the approved text itself',
    badAnchor.ok === false && badAnchor.reason === 'missing-anchor'
    && !fs.existsSync(path.join(target, 'docs', 'design', 'provenance', 'zxc-noanchor.md')),
    why(badAnchor));

  // The verify verb: the "before acceptance freeze" gate, over the exact commit.
  const verifyIo = say();
  const verifyRefused = P ? withBd(bdStub([{ id: 'zxc-beta', design: REF_NO_PATH_IN_COMMIT }]),
    () => P.main(['verify', 'zxc-beta', '--config', CONFIG], verifyIo.fn, verifyIo.fn)) : null;
  check('C2 verify refuses an issue whose provenance was never published',
    !!P && verifyRefused === P.EXIT_REFUSED && /only-on-my-desk\.md/.test(verifyIo.text()),
    verifyIo.text().slice(-300));
  const verifyOkIo = say();
  const verifyAccepted = P ? withBd(bdStub([{ id: 'zxc-alpha', design: published.designField }]),
    () => P.main(['verify', 'zxc-alpha', '--config', CONFIG], verifyOkIo.fn, verifyOkIo.fn)) : null;
  check('C2 ... and accepts the issue publication has already served',
    !!P && verifyAccepted === P.EXIT_OK, verifyOkIo.text().slice(-300));

  // C2's second arm: an immutable self-contained snapshot in the canonical issue. Proven with a
  // repoPath that does not exist and a readBlob spy, so "self-contained" is a fact and not a
  // hope.
  let blobReads = 0;
  const snapshotResolved = callD('resolveIssue', { id: 'zxc-zeta', design: SNAPSHOT_GOOD }, {
    repoPath: path.join(tmp, 'no-such-checkout'), commit: HEAD_WITHOUT_DOC,
    readBlob: () => { blobReads += 1; return { ok: false }; },
  });
  check('C2 a self-contained snapshot resolves with NO repository access at all',
    snapshotResolved.ok === true && blobReads === 0, why({ snapshotResolved, blobReads }));
  const snapshotTampered = callD('resolveIssue', { id: 'zxc-zeta', design: SNAPSHOT_BAD }, {
    repoPath: path.join(tmp, 'no-such-checkout'), commit: HEAD_WITHOUT_DOC,
    readBlob: () => ({ ok: false }),
  });
  check('C2 a snapshot whose digest does not match its body is never treated as resolvable',
    snapshotTampered.ok === false && (snapshotTampered.reasons || []).includes('snapshot-mismatch'),
    why(snapshotTampered));

  // ---- C3: an implementation workspace cloned ONLY from the frozen commit -------------------
  // SPEC DEFECT 3 above: this section IS the deterministic test the criterion asks for.
  const frozenCommit = String(published.commit || headOf(target));
  const workspace = path.join(tmp, 'zxc-workspace');
  const cloned = git(tmp, 'clone', '-q', fwd(bare), fwd(workspace));
  check('C3 harness: an implementation workspace is cloned from the integration remote',
    cloned.status === 0 && fs.existsSync(path.join(workspace, '.git')),
    String(cloned.stderr || '').trim());
  const checkedOut = git(workspace, 'checkout', '-q', '--detach', frozenCommit);
  check('C3 harness: it is parked on the exact frozen integration commit',
    checkedOut.status === 0 && headOf(workspace) === frozenCommit,
    `${String(checkedOut.stderr || '').trim()} head=${headOf(workspace)}`);
  const fromClone = callD('resolveIssue', { id: 'zxc-alpha', design: published.designField },
    { repoPath: workspace, commit: frozenCommit });
  check('C3 every design reference for the task resolves inside that clone alone',
    fromClone.ok === true && Array.isArray(fromClone.refs) && fromClone.refs.every((r) => r.ok === true),
    why(fromClone));
  check('C3 ... and the bytes it resolves to are the approved text, not a near miss',
    blobAt(workspace, frozenCommit, 'docs/design/provenance/zxc-alpha.md') === APPROVED_DESIGN);
  const localFromClone = callD('resolveIssue', { id: 'zxc-eta', design: REF_OPERATOR_LOCAL },
    { repoPath: workspace, commit: frozenCommit });
  check('C3 an OPERATOR-LOCAL reference is refused from the clone even though the file exists here',
    fs.existsSync(OPERATOR_LOCAL_DOC) && localFromClone.ok === false
    && (localFromClone.reasons || []).includes('operator-local'), why(localFromClone));
  let localReads = 0;
  const localRefused = callD('resolveRef',
    { raw: 'x', path: fwd(OPERATOR_LOCAL_DOC), anchor: '§2.4', local: true },
    { repoPath: workspace, commit: frozenCommit, readBlob: () => { localReads += 1; return { ok: true, text: APPROVED_DESIGN }; } });
  check('C3 ... and it is refused WITHOUT reading the operator\'s file',
    localRefused.ok === false && localRefused.reason === 'operator-local' && localReads === 0,
    why({ localRefused, localReads }));
  const desktopOnly = callD('resolveIssue', { id: 'zxc-theta', design: REF_NO_PATH_IN_COMMIT },
    { repoPath: workspace, commit: frozenCommit });
  check('C3 a document that never left the planning desk is refused from the clone by path',
    desktopOnly.ok === false && (desktopOnly.reasons || []).includes('missing-path')
    && /only-on-my-desk\.md/.test((callD('refusalLines', desktopOnly, { issueId: 'zxc-theta' }) || []).join('\n')),
    why(desktopOnly));
  // The resolver must not fall back to the pipeline checkout, where a DESIGN.md really does
  // exist: a reference the clone cannot satisfy has to fail in the clone.
  const noFallback = callD('resolveIssue', { id: 'zxc-iota', design: 'design-ref: DESIGN.md#§3.10' },
    { repoPath: workspace, commit: frozenCommit });
  check('C3 resolution never falls back to the pipeline checkout or the working directory',
    fs.existsSync(path.join(REPO, 'DESIGN.md')) && noFallback.ok === false
    && (noFallback.reasons || []).includes('missing-path'), why(noFallback));

  // ---- C4: concurrent planning sessions -----------------------------------------------------
  const otherSource = write(project('zxc-approved-two'), 'alpha-revised.md', REVISED_DESIGN);
  const betaSource = write(project('zxc-approved-three'), 'beta.md', APPROVED_DESIGN);

  // 1. Another session holds this canonical target's authority. Publication is refused BY OWNER
  //    NAME, and the tree is untouched.
  const heldBefore = { head: headOf(target), porcelain: porcelain(target), remote: remoteHead(bare, 'main') };
  const holder = lock ? lock.acquire(REPO, target, 'ZXC-OTHER-PLANNING-SESSION') : { ok: false };
  check('C4 harness: another planning session holds the canonical target',
    !!holder && holder.ok === true, why(holder));
  const whileHeld = callP('publish',
    { id: 'zxc-beta', config: CONFIG, source: betaSource, anchor: '§2.4' },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  // The refusal AND the untouched tree are one check: "nothing was written" is not evidence on
  // its own, because a publisher that does not exist writes nothing either.
  check('C4 publication is refused while another session holds the target, BY OWNER NAME, having written nothing',
    whileHeld.ok === false && whileHeld.reason === 'locked'
    && /ZXC-OTHER-PLANNING-SESSION/.test(String(whileHeld.error || ''))
    && headOf(target) === heldBefore.head && porcelain(target) === heldBefore.porcelain
    && remoteHead(bare, 'main') === heldBefore.remote
    && !fs.existsSync(path.join(target, 'docs', 'design', 'provenance', 'zxc-beta.md')),
    why({ whileHeld, head: headOf(target) }));
  if (holder && holder.ok) lock.release(REPO, target, holder.ownership);

  // 2. The provenance a frozen task already references cannot be overwritten with other bytes.
  const overwriteBefore = { head: headOf(target), remote: remoteHead(bare, 'main') };
  const overwrite = callP('publish',
    { id: 'zxc-alpha', config: CONFIG, source: otherSource, anchor: '§2.4' },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  check('C4 republishing DIFFERENT bytes over published provenance is refused, and the frozen bytes stand',
    overwrite.ok === false && overwrite.reason === 'already-published'
    && /zxc-alpha/.test(String(overwrite.error || ''))
    && blobAt(target, headOf(target), 'docs/design/provenance/zxc-alpha.md') === APPROVED_DESIGN
    && headOf(target) === overwriteBefore.head
    && remoteHead(bare, 'main') === overwriteBefore.remote, why(overwrite));
  const republish = callP('publish',
    { id: 'zxc-alpha', config: CONFIG, source: sourceFile, anchor: '§2.4' },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  check('C4 republishing the SAME bytes is idempotent and makes no second commit',
    republish.ok === true && republish.unchanged === true
    && headOf(target) === overwriteBefore.head, why(republish));

  // 3. The read-then-write gap between two sessions: a stale expected head is a refusal, never
  //    a lost update.
  const staleBefore = { head: headOf(target), remote: remoteHead(bare, 'main') };
  const raced = callP('publish',
    { id: 'zxc-beta', config: CONFIG, source: betaSource, anchor: '§2.4', expectedHead: HEAD_WITH_DOC },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  check('C4 a session publishing against a head that has since moved is refused as `raced`, naming both commits',
    raced.ok === false && raced.reason === 'raced'
    && String(raced.error || '').includes(HEAD_WITH_DOC)
    && String(raced.error || '').includes(staleBefore.head)
    && headOf(target) === staleBefore.head && remoteHead(bare, 'main') === staleBefore.remote
    && !fs.existsSync(path.join(target, 'docs', 'design', 'provenance', 'zxc-beta.md')),
    why({ raced, head: headOf(target) }));

  // 4. The same session, refreshed, publishes its own issue — and the first task's provenance
  //    is byte-identical at the new head AND still resolvable from the commit it froze against.
  const secondPublish = callP('publish',
    { id: 'zxc-beta', config: CONFIG, source: betaSource, anchor: '§2.4', expectedHead: headOf(target) },
    { out() {}, err() {} }, { updateIssue: () => ({ ok: true }) });
  check('C4 a refreshed session publishes its own provenance without disturbing the other',
    secondPublish.ok === true
    && blobAt(target, String(secondPublish.commit), 'docs/design/provenance/zxc-alpha.md') === APPROVED_DESIGN
    && blobAt(target, String(secondPublish.commit), 'docs/design/provenance/zxc-beta.md') === APPROVED_DESIGN,
    why(secondPublish));
  const stillFrozen = callD('resolveIssue', { id: 'zxc-alpha', design: published.designField },
    { repoPath: target, commit: frozenCommit });
  check('C4 the already-frozen task still resolves from the exact commit it was frozen at',
    stillFrozen.ok === true && stillFrozen.commit === frozenCommit, why(stillFrozen));
  const stillCurrent = callD('resolveIssue', { id: 'zxc-alpha', design: published.designField },
    { repoPath: target, commit: headOf(target) });
  check('C4 ... and from the head the second session left behind — no silent divergence',
    stillCurrent.ok === true, why(stillCurrent));
}

body()
  .catch((e) => {
    failed = 1;
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  })
  .then(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmrf(tmp);
    process.exit(failed);
  });
