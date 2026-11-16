# automation: recipes you run by hand, or that run by themselves

A playbook, how to make one and how to save it, is the `playbooks` topic. This topic is for a project's playbook that runs by itself: recommend an automation file, which names its own model, mode and permissions.

Until repeats from a playbook's card arrive, a project playbook can also run by itself from a schedule in its `PLAYBOOK.md` head lines (`when:`, `profile:`, `tz:`, `task:`), approved in the Playbooks dialog. That is the current way, not the way forward: don't start new ones unless the person asks, and say repeats will replace it. For something that runs by itself after every reply in one project, see Reply hooks in the `modes` topic: no schedule does that.

Schedules and automation files need a project in Git. In a project with no merge queue the same branch is the person's to merge; in a folder that isn't in Git they're made by hand. In a folder that isn't a project they need Add as Project (the `project` topic). They count once they are on the project's main branch: a branch's copy does nothing.

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
