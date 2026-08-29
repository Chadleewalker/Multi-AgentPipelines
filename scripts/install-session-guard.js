#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Install the host-only write guard that keeps one session in one folder
// (docs/parallel-sessions.md §8, change-log row `session-write-guard`).
//
// Run once per machine, not once per worktree — and that is the whole reason this
// installs into the USER-level agent config rather than the project's. A guard a session
// has to opt into is a guard the twentieth session does not have, and the twentieth
// session is the one this is for. Installed at the user level it is already in force in
// every folder the host opens, including a worktree created five minutes from now that
// nobody has configured.
//
// Installing it everywhere is only safe because the bridge has no opinion about a
// repository that does not carry `scripts/session-guard.js`: it exits 0 before spawning
// anything. Other projects on this machine are unaffected, and stay unaffected.
//
// It writes two things and both are git-ignored on purpose. This repo is a target of its
// own pipeline, so a tracked agent-hook configuration is cloned into a task container
// that has no agent CLI, fires there and fails every session — the boundary
// `tests/unit/agent-hooks.test.js` enforces. Same shape as
// `scripts/install-hooks.sh`: the installer travels in git, the hook never does.
//
//   <config>/hooks/session-guard.js   a copy of scripts/session-guard-bridge.js
//   <config>/settings.json            one PreToolUse entry that runs it
//
// The settings file is rewritten through JSON.parse/stringify, never by patching text, so
// a hand-edited file keeps its contents and only the hooks entry moves. The previous
// version is kept beside it before anything is written.
//
//   node scripts/install-session-guard.js            install or upgrade
//   node scripts/install-session-guard.js --status   report without changing anything
//   node scripts/install-session-guard.js --uninstall
//
// Seams for tests/unit/session-guard.test.js:
//   SESSION_GUARD_CONFIG_DIR   the agent config directory to install into
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_SRC = path.join(ROOT, 'scripts', 'session-guard-bridge.js');
// The machine-wide fallback policy: the same guard, used in folders that carry none of
// their own. It is what keeps the host-level rules in force in every other project.
const POLICY_SRC = path.join(ROOT, 'scripts', 'session-guard.js');

// Claude Code reads CLAUDE_CONFIG_DIR when set, and ~/.claude otherwise. The test seam is
// separate from it so a test run cannot be confused by the host's own override.
function configDir() {
  return path.resolve(
    process.env.SESSION_GUARD_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), '.claude')
  );
}

const MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
// Every entry this installer owns carries this in its command string, which is how a
// re-run recognises its own previous work instead of stacking a second copy.
const SIGIL = 'hooks/session-guard.js';

function die(msg) {
  console.error(`install-session-guard: ${msg}`);
  process.exit(1);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${file} is not valid JSON (${e.message}). Fix or move it, then re-run.`);
  }
  return {};
}

// Drop every PreToolUse group this installer has ever added, then drop any group left
// empty. Returns the cleaned settings object and how many were removed.
function stripOurs(settings) {
  let removed = 0;
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : null;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return { settings, removed };

  hooks.PreToolUse = hooks.PreToolUse.map((group) => {
    if (!group || !Array.isArray(group.hooks)) return group;
    const kept = group.hooks.filter((h) => {
      const owned = h && typeof h.command === 'string' && h.command.includes(SIGIL);
      if (owned) removed += 1;
      return !owned;
    });
    return { ...group, hooks: kept };
  }).filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);

  if (hooks.PreToolUse.length === 0) delete hooks.PreToolUse;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { settings, removed };
}

// Other PreToolUse commands whose job this guard has taken over. Matched by name because
// that is all a settings file offers; the result is a printed sentence, never an edit.
const SUPERSEDED = /safety-check/i;

function supersededHooks(settings) {
  const groups = (settings.hooks && settings.hooks.PreToolUse) || [];
  const found = new Set();
  for (const group of groups) {
    for (const h of (group && group.hooks) || []) {
      const command = String((h && h.command) || '');
      if (command.includes(SIGIL)) continue;
      const m = SUPERSEDED.exec(command);
      if (m) found.add(path.basename(command.replace(/["']/g, '').split(/\s+/).find((w) => SUPERSEDED.test(w)) || m[0]));
    }
  }
  return [...found];
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, to);
  return to;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const mode = process.argv[2] || '--install';
  const dir = configDir();
  const settingsFile = path.join(dir, 'settings.json');
  const bridgeDst = path.join(dir, 'hooks', 'session-guard.js');
  const policyDst = path.join(dir, 'hooks', 'session-guard-policy.js');
  // Forward slashes work in every shell this repo supports and survive JSON without the
  // backslash doubling a Windows path would need.
  const command = `node "${bridgeDst.split(path.sep).join('/')}"`;

  if (mode === '--status') {
    const settings = readJson(settingsFile);
    const groups = (settings.hooks && settings.hooks.PreToolUse) || [];
    const installed = groups.some(
      (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && String(h.command || '').includes(SIGIL))
    );
    console.log(`config dir : ${dir}`);
    console.log(`bridge     : ${fs.existsSync(bridgeDst) ? 'present' : 'MISSING'}  ${bridgeDst}`);
    console.log(`fallback   : ${fs.existsSync(policyDst) ? 'present' : 'MISSING'}  ${policyDst}`);
    console.log(`hook entry : ${installed ? 'present' : 'MISSING'}  ${settingsFile}`);
    process.exit(installed && fs.existsSync(bridgeDst) && fs.existsSync(policyDst) ? 0 : 1);
  }

  if (mode === '--uninstall') {
    const before = readJson(settingsFile);
    const { settings, removed } = stripOurs(before);
    const saved = backup(settingsFile);
    writeJson(settingsFile, settings);
    if (fs.existsSync(bridgeDst)) fs.rmSync(bridgeDst);
    if (fs.existsSync(policyDst)) fs.rmSync(policyDst);
    if (saved) console.log(`previous settings kept at ${saved}`);
    console.log(`removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'}, the bridge and the fallback policy`);
    console.log('sessions started from now on are no longer guarded, in this project or any other');
    process.exit(0);
  }

  if (mode !== '--install') die(`unknown option ${mode} (use --status or --uninstall)`);

  if (!fs.existsSync(BRIDGE_SRC)) die(`${BRIDGE_SRC} is missing — is this the repo root?`);
  if (!fs.existsSync(POLICY_SRC)) die(`${POLICY_SRC} is missing — is this the repo root?`);

  fs.mkdirSync(path.dirname(bridgeDst), { recursive: true });
  fs.copyFileSync(BRIDGE_SRC, bridgeDst);
  fs.copyFileSync(POLICY_SRC, policyDst);

  const { settings, removed } = stripOurs(readJson(settingsFile));
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push({
    matcher: MATCHER,
    hooks: [{ type: 'command', command }],
  });

  const saved = backup(settingsFile);
  writeJson(settingsFile, settings);

  console.log(`bridge   -> ${bridgeDst}`);
  console.log(`fallback -> ${policyDst}`);
  console.log(`settings -> ${settingsFile}${removed ? `  (replaced ${removed} earlier entry)` : ''}`);
  if (saved) console.log(`previous settings kept at ${saved}`);

  // A hook this now supersedes is REPORTED, never removed. It is somebody else's entry in
  // somebody else's configuration file, and an installer that quietly deletes a safety
  // check because it believes it has replaced it is the exact hazard this repo refuses
  // everywhere else. Removing it is a person's decision, so it gets a person's sentence.
  for (const name of supersededHooks(settings)) {
    console.log('');
    console.log(`Note: a separate command check is still configured (${name}).`);
    console.log('Its rules — force-pushing, deleting a home directory or a whole drive,');
    console.log('formatting a disk — are now covered here, and covered by reading parsed');
    console.log('words rather than matching text, so it no longer refuses a command that');
    console.log('merely mentions one of them. Nothing breaks if you keep both. Remove it');
    console.log(`by deleting its entry from ${settingsFile}.`);
  }
  console.log('');
  console.log('Active in sessions started from now on. Already-open sessions keep the old');
  console.log('configuration until they restart.');
  console.log('Check it with: node scripts/install-session-guard.js --status');
}

main();
