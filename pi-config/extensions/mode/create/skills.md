# skills: recipes a chat loads when relevant, and reusable slash commands

Recommend a skill when a chat should pick the recipe up by itself and it needs steps or helper files. Recommend a template when the person wants to type a short command for a prompt they repeat. Commands that run code come from add-ons: see `pi-extensions`.

A skill or template reaches new chats only: it can't show in this chat. Project Overseers, gathering chats and the Project Assistant load none. A worker finds its own from its folder.

## Your skills

- Change: a recipe every chat on this computer can load.
- Lives: `<agent dir>/skills/<name>/SKILL.md`, with any helper files beside it. Name a helper by its path from the skill's folder.
- Approves: the person, by their OK on every file.
- By: OK. It stays on this computer. Helper programs run with the chat's own tools.
- Live: new chat.
- Check: a new chat's setup card lists it under Skills, and `/skill:<name>` runs it by force.

```markdown
---
name: release-notes
description: Write release notes from the commits since the last tag. Use when asked for release notes or a changelog.
---

List the commits since the last tag, group them by what a user notices, and leave out internal changes.
```

`name` takes lowercase letters, digits and single hyphens, up to 64 characters, and should match the folder. `description` is required, up to 1024 characters: it's how a chat decides to load the skill, so say what it does and when. `disable-model-invocation: true` keeps it to `/skill:<name>` only.

## A project's skills

- Change: a recipe for chats in one project.
- Lives: `.pi/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md` in the project.
- Approves: the person, by Land.
- By: Land.
- Live: new chat, after landing.
- Check: a new chat in the project lists it under Skills.

## Your slash-command templates

- Change: a `/command` that expands to a prompt, in every chat on this computer.
- Lives: `<agent dir>/prompts/<name>.md`. The file name is the command, and it must sit directly in the folder.
- Approves: the person, by their OK on the whole file.
- By: OK. It stays on this computer. Sova has no screen for templates.
- Live: new chat.
- Check: type `/` in a new chat: it's in the menu, marked `prompt`.

```markdown
---
description: Review staged changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness and error handling}.
```

Arguments: `$1`, `$2`, `$@`, `${1:-default}`.

## A project's slash-command templates

- Change: a `/command` for chats in one project.
- Lives: `.pi/prompts/<name>.md` in the project.
- Approves: the person, by Land.
- By: Land.
- Live: new chat, after landing.
- Check: type `/` in a new chat in the project.
