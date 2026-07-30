#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The freeze gate's control (DESIGN.md §3.2, "Below the panel", move 1).
//
// One trivially-passing test whose only job is to answer a single question:
// CAN THE VERIFY COMMAND REPORT SUCCESS AT ALL RIGHT NOW?
//
// `scripts/freeze-gate.js` requires a spec's new tests to be RED before the freeze, because a
// test green before its implementation exists is satisfied by an empty diff. But a suite that
// cannot LOAD exits non-zero exactly like a genuine assertion failure, so red on its own
// proves nothing — this repo has already shipped a suite that could not execute its own stub
// and reported every check as a real failure. The gate therefore runs the verify command
// twice: once against the tests under review, and once against this directory. Only
// `real red + control green` is genuine red.
//
// It must not test anything. Anything it asserted could break for a reason unrelated to the
// harness, and a control that can fail for its own reasons is not a control.
//
// An EMPTY directory cannot do this job, which is how this file came to exist: a good runner
// is supposed to fail on "no test files found" — silently passing on zero tests is the
// vacuous success the gate exists to prevent — so an empty probe fails on exactly the
// well-built runners the gate most needs to work with. `tools/run-acceptance.sh` is one.
//
// This file lives under tests/acceptance/, so the verifier's tamper check covers it and no
// task can edit it during a run. That is correct: it is part of the judging apparatus.
process.exit(0);
