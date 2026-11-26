# §app/transport — Transport a chat to another of your devices
> Part of the Sova design spec · [overview](../design/overview.md)

Transport… sends a whole chat to another device of your mesh: its home (§app/chat-homes), its code
with every unfinished change, and its team. A **Copy** leaves the original as it is. A **Move** hands
the chat over and leaves a Moved row behind. A Transport agent on the destination gets that device
ready first. The original keeps working until the destination has proved the chat opens there, and
the chat never runs on two devices at once.

## §app.transport/start — Only your own click starts it

- **Where.** `Transport…` is in a chat's ⋯ menu (§app.session-list/row-menu) and on its session pane,
  for a chat with a home on this device. It opens the dialog (§app.transport/dialog).
- **Your click only.** A transport starts only from this device's own page, by your click
  (§app.access/your-click). A chat, its workers, a script, an extension's key, the Overseer and
  another computer are refused, each with where to click: "Only you start a transport, from this
  device's page. Nothing was sent." No agent tool or catalogue command starts one.
- **A ticket for this one chat.** Your click mints a one-time ticket. It is tied to this chat and to
  the device you chose, and it lets that device fetch this chat from this one, and only this chat,
  without any standing grant of yours to it (§mesh.peers/transport-ticket). The ticket is never shown in the
  chat, its transcripts, logs or events, and no chat or extension key can mint one. It is burnt
  once the destination has verified the package, or when the transport is cancelled or fails for
  good. The destination still needs its own grant to this device: sessions, the same grant
  starting any chat there needs.
- **Refused, with the reason.** Each refusal names why, changes nothing, and greys out Start
  Transport:
  - while the chat's branch is in the merge queue: "Its branch is in the merge queue. Transport it
    once it leaves the queue.";
  - a special chat, refused as Fork refuses it: the Overseer, a project overseer, a hand-off or
    organization session, a helper's own chat, a chat open in a terminal, a chat whose tools run on a
    remote target, a transport's own agent;
  - a chat with no home (from before homes): "This chat is from before chat homes, so it can't be
    transported.";
  - a destination that reads Update needed (§mesh.compatibility/update-needed), is offline, or
    doesn't grant this device sessions;
  - a chat already being transported;
  - a Moved row, which runs on the other device now: "This chat moved to {device}; it runs there now.
    Transport it from there.";
  - a compressed chat (§app.session-list/archive-compression): "A compressed chat can't be transported."

## §app.transport/dialog — The Transport dialog

A `.modal` titled "Transport This Chat", drawn over the whole page (on a phone too, where it opens from a
chat's details): its sections are flat, each under a small heading, never boxes inside the sheet, and a
size sits at the end of its line:

- **Copy or Move,** as two tabs, Move first. Copy: "Leaves this chat here as it is." Move: "Hands the
  chat to that device. Here it becomes a Moved row."
- **Device**, a select of your mesh devices (§mesh/peers), each with its state. **Folder on that
  device**, prefilled with the project's folder there, else the same path under that device's
  home.
- **Travels**, with sizes: the conversation and records, the code (its branch and unfinished changes,
  its submodules' included), the team (helpers, their conversations and inboxes), and scratch folders.
- **Private files git ignores**: each one listed with its size, all ticked. An unticked file stays
  here. The choice is remembered per project and device.
- **Stays here**, with sizes: build output and dependencies (rebuilt there, §app.transport/package),
  share and preview links (they end), and background jobs and running copies by name, which a
  Move stops at the switch.
- **That device still needs**: what the destination lacks (the project, its tools, its own values),
  which the Transport agent prepares (§app.transport/agent). Its model is a select, set to the
  strongest model that device can run (§app.transport/agent). When that device lacks the project and
  can't clone it (§app.transport/package), its first line reads that the project comes from this
  device, with the size of the history that adds to the package (its checked-out submodules'
  histories included), and the project's folder isn't
  listed as something to clone. What the project's own setup needs there is then listed under
  "After it arrives": this device sends that device the project's setup definition with the
  question (the tools its files and `.sova/project.json` name, and the host values it declares,
  read from the files here), and that device checks them against itself before the project is
  there: each tool it doesn't find for you, the dependencies the project installs (they never
  travel), and each host value it doesn't hold. Asking runs none of the project's commands on
  either device.
- **Busy helpers** (Move only): the choice of §app.transport/safe-transport.
- **Large new files**: an untracked file over 50 MB is listed with its size and unticked until you
  tick it (§app.transport/edge-cases).
- A file's row is its box, its path and its size; the whole row is the target.
- Foot, at its end: `Cancel` · `Start Transport` (accent). While a transport is under way: `Cancel`
  (it cancels the transport); needing you, `Cancel` · `Retry` (accent), the reason in the banner above,
  said once. A start that failed puts "Nothing was sent." over its reason; a refused Cancel, Retry or
  interrupt shows only the reason it was given (the transport may still be going in). After a
  refused Cancel the dialog keeps following the transport, and that reason clears once it is done or
  cancelled; at Needs you it stays beside the Needs you banner. Its words are in
  §design.copy-deck/transport.
- **While it runs,** the dialog shows the transport's steps (§app.transport/progress).

## §app.transport/progress — Following a transport while it runs

You can see where a transport is, from the dialog or from the chat itself, without waiting blind.

- **Its steps, in order.** While a transport runs, the Transport dialog lists its steps: Preparing
  {device} · Waiting for helpers (only a Move whose helpers were busy) · Stopping jobs and running
  copies (Move only) · Packing · Sending · Checking on {device} · Opening on {device}. A step done
  has a tick, the current one the live dot, one still to come a hollow dot, and a step that stopped
  (Needs you) the alert mark with its reason under it, with Retry and Cancel as before. The current
  step is read from the steps already finished, never from the transport's state alone. The dialog
  ends at Opening: what follows there (setup) shows on the Transport agent's card in the arrived
  chat (§app.transport/agent). Done shows its done line under the ticked steps; Cancelled keeps
  "Cancelled. Nothing moved.", with no steps.
- **While sending, a meter**: how much has arrived of the whole ("12 of 34 MB", both in the whole's
  unit), its bar, and once known the speed and the time left ("1 MB/s · 25 s left"). The speed is an
  average over the newest readings, shown only once there are enough of them over a few seconds; it
  is never shown as zero or as endless: when nothing moved lately, neither speed nor time left
  shows. A pull begun again (a Retry, a new package, a repack) counts from nothing: the bar
  never shows the last pull's bytes against the new package.
- **In the chat itself.** While a transport from this device runs or needs you, the chat's head
  shows, under its path line, "Moving to {device} · {step}" ("Copying to …" for a Copy), with the
  live dot, or the alert mark and "Needs you" when it stopped; while sending, the step reads
  "Sending 12 of 34 MB". Clicking it opens the Transport dialog. It goes when the transport is done
  or cancelled. On a narrow head "Moving to {device}" gives way first and the step stays whole. The
  chat list's row shows nothing of it.
- **That device's steps reach this one.** While it follows a transport, this device keeps that
  device's own steps (prepared, pulled, staged, verified, published, opened) as that device says
  them, and its newest readings of what has arrived, each with the time it was read. They are for
  showing only: nothing here decides anything from them.
- **One follower per transport.** The dialog and the chat's head read the same follower, about every
  1.5 s, which stops at done, cancelled or Needs you, and follows again after Retry. The done toast
  comes from it when a followed transport finishes, the dialog closed or not.

## §app.transport/package — What is packed, and when

- **Packed when the switch comes,** never kept in advance. Everything is packed then into one package:
  - the chat's home, conversations cut at their last complete line, without the unsent draft;
  - for a Move, this chat's usage and time records, cut from this device's own stores;
  - per worktree, its code, so it arrives exactly as it is: every commit, staged and unstaged changes,
    new files, renames, modes and symlinks, plus the scratch folders git ignores and the ticked
    private files;
  - each of its submodules, nested ones too, the same way as the project itself: one checked out
    here travels with its commit, its unfinished changes, its new files, its scratch folders and
    its ticked private files (listed in the dialog by their path in the worktree, under the same
    private-file rules), and its commits: only what its remote lacks when that device can fetch its
    remote, else its whole history. Its remote is the address `.gitmodules` gives, a relative one
    resolved against the address of the repository holding it, as git resolves it; that device
    checks each one with the same quick check that asks for nothing. A submodule never checked out
    here travels as the commit its project records, nothing more.
  
  A repack of the same state gives the same bytes.
- **The project from this device, when that device can't clone it.** When the destination lacks
  the repository at the chosen folder (nothing there, or an empty folder) and can't get it by clone
  (no remote recorded, or none answers from there), the project travels from this device: the
  package also carries the repository's default branch and the chat's branches with their whole
  history, never another remote's branches. Nothing is pushed anywhere, so this works for a project
  with no online repository; the first transport of a large project to a device that lacks it takes
  longer. The destination decides it: a quick check of each recorded remote that asks for nothing
  (no password prompt, no credential window, ssh in batch mode) and gives up after a few seconds. A
  Retry after preparation stopped with the folder still lacking the repository (the Transport
  agent's clone failed) takes this path too. No credential travels in the package or reaches a log.
- **Rebuilt there.** Dependencies, build output and the download caches of build tools are never
  sent: neither the device-wide ones (`~/.m2`, Cargo's registry, Go's modules and the like), which
  stay shared on each device for its own build tools, nor a worktree's own (`node_modules`, `target`,
  `dist`, `build`, `.gradle`, `.cpcache`, a project-local `.m2` repository, a gitlibs folder, a
  `.venv`, a pnpm store and the like), nor a link named as one of their folders (a worktree's
  `node_modules` linking to the main checkout's). Each is listed under Stays here, never as a private
  file, a new file or a scratch folder's file, and a file inside one git tracks nothing in stays
  with its folder even when git doesn't ignore it. A source folder that only shares such a name
  (`src/build`, `scripts/out`, holding tracked files) sends its new files like any new file. A plain file that only shares
  such a name stays the file it is. The destination rebuilds them with the project's own setup
  (§app/project-setup), or the Transport agent does.
- **Copy** packs the same.
- **Through Sova's servers.** The destination pulls the package from this device's peer listener
  with its ticket, resumably and checked by hash, as file offers are pulled (§mesh.links/transfer).

## §app.transport/arrival — Staged, verified, then published in one step

- **Staging first.** The destination unpacks into a staging folder of its own for this attempt.
- **Only where you chose.** Every worktree the offer names must lie inside the parent of the folder
  you chose there, links resolved (a tree under a link pointing elsewhere is refused). The
  repository's place is given relative to that parent, and may lie above it (a worktree folder
  beside its repository); an absolute one is refused ("Bad repository path"), and it passes the same
  check as the folder you chose: inside your home there, never in Sova's own state, links resolved.
  An offer that fails is refused with the reason, and nothing is made for it, not even a transport
  record.
- **Verified.** It rebuilds each worktree there and checks every carried file's hash and the tracked
  status against what this device recorded. Unpacking and checking read each file as a stream, never
  whole into memory, whatever its size.
- **Submodules as they were.** Each submodule checked out here is made inside its worktree at its
  path, in git's own layout (its repository in the worktree's git folder under `modules/`), on the
  commit it was on (detached, as `git submodule update` leaves it, or on its branch when it was on
  one), with its unfinished changes and its own submodules, and checked like the worktree: its
  commit, its tracked status and every carried file. Its commits come from the package, after what
  its remote has when only that travelled (fetched asking for nothing). Its remote and the
  project's record of it are set to the address `.gitmodules` gives, without credentials. One whose
  commit isn't the one its project records arrives the same, so the project there shows it
  changed as it did here. One never checked out here arrives as its commit's link only, not
  checked out there either, and the arrival note says so. In a folder already holding the project,
  a submodule already checked out there at its project's commit takes the chat's state at publish;
  one with changes of its own, at a commit the chat's doesn't build on, or with files standing
  where the chat's add one is refused, replacing nothing, and its files git doesn't hold go in
  beside what is there as the project's own do.
- **Published in one step.** Once everything is verified, the worktrees go to their folders and the
  chat appears in one step. Each linked worktree is known to git by its folder's name there, as if it
  had been added there: nothing named for the staging folder is left. Nothing opens a staged chat before the last changes are in.
- **One step at a time.** On the destination, arriving, publishing and Cancel's removal run one
  after another for a transport, never two at once. A publish asked again while one runs or waits
  its turn (this device asking again after a slow publish) takes that run's answer, so one publish
  never runs twice. A new package while an arrival runs waits for it, and the older run records
  nothing: one that fails after the newer package replaced it says nothing (no Needs you), and the
  newer one's arrival runs by itself. Once publishing has begun a new package is refused ("It is already being put in place
  here."), and after Cancel both a package and a publish are ("It was cancelled here.").
- **The repository from the package.** When the project came from this device
  (§app.transport/package), the destination makes the repository from the package in staging, beside
  its folder: the carried branches, its default branch checked out and clean, and origin set to the
  recorded remote's address without credentials (no remote recorded: no origin). The chat's worktrees
  are then built on it as below, verified, and the repository and its worktrees are published in the
  same one step. A folder that has filled up since is never replaced: publish refuses with the reason.
- **A folder already holding the project** (a clone the Transport agent made, or your own) is built on:
  clean and at the chat's commit or behind it, it takes the chat's commits, branch and unfinished
  changes at publish; its own branch and build output stay. Refused, with the reason: changes of its
  own, another repository, a commit the chat doesn't build on, or a file standing where the chat's
  code adds one. The files git doesn't hold are put in beside what is there, replacing nothing: a
  file there that differs is kept, the arrived one goes beside it as `{name}.from-{device}`, and the
  arrival note names both; a private file's arrived copy stays hidden from git like the file it sits
  beside. A private file goes to the Transport agent where it landed.
- **Paths rebuilt.** Each worker record's folder, extensions and environment are pointed at the
  destination's. Each conversation is found by its session id in the same home. So the team's
  records, reports and resumes work there.
- **Registered there.** When the destination's Sova has no project at the folder the project arrived
  in, arrival registers it there, as adding a project does (§app/projects), with this device's Sova
  settings for it: its name, its project overseer's settings and its context-file and skill
  decisions for new chats (each by its project-relative file, with the hash it was decided on, so a
  file that differs there reads as changed). Device-only things never travel: host values (asked as
  §app.transport/agent says), this machine's copy limit, running copies and their data, the merge
  queue's history and runs, landing state, and settings change cards. A project already registered
  there keeps its settings: nothing of them is overwritten. The project's own `.sova/` definition
  comes with the code. A registration that device refuses (a reserved folder) leaves the arrival as
  it is.
- **Failure.** A failure at any step leaves the chat running here as it was. A rebuild that fails
  partway there (a later worktree's folder taken, say) leaves nothing beside the folders: every
  staged copy it made goes, git keeps no record of them, and a folder in the way stays as it was. The transport shows as
  Needs you with the reason, and offers `Retry` and `Cancel`. Retry continues from what already
  arrived, a publish cut short included: each worktree's move is recorded as begun and as done, so
  one found already moved (its staged copy gone, its folder a checkout at the commit it staged)
  counts as published, and the rest follow; a folder holding other work is never taken for it. One
  whose files changed there before the Retry is kept as it is, and the arrival note says so ("{name}
  changed here after it arrived and before the chat opened; it was kept as it is."). That holds
  except a package built on commits that device couldn't get (a submodule's remote that
  didn't give them): Retry packs it again, carrying the whole history. Cancel removes what arrived
  from the destination; pressed while the worktrees are being rebuilt in staging, it waits for that,
  then removes every staged copy, leaving nothing in the project's folder. Cancel is refused with the reason, changing nothing, while a publish runs
  or waits ("It is opening here right now, so it can't be cancelled; it arrives in a moment."), once
  any part is in place ("Part of it is already in place here, so it can't be cancelled; press Retry
  to finish it."), and after it arrived ("It already arrived here.").
- **Cancel on this device follows that answer.** Cancel here asks that device first. Once it says
  the chat is going in (opening, or partly in place), nothing is called off here either: the
  transport is followed to its end, so a Move that arrives still leaves its Moved row and retires
  its worktrees, and Cancel says why ("It is opening on {device} right now, so it can't be
  cancelled; it arrives in a moment.", "Part of it is already in place on {device}, so it can't be
  cancelled; press Retry to finish it.", "It already arrived there."). Once the switch is decided,
  any answer from there but a yes keeps it going too ("{device} didn't cancel it ({its reason}); it
  may hold the chat already. Try again."), and so does that device being offline then ("{device}
  is offline; it may hold the chat already. Try again once it is back."). Whether it is decided
  counts when that device answers, never when Cancel was pressed; once that device has taken the
  Cancel, nothing here decides the switch or sends the publish afterwards. Before the decision,
  Cancel works as before.

## §app.transport/switch — A Move's switch

- **The team keeps working while the destination is prepared.** Only the switch pauses it:
  - the helpers are brought to rest (§app.transport/safe-transport);
  - background jobs and running copies are stopped, as listed in the dialog;
  - the last changes are packed and sent;
  - the destination applies them and opens the chat.
- **Nothing new starts here during the switch:** from the stop until the chat opens there (and once
  decided, even while it waits for a Retry), a prompt is refused with the reason and nothing is sent.
- **One device decides.** The source decides the switch. The chat runs here until the destination
  confirms it opened there, and from then on only there. If the confirmation never comes, the chat
  stays here. An interrupted switch is settled the same way on both devices at their next contact.
- **On arrival** the chat is told what moved, and which jobs and running copies were stopped, so it
  can start them again there. The running copies are started again there for it, the same services
  on the same trees (§app.transport/agent "Ready means the app runs"); its jobs it starts itself. A moved team continues by itself: each helper that was working
  resumes with a note that it moved, and an idle one stays idle (§app.chat-processes/workers).
- **Here it is gone for events.** The source's event stream says `chat.removed`, and the
  destination's says `chat.created` (§app.events/names).

## §app.transport/copy — A Copy brings its own idle team

A Copy is a new chat with its own id and home on the destination. It gets the conversation, its code
on a branch of its own, and its own team: every helper copied, idle and resumable there. Its home is
its own by name as well: each conversation, helper record, card and offer store, wake, usage record
and the home's index take the new ids, so nothing in it is keyed by the original's; only the
conversations' words and the files the chat wrote in its shared folder stay as they were. The original
and its team carry on here untouched.

## §app.transport/moved-row — What a Move leaves here

- **A Moved row.** The chat stays in this device's list as an archived row whose second line reads
  "Moved to {device}". Opening it opens the chat on that device. Here it can't be run: there is no
  composer and no Unarchive. Opened here, it says where it went and, on the page itself (never only
  in a button's hover), why Move Back is or isn't offered.
- **A safety copy, never removed.** Its home stays here, read-only, as the safety copy. Once the
  destination has verified its arrival, each worktree that travelled (whoever made it: the chat, its
  team, a script or you) is compressed into the safety copy and removed, so the branch can't be
  landed from two devices. Two stay, each with a line in the log saying why: the repository's main
  checkout, and a worktree another chat here still works in (its folder is in it, or it tracks it). The folder goes in whole, with what
  never travelled (unticked private files, build output, anything written after the switch), and so
  does its submodules' git data (their other branches, reflogs and stashes, which git keeps outside the
  folder), and only once each archive is read back and on the disk (its bytes, then the folder entry
  naming it) is the worktree removed, so a power loss right after can't lose both; a folder that can't be
  kept whole stays. Making and reading back each archive streams the folder, never holding a file
  whole in memory, so a worktree of any size (gigabytes of dependencies) is kept like a small one. A
  repository's own main checkout is never removed. Nothing removes it but your
  own Delete (§app.chat-homes/lifetime): Clean Up's deletes by age and of empty sessions never match
  a Moved row (§app.session-list/archive-cleanup).
- **Move Back, while nothing happened there.** For 7 days after the Move, the Moved row offers
  `Move Back` as long as the chat has had no new turn on the destination. Move Back is a Move's
  switch in reverse, by your click on this device's page:
  - the destination stops the chat and becomes the Moved side; its worktrees there stay as they are;
  - this device restores the chat from its safety copy, its code folder and worktree included (its
    submodules with their own git data), and it runs here again.
  
  It needs no Transport agent, since this device was already ready. It is refused, with the reason,
  while the destination is offline or doesn't grant this device sessions. Before it asks that device
  anything, every archive of the safety copy is read as a stream and checked by the package's own
  rules (§app.transport/arrival): no absolute name or `..`, only files, folders and links, no
  special bits, and nothing written through a link, whether the archive makes it or it is already
  where the archive goes. A link member is still restored as a link. A refused copy restores
  nothing, and the chat keeps running there. The same check runs again just before each archive is
  unpacked, and catches what can only be seen then: a link already standing where a submodule's git
  data goes, once its worktree is rebuilt. A copy refused then stops the Move Back partway, as
  below. The destination stops
  nothing unless this device proves your click on its page over that very request
  (§app.access/your-click); being a paired device isn't enough. A Move Back that stops
  partway here, after the destination stopped the chat, is finished by pressing Move Back again:
  stopping the chat there is no turn there, so the row keeps Move Back until it runs here again.
- **After a turn there, a Copy back.** Once the chat has had a turn on the destination, the safety
  copy no longer matches it. The row then offers `Copy Back` in place of Move Back. Copy Back is a
  new Copy from that device to this one (§app.transport/copy): it opens the chat on that device, whose
  own page starts the Copy (only a click there mints its ticket), and the safety copy stays as it is.
- **After 7 days.** The safety copy is compressed (§app.session-list/archive-compression), never
  removed, and Move Back is gone. Copy Back stays.

## §app.transport/edge-cases — The edge cases' defaults

- **A branch name taken there:** reused when it holds the same commit, else given a suffix, and the
  arrival says so.
- **Refused, with the reason:** nested repositories (a repository inside the worktree that isn't one
  of its submodules), and a merge, rebase or cherry-pick in progress, in the worktree or in one of
  its submodules ("Its submodule {path} has a merge in progress: …").
- **Submodules travel** like the project itself (§app.transport/package, §app.transport/arrival),
  each one checked out or not, as it was here.
- **Asked:** an untracked file over 50 MB (§app.transport/dialog).
- **Carried:**
  - ignore rules that exist only on this device;
  - seen marks, so the chat doesn't arrive unread;
  - a Move's cost, which shows there marked as spent on this device. A Copy is a new chat: the
    cost so far stays the original's.
- **Dropped:** group membership.
- **The Claude login** follows the destination's own rules (§app.claude-logins/login-moved): it
  borrows the chat's login by name when it is free, else takes the next usable one, with the usual
  note. The first reply there re-reads the chat condensed (§app.claude-logins/switch-cost).

## §app.transport/agent — The Transport agent gets the destination ready

- **A special helper.** A Transport starts the Transport agent, a Sova chat on the destination named
  "Transport: {chat title}", the chat's own title (after arrival, the title it has there), never its
  first message's line. A link joins it to the chat here (§mesh/links), so each side can
  message the other. You see it as a helper of the transport, and open it to answer what it asks.
- **Its own brief only.** Its chat runs in plain normal mode with no minor mode (no align, spec,
  vis or memory) and no project mode, whatever that device's default for new chats turns on, and
  it stays so on every reopen: it has only its brief and its own tools. What it asks you goes on its
  card through Sova's own tool (downloads, a command to run, a file to bring); what that tool has no
  ask for it says in plain words in its reply, and it never opens an alignment. It asks only for
  what the setup checks or the failing running copy need, never for anything for the chat's own
  work later (a browser for its tests, say).
- **Its card in the chat.** Its progress shows as a card in the chat it gets a device ready for:
  in the original chat while it prepares that device before the chat travels, and in the chat where
  it arrived when it starts only after arrival. In the arrived chat it is put also with no agent
  working, when a host value is to be asked or the agent couldn't be confined there. Once per
  transport: a card that travelled with the chat stays the one. The card names the device, shows the agent's state (Working, Ready, Needs
  you) and what is still to set up, read again while it works, and `Open Agent Chat` opens its chat
  on the device it works on. Putting it in starts no turn, and the card in an arrived chat is there
  before the arrival is fingerprinted, so it never counts as a turn there (§app.transport/moved-row).
- **Once per device.** It prepares a project once per device: getting the project there, its tools
  and dependencies, and running its setup. A later transport of that project to the same device
  skips what is already proven.
- **Checks first.** The project's own setup checks run on that device before any agent
  (§app/project-setup, §app.project-services/instances): the folder is there and holds this
  project, each tool its files name is installed, its dependencies are installed, and its doctor
  passes. With nothing missing no agent starts. Otherwise the agent is told exactly what the checks
  found missing, and acts only on that. The checks before arrival and after it ask about the same
  project, known by its root commit as well as its remotes, so a repository the arrival made from
  the package reads as this project's even with no remote recorded.
- **When the project comes from the source** (§app.transport/package), no agent starts before
  arrival and none is ever told to clone it: there is nothing to check until it is there. An agent
  that already tried stops reporting over its link. Once the chat has arrived, the setup checks run
  on the arrived project, and an agent starts (or the one already there is told) only for what they
  find missing: tools, dependencies, its setup checks, and the computer-specific values below. With
  nothing missing the project is recorded as ready on that device and no agent starts. What it
  takes on is said back to the source, so the transport reads as done with its setup under way
  there ("Moved to {device}; setting up {what} there…") rather than plainly done, and its card shows
  in the chat there.
- **Until the checks pass.** Each time its turn ends the checks run again, the turn an answer of
  yours hands it included: you answered while the turn that asked was still running, or after the
  card already read Needs you. Once the chat has arrived, every turn of the agent's chat that ends
  reads them again, one you started by typing into its chat included, and its card and the
  transport take what they find: Ready once all pass, Needs you while something is still missing.
  Turns ending close together share one reading, never two at once. A tool it installed in that
  turn no longer reads missing. All passing, the project
  is recorded as ready on that device, its link ends, and the transport goes on. It reports to the
  chat here at most when it starts, when it has to ask you something, and when it is done. Still missing, the transport shows
  as Needs you, and `Retry` hands the same agent what is left.
- **What it fixes.** Environment problems, and the computer-specific values in private files: database
  strings, paths and ports. Once the chat has arrived, a private file that still holds this
  device's home or folder paths goes to the agent to point at that device, and one starts for it
  when that device was already ready. That one has no link, since the chat is there by then: its
  card in the arrived chat shows its progress, and it says what it changed in its own chat.
- **Confined, always,** in Sova's own sandbox, writing only the project's folders and tools' own
  install folders; downloads and administrator rights are yours (§app.transport/agent-sandbox).
- **Ready only when it is.** The card reads Ready only when the setup checks pass after its turn:
  each program the project's files and its setup definition name is found for the user, each tool
  its mise file pins is installed there at that version (read with the environment the project's
  services get, so it is the toolchain they will use), its dependencies are installed, its doctor
  passes, nothing it asked you (downloads, a command to run, a file to bring) is still waiting, and,
  once the chat has arrived, its running copy runs and its entry page answers (below). Otherwise it
  reads Needs you over what is missing, and the project isn't recorded as ready on that device.
- **Ready means the app runs.** Once the chat has arrived, Sova's server starts its running copy
  there through the project's services on that device (§app.project-services/instances), never inside
  the agent's sandbox: the copies the device it came from ran for the chat, each with the services it
  ran (those its switch stopped; for a Copy, those running when it was packed) on the same tree there,
  and, when none ran, the project's own copy of the chat's tree. It waits for each service to be
  ready, then opens the project's entry page (its definition's `open`) and wants an HTTP success (2xx,
  or a redirect). The copy starts only once the rest there is set up: every setup check passes (its
  tools and dependencies), and never while an agent already there is still in a turn (installing).
  It is read again after each turn of the agent's chat, one start at a time per transport; the agent
  may start it again itself, through Sova's own tool and the same services, which refuses while a
  setup check still fails and says what is left, but only that reading decides Ready. When the copy
  doesn't run or its page fails, the agent is told what failed (each new failure once, at most 3 on
  its own), reads the copy's logs and its setup and data steps, works out why (a missing tool,
  package, file or setting), fixes what is inside its limits, asks on its card for the rest (what is
  missing and why), and starts it again. A start after a failed one, the agent's or the reading after
  its turn, is a fresh one: each of the copy's own services that is failed, degraded or still
  starting, and each running since before the agent's last fix (its last tool call that could change
  something), is stopped and started anew, never kept on what it built before; a healthy service
  started after that fix, and every shared service, are left as they are, and no data is reset. The
  agent never runs the project's servers, builds or watchers itself, its brief and its tool say: only
  that start runs them and the copy's logs show their output, so a build run by hand never leaves
  output the copy then takes for its own. Its data is the project's own empty or seeded data: data never travels. The
  copy stays running after Ready, the app the agents and the team work on once they resume: nothing
  is stopped and no data deleted, and once it has run no later reading starts it again. Only then
  does the card read Ready, and `Open App` opens its entry page. A project with no running-copy
  definition there is checked as before, and its card says no copy was started. A copy starting
  with nothing else to set up there puts the card in the arrived chat too.
- **A file outside the project, on your click.** When the project needs a file that lives outside the
  project on the device the chat came from (in the user's home there), the agent never reads that
  device: through Sova's own tool it puts on its card the file, as a path in that device's home, its
  folder there, and why, with `Copy Path` beside the path. `Bring From {device}`, by your click on
  either device's page (proven to the other device over that very request), has that device read
  exactly that one file, once: never a folder, a file over 1 MB, one in the sandbox's hidden list
  (`~/.ssh`, `~/.aws`, `~/.gnupg` and the like) or Sova's own folders, or one in a device-wide
  download cache (`~/.m2/repository`, `~/.gitlibs`, Cargo's registry, Go's modules, Bun's, npm's and
  Gradle's caches, the home's `~/.cache`, macOS's `~/Library/Caches` and pnpm store), whether by the
  path asked, a link to one, or a cache folder that is itself a link (moved to another disk): those
  the project's build tools fetch on each device. A worktree's own `.cache`, a chat's scratch, still
  travels (§app.transport/package). A hard link elsewhere in the home to a cached file can't be told
  from the file, so it isn't refused. A tool's own settings beside a cache (`~/.m2/settings.xml`, `~/.cargo/config.toml`) may
  still be brought. It is written to the same path
  in the agent's device's home, readable only by you; a file already there is kept as it is and
  nothing is brought, and the agent is told either way. `I Placed It Myself` says you put it there
  yourself, and nothing is read. Nothing is read anywhere before your click. A file a setup check, a
  setup step or the running copy's log names as missing in that device's home, outside the project,
  is such a file: the agent asks for it this way first, its folder there or not, never by asking
  for write access to that folder and never by writing a version of it itself; a path it names as
  that device's own is taken as the same path in the home it came from. A file inside the project
  or the chat's worktrees travels with the code and is never asked this way; a file outside the home
  is asked in plain words. Bring From needs the device the file lives on to let the agent's device
  start chats there, as Move Back does.
- **What it may do alone:** anything inside those folders, such as cloning (never a project that
  came from the source), installing dependencies and tool versions, and running setup and tests;
  never the project's servers, builds or watchers (the running copy runs those, above).
- **This computer's host values are yours.** The agent never sets the project's host values (the
  `host` names its definition declares, held per device in that device's `host.json`,
  §app.project-services/contract): its brief says so, and the sandbox hides `host.json` from it. A
  setup check that fails only for a host value starts no agent and holds nothing before arrival.
  The source sends, with its offer, the declared names and its own values for those names only,
  never anything else of its `host.json`, and never into a log or a page. After arrival the card in
  the arrived chat asks for each one that device doesn't hold, prefilled with the source's value to
  keep or change (empty when the source had none), and `Save Values` writes them into that device's
  `host.json` for the project, only on your click on that device's page. Values already in the
  project's own files (its `.env`, its docs) the agent may use for files inside the project, never
  to fill a host value.
- **What it asks first:** anything that costs money, a secret it can't find, and deleting anything
  already on that device; downloads, administrator rights and files outside the project as above.
- **Its model.** The strongest model that device can actually run: Claude Code Opus 5.5 when that
  device has a Claude login Claude Code can use now, otherwise OpenAI Codex gpt-6-astra, otherwise
  the chat's own model, each only when that device offers it. With none of them the dialog asks you
  to pick one. It can always be changed in the dialog.

## §app.transport/agent-sandbox — The Transport agent's sandbox

The Transport agent (§app.transport/agent) runs confined on its device, always: it writes only what
getting the project ready needs, and asks you for the rest.

- **Confined, always.** The agent runs in Sova's own sandbox (§chat/sandbox) on that device, before
  arrival and after it, from its first tool call, and the chat can't lower it. It may write only the
  project's folder (made empty there for its clone when it isn't there yet), the chat's worktrees once
  they have arrived, and the install and cache folders inside the tools' own folders in that device's
  home: mise's and asdf's installs, plugins and downloads, Cargo's registry and git checkouts,
  rustup's toolchains and downloads, Go's `pkg`, Bun's install cache, Volta's cache and tool images,
  Clojure's git deps, and the Clojure CLI's own config folder (`~/.clojure`, or `clojure` in the
  user's XDG config folder), each where it is there; mise's folder is made when missing, and the
  Clojure CLI's config folder when the project runs the CLI (its first run fills it; what is there
  stays as it is). A tool folder's own top is never writable: a file a shell profile loads from
  there (`~/.bun/_bun`, `~/.cargo/env`, `~/.asdf/asdf.sh`), its settings (rustup's `settings.toml`,
  Volta's `tools/user`), and its `bin` or shims stay as they are. `~/.deno` isn't writable at all.
  Every version, plugin, toolchain and image already installed stays read-only whole, so nothing you
  already run, or that links to it, can be changed; a version it installs is a new folder of its
  own, which it may write, and one it installed before the chat arrived is held read-only like the
  rest after arrival. A version manager's own record of its installs beside them (mise's
  `installs/.mise-installs.toml`) stays writable, so a new install can be recorded. A write inside
  an installed version or at a tool folder's top fails, and what it needs there becomes an ask on
  its card. The rest of `~/.config` stays read-only. The caches installs use (`~/.cache`, `~/.npm`,
  `~/.m2`) and mise's and pnpm's state are the sandbox's own private copies, as for any confined
  chat.
- **Shared download folders aren't protected.** The device-wide download folders it may write
  (Cargo's registry and git checkouts, Go's `pkg`, Bun's install cache, Clojure's git deps, the
  version managers' downloads) are shared with your own builds. What a transported project fetches
  into them is not checked, and your later builds may use it.
- **Dependencies from their registries, never copied.** It gets dependencies only through the
  project's own build tools, from their registries, on that device; it never copies a cache from
  another folder or from another device, never asks for one with Bring From, and a Transport package
  never carries such caches or build output (§app.transport/package). It
  can't read the user's private settings (the sandbox's hidden list: `~/.ssh` and the like), the
  other projects registered there, the chat homes, that device's host values or the transport's
  records; it can't write Sova's own state. Its network goes through the sandbox's proxy, as installs
  need. Anything beyond that it asks you for. When that device can't confine it (no sandbox backend,
  or one that can't enforce the scope), no agent starts: before arrival the transport waits as Needs
  you with the reason ("{device} can't confine the Transport agent to the project's folders
  ({reason}), so it didn't start. Set up Sova's sandbox there, then press Retry"), and after arrival
  its card in the arrived chat says so. An agent started before the chat's worktrees arrived takes
  them into its scope at its next open: Sova closes it while it is idle, and the message that tells
  it what is left reopens it.
- **Your PATH stays yours.** Nothing on the user's PATH is writable to it: the user's own bin folder
  (`~/.local/bin`, which it never makes), every tool's `bin` and shims, and any folder the PATH names
  inside a tool folder, so it never puts a program on your PATH itself. What it installs can still
  reach you indirectly: a version it installs can be picked up by your own loose version pins (node
  `22`, rustup's `stable`, asdf's), a version manager's alias links can be pointed at it, and a
  missing `~/.clojure/deps.edn` can be created. Anything that has to go on your PATH it asks for on its card through Sova's own tool,
  as a command for you to run in a terminal on that device ("This puts a program on your PATH,
  which the agent can't write to."), with `Copy Command`, and your `Done` tells it to go on, as for a
  command that needs administrator rights (below).
- **Known as the agent by its chat itself.** That a chat is a Transport agent is kept with the chat,
  in its home, as well as in the device's records. So it stays confined when those records are gone
  or can't be read: a chat any of them names as an agent, whose scope can't be read, opens at the
  sandbox's read-only level, writing nowhere, never unconfined. The mark is kept in the home the chat opens
  from, after a Chats folder move too (§app.chat-homes/chats-folder). An unreadable record is never
  written over with an empty one.
- **Downloads, on your click.** When an install needs a site its network doesn't reach (a
  toolchain's own download site, such as a language's release server) that a setup check or the
  running copy needs, the agent never works around it: through Sova's own tool, never in a message, it lists on its card what it would get,
  each tool with its version and the site it comes from (each site a plain host name). Nothing more
  is reachable until you press `Allow Downloads` on that card, by your click on either device's page
  (§app.access/your-click; on the device the chat comes from, that click is proven to the agent's
  device over that very request, as Move Back's is). Then that agent's network lets through exactly
  the sites listed, besides what it reached before, and nothing else, and the agent is told to go on.
  A list you haven't allowed widens nothing; a new list asks again.
- **Administrator rights stay yours.** The agent never runs anything that needs administrator
  rights (sudo, system packages, system services), and its sandbox gives it none. It puts the exact
  command on its card instead, through the same tool, for you to run yourself on that device; your
  `Done` on the card tells it to go on. Only such a command goes on the card: anything else outside
  where it may write that needs no administrator rights (a folder or file in the home its sandbox
  can't write) it asks you in plain words in its reply, never as a command for you to run; a file
  from the device the chat came from is asked as below, never as access to its folder.

## §app.transport/safe-transport — Busy helpers at a Move

When helpers are working as you press Move, the dialog offers two ways to reach the switch, and
starts nothing until you pick one:

- **Safe Transport**, the default: every coordinator, and every helper with no coordinator, is
  told to wrap up at once and go idle. The Move proceeds when all are idle. Until then the
  transport reads "Waiting for {n} helpers to finish", with `Interrupt and Move` beside it.
- **Interrupt and Move:** working helpers are stopped at once. They arrive marked Interrupted and
  are told to continue.

With no helper working, neither is shown.
