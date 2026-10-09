// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Portable tee to stdout and stderr: no /dev/stderr dependency under Git Bash.
// Wait for both writes before accepting another chunk, keeping captured logs bounded.
'use strict';
const { Writable, pipeline } = require('stream');
const destinations = [process.stdout, process.stderr];
// Writable callbacks report these errors to pipeline; avoid an unhandled error event.
for (const destination of destinations) destination.on('error', () => {});
const copier = new Writable({
  write(chunk, encoding, callback) {
    let pending = destinations.length;
    let failure;
    for (const destination of destinations) {
      destination.write(chunk, (error) => {
        failure ||= error;
        if (--pending === 0) callback(failure);
      });
    }
  },
});
pipeline(process.stdin, copier, (error) => {
  if (error) {
    console.error(`progress copy failed: ${error.message}`);
    process.exitCode = 1;
  }
});
