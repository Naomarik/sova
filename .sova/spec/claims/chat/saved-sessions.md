# §chat/saved-sessions — Saved sessions: save a chat so a colleague can continue it

A user saves a chat so a colleague can pick it up on their own computer and keep working with its
context. Sova makes a cleaned, portable copy of the conversation and commits it to one dedicated
branch of the project's repository, `sova/saved-sessions`, with the same name in every project. That
branch shares no history with the code, is never checked out by Sova and is never merged into main.
Saving and reading it never touch the user's working files, index or `HEAD`. A colleague finds saved
sessions on the new-session screen, previews one and continues it in the blank session in front of
them, which becomes their own session.

What travels is the main conversation only. Subagents and teams don't come back. A saved session
carries a short summary of each one instead. Saved sessions live only on that branch: there is no
save to a folder, no download, no saving inside a feature branch and no import from a file or link.
The words are the copy deck's (§design.copy-deck/saved-sessions).

## §chat.saved-sessions/save-dialog — Save Session

The session pane's Sharing tab has a **Save Session** button beside Share Session
(§app.subagents-pane/tabs). The local slash command `/save` opens the same dialog, which stands in for
a command palette entry: Sova's web app has no palette. Only a session in a folder inside a git
repository can be saved. In any other session the button is disabled and its `title` says why.

The dialog opens on what `POST /api/saved-sessions/prepare` returns. That request builds the cleaned
copy without writing anything. The dialog has these fields, in this order:

- **Title**: prefilled from the session's title.
- **Note for whoever opens it**: optional, shown before they continue.
- **Branches it belongs to**: prefilled with the worktrees this session created or attached
  (§chat.worktrees/entry), or the folder's branch if the session touched no worktree. The list is
  editable, picked from the repository's local branches. At least one branch is required.
- **How much history**: "Whole conversation" by default, or "Only what the agent sees now (since its
  last summary)". The second choice is offered only when the session has a summary. Trim long tool
  output is a separate checkbox (§chat.saved-sessions/size).
- **Include images**: a checkbox, on by default. With it off, every image is removed and the images
  need no review.
- **Cleaning report**: what was removed automatically, and a **Review** step listing each possible
  secret and each image (§chat.saved-sessions/cleaning).
- **Size after cleaning**, for the current choices.
- **Push so colleagues get it**: off by default and remembered per project. It is disabled when the
  repository has no remote. The first time it is turned on for a remote, a warning says the
  repository may be public, and the push goes ahead only once the user accepts it. The acceptance is
  remembered for that remote.

**Save** stays disabled until every possible secret and every image has a decision, Keep or Remove,
until at least one branch is named, and while the size is over the limit. Saving answers with the
saved card, the commit, and whether it was pushed. A push that failed after its retries leaves the
save in place and says why. Cancel writes nothing.

## §chat.saved-sessions/cleaning — What cleaning removes, and the review

Cleaning runs over every text in every kept entry: messages, tool arguments and results, extension
messages and summaries.

- **Known secrets are always removed**, with no review. These are the values and patterns the share
  links remove (the server's redactor: keys and tokens from auth, models and Claude credentials,
  Sova's own tokens, recognisable secret patterns), Sova's own links, preview links, and every value
  in the project's `.env*` files. When the merge round's private-name list exists on this computer,
  its names are known secrets too.
- **Possible secrets** are what cleaning can't be sure about, such as long high-entropy strings and
  key-shaped assignments. Each is listed with where it was found, a short excerpt with the match
  marked, and why it was flagged. The saver keeps or removes each one. A removed one is replaced with
  a marker.
- **Images**: Sova can't read text inside images, so every image in the kept history is listed with
  a thumbnail. The saver keeps or removes each one. A removed image becomes a short text note.
- **Thinking** is always left out. Old thinking isn't needed to continue, and a redaction inside a
  signed thinking block would break its signature.
- **Paths are made portable.** The repository's top-level folder becomes a root token, each worktree
  the session tracked becomes a worktree token naming its branch, and the home folder becomes `~`.
  A worker's session file path (in a subagent's result) becomes "[a session file on the saver's
  computer]", and a home folder written with dashes for slashes loses its user name too. Other
  absolute paths stay as written and are counted in the report.
- **Left out because it only makes sense on this computer**: the system prompt and its loadout
  entries, and every Sova or extension state entry. That covers grants, rules and their uses, sandbox
  and mode picks, the subagent profile pick, the Claude login, baton and overseer markers, link
  membership, cache affinity, wake details, worktree state and worker registries. The transcript's
  header gets a fresh id and a placeholder folder.

The report gives counts: secrets removed, possible secrets kept and removed, images kept and
removed, thinking blocks dropped, paths rewritten, absolute paths left, and tool outputs trimmed. The
card records the same counts (§chat.saved-sessions/branch).

## §chat.saved-sessions/size — How much history, and the size limit

"Whole conversation" is the active branch, linearised the way Fork from here copies it
(§chat.session-fork/from-reply): abandoned branches are left out. "Only what the agent sees now" is
the latest summary and everything after it. The model's context is the same either way; only the
scrollback a colleague can read differs.

The size shown is the transcript's size after cleaning, for the current choices. Above 10 MB the
dialog warns. Above 50 MB, Save stays disabled until a smaller choice brings it under: since the last
summary, trim long tool output, or both. Trimming keeps the head and the tail of each long tool
result with a marker between them, and the report counts how many were trimmed. The server refuses a
save over the limit, whatever the dialog sent.

## §chat.saved-sessions/branch — The saved-sessions branch, and what one saved session holds

Every saved session of a repository is one folder, `sessions/<bundle id>/`, on the orphan branch
`sova/saved-sessions`. The folder holds:

- `session.json`, the **card**: the saved-session marker (a fixed string no other file in the
  repository may hold literally), the bundle id, its version (rev),
  title, note, who saved it (git's `user.name`) and when, earlier versions (who and when), the
  branches it belongs to, the saving folder's commit, the harness, model and thinking level, the
  history choice, what it includes, entry and message counts, size, approximate tokens, the tokens
  used for paths, the cleaning counts, and the team and subagent summary
  (§chat.saved-sessions/workers).
- `transcript.jsonl`, the cleaned conversation.
- `README.md`, a readable page for anyone browsing the branch on a code host: title, note, who saved
  it and when, the last exchange, and how to continue it in Sova. It carries the marker too.

One saved session can belong to several branches. Its folder doesn't move when a branch is added.

**Writing never checks the branch out.** Sova builds the commit with git plumbing on the branch's
current tip, using a temporary index file, `hash-object`, the index update, `write-tree` and
`commit-tree`. It then moves the branch with `update-ref` guarded by the tip it read. The commit
message is "Save session: {title} (v{rev})". The user's `HEAD`, index, working files and checked-out
branch are never touched. A save without push writes the local branch only.

**Pushing.** A save with Push on first fetches only the saved-sessions branch from the remote and
builds the commit on the newer of the local and remote tips. The version check runs against that tip
(§chat.saved-sessions/resave). The save then pushes with an explicit refspec as a fast-forward. When
the remote moved meanwhile, it fetches that branch again, applies the same folder onto the new tip
(folders are disjoint per saved session) and retries, up to 3 times. Sova never force-pushes this
branch or any other.

## §chat.saved-sessions/workers — Teams and subagents travel as a summary

Subagents and teams are not brought back: only the main conversation travels. At save time Sova
writes a short summary of each subagent and team member the conversation started, built mechanically
from Sova's own worker and team records, with no model call. Each entry gives the team and role (or
the subagent's profile), the task it was given, how it ended, and its final report, clipped. The
summary is cleaned like everything else. Their full transcripts never travel, and a saved worker id
never resolves to a worker of the person who continues it.

## §chat.saved-sessions/saved-list — The Saved list in the Sharing tab

Once a session has saved, or was continued from a saved session, the Sharing tab shows a **Saved**
list under Save Session (`GET /api/saved-sessions/for-session`). Each row gives the title, the
version, when it was saved, whether it was pushed, and whether this session saved it or started from
it. A **Save Again** button opens the dialog for the next version.

The session remembers which saved session and version it saved or came from in a lineage record of
its own (a session state kind). That record is what makes the next save an update.

## §chat.saved-sessions/resave — Saving again, and someone else's newer version

Saving again from a session that saved, or from a continuation of a saved session, updates the same
saved session to the next version: the card's rev goes up by one, earlier versions are listed on it,
and git keeps the old files. The check reads the branch tip, after a fetch when pushing. When the tip
already holds a newer version from someone else than the one this session came from, the save stops
and asks, naming who saved it and when: **Save as New Copy** gives it a new bundle id at version 1,
and **Replace Theirs** writes the next version over theirs. Cancel writes nothing. Save Again
prefills the note and the branches from the version it updates (its branches joined with the
session's own), so a new version keeps what the last one said unless the saver changes it.

## §chat.saved-sessions/discovery — Saved sessions on the new-session screen

The new-session screen (the "Empty (new session)" state, §chat.transcript/setup-card) shows a small
**Saved sessions** card for a folder inside a git repository (`GET /api/saved-sessions?cwd=`). It sits
under the setup card, above the footnote "Your first message becomes its title.", in the setup
card's column and at its width. It is one quiet row and holds no buttons: the words "Saved
sessions", a count line, and a chevron. The whole card is one button (Enter or Space opens it too)
that opens the **Saved sessions** window, a modal (a sheet at folded width) that traps focus, closes
on Escape, Close or its scrim, and gives focus back to the card.

- **The count line** counts every saved session of the project, then how many are New, Updated and
  can't be read, leaving out parts at zero: "3 saved · 1 new · 1 updated · 1 can't be read". With
  none it reads "No saved sessions yet"; when the list couldn't be read, "Couldn't read them".
  When saved sessions are on main (§chat.saved-sessions/on-main), the card also carries an error chip
  "In {main}" (dot and word); a merged branch still holding saved sessions (§chat.saved-sessions/prune)
  adds "{n} branch merged" to the count line.
- **The window** lists every saved session of the project, newest first, whatever branch the folder
  is on. A branch filter offers "All branches" and each branch any saved session names. The filter
  starts on "All branches", so the folder's own branch filters nothing by default. The on-main alert
  and the prune offer sit at its top, above the list.

- **A row** gives the title, who saved it, its branches, when, its size, and a **New** or **Updated**
  badge. Each row has **Preview** and **Continue**. New means this computer has never seen that saved
  session; Updated means it has seen an older version. The badges come from a seen store on this
  computer (bundle id → version), and a version counts as seen once it is previewed or continued. A
  saved session whose card or transcript can't be read is listed as "Can't be read", with no Continue.
  Preview opens over the window; Continue closes the window and continues
  (§chat.saved-sessions/continue).
- **Where it reads.** Sova reads the cards with `git ls-tree` and `git cat-file` from the newer of the
  local `sova/saved-sessions` and its remote-tracking branch (`merge-base --is-ancestor` picks it),
  with no checkout and no fetch.
- **Get Saved Sessions** fetches only the saved-sessions branch from the remote, then lists again. It
  shows while it works and says why when it fails: offline, no remote, a sign-in problem, or no saved
  sessions on the remote. It is shown only when the repository has a remote. This button and a pushed
  save are the only times saved sessions fetch anything, and both fetch that branch alone.
- **With none**, the card still shows when the repository has a remote, reading "No saved sessions
  yet"; its window says so and offers Get Saved Sessions. With no remote either (and nothing on main
  or to prune), there is no card at all. Nothing else announces saved sessions: no sidebar count or
  badge, no toast and no Needs-you item.

## §chat.saved-sessions/preview — Preview

**Preview** opens a read-only dialog (`GET /api/saved-sessions/preview`) showing who saved it and
when, its branches, the note, the model, the last few messages (text only), and the team and
subagent summary. It also says which model Continue would use. It warns when the history is bigger
than that model's window: Continue then starts from the last summary. It always reminds the reader to
continue only sessions from people they trust. Its buttons are Close and Continue.

## §chat.saved-sessions/continue — Continue into the blank session

**Continue** loads the saved conversation into the blank, unprompted session on screen
(`POST /api/saved-sessions/continue`). That session becomes the user's own, in their folder. The
saved files are left untouched, and the session records the bundle id and version it came from
(§chat.saved-sessions/saved-list).

- **Its title** is the saved session's title, as the saver wrote it.
- **The folder's branch never changes.** Continue never checks anything out. A session started on
  master stays on master.
- **Paths** in the saved text are restored: the root token becomes this repository's top-level
  folder, and a worktree token becomes that branch's worktree if one is set up here, else the
  top-level folder.
- **Model.** The saved model is used when this computer can run it. Otherwise it is the user's
  default, and Sova says which model it picked and why. Mode and sandbox are always the user's own
  picks from that screen; nothing saved changes them.
- **Too big for the model.** When the history is bigger than the model's window, the session starts
  from the last summary, and says so.
- **Worktrees.** For each branch the saved session worked on, Sova offers to set up a worktree. A
  local branch gets a worktree on it; a branch only on the remote gets a new local branch from the
  remote's. A branch that already has a worktree uses it, and the folder's own branch needs nothing.
  Worktrees the user sets up are tracked by the session, and the agent is told where they are in a
  note it reads; the user is told by a toast and sees them in the Session tab's Worktrees.
- **The continuation note** heads the conversation (§chat.saved-sessions/continuation-note).

Nothing is sent to the model until the user sends their first message.

## §chat.saved-sessions/continuation-note — What the agent and the user are told

A continued conversation carries one note, written where the saved history ends, so it is the last
thing the agent reads before the user's first message and the first thing the user sees: the thread
opens at its end, with the note just above the composer. The agent is given it once. It says the conversation was saved by {name} on {date} and continued here, and
gives the saver's note. It says the subagents and teams the conversation mentions ran on the original
computer and don't exist here: they can't be messaged, steered or waited on. It then gives their
summary (§chat.saved-sessions/workers) and says to start new ones if they are needed. When the
history was cut to fit the model, it says so. When the model fell back, it names the saved model and
the one in use.

## §chat.saved-sessions/import — A saved transcript is untrusted

Continuing a saved session is an act of trust, like running a colleague's script: the agent takes
what it says as true. On import Sova reads the transcript strictly and keeps only entries that shape
the conversation: messages, extension messages, compactions, branch summaries, context edits, model
and thinking-level changes, the session name and labels. Every other entry is dropped, so a saved
session can never carry grants, sandbox or mode changes, baton or overseer markers, worktree paths or
worker registries onto the colleague's computer. A malformed line, broken ancestry or a tool call
without its result refuses the import, never a partial copy. A transcript over the size limit is
refused too.

## §chat.saved-sessions/merge-guard — Sova's merges stop on saved sessions in history

A saved session belongs on its own branch. Sova's merges check the whole history being merged
(`git log <merge base>..<branch>`) for the saved-session marker, wherever a file holding it sits, and
not only under a known path. These are the `worktree` tool's merge (§chat.worktrees/tool), Merge
Branch (§app.project-runtime/merge) and the merge round (§chat.merge-round/round). A hit stops the
merge, names the commits and files, and says that removing the folder in a later commit leaves it in
history. The merge goes ahead only with an explicit override (`allowSavedSessions`). From the
`worktree` tool the override always asks the user to confirm first, sandbox or not, and its refusal
tells the agent it needs the saved sessions cleaned out of the branch's history or the user's
explicit go-ahead, never the flag itself; with no one to ask, or declined, nothing is merged. Merge
Branch's override is the operator's own `Merge Anyway`. Merges made outside Sova can't be guarded.

## §chat.saved-sessions/on-main — A saved session that reached main anyway

When a saved session turns up in the main branch's tree (`GET /api/saved-sessions/on-main`), for
example because someone copied it in by hand, or only in main's unpushed history (a merge made
anyway of a branch that added it and deleted it later), the new-session screen for that repository
flags it on its Saved sessions card with an error chip "In {main}", and the Saved sessions window
(§chat.saved-sessions/discovery) opens on an alert naming each one. It offers:

- **Remove from Main**, whenever it is in main's tree: one commit on main that deletes only those folders. It needs main's
  checkout to have no tracked changes. It says plainly that the conversation stays in history and
  that any secret in it must be changed. While main is unpushed, the removed one stays listed as
  being in main's unpushed history, with Purge from History offered.
- **Purge from History**, only while every commit that added them is unpushed. Sova first keeps the
  old head as a local `backstop/saved-sessions-<sha>` branch, then rebuilds only the unpushed commits
  without those folders, the merge round's scrub pattern. The result must fast-forward the remote's
  main, and its tree must differ from the old head only by the removed folders.
- **After a push**, a checklist instead of a button: change every secret it held, tell colleagues,
  force-push by hand if the team agrees, and ask the code host to clear cached copies. Sova never
  force-pushes.

## §chat.saved-sessions/prune — After a feature branch merges

When a branch that saved sessions name has merged into main, the Saved sessions window
(§chat.saved-sessions/discovery) offers, above its list, to delete them from the saved-sessions branch (`POST /api/saved-sessions/prune`) or
keep them. Deleting asks first, naming each saved session and who saved it, and whether the deletion
will be pushed. Deleting is an ordinary commit on that branch. It is pushed only when the project's push
choice is on. A saved session that also belongs to other branches only loses that branch.

## §chat.saved-sessions/remote — Remote sessions

For a session on a remote target, saving, listing, fetching, previewing, continuing and the merge
checks run on the session's host, through the same remote command path the rest of the session uses
(§mesh.remote-sessions/host-scope). The repository and its saved-sessions branch are the ones on that
host.
