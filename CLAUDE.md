# WeatherBaseline

This file is thin on purpose: it grows a line at a time, when something proves worth writing down. Otherwise orient by reading the repo. One standing rule: **nothing deploys to prod without Ita's explicit green light** — never run `scripts/deploy_prod.sh` on your own judgement.

## Tasks

This repo's tasks are its **GitHub issues**. When Ita says **"task 5"** he means **issue #5 of this repo** — `gh issue view 5`. Every issue here is also an item on his cross-project board, GitHub Project #2 `COO` (https://github.com/users/theitush/projects/2 — the same data https://coo-board.pages.dev shows), and the project is where a task's status, priority, worker and queue position live. Don't read the queue at startup; look a task up when one is named. `gh issue list` shows what is open here.

A task is the issue title; the issue body is its notes; and once finished, the result goes in the same body under a `---` rule and a `**Result**` heading. The project's columns are `Status` (backlog / Queued / In Progress / Blocked / Review / Done / Cancelled), `Priority` (ASAP / high / medium / low), `Worker` (ita / fable / opus / sonnet / haiku) and `Due`.

**Every piece of work starts from a task.** If Ita names an issue, that is your task. If he asks for something with no issue behind it, write the issue here first — a title and a few lines of what he asked for — `gh project item-add` it, set it In Progress, and *then* start. Filing it afterwards defeats the point: In Progress before the work is what a crashed session leaves behind. A task is for work that ends in a commit; a question, a read or a five-minute look is not work and must not be filed, or the board becomes a log and buries the queue.

Working one:

1. Read it: `gh issue view <n>`. If its `Worker` is `ita`, it is Ita's own work — don't do it and don't close it.
2. Set Status to In Progress before starting, so a crashed session leaves evidence. Status is a project field, not an issue label, so it is set by item id:
   ```bash
   n=<n>; item=$(gh project item-list 2 --owner theitush -L 500 --format json -q ".items[] | select(.content.repository==\"theitush/WeatherBaseline\" and .content.number==$n) | .id")
   gh project item-edit --project-id PVT_kwHOAsyv184Bh3P- --id "$item" --field-id PVTSSF_lAHOAsyv184Bh3P-zhgxYh8 --single-select-option-id 36ef7d70
   ```
   Status option ids: backlog `72269122` · Queued `93fc0ce3` · In Progress `36ef7d70` · Blocked `d50a3e21` · Review `784755d5` · Done `bef6703c` · Cancelled `bf4d973d`.
3. Do the work; commit and push per **Committing and pushing** below.
4. Finish: write the result into the issue body, close the issue, and set Status to Done. Closing alone does not move the board, so all three happen:
   ```bash
   { gh issue view $n --json body -q .body; printf '\n---\n**Result**\n\n%s\n' "<what was done and how it was verified>"; } > /tmp/task-$n.md && gh issue edit $n --body-file /tmp/task-$n.md
   gh issue close $n
   gh project item-edit --project-id PVT_kwHOAsyv184Bh3P- --id "$item" --field-id PVTSSF_lAHOAsyv184Bh3P-zhgxYh8 --single-select-option-id bef6703c
   ```
   Blocked instead: Status `d50a3e21`, the blocker written into the body, issue left open.

### When the work needs a human eye: Review, not Done

Some work is finished but cannot be *signed off* by the thing that did it. Anything visual is the usual case — a new screen or component, a layout, spacing, colour, an animation, copy a person will read, a chart, a print or export layout — because "the tests pass" says nothing about whether it looks right. It is not only frontend: a judgement call between two defensible designs, an irreversible or outward-facing change, a heuristic or threshold whose output only a person can call good, a migration you cannot dry-run.

Those go to **Review** instead of Done: Status `784755d5`, **issue stays open**, and you do not close it. The reviewer closes it and sets Done once they have looked.

Review is worthless unless the issue says what to look at and who is looking, so write both into the body when you set it — same place a result goes, under a `**Review**` heading instead:

```bash
{ gh issue view $n --json body -q .body; cat <<'EOF'

---
**Review**

- **What:** the empty state on the cockpit list — spacing and the wording of the hint line
- **Who:** ita
- **Where:** branch `task-6-empty-state`, `npm run dev` → /cockpit with no filters
EOF
} > /tmp/task-$n.md && gh issue edit $n --body-file /tmp/task-$n.md
gh project item-edit --project-id PVT_kwHOAsyv184Bh3P- --id "$item" --field-id PVTSSF_lAHOAsyv184Bh3P-zhgxYh8 --single-select-option-id 784755d5
```

- **What** is the specific thing to look at, not the task title again. "The board renders" is not a review request; "the Review column's purple against the Blocked red in dark mode" is.
- **Who** is a name — `ita` unless he has said otherwise. A review nobody is named for is a task that sits in the column forever.
- **Where** is how they see it in ten seconds: a URL, a branch and the command to run it, a screenshot path, a file and line. Skip it only when there is genuinely nothing to look at but the diff.

Don't use Review to hedge. Work you are simply unsure about is Done with the doubt written into the result, or Blocked if you actually cannot proceed. Review means *this is finished and a person has to look at it before it counts*.

New tasks that come out of the work become issues here and go on the project: `gh issue create ...`, then `gh project item-add 2 --owner theitush --url <issue url>`. An item with no Status shows on the board as Queued and with no Worker as opus; use `item-edit` above if that is wrong. Never track work in a file in this repo, and never touch another repo's issues from here — anything cross-project goes through the `coo` repo.

### Committing and pushing

Never end a session with unpushed work. If a file was written or changed, it is committed and pushed before the session ends — work that lives only in a working tree is invisible to Ita and the COO, and dies with the machine. Where it goes depends on the state of the work:

- **Complete and verified** → trunk, however this repo normally lands changes.
- **Incomplete, unverified, or risky** → a feature branch named for the task (`task-<n>-<short-slug>`), pushed.

A pushed feature branch is written into its task the moment it exists: one line in the issue body — `In flight on branch task-<n>-<slug>`. That line is what makes the branch findable from the board or a phone; a branch nobody wrote down is a branch nobody knows to look at. Merge it per this repo's rules when the work lands, delete it when the task closes.

### Staying focused

Work the task you were given, and only it. When something unrelated turns up mid-task — a bug somewhere else, a perf stall, a dead file, a good idea for later — **pin it**: one `gh issue create` in the repo it belongs to, `gh project item-add` it, and go straight back to what you were doing. A pin is a title plus three to five lines: where you saw it, the symptom, a one-line hunch, a one-line "done when". Don't chase it, don't name every code path, don't design the fix — that is the job of whoever picks the issue up. The issue is what makes dropping it safe; nothing is lost, so there is never a reason to chase it now.

Related is not a detour. If the thing you found is part of the task, blocks it, or would be broken by the change you are about to make, handle it now — that *is* the task. The test is whether the current task can be finished and be correct without it, not whether it is interesting.

Same rule for scope: the task is what the issue says. Improvements you notice along the way are pins, not extras.

Same rule for the filesystem: **stay inside this repo's directory**. Everything you write — code, scratch files, test output, downloads — lands in this working tree (or your session scratchpad for throwaways), never in `~`, another project's directory, or anywhere else on the machine.
