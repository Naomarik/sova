# Session profiles

[← Sova](../README.md)

A profile says what one session can do: which of the default tools it loses, which session powers
it gains, and, if you like, which model, effort and subagents it starts with. You pick one with a
click on a new session's empty screen, where each profile is a card. It is fixed once the first
message is sent.

Profiles are files: you or an agent add and change them. Sova writes only one thing itself: **Save
Current As Profile**, on a new session's screen, adds that session's model, effort and subagent
profile to yours as a new profile. It never writes a built-in or project file.
**Settings → Profiles** shows every profile the open session's folder can use, with each file's path
and any mistake in it.

## Where they live

| Group | Where | Notes |
|---|---|---|
| **Built in** | `profiles/<id>.json` in Sova | Default (in code, changes nothing), Read-only reviewer, Mini overseer |
| **This project** | `<project>/.sova/profiles/<id>.json` | Committed with the project. One file per profile |
| **Yours** | `~/.pi/agent/sova/session-profiles.json` | `{"version": 1, "profiles": [...]}`. Every folder can use them. One of yours replaces a built-in one of the same id. With the mesh on, the whole file syncs to your other devices (the newest edit wins) |

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
| `minorModes` | no | The whole set of minor modes it starts with, any of `align`, `spec`, `vis` and `codemode`, in any order. `[]` starts with none. Absent: the default in `mode.json`. Picking a profile without it after one that had it puts the default back |
| `model` | no | `"provider/model"`: the model the main thread starts on |
| `thinking` | no | The main thread's effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `subagents` | no | A subagent profile's id (Settings → Subagents), or `"off"`: what its workers, teams and spec writer use. Absent: this device's default |
| `firstMessage` | no | Text put in an empty message box |
| `playbook` | no | A playbook's id. The empty screen offers **Run Playbook** for it, and the Overseer sends it as the first message |
| `overseerMayStart` | no | `true`: the Overseer may start a session with it |

Any other field is an error, and so is an unknown capability name.

**Removable** (`remove`): `shell` (bash), `edit` (edit, write), `workers` (subagents and teams),
`web` (search and fetch), `worktrees`, `links` (mesh links), `timers` (wake-ups).

**Grantable** (`grant`): `sessions.read` (list and read other sessions), `sessions.message` (send
them messages), `sessions.all` (see every session on this host, not just this project's).

## Model, effort and subagents

A profile can be nothing but a starting point: which model the session talks to, how hard it thinks,
and which subagent profile its workers use. Such a profile changes no tools, so the sidebar's
Profiles shelf leaves its sessions out; they show in Recent like any other session. Three examples
for `session-profiles.json` (the subagent ids are the ones in your Settings → Subagents):

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "claude-session",
      "label": "Claude session",
      "description": "Opus on the main thread; Claude subagents.",
      "model": "claude-code-cli/claude-opus-5-5",
      "thinking": "high",
      "subagents": "claude-team"
    },
    {
      "id": "claude-openai-subagents",
      "label": "Claude + OpenAI subagents",
      "model": "claude-code-cli/claude-opus-5-5",
      "thinking": "medium",
      "subagents": "openai-team"
    },
    {
      "id": "deepseek-main",
      "label": "DeepSeek main + Claude subagents",
      "icon": "bulb",
      "model": "deepseek/deepseek-chat",
      "thinking": "off",
      "subagents": "claude-team"
    }
  ]
}
```

A card shows what it sets on one line: "Opus 5.5 · high · subagents: Opus 5.5 · Sonnet 5.5". A card
whose model is turned off in Settings → Models, has no credentials on this device, or names a
subagent profile this device doesn't have is shown disabled with the reason, and can't be picked.

Picking one sets the session's model, effort and subagent profile at once; none of them becomes
the default for new sessions. Picking Default (or a profile that doesn't set them) afterwards puts
back the new-session model and effort, and this device's default subagent profile.

## Approving a project's profile

A project profile that grants a session power, or that the Overseer may start, needs your approval
once before it is used, and again whenever those powers grow. Approve it on the picker or in
Settings → Profiles. Approvals are kept in `~/.pi/agent/sova/profile-trust.json`, outside every
repository. A profile that only removes things needs none.

While the shell is kept, removals are guardrails, not a boundary: a shell can still change files and
call Sova's API.
