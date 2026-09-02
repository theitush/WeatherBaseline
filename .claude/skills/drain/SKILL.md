---
name: drain
description: Work this repo's queue (WeatherBaseline) one task at a time. Invoke as /drain for a plain drain, or /drain super <priority> to keep going until nothing at or above that floor is left. Use when Ita says "drain the queue", "drain your queue" or "super drain <priority>".
---

<!-- Generated from coo/templates/drain-SKILL.md — every repo carries the same
     file, rendered for its own name. Do not edit it here: `coo/tools/tasks-tail
     propagate` rewrites it wholesale and refuses, for the whole fleet, any copy
     it does not recognise as a past rendering. A rule true of this repo alone
     goes in its CLAUDE.md, above `## Tasks`. -->

# Draining

`CLAUDE.md` says what the words mean — whose queue this is, what the two modes are, one task one agent, and that the dispatcher sets the priority of what its workers file. Read those there; they hold all day, not only during a drain. **This file is only how to execute one, and deliberately does not restate them.**

## 1. Settle the mode before reading anything

| Invocation | Mode |
|---|---|
| `/drain` | plain drain — the queue as it stands when the drain starts |
| `/drain super low` (or `high`, `medium`, `ASAP`) | super drain with that floor |
| `/drain super` | **not a command.** Ask which floor. Do not guess one |

## 2. Take your slice of the board

The queue's order, Status and Priority live on the project, not in the issues, so one read gets them:

```bash
/home/ita/coo/tools/board list --tsv | awk -F'\t' '$4 == "WeatherBaseline"'
```

That is 1 GraphQL point for the whole board, in project order. `--tsv` is: position, item id, type, **repo**, issue number, Status, Priority, Worker, Due, title — the count line goes to stderr, so it does not reach the filter. Yours is what `CLAUDE.md` says is yours — normally exactly those rows, and never another repo's.

Then drop, in this order:

- `Worker: ita` — skip.
- `Blocked` — skip; name the blocker in your report. If it has since cleared, unblock it and work it.
- `Review` — skip; it is waiting on its named human. If no human is named, that is the bug: name one in the body and leave it there.
- `backlog` — skip, *unless* this is a super drain and this drain filed it: those it works, and no other backlog item.
- On a super drain only: everything below the floor.

What survives is worked in project order.

## 3. One item at a time

For each, in this order:

```bash
n=<n>
gh api repos/theitush/WeatherBaseline/issues/$n -q .body     # REST; gh issue view is GraphQL
/home/ita/coo/tools/sign WeatherBaseline $n <YourName>                 # before the work, not after
/home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"  # before the work, so a crash leaves evidence
```

Do the work. Verify it — tests, build, a read of the diff — because the result is a claim you are signing. Then file whatever the work did not reach as its own issue *before* this one closes — at `Status backlog`, per `CLAUDE.md` — and finish it exactly one of three ways:

**Done** — verified, remainder filed and named in the result:

```bash
{ gh api repos/theitush/WeatherBaseline/issues/$n -q .body
  printf '\n---\n**Result**\n\n%s\n\n— %s\n' "<what was done, how it was verified, Left over: #a, #b>" "<Your Full Name>"; } > /tmp/task-$n.md
gh api -X PATCH repos/theitush/WeatherBaseline/issues/$n -F body=@/tmp/task-$n.md -f state=closed
/home/ita/coo/tools/board set WeatherBaseline $n Status Done
```

**Review** — finished, but a person has to look. Issue stays **open**; write the one-line `**Review:** <who> — <what> — <where>` as the body's first line, replacing any existing one, and `/home/ita/coo/tools/board set WeatherBaseline $n Status Review`. Your commit says `Refs #n`, never `Closes #n` — a closing keyword erases the review request the moment it lands.

**Blocked** — you cannot proceed at all. Blocker written into the body, issue open, `Status Blocked`. Not a place to park work you are merely unsure of: that is Done with the doubt in the result.

## 4. Close out the pass

Before you report, and every time:

1. **Set the priority of every issue this drain filed yourself.** Read each one against the whole board, not from inside the task that produced it. Say in the report which you changed and why. They stay in `backlog`; promoting one to `Queued` is a call you make deliberately and name in the report, not a default.
2. Reorder the queue if the work changed what should run next.
3. `/home/ita/coo/tools/board pending` — flush anything a budget blackout queued.
4. Whatever your `CLAUDE.md` asks of a session before it ends.
5. Commit **by path** and push. Never `-A`: the tree is shared. An agent's report names the paths it left uncommitted; commit those and nothing else.

## 5. Super drain only: go round again

Re-read the board and repeat from step 2 while anything of yours sits at or above the floor — including what this drain just filed, which is in `backlog` and which only this mode reaches. Step 4.1 is what makes that terminate: leftovers priced from inside their parent task will otherwise keep landing at or above the floor forever.

## 6. Report

Per item: what it was, what you did, how you verified, where it landed (Done / Review-and-who / Blocked-and-why), and what it left behind. Then the queue's new state, and anything you skipped with the reason.
