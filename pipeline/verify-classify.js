#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The verifier's one judgment call, alone in a file so it can be tested without running
// the verifier — the `scripts/sweep-reclaim.js` precedent (the caller renders, it does not
// decide). Change-log row `verify-nobuffer`; STATUS defect 12.
//
// The rule: **no verdict is never a failure.**
//
// `spawnSync` reports `status === null` whenever the child was killed rather than exiting
// on its own terms — the output cap (ENOBUFS), the timeout (ETIMEDOUT), or any signal. In
// none of those cases did the suite reach an opinion about the code, so recording 'fail'
// is a statement the run cannot support. That is not a hypothetical: it is how
// a real task's first attempt was told its correct work was wrong, on 1,058,241
// bytes of output with every test green.
//
// Note which direction this can move an outcome. A real nonzero exit is still 'fail', so
// nothing here can turn a failing suite into a passing one — only a killed one into a
// named error. Hard rule 2 is intact: verification is not weakened, it is made to be
// about the code again.
'use strict';

// Node's spawnSync default is 1 MiB. 64 MiB is far past any real suite (the run that
// found the defect printed 1.01 MiB) while staying bounded — "no cap" would trade a
// false failure for an OOM inside the container, which is the same bug with a worse
// symptom.
const MAX_BUFFER = 64 * 1024 * 1024;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

// `res` is a spawnSync result. Returns { verdict: 'pass'|'fail'|'error', why? }.
// `why` is present iff verdict==='error' and always names the limit that was hit, because
// the artifact a human reads at 2 AM is otherwise a log stopping mid-sentence.
function classify(res, opts) {
  const maxBuffer = (opts && opts.maxBuffer) || MAX_BUFFER;
  const timeoutMs = (opts && opts.timeoutMs) || RUN_TIMEOUT_MS;
  if (!res || typeof res !== 'object') {
    return { verdict: 'error', why: 'produced no result object at all' };
  }
  if (res.status === 0) return { verdict: 'pass' };
  if (typeof res.status === 'number') return { verdict: 'fail' };

  const code = (res.error && res.error.code) || '';
  let why;
  if (code === 'ENOBUFS') {
    why = `output exceeded the ${Math.round(maxBuffer / (1024 * 1024))} MiB capture limit`;
  } else if (code === 'ETIMEDOUT') {
    why = `did not finish within ${Math.round(timeoutMs / 60000)} minutes`;
  } else {
    why = `was killed before it reached a verdict${res.signal ? ` (signal ${res.signal})` : ''}`;
  }
  return { verdict: 'error', why: `${why}${code ? ` [${code}]` : ''}` };
}

module.exports = { classify, MAX_BUFFER, RUN_TIMEOUT_MS };
