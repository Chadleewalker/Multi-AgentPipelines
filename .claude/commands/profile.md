---
description: Interview me and write my user profile — how agents should pitch things to me
---

Set up this person's **user profile**: the once-per-person file that tells an agent how to
pitch what it writes to them. Design: `DESIGN.md` §6.1, change-log row `user-profile`.

Read `docs/user-profile.example.md` first. It carries the interview you are about to run —
the marker lines, the two reasoning questions, the calibrated samples and the template.
Follow it; do not invent your own questions.

## Before you start

Check whether `~/.claude/CLAUDE.md` already exists.

- **It does, and it already names a rung** — say so, show them the rung line, and ask
  whether they want to redo the interview or adjust one thing. Do not overwrite a working
  profile because a command was run.
- **It does, but it is not a profile** (or has no rung) — say what is there, and offer to
  add the profile sections without disturbing the rest.
- **It does not exist** — run the interview.

Also check whether that path is a copy managed by something else — a header comment saying
so, or a `SessionStart` hook in `~/.claude/settings.json` that copies a file into place. If
it is, **edit the source, not the copy**, and say which file you edited. A profile written
to a managed copy is silently overwritten at the next session start, which is the exact
invisible failure this whole feature exists to prevent.

## Running the interview

Three steps, and **one step per message**. Do not paste all the questions at once — the
answers to step 1 change which samples step 3 shows.

1. **Marker terms.** Ask which lines they can *explain to someone else*. Never ask where
   they stopped.
2. **Two reasoning questions.** Both carry no software vocabulary. If they answer both and
   step 1 stopped at line B or earlier, that is rung 3 — high systems fluency with low
   software vocabulary, the combination a single "how technical" scale gets wrong.
3. **Read and pick.** Show the sample at the suggested rung plus the rung either side. This
   step outranks the other two. If they say a sample confused them, work out whether it was
   the writing or the subject — if the subject, the sample is at fault, not the reader.

Then close: if it is a near call, take the lower rung, and say why — one rung too low costs
a slightly longer answer, one rung too high costs a decision made on something they did not
follow, and they will not know it happened.

## Writing it

Draft the file from the template at the end of `docs/user-profile.example.md`, filling in
the rung line, the fluency description, and the sections on checking in and standing
defaults from what they tell you. Ask about those two sections directly — they are the most
consequential parts after the rung and the interview does not cover them.

**Show them the whole file before you write it.** Then write it, say exactly which path you
wrote, and tell them it takes effect in their next session.

Last, tell them two things they will need later:

- They can override the rung mid-conversation — "give me that at rung 2" — and it re-pitches
  on the spot. The file sets the default, not the session.
- If they keep overriding in the same direction, the rung line is wrong and should be
  edited. That is the signal, and nothing else will produce it: nothing anywhere enforces a
  profile, so noticing is the only feedback loop there is.
