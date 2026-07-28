// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Spec concerns, host side — DESIGN.md §3.7 (declared), §3.5 (evidence, never a gate).
// The container may append `specConcerns` entries to its status file; after it exits the
// host surfaces them at the four places a human reviewing a run already looks — the Beads
// attempt log, the run manifest, the run report and the PR body.
//
// Two invariants live here, and only here:
//
//  1. The BOUNDS (§3.7: at most 5 entries, each truncated to its first 1000 characters)
//     are re-enforced on the host. `pipeline/status.js` already caps on the way in, but
//     the status file is written by the agent inside the container and the host never
//     trusts it to have obeyed its own schema. All four surfaces come through this
//     module, because four copies of "first 5, first 1000 chars" is four chances to drift.
//  2. NOTHING here can move an outcome. No exit code, no §4.11 status, no Beads
//     transition, no decision about pushing a branch or opening a PR — the same posture
//     as `advisories`, and what keeps the three-attempt cap meaningful. Non-fatal like
//     memory filing: a malformed, absent or wrong-typed field is silently nothing rather
//     than an error (the `docsPhaseError` posture), so neither export ever throws.
'use strict';

const MAX_ENTRIES = 5;
const MAX_CHARS = 1000;

// The bounded concerns a status file carries, in input order. Accepts anything at all:
// a null/undefined status, or a `specConcerns` that is absent, null, a string, a number
// or an object, all yield [].
function specConcerns(status) {
  const raw = status && status.specConcerns;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    // Junk is dropped BEFORE the cap of five, so a stray blank entry cannot silently
    // displace a real concern. This diverges deliberately from `fileMemoryNotes`, which
    // slices to its cap first and skips blanks afterwards.
    if (!text) continue;
    out.push(text.slice(0, MAX_CHARS));            // head kept: the accusation comes first
    if (out.length === MAX_ENTRIES) break;
  }
  return out;
}

// One concern flattened for a surface that renders one entry per line — a bd note is a
// single indented block and a markdown bullet is a single line, so an internal newline
// would break either apart. The full text survives; only the line breaks become spaces.
function oneLine(text) {
  return String(text).replace(/\s*[\r\n]+\s*/g, ' ');
}

// The record fragment `run.js` spreads onto a task in the run manifest: the bounded
// values, or NO KEY at all when there is nothing to say (§4.12 declares the field
// optional, and an empty array on every task would be noise in every manifest).
function manifestFields(status) {
  const raised = specConcerns(status);
  return raised.length ? { specConcerns: raised } : {};
}

module.exports = { specConcerns, manifestFields, oneLine, MAX_ENTRIES, MAX_CHARS };
