---
title: Playbooks and schedules
description: A playbook is a written recipe an agent runs. A project's playbook can also run by itself, on a schedule you approve.
group: Features
order: 15
---

A playbook is a recipe in plain Markdown that an agent follows: "audit this repository's accessibility", "write the launch notes", "tidy the stale worktrees". You run one by hand from the composer, or let it run by itself on a schedule.

## Running a playbook

Open the composer's menu and pick **Playbooks**. The dialog lists three groups: the ones Sova ships, your own, and the ones that live in the current session's project. Pick one, add a line of your own if you like, and it goes into the chat as your message. The agent then does what the playbook says, in that chat.

A playbook can bring its own helper files, the way a skill does. A playbook written as a pi or Claude Code skill works as one too. Sova never runs a playbook's scripts itself: the agent runs them, under the session's own sandbox and permissions.

## Schedules

A project's playbook can say when it runs by itself. Its header names the triggers and the profile its runs use. Only a project's playbooks can have a schedule, because a schedule needs a project to run its sessions in.

Sova fires schedules itself, with no model involved. A run that fires reaches a session as a tagged wake-up, never as you. If the playbook's profile runs one session at a time, the run wakes that session, or starts it if none is running. Any other profile starts a new session for each run, titled after the playbook with "(scheduled)" added. A schedule never turns on one of the project's own [project modes](/docs/modes/project-modes/): only you or the Overseer turn one on.

### Triggers

A schedule has one to three triggers:

| Trigger | Fires |
|---|---|
| `daily 09:00`, `weekdays 09:00,18:30`, `weekends 10:00`, `mon,wed,fri 09:00` | At those times, in the schedule's time zone (your machine's, unless it names one) |
| `every 30m`, `every 2h` (1, 2, 3, 4, 6, 8 or 12 hours) | On a fixed grid from midnight, so a restart never shifts it |
| `claude-limit-reset` | When one of your Claude logins comes back from its usage limit: sessions this schedule runs that stopped at that limit are told to carry on |

Thirty minutes is the shortest interval, and a schedule fires at most 48 times a day. Only one run of a schedule is in flight at a time: while the last run is still working, a timed fire is skipped. A session a schedule starts or wakes counts toward the Overseer's limit on sessions working at once, so a fire with no free slot is skipped too. A fire missed while Sova was down runs once at start if it's less than an hour late, and is skipped otherwise.

In the Playbooks dialog a schedule reads in words, for example "Every 6 hours · When a Claude limit resets · Next 12:00 PM".

### Approving a schedule

Nothing fires until you approve it. A new schedule reads **Needs approval** in the Playbooks dialog and in the Overseer's **Approvals & Schedules** (the **Schedules** menu in its header, or the first item of its **⋯** menu on a narrower screen, marked with a dot while a schedule waits), and only your click approves it. The Overseer can't.

Your approval covers exactly what you saw: the triggers, the time zone and the profile with its powers. Change any of those, including adding or removing a trigger, and the schedule pauses until you approve it again. Edits to the playbook's instructions don't ask again: the profile, which the approval covers, decides what a run may do.

You can revoke an approval at any time. A schedule whose runs start sessions nobody opens pauses itself after 10 such runs in a row. A host can have at most 20 approved schedules.

Branches don't land through a schedule: each project's [merge queue](/docs/needs-you/) lands a branch once you press Land or type "land it" in its chat.
