#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Durable, host-owned intake.  This module uses lock.js only for canonical target identity;
// intake state deliberately has no relationship to the disposable lock-root location.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOCK = require('../runner/lock');

const VERSION = 'kickoff-intake/1';
const PROPOSALS = 'proposals';
const STAGING = 'staging';
const STATE_AIM = 'PIPELINE_STATE_DIR';
const STATE_DIR_NAME = '.multi-agent-pipelines';
const ID_RE = /^kp-[0-9a-f]{16}$/;
const RECORD_RE = /^kp-[0-9a-f]{16}\.json$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_PACKET_BYTES = 65536;
const PACKET_FIELDS = ['version', 'title', 'description', 'constraints', 'examples', 'nonGoals', 'priority', 'relations', 'origin'];
const RECORD_FIELDS = ['version', 'id', 'target', 'hash', 'intent', 'createdAt'];
const EXIT = { OK: 0, USAGE: 2, PACKET: 3, STATE: 4, MISSING: 5 };

class Refusal extends Error {
  constructor(code, name, detail) { super(`${name}: ${detail}`); this.code = code; this.refusal = name; }
}
const usage = (d) => new Refusal(EXIT.USAGE, 'usage', d);
const packetRefusal = (n, d) => new Refusal(EXIT.PACKET, n, d);
const stateRefusal = (n, d) => new Refusal(EXIT.STATE, n, d);
const out = (s) => fs.writeSync(1, String(s));
const err = (s) => fs.writeSync(2, String(s));

function helpText() {
  return `kickoff — durable non-blocking kickoff intake (contract ${VERSION})

Usage:
  node scripts/kickoff.js submit --config <run.config.json> --packet <file|->
  node scripts/kickoff.js list   --config <run.config.json> [--json]
  node scripts/kickoff.js show   --config <run.config.json> --id <kp-…> [--json]

Submit records intent only: it starts no child process and does not touch Beads, Git,
Docker, the network, or target-lock state.

State location: host-owned under ~/.multi-agent-pipelines, with one canonical-target
directory containing proposals/<id>.json. PIPELINE_STATE_DIR is the only test seam that
re-aims this durable root; PIPELINE_GLOBAL_LOCK_DIR affects only target locks.

Packet contract ${VERSION}: closed JSON fields are ${PACKET_FIELDS.join(', ')}. Input is
bounded to ${MAX_PACKET_BYTES} bytes. Ids are kp- plus 16 lowercase hexadecimal characters;
hashes are sha256: plus 64 lowercase hexadecimal characters over immutable intent bytes.

Exit codes:
  0   accepted, or a requested report was produced
  2   usage error
  3   packet refused
  4   state refused
  5   no such proposal
`;
}

function parseArgs(argv) {
  const args = { command: null, config: null, packet: null, id: null, json: false, help: false };
  const commands = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (['--config', '--packet', '--id'].includes(a)) {
      if (argv[i + 1] === undefined) throw usage(`${a} needs a value`);
      args[a.slice(2)] = argv[++i]; continue;
    }
    if (a.startsWith('-') && a !== '-') throw usage(`unknown option ${a}`);
    commands.push(a);
  }
  if (commands.length > 1) throw usage('one command at a time');
  args.command = commands[0] || null;
  return args;
}

function targetFromConfig(config) {
  if (!config) throw usage('a --config <run.config.json> is required');
  let body;
  try { body = JSON.parse(fs.readFileSync(path.resolve(config), 'utf8')); }
  catch (e) { throw usage(`run config is unreadable or invalid JSON (${e.code || e.message})`); }
  if (!body || typeof body.targetRepoPath !== 'string' || !body.targetRepoPath.trim()) {
    throw usage('run config declares no targetRepoPath');
  }
  return body.targetRepoPath;
}

function durableRoot() {
  const aimed = String(process.env[STATE_AIM] || '').trim();
  return aimed ? path.resolve(aimed) : path.join(os.homedir(), STATE_DIR_NAME);
}

function statePathsFor(spelling) {
  let target;
  try { target = LOCK.canonicalTarget(spelling); } catch (e) { throw usage(e.message); }
  // Use a digest only as a filename-safe partition. canonicalTarget remains the sole identity rule.
  const key = crypto.createHash('sha256').update(target).digest('hex');
  const root = durableRoot();
  const state = path.join(root, key);
  return { target, root, state, proposals: path.join(state, PROPOSALS), staging: path.join(state, STAGING) };
}

function realDirectory(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw stateRefusal('state-not-a-real-directory', `${dir} is not a real directory`);
    return true;
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    if (e instanceof Refusal) throw e;
    throw stateRefusal('state-unreadable', `${dir} cannot be inspected (${e.code || e.message})`);
  }
}

function ensureState(paths) {
  try { fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 }); fs.mkdirSync(paths.staging, { recursive: true, mode: 0o700 }); }
  catch (e) { throw stateRefusal('state-unwritable', `${paths.root} cannot be created (${e.code || e.message})`); }
  for (const p of [paths.root, paths.state, paths.proposals, paths.staging]) if (!realDirectory(p)) throw stateRefusal('state-unwritable', `${p} vanished while being created`);
}

function readPacketInput(spec) {
  if (!spec) throw usage('a --packet <file|-> is required');
  if (spec === '-') {
    const chunks = []; let total = 0; const block = Buffer.alloc(65536);
    for (;;) { const n = fs.readSync(0, block, 0, block.length, null); if (!n) break; total += n; if (total > MAX_PACKET_BYTES) throw packetRefusal('input-too-large', `packet input exceeds ${MAX_PACKET_BYTES} bytes`); chunks.push(Buffer.from(block.subarray(0, n))); }
    return Buffer.concat(chunks, total);
  }
  let stat;
  try { stat = fs.statSync(path.resolve(spec)); } catch (e) { throw packetRefusal('packet-unreadable', e.message); }
  if (!stat.isFile()) throw packetRefusal('packet-unreadable', 'packet is not a regular file');
  if (stat.size > MAX_PACKET_BYTES) throw packetRefusal('input-too-large', `packet input exceeds ${MAX_PACKET_BYTES} bytes`);
  return fs.readFileSync(path.resolve(spec));
}

function strings(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw packetRefusal('packet-field-type', `${field} must be an array of strings`);
  return value;
}
function canonicalPacket(buf) {
  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch (e) { throw packetRefusal('packet-not-json', e.message); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw packetRefusal('packet-not-json', 'packet must be a JSON object');
  const unknown = Object.keys(raw).filter((k) => !PACKET_FIELDS.includes(k));
  if (unknown.length) throw packetRefusal('unknown-field', unknown.join(', '));
  if (raw.version !== VERSION) throw packetRefusal('packet-version', `expected ${VERSION}`);
  if (typeof raw.title !== 'string' || !raw.title.trim()) throw packetRefusal('packet-field-type', 'title must be a non-empty string');
  if (raw.description !== undefined && typeof raw.description !== 'string') throw packetRefusal('packet-field-type', 'description must be a string');
  const priority = raw.priority == null ? 3 : raw.priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 5) throw packetRefusal('packet-field-type', 'priority must be 0 through 5');
  const relations = raw.relations == null ? [] : raw.relations;
  if (!Array.isArray(relations) || relations.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['kind', 'id'].includes(k)) || typeof r.kind !== 'string' || typeof r.id !== 'string')) throw packetRefusal('packet-field-type', 'relations must be { kind, id } objects');
  const origin = raw.origin == null ? null : raw.origin;
  if (origin !== null && (!origin || typeof origin !== 'object' || Array.isArray(origin) || Object.keys(origin).some((k) => !['kind', 'ref'].includes(k)) || typeof origin.kind !== 'string' || typeof origin.ref !== 'string')) throw packetRefusal('packet-field-type', 'origin must be { kind, ref } or null');
  return { version: VERSION, title: raw.title, description: raw.description || '', constraints: strings(raw.constraints, 'constraints'), examples: strings(raw.examples, 'examples'), nonGoals: strings(raw.nonGoals, 'nonGoals'), priority, relations: relations.map((r) => ({ kind: r.kind, id: r.id })), origin: origin && { kind: origin.kind, ref: origin.ref } };
}

const hashOf = (intent) => `sha256:${crypto.createHash('sha256').update(Buffer.from(intent, 'utf8')).digest('hex')}`;
function verifyRecord(record, id, target) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw stateRefusal('malformed-record', `${id} is not an object`);
  if (RECORD_FIELDS.some((k) => !(k in record)) || record.id !== id || record.target !== target || record.version !== VERSION || typeof record.intent !== 'string' || !HASH_RE.test(record.hash) || hashOf(record.intent) !== record.hash) throw stateRefusal('tampered-intent', `${id} is malformed or its immutable intent changed`);
  let packet; try { packet = JSON.parse(record.intent); } catch { throw stateRefusal('malformed-record', `${id} intent is not JSON`); }
  return { ...record, packet };
}
function readRecord(paths, id) {
  const file = path.join(paths.proposals, `${id}.json`); let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw stateRefusal('state-unreadable', e.message); }
  if (st.isSymbolicLink() || !st.isFile()) throw stateRefusal('state-not-a-regular-file', `${id} is not a regular file`);
  let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw stateRefusal('malformed-record', e.message); }
  return verifyRecord(value, id, paths.target);
}
function readAll(paths) {
  if (!realDirectory(paths.root) || !realDirectory(paths.state) || !realDirectory(paths.proposals)) return [];
  let names; try { names = fs.readdirSync(paths.proposals).sort(); } catch (e) { throw stateRefusal('state-unreadable', e.message); }
  const records = names.map((name) => { if (!RECORD_RE.test(name)) throw stateRefusal('state-unexpected-entry', `${name} is not a proposal record`); return readRecord(paths, name.slice(0, -5)); });
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function writeOnce(paths, file, text) {
  const scratch = path.join(paths.staging, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try { fd = fs.openSync(scratch, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); } catch (e) { throw stateRefusal('state-unwritable', e.message); } finally { if (fd !== undefined) fs.closeSync(fd); }
  try { fs.linkSync(scratch, file); return true; }
  catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!['EPERM', 'EACCES', 'EXDEV', 'ENOSYS', 'EMLINK', 'EOPNOTSUPP', 'ENOTSUP'].includes(e.code)) throw stateRefusal('state-unwritable', e.message);
    if (fs.existsSync(file)) return false;
    fs.renameSync(scratch, file); return true;
  } finally { try { fs.unlinkSync(scratch); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
const json = (x) => `${JSON.stringify(x, null, 2)}\n`;
function submit(args) {
  const paths = statePathsFor(targetFromConfig(args.config));
  const intent = JSON.stringify(canonicalPacket(readPacketInput(args.packet)));
  ensureState(paths);
  for (let i = 0; i < 8; i++) { const id = `kp-${crypto.randomBytes(8).toString('hex')}`; const record = { version: VERSION, id, target: paths.target, hash: hashOf(intent), intent, createdAt: new Date().toISOString() }; if (writeOnce(paths, path.join(paths.proposals, `${id}.json`), json(record))) { out(`accepted ${id} ${record.hash}\n`); return EXIT.OK; } }
  throw stateRefusal('state-unwritable', 'could not reserve an unused proposal id');
}
function list(args) { const paths = statePathsFor(targetFromConfig(args.config)); const records = readAll(paths); if (args.json) out(json({ version: VERSION, target: paths.target, proposals: records.map((r) => ({ id: r.id, hash: r.hash, createdAt: r.createdAt, priority: r.packet.priority, title: r.packet.title })) })); else out(`${VERSION}\ntarget: ${paths.target}\nproposals: ${records.length}\n${records.map((r) => `${r.id}  ${r.createdAt}  p${r.packet.priority}  ${r.packet.title.replace(/\s+/g, ' ')}`).join('\n')}${records.length ? '\n' : ''}`); return EXIT.OK; }
function show(args) { if (!args.id || !ID_RE.test(args.id)) throw usage('an --id <kp-…> is required'); const paths = statePathsFor(targetFromConfig(args.config)); const rec = realDirectory(paths.root) && realDirectory(paths.state) && realDirectory(paths.proposals) ? readRecord(paths, args.id) : null; if (!rec) throw new Refusal(EXIT.MISSING, 'no-such-proposal', `no such proposal ${args.id}`); if (args.json) out(json({ version: VERSION, id: rec.id, target: paths.target, hash: rec.hash, createdAt: rec.createdAt, packet: rec.packet })); else out(`${VERSION}\nid: ${rec.id}\ntarget: ${paths.target}\nhash: ${rec.hash}\ntitle: ${rec.packet.title}\n`); return EXIT.OK; }
function report(e) { if (e instanceof Refusal) { err(`kickoff: ${e.refusal}: ${e.message}\n`); return e.code; } err(`kickoff: unexpected failure: ${e && e.message}\n`); return EXIT.STATE; }
function main(argv) { let args; try { args = parseArgs(argv); if (args.help || (!args.command && argv.length === 0)) { out(helpText()); return EXIT.OK; } if (!args.command || !({ submit, list, show })[args.command]) throw usage('expected submit, list, or show'); return ({ submit, list, show })[args.command](args); } catch (e) { return report(e); } }
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { VERSION, PROPOSALS, STATE_AIM, MAX_PACKET_BYTES, EXIT, PACKET_FIELDS, RECORD_FIELDS, ID_RE, HASH_RE, statePathsFor, canonicalPacket, verifyRecord, readAll, helpText, main };
