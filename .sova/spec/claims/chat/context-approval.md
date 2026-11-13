# §chat/context-approval — Context files and skills: allowed, or asked first
> Part of the Sova design spec · [overview](../design/overview.md)

What a chat loads from the folders it works in, its context files and its skills, is decided per
folder on this computer. By default everything loads but what you disallowed. With one Sova-wide
switch turned off, nothing new loads until you approve it, and a new chat a person watches waits for
your decision before its first message.

## §chat.context-approval/setting — Allow context files and skills without asking

- **One switch, Sova-wide.** Settings → General has a section **Context files and skills · this
  computer**, after Summary line and before Server · this machine (§app.settings-dialog/general),
  holding one switch, **Allow context files and skills without asking**, with the hint "On, new chats
  load every context file and skill a folder offers except the ones you disallow. Off, anything you
  haven't approved stays off and a new chat waits for you to decide before it sends. Kept on this
  computer." It is **on** by default. A flip saves at once, apart from the dialog's Save Changes; a
  save that fails puts the switch back and says "Couldn't change that. {message}".
- **Where it is kept.** On this computer only, in `<state root>/context-approval.json`
  (`{allowWithoutAsking: true | false}`, written atomically). Only a missing file means the default,
  on. A file that can't be read, isn't JSON or doesn't hold a true or false keeps asking on, and the
  server logs a warning, once per distinct trouble, until the file is fixed or the switch is set again. `GET`/`PUT /api/settings/context-approval {allowWithoutAsking}` read and write it; a body without
  a true or false is refused (400).
- **Who may change it.** Turning it off (asking first) is open to every caller. Turning it back on is
  the operator's own page only (/who); from anyone else it is refused (403) and nothing changes, with
  words for the caller, such as "A script can't let context files and skills load without asking
  again: turn it on in Settings → General. Nothing was changed." The project overseer's
  `sova_settings` lists it but can't propose it (§app.project-overseer/settings).
- **What a change reaches.** Every chat started after it. Each chat still before its first message is
  told and its setup card is read again (/live). A chat already under way keeps the mode it started
  in. Turning asking on approves nothing by itself: every undecided context file and skill is
  Waiting.
- **On each project's All settings list.** A read-only row, **Context files and skills**, "Allowed
  without asking (Sova-wide)" or "Ask first (Sova-wide)", "kept on this computer", links to Settings →
  General (§app.project-overseer/settings).

## §chat.context-approval/modes — The default mode and the asking mode

- **The default mode** (the switch on). A Disallowed context file or skill stays off in new chats.
  Everything else loads as before this feature, with nothing to decide. New chats show no notice and
  no Approve, Approve All or "to approve" prompt, and Send is never held. A card row reads
  **Allowed** or **Disallowed**: **Disallow** on an allowed one, and **Allow** on a disallowed one,
  which only lifts the Disallow (back to no decision), so nothing is recorded as approved.
- **The asking mode** (the switch off). An item with no decision is **Waiting**, and a Waiting item
  stays off. A card row reads **Approved**, **Disallowed**, **Waiting** or **Changed** (/list): a
  Waiting one has **Approve** and **Disallow**, an approved one **Disallow**, a disallowed one
  **Approve**, a changed one **Re-approve** and **Disallow**. A new chat's setup card asks for the
  decisions (/held-send).
- **Both modes.** The per-chat switch on a new chat's setup card (§chat.transcript/setup-card-toggles)
  still turns an item on or off for that one chat, and never counts as deciding it.

## §chat.context-approval/at-once — A decision shows at once, and comes back if it isn't saved

- **Everywhere you decide.** Approve, Re-approve, Allow, Disallow, Approve All and Disallow All show
  the new state at the click, before the save answers: on a new chat's setup card and its notice
  (/held-send), the project page's Context Files and Skills cards (/context-card,
  §chat.skill-sources/project-defaults), a folder's list dialog (/folders) and a chat's "wasn't
  loaded" line (/mid-chat). The save runs behind it; the server's answer, or the next read of the
  list, replaces what was shown.
- **Every row stays clickable.** No button waits for another save: while saves run, any row can be
  decided, and a newer click on the same row is the one it keeps. A folder's saves go out one at a
  time in click order, whichever of these places made them; other folders' saves don't wait. Approve
  All and Disallow All cover what is still waiting at the click, never a row already decided and
  still saving.
- **A save that is refused or fails** puts back only its own rows (the notice's count too), and
  shows that place's failure message; other rows keep what was clicked.
- **A save with no answer** fails the same way 90 s after its click: its rows go back, with the
  failure message ending "It didn't answer in 90 s.", and a Send it held comes back. The folder's
  later saves still wait for its real answer, so none lands out of order; one that timed out before
  it went out is never sent. When the real answer comes after all, the place shows what the server
  did: a new chat's setup card and a project's card read the list again, and a chat's line shows its
  decision.
- **Send waits for what you decided here.** On a new chat's setup card, in either mode, while any
  decision made there has a save the server hasn't answered yet, Send is held and the composer line
  says "Saving…" (when nothing else waits, /held-send, §chat.composer/disabled-states). Once the
  server accepts the save, Send no longer waits for it, also when the read of the card after it
  fails. The card's per-chat switches wait longer: until a read of the card started after the answer
  has come back, since a switch sends the on and off set the card shows. If that read fails, it is
  tried once more 1.5 s later; if that fails too, the rows keep showing the decision (the notice's
  count too) and the switches stay waiting until the card's next read (the chat's rebuild and its
  reconnect read it again, /live). A message is never sent and then refused for an unsaved decision.
- **It loads nothing early.** What a chat loads, and whether its Send is held for Waiting items,
  follow only what the server saved (/held-send); who may decide is unchanged (/who).
- **The new chat screen stays put.** A decision on a new chat's setup card changes only its row and
  the notice's count, in place: the page keeps its scroll position and every section stays open or
  closed as it was, also when the card is read again after the save (/live). While the chat restarts
  with the new list and reconnects, the screen keeps its controls (the model picker and the setup
  card's decisions) until the chat says them again, and the view isn't sent back to the top, so the
  page doesn't move.

## §chat.context-approval/who — Who may decide

- **Open to every caller:** disallowing, and turning the Sova-wide switch off.
- **The operator's own page only:** approving (Re-approve included), turning a disallowed item back
  on (Approved or Waiting), turning the switch back on, a new chat's switch turning on a row its
  folder keeps off (Disallowed, or Waiting while asking), and Approve on a chat's "wasn't loaded"
  line (/mid-chat). The page is Sova's page on this computer, or the operator's page on another of
  their computers, which counts only with its proven click (the click-proof header that page's
  computer adds, §app.access/your-click); being a peer proves nothing on its own.
- **Refused (403, `yourClick: true`), and nothing changes,** with words for the caller: the Overseer
  ("Only you approve context files and skills, or turn a disallowed one back on: the Overseer can't.
  Nothing was changed."), a chat ("A chat can't approve context files or skills, or turn a disallowed
  one back on: its project overseer proposes it through sova_settings, on a card you apply. Nothing
  was changed."), a script ("A script can't approve context files or skills, or turn a disallowed one
  back on: use the project's Context Files or Skills card, or the new chat's card. Nothing was
  changed."), an extension, and another computer whose click can't be confirmed ("This computer
  couldn't confirm your click with the one the list is on. Try again, or decide on that computer's
  page. Nothing was changed.").
- **The project overseer's way.** Its `sova_settings` proposes an approval as a grant on a Settings
  change card the operator applies (§app.project-overseer/settings).

## §chat.context-approval/list — The approval list: one per computer

- **Which folders.** One list on this computer covers every registered project (`p:<project id>`: its
  root, its worktrees and the folders inside them share it) and every folder a chat runs in that is no
  project (`d:<path>`: the nearest folder above the chat's holding `.git`, a linked worktree's main
  checkout so the two share one, stopping below the home folder; else the chat's folder itself).
- **How an item is known.** By its key in that folder: its path relative to the checkout it is in, so
  the project's main folder and its worktrees share one decision for the same file; outside every
  checkout (the user's own files and skills, the Claude folder, files above the project) its absolute
  path. A file that is a link (a `SKILL.md` shared from elsewhere, a `CLAUDE.md` pointing at `AGENTS.md`)
  is known where it sits, never by what it points at. A skill is known by its place, never by its name
  alone: a project skill named like one of yours is a row of its own, and a skill that moves asks
  again. An approval records the item's fingerprint (sha256): a context file's content, a skill's whole
  folder (/fingerprint).
- **Above the project.** Instruction files in the folders between the home folder and the project's
  root (the folder holding its worktrees, say) are listed as **Above the project** and are decided
  like the project's own.
- **Your own files and skills.** The user's own context files and skills (pi's settings folder, the
  Claude folder, an `AGENTS.md` in the home folder) are decided per folder like the folder's own;
  nothing trusts them by itself.
- **Changed since you approved.** When an approved item's content no longer matches its fingerprint,
  it stays loaded and is marked **Changed since you approved** in a new chat's list (**Changed** on a
  card), with **Re-approve** (which records the new fingerprint) and **Disallow**. It doesn't hold
  Send. An approval with no fingerprint, or an item that can't be read now, reads as changed.
- **Which files.** Context files are the instruction files pi loads (`AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`): pi's settings folder's, the chat's folder's and every folder's
  above it, and those inside it (§chat/subfolder-instructions). A project's prompt files
  (`.pi/SYSTEM.md`, `APPEND_SYSTEM.md`) and its extensions are not on the list.
- **The scan.** Everything a chat in the folder could load is found by one scan of each checkout, the
  root first: pi's own context files and skills, then the subfolder walk's, each walk bounded as the
  subfolder walk is. A project's scan walks below unless its root is the home folder or a folder above
  it; a folder that is no project walks below only where its chats look below
  (§chat.subfolder-skills/offering), never at the home folder or above it. A new chat's setup card
  drops the scan's subfolder rows when the chat's own folder fails that rule.
  One row per key, the first found. A scan that stopped early (a walk at its limit,
  a checkout that couldn't be read) says so on the cards: "The search stopped early, so this list may
  miss some {context files | skills}."
- **Where it is kept.** In `<state root>/project-skills.json`, version 2 (`folders[<folder key>]`, each
  with `context` and `skills` by key, an approval with its fingerprint), written atomically. A decision
  on an item no longer found drops off, but only after a complete scan.
- **Decisions from before.** A version 1 file still reads. Its Disallowed skills, kept by name, become
  the decision on the first skill a scan finds with that name. Its Approved ones are dropped: that
  skill is Waiting again.
- **When it can't be read.** A new chat's build takes nothing as decided, in the Sova-wide switch's
  mode (asking, when even that can't be read): with asking on, everything stays off.

## §chat.context-approval/fingerprint — A skill's fingerprint covers its whole folder

- **The whole folder.** A skill's fingerprint is taken over every regular file in its folder, not its
  `SKILL.md` alone, so an edited script or a file added beside it reads as **Changed since you
  approved**. A link to a file counts by the content it points at.
- **A rescan reads nothing unchanged.** Each file's hash is kept in memory by its real path, size,
  modification and change times and inode, so rescanning a folder that hasn't changed reads no file.
- **Not fully checked.** Past about 2000 files or 20 MB, and for a folder holding a link to a folder, a
  broken link or a file or folder Sova can't read, the folder is checked only by its files' names,
  sizes and dates. That row says "Not fully checked for changes: the folder is very large, or holds
  links or files Sova can't read." under the skill's description on the Skills card, and under the waiting line in a new chat's list.

## §chat.context-approval/context-card — The Context Files card

- **Where.** The project page's Settings tab has a **Context Files** card right before the **Skills**
  card (§chat.skill-sources/project-defaults), after MCP Servers, and All settings has a **Context
  Files** row next to the Skills row (§app.project-overseer/settings). A peer's project (opened with
  `?host=`) shows neither.
- **What it lists.** Every context file a chat in the project could load (/list), each row with the
  file's name, where it comes from (the project, a folder inside it, **Above the project**, your own),
  its state as a chip, and the buttons its mode gives it (/modes). Its line reads "New chats load these
  context files, except the ones you disallow. Open chats keep theirs.", or while asking "New chats
  load the context files you approve. Open chats keep theirs." With none found: "No context files
  found. A chat here would load none." A click shows its new state at once and saves (/at-once); a
  save that fails puts the row back and is a toast, "Couldn't save {name}. {message}".
- **The routes.** `GET /api/projects/:pid/context-files` answers its rows, counts, the mode and whether
  the scan was complete. `PUT /api/projects/:pid/context-files {files: {<key>: "approved" | "disallowed"
  | "waiting"}}` saves the files given and answers the fresh view: refused 400 for a bad body, 404 for
  an unknown project or a key not found ("Nothing named "{key}" is found in {folder}."), and 403 as
  /who says. Each save goes through the project's one write: one Settings history line per item whose
  state changed (`field: "context.<key>"`), then the project's chats not yet started are rebuilt.
- **Commands.** `project.context-files.get` (Show Project Context Files) and `project.context-files.set`
  (Set Project Context Files) (§app.project-commands/projects-sweep).
- **The project overseer.** Its `sova_settings` lists each file's state by key and proposes
  `{setting: "context-files", files: {…}}` (§app.project-overseer/settings).

## §chat.context-approval/folders — A folder that is no project, and the Overseer's

- **From the chat.** A new chat's setup card ends its lists with where they are kept: "Kept for this
  project on this computer." with **Open Project Settings** (the project's Settings tab), or "Kept for
  this folder on this computer." with **Edit Folder List**, which opens the folder's list in a dialog:
  its **Context Files** and **Skills**, the same rows and buttons as a project's cards, showing a
  decision at once and putting it back if its save fails (/at-once). A decision there reaches the folder's chats not yet started as a project's does.
- **The Overseer.** The global Overseer runs in a folder that is no project. With asking on, it
  follows that folder's list (what waits stays off, and it never waits for you, /unwatched), and its
  head has a button that says how many wait ("{n} to approve", else **Context Files and Skills**) and
  opens the same dialog, named "The Overseer's folder". Without asking the button isn't shown.
- **The routes.** `GET /api/folder-approvals?cwd=<folder>` answers both lists of the folder a chat in
  `cwd` runs in (a project's folder answers for its project), and `PUT /api/folder-approvals {cwd,
  files?, skills?}` saves, with the rules of /who. Only a project's folder or the folder of a chat
  recorded on this computer is answered; any other is refused (404: "No project or chat of this
  computer is in that folder."). They are `session.folder-approvals.get` (Show Folder Context Files and
  Skills) and `session.folder-approvals.set` (Set Folder Context Files and Skills).

## §chat.context-approval/held-send — A new chat waits for your decision (asking mode)

- **The quick scan.** With asking on, a new chat's setup card lists everything the chat could load,
  the items of folders inside it included (/list), so they are decided before the first message.
- **The notice.** While any of them is Waiting, the setup card shows one notice counting context files
  and skills together, "{n} to approve for this project." ("… for this folder." outside a project),
  with **Review**, **Disallow All** and a primary **Approve All**, and each Waiting row says "Waiting
  for your decision · off until you approve it" with its own **Approve** and **Disallow**. Each shows
  its new state at once, the notice's count included, without moving the page (/at-once); a save that
  fails puts it back and is a toast: "Couldn't save {what} for {folder}. {message}".
- **Send is held.** You can type and the draft is kept, but Send is disabled, and one composer line
  says "Approve or disallow {n context files and m skills} to send." with **Review**, which opens the
  setup card's list (§chat.composer/disabled-states). Approve, Disallow, Approve All and Disallow All
  all count as deciding; the per-chat switch alone does not. Send comes back as soon as nothing waits,
  also when the decision is made in another tab or on the project page (/live).
- **Saving.** When nothing waits but a decision made on this page has a save not yet answered, Send
  stays held and the composer line says "Saving…" in place of the usual line (/at-once, which holds in the
  default mode too). A save that fails brings its items and the usual line back. A message is never
  sent and then refused for an unsaved decision.
- **An early first send.** A first send that arrives before the chat has reported the list it was
  built with is judged from its folder's list: while anything waits it is held, never let through as
  if nothing waited.
- **The server holds it too.** A watched page's first message (this computer's page, or the
  operator's page on another computer relayed through it) into a chat that is before its first
  message and still has Waiting items is refused, 409 `{error: "Approve or disallow {n} context files
  and skills to send.", code: "decide-first", waiting}`, and the message comes back as the draft
  (§chat.transcript/send-while-starting). The same holds on the chat's socket.
- **A group send.** A page's send to a group (§workspace.groups/the-group-composer) holds only the copy
  of a member that has items to decide, as that member's draft ("It is a new chat with context files
  or skills to approve or disallow first: the message waits as its draft."); the other members get
  theirs.
- **A Start from the page.** A to-do's or an idea's Start from the page into a folder that asks first
  makes the chat with its message held as the chat's draft, and says so: "{where} Its message waits in
  the composer: decide {n} context files and skills to send it."
- **When the check fails.** If counting the Waiting items fails, Send isn't held; the items stay off
  all the same.

## §chat.context-approval/unwatched — Chats no one watches are never held

The merge thread, reviewers, Create flows, the Overseer and project overseers, scheduled automations,
a chat started on another computer by a program (a direct call between computers, not a relayed
page), and messages sent by a script or the API go through. With asking on they start with their
Waiting items off. A project overseer loads only the project's own context files its list lets a new
chat load. The global Overseer follows its folder's list (§chat.context-approval/folders).

## §chat.context-approval/live — A decision reaches open new chats at once

After any decision, and after the Sova-wide switch changes, each chat of the folder this server holds
that is still before its first message is rebuilt with the new list, and every pane showing it reads
its setup card again: its rows, its notice and its held Send follow at once, in every tab. A started
chat is never touched.

## §chat.context-approval/mid-chat — An item found after the first message

- **Never shown to the agent.** In a chat that started with asking on, a context file or skill of a
  folder inside it that isn't on its fixed list never loads and never stops the chat. A transcript
  line, which is not sent to the model, says "{file} wasn't loaded: it isn't approved for this
  folder." ("The skill {name} wasn't loaded: …"), once per item.
- **Approve and Disallow on the line.** **Approve** (the operator's own page only, /who) saves the
  approval in the folder's list and also adds the item to this chat's fixed list, so it loads at the
  agent's next touch of that folder once the save is accepted; the line says "Approved. It loads at
  the agent's next step here." **Disallow** saves for the folder; the line says "Disallowed. It stays
  out." Each line shows at the click (/at-once); a save that fails puts the line back with its buttons
  and is a toast, "Couldn't save {name}. {message}". `POST /api/sessions/approval {path, kind, item,
  state}` is the route (`session.approval.set`, Approve or Disallow in a Chat).

## §chat.context-approval/fixed — Each chat's list, fixed at its first message

- **The stamp.** At a chat's first message its list is written into its own record once
  (§chat.transcript/setup-card-toggles). A chat that started with asking on gets a mark saying so and
  its exact lists of what it may load, so anything that appears later stays off, also after a server
  restart or Reload Now, even when nothing was off. A chat started in the default mode keeps its off
  lists, disallowed context files included. A chat started before this feature, with no mark, keeps
  loading as it does today.
- **Everywhere it loads.** The list covers the context files and skills it starts with, the files
  and skills of folders inside it that it reaches while it works (§chat/subfolder-instructions,
  §chat.subfolder-skills/offering), a typed `/skill:name` and the composer's slash list. The one write
  to a fixed list after the first message is an Approve on a "wasn't loaded" line (/mid-chat).
- **Workers.** A worker gets exactly its parent chat's fixed list and mode, context files included,
  set by Sova from the parent chat, never from the request.
- **Claude Code chats too.** A Claude Code chat runs on pi's prompt, so the same list covers it.
