# §chat/skill-sources — Where a chat's skills come from
> Part of the Sova design spec · [overview](../design/overview.md)

A chat is offered skills from pi's own places and from the Claude skills folders a project or a person
already keeps, with nothing to copy or configure. It reads them where they are, and writes nothing
there.

## §chat.skill-sources/starting — Which folders a chat starts with

- **The project's Claude folder.** Every ordinary chat and worker is offered the skills in
  `.claude/skills` in the chat's folder and each folder above it, up to the top of the repository
  (the nearest folder holding `.git`; with none, up to the disk's root), nearest first. These come
  after every place pi finds by itself (`.pi/skills`, `.agents/skills` nearest first, the agent
  folder's `skills`, `~/.agents/skills`, settings paths), so a skill of the same name there wins.
- **The home Claude folder.** The skills placed directly in the Claude config folder's `skills`
  (`$CLAUDE_CONFIG_DIR` unless it is a login's own folder, else `~/.claude`), each a child folder
  holding its own `SKILL.md`. That folder itself is never a place to search: what Claude keeps below
  `skills/.system`, or syncs from claude.ai below `skills/synced`, is not offered, including when a
  chat's folder sits under the home folder and the walk above reaches it.
- **Who gets none.** A chat that loads no skills stays that way: the Overseer, a project overseer, a
  baton's gathering chat, the Project Assistant.
- **Every list agrees.** A chat's own list and the setup card's list for a folder no chat holds
  (§chat.transcript/setup-card-skills) come from the same locations. A file reached by two routes
  shows once.
- **What Claude-only settings do.** A skill's model, allowed tools, forked run, hooks and path
  conditions are ignored: it loads and runs in the current chat with that chat's model and tools.
  Claude plugin skills and Claude's older slash commands aren't loaded. A skill's `!` lines stay text;
  Sova never runs them.

## §chat.skill-sources/rescue — A description with an unquoted colon still loads

A `SKILL.md` whose front matter won't parse only because a plain value holds a character YAML treats
as its own (`description: Date utils: parse and format`) loads anyway, with that value read as the
text it says. The rule is Claude Code's: a plain top-level value containing `: ` or any of
`{}[]*&#!|>%@` and a backtick is taken as a quoted string. A value already quoted, a block marker
(`|`, `>`) and a closed `[…]` or `{…}` list stay as written. Rescue applies wherever the file was
found. `/skill:name` runs a rescued skill too (§chat.skill-sources/arguments).

## §chat.skill-sources/manual-only — A manual-only skill isn't offered

A skill with `disable-model-invocation: true` is never listed to the model, and Sova doesn't say it
is. It still runs by `/skill:name`. The setup card (§chat.transcript/setup-card-skills) and the Context
tab (§app.subagents-pane/context-tab) label it Manual only and leave it out of what they count as
offered.

## §chat.skill-sources/arguments — What `/skill:name` fills in

`/skill:name` with text after it fills in Claude's placeholders in the skill's text before the model
sees it:

- `$ARGUMENTS` is the whole text, and is empty with none.
- `$ARGUMENTS[N]` and `$N` are the Nth word, counting from 0, a quoted run counting as one word.
- `$word` is the matching word for each name a skill's front matter lists under `arguments`.
- `${CLAUDE_SKILL_DIR}` is the folder holding the skill's `SKILL.md`.

`$N` or `$ARGUMENTS[N]` with no such word, and `$word` with none or for a name not listed, stay as
written: they are as likely a shell variable in an example. When the skill's text uses no argument
placeholder, the text follows the skill as before, so it still reaches the model. A skill with none of
these runs exactly as pi runs it.
