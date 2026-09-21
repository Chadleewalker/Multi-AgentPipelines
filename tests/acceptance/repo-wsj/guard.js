// Frozen acceptance test — repo-wsj [guard].
//
// Criterion 5 is the only guard: ordinary agent failures, unavailable prerequisites, and
// healthy preparations keep their established classifications and retry behaviour.
// The red companion, test.js, proves criteria 1–4 and 6.
'use strict';

const prepare = require('../../../scripts/prepare-batch');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}

// C5: These protocol outcomes predate the usage-limit park.  They must remain distinct: a
// normal failed model session is not silently converted into a shared subscription pause.
const failedAgent = prepare.parseWorkerEnvelope(JSON.stringify({
  ok: false, outcome: 'agent-failed', error: 'the model exited 1',
}));
check('C5 [guard] an ordinary agent failure remains a verified agent-failed result',
  failedAgent.verified && failedAgent.result.outcome === 'agent-failed' && failedAgent.result.ok === false);

const badProtocol = prepare.parseWorkerEnvelope('this is not a launcher protocol object');
check('C5 [guard] malformed launcher output remains invalid rather than being treated as a usage limit',
  !badProtocol.verified && badProtocol.result.outcome === 'invalid');

check('C5 [guard] an existing preparation still has distinct refusal and attention exits',
  prepare.EXIT_REFUSED === 3 && prepare.EXIT_ATTENTION === 4);

const healthyItems = [{ id: 'one' }, { id: 'two' }];
const expectedOrder = healthyItems.map((item) => item.id);
Promise.resolve(prepare.runPool(healthyItems, 1, async (item) => item.id))
  .then((result) => {
    check('C5 [guard] a healthy one-lane preparation still completes work in roster order',
      JSON.stringify(result) === JSON.stringify(expectedOrder), JSON.stringify(result));
    process.exitCode = failed;
  })
  .catch((error) => { console.log(`FAIL - C5 [guard] pool threw — ${error.message}`); process.exitCode = 1; });
