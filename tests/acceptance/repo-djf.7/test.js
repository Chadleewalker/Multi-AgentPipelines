// Frozen acceptance test — repo-djf.7: durable supervised host operations.
// C1 real child argv/auth/env/bounds; C2 one live feed and late pickup; C3 durable status;
// C4 restart/attention/approved retry; C5 exact settlement (plus guard); C6 overlap/stop/drain.
//
// Frozen interface: runner/operation-manager.js exports createHostOperationManager(options).
// startPreparation({project,batchId,configPath,issues,grant,authorConcurrency?}) launches the
// real prepare-batch CLI. startImplementation({project,operationId,configPath,grant}) launches
// one real runner CLI (the runner creates runId). status/restart/retry/stop take {project,id}.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const findRecord = (root, id) => {
  let found = null;
  const walk = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.json')) { const value = read(file); if (value && value.id === id) found = value; } } };
  walk(root); return found;
};
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } return null; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf7-'));
const stateRoot = path.join(tmp, 'host-state');
const project = path.join(tmp, 'model-editable-project');
const pipelineRoot = path.join(tmp, 'pipeline-root');
const preparationRoot = path.join(tmp, 'preparations');
const runsRoot = path.join(pipelineRoot, 'runs');
const feedFile = path.join(tmp, 'feed.json');
const fixture = path.join(tmp, 'real-child-fixture.js');
for (const dir of [project, pipelineRoot, preparationRoot, runsRoot]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(feedFile, JSON.stringify([{ issueId: 'proposal-1' }]));
fs.writeFileSync(fixture, `
const fs=require('fs'),path=require('path'); const a=process.argv.slice(2), now=()=>Date.now();
const auth=JSON.parse(fs.readFileSync(process.env.PIPELINE_CHILD_AUTHORITY,'utf8'));
const clean={CODEX_API_KEY:process.env.CODEX_API_KEY||null,OPENAI_API_KEY:process.env.OPENAI_API_KEY||null,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,CLAUDE_CODE_OAUTH_TOKEN:process.env.CLAUDE_CODE_OAUTH_TOKEN||null};
if(a[0]==='start'){
 const batch=a[1], root=path.join(process.env.PREPARATION_RUNS_DIR,batch); fs.mkdirSync(root,{recursive:true});
 const issues=[]; for(let i=0;i<a.length;i++) if(a[i]==='--issue') issues.push(a[i+1]);
 const publish=()=>{fs.writeFileSync(path.join(root,'started.json'),JSON.stringify({kind:'preparation',batch,pid:process.pid,startedAt:now(),argv:a,auth,env:clean})); fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({kind:'preparation-manifest',batchId:batch,issues:issues.map(id=>({id}))})); setTimeout(()=>fs.writeFileSync(path.join(root,'terminal.json'),JSON.stringify({finishedAt:now(),issues:issues.map(id=>({id,state:'proven-at-base'}))})),220); setTimeout(()=>process.exit(0),520)};
 if(batch.includes('dead')) setTimeout(publish,5000); else publish();
} else {
  const runId=process.env.RUN_ID; if(!runId) process.exit(9); const root=path.join(process.env.PIPELINE_RUNS_DIR,runId); fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'run.log'),'started\\n'); fs.writeFileSync(path.join(root,'events.jsonl'),JSON.stringify({runId,event:'run.started'})+'\\n'); fs.writeFileSync(path.join(root,'child-observed.json'),JSON.stringify({kind:'implementation',runId,pid:process.pid,startedAt:now(),argv:a,auth,env:clean}));
 const tick=()=>{ if(fs.existsSync(path.join(root,'stop'))){const rows=JSON.parse(fs.readFileSync(process.env.PIPELINE_FEED_FIXTURE,'utf8')); const tasks=rows.map((x,i)=>({issueId:x.issueId,branch:'task/'+x.issueId,prUrl:'https://example.invalid/pr/'+(i+1)})); fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({runId,finishedAt:now(),feed:{enabled:true,ending:'stop-requested'},tasks})); process.exit(0)} setTimeout(tick,20)}; tick();
}
`);

let mod = null; let loadError = '';
try { mod = require(path.join(REPO, 'runner', 'operation-manager.js')); } catch (e) { loadError = (e && e.message) || String(e); }
check('C1.0 operation manager exists at the frozen host interface', mod && typeof mod.createHostOperationManager === 'function', loadError);

async function main() {
  if (!mod) return;
  const launches = [], settlements = [], preSpawnEvidence = [];
  const inertChild = { pid: 900001, once: () => {} };
  let raceResult = null, prepRaceResult = null, parallelPrepResult = null;
  const supervisor = {
    settle: (lease, nonce, result) => {
      const prior = settlements.filter(x => x.nonce === nonce).length;
      const accepted = nonce !== 'b'.repeat(48) || prior > 0;
      settlements.push({ lease, nonce, result, accepted });
      return { ok: accepted };
    },
    withSection: (_admission, _section, fn) => fn(),
  };
  const inherited = { ...process.env, CODEX_API_KEY: 'remove', OPENAI_API_KEY: 'remove', ANTHROPIC_API_KEY: 'remove', CLAUDE_CODE_OAUTH_TOKEN: 'remove', KEEP_ME: 'yes', PREPARATION_RUNS_DIR: preparationRoot, PIPELINE_RUNS_DIR: runsRoot, PIPELINE_FEED_FIXTURE: feedFile };
  let preparationDerivations = 0;
  const preparationState = { deriveState: (root, batchId) => {
    preparationDerivations += 1;
    const dir = path.join(root, batchId), manifest = read(path.join(dir, 'manifest.json'));
    if (!manifest) return { ok: false, error: 'missing manifest', manifest: null, issues: [] };
    const terminal = read(path.join(dir, 'terminal.json'));
    // Match runner/preparation-state.js: terminality is represented by per-issue states;
    // deriveState deliberately has no synthetic finishedAt shortcut.
    return { ok: true, manifest, events: [], issues: terminal ? terminal.issues : manifest.issues.map(issue => ({ ...issue, state: 'pending' })) };
  } };
  const factory = () => mod.createHostOperationManager({ stateRoot, pipelineRoot, preparationRoot, runsRoot, supervisor, lifecycleTimeoutMs: 7000, env: inherited,
    preparationState,
    scripts: { prepare: fixture, run: fixture },
    spawn: (command, argv, options) => {
      const id = argv[1] === 'start' ? argv[2] : (launches.some(x => x.argv[0] === fixture && x.argv[1] === '--config') ? null : 'feed-one');
      if (id) preSpawnEvidence.push({ id, record: findRecord(stateRoot, id) });
      if (id === 'batch-one' && prepRaceResult === null) {
        const contender = mod.createHostOperationManager({ stateRoot, pipelineRoot, preparationRoot, runsRoot, supervisor, preparationState, lifecycleTimeoutMs: 7000, env: inherited, scripts: { prepare: fixture, run: fixture }, spawn: () => inertChild });
        prepRaceResult = contender.startPreparation({ project, batchId: 'batch-one', configPath: 'exact.run.json', issues: ['proposal-1'], grant: { authority: { nonce: '0'.repeat(48), scope: 'preparation', issueId: 'proposal-1', batch: 'batch-one', target: project, parent: { id: 'supervisor-one', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z' }, parentLease: { token: 'lease-one' } } });
        parallelPrepResult = contender.startPreparation({ project, batchId: 'batch-parallel', configPath: 'exact.run.json', issues: ['proposal-parallel'], grant: { authority: { nonce: 'a0'.repeat(24), scope: 'preparation', issueId: 'proposal-parallel', batch: 'batch-parallel', target: project, parent: { id: 'supervisor-one', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z' }, parentLease: { token: 'lease-one' } } });
      }
      if (id === 'feed-one' && raceResult === null) {
        const contender = mod.createHostOperationManager({ stateRoot, pipelineRoot, preparationRoot, runsRoot, supervisor, preparationState, lifecycleTimeoutMs: 7000, env: inherited, scripts: { prepare: fixture, run: fixture }, spawn: () => inertChild });
        raceResult = contender.startImplementation({ project, operationId: 'feed-race', configPath: 'exact.run.json', grant: { authority: { nonce: '7'.repeat(48), scope: 'implementation', issueId: null, batch: null, target: project, parent: { id: 'supervisor-one', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z' }, parentLease: { token: 'lease-one' } } });
      }
      launches.push({ command, argv, options });
      const child = cp.spawn(command, argv, options);
      // Suppress the original manager's preparation exit callback to simulate its crash;
      // a later manager must still derive completion from durable state plus OS liveness.
      return id === 'batch-one' ? { pid: child.pid, once: () => {} } : child;
    } });
  const manager = factory();
  const prepAuthority = { nonce: 'a'.repeat(48), scope: 'preparation', issueId: 'proposal-1', batch: 'batch-one', target: project, parent: { id: 'supervisor-one', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z' };
  const runAuthority = { nonce: 'b'.repeat(48), scope: 'implementation', issueId: null, batch: null, target: project, parent: { id: 'supervisor-one', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z' };
  const prep = manager.startPreparation({ project, batchId: 'batch-one', configPath: 'exact.run.json', issues: ['proposal-1'], authorConcurrency: 2, grant: { authority: prepAuthority, parentLease: { token: 'lease-one' } } });
  const run = manager.startImplementation({ project, operationId: 'feed-one', configPath: 'exact.run.json', grant: { authority: runAuthority, parentLease: { token: 'lease-one' } } });
  const prepCall = launches.find(x => x.argv.includes('batch-one'));
  const runCall = launches.find(x => x.argv[0] === fixture && x.argv[1] === '--config');
  check('C1.1 preparation uses the real start/batch/config/issue CLI with shell:false', prep.ok && prepCall && prepCall.command === process.execPath && prepCall.argv[0] === fixture && prepCall.argv[1] === 'start' && prepCall.argv[2] === 'batch-one' && prepCall.argv.includes('--config') && prepCall.argv.includes('exact.run.json') && prepCall.argv.includes('--issue') && prepCall.argv.includes('proposal-1') && prepCall.options.shell === false, JSON.stringify(prepCall));
  check('C1.2 implementation uses one real runner --config CLI and persists the runner-supported RUN_ID before launch', run.ok && run.operation.runId && runCall && runCall.command === process.execPath && runCall.argv[0] === fixture && runCall.argv[1] === '--config' && runCall.argv[2] === 'exact.run.json' && !runCall.argv.includes('feed-one') && runCall.options.env.RUN_ID === run.operation.runId && runCall.options.shell === false, JSON.stringify({ run: run.operation, runCall }));
  check('C1.3 child lifecycle is bounded, output cannot block on unread pipes, and ambient provider credentials are absent', prepCall && runCall && prepCall.options.timeout === 7000 && runCall.options.timeout === 7000 && prepCall.options.stdio === 'ignore' && runCall.options.stdio === 'ignore' && prepCall.options.env.KEEP_ME === 'yes' && runCall.options.env.KEEP_ME === 'yes' && !Object.prototype.hasOwnProperty.call(prepCall.options.env, 'CODEX_API_KEY') && !Object.prototype.hasOwnProperty.call(prepCall.options.env, 'OPENAI_API_KEY') && !Object.prototype.hasOwnProperty.call(prepCall.options.env, 'ANTHROPIC_API_KEY') && !Object.prototype.hasOwnProperty.call(prepCall.options.env, 'CLAUDE_CODE_OAUTH_TOKEN') && !Object.prototype.hasOwnProperty.call(runCall.options.env, 'CODEX_API_KEY') && !Object.prototype.hasOwnProperty.call(runCall.options.env, 'OPENAI_API_KEY') && !Object.prototype.hasOwnProperty.call(runCall.options.env, 'ANTHROPIC_API_KEY') && !Object.prototype.hasOwnProperty.call(runCall.options.env, 'CLAUDE_CODE_OAUTH_TOKEN'));
  check('C1.4 authority files contain the exact grants outside the project and spawned PIDs are real', prep.operation && run.operation && Number.isInteger(prep.operation.pid) && Number.isInteger(run.operation.pid) && prep.operation.pid > 0 && run.operation.pid > 0 && prep.operation.pid !== run.operation.pid && read(prep.operation.authorityPath).nonce === prepAuthority.nonce && read(run.operation.authorityPath).nonce === runAuthority.nonce && !prep.operation.authorityPath.startsWith(project) && !run.operation.authorityPath.startsWith(project), JSON.stringify({ prep: prep.operation, run: run.operation }));

  const defaultLaunches = [];
  const defaultsProject = path.join(tmp, 'defaults-project'); fs.mkdirSync(defaultsProject);
  const defaultsManager = mod.createHostOperationManager({ stateRoot: path.join(tmp, 'defaults-state'), pipelineRoot: REPO, supervisor, preparationState, env: inherited,
    spawn: (command, argv, options) => { defaultLaunches.push({ command, argv, options }); return inertChild; } });
  const defaultPrep = defaultsManager.startPreparation({ project: defaultsProject, batchId: 'default-batch', configPath: 'default.json', issues: ['proposal-default-a', 'proposal-default-b'], grant: { authority: { ...prepAuthority, nonce: 'f'.repeat(48), batch: 'default-batch', target: defaultsProject }, parentLease: { token: 'lease-default' } } });
  const defaultRun = defaultsManager.startImplementation({ project: defaultsProject, operationId: 'default-feed', configPath: 'default.json', grant: { authority: { ...runAuthority, nonce: '1'.repeat(48), target: defaultsProject }, parentLease: { token: 'lease-default' } } });
  check('C1.5 production defaults launch repository entrypoints and honor the real preparation root contract', defaultPrep.ok && defaultRun.ok && path.resolve(defaultLaunches[0].argv[0]) === path.join(REPO, 'scripts', 'prepare-batch.js') && path.resolve(defaultLaunches[1].argv[0]) === path.join(REPO, 'runner', 'run.js') && path.resolve(defaultPrep.operation.artifactPaths.preparationDir) === path.join(preparationRoot, 'default-batch') && path.resolve(defaultRun.operation.runDir).startsWith(path.join(REPO, 'runs') + path.sep), JSON.stringify({ defaultLaunches, defaultPrep, defaultRun }));
  const defaultPrepDir = path.join(preparationRoot, 'default-batch'); fs.mkdirSync(defaultPrepDir, { recursive: true });
  fs.writeFileSync(path.join(defaultPrepDir, 'manifest.json'), JSON.stringify({ kind: 'preparation-manifest', batchId: 'default-batch', issues: [{ id: 'proposal-default-a' }, { id: 'proposal-default-b' }] }));
  fs.writeFileSync(path.join(defaultPrepDir, 'terminal.json'), JSON.stringify({ issues: [{ id: 'proposal-default-a', state: 'unproven' }, { id: 'proposal-default-b', state: 'already-frozen' }] }));
  const completedUnproven = defaultsManager.status({ project: defaultsProject, id: 'default-batch' });
  check('C1.5a a child that exits with durable terminal success/failure evidence is a completed operation and its grant settles', completedUnproven.state === 'completed' && settlements.some(x => x.nonce === 'f'.repeat(48) && x.accepted), JSON.stringify(completedUnproven));
  const interruptedProject = path.join(tmp, 'interrupted-project'); fs.mkdirSync(interruptedProject);
  const interrupted = defaultsManager.startPreparation({ project: interruptedProject, batchId: 'interrupted-batch', configPath: 'default.json', issues: ['proposal-interrupted'], grant: { authority: { ...prepAuthority, nonce: 'ab'.repeat(24), batch: 'interrupted-batch', target: interruptedProject }, parentLease: { token: 'lease-interrupted' } } });
  const interruptedDir = path.join(preparationRoot, 'interrupted-batch'); fs.mkdirSync(interruptedDir, { recursive: true });
  fs.writeFileSync(path.join(interruptedDir, 'manifest.json'), JSON.stringify({ kind: 'preparation-manifest', batchId: 'interrupted-batch', issues: [{ id: 'proposal-interrupted' }] }));
  fs.writeFileSync(path.join(interruptedDir, 'terminal.json'), JSON.stringify({ issues: [{ id: 'proposal-interrupted', state: 'interrupted-unknown' }] }));
  const interruptedStatus = defaultsManager.status({ project: interruptedProject, id: 'interrupted-batch' });
  check('C1.5b interrupted-unknown remains attention and never settles as completed evidence', interrupted.ok && interruptedStatus.state === 'attention' && !settlements.some(x => x.nonce === 'ab'.repeat(24)), JSON.stringify(interruptedStatus));
  let unsafeRejected = false;
  try {
    const unsafe = mod.createHostOperationManager({ stateRoot: path.join(project, '.operation-state'), pipelineRoot, preparationRoot, runsRoot, supervisor, preparationState, env: inherited, scripts: { prepare: fixture, run: fixture }, spawn: () => inertChild });
    const result = unsafe.startPreparation({ project, batchId: 'unsafe-batch', configPath: 'unsafe.json', issues: ['proposal-unsafe'], grant: { authority: { ...prepAuthority, nonce: '2'.repeat(48), batch: 'unsafe-batch' }, parentLease: { token: 'lease-unsafe' } } });
    unsafeRejected = result && result.ok === false;
  } catch { unsafeRejected = true; }
  check('C1.6 durable operation and authority state is rejected inside the model-editable project', unsafeRejected);
  const colocatedRoot = path.join(tmp, 'colocated-pipeline-project'); fs.mkdirSync(path.join(colocatedRoot, 'runs', 'preparations'), { recursive: true });
  const colocatedLaunches = [];
  const colocated = mod.createHostOperationManager({ stateRoot: path.join(tmp, 'colocated-host-state'), pipelineRoot: colocatedRoot, preparationRoot: path.join(colocatedRoot, 'runs', 'preparations'), runsRoot: path.join(colocatedRoot, 'runs'), supervisor, preparationState, env: inherited, scripts: { prepare: fixture, run: fixture }, spawn: (command, argv, options) => { colocatedLaunches.push({ command, argv, options }); return inertChild; } });
  const colocatedPrep = colocated.startPreparation({ project: colocatedRoot, batchId: 'colocated-batch', configPath: 'colocated.json', issues: ['proposal-colocated'], grant: { authority: { ...prepAuthority, nonce: '5'.repeat(48), batch: 'colocated-batch', target: colocatedRoot }, parentLease: { token: 'lease-colocated' } } });
  check('C1.7 a pipeline may supervise its own checkout while only host operation state stays external', colocatedPrep.ok && colocatedLaunches.some(x => x.argv.includes('colocated-batch')), JSON.stringify(colocatedPrep));
  const beforeWrongGrant = launches.length;
  const wrongGrant = manager.startPreparation({ project, batchId: 'wrong-grant', configPath: 'exact.run.json', issues: ['proposal-wrong'], grant: { authority: { ...prepAuthority, nonce: '6'.repeat(48), scope: 'implementation', target: path.join(tmp, 'somewhere-else'), batch: 'wrong-grant' }, parentLease: { token: 'lease-one' } } });
  check('C1.8 target/scope-mismatched grants fail before authority write or process launch', wrongGrant.ok === false && launches.length === beforeWrongGrant);
  const prepBeforeSpawn = preSpawnEvidence.find(x => x.id === 'batch-one'), runBeforeSpawn = preSpawnEvidence.find(x => x.id === 'feed-one');
  check('C1.9 durable launching evidence exists before spawn closes the untracked-child crash window', prepBeforeSpawn && runBeforeSpawn && prepBeforeSpawn.record && runBeforeSpawn.record && prepBeforeSpawn.record.state === 'launching' && runBeforeSpawn.record.state === 'launching' && runBeforeSpawn.record.runId === run.operation.runId && runBeforeSpawn.record.pid === null, JSON.stringify(preSpawnEvidence));
  check('C1.10 exact duplicates are blocked while launching, but an independent preparation batch may overlap', raceResult && raceResult.ok === false && prepRaceResult && prepRaceResult.ok === false && parallelPrepResult && parallelPrepResult.ok, JSON.stringify({ raceResult, prepRaceResult, parallelPrepResult }));
  const projectA = path.join(tmp, 'project-a'), projectB = path.join(tmp, 'project-b'); fs.mkdirSync(projectA); fs.mkdirSync(projectB);
  const multiState = path.join(tmp, 'multi-project-state');
  const multiManager = mod.createHostOperationManager({ stateRoot: multiState, pipelineRoot, preparationRoot, runsRoot, supervisor, preparationState, env: inherited, scripts: { prepare: fixture, run: fixture }, spawn: () => inertChild });
  const sameIdA = multiManager.startPreparation({ project: projectA, batchId: 'shared-batch', configPath: 'a.json', issues: ['proposal-a'], grant: { authority: { ...prepAuthority, nonce: '8'.repeat(48), batch: 'shared-batch', target: projectA }, parentLease: { token: 'lease-a' } } });
  const sameIdB = multiManager.startPreparation({ project: projectB, batchId: 'shared-batch', configPath: 'b.json', issues: ['proposal-b'], grant: { authority: { ...prepAuthority, nonce: '9'.repeat(48), batch: 'shared-batch', target: projectB }, parentLease: { token: 'lease-b' } } });
  check('C1.11 operation identity is project plus id, so equal batch ids in different projects do not collide', sameIdA.ok && sameIdB.ok && sameIdA.operation.statePath !== sameIdB.operation.statePath && multiManager.status({ project: path.join(tmp, 'wrong-project'), id: 'shared-batch' }).ok === false, JSON.stringify({ sameIdA, sameIdB }));

  const runStarted = await waitFor(() => run.operation.runId && read(path.join(runsRoot, run.operation.runId, 'child-observed.json')));
  const prepStartManifest = await waitFor(() => read(path.join(preparationRoot, 'batch-one', 'manifest.json')));
  const prepWhilePending = manager.status({ project, id: 'batch-one' });
  check('C3.0 a real start-time preparation manifest remains running until derived issue state is terminal', prepStartManifest && prepWhilePending.state === 'running' && preparationDerivations > 0, JSON.stringify(prepWhilePending));
  const secondManager = factory();
  const duplicate = secondManager.startImplementation({ project, operationId: 'feed-two', configPath: 'exact.run.json', grant: { authority: { ...runAuthority, nonce: 'c'.repeat(48) }, parentLease: { token: 'lease-one' } } });
  const firstRunLaunch = launches.find(x => x.argv[0] === fixture && x.argv[1] === '--config');
  check('C2.1 a second manager reconstructs durable liveness and refuses a competing project feed', runStarted && duplicate.ok === false && launches.findLast(x => x.argv[0] === fixture && x.argv[1] === '--config') === firstRunLaunch, JSON.stringify(duplicate));
  fs.writeFileSync(feedFile, JSON.stringify([{ issueId: 'proposal-1' }, { issueId: 'proposal-2' }]));
  const runningStatus = manager.status({ project, id: 'feed-one' });
  const stop = manager.stop({ project, id: 'feed-one' });
  const completedRun = await waitFor(() => { const s = manager.status({ project, id: 'feed-one' }); return s.state === 'completed' && s; });
  check('C2.2 late proposal is picked up by the original live feed and maps to actual branch/PR rows', runningStatus.state === 'running' && stop.ok && completedRun && completedRun.runId === runStarted.runId && completedRun.manifest && completedRun.manifest.tasks.some(x => x.issueId === 'proposal-1' && x.branch && x.prUrl) && completedRun.manifest.tasks.some(x => x.issueId === 'proposal-2' && x.branch && x.prUrl), JSON.stringify(completedRun));
  check('C2.3 stop writes the real run sentinel, drains the child and starts no replacement', completedRun && completedRun.runDir && fs.existsSync(path.join(completedRun.runDir, 'stop')) && completedRun.manifest.feed.ending === 'stop-requested' && launches.findLast(x => x.argv[0] === fixture && x.argv[1] === '--config') === firstRunLaunch);
  const prepTerminalWhileChildLive = await waitFor(() => read(path.join(preparationRoot, 'batch-one', 'terminal.json')));
  const prepBeforeExit = secondManager.status({ project, id: 'batch-one' });
  check('C3.0a terminal-looking preparation events do not complete or settle while the coordinator child is still live', prepTerminalWhileChildLive && prepBeforeExit.state === 'running' && !settlements.some(x => x.nonce === prepAuthority.nonce), JSON.stringify(prepBeforeExit));

  const completedPrep = await waitFor(() => { const s = secondManager.status({ project, id: 'batch-one' }); return s.state === 'completed' && s; });
  const durablePrep = read(prep.operation.statePath), durableRun = read(run.operation.statePath);
  check('C3.1 durable host records retain operation, pid/process identity, grant, batch/run and artifact paths outside model trees', durablePrep && durableRun && durablePrep.pid === prep.operation.pid && durableRun.pid === run.operation.pid && durablePrep.processIdentity && durableRun.processIdentity && durablePrep.processIdentity.pid === durablePrep.pid && durableRun.processIdentity.pid === durableRun.pid && durablePrep.processIdentity.startedAt && durableRun.processIdentity.startedAt && durablePrep.grantNonce === prepAuthority.nonce && durableRun.grantNonce === runAuthority.nonce && durablePrep.batchId === 'batch-one' && durableRun.runId === runStarted.runId && durablePrep.artifactPaths && durableRun.artifactPaths && !durablePrep.statePath.startsWith(project) && !durableRun.statePath.startsWith(project), JSON.stringify({ durablePrep, durableRun }));
  const prepTerminal = read(path.join(preparationRoot, 'batch-one', 'terminal.json'));
  check('C3.2 status derives terminal state from real preparation outcomes and the terminal run manifest, never a start manifest or placeholder promise', completedPrep && completedRun && prepTerminal && completedPrep.preparation && completedPrep.preparation.issues.every(x => x.state === 'proven-at-base') && completedRun.manifest.runId === runStarted.runId);
  check('C3.3 actual timestamps prove preparation and implementation overlapped despite inverted completion order', prepTerminal.finishedAt > completedRun.manifest.finishedAt && runStarted.startedAt < prepTerminal.finishedAt && read(path.join(preparationRoot, 'batch-one', 'started.json')).startedAt < completedRun.manifest.finishedAt);

  check('C4.1 restart of live or completed durable evidence never launches a duplicate', manager.restart({ project, id: 'feed-one' }).ok === false && secondManager.restart({ project, id: 'batch-one' }).ok === false && launches.findLast(x => x.argv[0] === fixture && x.argv[1] === '--config') === firstRunLaunch);
  const deadAuthority = { ...prepAuthority, nonce: 'd'.repeat(48), batch: 'batch-dead' };
  const dead = manager.startPreparation({ project, batchId: 'batch-dead', configPath: 'exact.run.json', issues: ['proposal-dead'], grant: { authority: deadAuthority, parentLease: { token: 'lease-one' } } });
  if (dead.ok) { try { process.kill(dead.operation.pid, 'SIGKILL'); } catch {} }
  const attention = await waitFor(() => { const s = manager.status({ project, id: 'batch-dead' }); return s.state === 'attention' && s; });
  const deniedRetry = manager.retry({ project, id: 'batch-dead', approved: false });
  const beforeRetryPid = attention && attention.pid;
  const retryAuthority = { ...deadAuthority, nonce: 'e'.repeat(48) };
  const approvedRetry = manager.retry({ project, id: 'batch-dead', approved: true, grant: { authority: retryAuthority, parentLease: { token: 'lease-one' } } });
  const retryPrepCall = launches.findLast(x => x.argv.includes('batch-dead'));
  check('C4.2 dead/incomplete preparation becomes attention and approved retry preserves its original issue argv', dead.ok && attention && deniedRetry.ok === false && approvedRetry.ok && approvedRetry.operation.pid !== beforeRetryPid && approvedRetry.operation.attempt > attention.attempt && retryPrepCall.argv.includes('--issue') && retryPrepCall.argv.includes('proposal-dead'), JSON.stringify({ attention, approvedRetry, retryPrepCall }));
  check('C4.3 retry preserves prior attempt evidence instead of rewriting it', approvedRetry.operation.previousAttempts && approvedRetry.operation.previousAttempts.some(x => x.pid === beforeRetryPid && x.state === 'attention'));
  if (approvedRetry.ok) { try { process.kill(approvedRetry.operation.pid, 'SIGKILL'); } catch {} }

  const preserveAuthority = { ...prepAuthority, nonce: 'ca'.repeat(24), batch: 'batch-preserve' };
  const preserve = manager.startPreparation({ project, batchId: 'batch-preserve', configPath: 'exact.run.json', issues: ['proposal-preserve'], grant: { authority: preserveAuthority, parentLease: { token: 'lease-one' } } });
  if (preserve.ok) { try { process.kill(preserve.operation.pid, 'SIGKILL'); } catch {} }
  const preserveAttention = await waitFor(() => { const s = manager.status({ project, id: 'batch-preserve' }); return s.state === 'attention' && s; });
  const preservedBytes = preserveAttention && fs.readFileSync(preserve.operation.statePath, 'utf8');
  const rejectedRetry = manager.retry({ project, id: 'batch-preserve', approved: true, grant: { authority: { ...preserveAuthority, nonce: 'cb'.repeat(24), scope: 'implementation' }, parentLease: { token: 'lease-one' } } });
  const afterRejectedRetry = manager.status({ project, id: 'batch-preserve' });
  check('C4.3a a rejected approved retry leaves the prior attention evidence byte-identical and resumable', preserve.ok && preserveAttention && rejectedRetry.ok === false && afterRejectedRetry.ok && afterRejectedRetry.state === 'attention' && afterRejectedRetry.pid === preserveAttention.pid && afterRejectedRetry.attempt === preserveAttention.attempt && fs.readFileSync(preserve.operation.statePath, 'utf8') === preservedBytes, JSON.stringify({ rejectedRetry, afterRejectedRetry }));

  const deadRunAuthority = { ...runAuthority, nonce: '3'.repeat(48) };
  const deadRun = manager.startImplementation({ project, operationId: 'feed-dead', configPath: 'exact.run.json', grant: { authority: deadRunAuthority, parentLease: { token: 'lease-one' } } });
  const deadRunStarted = deadRun.ok && await waitFor(() => deadRun.operation.runId && read(path.join(runsRoot, deadRun.operation.runId, 'child-observed.json')));
  if (deadRun.ok) { try { process.kill(deadRun.operation.pid, 'SIGKILL'); } catch {} }
  const deadRunAttention = await waitFor(() => { const s = manager.status({ project, id: 'feed-dead' }); return s.state === 'attention' && s; });
  const runLaunchCount = launches.filter(x => x.argv[0] === fixture && x.argv[1] === '--config').length;
  const retriedRun = manager.retry({ project, id: 'feed-dead', approved: true, grant: { authority: { ...deadRunAuthority, nonce: '4'.repeat(48) }, parentLease: { token: 'lease-one' } } });
  const retryRunCall = launches.findLast(x => x.argv[0] === fixture);
  check('C4.4 approved implementation retry relaunches runner/run.js shape, not preparation', deadRunStarted && deadRunAttention && retriedRun.ok && retryRunCall.argv[0] === fixture && retryRunCall.argv[1] === '--config' && retryRunCall.argv[2] === 'exact.run.json' && launches.filter(x => x.argv[0] === fixture && x.argv[1] === '--config').length === runLaunchCount + 1, JSON.stringify(retryRunCall));
  if (retriedRun.ok) { try { process.kill(retriedRun.operation.pid, 'SIGKILL'); } catch {} }

  manager.status({ project, id: 'feed-one' }); manager.status({ project, id: 'feed-one' });
  const prepSettles = settlements.filter(x => x.nonce === prepAuthority.nonce), runSettles = settlements.filter(x => x.nonce === runAuthority.nonce);
  const prepAccepted = prepSettles.find(x => x.accepted), runAccepted = runSettles.find(x => x.accepted);
  const prepSuccessIsUnique = prepAccepted && prepSettles.filter(x => x.accepted).every(x => x === prepAccepted);
  const runSuccessIsUnique = runAccepted && runSettles.filter(x => x.accepted).every(x => x === runAccepted);
  check('C5.1 grants settle exactly once after durable terminal evidence, and a refused settlement remains retryable', prepSuccessIsUnique && runSuccessIsUnique && prepSettles.findLast(() => true) === prepAccepted && runSettles.findLast(() => true) === runAccepted && runSettles.some(x => !x.accepted) && prepAccepted.result.outcome === 'complete' && runAccepted.result.outcome === 'complete', JSON.stringify({ prepSettles, runSettles }));
  check('C5.2 preparation and implementation use distinct grants and can be live concurrently', prep.operation.grantNonce !== run.operation.grantNonce && prep.operation.startedAt <= run.operation.startedAt && prepTerminal.finishedAt > completedRun.manifest.finishedAt);

  const prepStarted = read(path.join(preparationRoot, 'batch-one', 'started.json'));
  check('C6.1 Docker-free fixture used real child identities and exact grant records', prepStarted && runStarted && prepStarted.pid === prep.operation.pid && runStarted.pid === run.operation.pid && prepStarted.auth.nonce === prepAuthority.nonce && runStarted.auth.nonce === runAuthority.nonce);
  check('C6.2 child-observed environments prove provider credentials never crossed the process boundary', prepStarted && runStarted && !prepStarted.env.CODEX_API_KEY && !prepStarted.env.OPENAI_API_KEY && !prepStarted.env.ANTHROPIC_API_KEY && !prepStarted.env.CLAUDE_CODE_OAUTH_TOKEN && !runStarted.env.CODEX_API_KEY && !runStarted.env.OPENAI_API_KEY && !runStarted.env.ANTHROPIC_API_KEY && !runStarted.env.CLAUDE_CODE_OAUTH_TOKEN);
}

main().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(failed); }).catch(e => { check('C1-C6 fixture completes', false, (e && e.stack) || String(e)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(1); });
