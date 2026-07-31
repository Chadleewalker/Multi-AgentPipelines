// Frozen acceptance test — repo-sls: every runner `bd` call is bounded, and a hung Beads
// call fails loudly instead of hanging the run (DESIGN.md §4.1, §4.10, §4.12).
// Written before implementation, from the spec alone; criteria A1–A6. Plain Node,
// Docker-free — a task container cannot run Docker.
//
// Four things this file gets right on purpose, each from the 2026-07-31 planning panel:
//
//   * THE STUB IS A .js FILE run through process.execPath, never a shebang script.
//     runner/bd.js spawns PIPELINE_BD_CMD with spawnSync and NO shell, and on the Windows
//     host a /bin/sh stub fails with EFTYPE — which is how repo-dhp shipped a suite that was
//     green in the container and red in the host sweep (STATUS defect 9). NODE_OPTIONS
//     carries forward slashes for the same reason.
//   * THE SLEEPING STUB GENUINELY BLOCKS (Atomics.wait). A setTimeout would let the process
//     exit early on some paths, and the test would then pass against an unbounded bd().
//   * A4 IS NOT SATISFIED BY THE STUB BRANCH ALONE. PIPELINE_BD_CMD takes absolute
//     precedence and returns early, so a Docker-free test can only EXECUTE that one branch —
//     an implementation bounding it alone would pass a naive suite while production `bd`
//     stayed unbounded, which is the exact hang this task exists to prevent. So A4 pins the
//     shared builder by value AND checks that every spawnSync in bd.js is built from it.
//   * A5 GUARDS THE THING THE SOLE-WRITER RULE RESTS ON. In a single-threaded runner,
//     spawnSync is what makes two bd calls unable to interleave over one embedded Dolt
//     database. repo-teq adds a worker pool immediately after this task; an async rewrite
//     here would remove that guarantee silently, at exactly the wrong moment.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const DEFAULT_TIMEOUT_MS = 60000;   // the documented default (A3)
const SMALL_TIMEOUT_MS = 400;       // small enough to fire fast, large enough not to flake
const STUB_SLEEP_MS = 6000;         // >> SMALL_TIMEOUT_MS, so a fired bound is unambiguous

// ---- the bd stub -------------------------------------------------------------------
// Modes: "sleep" blocks past any sane bound; "json" prints BD_STUB_OUT and exits 0.
// Both record the argument vector they were handed, which is what A6 reads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-sls-'));
const stub = path.join(tmp, 'bd-stub.js');
const argvOut = path.join(tmp, 'argv.json');
const stubOut = path.join(tmp, 'stdout.txt');
fs.writeFileSync(stub, [
  "'use strict';",
  "const sfs = require('fs');",
  'try { sfs.writeFileSync(process.env.BD_ARGV_OUT, JSON.stringify(process.argv.slice(1))); } catch {}',
  "if (process.env.BD_STUB_MODE === 'sleep') {",
  '  const ia = new Int32Array(new SharedArrayBuffer(4));',
  '  Atomics.wait(ia, 0, 0, Number(process.env.BD_STUB_SLEEP_MS));',
  '}',
  "let body = '[]';",
  "try { body = sfs.readFileSync(process.env.BD_STUB_OUT, 'utf8'); } catch {}",
  'sfs.writeSync(1, body);',
  'process.exit(0);',
  '',
].join('\n'));
fs.writeFileSync(stubOut, '[]');

process.env.PIPELINE_BD_CMD = process.execPath;
process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
process.env.BD_ARGV_OUT = argvOut;
process.env.BD_STUB_OUT = stubOut;
process.env.BD_STUB_SLEEP_MS = String(STUB_SLEEP_MS);

let bdmod = null;
try { bdmod = require(path.join(ROOT, 'runner', 'bd.js')); } catch { /* reported below */ }
check('runner/bd.js is requirable', bdmod !== null);
const bd = (bdmod && bdmod.bd) ? bdmod.bd : () => ({ status: 0, stdout: '', stderr: 'bd.js not loaded' });
const bdJson = (bdmod && bdmod.bdJson) ? bdmod.bdJson : () => ({ ok: true, data: [] });

const cfgFast = { targetRepoPath: '/nonexistent-by-design', image: 'unused', bdTimeoutMs: SMALL_TIMEOUT_MS };

// =====================================================================================
// A1 — a call past the bound fails visibly and names the timeout; a fast call does not
// =====================================================================================
process.env.BD_STUB_MODE = 'sleep';
const started = Date.now();
const slow = bd(cfgFast, ['list']);
const slowMs = Date.now() - started;

check('A1 a bd call past the bound returns a non-zero status',
  !!slow && slow.status !== 0 && slow.status !== null);
check('A1 the bound actually fired (returned well before the stub finished sleeping)',
  slowMs < STUB_SLEEP_MS - 1000);
const slowText = `${(slow && slow.stderr) || ''}${(slow && slow.stdout) || ''}`;
check('A1 the failure text names the timeout that fired',
  slowText.includes(String(SMALL_TIMEOUT_MS)) && /timed out|timeout/i.test(slowText));

process.env.BD_STUB_MODE = 'json';
const fast = bd(cfgFast, ['list']);
check('A1 a fast bd call under the same bound succeeds untouched',
  !!fast && fast.status === 0 && !/timed out|timeout/i.test(`${fast.stderr || ''}`));

// =====================================================================================
// A2 — a timed-out bdJson is distinguishable from a successful empty query
// =====================================================================================
process.env.BD_STUB_MODE = 'json';
fs.writeFileSync(stubOut, '[]');
const emptyOk = bdJson(cfgFast, ['list']);
check('A2 an empty result is ok:true with empty data',
  !!emptyOk && emptyOk.ok === true && Array.isArray(emptyOk.data) && emptyOk.data.length === 0);

process.env.BD_STUB_MODE = 'sleep';
const timedOut = bdJson(cfgFast, ['list']);
check('A2 a timed-out query is ok:false', !!timedOut && timedOut.ok === false);
check('A2 a timed-out query names the timeout in its error',
  !!timedOut && typeof timedOut.error === 'string'
  && timedOut.error.includes(String(SMALL_TIMEOUT_MS)) && /timed out|timeout/i.test(timedOut.error));
check('A2 the two outcomes are not confusable',
  !!timedOut && !!emptyOk && timedOut.ok !== emptyOk.ok);
process.env.BD_STUB_MODE = 'json';

// =====================================================================================
// A3 — the bound is a validated run.config.json field with a documented default
// =====================================================================================
let loadConfig = null;
try { ({ loadConfig } = require(path.join(ROOT, 'runner', 'config.js'))); } catch { /* below */ }
check('runner/config.js is requirable', typeof loadConfig === 'function');

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-sls-cfg-'));
function writeCfg(name, extra) {
  const p = path.join(cfgDir, name);
  fs.writeFileSync(p, JSON.stringify({
    targetRepoPath: 'C:/nonexistent', targetRepoRemote: 'https://example.invalid/r.git',
    image: 'unused:local', ...extra,
  }, null, 2));
  return p;
}
function loaded(p) { try { return { ok: true, cfg: loadConfig(p) }; } catch (e) { return { ok: false, message: e.message }; } }

const dflt = loaded(writeCfg('run.config.json', {}));
check('A3 a config naming no bdTimeoutMs defaults to 60000',
  dflt.ok && dflt.cfg.bdTimeoutMs === DEFAULT_TIMEOUT_MS);

const explicit = loaded(writeCfg('run.config.explicit.json', { bdTimeoutMs: 1234 }));
check('A3 an explicit bdTimeoutMs wins', explicit.ok && explicit.cfg.bdTimeoutMs === 1234);

for (const [label, bad] of [['zero', 0], ['negative', -1], ['fractional', 1.5], ['a string', '60000']]) {
  const r = loaded(writeCfg(`run.config.bad-${label.replace(/\s/g, '-')}.json`, { bdTimeoutMs: bad }));
  check(`A3 ${label} bdTimeoutMs is a load-time error naming the field`,
    !r.ok && /bdTimeoutMs/.test(r.message || ''));
}

const example = read(path.join(ROOT, 'run.config.example.json')) || '';
let exampleJson = null;
try { exampleJson = JSON.parse(example); } catch { /* reported by the check */ }
check('A3 run.config.example.json documents the field with the default',
  !!exampleJson && exampleJson.bdTimeoutMs === DEFAULT_TIMEOUT_MS);

// =====================================================================================
// A4 — one shared spawn-options builder, reaching every spawnSync in bd.js
// =====================================================================================
// The value half: the builder resolves the configured bound, and the default when absent.
const spawnOptions = bdmod && bdmod.spawnOptions;
check('A4 runner/bd.js exports spawnOptions', typeof spawnOptions === 'function');
if (typeof spawnOptions === 'function') {
  const o1 = spawnOptions({ bdTimeoutMs: 4321 });
  const o2 = spawnOptions({});
  const o3 = spawnOptions();
  check('A4 spawnOptions carries the configured bound as `timeout`', !!o1 && o1.timeout === 4321);
  check('A4 spawnOptions falls back to the documented default', !!o2 && o2.timeout === DEFAULT_TIMEOUT_MS);
  check('A4 spawnOptions tolerates a missing config', !!o3 && o3.timeout === DEFAULT_TIMEOUT_MS);
}

// The reach half: a Docker-free test can only EXECUTE the PIPELINE_BD_CMD branch, so the
// other two — host bd, and the docker fallback — are checked structurally. Every spawnSync
// statement in bd.js must be built from the shared builder, INCLUDING the two host-bd
// probes in hostBdSpec: a hung probe hangs the run exactly as a hung call does.
const bdSrc = read(path.join(ROOT, 'runner', 'bd.js')) || '';
// Join each spawnSync(...) call into one string by balancing parentheses, so a call spread
// over several lines is judged whole. Comment lines are dropped first.
const codeOnly = bdSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
function spawnSyncCalls(src) {
  const calls = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf('spawnSync(', i);
    if (at === -1) break;
    let depth = 0;
    let j = at + 'spawnSync'.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    calls.push(src.slice(at, j));
    i = j;
  }
  return calls;
}
const calls = spawnSyncCalls(codeOnly);
check('A4 runner/bd.js still has spawnSync call sites to check', calls.length >= 3);
check('A4 every spawnSync in runner/bd.js is built from spawnOptions',
  calls.length >= 3 && calls.every((c) => c.includes('spawnOptions')));

// =====================================================================================
// A5 — bd() stays synchronous (the sole-writer guarantee repo-teq will lean on)
// =====================================================================================
const asyncSpawn = /(^|[^.\w])spawn\s*\(/.test(codeOnly)
  || /(^|[^.\w])execFile\s*\(/.test(codeOnly)
  || /(^|[^.\w])exec\s*\(/.test(codeOnly);
check('A5 runner/bd.js spawns the bd command synchronously only', !asyncSpawn);
check('A5 runner/bd.js does not import an asynchronous spawn',
  !/require\(['"]child_process['"]\)[^\n]*\bspawn\b(?!Sync)/.test(codeOnly));

// =====================================================================================
// A6 [guard] — the seam contract is unchanged
// =====================================================================================
process.env.BD_STUB_MODE = 'json';
try { fs.unlinkSync(argvOut); } catch { /* first run */ }
bd(cfgFast, ['list', '--status', 'open']);
let seenArgv = null;
try { seenArgv = JSON.parse(read(argvOut) || 'null'); } catch { /* reported below */ }
// node resolves argv[1] — the first bd argument doubles as the "main module" under
// --require — so the first element is an absolute path ending in the subcommand, not the
// bare word. Match the tail exactly and the head by name; asserting the raw join would
// fail against a correct implementation on every platform.
check('A6 PIPELINE_BD_CMD receives the bare bd argument vector',
  Array.isArray(seenArgv) && seenArgv.length === 3
  && path.basename(String(seenArgv[0])) === 'list'
  && seenArgv[1] === '--status' && seenArgv[2] === 'open');
check('A6 PIPELINE_BD_CMD is not given a -C prefix',
  Array.isArray(seenArgv) && !seenArgv.includes('-C'));
check('A6 PIPELINE_BD_CMD takes absolute precedence (targetRepoPath never appears)',
  Array.isArray(seenArgv) && !seenArgv.includes(cfgFast.targetRepoPath));

// The fixture uses a `path/to` placeholder rather than a plausible machine path: this file
// is published, and scripts/test-sanitize.sh reads the tracked tree as bytes.
check('A6 toMountPath still converts an MSYS drive path',
  !!bdmod && typeof bdmod.toMountPath === 'function'
  && bdmod.toMountPath('/c/path/to/repo') === 'C:/path/to/repo');
check('A6 shimTarget still parses an npm sh shim',
  !!bdmod && typeof bdmod.shimTarget === 'function'
  && bdmod.shimTarget('exec node  "$basedir/node_modules/@beads/bd/bin/bd.js" "$@"', '/opt')
    === path.join('/opt', 'node_modules/@beads/bd/bin/bd.js'));
check('A6 haveHostBd is still exported', !!bdmod && typeof bdmod.haveHostBd === 'function');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ }
try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* disposable */ }

console.log(failed ? 'repo-sls: FAILED' : 'repo-sls: all checks passed');
process.exit(failed);
