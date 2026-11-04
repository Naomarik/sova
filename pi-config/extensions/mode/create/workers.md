# workers: which models your workers and teams run on, and named worker personas

<!-- Ids are shared/sova-settings-reference.ts's. -->
A card's edit is `{setting: "sova", id, value}`; call `sova_settings` `reference` with the id for the exact value. Recommend a subagent profile for "which model does what". A persona is for a worker with a standing role. A subagent profile is not a session profile: for named kinds of chat, see `profiles`.

The older files `mode-delegate.json`, `mode-spec.json` and `team-defaults.json` only seed the profile library and stand in when it can't be read. Don't offer them.

## Subagent profiles

- Change: one named set of every model a chat's workers use: Delegate's four kinds of work, each with a fallback; a team's coordinator, monitor and members default; the spec writer; the reviewer; and optionally the chat's alignment settings.
- Lives: `<agent dir>/subagent-profiles.json`. Don't write the file yourself: one mistake sends every chat to the older files.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `workers.profiles`, holding the whole library: read it with `get`, change one profile, keep the rest. Screen: Settings → Subagents, New Profile, Duplicate, or the mode menu's Save Current as Profile, which saves what the chat uses now and isn't offered on Off.
- Live: next turn and next team action. A running worker keeps its model. Each profile reaches their other computers with sync on.
- Check: its row in Settings → Subagents shows the models it routes to.

Each profile in the library is `{id, name, delegate, teams, members, specWriter, reviewer, alignment}`. `delegate` holds `planning`, `investigation`, `routine` and `complex`. Each of those, and `specWriter` and `reviewer`, is `{primary, fallback}`. Each of those is a worker, `{"backend": "claude-code", "model": "claude-haiku-5-5", "effort": "low"}`, or for `fallback`, `null`; on the `pi` backend `model` is `provider/model`. `members` is a worker or `null`. `specWriter` and `reviewer` are `null` for none, and `teams` for no standing coordinator and monitor. To change one role, read the library with `get`, change that key on the profile, and leave the rest as it was.

The reviewer is the worker that does adversarial review: a read-only check of the plan and the diff of risky work in align chats. It runs only while Adversarial review is on under Settings → Alignment (`modes`), so a reviewer set while that's off does nothing yet: say so.

## Which profile a chat uses

- Change: the profile for one chat, or this computer's default for chats that haven't picked one.
- Lives: the chat itself; the default is in `<agent dir>/subagent-profiles-default.json`.
- Approves: the person, by choosing.
- By: Card or Screen. One chat: the mode menu's Subagents row. The default: card `workers.default-profile`, or Make Default in Settings → Subagents.
- Live: next turn and next team action. The default doesn't spread: each computer keeps its own.
- Check: the mode menu's Subagents row names it.

## Which models workers may use

- Change: models a person may use themselves but a worker may not.
- Lives: `<agent dir>/model-policy.json`, as under `models`.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `models.policy`. Screen: Settings → Models, the Subagents switches.
- Live: next worker. Reaches their other computers with sync on.
- Check: starting a worker on that model is refused.

## Named worker personas

- Change: a worker with standing instructions and, optionally, its own model.
- Lives: `<agent dir>/agents/<name>.md`. The folder may not exist yet. The name takes letters, digits, dots, dashes and underscores.
- Approves: the person, by their OK on the whole file.
- By: OK. Show the path and the whole file first. Sova has no screen or list for personas, and they stay on this computer.
- Live: next worker that names it. `agent_spawn` takes it as `agentType`; a missing file fails the spawn. `team_create` and `team_add` refuse `agentType`: give a team member the same words as `systemPrompt`.
- Check: start a worker with that `agentType` and read its first reply. Model policy still applies to its model.

```markdown
---
model: provider/model-id
---
You review database migrations. Name any step that can't be rolled back, and say what would break.
```

## One worker's own tools

- Change: the tools or add-ons one worker gets, for that worker only.
- Lives: nowhere: it's a choice in the spawn, and nothing is kept.
- Approves: the person, by saying so in the chat.
- By: OK. Set `tools` (a list of built-in tools, `[]` for none) or `extensions` (a path, `npm:name` or `git:…` already installed; nothing installs at spawn) when starting the worker. No screen sets this.
- Live: that worker, from its start.
- Check: ask the worker which tools it has.

## How much of the computer workers take

- Change: the priority workers run at. It's a niceness from 0 (not lowered) to 19 (lowest), 10 by default.
- Lives: `workerNice` in `<agent dir>/sova/settings.json`.
- Approves: the person, by Apply.
- By: Card `workers.priority`. An environment setting `SOVA_WORKER_NICE` wins over it.
- Live: next worker. Reaches their other computers with sync on.
- Check: a new worker's process shows that niceness.
