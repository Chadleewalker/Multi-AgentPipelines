// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Sweep reclamation: what `scripts/test-all.sh` is allowed to remove after a suite, and
// why it is allowed to. DESIGN.md §4.12 (the runner owns the run lifecycle); change-log
// row `repo-zje`.
//
// OWNERSHIP IS A SNAPSHOT DIFF, NEVER A NAME MATCH. A resource is the sweep's to remove
// only if it (a) was absent before the suite ran and (b) matches the pipeline allowlist.
// Both halves are load-bearing:
//
//   * without (a), a developer's own long-lived `pipeline-proxy` — or a container from a
//     concurrent run — is destroyed by a test sweep;
//   * without (b), the sweep removes whatever else the machine happened to start while a
//     suite was running, which is not its business.
//
// The half that is already broken in the suites this replaces is (a) combined with a
// SUBSTRING name filter: `docker ps -aq --filter name=task-` matches `my-task-runner`,
// because docker's name filter is a substring (really a regex) match, not a prefix one.
// The `task-` rule here is anchored at the start of the name and is only ever consulted
// about resources the diff already says appeared during the suite.
//
// EVERY DOCKER CALL GOES THROUGH ${SWEEP_DOCKER:-docker}. That single seam is what makes
// the sweep drivable by a Docker-free test, and it is safe in a way a PATH stub for
// `pipeline-net.sh down` is not: `down` removes the network and the proxy BY NAME and
// unconditionally, so a stub that failed to intercept would delete the real ones, whereas
// a missed seam here yields an empty before/after diff and removes nothing at all.
//
// Usage:
//   node scripts/sweep-reclaim.js snapshot                 # the before-listing, as JSON
//   node scripts/sweep-reclaim.js reclaim --before <file>  # diff, remove, name what went
//   node scripts/sweep-reclaim.js reclaim --before <file> --dry-run
//
// `reclaim` prints ONE line to stdout — the note the sweep puts in its summary table,
// empty when the suite leaked nothing — and always exits 0. Diagnostics go to stderr, on
// purpose: a reclaimer that could fail a sweep would turn harness hygiene into a verdict,
// and one that swallowed its diagnostics would hide a seam that stopped working.
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

// ---- the allowlist -----------------------------------------------------------------
// Everything the pipeline itself creates, and nothing else. Kept as data so a reader can
// see the whole of what the sweep claims ownership of in one place.
const OWNED_IMAGES = ['pipeline-base:local', 'pipeline-proxy:local'];
const OWNED_NAMES = ['pipeline-proxy'];
const OWNED_NAME_PREFIX = 'task-';
const OWNED_NETWORKS = ['pipeline-net'];

// A bound, for the same reason runner/bd.js has one: a docker CLI that never returns must
// fail loudly rather than park the sweep between two suites.
const DOCKER_TIMEOUT_MS = 60000;

function ownsContainer(c) {
  if (!c || typeof c.id !== 'string' || !c.id) return false;
  const name = typeof c.name === 'string' ? c.name : '';
  const image = typeof c.image === 'string' ? c.image : '';
  if (OWNED_IMAGES.indexOf(image) !== -1) return true;
  if (OWNED_NAMES.indexOf(name) !== -1) return true;
  return name.slice(0, OWNED_NAME_PREFIX.length) === OWNED_NAME_PREFIX; // anchored at 0
}

function ownsNetwork(name) {
  return typeof name === 'string' && OWNED_NETWORKS.indexOf(name) !== -1;
}

function containerIds(listing) {
  const seen = new Set();
  const rows = (listing && listing.containers) || [];
  for (const row of rows) {
    // The before-listing carries identities only (`docker ps -aq`); the after-listing
    // carries attributes too. Accept either shape — all this needs is the identity.
    if (typeof row === 'string') { if (row.trim()) seen.add(row.trim()); }
    else if (row && typeof row.id === 'string' && row.id.trim()) seen.add(row.id.trim());
  }
  return seen;
}

function networkNames(listing) {
  const seen = new Set();
  for (const n of ((listing && listing.networks) || [])) {
    if (typeof n === 'string' && n.trim()) seen.add(n.trim());
  }
  return seen;
}

// The pure decision. No I/O, no docker, no environment: given what was there before the
// suite and what is there after it, say what the sweep created and may remove.
// Containers come first — a network still holding one cannot be removed.
function reclaimTargets(before, after) {
  const wasThere = containerIds(before);
  const hadNetwork = networkNames(before);
  const targets = [];

  for (const c of ((after && after.containers) || [])) {
    if (!c || typeof c.id !== 'string' || !c.id.trim()) continue;
    const row = {
      id: c.id.trim(),
      name: typeof c.name === 'string' ? c.name.trim() : '',
      image: typeof c.image === 'string' ? c.image.trim() : '',
    };
    if (wasThere.has(row.id)) continue;      // pre-existing — not ours, whatever it is
    if (!ownsContainer(row)) continue;       // appeared, but nothing to do with us
    targets.push({ kind: 'container', id: row.id, name: row.name, image: row.image });
  }

  for (const n of ((after && after.networks) || [])) {
    if (typeof n !== 'string') continue;
    const name = n.trim();
    if (!name || hadNetwork.has(name) || !ownsNetwork(name)) continue;
    targets.push({ kind: 'network', name });
  }

  return targets;
}

// ---- the seam ----------------------------------------------------------------------

function dockerCommand() {
  return process.env.SWEEP_DOCKER || 'docker';
}

function docker(args) {
  const r = spawnSync(dockerCommand(), args, {
    encoding: 'utf8',
    timeout: DOCKER_TIMEOUT_MS,
    killSignal: 'SIGKILL', // a wedged CLI can decline SIGTERM, and a bound that can be
                           // declined is not a bound (runner/bd.js, change-log row `repo-sls`)
  });
  const failedToRun = Boolean(r.error);
  return {
    ok: !failedToRun && r.status === 0,
    out: typeof r.stdout === 'string' ? r.stdout : '',
    why: failedToRun ? String(r.error && r.error.message) : `exit ${r.status}`,
  };
}

function lines(out) {
  // Split on both endings: the working copy is CRLF on the reference host and LF
  // everywhere a container looks at it (CLAUDE.md, "Guard line endings at the point of
  // parsing").
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function parseContainerRow(line) {
  const f = line.split(/\s+/);
  if (f.length < 3) return null;
  return { id: f[0], name: f[1].split(',')[0], image: f[2] };
}

// The before-listing: identities only. That is all a membership test needs, and asking
// for less means a baseline can never be mistaken for a classification.
function snapshot() {
  const c = docker(['ps', '-aq']);
  const n = docker(['network', 'ls', '--format', '{{.Name}}']);
  return {
    ok: c.ok && n.ok,
    containers: lines(c.out).map((id) => ({ id })),
    networks: lines(n.out),
    why: [c.ok ? null : `ps: ${c.why}`, n.ok ? null : `network ls: ${n.why}`]
      .filter(Boolean).join('; '),
  };
}

// The after-listing: identity plus the attributes the allowlist is decided on.
function census() {
  const c = docker(['ps', '-a', '--format', '{{.ID}} {{.Names}} {{.Image}}']);
  const n = docker(['network', 'ls', '--format', '{{.Name}}']);
  return {
    ok: c.ok && n.ok,
    containers: lines(c.out).map(parseContainerRow).filter(Boolean),
    networks: lines(n.out),
    why: [c.ok ? null : `ps: ${c.why}`, n.ok ? null : `network ls: ${n.why}`]
      .filter(Boolean).join('; '),
  };
}

function label(t) {
  if (t.kind === 'network') return `network ${t.name}`;
  return t.name ? `container ${t.id} (${t.name})` : `container ${t.id}`;
}

function remove(t) {
  return t.kind === 'network' ? docker(['network', 'rm', t.name]) : docker(['rm', '-f', t.id]);
}

// ---- the CLI -----------------------------------------------------------------------

function readBefore(file) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  // A baseline that could not be taken is not a baseline. Treating it as "nothing was
  // here" would make the first failed listing remove every pipeline container on the
  // machine, which is the exact opposite of what this file is for.
  if (!parsed || parsed.ok !== true) return null;
  return parsed;
}

function cliReclaim(beforeFile, dryRun) {
  const before = readBefore(beforeFile);
  if (!before) {
    process.stderr.write(
      `sweep-reclaim: no usable before-listing (${beforeFile || 'none given'}) — `
      + 'reclaimed nothing; the sweep never removes what it cannot prove it created\n');
    return '';
  }

  const after = census();
  if (!after.ok) {
    process.stderr.write(`sweep-reclaim: could not list docker resources (${after.why}) — `
      + 'reclaimed nothing\n');
    return '';
  }

  const targets = reclaimTargets(before, after);
  if (targets.length === 0) return '';

  if (dryRun) return `would reclaim ${targets.map(label).join(', ')}`;

  const gone = [];
  const stuck = [];
  for (const t of targets) {
    const r = remove(t);
    if (r.ok) gone.push(label(t));
    else {
      stuck.push(label(t));
      process.stderr.write(`sweep-reclaim: could not remove ${label(t)} (${r.why})\n`);
    }
  }

  const parts = [];
  if (gone.length) parts.push(`reclaimed ${gone.join(', ')}`);
  if (stuck.length) parts.push(`could not reclaim ${stuck.join(', ')}`);
  return parts.join('; ');
}

function main(argv) {
  const mode = argv[0] || '';
  const beforeAt = argv.indexOf('--before');
  const beforeFile = beforeAt === -1 ? '' : (argv[beforeAt + 1] || '');
  const dryRun = argv.indexOf('--dry-run') !== -1;

  if (mode === 'snapshot') {
    const s = snapshot();
    process.stdout.write(`${JSON.stringify(s)}\n`);
    if (!s.ok) process.stderr.write(`sweep-reclaim: snapshot incomplete (${s.why})\n`);
    return s.ok ? 0 : 1;
  }

  if (mode === 'reclaim') {
    const note = cliReclaim(beforeFile, dryRun);
    if (note) process.stdout.write(`${note}\n`);
    return 0; // never a verdict: see the header
  }

  process.stderr.write('usage: sweep-reclaim.js snapshot | reclaim --before <file> [--dry-run]\n');
  return 2;
}

module.exports = {
  reclaimTargets,
  ownsContainer,
  ownsNetwork,
  snapshot,
  census,
  label,
  OWNED_IMAGES,
  OWNED_NAMES,
  OWNED_NAME_PREFIX,
  OWNED_NETWORKS,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
