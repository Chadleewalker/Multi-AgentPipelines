// Frozen acceptance test — repo-lg3: make kickoff intake state genuinely durable. This is the
// RED half; `guard.js` beside it carries the checks that are already green at the fork point and
// must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  the authoritative contract and the CLI DEFAULT store proposal state under the durable
//       per-user `~/.multi-agent-pipelines/` root, and `PIPELINE_STATE_DIR` is the ONLY test
//       override of it. (Its "authoritative contract" half — that the prose says what the tool
//       does — is finished by C4, which is where the doc and the help screen are read.)
//   C2  this suite FAILS a lock-adjacent temp-root intake: no proposal record lives under the
//       host-global lock root, proposals stay readable after that OS-temp lock root is removed
//       outright, and they read identically from a second checkout and from an equivalent
//       spelling of the same target.
//   C3  submission stays non-blocking and atomic, launches no child at all — so no container
//       engine and no network client either — and mutates neither the target's Git tree and
//       index, nor its Beads database, nor any target-lock state.
//   C4  docs and CLI help name the same location and the same seam as the running tool and as
//       this suite. (Its "passes the mandatory regression suite" half is a pipeline-level gate,
//       for the reason recorded under SPEC DEFECTS below; what a frozen suite can honestly hold
//       is pinned in `guard.js`: the regression command is still declared and still required,
//       the frozen tree is untouched, and `runner/lock.js` still behaves exactly as it did.)
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT IS DECLARED HERE, ONCE, IN `CONTRACT` BELOW, exactly as the superseded suite for
// this feature declared its own — because C4 names THIS SUITE as one of the parties that must
// agree with the docs and the help screen, and a criterion about several sources stating one
// contract cannot be tested by a suite that keeps no copy of it. Everything the criteria
// enumerate — the durable root, the state seam, the proposals directory, the id and hash rules —
// is in that one object and nowhere else in this file.
//
// WHY THE STATE LOCATION MOVED, AND WHAT REPLACED IT. The superseded reading pinned the intake
// state BESIDE the host-global target lock authority, which `runner/lock.js` computes under
// `os.tmpdir()`. That is a cache location: an OS temp sweep, a reboot on a host that clears it,
// or an operator tidying up removes the whole tree, and with it every recorded proposal. A
// kickoff proposal is durable user intent, not run scaffolding, so the root is now the per-user
// `~/.multi-agent-pipelines/` directory — a home-relative location nothing sweeps — and the
// lock root keeps its own separate, disposable life. `PIPELINE_STATE_DIR` re-aims the durable
// root and is the only thing that does; `PIPELINE_GLOBAL_LOCK_DIR` re-aims the LOCK and must no
// longer move a single byte of intake state. That divergence is what C1 and C2 measure.
//
// HOW THE DEFAULT IS MEASURED WITHOUT TOUCHING THE OPERATOR'S REAL HOME. A frozen suite that
// wrote into the running operator's `~/.multi-agent-pipelines/` would be a test with side
// effects on live state, and one that skipped the default because of that would leave the
// criterion's central claim unmeasured. So the default is measured through the home directory
// itself: the child is given a disposable `HOME`/`USERPROFILE`, `os.homedir()` follows it (a
// fact pinned in `guard.js`), and `PIPELINE_STATE_DIR` is REMOVED from the child environment
// rather than set to something. What is observed is therefore the genuine default path, taken
// with no state seam in play at all.
//
// WHY THE LAYOUT UNDER THE ROOT IS ASSERTED STRUCTURALLY. The criteria fix the ROOT and say
// nothing about what sits beneath it, so this suite fixes the minimum that makes the behaviour
// observable and leaves the rest to the implementation: records are regular files named for
// their own id, they live in a directory named `proposals`, that directory is somewhere under
// the durable root, and it is keyed on canonical target identity — one directory per target,
// one directory for two spellings of one target. The records are found by WALKING the root, so
// nothing here depends on a digest spelling this suite would have had to invent.
//
// WHY `proposals/` HOLDS NOTHING BUT COMPLETE RECORDS. "Atomic" in C3 is only observable from
// outside if a half-written record cannot be mistaken for a visible one, so the contract is
// that the proposals directory contains exactly the records and nothing else: an implementation
// that stages a write before renaming it into place — which is how atomicity is normally bought
// — puts its staging area elsewhere under the state root.
//
// IT RUNS NO FROZEN SCRIPT AND STARTS NO CONTAINER ENGINE. The project's verifier, its
// `scripts/test-*` suites, its unit tree and its control-plane contract and loader are frozen
// paths; a frozen suite asserting through one would be asserting through a file no
// implementation may adjust. Every behaviour below is stated directly against the CLI, against
// `runner/lock.js` as a MODULE, and against the filesystem. `guard.js` checks that this holds
// line by line over the suite's own bytes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPEC DEFECTS AND READINGS, REPORTED NOT PAPERED OVER.
//
//   (a) C1 says "the authoritative contract" without naming a file. The machine-readable
//       control-plane contract is a frozen path, so no implementation may adjust it and no
//       frozen suite may demand that it change; the writable authority document is
//       `docs/control-plane.md`, which is the one this suite reads in C4. Recorded as an
//       ambiguity resolved the only way that leaves the criterion satisfiable.
//   (b) C4 says the implementation "passes the mandatory regression suite". That command is
//       declared in `pipeline.config.json` and is itself a frozen path; running it from a
//       frozen acceptance suite would assert through a file no implementation may adjust, and
//       would nest the project's whole regression layer inside one acceptance run. It stays a
//       pipeline-level gate. What `guard.js` pins instead is the substance this change could
//       plausibly break: that the regression command is still declared and still required, and
//       that `runner/lock.js` — whose own suite is in that regression layer — still computes
//       the same OS-temp root, still honours its own seam and still keeps its authority outside
//       the target.
//   (c) C2 says the suite must fail "PR #86's lock-adjacent temp-root implementation". At this
//       fork point that implementation is not in the tree — `scripts/kickoff.js` does not exist
//       on the integration branch — so no assertion can be made against the file itself. What
//       is asserted instead is the PROPERTY that implementation lacks, in both directions: no
//       record may live under the lock root, and every record must survive that root's removal.
//       An intake that stores proposals beside the lock fails both.
//   (d) The frozen suite for the superseded reading of this same feature is still in the tree
//       and still pins the proposal store beside the host-global lock. It is protected, this
//       task may not edit it, and a correct implementation of THIS issue necessarily makes it
//       red. It is not part of the mandatory regression command, so C4 remains satisfiable —
//       but the contradiction is real and needs a decision outside this suite.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONTROL_PLANE_DOC = path.join(REPO, 'docs', 'control-plane.md');

// ---- THE CONTRACT, stated once (C4's third party) -------------------------------------------
const CONTRACT = {
  // The contract version. One token, carried by the stored record, `list --json`, the CLI help
  // and the authority document, so "the same contract" is one string and not four spellings.
  version: 'kickoff-intake/1',
  // The command. Subcommands: submit, list, show. `--json` on list and show.
  cli: path.join('scripts', 'kickoff.js'),
  // THE DURABLE PER-USER ROOT. `~` is the running user's home directory; this is the directory
  // name inside it. Nothing about it is temporary, and nothing sweeps it.
  rootName: '.multi-agent-pipelines',
  // The directory that holds one record per proposal, somewhere under that root, keyed on
  // canonical target identity.
  proposalsDir: 'proposals',
  // The ONE seam that re-aims the durable root, and the two that must not.
  stateAim: 'PIPELINE_STATE_DIR',
  lockAim: 'PIPELINE_GLOBAL_LOCK_DIR',
  strangerAim: 'PIPELINE_KICKOFF_DIR',
  // The id rule and the hash rule.
  idPattern: /^kp-[0-9a-f]{16}$/,
  idToken: /\bkp-[0-9a-f]{16}\b/g,
  recordName: /^kp-[0-9a-f]{16}\.json$/,
  hashPattern: /^sha256:[0-9a-f]{64}$/,
  hashToken: /\bsha256:[0-9a-f]{64}\b/g,
  // Acceptance is exit 0. The rest of the exit vocabulary belongs to the intake contract that
  // already exists and is not what this issue moves, so it is not restated here.
  exitOk: 0,
  // The closed packet shape.
  packetFields: ['version', 'title', 'description', 'constraints', 'examples', 'nonGoals',
    'priority', 'relations', 'origin'],
  // The keys a stored record must carry. Extra keys are the implementation's business.
  recordKeys: ['version', 'id', 'target', 'hash', 'intent', 'createdAt'],
};

// A child that has to be killed to be collected is not a passing run; an intake that blocks on
// the target lock is exactly the failure C3 exists to catch, and a hung child would otherwise
// take the whole harness down as `indeterminate` instead of reporting a red check.
const CHILD_TIMEOUT_MS = 60000;
// The bound C3 states "non-blocking" with. Far above any honest intake's runtime and far below
// the lifetime of the lock the submission runs beside, so only a submission that WAITS for that
// lock can exceed it.
const NON_BLOCKING_MS = 30000;

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

// A byte-for-byte snapshot of a tree: content digest per file, link target per link, and the
// bare fact of a directory. Two snapshots taken in ONE run are compared against each other —
// never against a value typed here — so nothing later work does can move the answer.
function snapshot(root) {
  const seen = new Map();
  (function visit(abs) {
    let st;
    try { st = fs.lstatSync(abs); } catch { seen.set(path.relative(root, abs), 'absent'); return; }
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

// Every regular file under a tree, with links reported as links rather than followed: a walk
// that followed a link out of the tree would report files that are not in it.
function walkTree(root) {
  const out = [];
  (function visit(abs) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(abs, d.name);
      if (d.isSymbolicLink()) { out.push({ abs: child, kind: 'link' }); continue; }
      if (d.isDirectory()) { visit(child); continue; }
      out.push({ abs: child, kind: 'file' });
    }
  }(root));
  return out;
}

const recordFilesIn = (root) => walkTree(root)
  .filter((e) => e.kind === 'file' && CONTRACT.recordName.test(path.basename(e.abs)))
  .map((e) => e.abs).sort();
const recordDirsIn = (root) => [...new Set(recordFilesIn(root).map((p) => path.dirname(p)))].sort();

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg3-'));
// The disposable home. `os.homedir()` in a child follows `HOME` on POSIX and `USERPROFILE` on
// Windows — pinned in `guard.js` — so this is what the durable per-user root resolves against
// for every child this suite starts, and the operator's real home is never written to.
const FAKE_HOME = path.join(tmp, 'home');
const DURABLE_ROOT = path.join(FAKE_HOME, CONTRACT.rootName);
// The OS-temp lock root, re-aimed away from the operator's live locks. C2 deletes it outright.
const LOCK_HOME = path.join(tmp, 'lock-root');
const MARKER = path.join(tmp, 'forbidden-attempts.log');
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(LOCK_HOME, { recursive: true });

// Set BEFORE `runner/lock.js` is asked anything: the lock root is read at call time, and this is
// what keeps this suite off the operator's real host state.
process.env[CONTRACT.lockAim] = LOCK_HOME;

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

// One target per section: distinct targets have distinct canonical keys and therefore distinct
// state, so no section can be read through another's leftovers.
function makeTarget(name) {
  const dir = path.join(tmp, `target-${name}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), `// ${name}\n`);
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    '{"verifyCommand":"sh tools/proof-verify.sh","defaultBranch":"main","frozenPaths":[]}\n');
  // A Beads database and its export, so C3 has the named artifact to compare rather than a
  // stand-in for it.
  fs.writeFileSync(path.join(dir, '.beads', 'proof.db'),
    Buffer.from(`beads-fixture-${name}-${'0123456789abcdef'.repeat(8)}`, 'utf8'));
  fs.writeFileSync(path.join(dir, '.beads', 'proof.jsonl'),
    '{"id":"repo-000","title":"fixture","status":"open"}\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'remote', 'add', 'origin', dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  const config = path.join(tmp, `run.config.${name}.json`);
  fs.writeFileSync(config, `${JSON.stringify(configFor(dir), null, 2)}\n`);
  return { name, dir, config };
}

// ---- the packet -----------------------------------------------------------------------------

function packet(tag) {
  return {
    version: CONTRACT.version,
    title: `durable intake proof ${tag}`,
    description: `A kickoff proposal that must outlive the OS temp area, ${tag}.`,
    constraints: ['stored under the durable per-user root', 'starts no child process'],
    examples: [`node ${CONTRACT.cli.split(path.sep).join('/')} submit --config run.config.json --packet ${tag}.json`],
    nonGoals: ['storing intent beside a disposable lock', 'writing to Beads'],
    priority: 2,
    relations: [{ kind: 'related', id: 'repo-lg3' }],
    origin: { kind: 'planning-session', ref: `repo-lg3/${tag}` },
  };
}

function writePacket(tag, obj) {
  const file = path.join(tmp, `packet-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

// ---- running the CLI ------------------------------------------------------------------------

// `undefined` in `extra` REMOVES a variable rather than setting it to the string "undefined" —
// which is how the genuine default, with no state seam in play at all, is measured.
function childEnv(extra) {
  const env = { ...process.env };
  delete env[CONTRACT.stateAim];
  delete env[CONTRACT.strangerAim];
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// The two environments every section runs in. DEFAULT_MODE names no state seam: what it
// observes is the CLI's own default. SEAM_MODE re-aims the durable root through the one seam
// the contract allows.
const HOME_AIM = { HOME: FAKE_HOME, USERPROFILE: FAKE_HOME };
const DEFAULT_MODE = { ...HOME_AIM, [CONTRACT.lockAim]: LOCK_HOME, [CONTRACT.stateAim]: undefined };
const seamMode = (dir) => ({ ...HOME_AIM, [CONTRACT.lockAim]: LOCK_HOME, [CONTRACT.stateAim]: dir });

function cliPath(root) {
  return path.join(root || REPO, CONTRACT.cli);
}

function kick(args, opts = {}) {
  const nodeArgs = [...(opts.nodeArgs || []), cliPath(opts.root), ...args];
  const started = Date.now();
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd: opts.cwd || REPO,
    encoding: 'utf8',
    input: opts.input,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: childEnv(opts.env || DEFAULT_MODE),
  });
  return {
    status: r.status === null ? null : r.status,
    signal: r.signal || null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    elapsedMs: Date.now() - started,
  };
}

function kickAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const nodeArgs = [...(opts.nodeArgs || []), cliPath(opts.root), ...args];
    let child;
    try {
      child = spawn(process.execPath, nodeArgs, {
        cwd: opts.cwd || REPO, windowsHide: true, env: childEnv(opts.env || DEFAULT_MODE),
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
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const idsOf = (text) => {
  const body = parseJson(text);
  return body && Array.isArray(body.proposals) ? body.proposals.map((p) => p.id) : [];
};

// A record is valid when it is a regular file named for the id it carries, its declared hash
// follows the contract's hash rule, and re-hashing its own immutable intent bytes reproduces it.
function recordProblem(abs) {
  const name = path.basename(abs);
  if (!CONTRACT.recordName.test(name)) return `${name}: not a record file name`;
  let st;
  try { st = fs.lstatSync(abs); } catch { return `${name}: unreadable`; }
  if (!st.isFile()) return `${name}: not a regular file`;
  const rec = parseJson(readText(abs));
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

// Everything wrong with the records under a root, plus everything that is in a proposals
// directory WITHOUT being a record — a staging file left in the visible directory is exactly
// the half-written state C3 forbids.
function storeProblems(root) {
  const files = recordFilesIn(root);
  const out = files.map((f) => recordProblem(f)).filter(Boolean);
  for (const dir of recordDirsIn(root)) {
    if (path.basename(dir) !== CONTRACT.proposalsDir) {
      out.push(`records live in \`${path.basename(dir)}\`, not \`${CONTRACT.proposalsDir}\``);
    }
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const strangers = names.filter((n) => !CONTRACT.recordName.test(n));
    if (strangers.length) out.push(`${path.basename(dir)}/ holds non-records: ${strangers.slice(0, 3).join(', ')}`);
  }
  return out;
}

const isUnder = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ---- the run --------------------------------------------------------------------------------

async function run() {
  // `runner/lock.js` is loaded as a MODULE: C1 and C2 speak about canonical target identity and
  // about the lock root, and both must come from the project's own rule rather than from a
  // second copy of it typed here. A tree without it cannot be judged, and that is said out loud.
  let LOCK = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    LOCK = require(path.join(REPO, 'runner', 'lock.js'));
  } catch (e) {
    check(`C1 runner/lock.js loads, so canonical target identity and the lock root can be computed (${e && e.message})`, false);
    return;
  }

  // One preloaded shim that makes child-process creation AND network access impossible and
  // audible. Preloaded with `--require` so it patches the builtins BEFORE the CLI captures any
  // reference from them. What it cannot see is a raw libuv call or a native addon; nothing in
  // this project does that, and the limit is recorded rather than hidden. Because it refuses
  // every child, it also refuses any container engine client and any command-line network tool
  // the intake might otherwise reach for: those are children too.
  const shim = path.join(tmp, 'no-children-no-network.js');
  fs.writeFileSync(shim, [
    "'use strict';",
    "const io = require('fs');",
    'const marker = process.env.KICKOFF_PROOF_MARKER;',
    'const refuse = (kind, name) => {',
    "  try { io.appendFileSync(marker, kind + ':' + name + '\\n'); } catch (e) { /* the throw is the signal */ }",
    "  throw new Error('kickoff-proof: ' + kind + ' is disabled for this run: ' + name);",
    '};',
    'const patch = (mod, kind, names) => {',
    '  for (const name of names) {',
    "    if (!mod || typeof mod[name] !== 'function') continue;",
    '    mod[name] = function refused() { return refuse(kind, name); };',
    '  }',
    '};',
    "patch(require('child_process'), 'child-process',",
    "  ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);",
    "const net = require('net');",
    "patch(net, 'network', ['connect', 'createConnection']);",
    "if (net.Socket && net.Socket.prototype) patch(net.Socket.prototype, 'network', ['connect']);",
    "patch(require('dns'), 'network', ['lookup', 'resolve', 'resolve4', 'resolve6']);",
    "patch(require('http'), 'network', ['request', 'get']);",
    "patch(require('https'), 'network', ['request', 'get']);",
    "patch(require('tls'), 'network', ['connect']);",
    "if (typeof globalThis.fetch === 'function') globalThis.fetch = () => refuse('network', 'fetch');",
    '',
  ].join('\n'));
  const shimArgs = ['--require', shim.split(path.sep).join('/')];
  const shimEnv = { KICKOFF_PROOF_MARKER: MARKER };

  // =========================================================================================
  // C1 — the durable per-user root is the DEFAULT, and PIPELINE_STATE_DIR is the only override
  // =========================================================================================
  const c1 = makeTarget('c1');

  // (a) the genuine default: a disposable home, no state seam in the environment at all.
  const first = kick(['submit', '--config', c1.config, '--packet', writePacket('c1-a', packet('c1-a'))]);
  const id1 = oneIdIn(first.stdout);
  const hash1 = oneHashIn(first.stdout);
  check(`C1 submit exits ${CONTRACT.exitOk} with no state seam in the environment — the default path is a working path (got ${first.status}${first.stderr ? `; ${first.stderr.trim().split('\n')[0]}` : ''})`,
    first.status === CONTRACT.exitOk);
  check('C1 that submit prints one proposal id, and only one, following the id rule', id1 !== null);
  check('C1 that submit prints one content hash, and only one, following the hash rule', hash1 !== null);

  const defaultRecords = recordFilesIn(DURABLE_ROOT);
  check(`C1 the default store is the durable per-user root — \`~/${CONTRACT.rootName}\` holds the record the submission printed (${defaultRecords.length} record(s) under it)`,
    id1 !== null && defaultRecords.some((f) => path.basename(f) === `${id1}.json`));
  const defaultDirs = recordDirsIn(DURABLE_ROOT);
  check(`C1 the records under that root sit in exactly one \`${CONTRACT.proposalsDir}\` directory for one target (${defaultDirs.map((d) => path.basename(d)).join(', ') || 'none'})`,
    defaultDirs.length === 1 && path.basename(defaultDirs[0]) === CONTRACT.proposalsDir);
  const defaultProblems = storeProblems(DURABLE_ROOT);
  check(`C1 the record stored under the durable root is complete and its hash matches its own intent bytes${defaultProblems.length ? ` (${defaultProblems.slice(0, 3).join('; ')})` : ''}`,
    defaultRecords.length > 0 && defaultProblems.length === 0);
  const rec1 = id1 && defaultRecords.length ? parseJson(readText(path.join(defaultDirs[0] || '', `${id1}.json`))) : null;
  check('C1 that record names the canonical target rather than the spelling the config used',
    rec1 !== null && rec1.target === LOCK.canonicalTarget(c1.dir));
  const intent1 = rec1 ? parseJson(rec1.intent) : null;
  const missingFields = intent1 ? CONTRACT.packetFields.filter((f) => !(f in intent1)) : CONTRACT.packetFields;
  check(`C1 the immutable intent bytes round-trip every closed packet field${missingFields.length ? ` (missing: ${missingFields.join(', ')})` : ''}`,
    missingFields.length === 0);
  check('C1 nothing of the proposal was written inside the target repository',
    id1 !== null && recordFilesIn(c1.dir).length === 0);

  // (b) the seam that MAY move it.
  const aimed = path.join(tmp, 'aimed-state');
  const c1b = makeTarget('c1b');
  const seamed = kick(['submit', '--config', c1b.config, '--packet', writePacket('c1-b', packet('c1-b'))],
    { env: seamMode(aimed) });
  const id1b = oneIdIn(seamed.stdout);
  check(`C1 ${CONTRACT.stateAim} re-aims the durable root: the submission lands under it (got ${seamed.status})`,
    seamed.status === CONTRACT.exitOk && id1b !== null
    && recordFilesIn(aimed).some((f) => path.basename(f) === `${id1b}.json`));
  check(`C1 with ${CONTRACT.stateAim} aimed elsewhere nothing was written under the per-user root`,
    id1b !== null && !recordFilesIn(DURABLE_ROOT).some((f) => path.basename(f) === `${id1b}.json`));
  const seamedProblems = storeProblems(aimed);
  check(`C1 the re-aimed store has the same shape as the default one${seamedProblems.length ? ` (${seamedProblems.slice(0, 3).join('; ')})` : ''}`,
    recordFilesIn(aimed).length > 0 && seamedProblems.length === 0);

  // (c) the seams that MAY NOT. The lock seam is aimed somewhere new and the stranger seam is
  // set outright; neither may move a byte of intake state off the per-user root.
  const decoyLock = path.join(tmp, 'decoy-lock-root');
  const decoyStranger = path.join(tmp, 'decoy-stranger-root');
  fs.mkdirSync(decoyLock, { recursive: true });
  fs.mkdirSync(decoyStranger, { recursive: true });
  const c1c = makeTarget('c1c');
  const decoyed = kick(['submit', '--config', c1c.config, '--packet', writePacket('c1-c', packet('c1-c'))], {
    env: {
      ...HOME_AIM,
      [CONTRACT.lockAim]: decoyLock,
      [CONTRACT.strangerAim]: decoyStranger,
      [CONTRACT.stateAim]: undefined,
    },
  });
  const id1c = oneIdIn(decoyed.stdout);
  check(`C1 with ${CONTRACT.lockAim} and ${CONTRACT.strangerAim} both aimed at decoys, the submission still lands under the per-user root (got ${decoyed.status})`,
    decoyed.status === CONTRACT.exitOk && id1c !== null
    && recordFilesIn(DURABLE_ROOT).some((f) => path.basename(f) === `${id1c}.json`));
  check(`C1 ${CONTRACT.lockAim} moved no intake state — the decoy lock root holds no proposal record`,
    id1c !== null && recordFilesIn(decoyLock).length === 0);
  check(`C1 ${CONTRACT.strangerAim} moved no intake state — ${CONTRACT.stateAim} is the only override`,
    id1c !== null && recordFilesIn(decoyStranger).length === 0);

  // (d) one root, one directory per target, keyed on canonical identity rather than on order of
  // arrival: two targets sharing the durable root must not see each other's proposals.
  const c1Ids = idsOf(kick(['list', '--config', c1.config, '--json']).stdout);
  const c1cIds = idsOf(kick(['list', '--config', c1c.config, '--json']).stdout);
  check('C1 two targets sharing one durable root keep separate proposals directories',
    recordDirsIn(DURABLE_ROOT).length === 2);
  check('C1 neither target can see the other\'s proposals through list',
    id1 !== null && id1c !== null
    && c1Ids.includes(id1) && !c1Ids.includes(id1c)
    && c1cIds.includes(id1c) && !c1cIds.includes(id1));

  // =========================================================================================
  // C2 — nothing under the lock root, and readable after that root is removed, from a second
  //      checkout and from an equivalent spelling of the same target
  // =========================================================================================
  const c2 = makeTarget('c2');
  const c2Ids = [];
  for (const tag of ['c2-a', 'c2-b', 'c2-c']) {
    const r = kick(['submit', '--config', c2.config, '--packet', writePacket(tag, packet(tag))]);
    const got = oneIdIn(r.stdout);
    if (got) c2Ids.push(got);
  }
  check(`C2 three proposals were submitted for the durability claim to be measured over (got ${c2Ids.length})`,
    c2Ids.length === 3);

  // The lock root exists and is aimed here, so "no record under it" is a statement about a real
  // directory the intake could have written into rather than about an absent one.
  check(`C2 the OS-temp lock root this run uses really exists, so what follows is about a real directory (${LOCK_HOME})`,
    fs.existsSync(LOCK_HOME));
  const strayUnderLock = recordFilesIn(LOCK_HOME);
  check(`C2 no proposal record lives under the host-global lock root — intake state is not lock-adjacent${strayUnderLock.length ? ` (${strayUnderLock.slice(0, 3).map((f) => path.relative(LOCK_HOME, f)).join(', ')})` : ''}`,
    c2Ids.length === 3 && strayUnderLock.length === 0);
  check('C2 nor is the durable root itself hidden inside the lock root',
    c2Ids.length === 3 && !isUnder(DURABLE_ROOT, LOCK_HOME));

  const beforeRemoval = kick(['list', '--config', c2.config, '--json']);
  const beforeHuman = kick(['list', '--config', c2.config]);
  const showId = c2Ids[0] || 'kp-0000000000000000';
  const beforeShow = kick(['show', '--config', c2.config, '--id', showId, '--json']);
  check(`C2 list and show are green before the removal, so the comparison after it has something to compare (got ${beforeRemoval.status}, ${beforeHuman.status}, ${beforeShow.status})`,
    beforeRemoval.status === CONTRACT.exitOk && beforeHuman.status === CONTRACT.exitOk
    && beforeShow.status === CONTRACT.exitOk && idsOf(beforeRemoval.stdout).length === 3);

  // THE REMOVAL. The whole OS-temp lock root goes, exactly as a temp sweep or a reboot would
  // take it. An intake that kept its proposals beside the lock loses every one of them here.
  rmrf(LOCK_HOME);
  check(`C2 the OS-temp lock root was really removed, so the durability claim is being tested rather than assumed (${LOCK_HOME})`,
    !fs.existsSync(LOCK_HOME));
  const survivors = recordFilesIn(DURABLE_ROOT).filter((f) => c2Ids.includes(path.basename(f).slice(0, -5)));
  check(`C2 all three records survive the removal on disk (${survivors.length} of ${c2Ids.length})`,
    c2Ids.length === 3 && survivors.length === 3);
  const afterRemoval = kick(['list', '--config', c2.config, '--json']);
  const afterHuman = kick(['list', '--config', c2.config]);
  const afterShow = kick(['show', '--config', c2.config, '--id', showId, '--json']);
  check(`C2 list --json is byte-identical after the lock root's removal (got ${afterRemoval.status})`,
    beforeRemoval.status === CONTRACT.exitOk && afterRemoval.status === CONTRACT.exitOk
    && afterRemoval.stdout === beforeRemoval.stdout);
  check(`C2 list human output is byte-identical after the lock root's removal (got ${afterHuman.status})`,
    beforeHuman.status === CONTRACT.exitOk && afterHuman.status === CONTRACT.exitOk
    && afterHuman.stdout === beforeHuman.stdout);
  check(`C2 show is byte-identical after the lock root's removal — a named proposal is still readable (got ${afterShow.status})`,
    beforeShow.status === CONTRACT.exitOk && afterShow.status === CONTRACT.exitOk
    && afterShow.stdout === beforeShow.stdout);
  // Gated on the records having survived, for the reason every "nothing is there" check in this
  // suite is gated: an intake that stored nothing satisfies it without being asked to.
  check('C2 the removal did not quietly re-create the proposals inside the lock root either',
    survivors.length === 3 && recordFilesIn(LOCK_HOME).length === 0);

  // A second checkout of the pipeline, and an equivalent spelling of the same target, both read
  // AFTER the removal: durability and identity are one claim, not two.
  const secondCheckout = path.join(tmp, 'second-checkout');
  copyTree(REPO, secondCheckout, true);
  check(`C2 a second checkout of the pipeline carries the CLI at ${CONTRACT.cli.split(path.sep).join('/')}`,
    fs.existsSync(cliPath(secondCheckout)));

  const altDir = path.join(tmp, 'alt-config-home');
  fs.mkdirSync(altDir, { recursive: true });
  const altSpelling = process.platform === 'win32'
    ? `${path.join(c2.dir, 'src', '..').split(path.sep).join('/')}/`
    : `${path.join(c2.dir, 'src', '..')}/./`;
  const altConfig = path.join(altDir, 'run.config.alt.json');
  fs.writeFileSync(altConfig, `${JSON.stringify(configFor(altSpelling), null, 2)}\n`);
  // The precondition rides ON the two alt-spelling checks rather than standing as one of its
  // own: it is a fact about `runner/lock.js` pinned in `guard.js` and green at the fork point,
  // so as a separate check here it would prove nothing while hiding a fixture that had stopped
  // spelling an equivalent path.
  const altEquivalent = LOCK.canonicalTarget(altSpelling) === LOCK.canonicalTarget(c2.dir);

  const views = [
    ['a different working directory', { config: c2.config, opts: { cwd: tmp }, pre: true }],
    ['a second checkout', { config: c2.config, opts: { root: secondCheckout, cwd: secondCheckout }, pre: fs.existsSync(cliPath(secondCheckout)) }],
    ['an equivalent target spelling', { config: altConfig, opts: {}, pre: altEquivalent }],
  ];
  for (const [label, view] of views) {
    const human = kick(['list', '--config', view.config], view.opts);
    const json = kick(['list', '--config', view.config, '--json'], view.opts);
    const shown = kick(['show', '--config', view.config, '--id', showId, '--json'], view.opts);
    check(`C2 list human output is byte-identical from ${label}, after the lock root was removed`,
      view.pre && human.status === CONTRACT.exitOk && human.stdout === beforeHuman.stdout);
    check(`C2 list --json output is byte-identical from ${label}, after the lock root was removed`,
      view.pre && json.status === CONTRACT.exitOk && json.stdout === beforeRemoval.stdout);
    check(`C2 show output is byte-identical from ${label}, after the lock root was removed`,
      view.pre && shown.status === CONTRACT.exitOk && shown.stdout === beforeShow.stdout);
  }

  // The lock root is put back for the sections that follow: C3 takes a real target lock in it.
  fs.mkdirSync(LOCK_HOME, { recursive: true });

  // =========================================================================================
  // C3 — non-blocking, atomic, no child at all, and nothing mutated
  // =========================================================================================
  const c3 = makeTarget('c3');
  const lockObserverRoot = path.join(tmp, 'lock-observer-checkout');
  fs.mkdirSync(lockObserverRoot, { recursive: true });
  const held = LOCK.acquire(lockObserverRoot, c3.dir, 'repo-lg3-proof-run');
  const lockHeld = !!(held && held.ok);

  const lockRootBefore = snapshot(LOCK_HOME);
  const targetBefore = snapshot(c3.dir);
  const beadsBefore = snapshot(path.join(c3.dir, '.beads'));
  try { fs.rmSync(MARKER, { force: true }); } catch { /* first run */ }

  const underLock = kick(['submit', '--config', c3.config, '--packet', writePacket('c3', packet('c3'))],
    { nodeArgs: shimArgs, env: { ...DEFAULT_MODE, ...shimEnv } });
  const attempts = readText(MARKER);
  const childAttempts = attempts.split(/\r?\n/).filter((l) => l.startsWith('child-process:'));
  const netAttempts = attempts.split(/\r?\n/).filter((l) => l.startsWith('network:'));

  // `accepted` gates every "unchanged" check below, and that gating is the point. "The target is
  // byte-for-byte unchanged" is trivially true of an intake that does not exist, so on its own it
  // is a check no implementation is needed to satisfy. What C3 actually claims is that a submit
  // WHICH SUCCEEDED changed nothing — so the success is part of every one of them.
  const c3Id = oneIdIn(underLock.stdout);
  const accepted = lockHeld && underLock.status === CONTRACT.exitOk && c3Id !== null;
  check(`C3 submit exits ${CONTRACT.exitOk}, unkilled, while the ordinary target lock is held by another owner (got ${underLock.status}${underLock.stderr ? `; ${underLock.stderr.trim().split('\n')[0]}` : ''})`,
    lockHeld && underLock.status === CONTRACT.exitOk && underLock.signal === null);
  check(`C3 that submit did not WAIT for the lock — it returned in ${underLock.elapsedMs}ms, inside the non-blocking bound of ${NON_BLOCKING_MS}ms`,
    accepted && underLock.elapsedMs < NON_BLOCKING_MS);
  check(`C3 that submit created no child process at all — so no container engine client either${childAttempts.length ? ` (attempted: ${childAttempts.slice(0, 3).join(', ')})` : ''}`,
    accepted && childAttempts.length === 0);
  check(`C3 that submit opened no network connection and resolved no name${netAttempts.length ? ` (attempted: ${netAttempts.slice(0, 3).join(', ')})` : ''}`,
    accepted && netAttempts.length === 0);
  check('C3 the proposal written under the held lock is present and hash-valid',
    accepted && storeProblems(DURABLE_ROOT).length === 0
    && recordFilesIn(DURABLE_ROOT).some((f) => path.basename(f) === `${c3Id}.json`));

  const targetDiff = snapshotDifference(targetBefore, snapshot(c3.dir));
  const gitDiff = targetDiff.filter((d) => /\s\.git(\/|$)/.test(d));
  const beadsDiff = snapshotDifference(beadsBefore, snapshot(path.join(c3.dir, '.beads')));
  const lockRootDiff = snapshotDifference(lockRootBefore, snapshot(LOCK_HOME));
  check(`C3 the accepted submit left the target repository byte-for-byte unchanged${targetDiff.length ? ` (${targetDiff.slice(0, 5).join(', ')})` : ''}`,
    accepted && targetDiff.length === 0);
  check(`C3 the accepted submit left the target's Git directory, its index included, byte-for-byte unchanged${gitDiff.length ? ` (${gitDiff.slice(0, 5).join(', ')})` : ''}`,
    accepted && gitDiff.length === 0);
  check(`C3 the accepted submit left the target's Beads database and its export byte-for-byte unchanged${beadsDiff.length ? ` (${beadsDiff.join(', ')})` : ''}`,
    accepted && beadsDiff.length === 0);
  check(`C3 the accepted submit left ALL target-lock state byte-for-byte unchanged — it neither took the lock, nor waited for it, nor wrote beside it${lockRootDiff.length ? ` (${lockRootDiff.slice(0, 5).join(', ')})` : ''}`,
    accepted && lockRootDiff.length === 0);
  try { LOCK.release(lockObserverRoot, c3.dir, held && held.ownership); } catch { /* disposable */ }

  // Atomicity. Killed at a spread of delays across process startup and work, so some
  // submissions complete and some do not; what is asserted is that nothing in between is ever
  // visible. An ANCHOR submission that is never interrupted keeps "nothing is visible" from
  // satisfying the checks below; how many of the killed submissions get far enough to complete
  // is a fact about machine load, and a check that depended on it would be flaky in the
  // direction that reads as a broken suite.
  const c3i = makeTarget('c3i');
  const anchor = oneIdIn(kick(['submit', '--config', c3i.config, '--packet', writePacket('c3i-anchor', packet('c3i-anchor'))]).stdout);
  const killed = await Promise.all([0, 30, 60, 100, 150, 200, 300, 400].map((ms, i) => {
    const tag = `c3i-${i}`;
    return kickAsync(['submit', '--config', c3i.config, '--packet', writePacket(tag, packet(tag))],
      { killAfterMs: ms });
  }));
  const completed = killed.filter((r) => r.status === CONTRACT.exitOk).map((r) => oneIdIn(r.stdout)).filter(Boolean);
  const afterKills = kick(['list', '--config', c3i.config, '--json']);
  const visible = idsOf(afterKills.stdout);
  // The interrupted target's own proposals directory, found through the anchor's record rather
  // than through a path this suite would have had to invent — so what is counted is exactly what
  // this section wrote and nothing another section left under the same root.
  const anchorFile = anchor ? recordFilesIn(DURABLE_ROOT).find((f) => path.basename(f) === `${anchor}.json`) : null;
  const killDir = anchorFile ? path.dirname(anchorFile) : null;
  const storedAfterKills = killDir
    ? (() => { try { return fs.readdirSync(killDir).filter((n) => CONTRACT.recordName.test(n)).map((n) => n.slice(0, -5)); } catch { return []; } })()
    : [];
  check(`C3 list --json still exits ${CONTRACT.exitOk} after eight interrupted submissions (got ${afterKills.status}${afterKills.stderr ? `; ${afterKills.stderr.trim().split('\n')[0]}` : ''})`,
    afterKills.status === CONTRACT.exitOk);
  const killProblems = storeProblems(DURABLE_ROOT);
  check(`C3 interruption left no partial, unnamed or half-written entry anywhere in the store${killProblems.length ? ` (${killProblems.slice(0, 3).join('; ')})` : ''}`,
    // `killDir`, not just the anchor's id: an empty durable root has no half-written entry in it
    // either, and that is not what this check is asking.
    anchor !== null && killDir !== null && killProblems.length === 0);
  check(`C3 every proposal visible after interruption is a complete record, and every stored one is visible (${visible.length} visible of ${storedAfterKills.length} stored)`,
    afterKills.status === CONTRACT.exitOk && anchor !== null && visible.includes(anchor)
    && killDir !== null
    && [...visible].sort().join(',') === [...new Set(storedAfterKills)].sort().join(','));
  check(`C3 every interrupted submission that exited ${CONTRACT.exitOk} is visible, and only complete proposals are — a complete proposal or none (${completed.length} of eight completed)`,
    // `>=`, not `===`: a submission killed AFTER its atomic write but before it could exit is
    // visible and non-zero, and that is a legal outcome of an interruption. What is forbidden is
    // a completed submission that is missing, or anything visible that is not one of the nine.
    afterKills.status === CONTRACT.exitOk && anchor !== null && visible.includes(anchor)
    && killDir !== null && completed.every((id) => visible.includes(id))
    && visible.length >= completed.length + 1 && visible.length <= killed.length + 1);

  // =========================================================================================
  // C4 — the docs, the help screen, the running tool and this suite name one location and one
  //      seam
  // =========================================================================================
  const help = kick(['--help']);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const doc = readText(CONTROL_PLANE_DOC);
  check(`C4 CLI help exits ${CONTRACT.exitOk} (got ${help.status})`, help.status === CONTRACT.exitOk);

  // Substance tokens, asked of both prose sources against the one declaration at the top of this
  // file — not a sentence to copy. The failure message names exactly what was missing on which
  // side.
  const tokens = [
    ['the durable per-user root', `~/${CONTRACT.rootName}`],
    ['the state seam', CONTRACT.stateAim],
    ['the proposals directory', CONTRACT.proposalsDir],
    ['the contract version', CONTRACT.version],
    ['the CLI path', CONTRACT.cli.split(path.sep).join('/')],
  ];
  const missingDoc = tokens.filter(([, t]) => !doc.includes(t)).map(([label]) => label);
  const missingHelp = tokens.filter(([, t]) => !helpText.includes(t)).map(([label]) => label);
  check(`C4 docs/control-plane.md names the location and the seam this suite declares${missingDoc.length ? ` (missing: ${missingDoc.join('; ')})` : ''}`,
    missingDoc.length === 0);
  check(`C4 CLI help names the same location and the same seam${missingHelp.length ? ` (missing: ${missingHelp.join('; ')})` : ''}`,
    missingHelp.length === 0);

  // Naming the location is not enough: the prose and the tool have to be talking about the same
  // directory. A submission made with the environment the docs describe must land where the docs
  // say it lands, and the version the prose names must be the version the record carries.
  const c4 = makeTarget('c4');
  const c4Submit = kick(['submit', '--config', c4.config, '--packet', writePacket('c4', packet('c4'))]);
  const c4Id = oneIdIn(c4Submit.stdout);
  const c4Record = c4Id ? recordFilesIn(DURABLE_ROOT).find((f) => path.basename(f) === `${c4Id}.json`) : null;
  const c4List = parseJson(kick(['list', '--config', c4.config, '--json']).stdout);
  check('C4 the location the docs and help name is the location the running tool really uses',
    c4Record != null && isUnder(c4Record, DURABLE_ROOT)
    && path.basename(path.dirname(c4Record)) === CONTRACT.proposalsDir);
  check(`C4 the stored record and list --json both declare the version the docs and help name (${CONTRACT.version})`,
    c4Record != null && (parseJson(readText(c4Record)) || {}).version === CONTRACT.version
    && c4List !== null && c4List.version === CONTRACT.version);
  check('C4 the docs describe a seam that really works: the same submission, with the seam aimed, lands where the seam points and nowhere else',
    (() => {
      const aim = path.join(tmp, 'c4-aimed-state');
      const r = kick(['submit', '--config', c4.config, '--packet', writePacket('c4-seam', packet('c4-seam'))],
        { env: seamMode(aim) });
      const id = oneIdIn(r.stdout);
      return r.status === CONTRACT.exitOk && id !== null
        && recordFilesIn(aim).some((f) => path.basename(f) === `${id}.json`)
        && !recordFilesIn(DURABLE_ROOT).some((f) => path.basename(f) === `${id}.json`);
    })());
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
