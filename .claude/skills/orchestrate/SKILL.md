---
name: orchestrate
description: Work this repo's queue (WeatherBaseline) as a dispatcher — one subagent per task, several at once when their paths are disjoint, and a pinned Ran / Running / Planned panel. Invoke as /orchestrate.
---

<!-- Generated from coo/templates/orchestrate-SKILL.md — every repo carries the
     same file, rendered for its own name. Do not edit it here: `coo/tools/tasks-tail
     propagate` rewrites it wholesale and refuses, for the whole fleet, any copy
     it does not recognise as a past rendering. A rule true of this repo alone
     goes in its CLAUDE.md, above `## Tasks`. -->

# Orchestrating

`CLAUDE.md` says what the words mean — whose queue this is, one task one agent, that the dispatcher prices what its workers file, that agents in one tree keep off each other. Read those there; they hold all day, not only during a pass. **This file is only how to execute one, and deliberately does not restate them.** It replaced the `drain` skill on 2026-09-10 (coo#81): there is one mode, and the pass works the queue as it stood when it started — what the pass itself files lands in `backlog` and waits for triage.

You are the dispatcher. You do not work an item yourself down one long thread; you read the board, split it into lanes, spawn a worker per task, watch them, and verify and commit what comes back.

## 1. Take your slice of the board

The queue's order, Status and Priority live on the project, not in the issues, so one read gets them:

```bash
/home/ita/coo/tools/board list --tsv | awk -F'\t' '$4 == "WeatherBaseline"'
```

That is 1 GraphQL point for the whole board, in project order. `--tsv` is: position, item id, type, **repo**, issue number, Status, Priority, Worker, Due, title — the count line goes to stderr, so it does not reach the filter. Yours is what `CLAUDE.md` says is yours — normally exactly those rows, and never another repo's.

Then drop, in this order:

- `Worker: ita` — skip.
- `Blocked` — skip; name the blocker in your footer and report. If it has since cleared, unblock it and work it.
- `Review` — skip; it is waiting on its named human. If no human is named, that is the bug: name one in the body and leave it there.
- `backlog` — skip. It is the shelf, not the queue; a triage pass promotes from it, an orchestration does not.

What survives is the pass, in project order. Read each survivor's body now (`gh api repos/theitush/WeatherBaseline/issues/$n -q .body` — REST; `gh issue view` is GraphQL), because the next step needs to know what files each one will touch.

## 2. Split it into lanes

Parallelism is the point of this skill, and it has two constraints: **the tree** and **the box**. A split that ignores either one ends the pass early — the first as a clobbered file, the second as a dead session.

### The tree

Two workers in one checkout are safe only when the files they will reach for are disjoint, so:

- Group the survivors by the paths their work will touch. Tasks whose paths are disjoint run **at the same time**, each in its own subagent. Tasks that share a path run **one after the other**, in project order, in one lane.
- Name the split in every brief: the paths that worker owns, and the paths it must not touch because another worker holds them.
- Where two tasks cannot be split by path and you still want both running, one of them gets `isolation: "worktree"`; its branch is merged when it reports — a merge, never a clobber.
- Run as many lanes as the split allows and no more than you can watch. Model per worker is the card's `Worker` column.

### The box

Lanes share one machine's RAM, and the kernel does not care whose work it kills. On 2026-09-15 four uncapped workers ran at once on this box, one python reached **20.3 GB** of its 24 GB, and the OOM killer took `init.scope` — the cgroup holding the whole Claude Code process tree — **four times**, killing every agent session on the machine twice over (inbar#253). ~9 GB was pushed to swap first, so the box was unusable long before anything died. Ita, that day: *"ORCHESTRATE SO DO THINGS SIMULTANEOUSLY IF THEY ACTUALLY FIT IN MEM"*. So:

- **Budget the box before you spawn.** `free -g` is what is free now; leave **~4 GB** to the OS and to the sessions themselves. What remains is the pass's budget, and the sum of the lanes' caps may not exceed it.
- **Every heavy job runs capped, in its own cgroup, and never in swap.** Heavy is anything whose footprint you cannot bound by eye — a backtest, a training run, a dataset read, a build, a full test suite, any ad-hoc script over a large file:

  ```bash
  systemd-run --user --scope -q -p MemoryMax=<N>G -p MemorySwapMax=0 -- <command>
  ```

  `MemorySwapMax=0` matters as much as the cap: without it the job thrashes the whole machine before its own cgroup reclaims. A capped job that overruns dies with 137 and takes **only itself**; an uncapped one takes every session on the box. (Verified on this box 2026-09-15: a 600 MB allocation under `MemoryMax=256M` was killed, the shell that launched it untouched.)
- **Size the cap from a measured peak, not an estimate.** Peaks live in the repo's own memory or an issue's result; where none is recorded, cap it at what you can afford and *measure it this run* — `/usr/bin/time -v <command>` prints `Maximum resident set size`, and the number goes into the result so the next dispatcher sizes from a fact.
- **Run everything that fits, and no more.** Lanes whose caps fit the budget together run at once; the rest queue behind them, in project order. Narrowing a pass below what the box can hold wastes the machine — the point is simultaneous, not serial.
- **A worker that hits its cap reports the number and never raises it.** A job needing more than its documented peak is news: it goes in the report and in the issue, and the dispatcher decides whether the pass still fits.

Write the plan down before spawning anything — one line per task, the ones you skipped included:

```bash
/home/ita/coo/tools/orchestrate-status plan <<'EOF'
WeatherBaseline#74 | CLEANUP: retire queue.json            | 2 | 20
WeatherBaseline#75 | RUN: re-measure board cost            | 2 | 20
WeatherBaseline#76 | BUG: sign drops the surname           | skip |  | Blocked on inbar#40
EOF
```

The columns are id, title, lane, your estimate in whole minutes, and a note; `skip` in the lane column is a task you saw and passed over, and the note is why. That file *is* the pass — it is what the panel renders and what §4's footer is printed from, so it is also what a reader compares the finished pass against. Re-run `plan` whenever the shape of the pass changes (a task added, a lane re-cut, an estimate you now know better): it re-orders and re-estimates, and it never un-runs anything that has already started or landed.

## 3. Spawn, watch, land

For each task, in this order:

```bash
n=<n>
/home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"        # before the spawn, so a crash leaves evidence
/home/ita/coo/tools/orchestrate-status start WeatherBaseline#$n --eta 20     # stamps the real start; the panel counts down from it
```

Then spawn its worker into this repo at the card's model with the issue body as context and this brief:

> You hold `WeatherBaseline#n` and nothing else. Sign it (`/home/ita/coo/tools/sign WeatherBaseline n <YourName>`) before the work. You own these paths: `…`; do not touch `…`, another worker holds them. Your memory budget is **`<N>` GB**: run anything heavy under `systemd-run --user --scope -q -p MemoryMax=<N>G -p MemorySwapMax=0 -- …`, never uncapped and never into swap, and report its peak (`/usr/bin/time -v`, `Maximum resident set size`) — if you hit the cap, report the number rather than raising it. Do the work, verify it (tests, build, a read of the diff — the result is a claim you are signing), file whatever the work did not reach as its own issue at `Status backlog` before this one closes, and finish it exactly one of three ways per `CLAUDE.md`: **Done** (result block below a `---` rule, close the issue, `Status Done`), **Review** (issue stays open, one-line `**Review:** <who> — <what> — <where>` as the body's first line, `Status Review`, commit says `Refs #n`), or **Blocked** (blocker in the body, issue open, `Status Blocked`). Report back: what you did, how you verified, where it landed, which issues you filed, and the exact paths you left uncommitted.

When a worker reports, before starting anything else in its lane:

1. Read its result against the issue — you are the one who verifies before anything reads Done; what you cannot verify by looking goes to `Review` with what and who in the body.
2. Stamp the finish, which measures the duration for you:

   ```bash
   /home/ita/coo/tools/orchestrate-status land WeatherBaseline#$n Done
   /home/ita/coo/tools/orchestrate-status land WeatherBaseline#$n Review  --note ita
   /home/ita/coo/tools/orchestrate-status land WeatherBaseline#$n Blocked --note "inbar#40"
   ```

   Exactly the three ways a task is allowed to finish. `--at HH:MM` is for when you notice a few minutes late; without it the clock is now.
3. Commit **by path** the paths its report names, and nothing else. Never `-A`: the tree is shared.
4. Start the next task in that lane.
5. Send a message: it ends with the footer, and the footer now carries this task's actual timing.

## 4. The panel, and the footer on every message

The three lists — what ran, what is running, what is planned — are one file now, written by the commands in §2 and §3 and rendered in two places.

**The panel** is the status line: Claude Code re-runs it on every assistant message and pins each line of its output to the bottom of the terminal. So the three headings sit in one place and stop scrolling away, which is what Ita asked for (coo#87): *"i just want to have the running, ran, planned in a fixed format that doesnt go anywhere instead of the text written at the end of every msg."* There is nothing to set up per pass — `plan` brings the panel up, §5's `clear` takes it down, and a session with no pass shows no headings at all.

**The footer stays, and stays whole.** Every message you send during a pass still ends with the block, whether it is the plan, a one-line update, a question, or the final report. The panel lives only in this terminal; Ita follows a pass from his phone, where there is no status line, and a single notification has to be readable on its own — so a footer trimmed to "what changed since last time" is unreadable to exactly the reader it exists for. What has changed is that you no longer *retype* it. Print it and paste it:

```bash
/home/ita/coo/tools/orchestrate-status show
```

```
Ran      WeatherBaseline#71 BUG: board loses the middle page       Done   14:02→14:19 (17m)
         WeatherBaseline#73 FEATURE: lane carries its own backlog  Review 14:02→14:25 (23m) — ita
Running  WeatherBaseline#74 CLEANUP: retire queue.json             since 14:20, ~20m left → ~14:40
Planned  WeatherBaseline#75 RUN: re-measure board cost             lane 2, after #74, ~20m → ~15:00
         WeatherBaseline#76 BUG: sign drops the surname            skipped — Blocked on inbar#40
```

Both views render the same file, so the panel and the footer cannot disagree, and what the renderer guarantees you no longer have to:

- **Every line names the task by id *and* title.**
- **Ran** is every task finished so far this pass, where it landed, and the measured `start→end (Nm)`. A Review line names its reviewer; a Blocked line names its blocker.
- **Running** counts itself down. `~20m left` is `start + eta − now`, recomputed every time the panel re-renders, so it is true between your messages as well as in them — and a worker past its estimate reads `~12m past ~14:40` instead of sitting at "20m left" forever.
- **Planned** clocks are chained down each lane from whatever is running in it, so a worker landing early or late moves every line behind it. That is the whole-chain recalibration this section used to ask you to do by hand, and it is the part that was always wrong when you did.
- **Every `Running` and `Planned` line ends in a wall-clock finish time, not only a duration** — `~20m → ~15:00`. A duration alone makes the reader do the arithmetic and guess what time the dispatcher thinks it is; the clock time is what they actually want, which is when to come back.
- Skipped tasks stay on **Planned** with the reason, so the reader knows they were seen.
- Nothing running still prints all three headings, with `Running  —`.
- Times are measured, never guessed: `start` and `land` stamp the clock themselves. Estimates are the `--eta` you gave and say so with `~`; once the first worker lands, re-run `plan` to re-estimate the rest against what it actually took.

**The file is per session, not per repo**, because the panel has to be true of the terminal it is pinned to — two sessions open in the same repo (Ita's and yours) would otherwise overwrite each other's pass. It is keyed by `CLAUDE_CODE_SESSION_ID`, which is in the environment of every shell the skill runs, and which a subagent inherits from the session that spawned it — so a worker that stamps itself writes into its dispatcher's file, which is the right one. The renderer takes the session id off the status line's own input instead. You never name it: `/home/ita/coo/tools/orchestrate-status where` prints the path if you want to look.

The pinned rows need `statusLine` in `~/.claude/settings.json` to run `/home/ita/coo/tools/orchestrate-status statusline -- <whatever held the status line before>`, which is set up on this machine. Where it is not — a cloud session, another box — `plan`, `start`, `land` and `show` all still work and the footer is unaffected; only the pinned rows are missing.

## 5. Close out the pass

Before the final report, and every time:

1. **Price every issue this pass filed.** Read each one against the whole board, not from inside the task that produced it. Say which you changed and why. They stay in `backlog`; promoting one to `Queued` is a call you make deliberately and name in the report, not a default.
2. Reorder the queue if the work changed what should run next.
3. `/home/ita/coo/tools/board pending` — flush anything a budget blackout queued.
4. Whatever your `CLAUDE.md` asks of a session before it ends.
5. Commit **by path** and push. Anything a worker left uncommitted and named in its report is committed here; anything dirty it did not name is not yours.

## 6. Report

Per item: what it was, what its worker did, how it was verified, where it landed (Done / Review-and-who / Blocked-and-why), and what it left behind. Then the queue's new state, anything you skipped with the reason, the priorities you changed — and the footer one last time, with every line now carrying its actual timing.

Then, and only after that footer is written:

```bash
/home/ita/coo/tools/orchestrate-status clear    # the pass is over; the panel comes down
```

A pass left uncleared pins its own history to the bottom of the terminal for the rest of the session, which is the one way this panel can lie.
