#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const policy = require('./write-protection-policy');

function main() {
  try {
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = policy.decide(request);
    if (!result || !['allow', 'deny'].includes(result.decision)) throw new Error('invalid decision');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.decision === 'allow' ? 0 : 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: 'host guard unavailable or request invalid' })}\n`);
    return 2;
  }
}

if (require.main === module) process.exit(main());
module.exports = { main };
