# §app/folder-viewer — Folder viewer
> Part of the Sova design spec · [overview](../design/overview.md)

One read-only list of a folder's files, app-wide, that any screen can open. It knows nothing
about who opens it: the caller gives it one or more **labelled groups**, each a folder of a
registered project at a commit or ref, a folder Sova itself ships, or items the caller lists and
reads itself. The merge queue's settings (§app.merge-queue/settings) and the Context tab
(§app.subagents-pane/context-tab) open it; spec folders, skills and playbooks can open it the same
way.

**A list, in place.** The viewer is a part a screen embeds where it is needed, never a dialog of
its own, and it has no reading area: each group's label with a caption saying where its files come
from ("{folder} at {sha}", or "Shipped with Sova"), and its files as they are there, in reading
order: `PLAYBOOK.md`, `README.md` or `SKILL.md` first, a folder's own files before its subfolders',
then by name. Picking a file opens it in the reading window (§app/markdown-viewer), titled with its
name, the group's caption or label under it; nothing opens until one is picked. Every open reads the
file afresh; a read that fails is a toast, "Couldn't open that file." and the reason, and the window
stays shut. Closing the window returns to the list as it was. There are no next or previous buttons.

**What a caller may ask for**, none of which the merge queue's settings ask:
- An item may carry a plain name and a size in words: it then shows that name in ordinary text with
  the size beside it, and no file icon, instead of its path.
- An item may give a language word (`json`, `markdown`) for the reading window, when its path can't
  say how to show it.
- The caller may keep its own order: the list isn't sorted into reading order.
- The caller may give a refresh key: when it changes, every group is listed again. A file open in
  the reading window isn't read again.
- A group brings its own list and read (the Context tab reads parts as they are now, through
  §chat.transcript/setup-card-open-file).

**Each file as what it is.** The reading window shows a picked file by its type, a script as code;
nothing in the folder ever runs. A binary file or one past the size cap is listed; picking it opens
the window, which says it can't be shown, and it isn't read.

**Read from the commit, never the working tree.** A group of a project's folder is listed and read
at its commit (with no ref named, the project's main branch) through one generic read-only route, scoped to
registered project roots and the folders Sova ships. A project with no Git history shows its files
as they are, and can't be asked for a commit. The rules for reading a project's code hold
(§app.spec-lookup/code-read): its deny list (credentials, `.git`, dependency folders, secret-named
parts), except that the project's own `.sova` folder may be read in its committed tree (never on
disk, in a project with no Git history), its secret-named files still denied; no link is followed; key-shaped
lines read as hidden; a long file is cut. A path outside the folder, or one the deny list covers, is
refused.

**Closing.** Its own **Close**, and whatever control opened it, put it away.
