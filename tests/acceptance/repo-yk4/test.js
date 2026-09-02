// Frozen acceptance test — repo-yk4: make the freeze regressions cross-platform in task
// containers. This is the RED half; `guard.js` beside it carries the checks that are already
// green and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  `managedProbeMap` accepts valid Windows drive and UNC absolute probe paths on Linux
//       while still rejecting relative, missing, duplicate and mixed legacy mappings.
//   C2  protected manifests compare Git-relevant file modes across the Windows bind / Linux
//       copy boundary. (Its "keep byte and symlink sensitivity, and still detect
//       executable-bit changes where Git records them" half is pinned in `guard.js`.)
//   C3  the platform-fragile expectations `scripts/test-freeze.sh` and
//       `scripts/test-freeze-gate.sh` assert hold under Linux path semantics, and both
//       scripts remain runnable in a network-disabled image. See the DEFECT note below for
//       what this suite can and cannot say about C3.
//   C5  a change-log row documents the repair, and this suite stays focused and
//       container-engine-free.
//
//   C4 is proven ENTIRELY by `guard.js` ("no existing frozen path is edited"), because it is
//   a criterion about what did NOT change and so is green at the fork point by construction.
//
// HOW LINUX IS OBSERVED FROM A WINDOWS HOST. C1 and C3 are statements about behaviour ON
// LINUX, and C5 requires this suite to run without a container engine — so the suite cannot
// boot Linux to ask. It asks the same question the same way `path` does: `managedProbeMap`'s
// only platform-dependent line is `path.isAbsolute(probe)`, which answers `true` for
// `C:/probe` on win32 and `false` on Linux. A child process requires `scripts/freeze.js`
// FIRST (so module resolution is untouched) and only then rebinds `path.isAbsolute` to
// `path.posix.isAbsolute` — the exact substitution the platform makes. `path.win32.isAbsolute`,
// `path.posix.isAbsolute` and any regex a repair writes are all left alone, so every
// cross-platform fix passes and only a fix that still leans on the platform default fails.
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C3 as written names `scripts/test-freeze.sh`,
// `scripts/test-freeze-gate.sh` and `bash scripts/test-ci.sh`, and asks for them "in the
// network-disabled pipeline image". All three match `scripts/test-*.sh` in
// `pipeline.config.json` `frozenPaths`, and C5 requires this suite to be Docker-free. A frozen
// suite that shells into a frozen script asserts through a file it may never adjust, and it
// cannot start an image either. So C3 is proven here as the SUBSTANCE those scripts carry —
// the expectations inside them that go red on Linux today, restated directly against
// `scripts/freeze.js` — plus the static facts that both scripts are present and start no
// container engine. "The full configured regression command is green" stays a pipeline-level
// gate; no acceptance suite in this project can honestly claim it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FREEZE = path.join(REPO, 'scripts', 'freeze.js');
const PROTECTED_TREE = path.join(REPO, 'scripts', 'protected-tree.js');
const SUITE = path.join(REPO, 'tests', 'acceptance', 'repo-yk4');
const CHANGE_LOG = path.join(REPO, 'docs', 'change-log.md');
const REF = 'repo-yk4';

// See `guard.js`: fixtures and worktrees are routinely owned by another uid inside a
// container, and a frozen test must not depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
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

// One mapping question per row, asked twice — once with this host's own path semantics and
// once with Linux's. Data rather than code so the driver below needs no string escaping.
const CASES = [
  { key: 'driveForward', probes: ['a=C:/proof/probe'], probe: null, half: false, ids: ['a'] },
  { key: 'driveBack', probes: ['a=C:\\proof\\probe'], probe: null, half: false, ids: ['a'] },
  { key: 'driveSpaces', probes: ['a=Z:\\proof dir\\probe'], probe: null, half: false, ids: ['a'] },
  { key: 'unc', probes: ['a=\\\\server\\share\\probe'], probe: null, half: false, ids: ['a'] },
  { key: 'posix', probes: ['a=/srv/proof/probe'], probe: null, half: false, ids: ['a'] },
  { key: 'pair', probes: ['a=C:/one', 'b=D:\\two'], probe: null, half: false, ids: ['a', 'b'] },
  { key: 'relative', probes: ['a=relative/probe'], probe: null, half: false, ids: ['a'] },
  { key: 'driveRelative', probes: ['a=C:probe'], probe: null, half: false, ids: ['a'] },
  { key: 'missing', probes: ['a=C:/one'], probe: null, half: false, ids: ['a', 'b'] },
  { key: 'repeated', probes: ['a=C:/one', 'a=C:/two'], probe: null, half: false, ids: ['a'] },
  { key: 'duplicateIds', probes: ['a=C:/one'], probe: null, half: false, ids: ['a', 'a'] },
  { key: 'unrequested', probes: ['a=C:/one', 'z=C:/two'], probe: null, half: false, ids: ['a'] },
  { key: 'noSeparator', probes: ['aC:/one'], probe: null, half: false, ids: ['a'] },
  { key: 'emptyId', probes: ['=C:/one'], probe: null, half: false, ids: ['a'] },
  { key: 'emptyProbe', probes: ['a='], probe: null, half: false, ids: ['a'] },
  { key: 'legacyProbe', probes: ['a=C:/one'], probe: 'C:/legacy', half: false, ids: ['a'] },
  { key: 'halfProven', probes: ['a=C:/one'], probe: null, half: true, ids: ['a'] },
  { key: 'none', probes: [], probe: null, half: false, ids: ['a'] },
];

const DRIVER = [
  "'use strict';",
  "const path = require('path');",
  `const F = require(${JSON.stringify(FREEZE)});`,
  `const CASES = ${JSON.stringify(CASES)};`,
  'function ask() {',
  '  const out = {};',
  '  for (const c of CASES) {',
  '    try {',
  '      const r = F.managedProbeMap(',
  '        { managedProbes: c.probes, probe: c.probe, allowHalfProven: c.half }, c.ids);',
  '      out[c.key] = {',
  '        ok: !!(r && r.ok),',
  '        error: (r && r.error) || null,',
  '        ids: (r && r.entries) ? r.entries.map((e) => String(e.id)) : null,',
  '        probes: (r && r.entries) ? r.entries.map((e) => String(e.probe)) : null,',
  '      };',
  '    } catch (e) {',
  '      out[c.key] = { ok: false, error: `THREW ${e && e.message}`, ids: null, probes: null };',
  '    }',
  '  }',
  '  return out;',
  '}',
  '// The frozen checker also pins the parser that feeds the mapper; carried along so the',
  '// C3 section can state that whole expectation and not half of it.',
  "const parsed = F.parseArgs(['a', 'b', '--managed-probe', 'a=C:/one', '--managed-probe', 'b=C:/two']);",
  'const answer = { parsedProbes: parsed.managedProbes, parsedPositional: parsed.positional };',
  'answer.native = ask();',
  'const realIsAbsolute = path.isAbsolute;',
  '// Exactly what running on Linux changes about this function, and nothing else.',
  'path.isAbsolute = path.posix.isAbsolute;',
  'try { answer.posix = ask(); } finally { path.isAbsolute = realIsAbsolute; }',
  'process.stdout.write(JSON.stringify(answer));',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yk4-'));

try {
  check('C1 the freeze command is still present at scripts/freeze.js', fs.existsSync(FREEZE));

  const driverFile = path.join(tmp, 'linux-path-semantics.js');
  fs.writeFileSync(driverFile, `${DRIVER}\n`);
  const run = spawnSync(process.execPath, [driverFile], {
    encoding: 'utf8', cwd: REPO, timeout: 120000, windowsHide: true,
  });
  let answer = null;
  try { answer = JSON.parse(run.stdout); } catch { answer = null; }
  check(`C1 managedProbeMap could be asked under Linux path semantics${answer ? '' : ` (exit ${run.status}: ${String(run.stderr || '').trim().split('\n').slice(-3).join(' ')})`}`,
    answer !== null && answer.posix && answer.native);

  const linux = (answer && answer.posix) || {};
  const native = (answer && answer.native) || {};
  const got = (key) => linux[key] || { ok: false, error: 'NOT ASKED', ids: null };
  const why = (key) => JSON.stringify(got(key).error);

  // ---- C1, what Linux must now accept -----------------------------------------------------
  check(`C1 a Windows drive probe path with forward slashes is accepted on Linux — got ${why('driveForward')}`,
    got('driveForward').ok === true);
  check(`C1 a Windows drive probe path with backslashes is accepted on Linux — got ${why('driveBack')}`,
    got('driveBack').ok === true);
  check(`C1 a Windows drive probe path containing spaces is accepted on Linux — got ${why('driveSpaces')}`,
    got('driveSpaces').ok === true);
  check(`C1 a UNC probe path is accepted on Linux — got ${why('unc')}`,
    got('unc').ok === true);
  check(`C1 a POSIX absolute probe path is still accepted on Linux — got ${why('posix')}`,
    got('posix').ok === true);
  check(`C1 a two-issue batch of Windows mappings yields one entry per requested id, in order — got ${why('pair')}`,
    got('pair').ok === true && Array.isArray(got('pair').ids)
    && got('pair').ids.join(',') === 'a,b');
  check('C1 an accepted mapping still carries a non-empty resolved probe directory per entry',
    Array.isArray(got('pair').probes) && got('pair').probes.length === 2
    && got('pair').probes.every((p) => typeof p === 'string' && p.length > 0));

  // ---- C1, what Linux must still refuse ---------------------------------------------------
  // Accepting everything is the cheap way to pass the block above, so each refusal is named
  // with the message the operator has to read, not merely with `ok === false`.
  check(`C1 a relative probe path is still rejected on Linux — got ${why('relative')}`,
    got('relative').ok === false && /absolute/.test(got('relative').error || ''));
  check(`C1 a drive-RELATIVE probe path (\`C:probe\`) is still rejected on Linux — got ${why('driveRelative')}`,
    got('driveRelative').ok === false && /absolute/.test(got('driveRelative').error || ''));
  check(`C1 a batch missing a mapping is still rejected as missing, naming the id — got ${why('missing')}`,
    got('missing').ok === false && /missing: b/.test(got('missing').error || ''));
  check(`C1 a mapping repeated for one id is still rejected as repeated — got ${why('repeated')}`,
    got('repeated').ok === false && /repeated for a/.test(got('repeated').error || ''));
  check(`C1 duplicate issue ids are still rejected — got ${why('duplicateIds')}`,
    got('duplicateIds').ok === false && /unique/.test(got('duplicateIds').error || ''));
  check(`C1 a mapping for an unrequested id is still rejected, naming it — got ${why('unrequested')}`,
    got('unrequested').ok === false && /unrequested issue z/.test(got('unrequested').error || ''));
  check(`C1 a mapping with no \`=\` is still rejected — got ${why('noSeparator')}`,
    got('noSeparator').ok === false && /<issue-id>=<absolute-dir>/.test(got('noSeparator').error || ''));
  check(`C1 a mapping with an empty id is still rejected — got ${why('emptyId')}`,
    got('emptyId').ok === false && /<issue-id>=<absolute-dir>/.test(got('emptyId').error || ''));
  check(`C1 a mapping with an empty directory is still rejected — got ${why('emptyProbe')}`,
    got('emptyProbe').ok === false && /<issue-id>=<absolute-dir>/.test(got('emptyProbe').error || ''));
  check(`C1 the legacy \`--probe\` mixed with \`--managed-probe\` is still rejected — got ${why('legacyProbe')}`,
    got('legacyProbe').ok === false && /--probe and --managed-probe cannot be combined/.test(got('legacyProbe').error || ''));
  check(`C1 \`--allow-half-proven\` mixed with \`--managed-probe\` is still rejected — got ${why('halfProven')}`,
    got('halfProven').ok === false && /cannot be combined with --allow-half-proven/.test(got('halfProven').error || ''));
  check(`C1 a run with no managed probes at all is still the unmapped case — got ${why('none')}`,
    got('none').ok === true && got('none').ids === null);

  // ---- C3, the frozen regressions' own expectations, under Linux --------------------------
  // `tests/unit/freeze-cmd.test.js` check A4b is the exact assertion that fails inside the
  // pipeline image today: it maps `a=C:/one` and expects to be told which id is MISSING, and
  // on Linux it is told the mapping is not absolute instead. Restated here rather than run,
  // because that file and the script that drives it are both frozen paths.
  check(`C3 the frozen A4b expectation "missing names the unmapped id" holds on Linux — got ${why('missing')}`,
    got('missing').ok === false && /missing: b/.test(got('missing').error || ''));
  check(`C3 the frozen A4b expectation "a relative mapping says absolute" holds on Linux — got ${why('relative')}`,
    got('relative').ok === false && /absolute/.test(got('relative').error || ''));
  check(`C3 the frozen A4b expectation "a mixed batch cannot be combined" holds on Linux — got ${why('legacyProbe')}`,
    got('legacyProbe').ok === false && /cannot be combined/.test(got('legacyProbe').error || ''));
  check('C3 the frozen A4a expectation "parseArgs keeps every managed mapping in order" still holds',
    answer !== null && Array.isArray(answer.parsedProbes)
    && answer.parsedProbes.join('|') === 'a=C:/one|b=C:/two'
    && Array.isArray(answer.parsedPositional) && answer.parsedPositional.join(',') === 'a,b');

  // The whole point of the repair, stated once as a property rather than case by case: the two
  // platforms must answer the SAME question the SAME way. A mapping the host accepts and the
  // container refuses is precisely how a green regression suite goes red in the image.
  const disagreements = CASES.map((c) => c.key).filter((key) => {
    const n = native[key]; const l = linux[key];
    if (!n || !l) return true;
    if (n.ok !== l.ok || (n.error || null) !== (l.error || null)) return true;
    return JSON.stringify(n.ids) !== JSON.stringify(l.ids);
  });
  check(`C3 host and Linux path semantics agree on every managed-probe mapping${disagreements.length ? ` (disagree: ${disagreements.join(', ')})` : ''}`,
    answer !== null && disagreements.length === 0);

  // The static half of C3: both named scripts still exist and start no container engine, so
  // "passes in the network-disabled pipeline image" remains a question about them at all.
  const engine = /\b(?:docker|podman)\s+(?:run|build|compose|exec|image|pull|create)\b/;
  const network = /\b(?:curl|wget)\s|\bgit\s+(?:fetch|clone|pull)\s+https?:|\bnpm\s+(?:install|ci)\b/;
  for (const rel of ['scripts/test-freeze.sh', 'scripts/test-freeze-gate.sh']) {
    const file = path.join(REPO, ...rel.split('/'));
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    check(`C3 ${rel} is still present`, text !== null);
    check(`C3 ${rel} starts no container engine, so it can run in the network-disabled image`,
      text !== null && !engine.test(text));
    check(`C3 ${rel} reaches no network`, text !== null && !network.test(text));
  }

  // The command-line surface `scripts/test-freeze.sh` asserts, asked of the command directly.
  const bare = spawnSync(process.execPath, [FREEZE], { encoding: 'utf8', cwd: REPO, timeout: 60000, windowsHide: true });
  const bareText = `${bare.stdout || ''}${bare.stderr || ''}`;
  check(`C3 a bare freeze invocation still exits 2 with usage — got ${bare.status}`, bare.status === 2);
  check('C3 that usage still names both verbs',
    /freeze\.js status/.test(bareText) && /freeze\.js commit/.test(bareText));
  const help = spawnSync(process.execPath, [FREEZE, '--help'], { encoding: 'utf8', cwd: REPO, timeout: 60000, windowsHide: true });
  check(`C3 \`--help\` still exits 0 — got ${help.status}`, help.status === 0);

  // ---- C2, Git-relevant file modes across the bind/copy boundary ---------------------------
  // THE PRODUCTION FAILURE. A managed proof compares a Windows checkout bind-mounted into a
  // container against clean copies made inside it. Nothing about the files differs in Git's
  // eyes, but `entryFor` hashes all twelve permission bits, so `managedArtifactsIntact` reports
  // "changed after it was proven" and an expensive proof is thrown away.
  //
  // GIT ITSELF IS THE ORACLE, never a mode literal typed here — that is what makes the check
  // mean the same thing on both platforms. A perturbation counts only when `git status` in the
  // perturbed clone stays clean: Git has looked and recorded no change, so the manifest must
  // record none either. The perturbations Git DOES record are `guard.js`'s subject.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const PT = require(PROTECTED_TREE);
  const POLICY = { frozenPaths: ['tools/run-acceptance.sh'] };
  function tree(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'tests', 'acceptance', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pipeline.config.json'), '{"frozenPaths":["tools/run-acceptance.sh"]}\n');
    fs.writeFileSync(path.join(dir, 'tools', 'run-acceptance.sh'), '# runner\n');
    fs.writeFileSync(path.join(dir, 'tests', 'acceptance', 'demo', 'test.js'), '// demo\n');
    return dir;
  }
  function commit(dir) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'fixture@test.local');
    git(dir, 'config', 'user.name', 'fixture');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'fixture');
    return dir;
  }
  const manifestOf = (dir) => PT.protectedManifest(dir, POLICY, 'demo');

  const bind = commit(tree('bind'));
  const copy = commit(tree('copy'));
  const bindFile = path.join(bind, 'tools', 'run-acceptance.sh');
  const baseMode = fs.lstatSync(bindFile).mode & 0o7777;
  check('C2 the two clean clones start identical', PT.manifestDifference(manifestOf(bind), manifestOf(copy)).length === 0);
  check('C2 the clean clone is clean in Git\'s eyes',
    String(git(bind, 'status', '--porcelain').stdout || '').trim() === '');

  // Every non-executable permission shape this host can actually represent. On Windows only
  // the read-only attribute survives (0o666 vs 0o444); on Linux the whole non-executable
  // range does. Both are the same statement: Git records none of it.
  const usable = [];
  for (const mode of [0o644, 0o664, 0o600, 0o444, 0o400, 0o666]) {
    try { fs.chmodSync(bindFile, mode); } catch { continue; }
    const seen = fs.lstatSync(bindFile).mode & 0o7777;
    const recorded = String(git(bind, 'status', '--porcelain').stdout || '').trim();
    // Keyed on what the filesystem actually SHOWS, not on what was asked for: Windows maps a
    // whole range of requests onto two observable shapes, and asserting the same one twice
    // would inflate the count without adding a case.
    if (seen !== baseMode && (seen & 0o111) === 0 && recorded === ''
        && !usable.some((u) => u.seen === seen)) usable.push({ mode, seen });
  }
  try { fs.chmodSync(bindFile, baseMode); } catch { /* restored below anyway */ }
  check(`C2 this host can represent at least one Git-irrelevant permission difference (found ${usable.length})`,
    usable.length > 0);

  for (const { mode, seen } of usable) {
    fs.chmodSync(bindFile, mode);
    const a = manifestOf(copy);
    const b = manifestOf(bind);
    const diff = PT.manifestDifference(a, b);
    check(`C2 a permission difference Git does not record (0${mode.toString(8)} -> 0${seen.toString(8)}) does not change the protected manifest${diff.length ? ` (got: ${diff.join(', ')})` : ''}`,
      diff.length === 0);
    check(`C2 ... and does not change the manifest HASH, which is what managed proof compares (0${seen.toString(8)})`,
      PT.manifestHash(a) === PT.manifestHash(b));
  }
  try { fs.chmodSync(bindFile, baseMode); } catch { /* disposable fixture */ }

  // The same statement for a repo-shaped tree with no index — the shape the freeze gate's
  // `--green <probe-dir>` is handed, and the one `protectedManifest` serves from its
  // filesystem fallback rather than from `git hash-object`.
  const looseA = tree('loose-a');
  const looseB = tree('loose-b');
  const looseFile = path.join(looseB, 'tools', 'run-acceptance.sh');
  const indexless = git(looseB, 'rev-parse', '--is-inside-work-tree').status !== 0;
  if (!indexless) {
    check('C2 the temp area is inside a repository, so the index-less fallback is unobservable here — recorded, not claimed', true);
  } else {
    const looseBase = fs.lstatSync(looseFile).mode & 0o7777;
    const looseUsable = usable.filter(({ seen }) => seen !== looseBase);
    check(`C2 an index-less tree can show a Git-irrelevant permission difference (found ${looseUsable.length})`,
      looseUsable.length > 0);
    for (const { seen } of looseUsable) {
      fs.chmodSync(looseFile, seen);
      const diff = PT.manifestDifference(manifestOf(looseA), manifestOf(looseB));
      check(`C2 the same difference (0${seen.toString(8)}) is ignored in a repo-shaped tree with no index${diff.length ? ` (got: ${diff.join(', ')})` : ''}`,
        diff.length === 0);
    }
    try { fs.chmodSync(looseFile, looseBase); } catch { /* disposable fixture */ }
  }

  // ---- C5, the record of the repair --------------------------------------------------------
  // DESIGN.md §12: rows live in `docs/change-log.md`, one per amendment, and for a row produced
  // by a pipeline task the Ref IS the issue id. Nothing here counts rows or names its
  // neighbours, so later work is free to append as many as it likes.
  let logText = null;
  try { logText = fs.readFileSync(CHANGE_LOG, 'utf8'); } catch { logText = null; }
  check('C5 docs/change-log.md is still readable', logText !== null);
  const rows = String(logText || '').split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const mine = rows.filter((cells) => cells.length >= 4
    && cells[1].replace(/`/g, '') === REF);
  check(`C5 docs/change-log.md carries a row with Ref \`${REF}\` (found ${mine.length})`, mine.length === 1);
  if (mine.length === 1) {
    const [date, , claim, reason] = mine[0];
    check(`C5 that row carries a dated cell in the log's own format — got ${JSON.stringify(date)}`,
      /^\d{4}-\d{2}-\d{2}$/.test(date));
    // A floor on prose, never a wording match: the row has to DOCUMENT the repair, and an
    // empty or one-word cell does not. Later edits may only make these longer.
    check(`C5 that row states a claim rather than a placeholder (${claim.length} chars)`, claim.length >= 80);
    check(`C5 that row states the reason the repair was needed (${reason.length} chars)`, reason.length >= 80);
  }

  // The other half of C5, and openly self-referential: it is a statement about the files being
  // written here, so it can only ever be green. It is worth asserting anyway, because "focused
  // and Docker-free" is the property a later edit to this suite would silently spend.
  const suiteFiles = (() => {
    try { return fs.readdirSync(SUITE).filter((f) => /\.(?:js|sh)$/.test(f)); } catch { return []; }
  })();
  check(`C5 the acceptance suite for ${REF} is present and non-empty (${suiteFiles.length} test files)`,
    suiteFiles.length > 0);
  const offenders = suiteFiles.filter((f) => {
    let text = '';
    try { text = fs.readFileSync(path.join(SUITE, f), 'utf8'); } catch { return true; }
    return engine.test(text) || /\bexecSync\s*\(/.test(text)
      || /spawnSync\(\s*['"](?:sh|bash|cmd|powershell|pwsh)['"]/.test(text);
  });
  check(`C5 no file in the suite starts a container engine or shells into a script${offenders.length ? ` (offenders: ${offenders.join(', ')})` : ''}`,
    suiteFiles.length > 0 && offenders.length === 0);
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
