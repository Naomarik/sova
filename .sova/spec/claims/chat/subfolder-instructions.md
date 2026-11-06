# §chat/subfolder-instructions — Instruction files in subfolders load as the agent works
> Part of the Sova design spec · [overview](../design/overview.md)

A chat starts with the instruction files of its folder and the folders above it
(§chat.transcript/setup-card-context). A folder below it can keep its own instructions too: that
file loads the first time the agent reads, edits or creates a file in that folder, at the end of
that action's result, as Claude Code does with a nested `CLAUDE.md`, `AGENTS.md` included. It is
always on: no project, chat or setting turns it off.

## §chat.subfolder-instructions/loading — Which files load, when, and once

- **Which folders.** The folders strictly below the chat's folder, down to the touched file's
  folder, outermost first. The chat's own folder isn't one of them: its file loaded at the start.
  Nothing outside the chat's folder counts.
- **Which file in a folder.** The first regular file found of `AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, in that order, the order a chat's starting files follow.
- **Skipped folders.** Any path with a `node_modules` folder or a folder whose name starts with `.`
  below the chat's folder loads nothing from there down.
- **What loads them.** Only a read, an edit or a write (a file it creates) that succeeds. Bash,
  grep, find and ls never do.
- **How it reaches the model.** Each file is a separate text block at the end of the action's
  result, `<sova-instructions path="api/AGENTS.md">…</sova-instructions>`, its path relative to the
  chat's folder and its text as it is on disk then. A Claude Code chat gets the block in the tool
  result like any other text.
- **Once.** A file attaches only when the chat's current context doesn't hold it already: the
  current branch, from the latest compaction on (that compaction's kept part included). Only the
  blocks after a result's first that start with the block's opening count, so a tool's own output
  that merely contains that text can't pass for one. A subfolder's skills block
  (§chat.subfolder-skills/offering) in the same result doesn't hide them. Two actions run in one turn
  never both attach the same file.
- **Reading the file itself.** When the agent reads the whole instruction file (from line 1, with
  no limit or one that covers every line), its text is already in the result, so only a one-line
  block attaches, `<sova-instructions path="api/AGENTS.md">(loaded: this read)</sova-instructions>`,
  and the file counts as loaded. A partial read of it attaches the whole file as usual.
- **Again after a compaction or a rewind.** Once a compaction or a rewind (a fork too) leaves the
  block out of the current context, the next read, edit or write in that folder attaches it again.
- **Every chat with file tools.** Ordinary chats, Claude Code chats, every worker whose tools
  include read, edit or write, and overseers, never a file their file tools may not read (outside
  their folder, or a secret). A chat that starts with no instruction files at all (the baton's
  gathering chat, the Project Assistant) gets none this way either.
