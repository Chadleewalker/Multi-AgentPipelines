// Frozen acceptance test — repo-j9n: teach coordinated pipeline concurrency during
// onboarding. This is the RED half; `guard.js` beside it carries the checks that are already
// green at the fork point and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  ONBOARDING.md contains ONE onboarding prompt asking for an integer implementation
//       concurrency, and that prompt states all four facts: it caps simultaneous
//       implementation tasks in one coordinated run; no preference uses 1; higher values
//       increase host CPU/RAM/container demand; and they may consume model-subscription
//       capacity faster.
//   C2  ONBOARDING.md gives a copyable same-project preparation example built on
//       `node scripts/prepare-batch.js start <batch> --config run.config.<project>.json`
//       with at least two repeated `--issue` arguments and `--author-concurrency 1..10`, and
//       says not to launch independent `author-tests.js` sessions for parallel preparation.
//   C3  ONBOARDING.md forbids duplicate run configs and alternate path spellings as routes to
//       same-project parallelism, identifies the host-global canonical-target lock as the
//       coordinator/mutation authority, and explains that its owner may fan out bounded
//       isolated worktree/clone workers.
//   C4  ONBOARDING.md names `node scripts/dashboard.js` as the read-only lock/liveness view
//       and `node scripts/prepare-batch.js status <batch>` for a known preparation; instructs
//       operators not to delete, bypass, take over or interrupt a live holder and to wait; and
//       defines an optional task-scoped periodic check whose only effect is reporting
//       held/free until the user separately approves starting work.
//   C5  the acceptance run does not recursively launch `scripts/test-ci.sh` — asserted here,
//       over this suite's own files. THE REST OF C5 IS PROVEN BY `guard.js`: the diff
//       limitation, `runner/config.js`'s default of 1, the central-document contract the
//       `pipeline-onboard` / `scaffold` entrypoints read, and the mandatory regression stage
//       are all statements about what did NOT change, so they are green at the fork point by
//       construction and a red file is the wrong home for them. `guard.js` also records the
//       two spec defects inside C5 (the plugin repository is private and outside this tree;
//       the regression stage cannot be run from here without the recursion C5 forbids).
//
// HOW A DOCUMENT IS MEASURED HERE, stated once so an implementer knows the shape to write.
// Nothing below matches a sentence the author must copy — every check is a conjunction of
// SUBSTANCE tokens, and the failure message prints what was and was not found. Two scopes:
//
//   * A PROMPT UNIT (C1) is the smallest self-delimiting unit of this document: a markdown
//     heading or a top-level `- [ ]` checklist item, together with everything indented or
//     paragraphed under it up to the next heading or checklist item. That is exactly how
//     ONBOARDING.md is written today, so "one prompt" is countable rather than a guess: a
//     second prompt in a second checklist item is a second unit, and C1 says there is one.
//   * A SECTION (C3, C4) is a markdown heading and everything under it up to the next
//     heading. C3's material must sit in one section and C4's in one section — they are each
//     one coherent operator instruction, and prose split across the document is prose an
//     operator reads half of. Where a criterion's facts are spread, the failure message names
//     the best-scoring section and every fact it was missing.
//
// IT RUNS NO FROZEN SCRIPT and starts no container engine, for the reasons `guard.js` gives:
// `scripts/test-*.sh` and `tests/unit/` are frozen paths, and C5 forbids this run from
// launching `scripts/test-ci.sh` recursively. The one product module it loads,
// `scripts/prepare-batch.js`, is loaded as a MODULE and only for its own argument parser, so
// the documented example is validated against the CLI's real grammar rather than against a
// second copy of that grammar typed here. Where the module is absent — a crude probe tree —
// the check falls back to a shape test and says so in its own name.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ONBOARDING = path.join(REPO, 'ONBOARDING.md');
const SUITE = __dirname;

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}

// Which of a set of named patterns a passage carries, and which it does not. Every content
// check below is written as one of these, so a failure names the missing substance instead of
// saying "no match".
function missing(passage, patterns) {
  return Object.entries(patterns).filter(([, re]) => !re.test(passage)).map(([k]) => k);
}
function say(gaps) {
  return gaps.length ? `missing: ${gaps.join(', ')}` : '';
}

try {
  let doc = null;
  try { doc = fs.readFileSync(ONBOARDING, 'utf8'); } catch { doc = null; }
  check('C1 ONBOARDING.md is readable', doc !== null);
  const text = String(doc || '').replace(/\r\n/g, '\n');
  const LINES = text.split('\n');

  const isHeading = (l) => /^#{1,6}\s/.test(l);
  const isItem = (l) => /^\s{0,3}[-*]\s+\[[ xX]\]/.test(l);

  // ---- the two scopes ---------------------------------------------------------------------
  function unitAt(i) {
    let start = i;
    while (start > 0 && !isHeading(LINES[start]) && !isItem(LINES[start])) start -= 1;
    let end = i + 1;
    while (end < LINES.length && !isHeading(LINES[end]) && !isItem(LINES[end])) end += 1;
    return { start, text: LINES.slice(start, end).join('\n') };
  }
  const sections = (() => {
    const out = [];
    let cur = { title: '(preamble)', lines: [] };
    for (const line of LINES) {
      if (isHeading(line)) { out.push(cur); cur = { title: line.trim(), lines: [line] }; }
      else cur.lines.push(line);
    }
    out.push(cur);
    return out.map((s) => ({ title: s.title, text: s.lines.join('\n') }));
  })();
  // The section that carries the most of a criterion's substance, so a failure can report the
  // gaps in the passage the author actually wrote rather than in the whole file.
  function bestSection(patterns) {
    let best = { title: '(none)', text: '', gaps: Object.keys(patterns) };
    for (const s of sections) {
      const gaps = missing(s.text, patterns);
      if (gaps.length < best.gaps.length) best = { ...s, gaps };
    }
    return best;
  }

  // ---- C1: one prompt, four facts ----------------------------------------------------------
  // A prompt unit is one that ASKS THE USER FOR A NUMBER about implementation concurrency. A
  // cross-reference elsewhere ("the concurrency answer is recorded") asks for nothing and is
  // not counted; a second full prompt is, which is what makes "one prompt" discriminating.
  const ASKS = /\b(ask|asks|asked|asking|prompt|prompts|choose|chooses|choice|decide|specify|pick|enter|how many)\b/i;
  const WANTS_A_NUMBER = /\b(integer|whole number|number|how many|value)\b/i;
  const promptUnits = (() => {
    const seen = new Map();
    for (let i = 0; i < LINES.length; i += 1) {
      if (!/concurrenc/i.test(LINES[i])) continue;
      const unit = unitAt(i);
      if (seen.has(unit.start)) continue;
      if (!/implementation/i.test(unit.text)) continue;
      if (!ASKS.test(unit.text) || !WANTS_A_NUMBER.test(unit.text)) continue;
      seen.set(unit.start, unit);
    }
    return [...seen.values()];
  })();
  check(`C1 ONBOARDING.md contains exactly ONE unit that asks the user for an implementation concurrency (found ${promptUnits.length})`,
    promptUnits.length === 1,
    promptUnits.map((u) => `line ${u.start + 1}: ${LINES[u.start].trim().slice(0, 70)}`).join(' | ') || 'no unit asks for one');

  const prompt = promptUnits.length === 1 ? promptUnits[0].text : '';
  const c1 = {
    integer: /\b(integer|whole number)\b/i,
    // "it caps simultaneous implementation tasks in one coordinated run"
    capWord: /\b(cap|caps|capped|limit|limits|limiting|maximum|at most|ceiling|bound|bounds)\b/i,
    simultaneity: /\b(simultaneous|simultaneously|at once|at the same time|concurrent|concurrently|in parallel|side by side)\b/i,
    tasks: /\b(implementation|implement)\b[\s\S]{0,80}?\btasks?\b|\btasks?\b[\s\S]{0,80}?\bimplementation\b/i,
    oneRun: /\brun\b/i,
    // "no preference uses 1"
    noPreference: /\b(no preference|no answer|no opinion|unsure|not sure|does ?n[o']?t know|do ?n[o']?t know|nothing in particular|declines?|silence|default)\b/i,
    one: /(^|[^\w.])1([^\w.]|$)/,
    // "higher values increase host CPU/RAM/container demand"
    higher: /\b(higher|more|greater|larger|increase|increases|increasing|raises|grows|heavier)\b/i,
    cpu: /\bcpu\b/i,
    memory: /\b(ram|memory)\b/i,
    containers: /\bcontainers?\b/i,
    // "they may consume model-subscription capacity faster"
    subscription: /\bsubscription\b/i,
    capacity: /\b(capacity|quota|usage|allowance|budget|limit|window)\b/i,
    faster: /\b(faster|sooner|quicker|more quickly|more rapidly)\b/i,
  };
  const gapsIn = (keys) => missing(prompt, Object.fromEntries(keys.map((k) => [k, c1[k]])));

  check('C1 that prompt asks for an INTEGER (a whole number)', prompt !== '' && gapsIn(['integer']).length === 0,
    prompt === '' ? 'no single prompt unit to read' : say(gapsIn(['integer'])));
  {
    const gaps = gapsIn(['capWord', 'simultaneity', 'tasks', 'oneRun']);
    check('C1 fact 1: the prompt states the value CAPS SIMULTANEOUS IMPLEMENTATION TASKS in one coordinated run',
      prompt !== '' && gaps.length === 0, prompt === '' ? 'no single prompt unit to read' : say(gaps));
  }
  {
    const gaps = gapsIn(['noPreference', 'one']);
    check('C1 fact 2: the prompt states that NO PREFERENCE USES 1',
      prompt !== '' && gaps.length === 0, prompt === '' ? 'no single prompt unit to read' : say(gaps));
  }
  {
    const gaps = gapsIn(['higher', 'cpu', 'memory', 'containers']);
    check('C1 fact 3: the prompt states that HIGHER VALUES INCREASE HOST CPU/RAM/CONTAINER demand',
      prompt !== '' && gaps.length === 0, prompt === '' ? 'no single prompt unit to read' : say(gaps));
  }
  {
    const gaps = gapsIn(['subscription', 'capacity', 'faster']);
    check('C1 fact 4: the prompt states that higher values may CONSUME MODEL-SUBSCRIPTION CAPACITY FASTER',
      prompt !== '' && gaps.length === 0, prompt === '' ? 'no single prompt unit to read' : say(gaps));
  }

  // ---- C2: the copyable same-project preparation example -----------------------------------
  // Copyable means it lives in a fenced block a reader can lift whole, so the example is read
  // out of the fences rather than out of the prose around them.
  const fenced = (() => {
    const out = []; let cur = null;
    for (const line of LINES) {
      if (/^\s*```/.test(line)) { if (cur) { out.push(cur.join('\n')); cur = null; } else cur = []; continue; }
      if (cur) cur.push(line);
    }
    return out;
  })();
  const example = (() => {
    for (const block of fenced) {
      // A shell continuation is part of one command; join it before splitting into lines.
      for (const line of block.replace(/\\\n\s*/g, ' ').split('\n')) {
        if (/node\s+scripts\/prepare-batch\.js\s+start\b/.test(line)) return line.trim().replace(/^\$\s*/, '');
      }
    }
    return null;
  })();
  check('C2 a fenced, copyable block carries `node scripts/prepare-batch.js start ...`',
    example !== null, `${fenced.length} fenced block(s), none with the command`);

  const argv = example === null ? [] : example.split(/\s+/).slice(
    example.split(/\s+/).findIndex((t) => /prepare-batch\.js$/.test(t)) + 1);
  const valuesOf = (flag) => argv.filter((t, i) => argv[i - 1] === flag && t !== undefined);
  const issues = valuesOf('--issue');
  const configs = valuesOf('--config');
  const conc = valuesOf('--author-concurrency');

  check(`C2 the example names one same-project run config, \`run.config.<project>.json\` (found ${JSON.stringify(configs)})`,
    configs.length === 1 && /^run\.config\..+\.json$/.test(configs[0]));
  check(`C2 the example repeats \`--issue\` at least twice, which is what makes it a same-project batch (found ${issues.length})`,
    issues.length >= 2);

  // The bound is READ FROM the CLI rather than typed here, so "1..10" in the document is
  // checked against the range the command actually enforces.
  let PB = null;
  try { PB = require(path.join(REPO, 'scripts', 'prepare-batch.js')); } catch { PB = null; } // eslint-disable-line global-require, import/no-dynamic-require
  const MAX = PB && Number.isInteger(PB.MAX_CONCURRENCY) ? PB.MAX_CONCURRENCY : 10;
  const concValue = conc.length === 1 ? Number(conc[0]) : NaN;
  check(`C2 the example passes \`--author-concurrency\` a whole number within the range the CLI enforces (1..${MAX}) — found ${JSON.stringify(conc)}`,
    conc.length === 1 && Number.isInteger(concValue) && concValue >= 1 && concValue <= MAX);

  // The whole example, asked of the command's own parser. Angle-bracket placeholders are
  // substituted first — `<batch>` is the criterion's own notation and the parser rejects the
  // brackets as unsafe — so what is tested is the OPTION GRAMMAR the operator would copy, not
  // whether the author typed real issue ids.
  const substituted = (() => {
    let n = 0;
    return argv.map((tok) => {
      if (!/[<>]/.test(tok)) return tok;
      n += 1;
      const bare = tok.replace(/[<>]/g, '').replace(/^[^A-Za-z0-9]+/, '');
      return `${bare || 'x'}${bare && !/--/.test(tok) ? `-ph${n}` : ''}`;
    });
  })();
  if (PB && typeof PB.parseArgs === 'function') {
    let parsed = null;
    try { parsed = PB.parseArgs(substituted); } catch (e) { parsed = { error: `THREW ${e && e.message}` }; }
    check(`C2 the example parses through the CLI's own parser as a \`start\` with two or more issues — got ${JSON.stringify((parsed && parsed.error) || null)}`,
      !!parsed && !parsed.error && parsed.mode === 'start' && !!parsed.config
      && Array.isArray(parsed.issues) && parsed.issues.length >= 2
      && Number.isInteger(parsed.concurrency) && parsed.concurrency >= 1 && parsed.concurrency <= MAX,
      `argv: ${substituted.join(' ')}`);
  } else {
    check('C2 the CLI parser is not loadable in this tree, so the example is checked by shape only — recorded, not claimed',
      example !== null && argv[0] === 'start' && argv.length >= 2);
  }

  // The other half of C2: one preparation coordinator, not N author sessions.
  const c2Prose = {
    authorTests: /author-tests\.js/,
    prohibition: /\b(never|not|no|don'?t|do not|instead of|rather than|refuse|avoid)\b/i,
    independent: /\b(independent|independently|separate|separately|your own|extra|additional|parallel|side by side|by hand|hand-launched)\b/i,
    sessions: /\b(sessions?|invocations?|processes|runs|copies|instances)\b/i,
  };
  const prohibitionUnit = (() => {
    for (let i = 0; i < LINES.length; i += 1) {
      if (!/author-tests\.js/.test(LINES[i])) continue;
      const unit = unitAt(i);
      if (missing(unit.text, c2Prose).length === 0) return unit;
    }
    return null;
  })();
  check('C2 ONBOARDING.md says not to launch independent `author-tests.js` sessions for parallel preparation',
    prohibitionUnit !== null,
    /author-tests\.js/.test(text)
      ? `author-tests.js is mentioned, but no unit carries the prohibition (${say(missing(text, c2Prose))})`
      : 'author-tests.js is never mentioned');

  // ---- C3: one coordinator, one authority, bounded workers ---------------------------------
  const c3 = {
    // "explicitly forbids duplicate run configs ... for same-project parallelism"
    secondConfig: /\b(second|another|duplicate|duplicated|extra|additional|two|copies|copy)\b[\s\S]{0,120}?\bconfigs?\b|\bconfigs?\b[\s\S]{0,120}?\b(second|another|duplicate|duplicated|extra|additional|two|copies|copy)\b/i,
    runConfig: /run\.config/,
    forbids: /\b(never|not|no|don'?t|do not|must not|forbidden|refused|refuses|refuse|prohibited)\b/i,
    parallelism: /\b(parallel|parallelism|at once|at the same time|concurrent|concurrently|simultaneous|simultaneously|second run|two runs)\b/i,
    sameProject: /\bsame (project|repo|repository|target)\b|\bone (project|repo|repository|target)\b/i,
    // "... and alternate path spellings"
    spelling: /\b(spelling|spellings|spelled|alternate path|alternative path|different path|slash|slashes|separator|casing|upper ?case|lower ?case|symlink|symlinked|trailing)\b/i,
    identity: /\b(identity|same repo|same target|same project|canonical|folds?|folded|one key|the same lock)\b/i,
    // "identifies the host-global canonical-target lock as coordinator/mutation authority"
    hostGlobal: /\b(host-global|host global|global|machine-wide|host-wide|one per host|per host)\b/i,
    canonicalLock: /\bcanonical\b[\s\S]{0,60}?\b(target|path|lock)\b/i,
    lock: /\block\b/i,
    authority: /\b(authority|authoritative|the coordinator|coordinator|owns|owner|only writer|sole|mutation|mutations|mutate|mutating|writes)\b/i,
    // "explains that its owner may fan out bounded isolated worktree/clone workers"
    fanOut: /\b(fan out|fans out|fan-out|fanning out|delegate|delegates|dispatch|dispatches|spawn|spawns|launch|launches|run)\b/i,
    workers: /\bworkers?\b/i,
    isolated: /\b(isolated|isolation|bounded|bound|capped|limited)\b/i,
    trees: /\b(worktrees?|clones?)\b/i,
  };
  const s3 = bestSection(c3);
  const has3 = (keys) => missing(s3.text, Object.fromEntries(keys.map((k) => [k, c3[k]])));
  // THE ANCHOR, and the reason every C3 check carries it. ONBOARDING.md ALREADY forbids a
  // second run config and already says a trailing separator or a slash flip buys no second
  // identity ("One config per target repo", step 8 at the fork point) — so a check that asked
  // only for that would be green today and would pass an empty diff. What C3 adds is the
  // passage that names the HOST-GLOBAL CANONICAL-TARGET LOCK as the coordinator and mutation
  // authority, and both prohibitions have to be stated THERE, as answers to same-project
  // parallelism, rather than left where they are as facts about network names.
  const anchorGaps = has3(['hostGlobal', 'canonicalLock', 'lock', 'authority']);
  const anchored = anchorGaps.length === 0;
  const where3 = `best section: ${s3.title}`;
  const anchorNote = anchored ? '' : `the passage naming the host-global canonical-target lock as authority is absent (${say(anchorGaps)}); `;
  {
    const gaps = has3(['secondConfig', 'runConfig', 'forbids', 'parallelism', 'sameProject']);
    check('C3 the lock-authority passage explicitly forbids a duplicate run config as a route to same-project parallelism',
      anchored && gaps.length === 0, `${where3}; ${anchorNote}${say(gaps)}`);
  }
  {
    const gaps = has3(['spelling', 'forbids', 'identity']);
    check('C3 ... and forbids alternate path spellings as a way to buy a second identity',
      anchored && gaps.length === 0, `${where3}; ${anchorNote}${say(gaps)}`);
  }
  check('C3 ... and identifies the HOST-GLOBAL CANONICAL-TARGET LOCK as the coordinator/mutation authority',
    anchored, `${where3}; ${say(anchorGaps)}`);
  {
    const gaps = has3(['fanOut', 'workers', 'isolated', 'trees']);
    check('C3 ... and explains that the lock holder may FAN OUT BOUNDED ISOLATED worktree/clone workers',
      anchored && gaps.length === 0, `${where3}; ${anchorNote}${say(gaps)}`);
  }

  // ---- C4: what an operator does when the lock is held -------------------------------------
  const c4 = {
    dashboard: /scripts\/dashboard\.js/,
    readOnly: /\b(read-only|read only|reader|reads only|changes nothing|never writes|writes nothing|observe|observer)\b/i,
    liveness: /\b(liveness|live|alive|holder|holders|held)\b/i,
    lock: /\block|locks\b/i,
    status: /prepare-batch\.js\s+status/,
    knownBatch: /prepare-batch\.js\s+status\s+\S+/,
    known: /\b(known|already|prepared|preparation|batch|batches)\b/i,
    noDelete: /\b(delete|deleting|remove|removing|clear|clearing|rm)\b/i,
    noBypass: /\b(bypass|bypassing|work around|working around|circumvent|circumventing|override|overriding|ignore|ignoring)\b/i,
    noTakeover: /\b(take over|takeover|taking over|steal|stealing|claim|claiming|seize)\b/i,
    noInterrupt: /\b(interrupt|interrupting|kill|killing|stop|stopping|terminate|terminating|cancel)\b/i,
    prohibition: /\b(never|not|no|don'?t|do not|must not|forbidden)\b/i,
    wait: /\b(wait|waits|waiting)\b/i,
    optional: /\b(optional|optionally|if you like|may|can)\b/i,
    periodic: /\b(periodic|periodically|poll|polls|polling|interval|repeat|repeats|repeatedly|re-?check|recheck|every\s+\d+|again later)\b/i,
    taskScoped: /\b(task-scoped|task scoped|scoped to (the|one|a) task|for (that|this|one) task|per task|task-level|within the task)\b/i,
    onlyEffect: /\b(only|nothing else|no other effect|does nothing else|changes nothing|never acts|no side effect)\b/i,
    reports: /\b(report|reports|reporting|says|tells|prints|shows)\b/i,
    heldFree: /\bheld\b[\s\S]{0,60}?\bfree\b|\bfree\b[\s\S]{0,60}?\bheld\b/i,
    approves: /\b(approve|approves|approval|says so|agrees|permission|green-?light|confirms?)\b/i,
    separately: /\b(separate|separately|its own|explicitly|only then|first)\b/i,
    startWork: /\b(start|starting|begin|beginning|launch|launching)\b[\s\S]{0,40}?\b(work|run|task|tasks)\b/i,
  };
  const s4 = bestSection(c4);
  const has4 = (keys) => missing(s4.text, Object.fromEntries(keys.map((k) => [k, c4[k]])));
  const where4 = `best section: ${s4.title}`;
  {
    const gaps = has4(['dashboard', 'readOnly', 'liveness', 'lock']);
    check('C4 ONBOARDING.md names `node scripts/dashboard.js` as the READ-ONLY lock/liveness view',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['status', 'knownBatch', 'known']);
    check('C4 ... and names `node scripts/prepare-batch.js status <batch>` for a known preparation',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['noDelete', 'noBypass', 'noTakeover', 'noInterrupt', 'prohibition', 'liveness']);
    check('C4 ... and instructs operators not to DELETE, BYPASS, TAKE OVER or INTERRUPT a live holder',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['wait', 'liveness']);
    check('C4 ... and tells them to WAIT instead', gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['optional', 'periodic', 'taskScoped']);
    check('C4 ... and defines an OPTIONAL, TASK-SCOPED PERIODIC check',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['onlyEffect', 'reports', 'heldFree']);
    check('C4 ... whose ONLY EFFECT is reporting held/free',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }
  {
    const gaps = has4(['approves', 'separately', 'startWork']);
    check('C4 ... and that work starts only once the user SEPARATELY APPROVES it',
      gaps.length === 0, `${where4}; ${say(gaps)}`);
  }

  // ---- C5: this suite does not recursively launch the regression stage ---------------------
  // Openly self-referential — it is a statement about the files being written here, so it can
  // only ever be green. It is worth asserting anyway, because "does not re-enter the pipeline's
  // own regression command" is the property a later edit to this suite would silently spend.
  // The rest of C5 lives in `guard.js`; see the header.
  const suiteFiles = (() => {
    try { return fs.readdirSync(SUITE).filter((f) => /\.(?:js|sh)$/.test(f)); } catch { return []; }
  })();
  check(`C5 the acceptance suite for repo-j9n is present and non-empty (${suiteFiles.length} test files)`,
    suiteFiles.length > 0);
  const recursive = /test-ci\.sh|\btest-all\.sh\b/;
  const shells = /\b(?:execSync|spawn|spawnSync|exec)\s*\(\s*['"](?:sh|bash|cmd|powershell|pwsh|npm|npx)['"]/;
  const engine = /\b(?:docker|podman)\s+(?:run|build|compose|exec|image|pull|create)\b/;
  const offenders = suiteFiles.filter((f) => {
    let body = '';
    try { body = fs.readFileSync(path.join(SUITE, f), 'utf8'); } catch { return true; }
    // This file names `test-ci.sh` in prose; only an executable reference counts.
    const code = body.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
    return (recursive.test(code) && shells.test(code)) || engine.test(code) || shells.test(code);
  });
  check(`C5 no file in this suite shells out, so the acceptance run cannot recursively launch scripts/test-ci.sh${offenders.length ? ` (offenders: ${offenders.join(', ')})` : ''}`,
    suiteFiles.length > 0 && offenders.length === 0);
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
}
process.exit(failed);
