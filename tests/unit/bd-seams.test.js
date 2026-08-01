// Docker-free unit coverage for runner/bd.js's two-sided seam.
//
// WHY THIS EXISTS. `PIPELINE_BD_CMD` takes absolute precedence over every path in `bd()` — that
// is what lets a Docker-free suite stub the whole layer, and it is deliberate. But it means host
// bd and image bd collapse into one stub, so a check that COMPARES the two cannot be driven
// Docker-free at all: both sides answer identically by construction. That is not hypothetical —
// it is why `repo-ixa` (abort when the host and image bd versions disagree) could not be frozen.
//
// `bdOnHost` / `bdInImage` split the two sides apart, each with its own seam. This suite pins the
// property that makes the split worth having — that the two can be made to DISAGREE — plus the
// backward-compatibility guarantees every existing suite rests on.
//
// The stubs are `.js` files invoked through `process.execPath`, never `#!/bin/sh` scripts:
// `spawnSync` without a shell fails such a script with EFTYPE on the Windows host, so a shell
// stub would pass in the container and fail in the host sweep.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const bdmod = require(path.join(REPO, 'runner', 'bd.js'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`PASS  ${msg}`); }
  else { fail++; console.log(`FAIL  ${msg}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-seams-'));
function stub(name, text) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

// Each stub echoes a distinct version and its own name, so a result can be traced to the seam
// that produced it rather than merely differing.
const HOST = stub('host-bd.js', 'console.log("bd version 1.1.2 (host)");\n');
const IMAGE = stub('image-bd.js', 'console.log("bd version 1.1.0 (image)");\n');

const cfg = { targetRepoPath: tmp, image: 'pipeline-example:local' };

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---- the property the split exists for -------------------------------------------------

withEnv({ PIPELINE_BD_CMD: process.execPath, PIPELINE_IMAGE_BD_CMD: process.execPath }, () => {
  const h = bdmod.bdOnHost(cfg, [HOST]);
  const i = bdmod.bdInImage(cfg, [IMAGE]);
  const ht = (h && h.stdout || '').trim();
  const it = (i && i.stdout || '').trim();

  ok(ht.includes('1.1.2') && ht.includes('host'), 'bdOnHost runs the host-side seam');
  ok(it.includes('1.1.0') && it.includes('image'), 'bdInImage runs the image-side seam');
  ok(ht !== it,
    'the two sides can be made to DISAGREE — which is the whole point, and is impossible '
    + 'through PIPELINE_BD_CMD alone because it short-circuits every path in bd()');
});

// ---- backward compatibility: what every existing suite rests on ------------------------

withEnv({ PIPELINE_BD_CMD: process.execPath, PIPELINE_IMAGE_BD_CMD: undefined }, () => {
  const r = bdmod.bd(cfg, [stub('forty-two.js', 'console.log(42);\n')]);
  ok((r.stdout || '').trim() === '42',
    'bd() with only the general seam set is unchanged — no -C prefix, no host probe, '
    + 'no Docker fallback');
});

withEnv({ PIPELINE_BD_CMD: process.execPath, PIPELINE_IMAGE_BD_CMD: undefined }, () => {
  // The general seam must still win for bdOnHost too, or a suite that stubs only
  // PIPELINE_BD_CMD would start reaching the real host bd through the new function.
  const r = bdmod.bdOnHost(cfg, [HOST]);
  ok((r.stdout || '').includes('1.1.2'),
    'bdOnHost still honours PIPELINE_BD_CMD, so existing stubs keep working');
});

// ---- the distinction a version gate must not conflate ----------------------------------

withEnv({ PIPELINE_BD_CMD: undefined, PIPELINE_IMAGE_BD_CMD: undefined }, () => {
  const r = bdmod.bdOnHost(cfg, ['version']);
  const hostExists = bdmod.haveHostBd();
  if (hostExists) {
    ok(r !== null, 'with a host bd present, bdOnHost returns a result');
  } else {
    ok(r === null,
      'with NO host bd, bdOnHost returns null rather than a failed result — "there is nothing '
      + 'to compare" is a different answer from "the comparison failed", and a version gate '
      + 'that conflated them would report a skew of unknown size');
  }
});

// ---- the seam is a test seam, and says so ----------------------------------------------

const src = fs.readFileSync(path.join(REPO, 'runner', 'bd.js'), 'utf8');
ok(/PIPELINE_IMAGE_BD_CMD/.test(src) && /production must never set it/i.test(src),
  'the new seam is documented as a test seam production must never set, like its sibling');

console.log(`\nPASS  unit suite ran ${pass + fail} checks`);
if (fail > 0) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
