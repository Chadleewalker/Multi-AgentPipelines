// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for sweep hygiene — what `scripts/test-all.sh` reclaims after a suite, and
// what it must never touch. DESIGN.md §4.12; change-log row `repo-zje`.
//
// Re-runnable: the sweep picks it up through scripts/test-sweep-hygiene.sh. Its coverage
// is the half of tests/acceptance/repo-zje/ that has to outlive that task — a frozen
// acceptance directory is an artifact of a finished run and is never executed again, and
// the failure this prevents is both silent and destructive: a sweep that force-removes a
// container it did not create takes an unrelated long-lived container on the developer's
// machine with it, and says nothing.
//
// Plain Node, no test framework, no Docker, no network: run it as
// `node tests/unit/sweep-hygiene.test.js` from the repo root. One line per check —
// `ok - <label>` / `FAIL - <label>` — and a non-zero exit if any check failed, matching
// tests/acceptance/README.md.
//
// HOW THE REAL SWEEP IS DRIVEN WITH NO DAEMON. `scripts/test-all.sh` routes every docker
// call through `${SWEEP_DOCKER:-docker}`, so a stand-in answers all of them, prechecks
// included. The stand-in is `process.execPath` with the recorder preloaded through
// NODE_OPTIONS — never a `#!/bin/sh` file, because `sweep-reclaim.js` reaches the seam
// through `spawnSync` WITHOUT a shell and the Windows host fails such a file with EFTYPE
// (memory `repo-dhp-note-1`). The recorder no-ops when node is invoked normally, so the
// reclaimer itself still runs.
//
// WHY THE STAND-IN IS STATEFUL, and why that matters more than it looks. Ownership here is
// a before/after diff: if the recorder answered every listing identically, the leftover
// would appear in the BEFORE listing too and a correct implementation would — rightly —
// reclaim nothing, so the fixture could not tell a working reclaimer from a broken one.
// The stub suite therefore "creates" its container the way a real suite does: it drops a
// marker, and the recorder reports the container only once the marker exists. That also
// buys the case the frozen suite cannot express — the same debris present BEFORE the suite
// runs must survive it — which is the whole point of the diff.
//
// AND WHY THE STAND-IN IS SAFE, where a PATH stub for `pipeline-net.sh` was rejected:
// `pipeline-net.sh down` removes the network and the proxy BY NAME and unconditionally, so
// a stub that failed to intercept would delete the real ones. A missed seam here yields an
// empty diff and removes nothing.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RECLAIM = path.join(ROOT, 'scripts', 'sweep-reclaim.js');
const TEST_ALL = path.join(ROOT, 'scripts', 'test-all.sh');
const reclaimer = require(RECLAIM);

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const fwd = (p) => p.split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-sweep-'));

// ---- the pure decision ---------------------------------------------------------------
// No docker, no environment: given what was there before a suite and what is there after,
// which resources did the sweep create?

const PRE = [
  { id: 'aaa1', name: 'code-server-unrelated', image: 'linuxserver/code-server' },
  { id: 'aaa2', name: 'pipeline-proxy', image: 'pipeline-proxy:local' },
  { id: 'aaa3', name: 'task-from-a-concurrent-run', image: 'pipeline-base:local' },
];
const before = { containers: PRE.slice(), networks: ['bridge', 'pipeline-net'] };
const after = {
  containers: PRE.concat([
    { id: 'bbb1', name: 'task-repo-xyz-1', image: 'pipeline-base:local' },
    { id: 'bbb2', name: 'someone-elses', image: 'postgres:16' },
    { id: 'bbb3', name: 'my-task-runner', image: 'node:22' },
    { id: 'bbb4', name: 'a-shorter-name', image: 'pipeline-proxy:local' },
  ]),
  networks: ['bridge', 'pipeline-net', 'multiagentpipelines-net'],
};
const picked = reclaimer.reclaimTargets(before, after);
const ids = picked.filter((t) => t.kind === 'container').map((t) => t.id);
const nets = picked.filter((t) => t.kind === 'network').map((t) => t.name);

check('a container that appeared from a pipeline image is reclaimed', ids.indexOf('bbb1') !== -1);
check('a container that appeared from a pipeline image is reclaimed by ancestry alone',
  ids.indexOf('bbb4') !== -1);
check('a pre-existing unrelated container is never reclaimed', ids.indexOf('aaa1') === -1);
check('a pre-existing pipeline-proxy is never reclaimed — the diff decides, not the image',
  ids.indexOf('aaa2') === -1);
check('a pre-existing task- container is never reclaimed either (a concurrent run owns it)',
  ids.indexOf('aaa3') === -1);
check('a container that appeared from an unrelated image is not ours', ids.indexOf('bbb2') === -1);
check('"my-task-runner" is not ours: the task- rule is anchored, not a substring match',
  ids.indexOf('bbb3') === -1);
check('a network outside the allowlist is not reclaimed even though it appeared',
  nets.indexOf('multiagentpipelines-net') === -1);
check('a pre-existing pipeline-net is not reclaimed', nets.indexOf('pipeline-net') === -1);

const netPicked = reclaimer.reclaimTargets(
  { containers: [], networks: ['bridge'] },
  { containers: [{ id: 'ddd1', name: 'pipeline-proxy', image: 'squid:latest' }],
    networks: ['bridge', 'pipeline-net'] });
check('pipeline-net is reclaimed when the suite brought it up',
  netPicked.some((t) => t.kind === 'network' && t.name === 'pipeline-net'));
check('the proxy is reclaimed by its exact name even under an unexpected image',
  netPicked.some((t) => t.kind === 'container' && t.id === 'ddd1'));
check('containers are ordered before networks — a network still holding one cannot be removed',
  netPicked.findIndex((t) => t.kind === 'container') < netPicked.findIndex((t) => t.kind === 'network'));

check('an identities-only before-listing (docker ps -aq) is accepted in either shape',
  reclaimer.reclaimTargets({ containers: ['bbb1'], networks: [] },
    { containers: [{ id: 'bbb1', name: 'task-x', image: 'pipeline-base:local' }], networks: [] })
    .length === 0);

let threw = false;
try {
  reclaimer.reclaimTargets(null, { containers: [null, {}, 'junk'], networks: [null, 7, ''] });
  reclaimer.reclaimTargets(undefined, undefined);
} catch (e) { threw = true; }
check('malformed listings are survivable — a reclaimer that throws parks a sweep', !threw);

// ---- the fake root: the real test-all.sh, one stub suite, a recording stand-in ---------

let rootSeq = 0;
function makeRoot(opts) {
  const root = path.join(tmp, `root-${++rootSeq}`);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.copyFileSync(TEST_ALL, path.join(root, 'scripts', 'test-all.sh'));
  fs.copyFileSync(RECLAIM, path.join(root, 'scripts', 'sweep-reclaim.js'));

  // The stub suite creates its container the way a real suite does — by leaving a mark the
  // stand-in then reports. `--suite-created` up front makes the same debris pre-existing.
  const marker = fwd(path.join(root, 'state', 'created'));
  if (opts.preExisting) fs.writeFileSync(path.join(root, 'state', 'created'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'test-stub.sh'),
    `#!/bin/sh\necho "PASS  stub ran"\n: > "${marker}"\nexit ${opts.suiteExit}\n`);

  const rec = path.join(root, 'record.log');
  const stub = path.join(root, 'scripts', 'fake-docker.js');
  fs.writeFileSync(stub, FAKE_DOCKER);
  return { root, rec, stub, marker: path.join(root, 'state', 'created'), opts };
}

// The recorder. Preloaded into node through NODE_OPTIONS; acts as docker only when node was
// invoked AS the seam ("$SWEEP_DOCKER ps -aq"), which is the case where argv[1] is a docker
// subcommand rather than a script path.
const FAKE_DOCKER = `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(1);
if (argv.length && !/\\.js$/i.test(argv[0])) {
  const env = process.env;
  // node resolves argv[1] to an absolute path before the preload runs, so the subcommand
  // arrives as .../ps rather than ps. Record the basename: the record is read by pattern.
  const sub = path.basename(argv[0]);
  fs.appendFileSync(env.FAKE_RECORD, [sub].concat(argv.slice(1)).join(' ') + '\\n');
  const listExit = env.FAKE_LIST_EXIT === '1' ? 1 : 0;
  const rmExit = env.FAKE_RM_EXIT === '1' ? 1 : 0;
  const made = fs.existsSync(env.FAKE_MARKER);
  // Always on this host, and none of it the sweep's business. "my-task-runner" is the trap:
  // docker's own name filter matches it on "task-".
  const world = [
    ['aaa1', 'code-server-unrelated', 'linuxserver/code-server'],
    ['aaa8', 'my-task-runner', 'node:22'],
  ];
  if (made) world.push(['ccc9', 'task-leftover-1', 'pipeline-base:local']);
  const networks = ['bridge'];
  if (made && env.FAKE_NETWORK === '1') networks.push('pipeline-net');
  // fs.writeSync, not process.stdout.write: process.exit() truncates a pending async write
  // to a pipe, which would look exactly like a daemon reporting nothing.
  const say = (s) => { if (s.length) fs.writeSync(1, s.join('\\n') + '\\n'); };
  if (sub === 'ps') {
    // -q is the identity listing; --format is the classification one.
    say(argv.indexOf('--format') === -1 ? world.map((c) => c[0]) : world.map((c) => c.join(' ')));
    process.exit(listExit);
  }
  if (sub === 'network') {
    if (argv[1] === 'ls') { say(networks); process.exit(listExit); }
    process.exit(rmExit);
  }
  if (sub === 'rm') process.exit(rmExit);
  process.exit(0);
}
`;

function sweepEnv(fake, extra) {
  return Object.assign({}, process.env, {
    SWEEP_DOCKER: fwd(process.execPath),
    NODE_OPTIONS: `--require "${fwd(fake.stub)}"`,
    FAKE_RECORD: fake.rec,
    FAKE_MARKER: fake.marker,
    FAKE_NETWORK: fake.opts.network ? '1' : '0',
    FAKE_LIST_EXIT: fake.opts.listFails ? '1' : '0',
    FAKE_RM_EXIT: fake.opts.rmFails ? '1' : '0',
  }, extra || {});
}

function runSweep(fake) {
  return spawnSync('bash', [path.join(fake.root, 'scripts', 'test-all.sh'), '--skip', 'e2e'], {
    cwd: fake.root, encoding: 'utf8', timeout: 120000, env: sweepEnv(fake),
  });
}

function summaryOf(root) {
  const base = path.join(root, 'runs', 'sweeps');
  if (!fs.existsSync(base)) return '';
  const dirs = fs.readdirSync(base).sort();
  if (!dirs.length) return '';
  return read(path.join(base, dirs[dirs.length - 1], 'summary.txt'));
}

// ---- the CLI's own safety rule: no baseline, no removal --------------------------------

function reclaimCli(fake, args, env) {
  return spawnSync(process.execPath, [path.join(fake.root, 'scripts', 'sweep-reclaim.js')]
    .concat(args), { cwd: fake.root, encoding: 'utf8', timeout: 60000, env: sweepEnv(fake, env) });
}

{
  const fake = makeRoot({ suiteExit: 0, network: true, preExisting: true }); // debris present now
  const missing = reclaimCli(fake, ['reclaim', '--before', path.join(fake.root, 'nope.json')]);
  check('reclaim with no before-listing exits 0', missing.status === 0);
  check('reclaim with no before-listing removes NOTHING — the sweep never removes what it '
    + 'cannot prove it created', !/^rm\b/m.test(read(fake.rec)));
  check('reclaim with no before-listing says why, on stderr', /before-listing/.test(missing.stderr));

  const bad = path.join(fake.root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ ok: false, containers: [], networks: [] }));
  fs.writeFileSync(fake.rec, '');
  const incomplete = reclaimCli(fake, ['reclaim', '--before', bad]);
  check('a before-listing that failed to be taken is not treated as "nothing was here"',
    incomplete.status === 0 && !/^rm\b/m.test(read(fake.rec)));

  const empty = path.join(fake.root, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ ok: true, containers: [], networks: [] }));
  fs.writeFileSync(fake.rec, '');
  const dry = reclaimCli(fake, ['reclaim', '--before', empty, '--dry-run']);
  check('a genuinely empty baseline does reclaim, and names what it would remove',
    /ccc9/.test(dry.stdout) && /pipeline-net/.test(dry.stdout));
  check('--dry-run removes nothing', !/^rm\b/m.test(read(fake.rec)));
  check('--dry-run leaves the unrelated containers out of it', !/aaa1|my-task-runner/.test(dry.stdout));

  fs.writeFileSync(fake.rec, '');
  const snap = reclaimCli(fake, ['snapshot'], { FAKE_LIST_EXIT: '1' });
  check('snapshot reports a failed listing as not ok', /"ok":false/.test(snap.stdout));
  check('snapshot exits non-zero when the daemon would not answer', snap.status !== 0);
}

// ---- the real sweep, end to end --------------------------------------------------------

{
  // A suite that fails for its own reasons, having leaked a container, with pipeline-net
  // already gone. The old cleanup ran only when the network had survived AND the suite had
  // timed out, so this case got no cleanup at all.
  const fake = makeRoot({ suiteExit: 1, network: false });
  const r = runSweep(fake);
  const rec = read(fake.rec);
  check('harness: the sweep reached the stand-in (if this fails, ignore the rest)',
    rec.length > 0 && /(^|\n)ps /.test(rec));
  check('harness: the sweep got past its own Docker precheck', /(^|\n)info/.test(rec));
  check('a container leaked by a suite that exited 1 is reclaimed, with no network in sight',
    /(^|\n)rm -f ccc9\b/.test(rec));
  check('the unrelated "my-task-runner" is never removed — the live bug this replaces',
    !/rm .*aaa8/.test(rec));
  check('nor is the unrelated code-server', !/rm .*aaa1/.test(rec));
  check('a suite that failed for its own reasons still reports FAIL', /FAIL/.test(summaryOf(fake.root)));
  check('and the sweep still exits 1', r.status === 1);
}

{
  const fake = makeRoot({ suiteExit: 1, network: true, rmFails: true });
  const r = runSweep(fake);
  check('harness: the stand-in was reached with every rm failing', read(fake.rec).length > 0);
  check('a failing suite still fails when every removal errors', r.status === 1);
  check('and the summary says so rather than swallowing it',
    /FAIL/.test(summaryOf(fake.root)) && /could not reclaim/.test(summaryOf(fake.root)));
}

{
  const fake = makeRoot({ suiteExit: 1, network: true, listFails: true });
  const r = runSweep(fake);
  check('harness: the stand-in was reached with the listing failing', read(fake.rec).length > 0);
  check('a failing suite still fails when the listing itself errors', r.status === 1);
  check('a failed listing removes nothing at all', !/(^|\n)rm /.test(read(fake.rec)));
}

{
  const fake = makeRoot({ suiteExit: 0, network: true });
  const r = runSweep(fake);
  const summary = summaryOf(fake.root);
  check('harness: the stand-in was reached for the passing suite', read(fake.rec).length > 0);
  check('a passing suite still passes with debris present', r.status === 0 && /PASS/.test(summary));
  check('the summary NAMES the reclaimed container, rather than a fixed phrase',
    /ccc9/.test(summary) && /task-leftover-1/.test(summary));
  check('and names the reclaimed network', /pipeline-net/.test(summary));
  check('the network the suite brought up is reclaimed after it, not left for the next suite',
    /(^|\n)network rm pipeline-net\b/.test(read(fake.rec)));
  check('the container goes before the network — docker refuses a network still in use',
    read(fake.rec).indexOf('rm -f ccc9') < read(fake.rec).indexOf('network rm pipeline-net'));
}

{
  // The ownership guarantee, end to end: the same debris, but it was already there.
  const fake = makeRoot({ suiteExit: 0, network: true, preExisting: true });
  const r = runSweep(fake);
  const rec = read(fake.rec);
  check('harness: the stand-in was reached for the pre-existing case', rec.length > 0);
  check('debris that predates the suite is NOT reclaimed, however much it looks like ours',
    !/(^|\n)rm /.test(rec));
  check('a suite that leaked nothing gets an empty note',
    !/ccc9|reclaimed/.test(summaryOf(fake.root)));
  check('and the sweep still exits 0', r.status === 0);
}

// ---- the source rules ------------------------------------------------------------------

const stripComments = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const sweepSrc = stripComments(read(TEST_ALL));

check('test-all.sh keeps no removal path of its own',
  !/docker\s+rm\b/.test(sweepSrc) && !/docker\s+network\s+rm\b/.test(sweepSrc)
  && !/pipeline-net\.sh['"]?\s+down/.test(sweepSrc));
check('…because it delegates to scripts/sweep-reclaim.js', /sweep-reclaim/.test(sweepSrc));

const bare = sweepSrc.split('\n')
  .filter((l) => /(^|[^_])\bdocker\s/.test(l) && !/SWEEP_DOCKER/.test(l));
check(`every docker call in test-all.sh goes through $SWEEP_DOCKER, prechecks included `
  + `(offending: ${bare.map((l) => l.trim().slice(0, 40)).join(' | ') || 'none'})`,
  bare.length === 0);

// The live ownership bug, checked over the discovered set so a suite added later is covered
// without editing this: `--filter name=task-` is a substring match on the whole host.
const suites = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.sh$/.test(f));
check(`discovered ${suites.length} suites to check`, suites.length > 5);

const substring = [];
const untrapped = [];
for (const f of suites) {
  const src = read(path.join(ROOT, 'scripts', f));
  const body = stripComments(src);
  if (/--filter\s+["']?name=(?!\^)/.test(body)) substring.push(f);
  if (!/pipeline-net\.sh['"]?\s+up/.test(body)) continue;
  if (!/trap\s+[^\n]*EXIT/.test(body)) untrapped.push(f);
}
check(`no suite selects containers by an unanchored name filter (offending: `
  + `${substring.join(', ') || 'none'})`, substring.length === 0);
check(`every suite that brings pipeline-net up tears it down from an EXIT trap (no trap in: `
  + `${untrapped.join(', ') || 'none'})`, untrapped.length === 0);

// ----------------------------------------------------------------------------------------

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failed ? '\nsweep-hygiene: FAILED' : '\nsweep-hygiene: all checks passed');
process.exit(failed);
