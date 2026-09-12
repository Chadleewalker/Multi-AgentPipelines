// Frozen acceptance test — repo-djf.6: real kickoff-to-canonical-spec component.
// PAIRING: C1 -> C1.1-C1.4; C2 -> C2.1-C2.4; C3 -> C3.1-C3.4;
// C4 -> C4.1-C4.3; C5 -> C5.1-C5.3; C6 -> C6.1-C6.4; C7 -> C7.1-C7.2.
// Provider preservation checks are in guard.js.
//
// Frozen interface: scripts/specify-proposal.js exports execute, validateProposal,
// parseProposal, productionAdapters, main and MAX_MODEL_BYTES. execute(options, io, seams)
// accepts { proposalId, configPath, planningModel, reasoningEffort }. productionAdapters
// accepts the same options plus injectable deps for Docker-free verification of real wiring.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const stringify = JSON.stringify;
let api = null; let loadError = '';
try { api = require(path.join(REPO, 'scripts', 'specify-proposal.js')); } catch (e) { loadError = (e && e.message) || String(e); }
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
const sha = (value) => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : stringify(value)).digest('hex')}`;
const packet = { version: 'kickoff-intake/1', title: 'Proposal title', description: 'Add the capability.', constraints: ['Preserve behavior.'], examples: ['One example.'], nonGoals: [], priority: 1, relations: [], origin: { kind: 'agent-session', ref: 'idea-1' } };
const intent = stringify(packet);
const kickoff = { version: 'kickoff-intake/1', id: 'kp-0123456789abcdef', target: 'C:/repo', hash: sha(intent), intent, createdAt: '2026-09-11T00:00:00.000Z' };
const ready = { spec: 'Build without changing unrelated behavior.', acceptanceCriteria: ['Capability works.', 'Existing behavior stays green.'], designReferences: ['DESIGN.md#the-planning-phase-the-spec-layer'], difficulty: 'medium', status: 'ready' };
const question = { spec: 'Blocked on one product choice.', acceptanceCriteria: ['Selected behavior works.'], designReferences: ready.designReferences, difficulty: 'medium', status: 'needs-input', question: 'Which retention behavior should be canonical?' };
const OPTIONS = { proposalId: kickoff.id, configPath: '/pipeline/run.config.json', planningModel: 'gpt-5.6-terra', reasoningEffort: 'medium' };

function fixture(outputs, more = {}) {
  const calls = [], questions = new Map(), answers = new Map(), receipts = new Map(), beads = new Map();
  const sequence = Array.isArray(outputs) ? outputs : [outputs]; let launch = 0, creates = 0, crashed = false;
  const seams = {
    readKickoff: async id => { calls.push(['readKickoff', id]); return kickoff; },
    resolveIntegration: async () => { calls.push(['resolveIntegration']); return { commit: 'a'.repeat(40) }; },
    createReadOnlyCheckout: async commit => { calls.push(['checkout', commit]); return { path: '/isolated/read-only', commit, readOnly: true }; },
    cleanupCheckout: async checkout => { calls.push(['cleanupCheckout', checkout]); },
    launchCodex: async plan => { calls.push(['codex', plan]); return JSON.stringify(sequence[Math.min(launch++, sequence.length - 1)]); },
    readQuestion: async key => { calls.push(['readQuestion', key]); return questions.get(key) || null; },
    appendQuestion: async (key, value) => { calls.push(['appendQuestion', key, value]); if (!questions.has(key)) questions.set(key, value); },
    readAnswer: async key => { calls.push(['readAnswer', key]); return answers.get(key) || null; },
    writeAnswer: async (key, value) => { calls.push(['writeAnswer', key, value]); answers.set(key, value); },
    validateDesignReference: async (ref, commit) => { calls.push(['design', ref, commit]); return { ok: ref === ready.designReferences[0] && commit === 'a'.repeat(40) }; },
    beadsFind: async ref => { calls.push(['beadsFind', ref]); return beads.get(ref) || null; },
    beadsCreate: async request => { calls.push(['beadsCreate', request]); creates += 1; const row = { id: `repo-created-${creates}`, externalRef: request.externalRef }; beads.set(request.externalRef, row); return row; },
    readReceipt: async key => { calls.push(['readReceipt', key]); return receipts.get(key) || null; },
    writeReceipt: async (key, value) => { calls.push(['writeReceipt', key, value]); receipts.set(key, value); },
    sha256: sha, now: () => '2026-09-11T00:00:01.000Z',
    crash: async point => { calls.push(['crash', point]); if (more.crashOnce && point === 'after-beads-success-before-receipt' && !crashed) { crashed = true; throw new Error('simulated crash'); } },
    ...more,
  };
  return { calls, questions, answers, receipts, beads, seams, get creates() { return creates; } };
}
async function invoke(f) { if (!api || typeof api.execute !== 'function') return null; try { return await api.execute(OPTIONS, { out() {}, err() {} }, f.seams); } catch (e) { return { thrown: (e && e.message) || String(e) }; } }
function parsed(text) { try { return api && api.parseProposal(text); } catch { return null; } }
const argsOf = plan => (plan && (plan.args || plan.argv)) || [];

async function main() {
  check('C1.1 exposes deterministic engine, bounded parser, production adapters and CLI without mutating platform globals', api
    && typeof api.execute === 'function' && typeof api.validateProposal === 'function'
    && typeof api.parseProposal === 'function' && typeof api.productionAdapters === 'function'
    && typeof api.main === 'function' && JSON.stringify === stringify, loadError);
  const c1 = fixture(ready), c1r = await invoke(c1), codex = c1.calls.find(x => x[0] === 'codex'), plan = codex && codex[1], argv = argsOf(plan);
  const corrupt = fixture(ready, { readKickoff: async () => ({ ...kickoff, version: 'old-intake/0' }) });
  const corruptResult = await invoke(corrupt);
  check('C1.2 verifies the full immutable kickoff record, pins integration before model launch and cleans isolation', c1r && c1r.status === 'ready' && c1.calls[0][0] === 'readKickoff' && c1.calls[0][1] === kickoff.id && c1.calls.findIndex(x => x[0] === 'resolveIntegration') < c1.calls.findIndex(x => x[0] === 'codex') && plan && plan.commit === 'a'.repeat(40) && plan.kickoffHash === kickoff.hash && plan.intent.title === packet.title && c1.calls.some(x => x[0] === 'cleanupCheckout' && x[1].path === '/isolated/read-only') && corruptResult && corruptResult.status === 'refused' && !corrupt.calls.some(x => x[0] === 'codex'), stringify({ calls: c1.calls, corrupt: corrupt.calls }));
  check('C1.3 planner is configured Codex in isolated checkout with explicit read-only structured noninteractive execution', plan && plan.command === 'codex' && plan.model === OPTIONS.planningModel && plan.checkout.path === '/isolated/read-only' && argv[0] === 'exec' && argv.includes('--model') && argv.includes(OPTIONS.planningModel) && argv.includes('--sandbox') && argv[argv.indexOf('--sandbox') + 1] === 'read-only' && argv.includes('--ephemeral') && argv.includes('--ignore-user-config') && argv.includes('--ignore-rules') && argv.includes('--strict-config') && argv.includes('--json') && argv[argv.length - 1] === '-' && !argv.includes('workspace-write') && !argv.includes('danger-full-access') && !argv.includes('--approve-for-me'), JSON.stringify(plan));
  check('C1.4 planner selects saved ChatGPT auth and strips both API-key fallbacks', plan && plan.auth === 'chatgpt' && Array.isArray(plan.removeEnv) && plan.removeEnv.includes('CODEX_API_KEY') && plan.removeEnv.includes('OPENAI_API_KEY'));

  check('C2.1 parser has an at-most-64KiB bound and accepts both closed result variants', Number.isInteger(api && api.MAX_MODEL_BYTES) && api.MAX_MODEL_BYTES > 0 && api.MAX_MODEL_BYTES <= 65536 && parsed(JSON.stringify(ready)) && parsed(JSON.stringify(question)));
  check('C2.2 parser refuses malformed, oversized, array and trailing-prose output', !parsed('{bad') && !parsed('[]') && !parsed(`${JSON.stringify(ready)} trailing`) && !parsed(JSON.stringify({ ...ready, spec: 'x'.repeat((api && api.MAX_MODEL_BYTES) || 65536) })));
  check('C2.3 validation uses the design difficulty vocabulary and rejects operational, extra or unbounded values', api.validateProposal({ ...ready, difficulty: 'trivial' }) && api.validateProposal({ ...ready, difficulty: 'hard' }) && !api.validateProposal({ ...ready, difficulty: 'low' }) && !api.validateProposal({ ...ready, difficulty: 'high' }) && !api.validateProposal({ ...ready, issueId: 'forged' }) && !api.validateProposal({ ...ready, command: 'bd create' }) && !api.validateProposal({ ...ready, transition: 'ready' }) && !api.validateProposal({ ...ready, extra: true }) && !api.validateProposal({ ...ready, acceptanceCriteria: Array(200).fill('x') }) && !api.validateProposal({ ...ready, spec: 'x'.repeat(70000) }));
  check('C2.4 ready has no question and needs-input has exactly one concrete string question', api.validateProposal(ready) && api.validateProposal(question) && !api.validateProposal({ ...ready, question: 'not allowed' }) && !api.validateProposal({ ...question, question: '' }) && !api.validateProposal({ ...question, question: ['one', 'two'] }));

  const c3 = fixture([question, ready]), first = await invoke(c3), stored = c3.questions.get(kickoff.hash);
  const firstModelCall = c3.calls.find(x => x[0] === 'codex');
  check('C3.1 needs-input appends immutable question evidence and performs no Beads/Git write', first && first.status === 'needs-input' && stored && stored.question === question.question && stored.evidenceHash === sha(question) && !c3.calls.some(x => x[0] === 'beadsCreate' || x[0] === 'gitWrite'), JSON.stringify(c3.calls));
  c3.answers.set(kickoff.hash, { answer: 'Keep records for 30 days.', previousEvidenceHash: stored && stored.evidenceHash });
  const second = await invoke(c3), secondPlan = c3.calls.filter(x => x[0] === 'codex')[1];
  check('C3.2 appended answer launches a new evidence-linked attempt that can become ready', second && second.status === 'ready' && secondPlan && secondPlan !== firstModelCall && secondPlan[1].answer === 'Keep records for 30 days.' && secondPlan[1].questionEvidenceHash === stored.evidenceHash && typeof secondPlan[1].prompt === 'string' && secondPlan[1].prompt.includes('Keep records for 30 days.') && secondPlan[1].prompt.includes(stored.evidenceHash), stringify(c3.calls));
  check('C3.3 answer never overwrites or duplicates original question evidence', c3.questions.get(kickoff.hash) === stored
    && c3.calls.findIndex(x => x[0] === 'appendQuestion') === c3.calls.findLastIndex(x => x[0] === 'appendQuestion'));
  const badAnswer = fixture(ready); badAnswer.questions.set(kickoff.hash, { question: question.question, evidenceHash: sha(question) }); badAnswer.answers.set(kickoff.hash, { answer: 'Thirty days.', previousEvidenceHash: `sha256:${'0'.repeat(64)}` });
  const badAnswerResult = await invoke(badAnswer);
  check('C3.4 tampered answer linkage fails before model or Beads', badAnswerResult && badAnswerResult.status === 'refused' && !badAnswer.calls.some(x => x[0] === 'codex' || x[0] === 'beadsCreate'));

  const c4 = fixture(ready), c4r = await invoke(c4), created = c4.calls.find(x => x[0] === 'beadsCreate');
  check('C4.1 all design refs resolve at pinned commit before one Beads creation', c4r && c4r.status === 'ready' && c4.calls.filter(x => x[0] === 'design').length === ready.designReferences.length && c4.calls.every(x => x[0] !== 'design' || x[2] === 'a'.repeat(40)) && c4.calls.findIndex(x => x[0] === 'design') < c4.calls.findIndex(x => x[0] === 'beadsCreate') && c4.calls.findIndex(x => x[0] === 'beadsCreate') === c4.calls.findLastIndex(x => x[0] === 'beadsCreate'), JSON.stringify(c4.calls));
  check('C4.2 Beads receives native spec fields, immutable provenance and idempotency reference', created && created[1].title === packet.title && created[1].description === ready.spec && stringify(created[1].acceptanceCriteria) === stringify(ready.acceptanceCriteria) && stringify(created[1].designReferences) === stringify(ready.designReferences) && created[1].priority === packet.priority && created[1].kickoffHash === kickoff.hash && created[1].specHash === sha(ready) && typeof created[1].externalRef === 'string' && created[1].externalRef.includes(kickoff.hash), stringify(created && created[1]));
  check('C4.3 issueId comes only from Beads', c4r && c4r.issueId === 'repo-created-1' && c4r.issueId !== kickoff.id && !Object.prototype.hasOwnProperty.call(ready, 'issueId'));

  const c5 = fixture(ready), c5r = await invoke(c5), receipt = c5.receipts.get(kickoff.hash), before = c5.calls.length, restarted = await invoke(c5), restartCalls = c5.calls.slice(before);
  check('C5.1 self-verifying receipt makes normal restart side-effect free', c5r && restarted && restarted.issueId === c5r.issueId && receipt && receipt.proposal && receipt.specHash === sha(receipt.proposal) && receipt.kickoffHash === kickoff.hash && receipt.integrationCommit === 'a'.repeat(40) && !restartCalls.some(x => x[0] === 'codex' || x[0] === 'beadsCreate'), JSON.stringify({ receipt, restartCalls }));
  const badReceipt = fixture(ready); badReceipt.receipts.set(kickoff.hash, { ...receipt, proposal: { ...ready, spec: 'tampered' } }); const badReceiptResult = await invoke(badReceipt);
  check('C5.2 tampered receipt fails before model/Beads', badReceiptResult && badReceiptResult.status === 'refused' && !badReceipt.calls.some(x => x[0] === 'codex' || x[0] === 'beadsFind' || x[0] === 'beadsCreate'));
  const crash = fixture(ready, { crashOnce: true }), crashed = await invoke(crash), absent = crash.receipts.get(kickoff.hash), recovered = await invoke(crash);
  check('C5.3 crash after Beads success before receipt recovers by external ref without duplicate creation', crashed && crashed.thrown === 'simulated crash' && !absent && recovered && recovered.status === 'ready' && recovered.issueId === 'repo-created-1' && crash.calls.findIndex(x => x[0] === 'beadsCreate') === crash.calls.findLastIndex(x => x[0] === 'beadsCreate') && crash.calls.filter(x => x[0] === 'beadsFind').length >= 2 && crash.receipts.has(kickoff.hash), JSON.stringify(crash.calls));

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'specifier-target-'));
  const durableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'specifier-state-'));
  const checkoutPath = path.join(durableRoot, 'checkouts', 'one');
  const launches = [], bdCalls = [], kickoffCalls = [], designCalls = [];
  const exactRef = `kickoff-spec:${kickoff.hash}`;
  const deps = {
    env: { PATH: 'kept', CODEX_API_KEY: 'leak', OPENAI_API_KEY: 'leak', CODEX_HOME: '/saved/chatgpt-session' },
    run: (command, args, options) => {
      launches.push({ command, args, options });
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${'b'.repeat(40)}\n` };
      if (command === 'git' && args[0] === 'show') return { status: 0, stdout: '# The Planning Phase (the spec layer)\n' };
      if (command === 'git') return { status: 0, stdout: '' };
      return { status: 0, stdout: `${stringify({ type: 'item.completed', item: { type: 'agent_message', text: stringify(ready) } })}\n` };
    },
    bdJson: (_cfg, args) => {
      bdCalls.push(args);
      if (args[0] === 'search') return { ok: true, data: [{ id: 'wrong-substring', external_ref: `prefix-${exactRef}` }, { id: 'repo-exact', external_ref: exactRef }] };
      return { ok: true, data: [{ id: 'repo-from-real-adapter', external_ref: exactRef }] };
    },
    loadConfig: () => ({ targetRepoPath: targetRoot, model: OPTIONS.planningModel, reasoningEffort: 'medium', wallClockMinutes: 7, codexAuth: 'chatgpt' }),
    resolveBranch: () => ({ ok: true, branch: 'main' }),
    newCheckoutPath: () => checkoutPath,
    kickoffApi: {
      statePathsFor: target => { kickoffCalls.push(['paths', target]); return { target, state: durableRoot, proposals: path.join(durableRoot, 'proposals') }; },
      readAll: paths => { kickoffCalls.push(['readAll', paths]); return [kickoff]; },
    },
    resolveDesignReference: (root, ref, commit) => { designCalls.push([root, ref, commit]); return { ok: root === checkoutPath && ref === ready.designReferences[0] && commit === 'b'.repeat(40) }; },
  };
  let prod = null; try { prod = api.productionAdapters(OPTIONS, deps); } catch (e) { loadError = (e && e.stack) || String(e); }
  const prodKickoff = prod && await prod.readKickoff(kickoff.id);
  const integration = prod && await prod.resolveIntegration();
  const checkout = prod && await prod.createReadOnlyCheckout(integration.commit);
  const designResult = prod && await prod.validateDesignReference(ready.designReferences[0], integration.commit);
  const prodText = prod && await prod.launchCodex({ ...plan, checkout, prompt: 'bounded prompt' });
  const launchCall = launches.find(x => x.command === 'codex');
  const cleanupResult = prod && await prod.cleanupCheckout(checkout);
  check('C6.1 production adapters read canonical durable intake, resolve configured branch, create detached isolation and validate design at its commit', prodKickoff === kickoff
    && kickoffCalls.some(x => x[0] === 'paths' && x[1] === targetRoot) && kickoffCalls.some(x => x[0] === 'readAll')
    && launches.some(x => x.command === 'git' && x.args[0] === 'rev-parse' && x.args.includes('main') && !x.args.includes('HEAD'))
    && launches.some(x => x.command === 'git' && x.args[0] === 'worktree' && x.args.includes('add') && x.args.includes('--detach') && x.args.includes(integration.commit))
    && launches.some(x => x.command === 'git' && x.args[0] === 'worktree' && x.args.includes('remove') && x.args.includes(checkoutPath))
    && checkout && checkout.path === checkoutPath && checkout.path !== targetRoot && checkout.readOnly === true
    && designResult && designResult.ok === true && designCalls.some(x => x[0] === checkoutPath && x[2] === integration.commit), stringify({ kickoffCalls, launches, designCalls, checkout }));
  check('C6.2 production Codex adapter uses shell:false, timeout, stdin, isolated checkout and key-free saved auth env', prodText === stringify(ready) && launchCall && launchCall.options.shell === false && Number.isFinite(launchCall.options.timeout) && launchCall.options.timeout > 0 && launchCall.options.cwd === checkoutPath && launchCall.options.input === 'bounded prompt' && launchCall.options.env.PATH === 'kept' && launchCall.options.env.CODEX_HOME === '/saved/chatgpt-session' && !Object.prototype.hasOwnProperty.call(launchCall.options.env, 'CODEX_API_KEY') && !Object.prototype.hasOwnProperty.call(launchCall.options.env, 'OPENAI_API_KEY'), stringify(launchCall));
  const found = prod && await prod.beadsFind(exactRef), made = prod && await prod.beadsCreate(created[1]);
  const createArgs = bdCalls.find(x => x[0] === 'create') || [];
  const searchArgs = bdCalls.find(x => x[0] === 'search') || [];
  const questionRecord = { question: question.question, evidenceHash: sha(question) };
  const answerRecord = { answer: 'Thirty days.', previousEvidenceHash: questionRecord.evidenceHash };
  const receiptRecord = { kickoffHash: kickoff.hash, proposal: ready, specHash: sha(ready), issueId: 'repo-ledger' };
  if (prod) { await prod.appendQuestion(kickoff.hash, questionRecord); await prod.writeAnswer(kickoff.hash, answerRecord); await prod.writeReceipt(kickoff.hash, receiptRecord); }
  const ledgerRoundTrip = prod && await Promise.all([prod.readQuestion(kickoff.hash), prod.readAnswer(kickoff.hash), prod.readReceipt(kickoff.hash)]);
  check('C6.3 production Beads and ledger adapters use exact external identity, native fields and durable state outside the target', found && found.id === 'repo-exact' && made && made.id === 'repo-from-real-adapter'
    && searchArgs.includes('--external-contains') && !searchArgs.includes('--external-ref') && searchArgs.includes(exactRef)
    && createArgs.includes('--external-ref') && createArgs.includes('--acceptance') && createArgs.includes('--design') && createArgs.includes('--priority') && createArgs.includes('--metadata')
    && typeof prod.readQuestion === 'function' && typeof prod.appendQuestion === 'function'
    && typeof prod.readAnswer === 'function' && typeof prod.writeAnswer === 'function'
    && typeof prod.readReceipt === 'function' && typeof prod.writeReceipt === 'function'
    && typeof prod.resolveIntegration === 'function' && typeof prod.createReadOnlyCheckout === 'function'
    && typeof prod.cleanupCheckout === 'function' && typeof prod.validateDesignReference === 'function'
    && stringify(ledgerRoundTrip) === stringify([questionRecord, answerRecord, receiptRecord])
    && !fs.existsSync(path.join(targetRoot, '.pipeline')), stringify({ bdCalls, targetRoot, durableRoot, ledgerRoundTrip, cleanupResult }));

  const previousStateRoot = process.env.PIPELINE_STATE_DIR;
  process.env.PIPELINE_STATE_DIR = durableRoot;
  const kickoffApi = require(path.join(REPO, 'scripts', 'kickoff.js'));
  const actualPaths = kickoffApi.statePathsFor(targetRoot);
  const actualKickoff = { ...kickoff, target: actualPaths.target };
  fs.mkdirSync(actualPaths.proposals, { recursive: true });
  fs.writeFileSync(path.join(actualPaths.proposals, `${actualKickoff.id}.json`), `${stringify(actualKickoff)}\n`);
  let defaultProd = null; try { defaultProd = api.productionAdapters(OPTIONS, { ...deps, kickoffApi: undefined, resolveDesignReference: undefined }); } catch (e) { loadError = (e && e.stack) || String(e); }
  const defaultKickoff = defaultProd && await defaultProd.readKickoff(actualKickoff.id);
  fs.mkdirSync(checkoutPath, { recursive: true });
  fs.writeFileSync(path.join(checkoutPath, 'DESIGN.md'), '# The Planning Phase (the spec layer)\n');
  if (defaultProd) await defaultProd.createReadOnlyCheckout('b'.repeat(40));
  const defaultDesign = defaultProd && await defaultProd.validateDesignReference(ready.designReferences[0], 'b'.repeat(40));
  check('C6.4 default production mode imports canonical kickoff intake and a real design resolver without test injections', defaultKickoff && defaultKickoff.id === actualKickoff.id && defaultKickoff.hash === actualKickoff.hash && defaultDesign && defaultDesign.ok === true, stringify({ defaultKickoff, defaultDesign, loadError }));
  if (previousStateRoot === undefined) delete process.env.PIPELINE_STATE_DIR; else process.env.PIPELINE_STATE_DIR = previousStateRoot;
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.rmSync(durableRoot, { recursive: true, force: true });

  const cliCalls = [], io = { out: s => cliCalls.push(['out', s]), err: s => cliCalls.push(['err', s]) };
  const cliDeps = { productionAdapters: () => ({ marker: 'production' }), execute: async (options, _io, seams) => { cliCalls.push(['execute', options, seams]); return { status: 'ready', issueId: 'repo-cli' }; }, recordAnswer: async options => { cliCalls.push(['answer', options]); return { status: 'answered', proposalId: options.proposalId }; } };
  const runCode = api && await api.main(['run', '--config', '/cfg.json', '--proposal', kickoff.id, '--json'], io, cliDeps);
  const runExecution = cliCalls.find(x => x[0] === 'execute');
  const answerCode = api && await api.main(['answer', '--config', '/cfg.json', '--proposal', kickoff.id, '--evidence', sha(question), '--answer', 'Thirty days.', '--json'], io, cliDeps);
  check('C7.1 CLI run maps to production adapters and emits deterministic result', runCode === 0 && cliCalls.some(x => x[0] === 'execute' && x[1].proposalId === kickoff.id && x[1].configPath === '/cfg.json' && x[2].marker === 'production') && cliCalls.some(x => x[0] === 'out' && String(x[1]).includes('repo-cli')), JSON.stringify(cliCalls));
  check('C7.2 CLI answer records a new evidence-linked attempt without invoking model', answerCode === 0 && cliCalls.some(x => x[0] === 'answer' && x[1].proposalId === kickoff.id && x[1].previousEvidenceHash === sha(question) && x[1].answer === 'Thirty days.') && cliCalls.findLast(x => x[0] === 'execute') === runExecution, JSON.stringify(cliCalls));
}
main().then(() => process.exit(failed)).catch(e => { check('C1-C7 fixture completes', false, (e && e.stack) || String(e)); process.exit(1); });
