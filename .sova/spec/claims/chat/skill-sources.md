# §chat/skill-sources — Where a chat's skills come from
> Part of the Sova design spec · [overview](../design/overview.md)

A chat is offered skills from pi's own places and from the Claude skills folders a project or a person
already keeps, with nothing to copy or configure. It reads them where they are, and writes nothing
there. Which skills a new chat may load is decided per folder on this computer, allowed unless
disallowed or asked first (§chat/context-approval, /project-defaults); a chat's list is fixed at its
first message (/project-new-chats).

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

## §chat.skill-sources/project-defaults — A project's Skills: what its new chats are offered

Each project, and each folder a chat runs in that is no project, has skill decisions for the chats
it starts, kept on this computer in its approval list (§chat.context-approval/list).

- **The states.** In the default mode a skill reads **Allowed** or **Disallowed**: a Disallowed one is
  off in new chats and every other one is on. In the asking mode (§chat.context-approval/modes) a
  skill is **Approved**, **Disallowed**, **Waiting** (no decision yet, off) or **Changed** (approved,
  and still on, but its file changed since).
- **Which chats.** Every chat Sova starts in the project's folder: its root, a folder inside it, or
  one of its linked worktrees, as §app/projects matches folders (an archived project matches
  nothing), Claude Code chats included; and every chat in a folder that is no project, by that folder
  (§chat.context-approval/folders). A chat that loads no skills (/starting) has none of this.
- **The Skills card.** The project page's Settings tab has a **Skills** card right after the **Context
  Files** card (§chat.context-approval/context-card). Its line reads "New chats load these skills,
  except the ones you disallow. Open chats keep theirs.", or while asking "New chats load the skills
  you approve. Open chats keep theirs." It lists every skill a chat in the project could be offered,
  found by the folder's scan (§chat.context-approval/list): for the project's root, then for each of
  its worktrees, pi's own places with the Claude folders (/starting), then the skills of folders
  inside it (§chat/subfolder-skills). A skill is one row per place, never per name alone, so a project
  skill named like one of yours is a row of its own; the main folder and its worktrees share a row for
  the same place. Each row has the skill's name, where it comes from, its state as a chip, and the
  buttons its mode gives it (§chat.context-approval/modes). A click saves at once; a save that fails
  is a toast, "Couldn't save {name}. {message}". With no skill found the card says "No skills found. A
  chat here would load none." A peer's project (opened with `?host=`) shows no Skills card.
- **The routes.** `GET /api/projects/:pid/skills` answers every row with its key and state, the
  counts, the mode and whether the scan was complete. `PUT /api/projects/:pid/skills {skills: {<skill
  key or name>: "approved" | "disallowed" | "waiting"}}` changes only the skills given (a bare name is
  the first skill found with it; `waiting` clears a decision) and answers the fresh view; a bad body
  is refused (400), and so is a skill not found (404: "Nothing named "{name}" is found in
  {folder}."). They are `project.skills.get` and `project.skills.set`
  (§app.project-commands/projects-sweep).
- **Approving, and allowing again, are yours.** A PUT that approves a skill, or makes a Disallowed one
  Approved or Waiting, is refused (403) and nothing changes unless it comes from the operator's own
  page, with the words of §chat.context-approval/who. Disallowing is open to every caller.
- **One save, with its history.** Every change of a project's Skills and Context Files (the cards, a
  new chat's setup card, a chat's "wasn't loaded" line, a script, the project overseer's
  `sova_settings`, a Settings change card's Apply and an Undo, §app.project-overseer/settings) is saved
  the same way: the list is written, one Settings history line is added for each item whose state
  changed (`field: "skills.<key>"` or `"context.<key>"`, from and to `approved`, `disallowed` or
  `waiting`), and then the new chats below are rebuilt.
- **A skill that is gone drops off.** A decided skill no longer found in any checkout leaves the card
  and the list by itself. Only a scan that saw every checkout whole drops one: when git can't list the
  worktrees, a folder can't be loaded, or a folder walk stops at its limit, every decision is kept.
- **New chats take a change at once** (§chat.context-approval/live). A started chat is never touched
  (§chat.context-approval/fixed).
- **The project overseer manages them.** Its `sova_settings` lists each skill's state by key and
  proposes changes, and a Create chat can propose one, as for every project setting
  (§app.project-overseer/settings).
- **On the All settings list.** The tab's All settings section has a **Skills** row
  (§app.project-overseer/settings).

## §chat.skill-sources/project-new-chats — A new chat in a project: its skills on the setup card

- **The rows.** While the setup card's switches show (§chat.transcript/setup-card-toggles), a chat in
  a project, or in a folder that is none, marks each skill row (§chat.transcript/setup-card-skills),
  as each context file row, with its folder's decision. A Disallowed row starts off and says `Off for
  this project` (`Off for this folder`) under its name, with no buttons; its switch still turns it on
  for this one chat, and the row then says `Off for this project · on for this chat`. A changed one
  says `Changed since you approved`, with **Re-approve** and **Disallow**. In the default mode every
  other row is as any other: no Waiting line, no Approve and no notice. The chat's own switches never
  change the folder's decisions. Under the lists, the card says where they are kept and opens them
  (§chat.context-approval/folders).
- **In the asking mode.** A Waiting row starts off and says `Waiting for your decision · off until you
  approve it`, with its own **Approve** and **Disallow**, and the card's one notice and the held Send
  ask for the decisions (§chat.context-approval/held-send). Each answer saves to the folder's list as
  the cards' buttons do (/project-defaults), and the card is read again: an approved item is on, and a
  disallowed one is off in this same chat as well, before its first message. While any of these saves
  runs, the others wait.
- **Before the first message, flips stay flips.** A chat's own switches are kept as what it changed
  against its folder's decisions, so a decision made before its first message still reaches it, except
  for an item the chat switched itself. A switch never turns on a disallowed skill the card doesn't
  list.
- **Fixed at the first message.** When the first message is sent, the chat's lists are written into
  its own record exactly once, before the message goes in, with the mode it started in
  (§chat.context-approval/fixed). From then on a change on a card never moves that chat: reopening it,
  a reload of its code and a server restart keep its lists. A chat started before projects had Skills
  keeps every skill on, and never takes up the folder's decisions later.
- **Workers.** A worker a chat starts is offered exactly its parent chat's skills and mode, whatever
  the folder's decisions say now (§chat.context-approval/fixed). Sova sets it from the parent chat,
  never from the request. The worker keeps that list as its own, so its subfolder skills, a typed
  `/skill:name` and its slash list leave the same skills out.
- **Off everywhere.** A skill a chat has off is out of the skills the prompt lists, `/skill:`
  expansion, the composer's slash list and the subfolder skills block (§chat.subfolder-skills/offering).
