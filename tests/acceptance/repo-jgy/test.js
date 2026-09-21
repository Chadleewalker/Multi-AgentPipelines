// Frozen acceptance test — repo-jgy: durable non-blocking kickoff intake. This is the RED
// half; `guard.js` beside it carries the checks that are already green at the fork point and
// must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  `submit --config <path> --packet <file-or->` accepts the closed versioned packet shape
//       (title, description, constraints, examples, non-goals, priority, known relations and
//       origin), writes it once, atomically, and prints a stable proposal id plus content hash.
//   C2  twenty simultaneous valid submissions to one target produce twenty distinct readable
//       proposals with no lost, partial or overwritten record; an interrupted submission leaves
//       either a complete proposal or no visible proposal.
//   C3  `list` and `show` return deterministic human output and `--json` output from a second
//       checkout and from an equivalent path spelling of the same target.
//   C4  `submit` invokes no child process and succeeds while the ordinary target lock is held;
//       the target Git tree, index and Beads database remain byte-for-byte unchanged.
//       (Its retention half — that `runner/lock.js` IS the ordinary target lock, that its
//       authority lives outside the target, and that `canonicalTarget` still folds equivalent
//       spellings — is pinned in `guard.js`, because it is a statement about what did not
//       change and so is green at the fork point by construction.)
//   C5  editing immutable intent bytes, replacing a state component with a symlink, exceeding
//       the input bound and supplying an unknown field each return non-zero and name the
//       refusal; a refused record never appears in `list`.
//   C6  `docs/control-plane.md`, CLI help and this Docker-free suite name the same contract
//       version, state location, id/hash rule and exit-code meanings. (Its "Docker-free" half
//       is pinned in `guard.js`: that this suite starts no container engine and asserts through
//       no frozen path is true the moment the suite is written.)
//
// THE CONTRACT IS DECLARED HERE, ONCE, IN `CONTRACT` BELOW — deliberately, because C6 names
// THIS SUITE as one of the three places that must agree. A criterion about three sources
// stating one contract cannot be tested by a suite that keeps no copy of it; the tests are one
// of the parties, so the values are written down here and the other two are checked against
// them. Everything the criteria enumerate — contract version, state location, id rule, hash
// rule, input bound, exit codes and refusal names — is in that one object and nowhere else in
// this file.
//
// WHY THE STATE LOCATION IS WHERE IT IS. C4 requires the target's Git tree, index and Beads
// database to be byte-for-byte unchanged, and C3 requires `list` and `show` to answer
// identically from a second checkout and from another spelling of the same target path. Both
// are properties the project already has one home for: `runner/lock.js`'s host-global lock
// authority, which sits outside every checkout and every target and is keyed on
// `canonicalTarget` so that two spellings reach one file. The intake state is therefore pinned
// BESIDE that authority — `<host-global target lock>.kickoff/` — exactly as
// `preparationUncertainDir` pins `<lock>.preparation-uncertain` beside it today. The path is
// COMPUTED from `runner/lock.js` rather than restated here, so there is one identity rule in
// the project and not a second copy inside a frozen test.
//
// WHY THE PROPOSALS DIRECTORY HOLDS NOTHING BUT COMPLETE RECORDS. "Interruption leaves either a
// complete proposal or no visible proposal" is only observable from outside if a half-written
// record cannot be mistaken for a visible one. So the contract is that
// `<state>/proposals/` contains exactly the records and nothing else: an implementation that
// stages a write before renaming it into place — which is how the atomicity in C1 is normally
// bought — puts its staging area elsewhere under the state root. Anything else and a killed
// process leaves a file that is neither a proposal nor absent.
//
// IT RUNS NO FROZEN SCRIPT AND STARTS NO CONTAINER ENGINE. The project's verifier, the
// `scripts/test-*` suites, `tests/unit/` and the control-plane contract and loader are frozen
// paths; a frozen suite that asserted through one would be asserting through a file no
// implementation may adjust. Every behaviour below is stated directly against the CLI, against
// `runner/lock.js` as a MODULE, and against the filesystem. `guard.js` checks that this holds
// line by line over the suite's own bytes.
//
// SPEC READING, RECORDED NOT PAPERED OVER. C1 says the printed proposal id is "stable". That
// admits two readings: content-addressed (the same packet always yields the same id) or
// recorded-and-unchanging (the id printed is the id stored, the id `show` accepts and the id
// `list` keeps reporting). Only the second is consistent with C2 under every packet — twenty
// submissions must yield twenty distinct proposals, which a content-addressed id cannot do for
// twenty identical packets — so the weaker, second reading is what is asserted here. It passes
// under either implementation. Reported as an ambiguity, not a defect.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONTROL_PLANE_DOC = path.join(REPO, 'docs', 'control-plane.md');

// ---- THE CONTRACT, stated once (C6's third party) -------------------------------------------
const CONTRACT = {
  // The contract version. One token, carried by the packet, the stored record, `list --json`,
  // the CLI help and `docs/control-plane.md`, so "the same contract version" is one string and
  // not four spellings of an integer.
  version: 'kickoff-intake/1',
  // The command. Subcommands: submit, list, show. `--json` on list and show.
  cli: path.join('scripts', 'kickoff.js'),
  // The state location: a directory beside the host-global target lock authority computed by
  // `runner/lock.js`, holding a `proposals/` directory of one record per proposal. Re-aimed for
  // a test by the same environment seam that re-aims the lock itself.
  stateSuffix: '.kickoff',
  proposalsDir: 'proposals',
  stateAim: 'PIPELINE_GLOBAL_LOCK_DIR',
  // The id rule and the hash rule.
  idPattern: /^kp-[0-9a-f]{16}$/,
  idToken: /\bkp-[0-9a-f]{16}\b/g,
  hashPattern: /^sha256:[0-9a-f]{64}$/,
  hashToken: /\bsha256:[0-9a-f]{64}\b/g,
  // The input bound, in bytes of packet input as supplied. At most this many is accepted.
  maxPacketBytes: 65536,
  // The exit-code meanings, and the keyword each must be named with wherever the contract is
  // stated. `submit`, `list` and `show` all speak this vocabulary.
  exits: {
    ok: { code: 0, keyword: /accept|report/i },
    usage: { code: 2, keyword: /usage/i },
    packet: { code: 3, keyword: /packet/i },
    state: { code: 4, keyword: /state/i },
    missing: { code: 5, keyword: /no such|unknown proposal|not found/i },
  },
  // The refusal names. "Names the refusal" means this token appears on the CLI's stderr.
  refusals: {
    unknownField: 'unknown-field',
    tooLarge: 'input-too-large',
    tampered: 'tampered-intent',
    notRealDirectory: 'state-not-a-real-directory',
  },
  // The closed packet shape. Closed: any field not in this list is refused.
  packetFields: ['version', 'title', 'description', 'constraints', 'examples', 'nonGoals',
    'priority', 'relations', 'origin'],
  // The keys a stored record must carry. Extra keys are the implementation's business.
  recordKeys: ['version', 'id', 'target', 'hash', 'intent', 'createdAt'],
};

// A child that has to be killed to be collected is not a passing run; a non-blocking intake
// that blocks is exactly the failure C4 exists to catch, and a hung child would otherwise take
// the whole harness down as `indeterminate` instead of reporting a red check.
const CHILD_TIMEOUT_MS = 60000;

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

const GIT_SAFE = ['-c', 'safe.directory=*'];
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}

function rmrf(target) {
  const walkDown = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walkDown(path.join(p, n));
    }
  };
  walkDown(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A symbolic link where the host allows one, and a directory junction where it does not:
// Windows refuses `symlink()` to an unprivileged process but allows a junction, and Node reports
// both through `lstat().isSymbolicLink()`. Returns null when neither is available.
function linkDir(target, where) {
  for (const type of [undefined, 'junction']) {
    try { fs.symlinkSync(target, where, type); return type || 'symlink'; } catch { /* try next */ }
  }
  return null;
}

// A byte-for-byte snapshot of a tree: content digest per file, link target per link, and the
// bare fact of a directory. Two snapshots taken in ONE run are compared against each other —
// never against a value typed here — so nothing later work does can move the answer.
function snapshot(root) {
  const seen = new Map();
  (function visit(abs) {
    let st;
    try { st = fs.lstatSync(abs); } catch { seen.set(path.relative(root, abs), 'unreadable'); return; }
    const rel = path.relative(root, abs).split(path.sep).join('/') || '.';
    if (st.isSymbolicLink()) {
      let dest = '';
      try { dest = fs.readlinkSync(abs); } catch { dest = 'unreadable'; }
      seen.set(rel, `link:${dest}`);
      return;
    }
    if (st.isDirectory()) {
      seen.set(rel, 'dir');
      let names = [];
      try { names = fs.readdirSync(abs).sort(); } catch { names = []; }
      for (const n of names) visit(path.join(abs, n));
      return;
    }
    let digest = 'unreadable';
    try { digest = `file:${st.size}:${sha256(fs.readFileSync(abs))}`; } catch { /* recorded above */ }
    seen.set(rel, digest);
  }(root));
  return seen;
}

function snapshotDifference(before, after) {
  const out = [];
  for (const [rel, value] of before) {
    if (!after.has(rel)) out.push(`removed ${rel}`);
    else if (after.get(rel) !== value) out.push(`edited ${rel}`);
  }
  for (const rel of after.keys()) if (!before.has(rel)) out.push(`added ${rel}`);
  return out.sort();
}

// A second checkout of the pipeline, built by copying the tree this suite sits in. `.git` is
// excluded because a checkout is a working tree and the CLI is not entitled to need history;
// `tests` and `docs` are excluded for size, and the gate's own scratch directories because they
// exist only while it runs.
const CHECKOUT_SKIP = /^(\.git|runs|node_modules|tests|docs|\.freeze-gate-)/;
function copyTree(src, dst, skipTop) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipTop && CHECKOUT_SKIP.test(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    let st;
    try { st = fs.lstatSync(from); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(from, to, false);
    else { try { fs.copyFileSync(from, to); } catch { /* best effort */ } }
  }
}

// ---- the fixture ----------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jgy-'));
const STATE_HOME = path.join(tmp, 'lock-home');
const CHILD_MARKER = path.join(tmp, 'child-process-attempts.log');

// Set BEFORE `runner/lock.js` is asked anything: the authority root is read at call time, and
// this is what keeps the whole suite off the operator's real host state.
process.env[CONTRACT.stateAim] = STATE_HOME;
fs.mkdirSync(STATE_HOME, { recursive: true });

// The example run-config shape, so a CLI that validates its config sees a complete one. Only
// `targetRepoPath` is load-bearing for the intake.
function configFor(targetSpelling) {
  return {
    targetRepoPath: targetSpelling,
    targetRepoRemote: targetSpelling,
    image: 'pipeline-proof:local',
    proxyPort: 3128,
    wallClockMinutes: 240,
    probeIntervalMinutes: 15,
    bdTimeoutMs: 60000,
    gitTimeoutMs: 60000,
    lifecycleTimeoutMs: 120000,
    concurrency: 1,
    feedIdleGraceMinutes: 0,
    feedPollSeconds: 30,
    allowHalfProven: false,
    agentCommand: null,
    hostShell: null,
    model: 'opus',
  };
}

let LOCK = null;
function stateRootFor(target) {
  return `${LOCK.globalLockPath(target)}${CONTRACT.stateSuffix}`;
}

// One target per section: distinct targets have distinct canonical keys and therefore distinct
// state, so no section can be read through another's leftovers.
function makeTarget(name) {
  const dir = path.join(tmp, `target-${name}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), `// ${name}\n`);
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    '{"verifyCommand":"sh tools/proof-verify.sh","defaultBranch":"main","frozenPaths":[]}\n');
  // A Beads database and its export, so C4 has the named artifact to compare rather than a
  // stand-in for it.
  fs.writeFileSync(path.join(dir, '.beads', 'proof.db'),
    Buffer.from(`beads-fixture-${name}-${'0123456789abcdef'.repeat(8)}`, 'utf8'));
  fs.writeFileSync(path.join(dir, '.beads', 'proof.jsonl'),
    `{"id":"repo-000","title":"fixture","status":"open"}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'remote', 'add', 'origin', dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  const config = path.join(tmp, `run.config.${name}.json`);
  fs.writeFileSync(config, `${JSON.stringify(configFor(dir), null, 2)}\n`);
  return { name, dir, config, state: stateRootFor(dir), proposals: path.join(stateRootFor(dir), CONTRACT.proposalsDir) };
}

// ---- the packet -----------------------------------------------------------------------------

function packet(tag) {
  return {
    version: CONTRACT.version,
    title: `intake proof ${tag}`,
    description: `A durable non-blocking kickoff intake proposal, ${tag}.`,
    constraints: ['starts no child process', 'mutates nothing in the target'],
    examples: [`node ${CONTRACT.cli.split(path.sep).join('/')} submit --config run.config.json --packet ${tag}.json`],
    nonGoals: ['starting a container', 'writing to Beads'],
    priority: 2,
    relations: [{ kind: 'related', id: 'repo-jgy' }],
    origin: { kind: 'planning-session', ref: `repo-jgy/${tag}` },
  };
}

// A packet whose serialized input is EXACTLY `bytes` long, padded in the one free-text field.
// ASCII padding only, so a character is a byte.
function sizedPacketText(tag, bytes) {
  const p = packet(tag);
  p.description = '';
  const pad = bytes - Buffer.byteLength(JSON.stringify(p), 'utf8');
  if (pad < 0) return null;
  p.description = 'x'.repeat(pad);
  const text = JSON.stringify(p);
  return Buffer.byteLength(text, 'utf8') === bytes ? text : null;
}

function writePacket(tag, obj) {
  const file = path.join(tmp, `packet-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

// ---- running the CLI ------------------------------------------------------------------------

function childEnv(extra) {
  return { ...process.env, [CONTRACT.stateAim]: STATE_HOME, ...(extra || {}) };
}

function cliPath(root) {
  return path.join(root || REPO, CONTRACT.cli);
}

function kick(args, opts = {}) {
  const nodeArgs = [...(opts.nodeArgs || []), cliPath(opts.root), ...args];
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd: opts.cwd || REPO,
    encoding: 'utf8',
    input: opts.input,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: childEnv(opts.env),
  });
  return {
    status: r.status === null ? null : r.status,
    signal: r.signal || null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function kickAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const nodeArgs = [...(opts.nodeArgs || []), cliPath(opts.root), ...args];
    let child;
    try {
      child = spawn(process.execPath, nodeArgs, {
        cwd: opts.cwd || REPO, windowsHide: true, env: childEnv(opts.env),
      });
    } catch (e) {
      resolve({ status: null, signal: null, stdout: '', stderr: String(e), killed: false });
      return;
    }
    let out = ''; let err = ''; let killed = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    const timers = [];
    if (typeof opts.killAfterMs === 'number') {
      timers.push(setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, opts.killAfterMs));
    }
    timers.push(setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, CHILD_TIMEOUT_MS));
    child.on('close', (status, signal) => {
      for (const t of timers) clearTimeout(t);
      resolve({ status, signal: signal || null, stdout: out, stderr: err, killed });
    });
  });
}

// One id, however many times it is printed. A submission that echoes the record path as well as
// the id prints the token twice and is not thereby wrong; printing TWO DIFFERENT ids is, because
// then nothing on stdout is "the" proposal id.
const tokensIn = (text, re) => { re.lastIndex = 0; return String(text).match(re) || []; };
const oneOf = (text, re) => {
  const m = tokensIn(text, re);
  return m.length >= 1 && new Set(m).size === 1 ? m[0] : null;
};
const oneIdIn = (text) => oneOf(text, CONTRACT.idToken);
const oneHashIn = (text) => oneOf(text, CONTRACT.hashToken);
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

function entriesIn(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return null; }
}

// A record is valid when it is a regular file named for the id it carries, its declared hash
// matches the contract's hash rule, and re-hashing its own immutable intent bytes reproduces it.
function recordProblem(dir, name) {
  const abs = path.join(dir, name);
  if (!/^kp-[0-9a-f]{16}\.json$/.test(name)) return `${name}: not a record file name`;
  let st;
  try { st = fs.lstatSync(abs); } catch { return `${name}: unreadable`; }
  if (!st.isFile()) return `${name}: not a regular file`;
  const rec = parseJson((() => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } })());
  if (!rec || typeof rec !== 'object') return `${name}: not parseable JSON`;
  for (const key of CONTRACT.recordKeys) {
    if (!(key in rec)) return `${name}: record has no \`${key}\``;
  }
  if (rec.id !== name.slice(0, -5)) return `${name}: record id \`${rec.id}\` does not name its own file`;
  if (!CONTRACT.idPattern.test(String(rec.id))) return `${name}: id does not follow the id rule`;
  if (!CONTRACT.hashPattern.test(String(rec.hash))) return `${name}: hash does not follow the hash rule`;
  if (typeof rec.intent !== 'string') return `${name}: intent is not a byte string`;
  if (`sha256:${sha256(Buffer.from(rec.intent, 'utf8'))}` !== rec.hash) return `${name}: hash does not match its own intent bytes`;
  if (rec.version !== CONTRACT.version) return `${name}: record declares version \`${rec.version}\``;
  if (!parseJson(rec.intent)) return `${name}: intent bytes are not a parseable packet`;
  return null;
}

function recordProblems(dir) {
  const names = entriesIn(dir);
  if (names === null) return ['the proposals directory does not exist'];
  const out = [];
  for (const n of names) { const why = recordProblem(dir, n); if (why) out.push(why); }
  return out;
}

// ---- the run --------------------------------------------------------------------------------

async function run() {
  // `runner/lock.js` is loaded as a MODULE, for the reason the header gives: the state location
  // is derived from the project's own identity rule rather than from a second copy of it here.
  // A tree without it cannot be judged, and that is said out loud rather than assumed.
  const lockModule = path.join(REPO, 'runner', 'lock.js');
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    LOCK = require(lockModule);
  } catch (e) {
    check(`C1 runner/lock.js loads, so the contract's state location can be computed (${e && e.message})`, false);
    return;
  }

  // A single writeable shim that makes child-process creation impossible and audible. Preloaded
  // with `--require` so it patches the builtin BEFORE the CLI captures any reference from it.
  // What it cannot see is a raw libuv spawn or a native addon; nothing in this project does that,
  // and the limit is recorded rather than hidden.
  const shim = path.join(tmp, 'no-child-process.js');
  fs.writeFileSync(shim, [
    "'use strict';",
    "const cp = require('child_process');",
    "const io = require('fs');",
    'const marker = process.env.KICKOFF_PROOF_CHILD_MARKER;',
    "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
    "  if (typeof cp[name] !== 'function') continue;",
    '  cp[name] = function refuse() {',
    "    try { io.appendFileSync(marker, name + '\\n'); } catch (e) { /* the throw is the signal */ }",
    "    throw new Error('kickoff-proof: child process creation is disabled for this run: ' + name);",
    '  };',
    '}',
    '',
  ].join('\n'));

  // =========================================================================================
  // C1 — submit accepts the closed versioned packet, writes it once, prints id and hash
  // =========================================================================================
  const c1 = makeTarget('c1');
  const p1 = packet('c1-file');
  const first = kick(['submit', '--config', c1.config, '--packet', writePacket('c1-file', p1)]);
  check(`C1 submit exits ${CONTRACT.exits.ok.code} for a complete valid packet read from a file (got ${first.status}${first.stderr ? `; stderr: ${first.stderr.trim().split('\n')[0]}` : ''})`,
    first.status === CONTRACT.exits.ok.code);
  const id1 = oneIdIn(first.stdout);
  const hash1 = oneHashIn(first.stdout);
  check('C1 submit prints one proposal id, and only one, following the id rule', id1 !== null);
  check('C1 submit prints one content hash, and only one, following the hash rule', hash1 !== null);

  const stdinPacket = packet('c1-stdin');
  const second = kick(['submit', '--config', c1.config, '--packet', '-'], { input: JSON.stringify(stdinPacket) });
  check(`C1 submit accepts the same packet on stdin via \`--packet -\` (got ${second.status})`,
    second.status === CONTRACT.exits.ok.code);
  const id2 = oneIdIn(second.stdout);
  check('C1 the stdin submission prints its own distinct proposal id',
    id2 !== null && id1 !== null && id2 !== id1);

  const c1Entries = entriesIn(c1.proposals);
  check(`C1 the contract's state location holds a proposals directory (${c1.proposals})`, c1Entries !== null);
  check(`C1 the proposals directory holds exactly the two submitted records (${(c1Entries || []).join(', ') || 'none'})`,
    Array.isArray(c1Entries) && c1Entries.length === 2);
  check('C1 each printed id names its own record file in the proposals directory',
    id1 !== null && id2 !== null
    && fs.existsSync(path.join(c1.proposals, `${id1}.json`))
    && fs.existsSync(path.join(c1.proposals, `${id2}.json`)));
  const c1Problems = recordProblems(c1.proposals);
  check(`C1 every stored record is complete and its hash matches its own intent bytes${c1Problems.length ? ` (${c1Problems.slice(0, 3).join('; ')})` : ''}`,
    c1Problems.length === 0);

  const rec1 = id1 ? parseJson((() => { try { return fs.readFileSync(path.join(c1.proposals, `${id1}.json`), 'utf8'); } catch { return ''; } })()) : null;
  check('C1 the printed content hash is the record\'s own hash', rec1 !== null && rec1.hash === hash1);
  check(`C1 the stored record declares the contract version \`${CONTRACT.version}\``,
    rec1 !== null && rec1.version === CONTRACT.version);
  check('C1 the stored record names the canonical target rather than the spelling the config used',
    rec1 !== null && rec1.target === LOCK.canonicalTarget(c1.dir));
  const intent1 = rec1 ? parseJson(rec1.intent) : null;
  const missingFields = intent1 ? CONTRACT.packetFields.filter((f) => !(f in intent1)) : CONTRACT.packetFields;
  check(`C1 the immutable intent bytes round-trip every closed packet field${missingFields.length ? ` (missing: ${missingFields.join(', ')})` : ''}`,
    missingFields.length === 0);
  check('C1 the immutable intent bytes round-trip the packet\'s exact values',
    intent1 !== null && JSON.stringify(intent1) === JSON.stringify(p1));

  // Written ONCE: a later submission to the same target must not rewrite, re-key or re-order an
  // existing record. Two snapshots of the same file taken in this one run.
  const beforeThird = id1 ? snapshot(path.join(c1.proposals, `${id1}.json`)) : new Map();
  kick(['submit', '--config', c1.config, '--packet', writePacket('c1-third', packet('c1-third'))]);
  const afterThird = id1 ? snapshot(path.join(c1.proposals, `${id1}.json`)) : new Map();
  const rewrite = snapshotDifference(beforeThird, afterThird);
  check(`C1 an existing record's bytes are untouched by a later submission — written once, never rewritten${rewrite.length ? ` (${rewrite.join(', ')})` : ''}`,
    id1 !== null && rewrite.length === 0);
  const c1After = entriesIn(c1.proposals) || [];
  check(`C1 the proposals directory holds only complete records — no staging or temporary entry (${c1After.join(', ')})`,
    c1After.length === 3 && recordProblems(c1.proposals).length === 0);

  // =========================================================================================
  // C2 — twenty simultaneous submissions, and interruption
  // =========================================================================================
  const c2 = makeTarget('c2');
  const burst = [];
  for (let i = 0; i < 20; i++) {
    const tag = `c2-${String(i).padStart(2, '0')}`;
    burst.push(kickAsync(['submit', '--config', c2.config, '--packet', writePacket(tag, packet(tag))]));
  }
  const bursted = await Promise.all(burst);
  const badExits = bursted.filter((r) => r.status !== CONTRACT.exits.ok.code);
  check(`C2 twenty simultaneous submissions to one target all exit ${CONTRACT.exits.ok.code}${badExits.length ? ` (${badExits.length} did not: ${badExits.slice(0, 3).map((r) => `${r.status}/${(r.stderr || '').trim().split('\n')[0]}`).join(' | ')})` : ''}`,
    badExits.length === 0);
  const burstIds = bursted.map((r) => oneIdIn(r.stdout)).filter(Boolean);
  check(`C2 the twenty submissions print twenty proposal ids (got ${burstIds.length})`, burstIds.length === 20);
  check(`C2 those twenty ids are all distinct — no id reused (got ${new Set(burstIds).size} distinct)`,
    new Set(burstIds).size === 20);
  const c2Entries = entriesIn(c2.proposals) || [];
  check(`C2 the proposals directory holds exactly twenty entries — nothing lost or overwritten (got ${c2Entries.length})`,
    c2Entries.length === 20);
  const c2Problems = recordProblems(c2.proposals);
  check(`C2 all twenty stored records are complete and hash-valid${c2Problems.length ? ` (${c2Problems.slice(0, 3).join('; ')})` : ''}`,
    c2Problems.length === 0);
  const c2Listed = kick(['list', '--config', c2.config, '--json']);
  const c2Json = parseJson(c2Listed.stdout);
  const c2ListedIds = c2Json && Array.isArray(c2Json.proposals) ? c2Json.proposals.map((p) => p.id) : [];
  check(`C2 list --json exits ${CONTRACT.exits.ok.code} and reports exactly the twenty submitted ids (got ${c2ListedIds.length})`,
    c2Listed.status === CONTRACT.exits.ok.code
    && c2ListedIds.length === 20
    && [...new Set(c2ListedIds)].sort().join(',') === [...new Set(burstIds)].sort().join(','));
  check('C2 every one of the twenty ids is readable through show',
    burstIds.length === 20 && burstIds.every((id) => {
      const shown = kick(['show', '--config', c2.config, '--id', id, '--json']);
      const body = parseJson(shown.stdout);
      return shown.status === CONTRACT.exits.ok.code && body && body.id === id;
    }));

  // Interruption. Killed at a spread of delays across process startup and work, so some
  // submissions complete and some do not; what is asserted is that nothing in between is ever
  // visible.
  const c2i = makeTarget('c2i');
  // An ANCHOR submission that is never interrupted, so "nothing is visible" cannot satisfy the
  // checks below. How many of the killed submissions get far enough to complete is a fact about
  // machine load, and a check that depended on it would be flaky in the direction that reads as
  // a broken suite; the anchor is what makes the assertions non-vacuous without depending on it.
  const anchor = oneIdIn(kick(['submit', '--config', c2i.config, '--packet', writePacket('c2i-anchor', packet('c2i-anchor'))]).stdout);
  const killed = await Promise.all([0, 30, 60, 100, 150, 200, 300, 400].map((ms, i) => {
    const tag = `c2i-${i}`;
    return kickAsync(['submit', '--config', c2i.config, '--packet', writePacket(tag, packet(tag))],
      { killAfterMs: ms });
  }));
  const survived = killed.filter((r) => r.status === CONTRACT.exits.ok.code).map((r) => oneIdIn(r.stdout)).filter(Boolean);
  const iListed = kick(['list', '--config', c2i.config, '--json']);
  const iJson = parseJson(iListed.stdout);
  const iIds = iJson && Array.isArray(iJson.proposals) ? iJson.proposals.map((p) => p.id) : [];
  check(`C2 list --json still exits ${CONTRACT.exits.ok.code} after eight interrupted submissions (got ${iListed.status}${iListed.stderr ? `; ${iListed.stderr.trim().split('\n')[0]}` : ''})`,
    iListed.status === CONTRACT.exits.ok.code);
  const iProblems = recordProblems(c2i.proposals);
  const iEntries = entriesIn(c2i.proposals);
  check(`C2 interruption left no partial, unnamed or half-written entry in the proposals directory${iProblems.length ? ` (${iProblems.slice(0, 3).join('; ')})` : ''}`,
    iProblems.length === 0);
  // Every condition below is gated on the anchor: "nothing visible" is trivially true of an
  // intake that never wrote anything, and a check a missing feature satisfies is not a check.
  check(`C2 every proposal visible after interruption is a complete record (${iIds.length} visible of ${(iEntries || []).length} stored)`,
    iListed.status === CONTRACT.exits.ok.code && anchor !== null && iIds.includes(anchor)
    && Array.isArray(iEntries) && iIds.length === iEntries.length
    && iIds.every((id) => recordProblem(c2i.proposals, `${id}.json`) === null));
  check(`C2 every interrupted submission that exited ${CONTRACT.exits.ok.code} is visible, and only those are — a complete proposal or none (${survived.length} of eight completed)`,
    iListed.status === CONTRACT.exits.ok.code && anchor !== null && iIds.includes(anchor)
    // `>=`, not `===`: a submission killed AFTER its atomic write but before it could exit is
    // visible and non-zero, and C2 explicitly permits that — a complete proposal is a legal
    // outcome of an interruption. What is forbidden is a completed submission that is missing,
    // or anything visible that is not one of the nine.
    && survived.every((id) => iIds.includes(id))
    && iIds.length >= survived.length + 1 && iIds.length <= killed.length + 1);

  // =========================================================================================
  // C3 — deterministic list and show from a second checkout and an equivalent path spelling
  // =========================================================================================
  const c3 = makeTarget('c3');
  const c3Ids = [];
  for (const tag of ['c3-a', 'c3-b', 'c3-c']) {
    const r = kick(['submit', '--config', c3.config, '--packet', writePacket(tag, packet(tag))]);
    const got = oneIdIn(r.stdout);
    if (got) c3Ids.push(got);
  }
  check(`C3 three proposals were submitted to build a deterministic view over (got ${c3Ids.length})`, c3Ids.length === 3);

  const secondCheckout = path.join(tmp, 'second-checkout');
  copyTree(REPO, secondCheckout, true);
  check(`C3 a second checkout of the pipeline carries the CLI at ${CONTRACT.cli.split(path.sep).join('/')}`,
    fs.existsSync(cliPath(secondCheckout)));

  // An equivalent spelling of the same target, written into a config at a different path so
  // nothing about the answer can come from the config's own location.
  const altDir = path.join(tmp, 'alt-config-home');
  fs.mkdirSync(altDir, { recursive: true });
  const altSpelling = process.platform === 'win32'
    ? `${path.join(c3.dir, 'src', '..').split(path.sep).join('/')}/`
    : `${path.join(c3.dir, 'src', '..')}/./`;
  const altConfig = path.join(altDir, 'run.config.alt.json');
  fs.writeFileSync(altConfig, `${JSON.stringify(configFor(altSpelling), null, 2)}\n`);
  // The precondition rides ON the two alt-spelling checks rather than standing as a check of its
  // own: it is a fact about `runner/lock.js` (pinned in `guard.js`) and it is green at the fork
  // point, so as a separate check here it would prove nothing and hide a fixture that had
  // stopped spelling an equivalent path.
  const altEquivalent = LOCK.canonicalTarget(altSpelling) === LOCK.canonicalTarget(c3.dir);

  const views = [
    ['a repeat invocation', { config: c3.config, opts: {}, pre: true }],
    ['a different working directory', { config: c3.config, opts: { cwd: tmp }, pre: true }],
    ['a second checkout', { config: c3.config, opts: { root: secondCheckout, cwd: secondCheckout }, pre: fs.existsSync(cliPath(secondCheckout)) }],
    ['an equivalent path spelling', { config: altConfig, opts: {}, pre: altEquivalent }],
  ];
  const baselineHuman = kick(['list', '--config', c3.config]);
  const baselineJson = kick(['list', '--config', c3.config, '--json']);
  check(`C3 list exits ${CONTRACT.exits.ok.code} in human form and in --json form (got ${baselineHuman.status} and ${baselineJson.status})`,
    baselineHuman.status === CONTRACT.exits.ok.code && baselineJson.status === CONTRACT.exits.ok.code);
  check('C3 list human output names every proposal it holds',
    c3Ids.length === 3 && c3Ids.every((id) => baselineHuman.stdout.includes(id)));
  const baseJson = parseJson(baselineJson.stdout);
  check('C3 list --json names the canonical target rather than the spelling the config used',
    baseJson !== null && baseJson.target === LOCK.canonicalTarget(c3.dir)
    && baseJson.version === CONTRACT.version);

  for (const [label, view] of views) {
    const human = kick(['list', '--config', view.config], view.opts);
    const json = kick(['list', '--config', view.config, '--json'], view.opts);
    check(`C3 list human output is byte-identical from ${label}`,
      view.pre && human.status === CONTRACT.exits.ok.code && human.stdout === baselineHuman.stdout);
    check(`C3 list --json output is byte-identical from ${label}`,
      view.pre && json.status === CONTRACT.exits.ok.code && json.stdout === baselineJson.stdout);
  }

  const showId = c3Ids[0] || 'kp-0000000000000000';
  const showHuman = kick(['show', '--config', c3.config, '--id', showId]);
  const showJson = kick(['show', '--config', c3.config, '--id', showId, '--json']);
  check(`C3 show exits ${CONTRACT.exits.ok.code} in human form and in --json form (got ${showHuman.status} and ${showJson.status})`,
    showHuman.status === CONTRACT.exits.ok.code && showJson.status === CONTRACT.exits.ok.code);
  const shownBody = parseJson(showJson.stdout);
  check('C3 show --json carries the id, the content hash, the canonical target and the packet itself',
    shownBody !== null && shownBody.id === showId
    && CONTRACT.hashPattern.test(String(shownBody.hash))
    && shownBody.target === LOCK.canonicalTarget(c3.dir)
    && shownBody.version === CONTRACT.version
    && shownBody.packet && shownBody.packet.title === packet('c3-a').title);
  check('C3 show human output names the proposal it is showing', showHuman.stdout.includes(showId));
  for (const [label, view] of views) {
    const human = kick(['show', '--config', view.config, '--id', showId], view.opts);
    const json = kick(['show', '--config', view.config, '--id', showId, '--json'], view.opts);
    check(`C3 show human output is byte-identical from ${label}`,
      view.pre && human.status === CONTRACT.exits.ok.code && human.stdout === showHuman.stdout);
    check(`C3 show --json output is byte-identical from ${label}`,
      view.pre && json.status === CONTRACT.exits.ok.code && json.stdout === showJson.stdout);
  }

  // =========================================================================================
  // C4 — no child process, the held target lock, and an untouched target
  // =========================================================================================
  const c4 = makeTarget('c4');
  const lockRepoRoot = path.join(tmp, 'lock-observer-checkout');
  fs.mkdirSync(lockRepoRoot, { recursive: true });
  const held = LOCK.acquire(lockRepoRoot, c4.dir, 'repo-jgy-proof-run');
  const lockHeld = !!(held && held.ok);

  const authority = LOCK.globalLockPath(c4.dir);
  const authorityBefore = snapshot(authority);
  const targetBefore = snapshot(c4.dir);
  const beadsBefore = snapshot(path.join(c4.dir, '.beads'));
  try { fs.rmSync(CHILD_MARKER, { force: true }); } catch { /* first run */ }

  const underLock = kick(['submit', '--config', c4.config, '--packet', writePacket('c4', packet('c4'))], {
    nodeArgs: ['--require', shim.split(path.sep).join('/')],
    env: { KICKOFF_PROOF_CHILD_MARKER: CHILD_MARKER },
  });
  let attempts = '';
  try { attempts = fs.readFileSync(CHILD_MARKER, 'utf8'); } catch { attempts = ''; }

  // `accepted` gates every "unchanged" check below, and that gating is the point. "The target is
  // byte-for-byte unchanged" is trivially true of an intake that does not exist, so on its own it
  // is a check no implementation is needed to satisfy. What C4 actually claims is that a submit
  // WHICH SUCCEEDED changed nothing — so the success is part of every one of them.
  const c4Id = oneIdIn(underLock.stdout);
  const accepted = lockHeld && underLock.status === CONTRACT.exits.ok.code && c4Id !== null;
  check(`C4 submit exits ${CONTRACT.exits.ok.code}, unkilled, while the ordinary target lock is held by another owner and child-process creation is disabled (got ${underLock.status}${underLock.stderr ? `; ${underLock.stderr.trim().split('\n')[0]}` : ''})`,
    lockHeld && underLock.status === CONTRACT.exits.ok.code && underLock.signal === null);
  check(`C4 that submit attempted no child process at all${attempts ? ` (attempted: ${attempts.trim().split('\n').join(', ')})` : ''}`,
    accepted && attempts === '');
  const c4Problems = recordProblems(c4.proposals);
  check(`C4 the proposal written under the held lock is present and hash-valid${c4Problems.length ? ` (${c4Problems.slice(0, 2).join('; ')})` : ''}`,
    accepted && c4Problems.length === 0 && fs.existsSync(path.join(c4.proposals, `${c4Id}.json`)));

  const targetDiff = snapshotDifference(targetBefore, snapshot(c4.dir));
  const gitDiff = targetDiff.filter((d) => /\s\.git(\/|$)/.test(d));
  const beadsDiff = snapshotDifference(beadsBefore, snapshot(path.join(c4.dir, '.beads')));
  const authorityDiff = snapshotDifference(authorityBefore, snapshot(authority));
  check(`C4 the accepted submit left the target repository byte-for-byte unchanged — working tree, Git tree and index alike${targetDiff.length ? ` (${targetDiff.slice(0, 5).join(', ')})` : ''}`,
    accepted && targetDiff.length === 0);
  check(`C4 the accepted submit left the target's Git directory, its index included, byte-for-byte unchanged${gitDiff.length ? ` (${gitDiff.slice(0, 5).join(', ')})` : ''}`,
    accepted && gitDiff.length === 0);
  check(`C4 the accepted submit left the target's Beads database and its export byte-for-byte unchanged${beadsDiff.length ? ` (${beadsDiff.join(', ')})` : ''}`,
    accepted && beadsDiff.length === 0);
  check(`C4 the accepted submit left the ordinary target lock's own authority record byte-for-byte unchanged — it neither took the lock nor waited for it${authorityDiff.length ? ` (${authorityDiff.join(', ')})` : ''}`,
    accepted && authorityDiff.length === 0);
  try { LOCK.release(lockRepoRoot, c4.dir, held && held.ownership); } catch { /* disposable */ }

  // =========================================================================================
  // C5 — the four refusals, each named, and a refused record that never appears in list
  // =========================================================================================
  const c5 = makeTarget('c5');
  const keepIds = [];
  for (const tag of ['c5-a', 'c5-b']) {
    const r = kick(['submit', '--config', c5.config, '--packet', writePacket(tag, packet(tag))]);
    const got = oneIdIn(r.stdout);
    if (got) keepIds.push(got);
  }
  check(`C5 two accepted proposals exist for the refusals to be measured against (got ${keepIds.length})`,
    keepIds.length === 2);
  const cleanHuman = kick(['list', '--config', c5.config]);
  const cleanJson = kick(['list', '--config', c5.config, '--json']);

  // (a) an unknown field — the packet shape is closed.
  const strange = packet('c5-unknown');
  strange.escalate = true;
  const unknown = kick(['submit', '--config', c5.config, '--packet', writePacket('c5-unknown', strange)]);
  check(`C5 an unknown packet field is refused with exit ${CONTRACT.exits.packet.code} (got ${unknown.status})`,
    unknown.status === CONTRACT.exits.packet.code);
  check(`C5 the unknown-field refusal is named on stderr as \`${CONTRACT.refusals.unknownField}\` and names the field`,
    unknown.stderr.includes(CONTRACT.refusals.unknownField) && unknown.stderr.includes('escalate'));

  // (b) the input bound — one byte over is refused, and exactly at the bound is still accepted,
  // so the bound is proven to be a bound rather than a wall somewhere below it.
  const overText = sizedPacketText('c5-over', CONTRACT.maxPacketBytes + 1);
  const atText = sizedPacketText('c5-at', CONTRACT.maxPacketBytes);
  const overFile = path.join(tmp, 'packet-c5-over.json');
  const atFile = path.join(tmp, 'packet-c5-at.json');
  if (overText) fs.writeFileSync(overFile, overText);
  if (atText) fs.writeFileSync(atFile, atText);
  const over = kick(['submit', '--config', c5.config, '--packet', overFile]);
  check(`C5 a packet one byte over the ${CONTRACT.maxPacketBytes}-byte input bound is refused with exit ${CONTRACT.exits.packet.code} (got ${over.status})`,
    overText !== null && over.status === CONTRACT.exits.packet.code);
  check(`C5 the input-bound refusal is named on stderr as \`${CONTRACT.refusals.tooLarge}\` and states the bound`,
    overText !== null && over.stderr.includes(CONTRACT.refusals.tooLarge)
    && over.stderr.includes(String(CONTRACT.maxPacketBytes)));
  const at = kick(['submit', '--config', c5.config, '--packet', atFile]);
  check(`C5 a packet of exactly the bound is still accepted — the bound is a bound, not a wall below it (got ${at.status})`,
    atText !== null && at.status === CONTRACT.exits.ok.code);
  const atId = oneIdIn(at.stdout);

  // A refused record never appears in list: the two refusals above must have left the visible
  // state exactly as it was, and the one acceptance between them must be the only change.
  const afterRefusals = kick(['list', '--config', c5.config, '--json']);
  const afterIds = (() => { const b = parseJson(afterRefusals.stdout); return b && Array.isArray(b.proposals) ? b.proposals.map((p) => p.id) : []; })();
  check(`C5 neither packet refusal left an entry in the proposals directory (${(entriesIn(c5.proposals) || []).length} entries for ${keepIds.length + 1} accepted)`,
    (entriesIn(c5.proposals) || []).length === keepIds.length + 1);
  check('C5 a refused record never appears in list — only the accepted proposals do',
    afterRefusals.status === CONTRACT.exits.ok.code
    && atId !== null
    && [...afterIds].sort().join(',') === [...keepIds, atId].sort().join(','));
  check(`C5 a refused submission is not readable through show either — an unknown id is exit ${CONTRACT.exits.missing.code}, never a proposal`,
    keepIds.length === 2
    && kick(['show', '--config', c5.config, '--id', 'kp-ffffffffffffffff']).status === CONTRACT.exits.missing.code);

  // (c) editing immutable intent bytes. The intent string alone is changed; the recorded hash is
  // left exactly as written, which is what "immutable" has to mean to be checkable.
  const victim = path.join(c5.proposals, `${keepIds[0]}.json`);
  const victimBytes = (() => { try { return fs.readFileSync(victim); } catch { return null; } })();
  let tamperedList = { status: null, stdout: '', stderr: '' };
  let tamperedShow = { status: null, stdout: '', stderr: '' };
  if (victimBytes) {
    const rec = parseJson(victimBytes.toString('utf8'));
    if (rec && typeof rec.intent === 'string') {
      rec.intent = rec.intent.replace('intake proof', 'intake pr00f');
      fs.writeFileSync(victim, `${JSON.stringify(rec, null, 2)}\n`);
    }
    tamperedList = kick(['list', '--config', c5.config, '--json']);
    tamperedShow = kick(['show', '--config', c5.config, '--id', keepIds[0]]);
  }
  check(`C5 edited immutable intent bytes are refused by list with exit ${CONTRACT.exits.state.code} (got ${tamperedList.status})`,
    tamperedList.status === CONTRACT.exits.state.code);
  check(`C5 the tampered-intent refusal is named on stderr as \`${CONTRACT.refusals.tampered}\` and names the proposal`,
    tamperedList.stderr.includes(CONTRACT.refusals.tampered) && tamperedList.stderr.includes(keepIds[0] || 'kp-'));
  check('C5 the tampered record never appears in list output',
    victimBytes !== null && keepIds.length === 2 && !tamperedList.stdout.includes(keepIds[0]));
  check(`C5 show for the tampered proposal is refused with exit ${CONTRACT.exits.state.code} (got ${tamperedShow.status})`,
    tamperedShow.status === CONTRACT.exits.state.code);
  if (victimBytes) fs.writeFileSync(victim, victimBytes);
  const restored = kick(['list', '--config', c5.config, '--json']);
  check('C5 restoring the record\'s own bytes makes list green again and the proposal reappears — the refusal was about the edit, not the record',
    restored.status === CONTRACT.exits.ok.code && restored.stdout === afterRefusals.stdout);

  // (d) a state component replaced by a symlink. The link points at a directory with IDENTICAL
  // content, so nothing but the link-ness itself distinguishes the two states.
  const realAway = `${c5.proposals}-real`;
  let linkKind = null;
  // The state component has to EXIST before it can be replaced. A missing proposals directory is
  // not an environment without symlinks, it is an intake that never wrote anything — so the
  // "unobservable" branch below is reachable only when the directory was there and the host
  // genuinely refused both a symlink and a junction. Otherwise this is a plain red.
  const componentPresent = entriesIn(c5.proposals) !== null;
  if (componentPresent) {
    try {
      fs.renameSync(c5.proposals, realAway);
      linkKind = linkDir(realAway, c5.proposals);
      if (linkKind === null) fs.renameSync(realAway, c5.proposals);
    } catch { linkKind = null; }
  }
  if (!componentPresent) {
    check('C5 a state component exists to be replaced by a symlink', false);
  } else if (linkKind === null) {
    // An environment that can make no link at all has nothing to say about link sensitivity,
    // and pretending otherwise would be a vacuous pass. Recorded rather than silently dropped.
    check('C5 a symlinked state component is unobservable here (no symlink or junction can be created) — recorded, not claimed', true);
  } else {
    const linked = kick(['list', '--config', c5.config, '--json']);
    const linkedShow = kick(['show', '--config', c5.config, '--id', keepIds[0]]);
    check(`C5 a state component replaced by a ${linkKind} is refused by list with exit ${CONTRACT.exits.state.code} (got ${linked.status})`,
      linked.status === CONTRACT.exits.state.code);
    check(`C5 that refusal is named on stderr as \`${CONTRACT.refusals.notRealDirectory}\``,
      linked.stderr.includes(CONTRACT.refusals.notRealDirectory));
    check(`C5 show is refused the same way while a state component is a ${linkKind} (got ${linkedShow.status})`,
      linkedShow.status === CONTRACT.exits.state.code);
    check('C5 no proposal appears in list while a state component is a link',
      !linked.stdout.includes(keepIds[0] || 'kp-0000000000000000'));
    // The link is removed as a LINK — never recursively. A recursive delete through a junction
    // can take the contents of the directory it points at with it, and that directory holds the
    // very records the checks after this one read.
    try {
      const st = fs.lstatSync(c5.proposals);
      if (st.isSymbolicLink() || st.isDirectory()) {
        try { fs.unlinkSync(c5.proposals); } catch { fs.rmdirSync(c5.proposals); }
      }
    } catch { /* already gone */ }
    try { fs.renameSync(realAway, c5.proposals); } catch { /* restore best effort */ }
    const unlinked = kick(['list', '--config', c5.config, '--json']);
    check('C5 restoring the real directory makes list green again with the same bytes — the refusal was about the link',
      unlinked.status === CONTRACT.exits.ok.code && unlinked.stdout === afterRefusals.stdout);
  }
  const survivors = entriesIn(c5.proposals) || [];
  check(`C5 every accepted proposal survived all four refusals complete and hash-valid (${survivors.length} for ${keepIds.length + 1} accepted)`,
    cleanHuman.status === CONTRACT.exits.ok.code && cleanJson.status === CONTRACT.exits.ok.code
    && survivors.length === keepIds.length + 1
    && recordProblems(c5.proposals).length === 0);

  // =========================================================================================
  // C6 — one contract in three places, and every exit code it names is real
  // =========================================================================================
  const help = kick(['--help']);
  const helpText = `${help.stdout}\n${help.stderr}`;
  let doc = '';
  try { doc = fs.readFileSync(CONTROL_PLANE_DOC, 'utf8'); } catch { doc = ''; }
  check(`C6 CLI help exits ${CONTRACT.exits.ok.code} (got ${help.status})`, help.status === CONTRACT.exits.ok.code);

  // The state-location, id-rule and hash-rule tokens, asked of both other sources against the
  // one declaration at the top of this file. Substance tokens, not a sentence to copy: the
  // failure message names exactly what was missing on each side.
  const tokens = [
    ['the contract version', CONTRACT.version],
    ['the CLI path', CONTRACT.cli.split(path.sep).join('/')],
    ['the state-location suffix', CONTRACT.stateSuffix],
    ['the proposals directory', CONTRACT.proposalsDir],
    ['the state-location seam', CONTRACT.stateAim],
    ['the id rule', 'kp-'],
    ['the hash rule', 'sha256'],
    ['the immutable intent bytes', 'intent'],
    ['the input bound', String(CONTRACT.maxPacketBytes)],
  ];
  const missingDoc = tokens.filter(([, t]) => !doc.includes(t)).map(([label]) => label);
  const missingHelp = tokens.filter(([, t]) => !helpText.includes(t)).map(([label]) => label);
  check(`C6 docs/control-plane.md names the contract this suite declares${missingDoc.length ? ` (missing: ${missingDoc.join('; ')})` : ''}`,
    missingDoc.length === 0);
  check(`C6 CLI help names the same contract this suite declares${missingHelp.length ? ` (missing: ${missingHelp.join('; ')})` : ''}`,
    missingHelp.length === 0);

  // Exit-code meanings. A code is "named with its meaning" when one line carries the code as a
  // standalone number and the meaning's keyword. Line-scoped so a document that lists the codes
  // in a table or a help screen that lists them in a block both satisfy it, and so a page that
  // merely contains the digits somewhere does not.
  const namesExitCode = (text, code, keyword) => String(text).split(/\r?\n/)
    .some((line) => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(line) && keyword.test(line));
  for (const [name, spec] of Object.entries(CONTRACT.exits)) {
    check(`C6 docs/control-plane.md names exit ${spec.code} and what it means (${name})`,
      namesExitCode(doc, spec.code, spec.keyword));
    check(`C6 CLI help names exit ${spec.code} and what it means (${name})`,
      namesExitCode(helpText, spec.code, spec.keyword));
  }

  // Every code in that vocabulary must be REAL, or the contract the three sources agree on is
  // partly fiction. Codes 3 and 4 are exercised by C5 above; 0 by every section; these are the
  // remaining two.
  const noConfig = kick(['submit', '--packet', '-'], { input: JSON.stringify(packet('c6-usage')) });
  check(`C6 exit ${CONTRACT.exits.usage.code} is real: submit with no --config is a usage error (got ${noConfig.status})`,
    noConfig.status === CONTRACT.exits.usage.code);
  const c6 = makeTarget('c6');
  const absent = kick(['show', '--config', c6.config, '--id', 'kp-0123456789abcdef']);
  check(`C6 exit ${CONTRACT.exits.missing.code} is real: show for an id that does not exist (got ${absent.status})`,
    absent.status === CONTRACT.exits.missing.code);

  // And the running tool must speak the version the prose names, in both directions.
  const c6Submit = kick(['submit', '--config', c6.config, '--packet', writePacket('c6', packet('c6'))]);
  const c6List = parseJson(kick(['list', '--config', c6.config, '--json']).stdout);
  const c6Id = oneIdIn(c6Submit.stdout);
  const c6Rec = c6Id ? parseJson((() => { try { return fs.readFileSync(path.join(c6.proposals, `${c6Id}.json`), 'utf8'); } catch { return ''; } })()) : null;
  check(`C6 the stored record and list --json both declare the version the docs and help name (${CONTRACT.version})`,
    c6Rec !== null && c6Rec.version === CONTRACT.version
    && c6List !== null && c6List.version === CONTRACT.version);
  check('C6 the state the tool writes really is at the location the contract names, and nowhere in the target',
    fs.existsSync(path.join(c6.proposals, `${c6Id}.json`))
    && path.resolve(c6.state).startsWith(path.resolve(STATE_HOME))
    && !path.resolve(c6.state).startsWith(path.resolve(c6.dir)));
}

// Cleanup happens BEFORE the exit, not in a `finally` after it: `process.exit` terminates the
// process immediately and a disposal step scheduled behind it never runs.
run().catch((e) => {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
}).then(() => {
  rmrf(tmp);
  process.exit(failed);
});
