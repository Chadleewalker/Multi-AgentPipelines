# Frozen acceptance tests — repo-kfg: `scripts/dashboard.js` and the frozen `/state` contract

Spec: `docs/planning-draft-2026-08-10.md`, Task 2 (design-ref `DESIGN.md` §5, change-log
row `live-dashboard`). One file, `test.js`, run by
`sh tools/run-acceptance.sh tests/acceptance/repo-kfg/`. Written before the
implementation exists: today it fails feature-shaped (`scripts/dashboard.js does not
exist`) and exits non-zero; it goes green only when the reader, its wrapper suite and
the unit suite all land.

All fixtures live under a throwaway temp root; every host is `example.invalid`; every
id and title is invented; timestamps are computed from the clock at run time. Held lock
records are minted at test time (this process's pid, fresh `takenAtMs`/`uptimeSeconds`,
`procStart: null`) so the dashboard's inline liveness copy sees a live holder; the stale
fixture uses the pre-reboot `takenAtMs` falsifier. Nothing is `require`d from repo code —
the canonical-path fold, the lock-record shape and the `run.log` line shape are inlined.

## Criterion → checks

| Done means | Checks (label prefix) | What they pin |
|---|---|---|
| 1. Two-project joins, every Description feature asserted | `C1 …` | Live project A: held lock minted at test time joins its manifest-less run **by the lock's `runId`** (a newer decoy dir loses); em-dash title verbatim; live workspace `phase: "verify"`, `attempt` 1, `attemptResults ["fail"]`, `lastWrite` = status mtime ISO; parked task with `pauses` 1; refused task; `park` open/1 cycle/`until` from the pinned reset line; queued id in `run.queued`; the type-skipped id and the `preflight` pseudo-task are not rows. Idle project B: keyed by the manifest URL, `name` strips `.git`, `concurrency: 4` asserted (never the default), `prUrl`/`branch`/`attempt` 2/`pauses` 0/`activeSeconds`/`finishedAt` from the manifest, `attemptResults ["fail","pass"]` from the collected task status. Trailing-separator and `./`-segment spellings fold to one canonical key. Run-dir predicate: plain file, hollow dir, `locks`, `sweeps` produce no project. Byte-wise sorts. |
| 2. Frozen shape, deterministic, fresh | `C2 …` | Two calls byte-identical except `now`; whitelist key compare at every level of the frozen contract (an added key fails loudly); in-place LF→CRLF rewrite of `run.log` changes nothing; an appended `task finished` line is visible on the very next request (no startup cache). |
| 3. Named degraded states at their pinned level, never a 500 | `C3 …` | Planted one at a time, as unparseable bytes or a directory where a file belongs (never chmod): log-but-no-manifest; unparseable manifest; array manifest; unparseable status; status.json as a directory; missing status; vanished workspace; no `workspace ready:` line; unparseable lock; stale lock (pre-boot `takenAtMs`); live lock naming a runId with no directory; status without `phase`; `phase: "review"` → `phase-unknown` while the rest of the file is still read; orphan run dir → `unknown:<runDirName>` + `target-unknown`; missing `runs/locks/` is ordinary (own root + server, no degraded marker). Each: HTTP 200, the named term at the pinned level, surrounding fields present-but-null, stale ⇒ `live: false`, the other project renders completely. `/proc`-gated: a deliberately wrong `procStart` renders `stale` where `/proc/self/stat` exists, named non-`ok - ` skip elsewhere. |
| 4. The server contract | `C4 …` | Scrubbed child env (no `NODE_OPTIONS`/`NODE_DEBUG`/inherited `DASHBOARD_*`; `HOME`/`TMPDIR`/`TEMP`/`TMP` at dedicated dirs); `DASHBOARD_PORT=0` announces exactly one stdout line over the server's whole life; `GET /` 200 `text/html` with the scheme-level self-containment checks (no `://`, `src=`, `@import`; every `href` starts `#`); `/state` `application/json` + `Cache-Control: no-store`; the four pinned paths 404 with the exact body `not found\n`; loopback two legs (`/proc/net/tcp*` listener address where it exists, else named skip; TCP connects to every non-loopback interface and `[::1]` must not succeed — any error is a pass); taken-port drive binds `:0` itself, expects exit 1, one `dashboard: ` stderr line, no `/^\s+at /`. |
| 5. Pure reader, proved both ways, from anywhere | `C5 …` | Source scan: every `require` (with `node:` stripped) in node's builtin list, no `child_process` token. Behavioural: path+content-hash snapshots of the fixture root, `scripts/`, the dedicated HOME/TMP dirs and the empty cwd, bracketing a child that serves `GET /`, three `/state`, one 404 and **exits** before the after-snapshot; every dedicated dir still empty. `/state` identical from two cwds with `now` held out. A copied script over its own repo-shaped root proves the default root resolves from the script location (and that blank `DASHBOARD_RUNS_DIR` = unset). |
| 6. The suite exists, counts, and is swept | `C6 …` | `scripts/test-dashboard.sh` and `tests/unit/dashboard.test.js` exist; the wrapper invoked via `sh` with `DASHBOARD_RUNS_DIR=/nonexistent` and `DASHBOARD_PORT=1` exported exits 0; at least 35 `^ok - ` lines and zero `FAIL` lines, counted by this test itself (a `node --test` harness would print a shape this count rejects). The wrapper's name matches the sweep's `scripts/test-*.sh` glob by existing at that path. |

Failure shape today: `FAIL - scripts/dashboard.js does not exist …` plus one
feature-shaped `FAIL` per dependent criterion and the two `C6` existence failures —
no unhandled exceptions, no hangs (every server wait has a 10s timer, the whole suite a
540s watchdog).
