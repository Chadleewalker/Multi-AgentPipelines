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
// RED IS ONLY HALF THE PROOF, and this is the half `--green` adds. A suite that is red at the
// fork point and a suite whose own fixture is broken are THE SAME OBSERVATION — non-zero — so
// everything above can be satisfied by a suite no implementation can ever turn green. That has
// cost two tasks three attempts each: one froze with 11 of 29 checks unreachable because a
// preload stub killed the child process before its first line, and one froze with the criterion
// the task existed for calling `git init -q -c …`, where `-c` must precede the subcommand, so no
// repository was ever created and two neighbouring checks passed VACUOUSLY. Both were diagnosed
// by the task agent through the spec-concern channel; neither was visible to this gate.
//
// So the gate takes a THIRD and FOURTH observation when it is given a probe:
//
//   --green <dir>  a repo-shaped tree in which the criteria are ALREADY SATISFIED, by any means
//                  however crude. A throwaway probe, never an implementation.
//
//   real RED, control GREEN, probe GREEN, probe control GREEN -> red.          exit 0
//   real RED, control GREEN, probe RED,   probe control GREEN -> unreachable.  exit 3
//   real RED, control GREEN, probe control NOT green          -> indeterminate.exit 2
//   real RED, control GREEN, no probe                         -> half-proven.  exit 4
//
// `half-proven` PROCEEDS — a freeze with no probe stays legal, and the state is carried into the
// approval pass the way the guard count is. `unreachable` does not: it is the finding the probe
// exists to produce. A BROKEN probe is never `unreachable`; exit 3 is reachable only when the
// probe's own control comes back green, because otherwise the probe's red says nothing about the
// criteria, exactly as the fork-point control says nothing when it fails.
//
// WHAT A PROBE IS. A repo-shaped TREE, not a handful of files: every frozen suite resolves its
// own root as `path.resolve(__dirname, '..', '..', '..')` — the tree it SITS IN, never the
// working directory — and `verifyCommand` is a path relative to cwd. So a probe carries the
// project's acceptance-test runner at the same relative path, `tests/acceptance/<id>/`, and
// `tests/acceptance/_control/` if the project has one. A directory holding only the criteria's
// artifacts yields "no test files" and a FALSE `unreachable`.
//
// GUARDS. A criterion may legitimately be green at the fork point when it asserts that
// existing behaviour still holds. Those are legal, must be labelled `[guard]` in the spec,
// and their count is reported so a spec that is all guards is visible rather than silent
// (the approval pass, PLANNING.md step 5). A pure refactor's only honest criteria are
// guards, which is why they are labelled rather than banned.
//
// A STALE GUARD IS ITS OWN VERDICT (DESIGN.md §3.2, change-log rows `stale-guard-design`
// and `repo-i4b`). The exemption above is what makes the suite-level red honest — a guard
// file is *supposed* to be green at the fork point, so its green cannot be read as
// non-discriminating. But that cuts both ways, and the other edge had no name until now: a
// guard that is RED before any work exists is not a criterion waiting to be satisfied, it is
// a pin that has ALREADY MOVED. Four of the twelve suites that reached `stuck` in one
// fortnight were exactly that — "flight unchanged", "keys untouched", "content not code",
// each pinned to a number, a key or a file that had changed before the task was frozen. The
// suite-level red says nothing about them: one ordinary criterion failing makes the whole
// run non-zero, and the stale guard hides inside it.
//
// So a test file that DECLARES ITSELF a guard — the literal `[guard]` token, any case, on a
// comment line within its first ten lines, the same word the spec uses — is run ALONE
// against the fork point and must be green there:
//
//   real RED, control GREEN, guard subset RED -> stale-guard.  exit 5
//
// It beats `half-proven`, `red` and `unreachable`, and it short-circuits the probe: a stale
// pin is a fact about the fork point, and no probe result can change what it means. A guard
// subset that could not RUN — exit above 1, a kill, a failed spawn — is `indeterminate` and
// names the guard side, on exactly the reasoning that makes a broken probe `indeterminate`
// rather than `unreachable`.
//
// NO LLM, no judgment, no network: it runs one command two or four times and compares exit codes.
//
// Usage:
//   node scripts/freeze-gate.js --repo <target-repo> --tests tests/acceptance/<issue-id>/ \
//        [--green <probe-dir>] [--spec <draft-spec-file>]
//
// Exit codes: 0 gate passed (red at the fork point, green in the probe), 1 gate failed (green —
//             a spec bug), 2 could not run, or ran and could not discriminate, 3 the criteria
//             were red in the probe too — they may be unreachable, 4 red but half-proven: no
//             probe was supplied, so the green side has never been seen, 5 a `[guard]` test
//             file is red at the fork point — a stale pin, and never a pass.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The capture ceiling, IMPORTED rather than retyped. `runVerify` had none, so Node's 1 MiB
// default applied and `spawnSync` KILLED the child on overflow — and a passing probe is verbose
// by definition, so change-log row `verify-nobuffer` was recurring inside the gate that judges
// the freeze. One value, one file: two copies of a limit drift silently and unattended.
const { MAX_BUFFER } = require('../pipeline/verify-classify.js');

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
    // The verifier's own ceiling, imported from the module that owns it. Without it Node's
    // 1 MiB default applies and a suite is killed for being LOUD — which reads as a red run
    // that never happened, and a green probe is the loudest run this tool ever takes.
    maxBuffer: MAX_BUFFER,
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
// `root` is a parameter rather than "the target repo" because a probe is a repo-shaped tree
// with a control of its own, resolved by exactly this rule against exactly that tree: a probe
// judged by the target's control would be judged by a harness it does not use.
function resolveControl(root, explicit) {
  if (explicit) return { kind: 'explicit', dir: explicit.replace(/\\/g, '/') };
  const conventional = path.join(root, CONTROL_DIR);
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
// The name carries a per-call counter as well as the pid. Keyed on the pid alone it was a
// single name per process, and the gate now makes this call twice — once per tree. When the
// two trees are the same tree (a probe built in place, or a suite that points both at one
// fixture) the second call's `finally` deletes the first call's directory out from under it,
// and the fork-point control silently probes a path that no longer exists.
let controlDirSeq = 0;
function withEmptyControlDir(root, fn) {
  controlDirSeq += 1;
  const dir = path.join(root, `.freeze-gate-control-${process.pid}-${controlDirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fn(path.relative(root, dir).split(path.sep).join('/') + '/');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The guard subset's scratch directory — the same shape as `withEmptyControlDir` above, and
// for the same reasons, which is why it is a mirror of it rather than a second idea. It is
// created INSIDE the target tree, as a SIBLING of the suite: a frozen test resolves its own
// root as `path.resolve(__dirname, '..', '..', '..')` — the tree it sits in — so a guard file
// judged from anywhere else in the filesystem would resolve a different root and fail for a
// reason that has nothing to do with the pin it holds. Sibling and same depth is the only
// placement where a guard file sees exactly the tree it saw in the suite.
//
// Named with the pid AND a per-call counter for the reason recorded on `withEmptyControlDir`:
// a name keyed on the pid alone is one name per process, and two calls in one process would
// have the second's `finally` delete the first's directory out from under it.
//
// The handed-back path is repo-relative POSIX, exactly as `tests` is: an absolute path into
// the tree would be a path the project's runner is entitled to refuse, and the whole point of
// running the subset through `verifyCommand` is that it is judged by the harness the task
// will really be judged by.
let guardDirSeq = 0;
function withGuardDir(root, suiteDir, names, fn) {
  guardDirSeq += 1;
  const dir = path.join(path.resolve(suiteDir, '..'), `.freeze-gate-guards-${process.pid}-${guardDirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Copied, never linked or moved: the fork-point suite is about to be committed and
    // frozen, and the subset run must judge the same bytes the freeze will carry.
    for (const n of names) fs.copyFileSync(path.join(suiteDir, n), path.join(dir, n));
    return fn(path.relative(root, dir).split(path.sep).join('/') + '/');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// One side of the gate: the suite and its control, in ONE tree. Called once for the fork point
// and once for the probe, with the SAME repo-relative `tests` string both times — never an
// absolute path into the probe. The comment on `withEmptyControlDir` above records why: engine
// runners routinely refuse a path outside the project, which is why the empty-directory
// fallback is built inside the tree rather than in the temp area, and a probe handed an
// absolute path would be running a suite that sits outside the project it is being judged in.
function runSide(root, verifyCommand, tests, timeoutMs, controlArg) {
  const suite = runVerify(root, verifyCommand, tests, timeoutMs);
  const chosen = resolveControl(root, controlArg);
  const control = chosen.dir
    ? runVerify(root, verifyCommand, chosen.dir, timeoutMs)
    : withEmptyControlDir(root, (dir) => runVerify(root, verifyCommand, dir, timeoutMs));
  return { suite, control, chosen };
}

// --- the probe's copy of the suite ------------------------------------------------------------
//
// The probe runs `<probe>/tests/acceptance/<id>/`, which is a copy of the very suite being
// frozen — so a probe author can make the criteria "pass" by editing the TEST rather than the
// tree, and the gate would bless the freeze it exists to prevent. Every file under the suite
// directory is hashed, byte for byte, in name order, and the two trees are compared BEFORE any
// probe run.
function digestSuite(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return null;
  const files = new Map();
  (function visit(abs) {
    let entries;
    try { entries = fs.readdirSync(abs).sort(); } catch { return; }
    for (const e of entries) {
      const p = path.join(abs, e);
      let s;
      try { s = fs.statSync(p); } catch { continue; }
      if (s.isDirectory()) { visit(p); continue; }
      const rel = path.relative(dir, p).split(path.sep).join('/');
      let sha;
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
      catch { sha = 'unreadable'; }
      files.set(rel, sha);
    }
  }(dir));
  return files;
}

// Returns the difference in the probe's favour-free form: what the fork point has that the probe
// does not, and what both have but spelled differently.
function compareSuites(forkDir, probeDir) {
  const fork = digestSuite(forkDir);
  const probe = digestSuite(probeDir);
  if (!probe) return { probeMissing: true, absent: [], differing: [], extra: [] };
  const absent = [];
  const differing = [];
  for (const [rel, sha] of (fork || new Map())) {
    if (!probe.has(rel)) absent.push(rel);
    else if (probe.get(rel) !== sha) differing.push(rel);
  }
  const extra = [...probe.keys()].filter((rel) => !(fork || new Map()).has(rel)).sort();
  return { probeMissing: false, absent: absent.sort(), differing: differing.sort(), extra };
}

// --- the verdict --------------------------------------------------------------------------

// Pure, so the whole decision table is testable without executing anything. `real` and
// `control` are the fork point's two run results, `probe` and `probeControl` the probe's —
// `probe === null` means no `--green` was given. Everything else is presentation.
//
// A run that was KILLED, or never started, is not evidence of anything on either side.
const brokenRun = (r) => !r || r.error || r.signal || r.status === null || typeof r.status !== 'number';
const whyBroken = (r) => (!r ? 'no result at all'
  : r.error || (r.signal ? `killed by ${r.signal}` : 'no exit status'));

// `guard` is the guard subset's run — the `[guard]` files of the suite, run ALONE against the
// fork point — and `guard === null` means there were none, or the fork point was never in the
// state that makes the question meaningful. It defaults to null so every five-argument caller
// keeps its exact answer: guard-absent and guard-green are the same row, which is what lets
// the frozen `repo-inj` suite go on meaning what it meant.
function verdictFor(real, control, controlKind = 'conventional', probe = null, probeControl = null,
  guard = null) {
  if (brokenRun(real)) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'the verify command could not be run against the tests at the fork point',
      detail: whyBroken(real),
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
  // Real is non-zero — but WHICH non-zero. By near-universal convention a test runner exits 1
  // when tests fail and 2 or more when it could not run them: a parse error, a missing import,
  // no tests collected. The control cannot separate those, because it only proves the harness
  // works on OTHER tests — a suite whose own script fails to load leaves the control perfectly
  // green. Caught by exactly that: a frozen suite with a GDScript parse error exited 2 against a
  // green control, and this gate called it RED. It was never discriminating; it never ran.
  //
  // So anything above 1 is indeterminate unless a project says otherwise. Costs a false
  // indeterminate on a runner that uses 2 for ordinary failure; that direction is the safe one,
  // because it refuses to bless rather than refusing to notice.
  // Exit 1: a genuine test failure. Only the control can say whether the harness was working.
  if (brokenRun(control) || control.status !== 0) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'cannot tell a red test from a broken harness at the fork point',
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
  if (real.status > 1) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: `the tests exited ${real.status} at the fork point, which is "could not run", not "failed"`,
      detail:
        'A runner exits 1 when tests fail and 2 or more when it could not run them — a parse '
        + 'error, a missing import, no tests collected. The control is green, so the harness '
        + 'itself is fine: it is THIS suite that did not execute. Red proves nothing until the '
        + 'suite runs, so fix the suite and re-run. (If this project genuinely uses this code for '
        + 'ordinary test failure, the gate needs to be told so.)',
    };
  }

  // Red at the fork point, on a harness proven to work there. That is half the proof, and
  // everything below is the other half.

  // The guard subset comes FIRST of everything below, and the order is the verdict: a stale
  // pin beats `half-proven`, `red` and `unreachable` alike, because it is a fact about the
  // fork point and no probe result can change what it means. Above this line nothing is
  // reached — a green fork point is still `green`, a broken harness is still `indeterminate`,
  // and a suite that exited 2 still did not run — because in every one of those states the
  // suite-level observation is already uninterpretable and the guard's would be too.
  if (guard) {
    if (brokenRun(guard) || guard.status > 1) {
      return {
        verdict: 'indeterminate',
        exit: 2,
        headline: 'cannot judge the guard subset: the [guard] files were never run at the fork point',
        detail:
          `The broken side is the guard subset. ${brokenRun(guard) ? whyBroken(guard) : `It exited ${guard.status}, which is "could not run", not "failed"`}. `
          + 'The suite\'s own control is green, so the harness works — it is this subset that did '
          + 'not execute, and a guard that was never run cannot be called stale any more than a '
          + 'broken probe can be called unreachable. Most often the subset is not self-contained: '
          + 'a guard file that imports a helper from its own suite directory sees only itself in '
          + 'here. Fix it and re-run; until then the guard side carries no information.',
      };
    }
    if (guard.status !== 0) {
      return {
        verdict: 'stale-guard',
        exit: 5,
        headline: 'a [guard] test is RED at the fork point — it pins behaviour that is already gone',
        detail:
          'A guard says "existing behaviour X still holds", so it is the one kind of criterion '
          + 'that is SUPPOSED to be green before any work exists. Red here cannot mean the '
          + 'implementation is missing — there is nothing for it to be waiting for. It means the '
          + 'pin has already moved: the number, the key or the file it names changed before this '
          + 'task was ever frozen. Four of the twelve suites that reached `stuck` in one fortnight '
          + 'were exactly this. Never a pass, and never fixable during a run — a frozen test is '
          + 'not editable in a container. Re-read the guard against the tree as it is now and '
          + 'either re-pin it or drop the criterion, then re-run the gate.',
      };
    }
  }

  if (probe === null) {
    return {
      verdict: 'half-proven',
      exit: 4,
      headline: 'the tests FAIL at the fork point — but nothing here has ever seen them PASS',
      detail:
        'Red alone cannot tell a discriminating suite from one whose own fixture is broken: '
        + 'both are non-zero. Two tasks have burned three attempts each on suites that were red '
        + 'for the wrong reason and could never have gone green. Re-run with --green <probe-dir> '
        + 'against a repo-shaped tree in which the criteria are already satisfied, by any means '
        + 'however crude. This is not a refusal: a freeze with no probe is legal and PROCEEDS. '
        + 'Carry the half-proven state into the approval pass the way the guard count is carried, '
        + 'so it is visible rather than assumed.',
    };
  }
  // The probe's control first, for the same reason the fork point's comes first: a probe whose
  // harness cannot report success at all says nothing about the criteria. A BROKEN PROBE IS
  // NEVER `unreachable` — exit 3 is reachable only from here on.
  if (brokenRun(probeControl) || probeControl.status !== 0) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'cannot judge the probe: the verify command fails against the PROBE\'S control',
      detail:
        'The broken side is the probe, not the tests and not the fork point. Its control is a '
        + 'test known to pass, so a probe that fails it is malformed — most often it is not '
        + 'repo-shaped: a probe must carry the project\'s test runner at the same relative path '
        + 'and a control directory of its own, not only the criteria\'s artifacts. Until that is '
        + 'fixed the probe\'s red carries no information, and calling it unreachable would blame '
        + 'the spec for the probe\'s bug.',
    };
  }
  if (brokenRun(probe)) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: 'cannot judge the probe: the verify command could not be run against the probe\'s suite',
      detail: `The broken side is the probe. ${whyBroken(probe)}`,
    };
  }
  if (probe.status > 1) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: `the probe's suite exited ${probe.status}, which is "could not run", not "failed"`,
      detail:
        'The broken side is the probe. Its control is green, so the probe\'s harness works — it '
        + 'is the suite\'s copy inside the probe that did not execute, which is a fact about the '
        + 'probe tree and not about the criteria. Fix the probe and re-run.',
    };
  }
  if (probe.status !== 0) {
    return {
      verdict: 'unreachable',
      exit: 3,
      headline: 'the tests fail in the PROBE too — one or more criteria may be unreachable',
      detail:
        'The probe\'s control is green, so the probe\'s harness works; the criteria simply did '
        + 'not pass in a tree where they are supposed to be satisfied already. Either the probe '
        + 'does not really satisfy them, or the suite contains checks no implementation can ever '
        + 'reach — 11 of 29 in one frozen suite, and in another the criterion the task existed '
        + 'for, whose fixture called `git init -q -c …` and never created a repository at all. '
        + 'This is not a pass. Fix whichever it is before freezing.',
    };
  }
  return {
    verdict: 'red',
    exit: 0,
    headline:
      'the tests FAIL against the fork point and PASS in the probe, on controls green in both trees',
    detail:
      'The tests discriminate in both directions: they can detect the thing they exist to catch, '
      + 'and something exists that turns every one of them green.',
  };
}

// --- the brittleness lint (DESIGN.md §3.2, "below the panel", move 6) -----------------------
//
// The exit-code gate above answers one question — are these tests red at the fork point? — and
// an entire class of bad frozen test answers it correctly and then goes red again for every
// later task that legitimately grows the thing it enumerated. One target repo has lost at
// least eight frozen files across six suites to that shape, and the worst of them INVERTS: it
// goes red precisely because an unrelated later task did its job correctly.
//
// THE RULE THE FOUR SHAPES ARE INSTANCES OF. Hashing and enumerating are not what makes a
// guard brittle — this repo's own frozen suites do both, correctly. Six of them hash a walked
// tree as the house "writes nothing" guard, and `repo-1cy` diffs against a merge-base in the
// way CLAUDE.md cites as CORRECT. What those seven have in common is what makes them safe:
// they compare two values COMPUTED IN THE SAME RUN, and nothing later work does can change a
// before/after snapshot. So:
//
//   A guard is brittle when the EXPECTED SIDE of the assertion is a literal the author typed,
//   and the population it describes is one later work is licensed to grow.
//
// A tool can check the first half exactly. It cannot check the second half at all — that is
// the human's question, and it is why every finding below is phrased as one. The pass DECIDES
// NOTHING: it never touches the exit code (0/1/2 are a verdict `PLANNING.md` step 4 branches
// on, and a lint that can fail a freeze is a gate on spec *authoring*, whose only defeat is
// rewording until it passes — hard rule 5), and each finding takes a disposition in the
// planning draft the way a critic's does.
//
// LANGUAGE SCOPE IS STATED, NOT ASSUMED. The patterns are line-oriented and written against
// JavaScript, GDScript, Python and shell syntax. Anything else is best-effort.
//
// COMMENTS AND STRING LITERALS ARE LINTED, deliberately: a commented-out brittle assertion is
// a brittle assertion someone will uncomment.

// Read allowlist and the binary sniff. A file outside the allowlist is SKIPPED BY NAME rather
// than read, and so is one carrying a NUL byte — `fs.readFileSync(p, 'utf8')` does not throw
// on binary input, it returns replacement characters, so linting it would produce confident
// nonsense instead of an honest skip.
const LINT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.gd', '.py', '.sh', '.bash',
]);
const BINARY_SNIFF_BYTES = 8192;

// The questions. These ARE the deliverable — the tool surfaces candidates and the human
// answers — so each names its own shape and asks the one thing no tool can settle.
const QUESTIONS = {
  'literal-name-list':
    'literal-name-list: the expected side is a list of names typed by hand — is later work '
    + 'licensed to add one, and would this test then go red for doing its job?',
  'literal-count':
    'literal-count: this pins a population at an exact size — is later work licensed to grow '
    + 'it, and is the count the thing the criterion is really about?',
  'literal-digest':
    'literal-digest: a digest is compared against a literal typed into the test — is every '
    + 'byte under that hash frozen for good, or would a legitimate later change move it?',
  'branch-self-diff':
    'branch-self-diff: this diffs against the integration branch, so it sees every later '
    + "task's work — is that intended, or will it go red for changes this task never made?",
};

// Continuation joining. A brittle assertion split across lines must still be found, and it is
// reported at the line the assertion STARTS on. Only `(` and `[` are counted: a trailing `{`
// is an ordinary block opener and joining on it would swallow the next line of every function.
// Quoted spans are blanked first so a bracket inside a string cannot unbalance a line.
const MAX_CONTINUATION_LINES = 3;
const blankStrings = (s) => String(s).replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '""');
function opensMoreThanItCloses(line) {
  const s = blankStrings(line);
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
  }
  return depth > 0;
}
function windowAt(lines, i) {
  let text = lines[i];
  let j = i;
  let taken = 0;
  while (taken < MAX_CONTINUATION_LINES && j + 1 < lines.length && opensMoreThanItCloses(text)) {
    j += 1; taken += 1;
    text = `${text} ${String(lines[j]).trim()}`;
  }
  return text;
}

// An assertion of ANY kind, and an assertion of EQUALITY specifically. `require` is
// deliberately absent: `require('fs')` is on the first line of nearly every file here, and a
// token that common turns the assertion test into no test at all.
// The second alternative is Python's and shell's statement form, `assert len(rows) == 12`,
// which has no parentheses to key on. It is anchored at the start of the line (optionally
// behind a comment marker) so that prose merely CONTAINING the word — "this used to assert
// deepStrictEqual against a whole list of names" — is not read as an assertion.
const ASSERT_ANY =
  /(?:\b(?:assert\w*|expect\w*|check\w*|should\w*|verif\w*)\s*[.(])|(?:^\s*(?:\/\/|#|--)?\s*assert\s+\S)/im;
const ASSERT_EQ =
  /\b(assert_eq\w*|assert_equals?|assertEquals?|strictEqual|deepStrictEqual|deepEqual|equals?|toEqual|toBe|toStrictEqual|is_equal)\s*\(/i;
const EQUALITY_OP = /===|!==|==(?!=)|!=/;
const isEqualityAssertion = (t) => ASSERT_EQ.test(t) || (ASSERT_ANY.test(t) && EQUALITY_OP.test(t));

// literal-name-list — an array (or object-key) literal of two or more STRING elements on the
// expected side of an equality assertion. The assertion is what separates it from a literal
// list used as an INPUT: `path.join('tests', 'acceptance', 'demo')` enumerates nothing anyone
// will grow, and neither does `const FIXTURE_FILES = ['a.js', 'b.js']`.
const STRING_ARRAY = /\[\s*(?:['"][^'"\n]*['"]\s*,\s*)+['"][^'"\n]*['"]\s*,?\s*\]/;
const STRING_KEY_OBJECT = /\{\s*(?:['"][^'"\n]*['"]\s*:\s*[^,{}\n]*,\s*)+['"][^'"\n]*['"]\s*:/;

// literal-count — a `.length` / `.size()` / `len()` / `count` compared by STRICT EQUALITY to
// an integer literal >= 2. `> 0`, `>= 1` and `!== 0` describe a population without pinning it,
// and `=== 0` / `=== 1` are almost never a catalogue.
const COUNTER = '(?:\\.length\\b|\\.size\\s*\\(\\s*\\)|\\.size\\b|\\blen\\s*\\([^()]*\\)|\\.count\\b|\\bcount\\s*\\(\\s*\\))';
const COUNT_AS_ARGUMENT = new RegExp(`${COUNTER}\\s*,\\s*(\\d+)\\b`, 'g');
const COUNT_BY_OPERATOR = new RegExp(`${COUNTER}\\s*(?:===|==)\\s*(\\d+)\\b`, 'g');
const COUNT_BY_OPERATOR_REVERSED = new RegExp(`\\b(\\d+)\\s*(?:===|==)\\s*[A-Za-z_$][\\w$.]*${COUNTER}`, 'g');
function anyCatalogueCount(re, text) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (Number(m[1]) >= 2) return true;
  }
  return false;
}

// literal-digest — a hash compared against a STRING LITERAL. Two computed digests compared to
// each other are the house snapshot guard in six of this repo's own frozen suites and must
// never fire, which is exactly what requiring the literal buys.
const DIGEST_TOKEN = /(sha1|sha256|sha512|md5|hash|digest|checksum|crc32|fingerprint)/i;
const HEX_STRING_LITERAL = /(['"])[0-9a-fA-F]{8,}\1/;

// branch-self-diff — a `git diff` / `git merge-base` naming the INTEGRATION branch. Git
// against refs the test created itself in a throwaway repository is `repo-1cy`, and correct.
const GIT_INVOCATION = /\bgit\b/;
const GIT_HISTORY_VERB = /\b(diff|merge-base|merge_base)\b/;
const REMOTE_REF = /\b(?:origin|upstream)\//;
const DEFAULT_INTEGRATION_BRANCHES = ['main', 'master', 'develop', 'trunk'];
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namesIntegrationBranch(text, opts) {
  if (REMOTE_REF.test(text)) return true;
  const names = DEFAULT_INTEGRATION_BRANCHES.slice();
  if (opts && opts.defaultBranch) names.push(String(opts.defaultBranch));
  return names.some((b) => new RegExp(`(^|['"\\s])${escapeRe(b)}(['"\\s.]|$)`).test(text));
}

// The registry. Order here is presentation only: a line matching two shapes yields two
// findings, one each, because a precedence rule would hide the second reason it is brittle.
const SHAPE_RULES = [
  ['literal-name-list', (t) => isEqualityAssertion(t)
    && (STRING_ARRAY.test(t) || STRING_KEY_OBJECT.test(t))],
  ['literal-count', (t) =>
    (ASSERT_EQ.test(t) && anyCatalogueCount(COUNT_AS_ARGUMENT, t))
    || (ASSERT_ANY.test(t) && (anyCatalogueCount(COUNT_BY_OPERATOR, t)
      || anyCatalogueCount(COUNT_BY_OPERATOR_REVERSED, t)))],
  ['literal-digest', (t) => ASSERT_ANY.test(t)
    && DIGEST_TOKEN.test(t) && HEX_STRING_LITERAL.test(t)],
  ['branch-self-diff', (t, opts) => GIT_INVOCATION.test(t)
    && GIT_HISTORY_VERB.test(t) && namesIntegrationBranch(t, opts)],
];

// Pure over text, so every shape is testable without touching a filesystem. `file` is echoed
// back verbatim — the caller decides how a path is spelled, and the CLI spells it
// suite-relative, matching how `guards declared:` prints the spec path it was handed.
function brittleFindings(text, file, opts) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const window = windowAt(lines, i);
    for (const [shape, fires] of SHAPE_RULES) {
      if (fires(window, opts)) {
        findings.push({
          file,
          line: i + 1,
          shape,
          text: String(lines[i]).trim(),
          question: QUESTIONS[shape],
        });
      }
    }
  }
  return findings;
}

// Walk the suite. Every path that is not linted is NAMED with a reason from a pinned
// vocabulary — `binary`, `extension`, `unreadable` — because an unavailable discriminator that
// stays quiet is indistinguishable from a clean one.
function lintSuite(dirOrFile, opts) {
  const root = path.resolve(dirOrFile);
  const rootIsDir = fs.statSync(root).isDirectory();
  const base = rootIsDir ? root : path.dirname(root);
  const rel = (abs) => path.relative(base, abs).split(path.sep).join('/') || path.basename(abs);

  const findings = [];
  const skipped = [];
  (function visit(abs) {
    let st;
    try { st = fs.statSync(abs); } catch { skipped.push({ path: rel(abs), reason: 'unreadable' }); return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(abs).sort(); }
      catch { skipped.push({ path: rel(abs), reason: 'unreadable' }); return; }
      for (const e of entries) visit(path.join(abs, e));
      return;
    }
    if (!LINT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      skipped.push({ path: rel(abs), reason: 'extension' });
      return;
    }
    let buf;
    try { buf = fs.readFileSync(abs); }
    catch { skipped.push({ path: rel(abs), reason: 'unreadable' }); return; }
    if (buf.slice(0, BINARY_SNIFF_BYTES).includes(0)) {
      skipped.push({ path: rel(abs), reason: 'binary' });
      return;
    }
    findings.push(...brittleFindings(buf.toString('utf8'), rel(abs), opts));
  }(root));

  return { findings, skipped };
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

// A guard FILE declares itself, in its own text, and the declaration is deliberately narrow.
//
// WHY A COMMENT LINE, AND WHY THE FIRST TEN. The token has to be somewhere a reader opening
// the file sees it without scrolling, because the whole value of the exemption is that it is
// visible — and it has to be somewhere no ordinary code puts it by accident. A string literal
// is not that place: `const G = '[guard]'` is a test ABOUT guards, and this repo's own suites
// are full of them (this scanner's own fixtures included). A ten-line header window and a
// comment marker together make the declaration deliberate: nothing lands there by accident,
// and nothing that lands there is hard to find.
//
// TOP-LEVEL ONLY, and the same read allowlist and NUL sniff the lint uses. A file the lint
// refuses to read is a file this cannot read either — `fs.readFileSync(p, 'utf8')` does not
// throw on binary input, it returns replacement characters, so a `[guard]` "found" in a PNG
// is confident nonsense. Nested files are out because the subset is a FLAT directory: a guard
// file is copied to a sibling of the suite and run alone, and a file that needed its own
// subdirectory around it would be judged in a shape it never had.
const GUARD_HEADER_LINES = 10;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|--)/;

function guardFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!LINT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(dir, entry.name)); } catch { continue; }
    if (buf.slice(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    // `\r?\n`, not `\n`: the reference host's working copy is CRLF and every container sees
    // LF, so the line count and the line text both have to say which they mean.
    const header = buf.toString('utf8').split(/\r?\n/).slice(0, GUARD_HEADER_LINES);
    if (header.some((line) => COMMENT_LINE.test(line) && GUARD.test(line))) found.push(entry.name);
  }
  return found.sort();
}

// --- CLI --------------------------------------------------------------------------------------

function main(argv) {
  let repo = null; let tests = null; let spec = null; let controlArg = null; let timeoutMs = 600000;
  let green = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') repo = argv[++i];
    else if (a === '--tests') tests = argv[++i];
    else if (a === '--spec') spec = argv[++i];
    else if (a === '--control') controlArg = argv[++i];
    else if (a === '--timeout') timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--green') {
      // A flag with no value and a flag with an EMPTY value are different mistakes and get
      // different sentences: the first is a truncated command line, the second is usually a
      // shell variable that expanded to nothing, which is the one that looks fine on screen.
      if (i + 1 >= argv.length) {
        console.error('freeze-gate: --green was given no value (arguments) — pass the probe directory: --green <probe-dir>');
        return 2;
      }
      green = argv[++i];
    } else if (a === '-h' || a === '--help') { usage(); return 0; }
    else { console.error(`freeze-gate: unexpected argument ${a}`); return 2; }
  }
  if (!repo || !tests) { usage(); return 2; }

  // The probe path is checked before anything is run, and every refusal NAMES IT. An
  // exit-code-only refusal is indistinguishable from the `unexpected argument` this flag used
  // to hit — same code, no information — so the path is what the message is about.
  let probeRoot = null;
  if (green !== null) {
    if (String(green).trim() === '') {
      console.error('freeze-gate: --green was given an empty value (arguments) — a probe directory is required, or omit the flag');
      return 2;
    }
    probeRoot = path.resolve(green);
    let st = null;
    try { st = fs.statSync(probeRoot); } catch { st = null; }
    if (!st) {
      console.error(`freeze-gate: --green probe directory does not exist: ${green}`);
      return 2;
    }
    if (!st.isDirectory()) {
      console.error(`freeze-gate: --green probe path is not a directory: ${green}`);
      return 2;
    }
  }

  const repoRoot = path.resolve(repo);
  let verifyCommand;
  let defaultBranch = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pipeline.config.json'), 'utf8'));
    verifyCommand = cfg.verifyCommand;
    defaultBranch = cfg.defaultBranch || null;
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

  // The probe's copy of the suite, compared BEFORE any probe run — so this refusal WINS over
  // the broken-probe verdict when both would apply, which is the point: a probe that edited the
  // tests is not a probe that failed, it is a probe that changed the question.
  let suiteDiff = null;
  if (probeRoot) {
    suiteDiff = compareSuites(testPath, path.join(probeRoot, tests));
    if (suiteDiff.probeMissing) {
      console.error(`freeze-gate: the probe does not carry the suite at ${tests} (probe) — ${probeRoot}`);
      console.error('freeze-gate: a probe is a REPO-SHAPED TREE: the project\'s test runner at the same');
      console.error('freeze-gate: relative path, tests/acceptance/<id>/, and its own control directory.');
      console.error('freeze-gate: a directory holding only the criteria\'s artifacts yields "no test files".');
      return 2;
    }
    if (suiteDiff.absent.length) {
      console.error(`freeze-gate: the probe's copy of the suite is MISSING files the fork point has (probe):`);
      for (const f of suiteDiff.absent) console.error(`freeze-gate:   ${f}`);
      console.error('freeze-gate: a probe satisfies the criteria by changing the TREE, never by removing');
      console.error('freeze-gate: or editing a check — a probe that edits its judge blesses the freeze this gate exists to prevent.');
      return 2;
    }
  }

  // Guards first: they are reported whatever the run does, because the count belongs in the
  // approval pass either way.
  let guards = [];
  if (spec) {
    try { guards = guardCount(fs.readFileSync(spec, 'utf8')); }
    catch (e) { console.error(`freeze-gate: ${e.message}`); return 2; }
  }

  const fork = runSide(repoRoot, verifyCommand, tests, timeoutMs, controlArg);
  const real = fork.suite;
  const control = fork.control;
  const chosen = fork.chosen;

  // The guard subset — the third observation in the fork-point tree, and the only one that
  // asks about a subset of the suite rather than the whole of it.
  //
  // It runs ONCE, and only from the one state in which its answer means anything: the fork
  // point red at exactly 1, on a control proven green. Anywhere else the suite-level
  // observation is already uninterpretable — a green fork point, a red control, an exit above
  // 1 — and a guard's red would be one more unreadable number rather than a finding. It
  // reuses THIS tree's control result rather than taking one of its own: the control answers
  // "can this command report success right now?", which is a fact about the tree and the
  // command, and it was answered a moment ago in the same tree by the same command.
  const guardNames = guardFiles(testPath);
  const forkIsRedOnGreen = !brokenRun(real) && real.status === 1
    && !brokenRun(control) && control.status === 0;
  let guardRun = null;
  let guardDir = null;
  if (guardNames.length && forkIsRedOnGreen) {
    try {
      guardRun = withGuardDir(repoRoot, testPath, guardNames, (dir) => {
        guardDir = dir;
        return runVerify(repoRoot, verifyCommand, dir, timeoutMs);
      });
    } catch (e) {
      // A subset that could not even be BUILT is the same finding as one that could not be
      // run, and it takes the same shape rather than a stack trace over the verdict: the
      // guard side is unavailable, and an unavailable discriminator announces itself.
      guardRun = { status: null, signal: null, stdout: '', stderr: '', error: (e && e.message) || String(e) };
    }
  }
  // A guard that is not green short-circuits the probe, because `verdictFor` will not read a
  // probe result behind one: running it anyway would spend two more invocations of the
  // project's whole test command to produce an answer nothing consults.
  const guardBlocks = !!guardRun && (brokenRun(guardRun) || guardRun.status !== 0);

  // The SAME repo-relative `tests` string, in the probe's own tree. Never an absolute path into
  // the probe: a frozen suite resolves its own root from `__dirname`, and the runner is given a
  // path relative to cwd, so an absolute path would run the fork point's copy from inside the
  // probe and prove nothing about either.
  const probe = probeRoot && !guardBlocks
    ? runSide(probeRoot, verifyCommand, tests, timeoutMs, controlArg) : null;
  const v = verdictFor(real, control, chosen.kind,
    probe ? probe.suite : null, probe ? probe.control : null, guardRun);

  const CONTROL_LABEL = {
    conventional: `${CONTROL_DIR} — one passing test`,
    explicit: `${chosen.dir} — supplied with --control`,
    'empty-probe': 'empty directory — NO control fixture, this discriminator is weak',
  };
  const probeLabel = (kind) => ({
    conventional: `${CONTROL_DIR} in the probe — one passing test`,
    explicit: `${chosen.dir} in the probe — supplied with --control`,
    'empty-probe': 'empty directory in the probe — NO control fixture, this discriminator is weak',
  }[kind]);
  console.log(`freeze-gate: ${tests}`);
  console.log(`  real run       exit ${fmtStatus(real)}`);
  console.log(`  control run    exit ${fmtStatus(control)}   (${CONTROL_LABEL[chosen.kind]})`);
  // Printed whenever the suite HAS a guard file, including when the subset did not run — a
  // line that only appears on the interesting branch cannot be told from one that never ran,
  // which is the same argument the brittleness count's unconditional zero rests on. A suite
  // with no guard file gets no line at all: there is nothing that could have run.
  if (guardNames.length) {
    console.log(guardRun
      ? `  guard run      exit ${fmtStatus(guardRun)}   (${guardNames.length} file(s) run alone in ${guardDir})`
      : '  guard run      not run   (only a fork point red at exit 1 on a green control asks the question)');
  }
  if (probe) {
    console.log(`  probe run      exit ${fmtStatus(probe.suite)}   (--green ${probeRoot})`);
    console.log(`  probe control  exit ${fmtStatus(probe.control)}   (${probeLabel(probe.chosen.kind)})`);
  }
  // What the two copies of the suite disagree about. Named, never silent: the probe runs its
  // OWN copy, so a difference is the one thing that can make a green probe mean nothing.
  if (suiteDiff && (suiteDiff.differing.length || suiteDiff.extra.length)) {
    console.log('');
    console.log(`probe suite differs: ${suiteDiff.differing.length} edited, ${suiteDiff.extra.length} added`);
    for (const f of suiteDiff.differing) console.log(`  edited in the probe: ${f}`);
    for (const f of suiteDiff.extra) console.log(`  present only in the probe: ${f}`);
    console.log(wrap('A probe is supposed to satisfy the criteria by changing the TREE. Where its copy '
      + 'of a test differs from the fork point\'s, the probe run judged a different suite from the '
      + 'one being frozen, and a green probe says only that the EDITED test passes. Read every line '
      + 'above before trusting the verdict.'));
  }
  console.log('');
  console.log(`${v.verdict.toUpperCase()}: ${v.headline}`);
  console.log(wrap(v.detail));
  // The guard files themselves, NAMED and counted — on the `guards declared:` precedent, and
  // printed even at zero. `guard files: 0` is the evidence that none were quietly assumed;
  // the names are what a `stale-guard` verdict is actionable from, since the exit code alone
  // says a guard is stale and not which one.
  console.log('');
  console.log(`guard files: ${guardNames.length}`);
  for (const g of guardNames) console.log(`  ${g}`);
  if (spec) {
    console.log('');
    console.log(`guards declared: ${guards.length}`);
    for (const g of guards) console.log(`  ${spec}:${g.line}  ${g.text}`);
  }
  // The brittleness lint. Printed for every verdict and with or without `--spec` — a
  // discriminator silent on a clean suite cannot be told from one that never ran — and outside
  // the `if (spec)` block above, which is the placement that would hide it from the majority
  // of invocations. It reads only the `--tests` path, never the control directory, which for
  // the conventional control is live repo content rather than anything under review.
  //
  // It CANNOT move the exit code, in either direction: a clean pass does not rescue a green
  // verdict, findings do not fail a red one, and a pass that throws says `unavailable` and
  // names the reason rather than propagating a stack trace over the verdict or printing a `0`
  // that would read as a silent all-clear.
  console.log('');
  try {
    const lint = lintSuite(testPath, { defaultBranch });
    console.log(`brittleness findings: ${lint.findings.length}`);
    for (const f of lint.findings) {
      console.log(`  ${f.file}:${f.line}  [${f.shape}]  ${f.question}`);
      console.log(`      ${f.text}`);
    }
    for (const s of lint.skipped) console.log(`  skipped: ${s.path}  (${s.reason})`);
  } catch (e) {
    console.log(`brittleness findings: unavailable - ${(e && e.message) || String(e)}`);
  }

  if (v.verdict !== 'red' && (real.stderr || '').trim()) {
    console.log('');
    console.log('last stderr from the real run:');
    console.log(String(real.stderr).trim().split(/\r?\n/).slice(-8).map((l) => `  ${l}`).join('\n'));
  }
  // The subset's own stderr, kept apart from the real run's. On a `stale-guard` this is the
  // only place the failing assertion appears at all — the suite-level run drowned it in the
  // ordinary criteria's failures, which is the whole reason the subset exists.
  if (guardRun && v.verdict !== 'red' && (guardRun.stderr || '').trim()) {
    console.log('');
    console.log('last stderr from the guard run:');
    console.log(String(guardRun.stderr).trim().split(/\r?\n/).slice(-8).map((l) => `  ${l}`).join('\n'));
  }
  return v.exit;
}

const fmtStatus = (r) =>
  (r.error ? `— (${r.error})` : r.signal ? `— (killed by ${r.signal})` : String(r.status));

const wrap = (s) => String(s).replace(/(.{1,86})(\s|$)/g, '$1\n').trimEnd();

function usage() {
  console.log('usage: node scripts/freeze-gate.js --repo <target-repo> \\');
  console.log('         --tests tests/acceptance/<issue-id>/ [--green <probe-dir>] \\');
  console.log('         [--spec <draft>] [--control <dir>] [--timeout <s>]');
  console.log('  --green <probe-dir>  a repo-shaped tree in which the criteria are ALREADY');
  console.log('                       satisfied, however crudely. The same suite is run there');
  console.log('                       and must come out GREEN. Exit 3 = red there too');
  console.log('                       (unreachable); omitted = exit 4 (half-proven, proceeds).');
  console.log('  a test file declaring itself [guard] in its first ten comment lines is also');
  console.log('  run ALONE against the fork point. Red there = exit 5 (stale-guard), never a pass.');
}

module.exports = {
  verdictFor, guardCount, guardFiles, runVerify, withEmptyControlDir, withGuardDir,
  resolveControl, CONTROL_DIR, main,
  brittleFindings, lintSuite, LINT_EXTENSIONS, QUESTIONS,
  runSide, digestSuite, compareSuites, MAX_BUFFER,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
