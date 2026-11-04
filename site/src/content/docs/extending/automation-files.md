---
title: Automation files
description: An automation is a file in your project that runs a playbook by itself, in one long-running session of its own, with its settings and permissions in the file.
group: Extending
order: 24
---

An automation is one file, `.sova/automations/<id>.json`, in your project. It says when a playbook runs,
and everything that playbook's session may do and runs on.

```json
{
  "id": "nightly-check",
  "label": "Nightly check",
  "when": "daily 02:00",
  "tz": "Europe/Berlin",
  "task": "Check last night's build",
  "playbook": "build-check",
  "session": "long-running",
  "settings": { "model": "provider/model-id", "thinking": "low", "mode": "normal", "minorModes": ["spec"] },
  "permissions": { "remove": ["web"], "oneAtATime": true }
}
```

## What one holds

| Key | Meaning |
|---|---|
| `id` | Required. The file's name without `.json`: lowercase letters, digits and dashes |
| `label` | Required, at most 60 characters. Names it wherever it's shown |
| `when` | Required. The triggers, in the [schedule language](/docs/playbooks-and-schedules/#triggers) |
| `tz` | A time zone such as `Europe/Berlin`. Without it, the host's own zone |
| `task` | The reason in each fired message |
| `playbook` | Required. The id of the project playbook it runs |
| `session` | Required. Today only `long-running`: one session, woken by every fire |
| `settings` | Optional: `model` (`provider/id`), `thinking`, `mode`, `minorModes`, `memory` |
| `permissions` | Optional: `remove`, `grant`, `oneAtATime`, `limits`, `overseerMayStart` |

`settings.mode` is `normal` or `delegate`. `settings.minorModes` is any of `align`, `spec`, `vis` and
`memory`, and names the whole set. What `settings` leaves out stays as the session has it. `settings.memory`
is `{"type": …}`: the summary size stays Settings → Memory's.

`permissions.remove` takes `shell`, `edit`, `workers`, `web`, `worktrees` and `timers`. `permissions.grant`
takes `sessions.read`, `sessions.message` and `sessions.all`, as a session profile's do. `oneAtATime`,
`limits` and `overseerMayStart` are a profile's too.

The file is read strictly: an unknown key or a wrong value makes it invalid, with the exact error, and
it never runs in part.

## What it can't name

- **Create.** Create is chosen in a chat's own mode menu, so `settings.mode` can't be `create`, and the
  file is invalid.
- **A profile.** The session's settings and permissions are in the file.
- **A project mode.** Only the file's built-in minor modes.

## How it differs from a playbook's schedule

| | A playbook's schedule | An automation file |
|---|---|---|
| Where it lives | `when:` in the playbook's header | Its own file |
| What a run is | Whatever its profile says: a new session per fire, or One at a time | One session of its own, woken by every fire |
| Settings and permissions | From the profile it names | In the file |
| Approval covers | Triggers, zone and the profile with its powers | Triggers, zone, playbook, session kind and every permission |

A playbook an automation file runs shows that automation in the Playbooks dialog, and the automation is
what you approve. Its own `when:` line, if any, is no second schedule.

## Approving it

Nothing fires until it's approved, in the Playbooks dialog or the Overseer's **Approvals & Schedules**.
A new one reads **Needs approval**.

The approval covers the triggers, the zone, the playbook's id, the session kind and every permission.
Change any of those and it pauses until you approve it again. Edits to its `settings`, `label` and `task`,
and to the playbook's text, don't ask again.

## When it runs

Sova fires it with no model involved, under the rules of a [schedule](/docs/playbooks-and-schedules/#triggers):
the same triggers, limits and catch-up after a restart.

The first fire starts its session, titled "{label} (automation)". Each later fire applies the file's
`settings` where they differ, then wakes that session. If the session is archived, the next fire starts a
new one. A fire is skipped while the session is open in a terminal. The sessions Sova's schedules run
are listed under **Automations** in the sidebar.

Sova reads the files fresh each time. When a file disappears, an unapproved automation is forgotten, and
an approved one pauses and says the file is gone.
