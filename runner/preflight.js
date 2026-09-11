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
const { admitEntry } = require('./supervisor');
const {
  normalizeProvider, providerFor, missingCodexCapabilities,
} = require('./agent-provider');
const codexAuth = require('./codex-auth');
const { sandboxSecurityArgs } = require('./container');

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

// Does the task image actually carry a usable CLI for the SELECTED provider (§4.12)?
// `image inspect` proves the image is present, not that it can run this run's agent — an
// image built before the Codex pin, or with an older CLI, passes that gate and then fails
// inside every task container with no host-side diagnostic.
//
// Isolated on purpose: `--network none` so a capability probe cannot reach a model
// endpoint, and `--entrypoint` so the image's own entrypoint is not what answers.
function imageSupportsProvider(cfg, provider, execute = sh) {
  const image = cfg && cfg.image;
  if (normalizeProvider(provider) === 'codex') {
    const probe = execute(cfg, 'docker',
      ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', image, 'exec', '--help'],
      { label: 'Codex CLI capability probe' });
    if (!probe || probe.status !== 0) return false;
    return missingCodexCapabilities(`${probe.stdout || ''}${probe.stderr || ''}`).length === 0;
  }
  const probe = execute(cfg, 'docker',
    ['run', '--rm', '--network', 'none', '--entrypoint', 'claude', image, '--version'],
    { label: 'Claude CLI capability probe' });
  return !!probe && probe.status === 0;
}

// `codex exec --help` proves the CLI contract, but not that the host kernel and Docker policy
// let the pinned CLI create the workspace-write sandbox it will use for model commands. This
// credential-free command probe uses a stricter outer boundary than a task: read-only root, no
// capabilities, no-new-privileges, non-root uid, no network, and bounded resources.
function codexSandboxAvailable(cfg, execute = sh) {
  const probe = execute(cfg, 'docker', [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', ...sandboxSecurityArgs('codex'),
    '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '-e', 'HOME=/tmp/home',
    '--user', 'node', '--entrypoint', 'codex', cfg.image, 'sandbox', '--', 'true',
  ], { label: 'Codex workspace sandbox capability probe' });
  return !!probe && probe.status === 0;
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
    // Which allowlist the sidecar is built from and which endpoint the gate proves
    // reachable. One profile per provider — never one profile widened to both.
    PIPELINE_PROXY_PROFILE: providerFor(cfg),
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
function preflightAfterAuth(cfg, repoRoot, log, deps = {}) {
  const t = `${log.runId}/preflight`;

  // ---- child admission: ahead of the project lock itself (§3.10) ----
  // Ahead of the lock because it decides WHICH exclusion applies. With no supervisor on this
  // canonical target and no child authority presented, it answers `standalone` and everything
  // below is exactly today's behaviour. With a supervisor live, an unrelated run is refused by
  // that supervisor's name before it can take a lock, probe Docker, create a network or write
  // to Beads; with valid implementation authority, the run proceeds under its parent's
  // ownership and takes no target lock of its own.
  const admitChild = deps.admitEntry || admitEntry;
  const entry = admitChild('implementation', {
    targetRepoPath: cfg.targetRepoPath, repoRoot, env: deps.env || process.env,
  });
  if (!entry.ok) {
    return {
      ok: false,
      locked: true,                    // nothing was started — run.js skips teardown
      childAuthorityRefused: true,
      reason: `child authority refused (${entry.reason}): ${entry.message}`,
    };
  }
  const child = entry.mode === 'supervisor-child' ? entry.admission : null;
  if (child) {
    // The same line a standalone run writes, because the project lock IS held for this target
    // — by the parent, not by this process. Saying anything else would leave the dashboard's
    // live view unable to tell a supervised run from one that never got the project at all.
    log.info(t, `project lock held for ${cfg.targetRepoPath} by supervisor ${child.parent.id}`
      + ` (pid ${child.parent.pid}); admitted as its child under grant ${child.nonce}`
      + `${child.issueId ? ` for ${child.issueId}` : ''}, so this run takes no lock of its own`,
    { event: 'lock.held', data: { path: cfg.targetRepoPath } });
    return childPreflight(cfg, repoRoot, log, deps, t, child);
  }

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
  return startupGates(cfg, repoRoot, log, deps, t, {
    ownership: held.ownership,
    lockOwned: true,
    releaseOwnership: () => release(repoRoot, cfg.targetRepoPath, held.ownership),
  });
}

// A supervisor child runs exactly the same gates in exactly the same order, and owns exactly
// the same compensation for the plumbing it starts. The one difference is ownership: the
// parent's lease already excludes every other coordinator from this canonical target, so the
// child takes no lock and must never release the one it was let in under.
function childPreflight(cfg, repoRoot, log, deps, t, child) {
  return startupGates(cfg, repoRoot, log, deps, t, {
    ownership: null,
    lockOwned: false,
    childAdmission: child,
    releaseOwnership: () => {},
  });
}

// Everything after admission and the lock. Extracted so the standalone and supervisor-child
// paths cannot drift apart in gate ORDER — the order is the contract (§4.12): identity, shell,
// Docker, image, network, egress, stale-issue recovery, and a compensating teardown on every
// unsuccessful path.
function startupGates(cfg, repoRoot, log, deps, t, owned) {
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

    // Only for a non-default provider: a Claude run's image gate is exactly the presence
    // check above, as it has always been, so an untouched run config launches nothing new.
    const provider = providerFor(cfg);
    if (provider !== 'claude') {
      const supports = (deps.imageSupportsProvider || imageSupportsProvider)(cfg, provider);
      if (!supports) {
        return {
          ok: false,
          reason: `image '${cfg.image}' has no usable ${provider} CLI with every required`
            + ` capability — rebuild the pinned base image during planning (§3.4); the runner never builds`,
        };
      }
      log.info(t, `image ${cfg.image} runs the selected ${provider} CLI`);
      // Existing deterministic fixtures replace imageSupportsProvider as the complete provider
      // seam. Production, and a fixture explicitly supplying the new seam, additionally proves
      // the real sandbox command before network startup or any Beads mutation.
      if ((!deps.imageSupportsProvider || deps.codexSandboxAvailable)
          && !(deps.codexSandboxAvailable || codexSandboxAvailable)(cfg)) {
        return {
          ok: false,
          reason: `image '${cfg.image}' cannot start the Codex workspace sandbox as its non-root`
            + ' task user — the Docker runtime must permit the provider-specific unprivileged'
            + ' namespace policy; no task was started',
        };
      }
      if (!deps.imageSupportsProvider || deps.codexSandboxAvailable) {
        log.info(t, `image ${cfg.image} starts the Codex workspace sandbox as node`);
      }
    }

    // Set before invoking `up`: the script can create the network and then fail. Any
    // attempted startup therefore owns a compensating `down` on every non-success path.
    networkAttempted = true;
    const net = startNetwork(repoRoot, cfg, log, t);
    if (!net.ok) return { ok: false, reason: `network/sidecar failed to start: ${net.output.trim()}` };
    log.info(t, 'network + proxy sidecar up');

    const eg = checkEgress(repoRoot, cfg);
    if (!eg.ok) return { ok: false, reason: `egress check failed — allowlist not in force: ${eg.output.trim()}` };
    log.info(t, 'egress check passed (allowlist in force)');

    const stale = recover(cfg, log, t, owned.ownership);
    if (stale.error) log.error(t, `stale-issue recovery skipped: ${stale.error}`);

    keepOwnership = true;
    return {
      ok: true,
      recovered: stale.recovered || [],
      networkOwned: true,
      lockOwned: owned.lockOwned,
      ownership: owned.ownership,
      ...(owned.childAdmission ? { childAdmission: owned.childAdmission } : {}),
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
        owned.releaseOwnership();
      }
    }
  }
}

// Managed ChatGPT state is checked before every lock and mutable gate. Legacy modes stay synchronous.
function preflight(cfg, repoRoot, log, deps = {}) {
  if (providerFor(cfg) !== 'codex' || cfg.codexAuth !== 'chatgpt') return preflightAfterAuth(cfg, repoRoot, log, deps);
  const env = deps.env || process.env;
  return Promise.resolve((deps.codexAuth || codexAuth).preflight({
    mode: 'chatgpt', codexHome: env.CODEX_HOME, cacheRoot: env.PIPELINE_CODEX_CACHE,
  })).then((auth) => {
    if (!auth || !auth.ok) return { ok: false, authRefused: true, reason: auth && auth.reason || 'ChatGPT authentication unavailable' };
    cfg.codexAuthCacheRoot = auth.cacheRoot;
    return preflightAfterAuth(cfg, repoRoot, log, deps);
  });
}

module.exports = {
  preflight, networkUp, networkDown, egressCheck, imageExists, imageSupportsProvider,
  codexSandboxAvailable, dockerAvailable, recoverStaleIssues, metadataOf, ownedBy, verifyRepoIdentity,
};
