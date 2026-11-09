# Profiles

[← Sova](../README.md)

A profile is one named setup for a chat, in two parts:

- **When a Chat Starts**: the mode and add-on modes a chat starts in, which of the default tools it
  loses, which session powers it gains, One at a time, the limits on its sends, a first message, and
  whether the Overseer may start it. This part is fixed once the chat's first message is sent.
- **Models**: the chat's own model and effort, and the models of its helpers: Delegate's four work
  kinds, the team coordinator, monitor and members default, the spec writer and the reviewer, with
  the alignment settings. A chat can switch this part at any time, all at once.

There is one list of profiles, one Settings tab that edits them (**Settings → Profiles**; there is no
Subagents tab), and one default per computer that decides what a new chat starts with.

## One list, saved as two halves

No new file holds a profile. Each profile is saved as two halves that already existed before
profiles were joined, linked by id:

| Half | Where | Holds |
|---|---|---|
| The session profile | `session-profiles.json` in Sova's state folder (yours), or `<project>/.sova/profiles/<id>.json` (a project's) | When a Chat Starts, and the chat's own `model` and `thinking` |
| The helper library | `subagent-profiles.json` in pi's agent folder | Delegate's routes, teams, spec writer, reviewer, alignment settings |

The session profile's `subagents` field names its library profile: that link is what makes the two
one profile.

- **A pair is one profile**, under the session profile's name. Its id is the session profile's id.
- **A library profile no session profile links to** is still a profile, with only a Models part. Its
  id is its library id. A chat on it keeps its own model and modes and takes these helpers.
- **A session profile with no link** is still a profile; a chat on it takes its helpers from this
  computer's default.
- **A library profile linked by more than one profile** is shared: the editor says "Also used by
  {name}", and an edit changes it for each. Deleting one of them keeps the library half the others
  still link.

Settings → Profiles writes each half through its own writer, only when that half changed. A new
profile creates both halves, linked; a rename renames both. Nothing is rewritten when Sova starts,
and nothing is converted: an older Sova on another device keeps its Subagents tab and reads the same
two files.

## Where they come from

| Group | Where | Notes |
|---|---|---|
| **Yours** | `session-profiles.json` (and its library halves) | `{"version": 1, "profiles": [...]}`. Every folder can use them. Edited in Settings → Profiles. With the mesh on, the file syncs to your other devices (the newest edit wins) |
| **This project** | `<project>/.sova/profiles/<id>.json` | Committed with the project. One file per profile. Read-only in Settings: you or an agent change the file |
| **Built in** | Off | Sets nothing (below) |

**The project** is the repository's main checkout. A session in a worktree or a subfolder of the
repository uses the main checkout's `.sova/profiles/`, so a profile changed on a branch takes effect
once it is merged. A folder outside git is its own project.

In a project's folder, the file's name must be its `id` plus `.json`. A file with a mistake is
skipped and shown in Settings → Profiles with the exact error. The others still load.

## Off

**Off** is built in, first in every list, and can't be edited or deleted. It sets nothing in either
part: a chat on it keeps its own model and modes, and the agent picks every worker. It is what the
new chat screen's old **My settings** card was. Off can be the default.

## One default per computer

Each computer has one default profile. A new chat's empty screen opens with it picked, and so does
every chat Sova starts with no profile named: New Session, a project's coding sessions (where a
project's own coding model, if it has one, is still the session's model) and an Overseer start that
names none.

- **Choose it** with **Make Default** in Settings → Profiles, or **Make {name} the Default** in a
  chat's mode menu. Nothing else moves it: picks, switches, model changes and Overseer calls change
  only that chat.
- It is kept in `default-profile.json` in Sova's state folder, `{"version": 1, "profile": "<id or
  off>"}`. It never syncs: each computer keeps its own.
- Choosing a default also writes the older default files (the default mode in `mode.json`, the
  new-session model in `defaults.json`, and `subagent-profiles-default.json`), so the terminal and an
  older Sova keep reading the default they always did.
- Until you choose one, the default is the profile linking your saved default subagent profile, else
  Off.
- You can't delete the default: make another one the default first.

## Switching a chat's profile

The mode menu's **Profile · {name}** row opens a picker of every profile the chat can use. Picking
one switches the chat's whole Models part: its own model and effort (where the profile sets them),
its helpers and the alignment settings. Tools, session powers and modes stay as the chat has them.

- **All or nothing.** Before anything is written, the new model is checked as a composer pick is: it
  is a model here, Settings → Models allows it, and this computer has credentials for it. If any
  check fails, nothing switches, and the menu says why. A chat is never left with its helpers on the
  new profile and its own model on the old one.
- **While a reply runs**, the switch waits for the reply to end, then applies, with **Cancel Switch**
  until then.
- It works across backends: a Claude Code chat can switch to an OpenAI Codex or pi model and continue
  the same conversation, and back.
- After a usage limit, the row under the error offers up to two of your profiles that use no model
  of the exhausted provider: **Switch This Chat to {name}** does the same switch.

## "(edited)"

Choosing another model in the composer keeps the chat's profile picked and marks it edited: the mode
menu reads "{name} (edited)", for example "Claude (edited)". It reads so while the chat's model isn't
the one its profile sets; choosing that model again, or picking the profile again, clears it. An edit
changes no helper, no profile and not the default. The usage-limit row judges the model the chat
actually runs.

## The session profile's format

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
  "model": "claude-code-cli/claude-opus-5-5",
  "thinking": "high",
  "subagents": "claude-team",
  "overseerMayStart": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits and dashes, up to 63 characters |
| `label` | yes | The profile's name, up to 60 characters |
| `icon` | no | `grid`, `eye`, `network`, `branch`, `wrench`, `shield`, `search`, `terminal`, `bulb` or `building` (default `wrench`) |
| `description` | no | One line under the name |
| `remove` | no | Capabilities it loses (below). Removing any but `mcp` also removes `workers`; removing only `mcp` leaves Workers alone |
| `grant` | no | Session powers it gains (below). `sessions.message` and `sessions.all` also grant `sessions.read` |
| `singleton` | no | `true`: **One at a time**, at most 1 live session per profile (per project for a project's profile) |
| `limits` | no | Any of `hops` (3), `perMessage` (10), `perDay` (40), `targetsPerRun` (5), `perPair` (6): whole numbers from 1 |
| `mode` | no | `normal` or `delegate`: the mode it starts in. `create` is an error: Create is chosen in a chat |
| `minorModes` | no | The whole set of add-on modes it starts with, any of `align`, `spec` and `vis`. `[]` starts with none. Absent: the default in `mode.json` |
| `model` | no | `"provider/model"`: the chat's own model (Models part) |
| `thinking` | no | The chat's own effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `subagents` | no | The id of its library profile, or `"off"`: the link to its helpers. Absent: this computer's default helpers |
| `firstMessage` | no | Text put in an empty message box |
| `overseerMayStart` | no | `true`: the Overseer may start a session with it |

Any other field is an error, and so is an unknown capability name. A `playbook` key, which older
Sova wrote, is ignored.

**Removable** (`remove`): `shell` (bash), `edit` (edit, write), `workers` (subagents and teams),
`web` (search and fetch), `worktrees`, `timers` (wake-ups), `mcp` (the chat's MCP servers).

**Grantable** (`grant`): `sessions.read` (list and read other sessions), `sessions.message` (send
them messages), `sessions.all` (see every session on this host, not just this project's).

## The Overseer

The Overseer's `sova_list_profiles` (also named `sova_list_subagent_profiles`) lists Off and every
profile, with its id, name, footprint, which parts it has, whether the Overseer may start it and
which is the default. `sova_create_session` takes a `profile` id and starts the session on it, both
parts; a profile with a When a Chat Starts part needs `overseerMayStart` (and, from a project, your
approval), one with only a Models part needs neither. `sova_set_session` takes `profile` and
switches only that chat's Models part, so it never changes a chat's tools or powers.
`subagent_profile` is still taken on both and switches only the helpers. No Overseer call moves the
default.

## Approving a project's profile

A project profile that grants a session power, or that the Overseer may start, needs your approval
once before it is used, and again whenever those powers grow. Approve it on the picker or in
Settings → Profiles. Approvals are kept in `profile-trust.json` in Sova's state folder, outside every
repository. A profile that only removes things, or only sets models, needs none.

While the shell is kept, removals are guardrails, not a boundary: a shell can still change files and
call Sova's API.
