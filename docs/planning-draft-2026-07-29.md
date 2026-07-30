# Planning draft — 2026-07-29

Two tasks that let more than one project run through the pipeline at the same time.
Approved, critiqued and frozen as issues `repo-jur` and `repo-os9`.

**Superseded by those issues** — they are the canonical spec from the freeze onward.
Delete this file once the tasks have run.

---

## The problem, plainly

Each project already keeps its own work queue: the Beads database lives inside the target
repo (`bd -C <targetRepoPath>` in `runner/bd.js`), and syncs over that project's own git
remote. Nothing about the issues is shared.

What *is* shared is the Docker plumbing. Every run uses one network called `pipeline-net`
and one proxy container called `pipeline-proxy` — the container's only route to Anthropic.
Those two names are constants in `scripts/pipeline-net.sh`, and the same constants appear
again in `scripts/egress-check.sh`. So:

- Starting a second run destroys the first run's proxy. `up()` does an unconditional
  `docker rm -f pipeline-proxy` before recreating it.
- Finishing either run tears down the network and proxy for both. `runner/run.js` calls
  `networkDown()` at the end of every run.

Neither failure announces itself. The surviving run just loses its network, and the agent
inside it starts failing for reasons that look like the model's fault.

The `network`, `proxyName` and `proxyPort` fields already in `run.config.*.json` look like
they solve this, but they only reach the task container (`runner/container.js`). The two
scripts that actually create and destroy the network ignore them entirely.

**This is not the parallelism item in DESIGN.md §7** (change-log row `parallelism-v2`).
That one is about one runner working several tasks of *one* project at once, and it stays
out of scope. This is several independent runner processes, one per project, each still a
sequential loop over its own queue.

---

## Task A — `repo-jur` — per-project network and proxy

**Difficulty:** medium · **design-ref:** DESIGN.md §4.8, §4.12 · **Depends on:** nothing

Names come from the run config. When the config names none, the runner derives them from
the config file's own name rather than falling back to a shared constant — a default that
collides silently is the bug being fixed, so reinstating it as a fallback would
reintroduce it. An explicit `network` / `proxyName` still wins.

### Done means

1. Two runs against different projects can be in flight at once, and neither one's network
   or proxy is created, destroyed or restarted by the other.
2. A config naming no network derives both names from the project segment of its own file
   name: identical in every process that loads it (never pid-, clock- or random-derived),
   and legal both as a Docker object and as a hostname — the proxy name is the host part
   of the container's `HTTPS_PROXY`. Two projects that both say nothing still get
   different networks. A config named exactly `run.config.json` keeps today's shared
   defaults, so **running two projects at once requires each config to be named
   `run.config.<project>.json`**.
3. An explicit network and proxy are the names that actually reach the two scripts — not
   merely what `loadConfig` returns.
4. The egress gate is aimed at the run's own network, proxy and port, and a gate that
   exits non-zero still aborts the run. That the allowlist itself holds stays proven by
   the host Docker suites.
5. `run.log` names the run's own network and proxy exactly, where the run brings them up,
   and names no default.
6. With no override the scripts emit exactly today's names, image tag and proxy URL.
7. The proxy image tag stays shared across projects.

### Constraints

- Suites keep today's names: ~12 hard-code them in cleanup traps, so the scripts must
  default to them when given no override.
- The proxy image tag (`pipeline-proxy:local`) stays shared — only the running container
  and the network are per-project.
- No change to what the proxy allows. Names move, policy does not.
- No new dependencies; acceptance tests must be Docker-free.

---

## Task B — `repo-os9` — refuse a second run against the same project

**Difficulty:** medium · **design-ref:** DESIGN.md §4.12 · **Depends on:** `repo-jur`

Task A makes different projects independent. It does nothing about starting the *same*
project twice, which afterwards is the remaining way to corrupt a run. Two runners
draining one queue is worse than a network clash: both ask Beads for ready work, both can
claim the same issue, both push a branch for it.

### Done means

1. Starting a run while another live run holds the same project exits non-zero, with
   `run.log` naming both the project and the run that holds the lock, before the Docker
   gate is reached.
2. That refusal starts no network, runs no egress check, writes nothing to Beads, and
   leaves the holder's lock intact.
3. Two runs against different projects both proceed; conversely the same project reached
   by a differently-spelled path is one project, not two.
4. A lock whose owner is gone is taken over, and the takeover names the run whose lock was
   seized.
5. A run that ends normally, or aborts at preflight, releases its lock. Operator stop is
   out of scope and covered by criterion 4 instead.
6. The lock is visible across processes, not just within one.

### Constraints

- A crashed run's lock must not block the machine forever, and the record must survive PID
  reuse — a recycled pid reads as alive, which would make a pid-only record permanent.
- Refusal is the first gate in preflight, ahead of the Docker probe.
- The lock lives under the pipeline repo's `runs/`, beside the sweep lock.
- No new dependencies; acceptance tests must be Docker-free.

---

## What the testability critic changed

Both tasks went through `advisors/testability.md` as independent fresh-context reviews.
Both returned `concerns`; a critic never gates, so these were decisions, not vetoes. What
was accepted:

- **A criterion that was green before any work started.** `repo-jur`'s "an explicit
  network is used verbatim" passes against the current code — `loadConfig` already carries
  those fields; the defect is that the scripts ignore them. Restated so only "the names
  reach the scripts" counts.
- **Determinism across processes, not just calls.** A name built from a pid, a clock or a
  random suffix satisfied the original wording, then breaks teardown: the `down` at run
  end computes a different name than the `up` did.
- **Hostname safety, not just Docker-name safety.** The proxy name becomes the host part
  of `HTTPS_PROXY` inside every task container — a name Docker accepts but DNS handles
  poorly fails where no Docker-free test can see it.
- **Two criteria that named outcomes no frozen test can reach.** "The existing suites pass
  unchanged" is a host-sweep obligation (`bash scripts/test-all.sh`), and "the allowlist is
  in force" needs real Docker. Both now say what the frozen test actually proves and where
  the real proof lives.
- **Two constraints with no criterion at all.** The shared proxy image tag now has one.
- **`repo-os9`'s criteria 2 and 4 contradicted each other** — "creates nothing" versus
  "recorded in `run.log`", when `startRun` creates the run folder before preflight. Now
  enumerated.
- **The dangerous input was missing.** "Two different projects both start" is satisfied by
  a lock keyed on a raw path string; the case that matters is the *same* repo spelled two
  ways, which on this host happens for real — configs write `targetRepoPath` with forward
  slashes while `path.join` produces backslashes.
- **PID reuse.** A record carrying only a pid can refuse to take over after a reboot,
  because a recycled pid reads as alive. Now a constraint.

Declined, and recorded as gaps rather than fixed:

- **Nothing gates that the lock is held for the whole task loop.** An implementation that
  acquires and releases inside preflight would pass every criterion, because reaching the
  loop needs Docker. The cross-process and real-runner checks cover the scope that matters.
- **The lock file's path is not pinned**, so its scope is proven by behaviour rather than
  by location.
- **Two projects that both use a bare `run.config.json` still collide.** Deriving a name
  for that case would break the runner suites that assert on `pipeline-net`. Criterion 2
  states the naming requirement; criterion 5's log line makes a collision visible on the
  first run.
- **Operator stop is not tested.** Node on Windows cannot catch a signal delivered to a
  spawned child, so that test could never pass in the host sweep.

---

## Sequencing

1. **Nothing runs until the run that is live as this is written finishes.** It holds
   `pipeline-net`; a sweep or a second run while it is up kills it.
2. Run `repo-jur`, merge it, then `repo-os9`.
3. **Manual step after `repo-jur` merges, which no agent can do for you:** the
   `run.config.*.json` files are git-ignored, so the task cannot edit them. Delete the
   `"network"` and `"proxyName"` lines from each. Until you do, they keep explicitly
   asking for the shared `pipeline-net` and will keep colliding — the fix is real but the
   configs override it. The runner logging its network name (criterion 5) is how you
   confirm it took effect.
4. Run `bash scripts/test-all.sh` after each merge. Criterion 6 is a promise about those
   suites that no frozen test can keep.

## What this does not fix

- **Capacity.** Two runs draw on the same subscription window, so they exhaust it about
  twice as fast and then both park. This buys elapsed time, not throughput.
- **Sweeps.** The suites still share one network and still cannot run concurrently with
  each other — but after `repo-jur` they no longer collide with *runs*.
- **Batched tasks colliding on files.** Unrelated, still open, still in `docs/STATUS.md`.
