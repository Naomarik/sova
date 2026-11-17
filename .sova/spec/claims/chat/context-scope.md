# §chat/context-scope — A chat's context files come from its own folder and repository only
> Part of the Sova design spec · [overview](../design/overview.md)

A chat never starts with the context files of the folders above its folder, except inside a git
repository: there it loads those from its folder up to the repository's top folder, never from the
home folder or a folder above it. Outside a repository it loads its own folder's file only. pi's
settings folder's file always loads. The files of folders inside the chat's folder load as the agent
works there (§chat/subfolder-instructions). A project's instruction files and skills are its real
files: one whose real place is outside the project, through a link, never loads and is never listed.

## §chat.context-scope/folders — Which folders a chat's starting context files come from

- **The files.** In each folder, the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`,
  `CLAUDE.md`, `CLAUDE.MD` it holds, as pi picks it. Only which folders count is Sova's.
- **pi's settings folder.** Its file always loads, first.
- **Inside a git repository.** The chat's folder and each folder above it, up to the repository's
  top folder: the nearest folder holding `.git` (a folder or a file), found upwards from the chat's
  folder's real place, so a linked worktree or a submodule stops at its own top. It holds for a
  repository outside the home folder too (`/tmp/x/repo/sub` loads `repo`'s file). Never the home
  folder or a folder above it: a repository whose top is there (dotfiles kept at home) counts as no
  repository.
- **Outside a repository.** The chat's own folder's file only.
- **The home folder's file.** `~/AGENTS.md` loads only in a chat whose folder is the home folder
  itself (as typed, or by its real place), never in one below it.
- **At the home folder or above it.** A chat whose folder is the home folder or a folder above it
  (`/home`, `/`) starts with its own folder's file and pi's settings folder's, and loads nothing from
  the folders inside it, at the start or as it works (§chat/subfolder-instructions).
- **A folder reached through a link.** pi looks in the folders of the path the chat was opened at,
  so a chat opened through a link loads only the files of those folders that this rule also allows:
  a link into a repository's folder gives that folder's file, never the repository's top's or the
  link's own surroundings'.
- **Only the project's real files.** The project is the repository's top folder this rule finds, or
  the chat's own folder where it finds none; a chat at the home folder or above it works in no
  project, and this check doesn't apply to it. An instruction file or skill found in the project's
  folders (its starting files above, those of folders inside it, §chat/subfolder-instructions, and its
  skill folders, `.pi/skills`, `.agents/skills` and `.claude/skills`, §chat.skill-sources/starting,
  §chat.subfolder-skills/offering) loads, and is listed (§chat.context-approval/list), only when its
  real place is inside the project: a file that is a link to elsewhere, or one in a folder reached
  through such a link, never does, nor does a link that leads nowhere. A link that stays inside the
  project (a `CLAUDE.md` pointing at its `AGENTS.md`, a starting skill folder linked from another
  folder of the project) is fine; as the agent works, a folder inside the chat's folder counts only
  while its real place stays inside the chat's folder (§chat.subfolder-instructions/loading). pi's settings
  folder is not a project's: its file and the user's own skills load wherever their links lead.
- **Only ever less.** The rule only takes files away from what pi finds; a pi that looks in more
  folders can't add one. Each chat's switches, its fixed list and a chat's own narrower rule (a project
  overseer's, §app.project-overseer/identity) apply after it, and none brings back a file it left out.
- **Every chat.** Ordinary chats, Claude Code chats, workers (each from its own folder, then its
  parent's list, §chat.context-approval/fixed), team members, the merge thread, reviewers, the
  Overseer and project overseers, at every build of the chat, with or without switches of its own.
- **Chats already under way.** Nothing is rewritten: a chat started before this rule follows it from
  its next rebuild (its reopening, a reconnect after a server restart, Reload Now), and its recorded
  list stays as it was.
- **A folder that is gone.** A chat that runs in the home folder because its own folder is gone
  (§app.shell/missing-folder-home) is scoped by its stored folder, not by the home folder: it loads
  pi's settings folder's file and no other.
- **What it doesn't touch.** Skills keep their own places (§chat.skill-sources/starting), and a
  folder's skills inside the chat's folder are offered as before, except one whose real place is
  outside the project (above).
  A terminal (pi's TUI) that opens a session loads what pi itself finds.
