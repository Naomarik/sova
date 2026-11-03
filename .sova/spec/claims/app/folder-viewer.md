# §app/folder-viewer — Folder viewer
> Part of the Sova design spec · [overview](../design/overview.md)

One read-only viewer for a folder of files, app-wide, that any screen can open. It knows nothing
about who opens it: the caller gives it one or more **labelled groups**, each a folder of a
registered project at a commit or ref (or a folder Sova itself ships). The merge
queue's settings are its first caller (§app.merge-queue/settings); spec folders, skills and
playbooks can open it the same way.

**Two panes, in place.** The viewer is a part a screen embeds where it is needed, never a dialog of
its own. On the left, each group's label with a caption saying where its files come from
("{folder} at {sha}", or "Shipped with Sova"), and its files as they are there; on the right, the
picked file. It opens on the first group's first file in reading order: `PLAYBOOK.md`, `README.md`
or `SKILL.md` first, a folder's own files before its subfolders', then by name. Under 640px the list
stacks above the file.

**Each file as what it is.**
- A markdown document is rendered with §chat/markdown's renderer, raw HTML off.
- Any other text file, a script included, is shown verbatim in mono, its path followed by "· shown
  as text, never run". Nothing in the folder ever runs.
- A binary file is listed and not shown ("Not a text file, so it isn't shown."), nor is one past the
  size cap ("Too large to show here."); a long file shows its start ("The file is longer; this is its
  start.").

**Read from the commit, never the working tree.** Files are listed and read at the group's commit
(with no ref named, the project's main branch) through one generic read-only route, scoped to
registered project roots and the folders Sova ships. A project with no Git history shows its files
as they are, and can't be asked for a commit. The rules for reading a project's code hold
(§app.spec-lookup/code-read): its deny list (credentials, `.git`, dependency folders, secret-named
parts), except that the project's own `.sova` folder may be read in its committed tree (never on
disk, in a project with no Git history), its secret-named files still denied; no link is followed; key-shaped
lines read as hidden; a long file is cut. A path outside the folder, or one the deny list covers, is
refused.

**Closing.** Its own **Close**, and whatever control opened it, put it away.
