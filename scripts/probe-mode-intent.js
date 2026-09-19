// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// A model requests a mode; it never supplies Git arguments, a command or a verdict.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const AGENT = require('../runner/agent-provider');
const { canonicalTarget } = require('../runner/lock');
const { classify } = require('./write-protection-policy');
const { protectedManifest, manifestDifference, within } = require('./protected-tree');

const HEADER = 'PROBE_MODE_INTENT_V1';
const MAX_REQUEST_BYTES = 16384;
const MAX_CHANGES = 64;
const MAX_PATH_BYTES = 1024;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (message) => { throw new Error(`probe mode intent: ${message}`); };
const sameKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).sort().join('\0') === keys.slice().sort().join('\0');

function finalResponse(provider, launched) {
  if (!launched || launched.status !== 0) return null;
  const raw = String(launched.stdout || ''); // Never inspect stderr or a tool transcript for requests.
  if (provider === 'codex') {
    if (!AGENT.terminalResult(provider, raw)) return null;
    return (AGENT.normalizeOutput(provider, raw) || {}).finalText || null;
  }
  if (provider !== 'claude') failure('unsupported result provider');
  // Managed Claude proofs explicitly request one JSON result object. Never fall back to
  // stdout, a tool event or a transcript if that terminal envelope is absent or malformed.
  if (launched.probeResponseFormat === 'claude-json') {
    let result;
    try { result = JSON.parse(raw); }
    catch { failure('Claude probe did not return one JSON result object'); }
    if (!result || Array.isArray(result) || result.type !== 'result'
        || result.subtype !== 'success' || result.is_error !== false
        || typeof result.result !== 'string') {
      failure('Claude probe did not return a successful terminal result');
    }
    return result.result;
  }
  // Legacy direct callers and injected launch seams retain their plain-text behavior.
  // If they supply provider events, only the successful terminal result has authority.
  const events = raw.split(/\r?\n/).flatMap((line) => {
    try { const value = JSON.parse(line); return value && typeof value.type === 'string' ? [value] : []; }
    catch { return []; }
  });
  const providerEvents = events.filter((e) => ['result', 'assistant', 'user', 'system', 'stream_event'].includes(e.type));
  if (!providerEvents.length) return raw;
  const result = providerEvents.filter((e) => e.type === 'result').at(-1);
  return result && !result.is_error && (!result.subtype || result.subtype === 'success')
    && typeof result.result === 'string' ? result.result : null;
}

function parseRequest(text) {
  if (text === null || text === undefined) return null;
  const value = String(text).trim().replace(/\r\n/g, '\n');
  if (!value.includes(HEADER)) return null; // Existing ordinary responses retain their behavior.
  if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BYTES
      || !value.startsWith(`${HEADER}\n`)) failure('malformed or oversized final request');
  let request;
  try { request = JSON.parse(value.slice(HEADER.length + 1)); }
  catch { failure('final request must contain exactly one JSON object'); }
  if (!sameKeys(request, ['version', 'changes']) || request.version !== 1
      || !Array.isArray(request.changes) || request.changes.length < 1
      || request.changes.length > MAX_CHANGES) failure('invalid request shape or change count');
  const seen = new Set();
  for (const entry of request.changes) {
    if (!sameKeys(entry, ['path', 'mode']) || typeof entry.path !== 'string'
        || !['100644', '100755'].includes(entry.mode)) failure('invalid path/mode entry');
    const rel = entry.path;
    const parts = rel.split('/');
    if (!rel || Buffer.byteLength(rel, 'utf8') > MAX_PATH_BYTES || path.isAbsolute(rel)
        || /[\\:\x00-\x1f\x7f]/.test(rel) || rel.startsWith('-')
        || parts.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p)
          || /^\.git$/i.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
      failure('path must be a safe literal repository-relative file');
    }
    const key = rel.toLowerCase(); // Also reject aliases in Windows proof clones.
    if (seen.has(key)) failure('duplicate or conflicting path');
    seen.add(key);
  }
  return request;
}

function requestFromLaunch(provider, launched) {
  let terminal = null;
  try {
    terminal = finalResponse(provider, launched);
    return parseRequest(terminal);
  } catch (error) {
    const raw = String(launched && launched.stdout || '');
    // Keep a bounded, escaped preview of only the selected terminal answer. Raw stdout and
    // stderr may contain tool output, so retain only stdout size/hash when framing failed.
    const diagnostic = { provider, format: launched && launched.probeResponseFormat || 'legacy',
      stdoutBytes: Buffer.byteLength(raw, 'utf8'), stdoutSha256: sha(raw) };
    if (terminal !== null) {
      const bytes = Buffer.from(terminal, 'utf8');
      diagnostic.finalResponse = { bytes: bytes.length, sha256: sha(bytes),
        headerOffset: terminal.indexOf(HEADER),
        preview: bytes.subarray(0, 512).toString('utf8'), truncated: bytes.length > 512 };
    }
    error.modeIntentEvidence = `PROBE_MODE_INTENT_DIAGNOSTIC ${JSON.stringify(diagnostic)}`;
    throw error;
  }
}

function checkedFile(root, rel, policy) {
  if (classify(rel, { policy }) !== 'product') failure('requested path is not an allowed product file');
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !within(root, fs.realpathSync(current))) failure('path traverses a link or escapes the probe');
    if (current !== path.join(root, rel) && !stat.isDirectory()) failure('path ancestor is not a directory');
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1) failure('requested path must be a regular file with one link');
  const bytes = fs.readFileSync(current);
  return { path: rel, abs: current, bytes, sha256: sha(bytes), nativeMode: stat.mode & 0o777 };
}

function localGitEnv(config) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(GIT_|PIPELINE_|FREEZE_GATE_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|GH_|GITHUB_|SSH_ASKPASS$)/i.test(name)) delete env[name];
  }
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

function checkGitMetadata(root) {
  const gitDir = path.join(root, '.git');
  const ordinary = (file, directory) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
        || (!directory && stat.nlink !== 1) || fs.realpathSync(file) !== file) {
      failure('probe Git metadata is redirected');
    }
  };
  ordinary(gitDir, true);
  if (fs.existsSync(path.join(gitDir, 'commondir'))) failure('shared Git common directory is not allowed');
  ordinary(path.join(gitDir, 'index'), false);
  const objects = path.join(gitDir, 'objects'); ordinary(objects, true);
  // A symlinked fanout directory can redirect hash-object writes even when objects/ itself is real.
  for (const child of fs.readdirSync(objects)) {
    const file = path.join(objects, child);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || fs.realpathSync(file) !== file) failure('probe object storage is redirected');
    if (/^[0-9a-f]{2}$/i.test(child) && !stat.isDirectory()) failure('probe object fanout is not a directory');
  }
  return gitDir;
}

function owned(built, prepared, readManagedProbe) {
  const actual = readManagedProbe(prepared.probe);
  if (!actual || path.resolve(actual.probe) !== path.resolve(prepared.probe)
      || path.resolve(actual.baseline) !== path.resolve(prepared.baseline)
      || path.resolve(actual.container) !== path.resolve(prepared.container)
      || actual.marker.status === 'proven' || actual.marker.issue !== (built.suiteId || built.id)
      || actual.marker.head !== prepared.head
      || actual.marker.targetIdentity !== canonicalTarget(built.cfg.targetRepoPath)
      || path.resolve(actual.marker.sourceWorktree) !== path.resolve(built.folder.dir)) failure('owned unfinished probe identity changed');
  return actual;
}

function applyRequest(built, prepared, request, readManagedProbe) {
  if (!request) return null;
  // Validate again at the consumer boundary, even when the producer already parsed it.
  parseRequest(`${HEADER}\n${JSON.stringify(request)}`);
  owned(built, prepared, readManagedProbe);
  const root = fs.realpathSync(prepared.probe);
  const gitDir = checkGitMetadata(root);
  const scratch = fs.mkdtempSync(path.join(prepared.container, '.mode-intent-'));
  const config = path.join(scratch, 'gitconfig');
  fs.writeFileSync(config, '');
  const env = localGitEnv(config);
  const index = path.join(gitDir, 'index');
  const lock = `${index}.lock`;
  const temporaryIndex = path.join(scratch, 'index');
  let lockFd = null;
  let lockOwned = false;
  let installed = false;
  let files = [];
  const manifest = () => protectedManifest(root, built.policy, built.suiteId || built.id,
    (cmd, args, options) => spawnSync(cmd, ['-c', `safe.directory=${root}`, '-c', 'core.fsmonitor=false', ...args],
      { ...options, env }));
  const git = (args, options = {}) => {
    const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${scratch}`, '--literal-pathspecs', ...args], {
      cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
      env, ...options,
    });
    if (result.status !== 0 || result.error || result.signal) failure(`local Git ${args[0]} failed`);
    return String(result.stdout || '');
  };
  try {
    const protectedBefore = manifest();
    const protectedNames = new Set(protectedBefore.map(([name]) => name.toLowerCase()));
    files = request.changes.map((entry) => {
      if (protectedNames.has(entry.path.toLowerCase())) failure('requested path is protected');
      return { ...checkedFile(root, entry.path, built.policy), mode: entry.mode };
    });
    // No index, file mode or object mutation occurs until EVERY requested path passed validation.
    // Git commands cannot be redirected to another repository/index by inherited environment.
    const actualGitDir = git(['rev-parse', '--absolute-git-dir']).trim();
    if (fs.realpathSync(actualGitDir) !== gitDir) failure('Git directory does not belong to probe');
    for (const [arg, expected] of [['--git-common-dir', gitDir], ['--show-toplevel', root]]) {
      if (fs.realpathSync(path.resolve(root, git(['rev-parse', arg]).trim())) !== expected) failure('Git metadata redirects outside the owned probe');
    }
    if (fs.realpathSync(path.resolve(root, git(['rev-parse', '--git-path', 'objects']).trim())) !== path.join(gitDir, 'objects')) {
      failure('Git object writes would leave the owned probe');
    }
    lockFd = fs.openSync(lock, 'wx', 0o600);
    lockOwned = true;
    fs.copyFileSync(index, temporaryIndex);
    for (const file of files) {
      file.blob = git(['hash-object', '-w', '--stdin'], { input: file.bytes }).trim();
      if (!/^[0-9a-f]{40,64}$/.test(file.blob)) failure('invalid local blob identity');
    }
    // index-info is a NUL-delimited data channel, never model-selected argv or pathspecs.
    const indexInfo = files.map((file) => `${file.mode} ${file.blob}\t${file.path}\0`).join('');
    git(['update-index', '-z', '--index-info'], { input: indexInfo, env: { ...env, GIT_INDEX_FILE: temporaryIndex } });
    owned(built, prepared, readManagedProbe);
    checkGitMetadata(root);
    // Persist the intent before changing the native/index modes. This is not a success receipt:
    // only the real gate can prove success, and a failed installation leaves this request auditable.
    const audit = { version: 1, kind: 'probe-mode-intent', phase: 'prepared', issue: built.suiteId || built.id,
      head: prepared.head, requestHash: sha(Buffer.from(JSON.stringify(request))),
      changes: files.map(({ path: name, mode, blob, sha256 }) => ({ path: name, mode, blob, sha256 })) };
    const auditPath = path.join(prepared.container, `.mode-intent-request-${crypto.randomBytes(12).toString('hex')}.json`);
    const auditFd = fs.openSync(auditPath, 'wx', 0o600);
    try { fs.writeFileSync(auditFd, `${JSON.stringify(audit, null, 2)}\n`); fs.fsyncSync(auditFd); }
    finally { fs.closeSync(auditFd); }
    for (const file of files) {
      if (checkedFile(root, file.path, built.policy).sha256 !== file.sha256) failure('requested file changed while applying intent');
      // On native hosts, ordinary subsequent git add must not undo the explicit index intent.
      // Windows mode bits remain untrusted; the index above is authoritative on every host.
      if (process.platform !== 'win32') fs.chmodSync(file.abs,
        (file.nativeMode & ~0o111) | (file.mode === '100755' ? 0o111 : 0));
    }
    if (manifestDifference(protectedBefore, manifest()).length) {
      failure('protected paths changed during mode application');
    }
    fs.writeFileSync(lockFd, fs.readFileSync(temporaryIndex));
    fs.fsyncSync(lockFd); fs.closeSync(lockFd); lockFd = null;
    fs.renameSync(lock, index); installed = true;
    return audit;
  } finally {
    if (lockFd !== null) fs.closeSync(lockFd);
    if (!installed) {
      for (const file of files) {
        try { if (process.platform !== 'win32' && checkedFile(root, file.path, built.policy).sha256 === file.sha256) fs.chmodSync(file.abs, file.nativeMode); } catch { /* failure remains a refusal */ }
      }
      // Only remove the lock this invocation acquired; an existing Git lock is never ours.
      if (lockOwned) { try { fs.unlinkSync(lock); } catch { /* report original failure */ } }
    }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* retained scratch cannot disguise an applied transaction */ }
  }
}

function verifyApplied(built, prepared, audit, readManagedProbe) {
  if (!audit) return;
  owned(built, prepared, readManagedProbe);
  checkGitMetadata(fs.realpathSync(prepared.probe));
  const scratch = fs.mkdtempSync(path.join(prepared.container, '.mode-intent-check-'));
  try {
    const config = path.join(scratch, 'gitconfig'); fs.writeFileSync(config, '');
    for (const entry of audit.changes) {
      const file = checkedFile(prepared.probe, entry.path, built.policy);
      if (file.sha256 !== entry.sha256) failure('requested candidate content changed during the gate');
      const result = spawnSync('git', ['-c', `safe.directory=${prepared.probe}`, '-c', 'core.fsmonitor=false',
        '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', entry.path], {
        cwd: prepared.probe, encoding: 'utf8', env: localGitEnv(config), timeout: 60000,
        windowsHide: true, maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error || result.signal
          || result.stdout !== `${entry.mode} ${entry.blob} 0\t${entry.path}\0`) {
        failure('requested candidate Git mode/blob changed during the gate');
      }
      if (process.platform !== 'win32' && !!(file.nativeMode & 0o111) !== (entry.mode === '100755')) {
        failure('requested candidate native executable access changed during the gate');
      }
    }
  } finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* observation cleanup is best effort */ } }
}

module.exports = { HEADER, MAX_REQUEST_BYTES, MAX_CHANGES, MAX_PATH_BYTES,
  finalResponse, parseRequest, requestFromLaunch, applyRequest, verifyApplied, localGitEnv };
