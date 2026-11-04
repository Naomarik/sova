# profiles: named kinds of chat, what each may and may not do

Recommend a profile of the person's own for "start like this"; a project's when the whole project should have it. A session profile isn't a subagent profile: for worker models, see `workers`.

A profile is chosen on a new chat's empty screen and fixed at the first message. It can't name Create: a profile whose `mode` is `create` doesn't parse.

Removing tools is a guardrail, not a boundary, while the chat keeps `shell`. Removal goes by group: a profile can't drop one add-on's tool.

## Your own profiles

- Change: a named starting point, in every folder: its model, effort, subagents, modes, what it loses and what it gains.
- Lives: `<agent dir>/sova/session-profiles.json`, as `{"version": 1, "profiles": [...]}`.
- Approves: the person, by their OK on the whole change.
- By: Screen or OK. Save Current As Profile on a new chat's screen saves its model, effort and subagent profile. For anything more, show the whole file and wait for OK. With sync on, say first that the whole file reaches other computers that may read their sessions, and that the newest edit wins.
- Live: new chat. A chat keeps the copy it started from.
- Check: it's a card on a new chat's empty screen. Settings → Profiles shows each file's path and any mistake in it.

## A project's profiles

- Change: a profile every chat in a project can pick.
- Lives: `<project>/.sova/profiles/<id>.json`, always in the main checkout, one file per profile, named after its `id`. A chat in a worktree reads the main checkout's, so a branch's edit counts only once it's on the main branch.
- Approves: the person. A profile that only removes needs nothing more. One that grants a power or sets `overseerMayStart` also needs their Approve; widening it asks again.
- By: Card or Land. Card for one profile, which Apply and Approve can approve with it.
- Live: new chat, once it's on the main branch.
- Check: it's a card on a new chat's empty screen in the project, and any mistake shows in Settings → Profiles. A file with a mistake is skipped; the others still load.

```json
{
  "id": "docs-writer",
  "label": "Docs writer",
  "icon": "bulb",
  "description": "Writes docs. Starts no workers.",
  "remove": ["workers", "web"],
  "minorModes": ["align"],
  "thinking": "medium"
}
```

Required: `id` (lowercase, digits and dashes, up to 63) and `label` (up to 60). `icon`: `grid eye network branch wrench shield search terminal bulb building`. `remove`: `shell edit workers web worktrees timers`; removing anything also removes `workers`. `grant`: `sessions.read sessions.message sessions.all`. `limits`: any of `hops perMessage perDay targetsPerRun perPair`, whole numbers from 1. `mode`: `normal` or `delegate`. `minorModes`: the whole set, any of `align spec vis`. `model`: `provider/model`. `thinking`: `off minimal low medium high xhigh max`. `subagents`: a subagent profile's id, or `off`. Also `singleton` (at most one live chat), `firstMessage` and `overseerMayStart`. Any other field is an error. An own profile keeps the same shape inside the `profiles` list.

## Hiding a profile

- Change: whether a profile shows in the picker.
- Lives: Settings → Profiles.
- Approves: the person, by clicking.
- By: Screen. Settings → Profiles, Hide From Picker.
- Live: now.
- Check: the card is gone from a new chat's screen.

## One profile dropping one tool

- Change: nothing: a profile can remove a group of tools, not a single tool an add-on brings.
- Lives: nowhere.
- Approves: nobody: there's nothing to approve.
- By: None. The nearest way is removing the whole group, or leaving the add-on out of `pi-extensions`.
- Live: never, today.
- Check: there's nothing to check.
