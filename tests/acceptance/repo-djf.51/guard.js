// Frozen acceptance guard — repo-djf.51. [guard]
// Criteria -> tests: C5's stay-green half (the shared lock canonicalization authority's
// existing contract, `prove-tests.js`'s existing exported surface, its existing
// ownership-marker forging protections, and the mandatory regression profile's own
// configuration) -> G1, G2, G3, G4 here. test.js's T8 covers the other half of C5 (actually
// re-running the repo-os9 target-lock suite and the repo-djf.14 probe-ownership/freeze suite),
// since that half is only provable by executing those suites, not by inspecting shape.
// Every check here is GREEN at the fork point (repo-djf.51 has not landed; the identity
// binding this issue adds sits entirely on top of the interfaces pinned below) and must stay
// green.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const LOCK = require(path.join(ROOT, 'runner', 'lock.js'));
const PROVE = require(path.join(ROOT, 'scripts', 'prove-tests.js'));

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

// G1 / C5 — the shared lock canonicalization authority's existing contract: resolves a real
// path, folds an equivalent (redundant-segment) spelling to the same identity, and (on the
// case-insensitive, backslash-native reference host) folds case and slash direction too. This
// suite's T1/T2/T5 depend on this contract already holding; it must not move underneath them.
check('G1 C5 [guard] lock.canonicalTarget resolves a real path and folds an equivalent spelling to one identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf51-guard-canon-'));
  try {
    const alias = path.join(dir, '..', path.basename(dir));
    assert.strictEqual(LOCK.canonicalTarget(dir), LOCK.canonicalTarget(alias),
      `canonicalTarget(${dir}) !== canonicalTarget(${alias})`);
    if (process.platform === 'win32') {
      const flipped = dir.toUpperCase().split(path.sep).join('/');
      assert.strictEqual(LOCK.canonicalTarget(dir), LOCK.canonicalTarget(flipped),
        `canonicalTarget did not fold case/slash on win32: ${dir} vs ${flipped}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// G2 / C5 — `scripts/prove-tests.js` keeps exporting the exact surface repo-djf.14 and this
// suite both call directly; canonical identity binding must be additive to it, never a rename
// or removal.
check('G2 C5 [guard] scripts/prove-tests.js keeps exporting its existing probe-preparation surface', () => {
  for (const name of ['prepareProbe', 'resumeProbe', 'readManagedProbe', 'ownedContainer',
    'removeOwnedPath', 'removeOwnedContainer', 'validateManagedProbe', 'promoteManagedSuite',
    'proveTests']) {
    assert.strictEqual(typeof PROVE[name], 'function', `scripts/prove-tests.js no longer exports ${name}()`);
  }
  for (const name of ['MARKER', 'PROBE_PREFIX', 'PROBE_ROOT_NAME']) {
    assert.strictEqual(typeof PROVE[name] === 'string' && PROVE[name].length > 0, true,
      `scripts/prove-tests.js no longer exports a non-empty ${name}`);
  }
});

// G3 / C5 — the existing ownership-marker forging protection: an ordinary, unmarked directory
// is never treated as an owned probe container. Canonical identity binding adds a refusal
// reason; it must not replace or weaken this one.
check('G3 C5 [guard] ownedContainer still refuses a directory with no ownership marker at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PROVE.PROBE_PREFIX}guard-`));
  try {
    assert.strictEqual(PROVE.ownedContainer(dir), false, 'an unmarked directory was accepted as an owned probe container');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// G4 / C5 — the mandatory, Docker-free regression layer stays required and runnable: it is what
// keeps enforcing canonical-identity safety (and everything else in this project) once this
// change lands.
check('G4 C5 [guard] the mandatory regression profile remains required and names an existing command', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8'));
  assert.strictEqual(config.regressionPolicy, 'required', JSON.stringify(config.regressionPolicy));
  assert.strictEqual(config.regressionCommand, 'bash scripts/test-ci.sh', JSON.stringify(config.regressionCommand));
  assert(fs.existsSync(path.join(ROOT, 'scripts', 'test-ci.sh')), 'scripts/test-ci.sh is missing');
});

process.exitCode = failed;
