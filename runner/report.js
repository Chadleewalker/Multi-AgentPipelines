// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Run manifest + run report — DESIGN.md §4.9, §4.12 (T17).
// The report is generated from the manifest + git, never hand-edited, and
// regeneration from the same inputs is byte-identical.
'use strict';
const fs = require('fs');
const path = require('path');

// Scrutiny order (§4.9): tampered > undispatchable > stuck > partial > failed >
// done-with-retries > done-first-try, ties broken by attempt count then diff size.
//
// `undispatchable` (§4.11, §4.12) ranks second, behind `tampered`: a batch that could not
// run at all is the first thing a person opening the report needs to see. Its rank is
// INSERTED FRACTIONALLY and never renumbered — `scrutinyKey`'s fallback for an unknown
// outcome is the literal rank `failed` holds, so renumbering would silently re-home every
// future unknown outcome, which is not this table's to do.
const RANK = { tampered: 0, undispatchable: 0.5, stuck: 1, partial: 2, failed: 3, paused: 4, done: 5 };

function scrutinyKey(t) {
  const base = RANK[t.outcome] === undefined ? 3 : RANK[t.outcome];
  // done splits: with retries ranks above first-try.
  const doneAdjust = t.outcome === 'done' && (t.attempts || 0) <= 1 ? 0.5 : 0;
  return [base + doneAdjust, -(t.attempts || 0), -(t.diffLines || 0)];
}

function byScrutiny(a, b) {
  const ka = scrutinyKey(a);
  const kb = scrutinyKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return String(a.issueId).localeCompare(String(b.issueId)); // deterministic tie-break
}

function writeManifest(runDir, manifest) {
  const file = path.join(runDir, 'run.json');
  const ordered = { ...manifest, tasks: [...manifest.tasks].sort(byScrutiny) };
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n');
  return { file, manifest: ordered };
}

const LABEL = {
  done: 'DONE',
  partial: 'PARTIAL — acceptance passed, regressions failed',
  stuck: 'STUCK — bailed after 3 attempts',
  tampered: 'TAMPERED — frozen tests were modified',
  failed: 'FAILED',
  paused: 'PAUSED — usage window did not reopen',
  // A label of its own, because the fallback below prints the bare outcome word (§4.12). This
  // is the HISTORIC sentence and it stays the default: a row carrying no `refusal` — a manifest
  // written before §4.12's third admission rule, or any other writer of this outcome — is the
  // second admission rule's refusal and nothing else, and renders exactly as it always did.
  undispatchable: 'UNDISPATCHABLE — no frozen acceptance suite on the integration branch',
};

// §4.12's four refusal kinds, in the heading. One phrase each, and DISTINCT: the heading is
// what a person skimming a report of thirty tasks reads, and four different failures under one
// sentence send three of them to the wrong remedy. The vocabulary is `runner/queue.js`'s
// `REFUSAL` and `run.schema.json`'s enum; an unknown kind falls back to the historic label
// rather than inventing a heading for a value this report does not understand.
const UNDISPATCHABLE_LABEL = {
  'no-suite': LABEL.undispatchable,
  'no-receipt': 'UNDISPATCHABLE — the frozen suite carries no freeze receipt',
  'receipt-mismatch': 'UNDISPATCHABLE — the frozen suite has changed since its receipt was written',
  'half-proven': 'UNDISPATCHABLE — the freeze receipt records a half-proven freeze',
};

// The body paragraph, keyed by the same four. Every one of them opens on the fact that makes
// this outcome unlike all the others — Beads was never touched — and then names the remedy for
// THAT kind and no other.
const NOT_DISPATCHED = 'so Beads was never touched and it is still `open`';
const UNDISPATCHABLE_BODY = {
  'no-suite': (id) => 'Freeze its acceptance suite at '
    + `\`tests/acceptance/${id}/\` on the branch task containers fork from and **push it** — `
    + 'freezing locally is not freezing — then re-run.',
  'no-receipt': (id) => `The suite at \`tests/acceptance/${id}/\` is on the branch, but nothing `
    + 'beside it records that it was ever gated: there is no receipt, or the one there is '
    + 'cannot be read. Run the freeze gate over that suite and push the `.freeze-gate.json` it '
    + 'writes, together with the suite, then re-run.',
  'receipt-mismatch': (id) => `The suite at \`tests/acceptance/${id}/\` carries a receipt, but `
    + 'the branch no longer holds the suite that receipt was written for — it was edited after '
    + 'the gate blessed it, so what a container would be judged against has never been gated. '
    + 'Run the freeze gate over it again and push the suite and its fresh receipt together, '
    + 'then re-run.',
  'half-proven': (id) => `The gate found the suite at \`tests/acceptance/${id}/\` red at the `
    + 'fork point but was given no probe, so the green side has never been seen and nothing '
    + 'has shown an implementation can satisfy it — the class that produced seven of twelve '
    + 'stuck tasks in one fortnight. Re-gate it with a probe (`--green <probe-dir>`), or set '
    + '`allowHalfProven: true` in the run config if a half-proven freeze is good enough for '
    + 'this run, then re-run.',
};

const refusalKindOf = (t) => (
  Object.prototype.hasOwnProperty.call(UNDISPATCHABLE_LABEL, t.refusal) ? t.refusal : 'no-suite');

function renderReport(manifest) {
  const L = [];
  const counts = {};
  for (const t of manifest.tasks) counts[t.outcome] = (counts[t.outcome] || 0) + 1;

  L.push(`# Run report — ${manifest.runId}`);
  L.push('');
  L.push(`Started ${manifest.startedAt} · finished ${manifest.finishedAt}`);
  if (manifest.targetRepo) L.push(`Target: \`${manifest.targetRepo}\``);
  L.push('');
  if (manifest.abortedReason) {
    L.push(`> **Run aborted:** ${manifest.abortedReason}`);
    L.push('');
  }
  L.push(`**${manifest.tasks.length} task(s)**: ` +
    (Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`).join(' · ') || 'none'));
  L.push('');

  // §3.7 (the readership amendment), at RUN level and UNCONDITIONAL. The per-task block
  // further down is right for one concern and wrong for seven: what a reader needs is not a
  // concern but the same concern arriving n times, and that fact exists only across tasks —
  // where, until this line, no artifact looked. So the count prints for every manifest,
  // including a clean one where the news is the zero, rather than behind the per-task
  // truthiness guard, which would go silent on exactly the runs a reader can stop reading.
  //
  // It is a count and nothing else. A concern is evidence, never a gate (hard rule 5,
  // §3.5): nothing here consults an outcome and nothing here can change one. A malformed
  // `specConcerns` counts as zero — the manifest is not schema-validated at render time,
  // and `(t.specConcerns || []).length` would score the string 'nope' as four.
  //
  // Bold, never `## `: scripts/test-report.sh reads task order with
  // `grep -o '^## [a-z0-9-]*'`, so a run-level `## ` heading injects a phantom task there.
  const concernCount = (t) => (Array.isArray(t.specConcerns) ? t.specConcerns.length : 0);
  const raisers = manifest.tasks.filter((t) => concernCount(t) > 0);
  const concernTotal = raisers.reduce((n, t) => n + concernCount(t), 0);
  L.push(`**Spec concerns: ${concernTotal} raised by ${raisers.length} of ` +
    `${manifest.tasks.length} tasks.** Evidence only — none of them changed an outcome `
    + 'above (DESIGN.md §3.7); a spec may be changed in a planning session and nowhere else.');
  L.push('');

  L.push('Ordered by how much scrutiny each item needs.');
  L.push('');

  for (const t of manifest.tasks) {
    const label = t.outcome === 'undispatchable'
      ? UNDISPATCHABLE_LABEL[refusalKindOf(t)]
      : (LABEL[t.outcome] || t.outcome);
    L.push(`## ${t.issueId} — ${label}`);
    L.push('');
    if (t.title) L.push(`**${t.title}**`);
    L.push('');
    const facts = [];
    if (t.branch) facts.push(`Branch: \`${t.branch}\`${t.pushed ? '' : ' (not pushed — no commits)'}`);
    if (t.prUrl) facts.push(`PR: ${t.prUrl}`);
    else if (t.pushed) facts.push('PR: none — review the branch directly');
    if (t.attempts !== undefined) facts.push(`Attempts: ${t.attempts}`);
    if (t.pauses) facts.push(`Rate-limit pauses: ${t.pauses}`);
    if (t.activeSeconds !== undefined) facts.push(`Active time: ${t.activeSeconds}s`);
    if (t.diffLines !== undefined) facts.push(`Diff: ${t.diffLines} lines`);
    if (t.model) facts.push(`Model: ${t.model}`);
    for (const f of facts) L.push(`- ${f}`);
    L.push('');

    // §4.12's refusal, stated even for a row carrying nothing else. The remedy is the whole
    // point of the row — a reader who learns only that a task did not run learns nothing
    // actionable — and it must not depend on the manufactured fields being present, because
    // an older manifest, or any other writer of this outcome, carries none of them.
    if (t.outcome === 'undispatchable') {
      L.push('**Not dispatched.** The ready queue refused this issue before anything was '
        + `claimed, ${NOT_DISPATCHED}. `
        + UNDISPATCHABLE_BODY[refusalKindOf(t)](t.issueId));
      L.push('');
    }

    // §3.7, ABOVE "what changed" AND ON PURPOSE. A concern cannot change an outcome, so a
    // task that raises one still sorts by its outcome — and `done` sorts LAST. The first
    // concern ever raised in a real run came from a first-try `done` at the bottom of a
    // one-task report, which is the easiest place in this file for a reader to stop before.
    // Putting it above the summary is the whole reason the channel exists (§3.3).
    if (t.specConcerns && t.specConcerns.length) {
      const n = t.specConcerns.length;
      L.push(`**⚠ Spec concern${n === 1 ? '' : 's'} raised (${n})** — the agent believes the ` +
        'frozen spec or its tests are wrong. This did not affect the outcome above ' +
        '(DESIGN.md §3.7); changing a spec is legal in a planning session and nowhere else.');
      L.push('');
      for (const c of t.specConcerns) {
        L.push('> ' + String(c).trim().split('\n').join('\n> '));
        L.push('');
      }
    }

    L.push('**What changed**');
    L.push('');
    L.push(t.changeSummary ? t.changeSummary.trim() : '_(no change summary produced)_');
    L.push('');

    L.push('**Verification evidence**');
    L.push('');
    if (t.verification) {
      L.push(`- Acceptance: **${t.verification.acceptance || 'n/a'}**`);
      L.push(`- Regressions: **${t.verification.regressions || 'n/a'}**`);
      if (t.verification.evidence) {
        L.push('');
        L.push('```');
        L.push(String(t.verification.evidence).trim());
        L.push('```');
      }
    } else {
      L.push('- _(no verifier evidence collected)_');
    }
    L.push('');

    if (t.stuckState) {
      L.push('**Stuck state**');
      L.push('');
      L.push(t.stuckState.trim());
      L.push('');
    }
    if (t.attemptNotes && t.attemptNotes.length) {
      L.push('**Attempt notes**');
      L.push('');
      L.push('```');
      for (const n of t.attemptNotes) L.push(n.trim());
      L.push('```');
      L.push('');
    }
    if (t.error) {
      L.push(`**Error:** ${t.error}`);
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('_Generated from the run manifest and git. Regenerating produces an identical file; never edit by hand._');
  L.push('');
  return L.join('\n');
}

function writeReport(runDir, manifest) {
  const file = path.join(runDir, 'report.md');
  fs.writeFileSync(file, renderReport(manifest));
  return file;
}

module.exports = { writeManifest, writeReport, renderReport, byScrutiny };
