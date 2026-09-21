// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Runtime validation for the two container-to-host contract artifacts.
//
// The runner deliberately has no npm/runtime dependency: it must work on a freshly cloned
// host and inside the closed-network self-test. These schemas use a small, explicit subset
// of JSON Schema 2020-12, implemented here and pinned by adversarial tests. Unknown schema
// decoration is ignored; every assertion keyword present in status.schema.json and
// verify.schema.json is enforced.
'use strict';

const STATUS_SCHEMA = require('../schemas/status.schema.json');
const VERIFY_SCHEMA = require('../schemas/verify.schema.json');

const SCHEMAS = { status: STATUS_SCHEMA, verify: VERIFY_SCHEMA };
const MAX_ERRORS = 20;

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function dateTime(value) {
  // RFC3339 shape plus a real calendar instant. Date.parse alone admits date-only and other
  // implementation-specific forms; the schema says date-time, so those fail closed.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const y = Number(year); const mo = Number(month); const d = Number(day);
  if (mo < 1 || mo > 12 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(y, mo, 0);
  if (d < 1 || d > calendar.getUTCDate()) return false;
  if (sign && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function addError(errors, path, rule) {
  if (errors.length < MAX_ERRORS) errors.push(`${path}: ${rule}`);
}

function validateNode(schema, value, at, errors) {
  if (!schema || typeof schema !== 'object' || errors.length >= MAX_ERRORS) return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      addError(errors, at, `must be ${types.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    addError(errors, at, 'must be an allowed enum value');
    return;
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      addError(errors, at, `must have length >= ${schema.minLength}`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      addError(errors, at, `must have length <= ${schema.maxLength}`);
    }
    if (schema.format === 'date-time' && !dateTime(value)) {
      addError(errors, at, 'must be an RFC3339 date-time');
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      addError(errors, at, `must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      addError(errors, at, `must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      addError(errors, at, `must contain >= ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      addError(errors, at, `must contain <= ${schema.maxItems} item(s)`);
    }
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${at}/${index}`, errors));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties : {};
    for (const key of (schema.required || [])) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) addError(errors, `${at}/${key}`, 'is required');
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) addError(errors, `${at}/${key}`, 'is not allowed');
      } else {
        validateNode(properties[key], child, `${at}/${key}`, errors);
      }
    }
  }
}

function validateValue(schema, value) {
  const errors = [];
  validateNode(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

function parseArtifact(kind, raw, expectedIssueId) {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, state: 'unknown-contract', errors: ['$: unknown artifact contract'], value: null };
  if (raw === null || raw === undefined) return { ok: false, state: 'missing', errors: [], value: null };

  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return { ok: false, state: 'malformed', errors: [], value: null };
  }
  const checked = validateValue(schema, value);
  if (!checked.ok) return { ok: false, state: 'schema-invalid', errors: checked.errors, value: null };
  if (typeof expectedIssueId === 'string' && value.issueId !== expectedIssueId) {
    return { ok: false, state: 'issue-mismatch', errors: ['$/issueId: does not match the claimed task'], value: null };
  }
  return { ok: true, state: 'valid', errors: [], value };
}

// Only exit 0 can become done/partial and close an issue. Every other exit already maps to
// a non-success state, so malformed diagnostic artifacts must not relabel it. This function
// is the final success discriminator used by runOneTask before outcomeFor().
function successfulArtifactFailure(exitCode, contracts) {
  if (Number(exitCode) !== 0) return null;
  const status = contracts && contracts.status;
  const verify = contracts && contracts.verify;
  const failures = [];
  if (!status || !status.ok) failures.push(`status artifact ${status ? status.state : 'missing'}`);
  if (!verify || !verify.ok) failures.push(`verification artifact ${verify ? verify.state : 'missing'}`);
  else if (!verify.value || verify.value.acceptance !== 'pass') {
    failures.push('verification acceptance is not pass');
  }
  return failures.length ? `artifact contract failure: ${failures.join('; ')}` : null;
}

module.exports = {
  validateValue,
  parseArtifact,
  successfulArtifactFailure,
  SCHEMAS,
  MAX_ERRORS,
};
