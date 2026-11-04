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

Both can be read, never edited, from Settings → Merge Queue, as two labelled groups, "Sova's
method" and "This project's" (§app.merge-queue/settings).

**One thread, with memory, on its own.** Each project keeps one merge thread, whose only mode is
memory (UniiChat). It reads its playbook again whenever it changed, works without waiting for the
user, and is never replaced for its age, only when it can't go on or the user presses Start Fresh
(§chat.merge-queue/thread-life). It has no MCP servers (§app.mcp/who-gets).

**Its model.** A new merge thread opens on the merge-thread model the project has on this computer
(§app.merge-queue/models), else on the new-chat default. A thread already open keeps its model
until it is replaced.

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

A replaced thread keeps its merge verbs for an hour, to finish its turn (one replaced by Start Fresh
doesn't, §chat.merge-queue/thread-life). A new thread's title is
"Merge thread · {project folder} · {date}". Only the project's current merge thread, or one
replaced within the hour, counts as the thread for the merge verbs.

**What it may do.** It may:
- read the queue, the runs and their logs;
- write notes;
- add checks (never drop one);
- judge and resolve conflicts;
- retry after a machine pause.

It may not approve, cancel or land an entry, merge into the target, or push. It messages no other
chat directly. When it needs the user (the names interview below, or any question it can't settle
itself), it asks through the merge verbs, and Sova carries the question to the branch's chat
(§chat.merge-queue/asks). Its profile has no web, no workers and no timers, grants no session
powers, and the Overseer can't start it.

**The names interview.** When a project that pushes has no private names yet, Sova holds its pushes
and calls the thread with the project's names file and target. The thread first runs the name
finder (`discover-names.mjs`). It then asks the user with `merge.ask`, naming the newest landed
entry so that branch's chat asks them (§chat.merge-queue/asks), never in its own chat, what must
never reach the public repository:
- servers and their addresses;
- domain names, hostnames or tailnet names;
- keys;
- client or person names;
- anything else.

When their answer comes back, it adds their names to the list, then asks the same way whether the
list is complete, giving only its kinds and counts. A question never quotes a name: to see the
names themselves the user opens the merge thread, which shows the list there only. Once they
confirm, it says in the entry's note (with no names) that the push hold lifts with the next
landing. The names are kept only in the project's names file (`<state root>/merge-queue/<project key>/names.json`; Sova's own
repository falls back to `<state root>/merge-round.json`), which the leak scan reads
(§app.merge-queue/push); Sova's own project keeps `<state root>/merge-round.json`. The file is
private to the user (mode 0600), only ever added to, and never committed. The finder prints the
names themselves only when asked to show them. Sova's method playbook says so, and so does Sova's
own project playbook: the names interview and every other question go this way, and otherwise the
thread acts on its own.

**Off the critical path.** Sova starts each run by itself. Telling the thread is fire-and-forget:
a delivery that hangs is given up after 60 seconds, and a failure is only logged. When the thread
is missing, slow or failing:
- the run uses the required checks and their triggers;
- the landing has no note;
- a conflict goes back to the branch's chat.

## §chat.merge-queue/thread-life — The merge thread's memory, and when it is replaced

**Its one mode: memory.** The thread runs in mode normal, with memory on as UniiChat
(§chat.memory/types) and no other minor mode: no Delegate, Align, Spec or Vis. It has that from its
first message: Sova creates the chat with its profile's modes (normal, no minor modes), turns
memory on as UniiChat, pins the mode, and only then sends the first event. The memory type is
UniiChat whatever Settings → Memory's default type says; its size is Settings → Memory's UniiChat
size (§chat.memory/choice). Being pinned, the default modes saved on this computer never reach it,
now or after they change, and nothing switches its modes later: a switch from its mode menu or a
settings change is refused, as for every queue chat (§app.merge-queue/chats).

**It works on its own.** The thread never waits for the user in its own chat: it settles what it
can by itself, and anything only the user can answer goes to the branch's chat
(§chat.merge-queue/asks). The user can still open the thread and talk to it, from the Merge Queue
tab (§app.merge-queue/view); that is never how it is run.

**One thread per project, kept.** Each project keeps one merge thread for as long as it works; its
age never replaces it. At each event Sova reuses it unless one of these holds, and then it starts
a new one:
- there is none yet;
- its chat is gone, archived or open in a terminal;
- it keeps refusing messages: a refused message is tried twice more, after 5 and then 20 seconds,
  and only a third refusal replaces it;
- it is past half its context window (exactly half still reuses it; an unknown window never
  replaces it), kept only as a safety net, since memory keeps each turn small;
- the user pressed **Start Fresh** on the Merge Queue tab's Merge thread card, and confirmed it
  (§app.merge-queue/chats).

A thread running without memory (its memory switch refused, or a runtime with none) is still
replaced once it is more than 24 hours old. Sova records why each thread was replaced, in plain
words ("its chat is gone", "it refused messages (…)", "you started a fresh one"), keeping the newest
200, and each stays listed in the tab's History (§app.merge-queue/chats).

**Start Fresh** is a catalogue command over `merge.fresh` (§app.project-services/merge-verbs). It
waits for what the thread is being sent, then moves the thread into the history and archives it
as a reviewer is archived: Sova waits for its turn to end (at most 2 minutes), else stops it, then
archives it, trying again when refused (§app.merge-queue/review). The project then has no merge
thread until the next event starts one, and the old one loses its merge verbs at once, with no
hour's grace. Questions still open stay open across it (§chat.merge-queue/asks).

**Its playbook, read again when it changes.** Sova keeps a hash of each playbook folder's
`PLAYBOOK.md` and everything under its `references/`, Sova's method and the project's alike. When
it changed since the thread last read it, the next event's message starts with one line: "The
playbook changed since you read it: read {method PLAYBOOK.md} and {project PLAYBOOK.md} again
first, with the references they name." Everything else (the branch, the queue, the logs) it reads
fresh at each event, as before: its memory is for history, never for the queue's current state.

## §chat.merge-queue/chat-card — A branch's card in the chat that built it

From the moment a branch is approved (§app.merge-queue/approve), the chat that owns it shows one
**queue card** for that branch. The approval may come from Land in the composer's worktrees control,
the session pane or the Merge Queue view, or from "land it" typed in that chat. The owner is the
chat the approval names (a typed "land it", a Land in a chat's own control or pane). Without one
(Land on the Merge Queue view), it is the branch's owner by the queue's one rule
(§app.merge-queue/owner), the chat that row shows: the chat that created and tracks the worktree,
else the newest chat working in it, an archived one included. A branch with no known chat gets no
card anywhere. Approving the same branch again after a hand-back
a Remove from Queue or a Cancel moves its same card on, as a new "approved" revision; a Landed card is never reused.

**One card per branch.** A chat that owns several branches in the queue shows one card for each,
and each moves only at its own outcomes. The composer's worktrees control stays the summary of all
of them (§chat.composer/worktrees-control).

**Where it stands, and how it moves.** The card first stands where the chat was when the branch was
approved: after what was then the transcript's last row. It follows the chat by revisions, as a
follow card does (§chat.transcript-cards/placement):
- **In place** while the branch waits and is checked: its place in line ("Queued · 2nd"), the
  estimate, "Checking · 4 of 7 steps". These updates change the card where it stands and never move
  it or the rows above it: it is never rebuilt, so the chat never shifts.
- **A new revision at the bottom** at each outcome: Landed, Needs a fix, Behaviour differs, Review
  flagged, Can't tell whose failure, Drafts changed, Sent back, Removed, and on the host Request
  ready, Requested, Pushed and Closed. A request's host state changes in place. A conflict the merge thread is still judging stays in
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
- **On the host** (a project that lands by request, §app.merge-queue/requests): "Review the
  request" with **Review Request**, the request's title and description to read and edit, and
  **Publish**; then the request open, "PR #{n} open · checks running on GitHub", with **Open on
  GitHub** (or GitLab), whose host state changes in place in the request's words (**Send Back to
  Chat** on host checks failed, changes requested or conflicts); then a **Landed** revision once the
  host merged it ("Merged on GitHub. Sova checked it merged with {target}; GitHub's merge is
  final."), or "Closed on GitHub" with **Land Again**. Push branch only ends at **Pushed**. Land
  Again also shows on an open request or a pushed branch once the branch has newer commits.
- **Needs a fix** gives the reason with **See Why**, and lists the failing checks ("Unit tests · 1
  failed") with their failing tests and a link to each log. When the merge thread's explanation
  arrives later, it is added to the same card ("Merge thread: …"). It and a **Sent back** revision
  offer **Land This Commit Again** and **Remove from Queue** (§chat.composer/worktrees-control).
  For a branch sent back for its drafts, once they have changed since and fit, the card keeps its
  Needs a fix pill and offers **Land** at the same commit in place of Land This Commit Again, beside
  Remove from Queue; it changes by itself when the drafts are edited. A fix at a newer commit
  leaves the card's buttons as they are: Land for the new commit is on the rows and the tab. Once
  the entry no longer needs a fix (the branch approved again later, already in the target, or its
  branch or folder gone), the card offers no action at all, so nothing on it is one the queue would
  refuse.
- **Drafts changed** offers **Land**, as the Merge Queue tab and the rows do: a new approval of the
  card's commit for the drafts as they are now (§app.merge-queue/approve).
- **Removed**, after Remove from Queue: a final revision with the **Removed** pill and the reason
  "removed by you", and no queue action; approving the branch again later moves the card on as a
  new "approved" revision.

Land and Land This Commit Again on the card approve the commit the card shows; Land Again approves
the branch's head.
- **Behaviour differs** shows both sides and the proposal, with **Accept** and **Send Back**;
  **Review flagged** shows the review's findings, with **Land Anyway** and **Send Back**;
  **Can't tell whose failure** names the check that failed on the merge and on the target alone,
  with its log, and offers **Land Anyway** and **Send Back** (§app.merge-queue/blame). These, Cancel, Land Again, Land This Commit Again and Remove from Queue are the same actions as the composer's modal and the pane, kept in
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
into the composer or the conversation for any outcome. It speaks only about repositories it serves
(§app.merge-queue/served): a chat working in any other repository gets no `[merge-queue]`
message, queue card or queue line, whatever its branches look like. The one exception is a typed
"land it" the queue turns down for that reason, said as below.

- **The host's news doesn't start a turn.** A request opened, its host state changing, merged,
  closed, or a branch pushed: each is a hidden line, as Landed is. Host checks failing starts no
  turn either; **Send Back to Chat** on the card does, as Send Back does.
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
  the conflict, or the review's findings. A Needs a fix turn also names what the user will see once it
  is fixed: for a branch sent back for its spec drafts, that fixing them needs no commit and that once
  they fit the user sees Land again at the same commit (or Land This Commit Again on its row and card),
  or types "land it" in the chat; for a broken check or a conflict, that Land comes back on its row
  once the fix is committed and finished. The turn a user's Send Back starts ends the same way: Land
  comes back on its row once the fix is committed and finished, or the user can use Land This Commit
  Again. **Remove from Queue** starts no turn and leaves no hidden
  line. A chat busy with other work takes it after that turn. A
  wake the chat can't take (archived, an Overseer, a project overseer or a baton chat, or one held
  open in a terminal, which Sova never writes to) is refused and becomes the hidden line
  instead. A worker chat that owns a branch is never woken itself (a worker's session takes no
  wake from outside the chat that runs it): its wake goes to the chat that runs the worker, up to
  the top chat when workers run workers (at most 8 levels), exactly once, marked as from the merge
  queue like any other, its text naming the worker and the branch ("For your worker "{title}" …"
  before the queue's own words). When no chat that runs it is known, or that chat can't take it,
  the fact becomes the hidden line in the worker's own chat instead, as above, so nothing is lost
  and nothing is sent twice.
- **Waiting for the user starts nothing.** Behaviour differs, Review flagged and Can't tell whose
  failure ask the user on the card: no turn and no hidden line. When the user sends it back, that
  Send Back starts the turn, as above.
- **A question from the merge thread starts a turn**, once per question, the same marked way: the
  merge thread's question for the user, and how to pass the user's answer back
  (§chat.merge-queue/asks). A chat that can't take it gets no hidden line for it: the question
  waits on the Merge Queue tab instead.
- **A typed "land it" the queue refuses** is told to the model the same way, as a hidden line.
  In a repository the queue doesn't serve (a chat still on code from before that rule records such
  a go-ahead), the line is "{branch} at {sha} couldn't be queued to land: not a project the merge
  queue serves: merge it into main from the chat.", so the chat, once reloaded, merges it itself.
- A restart never repeats a revision, a hidden line or a wake: each is recorded once per entry,
  outcome and run in the chat's own queue-card record, kept whatever the chat's alignment, archive
  or worker state.

## §chat.merge-queue/asks — When the merge thread needs the user

The merge thread runs on its own (§chat.merge-queue/thread). When it needs the user, for the names
interview or any question it can't settle itself, it never waits in its own chat: it asks with
`merge.ask` (the question in plain words, and the entry it is about; §app.project-services/merge-verbs),
and Sova takes the question to the user. Each question gets an id (`ak_…`).

- **To the branch's chat.** The question goes to the chat the entry records as its branch's
  (§chat.merge-queue/chat-card). When that chat is a worker, it goes to the chat that runs it, up
  to the top chat when workers run workers (at most 8 levels).
- **One marked message.** Sova sends that chat exactly one merge queue message for the question
  (`[merge-queue]`, the author "Merge queue", never the user's words or go-ahead,
  §chat.merge-queue/chat-turns): "The merge thread needs the user (about {branch}):", the question,
  then that it should ask the user in plain words, wait for their answer and never answer it
  itself, and relay their words with `merge.reply {ask: "{id}", text: "<their answer>"}`. The
  `worktree` tool's guidance tells every chat the same. No notification is sent.
- **The answer goes back.** `merge.reply` is taken only from the chat the question was asked in, or
  from the operator (the tab). It closes the question, and the thread gets it as its next event:
  "Answer to your question {id} (about {branch}), from {who}:", the answer, and the question. A
  second answer to the same question, or one to an unknown id, is refused.
- **No chat to ask.** When the entry names no chat, or its chat (after workers) is archived, gone,
  open in a terminal, an Overseer, a project overseer, a baton chat or one of the queue's own, or
  the message is refused, or the question names no entry, the question is held on the project's Merge Queue tab
  instead, and exactly one notification is sent for it, which opens that tab
  (§app.notifications/delivery). No message goes to any chat.
- **On the tab.** While a question is open the Merge thread card reads "Asking you" and shows "The
  merge thread is asking you something." with the question: one asked in a chat adds "Waiting on you
  · asked in {chat}", the chat's title a link to it; one held on the tab adds **Your answer**, with
  **Send Answer** (`merge.reply` as the operator) and **Answer in Merge Thread**, which opens the
  thread (§app.merge-queue/chats).

Open questions are kept with the project's thread record, across a Start Fresh or a replaced
thread. The user can always open the merge thread and talk to it directly; that is never needed.
