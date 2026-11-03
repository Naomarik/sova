# §chat/merge-queue — The merge queue in chats
> Part of the Sova design spec · [overview](../design/overview.md)

Each project's merge queue (§app/merge-queue) has one **merge thread**. It is a chat Sova starts
itself, on the **Merge thread** profile, to follow the merge playbook. It replaces the Merge
Captain. It never lands anything itself, never moves the target and never runs git on it. It acts
only through the merge verbs (§app.project-services/merge-verbs), and the queue never waits for it.

The chat that built a branch follows its trip through the queue on one card per branch
(§chat.merge-queue/chat-card), and its model hears of it without a message pretending to be the
user's (§chat.merge-queue/chat-turns).

## §chat.merge-queue/thread — What the merge thread does

**Its playbook.** Sova ships a method playbook (`playbooks/merge-queue/`), which the thread always
follows. A project may add its own `.sova/playbooks/merge-queue/PLAYBOOK.md`. The thread reads it
after the method, and where the two differ, the project's wins. Both are playbook folders
(§chat.playbooks/bundles). What is worth a note on a landing is what the project's playbook says.
- Sova's says: server, shared or pi-config code (restart Sova to pick it up), dependency or
  lockfile changes, migrations or state-file changes, follow-ups the branch left.
- A static site's might say nothing is worth noting, since it reloads itself.

**When Sova calls it in.** The queue tells the thread itself, through no schedule and with no
approval, when:
- **an entry was queued.** It reads the branch's diff and its chat's intent. It may write the
  landing's note (§app.merge-queue/note). It may also pick extra checks by blast radius with
  `merge.extend`, each with its reason, add-only (§app.merge-queue/checks). Picks count only if they
  arrive before the run's checks start.
- **a merge conflicted.** It judges the conflict with `merge.resolve`, saying no behaviour change or
  behaviour differs, with the target's side and the branch's side in plain words
  (§app.merge-queue/conflicts).
- **a run failed on the branch.** It explains the failure as the entry's note.
- **the queue paused.**
- **a project that pushes has no private names** (below).

**A fresh chat when the last one won't do.** At each event Sova reuses the project's merge thread
unless one of these holds, and then it starts a new one:
- there is none yet;
- its chat is gone, archived or open in a terminal;
- it refused a message;
- it is more than 24 hours old (exactly 24 hours still reuses it);
- it is past half its context window (exactly half still reuses it; an unknown window never
  replaces it).

A replaced thread keeps its merge verbs for an hour, to finish its turn. A new thread's title is
"Merge thread · {project folder} · {date}". Only the project's current merge thread, or one
replaced within the hour, counts as the thread for the merge verbs.

**What it may do.** It may:
- read the queue, the runs and their logs;
- write notes;
- add checks (never drop one);
- judge and resolve conflicts;
- retry after a machine pause.

It may not approve, cancel or land an entry, merge into the target, or push. It messages no other
chat, and asks the user only the names interview below. Its profile has no web, no workers and no timers, grants
no session powers, and the Overseer can't start it.

**The names interview.** When a project that pushes has no private names yet, Sova holds its pushes
and calls the thread with the project's names file and target. The thread first runs the name
finder (`discover-names.mjs`). It then asks the user once, in its own chat, what must never reach
the public repository:
- servers and their addresses;
- domain names, hostnames or tailnet names;
- keys;
- client or person names;
- anything else.

It adds the user's names to the list and shows the list once the user confirms. The names are kept
only in the project's names file (`<state root>/merge-queue/<project key>/names.json`; Sova's own
repository falls back to `<state root>/merge-round.json`), which the leak scan reads
(§app.merge-queue/push); Sova's own project keeps `<state root>/merge-round.json`. The file is
private to the user (mode 0600), only ever added to, and never committed. The finder prints the
names themselves only when asked to show them. This is the only time the thread asks the user
anything.

**Off the critical path.** Sova starts each run by itself. Telling the thread is fire-and-forget:
a delivery that hangs is given up after 60 seconds, and a failure is only logged. When the thread
is missing, slow or failing:
- the run uses the required checks and their triggers;
- the landing has no note;
- a conflict goes back to the branch's chat.

## §chat.merge-queue/chat-card — A branch's card in the chat that built it

From the moment a branch is approved (§app.merge-queue/approve), the chat that owns it shows one
**queue card** for that branch. The approval may come from Land in the composer's worktrees control,
the session pane or the Merge Queue view, or from "land it" typed in that chat. The owner is the
chat the approval names. Without one (Land on the Merge Queue view), it is the chat of the branch's
earlier entry, else the newest chat not archived whose folder is inside the branch's worktree. A
branch with no known chat gets no card anywhere. Approving the same branch again after a hand-back
or a Cancel moves its same card on, as a new "approved" revision; a Landed card is never reused.

**One card per branch.** A chat that owns several branches in the queue shows one card for each,
and each moves only at its own outcomes. The composer's worktrees control stays the summary of all
of them (§chat.composer/worktrees-control).

**Where it stands, and how it moves.** The card first stands where the chat was when the branch was
approved: after what was then the transcript's last row. It follows the chat by revisions, as a
follow card does (§chat.transcript-cards/placement):
- **In place** while the branch waits and is checked: its place in line ("Queued · 2nd"), the
  estimate, "Checking · 4 of 7 steps". These updates change the card where it stands and never move
  it.
- **A new revision at the bottom** at each outcome: Landed, Needs a fix, Behaviour differs, Review
  flagged, Can't tell whose failure, Drafts changed, and Sent back. A conflict the merge thread is still judging stays in
  place; its outcome is Behaviour differs or a hand-back. The newest revision is the full card; each
  earlier one folds to one line ("feat/x · Queued 2nd · earlier copy") that opens to show it as it
  was, read-only and with no actions. The newest
  copy is always where the reader is.
- A restart of the server never adds a revision twice: each outcome's revision is recorded with the
  queue's own records, once per entry, outcome and run.

**What it shows.** Every revision has the branch icon, the state pill in the same words as the
composer's modal, "{branch} into {target}", the short commit (the landed one once it lands, else the
approved one), the worktree's path, and **View Merge Queue**. While queued it says "starts in ~N min ·
takes ~N min" and offers **Cancel**; while checking, "Checking · 4 of 7 steps".
- **Landed** looks like the Merged card a chat's own merge gets (§chat.worktrees/merge-card): a
  LANDED pill, "{branch} into {target} {sha}", "{n} commits · +{a} −{d} · {time}" (counted at the
  landing, from the target before it to the approved commit, so they never drift), the merge thread's note, Sova's other notes (flaky tests, review
  notes, what a resolved conflict did), the reason once when the push didn't happen ("Push held: {why}." when
  the queue's reason already says it is held, else "Not pushed: {why}.", or "Not pushed: this project
  doesn't push from the queue."), and "1 newer
  commit not included" with **Land Again** when the branch moved past the approval. **Review
  Changes** opens the changes viewer on exactly what landed: from the target before the landing to
  the landed commit, in the project's repository, even once the worktree is removed
  (§chat.changes/entry).
- **Needs a fix** gives the reason with **See Why**, and lists the failing checks ("Unit tests · 1
  failed") with their failing tests and a link to each log. When the merge thread's explanation
  arrives later, it is added to the same card ("Merge thread: …").
- **Behaviour differs** shows both sides and the proposal, with **Accept** and **Send Back**;
  **Review flagged** shows the review's findings, with **Land Anyway** and **Send Back**;
  **Can't tell whose failure** names the check that failed on the merge and on the target alone,
  with its log, and offers **Land Anyway** and **Send Back** (§app.merge-queue/blame). These, Cancel
  and Land Again are the same actions as the composer's modal and the pane, kept in
  sync with them. They are catalogue commands over the merge verbs
  (§app.project-services/merge-verbs): they act on the queue directly and never type into the chat.

**Sova's own card.** The queue card is a card kind built into Sova on the transcript toolkit
(§chat.transcript-cards/built-ins), raised by the server from the queue's records. Nothing is
written into the chat's session file. It needs no card files and no trust. A chat's queue cards
are read with `GET /api/merge-queue/cards` (the catalogue's `session.merge-cards`, a look) and follow
the session feed. It works in every chat Sova holds or shows, those started before it shipped included, pi and Claude Code alike:
- a chat with an open alignment question still gets it;
- an archived chat keeps its record, shown when it is opened;
- a chat open in a terminal gets nothing written, and the card is drawn whenever Sova shows it.

**Nothing back-filled.** Branches that landed before the queue cards existed get no card. The Merged
card stays for a merge a chat makes itself into a branch the queue doesn't manage
(§chat.worktrees/merge-card).

## §chat.merge-queue/chat-turns — What the queue tells the chat's model

The queue never sends a chat a message that looks typed by the user: no "Sova: …" message is put
into the composer or the conversation for any outcome.

- **Landed and Drafts changed don't start a turn.** The chat's model reads one hidden line at its
  next turn, in a block of the chat's card note (so chats started before this shipped get it too).
  The block's first line is "From Sova's merge queue (not the user's words; nothing to answer):",
  then one line per fact, for example "feat/x landed on master at 4fec160, 8 commits. Note: …", or that the
  branch's spec drafts changed since the approval. Each fact is given once, even across a server
  restart. The line is kept apart from the card, so it reaches the model whatever happened to the
  card.
- **Needs a fix and Send Back start a turn** in the owning chat, so it can start fixing. Every
  merge queue message, these and readiness's notes on what still blocks a finished branch
  (§chat.worktrees/ready-to-land), goes the same way: a follow-up message starting `[merge-queue]`,
  carrying another sender's marker and titled "Merge queue". It is never taken as the user's
  go-ahead (§chat.worktrees/land-own-word). The turn is
  marked as coming from the merge queue (§chat.profiles/delivery), never drawn as the user's message:
  it reads with the author "Merge queue" and a branch icon, live and settled alike, and never as
  "From a session" or a link to one. Sova knows it by its marker or by its `[merge-queue]` prefix. It is a sender of its own, like a
  message the Overseer sent: never counted in the composer's "N inputs", and on the Timeline an
  input row reading "From the merge queue", which Inputs Only leaves out (§chat.timeline/inputs-only).
  The turn carries what the card shows: the failing checks and where their logs are, or both sides of
  the conflict, or the review's findings. A chat busy with other work takes it after that turn. A
  wake the chat can't take (archived, an Overseer, a project overseer or a baton chat, or one held
  open in a terminal, which Sova never writes to) is refused and becomes the hidden line
  instead. A worker chat that owns a branch gets the wake like any other chat.
- **Waiting for the user starts nothing.** Behaviour differs, Review flagged and Can't tell whose
  failure ask the user on the card: no turn and no hidden line. When the user sends it back, that
  Send Back starts the turn, as above.
- **A typed "land it" the queue refuses** is told to the model the same way, as a hidden line.
- A restart never repeats a revision, a hidden line or a wake: each is recorded once per entry,
  outcome and run in the chat's own queue-card record, kept whatever the chat's alignment, archive
  or worker state.
