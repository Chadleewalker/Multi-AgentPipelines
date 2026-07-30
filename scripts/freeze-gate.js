#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The freeze gate — DESIGN.md §3.2, "Below the panel", move 1.
//
// A frozen acceptance test that is GREEN against the state the task starts from is
// non-discriminating by construction: it cannot detect the thing it exists to catch, and it
// passes a correct implementation, a broken one and an empty diff alike. Several criteria in
// the first real panel run were satisfied by submitting nothing at all. So before a spec is
// frozen, its tests are run against that starting state and required to be RED.
//
// WHAT "the fork point" MEANS HERE. Tests are committed to the integration branch at freeze
// (PLANNING.md step 6), and a task branch forks from that branch at run time — so the fork
// point holds the tests and NOT the implementation. That state is what this gate measures,
// and at planning time it is simply: the integration branch, with the new tests present and
// no implementation written. There is no branch to check out and nothing to reconstruct.
// This runs BEFORE any code exists, which is the only window in which the answer means
// anything.
//
// RED IS NOT ONE STATE, and this is the half that makes the gate honest rather than
// superstitious. A suite that cannot LOAD — a syntax error, a missing import, a runner that
// errors before collecting anything — exits non-zero exactly like a genuine assertion
// failure. Accepting any non-zero exit would bless a broken harness as a discriminating
// test, which is a failure this repo has already shipped once: a suite that could not
// execute its own stub reported every check as a genuine failure rather than announcing
// itself broken (CLAUDE.md, "assert the artifact is *right*, not merely present"). So the
// gate takes a second observation to compare against — a CONTROL RUN of the same command
// against an empty test directory:
//
//   real RED,  control GREEN  -> genuine red. The gate passes.
//   real GREEN                -> non-discriminating, or an unlabelled guard. The gate fails.
//   real RED,  control RED    -> the command fails even with nothing to run, so its exit code
//                                carries no signal about these tests. INDETERMINATE, reported
//                                as such and never as a pass.
//
// THE CONTROL IS A PASSING TEST, NOT AN EMPTY DIRECTORY. The first version of this gate
// probed with an empty directory, on the reasoning that it needs no per-project fixture. That
// was wrong in the worst direction: a good runner *should* fail on "no test files found" —
// silently passing on zero tests is the vacuous-success bug this repo already has a rule
// about — so the better the target's runner, the more surely the empty probe fails too, and
// the gate answers `indeterminate` for every well-built project. This repo's own
// `tools/run-acceptance.sh` does exactly that, which is how it was caught.
//
// So the control is `tests/acceptance/_control/`: one trivially-passing test, committed once
// per project at onboarding. It answers the only question the control exists to answer — can
// this command report success at all right now? — and `--control` overrides it. When no
// control directory exists the gate falls back to the empty-directory probe and SAYS SO,
// because an unavailable discriminator must announce itself rather than quietly weaken the
// verdict.
//
// GUARDS. A criterion may legitimately be green at the fork point when it asserts that
// existing behaviour still holds. Those are legal, must be labelled `[guard]` in the spec,
// and their count is reported so a spec that is all guards is visible rather than silent
// (the approval pass, PLANNING.md step 5). A pure refactor's only honest criteria are
// guards, which is why they are labelled rather than banned.
//
// NO LLM, no judgment, no network: it runs one command twice and compares two exit codes.
//
// Usage:
//   node scripts/freeze-gate.js --repo <target-repo> --tests tests/acceptance/<issue-id>/ \
//        [--spec <draft-spec-file>]
//
// Exit codes: 0 gate passed (red and discriminating), 1 gate failed (green — a spec bug),
//             2 could not run, or ran and could not discriminate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The guard marker. Case-insensitive so a draft is not failed on capitalisation; explicit
// either way, because the whole point of the exemption is that it is visible.
const GUARD = /\[guard\]/i;

// --- running the target's verifier -------------------------------------------------------

// Invoked exactly as `pipeline/verify.js` invokes it — `sh -c "<verifyCommand> <dir>"`. A
// gate that ran the command differently from the verifier would be measuring a different
// thing, and the difference would surface as a task that passed the gate and then failed the
// run for reasons the gate never saw. FREEZE_GATE_CMD replaces the configured command; that
// is the seam the suite stubs through, and it takes a `node <file.js>` stub rather than a
// shell script because `spawnSync` cannot execute a `#!/bin/sh` file on the Windows host.
function runVerify(repoRoot, verifyCommand, testDir, timeoutMs) {
  const cmd = process.env.FREEZE_GATE_CMD || verifyCommand;
  const r = spawnSync('sh', ['-c', `${cmd} ${testDir}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    // The verifier gives the suite a plain environment; inheriting this process's is the
    // closest available approximation and keeps GODOT_BIN-style host variables reachable.
    env: process.env,
  });
  return {
    // spawnSync reports a signal kill (timeout) with status null — treat that as its own
    // failure rather than coercing null to 0, which would read as a green run.
    status: r.status === null ? null : r.status,
    signal: r.signal || null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : null,
  };
}

// The conventional control: one trivially-passing test, committed once per project
// (ONBOARDING.md §2). Its whole job is to answer "can this command report success right now?"
const CONTROL_DIR = 'tests/acceptance/_control/';

// Pick the control to run against, in preference order, and say which was chosen — the
// verdict means different things depending on the answer, so the choice is never silent.
function resolveControl(repoRoot, explicit) {
  if (explicit) return { kind: 'explicit', dir: explicit.replace(/\\/g, '/') };
  const conventional = path.join(repoRoot, CONTROL_DIR);
  if (fs.existsSync(conventional) && fs.readdirSync(conventional).length > 0) {
    return { kind: 'conventional', dir: CONTROL_DIR };
  }
  return { kind: 'empty-probe', dir: null };
}

// The empty-directory fallback, used only when no control fixture exists. Created inside the
// target repo, not the system temp area: engine test runners routinely refuse a path outside
// the project (Godot's resource paths, a JS runner's rootDir), and a control that failed for
// THAT reason would report every project as indeterminate. Removed in a finally, and named so
// an interrupted run leaves something obviously disposable behind.
function withEmptyControlDir(repoRoot, fn) {
  const dir = path.join(repoRoot, `.freeze-gate-control-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fn(path.relative(repoRoot, dir).split(path.sep).join('/') + '/');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// --- the verdict --------------------------------------------------------------------------

// Pure, so the whole decision table is testable without executing anything. `real` and
// `control` are the two run results; everything else is presentation.
function verdictFor(real, control, controlKind = 'conventional') {
  if (real.error || real.signal || real.status === null) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'the verify command could not be run against the tests',
      detail: real.error || (real.signal ? `killed by ${real.signal}` : 'no exit status'),
    };
  }
  if (real.status === 0) {
    return {
      verdict: 'green',
      exit: 1,
      headline: 'the tests PASS against the fork point — they cannot detect anything',
      detail:
        'A test green before the implementation exists is satisfied by an empty diff, so it '
        + 'would pass a correct submission, a broken one and no submission at all. Either the '
        + 'criterion is not discriminating and needs rewriting, or it is a guard ("existing '
        + 'behaviour X still holds") and must be labelled [guard] in the spec.',
    };
  }
  // Real is non-zero. Only the control can say whether that means anything.
  if (control.error || control.signal || control.status === null || control.status !== 0) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'cannot tell a red test from a broken harness',
      detail: controlKind === 'empty-probe'
        // Much the likeliest cause, and it is not a defect in the project: a runner SHOULD
        // fail on "no test files found", because silently passing on zero tests is the
        // vacuous success this whole gate exists to prevent. Name the fix, not the symptom.
        ? 'The verify command also fails against an EMPTY test directory — but no control '
          + `fixture exists, so that proves nothing: a good runner is *supposed* to fail when it `
          + `finds no tests. Add ${CONTROL_DIR} holding one trivially-passing test (ONBOARDING.md `
          + '§2) and re-run; until then this gate cannot discriminate on this project.'
        : 'The verify command fails even against the control, which is a test known to pass. '
          + 'So its non-zero exit carries no information about these tests specifically — the '
          + 'harness is broken independently of the spec. Fix it before reading anything into '
          + 'the red.',
    };
  }
  return {
    verdict: 'red',
    exit: 0,
    headline: 'the tests FAIL against the fork point, and the harness reports green on the control',
    detail: 'The tests discriminate: they can detect the thing they exist to catch.',
  };
}

// --- guards ---------------------------------------------------------------------------------

// Counted from the spec text rather than inferred: an exemption the tool works out for itself
// is an exemption nobody sees. Reported even when zero, because "0 guards" in the approval
// pass is the evidence that none were quietly assumed.
function guardCount(specText) {
  const lines = String(specText).split(/\r?\n/);
  const guards = [];
  lines.forEach((line, i) => {
    if (GUARD.test(line)) guards.push({ line: i + 1, text: line.trim().slice(0, 160) });
  });
  return guards;
}

// --- CLI --------------------------------------------------------------------------------------

function main(argv) {
  let repo = null; let tests = null; let spec = null; let controlArg = null; let timeoutMs = 600000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') repo = argv[++i];
    else if (a === '--tests') tests = argv[++i];
    else if (a === '--spec') spec = argv[++i];
    else if (a === '--control') controlArg = argv[++i];
    else if (a === '--timeout') timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else { console.error(`freeze-gate: unexpected argument ${a}`); return 2; }
  }
  if (!repo || !tests) { usage(); return 2; }

  const repoRoot = path.resolve(repo);
  let verifyCommand;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pipeline.config.json'), 'utf8'));
    verifyCommand = cfg.verifyCommand;
    if (!verifyCommand && !process.env.FREEZE_GATE_CMD) {
      console.error('freeze-gate: verifyCommand missing from pipeline.config.json');
      return 2;
    }
  } catch (e) { console.error(`freeze-gate: ${e.message}`); return 2; }

  const testPath = path.join(repoRoot, tests);
  if (!fs.existsSync(testPath)) {
    console.error(`freeze-gate: no such test directory: ${tests}`);
    return 2;
  }

  // Guards first: they are reported whatever the run does, because the count belongs in the
  // approval pass either way.
  let guards = [];
  if (spec) {
    try { guards = guardCount(fs.readFileSync(spec, 'utf8')); }
    catch (e) { console.error(`freeze-gate: ${e.message}`); return 2; }
  }

  const real = runVerify(repoRoot, verifyCommand, tests, timeoutMs);
  const chosen = resolveControl(repoRoot, controlArg);
  const control = chosen.dir
    ? runVerify(repoRoot, verifyCommand, chosen.dir, timeoutMs)
    : withEmptyControlDir(repoRoot, (dir) => runVerify(repoRoot, verifyCommand, dir, timeoutMs));
  const v = verdictFor(real, control, chosen.kind);

  const CONTROL_LABEL = {
    conventional: `${CONTROL_DIR} — one passing test`,
    explicit: `${chosen.dir} — supplied with --control`,
    'empty-probe': 'empty directory — NO control fixture, this discriminator is weak',
  };
  console.log(`freeze-gate: ${tests}`);
  console.log(`  real run     exit ${fmtStatus(real)}`);
  console.log(`  control run  exit ${fmtStatus(control)}   (${CONTROL_LABEL[chosen.kind]})`);
  console.log('');
  console.log(`${v.verdict.toUpperCase()}: ${v.headline}`);
  console.log(wrap(v.detail));
  if (spec) {
    console.log('');
    console.log(`guards declared: ${guards.length}`);
    for (const g of guards) console.log(`  ${spec}:${g.line}  ${g.text}`);
  }
  if (v.verdict !== 'red' && (real.stderr || '').trim()) {
    console.log('');
    console.log('last stderr from the real run:');
    console.log(String(real.stderr).trim().split(/\r?\n/).slice(-8).map((l) => `  ${l}`).join('\n'));
  }
  return v.exit;
}

const fmtStatus = (r) =>
  (r.error ? `— (${r.error})` : r.signal ? `— (killed by ${r.signal})` : String(r.status));

const wrap = (s) => String(s).replace(/(.{1,86})(\s|$)/g, '$1\n').trimEnd();

function usage() {
  console.log('usage: node scripts/freeze-gate.js --repo <target-repo> \\');
  console.log('         --tests tests/acceptance/<issue-id>/ [--spec <draft>] [--timeout <s>]');
}

module.exports = {
  verdictFor, guardCount, runVerify, withEmptyControlDir, resolveControl, CONTROL_DIR, main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
