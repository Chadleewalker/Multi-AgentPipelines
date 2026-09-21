// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Stable, enumerable control-plane policy lives in one machine-readable contract.
// Algorithms stay in their owning modules; those modules import values from here rather
// than keeping prose-adjacent copies that can drift independently.
'use strict';

const contract = require('../contracts/control-plane.json');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

if (contract.version !== 1) {
  throw new Error(`unsupported control-plane contract version: ${contract.version}`);
}

module.exports = deepFreeze(contract);
