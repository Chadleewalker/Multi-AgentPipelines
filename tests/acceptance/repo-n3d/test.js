// Frozen acceptance test — repo-n3d: PLANNING.md says that a pure refactor cannot be frozen,
// and what to do instead. Criteria P1–P5. Plain Node, Docker-free.
//
// THIS IS A WEAK GATE AND SAYS SO. Prose cannot be checked for meaning; these assertions check
// that specific ideas are present and reachable, not that they are well written. The value of the
// task is findability at the moment a planner is sizing a candidate — the rule already exists in
// the freeze gate's exit-1 branch, in step 4's guard paragraph and in docs/IDEAS.md, and each
// session has been re-deriving it anyway. Three times in one day, at a planning cycle each.
//
// So the criteria are deliberately shaped around *where* the guidance sits and *what decision it
// enables*, rather than around wording — a wording assertion would freeze one author's sentence
// and fail the next honest edit.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PLAYBOOK = path.join(REPO, 'PLANNING.md');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`ok - ${msg}`); }
  else { fail++; console.log(`FAIL - ${msg}`); }
}

const src = fs.existsSync(PLAYBOOK) ? fs.readFileSync(PLAYBOOK, 'utf8') : '';
const low = src.toLowerCase();

// ---------------------------------------------------------------------------------------------
// P1 — the rule is stated, with its remedy.
// ---------------------------------------------------------------------------------------------

ok(src.length > 0, 'P1 PLANNING.md is readable');

// The claim: a task whose only criteria are guards cannot be frozen.
const statesRule = /pure refactor/i.test(src)
  && (/cannot be frozen|not freezable|unfreezable/i.test(src));
ok(statesRule,
  'P1 PLANNING.md states that a pure refactor cannot be frozen — today the phrase "pure '
  + 'refactor" appears only in step 4\'s aside about guards being legal, which says the opposite '
  + 'is permitted and never says the task is unfreezable');

// The remedy: fold it into a later task with a behavioural reason to touch the same code.
const statesRemedy = /fold/i.test(src)
  && /behavioural reason|behavioral reason/i.test(src);
ok(statesRemedy,
  'P1 …and names the remedy: fold it into a later task that has a behavioural reason to touch '
  + 'the same code. A rule with no remedy reads as a prohibition on the work itself');

// ---------------------------------------------------------------------------------------------
// P2 — the diagnostic a planner can apply BEFORE writing criteria.
// ---------------------------------------------------------------------------------------------

const statesDiagnostic = /behavioural signature|behavioral signature/i.test(src)
  && /(differs?|different)[^.]{0,80}(before and after|under the fix)/i.test(src);
ok(statesDiagnostic,
  'P2 the passage gives the test a planner can apply before writing any criteria — whether an '
  + 'input exists whose observable answer differs before and after — rather than only describing '
  + 'the symptom after the freeze gate has already rejected the spec');

// ---------------------------------------------------------------------------------------------
// P3 — reachable from where the freeze gate is described.
// ---------------------------------------------------------------------------------------------

function sectionAround(needle, span) {
  const i = low.indexOf(needle.toLowerCase());
  if (i < 0) return '';
  return src.slice(Math.max(0, i - span), Math.min(src.length, i + span));
}

// Step 4 is where the gate and the guard exemption already live.
const gateArea = sectionAround('freeze-gate.js', 3000) || sectionAround('prove the tests can fail', 3000);
ok(gateArea.length > 0, 'P3 the freeze-gate step is findable in PLANNING.md');
ok(/pure refactor/i.test(gateArea),
  'P3 the pure-refactor guidance is cross-referenced from the freeze-gate step, so a planner who '
  + 'has just met exit 1 finds it without already knowing it exists');

// ---------------------------------------------------------------------------------------------
// P4 [guard] — the playbook suite still passes, with nothing removed.
// ---------------------------------------------------------------------------------------------

const suite = spawnSync('sh', [path.join(REPO, 'scripts', 'test-planning-playbook.sh')], {
  cwd: REPO, encoding: 'utf8', timeout: 120000,
});
const out = (suite.stdout || '') + (suite.stderr || '');
ok(suite.status === 0,
  `P4 [guard] scripts/test-planning-playbook.sh still exits 0 (got ${suite.status})`);
const checks = (out.match(/^PASS/gm) || []).length;
ok(checks >= 42,
  `P4 [guard] …with at least the 42 checks it made before (counted ${checks}) — this task adds `
  + 'guidance, it does not renumber or restructure the steps');

// ---------------------------------------------------------------------------------------------
// P5 [guard] — nothing outside PLANNING.md moved.
//
// A sibling task in the same batch owns scripts/test-all.sh. This is the criterion that proves
// they stayed out of each other's way, which is the whole premise of running them concurrently.
// ---------------------------------------------------------------------------------------------

const git = spawnSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
  cwd: REPO, encoding: 'utf8', timeout: 60000,
});
if (git.status === 0) {
  const touched = (git.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !f.startsWith('tests/acceptance/'))
    .filter((f) => !f.startsWith('.beads/'))
    // The documentation phase legitimately records every task in these.
    .filter((f) => !['DESIGN.md', 'docs/STATUS.md', 'CLAUDE.md', 'docs/pipeline-diagram.md',
      'README.md', 'docs/IDEAS.md'].includes(f));
  const strays = touched.filter((f) => f !== 'PLANNING.md');
  ok(strays.length === 0,
    `P5 [guard] nothing outside PLANNING.md and the documentation set was modified `
    + `(strays: ${strays.join(', ') || 'none'}) — a sibling task in this batch owns `
    + 'scripts/test-all.sh');
} else {
  ok(true, 'P5 [guard] skipped: no git range available to diff against');
}

console.log(`\nrepo-n3d: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('repo-n3d: FAILED'); process.exit(1); }
console.log('repo-n3d: all checks passed');
