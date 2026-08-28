// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Pre-run gates and lifecycle ownership — DESIGN.md §4.12, §4.8, §3.4 (T11).
// The runner owns the run lifecycle end to end: bring the network + sidecar up,
// prove the allowlist holds, assert the image exists, recover stale in-progress
// issues, and tear the network down at run end.
'use strict';
const path = require('path');
const { bd, bdJson } = require('./bd');
const { deriveNames } = require('./config');
const {
  acquire, release, clearRecoveryOwner, OWNER_TOKEN_KEY, OWNER_RUN_KEY,
} = require('./lock');
const { resolveHostShell, commandFor } = require('./host-shell');
const { runSync, failureText } = require('./process');
const { verifyRepoIdentity } = require('./repo-identity');

// The historical shared pair, which is what a config with no project segment gets.
// Asked for by name rather than spelled out again, so the two files cannot drift.
const SHARED = deriveNames('run.config.json');

const sh = (cfg, cmd, args, opts = {}) =>
  runSync(cmd, args, { cfg, kind: 'lifecycle', ...opts });

function dockerAvailable(cfg) {
  return sh(cfg, 'docker', ['info', '--format', 'ok'], { label: 'Docker daemon probe' });
}

function imageExists(image, cfg) {
  return sh(cfg, 'docker', ['image', 'inspect', image], { label: 'Docker image inspection' });
}

// The network, the proxy sidecar and its port are per project (§4.8 — `config.js`
// derives them when a config names none), and the two shell scripts read them from the
// environment, each falling back to the historical name when unset. Every call that
// creates, probes or destroys plumbing goes through here, so a run can only ever act on
// its own: no code path is left able to reach for a shared default.
function netEnv(cfg) {
  if (!cfg || !cfg.network || !cfg.proxyName || !cfg.proxyPort) {
    throw new Error('internal: run config carries no network/proxy names (loadConfig fills them)');
  }
  return {
    ...process.env,
    PIPELINE_NET: cfg.network,
    PIPELINE_PROXY: cfg.proxyName,
    PIPELINE_PROXY_PORT: String(cfg.proxyPort),
  };
}

function networkUp(repoRoot, cfg, log, traceId) {
  const env = netEnv(cfg);
  // Named before the attempt, not after it: a failure to come up has to say which network
  // and proxy it was trying to create, and this is the line that ties a run in `run.log`
  // to what `docker ps` shows while two projects are in flight. A run that ends up on the
  // shared pair says so — the collision this task removed is only safe while it is
  // visible, and the config file name is the one thing that decides it.
  const shared = cfg.network === SHARED.network || cfg.proxyName === SHARED.proxyName;
  if (log) {
    log.info(traceId, `task network ${cfg.network} + proxy sidecar ${cfg.proxyName} (${cfg.proxyUrl}) coming up`
      + (shared ? ' — the shared default pair (this config names no project segment), so a second run on it would collide' : ''));
  }
  const r = sh(cfg, commandFor(cfg), [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'up'], {
    env,
    label: 'network/sidecar startup',
  });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function networkDown(repoRoot, cfg) {
  const r = sh(cfg, commandFor(cfg), [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'down'], {
    env: netEnv(cfg),
    label: 'network/sidecar teardown',
  });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || ''), result: r };
}

function egressCheck(repoRoot, cfg) {
  // Aimed at the same network, proxy and port the tasks will use — a gate that passes
  // against a different network proves nothing about this run.
  const r = sh(cfg, commandFor(cfg), [path.join(repoRoot, 'scripts', 'egress-check.sh')], {
    env: netEnv(cfg),
    label: 'egress allowlist check',
  });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function metadataOf(issue) {
  const raw = issue && issue.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* malformed metadata proves no ownership */ }
  }
  return {};
}

function issueFromShow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function ownedBy(issue, owner) {
  const metadata = metadataOf(issue);
  return !!issue && issue.status === 'in_progress'
    && issue.assignee === owner.actor
    && metadata[OWNER_TOKEN_KEY] === owner.token
    && metadata[OWNER_RUN_KEY] === owner.runId;
}

// Recovery is no longer a mass reset. The global lock carries the owner tokens of runs
// proven dead or cleanly released with unfinished claims; Beads carries the same token,
// actor and run id from the atomic claim transaction. All four facts must still agree.
// A human's in-progress issue, or one reclaimed by a later run, is therefore untouchable.
function recoverStaleIssues(cfg, log, traceId, ownership, io = {}) {
  const owners = Array.isArray(ownership && ownership.recoveryOwners)
    ? ownership.recoveryOwners.filter((o) => o && o.token && o.actor && o.runId) : [];
  if (!owners.length) return { recovered: [] };
  const readJson = io.bdJson || bdJson;
  const write = io.bd || bd;
  const clearOwner = io.clearRecoveryOwner || clearRecoveryOwner;
  const res = readJson(cfg, ['list', '--status', 'in_progress']);
  if (!res.ok) return { recovered: [], error: res.error };
  const recovered = [];
  const errors = [];
  const entries = Array.isArray(res.data) ? res.data : [];
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    const shown = readJson(cfg, ['show', entry.id]);
    if (!shown.ok) {
      errors.push(`cannot verify ownership of ${entry.id}: ${shown.error}`);
      continue;
    }
    const issue = issueFromShow(shown.data);
    const owner = owners.find((candidate) => ownedBy(issue, candidate));
    if (!owner) continue;
    const result = write(cfg, [
      'update', issue.id,
      '--status', 'open',
      '--assignee', '',
      '--unset-metadata', OWNER_TOKEN_KEY,
      '--unset-metadata', OWNER_RUN_KEY,
      '--append-notes', `runner: recovered ownership from dead run ${owner.runId}`,
      '--actor', ownership.actor,
    ]);
    if (result.status !== 0) {
      errors.push(`cannot recover ${issue.id}: ${String(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
      continue;
    }
    recovered.push(issue.id);
    log.info(traceId, `recovered runner-owned in_progress issue ${issue.id} from dead run ${owner.runId} -> open`);
  }
  if (!errors.length) {
    for (const owner of owners) {
      try { clearOwner(ownership, owner.token); }
      catch (e) { errors.push(`cannot settle recovery proof for run ${owner.runId}: ${e && e.message ? e.message : e}`); }
    }
  }
  return { recovered, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

// Full pre-run sequence. Returns {ok, reason} — ok:false means ABORT THE RUN.
// Every gate after the lock can leave something behind, so each of them releases it on
// the way out: an abort at preflight must leave the project free (§4.12).
function preflight(cfg, repoRoot, log, deps = {}) {
  const t = `${log.runId}/preflight`;

  // ---- the project lock: FIRST, ahead of every other gate (§4.12) ----
  // First and not merely early. It is the only purely local check — everything after it
  // probes Docker or writes to Beads, and a refusal that arrives after `bd update` has
  // reset another live run's in_progress issues has not refused anything useful. Being
  // first is also what lets a second run be refused with nothing created to clean up:
  // no network, no sidecar, no container, no Beads write.
  const held = acquire(repoRoot, cfg.targetRepoPath, log.runId);
  if (!held.ok) {
    const h = held.holder;
    return {
      ok: false,
      locked: true,                  // nothing was started — run.js skips teardown
      reason: `${cfg.targetRepoPath} is already being run by run ${h.runId}`
        + ` (pid ${h.pid}${h.since ? `, since ${h.since}` : ''}) — two runners on one Beads queue`
        + ` would claim the same issue twice (§4.10). Wait for that run, or run a different project.`,
    };
  }
  if (held.tookOver) {
    log.info(t, `project lock: took over the lock on ${cfg.targetRepoPath} left by run ${held.previous.runId}`
      + ` (pid ${held.previous.pid}) — that process is gone`,
    { event: 'lock.tookOver', data: { path: cfg.targetRepoPath } });
  }
  log.info(t, `project lock held for ${cfg.targetRepoPath}`,
    { event: 'lock.held', data: { path: cfg.targetRepoPath } });
  let keepOwnership = false;
  let networkAttempted = false;
  try {
    const checkDocker = deps.dockerAvailable || dockerAvailable;
    const checkImage = deps.imageExists || imageExists;
    const startNetwork = deps.networkUp || networkUp;
    const checkEgress = deps.egressCheck || egressCheck;
    const recover = deps.recoverStaleIssues || recoverStaleIssues;
    // The local checkout owns Beads while the configured remote owns every dispatch fetch,
    // workspace and publication. Prove they identify the same repository before either side
    // can be mutated. The lock stays first so two contenders cannot race this or any later gate.
    const checkIdentity = deps.verifyRepoIdentity || verifyRepoIdentity;
    const identity = checkIdentity(cfg);
    if (!identity.ok) return { ok: false, identityMismatch: true, reason: identity.reason };
    log.info(t, `repository identity verified via '${identity.remoteName}' (${identity.identity})`);

    // Before Docker, networking, or Beads: on Windows `bash` may be WSL, which cannot launch
    // this process's Windows Node toolchain. Resolve one shell, prove the exact Node binary
    // through it, and reuse that identity for every host-side shell call in the run.
    const resolveShell = deps.resolveHostShell || resolveHostShell;
    const shell = resolveShell(cfg.hostShell, { timeoutMs: cfg.lifecycleTimeoutMs });
    if (!shell.ok) return { ok: false, reason: shell.reason, shellUnavailable: true };
    cfg.hostShell = shell.command;
    log.info(t, `host shell verified (${shell.kind}): ${shell.command}`);

    const daemon = checkDocker(cfg);
    if (daemon.status !== 0) {
      return {
        ok: false,
        reason: daemon.timedOut
          ? failureText(daemon)
          : 'Docker daemon not reachable (is Docker Desktop running?)',
      };
    }
    log.info(t, 'docker daemon reachable');

    const image = checkImage(cfg.image, cfg);
    if (image.status !== 0) {
      return {
        ok: false,
        reason: image.timedOut ? failureText(image)
          : `image '${cfg.image}' not found — build it during planning (§3.4); the runner never builds`,
      };
    }
    log.info(t, `image ${cfg.image} present`);

    // Set before invoking `up`: the script can create the network and then fail. Any
    // attempted startup therefore owns a compensating `down` on every non-success path.
    networkAttempted = true;
    const net = startNetwork(repoRoot, cfg, log, t);
    if (!net.ok) return { ok: false, reason: `network/sidecar failed to start: ${net.output.trim()}` };
    log.info(t, 'network + proxy sidecar up');

    const eg = checkEgress(repoRoot, cfg);
    if (!eg.ok) return { ok: false, reason: `egress check failed — allowlist not in force: ${eg.output.trim()}` };
    log.info(t, 'egress check passed (allowlist in force)');

    const stale = recover(cfg, log, t, held.ownership);
    if (stale.error) log.error(t, `stale-issue recovery skipped: ${stale.error}`);

    keepOwnership = true;
    return {
      ok: true,
      recovered: stale.recovered || [],
      networkOwned: true,
      lockOwned: true,
      ownership: held.ownership,
    };
  } catch (e) {
    return { ok: false, unexpected: true, reason: `preflight failed unexpectedly: ${e && e.message ? e.message : e}` };
  } finally {
    if (!keepOwnership) {
      try {
        if (networkAttempted) {
          const down = (deps.networkDown || networkDown)(repoRoot, cfg);
          if (down && down.ok === false) {
            log.error(t, `preflight cleanup could not tear down network plumbing: ${String(down.output || '').trim() || 'no diagnostic'}`);
          }
        }
      } catch (e) {
        log.error(t, `preflight cleanup threw while tearing down network plumbing: ${e && e.message ? e.message : e}`);
      } finally {
        release(repoRoot, cfg.targetRepoPath, held.ownership);
      }
    }
  }
}

module.exports = {
  preflight, networkUp, networkDown, egressCheck, imageExists, dockerAvailable,
  recoverStaleIssues, metadataOf, ownedBy, verifyRepoIdentity,
};
