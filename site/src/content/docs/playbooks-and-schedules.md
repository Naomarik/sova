---
title: Playbooks and schedules
description: A playbook is a written recipe an agent runs. A project's playbook can also run by itself, on a schedule you approve, and the Merge round shows what that looks like.
group: Features
order: 15
---

A playbook is a recipe in plain Markdown that an agent follows: "audit this repository's accessibility", "write the launch notes", "land the finished branches". You run one by hand from the composer, or let it run by itself on a schedule.

## Running a playbook

Open the composer's menu and pick **Playbooks**. The dialog lists three groups: the ones Sova ships, your own, and the ones that live in the current session's project. Pick one, add a line of your own if you like, and it goes into the chat as your message. The agent then does what the playbook says, in that chat.

A playbook can bring its own helper files, the way a skill does. A playbook written as a pi or Claude Code skill works as one too.

## Schedules

A project's playbook can say when it runs by itself. Its header names the triggers and the profile its runs use. Only a project's playbooks can have a schedule, because a schedule needs a project to run its sessions in.

Sova fires schedules itself, with no model involved. A run that fires reaches a session as a tagged wake-up, never as you. If the playbook's profile runs one session at a time, the run wakes that session, or starts it if none is running. Any other profile starts a new session for each run, titled after the playbook with "(scheduled)" added.

### Triggers

A schedule has one to three triggers:

| Trigger | Fires |
|---|---|
| `daily 09:00`, `weekdays 09:00,18:30`, `weekends 10:00`, `mon,wed,fri 09:00` | At those times, in the schedule's time zone (your machine's, unless it names one) |
| `every 30m`, `every 2h` (1, 2, 3, 4, 6, 8 or 12 hours) | On a fixed grid from midnight, so a restart never shifts it |
| `claude-limit-reset` | When one of your Claude logins comes back from its usage limit: sessions this schedule runs that stopped at that limit are told to carry on |
| `merge-ready` | When a branch in the project turns ready to merge and its owner is idle |

Thirty minutes is the shortest interval, and a schedule fires at most 48 times a day. Only one run of a schedule is in flight at a time: while the last run is still working, a timed fire is skipped, and a `merge-ready` fire waits until that run is done.

A `merge-ready` fire also waits until at least 30 minutes have passed since the schedule last fired for any reason. Branches that turn ready in the meantime are collected and named together in the next fire, so a run of finished branches wakes the session once, not once per branch. It never uses up the day's last fires that the schedule's timed triggers might need, so a backstop such as `every 6h` still runs.

In the Playbooks dialog a schedule reads in words, for example "When a branch is ready to merge · Every 6 hours · Next 12:00 PM".

### Approving a schedule

Nothing fires until you approve it. A new schedule reads **Needs approval** in the Playbooks dialog and on the Overseer's permits chip, and only your click approves it. The Overseer can't.

Your approval covers exactly what you saw: the triggers, the time zone and the profile with its powers. Change any of those, including adding or removing a trigger, and the schedule pauses until you approve it again. Edits to the playbook's instructions don't ask again: the profile, which the approval covers, decides what a run may do.

You can revoke an approval at any time. A schedule whose runs start sessions nobody opens pauses itself after ten such runs.

## Example: the Merge round

Sova's own repository ships a playbook called **Merge round**. It runs as the **Merge captain** profile, one session at a time, and lands other sessions' finished branches on master one at a time: it checks each branch, merges it, pushes it, and restarts the live server when that's safe. Its schedule is:

```
merge-ready; every 6h; claude-limit-reset
```

So the captain wakes when a branch is ready to merge, every six hours anyway, and after a Claude limit resets if it stopped at one.

### The merge board

Sova already works out, for every worktree a session tracks, whether it's ready to merge. That's the chip in the Session tab and the light in the sidebar, worked out from git and the session with no model involved. Sova also keeps that view on a merge board: each branch, its readiness, the session that owns it, and whether that session is idle, busy or archived. The captain reads the board instead of guessing from session titles, so it sees every branch Sova's sidebar shows as ready.

"Ready to merge" covers both chips you see in Sova: **Ready to merge**, and **Waiting for your OK**. The second one means the owner's last reply asks for the go-ahead.

Right after Sova restarts it may not have read every session yet. The board says so, and the captain treats a branch it can't place yet as unknown, never as "nobody owns this".

### Asking the owner

Before landing any branch, the captain asks the session that owns it whether the branch is ready at its current head. It asks only when that session is idle. A busy owner is asked on a later round. The owner answers on the captain's own topic, and only an answer naming the branch's current commit counts.

"Waiting for your OK" means ask the owner. The owner's answer is the OK. A branch whose owner confirms it, and that passes every check, lands and is pushed without bothering you.

### What comes to you

You hear about a branch when nobody else can answer for it:

- **Owner archived, your call.** The only session that tracked it is archived.
- **No session tracks this worktree, your call.** No session owns it at all.

Each is in the round's report once, not every round. The captain lands such a branch only when you say so. Naming a branch to land counts as its owner's go-ahead.

You're also asked before anything that's always your decision: rewriting unpushed history to remove a leaked name, waiving a leak-scan hit, a restart while sessions are busy, or a deploy to another machine.

A round that finds nothing to do reports one line: "Nothing new on the merge board."
