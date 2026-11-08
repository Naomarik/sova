# §chat/merge-queue — The merge queue in chats
> Part of the Sova design spec · [overview](../design/overview.md)

Each project's merge queue (§app/merge-queue) has one **merge thread**. It is a chat Sova starts
itself, on the **Merge thread** profile, to follow the merge playbook. It replaces the Merge
Captain. It never lands anything itself, never moves the target and never runs git on it. It acts
only through the merge verbs (§app.project-services/merge-verbs), and the queue never waits for it.

The chat that built a branch follows its trip through the queue on one card per branch
(§chat.merge-queue/chat-card), and its model hears of it without a message pretending to be the
user's (§chat.merge-queue/chat-turns). A review that blocks the branch also gets a card of its own,
with the reviewer's whole report (§chat.merge-queue/review-card). What the queue asks of the chat arrives as requests on a chat
queue Sova opens there (§chat.merge-queue/requests); the chat answers each one Fixed, Needs you or
Can't (§chat.merge-queue/answers); and what only the user can decide waits on the card as one
decision, answered from the chat's message box (§chat.merge-queue/decision).

## §chat.merge-queue/thread — What the merge thread does

**Its playbook.** Sova ships a method playbook (`playbooks/merge-queue/`), which the thread always
follows. A project may add its own `.sova/playbooks/merge-queue/PLAYBOOK.md`. The thread reads it
after the method, and where the two differ, the project's wins. Both are playbook folders
(§chat.playbooks/bundles). What is worth a note on a landing is what the project's playbook says.
- Sova's says: server, shared or pi-config code, dependency or lockfile changes, migrations or
  state-file changes, follow-ups the branch left. It also has the thread restart Sova itself after
  landings that change what the server runs, and note that it did (§chat.merge-queue/sova-restart).
- A static site's might say nothing is worth noting, since it reloads itself.

Both can be read, never edited, from Settings → Merge Queue, as two labelled groups, "Sova's method"
and "This project's" (§app.merge-queue/settings).

**Read as you go.** Sova's method playbook has a **Read as you go** table: one row per moment Sova
calls the thread in for (**Queued**, **Conflict**, also a resolution of its own that failed a check;
**Failed**, also a failure whose owner can't be told and a blocking review; **Fix**, a fix the chat
answered with, drafts-only ones included; **Chat answer**, a chat's Can't or Needs you; **Paused**,
**Idle**, **Names**, **Answer**), naming the pages to read again at that moment, every time. Every
message asking it to rule carries what is the user's to decide (§app.merge-queue/needs-user), as its
method's section "What is the user's" says. Each message Sova sends the thread ends: "Before you
act, read your playbook's "Read as you go" row for {moment} and the pages it names, now, never from
memory (the project's own playbook wins where its list differs)." Its memory is for history only (a
check that failed before, how it judged a branch like this one), never for the current state or the
method. A project's own merge playbook may give its own table: its row wins where it differs;
without one, Sova's stands, with the project playbook's section of the same name added.

**One thread, with memory, on its own.** Each project keeps one merge thread, whose only mode is
memory (UniiChat). It reads its playbook again whenever it changed, works without waiting for the
user, and is never replaced for its age, only when it can't go on or the user presses Start Fresh
(§chat.merge-queue/thread-life). It has no MCP servers (§app.mcp/who-gets). It runs sandboxed (§chat.merge-queue/thread-sandbox).

**Its model.** A new merge thread opens on the merge-thread model the project has on this computer
(§app.merge-queue/models), else on the new-chat default. A thread already open keeps its model until
it is replaced.

**When Sova calls it in.** The queue tells the thread itself, through no schedule and with no
approval, when:
- **an entry was queued.** It reads the branch's diff and its chat's intent. It may write the
  landing's note (§app.merge-queue/note). It may also pick extra checks by blast radius with
  `merge.extend`, each with its reason, add-only (§app.merge-queue/checks). Picks count only if they
  arrive before the run's checks start. The message for every queued branch gives the full pick,
  `merge.extend {entry, checks: [id], why, select}`, and says `select` is part of it, to be copied
  whenever the pick has one; the tool's own help says the same (§app.project-services/merge-verbs).
  No setting governs this, and the queue doesn't handle a pick sent with no selection specially.
- **a merge conflicted.** It judges the conflict with `merge.resolve`, ruling no behaviour change,
  the chat fixes it, or behaviour differs (it needs the user, with its question and choices), with
  the target's side and the branch's side in plain words (§app.merge-queue/conflicts). It works the
  resolution out in the scratch copy Sova made for that attempt, whose folder the call names, and
  never makes a worktree or a branch of its own for it (§app.merge-queue/resolve-copy).
- **a run failed on the branch.** It explains the failure as the entry's note and gives the chat its
  diagnosis, which goes with the request (§app.merge-queue/send-back).
- **a review blocked.** It gets the whole report and hands it to the branch's chat with
  `merge.rule` chat-fixes, never retyping a finding: Sova delivers the reviewer's words
  (§app.merge-queue/send-back). It may add a note with the hand-off, or later as a further
  chat-fixes with its text while the entry is back with the chat; `merge.note` stays the landing
  note and never reaches the chat. It may instead rule that it needs the user
  (§app.merge-queue/needs-user). A review whose try runs out (the last try, or the same findings
  twice) already waits for the user: the thread gets its report and is told nothing is to hand on.
- **a failure whose owner can't be told, a resolution of its own that failed a check.** It rules
  what happens: the chat fixes it, it tries again, or it needs the user
  (§app.merge-queue/needs-user).
- **a fix arrived.** From a range-diff of the branch as approved against the branch now, from the
  merge base, it rules whether the fix changes only what was asked and decides nothing of the user's
  (§app.merge-queue/standing-approval).
- **a chat answered "Can't" or "Needs you".** On "Can't" it may try one other approach before it
  raises it to the user (§app.merge-queue/needs-user); a "Needs you" it can't overrule.
- **the queue paused.**
- **the queue has nothing left to check** (§app.merge-queue/empty).
- **a project that pushes has no private names** (§chat.merge-queue/names-interview).

A replaced thread keeps its merge verbs for an hour, to finish its turn (one replaced by Start Fresh
doesn't, §chat.merge-queue/thread-life). A new thread's title is "Merge thread · {project folder} ·
{date}". Only the project's current merge thread, or one replaced within the hour, counts as the
thread for the merge verbs.

**What it may do**, and what it may not, is §chat.merge-queue/thread-powers: it reads, notes, adds
checks, judges conflicts and checks fixes, but never approves, lands or answers for the user.

**Off the critical path.** Sova starts each run by itself. Telling the thread is fire-and-forget: a
delivery that hangs is given up after 60 seconds, and a failure is only logged. When the thread is
missing, slow or failing:
- the run uses the required checks and their triggers;
- the landing has no note;
- a conflict waits for it, never going to the chat unjudged (§app.merge-queue/conflicts);
- a failure goes back to the chat without a diagnosis;
- a blocking review's report goes to the chat by itself after 5 minutes, without a note, or at once
  when no merge thread is running;
- a fix waits for it, never for the user, and lands only once checked
  (§app.merge-queue/standing-approval).

## §chat.merge-queue/thread-powers — What the merge thread may and may not do

It may:
- read the queue, the runs and their logs;
- write notes;
- add checks (never drop one);
- judge and resolve conflicts, and rule whether the chat fixes something or it needs the user;
- check a fix, confirming it changes only what was asked;
- retry after a machine pause, and put an entry back in line while the user's Land still stands
  (counted against its tries, §app.merge-queue/tries), never one the user removed, out of tries or
  waiting for the user's decision;
- hold its queue's new starts for a few minutes, and clear that hold (§app.merge-queue/empty);
- have Sova restart Sova, say what is live, try a resolution's tests in a scratch copy and keep the
  private-names file, each through a merge verb Sova runs for it, never a script or command of its
  own (§chat.merge-queue/thread-sandbox).

It may not approve, cancel or land an entry, answer a decision for the user, pause or resume the
queue, merge into the target, or push. It can't remove, rewrite or soften a review's finding: it
has no verb for it, and Sova delivers the reviewer's words as written. Its note on a review is
short (at most 500 characters) and says only what the findings don't: a note that repeats any 40
characters of the reviewer's summary or a finding is refused, saying the findings already go as the
reviewer wrote them, and nothing goes to the chat for it. It never sets the queue up or changes its
setup: that is the
project's Setup chat, a separate chat the user talks to (§app/project-setup), and the thread neither
starts it nor calls `merge.try` or `merge.setup`. It messages no other chat directly: what it wants
of a branch's chat goes as the queue's requests (§chat.merge-queue/requests). When it needs the user
(the names interview, §chat.merge-queue/names-interview, or anything that is the user's,
§app.merge-queue/needs-user), it asks through the merge verbs with its question and choices, and
Sova carries the question to the branch's chat as a decision (§chat.merge-queue/asks,
§chat.merge-queue/decision). Its profile has no web, no workers, no timers and no worktree tool,
grants no session powers, and the Overseer can't start it.

## §chat.merge-queue/names-interview — The names interview

When a project that pushes has no private names yet, Sova holds its pushes
and calls the thread with the project's names file and target. The thread first has Sova run the
name finder (`merge.names {action: "discover"}`, §chat.merge-queue/thread-sandbox). It then asks the user with `merge.ask`, naming the newest landed
entry so that branch's chat asks them (§chat.merge-queue/asks), never in its own chat, what must
never reach the public repository:
- servers and their addresses;
- domain names, hostnames or tailnet names;
- keys;
- client or person names;
- anything else.

When their answer comes back, it has Sova add their names to the list (`merge.names`), then asks
the same way whether the list is complete, giving only its kinds and counts. A question never quotes
a name: to see the names themselves the user opens the merge thread, which shows the list in its
own chat only. Once they
confirm, it says in the entry's note (with no names) that the push hold lifts with the next
landing. The names are kept only in the project's names file (`<state root>/merge-queue/<project
key>/names.json`; Sova's own
repository falls back to `<state root>/merge-round.json`), which the leak scan reads
(§app.merge-queue/push); Sova's own project keeps `<state root>/merge-round.json`. The file is
private to the user (mode 0600), written only by Sova, only ever added to, and never committed.
Sova shows the names themselves only to the merge thread and to the operator (`merge.names {action:
"show"}`, §chat.merge-queue/thread-sandbox); every other chat is refused. Sova's method playbook says so, and so does Sova's
own project playbook: the names interview and every other question go this way, and otherwise the
thread acts on its own.

## §chat.merge-queue/thread-sandbox — The merge thread works sandboxed, through Sova's verbs

The merge thread starts in the project's main checkout with its sandbox On at the read-only level
(§chat/sandbox), and without the worktree tool. That folder is never a writable root (the session's
folder is marked not writable): its tools read
wherever the sandbox allows and write only in their own temp folder. There is no other writable
mount (not the main checkout, a scratch copy or any worktree) and no network. The sandbox takes a
tightening-only flag for this (the session runs at read-only whatever the policy's level says); it
never loosens anything. It tries things in a scratch clone it makes under its temp folder, and
deletes the clone when it is done.

Everything it does beyond reading goes through the merge verbs Sova runs for it
(§app.project-services/merge-verbs):
- **Restarting Sova**: `merge.restart` (§chat.merge-queue/sova-restart).
- **What is live**: `merge.live {project}`, to any caller that may read the queue: the commit Sova
  runs and when it started (what `GET /api/health` says), the target's head, and the plan between
  them (nothing, build or restart; whether an install is owed; file counts).
- **Resolving a conflict**: `merge.resolve` also takes `contents`, each conflicted file's whole
  merged text by its repository path, only with the verdict no behaviour change (the chat fixes it
  and needs the user carry none, and are refused with them), and never together with `commit`.
  Sova merges the approved commit into the entry's scratch copy
  (detached, at the target's head), writes those files there, refuses when a conflicted file is
  left unresolved or a path leaves the copy, commits the merge in the copy and uses that commit as
  the resolution (§app.merge-queue/resolve-copy). The target branch, the main checkout and every
  branch stay where they were. The thread never commits in a scratch copy itself.
- **Trying a resolution**: `merge.test {entry, select?}`, the merge thread's only, runs the
  project's merge install (when declared) and its test command with the given selectors in that
  entry's scratch copy, and answers pass or fail with the last lines of the output. It changes
  nothing in the queue or the entry.
- **The names interview**: only Sova writes the private-names file (§chat.merge-queue/thread).
  `merge.names {action: "discover"}` has Sova run the name finder itself into the project's names
  file (the one Sova keeps, never a path the thread picks) and answers kinds and counts, never
  values. It collects the login emails of this computer's Claude logins (their identities in
  `claude-accounts.json`, each added login's `.claude.json` and Claude Code's own), so they stay out
  of the public repository, except in a hermetic agent dir (a test copy: one with its own
  `claude-projects/`, §app.claude-logins/registry), where it collects no login email and its answer
  says "login emails: a hermetic agent dir, skipped"; every other source is read as before; `{action: "add", text}` adds the user's names, one `<kind>: <value>` per line, through a
  private temp file Sova deletes; `{action: "show"}` answers
  the list. The names are shown to the merge thread and to the operator's own page; every other
  chat, and a chat's script on the operator's route, is refused (`forbidden`).

**Restart, test and names: the thread's tool or your click.** `merge.restart`, `merge.test` and
`merge.names` pass from the merge thread's own tool, and on the operator's route only on the user's
own click in Sova's page or a proven click from another of their computers (§app.access/your-click,
§app.project-services/merge-callers): a request that shows the token in a header (the operator's
own script, a terminal) or a blank caller key is refused, as for every other act on the queue, and
a chat's script on the operator's route gets "{verb} is the merge thread's (its own tool) or the
user's page, never a chat's script". `merge.live` is a read: any caller that may read the queue
calls it.

**Answers it can read whole.** Every merge verb's answer, as a chat's tool returns it, stays under
24,000 characters, so the Claude Code CLI never saves it to a file under `claude-accounts/`, which
the sandbox hides. A longer answer is sent again as compact JSON, then cut, and the cut says what was left
out and how to ask for less: `merge.status {entry}` answers that one entry, `merge.logs {run, step,
lines}` one step. A cut `merge.logs` keeps the newest log lines (the tail, where a failure shows)
and drops the oldest, and says how many it left out and to ask for fewer lines; any other cut answer
keeps its beginning.

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
fresh at each event, as before: its memory is for history, never for the queue's current state,
nor for how to do a step: each event's message names the guide pages to read again now (Read as you
go, §chat.merge-queue/thread).

## §chat.merge-queue/chat-card — A branch's card in the chat that built it

From the moment a branch is approved (§app.merge-queue/approve), the chat that owns it shows one
**queue card** for that branch. The approval may come from Land in the composer's worktrees control,
the session pane or the Merge Queue view, or from "land it" typed in that chat. The owner is the
chat the approval names (a typed "land it", a Land in a chat's own control or pane). Without one
(Land on the Merge Queue view), it is the branch's owner by the queue's one rule
(§app.merge-queue/owner), the chat that row shows: the chat that created and tracks the worktree,
else the newest chat working in it, an archived one included. A branch with no known chat gets no
card anywhere. Approving the same branch again after a Remove from Queue or Out of tries moves its
same card on, as a new "approved" revision; a Landed card is never reused.

**One card per branch.** A chat that owns several branches in the queue shows one card for each, and
each moves only at its own outcomes. The composer's worktrees control stays the summary of all of
them (§chat.composer/worktrees-control).

**Where it stands, and how it moves.** The card first stands where the chat was when the branch was
approved: after what was then the transcript's last row. It follows the chat by revisions, as a
follow card does (§chat.transcript-cards/placement):
- **In place** while the branch waits, is checked and is fixed by its chat: "Approved · waiting for
  a fix", its place in line ("Queued · 2nd"), the estimate, "Checking · 4 of 7 steps", "Back with
  the chat · try 2 of 3 · Unit tests failed", "Waiting for the merge thread", "Paused: you stopped
  the chat", the chat's answers (§chat.merge-queue/answers) and the merge thread's diagnosis. These
  updates change the card where it stands and never move it or the rows above it: it is never
  rebuilt, so the chat never shifts.
- **A new revision at the bottom** only for **Landed** and for a **decision** that waits for the
  user (§chat.merge-queue/decision: Behaviour differs, Needs you, Can't tell whose failure, Out of
  tries, a fix that needs your OK, Drafts changed), and for Removed, and on the host Request ready,
  Requested, Pushed and Closed. A request's host state changes in place. A conflict the merge thread
  is still judging, and everything sent back to the chat, stays in place. The newest revision is the
  full card; each earlier one folds to one line ("feat/x · Queued 2nd · earlier copy") that opens to
  show it as it was, read-only and with no actions. The newest copy is always where the reader is.
- A restart of the server never adds a revision twice: each outcome's revision is recorded with the
  queue's own records, once per entry, outcome and run.

**What it shows.** Every revision has the branch icon, the state pill in the same words as the
composer's modal, "{branch} into {target}", the short commit (the landed one once it lands, else the
approved one), the worktree's path, and **View Merge Queue**. While queued it says "starts in ~N min
· takes ~N min" and offers **Remove from Queue**; while checking, "Checking · 4 of 7 steps".
- **Landed** looks like the Merged card a chat's own merge gets (§chat.worktrees/merge-card): a
  LANDED pill, "{branch} into {target} {sha}", "{n} commits · +{a} −{d} · {time}" (counted at the
  landing, from the target before it to the approved commit, so they never drift), the merge
  thread's note, Sova's other notes (flaky tests, review notes, what a resolved conflict did; the
  review's notes in full, "Review: {summary}", folded, opening to one row per note as on the review
  card, §chat.merge-queue/review-card), the
  reason once when the push didn't happen ("Push held: {why}." when the queue's reason already says
  it is held, else "Not pushed: {why}.", or "Not pushed: this project doesn't push from the
  queue."), and "1 newer commit not included" with **Land Again** when the branch moved past the
  approval. **Review Changes** opens the changes viewer on exactly what landed: from the target
  before the landing to the landed commit, in the project's repository, even once the worktree is
  removed (§chat.changes/entry). When checked fix commits landed after the user's Land (never a
  rewritten one), the card lists them ("Fixes that landed with your Land:", each commit's short id
  and subject), and says when drafts were re-pinned (§app.merge-queue/standing-approval). Land Again
  stays, for work after the landing.

What it shows on the host, while the queue works it with the chat, and at a decision, and which
actions it offers, is §chat.merge-queue/card-states.

**Sova's own card.** The queue card is a card kind built into Sova on the transcript toolkit
(§chat.transcript-cards/built-ins), raised by the server from the queue's records. Nothing is
written into the chat's session file. It needs no card files and no trust. A chat's queue cards are
read with `GET /api/merge-queue/cards` (the catalogue's `session.merge-cards`, a look) and follow
the session feed. It works in every chat Sova holds or shows, those started before it shipped
included, pi and Claude Code alike:
- a chat with an open alignment question still gets it;
- an archived chat keeps its record, shown when it is opened;
- a chat open in a terminal gets nothing written, and the card is drawn whenever Sova shows it.

**Nothing back-filled.** Branches that landed before the queue cards existed get no card. The Merged
card stays for a merge a chat makes itself into a branch the queue doesn't manage
(§chat.worktrees/merge-card).

## §chat.merge-queue/card-states — The card on the host, while its chat fixes, and at a decision

Beside Queued, Checking and Landed (§chat.merge-queue/chat-card), the card reads:
- **On the host** (a project that lands by request, §app.merge-queue/requests): "Review the request"
  with **Review Request**, the request's title and description to read and edit, and **Publish**;
  then the request open, "PR #{n} open · checks running on GitHub", with **Open on GitHub** (or
  GitLab), whose host state changes in place in the request's words (host checks failed, changes
  requested or conflicts read "Back with the chat" in place, as the queue sends them back by itself,
  §app.merge-queue/requests); then a **Landed** revision once the host merged it ("Merged on GitHub.
  Sova checked it merged with {target}; GitHub's merge is final."), or "Closed on GitHub" with
  **Land Again**. Push branch only ends at **Pushed**. Land Again also shows on an open request or a
  pushed branch once the branch has newer commits.
- **Back with the chat** (in place) gives the reason with **See Why**, "try {n} of 3" (none for a
  conflict that was already there at the Land, which costs no try), and lists the failing checks
  ("Unit tests · 1 failed") with their failing tests and a link to each log, or the conflicting
  files. For a blocking review the state line ends "Review found {k} issues" ("1 issue"), which
  jumps to the review card (§chat.merge-queue/review-card), landing on its top and focusing it; when
  that card stands in another chat (a worker's branch, in the chat that runs it), it is a link that
  opens that chat on the card. The reason isn't repeated under it, and the review isn't listed as a
  failing check, since its findings and the merge thread's note are on that card. The line shows
  while the review is with the merge thread, being fixed or waiting for the user. The merge thread's diagnosis of any other failure is added as it arrives ("Merge
  thread: …"), and so is the chat's answer ("Fixed: commit 4fec160", "Fixed: drafts", "Fixed: commit
  4fec160 and drafts", "Needs you: …", "Can't: …"). A fix that arrives while the entry's run is
  checking reads "Back with the chat · Fix waits for the run checking now". It offers **Remove from
  Queue** only: no Land, no re-land, no send-back. When the fix is checked it reads "Fix checked ·
  back in line" and moves on to Queued in place.
- **Waiting for the merge thread** (in place), for a fix the merge thread can't check yet because it
  isn't running or hasn't ruled (§app.merge-queue/standing-approval), or a conflict it hasn't judged
  (§app.merge-queue/conflicts): the chat's answer, and Remove from Queue only. Once the thread is
  back and has checked the fix it reads "Fix checked · back in line".
- **Approved · waiting for a fix** (in place), for a finished branch the user landed while blocked
  (§app.merge-queue/approve): what blocks it, and Remove from Queue.
- **Paused: you stopped the chat** (in place), after Stop in the chat (§chat.merge-queue/requests):
  "Your next message lets the merge queue's requests through.", and Remove from Queue.
- **Drafts changed** is a decision (§chat.merge-queue/decision), offering **Land** (a new approval
  of the card's commit for the drafts as they are now, §app.merge-queue/after-approval) and Remove
  from Queue.
- **Removed**, after Remove from Queue: a final revision with the **Removed** pill and the reason
  "removed by you", and no queue action; approving the branch again later moves the card on as a new
  "approved" revision.

Land on the card approves the commit the card shows; Land Again and Out of tries' Land approve the
branch's head.
- **Decisions** (§chat.merge-queue/decision), each a new revision at the bottom: **Behaviour
  differs** shows both sides, the question, its choices and the proposal, with **Accept** when there
  is a proposal; **Needs you** shows the question and its choices; **Can't tell whose failure**
  names the check that failed on the merge and on the target alone, with its log, and offers **Land
  Anyway** and **Try Again** (§app.merge-queue/blame); **Out of tries** gives the reason with
  **Land** (§app.merge-queue/tries); a fix that needs your OK says why, with **Land**
  (§app.merge-queue/standing-approval). Each also offers Remove from Queue. No card has a text box;
  a decision answered in words is answered from the chat's message box.

There is no Send Back, Send Back to Chat, Land This Commit Again or Land Newest Commit on any card.
Land, Land Again, Accept, Land Anyway, Try Again and Remove from Queue are the same actions as the
composer's modal and the pane, kept in sync with them. They are catalogue commands over the merge
verbs (§app.project-services/merge-verbs): they act on the queue directly, never type into the chat,
and count only as the user's own click in Sova's page (§app.access/your-click).

## §chat.merge-queue/review-card — Review found issues: a blocking review's own card

When the review blocks a branch (§app.merge-queue/review), the chat gets a **Review found issues**
card for that review: the reviewer's whole report, uncut, the merge thread's note, and how the fix
is going. There is one card per review that blocks, apart from the branch's queue card
(§chat.merge-queue/chat-card), which only points to it.

**Where it stands.** It appears at the bottom of the chat when the review blocks, after what was
then the transcript's last row, where the chat is about to work on the fix; the request's folded
row comes below it (§chat.merge-queue/requests). It stands in the chat the review's request goes
to: for a worker's branch, the chat that runs the worker, up to the top chat when workers run
workers (§chat.merge-queue/chat-turns); when no such chat is known, the branch's own chat. It
changes in place as the fix goes on and never moves or shifts the rows above it. A blocking review
on an entry with no standing approval (a release's) gets no record and no card.

**What it shows.** A **Found issues** chip; "{branch} into {target} · {sha} · try {n} of 3", {sha}
the branch's commit that was reviewed; the reviewer's summary; then one row per finding, in the
reviewer's order: its kind as a word (Dead code, Duplication, Hack, Missing test, Naming, Other),
its file and line in mono when it names one, and its text, whole, as the reviewer wrote it. Under
the findings, the merge thread's note, "Merge thread: {note}", once it gives one; then the state
line; then **See Run** (the run page of the run that reviewed it) and **Open Reviewer Chat** (that
review's reviewer chat, readable once archived; a cleared one reads "Reviewer chat cleared" with no
link, §app.merge-queue/chats). It has no text box and no action on the queue.

**A finding's file.** A finding's file and line opens the changes viewer (§chat.changes/entry) on
that file in the change that was reviewed: the commit the reviewer read (the branch merged onto the
target, its drafts made official) against the target it was merged onto, so the reviewer's line
numbers match. It opens on the file, not scrolled to the line. Once that reviewed commit is no
longer kept (whether it is, is read again each time the chat's cards are read), the file opens on
the branch as it is now against the target instead, and the card says once, under its findings,
"The reviewed commit is gone: lines may have moved." A finding that names no file has no link.

**Its states**, in place. The card follows the review it belongs to, never the branch's newest state:
- **With the merge thread**: the review blocked and the merge thread has the whole report
  (§chat.merge-queue/thread).
- **Fixing**: the chat has the request: "Fixing · this chat answers when it's done".
- **Fix sent · re-reviewing**: the chat answered Fixed and the fix was checked
  (§app.merge-queue/standing-approval), or the merge thread put the entry back in line; it holds
  while the next run checks it.
- **Stopped before re-review**: the next run was sent back for something else: "a check failed: …"
  (the check's first line), "its spec drafts didn't fit" or "a conflict with {target}". It reads so
  whatever that run's reviewer answered, since no re-review passed it. The card keeps its findings,
  and goes back to Fix sent · re-reviewing when the branch is next checked.
- **Passed on re-review**: the next review didn't block; the queue card's Landed revision follows
  below as usual.
- **Waiting for you**: the entry waits for the user's decision: the chat answered Needs you, a Can't
  reached the user, the merge thread ruled it needs the user (§app.merge-queue/needs-user), or it ran
  out of tries, the same findings twice included (§app.merge-queue/tries). The decision itself
  stays on the queue card (§chat.merge-queue/decision); "Waiting for you" is a link that goes to it
  when it is on screen. Once the user answers it and the report goes to the chat with their answer,
  the card reads Fixing again (§app.merge-queue/send-back).
- **Removed**: the user pressed Remove from Queue.

**Blocked again.** When the re-review blocks again, a new card appears at the bottom for that
review, with its own findings and try. The earlier one folds to one line, "Review · try {n} · {k}
issues · fixed" ("1 issue"), which opens it as it was, read-only, its links (See Run, Open
Reviewer Chat, its files) and nothing else. Each review keeps its own report: a later review never
changes an earlier one's card.

**One record.** The card, the chat's request with its folded row, and the run's log all come from
one saved record of that review, kept with the queue's records (§app.merge-queue/review), so they
never disagree. The card is a kind built into Sova on the transcript toolkit
(§chat.transcript-cards/built-ins), raised by the server from those records; nothing is written into
the chat's session file. It is read with the chat's queue cards (`GET /api/merge-queue/cards`,
whose answer carries them beside the queue cards) and follows the session feed, and a restart never
adds it twice.

**In every chat Sova shows**: on reload, in an archived chat (shown from its record when it is
opened), and in a chat that can't take requests (archived, or open in a terminal, drawn in its
read-only watch view with nothing written to its session file), where it is the only place the
findings show. It sends no notification: a blocked review reaches the user only when
it needs them (§app.notifications/delivery).

## §chat.merge-queue/chat-turns — What the queue tells the chat's model

The queue never sends a chat a message that looks typed by the user: no "Sova: …" message is put
into the composer or the conversation for any outcome. It speaks only about repositories it serves
(§app.merge-queue/served): a chat working in any other repository gets no `[merge-queue]` message,
queue card or queue line, whatever its branches look like. The one exception is a typed "land it"
the queue turns down for that reason, said as below.

- **The host's news doesn't start a turn.** A request opened, its host state changing, merged,
  closed, or a branch pushed: each is a hidden line, as Landed is. Host checks failing, changes
  requested and conflicts on the host are sent back by themselves, as requests (below).
- **Landed and Drafts changed don't start a turn.** The chat's model reads one hidden line at its
  next turn, in a block of the chat's card note (so chats started before this shipped get it too).
  The block's first line is "From Sova's merge queue (not the user's words; nothing to answer):",
  then one line per fact, for example "feat/x landed on master at 4fec160, 8 commits. Note: …", or
  that the branch's spec drafts changed since the approval. A landing with review notes adds them,
  whole: "Review notes: …", so the model is told of them quietly and no turn starts for them. Each
  fact is given once, even across a server restart. The line is kept apart from the card, so it
  reaches the model whatever happened to the card.
- **Requests start a turn**, as batches on the merge queue's chat queue in the owning chat
  (§chat.merge-queue/requests): every send-back (a failure that is the branch's, a conflict the chat
  fixes, a blocking review's report, drafts that don't fit, the host's failing checks, changes requested
  or conflicts; §app.merge-queue/send-back), what still blocks a finished branch, before or after
  Land (§chat.worktrees/ready-to-land), and a merge thread's other approach after a "Can't". Each
  request carries what the card shows (the failing checks and where their logs are, the conflicting
  files as they are on the newest target, a blocking review's whole report as the reviewer wrote it,
  what doesn't fit) and the merge thread's diagnosis (for a review, its note), and asks the chat to
  answer Fixed, Needs you or Can't
  (§chat.merge-queue/answers). After a Land, it tells the chat that the user's Land stands, so once
  its fix is checked the branch goes back in line by itself, and that it must not ask the user to
  land it again; a batch of before-Land requests only says nothing of a Land. A request is never
  taken as the user's go-ahead (§chat.worktrees/land-own-word), is never drawn as the user's
  message, and is never counted in the composer's "N inputs". No merge queue message is sent as a
  `[merge-queue]` follow-up any more; one already in a transcript still reads with the author "Merge
  queue" and a branch icon, and on the Timeline as "From the merge queue", which Inputs Only leaves
  out (§chat.timeline/inputs-only). **Remove from Queue** starts no turn and leaves no hidden line;
  requests not yet delivered are dropped.
- **Chats that can't take requests.** A chat that can't take notes on a chat queue (archived, an
  Overseer, a project overseer or a baton chat, or one held open in a terminal, which Sova never
  writes to) gets none: a question for the user waits on the Merge Queue tab with one notification
  (§chat.merge-queue/asks), and any other request becomes the hidden line instead. A worker chat
  that owns a branch never receives requests itself: they go to the chat that runs the worker, up to
  the top chat when workers run workers (at most 8 levels), exactly once, their text naming the
  worker and the branch ("For your worker "{title}" …" before the queue's own words). When no chat
  that runs it is known, or that chat can't take them, the fact becomes the hidden line in the
  worker's own chat instead, so nothing is lost and nothing is sent twice.
- **Waiting for the user starts nothing by itself.** A decision (§chat.merge-queue/decision) asks
  the user on the card: its note to the chat is held, "not sent yet", and starts no turn and leaves
  no hidden line. When the user sends their answer from the message box, that one turn carries their
  answer and the held note together. Land Anyway, Try Again, Accept, Land and Remove from Queue act
  on the queue and start no turn.
- **A question from the merge thread** is a decision, once per question (§chat.merge-queue/asks):
  its note is held until the user answers, and says their own message is the answer, which Sova
  passes to the merge thread: nothing for the chat to relay.
- **A typed "land it" the queue refuses** is told to the model the same way, as a hidden line. In a
  repository the queue doesn't serve (a chat still on code from before that rule records such a
  go-ahead), the line is "{branch} at {sha} couldn't be queued to land: not a project the merge
  queue serves: merge it into main from the chat.", so the chat, once reloaded, merges it itself.
- A restart never repeats a revision, a hidden line or a request: each is recorded once per entry,
  outcome and run in the chat's own queue-card record, kept whatever the chat's alignment, archive
  or worker state. A request already pushed to the chat queue is delivered at least once
  (§chat.topics/delivery), with the same request id.

## §chat.merge-queue/asks — When the merge thread needs the user

The merge thread runs on its own (§chat.merge-queue/thread). When it needs the user, for the names
interview or any question it can't settle itself, it never waits in its own chat: it asks with
`merge.ask` (the question in plain words, its choices when it has them, and the entry it is about;
§app.project-services/merge-verbs), and Sova takes the question to the user. Each question gets an
id (`ak_…`).

- **To the branch's chat.** The question goes to the chat the entry records as its branch's
  (§chat.merge-queue/chat-card). When that chat is a worker, it goes to the chat that runs it, up to
  the top chat when workers run workers (at most 8 levels).
- **One decision, its note held.** The question shows on the branch's card as a decision
  (§chat.merge-queue/decision): the question and its choices, with the queue's note to the chat held
  and marked "not sent yet". The note is never the user's words or go-ahead
  (§chat.merge-queue/chat-turns): "The merge thread asked the user (question {id}):", the question,
  then that their answer is the message with the note, that Sova passed it to the merge thread too,
  and that there is nothing to relay.
  When the user sends their next message from the chat's message box, Sova records that message as
  the user's answer, and the note and their answer reach the chat together, in one turn. The
  `worktree` tool's guidance tells every chat the same. Exactly one notification is sent for it
  (§app.notifications/merge-queue).
- **The answer goes back.** The user's own message closes the question, and the thread gets it as
  its next event: "Answer to your question {id} (about {branch}), from {who}:", the answer, and the
  question. No chat relays it: `merge.reply` is taken only from the operator, never from a chat's
  script (§app.project-services/merge-callers). A second answer to the same question, or one to an
  unknown id, is refused.
- **No chat to ask.** When the entry names no chat, or its chat (after workers) is archived, gone,
  open in a terminal, an Overseer, a project overseer, a baton chat or one of the queue's own, or
  the message is refused, or the question names no entry, the question is held on the project's
  Merge Queue tab instead, and exactly one notification is sent for it, which opens that tab
  (§app.notifications/delivery). No message goes to any chat.
- **On the tab.** While a question is open the Merge thread card reads "Asking you" and shows "The
  merge thread is asking you something." with the question and its choices: one asked in a chat adds
  "Waiting on you · asked in {chat}", the chat's title a link to it (**Answer in Chat**); one held
  on the tab adds one button, **Answer in Merge Thread**, which opens the merge thread's chat with
  the question held above its message box ("Merge thread asks: {question} · not sent yet: your
  answer goes with it"), as a decision is (§chat.merge-queue/decision); the user answers in that
  message box, and their answer goes to the thread with the question and closes it as the user's
  answer. The card has no "Your answer" text box and no Send Answer; no card on the tab has a text
  box (§app.merge-queue/chats).

Open questions are kept with the project's thread record, across a Start Fresh or a replaced thread.
The user can always open the merge thread and talk to it directly; that is never needed.

## §chat.merge-queue/requests — The merge queue's requests, on a chat queue in the branch's chat

Everything the merge queue asks of a branch's chat reaches it as a **request**: a note on a chat
queue (§chat/topics) Sova opens in that chat, from the sender **Merge queue**. The branch's queue
card (§chat.merge-queue/chat-card) stays the one place its state and the chat's answers show. The
one other card is a blocking review's own, **Review found issues** (§chat.merge-queue/review-card),
one per review, drawn from the same saved record of that review as its request, so the two never
disagree.

- **One queue per chat.** Sova opens it the first time it has a request for the chat (for a worker's
  branch, the chat that runs the worker, §chat.merge-queue/chat-turns), on base `merge-queue`
  (§chat.topics/open), and keeps it while the chat is open. Only the merge queue pushes to it.
- **What goes on it.** Every send-back (§app.merge-queue/send-back), what still blocks a finished
  branch before or after Land (§chat.worktrees/ready-to-land), a merge thread's other approach after
  a "Can't" (§app.merge-queue/needs-user), and the held note of a decision once the user answers it
  (§chat.merge-queue/decision). Landed, Drafts changed and a refused typed "land it" stay hidden
  lines (§chat.merge-queue/chat-turns).
- **Each request has an id** (`rq_…`) and names its branch and its entry; the chat's answer names
  that id (§chat.merge-queue/answers).
- **Framed as requests, the user first.** A batch of them tells the model they are requests from
  Sova's merge queue it may act on, with its own user first (§chat.topics/delivery). They are never
  the user's words or go-ahead (§chat.worktrees/land-own-word).
- **Everything is delivered.** A request is never taken back before delivery, even once newer
  requests make it out of date; the chat reads them in order and answers each. The one exception
  is the user ending the entry: Remove from Queue drops its requests not yet delivered.
- **They wait for the chat.** Requests arrive between turns, never interrupting one, after the
  user's own queued messages (§chat.topics/delivery). A chat working on other work takes them when
  its turn ends.
- **Stop pauses them.** After Stop in the chat, no batch of requests starts until the user's next
  message; once a request is waiting for that chat, the card reads "Paused: you stopped the chat"
  (§chat.merge-queue/chat-card). Remove from Queue still ends the entry, and drops its requests not
  yet delivered.
- **In the transcript** a batch shows as one folded row, "Merge queue · {branch} · {n} requests",
  with a branch icon, opening to each request (§chat.topics/row). It is never a "You" bubble and
  never counted among the user's inputs.
- **Read like a turn the user started, for attention.** A merge queue batch's turn gets a turn
  outcome and its reply is checked for a question to the user (§app.decisions/attention-signals,
  §app.decisions/asks-user), unlike other chat queues' batches, and its reply counts as the chat's
  latest reply for its merge readiness (§chat.worktrees/ready-to-land), so a finished fix can read
  Ready to land and a chat that needs the user shows in Needs you.
- **Chats that can't take them** (archived, TUI-live, an Overseer, a project overseer, a baton chat)
  keep the fallback: a question goes to the Merge Queue tab with one notification, anything else
  becomes the hidden line (§chat.merge-queue/chat-turns).

## §chat.merge-queue/answers — Fixed, Needs you, or Can't

The branch's chat answers each request (§chat.merge-queue/requests) once, by its id, in one of three
ways, with `merge.respond` (§app.project-services/merge-verbs). Only the chat the request was sent
to can answer it, and only once; a merge thread's question is never one of its requests (the user
answers that, §chat.merge-queue/asks). The answer shows on the branch's card, in place
(§chat.merge-queue/chat-card), and in the Merge Queue tab's row.

- **Fixed**, with what changed: a commit (its id), drafts, or both. The merge thread checks the fix
  (§app.merge-queue/standing-approval); a drafts-only fix makes no commit, and Sova re-pins the
  approval's drafts once the fix is checked. A checked fix goes back in line by itself.
- **Needs you: <question, options>**: something only the user can decide
  (§app.merge-queue/needs-user). It becomes a decision on the card (§chat.merge-queue/decision); the
  merge thread can't overrule it.
- **Can't: <why>**: goes to the merge thread first, which may try one other approach, then raises it
  to the user as "can't be settled without you" (§app.merge-queue/needs-user).

A chat that ends its turn without answering a request it was sent leaves the entry back with the
chat; a new commit it makes is not a fix until it answers. Sova reads what a Fixed answer changed
itself (the commit it names, else the branch's head, and the drafts by their hash), and refuses one
when nothing changed since the request. An entry that landed, was removed or waits for the user's
decision takes no answer. Before Land, the requests that say what still blocks a finished branch or
that its drafts don't fit (§chat.worktrees/blocks-landing, §chat.worktrees/landing-specs) are
answered the same way; a Can't on the drafts one shows on the chip ("can't land them: <why>").
Before Land there is no entry, so a Needs you there is only recorded: it makes no decision, card or
notification, and reaches the user through the chat's own reply, which asks them
(§app.decisions/asks-user). The free-text "Can't land specs: <why>" line is no longer read: a chat
that can't make its drafts fit answers Can't.

## §chat.merge-queue/decision — A decision waits on the card, answered from the message box

What only the user can decide (§app.merge-queue/needs-user) waits as one **decision**: a new
revision of the branch's queue card at the bottom of the chat (§chat.merge-queue/chat-card), in the
Merge Queue tab's Needs you (§app.merge-queue/view) and in the landing bar
(§app.merge-queue/landing-bar-states), with exactly one notification (§app.notifications/delivery).

- **What the card shows.** The question in plain words and its choices, and, under them, the queue's
  note to the chat ("Merge queue: {note}"), held and marked with a **Not sent yet** chip and "your
  answer goes with it". No card has a text box.
- **Choices fill the message box.** A choice button adds its words to the chat's message box and
  puts focus there, where the user may change them; nothing is sent until the user sends.
- **The message box says it is waiting for the user's answer.** While a decision's note is held, the
  composer shows it above the message box ("Merge queue · {branch} · not sent yet: your answer goes
  with it"), so the user knows their own answer is wanted there.
- **One turn.** When the user sends, their answer and the held note reach the chat together, as one
  message: the user's message as their own words, then the note, marked as the merge queue's held
  note, never the user's (§chat.topics/delivery). Sent while the chat is working, they go together
  into the running turn, not as a turn of their own, so a later unrelated message never carries the
  note. Only the user's own message from their page on this computer counts (a prompt or a steer),
  never a card's click. The message answers the decision it names (a choice button names it), else
  the newest decision waiting in that chat. In the transcript the user's bubble shows only their own
  words; the held note folds under it, "Merge queue · {branch} · sent with your answer". The
  decision is then answered: the card moves back to in-place updates ("Back with the chat") and the
  tab's and landing bar's Needs you drop it.
- **Queue answers act at once.** Accept, Land Anyway, Try Again, Land and Remove from Queue on a
  decision act on the queue directly, like the other card actions, and send nothing to the chat.
- **Only the user answers.** A decision's buttons count only as the user's own click in Sova's page,
  and its answer only as the user's own message sent from the chat's message box
  (§app.access/your-click): never a chat's script, a tool, another session or the merge thread.
- **No chat to show it in** (archived, TUI-live, an Overseer, a project overseer, a baton chat): the
  decision waits on the Merge Queue tab instead, answered there by its buttons or in the merge
  thread (§chat.merge-queue/asks).

## §chat.merge-queue/sova-restart — Sova's merge thread restarts Sova after landings

Sova's own project playbook (`.sova/playbooks/merge-queue/`, its "When the queue is idle") has
Sova's merge thread restart Sova after landings that change what its server runs, so new server code
goes live without the operator pressing Restart Sova. The thread does it through one merge verb Sova
runs for it, `merge.restart {project}`, never a script or command of its own
(§chat.merge-queue/thread-sandbox). It is an instruction in that playbook, not a product setting:
there is no switch and nothing on screen for it, and no other project's merge thread does it (each
follows its own project's playbook; Sova's method playbook forbids restarting anything unless the
project's playbook says so, §chat.merge-queue/thread). `merge.restart` answers only for the project
Sova itself runs from, and only to that project's merge thread or the operator.

- **What needs a restart.** One rule (`server/restart-paths.ts`) says which landed files the server
  loads only at its start:
  - code under `server/`, `shared/` or `pi-config/`, but not tests (`*.test.*`) or Markdown docs;
  - the `src/` files the server or a chat process imports at runtime (its list is held to a walk of
    the server's imports, so a new import is caught);
  - the package list, lockfile, workspace install settings and toolchain pin (`package.json`,
    `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`), which also need an install first.

  Landings of other page files (`src/`, `public/`, the page's build settings) only get the page
  rebuilt, never a restart. A `package.json` whose only change is its `version` (a release's bump)
  counts for neither. A session's "restart pending" and its status line's "restart owed" read the
  same file rule (§chat.worktrees/readiness), file by file, so a release commit may still show there.
- **When.** Only on the queue's Idle (§app.merge-queue/empty), and once: `merge.restart` plans from
the commit Sova started on to the target's head, with the file rule above. It does nothing while
anything is queued or checking; the thread waits for the next Idle. When nothing needs it, nothing
happens. `merge.live {project}` tells the thread, without reaching Sova's port, the commit Sova runs
and when it started, the target's head and the plan between them, and the Idle message carries the
live commit too.
- **Never during a release.** While a release is open (§app.release/checks) `merge.restart` builds
  and restarts nothing. The release's hold lifting at Publish or Abandon sends Idle again, and the
  thread catches up then. A release's own commit is never a reason to restart: trying a release
  live stays the operator's Apply (§app.release/sova).
- **Page files only:** it runs `pnpm run build` in the main checkout and restarts nothing; on a
  failure the note says "The page build failed after landing {branch}: {first error line}." When a
  page build passes after an earlier one failed, the failure line goes from the landing's note and
  nothing is added, so the note carries no stale outcome. Open tabs offer the newer page.
- **A restart, in order:**
  1. It holds the queue's new starts (`merge.hold`, §app.merge-queue/empty).
  2. In the main checkout it runs `pnpm install --frozen-lockfile` when an install file changed,
     then `pnpm run build`. If either fails, nothing restarts, the hold is cleared, and the answer
     and the note say "Not restarted: {install|build} failed after landing {branch}: {first error
     line}."
  3. Otherwise it renews the hold, so it still holds new starts when the restart is scheduled,
     however long the install and build took; then it answers with the commit it expects and
     restarts the project's adopted unit
     (Sova's: `sova-runtime.service`) 3 seconds later, as Apply does, but only when the server
     answering is that unit's own main process; otherwise nothing restarts ("this server isn't run
     by {unit}: nothing restarts"), never through `POST
     /api/updates/restart`, which still refuses chats (§app.updates/restart). Chats and workers,
     the merge thread included, keep running through it (§app.chat-processes/survives-restart).
  4. At its next start Sova compares the commit it started on with the expected one, lifts the
     hold, and writes the outcome on the newest landing's note (§app.merge-queue/note), in place
     of an earlier restart outcome and keeping the rest of the note: "Restarted Sova after landing {branch}.", or "Restart after landing {branch} didn't come
     back on {sha}: it started on {sha}. Check sova-runtime.service." A restart scheduled but not
     seen at a start within 2 minutes goes stale. The thread never retries a failed restart: the
     next Idle plans again.
- **One outcome on each landing's note.** Sova writes every outcome above on the newest landing's
  note itself, failures included; the thread doesn't note a failed restart again. A landing's note
  keeps one restart outcome, the latest: a new one (a build that failed, then passed) replaces the
  earlier one, Sova's or the thread's, and the rest of the note stays.

This is the one place a chat restarts Sova (§app.access/your-click), and only through that verb.
