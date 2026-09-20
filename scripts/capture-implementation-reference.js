#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs = require('fs');
const path = require('path');
const reference = require('../runner/implementation-reference');
function main(argv) {
  const opts = {};
  const keys = { '--target': 'target', '--issue': 'issue', '--probe': 'probePath', '--candidate-hash': 'candidateHash', '--output': 'output' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1] || opts[keys[argv[i]]]) throw new Error('expected --target --issue --probe --candidate-hash --output, once each');
    opts[keys[argv[i]]] = argv[i + 1];
  }
  if (Object.keys(opts).length !== 5) throw new Error('all five capture options are required');
  const output = path.resolve(opts.output);
  // Require an existing, unlinked output parent; lexical containment alone misses junctions.
  let current = path.dirname(output);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('capture output parent must be an unlinked directory');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolvedOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const rel = path.relative(fs.realpathSync(opts.target), resolvedOutput);
  if (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) throw new Error('capture output must be outside the target checkout');
  const made = reference.capture(opts);
  fs.writeFileSync(output, made.bytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ path: output, hash: made.hash, issue: made.value.issue })}\n`);
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; } }
module.exports = { main };
