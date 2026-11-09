# modes: what new chats start in, how planning behaves, and modes your project ships

<!-- Ids are shared/sova-settings-reference.ts's. -->
The major modes are a closed list: Sova can't add one, and a project minor mode is the nearest way. Create itself is chosen per chat and can't be a default.

Spec mode's writer is set in a subagent profile (`workers`). `mode-spec.json` is an older file that only seeds the profile library: don't offer it.

For something that should run by itself after every reply in a project, the way is a reply hook, below.

A project mode lives in the checkout, so a chat in a worktree sees its own branch's modes. It never turns itself on: no default, profile or schedule can name one. Chats on a remote machine have none.

## What new chats start in

- Change: the major mode (normal or Delegate), strict and the minor modes new chats start with. Save as default also saves the subagent profile. Strict takes `edit` and `write` from the chat and leaves `bash`: promise no more than that.
- Lives: `<agent dir>/mode.json`. There's no default per project: coding sessions use this one too.
- Approves: the person, by Apply or by pressing it.
- By: Card or Screen. Card `modes.default`, with all three of `{mode, strict, minorModes}`; `mode` is `normal` or `delegate`, and Create is refused because no default holds it. It doesn't set the subagent profile: that's `workers`. Screen: set a chat up as wanted, then press Save as default in its mode menu. In Create that saves the chat's last normal or Delegate choice, so the person should do it from a normal or Delegate chat.
- Live: new chat. The modes reach their other computers with sync on; the subagent profile default stays on this computer.
- Check: open a new chat and read its mode menu.

## How planning behaves

- Change: align's Eagerness (Eager or Careful), its writing style (Project manager, Simplified or Technical) and Visuals.
- Lives: `<agent dir>/mode-align.json`. A subagent profile can override any of them for its chats.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `alignment.style`. Screen: Settings → Alignment.
- Live: next message for Eagerness and style; new chat for Visuals. Reaches their other computers with sync on.
- Check: the tab shows the choice after Save.

## Adversarial review

- Change: a read-only reviewer that checks the plan and the diff of risky work in align chats.
- Lives: `alignment.review` in `<agent dir>/sova/settings.json`. The chat's subagent profile names the reviewer's model.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `alignment.review`. Screen: Settings → Alignment, Adversarial review.
- Live: new chat. Reaches their other computers with sync on.
- Check: the Reviewer row appears in each profile's Models part in Settings → Profiles.

## Memory settings

- Change: which small model summarizes, and how much summary a chat keeps. Memory itself is turned on from a chat's mode menu.
- Lives: `<agent dir>/mode-memory.json`.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `memory`. Screen: Settings → Memory. The default memory type comes from Save as default in the mode menu.
- Live: next summary. It stays on this computer.
- Check: the tab shows the choice after Save.

## A project mode with instructions only

- Change: instructions and reference files a project ships, switched on per chat.
- Lives: `<project>/.sova/minor-modes/<id>/MODE.md`, with reference files beside it. The id takes lowercase letters, digits and hyphens, starts with a letter, runs to 30 characters at most, and can't be `align`, `spec`, `vis`, `memory` or `design`.
- Approves: nobody: a mode with no tools, commands or hooks needs no approval. Someone still has to turn it on in each chat.
- By: Land or Card. Card for `MODE.md` alone; Land when it has reference files.
- Live: after landing, or at once in the worktree of its branch: the mode menu reads the files each time it opens. Once on, the next reply.
- Check: open the mode menu in a chat in that checkout: it's listed under This project. A broken one says why there.

```markdown
---
description: Check a release is ready before tagging it
workers: no
---

Before you tag a release, read checklist.md and go through it item by item.
```

The frontmatter is `key: value` lines, not YAML, and takes only `description` (required), `workers` (`yes` hands the mode to the chat's workers), `tools`, `commands` and `hooks`. Any other key is an error, and so is an empty body. Full guide: /docs/modes/project-modes/.

## A project mode with tools or commands

- Change: a mode that gives the agent a project's own programs. See `tools` for how to declare one.
- Lives: `<project>/.sova/minor-modes/<id>/`, the `tools` and `commands` keys of `MODE.md`, and helper programs beside it.
- Approves: the person, in the mode menu: Approve and Turn On.
- By: Land. A card can't carry helper files.
- Live: after landing and approval, from the chat's next run. A change to any file but `MODE.md`'s body stops the tools until it's turned off and on and approved again. They don't run in a chat with its sandbox On.
- Check: the agent can call `<id>__<name>`, with the id's hyphens as underscores.

## Reply hooks

- Change: a program that runs by itself when a reply starts or ends, in each chat with its project mode on. It only reports: it never blocks, delays or changes a reply, and what it prints never reaches the chat. It's told which chat and when, not what the reply said, and runs at most 10 times in 10 minutes.
- Lives: the `hooks` key of `<project>/.sova/minor-modes/<id>/MODE.md`, and the program beside it.
- Approves: the person, by Approve Hooks in the mode menu. Only their click passes.
- By: Land. Someone must turn the mode on in each chat: nothing does it for a whole project.
- Live: after landing and approval, from the next reply.
- Check: a hook prints nothing into the chat, so have its program write a file, and look for that file after a reply. A failure writes one line to the chat's log. Full guide: /docs/modes/project-modes/.

```markdown
---
description: Spell check after each reply
hooks: [{"on": "turn.ended", "run": ["./check.sh"]}]
---

The spell check runs after each reply and writes its findings to spelling.log.
```

`on` is `turn.started` or `turn.ended`, `run` an argv under the rules of a tool's `command` (see `tools`), `timeoutS` optional, 1 to 600, 30 by default. At most 8 hooks.
