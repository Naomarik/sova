# Session profiles

[← Sova](../README.md)

A profile says what one session can do: which of the default tools it loses, and which session
powers it gains. You pick one on a new session's empty screen. It is fixed once the first message
is sent.

Profiles are files. Sova lists them and never writes them: you or an agent add and change them.
**Settings → Profiles** shows every profile the open session's folder can use, with each file's path
and any mistake in it.

## Where they live

| Group | Where | Notes |
|---|---|---|
| **Built in** | `profiles/<id>.json` in Sova | Default (in code, changes nothing), Read-only reviewer, Mini overseer |
| **This project** | `<project>/.sova/profiles/<id>.json` | Committed with the project. One file per profile |
| **Yours** | `~/.pi/agent/sova/session-profiles.json` | `{"version": 1, "profiles": [...]}`. Every folder can use them. One of yours replaces a built-in one of the same id |

**The project** is the repository's main checkout. A session in a worktree or a subfolder of the
repository uses the main checkout's `.sova/profiles/` and `.sova/playbooks/`. So a profile changed on
a branch takes effect once it is merged. A folder outside git is its own project.

In a project's folder, the file's name must be its `id` plus `.json`. A file with a mistake is
skipped and shown in Settings → Profiles with the exact error. The others still load.

## The format

```json
{
  "id": "release-checker",
  "label": "Release checker",
  "icon": "branch",
  "description": "Checks branches before a release. Can't browse the web.",
  "remove": ["web"],
  "grant": ["sessions.read", "sessions.message"],
  "singleton": true,
  "limits": { "targetsPerRun": 10, "perDay": 80 },
  "playbook": "release-check",
  "overseerMayStart": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits and dashes, up to 63 characters |
| `label` | yes | The name the picker shows, up to 60 characters |
| `icon` | no | `grid`, `eye`, `network`, `branch`, `wrench`, `shield`, `search`, `terminal`, `bulb` or `building` (default `wrench`) |
| `description` | no | One line under the name |
| `remove` | no | Capabilities it loses (below). Removing anything also removes `workers` |
| `grant` | no | Session powers it gains (below). `sessions.message` and `sessions.all` also grant `sessions.read` |
| `singleton` | no | `true`: **One at a time**, at most 1 live session per profile (per project for a project's profile) |
| `limits` | no | Any of `hops` (3), `perMessage` (10), `perDay` (40), `targetsPerRun` (5), `perPair` (6): whole numbers from 1 |
| `mode` | no | `normal` or `delegate`: the mode it starts in |
| `model` | no | `"provider/model"`: the model it starts on |
| `firstMessage` | no | Text put in an empty message box |
| `playbook` | no | A playbook's id. The empty screen offers **Run Playbook** for it, and the Overseer sends it as the first message |
| `overseerMayStart` | no | `true`: the Overseer may start a session with it |

Any other field is an error, and so is an unknown capability name.

**Removable** (`remove`): `shell` (bash), `edit` (edit, write), `workers` (subagents and teams),
`web` (search and fetch), `worktrees`, `links` (mesh links), `timers` (wake-ups).

**Grantable** (`grant`): `sessions.read` (list and read other sessions), `sessions.message` (send
them messages), `sessions.all` (see every session on this host, not just this project's).

## Approving a project's profile

A project profile that grants a session power, or that the Overseer may start, needs your approval
once before it is used, and again whenever those powers grow. Approve it on the picker or in
Settings → Profiles. Approvals are kept in `~/.pi/agent/sova/profile-trust.json`, outside every
repository. A profile that only removes things needs none.

While the shell is kept, removals are guardrails, not a boundary: a shell can still change files and
call Sova's API.
