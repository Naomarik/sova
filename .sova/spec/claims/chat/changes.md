# §chat/changes — Reviewing what changed
> Part of the Sova design spec · [overview](../design/overview.md)

Sova shows what a session changed on disk as a diff, read-only: never a working-tree write, never
a git command that changes anything. The same **changes viewer** opens from the session pane, from
a merge card, and from the agent's `show_changes` tool, and shows one comparison the server
chose (the session's uncommitted changes against HEAD, a tracked worktree against the point it
branched from, or one commit against its first parent).

## §chat.changes/viewer — The changes viewer

The viewer has two panes. The left pane holds a file tree above the numbered steps
(§chat.changes/steps); the right pane shows one file, or one step. A control above the panes
hides the left pane and shows it again, so the diff takes the whole width; the choice is
remembered on this device, and the diff's header still names the file or step it shows.

Picking a file row shows that file's whole diff, and marks that row as current. Each of its
hunks is headed by the step that made it, which opens that step. Picking a step, or a step number
on a file row, shows that step: its title, the agent's why when it wrote one, "Builds on" links
to the steps it builds on, and its hunks across files, each file under a header that names it,
with its status and counts, and opens that file. The viewer opens on the first step, or on the
first file when there are no steps.

The diff's header names the path (a rename reads "old → new"), its lines added and removed, and a
Unified / Split switch; Split is available while the diff pane is at least 520px wide, and the
choice is the one the diff renderer remembers (§chat.changes/diff-renderer). When the pane is
narrower only because the left pane is showing, Split stays tappable, says "Needs a wider pane —
hides the file list", and a tap hides the left pane and switches to Split; when even the whole
width is narrower, Split is disabled with the reason "Too narrow for two sides, even without the
file list". A file row
can be marked **Viewed**; the mark lives only while the viewer is open. A file's patch is read
when the file (or a step holding it) is first shown, and to place hunks into steps; a file too
large to read whole says so and shows its counts.

Below 768px of the viewer's own width (a phone, or a merge card in a narrow column) the two panes
become two views: the tree and steps first, and picking a file or step shows its diff full-width
with a Back control that returns to the list; the pane control and the Unified / Split switch are
not offered there, and the diff is Unified. Focus moves with the view.

The viewer reports what it could not do plainly: a comparison the server refused, a repository
it could not read, a file whose patch failed, each with what it means and a way to retry.

## §chat.changes/tree — The file tree

The tree lists every changed file under its folders, folders first, each level by name; a chain
of folders that hold only one folder reads as one row ("pi-config/extensions/show-changes").
A folder folds and unfolds with its chevron; a folded folder shows how many files it holds and
their lines added and removed. **Expand All** and **Collapse All** above the tree act on every
folder. A file row shows its status letter (M modified, A added, D deleted, R renamed, and T or B
for a type change or binary), its name, a check when it is marked Viewed, its counts, and the
numbers of the steps that hold its hunks, each a round badge that opens its step. The tree and
the steps list are dense, so more of a change fits on one screen: rows are 32px tall on a touch
screen and 28px with a mouse, below the 44px touch minimum by design.

## §chat.changes/steps — The change as steps

The diff is told as numbered steps, and every hunk of it lands in exactly one step or under
**Other changes**, which is listed last and unnumbered. A hunk is a unit: a step never holds
part of one.

Without agent-written steps, each agent turn that edited or wrote files is a step, in turn order,
titled from the first line of the prompt that started it. A hunk belongs to the turn whose
successful edit and write calls added or removed the most of its lines (a later turn wins a
tie); a hunk whose lines are too short to tell is matched by the line range the edit recorded.
Hunks no turn made (edits by hand, by a tool other than edit and write, or by another session)
go under Other changes. A turn none of whose edits remain in the diff is not a step. A step
builds on each earlier step that changed one of its files.

With agent-written steps (§chat.changes/show-changes-card), those are the steps, in the agent's
order and words, checked against the real diff the same way: each hunk goes to the first step
that names it (by file, or by file and the hunk's starting line), a step that names nothing in
the diff is left out and listed as unmatched, "builds on" keeps only earlier steps that remain,
and what no step names goes under Other changes.

## §chat.changes/entry — Where the viewer opens

- The session pane's Session tab: while the folder has uncommitted changes, the Repository section
  has an **Uncommitted changes** line with how many paths changed and their lines added and
  removed, and a **Review Changes** control beside it, which opens the viewer on them against HEAD;
  each active tracked worktree row has a **Review Changes** control at its end (below its chips
  when the pane is narrow) that opens its branch against its merge-base with the branch it came
  from.
- A merge card (§chat.worktrees/merge-card) has a chevron that unfolds the viewer inside the card,
  on that merge's commit against its first parent; the chevron folds it again. Inside the card the
  viewer has no height or scroll area of its own: it grows with what it shows, and the transcript
  scrolls it, so a drag over it always moves the page.
- An agent's `show_changes` result (§chat.changes/show-changes-card).

Nothing of the viewer exists until it is shown: a folded merge card, a `show_changes` card or a
Review Changes control whose viewer isn't open reads nothing from the server and parses, diffs,
places and highlights nothing; closing or folding the viewer drops it.

From the session pane the viewer opens as a dialog over the page (a full-height sheet at folded
width), closed with Close, Esc or the scrim, and focus returns to the control that opened it.
For steps from turns the viewer reads the session's whole transcript when it opens, not only the
rows the chat has loaded. A card in a transcript Sova can't tie to a session (a subagent's) has
no chevron and no Review Changes control.

## §chat.changes/show-changes-card — The agent's show_changes card

A `show_changes` tool result renders as a card, not a tool row: the comparison it names, its
title when it has one, how many steps the agent wrote, and a **Review Changes** control that opens
the viewer on that comparison with the agent's steps. A result whose details Sova can't read
stays an ordinary tool row.

## §chat.changes/show-changes-tool — The `show_changes` tool

The agent opens the viewer with one tool, `show_changes` (pi-config's `show-changes`
extension), when the user asks to see or review changes; it replies in a sentence or two instead of
pasting a diff. The tool is read-only. It takes a scope: `dirty` (the index
and working tree, untracked files included, against HEAD), `worktree` (a branch against its
merge-base with its base branch: the tracked worktree's base branch, else `master`, else `main`,
else the branch `origin/HEAD` names, else the tracked base commit) or `commit` (one commit, which it names, against its first parent).
For `dirty` and `worktree` it reads the tracked worktree named by branch or path, else the tracked
worktree holding the session's cwd, else (for `worktree`) the only tracked one, else the cwd. It
may also take a title, a list of repo-relative files or directories to limit the view to, and
steps: each a title, an optional why, the earlier steps it builds on, and the hunks it holds,
named by file (every hunk of it) or by file and the start line of the hunk's old or new side.

The tool refuses, changing and showing nothing, a malformed call with a sentence saying what to
fix: a path that is absolute or climbs out with `..`, a step building on itself or a later step,
the same hunk named twice, a commit that does not resolve, a checkout on its own base branch for
`worktree`, a folder outside git, and any call in a session whose tools run on a remote target.

It then reads the hunks of the diff the viewer shows (the same comparison, files, rename detection
and default context; an untracked file is one added hunk, a binary file or one whose patch is too
large to draw is one whole-file unit), within the paths given, and places them the way the viewer
does (§chat.changes/steps). It refuses, showing nothing, a diff of more than one hunk sent without
steps, and steps that leave a hunk unplaced or hold a ref naming no hunk. The refusal says how to
fix it in one retry: for no steps, to resend with steps, and for a change that is one idea, one
step naming every file by path; it lists every hunk still to place, grouped by file, as its new
start and line count and its first changed line (past 150 hunks, the files with their hunk counts
instead, since a ref by path places all of a file's hunks), and each ref naming no hunk with the
file's hunk ranges or that the file is not in the diff; it stays under about 12 KB. A diff of one
hunk or none needs no steps.

Its result's text names the comparison, lists the changed files (the first 40), and says how many
hunks there are and, when steps were given, that every hunk is placed in a step. Its result's
details are the record Sova reads: version 1, the scope with the folder read, the repository's
top level and the full commit ids the tool resolved, and the title, paths and steps as checked;
Sova ignores a result whose details are malformed.

## §chat.changes/endpoint — Reading a diff from git

The server reads every diff itself, read-only, and the client never names a ref: it names a
session and one of three comparisons, and the server resolves the rest. A **worktree** comparison
is the worktree's committed branch against its merge-base with its base branch (the tracked
worktree's base branch when that branch still exists, else master, else main, else the remote's
default); a **commit** comparison is one commit against its first parent (a first commit against
nothing); an **uncommitted** comparison is the working tree, staged changes included, against HEAD,
with untracked files shown as added and a file whose content did not change never listed. The
folder named must be one the session already knows (its folder, its workers' folders, a
worktree it tracked, a merged worktree's folder) or inside one; the diff covers that folder's whole
repository. Anything else is refused with a reason, before git runs there. A commit whose folder is
gone, as a merged worktree's often is, is read from the first folder the session knows whose
repository still has it, the session's own folder first.

A diff comes in two reads: the file list (each file's path, its old path when renamed, whether it
was modified, added, deleted, renamed, retyped or is binary, and its lines added and removed, with
totals over every file); and one file's patch, which, when asked, also carries the file's whole old
side, so folded context can be expanded. That old side is the one the patch itself names; no read
takes a path or an object name from the client, so nothing outside the diff (an ignored file, say)
is ever sent. Reading never writes the repository, its index or the working tree. Each is bounded: a
list past 3,000 files says it was cut and still counts every file; a patch past 1 MB is not sent,
and says how far it got; an old side past 8 MB or binary is not sent, and its folds stay closed;
every git stops after 5 s. An untracked file is read only up to 1 MB: past that it is not diffed,
and its lines are counted only as far as they were read. One file list reads at most 16 MB of
untracked files in all; the files after that are listed, marked too large, and not counted.

## §chat.changes/diff-renderer — How one file's diff reads

Every diff in Sova (the changes viewer, a tool card, a merge card) draws one file the same way.
Each line has two line-number columns (old, new) and a sign (+, −, or blank) before the code, in
a gutter that selection skips, so copying a range copies code only. Added lines sit on
`--diff-add-bg`, removed lines on `--diff-del-bg`. Code is highlighted by the file's path, each
side as one whole text, so a hunk inside a block comment or a template string keeps its colours.
Long lines wrap; their numbers stay on the first line.

Inside a run of changes, each removed line is paired with the added line it most resembles, in
order. A pair marks the words that changed, in `--color-ink` on `--diff-del-emph` /
`--diff-add-emph`; marks never cover indentation. A pair gets no marks when more than 60% of a
line changed or a line is over 1,000 characters: the whole line reads as changed.

Unchanged lines between hunks fold to one row, "⋯ Show n unchanged lines" (with the enclosing
function git names, when it names one). When the whole text is known, or the changes viewer can
read the file's old side, the row opens those lines in place (while the viewer reads, it says
"⋯ Reading n unchanged lines…"; a failed read leaves the button to try again). When it can't
(a tool card's snippet, an old side too large or binary), it reads "⋯ n unchanged lines" and
doesn't open. Hunks of one step that
aren't neighbours in the file are separated by a plain "⋯" rule.

**Unified / Split.** Unified is the default. Split puts the old side left and the new right, a
changed line beside the line it became and a blank filler opposite a line with no partner. Split
is available only when the diff itself is at least as wide as its surface's threshold (900px in
a tool card, where the transcript column allows it only at its widest; the changes viewer sets
its own, and may offer a way to widen, §chat.changes/viewer); below that the Split button is
disabled with the reason "Too narrow for two sides" and the diff shows Unified. The choice is one
setting for every diff, remembered on this device.

**Keys.** With the diff focused, n moves to the next hunk and p to the previous one.

**Big diffs.** A file with more than 1,500 changed lines shows its header and a "Load Diff (n
lines)" button in place of its lines; the lines are built only when it is pressed. Loading and
opened folds belong to one file: moving to another file starts it folded, behind its own Load Diff
when it is big.

A binary file says "Binary file, not shown."; a rename with no line changes says so.

## §chat.changes/tool-card-diff — Edits and writes as diffs in tool cards

An `edit` or `write` tool card (pi's, and a Claude Code worker's `Edit`, `MultiEdit` and `Write`,
which read as `edit` and `write`) shows what it changed as a diff (§chat.changes/diff-renderer)
under a "Changes" label (`edit`) or "Content" (`write`), with Copy Code for the text written: a
`write`'s whole content, or an `edit`'s new text (several replacements joined by a blank line). Its
closed summary row adds "+n −m" before the status chip, once the call's arguments are complete,
counted off the result's recorded patch (pi's `details.patch`, or the Claude Code result's hunks);
without a recorded patch the row shows no count.

- **edit.** The result's recorded patch gives the file's own line numbers: pi's `details.patch`,
  or the Claude Code result's hunks. Without one (the call is still running, it failed, or the
  session predates it), each replacement is diffed on its own, without line numbers, and a note
  says "Line numbers weren't recorded; each change is shown on its own."
- **write.** Every line added, numbered from 1. A Claude Code `Write` that replaced a file shows
  the real diff against the old content; one that created a file shows no note. A pi `write` notes
  "The whole file as written. If it replaced one, the old content wasn't recorded.", since pi
  doesn't record which it was.

The body is still built the first time the card is opened (§chat.transcript/transcript-items):
a closed card diffs, word-marks and highlights nothing, and a card closed again keeps what it drew
without redoing any of it until it opens again.
