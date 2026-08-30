# HowHotWasIt

This file is deliberately thin: writing the full CLAUDE.md is task #9 (what a "task" is, below). Until it lands, orient by reading the repo. One standing rule already applies: **nothing deploys to prod without Ita's explicit green light** — never run `scripts/deploy_prod.sh` on your own judgement.

## Tasks

This repo's tasks are its **GitHub issues**. When Ita says **"task 5"** he means **issue #5 of this repo** — `gh issue view 5`. Every issue here is also an item on his cross-project board, GitHub Project #2 `COO` (https://github.com/users/theitush/projects/2 — the same data https://coo-board.pages.dev shows), and the project is where a task's status, priority, worker and queue position live. Don't read the queue at startup; look a task up when one is named. `gh issue list` shows what is open here.

A task is the issue title; the issue body is its notes; and once finished, the result goes in the same body under a `---` rule and a `**Result**` heading. The project's columns are `Status` (backlog / Queued / In Progress / Blocked / Done / Cancelled), `Priority` (ASAP / high / medium / low), `Worker` (ita / fable / opus / sonnet / haiku) and `Due`.

Working one:

1. Read it: `gh issue view <n>`. If its `Worker` is `ita`, it is Ita's own work — don't do it and don't close it.
2. Set Status to In Progress before starting, so a crashed session leaves evidence. Status is a project field, not an issue label, so it is set by item id:
   ```bash
   n=<n>; item=$(gh project item-list 2 --owner theitush -L 500 --format json -q ".items[] | select(.content.repository==\"theitush/HowHotWasIt\" and .content.number==$n) | .id")
   gh project item-edit --project-id PVT_kwHOAsyv184Bh3P- --id "$item" --field-id PVTSSF_lAHOAsyv184Bh3P-zhgxYh8 --single-select-option-id 36ef7d70
   ```
   Status option ids: backlog `72269122` · Queued `93fc0ce3` · In Progress `36ef7d70` · Blocked `d50a3e21` · Done `bef6703c` · Cancelled `bf4d973d`.
3. Do the work; commit the way this repo's rules say.
4. Finish: write the result into the issue body, close the issue, and set Status to Done. Closing alone does not move the board, so all three happen:
   ```bash
   { gh issue view $n --json body -q .body; printf '\n---\n**Result**\n\n%s\n' "<what was done and how it was verified>"; } > /tmp/task-$n.md && gh issue edit $n --body-file /tmp/task-$n.md
   gh issue close $n
   gh project item-edit --project-id PVT_kwHOAsyv184Bh3P- --id "$item" --field-id PVTSSF_lAHOAsyv184Bh3P-zhgxYh8 --single-select-option-id bef6703c
   ```
   Blocked instead: Status `d50a3e21`, the blocker written into the body, issue left open.

New tasks that come out of the work become issues here and go on the project: `gh issue create ...`, then `gh project item-add 2 --owner theitush --url <issue url>`. An item with no Status shows on the board as Queued and with no Worker as opus; use `item-edit` above if that is wrong. Never track work in a file in this repo, and never touch another repo's issues from here — anything cross-project goes through the `coo` repo.
