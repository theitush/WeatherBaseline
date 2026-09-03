# WeatherBaseline

This file is thin on purpose: it grows a line at a time, when something proves worth writing down. Otherwise orient by reading the repo. One standing rule: **nothing deploys to prod without Ita's explicit green light** — never run `scripts/deploy_prod.sh` on your own judgement.

## Tasks

*This section is generated from `coo/templates/CLAUDE-tasks.md`: everything from this heading to the end of the file is replaced wholesale whenever that template changes, so **nothing repo-specific may live here.** A rule true only of this repo goes **above** this heading — including one that amends or supersedes a rule below, which says which rule it supersedes and is then read first, the right order for a supersession. `coo/tools/tasks-tail propagate` refuses to overwrite a tail it does not recognise and stops the run for every repo, so a line slipped in here blocks the whole fleet's next update until someone moves it (coo#46).*

This repo's tasks are its **GitHub issues**. When Ita says **"task 5"** he means **issue #5 of this repo**. Every issue here is also an item on his cross-project board, GitHub Project #2 `COO` (https://github.com/users/theitush/projects/2 — the same data https://coo-board.pages.dev shows), and the project is where a task's status, priority, worker and queue position live. Don't read the queue at startup; look a task up when one is named.

**Read and write issues over REST, not `gh issue`.** Every `gh issue view`, `edit`, `close` and `list` goes out over GraphQL, whose 5000-point hourly budget is shared by every agent and the board and does run out. The REST bucket is a separate 5000 an hour that nothing here touches, and it does the same work:

```bash
gh api repos/theitush/WeatherBaseline/issues/<n> -q .body            # read one — this is "task 5"
gh api "repos/theitush/WeatherBaseline/issues?state=open&per_page=100" \
  -q '.[] | select(.pull_request == null) | "#\(.number) \(.title)"'   # what is open here
gh api repos/theitush/WeatherBaseline/issues -X POST -f title="..." -F body=@file -q .number   # file one
```

`gh issue create` looks like it should be safe and is not: it makes a GraphQL call for the repo's metadata before it posts anything, so it fails outright when the budget is gone. Use the POST above. Only the project's *columns* genuinely need GraphQL, and step 2 below is how those get written.

A task is the issue title; the issue body holds up to three sections, in the order they are read: a one-line **review** at the top (`**Review:** <who> — <what to look at>`, only once the work needs a human eye), the **details**, and once finished the **result**, behind a `---` rule and a `**Result**` heading. Ita reads and edits all three on the board. The project's columns are `Status` (backlog / Queued / In Progress / Blocked / Review / Done / Cancelled), `Priority` (ASAP / high / medium / low), `Worker` (ita / fable / opus / sonnet / haiku) and `Due`.

**Every piece of work starts from a task.** If Ita names an issue, that is your task. If he asks for something with no issue behind it, write the issue here first — a title and a few lines of what he asked for — `tools/board add` it, set it In Progress, and *then* start. Filing it afterwards defeats the point: In Progress before the work is what a crashed session leaves behind. A task is for work that ends in a commit; a question, a read or a five-minute look is not work and must not be filed, or the board becomes a log and buries the queue.

**Every other issue you file lands in `backlog`.** A pin, a leftover, anything you notice and write down: `tools/board add WeatherBaseline $n && /home/ita/coo/tools/board set WeatherBaseline $n Status backlog`. The one exception is the paragraph above — work you are about to do, which goes straight to `In Progress`. Set `Priority` honestly, because it is the triage signal, but understand that it promotes nothing: **`Queued` is a promotion a person or a triage pass makes deliberately.** That is the difference between a queue that says what to work next and a list of everything anyone ever noticed — the queue held 58 filed-and-never-queued items on 2026-09-02, which is what this rule exists to stop. If you think a finding genuinely cannot wait for triage, **say so** — in your report, to Ita, to whoever dispatched you — rather than putting it in the queue yourself (Ita, 2026-09-02, coo#62).

Working one:

1. Read it: `gh api repos/theitush/WeatherBaseline/issues/<n> -q .body`. If its `Worker` is `ita`, it is Ita's own work — don't do it and don't close it.
2. Set Status to In Progress before starting, so a crashed session leaves evidence, and sign the task in the same breath (see **Who took this task: sign it**). Status is a project *column*, not an issue label, and the columns are the one thing here that needs the GraphQL budget. `/home/ita/coo/tools/board` is how you write one:
   ```bash
   n=<n>
   /home/ita/coo/tools/board set WeatherBaseline $n Status "In Progress"
   ```
   It answers `sent:` when the write landed and `queued:` when the budget was spent — either way it returns at once and never fails, and the COO flushes what was queued when the hour turns. Running that script is the one thing you may do outside this repo's directory. The same line writes the other columns: `Priority high` (ASAP / high / medium / low), `Worker opus`, `Due 2026-09-05`. Status values, spelled and cased exactly like this: `backlog` · `Queued` · `In Progress` · `Blocked` · `Review` · `Done` · `Cancelled`. `tools/board add WeatherBaseline $n` puts a newly filed issue on the project — though a `set` does it for you if the issue isn't an item yet.

   **Don't reach for `gh project` instead.** A write through `tools/board` costs 2 of the 5000 hourly points; the same write as `gh project item-edit` costs ~104, and `gh project item-list` about one point per item on the board. A handful of either locks every agent *and the board itself* out of the project for the rest of the hour. (Measured 2026-09-01, coo#32.)

   **And never retry a board write in a loop.** That budget does run out — and when it has, `gh project` reports it as `unknown owner type`, which reads like a malformed command rather than a rate limit. It can be an hour before it clears, so retrying spends your time and learns nothing. You are not blocked by it either: the script has already recorded the write, and issues are REST, so the work itself carries on untouched. On a machine with no `tools/board`, write down which board writes you could not make and say so in your report — an unmade board write is bookkeeping the COO can drain; an agent sat in a retry loop is the task not getting done.
3. Do the work; commit and push per **Committing and pushing** below.
4. Finish: file whatever you could not do (see **What you could not do becomes a task**), write the result into the issue body, close the issue, and set Status to Done. Closing alone does not move the board, so both happen — the body and the close are one REST call:
   ```bash
   { gh api repos/theitush/WeatherBaseline/issues/$n -q .body
     printf '\n---\n**Result**\n\n%s\n' "<what was done and how it was verified>"; } > /tmp/task-$n.md
   gh api -X PATCH repos/theitush/WeatherBaseline/issues/$n -F body=@/tmp/task-$n.md -f state=closed
   /home/ita/coo/tools/board set WeatherBaseline $n Status Done
   ```
   Cancelled instead: add `-f state_reason=not_planned` and set `Status Cancelled`. Blocked instead: `Status Blocked`, the blocker written into the body, issue left open and not PATCHed closed.

### One task, one agent

One task is held by one agent, start to finish, and that agent works nothing else while it holds it. That is what makes the signature below mean anything — one name, one transcript, one thing to resume — and what keeps a result honest about what was actually done. An agent working several tasks in one run is the rare exception, and it is only right when they are genuinely one piece of work split across issues: the same change to the same files, where doing them apart would mean doing them twice.

**"Drain the queue" means this repo's queue, one subagent per task.** When Ita asks a session here to drain, he means *this repo's* open issues — not another repo's, not the whole board — and he means spawn them, not work them yourself down one long thread. Go in project order and give each task its own subagent, which owns it end to end: read the issue, sign it, In Progress, do the work, write the result, close it. You are the dispatcher — you choose what goes next, you skip `Worker: ita` items because they are his, and you verify what comes back before anything reads Done. What you cannot verify by looking goes to `Review` with what and who written into the body, exactly as if you had done the work yourself.

**Two drains.** A plain *drain* works the queue as it stood when it started; issues the drain itself files are left for the next one. **"super drain `<priority>`"** keeps going until nothing at or above that floor is left, including what the drain itself filed — `super drain low` takes low, medium, high and ASAP; `super drain high` takes high and ASAP only. The floor is required: a bare "super drain" is not a command, so ask which floor. Either way `Blocked` is skipped with the blocker noted, `Review` waits on its named human, `Worker: ita` is his, and `backlog` is outside both — with one exception, since everything you file now lands there: **a super drain works the issues that drain itself filed, backlog or not**, and nothing else in the backlog. An issue this drain did not file is not its business, however it is priced.

**Review the priority your subagents choose.** A subagent picks the `Priority` of the issues it files from inside its own task, where everything it has just been staring at looks important. You are the one holding the whole queue, so read every issue your subagents filed and set the priority yourself. Those issues sit in `backlog`, so what you set is triage — where the item lands when someone promotes it, not whether it runs tonight — and it is still what lets a super drain end, since that mode reaches back into its own leftovers.

**How a drain is executed is the `drain` skill**, not this section — `.claude/skills/drain/SKILL.md`, invoked `/drain`, or `/drain super <floor>` for the other mode. It holds the order of a pass and the per-item ritual, and restates none of the definitions above; this section defines none of its steps. It is generated from `coo/templates/drain-SKILL.md` and propagated exactly like this tail, so every repo runs the same drain (coo#60).

Two subagents in this tree at once is fine only when their paths are disjoint, and naming that split in each one's prompt is your job — they hold what they dirty, same as you (below). Where the paths cannot be split, run them one after the other.

### Who took this task: sign it

`Worker: opus` names a model, not a worker. When a result looks wrong an hour later there is nothing to go back to — no session to resume, no transcript to read, nobody to ask. So whoever takes a task signs it.

Pick yourself a first name before you start — one word, yours to choose, not a job title. It is what Ita calls you, so make it something he can say, and don't worry about whether someone already has it: models reach for the same handful of names, and being told to go away and think of another is a poor greeting. Then sign, **before any work**, in the same breath as setting Status to In Progress:

```bash
/home/ita/coo/tools/sign WeatherBaseline $n Pike     # a surname is drawn for you: Pike Vance
```

That writes one line into the issue body — your name, this machine, the directory you are working in, the command that resumes your session, and the path to the transcript that is your memory of this task. Sign before the work for the same reason Status goes to In Progress before it: whoever dies mid-task has still left an address. Signing again replaces that line rather than stacking a second one, so the card always names whoever holds the task *now*.

Two people may share a first name; the surname is drawn for you, so both Pikes get to be Pike and the pair are still tellable apart. If you are revived onto a task already signed, **keep the full name** — pass both words, `/home/ita/coo/tools/sign WeatherBaseline $n "Pike Vance"` — and you are the same worker you were. A bare first name on a task already signed by that first name keeps the surname it had, so nobody is renamed halfway through their own task. Sign your **Result** with the full name too (`— Pike Vance`): the `**Agent:**` line names whoever holds the task now, so only the result keeps naming whoever wrote it.

Where there is no `/home/ita/coo/tools/sign` — a cloud or remote run — write the line by hand as the first line of the body, and be honest that there is nothing to resume:

```
**Agent:** Pike Vance · <hostname> · in `<pwd>` · no resumable session (cloud or remote run)
```

### When the work needs a human eye: Review, not Done

Some work is finished but cannot be *signed off* by the thing that did it. Anything visual is the usual case — a new screen or component, a layout, spacing, colour, an animation, copy a person will read, a chart, a print or export layout — because "the tests pass" says nothing about whether it looks right. It is not only frontend: a judgement call between two defensible designs, an irreversible or outward-facing change, a heuristic or threshold whose output only a person can call good, a migration you cannot dry-run.

Those go to **Review** instead of Done: Status `Review`, **issue stays open**, and you do not close it. The reviewer closes it and sets Done once they have looked.

Nothing else may close it either. A commit message carrying `Closes #n` or `Fixes #n` auto-closes the issue the moment it lands on the default branch, and a closed issue reads as Done on the board — the review request is erased before anyone sees it. Reference the issue without a closing keyword: `Refs #n`.

Review is worthless unless the issue says what to look at and who is looking, so write both into the body when you set it — as the **first line of the body**, above the details:

```bash
{ printf '**Review:** %s\n\n' "ita — the empty state on the cockpit list, branch \`task-6-empty-state\`, npm run dev → /cockpit with no filters"
  gh api repos/theitush/WeatherBaseline/issues/$n -q .body | sed '/^\*\*Review:\*\*/d'   # replace an existing line, never stack two
} > /tmp/task-$n.md
gh api -X PATCH repos/theitush/WeatherBaseline/issues/$n -F body=@/tmp/task-$n.md
/home/ita/coo/tools/board set WeatherBaseline $n Status Review
```

**One line. Not two, not a bullet list** — it is the bottom line of what a person has to look at, and it is the field Ita reads first on the card. Everything else you want to say belongs in the details or the result. That one line carries:

- **who** — a name, `ita` unless he has said otherwise. A review nobody is named for is a task that sits in the column forever.
- **what** — the specific thing, not the task title again. "The board renders" is not a review request; "the Review column's purple against the Blocked red in dark mode" is.
- **where** — how they see it in ten seconds: a URL, a branch and the command to run it, a file and line. Drop it only when there is genuinely nothing to look at but the diff.

Don't use Review to hedge. Work you are simply unsure about is Done with the doubt written into the result, or Blocked if you actually cannot proceed. Review means *this is finished and a person has to look at it before it counts*.

New tasks that come out of the work become issues here and go on the project: the REST POST above, then `tools/board add WeatherBaseline <n>`. An item with no Status shows on the board as Queued and with no Worker as opus; use `tools/board set` above if that is wrong. Never track work in a file in this repo, and never touch another repo's issues from here — anything cross-project goes through the `coo` repo.

### What you could not do becomes a task

Few tasks land whole. Before you close one, read your own result back and ask what it admits to: a step you skipped, a check you could not run, a number you estimated instead of measuring, a case you left uncovered, a follow-up the work made obvious. **Each one becomes its own issue here, on the project at `backlog`, before this task closes** — same shape as a pin: a title, where it is, the symptom, a one-line hunch, a one-line "done when", and a line saying it is left over from #n.

Then name them in the result: `Left over: #40 (the extended tier was never run end to end), #41 (d5_queue_check has no pinned numbers)`. A limitation that lives only as prose in a result is lost — nobody drains a paragraph, and the next reader takes the task for finished.

Filing the remainder is what lets you close. It is not Blocked, which is for work you cannot proceed with at all, and not Review, which is for work a person has to look at. Work that went as far as it goes, with the rest named and queued, is Done.

### Committing and pushing

Never end a session with unpushed work. If a file was written or changed, it is committed and pushed before the session ends — work that lives only in a working tree is invisible to Ita and the COO, and dies with the machine. Where it goes depends on the state of the work:

- **Complete and verified** → trunk, however this repo normally lands changes.
- **Incomplete, unverified, or risky** → a feature branch named for the task (`task-<n>-<short-slug>`), pushed.

A pushed feature branch is written into its task the moment it exists: one line in the issue body — `In flight on branch task-<n>-<slug>`. That line is what makes the branch findable from the board or a phone; a branch nobody wrote down is a branch nobody knows to look at. Merge it per this repo's rules when the work lands, delete it when the task closes.

**Commit by path** — `git add <the files you changed> && git commit`, never `-A` or `-a` — because this working tree is shared. Another session's agents, the COO's, or Ita's own may be mid-change in it while you are, and their half-done files look exactly like yours to `git add -A`. For the same reason never run anything that takes the whole tree with it: no `stash`, no switching branches while the tree holds files that are not yours, no `pull --rebase` or `--autostash`, no `reset`, `restore` or `clean`. A plain `git pull` is safe — it refuses rather than overwrites — and if it refuses over a file you did not change, that file is someone's: leave it, work from what you have, and say so. A feature branch is still fine: `git checkout -b` from where you stand carries the dirty files along untouched, and they are no more yours to commit there than on trunk.

### Checks run before the commit, not in GitHub Actions

**Never add a GitHub Actions workflow.** Not a test job, not a lint job, not one that only
runs on pull requests, and not as the automatic half of a check you have just written. The
only workflow this repo has is `mirror-sync.yml`, which copies trunk into the COO's `mirror/`
and wakes nobody — plus, where the repo genuinely deploys somewhere, the workflow that
deploys it. That is the whole list, and adding to it is Ita's call, asked for in advance.

The reason is that a runner here has nobody to report to: one machine, no second contributor,
and — unless this repo has a real deploy target — no production. The entire effect of a red
tick is an email to Ita, and the only thing he can do with that email is paste it back into
an agent. So a fact a script settles in seconds travels through the one person who cannot act
on it, and arrives as an interruption rather than as a check. `theitush/inbar` ran a
unit-suite workflow for three days, and every failure it ever reported was one the committing
agent could have seen thirteen seconds earlier on its own machine (inbar#96, coo#65 — the
same call as coo#59, which deleted coo's own two workflows the day they were added).

A check worth running automatically therefore runs **before the commit exists, on the machine
making it**: a git `pre-commit` hook, tracked in the repo rather than left in `.git/hooks` so
that it is reviewable and it travels, installed per clone with `git config core.hooksPath
<dir>`. It needs no network, no token and no runner, and its failure reaches the agent that
caused it, in that agent's own terminal, while the fix is still one edit away.
`git commit --no-verify` skips it when you mean to. If you think this repo is the exception,
say so and ask — don't push a workflow and find out.

### Staying focused

Work the task you were given, and only it. When something unrelated turns up mid-task — a bug somewhere else, a perf stall, a dead file, a good idea for later — **pin it**: one REST POST in the repo it belongs to, `tools/board add` it, set it to `backlog`, and go straight back to what you were doing. A pin is a title plus three to five lines: where you saw it, the symptom, a one-line hunch, a one-line "done when". Don't chase it, don't name every code path, don't design the fix — that is the job of whoever picks the issue up. The issue is what makes dropping it safe; nothing is lost, so there is never a reason to chase it now.

Related is not a detour. If the thing you found is part of the task, blocks it, or would be broken by the change you are about to make, handle it now — that *is* the task. The test is whether the current task can be finished and be correct without it, not whether it is interesting.

Same rule for scope: the task is what the issue says. Improvements you notice along the way are pins, not extras.

Same rule for the filesystem: **stay inside this repo's directory**. Everything you write — code, scratch files, test output, downloads — lands in this working tree (or your session scratchpad for throwaways), never in `~`, another project's directory, or anywhere else on the machine.

And the tree itself is shared: **you hold what you dirty, and you touch nothing dirty that is not yours.** A file `git status` reports changed that you did not change is someone's work in progress — another session's agent, the COO's, Ita's own — whatever it looks like, and it is not yours to edit, stage, commit or revert. Check the file, not the tree, and check when you first reach for it, not at the start of the task: a check made at the top was accurate when it ran and wrong twenty minutes later (coo#39, 2026-09-01). `git status --short -- <path>` is the whole check — empty means yours, and it stays yours until you commit it. Held? Put your change in a new file; that costs nothing, never goes stale, and ends in a merge rather than a lost edit. Has to be that file? Ask, never guess: `ListAgents` shows the sessions on this machine and `SendMessage` reaches them, and the one working in this tree can say whether the file is its agent's. Nobody alive claims it? It is still not yours — it is Ita's to keep or drop, so tell him.
