#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The kickoff intake — DESIGN.md §3.10 (change-log row `continuous-idea-conveyor`).
//
// A thought arrives while a run is in flight. Today the only way to hand it to the
// pipeline is a planning session: interactive, blocking, and unavailable exactly when the
// machine is busy. So an idea either waits for a person to be free or is lost. This is the
// intake half of the answer and nothing more — one command that RECORDS a kickoff packet
// and returns:
//
//   node scripts/kickoff.js submit --config run.config.<project>.json --packet idea.json
//   node scripts/kickoff.js list   --config run.config.<project>.json [--json]
//   node scripts/kickoff.js show   --config run.config.<project>.json --id kp-… [--json]
//
// FOUR PROPERTIES ARE LOAD-BEARING. Every decision below follows from one of them.
//
//   1. NON-BLOCKING, AND THAT IS A STRUCTURAL CLAIM, NOT A LATENCY ONE. A submit creates
//      no runnable Beads issue and starts no model, container, Git, worktree or target-lock
//      operation — it starts NO CHILD PROCESS AT ALL. That is the only version of "it can
//      be run while a run is in flight" that stays true when the machine is loaded: a tool
//      that shells out inherits every way the thing it shelled out to can block, and a
//      tool that takes the target lock is refused by the very run it was meant not to
//      disturb. Node built-ins only, and nothing here spawns.
//
//   2. HOST-OWNED STATE, KEYED ON CANONICAL TARGET IDENTITY. The queue belongs to the
//      project, not to the checkout that happened to submit. `runner/lock.js` already owns
//      exactly that identity rule — one canonical key per target repository, host-global,
//      outside every checkout and every target — so the intake state is pinned BESIDE that
//      authority rather than growing a second identity rule beside it:
//
//        <host-global target lock file>.kickoff/proposals/<id>.json
//
//      the same shape `preparationUncertainDir` already uses for
//      `<lock>.preparation-uncertain`. Two spellings of one target path and two pipeline
//      worktrees therefore share one queue, for free, because they compute one file.
//      Hard rule 1 is untouched: this is not Beads and never becomes Beads by itself.
//
//   3. THE ORIGINAL IS IMMUTABLE. A record carries the packet as submitted in one
//      `intent` string and a `sha256:` digest of exactly those bytes. Nothing rewrites a
//      record — not a later submit, not a later stage change. Answers to questions and
//      stage transitions are append-only events in a later task; they will sit beside the
//      record, never inside it. An `intent` that no longer hashes to its recorded hash is
//      not a record with a correction in it, it is a `tampered-intent` refusal.
//
//   4. FAIL CLOSED ON STATE, AND LEAVE NOTHING HALF-VISIBLE. `proposals/` holds records
//      and nothing else: the write is staged in a sibling `staging/` directory and linked
//      into place as one filesystem operation, so an interruption leaves either a complete
//      proposal or no visible proposal — never a file that is neither. A state component
//      that is not a real directory, an unreadable or malformed record, and an input over
//      the bound are all refusals by name, before anything is written.
//
// PINNED DECISIONS a future reader would otherwise re-litigate:
//
//   * The id is ASSIGNED, not derived from content. Two identical packets are two
//     proposals — a person submitting the same idea twice has said something, and a
//     content-addressed id would silently merge the second into the first. Uniqueness
//     comes from 64 random bits plus an exclusive create, so twenty simultaneous submits
//     produce twenty records with no coordination between them and no lock of any kind.
//   * The hash covers the intent bytes, NOT the record. The record gains `createdAt` and
//     will gain event pointers; a digest over the whole file would change whenever the
//     envelope did, and the thing worth pinning is the packet a person wrote.
//   * `intent` is a CANONICAL serialization of the packet, not the input bytes as typed.
//     Indentation and key order are not intent, and two spellings of one packet must not
//     produce two different hashes. The closed field order below is that canonical order.
//   * The bound is on the INPUT AS SUPPLIED, checked before parsing. A bound applied after
//     the parse has already read whatever arrived into memory, which is the thing the
//     bound exists to prevent.
//   * A missing state root reads as empty: `list` reports nothing and exits 0, `show`
//     exits 5. An absent queue is not a broken queue.
//   * `list` fails closed over the WHOLE directory and `show` over the ONE record it was
//     asked for. A report that silently omitted a bad record would be the dangerous
//     failure mode; a `show` that refused because some unrelated record is bad would make
//     one damaged file hide the whole queue.
//
// Self-contained but for `runner/lock.js`, which is the point of property 2: the identity
// rule is imported, never copied. Nothing else in the repo is required, and nothing here
// reads or writes the target repository, Beads, or `runs/`.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const LOCK = require('../runner/lock');

// ---- the contract ----------------------------------------------------------------------
// One token, carried by the packet, the stored record, `list --json`, the CLI help and
// `docs/control-plane.md`, so "the same contract version" is one string and not five
// spellings of an integer.
const VERSION = 'kickoff-intake/1';
const STATE_SUFFIX = '.kickoff';
const PROPOSALS = 'proposals';
const STAGING = 'staging';
const STATE_AIM = 'PIPELINE_GLOBAL_LOCK_DIR';
const ID_PREFIX = 'kp-';
const ID_HEX = 16;
const ID_RE = new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX}}$`);
const RECORD_RE = new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX}}\\.json$`);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_PACKET_BYTES = 65536;

// The closed packet shape, in canonical order. Any field outside this list is refused.
const PACKET_FIELDS = ['version', 'title', 'description', 'constraints', 'examples',
  'nonGoals', 'priority', 'relations', 'origin'];
const RECORD_FIELDS = ['version', 'id', 'target', 'hash', 'intent', 'createdAt'];

// Secondary bounds. None of them may sit below the input bound in a way that makes the
// input bound unreachable — a wall below the stated bound is a different contract.
const MAX_TITLE = 512;
const MAX_LIST_ITEMS = 64;
const MAX_ITEM_CHARS = 4096;
const MAX_PRIORITY = 5;
const RELATION_FIELDS = ['kind', 'id'];
const ORIGIN_FIELDS = ['kind', 'ref'];

const EXIT = { OK: 0, USAGE: 2, PACKET: 3, STATE: 4, MISSING: 5 };

// ---- refusals --------------------------------------------------------------------------
// Every non-zero exit names its refusal on stderr. The name is the stable part; the
// sentence after it is for the person reading.
class Refusal extends Error {
  constructor(code, name, detail) {
    super(`${name}: ${detail}`);
    this.code = code;
    this.refusal = name;
    this.detail = detail;
  }
}
const usage = (detail) => new Refusal(EXIT.USAGE, 'usage', detail);
const packetRefusal = (name, detail) => new Refusal(EXIT.PACKET, name, detail);
const stateRefusal = (name, detail) => new Refusal(EXIT.STATE, name, detail);

// `process.stdout.write` to a pipe is asynchronous on the Windows reference host and
// `process.exit` truncates a pending write, so every byte this tool reports goes out
// through a synchronous write that retries the one recoverable error.
function writeFd(fd, text) {
  const buf = Buffer.from(String(text), 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === 'EAGAIN') { pause(5); continue; }
      if (e.code === 'EPIPE') return;
      throw e;
    }
  }
}
const out = (text) => writeFd(1, text);
const err = (text) => writeFd(2, text);

// A synchronous sleep with no timer and no child process: the only two places a bounded
// wait is needed here are a non-blocking stdin and a non-blocking stdout.
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
}

// ---- help ------------------------------------------------------------------------------
// C6's second party. It states the same contract `docs/control-plane.md` states and the
// Docker-free tests declare: version, state location, id rule, hash rule, input bound and
// what every exit code means.
function helpText() {
  return `kickoff — durable non-blocking kickoff intake (contract ${VERSION})

Usage:
  node scripts/kickoff.js submit --config <run.config.json> --packet <file|->
  node scripts/kickoff.js list   --config <run.config.json> [--json]
  node scripts/kickoff.js show   --config <run.config.json> --id <${ID_PREFIX}…> [--json]
  node scripts/kickoff.js --help

A submit RECORDS a kickoff packet and does nothing else. It creates no runnable Beads
issue and starts no model, Docker, Git, worktree or target-lock operation; it starts no
child process at all, so it is safe to run while a run is in flight.

The packet is a closed JSON object (contract ${VERSION}). Any field outside this
list is refused as \`unknown-field\`:

  version      "${VERSION}"
  title        one line of intent
  description  the body of the request
  constraints  array of strings
  examples     array of strings
  nonGoals     array of strings
  priority     whole number, 0 to ${MAX_PRIORITY}
  relations    array of { kind, id } known relations
  origin       { kind, ref }, or null

Input bound: at most ${MAX_PACKET_BYTES} bytes of packet input as supplied, read from a
file or from stdin with \`--packet -\`. One byte more is refused as \`input-too-large\`,
before the input is parsed.

State location: host-owned, per project, outside every checkout and every target. It sits
beside the host-global target lock authority that runner/lock.js computes for the config's
canonical \`targetRepoPath\`:

  <host-global target lock file>${STATE_SUFFIX}/${PROPOSALS}/<id>.json

${STATE_AIM} re-aims that root — the same seam runner/lock.js uses, a test seam
rather than an operator control. Because the key is canonical target identity, equivalent
spellings of one target path and different pipeline worktrees share one queue.

Id rule:   \`${ID_PREFIX}\` followed by ${ID_HEX} lowercase hexadecimal characters, assigned once at
           submit and never reassigned. The id printed is the id stored, the id \`show\`
           accepts, and the id \`list\` keeps reporting.
Hash rule: \`sha256:\` followed by 64 lowercase hexadecimal characters, taken over the
           record's immutable \`intent\` bytes — the canonical serialization of the packet
           as submitted. The original record is immutable: a record whose \`intent\` no
           longer hashes to its recorded hash is refused as \`tampered-intent\`, and a
           state component that is not a real directory is refused as
           \`state-not-a-real-directory\`.

Exit codes:
  0   accepted, or the requested report was produced
  2   usage error — the command line is wrong or incomplete
  3   packet refused — malformed, too large, or outside the closed shape
  4   state refused — the intake state is unreadable, tampered, or not a real directory
  5   no such proposal for this target
`;
}

// ---- argument parsing --------------------------------------------------------------------
const VALUE_FLAGS = ['--config', '--packet', '--id'];
const BARE_FLAGS = ['--json'];

function parseArgs(argv) {
  const parsed = { command: null, config: null, packet: null, id: null, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (VALUE_FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw usage(`${arg} needs a value`);
      i++;
      if (arg === '--config') parsed.config = value;
      else if (arg === '--packet') parsed.packet = value;
      else parsed.id = value;
      continue;
    }
    if (BARE_FLAGS.includes(arg)) { parsed.json = true; continue; }
    if (arg.startsWith('-') && arg !== '-') throw usage(`unknown option ${arg}`);
    rest.push(arg);
  }
  if (rest.length > 1) throw usage(`one command at a time, got: ${rest.join(', ')}`);
  parsed.command = rest[0] || null;
  return parsed;
}

// ---- the target, and the state it keys ---------------------------------------------------

// Only `targetRepoPath` is load-bearing here: the intake never reaches the remote, the
// image, the proxy or anything else the run config carries.
function targetSpellingFrom(configPath) {
  if (!configPath) throw usage('a --config <run.config.json> is required');
  const abs = path.resolve(configPath);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (e) { throw usage(`run config not readable at ${abs} (${e.code || e.message})`); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw usage(`run config is not valid JSON at ${abs}: ${e.message}`); }
  const spelling = cfg && cfg.targetRepoPath;
  if (typeof spelling !== 'string' || !spelling.trim()) {
    throw usage(`run config at ${abs} declares no targetRepoPath`);
  }
  return spelling;
}

function statePathsFor(spelling) {
  let root;
  let target;
  try {
    root = `${LOCK.globalLockPath(spelling)}${STATE_SUFFIX}`;
    target = LOCK.canonicalTarget(spelling);
  } catch (e) {
    throw usage(`the target repo path cannot be resolved: ${e.message}`);
  }
  return { target, root, proposals: path.join(root, PROPOSALS), staging: path.join(root, STAGING) };
}

// A state component is a real directory or it is a refusal. `false` means "not there yet",
// which is a legal empty queue and never a link, a file or an unreadable entry.
function realDirectory(dir) {
  let st;
  try { st = fs.lstatSync(dir); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw stateRefusal('state-unreadable', `${dir} cannot be inspected (${e.code || e.message})`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw stateRefusal('state-not-a-real-directory', `${dir} is not a real directory`);
  }
  return true;
}

// Create the state, then prove it is what it claims to be. `mkdir -p` is happy to walk
// through a symlinked component, so the check has to come after the create and not
// instead of it.
function ensureState(paths) {
  try {
    fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.staging, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw stateRefusal('state-unwritable', `${paths.root} cannot be created (${e.code || e.message})`);
  }
  for (const dir of [paths.root, paths.proposals, paths.staging]) {
    if (!realDirectory(dir)) throw stateRefusal('state-unwritable', `${dir} vanished while it was being created`);
  }
}

// ---- packet input ------------------------------------------------------------------------

// Bounded at the source. A file is measured before it is read; stdin is read in chunks and
// abandoned the moment it passes the bound, so an oversized input is never fully resident.
function readPacketInput(spec) {
  if (!spec) throw usage('a --packet <file|-> is required');
  if (spec === '-') return readStdinBounded(MAX_PACKET_BYTES);
  const abs = path.resolve(spec);
  let st;
  try { st = fs.statSync(abs); }
  catch (e) { throw packetRefusal('packet-unreadable', `no packet at ${abs} (${e.code || e.message})`); }
  if (!st.isFile()) throw packetRefusal('packet-unreadable', `${abs} is not a regular file`);
  if (st.size > MAX_PACKET_BYTES) {
    throw packetRefusal('input-too-large', `packet input is ${st.size} bytes; the bound is ${MAX_PACKET_BYTES} bytes`);
  }
  let buf;
  try { buf = fs.readFileSync(abs); }
  catch (e) { throw packetRefusal('packet-unreadable', `${abs} could not be read (${e.code || e.message})`); }
  if (buf.length > MAX_PACKET_BYTES) {
    throw packetRefusal('input-too-large', `packet input is ${buf.length} bytes; the bound is ${MAX_PACKET_BYTES} bytes`);
  }
  return buf;
}

function readStdinBounded(limit) {
  const chunks = [];
  const block = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    let read;
    try {
      read = fs.readSync(0, block, 0, block.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { pause(5); continue; }
      if (e.code === 'EOF') break;                        // a closed console handle on Windows
      throw packetRefusal('packet-unreadable', `stdin could not be read (${e.code || e.message})`);
    }
    if (read === 0) break;
    total += read;
    if (total > limit) {
      throw packetRefusal('input-too-large', `packet input is more than ${limit} bytes; the bound is ${limit} bytes`);
    }
    chunks.push(Buffer.from(block.subarray(0, read)));
  }
  return Buffer.concat(chunks, total);
}

// ---- the closed packet shape ---------------------------------------------------------------

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw packetRefusal('packet-field-type', `\`${field}\` must be an array of strings`);
  if (value.length > MAX_LIST_ITEMS) {
    throw packetRefusal('packet-field-type', `\`${field}\` holds ${value.length} entries; at most ${MAX_LIST_ITEMS} are accepted`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string') throw packetRefusal('packet-field-type', `\`${field}[${i}]\` must be a string`);
    if (item.length > MAX_ITEM_CHARS) {
      throw packetRefusal('packet-field-type', `\`${field}[${i}]\` is longer than ${MAX_ITEM_CHARS} characters`);
    }
    return item;
  });
}

function closedObject(value, fields, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw packetRefusal('packet-field-type', `\`${field}\` must be an object with ${fields.join(' and ')}`);
  }
  const unknown = Object.keys(value).filter((k) => !fields.includes(k));
  if (unknown.length) {
    throw packetRefusal('unknown-field', `the packet shape is closed; \`${field}\` carries unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  const built = {};
  for (const key of fields) {
    const item = value[key];
    if (typeof item !== 'string' || !item.trim()) {
      throw packetRefusal('packet-field-type', `\`${field}.${key}\` must be a non-empty string`);
    }
    if (item.length > MAX_ITEM_CHARS) {
      throw packetRefusal('packet-field-type', `\`${field}.${key}\` is longer than ${MAX_ITEM_CHARS} characters`);
    }
    built[key] = item;
  }
  return built;
}

// Parse, refuse, and hand back the canonical form. The order the fields are rebuilt in IS
// the canonical order, which is what makes two spellings of one packet hash alike.
function canonicalPacket(buf) {
  let text;
  try { text = buf.toString('utf8'); }
  catch (e) { throw packetRefusal('packet-not-json', `the packet is not UTF-8 text: ${e.message}`); }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw packetRefusal('packet-not-json', `the packet is not valid JSON: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw packetRefusal('packet-not-json', 'the packet must be a JSON object');
  }

  const unknown = Object.keys(raw).filter((k) => !PACKET_FIELDS.includes(k));
  if (unknown.length) {
    throw packetRefusal('unknown-field', `the packet shape is closed; unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (accepted: ${PACKET_FIELDS.join(', ')})`);
  }

  if (raw.version !== VERSION) {
    throw packetRefusal('packet-version', `the packet declares version \`${raw.version}\`; this intake speaks \`${VERSION}\``);
  }
  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    throw packetRefusal('packet-field-type', '`title` must be a non-empty string');
  }
  if (raw.title.length > MAX_TITLE) {
    throw packetRefusal('packet-field-type', `\`title\` is longer than ${MAX_TITLE} characters`);
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw packetRefusal('packet-field-type', '`description` must be a string');
  }
  const priority = raw.priority === undefined || raw.priority === null ? MAX_PRIORITY - 2 : raw.priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
    throw packetRefusal('packet-field-type', `\`priority\` must be a whole number from 0 to ${MAX_PRIORITY}`);
  }
  let relations = [];
  if (raw.relations !== undefined && raw.relations !== null) {
    if (!Array.isArray(raw.relations)) throw packetRefusal('packet-field-type', '`relations` must be an array of { kind, id }');
    if (raw.relations.length > MAX_LIST_ITEMS) {
      throw packetRefusal('packet-field-type', `\`relations\` holds ${raw.relations.length} entries; at most ${MAX_LIST_ITEMS} are accepted`);
    }
    relations = raw.relations.map((r, i) => closedObject(r, RELATION_FIELDS, `relations[${i}]`));
  }
  const origin = raw.origin === undefined || raw.origin === null
    ? null : closedObject(raw.origin, ORIGIN_FIELDS, 'origin');

  return {
    version: VERSION,
    title: raw.title,
    description: raw.description === undefined ? '' : raw.description,
    constraints: stringList(raw.constraints, 'constraints'),
    examples: stringList(raw.examples, 'examples'),
    nonGoals: stringList(raw.nonGoals, 'nonGoals'),
    priority,
    relations,
    origin,
  };
}

// ---- records -------------------------------------------------------------------------------

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const hashOf = (intent) => `sha256:${sha256(intent)}`;
const newId = () => `${ID_PREFIX}${crypto.randomBytes(ID_HEX / 2).toString('hex')}`;

// The one place a record's shape is judged. Everything it can refuse is a state refusal:
// by the time a record is on disk, the packet that produced it was already accepted.
function verifyRecord(rec, id, target) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw stateRefusal('malformed-record', `proposal ${id} is not a JSON object`);
  }
  for (const key of RECORD_FIELDS) {
    if (!(key in rec)) throw stateRefusal('malformed-record', `proposal ${id} has no \`${key}\``);
  }
  if (rec.version !== VERSION) {
    throw stateRefusal('unsupported-record-version', `proposal ${id} declares version \`${rec.version}\`; this intake speaks \`${VERSION}\``);
  }
  if (rec.id !== id) throw stateRefusal('malformed-record', `proposal ${id} carries the id \`${rec.id}\` and does not name its own file`);
  if (typeof rec.intent !== 'string') throw stateRefusal('malformed-record', `proposal ${id} carries no immutable intent bytes`);
  if (typeof rec.hash !== 'string' || !HASH_RE.test(rec.hash)) {
    throw stateRefusal('malformed-record', `proposal ${id} carries no sha256: content hash`);
  }
  if (hashOf(rec.intent) !== rec.hash) {
    throw stateRefusal('tampered-intent', `proposal ${id} no longer hashes to its recorded hash — the original intent bytes are immutable`);
  }
  if (rec.target !== target) {
    throw stateRefusal('malformed-record', `proposal ${id} names the target \`${rec.target}\` and is filed under \`${target}\``);
  }
  let packet;
  try { packet = JSON.parse(rec.intent); }
  catch (e) { throw stateRefusal('malformed-record', `proposal ${id} carries intent bytes that are not a packet: ${e.message}`); }
  return { ...rec, packet };
}

function readRecord(paths, id) {
  const abs = path.join(paths.proposals, `${id}.json`);
  let st;
  try { st = fs.lstatSync(abs); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw stateRefusal('state-unreadable', `proposal ${id} cannot be inspected (${e.code || e.message})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw stateRefusal('state-not-a-regular-file', `proposal ${id} is not a regular file`);
  }
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (e) { throw stateRefusal('state-unreadable', `proposal ${id} could not be read (${e.code || e.message})`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw stateRefusal('malformed-record', `proposal ${id} is not parseable JSON: ${e.message}`); }
  return verifyRecord(parsed, id, paths.target);
}

// The whole queue, fail-closed, in a deterministic order that does not depend on readdir,
// on the clock, or on which checkout asked. `createdAt` first because that is the order a
// reader wants; the id breaks ties, and two records cannot share one id.
function readAll(paths) {
  if (!realDirectory(paths.root)) return [];
  if (!realDirectory(paths.proposals)) return [];
  let names;
  try { names = fs.readdirSync(paths.proposals); }
  catch (e) { throw stateRefusal('state-unreadable', `${paths.proposals} could not be listed (${e.code || e.message})`); }
  const records = [];
  for (const name of names.sort()) {
    if (!RECORD_RE.test(name)) {
      throw stateRefusal('state-unexpected-entry', `${path.join(paths.proposals, name)} is not a proposal record; the proposals directory holds records and nothing else`);
    }
    const rec = readRecord(paths, name.slice(0, -'.json'.length));
    if (rec) records.push(rec);
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return records;
}

// ---- the atomic write ------------------------------------------------------------------------

// Staged in a sibling directory and linked into place, so `proposals/` never holds
// anything but a complete record: a killed process leaves its half-written file in
// `staging/`, where no reader looks. `link` is used rather than `rename` because it
// refuses to replace an existing name — a record is written once and never overwritten,
// and an id collision has to be visible rather than silently destructive.
function writeRecordOnce(paths, finalPath, text) {
  const scratch = path.join(paths.staging, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(scratch, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* never opened */ }
    throw stateRefusal('state-unwritable', `${scratch} could not be staged (${e.code || e.message})`);
  }
  fs.closeSync(fd);
  try {
    try {
      fs.linkSync(scratch, finalPath);
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      // A filesystem with no hard links still has an atomic rename. The pre-check is not
      // a race the id makes reachable — 64 random bits — and losing it would be a silent
      // overwrite, which is the one outcome worth a second look.
      if (!['EPERM', 'EACCES', 'EXDEV', 'ENOSYS', 'EMLINK', 'EOPNOTSUPP', 'ENOTSUP'].includes(e.code)) {
        throw stateRefusal('state-unwritable', `${finalPath} could not be linked into place (${e.code || e.message})`);
      }
      if (fs.existsSync(finalPath)) return false;
      fs.renameSync(scratch, finalPath);
    }
    return true;
  } finally {
    try { fs.unlinkSync(scratch); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// ---- rendering ---------------------------------------------------------------------------

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const jsonOut = (body) => `${JSON.stringify(body, null, 2)}\n`;

function listHuman(paths, records) {
  const lines = [
    VERSION,
    `target: ${paths.target}`,
    `proposals: ${records.length}`,
  ];
  if (records.length) lines.push('');
  for (const rec of records) {
    lines.push(`${rec.id}  ${rec.createdAt}  p${rec.packet.priority}  ${clip(oneLine(rec.packet.title), 72)}`);
  }
  return `${lines.join('\n')}\n`;
}

function listJson(paths, records) {
  return jsonOut({
    version: VERSION,
    target: paths.target,
    proposals: records.map((rec) => ({
      id: rec.id,
      hash: rec.hash,
      createdAt: rec.createdAt,
      priority: rec.packet.priority,
      title: rec.packet.title,
    })),
  });
}

function showHuman(paths, rec) {
  const p = rec.packet;
  const lines = [
    VERSION,
    `id: ${rec.id}`,
    `target: ${paths.target}`,
    `hash: ${rec.hash}`,
    `created: ${rec.createdAt}`,
    `priority: ${p.priority}`,
    `origin: ${p.origin ? `${p.origin.kind} ${p.origin.ref}` : '(none)'}`,
    '',
    `title: ${oneLine(p.title)}`,
    '',
    'description:',
    ...String(p.description).split(/\r?\n/).map((l) => `  ${l}`.trimEnd()),
  ];
  const section = (label, items) => {
    lines.push('', `${label}:`);
    if (!items.length) lines.push('  (none)');
    for (const item of items) lines.push(`  - ${oneLine(item)}`);
  };
  section('constraints', p.constraints);
  section('examples', p.examples);
  section('non-goals', p.nonGoals);
  lines.push('', 'relations:');
  if (!p.relations.length) lines.push('  (none)');
  for (const r of p.relations) lines.push(`  - ${r.kind} ${r.id}`);
  return `${lines.join('\n')}\n`;
}

function showJson(paths, rec) {
  return jsonOut({
    version: VERSION,
    id: rec.id,
    target: paths.target,
    hash: rec.hash,
    createdAt: rec.createdAt,
    packet: rec.packet,
  });
}

// ---- the commands ---------------------------------------------------------------------------

function submit(args) {
  const paths = statePathsFor(targetSpellingFrom(args.config));
  // The packet is judged BEFORE the state is created, so a refused submission leaves no
  // trace at all — not a directory, not a staged file, and never an entry a reader could
  // mistake for a proposal.
  const packet = canonicalPacket(readPacketInput(args.packet));
  const intent = JSON.stringify(packet);
  const hash = hashOf(intent);
  ensureState(paths);

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId();
    const record = {
      version: VERSION,
      id,
      target: paths.target,
      hash,
      intent,
      createdAt: new Date().toISOString(),
    };
    if (writeRecordOnce(paths, path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)) {
      out(`accepted ${id} ${hash}\n`);
      return EXIT.OK;
    }
  }
  throw stateRefusal('state-unwritable', 'no unused proposal id could be reserved after eight attempts');
}

function list(args) {
  const paths = statePathsFor(targetSpellingFrom(args.config));
  const records = readAll(paths);
  out(args.json ? listJson(paths, records) : listHuman(paths, records));
  return EXIT.OK;
}

function show(args) {
  const paths = statePathsFor(targetSpellingFrom(args.config));
  if (!args.id) throw usage('an --id <kp-…> is required');
  if (!ID_RE.test(args.id)) throw usage(`\`${args.id}\` is not a proposal id: ${ID_PREFIX} followed by ${ID_HEX} lowercase hexadecimal characters`);
  const present = realDirectory(paths.root) && realDirectory(paths.proposals);
  const rec = present ? readRecord(paths, args.id) : null;
  if (!rec) throw new Refusal(EXIT.MISSING, 'no-such-proposal', `no such proposal ${args.id} for ${paths.target}`);
  out(args.json ? showJson(paths, rec) : showHuman(paths, rec));
  return EXIT.OK;
}

const COMMANDS = { submit, list, show };

function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { return report(e); }
  if (args.help || (!args.command && argv.length === 0)) { out(helpText()); return EXIT.OK; }
  try {
    if (!args.command) throw usage(`a command is required: ${Object.keys(COMMANDS).join(', ')}`);
    const run = COMMANDS[args.command];
    if (!run) throw usage(`unknown command \`${args.command}\`; expected one of ${Object.keys(COMMANDS).join(', ')}`);
    return run(args);
  } catch (e) {
    return report(e);
  }
}

// A refusal names itself on stderr and nothing goes to stdout: a reader piping `--json`
// into a parser must never receive half a report followed by a complaint.
function report(e) {
  if (e instanceof Refusal) {
    err(`kickoff: ${e.refusal}: ${e.detail}\n`);
    if (e.code === EXIT.USAGE) err(`kickoff: run \`node scripts/kickoff.js --help\` for usage\n`);
    return e.code;
  }
  err(`kickoff: unexpected failure: ${e && e.stack ? e.stack : e}\n`);
  return EXIT.STATE;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
  process.exit(process.exitCode);
}

module.exports = {
  VERSION, STATE_SUFFIX, PROPOSALS, STATE_AIM, MAX_PACKET_BYTES, EXIT,
  PACKET_FIELDS, RECORD_FIELDS, ID_RE, HASH_RE,
  statePathsFor, canonicalPacket, verifyRecord, readAll, helpText, main,
};
