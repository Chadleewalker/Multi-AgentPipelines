#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Deterministic host half of kickoff -> canonical Beads spec.  The planner may propose
// content; every identity, transition, bound and durable write is decided here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MAX_MODEL_BYTES = 64 * 1024;
const MAX_TEXT = 32 * 1024;
const MAX_ITEM = 4096;
const MAX_ITEMS = 64;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DIFFICULTIES = new Set(['trivial', 'medium', 'hard']);
const KICKOFF_FIELDS = ['version', 'id', 'target', 'hash', 'intent', 'createdAt'];
const INTENT_FIELDS = ['version', 'title', 'description', 'constraints', 'examples',
  'nonGoals', 'priority', 'relations', 'origin'];
const READY_FIELDS = ['spec', 'acceptanceCriteria', 'designReferences', 'difficulty', 'status'];
const QUESTION_FIELDS = [...READY_FIELDS, 'question'];

const sha256 = value => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const boundedString = (value, max = MAX_ITEM) => typeof value === 'string'
  && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max;
const stringList = (value, max = MAX_ITEMS) => Array.isArray(value) && value.length > 0
  && value.length <= max && value.every(item => boundedString(item));

function validateProposal(value) {
  if (!plainObject(value) || !['ready', 'needs-input'].includes(value.status)) return false;
  const allowed = value.status === 'ready' ? READY_FIELDS : QUESTION_FIELDS;
  if (Object.keys(value).length !== allowed.length
      || Object.keys(value).some(key => !allowed.includes(key))
      || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (!boundedString(value.spec, MAX_TEXT)
      || !stringList(value.acceptanceCriteria)
      || !stringList(value.designReferences, 32)
      || !DIFFICULTIES.has(value.difficulty)) return false;
  if (value.designReferences.some(ref => !/^[^\s:#][^\r\n]*#[^\r\n#]+$/.test(ref)
      || Buffer.byteLength(ref, 'utf8') > 1024)) return false;
  return value.status === 'ready' ? !Object.prototype.hasOwnProperty.call(value, 'question')
    : boundedString(value.question, 4096);
}

function parseProposal(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_MODEL_BYTES) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return validateProposal(value) ? value : null;
}

function verifyKickoff(record, expectedId, hash = sha256) {
  if (!plainObject(record) || record.version !== 'kickoff-intake/1'
      || record.id !== expectedId || typeof record.target !== 'string' || !record.target
      || typeof record.intent !== 'string' || !HASH_RE.test(record.hash)
      || hash(record.intent) !== record.hash
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
      || Object.keys(record).some(key => ![...KICKOFF_FIELDS, 'packet'].includes(key))
      || KICKOFF_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null;
  let intent;
  try { intent = JSON.parse(record.intent); } catch { return null; }
  if (!plainObject(intent) || intent.version !== 'kickoff-intake/1'
      || !boundedString(intent.title, 4096) || !Number.isInteger(intent.priority)
      || intent.priority < 0 || intent.priority > 5
      || Object.keys(intent).length !== INTENT_FIELDS.length
      || INTENT_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(intent, key))
      || typeof intent.description !== 'string'
      || !Array.isArray(intent.constraints) || !Array.isArray(intent.examples)
      || !Array.isArray(intent.nonGoals) || !Array.isArray(intent.relations)
      || !intent.constraints.every(value => typeof value === 'string')
      || !intent.examples.every(value => typeof value === 'string')
      || !intent.nonGoals.every(value => typeof value === 'string')) return null;
  if (record.packet !== undefined && JSON.stringify(record.packet) !== JSON.stringify(intent)) return null;
  return intent;
}

function validQuestionEvidence(value, kickoffHash, hash = sha256) {
  return plainObject(value) && value.kickoffHash === kickoffHash
    && validateProposal(value.proposal) && value.proposal.status === 'needs-input'
    && value.question === value.proposal.question && value.evidenceHash === hash(value.proposal);
}

function validReceipt(receipt, kickoffHash, hash = sha256) {
  if (!plainObject(receipt) || receipt.kickoffHash !== kickoffHash
      || !validateProposal(receipt.proposal) || receipt.proposal.status !== 'ready'
      || receipt.specHash !== hash(receipt.proposal) || !boundedString(receipt.issueId, 512)
      || !COMMIT_RE.test(receipt.integrationCommit || '')) return false;
  if (receipt.receiptHash !== undefined) {
    const body = { ...receipt }; delete body.receiptHash;
    if (receipt.receiptHash !== hash(body)) return false;
  }
  return true;
}

function promptFor(kickoff, intent, answer, questionEvidenceHash) {
  return [
    'Return exactly one JSON object and no prose.',
    'Allowed ready keys: spec, acceptanceCriteria, designReferences, difficulty, status.',
    'Allowed needs-input keys add exactly one question. status is ready or needs-input.',
    'Never propose issue ids, commands, transitions, priorities, or operational identities.',
    `Immutable kickoff hash: ${kickoff.hash}`,
    `Immutable intent JSON: ${kickoff.intent}`,
    answer ? `Evidence-linked answer (${questionEvidenceHash}): ${answer}` : '',
  ].filter(Boolean).join('\n');
}

function plannerPlan(options, checkout, kickoff, intent, answerRecord) {
  const model = options.planningModel || 'gpt-5.6-terra';
  const effort = options.reasoningEffort || 'medium';
  const args = ['exec', '--model', model, '-c', `model_reasoning_effort=${effort}`,
    '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-'];
  return {
    command: 'codex', args, argv: args, model, reasoningEffort: effort, auth: 'chatgpt',
    removeEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'], checkout,
    commit: checkout.commit, kickoffHash: kickoff.hash, intent,
    answer: answerRecord && answerRecord.answer,
    questionEvidenceHash: answerRecord && answerRecord.previousEvidenceHash,
    prompt: promptFor(kickoff, intent, answerRecord && answerRecord.answer,
      answerRecord && answerRecord.previousEvidenceHash),
  };
}

const refused = reason => ({ status: 'refused', reason });

async function execute(options, io = {}, seams) {
  const hash = seams.sha256 || sha256;
  const kickoff = await seams.readKickoff(options.proposalId);
  const intent = verifyKickoff(kickoff, options.proposalId, hash);
  if (!intent) return refused('kickoff record is missing, malformed, or tampered');

  const receipt = await seams.readReceipt(kickoff.hash);
  if (receipt) {
    if (!validReceipt(receipt, kickoff.hash, hash)) return refused('receipt evidence is tampered');
    return { status: 'ready', issueId: receipt.issueId, receipt };
  }

  const priorQuestion = await seams.readQuestion(kickoff.hash);
  const answer = await seams.readAnswer(kickoff.hash);
  if (priorQuestion && !validQuestionEvidence(priorQuestion, kickoff.hash, hash)) {
    return refused('question evidence is malformed or tampered');
  }
  if (answer && (!priorQuestion || !boundedString(answer.answer, 8192)
      || answer.previousEvidenceHash !== priorQuestion.evidenceHash)) {
    return refused('answer evidence does not link to the immutable question');
  }
  if (priorQuestion && !answer) {
    return { status: 'needs-input', question: priorQuestion.question,
      evidenceHash: priorQuestion.evidenceHash };
  }

  const integration = await seams.resolveIntegration();
  if (!integration || !COMMIT_RE.test(integration.commit || '')) return refused('integration commit could not be pinned');
  const checkout = await seams.createReadOnlyCheckout(integration.commit);
  let proposal;
  try {
    const configured = { ...options,
      planningModel: options.planningModel || seams.planningModel,
      reasoningEffort: options.reasoningEffort || seams.reasoningEffort };
    const plan = plannerPlan(configured, checkout, kickoff, intent, answer);
    proposal = parseProposal(await seams.launchCodex(plan));
  } finally {
    await seams.cleanupCheckout(checkout);
  }
  if (!proposal) return refused('planner output violates the closed proposal contract');
  const specHash = hash(proposal);

  if (proposal.status === 'needs-input') {
    if (priorQuestion) return refused('planner returned another question after an answered attempt');
    const evidence = { kickoffHash: kickoff.hash, proposal, question: proposal.question,
      evidenceHash: specHash, createdAt: seams.now() };
    await seams.appendQuestion(kickoff.hash, evidence);
    return { status: 'needs-input', question: proposal.question, evidenceHash: evidence.evidenceHash };
  }

  for (const ref of proposal.designReferences) {
    const result = await seams.validateDesignReference(ref, integration.commit);
    if (!result || !result.ok) return refused(`design reference does not resolve at ${integration.commit}: ${ref}`);
  }

  const externalRef = `kickoff-spec:${kickoff.hash}`;
  const request = {
    title: intent.title, description: proposal.spec,
    acceptanceCriteria: proposal.acceptanceCriteria,
    designReferences: proposal.designReferences, difficulty: proposal.difficulty,
    priority: intent.priority, kickoffHash: kickoff.hash, specHash, externalRef,
    metadata: {
      kickoffId: kickoff.id, kickoffHash: kickoff.hash, specHash,
      integrationCommit: integration.commit,
      fieldIntentRefs: {
        title: `${kickoff.hash}#/title`, priority: `${kickoff.hash}#/priority`,
        description: `${specHash}#/spec`, acceptanceCriteria: `${specHash}#/acceptanceCriteria`,
        designReferences: `${specHash}#/designReferences`, difficulty: `${specHash}#/difficulty`,
      },
    },
  };
  let issue = await seams.beadsFind(externalRef);
  if (!issue) issue = await seams.beadsCreate(request);
  if (!issue || !boundedString(issue.id, 512)) return refused('Beads did not return an issue identity');
  await seams.crash('after-beads-success-before-receipt');
  const receiptBody = { version: 'kickoff-spec-receipt/1', kickoffId: kickoff.id,
    kickoffHash: kickoff.hash, specHash, proposal, integrationCommit: integration.commit,
    externalRef, issueId: issue.id, createdAt: seams.now() };
  const finalReceipt = { ...receiptBody, receiptHash: hash(receiptBody) };
  await seams.writeReceipt(kickoff.hash, finalReceipt);
  return { status: 'ready', issueId: issue.id, receipt: finalReceipt };
}

function normalizeCodexOutput(stdout) {
  const raw = String(stdout || '');
  if (parseProposal(raw)) return raw;
  let answer = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event && event.type === 'item.completed' && event.item
        && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      answer = event.item.text;
    }
  }
  return answer;
}

function atomicJson(file, value, immutable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value)}\n`;
  if (immutable) {
    try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (JSON.stringify(old) !== JSON.stringify(value)) throw new Error(`immutable evidence already exists at ${file}`);
      return;
    }
  }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function makeReadOnly(root) {
  if (!fs.existsSync(root)) return;
  const walk = file => {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(file, name));
      fs.chmodSync(file, 0o555);
    } else fs.chmodSync(file, 0o444);
  };
  walk(root);
}

function makeWritable(root) {
  if (!fs.existsSync(root)) return;
  const walk = file => {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(file, 0o755);
      for (const name of fs.readdirSync(file)) walk(path.join(file, name));
    } else fs.chmodSync(file, 0o644);
  };
  walk(root);
}

function productionAdapters(options, deps = {}) {
  const run = deps.run || spawnSync;
  const loadConfig = deps.loadConfig || require('../runner/config').loadConfig;
  const cfg = loadConfig(options.configPath);
  const kickoffApi = deps.kickoffApi || require('./kickoff');
  const bdJson = deps.bdJson || require('../runner/bd').bdJson;
  const resolveBranch = deps.resolveBranch || require('../runner/queue').resolveBranch;
  const designApi = require('../runner/design-ref');
  if (cfg.codexAuth !== 'chatgpt') {
    throw new Error("specify-proposal requires run.config.json codexAuth 'chatgpt'");
  }
  const state = kickoffApi.statePathsFor(cfg.targetRepoPath);
  const ledger = kind => path.join(state.state, 'specification', kind);
  const fileFor = (kind, key) => path.join(ledger(kind), `${key.replace(':', '-')}.json`);
  const gitOptions = extra => ({ cwd: cfg.targetRepoPath, encoding: 'utf8', shell: false,
    timeout: cfg.gitTimeoutMs || 60000, killSignal: 'SIGKILL', windowsHide: true, ...extra });
  const invoke = (command, args, callOptions) => run(command, args, callOptions);

  const adapters = {
    planningModel: options.planningModel || cfg.model,
    reasoningEffort: options.reasoningEffort || cfg.reasoningEffort,
    sha256, now: () => new Date().toISOString(), crash: async () => {},
    async readKickoff(id) {
      return kickoffApi.readAll(state).find(record => record.id === id) || null;
    },
    async resolveIntegration() {
      const branch = resolveBranch(cfg);
      if (!branch || !branch.ok) return null;
      const result = invoke('git', ['rev-parse', '--verify', branch.branch], gitOptions());
      const commit = String(result.stdout || '').trim();
      return result.status === 0 && COMMIT_RE.test(commit) ? { branch: branch.branch, commit } : null;
    },
    async createReadOnlyCheckout(commit) {
      const checkoutPath = deps.newCheckoutPath ? deps.newCheckoutPath()
        : fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-specifier-'));
      fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
      const result = invoke('git', ['worktree', 'add', '--detach', checkoutPath, commit], gitOptions());
      if (result.status !== 0) throw new Error(`could not create pinned planning checkout: ${result.stderr || ''}`);
      return { path: checkoutPath, commit, readOnly: true };
    },
    async cleanupCheckout(checkout) {
      makeWritable(checkout.path);
      const result = invoke('git', ['worktree', 'remove', '--force', checkout.path], gitOptions());
      return result.status === 0;
    },
    async launchCodex(plan) {
      const env = { ...(deps.env || process.env) };
      delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY;
      const result = invoke(plan.command, plan.args, { cwd: plan.checkout.path, encoding: 'utf8',
        shell: false, timeout: Math.max(1000, Math.floor((cfg.wallClockMinutes || 10) * 60000)),
        killSignal: 'SIGKILL', maxBuffer: MAX_MODEL_BYTES * 4, input: plan.prompt, env,
        windowsHide: true });
      if (result.status !== 0) throw new Error(`Codex planner failed: ${result.stderr || 'no diagnostic'}`);
      const normalized = normalizeCodexOutput(result.stdout);
      return typeof normalized === 'string' && Buffer.byteLength(normalized, 'utf8') <= MAX_MODEL_BYTES
        ? normalized : null;
    },
    async validateDesignReference(ref, commit) {
      if (deps.resolveDesignReference) return deps.resolveDesignReference(adapters.checkoutPath || '', ref, commit);
      const parsed = designApi.parse(`design-ref: ${ref}`);
      if (!parsed.ok || parsed.refs.length !== 1 || parsed.refs[0].local) return { ok: false };
      const item = parsed.refs[0];
      const result = invoke('git', ['show', `${commit}:${item.path}`],
        { ...gitOptions(), cwd: adapters.checkoutPath || cfg.targetRepoPath });
      const slug = value => String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
      const markdownSlugMatch = String(result.stdout || '').split(/\r?\n/).some(line => {
        const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        return heading && slug(heading[1]) === slug(item.anchor);
      });
      return { ok: result.status === 0
        && (designApi.hasAnchor(result.stdout, item.anchor) || markdownSlugMatch) };
    },
    async beadsFind(externalRef) {
      const result = bdJson(cfg, ['search', '--external-contains', externalRef]);
      if (!result.ok || !Array.isArray(result.data)) throw new Error(result.error || 'Beads search failed');
      return result.data.find(row => row && (row.external_ref === externalRef || row.externalRef === externalRef)) || null;
    },
    async beadsCreate(request) {
      const design = request.designReferences.map(ref => `design-ref: ${ref}`).join('\n');
      const result = bdJson(cfg, ['create', request.title, '-d', request.description,
        '--acceptance', request.acceptanceCriteria.join('\n'), '--design', design,
        '--priority', String(request.priority), '--external-ref', request.externalRef,
        '--metadata', JSON.stringify(request.metadata), '--silent']);
      if (!result.ok) throw new Error(result.error || 'Beads create failed');
      return Array.isArray(result.data) ? result.data[0] : result.data;
    },
    async readQuestion(key) { return readJson(fileFor('questions', key)); },
    async appendQuestion(key, value) { atomicJson(fileFor('questions', key), value, true); },
    async readAnswer(key) { return readJson(fileFor('answers', key)); },
    async writeAnswer(key, value) { atomicJson(fileFor('answers', key), value, true); },
    async readReceipt(key) { return readJson(fileFor('receipts', key)); },
    async writeReceipt(key, value) { atomicJson(fileFor('receipts', key), value, true); },
  };
  const create = adapters.createReadOnlyCheckout;
  adapters.createReadOnlyCheckout = async commit => {
    const checkout = await create(commit); adapters.checkoutPath = checkout.path; return checkout;
  };
  return adapters;
}

async function recordAnswer(options, adapters) {
  const kickoff = await adapters.readKickoff(options.proposalId);
  const intent = kickoff && verifyKickoff(kickoff, options.proposalId, adapters.sha256 || sha256);
  if (!intent) return refused('kickoff record is missing, malformed, or tampered');
  const question = await adapters.readQuestion(kickoff.hash);
  if (!question || question.evidenceHash !== options.previousEvidenceHash) {
    return refused('answer evidence does not link to the immutable question');
  }
  const value = { answer: options.answer, previousEvidenceHash: options.previousEvidenceHash,
    createdAt: (adapters.now || (() => new Date().toISOString()))() };
  if (!boundedString(value.answer, 8192)) return refused('answer must be a bounded non-empty string');
  await adapters.writeAnswer(kickoff.hash, value);
  return { status: 'answered', proposalId: options.proposalId, evidenceHash: options.previousEvidenceHash };
}

function parseArgs(argv) {
  const result = { command: null, configPath: null, proposalId: null, planningModel: null,
    reasoningEffort: null, previousEvidenceHash: null, answer: null, json: false };
  const values = { '--config': 'configPath', '--proposal': 'proposalId', '--model': 'planningModel',
    '--reasoning-effort': 'reasoningEffort', '--evidence': 'previousEvidenceHash', '--answer': 'answer' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { result.json = true; continue; }
    if (values[argv[i]]) { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); result[values[argv[i]]] = argv[++i]; continue; }
    if (!result.command && ['run', 'answer'].includes(argv[i])) { result.command = argv[i]; continue; }
    throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!result.command || !result.configPath || !result.proposalId) throw new Error('run/answer requires --config and --proposal');
  if (!/^kp-[0-9a-f]{16}$/.test(result.proposalId)) throw new Error('--proposal must be kp- plus 16 lowercase hexadecimal characters');
  if (result.planningModel !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result.planningModel)) throw new Error('--model is not a safe model alias');
  if (result.reasoningEffort !== null
      && !['minimal', 'low', 'medium', 'high'].includes(result.reasoningEffort)) throw new Error('--reasoning-effort must be minimal, low, medium, or high');
  if (result.command === 'answer' && (!result.previousEvidenceHash || !result.answer)) throw new Error('answer requires --evidence and --answer');
  if (result.command === 'answer' && !HASH_RE.test(result.previousEvidenceHash)) throw new Error('--evidence must be a sha256 hash');
  return result;
}

function helpText() {
  return `specify-proposal — turn immutable kickoff intent into one canonical Beads spec

Usage:
  node scripts/specify-proposal.js run --config <run.config.json> --proposal <kp-…> [--model <id>] [--reasoning-effort <level>] [--json]
  node scripts/specify-proposal.js answer --config <run.config.json> --proposal <kp-…> --evidence <sha256:…> --answer <text> [--json]

The run command uses saved ChatGPT authentication, an isolated pinned checkout and Codex's
read-only sandbox. The answer command records only evidence-linked user input; run it again
afterwards to launch a new planning attempt.
`;
}

async function main(argv, io = {}, deps = {}) {
  const writeOut = io.out || (text => fs.writeSync(1, String(text)));
  const writeErr = io.err || (text => fs.writeSync(2, String(text)));
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    writeOut(helpText()); return 0;
  }
  let options;
  try { options = parseArgs(argv); }
  catch (e) { writeErr(`specify-proposal: ${e.message}\n`); return 2; }
  try {
    const makeAdapters = deps.productionAdapters || productionAdapters;
    const adapters = makeAdapters(options);
    const result = options.command === 'answer'
      ? await (deps.recordAnswer || recordAnswer)(options, adapters)
      : await (deps.execute || execute)(options, io, adapters);
    writeOut(options.json ? `${JSON.stringify(result)}\n`
      : `${result.status}${result.issueId ? ` ${result.issueId}` : ''}${result.question ? `: ${result.question}` : ''}\n`);
    return result.status === 'refused' ? 4 : result.status === 'needs-input' ? 3 : 0;
  } catch (e) {
    writeErr(`specify-proposal: ${e.message}\n`); return 4;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { MAX_MODEL_BYTES, validateProposal, parseProposal, execute,
  productionAdapters, recordAnswer, normalizeCodexOutput, helpText, main };
