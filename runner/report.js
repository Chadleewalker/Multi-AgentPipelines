// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Run manifest + run report — DESIGN.md §4.9, §4.12 (T17).
// The report is generated from the manifest + git, never hand-edited, and
// regeneration from the same inputs is byte-identical.
'use strict';
const fs = require('fs');
const path = require('path');

// Scrutiny order (§4.9): tampered > stuck > partial > failed > done-with-retries >
// done-first-try, ties broken by attempt count then diff size.
const RANK = { tampered: 0, stuck: 1, partial: 2, failed: 3, paused: 4, done: 5 };

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
};

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
  L.push('Ordered by how much scrutiny each item needs.');
  L.push('');

  for (const t of manifest.tasks) {
    L.push(`## ${t.issueId} — ${LABEL[t.outcome] || t.outcome}`);
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
