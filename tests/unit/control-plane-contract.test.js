// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('../../runner/control-plane');
const { DEFAULTS } = require('../../runner/config');
const { OUTCOMES, outcomeFor } = require('../../runner/queue');
const { OWNER_TOKEN_KEY, OWNER_RUN_KEY } = require('../../runner/lock');
const { PSEUDO_TASKS: LOG_PSEUDO_TASKS } = require('../../runner/log');
const { PR_ELIGIBLE_OUTCOMES } = require('../../runner/publish');
const { MEMORY_STATUSES } = require('../../runner/memory');
const { PSEUDO_TASKS: DASHBOARD_PSEUDO_TASKS } = require('../../scripts/dashboard');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); failed += 1; }
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sameMembers = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

check('the checked-in control-plane contract has the supported version', contract.version === 1);
check('the contract and every nested policy value are immutable at runtime',
  Object.isFrozen(contract)
    && Object.isFrozen(contract.configDefaults)
    && Object.isFrozen(contract.outcomes.exitCodes)
    && Object.isFrozen(contract.outcomes.exitCodes['0']));
check('runner config defaults are the canonical contract object', DEFAULTS === contract.configDefaults);
const exampleConfig = JSON.parse(read('run.config.example.json'));
const copiedDefaults = Object.keys(exampleConfig).filter((key) => Object.hasOwn(contract.configDefaults, key));
check('every default repeated in the example config agrees with the canonical contract',
  copiedDefaults.length > 0
    && copiedDefaults.every((key) => exampleConfig[key] === contract.configDefaults[key]));
check('queue exit outcomes are the canonical contract object', OUTCOMES === contract.outcomes.exitCodes);
check('regression failure uses the canonical partial outcome',
  JSON.stringify(outcomeFor(0, { regressions: 'fail' }))
    === JSON.stringify(contract.outcomes.partialOnRegressionFailure));
check('unknown exits retain the canonical failed fallback', outcomeFor(99).status === contract.outcomes.exitCodes['30'].status);
check('Beads owner metadata names come from the contract',
  OWNER_TOKEN_KEY === contract.beads.ownerMetadata.token
    && OWNER_RUN_KEY === contract.beads.ownerMetadata.runId);
check('the run logger uses the canonical pseudo-task set', sameMembers(LOG_PSEUDO_TASKS, contract.run.pseudoTasks));
check('the dashboard uses the canonical pseudo-task set', sameMembers(DASHBOARD_PSEUDO_TASKS, contract.run.pseudoTasks));
check('publication uses the canonical PR-eligible outcomes',
  sameMembers(PR_ELIGIBLE_OUTCOMES, contract.publication.prEligibleOutcomes));
check('memory filing uses the canonical eligible outcomes', MEMORY_STATUSES === contract.memory.eligibleOutcomes);

const runSchema = JSON.parse(read('schemas/run.schema.json'));
const schemaOutcomes = runSchema.properties.tasks.items.properties.outcome.enum;
check('the run artifact schema admits exactly the canonical task statuses',
  sameMembers(schemaOutcomes, contract.outcomes.taskStatuses));
const mappedStatuses = new Set([
  ...Object.values(contract.outcomes.exitCodes).map((entry) => entry.status),
  contract.outcomes.partialOnRegressionFailure.status,
  'undispatchable',
]);
check('every canonical task status is produced by an enumerated control-plane path',
  sameMembers(mappedStatuses, contract.outcomes.taskStatuses));

for (const file of ['AGENTS.md', 'CLAUDE.md']) {
  const text = read(file);
  const headers = text.match(/^## Beads Issue Tracker\s*$/gm) || [];
  check(`${file} contains exactly one Beads instruction block`, headers.length === 1, headers.length);
}

const agents = read('AGENTS.md');
check('AGENTS points to bd prime instead of copying the workflow', /\bbd prime\b/.test(agents));
const claude = read('CLAUDE.md');
check('the Claude guide does not freeze a suite count in prose', !/\b(?:twenty[- ]one|\d+) suites?\b/i.test(claude));
check('the Claude guide delegates the mandatory suite roster to its executable profile',
  /scripts\/test-ci\.sh --list/.test(claude) && /scripts\/test-ci\.sh\b/.test(claude));
check('the Claude guide points to the canonical control-plane guide', /docs\/control-plane\.md/.test(claude));
const readme = read('README.md');
check('README points current operations at the control-plane guide', /docs\/control-plane\.md/.test(readme));
check('README no longer presents the historical status record as current state',
  !/`docs\/STATUS\.md` \| current state/i.test(readme)
    && !/See \[`docs\/STATUS\.md`\]\(docs\/STATUS\.md\)\./.test(readme));
const status = read('docs/STATUS.md');
check('the former status narrative is explicitly archived in place',
  /^# Historical Status Archive/m.test(status) && /docs\/control-plane\.md/.test(status));
const diagram = read('docs/pipeline-diagram.md');
check('the maintained diagram points to the contract instead of copying its outcome table',
  /contracts\/control-plane\.json/.test(diagram) && !/^\| Outcome \| Exit \|/m.test(diagram));

const pipelineConfig = JSON.parse(read('pipeline.config.json'));
check('the canonical JSON contract is frozen against task mutation',
  pipelineConfig.frozenPaths.includes('contracts/control-plane.json'));

console.log(`control-plane contract: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
