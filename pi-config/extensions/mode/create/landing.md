# landing: what must pass before a branch reaches your project, and how it lands

A project's branches go through its merge queue once the project is on Sova's Projects list and its checks are set up. Until then the project has no Land, so don't promise it: a branch is the person's own to merge, and you merge it only on their own word in this chat. In a folder that isn't a project, offer Add as Project first (the `project` topic). In a project with no queue, offer Set Up with a Chat. In a folder that isn't in Git there's no landing at all.

Landing a branch is always the person's: Land beside the composer, on the project page's Merge Queue tab, or "land it" typed in the branch's own chat. When they type it, you record it with `worktree land` and the queue does the rest; you never touch the main branch yourself, and you never send anyone those words. The queue reads the target branch's copy of `.sova/project.json`, never the branch's, so a branch that changes its checks is tested by the old ones, and its own take effect once it lands.

A card lands on the main branch with no checks, so a change that fails one turns main red and the next landing fails. When the project has checks, tell the person that before they Apply, every time; if a check could catch the change, choose Land instead.

## First setup

- Change: whether the project has a merge queue, and its first checks: a list of checks, one test command, or "no automated tests".
- Lives: the `merge` section of `.sova/project.json`, created if there's no file yet.
- Approves: the person alone: their answers to the project's Setup chat, then Merge Branch on its branch. First setup is theirs; no card holds it.
- By: Screen. Set Up with a Chat on the project page's Merge Queue tab (or in Settings → Merge Queue) opens the project's Setup chat: it reads the project, measures its commands, asks what it can't find out, draws the plan, writes it on its own branch and runs a trial of that branch's checks. Merge Branch is offered once a trial of the branch's head passed. You never write the section yourself for a first setup: send them to that chat.
- Live: once the branch is merged. The next branch goes through the queue.
- Check: the Merge Queue tab shows the queue, and Land appears on the project's branches.

## Changing the setup

- Change: anything about how branches land, how releases go or how the project ships, beyond the values in the next section.
- Lives: `.sova/project.json` (`merge`, `release`, `deploy`) and the folders they name.
- Approves: the person: Change Setup, their answers, then Land on the Setup chat's branch.
- By: Screen. Change Setup on the Merge Queue tab, the Releases tab or Settings → Merge Queue reopens the same Setup chat; it draws the current setup, marks what changes, trial-runs it, and proposes it on a branch. Land is offered once a trial of that branch's head passed, since the queue checks a branch with the target's checks, not the branch's.
- Live: after landing, from the next landing.
- Check: the Merge Queue tab shows the new checks on the next run.

## Push, review and each check's limits

- Change: whether a landing pushes, whether review runs, and for each check its time limit (at most 30 minutes), whether it reruns only the failed files, and whether it always runs or only when the merge thread picks it.
- Lives: the `merge` section of `.sova/project.json` on the target branch.
- Approves: the person, by Apply on the card, which stands for the confirm on the Settings tab.
- By: Card or Screen. `{setting: "merge-queue", changes}`, on a card of its own. The card goes the same way as Save in Settings → Merge Queue, the same commit and the same refusals, and it isn't checked first. Applied while a branch is checking, it reads "Saves when the current branch finishes." It's refused while the project folder has an uncommitted change. On a project that lands by request, it goes out as a request of its own instead.
- Live: from the next landing, or on a request project once that request merges.
- Check: Settings → Merge Queue shows the value, tagged Project file, with "From {target} at {sha}".

## How a branch lands

- Change: merge locally, a pull request on GitHub, a merge request on GitLab, or push the branch only. Key: `merge.land`, or a choice kept on this computer, which wins.
- Lives: the project's file, shared with everyone on the repository, or this computer.
- Approves: the person alone.
- By: Screen. Settings → Merge Queue, How it lands. It asks where to keep the choice, and it shows what's suggested from `origin`.
- Live: from the next approval. A branch already approved keeps the way it had.
- Check: the row says the way in effect and where it comes from.

## Review and merge thread models

- Change: which model and effort the review and the merge thread run on, for one project.
- Lives: this computer. They never go in the project's file, and they don't spread.
- Approves: the person, by Apply.
- By: Card or Screen. `{setting: "merge-queue", models}`, or Change on Settings → Merge Queue. A model turned off in Settings → Models can't be picked.
- Live: from the next review, or the next fresh merge thread. One running keeps its model.
- Check: Settings → Merge Queue shows the model, or "Same as new chats".

## Check commands, install step and target

- Change: what each check runs, adding or removing a check, the offline install, and the branch the queue lands into. Keys: `merge.checks`, `merge.install`, `merge.target`. A check is `{id, label, run, timeout?, rerun?, requires?, optional?}`, 1 to 30 of them, or `"checks": "none"`.
- Lives: the `merge` section of `.sova/project.json`.
- Approves: the person, by Land.
- By: Land, through Change Setup. Never a card: the project's Setup chat changes the command on its own branch and runs a trial of it, and Land is offered once a trial of that branch's head passed, since the queue checks a branch with the target's checks, not its own.
- Live: after landing, from the next landing.
- Check: the next landing's run shows each check, tagged Required.

The whole section, beside the file's other keys. `run` is a list of arguments, and it may read `${merge.base}`, `${merge.tip}` and `${merge.target}`:

```json
{"merge": {"checks": [{"id": "unit", "label": "Unit tests", "run": ["npm", "test"], "timeout": 600}]}}
```

## Review instructions

- Change: what the reviewer of each landing looks for. Key: `merge.review`, the folder of the project's review kit.
- Lives: a folder in the project such as `.sova/playbooks/review/`, with its instructions and references. It has no `SKILL.md` and sits in no skills folder, so ordinary chats never load it.
- Approves: the person, by Land. Review on or off afterwards is the setting above.
- By: Land. A `merge.review` key in the change turns review on when it lands, with no card: say so first, and have them check the review model, because a review that can't run stops the queue.
- Live: after landing, from the next landing.
- Check: the next landing shows a review, with its chat. Open Folder in Settings → Merge Queue shows the kit as the target has it.

## The merge thread's instructions

- Change: what the merge thread should know about this project.
- Lives: `.sova/playbooks/merge-queue/PLAYBOOK.md` in the project.
- Approves: the person, by Land.
- By: Land.
- Live: after landing. The thread reads the project folder's copy.
- Check: Open Folder on the Merge thread row in Settings → Merge Queue, under "This project's".

## Request instructions

- Change: how a pull or merge request's title and description are written, and the checks they must pass. Key: `merge.request`, the folder of the request kit.
- Lives: a folder such as `.sova/playbooks/request/`: `PLAYBOOK.md`, a `references` folder, and `check*.mjs` files in a `scripts` folder, run in name order.
- Approves: the person, by Land.
- By: Land.
- Live: after landing, for the next request. A project that lands locally never uses it.
- Check: the next request's text follows it. Open Folder in Settings → Merge Queue shows the kit.

## Private names

- Change: the names a push must never carry out of the project.
- Lives: this computer, never committed. It doesn't spread.
- Approves: the person, by answering the merge thread.
- By: None. You can't set them. The merge thread asks in the branch's chat, and until they're set up a push is held.
- Live: from the next push.
- Check: Settings → Merge Queue reads "Set up · {n} names", never the names.
