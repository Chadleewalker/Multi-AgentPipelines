// Frozen acceptance test — repo-j9n, the [guard] half: teaching coordinated pipeline
// concurrency during onboarding is a DOCUMENTATION change, and it must not be paid for with
// any of the behaviour the new prose describes.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. Nothing red
// belongs here: a [guard] file that is red at the fork point is a stale pin and refuses the
// freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// WHICH CRITERION EACH CHECK PROVES.
//
//   C5, and most of it. C5 is the criterion about what did NOT change, so it is green at the
//       fork point by construction and belongs here rather than in `test.js`:
//         * "the implementation diff outside `tests/acceptance/repo-j9n` and its receipt is
//           limited to ONBOARDING.md" — the house merge-base CONTENT diff (the shape
//           `tests/acceptance/repo-yk4/guard.js` and, before it, `repo-1cy` use), over the
//           whole tree rather than a list typed here;
//         * "the existing Harness_Pipeline pipeline-onboard/scaffold entrypoints continue to
//           read central ONBOARDING.md dynamically" — as much of it as is observable from
//           inside this repository; see the DEFECT note below for what that is and is not;
//         * "runner/config.js still defaults concurrency to 1" — asked of `loadConfig` and
//           `DEFAULTS`, plus the validation contract the new onboarding prompt describes
//           (a whole number of 1 or more);
//         * "the pipeline's separate mandatory regression stage passes" — the part of it a
//           frozen suite may honestly assert: the stage is still DECLARED and its command is
//           still present. See the DEFECT note.
//   C2 — the CLI grammar the new copyable example has to use is still the grammar
//       `scripts/prepare-batch.js` actually accepts, and its concurrency ceiling is still 10,
//       so "`--author-concurrency 1..10`" in the document stays true rather than becoming
//       folklore. `test.js` proves the document carries the example; this proves the example
//       it must carry is real.
//   C4 — the two read-only commands the document must name (`node scripts/dashboard.js` and
//       `node scripts/prepare-batch.js status <batch>`) still exist and still parse.
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER — TWO OF THEM, both in C5.
//
//   1. The `pipeline-onboard` / `scaffold` entrypoints live in the harness plugin, which
//      SETUP.md §A8 states is a SEPARATE, PRIVATE repository that is deliberately not named
//      in this public tree, and which installs under `~/.claude/plugins` — outside this
//      worktree entirely. No frozen suite here can open those files, so "the entrypoints
//      continue to read central ONBOARDING.md dynamically" is proven here as the CONTRACT
//      SIDE that lives in this repo and is the only thing those entrypoints depend on:
//      `ONBOARDING.md` is still at the repository root, still declares itself the source of
//      truth that a wrapper reads rather than copies, and the checklist still exists in
//      exactly one file, so nothing has been forked into a wrapper-shaped copy.
//   2. "The pipeline's separate mandatory regression stage passes" cannot be asserted by this
//      suite at all: C5 forbids the acceptance run from recursively launching
//      `scripts/test-ci.sh`, and that script matches `scripts/test-*.sh` in
//      `pipeline.config.json` `frozenPaths` besides. It stays a pipeline-level gate; what is
//      checkable from here is that the stage is still configured as mandatory and its command
//      still exists.
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a flat scratch
// directory beside the suite, so this file requires nothing from its own folder and resolves
// the repository from its own `__dirname` at the suite's depth, the way every frozen suite
// here does.
//
// IT RUNS NO FROZEN SCRIPT and starts no container engine: `scripts/test-*.sh` and
// `tests/unit/` are frozen paths, a frozen suite that shells into one asserts through a file
// it may never adjust, and C5 forbids the recursion by name.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ONBOARDING = path.join(REPO, 'ONBOARDING.md');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const DASHBOARD = path.join(REPO, 'scripts', 'dashboard.js');
const CONFIG_MODULE = path.join(REPO, 'runner', 'config.js');
const SUITE_REL = 'tests/acceptance/repo-j9n';

// Fixtures and worktrees are routinely owned by a different uid than the process inside a
// container, and git's dubious-ownership guard would otherwise refuse every call. A frozen
// test must not depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-j9n-'));

try {
  // ---- C5: ONBOARDING.md is still the central file a wrapper reads ------------------------
  const doc = read(ONBOARDING);
  check('C5 [guard] ONBOARDING.md is still present at the repository root and non-empty',
    typeof doc === 'string' && doc.trim().length > 0);
  const text = String(doc || '');
  check('C5 [guard] ONBOARDING.md still names the `pipeline-onboard` wrapper entrypoint',
    /pipeline-onboard/.test(text));
  check('C5 [guard] ONBOARDING.md still states that the wrapper READS this file rather than copying it',
    /reads this file/i.test(text) && /source of truth/i.test(text));
  check('C5 [guard] ONBOARDING.md still tells authors to keep new material in this file rather than in a wrapper',
    /in this file/i.test(text) && /wrapper/i.test(text));

  // No wrapper-shaped copy: the checklist heading exists in exactly one tracked file, so the
  // entrypoints have nothing to read but the central document. Listed from Git rather than
  // walked, so ignored and generated trees cannot answer.
  const tracked = (() => {
    const r = git(REPO, 'ls-files', '-z');
    if (r.status !== 0) return null;
    return String(r.stdout || '').split('\0').filter(Boolean);
  })();
  if (!Array.isArray(tracked) || tracked.length === 0) {
    // A tree with no Git — a crude probe is exactly that — cannot answer a question about
    // TRACKED files. Recorded rather than silently dropped, and never claimed as a pass of
    // the thing it could not observe.
    check('C5 [guard] this tree has no readable Git index, so the single-copy question is unobservable here — recorded, not claimed',
      true);
  } else {
    const carriers = tracked.filter((rel) => rel.toLowerCase().endsWith('.md'))
      .filter((rel) => /^##\s+The Checklist\s*$/m.test(String(read(path.join(REPO, ...rel.split('/'))) || '')));
    check(`C5 [guard] the onboarding checklist still lives in exactly one tracked file (found ${carriers.length}: ${carriers.join(', ') || 'none'})`,
      carriers.length === 1 && carriers[0] === 'ONBOARDING.md');
  }

  // ---- C5: runner/config.js still defaults concurrency to 1 --------------------------------
  let CONFIG = null;
  try { CONFIG = require(CONFIG_MODULE); } catch { CONFIG = null; } // eslint-disable-line global-require, import/no-dynamic-require
  check('C5 [guard] runner/config.js is still loadable', CONFIG !== null);
  if (CONFIG) {
    check(`C5 [guard] the run-config default for \`concurrency\` is still 1 — got ${JSON.stringify(CONFIG.DEFAULTS && CONFIG.DEFAULTS.concurrency)}`,
      CONFIG.DEFAULTS && CONFIG.DEFAULTS.concurrency === 1);

    const cfgFile = path.join(tmp, 'run.config.probe.json');
    const write = (extra) => {
      fs.writeFileSync(cfgFile, JSON.stringify({
        targetRepoPath: path.join(tmp, 'target'),
        targetRepoRemote: 'https://example.invalid/probe.git',
        image: 'pipeline-probe:local',
        ...extra,
      }));
      return cfgFile;
    };
    const load = (extra) => {
      try { return { ok: true, cfg: CONFIG.loadConfig(write(extra)) }; }
      catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
    };

    const silent = load({});
    check(`C5 [guard] a run config that says nothing about concurrency still resolves to 1 — got ${silent.ok ? JSON.stringify(silent.cfg.concurrency) : silent.error}`,
      silent.ok === true && silent.cfg.concurrency === 1);
    const explicit = load({ concurrency: 4 });
    check('C5 [guard] an explicit whole number of 1 or more is still accepted',
      explicit.ok === true && explicit.cfg.concurrency === 4);
    // The validation contract the new onboarding prompt has to describe truthfully: a WHOLE
    // number, and never below one. Each refusal is named by the message the operator reads.
    for (const bad of [0, -1, 1.5, '2', null]) {
      const r = load({ concurrency: bad });
      check(`C5 [guard] \`concurrency: ${JSON.stringify(bad)}\` is still refused by name — got ${r.ok ? 'accepted' : JSON.stringify(r.error)}`,
        r.ok === false && /'concurrency' must be a whole number of 1 or more/.test(r.error || ''));
    }
  }

  // ---- C5: the mandatory regression stage is still declared --------------------------------
  // Not RUN — C5 forbids this suite from launching it recursively, and it is a frozen path
  // besides. See the DEFECT note at the top of this file.
  let policy = null;
  try { policy = JSON.parse(String(read(path.join(REPO, 'pipeline.config.json')) || '')); } catch { policy = null; }
  check('C5 [guard] pipeline.config.json is still readable', policy !== null);
  if (policy) {
    check(`C5 [guard] the regression stage is still mandatory — got ${JSON.stringify(policy.regressionPolicy)}`,
      policy.regressionPolicy === 'required');
    check(`C5 [guard] the regression command is still declared — got ${JSON.stringify(policy.regressionCommand)}`,
      typeof policy.regressionCommand === 'string' && /scripts\/test-ci\.sh/.test(policy.regressionCommand));
  }
  check('C5 [guard] the regression command\'s script is still present',
    fs.existsSync(path.join(REPO, 'scripts', 'test-ci.sh')));

  // ---- C2 and C4: the commands the document must name are real -----------------------------
  let PB = null;
  try { PB = require(PREPARE_BATCH); } catch { PB = null; } // eslint-disable-line global-require, import/no-dynamic-require
  check('C2 [guard] scripts/prepare-batch.js is still loadable', PB !== null);
  check('C4 [guard] scripts/dashboard.js is still present', fs.existsSync(DASHBOARD));
  if (PB && typeof PB.parseArgs === 'function') {
    check(`C2 [guard] the author-concurrency ceiling the document quotes is still 10 — got ${JSON.stringify(PB.MAX_CONCURRENCY)}`,
      PB.MAX_CONCURRENCY === 10);

    const startArgv = (n) => ['start', 'batch1', '--config', 'run.config.project.json',
      '--issue', 'repo-aaa', '--issue', 'repo-bbb', '--author-concurrency', String(n)];
    const first = PB.parseArgs(startArgv(1));
    check(`C2 [guard] the documented start grammar (one --config, two repeated --issue, --author-concurrency) still parses — got ${JSON.stringify(first.error || null)}`,
      !first.error && first.mode === 'start' && Array.isArray(first.issues)
      && first.issues.length === 2 && first.concurrency === 1);
    const ceiling = PB.parseArgs(startArgv(PB.MAX_CONCURRENCY));
    check('C2 [guard] the top of the documented range is still accepted', !ceiling.error && ceiling.concurrency === PB.MAX_CONCURRENCY);
    for (const bad of [0, PB.MAX_CONCURRENCY + 1]) {
      const r = PB.parseArgs(startArgv(bad));
      check(`C2 [guard] --author-concurrency ${bad} is still refused, so the documented range is a real bound — got ${JSON.stringify(r.error || 'accepted')}`,
        !!r.error && /author-concurrency/.test(r.error));
    }

    const status = PB.parseArgs(['status', 'batch1']);
    check(`C4 [guard] \`prepare-batch.js status <batch>\` still parses — got ${JSON.stringify(status.error || null)}`,
      !status.error && status.mode === 'status' && status.batch === 'batch1');
  }

  // ---- C5: nothing outside ONBOARDING.md and this suite has moved --------------------------
  // The fork point, resolved from refs rather than typed. Where no integration ref is
  // reachable — a detached proof clone, or a probe tree that is not a repository at all — the
  // comparison degrades and SAYS SO in the check's own name rather than in silence.
  const forkPoint = (() => {
    for (const ref of ['main', 'origin/main', 'refs/remotes/origin/main']) {
      const r = git(REPO, 'merge-base', ref, 'HEAD');
      if (r.status === 0 && String(r.stdout || '').trim()) return { rev: r.stdout.trim(), ref };
    }
    const head = git(REPO, 'rev-parse', 'HEAD');
    if (head.status === 0 && String(head.stdout || '').trim()) return { rev: head.stdout.trim(), ref: 'HEAD' };
    return null;
  })();

  if (forkPoint === null) {
    check('C5 [guard] this tree has no reachable fork point, so the implementation diff is unobservable here — recorded, not claimed',
      true);
  } else {
    // What C5 licenses the implementation to change, and nothing else: the document itself,
    // this suite, its `.freeze-gate.json` receipt (which lives inside the suite), and the
    // freeze gate's own disposable guard scratch directory, which is created beside the suite
    // while this very file is running.
    const allowed = (rel) => rel === 'ONBOARDING.md'
      || rel === `${SUITE_REL}/` || rel.startsWith(`${SUITE_REL}/`)
      || /^tests\/acceptance\/\.freeze-gate-guards-/.test(rel);

    // Names first, content second. `git diff --name-only` over-reports on a Windows-origin
    // checkout — CRLF on disk against an LF blob makes every file look changed inside a Linux
    // container — so it is used only to narrow the candidates, and each candidate is then
    // compared as NORMALISED CONTENT against the fork point. Compared against the WORKING TREE
    // because an implementation task's edits are uncommitted when its verifier runs.
    const named = git(REPO, 'diff', '--name-only', '-z', forkPoint.rev, '--');
    check(`C5 [guard] the fork point (${forkPoint.ref}) could be diffed against the working tree`,
      named.status === 0);
    const candidates = String(named.stdout || '').split('\0').filter(Boolean).filter((rel) => !allowed(rel));

    const norm = (t) => String(t).replace(/\r\n/g, '\n');
    const changed = candidates.filter((rel) => {
      const shown = git(REPO, 'show', `${forkPoint.rev}:${rel}`);
      if (shown.status !== 0) return true;
      const disk = read(path.join(REPO, ...rel.split('/')));
      if (disk === null) return true;
      return norm(disk) !== norm(shown.stdout);
    });
    check(`C5 [guard] no tracked file outside ONBOARDING.md and this suite differs from the fork point${changed.length ? ` (changed: ${changed.slice(0, 8).join(', ')})` : ''}`,
      named.status === 0 && changed.length === 0);

    // An ADDED file is a change the tracked-file diff above cannot see. Ignored paths are
    // excluded by Git's own rules rather than by a list here.
    const now = git(REPO, 'ls-files', '-z', '--others', '--exclude-standard');
    const added = String(now.stdout || '').split('\0').filter(Boolean).filter((rel) => !allowed(rel));
    check(`C5 [guard] no new file has appeared outside ONBOARDING.md and this suite${added.length ? ` (added: ${added.slice(0, 8).join(', ')})` : ''}`,
      now.status === 0 && added.length === 0);
  }
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
