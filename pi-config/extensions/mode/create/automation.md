# automation: recipes you run by hand, or that run by themselves

A recipe the person runs by hand is a playbook: the `playbooks` topic says how one is made and saved. This topic is for a project's playbook that runs by itself: recommend an automation file, which names its own model, mode and permissions. A schedule in a playbook's head lines is the older way, kept working for the ones that exist; repeats from a playbook's card will replace it. For something that runs by itself after every reply in one project, see Reply hooks in the `modes` topic: no schedule does that.

Schedules and automation files need a project in Git. In a project with no merge queue the same branch is the person's to merge; in a folder that isn't in Git they're made by hand. In a folder that isn't a project they need Add as Project (the `project` topic). They count once they are on the project's main branch: a branch's copy does nothing.

## Schedules

- Change: when a project playbook runs by itself, with which profile. Keys in its head: `when:` (`daily 09:00`, `weekdays 09:00,17:00`, `weekends 10:00`, `mon,wed,fri 09:00`, `every 30m`, `every 2h`, `claude-limit-reset`; up to 3 joined by `;`), `profile:` (required), `tz:` and `task:`. A schedule in the person's own playbooks is ignored.
- Lives: the head of the project's `PLAYBOOK.md`. Its approval lives on this computer, outside every repository.
- Approves: only the person's own click in the page: Approve in the Playbooks dialog, or Apply and Approve on the card. A schedule on another of their computers can be approved from this page too. A change to `when:`, `tz:` or the profile pauses it until it's approved again. Edits to the instructions and to `task:` never ask again.
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
- Approves: only the person's own click in the page: Approve in the Playbooks dialog. It asks again when the triggers, zone, playbook, session kind or permissions change, not for settings, label, task or the playbook's text.
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
