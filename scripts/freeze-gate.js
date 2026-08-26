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
  if (real.status > 1) {
    return {
      verdict: 'indeterminate',
      exit: 2,
      headline: `the tests exited ${real.status}, which is "could not run", not "failed"`,
      detail:
        'A runner exits 1 when tests fail and 2 or more when it could not run them — a parse '
        + 'error, a missing import, no tests collected. The control is green, so the harness '
        + 'itself is fine: it is THIS suite that did not execute. Red proves nothing until the '
        + 'suite runs, so fix the suite and re-run. (If this project genuinely uses this code for '
        + 'ordinary test failure, the gate needs to be told so.)',
    };
  }
  return {
    verdict: 'red',
    exit: 0,
    headline: 'the tests FAIL against the fork point, and the harness reports green on the control',
    detail: 'The tests discriminate: they can detect the thing they exist to catch.',
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
  brittleFindings, lintSuite, LINT_EXTENSIONS, QUESTIONS,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
