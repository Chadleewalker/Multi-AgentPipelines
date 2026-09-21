// Frozen acceptance test — the regressions enum drift between the verifier's result
// file and the run manifest (planning draft 2026-08-18, Task 3; design-ref DESIGN.md
// §4.4, §4.11, change-log row `verify-nobuffer`). Written before implementation, from
// the spec alone; criteria D1–D5 map 1:1 to the issue's "Done means" list. Plain Node,
// Docker-free, no ajv, no network, nothing read from `runs/`.
//
// THE DEFECT: `schemas/verify.schema.json` accepts four values for `regressions`
// (`verify-nobuffer` added `error`, meaning the regression run was killed before
// reaching a verdict); `schemas/run.schema.json` accepts three. `runner/run.js` copies
// the value onto the manifest task row verbatim, so a killed regression pass writes a
// `run.json` that fails its own ajv validation in `scripts/test-report.sh` and
// `scripts/e2e.sh`.
//
// PATHS ARE RESOLVED FROM __dirname, NEVER FROM THE WORKING DIRECTORY, and both files
// are asserted to have parsed before anything is compared. A missing file must fail
// loudly rather than turning into an empty-set comparison that reads as agreement —
// which is exactly how a cross-file equality check goes vacuously green.
//
// Criteria:
//   D1  the manifest admits every value the verifier can emit. Both enums are read at
//       their pinned JSON paths and each is asserted to be an array of length >= 4
//       BEFORE the comparison; the vocabulary is taken from verify.schema.json rather
//       than written down here, so the next value added there and forgotten in the
//       manifest fails this too. The admitted fixture is a realistic task row of the
//       shape runner/run.js writes, not a two-key stub — with additionalProperties
//       false on both objects, a stub tests strictly less than the artifact that fails
//       in the field.
//   D2  [guard] the verifier's vocabulary is not narrowed, and the admitter can in fact
//       reject — an invented value is refused by both schemas, on the same paths D1
//       just admitted. Without this, an admitter that enforces additionalProperties and
//       never looks at `enum` passes D1's admit half against the unfixed schema.
//   D3  [guard] `error` still does not downgrade a passing task: runner/queue.js's
//       exported outcomeFor is driven in-process over four probes.
//   D4  the drift check keeps running after this task closes. A frozen acceptance test
//       is executed by pipeline/verify.js during its own task's run and never again —
//       scripts/test-all.sh discovers suites by the glob scripts/test-*.sh and nothing
//       in scripts/ ever runs an acceptance directory. So this file gates THIS task,
//       and scripts/test-schema-drift.sh is what stops the defect recurring. Both
//       drives are here: green against the real schemas, RED against a planted drifted
//       pair through its SCHEMA_DRIFT_DIR seam, because a guard nobody has seen fail is
//       not a guard.
//   D5  [guard] run.schema.json is otherwise unmoved — the parsed file deep-equals an
//       image of the fork-point file with the single new enum member added and nothing
//       else changed. Inlining that baseline does not go stale: the fork-point state is
//       fixed history, known at freeze time. Four sampled property checks would pass an
//       implementation that also widened the `outcome` enum or dropped a maxItems.
//
// Every fixture value is invented (issue id `app-777`); all temp dirs live under
// os.tmpdir() via mkdtempSync and are removed in a finally; no stub is spawned without
// an explicit interpreter. Nothing depends on chmod, so the same file passes on the
// Windows host and in the Linux container.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMAS = path.join(ROOT, 'schemas');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---- the inline admitter (repo-1cy / repo-bmd precedent: never ajv) ---------------
// Driven by each schema AS READ FROM DISK. It enforces required, additionalProperties,
// enums and scalar types — the things an additive change can break — and D2's negative
// probes are what prove it is a real check rather than a function returning true.
function admit(obj, sch) {
  if (!sch || typeof sch !== 'object') return true;
  if (sch.properties || sch.type === 'object') {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
    const props = sch.properties || {};
    for (const k of sch.required || []) if (!(k in obj)) return false;
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(props, k)) return false;
    }
    for (const k of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, k) && !admit(obj[k], props[k])) return false;
    }
    return true;
  }
  if (sch.items || sch.type === 'array') {
    if (!Array.isArray(obj)) return false;
    for (const it of obj) if (sch.items && !admit(it, sch.items)) return false;
    return true;
  }
  if (Array.isArray(sch.enum)) return sch.enum.includes(obj);
  if (sch.type === 'string') return typeof obj === 'string';
  if (sch.type === 'integer') return Number.isInteger(obj);
  if (sch.type === 'number') return typeof obj === 'number' && Number.isFinite(obj);
  if (sch.type === 'boolean') return typeof obj === 'boolean';
  return true;   // union or unconstrained types are not this test's business
}

// Order-insensitive deep equality, with the first differing path named — a bare
// "objects differ" is not actionable at 3am.
function deepDiff(a, b, at) {
  const where = at || '$';
  if (a === b) return null;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) return `${where}: ${ta} vs ${tb}`;
  if (ta === 'array') {
    if (a.length !== b.length) return `${where}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], `${where}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (show(ka) !== show(kb)) return `${where}: keys ${show(ka)} vs ${show(kb)}`;
    for (const k of ka) {
      const d = deepDiff(a[k], b[k], `${where}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${where}: ${show(a)} vs ${show(b)}`;
}

// The fork-point image of schemas/run.schema.json with the single new enum member
// added. Generated at freeze time from the file as it then stood; fixed history.
const BASELINE_RUN_SCHEMA =
{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "run.schema.json",
    "title": "Per-run manifest (runs/<run-id>/run.json)",
    "description": "Written by the runner (owner: the runner task, T14/T16 - DESIGN.md 4.12). Frozen input to the report generator: Beads alone cannot reconstruct report statuses, because stuck/tampered/failed all map to 'blocked' and done/partial both map to 'closed'.",
    "type": "object",
    "required": [
      "runId",
      "startedAt",
      "finishedAt",
      "tasks"
    ],
    "additionalProperties": false,
    "properties": {
      "runId": {
        "type": "string"
      },
      "startedAt": {
        "type": "string",
        "format": "date-time"
      },
      "finishedAt": {
        "type": "string",
        "format": "date-time"
      },
      "targetRepo": {
        "type": "string"
      },
      "concurrency": {
        "description": "How many task containers this runner was configured to work at once (DESIGN.md 7). The configured or defaulted setting, not the observed peak in flight. Optional: manifests written before the knob existed carry no such field.",
        "type": "integer",
        "minimum": 1
      },
      "abortedReason": {
        "description": "Present when the run ended before draining the queue (preflight failure, operator stop).",
        "type": "string"
      },
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "issueId",
            "outcome"
          ],
          "additionalProperties": false,
          "properties": {
            "issueId": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "outcome": {
              "description": "Report status from the 4.11 table.",
              "enum": [
                "done",
                "partial",
                "stuck",
                "tampered",
                "failed",
                "paused"
              ]
            },
            "exitCode": {
              "description": "Container exit code, or 'killed' for a host wall-clock kill (which produces no code).",
              "type": [
                "integer",
                "string"
              ]
            },
            "branch": {
              "type": "string"
            },
            "pushed": {
              "type": "boolean"
            },
            "prUrl": {
              "type": [
                "string",
                "null"
              ]
            },
            "attempts": {
              "type": "integer",
              "minimum": 0
            },
            "pauses": {
              "type": "integer",
              "minimum": 0
            },
            "activeSeconds": {
              "type": "number",
              "minimum": 0
            },
            "diffLines": {
              "description": "Lines changed on the branch - the report's tie-breaker after attempt count.",
              "type": "integer",
              "minimum": 0
            },
            "changeSummary": {
              "type": "string"
            },
            "model": {
              "description": "Model the agent phases ran on (4.3).",
              "type": "string"
            },
            "verification": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "acceptance": {
                  "enum": [
                    "pass",
                    "fail",
                    "tampered",
                    "error"
                  ]
                },
                "regressions": {
                  "enum": [
                    "pass",
                    "fail",
                    "absent",
                    "error"
                  ]
                },
                "evidence": {
                  "type": "string"
                }
              }
            },
            "attemptNotes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "stuckState": {
              "type": "string"
            },
            "specConcerns": {
              "description": "Verbatim copy of the container's status-file specConcerns (DESIGN.md 3.7), carried so the report and PR body can surface them. Same bounds as status.schema.json. Evidence only (3.5): present or absent, it never affects outcome or scrutiny order.",
              "type": "array",
              "maxItems": 5,
              "items": {
                "type": "string",
                "maxLength": 1000
              }
            },
            "error": {
              "type": "string"
            }
          }
        }
      }
    }
  };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-4d8-'));

try {
  // ---- both schemas must be present and parse, before anything is compared --------
  const runSchema = readJson(path.join(SCHEMAS, 'run.schema.json'));
  const verifySchema = readJson(path.join(SCHEMAS, 'verify.schema.json'));
  check('schemas/run.schema.json parsed to an object', Boolean(runSchema) && typeof runSchema === 'object');
  check('schemas/verify.schema.json parsed to an object', Boolean(verifySchema) && typeof verifySchema === 'object');
  if (!runSchema || !verifySchema) {
    console.log('FAIL - HARNESS BROKEN: a schema file is missing or unparsable, so every');
    console.log('       comparison below would be between two empty sets and would read as');
    console.log('       agreement. Refusing to report that as a pass.');
    process.exit(1);
  }

  // The two pinned JSON paths. Named here so the test cannot quietly read an easier node.
  const rowSchema = runSchema.properties && runSchema.properties.tasks
    && runSchema.properties.tasks.items;
  const verificationSchema = rowSchema && rowSchema.properties && rowSchema.properties.verification;
  const runEnum = verificationSchema && verificationSchema.properties
    && verificationSchema.properties.regressions && verificationSchema.properties.regressions.enum;
  const verifyEnum = verifySchema.properties && verifySchema.properties.regressions
    && verifySchema.properties.regressions.enum;

  // ==== D1: the manifest admits every value the verifier can emit ==================
  // Each side is asserted to be a located, non-trivial array FIRST. A lookup that
  // misses yields undefined on both sides, and "the sets are equal" is then trivially
  // true — the way this exact check goes vacuously green.
  check(`D1 run.schema.json's regressions enum is located at properties.tasks.items.properties.verification.properties.regressions.enum and holds at least 4 values (got ${show(runEnum)})`,
    Array.isArray(runEnum) && runEnum.length >= 4);
  check(`D1 verify.schema.json's regressions enum is located at properties.regressions.enum and holds at least 4 values (got ${show(verifyEnum)})`,
    Array.isArray(verifyEnum) && verifyEnum.length >= 4);
  const bothLocated = Array.isArray(runEnum) && Array.isArray(verifyEnum);
  check(`D1 the two vocabularies are exactly equal (run ${show(runEnum)} vs verify ${show(verifyEnum)})`,
    bothLocated && show(runEnum.slice().sort()) === show(verifyEnum.slice().sort()));
  check(`D1 "error" is among the values the manifest accepts (got ${show(runEnum)})`,
    Array.isArray(runEnum) && runEnum.includes('error'));

  // A realistic task row — the shape runner/run.js actually writes — not a stub.
  // With additionalProperties:false on both the row and the verification object, a
  // two-key stub tests strictly less than the artifact that fails in the field.
  const manifestFor = (regressions) => ({
    runId: 'run-fixture',
    startedAt: '2020-01-01T00:00:00.000Z',
    finishedAt: '2020-01-01T01:00:00.000Z',
    targetRepo: 'https://example.invalid/repo-fixture.git',
    concurrency: 1,
    tasks: [{
      issueId: 'app-777',
      title: 'invented fixture task',
      outcome: 'done',
      exitCode: 0,
      branch: 'task/app-777',
      pushed: true,
      prUrl: 'https://example.invalid/pr/1',
      attempts: 1,
      pauses: 0,
      activeSeconds: 42,
      diffLines: 17,
      changeSummary: 'Invented change summary for the fixture task.',
      model: 'fixture-model',
      stuckState: 'invented stuck state text',
      specConcerns: ['invented spec concern text'],
      verification: {
        acceptance: 'pass',
        regressions,
        evidence: 'invented acceptance output tail',
      },
      attemptNotes: ['invented attempt note'],
    }],
  });
  if (Array.isArray(verifyEnum)) {
    for (const value of verifyEnum) {
      check(`D1 a realistic manifest whose task row carries regressions "${value}" is admitted by run.schema.json`,
        admit(manifestFor(value), runSchema) === true);
    }
  }

  // ==== D2 [guard]: the vocabulary is not narrowed, and the admitter can reject =====
  const verifyResult = (over) => Object.assign({
    issueId: 'app-777',
    timestamp: '2020-01-01T00:00:00.000Z',
    acceptance: 'pass',
    regressions: 'pass',
  }, over);
  check('D2 verify.schema.json still admits a result carrying regressions "error"',
    admit(verifyResult({ regressions: 'error' }), verifySchema) === true);
  check('D2 verify.schema.json still admits a result carrying acceptance "error"',
    admit(verifyResult({ acceptance: 'error', error: 'invented reason' }), verifySchema) === true);
  check('D2 an invented regressions value "aborted" is REJECTED by verify.schema.json — the enum is still closed',
    admit(verifyResult({ regressions: 'aborted' }), verifySchema) === false);
  check('D2 an invented regressions value "aborted" is REJECTED by run.schema.json, on the same path D1 admitted',
    admit(manifestFor('aborted'), runSchema) === false);

  // ==== D3 [guard]: "error" still does not downgrade a passing task =================
  let queue = null;
  try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { queue = null; }
  check('D3 runner/queue.js is require()-able in-process and exports outcomeFor',
    Boolean(queue) && typeof queue.outcomeFor === 'function');
  if (queue && typeof queue.outcomeFor === 'function') {
    const probe = (verify) => show(queue.outcomeFor(0, verify));
    check(`D3 exit 0 with regressions "error" stays done — a killed regression run is a harness fault, not a regression (got ${probe({ regressions: 'error' })})`,
      probe({ regressions: 'error' }) === show({ status: 'done', beads: 'closed' }));
    check(`D3 exit 0 with regressions "fail" is still partial (got ${probe({ regressions: 'fail' })})`,
      probe({ regressions: 'fail' }) === show({ status: 'partial', beads: 'closed' }));
    check(`D3 exit 0 with regressions "absent" stays done (got ${probe({ regressions: 'absent' })})`,
      probe({ regressions: 'absent' }) === show({ status: 'done', beads: 'closed' }));
    check(`D3 exit 0 with no verify object at all stays done (got ${probe(null)})`,
      probe(null) === show({ status: 'done', beads: 'closed' }));
  }

  // ==== D4: the drift check keeps running after this task closes ====================
  const suite = path.join(ROOT, 'scripts', 'test-schema-drift.sh');
  check('D4 scripts/test-schema-drift.sh exists — a frozen acceptance test runs once, so the recurring guard has to live where the sweep looks',
    fs.existsSync(suite));
  check('D4 its name matches the sweep\'s discovery glob scripts/test-*.sh',
    /^test-.*\.sh$/.test(path.basename(suite)));
  check('D4 the Node checker it drives exists at tests/unit/schema-drift.test.js',
    fs.existsSync(path.join(ROOT, 'tests', 'unit', 'schema-drift.test.js')));
  if (fs.existsSync(suite)) {
    // Green against the real schemas. An explicit interpreter, always.
    const green = spawnSync('bash', [suite], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    check(`D4 the suite exits 0 against the repo's real schemas/ (got ${green.status}; stderr: ${(green.stderr || '').trim().slice(0, 200)})`,
      green.status === 0);

    // Red against a planted drifted pair, through the seam. This is the half that
    // proves the new guard can fail — one that has never been observed to fail is not
    // a guard, it is a line of output.
    const planted = path.join(tmp, 'drifted-schemas');
    fs.mkdirSync(planted, { recursive: true });
    const drifted = JSON.parse(JSON.stringify(runSchema));
    const dEnum = drifted.properties.tasks.items.properties.verification.properties.regressions.enum;
    drifted.properties.tasks.items.properties.verification.properties.regressions.enum =
      dEnum.filter((v) => v !== 'error');
    fs.writeFileSync(path.join(planted, 'run.schema.json'), JSON.stringify(drifted, null, 2) + '\n');
    fs.copyFileSync(path.join(SCHEMAS, 'verify.schema.json'), path.join(planted, 'verify.schema.json'));
    const red = spawnSync('bash', [suite], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SCHEMA_DRIFT_DIR: planted.split(path.sep).join('/') },
    });
    check(`D4 the suite exits NON-ZERO against a planted pair with "error" removed from the manifest enum (got ${red.status})`,
      typeof red.status === 'number' && red.status !== 0);
    check(`D4 and it names the missing value in its output, so the failure is actionable (searched stdout+stderr for "error")`,
      /error/i.test(String(red.stdout || '') + String(red.stderr || '')));
  }

  // ==== D5 [guard]: run.schema.json is otherwise unmoved ============================
  const diff = deepDiff(runSchema, BASELINE_RUN_SCHEMA);
  check(`D5 schemas/run.schema.json deep-equals its fork-point image plus the one new enum member${diff ? ` — first difference at ${diff}` : ''}`,
    diff === null);
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
}
process.exit(failed);
