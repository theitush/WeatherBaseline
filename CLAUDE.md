# WeatherBaseline

This file is thin on purpose: it grows a line at a time, when something proves worth writing down. Otherwise orient by reading the repo. One standing rule: **nothing deploys to prod without Ita's explicit green light** — never run `scripts/deploy_prod.sh` on your own judgement.

## Tasks

*Generated from `coo/templates/CLAUDE-tasks.md` and overwritten whenever it changes — put this repo's own rules above this heading.*

This repo's tasks are its GitHub issues: **"task 5" means issue #5 here.** Each is also an item on Project #2 `COO` (https://coo-board.pages.dev), whose columns hold `Status` (backlog / Queued / In Progress / Blocked / Review / Done / Cancelled), `Priority` (ASAP / high / medium / low), `Worker` (ita / fable / opus / sonnet / haiku) and `Due`. Look a task up when one is named; don't read the queue at startup.

**Issues go over REST, never `gh issue`** (that is GraphQL, a shared budget that runs out). **Columns go only through `/home/ita/coo/tools/board`** — never `gh project`, and never a retry loop; it queues what it cannot send. Running it is the one thing you may do outside this directory.

```bash
gh api repos/theitush/WeatherBaseline/issues/<n> -q .body                                     # read one
gh api "repos/theitush/WeatherBaseline/issues?state=open&per_page=100" -q '.[] | select(.pull_request == null) | "#\(.number) \(.title)"'
gh api repos/theitush/WeatherBaseline/issues -X POST -f title="..." -F body=@file -q .number   # file one
/home/ita/coo/tools/board add WeatherBaseline $n;  /home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"   # or Priority high, Worker opus, Due 2026-09-05
```

**Titles start with their type:** `BUG:` behaves wrong (wrong docs and hurtful slowness too) · `FEATURE:` new or visibly changed capability · `RESEARCH:` a question answered by measuring · `RUN:` existing machinery executed · `CLEANUP:` no behaviour change · `DECIDE:` a call only a person can make (`Worker: ita`). An area tag follows the type: `BUG: backtest(#61): …`.

**The body**, in order: an optional one-line `**Review:**`, the `**Agent:**` line, the **Ask**, the details, and at the end `---` + `**Result**`.

**Work starts from a task.** Ita names an issue — that is the task. He asks for something with no issue — file one first: his words byte for byte in an Ask block (`**Ask** — Ita, <date>, \`<transcript path>\`:` then `> …`, typos and all), a few lines of what they mean, then add it and set In Progress before starting. An issue nobody asked for says so: `**Ask** — none; filed by <name> while working WeatherBaseline#12.` If his ask carries an open question, settle it with him before filing. A question, a read or a five-minute look is not a task. **Everything else you file goes to `backlog`**, with an honest `Priority`; `Queued` is a promotion only a person or triage makes — if something can't wait, say so instead.

**Working one:**
1. Read it. `Worker: ita` is his — don't do it, don't close it.
2. Sign and set In Progress, before any work: pick a one-word first name and run `/home/ita/coo/tools/sign WeatherBaseline $n Pike` (a surname is drawn: Pike Vance; revived, pass both words). No `tools/sign` (cloud run): write `**Agent:** <name> · <hostname> · in \`<pwd>\` · no resumable session` at the top of the body by hand.
3. Do the work; commit and push (below).
4. Finish — file the leftovers, write the result signed with your full name, close, set Done:
   ```bash
   { gh api repos/theitush/WeatherBaseline/issues/$n -q .body; printf '\n---\n**Result**\n\n%s\n' "<what, how verified> — Pike Vance"; } > /tmp/task-$n.md
   gh api -X PATCH repos/theitush/WeatherBaseline/issues/$n -F body=@/tmp/task-$n.md -f state=closed
   /home/ita/coo/tools/board set WeatherBaseline $n Status Done
   ```
   Cancelled: add `-f state_reason=not_planned`, `Status Cancelled`. Blocked: `Status Blocked`, blocker in the body, issue left open.

**Review, not Done,** when finished work needs a person's eye — anything visual, a judgement call, an outward-facing or irreversible change. Status `Review`, issue stays open, and only the reviewer closes it. The body's first line is **one line** — `**Review:** ita — <what exactly> <where: URL, branch + command, file:line>`. Commits say `Refs #n`, never `Closes`/`Fixes`, which would close it. Mere doubt is not Review: it is Done with the doubt in the result, or Blocked.

**What you could not do becomes a task.** Each skipped step, unrun check, estimate, uncovered case → its own `backlog` issue before this one closes, and the result names them: `Left over: #40 (…), #41 (…)`.

**Another repo's work is handed off, not taken:** file it in that repo over REST, `tools/board add` it at `backlog`, tell Ita in one line, and get back to your task. Never write into another repo's tree; read it there or in `coo/mirror/<name>/`.

**Stay focused.** Unrelated findings are pins: a `backlog` issue of three to five lines (where, symptom, hunch, done-when), then straight back. Related is not a detour — if the task can't be finished correctly without it, it is the task. Write only inside this repo's directory (or your session scratchpad).

**Git.** Never end with unpushed work: complete and verified → trunk; incomplete or risky → branch `task-<n>-<slug>`, pushed, with `In flight on branch …` written into the issue. The tree is shared, so **you hold what you dirty and touch nothing dirty that is not yours**: check `git status --short -- <path>` when you reach for a file; if it is held, use a new file or ask — never guess. Commit by path (`git add <files>`, never `-A`/`-a`); never `stash`, `reset`, `restore`, `clean`, `pull --rebase`/`--autostash`, or a branch switch over others' files. Plain `git pull` is safe.

**No GitHub Actions.** Never add a workflow; `mirror-sync.yml` (plus a real deploy) is the whole list, and more is Ita's call in advance. Automatic checks are a tracked `pre-commit` hook on `core.hooksPath`.

**The org.** Seven repos, all Ita's, one machine, one board: `WeatherBaseline` (`~/HowHotWasIt`, ERA5 baselines + public site), `inbar` (`~/Inbar`, trading research), `lead-machine` (`~/leadgen`, outreach pipeline + cockpit), `planets` (`~/planets`, astronomical poster editor), `yajna` (`~/yajna`, journal app), `giverny` (`~/giverny`, fork of the Giverny terminal), `coo` (`~/coo`). The COO owns what is shared — the board, this section, `coo/mirror/`, `coo/STATUS.md` — and is the one that dispatches work into other repos, so cross-repo work goes to it.

`/orchestrate` (`.claude/skills/orchestrate/SKILL.md`) is how a queue pass runs; it is not needed to work one task.
