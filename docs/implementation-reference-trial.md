# Implementation reference trial

An explicitly selected successful managed proof can supply candidate code to the normal
implementation agent. It is untrusted reference data: code is never applied automatically,
and the normal model, frozen tests, regression checks, scans, publication and human PR review
remain required. No input means the existing prompt and execution path are unchanged.

Before human-approved freeze consumes the probe, inspect its candidate hash with the existing
`prove-tests --inspect-candidate` command, then capture outside the target checkout:

```
node scripts/capture-implementation-reference.js --target <target> --issue <id> --probe <managed-probe> --candidate-hash <inspected-hash> --output <new-external-file>
```

Capture reports an artifact SHA256. After ordinary human approval and freeze publication:

```
node runner/run.js --config <config> --implementation-reference <artifact> --implementation-reference-hash <artifact-sha256>
```

This narrow trial requires a fixed run with concurrency one and exactly the selected issue
in the admitted ready queue. It supports at most four modified existing regular UTF-8 product
files and a 256 KiB artifact; additions, deletions, renames, binary or mode changes are refused.
Only the selected suite's freeze may change integration after the original proof base. Its
published suite must match, and product bytes must still match the baseline.

New successful proofs record optional product provenance when bounded snapshots before and
after the gate agree. Snapshot failure or product changes during a gate do not change proof
outcomes; they make this optional reference unavailable. Historical proofs without a product
binding must be re-proven; existing successful candidate-reuse bindings remain usable.

The artifact is copied only into excluded `.run/implementation-reference.json`. The canonical
issue text stays unchanged. No alternate provider, agent command, receipt, authority, automatic
rebase, or production seed registry is introduced. The retained proof remains untouched until
normal freeze cleanup. A refusal launches no implementation model for the selected task.
The workspace log records only the reference hashes; the normal agent response reports whether
it used, adapted or rejected the candidate so a later trial can measure actual reuse.
