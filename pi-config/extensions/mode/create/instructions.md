# instructions: standing rules every chat in a folder, or on this computer, follows

Recommend `AGENTS.md`: for a project in its own folder, for this computer in the agent dir. The base prompt is for the rare rule that must sit above everything else.

A rule at or above a chat's folder reaches new chats only: it can't show in this chat. One in a folder below it loads as the chat works there. A Project Overseer reads only the files inside its project, and a gathering chat and the Project Assistant read none. There's no way to give the Project Assistant instructions here.

## Rules for a folder

- Change: rules for every chat in a folder and anything below it.
- Lives: `<folder>/AGENTS.md` or `<folder>/CLAUDE.md`. A chat reads the one in its own folder and each parent's. `AGENTS.override.md` replaces those two, in that folder only.
- Approves: the person, by Land.
- By: Land. In a folder that isn't in Git, say the change is made by hand.
- Live: new chat, after landing.
- Check: a new chat's setup card lists the file under Context.

```markdown
# Rules
- Run the tests before saying a change is done.
- Never commit generated files.
```

## Rules for one part of a project

- Change: rules that apply only while the agent works in one subfolder.
- Lives: `<project>/<subfolder>/AGENTS.md` or `CLAUDE.md`. Folders named `node_modules` or starting with `.` are skipped. It's always on: there's no setting.
- Approves: the person, by Land.
- By: Land. In a folder that isn't in Git, say the change is made by hand.
- Live: after landing, the first time a chat or worker reads, edits or creates a file in that folder. Bash, grep, find and ls don't load it. It loads again after a compaction.
- Check: once it has loaded, the session pane's Context tab lists the file.

## Rules for this computer

- Change: rules for every chat on this computer, in any folder.
- Lives: `<agent dir>/AGENTS.md`. Resolve links first, and show any existing rules beside the addition.
- Approves: the person, by their OK on the whole change.
- By: OK. It stays on this computer.
- Live: new chat.
- Check: a new chat's setup card lists the file under Context.

## Additions to the base prompt

- Change: text added to the system prompt itself, for this computer or one project.
- Lives: `<agent dir>/APPEND_SYSTEM.md`, or `<project>/.pi/APPEND_SYSTEM.md`. A project's file wins over the agent dir's; the two aren't combined.
- Approves: the person, by their OK, or by Land for a project's.
- By: OK or Land. OK for this computer, Land for a project. Say that the setup card doesn't show or switch this file.
- Live: new chat.
- Check: ask a new chat to repeat the rule.

## Replacing the base prompt

- Change: the whole system prompt, with `SYSTEM.md` in the same two places. Offer it only if asked, and say it drops pi's default prompt entirely.
- Lives: `<agent dir>/SYSTEM.md`, or `<project>/.pi/SYSTEM.md`.
- Approves: the person, by their OK, or by Land for a project's.
- By: OK or Land. OK for this computer, Land for a project.
- Live: new chat.
- Check: a new chat follows it.

## Leaving a rule or skill out of one chat

- Change: switch off one context file or skill for one chat.
- Lives: that chat's setup card. Nothing is remembered for the next chat, and workers ignore it.
- Approves: the person, by flipping the switch.
- By: Screen. The switches on the empty chat's setup card, before the first message only.
- Live: now.
- Check: the row reads off, and the total above it drops.
