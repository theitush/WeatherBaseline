---
name: orchestrate
description: Work this repo's queue (WeatherBaseline) as a dispatcher — one subagent per task, several at once when their paths are disjoint, and a pinned Running / Planned / Done panel. Invoke as /orchestrate.
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
- Run as many lanes as the split allows and no more than you can watch. Model per worker is the card's `Worker` column, and it goes on the spawn as `model:` **every time** — `opus` unless the card says otherwise. A spawn with no `model` runs at whatever default this machine happens to carry, and on 2026-09-18 an orchestrator asked which that was answered Fable, then Opus, and had checked neither (coo#94). Passing it is what makes the answer yours.

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

The columns are id, title, lane, your estimate in whole minutes, and a note; `skip` in the lane column is a task you saw and passed over, and the note is why. A skipped row is recorded and **never rendered** (§4) — the panel is what is happening, not what is not — so the file stays a true record of the pass while `Planned` holds only what is going to run next; what you passed over is prose in §6's report. That file *is* the pass — it is what the panel renders and what §6's footer is printed from, so it is also what a reader compares the finished pass against. Re-run `plan` whenever the shape of the pass changes (a task added, a lane re-cut, an estimate you now know better): it re-orders and re-estimates, and it never un-runs anything that has already started or landed.

## 3. Spawn, watch, land

For each task, in this order:

```bash
n=<n>
/home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"        # before the spawn, so a crash leaves evidence
/home/ita/coo/tools/orchestrate-status start WeatherBaseline#$n --eta 20     # stamps the real start; the panel counts down from it
```

Then spawn its worker into this repo with `model:` set to the card's `Worker` — passed explicitly, never left to inherit — with the issue body as context and this brief:

> You hold `WeatherBaseline#n` and nothing else. Sign it (`/home/ita/coo/tools/sign WeatherBaseline n <YourName>`) before the work. His ask is in the issue body's **Ask** block, in his own words — read it there. Nothing in this brief restates it, and any reading of it here is mine, not his. You own these paths: `…`; do not touch `…`, another worker holds them. Your memory budget is **`<N>` GB**: run anything heavy under `systemd-run --user --scope -q -p MemoryMax=<N>G -p MemorySwapMax=0 -- …`, never uncapped and never into swap, and report its peak (`/usr/bin/time -v`, `Maximum resident set size`) — if you hit the cap, report the number rather than raising it. Do the work, verify it (tests, build, a read of the diff — the result is a claim you are signing), file whatever the work did not reach as its own issue at `Status backlog` before this one closes, and finish it exactly one of three ways per `CLAUDE.md`: **Done** (result block below a `---` rule, close the issue, `Status Done`), **Review** (issue stays open, one-line `**Review:** <who> — <what> — <where>` as the body's first line, `Status Review`, commit says `Refs #n`), or **Blocked** (blocker in the body, issue open, `Status Blocked`). Report back: what you did, how you verified, where it landed, which issues you filed, and the exact paths you left uncommitted.

**The brief never re-types his words.** The ask lives once, in the issue body's `**Ask**` block, and the worker reads it there — a brief that quotes it makes a second copy that can drift, and on 2026-09-18 it did: `countrous` came out `contours`, `diagnoal` came out `diagoanl`, and two of fourteen rounds went on undoing the reading the tidied word licensed (coo#93 §2). Where a task needs *your* reading of an ambiguous ask, write it outside the blockquote and say it is yours. And if the ask has a question in it, ask him before you spawn — not after the worker builds.

**Name the task in the spawn's `description`** — `WeatherBaseline#n` somewhere in it, which `Work WeatherBaseline#74 …` already does. That is the whole of what a clickable row needs: the panel finds a worker's transcript by matching that description, so `start` takes nothing extra and a pass written the usual way links itself (§4). Where the match cannot be made — a worker spawned before its row existed, a task you worked by hand — say where the row points instead, with `/home/ita/coo/tools/orchestrate-status start WeatherBaseline#$n --agent <id>` or `--link <path|url>`. A **planned** task points at the brief you are going to send it, once you have written it down:

```bash
/home/ita/coo/tools/orchestrate-status brief WeatherBaseline#$n <<'EOF'
You hold WeatherBaseline#$n and nothing else. …
EOF
```

That is optional, and it is the one way to read a brief before it is sent: nothing can put unsent text into a running session's prompt box, so the brief is a file the planned row links to, editable up until the spawn (coo#102).

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
5. Send a message saying what landed and what you started behind it — a line or two, no footer. The panel at the bottom of the terminal is already carrying the lists, live and recomputed; the block goes on the final report and nowhere else (§4, §6).

## 4. The panel, and the footer on the final report

The three lists — what is running, what is planned, what is done — are one file now, written by the commands in §2 and §3 and rendered in two places.

**The panel** is the status line: Claude Code re-runs it on every assistant message and pins each line of its output to the bottom of the terminal. So the headings sit in one place and stop scrolling away, which is what Ita asked for (coo#87): *"i just want to have the running, ran, planned in a fixed format that doesnt go anywhere instead of the text written at the end of every msg."* There is nothing to set up per pass — `plan` brings the panel up, §5's `clear` takes it down, and a session with no pass shows no headings at all.

**The footer goes on the final report, whole — and on nothing else.** During the pass the panel *is* the footer: it re-renders on every message and on a timer, it sits in one place, and it is already right, so a block pasted under each message only says the same thing twice. Ita, mid-pass on 2026-09-19: *"you dont need to write the suffix coz the under table thing seems ot be working!"* (coo#97). What the panel cannot do is leave this terminal, and Ita follows a pass from his phone, where there is no status line and a single notification has to be readable on its own — so the final report still ends with the block, in full, never trimmed to "what changed since last time". You never retype it either. Print it and paste it:

```bash
/home/ita/coo/tools/orchestrate-status show
```

```
STAGE    TASK                                                          ETA                         TOKENS
Session              orchestrator                                                                  206.3k
Running  WeatherBaseline#74 CLEANUP: retire queue.json                        00:20                       124.8k
Planned  WeatherBaseline#75 RUN: re-measure board cost                        00:40
Done     WeatherBaseline#73 FEATURE: lane carries its own backlog             00:17  Review — ita         213.3k
Done     WeatherBaseline#71 BUG: board loses the middle page                  00:10  Done                 230.3k
                                                                                           total:  774.7k
```

It is a table — a `STAGE  TASK  ETA  TOKENS` header, the orchestrator's own row at the top, then Running, then Planned, then Done, the stage written on every row, and the total on the last — with the ETA and TOKENS columns a fixed width and TASK taking the rest of the terminal, so nothing jumps between renders (Ita, 2026-09-17, coo#90: *"running then planned then ran … stage, task, eta in fixed length columns"*). The two numbers are the last two columns, so the eye scans two straight edges down the right of the table rather than one down the middle (Ita, 2026-09-19, coo#117: *"the tokens should be the most right column"*). Claude Code runs the status line with `COLUMNS` and `LINES` set to the terminal's size, so the panel sizes itself to the window; `/home/ita/coo/tools/orchestrate-status width <cols>` is only the fallback for a status line run some other way, and unset it lays out for 120. Both views render the same file, so the panel and the footer cannot disagree, and what the renderer guarantees you no longer have to:

- **Every line names the task by id *and* title.** A title longer than the column is cut with an ellipsis; the id never is.
- **The ETA column is one number: how much longer**, as `hh:mm`, or `d:hh:mm` once it is over a day. Ita, 2026-09-19 (coo#117): *"lets do the eta as just time left hh:mm or d:hh:mm if over 24hrs"*. So a running or planned row says the time left until it is finished, a row past its estimate says the same with a leading minus — `-00:50`, a countdown through zero — and a finished row says the span it took, `00:17`, in that same form. One kind of thing, read straight down. The finish clock, the `since 14:20` and the `lane 2 after #74` note that shared this column until that day are gone: *just* was the word he used, the lanes are still chained exactly as they were, and which lane a task is in is §2's business and the report's.
- **Done** is every task finished so far this pass, the span it took, and where it landed — **newest first**, so the last thing to land is the top Done row (Ita, 2026-09-19, coo#117: *"the last done should be at the top"*). A Review line names its reviewer; a Blocked line names its blocker, beside the span in the same column. **The stage means this pass is done with the task, not that the board says `Done`** — a `Done` row can read `Review — ita` or `Blocked on inbar#40` right after its span, because that is where it landed and the stage is only that the pass let go of it. It was called `Ran` until 2026-09-19 (Ita, coo#110: *"ran in green and it should be called done"*); the plan file still writes the state as `ran`, which nothing but the renderer reads.
- **Running** counts itself down. `00:20` is `start + eta − now`, recomputed every time the panel re-renders, so it is true between your messages as well as in them — and a worker past its estimate goes to `-00:12` instead of sitting at "20m left" forever.
- **Planned** rows are chained down each lane from whatever is running in it, so a worker landing early or late moves every line behind it. That is the whole-chain recalibration this section used to ask you to do by hand, and it is the part that was always wrong when you did. The chain is not written on the row — only its result, the time left.
- **`Planned` is only what is going to run next, and there are only these three stages.** A task you saw and passed over — `Worker: ita`, `Blocked`, `Review`, `backlog` — is kept in the file by `plan` and appears on the panel **nowhere**: not on Planned, and not in a stage of its own. Ita, 2026-09-19 (coo#97): *"planned is ONLY things that are planned to go next in line"*, and, on being shown a `Skipped` stage built for the rest: *"lol ffs skipped is not in the fucking spec. why am i seeing skipped things"*. The panel is the room you have for what is happening; §6's report is where you name what you passed over, in prose, with the reason.
- **Every `Running` and `Done` row carries the tokens its worker has used**, re-read from that worker's transcript on every render, so a running row's count climbs while it works (Ita, 2026-09-19, coo#103: *"i want a token count on the tasks also. updated like in the subagents thing"*). It is the number Claude Code's own agents view shows beside a subagent — **the context that agent is carrying right now, plus every output token it has written** — so the panel and that view agree; it is not what the agent has been billed, which counts the same context once per turn. A `Planned` row has no worker yet and a row whose worker cannot be found prints nothing, never an error, and the column is a fixed width, rightmost since coo#117, so a count going from `9.9k` to `124.8k` moves nothing.
- **Two rows of the table are not tasks.** The orchestrator's own count is a row at the **top**, shaped like any session's — a stage, a title, a count, no ETA — and the total of it and every worker is the **last** row, written the way a ledger writes one: `total:` right-aligned in the column left of TOKENS, the number beside it, nothing else on the line. Ita, 2026-09-19 (coo#117): *"the orchestrator should appear like a session at the top and the total should yes be a row but like in accounting style so just total: 2.3M next to eachother as the last row"*. Both appear only when there is something to count, neither holds a task, and neither is tinted — the colour says what a *task* is doing. They replaced the `Tokens` stage that carried the same two numbers until that day.
- **A row's id is a link.** `Running` and `Done` link to their worker's transcript, `Planned` to the brief `brief` wrote for it — an OSC 8 hyperlink on the id alone, so ctrl+click on `WeatherBaseline#74` opens what that row is about (Ita, 2026-09-19, coo#102: *"i want to be able to click on the agents running or does that ran and it would take me to them"*). What follows the URL is the terminal, not Claude Code, so nothing here reaches Claude Code's own subagent view; while a worker is still running that view is already there, under the prompt or at `/tasks` — select the row and press Enter. The URL is invisible on screen, so `/home/ita/coo/tools/orchestrate-status links` prints what every row resolves to and what the environment makes of it; `ORCHESTRATE_LINKS=0` turns the escapes off; and where Claude Code does not detect a hyperlink-capable terminal the id just prints as text, which is why `FORCE_HYPERLINK=1` in its environment is worth having. The footer `show` prints is plain — it is pasted into a report, where an escape sequence is not a link but garbage — so that is the one place the two views differ on purpose.
- **Each stage has a colour** in the terminal: `Running` a mid blue, `Planned` a lighter blue, `Done` green (Ita, 2026-09-19, coo#110: *"maybe diff colors? like blue for running and slightly beigher for planned and ran in green"*, and then *"i dont like this beige… i said light blue.. so keep the current blue for running and make it ligher blue for what is currently beige"*). The whole row is tinted, not just the stage word — three bands read from across a terminal where three tinted words do not — and the three 256-colour codes are picked to read on a dark theme and a light one alike. It goes where the links go and stops where they stop: the panel is coloured, the footer `show` prints is not. `ORCHESTRATE_COLOR=0` turns it off, and so does `NO_COLOR`; `/home/ita/coo/tools/orchestrate-status links` prints which codes are in use and whether either escape is on.
- Nothing running still prints the header and all three stages, with `Running  —`.
- **The panel is capped** at half the terminal, and Done collapses from the oldest into a `+N earlier` count — which, now that the newest is at the top, is the bottom of that stage; a status line cannot scroll. `/home/ita/coo/tools/orchestrate-status expand` lifts the cap for this session and `collapse` restores it — Ita runs them from the prompt as `! …/orchestrate-status expand`, and so can you when he asks. The status line also re-runs on a timer (`refreshInterval` in `~/.claude/settings.json`), so the toggle and the countdowns take effect between messages (coo#91).
- Times are measured, never guessed: `start` and `land` stamp the clock themselves. What tells a measurement from an estimate is the stage, not a mark on the number — a `Done` row's span was timed, a `Running` or `Planned` row's is the `--eta` you gave, counted down; the `~` that used to say so went with the rest of the tail at coo#117. Once the first worker lands, re-run `plan` to re-estimate the rest against what it actually took.

**The file is per session, not per repo**, because the panel has to be true of the terminal it is pinned to — two sessions open in the same repo (Ita's and yours) would otherwise overwrite each other's pass. It is keyed by `CLAUDE_CODE_SESSION_ID`, which is in the environment of every shell the skill runs, and which a subagent inherits from the session that spawned it — so a worker that stamps itself writes into its dispatcher's file, which is the right one. The renderer takes the session id off the status line's own input instead. You never name it: `/home/ita/coo/tools/orchestrate-status where` prints the path if you want to look. The id can change under a running pass — a resume, or Ita switching to the agents view and back — and then `start`/`land` report no pass: run `/home/ita/coo/tools/orchestrate-status adopt` and the previous session's file moves under the new id (coo#92).

The pinned rows come from `statusLine` in this repo's own `.claude/settings.json` — the checked-in project file, which runs `/home/ita/coo/tools/orchestrate-status statusline` and which overrides the user-level block as a whole. Giverny owns `~/.claude/settings.json`'s block per account and rewrites it whenever it likes (it did on 2026-09-17 and again by 2026-09-19, each time taking a wrapper there down with it), so nothing of ours lives there any more: the wrapper reads whatever Giverny last wrote at render time and prints it above the panel (coo#91, coo#96). `/home/ita/coo/tools/orchestrate-status install` writes all six repos' files and is safe to repeat; it is only needed on a new repo or a new machine. Where it is not — a cloud session, another box — `plan`, `start`, `land` and `show` all still work and the footer is unaffected; only the pinned rows are missing.

## 5. Close out the pass

Before the final report, and every time:

1. **Price every issue this pass filed.** Read each one against the whole board, not from inside the task that produced it. Say which you changed and why. They stay in `backlog`; promoting one to `Queued` is a call you make deliberately and name in the report, not a default.
2. Reorder the queue if the work changed what should run next.
3. `/home/ita/coo/tools/board pending` — flush anything a budget blackout queued.
4. Whatever your `CLAUDE.md` asks of a session before it ends.
5. Commit **by path** and push. Anything a worker left uncommitted and named in its report is committed here; anything dirty it did not name is not yours.

## 6. Report

Per item: what it was, what its worker did, how it was verified, where it landed (Done / Review-and-who / Blocked-and-why), and what it left behind. Then the queue's new state, anything you skipped with the reason, the priorities you changed — and the footer, `/home/ita/coo/tools/orchestrate-status show` pasted whole, every line now carrying its actual timing. This is the one message of the pass that carries it.

Then, and only after that footer is written:

```bash
/home/ita/coo/tools/orchestrate-status clear    # the pass is over; the panel comes down
```

A pass left uncleared pins its own history to the bottom of the terminal for the rest of the session, which is the one way this panel can lie.
