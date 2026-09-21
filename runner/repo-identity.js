// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Bind the local repository that owns Beads to the remote used for dispatch, workspaces
// and publication. URL strings are not identities: GitHub HTTPS and SSH locators can name
// the same repository, as can an absolute path and its file:// spelling. This module reduces
// those equivalent locators to one credential-free identity before comparing them.
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { runSync, failureText } = require('./process');

function trimRepoSuffix(value) {
  return String(value || '').replace(/[\\/]+$/, '').replace(/\.git$/i, '');
}

function localIdentity(locator, baseDir) {
  let resolved = path.resolve(baseDir || process.cwd(), locator);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* a configured remote may be offline */ }
  // Unlike a network locator, a filesystem path ending in `.git` is not interchangeable
  // with the sibling path without it: both directories can exist and hold different repos.
  let normalized = path.normalize(resolved).replace(/\\/g, '/');
  // Drive-letter and UNC paths are case-insensitive on the Windows host. Case-folding them
  // also makes a path returned by Git compare with a differently-cased config spelling.
  if (process.platform === 'win32' || /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')) {
    normalized = normalized.toLowerCase();
  }
  return normalized ? `file:${normalized}` : null;
}

function networkIdentity(hostname, port, pathname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return null;
  let repoPath = trimRepoSuffix(String(pathname || '').replace(/\\/g, '/'))
    .replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!repoPath) return null;
  // GitHub owner/repository names are case-insensitive; preserve case on other servers,
  // where path case can be part of repository identity.
  if (host === 'github.com' || host === 'www.github.com') repoPath = repoPath.toLowerCase();
  return `repo:${host}${port ? `:${port}` : ''}/${repoPath}`;
}

function normalizeRemoteIdentity(locator, baseDir = process.cwd()) {
  const raw = String(locator || '').trim();
  if (!raw) return null;

  // A Windows drive path contains a colon but is not the scp-like host:path syntax.
  const windowsPath = /^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw);
  if (!windowsPath) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'file:') return localIdentity(fileURLToPath(parsed), baseDir);
      if (parsed.hostname) return networkIdentity(parsed.hostname, parsed.port, parsed.pathname);
    } catch { /* try scp syntax, then a local path */ }

    // Git's common SSH shorthand: git@github.com:owner/repository.git. The user name and
    // transport are deliberately excluded, just as URL credentials and protocols are.
    const scp = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/.exec(raw);
    if (scp) return networkIdentity(scp[1], '', scp[2]);
  }

  return localIdentity(raw, baseDir);
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function failure(reason) {
  return { ok: false, reason: `${reason}; refusing before Beads mutation or workspace creation` };
}

// The configured locator is expanded through Git's url.*.insteadOf rules without touching
// the network. Local fetch URLs are read from every named remote; requiring a particular
// remote name would reject a valid repository merely because it calls the remote `upstream`.
function verifyRepoIdentity(cfg, io = {}) {
  const execute = io.runSync || runSync;
  const local = cfg && cfg.targetRepoPath;
  const configured = cfg && cfg.targetRepoRemote;
  if (!local || !configured) return failure('repository identity cannot be checked because the run config is incomplete');

  const expanded = execute('git', ['ls-remote', '--get-url', configured], {
    cfg, kind: 'git', label: 'configured repository identity expansion',
  });
  if (expanded.status !== 0) {
    return failure(`cannot interpret targetRepoRemote: ${failureText(expanded, 'git ls-remote --get-url failed')}`);
  }
  const configuredLocator = lines(expanded.stdout)[0] || configured;
  const configuredIdentity = normalizeRemoteIdentity(configuredLocator, process.cwd());
  if (!configuredIdentity) return failure('targetRepoRemote has no stable repository identity');

  const named = execute('git', ['-C', local, 'remote'], {
    cfg, kind: 'git', label: 'local repository remote enumeration',
  });
  if (named.status !== 0) {
    return failure(`cannot inspect targetRepoPath as a Git repository: ${failureText(named, 'git remote failed')}`);
  }
  const remoteNames = lines(named.stdout);
  if (!remoteNames.length) {
    return failure(`targetRepoPath has no configured fetch remote to match ${configuredIdentity}`);
  }

  const observed = [];
  for (const name of remoteNames) {
    const result = execute('git', ['-C', local, 'remote', 'get-url', '--all', name], {
      cfg, kind: 'git', label: `local repository remote '${name}' inspection`,
    });
    if (result.status !== 0) {
      return failure(`cannot inspect fetch remote '${name}': ${failureText(result, 'git remote get-url failed')}`);
    }
    for (const locator of lines(result.stdout)) {
      const identity = normalizeRemoteIdentity(locator, local);
      if (!identity) continue;
      observed.push({ name, identity });
      if (identity === configuredIdentity) {
        return { ok: true, identity: configuredIdentity, remoteName: name };
      }
    }
  }

  const localIdentities = [...new Set(observed.map((item) => item.identity))];
  const localText = localIdentities.length ? localIdentities.join(', ') : '(no stable fetch identity)';
  return failure(`repository identity mismatch: targetRepoPath fetch remotes identify ${localText}, while targetRepoRemote identifies ${configuredIdentity}`);
}

module.exports = { normalizeRemoteIdentity, verifyRepoIdentity };
