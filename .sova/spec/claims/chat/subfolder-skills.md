# §chat/subfolder-skills — Skills in subfolders are offered as the agent works
> Part of the Sova design spec · [overview](../design/overview.md)

A folder below a chat's own can keep skills of its own, in `.claude/skills` or `.agents/skills`. They
cost nothing until the agent works there: the first time it reads, edits or creates a file in that
folder, the model is offered them, the way a subfolder's instruction file loads
(§chat/subfolder-instructions). The chat's prompt never changes for this, so it costs no uncached
turn and no restart of a Claude process.

## §chat.subfolder-skills/offering — When and how the model is offered them

- **Which folders.** The folders strictly below the chat's folder, down to the touched file's folder,
  outermost first. A folder whose name starts with `.`, `node_modules`, and everything below either
  doesn't count, as for instruction files. Nor does a skills folder git ignores; a folder git can't
  answer for (no repository, or an error) counts.
- **What offers them.** Only a read, an edit or a write that succeeds. Bash, grep, find and ls never do.
- **How it reaches the model.** One text block per folder at the end of that action's result, after
  any instruction files, `<sova-skills dir="services/samba">…</sova-skills>`, listing each skill's
  name, description and location in the form the chat's starting skills use, and saying to read a
  skill's file when the task matches. The agent then reads a skill when it needs it. A Claude Code chat
  gets the block in the tool result like any other text.
- **In one folder.** `.agents/skills` first, then `.claude/skills`, as at a chat's start; the first of
  two with one name is offered. A file the chat's starting list already has isn't offered again. A
  skill this chat has off (switched off on its setup card, §chat.transcript/setup-card-toggles, or
  off for its folder when it started, §chat.skill-sources/project-new-chats; a worker's are its
  parent's) stays off. In a chat started in the asking mode only a skill on its fixed list is
  offered; any other one gets the transcript line of §chat.context-approval/mid-chat instead. A manual-only skill
  (§chat.skill-sources/manual-only) isn't in the block, and a folder holding only those gets none.
- **Once.** A folder's block attaches only when the chat's current context doesn't hold it, by the same
  rule as instruction files: the current branch from the latest compaction on, only blocks after a
  result's first, and two actions of one turn never both attach one.
- **Again after a compaction or a rewind.** Once a compaction or a rewind (a fork too) leaves the block
  out of the current context, the next read, edit or write in that folder offers them again.
- **Who gets them.** Ordinary chats, Claude Code chats and workers, whichever backend, whose tools
  can both touch a file (read, edit or write) and read one (read or bash). A chat that loads no skills
  (the Overseer, a project overseer, a gathering chat, the Project Assistant) never does.

## §chat.subfolder-skills/command — `/skill:name` for a subfolder's skill

- **The menu.** A subfolder's skill joins the `/` menu once the chat has been offered it, and leaves if
  a compaction or a rewind removes the block. The menu updates when the run settles.
- **By hand.** Typing `/skill:name` works at any time, offered yet or not, manual-only included, because
  you're asking for it directly and it costs nothing until then, unless this chat switched that name off. It expands as a starting skill's does,
  with its arguments filled in (§chat.skill-sources/arguments), and then counts as read.
- **Same name.** The name stays with the skill offered first: the chat's starting skill, else the one
  offered earliest on the branch, else the outermost one below the chat's folder. The model is still
  offered a subfolder's skill of the same name, with its location, since a service's own skill may
  differ. Skills offered lists both, each with its folder (§app.subagents-pane/context-tab).
