#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Reset-time parser (§4.7). Reads an agent log on stdin and, when the current Claude
// CLI reports a usage limit as a bare wall-clock time — "You've hit your session limit ·
// resets 7:20pm (UTC)" — prints a future time on today's UTC date as an ISO-8601
// timestamp. entrypoint.sh feeds the result to `status.js set rateLimitResetAt`, which
// the runner waits on (runner/pause.js waitPlan). Prints nothing when no time is found,
// which is the signal to fall back to probing — so this must NEVER guess.
//
// Deliberate scope:
//   * ONLY the "(UTC)"-qualified form is parsed. A time with no zone is ambiguous by up
//     to 24h; reporting a wrong reset is worse than probing, so an un-zoned time yields
//     nothing and the prober takes over.
//   * No date is given. A time at or before `now` could be a just-elapsed reset or a
//     reset tomorrow. Return nothing and probe rather than inventing a 24-hour wait.
//     This also handles midnight resets: probing observes the window reopening.
'use strict';

// Exposed for tests: pure given (text, now). now is a Date; defaults to real time.
function resolveReset(text, now = new Date()) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // "resets 7:20pm (UTC)" / "resets 11pm (UTC)" / "resets 7:20 pm (utc)". Minutes optional.
  const m = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(utc\)/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null; // 12-hour clock only

  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  // Trust only a future time on today's UTC date; the message cannot prove tomorrow.
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  if (candidate.getTime() <= now.getTime()) return null;
  return candidate.toISOString();
}

module.exports = { resolveReset };

// CLI: read stdin, print the ISO reset (or nothing).
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const iso = resolveReset(input);
    if (iso) process.stdout.write(iso + '\n');
  });
}
