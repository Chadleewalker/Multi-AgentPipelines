# Running several agent sessions on one project

**One folder per session. Never two sessions in one folder.**

This is the working guide. The design record is `DESIGN.md` §6.2; the tool is
`scripts/worktree.js`; the tool's own checks are `scripts/test-worktree.sh`.

---

## 1. Why this exists

If you open three agent sessions and point all three at `C:\Code\Projects\MyProject`, they
are not three workspaces. They are three agents typing into **one** set of files with
**one** staging area between them.

What that costs, in the order it tends to happen:

- Session B runs `git add -A` and commits. Git stages *the folder*, not *B's work* — so
  session A's four half-finished files go into B's commit, under B's message about
  something else. Nothing is lost, but the history now says something untrue, and the next
  person to read it (including a future agent) is misled.
- Session C runs `git checkout -- some/file.gd` to test a hunch. That command means "throw
  away the edits to this file". A's uncommitted work in that file is gone, with no
  recovery — it was never committed, so git never had a copy.
- Two sessions edit the same file seconds apart. The second write wins silently. Neither
  agent sees a conflict, because there is no merge — it is one file on one disk.

The first two have already happened here. The fix is not "be careful"; careful is what
fails at 11pm on the fourth session. The fix is to make the collision **impossible**.

## 2. What a worktree is

Git can keep **one history** while checking it out into **several folders at once**, each
folder on its own branch. Each folder has its own files and its own staging area. They
share commits, branches and tags.

```
C:\Code\Projects\
    MyProject\                  <- the main checkout. Shared history lives here.
    MyProject-flight-tuning\    <- session A. Branch: flight-tuning
    MyProject-save-format\      <- session B. Branch: save-format
```

Session A cannot see, stage, commit or delete session B's files, because they are not in
its folder. `git add -A` in A stages A's folder and nothing else. `git checkout --` in A
reaches A's copy and nothing else. Both were verified rather than assumed —
`scripts/test-worktree.sh` runs exactly those two commands across two worktrees and checks
that neither reaches the other.

It is **not** a second clone. There is one `.git`, one history, one set of branches. A
commit made in A is immediately visible to B as a commit on A's branch. Disk cost is one
extra copy of the working files, not of the history.

## 3. Start a session

From the main checkout:

```bash
node scripts/worktree.js new flight-tuning
```

Name it after **the idea**, not the date or the agent. That name becomes both the folder
name and the branch name, so it is what you will see in `git log`, in the PR list, and in
the folder picker at 11pm.

It prints the folder it made. **Open your agent session with that folder as its working
directory** — that is the whole point; an agent started in the main checkout is back to the
original problem.

Options you will rarely need:

| Flag | What it does |
|---|---|
| `--from <branch>` | Branch from something other than the project's default branch. Needed only if the tool cannot work the default out, in which case it says so rather than guessing. |
| `--root <dir>` | Put the folder somewhere other than beside the main checkout. |

## 4. Work in it

Normally. It is an ordinary checkout of the project.

Two things are different, and both are consequences of the folder being new:

- **The agent will re-ask for permissions.** Claude Code keeps per-folder approvals in
  `.claude/settings.local.json`, which is git-ignored and therefore not in a new worktree.
  Expect a burst of prompts on the first run and none after.
- **Build caches and installed packages are not there.** They are git-ignored, so git does
  not check them out. Whatever your project does on a cold checkout — `npm install`, a
  first-run asset import, a compile — it will do once in each new worktree. See §7.

## 5. Get the work back

Unchanged from how it works today, and deliberately so:

```bash
git push -u origin flight-tuning     # from inside the worktree
gh pr create                         # or open it in the browser
```

**You merge. The agent never does.** A PR is the handoff boundary — it is the point where
you see what the session actually did before it becomes part of the project. That rule
predates worktrees and worktrees do not relax it.

For this repo specifically, there is a second reason to merge promptly: a task's frozen
acceptance tests must be on the branch the pipeline's containers fork from, or the dispatch
gate refuses to dispatch that task (`DESIGN.md` §4.12). A spec frozen on an unmerged
worktree branch is invisible to a run. Freeze, PR, merge, *then* run — or, if a run is
already going and feeding is on, push the branch and the running batch will pick it up at
the next free worker.

## 6. Close a session down

```bash
node scripts/worktree.js list        # what is open, and what still holds work
node scripts/worktree.js remove flight-tuning
```

`remove` **refuses** while the folder still holds anything: uncommitted changes, untracked
files, or commits that exist on no remote. It names what it found. That refusal is the
feature — it is the same protection as everything else here, pointed at the tidying-up step,
which is when work is most likely to be thrown away by accident.

`--force` overrides it and destroys the work. There is no undo.

**The branch outlives the folder.** Removing the worktree does not delete the branch, and
the tool says so. Deleting a branch is a separate, irreversible act and belongs to whoever
merged the PR.

---

## 7. What is shared, what is copied, what you must not copy

A worktree checks out **tracked files only**. Anything git-ignored — every local config,
every secret, every build cache — is simply absent from a new one. Below is what that means
in practice, all of it verified on this machine rather than reasoned about.

### Shared automatically, nothing to do

| Thing | Why it is fine |
|---|---|
| Commits, branches, tags, remotes | One `.git`. That is what a worktree is. |
| **The Beads issue database** | **Verified.** Beads finds its database through git's *common directory*, so every worktree reads and writes the **one** database in the main checkout. `bd count` returns the same number from a worktree and from the main checkout, and running `bd` in a worktree creates no second database there. This is the answer to the question that mattered most: N worktrees do **not** mean N issue queues, so the work queue cannot fork the way the code does. `bd worktree info` will tell you what a given folder resolved to. |

That Beads result also means the reverse: two sessions writing issues at the same moment
are writing to the same database, and Beads serialises them with its own lock files. That
concurrency already happens today under the operator/working-session split, and change-log
row `live-queue-feed` records it being sized and dismissed on the evidence. Worktrees do
not add to it.

### Absent from a new worktree — copy if the session needs it

Verified by listing both folders: present in the main checkout, absent in a fresh worktree.

| Path | What it is | Carry it? |
|---|---|---|
| `.env.pipeline` | the Claude subscription token | only for a session that launches runs — and those belong in the main checkout anyway |
| `run.config.*.json` | per-project runner config | same |
| `.sanitize-denylist` | the host-only publication denylist | **yes** — without it `scripts/test-sanitize.sh` skips its project-specific checks and passes something it should have caught |
| `docs/user-profile.md` | your profile | not needed; the live copy is at `~/.claude/CLAUDE.md` |
| `.claude/settings.local.json` | per-folder tool approvals | no — let it rebuild, or you inherit approvals granted for different work |
| `tools/mapbuild/node_modules` | the mermaid renderer, **388 MB** | **no.** Redraw the reader's map from the main checkout instead. |

Declare what to copy in a file called **`.worktree-carry`** at the repo root — one path per
line, `#` for comments. `scripts/worktree.js new` copies each one and reports what it
carried, what was missing, and what it refused. See `.worktree-carry.example`.

### Never copy

| Path | Why |
|---|---|
| **`runs/`** | It holds the per-project run **lock** (`runs/locks/`, `DESIGN.md` §4.12), which is what makes "one run per project" true. A second copy is a second lock, and two runners can then drain one queue at once. `scripts/worktree.js` refuses this entry by name and prints the reason; it is not a matter of remembering. |

**Consequence, and it is a rule, not a preference: launch pipeline runs from the main
checkout only.** Not just because of the lock — `runs/` is also where every report, manifest
and artifact lands, so a run launched from a worktree writes its history into a folder that
`verdict.js`, `batch.js`, `audit-runs.js` and the dashboard will never look in. The run
would work and its results would be invisible.

This lines up with how you already work: the **operator** session lives in the main
checkout and launches things; **working** sessions live in worktrees and never do.

### The category to check on any new project

The four above are this repo's instances of three general categories. On a project that is
not this one, walk the same three:

1. **Build or import caches** — `node_modules/`, `.godot/`, `target/`, `__pycache__`,
   `.gradle/`. Git-ignored, so absent, so rebuilt once per worktree. The question is only
   *how long that takes*, and the answer is a property of the project, not of worktrees.
   Measure it once, write the number in the project's own CLAUDE.md, and if it is
   genuinely painful, add it to `.worktree-carry` — a stale cache that gets rebuilt is
   cheap; a 388 MB copy per session is not.
2. **Host-only config and secrets** — anything git-ignored that the project needs to
   *run*. These are the ones that fail confusingly ten minutes in rather than immediately.
   List them in `.worktree-carry`.
3. **Anything enforcing "only one of these at a time"** — a lock file, a PID file, a port
   file, a local database. Ask whether the tool finds it via the *repository* (safe to
   share, like Beads) or via the *current folder* (duplicated, and the guarantee it
   provides quietly stops holding). This is the category that bites, and it never announces
   itself.

Environment variables — a `GODOT` pointing at an engine binary, a `JAVA_HOME` — are a
non-issue: they belong to the shell, not the folder, and an absolute path works from any
worktree.

---

## 8. The rules that make this hold

These are in `CLAUDE.md` so every agent session reads them. They are short because they
have to survive being followed at speed:

- Stage **named paths**. Never `git add -A`, `git add .`, or `git commit -a`.
- Never run a command that discards work you did not write: `git checkout --`,
  `git restore`, `git stash`, `git reset --hard`, `git clean`.
- If `git status` shows changes you did not make, **stop and report**. Do not commit them,
  revert them, or move them.

Worktrees make the *blast radius* of breaking these rules your own folder instead of
someone else's. That is a large improvement and it is not a licence — inside one folder,
`git add -A` will still sweep up whatever you left half-done an hour ago.
