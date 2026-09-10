---
name: orchestrate
description: Work this repo's queue (WeatherBaseline) as a dispatcher — one subagent per task, several at once when their paths are disjoint, and a status footer on every message. Invoke as /orchestrate.
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

Parallelism is the point of this skill, and the tree is the constraint. Two workers in one checkout are safe only when the files they will reach for are disjoint, so:

- Group the survivors by the paths their work will touch. Tasks whose paths are disjoint run **at the same time**, each in its own subagent. Tasks that share a path run **one after the other**, in project order, in one lane.
- Name the split in every brief: the paths that worker owns, and the paths it must not touch because another worker holds them.
- Where two tasks cannot be split by path and you still want both running, one of them gets `isolation: "worktree"`; its branch is merged when it reports — a merge, never a clobber.
- Run as many lanes as the split allows and no more than you can watch. Model per worker is the card's `Worker` column.

Write the plan down before spawning anything — it is the first footer (§4), and it is what a reader compares the finished pass against.

## 3. Spawn, watch, land

For each task, in this order:

```bash
n=<n>
/home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"   # before the spawn, so a crash leaves evidence
date +%H:%M                                             # the start time you will report
```

Then spawn its worker into this repo at the card's model with the issue body as context and this brief:

> You hold `WeatherBaseline#n` and nothing else. Sign it (`/home/ita/coo/tools/sign WeatherBaseline n <YourName>`) before the work. You own these paths: `…`; do not touch `…`, another worker holds them. Do the work, verify it (tests, build, a read of the diff — the result is a claim you are signing), file whatever the work did not reach as its own issue at `Status backlog` before this one closes, and finish it exactly one of three ways per `CLAUDE.md`: **Done** (result block below a `---` rule, close the issue, `Status Done`), **Review** (issue stays open, one-line `**Review:** <who> — <what> — <where>` as the body's first line, `Status Review`, commit says `Refs #n`), or **Blocked** (blocker in the body, issue open, `Status Blocked`). Report back: what you did, how you verified, where it landed, which issues you filed, and the exact paths you left uncommitted.

When a worker reports, before starting anything else in its lane:

1. Note the finish time. Read its result against the issue — you are the one who verifies before anything reads Done; what you cannot verify by looking goes to `Review` with what and who in the body.
2. Commit **by path** the paths its report names, and nothing else. Never `-A`: the tree is shared.
3. Start the next task in that lane.
4. Send a message: it ends with the footer, and the footer now carries this task's actual timing.

## 4. The footer — on every message

Every message you send during a pass ends with this block, whether the message is the plan, a one-line update, a question, or the final report. It is how Ita follows a pass from another device without reading transcripts. **Every line names the task by id *and* title.**

```
Ran      WeatherBaseline#71 BUG: board loses the middle page        Done    14:02→14:19 (17m)
         WeatherBaseline#73 FEATURE: lane carries its own backlog    Review  14:02→14:25 (23m) — ita
Running  WeatherBaseline#74 CLEANUP: retire queue.json               since 14:20, ETA ~14:40
Planned  WeatherBaseline#75 RUN: re-measure board cost               next in lane 2, ~20m
         WeatherBaseline#76 BUG: sign drops the surname               skipped — Blocked on inbar#40
```

- **Ran**: every task finished so far this pass, where it landed, and measured start→end with the duration. A Review line names its reviewer; a Blocked line names the blocker.
- **Running**: every worker alive now, its start time, and an ETA marked `~`.
- **Planned**: everything still to come, in the order it will run, with which lane and an estimate — plus every task you skipped and why, so the reader knows it was seen.
- Times are wall-clock, measured with `date` at spawn and at the report — never guessed. ETAs are estimates and say so with `~`; once the first worker of the pass finishes, recalibrate the rest against what it actually took.
- A block with nothing running still prints all three headings, with `Running  —`.

## 5. Close out the pass

Before the final report, and every time:

1. **Price every issue this pass filed.** Read each one against the whole board, not from inside the task that produced it. Say which you changed and why. They stay in `backlog`; promoting one to `Queued` is a call you make deliberately and name in the report, not a default.
2. Reorder the queue if the work changed what should run next.
3. `/home/ita/coo/tools/board pending` — flush anything a budget blackout queued.
4. Whatever your `CLAUDE.md` asks of a session before it ends.
5. Commit **by path** and push. Anything a worker left uncommitted and named in its report is committed here; anything dirty it did not name is not yours.

## 6. Report

Per item: what it was, what its worker did, how it was verified, where it landed (Done / Review-and-who / Blocked-and-why), and what it left behind. Then the queue's new state, anything you skipped with the reason, the priorities you changed — and the footer, with every line now carrying its actual timing.
