// Frozen acceptance test — repo-zje: the sweep reclaims only what it created, after every
// suite (DESIGN.md §4.12). Written before implementation, from the spec alone; criteria D1–D6.
// Plain Node, Docker-free — a task container cannot run Docker.
//
// WHY A RECORDING STAND-IN IS SAFE HERE, when a PATH stub was rejected for pipeline-net.sh.
// `scripts/test-network-names.sh` refuses to shadow `docker` on PATH because a stub that failed
// to intercept would drive the live daemon — and `pipeline-net.sh down` removes the proxy and
// the network BY NAME, unconditionally, so a miss would delete the user's real network. The
// reclaimer removes only what a before/after snapshot diff says appeared, intersected with an
// allowlist. Under a missed seam the fake suite created nothing, the diff is empty, and nothing
// is removed. The ownership rule is what makes the stand-in safe, and it is exactly the thing
// `pipeline-net.sh down` lacks.
//
// D2 AND D4 RUN THE REAL `scripts/test-all.sh`, copied into a temp root. Copied, not invoked in
// place: `test-all.sh` takes a lock, and a suite running inside the sweep would deadlock against
// the sweep that launched it. The recorder is a `#!/bin/sh` file on purpose — it is only ever
// reached as `"$SWEEP_DOCKER" …` from bash, which execs it fine. The EFTYPE trap this repo
// documents applies to `spawnSync` WITHOUT a shell, which is not how this is reached.
//
// THE FIRST ASSERTION IN EACH HARNESS TEST IS THE HARNESS ITSELF. A recorder that never ran
// looks identical to a sweep that reclaimed nothing, so nothing downstream is trusted until the
// recording proves the stand-in was actually reached.

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECLAIM = path.join(REPO, 'scripts', 'sweep-reclaim.js');
const TEST_ALL = path.join(REPO, 'scripts', 'test-all.sh');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`ok - ${msg}`); }
  else { fail++; console.log(`FAIL - ${msg}`); }
}

// ---------------------------------------------------------------------------------------------
// D1 — ownership is a snapshot diff intersected with an allowlist, never a name substring.
// ---------------------------------------------------------------------------------------------

// The listing shape the reclaimer is given. Pinned here because the frozen test IS the contract.
const BEFORE = {
  containers: [
    { id: 'aaa1', name: 'code-server-unrelated', image: 'linuxserver/code-server' },
    { id: 'aaa2', name: 'pipeline-proxy', image: 'pipeline-proxy:local' },
  ],
  networks: ['bridge', 'pipeline-net'],
};

const AFTER = {
  containers: [
    // present in BEFORE — pre-existing, never ours
    { id: 'aaa1', name: 'code-server-unrelated', image: 'linuxserver/code-server' },
    { id: 'aaa2', name: 'pipeline-proxy', image: 'pipeline-proxy:local' },
    // appeared during the suite, from our image — ours
    { id: 'bbb1', name: 'task-repo-xyz-1', image: 'pipeline-base:local' },
    // appeared during the suite, unrelated image — NOT ours
    { id: 'bbb2', name: 'someone-elses', image: 'postgres:16' },
    // the substring trap: contains "task-" but does not start with it, and is not our image
    { id: 'bbb3', name: 'my-task-runner', image: 'node:22' },
  ],
  networks: ['bridge', 'pipeline-net', 'multiagentpipelines-net'],
};

function d1() {
  if (!fs.existsSync(RECLAIM)) {
    ok(false, `D1 ${path.relative(REPO, RECLAIM)} must exist`);
    return;
  }
  let mod;
  try { mod = require(RECLAIM); } catch (e) {
    ok(false, `D1 sweep-reclaim.js must be requirable (${e.message})`);
    return;
  }
  ok(typeof mod.reclaimTargets === 'function',
    'D1 sweep-reclaim.js exports reclaimTargets(before, after)');
  if (typeof mod.reclaimTargets !== 'function') return;

  const picked = mod.reclaimTargets(BEFORE, AFTER);
  ok(Array.isArray(picked), 'D1 reclaimTargets returns an array');
  if (!Array.isArray(picked)) return;

  const blob = JSON.stringify(picked);
  ok(blob.includes('bbb1'),
    'D1 a container that appeared during the suite from pipeline-base:local is reclaimed');
  ok(!blob.includes('aaa1'),
    'D1 a container present before the suite is never reclaimed, whatever its image');
  ok(!blob.includes('aaa2'),
    'D1 a pipeline container that pre-existed the suite is never reclaimed either — the diff '
    + 'decides ownership, not the image alone');
  ok(!blob.includes('bbb2'),
    'D1 a container that appeared from an unrelated image is not ours');
  ok(!blob.includes('bbb3'),
    'D1 "my-task-runner" is NOT reclaimed — docker\'s name filter is a substring match and the '
    + 'current suites use it, so an unrelated host container is force-removed today');
  ok(blob.includes('multiagentpipelines-net') === false,
    'D1 a network outside the allowlist is not reclaimed even though it appeared during the suite');
}

// ---------------------------------------------------------------------------------------------
// The fake root: the real test-all.sh, one stub suite, and a recording stand-in for docker.
// ---------------------------------------------------------------------------------------------

function makeRoot(opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-zje-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });

  fs.copyFileSync(TEST_ALL, path.join(root, 'scripts', 'test-all.sh'));
  if (fs.existsSync(RECLAIM)) {
    fs.copyFileSync(RECLAIM, path.join(root, 'scripts', 'sweep-reclaim.js'));
  }

  // One stub suite with the exit code the case wants.
  fs.writeFileSync(path.join(root, 'scripts', 'test-stub.sh'),
    `#!/bin/sh\necho "PASS  stub ran"\nexit ${opts.suiteExit}\n`);

  // The recorder. Every invocation is appended to record.log; listings are answered from
  // fixtures so the diff has something to find.
  const rec = path.join(root, 'record.log');
  const rmExit = opts.rmFails ? 1 : 0;
  const lsExit = opts.listFails ? 1 : 0;
  const netLine = opts.networkSurvives ? 'pipeline-net' : '';
  fs.writeFileSync(path.join(root, 'scripts', 'fake-docker.sh'),
    '#!/bin/sh\n'
    + `echo "$@" >> ${JSON.stringify(rec)}\n`
    + 'case "$1" in\n'
    + `  ps) echo "ccc9 task-leftover-1 pipeline-base:local"; exit ${lsExit} ;;\n`
    + `  network) if [ "$2" = "ls" ]; then echo "${netLine}"; exit ${lsExit}; fi; exit ${rmExit} ;;\n`
    + `  rm) exit ${rmExit} ;;\n`
    + '  info|version) exit 0 ;;\n'
    + '  *) exit 0 ;;\n'
    + 'esac\n');

  for (const f of ['test-all.sh', 'test-stub.sh', 'fake-docker.sh']) {
    try { fs.chmodSync(path.join(root, 'scripts', f), 0o755); } catch (_) {}
  }
  return { root, rec };
}

function runSweep(root) {
  return spawnSync('bash', [path.join(root, 'scripts', 'test-all.sh'), '--skip', 'e2e'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, {
      SWEEP_DOCKER: path.join(root, 'scripts', 'fake-docker.sh'),
    }),
  });
}

function readRecord(rec) {
  try { return fs.readFileSync(rec, 'utf8'); } catch (_) { return ''; }
}

function latestSummary(root) {
  const base = path.join(root, 'runs', 'sweeps');
  if (!fs.existsSync(base)) return '';
  const dirs = fs.readdirSync(base).sort();
  if (!dirs.length) return '';
  const p = path.join(base, dirs[dirs.length - 1], 'summary.txt');
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------------------------
// D2 — reclamation runs after every suite, and does not depend on a surviving network.
// ---------------------------------------------------------------------------------------------

function d2() {
  const { root, rec } = makeRoot({ suiteExit: 1, networkSurvives: false });
  const r = runSweep(root);
  const record = readRecord(rec);

  // HARNESS FIRST. A recorder that never ran is indistinguishable from a clean sweep.
  ok(record.length > 0 && /\bps\b|\bnetwork\b/.test(record),
    'D2 harness: the sweep reached the SWEEP_DOCKER stand-in (if this fails, ignore the rest)');
  if (!record.length) return;

  ok(/\brm\b/.test(record),
    'D2 a leftover container is removed even though the suite exited 1 and pipeline-net is gone '
    + '— today the cleanup is gated on the network existing AND on the suite having timed out');
  ok(record.includes('ccc9') || record.includes('task-leftover-1'),
    'D2 the thing removed is the leftover the listing reported, by identity');
}

// ---------------------------------------------------------------------------------------------
// D3 [guard] — reclamation never changes a verdict or the sweep's exit code.
// ---------------------------------------------------------------------------------------------

function d3() {
  for (const kase of [
    { name: 'a failing suite still fails', suiteExit: 1, rmFails: false, expect: 1 },
    { name: 'a failing suite still fails when every rm errors', suiteExit: 1, rmFails: true, expect: 1 },
    { name: 'a failing suite still fails when the listing itself errors', suiteExit: 1, listFails: true, expect: 1 },
    { name: 'a passing suite still passes with debris present', suiteExit: 0, rmFails: false, expect: 0 },
  ]) {
    const { root } = makeRoot(Object.assign({ networkSurvives: true }, kase));
    const r = runSweep(root);
    ok(r.status === kase.expect,
      `D3 [guard] ${kase.name} (sweep exit ${r.status}, expected ${kase.expect})`);
    const summary = latestSummary(root);
    if (kase.expect === 1) {
      ok(/FAIL/.test(summary || r.stdout || ''),
        `D3 [guard] ${kase.name}: the summary still reports FAIL`);
    } else {
      ok(/PASS/.test(summary || r.stdout || ''),
        `D3 [guard] ${kase.name}: the summary still reports PASS`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// D4 — the summary names what it reclaimed, by identity rather than by a fixed phrase.
// ---------------------------------------------------------------------------------------------

function d4() {
  const { root, rec } = makeRoot({ suiteExit: 0, networkSurvives: true });
  runSweep(root);
  const record = readRecord(rec);
  ok(record.length > 0,
    'D4 harness: the stand-in was reached (if this fails, ignore the rest)');
  if (!record.length) return;

  const summary = latestSummary(root);
  ok(summary.length > 0, 'D4 a summary.txt was written');
  ok(summary.includes('ccc9') || summary.includes('task-leftover-1'),
    'D4 the summary NAMES the reclaimed container — today the note is the fixed string '
    + '"left pipeline-net up" and removals never reach the table a human reads');
}

// ---------------------------------------------------------------------------------------------
// D5 — test-all.sh keeps no removal path of its own. A deliberately NEGATIVE source assertion:
// it forbids text rather than rewarding it, so it cannot be satisfied by code that never runs.
// ---------------------------------------------------------------------------------------------

function stripComments(src) {
  return src.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

function d5() {
  const src = stripComments(fs.readFileSync(TEST_ALL, 'utf8'));
  ok(!/docker\s+rm\b/.test(src),
    'D5 test-all.sh contains no `docker rm` outside the delegated reclaim call');
  ok(!/docker\s+network\s+rm\b/.test(src),
    'D5 test-all.sh contains no `docker network rm`');
  ok(!/pipeline-net\.sh['"]?\s+down/.test(src),
    'D5 test-all.sh does not tear the network down itself');
  ok(/sweep-reclaim/.test(src),
    'D5 …because it delegates to the reclaimer instead');
}

// ---------------------------------------------------------------------------------------------
// D6 — every suite that brings the network up tears it down from an EXIT trap.
// Checked over the DISCOVERED set, so a suite added later is covered without editing this.
// ---------------------------------------------------------------------------------------------

function d6() {
  const dir = path.join(REPO, 'scripts');
  const suites = fs.readdirSync(dir).filter((f) => /^test-.*\.sh$/.test(f));
  ok(suites.length > 5, `D6 discovered ${suites.length} suites to check`);

  const offenders = [];
  for (const f of suites) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const bringsUp = /pipeline-net\.sh['"]?\s+up/.test(stripComments(src));
    if (!bringsUp) continue;
    const trapsDown = /trap\s+[^\n]*pipeline-net\.sh['"]?\s+down/.test(src)
      || /trap\s+['"]?[a-z_]+['"]?\s+EXIT/i.test(src);
    if (!trapsDown) offenders.push(f);
  }
  ok(offenders.length === 0,
    `D6 every suite that brings pipeline-net up tears it down from an EXIT trap `
    + `(no trap in: ${offenders.join(', ') || 'none'})`);
}

// ---------------------------------------------------------------------------------------------

d1();
d2();
d3();
d4();
d5();
d6();

console.log(`\nrepo-zje: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('repo-zje: FAILED');
  process.exit(1);
}
console.log('repo-zje: all checks passed');
