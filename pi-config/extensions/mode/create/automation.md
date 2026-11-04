# automation: recipes you run by hand, or that run by themselves

<!-- q10 is open: Approves lines say where the person approves, never that nobody else can. Don't say a schedule on another computer must be approved on that computer's page. -->
Recommend a playbook for a recipe the person runs by hand. For one that runs by itself, recommend a schedule on a playbook when an existing profile fits, and an automation file when the run needs its own model, mode or permissions.

A project's playbooks, schedules and automation files need a project in Git. In a project with no merge queue the same branch is the person's to merge; in a folder that isn't in Git they're made by hand. In a folder that isn't a project, the person's own playbooks still work, and the project-only things need Add as Project (the `project` topic). A project's playbooks and automations count once they are on its main branch: a branch's copy does nothing.

## Your own playbooks

- Change: a recipe available in all the person's chats on this computer, optionally replacing a shipped one with the same id.
- Lives: `playbooks/<id>/PLAYBOOK.md` in the person's Sova state folder. The id is lowercase letters, digits and dashes. Files the entry names sit beside it, and relative paths in it resolve against its own folder.
- Approves: the person, by their OK on the whole file.
- By: OK. Show the path and the whole file first.
- Live: now: the Playbooks dialog reads the folder each time it opens. It doesn't spread to other computers.
- Check: the composer's plus, Playbooks, lists it under Yours.

The entry's head is `key: value` lines, one line each, not YAML. Sova reads `title`, `name`, `description` and `promptHint`:

```markdown
---
title: Weekly tidy
description: Clear finished worktrees and report what's left.
---
List this project's worktrees. For each finished one, say what's left in it.
```

## A project's playbooks

- Change: a recipe for everyone on the project.
- Lives: `.sova/playbooks/<id>/PLAYBOOK.md` in the project, the same grammar. A folder written as a skill, with `SKILL.md`, works too. Sova never runs a playbook's scripts: the agent runs them under the chat's own permissions.
- Approves: the person, by Land or Apply.
- By: Land or Card. Land when it has more than its one `PLAYBOOK.md`. The card is the `playbook` setting, with its id and the file's text.
- Live: after landing, or once the card is applied, the next time the Playbooks dialog opens.
- Check: the Playbooks dialog lists it under This project.

## Schedules

- Change: when a project playbook runs by itself, with which profile. Keys in its head: `when:` (`daily 09:00`, `weekdays 09:00,17:00`, `weekends 10:00`, `mon,wed,fri 09:00`, `every 30m`, `every 2h`, `claude-limit-reset`; up to 3 joined by `;`), `profile:` (required), `tz:` and `task:`. A schedule in the person's own playbooks is ignored.
- Lives: the head of the project's `PLAYBOOK.md`. Its approval lives on this computer, outside every repository.
- Approves: the person, with Approve in the Playbooks dialog, or Apply and Approve on the card. A change to `when:`, `tz:` or the profile pauses it until it's approved again. Edits to the instructions and to `task:` never ask again.
- By: Land or Card. The card is the `playbook` setting.
- Live: after it's on the main branch and approved, from its next time. Nothing fires unapproved. 30 minutes is the shortest interval, and a schedule fires at most 48 times a day.
- Check: the Playbooks dialog shows its state and next run; its sessions show under Automations in the session list. After 10 runs nobody opened, it pauses.

Add to the playbook's head:

```markdown
when: weekdays 09:00
profile: reviewer
tz: Europe/Berlin
task: Review yesterday's work
```

## Automation files

- Change: a schedule that keeps one long-running session, woken by each fire, with that session's own settings and permissions in the file instead of a profile.
- Lives: `.sova/automations/<id>.json` in the project, the file's name being its `id`. Keys: `id`, `label`, `when`, `tz`, `task`, `playbook`, `session` (only `long-running`), `settings` (`model`, `thinking`, `mode`, `minorModes`, `memory`) and `permissions` (`remove`, `grant`, `oneAtATime`, `limits`, `overseerMayStart`). It's parsed strictly. `settings.mode` is `normal` or `delegate`: Create is chosen in each chat, so an automation can't name it.
- Approves: the person, with Approve in the Playbooks dialog. It asks again when the triggers, zone, playbook, session kind or permissions change, not for settings, label, task or the playbook's text.
- By: Land. No card holds an automation file.
- Live: after landing and approval, from its next time.
- Check: the Playbooks dialog shows it, or the exact error if the file is wrong; its session shows under Automations in the session list.

It runs a playbook the project already has:

```json
{
  "id": "nightly-check",
  "label": "Nightly check",
  "when": "daily 02:00",
  "playbook": "nightly-check",
  "session": "long-running",
  "settings": {"mode": "normal"}
}
```

## Stopping a schedule

- Change: whether an approved schedule keeps firing.
- Lives: this computer's list of approvals.
- Approves: the person.
- By: Screen. The Playbooks dialog, or Approvals & Schedules on the Overseer's page.
- Live: now: the next tick fires nothing.
- Check: it reads Needs approval again for as long as the file declares it.
