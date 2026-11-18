# §chat/context-approval — Context files and skills: one switch per item
> Part of the Sova design spec · [overview](../design/overview.md)

What a chat loads from the folders it works in, its context files and its skills, is one switch per
item, kept per folder on this computer: on, new chats there load it; off, they don't. Each group has
one switch for all of its rows. One Sova-wide switch says what an item nobody has set starts as. A
new or changed item is a mark on its row; nothing ever waits for a decision.

## §chat.context-approval/setting — New context files and skills start on

- **One switch, Sova-wide.** Settings → General has a section **Context files and skills · this
  computer**, after Summary line and before Server · this machine (§app.settings-dialog/general),
  holding one switch, **New context files and skills start on**, with the hint "On, a context file
  or skill you haven't set loads in new chats. Off, it stays off, marked New, until you turn it on.
  Kept on this computer." It is **on** by default. A flip saves at once, apart from the dialog's Save
  Changes; a save that fails puts the switch back and says "Couldn't change that. {message}".
- **Where it is kept.** On this computer only, in `<state root>/context-approval.json`
  (`{allowWithoutAsking: true | false}`, written atomically; on is `true`). Only a missing file means
  the default, on. A file that can't be read, isn't JSON or doesn't hold a true or false counts as
  off, and the server logs a warning, once per distinct trouble, until the file is fixed or the
  switch is set again. `GET`/`PUT /api/settings/context-approval {allowWithoutAsking}` read and write
  it; a body without a true or false is refused (400).
- **Who may change it.** Turning it off is open to every caller. Turning it back on is the operator's
  own page only (/who); from anyone else it is refused (403) and nothing changes, with words for the
  caller, such as "A script can't let new context files and skills start on: turn it on in Settings
  → General. Nothing was changed." (the Overseer: "Only you let new context files and skills start
  on: the Overseer can't. Nothing was changed."; a chat: "A chat can't let new context files and
  skills start on: only you turn it on, in Settings → General. Nothing was changed."). The project overseer's `sova_settings` lists it but can't propose
  it (§app.project-overseer/settings).
- **What a change reaches.** Every chat started after it. Each chat still before its first message is
  told and its setup card is read again (/live). A chat already under way keeps the mode it started
  in. Turning it off turns nothing on: every item nobody has set is off and marked New (/marks).
- **On each project's All settings list.** A read-only row, **Context files and skills**, "New ones
  start on (Sova-wide)" or "New ones start off (Sova-wide)", "kept on this computer", links to
  Settings → General (§app.project-overseer/settings).

## §chat.context-approval/modes — One switch per item, in either mode

- **The switch is the decision.** Each context file and skill is one row with one switch: on a new
  chat's setup card (§chat.transcript/setup-card-toggles), the project's Context Files and Skills
  cards (/context-card, §chat.skill-sources/project-defaults) and a folder's list dialog (/folders).
  On means new chats in that folder load it; off means they don't. A flip shows at once and is saved
  for the folder (/at-once), and reaches only chats not yet started (/live, /fixed). No row has a
  state chip, and there is no Approve, Disallow, Allow, Re-approve, Approve All or Disallow All.
  Each group also has one switch for all of its rows (/group).
- **New ones start on** (the Sova-wide switch on). Off is Disallowed; every other item is on.
  Turning one back on only lifts its Disallow (back to no decision), so nothing is recorded as
  approved. No row is marked New or Changed.
- **New ones start off** (the Sova-wide switch off). On is approved, with the item's fingerprint
  (/list); off is Disallowed, or never set. An item never set is off and marked **New**; an approved
  one whose content changed since stays on and is marked **Changed** (/marks). A fingerprint kept
  from an earlier period of starting off stays in the list, so when new ones start off again such a
  row reads Changed again.
- **No switch for one chat.** A context file or skill has no switch of its own for one chat: a new
  chat's rows are its folder's switches. To start one chat without an item, turn it off, send that
  chat's first message and turn it back on: the chat keeps what it started with, and any other chat
  started in that folder meanwhile starts without it too. MCP servers keep their own per-chat
  switches (§chat.transcript/setup-card-toggles).

## §chat.context-approval/group — One switch per group, and Undo

- **The group switch.** A new chat's setup card has one switch for each kind, on its Context and its
  Skills heading, labelled "All context files" and "All skills". The project's Context Files and
  Skills cards and the two lists of a folder's dialog are split by where the items come from, **In
  the project** (**In this folder**), **In folders inside it**, **Above the project** (**Above this
  folder**; only a project kept in a folder inside a larger repository has rows there, /list), **Yours**
  and **Claude folder** (each shown only when it has rows), and each part's
  heading says "{on} of {n} on" and carries its own switch, labelled "All {context files | skills}
  {the part's name, lowercased}". Manual-only skills have no group switch
  (§chat.transcript/setup-card-skills). A group switch is on when every row of its group is on, off
  when every row is off, and in the middle (`aria-checked="mixed"`) when they differ, and says so
  beside it: On, Off or Mixed. Each row's switch says On or Off. Pressed from off or the middle it turns
  every row of its group on; pressed from on, every row off.
- **One save.** A group flip is one save naming each item it changes. To on: every row that is off,
  New ones included, is turned on (approved while new ones start off, its Disallow lifted while they
  start on); a row already on is left out, so a Changed row stays Changed and its fingerprint is
  never rewritten. The save says it is a group switch's (`group` in its body, the switch's id), and the server
  holds to this too: in a group save, `approved` for an item already approved is left out, even when
  it is the only item named. Outside a group save, `approved` for one item already approved is Accept
  Change and records a new fingerprint. To off: every row that is on is Disallowed. Turning rows on is the operator's own
  page only (/who).
- **What it did, and Undo.** Right after a group flip, one line under that group's heading says
  what it did, "Turned 6 skills off." or "Turned 2 context files on.", with **Undo**. It is in the
  flow of the page, not a toast, and stays until the next change in that group or a newer press of
  that same group switch. A press of another group in the same folder leaves it, so two groups can
  each show their own Undo at once. Undo puts back only its own group's switches, every switch the
  flip changed, back exactly as it was: the server writes back each item's record from before the
  flip, fingerprint included, so a Changed row reads Changed again and a New row New again. An item
  whose record changed after the flip keeps its newer state. Undo that turns a row back on is the
  operator's own page only.
- **The route.** A group save names its group switch's id, as `group: "<id>"` or as `groupId: "<id>"`
  beside `group: true` (1 to 100 letters, digits and `:_./-`: the page sends `setup:context` and
  `setup:skill` from a new chat's list, `card:context:<source>` and `card:skill:<source>` from the
  cards and a folder's dialog); `group: true` alone is read as "context", "skills" or "both" by what the
  save names. Any other value, a bad id, or a `groupId` without `group: true` is refused, 400 "group
  must be the group switch's id (up to 100 letters, digits and :_./-) or absent." A group save that changed at least one record answers an `undo` token; one that changed
  nothing answers none and leaves that group's token standing, and no other save takes or retires a
  token, however many items it names. The server keeps one token per folder and group, in memory,
  for a folder's 32 newest groups: the records from before that group's latest save. The same
  save route with `{undo: <token>}` and no changes (`{cwd, undo}` for the folder route) writes each
  item's earlier record back verbatim (its state, fingerprint and name; no record is unset) where the
  item's record still equals what the save wrote, and answers the fresh view with `undone` (the items
  put back) and `kept` (the items left, changed since); it answers no new token, and a token works
  once. Who may is judged on what it would put back (/who), and only the items so judged are
  written. A project's Undo writes one Settings
  history line per item whose state it changes (one that only puts a fingerprint back writes none).
  A token the server no longer holds (used, replaced by a newer save of the same group in that
  folder, dropped as the folder's oldest past 32 groups, or forgotten at a restart) is refused, 409 `{error: "Undo is no longer available. Nothing was
  changed.", code: "undo-gone"}`, which the page shows as a toast; a token that isn't a string, 400 "undo must be the token a group
  save answered with." It is the set route, so it adds no command.

## §chat.context-approval/marks — New and Changed are marks, never a hold

- **New.** While new ones start off, an item nobody has set is off and its row says **New**, a dot and
  the word, never colour alone. While new ones start on, no row is marked. A new chat's folded
  `System context` line counts them, "{n} new, off", and the Changed ones that are on, "{c}
  changed" (§chat.transcript/setup-card). There is no
  notice and nothing to press: turning the row on is the approval.
- **When New goes.** When the row is flipped; when its group switch turns it on or off; or when a
  chat's first message is sent after its System context was open while the row showed New: those
  rows are then saved as off (Disallowed, open to every caller, /who), and the mark goes. A first
  message sent with the list never opened clears nothing. A save that fails leaves the marks. That
  save turns no row on or off, so it rebuilds no chat (/live).
- **Changed.** An item turned on whose content no longer matches its fingerprint (/list) stays on and
  keeps loading. Its row says "Changed since you turned it on" with one button, **Accept Change**,
  which records the new fingerprint (the operator's own page only, /who); the mark goes, with no
  toast. It is the only button on any row. Turning the row off turns it off, and the mark goes with it. The group switch never
  accepts a change (/group).
- **Nothing waits.** A New or Changed item never holds Send or any chat (/held-send).

## §chat.context-approval/at-once — A flip shows at once, and comes back if it isn't saved

- **Everywhere you decide.** A row's switch, a group switch, Undo, Accept Change and a chat's Turn On
  show the new state at the click, before the save answers: on a new chat's setup card, the project
  page's Context Files and Skills cards (/context-card, §chat.skill-sources/project-defaults), a
  folder's list dialog (/folders) and a chat's "wasn't loaded" line (/mid-chat). The save runs behind
  it; the server's answer, or the next read of the list, replaces what was shown.
- **Every row stays clickable.** No switch waits for another save: while saves run, any row can be
  flipped, and a newer click on the same row is the one it keeps. A folder's saves go out one at a
  time in click order, whichever of these places made them; other folders' saves don't wait. A group
  switch covers the rows as they show at its click.
- **A save that is refused or fails** puts back only its own rows (the group switch and the marks
  with them), and shows that place's failure message; other rows keep what was clicked.
- **A save with no answer** fails the same way 90 s after its click: its rows go back, with the
  failure message ending "It didn't answer in 90 s.", and Send comes back. The folder's later saves
  still wait for its real answer, so none lands out of order; one that timed out before it went out
  is never sent. When the real answer comes after all, the place shows what the server did: a new
  chat's setup card and a project's card read the list again, and a chat's line shows its decision.
- **Send waits for the rebuilt chat.** On a new chat's setup card, after a flip made there, Send is
  held and the composer's notice says "Saving…" (§chat.composer/disabled-states) until the server
  has answered the save and a read of the card started after that answer has come back, so the chat
  shown is the one rebuilt with the new switches (/live). If that read fails it is tried once more
  1.5 s later; if that fails too, Send waits for the card's next read (the chat's rebuild and its
  reconnect read it again). A save that fails brings Send back with its rows put back.
- **The first message checks again.** Just before a new ordinary chat's first message goes in (from
  the page or its socket, `POST /api/sessions/prompt`, a group send, a to-do's or idea's Start, or any
  program), the server reads the folder's decisions again and lays them over the chat's own entry as
  its build does; when that differs from the list the chat was built with, the chat is rebuilt in its
  own process first (its panes reconnect), then the message goes in. When that rebuild fails, or the
  folder's switches or the chat's own entry can't be read, the message is refused and never sent:
  the page gets it back as its draft with "Sova couldn't apply your context file and skill switches
  to this chat, so your message wasn't sent. Send it again to retry.", a server-side send (`POST
  /api/sessions/prompt`, a group send, a Start) is refused with the same words, and the next message
  checks again. Workers, special chats and started chats aren't checked. A quick first
  send never goes out on an old list.
- **It loads nothing early.** What a chat loads follows only what the server saved; who may turn an
  item on is unchanged (/who).
- **The new chat screen stays put.** A flip on a new chat's setup card changes only its row, its
  group switch and the folded line's counts, in place: the page keeps its scroll position and every
  section stays open or closed as it was, also when the card is read again after the save (/live).
  While the chat restarts with the new list and reconnects, the screen keeps its controls (the model
  picker and the setup card's switches) until the chat says them again, and the view isn't sent back
  to the top, so the page doesn't move.

## §chat.context-approval/who — Who may turn an item on

- **Open to every caller:** turning an item off (a row, a group switch to off, the New marks a first
  message settles, /marks), an Undo that only turns rows off, and turning the Sova-wide switch off.
- **The operator's own page only:** turning an item on in either mode (a row's switch, a group switch
  to on, an Undo that turns a row back on, lifting a Disallow), **Accept Change**, turning the
  Sova-wide switch back on, and **Turn On** on a chat's "wasn't loaded" line (/mid-chat). The page is
  Sova's page on this computer, or the operator's page on another of their computers, which counts
  only with its proven click (the click-proof header that page's computer adds,
  §app.access/your-click); being a peer proves nothing on its own.
- **Refused (403, `yourClick: true`), and nothing changes,** with words for the caller: the Overseer
  ("Only you turn on context files and skills: the Overseer can't. Nothing was changed."), a chat ("A
  chat can't turn on context files or skills: its project overseer proposes it through
  sova_settings, on a card you apply. Nothing was changed."), a script ("A script can't turn on
  context files or skills: use the project's Context Files or Skills card, or the new chat's list.
  Nothing was changed."), an extension ("An extension can't turn on context files or skills. Nothing
  was changed."), and another computer whose click can't be confirmed ("This computer couldn't
  confirm your click with the one the list is on. Try again, or turn it on in that computer's page.
  Nothing was changed.").
- **The project overseer's way.** Its `sova_settings` proposes turning an item on as a grant on a
  Settings change card the operator applies (§app.project-overseer/settings).

## §chat.context-approval/list — The approval list: one per computer

- **Which folders.** One list on this computer covers every registered project (`p:<project id>`: its
  root, its worktrees and the folders inside them share it) and every folder a chat runs in that is no
  project (`d:<path>`: the nearest folder above the chat's holding `.git`, a linked worktree's main
  checkout so the two share one, stopping below the home folder; else the chat's folder itself).
- **How an item is known.** By its key in that folder: its path relative to the checkout it is in, so
  the project's main folder and its worktrees share one decision for the same file; outside every
  checkout (the user's own files and skills, the Claude folder, files above the project) its absolute
  path. A file that is a link (a `CLAUDE.md` pointing at `AGENTS.md`, a `SKILL.md` of yours shared
  from elsewhere) is known where it sits, never by what it points at; an item inside a folder reached
  through a link (a skill folder that is a link) is known by that folder's real place and its own name,
  and a chat's list names it the same way whichever path the loader gives it. A skill is known by its place, never by its name
  alone: a project skill named like one of yours is a row of its own, and a skill that moves asks
  again. An approval records the item's fingerprint (sha256): a context file's content, a skill's whole
  folder (/fingerprint).
- **Above the project, and outside it.** A project inside a larger repository lists the files
  between its root and the repository's top as **Above the project**. Files above a repository's top,
  at or above home, and a project's item linked out of it never load (§chat.context-scope/folders), so
  aren't listed; a decision kept for one drops off as any item no longer found does.
- **Your own files and skills.** The user's own context files and skills (pi's settings folder, the
  Claude folder, and an `AGENTS.md` in the home folder, listed only for a project or folder that is
  the home folder itself) are decided per folder like the folder's own; nothing trusts them by
  itself.
- **Changed since you turned it on.** When an approved item's content no longer matches its
  fingerprint, it stays loaded and its row is marked "Changed since you turned it on", with **Accept
  Change** (which records the new fingerprint) (/marks). It doesn't hold Send. An approval with no
  fingerprint, or an item that can't be read now, reads as changed.
- **Which files.** Context files are the instruction files pi loads (`AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`): pi's settings folder's, the chat's folder's and, inside a
  git repository, those of the folders above it up to the repository's top (§chat/context-scope),
  and those inside it (§chat/subfolder-instructions). A project's prompt files
  (`.pi/SYSTEM.md`, `APPEND_SYSTEM.md`) and its extensions are not on the list.
- **The scan.** Everything a chat in the folder could load is found by one scan of each checkout, the
  root first: pi's own context files and skills, then the subfolder walk's, each walk bounded as the
  subfolder walk is. A project's scan walks below unless its root is the home folder or a folder above
  it; a folder that is no project walks below only where its chats look below
  (§chat.subfolder-skills/offering), never at the home folder or above it. pi's own context files
  are only those of the folders a chat there may load from (§chat/context-scope). A new chat's setup
  card drops the scan's subfolder rows when the chat's own folder fails that rule, and lists no scan
  row outside the chat's own folder (a folder beside it in the checkout): only files it could load.
  One row per key, the first found. A scan that stopped early (a walk at its limit,
  a checkout that couldn't be read) says so on the cards: "The search stopped early, so this list may
  miss some {context files | skills}."
  What a scan finds is kept per checkout and read without holding up the server: pi's own lists (the
  checkout's context files and skills, those above it and the user's own) and the subfolder walk. A
  read of the list (the cards, a new chat's setup card) answers from the checkout's last read, and
  when that read began 10 s or more ago it starts one new read behind it. So a file or skill added or
  removed, at the root, below it, above it or in the user's own folders, shows from the first read
  after a read that began after the change. A save (any item turned on or off, from a card,
  the setup card, a chat or the project overseer's proposal) checks only the items it names: each is
  found in the folder's last scan, with no walk, and each item turned on is fingerprinted from its file
  as it is now (one gone or unreadable is refused, 409 "{key} can't be approved: it couldn't be read.
  Nothing was changed."); only a key the last scan lacks makes the save scan the folder again first.
  The save's answer is drawn from that scan, so an edit made since the last read shows as Changed at
  the next read. A setup read asked to be fresh reads the folder again first. Fingerprints
  are read at each scan; the list of checkouts is kept for 5 s.
- **Where it is kept.** In `<state root>/project-skills.json`, version 2 (`folders[<folder key>]`, each
  with `context` and `skills` by key, an approval with its fingerprint), written atomically. A decision
  on an item no longer found drops off, but only after a complete scan that began, and whose walks
  began, after the folder's latest save: a scan that read a walk from before a save drops nothing, and
  a later one does it.
- **Decisions from before.** A version 1 file still reads. Its Disallowed skills, kept by name, become
  the decision on the first skill a scan finds with that name. Its Approved ones are dropped: that
  skill is unset again (off and New while new ones start off).
- **When it can't be read.** A new chat's build takes nothing as decided, in the Sova-wide switch's
  mode (new ones off, when even that can't be read): while new ones start off, everything stays off.

## §chat.context-approval/fingerprint — A skill's fingerprint covers its whole folder

- **The whole folder.** A skill's fingerprint is taken over every regular file in its folder, not its
  `SKILL.md` alone, so an edited script or a file added beside it reads as **Changed since you
  turned it on** (/marks). A link to a file counts by the content it points at.
- **A rescan reads nothing unchanged.** Each file's hash is kept in memory by its real path, size,
  modification and change times and inode, so rescanning a folder that hasn't changed reads no file.
- **Not fully checked.** Past about 2000 files or 20 MB, and for a folder holding a link to a folder, a
  broken link or a file or folder Sova can't read, the folder is checked only by its files' names,
  sizes and dates. That row says "Not fully checked for changes: the folder is very large, or holds
  links or files Sova can't read." under the skill's description on the Skills card, and under its name in a new chat's list.

## §chat.context-approval/context-card — The Context Files card

- **Where.** The project page's Settings tab has a **Context Files** card right before the **Skills**
  card (§chat.skill-sources/project-defaults), after MCP Servers, and All settings has a **Context
  Files** row next to the Skills row (§app.project-overseer/settings). A peer's project (opened with
  `?host=`) shows neither.
- **What it lists.** Every context file a chat in the project could load (/list), each row with the
  file's name, where it comes from (the project, a folder inside it, **Above the project** for a
  project kept inside a larger repository, your own; never a file the chat can't load, §chat/context-scope),
  its size and one switch (/modes), with its New or Changed mark (/marks). Its heading carries the
  group switch and its Undo line (/group). Its line reads "New chats load the context files you turn
  on. Open chats keep theirs." With none found: "No context files found. A chat here would load
  none." A flip shows at once and saves (/at-once); a save that fails puts the row back and is a
  toast, "Couldn't save {name}. {message}".
- **The routes.** `GET /api/projects/:pid/context-files` answers its rows, counts, the mode and whether
  the scan was complete. `PUT /api/projects/:pid/context-files {files: {<key>: "approved" | "disallowed"
  | "waiting"}}` saves the files given and answers the fresh view, with an `undo` token for a group
  switch's save (`group`, /group); `{undo: <token>}` takes the save back. It is refused 400 for a bad body, 404
  for an unknown project or a key not found ("Nothing named "{key}" is found in {folder}."), 409 for
  an Undo no longer held, and 403 as /who says. Each save goes through the project's one write: one
  Settings history line per item whose state changed (`field: "context.<key>"`), then the project's
  chats not yet started are rebuilt (/live).
- **Commands.** `project.context-files.get` (Show Project Context Files) and `project.context-files.set`
  (Set Project Context Files) (§app.project-commands/projects-sweep).
- **The project overseer.** Its `sova_settings` lists each file's state by key and proposes
  `{setting: "context-files", files: {…}}` (§app.project-overseer/settings).

## §chat.context-approval/folders — A folder that is no project, and the Overseer's

- **From the chat.** A new chat's setup card ends its lists with where they are kept and how new ones
  start: "Kept for this project on this computer. New items start off." ("… start on.") with **Open
  Project Settings** (the project's Settings tab), or "Kept for this folder on this computer. New
  items start off." with **Edit Folder List**, which opens the folder's list in a dialog:
  its **Context Files** and **Skills**, the same rows, switches, group switches and marks as a
  project's cards, showing a flip at once and putting it back if its save fails (/at-once). A flip
  there reaches the folder's chats not yet started as a project's does (/live).
- **The Overseer.** The global Overseer runs in a folder that is no project. It follows that folder's
  list (/unwatched), and its head has a button that opens the same dialog, named "The Overseer's
  folder". While new ones start off it reads "{n} new, off" when some are, else **Context Files and
  Skills**; while they start on the button isn't shown.
- **The routes.** `GET /api/folder-approvals?cwd=<folder>` answers both lists of the folder a chat in
  `cwd` runs in (a project's folder answers for its project), and `PUT /api/folder-approvals {cwd,
  files?, skills?}` saves, with the rules of /who, answering an `undo` token for a group switch's
  save (`group`, /group); `{cwd, undo}` takes that save back. Only a project's folder or the folder of a chat
  recorded on this computer is answered; any other is refused (404: "No project or chat of this
  computer is in that folder."). They are `session.folder-approvals.get` (Show Folder Context Files and
  Skills) and `session.folder-approvals.set` (Set Folder Context Files and Skills).

## §chat.context-approval/held-send — Nothing waits for a decision

- **Send is never held for an item.** A New item (/marks) stays off and holds nothing, in either mode:
  a new chat's Send, its first message on `POST /api/sessions/prompt` and on the chat's socket, a
  page's send to a group (§workspace.groups/the-group-composer) and a to-do's or an idea's Start from
  the page all go through, and the chat starts with its New items off. No first message is refused
  for an item nobody has set, and there is no `decide-first` refusal.
- **No notice and no line.** A new chat's setup card has no notice counting what to approve, and
  the composer has no "Approve or disallow…" line and no Review (§chat.composer/disabled-states).
  The folded `System context` line says how many items are new and off (/marks).
- **What does hold Send** is only a flip on that card whose save hasn't settled yet, "Saving…"
  (/at-once).

## §chat.context-approval/unwatched — Chats no one watches start like any other

The merge thread, reviewers, Create flows, the Overseer and project overseers, scheduled automations,
a chat started on another computer by a program, and messages sent by a script or the API start as
every chat does: with what is off for their folder off, New items included, and nothing to wait
for. A project overseer loads only the project's own context files its list lets a new chat load.
The global Overseer follows its folder's list (§chat.context-approval/folders). Each of them loads
context files only from the folders its own folder allows (§chat/context-scope), as every chat does.

## §chat.context-approval/live — A flip reaches open new chats at once

After any save that turns an item on or off, and after the Sova-wide switch changes, each chat of the
folder this server holds that is still before its first message is rebuilt with the new list, and
every pane showing it reads its setup card again: its rows, its group switches and its marks follow
at once, in every tab. A save or Undo answers only after the refresh that covers it. A refresh waits
120 ms before it reads, and a save made while one waits or runs joins the next, so a burst of saves
rebuilds a waiting chat once after the last. A save that turns nothing on or off (Accept Change, the
New marks a first message settles, /marks) rebuilds nothing: the panes are only told to read the
card again. A started chat is never touched.

## §chat.context-approval/mid-chat — An item found after the first message

- **Never shown to the agent.** In a chat that started while new ones start off, a context file or
  skill of a folder inside it that isn't on its fixed list never loads and never stops the chat. A
  transcript line, which is not sent to the model, says "{file} wasn't loaded: it is off for this
  project." ("… for this folder." in a folder that is no project, and as the transcript's own text
  before the page knows the chat's folder; "The skill {name} wasn't loaded: …"), once per item.
- **Turn On on the line.** The line has one button, **Turn On** (the operator's own page only, /who).
  It saves the item on in the folder's list and also adds it to this chat's fixed list, so it loads
  at the agent's next touch of that folder once the save is accepted; the line says "Turned on. It
  loads at the agent's next step here." There is no Disallow: the item is already off. The line shows
  at the click (/at-once); a save that fails puts the line back with its button and is a toast,
  "Couldn't save {name}. {message}". `POST /api/sessions/approval {path, kind, item, state}` is the
  route (`session.approval.set`).

## §chat.context-approval/fixed — Each chat's list, fixed at its first message

- **The stamp.** At a chat's first message its list is written into its own record once
  (§chat.transcript/setup-card-toggles). A chat that started while new ones start off gets a mark saying so and
  its exact lists of what it may load, so anything that appears later stays off, also after a server
  restart or Reload Now, even when nothing was off. A chat started in the default mode keeps its off
  lists, disallowed context files included. A chat started before this feature, with no mark, keeps
  loading as it does today.
- **Everywhere it loads.** The list covers the context files and skills it starts with, the files
  and skills of folders inside it that it reaches while it works (§chat/subfolder-instructions,
  §chat.subfolder-skills/offering), a typed `/skill:name` and the composer's slash list. The one write
  to a fixed list after the first message is a Turn On on a "wasn't loaded" line (/mid-chat).
- **Workers.** A worker gets exactly its parent chat's fixed list and mode, context files included,
  set by Sova from the parent chat, never from the request, laid over what its own folder allows
  (§chat/context-scope).
- **The folder rule comes first.** No list brings back a context file the folder rule leaves out
  (§chat/context-scope). A chat whose list was fixed before the rule keeps that list, unchanged, and
  from its next rebuild loads only the files of it the rule allows.
- **Claude Code chats too.** A Claude Code chat runs on pi's prompt, so the same list covers it.
