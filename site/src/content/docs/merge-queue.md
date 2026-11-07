---
title: Merge queue
description: Each project's branches reach its main branch through one queue. Sova merges each branch onto the newest main branch in a copy of its own, runs the project's checks there, and lands exactly the commit it tested.
group: Features
order: 10.5
---

A project on Sova's Projects list gets a **merge queue** once its checks are set up. From then on it
is the only way a branch reaches that project's main branch (`master`, or `main`). A repository
that isn't on the list has no queue: its chats merge into the main branch plainly when you ask.

## Land a branch

A branch enters the queue only on your word, in one of two ways:

- **Land**: in the composer's worktrees control, on the branch's row in the session pane's
  Worktrees section, or on the project's **Merge Queue** tab. Its menu also holds **Land Without
  Review** (when the project has a review) and **Land Without Its Specs…**, which leaves the
  branch's spec drafts behind.
- **Typing "land it"** (or "merge it") in the branch's own chat. "land it without its specs" and
  "land it, skip review" are taken as said. Only your own typed message counts: one the Overseer,
  a baton or another chat sent never does.

Land approves exactly the commit the screen showed you. Work you do on the branch after that isn't
included ("1 newer commit not included"): land again for it. Land refuses a branch with uncommitted
files, nothing ahead of the main branch, or a temporary commit (`WIP`, `fixup!`). A branch whose chat
says it's finished but that is held up by something the chat can fix (a failing check, spec drafts
that don't fit) can still be landed: it reads **Approved · waiting for a fix**, its chat is told what
blocks it, and it joins the line by itself once nothing does. One that only conflicts with the main
branch joins the line at once, and the merge thread takes the conflict.

**One Land is enough.** Your Land stands until the branch lands, you remove it, or it waits for a
decision only you can make. While it stands, the queue and the branch's chat fix landing problems
between them, and you never press Land again for their fixes.

Branches run one at a time, in the order you approved them, and each row shows its place: "Queued
· 2nd", with when it starts and how long it takes.

## What happens to it

1. **Merged in a copy.** Sova merges the branch onto the newest main branch in a separate copy
   beside the project, never in your folders. The branch's spec drafts become official there, so
   the docs that land are the ones that were tested.
2. **Checked.** The project's checks run on that merge: the ones it always runs, the ones the
   change's files call for, and any the merge thread adds for this branch. A project may also have
   a read-only **review** look at the change.
3. **Landed.** The main branch moves to exactly the commit that was tested, then your main folder
   follows, and the queue pushes it to `origin`. A project can instead land by opening a pull
   request on GitHub, a merge request on GitLab, or only pushing the branch (**How it lands**, in
   Settings → Merge Queue).

The branch's chat gets one card for its branch, from Land on, updated in place as it moves:
"Queued · 2nd", "Checking · 4 of 7 steps", "Back with the chat · try 2 of 3 · Unit tests failed",
"Waiting for the merge thread". It moves to the bottom of the chat only when the branch lands or a
decision waits for you. The Landed card lists the chat's fixes that landed with your Land. The
worktree stays where it is: Sova never removes it.

<!-- screen: landing-progress | A branch's card in its own chat, updated in place as the queue checks it: its place in line, the check running now and how long it takes. -->

## When something fails

A red check is blamed on the branch only once the same check has passed on the main branch alone,
in the same copy. A failure that also happens on the main branch is noted on the landing and
doesn't hold the branch; a test that passes when run again is noted as flaky.

### Sent back to the chat, by itself

When the problem is the branch's (a check it broke, a conflict the merge thread can't resolve
safely, review findings, spec drafts that don't fit), the queue sends it back to the branch's chat
on its own, with the merge thread's diagnosis. There is no Send Back button to press. The request
arrives on a chat queue Sova opens in that chat, from **Merge queue**, between turns and after your
own messages; it shows in the chat as one folded row, "Merge queue · feat/x · 2 requests". Your own
messages come first, and the requests are never your words or your go-ahead.

The chat answers each request in one of three ways:

- **Fixed**, with what changed: a commit, its spec drafts, or both. The merge thread checks that
  the fix changes only what was asked, and the branch goes back in line by itself, with the fix
  carried by your Land. A fix of the drafts alone needs no commit.
- **Needs you**: something only you can decide. It becomes a decision (below).
- **Can't**, with why. The merge thread may try one other approach; if that fails too, it comes to
  you as "can't be settled without you".

The card shows where it stands, in place: "Back with the chat · try 2 of 3 · Unit tests failed",
the chat's answer ("Fixed: commit a1b2c3d"), "Waiting for the merge thread" while a fix waits to be
checked (a fix is never landed unchecked), and "Paused: you stopped the chat" after you press Stop
there; your next message lets the requests through again.

Each Land has **3 tries**. A run that fails the same way twice stops early. Out of tries, the card
reads **Out of tries** with the reason, and waits for you: **Land** tries again with three new
tries, or **Remove from Queue**.

**Remove from Queue** is on the branch's card and row at every stage. It takes the branch off the
queue at once and deletes nothing: the branch, its folder, its commits and its drafts stay.

### Decisions that wait for you

Only what is yours to decide stops for you: anything a person sees or does differently (wording,
layout, controls, defaults, notifications, noticeable timing, data kept or deleted, permissions and
safety), a change of meaning to something you agreed, or anything the branch's task never decided.
Either the merge thread or the branch's chat can raise it, and neither can overrule the other.
Each decision sends one notification, and shows on the branch's card at the bottom of its chat, in
the Merge Queue tab's **Needs you** and in the sidebar's landing bar:

- **Behaviour differs**: the main branch's side, the branch's side and the merge thread's
  proposal, with **Accept** when it proposed a resolution.
- **Needs you**: a question from the merge thread or the chat, with its choices.
- **Can't tell whose failure**: a check failed on the merge and on the main branch alone.
  **Land Anyway** lands the commit it tested; **Try Again** checks it afresh and uses no try.
- **Out of tries**, **A fix needs your OK** (a fix on top of work you asked for, or wider than
  asked) and **Drafts changed** beyond making them fit: **Land**.

No card has a text box. A question is answered in the chat's own message box: its choice buttons
put their words there for you to change or send, and the queue's note to the chat waits on the card
marked **Not sent yet**. The message box says so too ("Merge queue · feat/x · not sent yet: your
answer goes with it"). When you send, your answer and the queue's note reach the chat together, in
one turn. On the Merge Queue tab, **Answer in Chat** opens the branch's chat to answer there.

Land, the answers on a decision and Remove from Queue count only as your own click in Sova's page
(or, for Land, "land it" in your own words): never a chat's script, the merge thread or another
session. The queue's requests never count as "land it".

## The Merge Queue tab

The project page's **Merge Queue** tab shows the main branch at its commit and whether `origin` has
it, the queue's state with **Pause Queue** and **Queue Settings**, what is being checked now (the
check, a meter and how long it takes), the line of waiting branches, and the recent landings with
their notes. Every row opens its chat and has **Review Changes**, which shows the change in the
changes viewer.

<!-- screen: merge-queue-tab | A project's Merge Queue tab: the main branch at its commit, the branch being checked with its meter, the branches waiting in line, and the recent landings with their notes. -->

Each run has a page of its own: the branch, the commit that was tested, its verdict in plain words (and, for a red run, whose failure it is), then every check with why it ran, its time and its **Log**. Nothing merges from a run until every check passes.

<!-- screen: merge-queue-run | One branch's run page: its verdict, the tested commit, and Checks and why, each check with its result, its time and its log. -->

The queue pauses itself, and says why, when the main branch moved outside the queue, when the
project folder has uncommitted edits, or when setup fails on the main branch itself. **Resume
Queue** starts it again.

## The merge thread

Each project has one **merge thread**, a chat Sova starts to help the queue: it writes a note on
each landing, picks extra tests the change could break, judges conflicts and explains failures. It
acts only through the queue, never moves the main branch itself, and a missing or slow thread
never delays a landing. When it has a question about a branch, it asks in that branch's chat.
A question no branch's chat can carry shows on its card on the Merge Queue tab with one button,
**Answer in Merge Thread**, which opens the thread's chat: you answer in its message box.

The thread works read-only: its sandbox lets it write only in its own temp folder, never in your
project's folders, with no network. Everything beyond reading, such as restarting Sova after
landings, writing a conflict's resolution or running a test, it asks Sova to do. Its chat's head has
a **Run logs** chip with their size: Sova packs a run's logs a day after it ends and never deletes
them, unless you press **Clean Logs…**, which says what goes and asks first. The newest 10 runs, the
run checking now and the runs of entries still open keep theirs.

The thread and every review chat are the queue's own: they stay out of your session lists and are
opened from the Merge Queue tab, which keeps their history until you clear it. **Start Fresh…**
replaces the thread.

## Set it up

A project on the Projects list with no checks yet shows **Set Up with a Chat** on its Merge Queue
tab. That opens the project's Setup chat, one standing chat per project, working in a worktree of
its own. It reads the project, asks what it can't find, and proposes the checks on a setup branch:
listed checks, one test command, or no automated tests.

The tab shows what the branch proposes, read from its files, and every file it changes. The branch
can land only after a trial of its exact commit passed, because the queue checks a branch with the
main branch's checks, not its own. Until then the proposal offers **Run Trial** in Land's place, and
a newer commit needs a new trial. The same rule holds for any chat's branch that changes the
project's merge, release or deploy setup. Once the checks are on the main branch, the project's
branches land through the queue. **Change Setup** opens the same chat later.

**Settings → Merge Queue** shows every value a project's queue uses, each tagged with where it
lives (the project's file, this computer, or Sova), and lets you change them: how it lands, the
checks, the review and its model, and the merge thread's model. A change to the project's file is
saved as one commit you confirm. [Merge queue settings](/docs/merge-queue-settings/) has the whole
tab.

While a [release](/docs/releases/) is open, the queue is frozen for it: only the release's own
commit lands, nothing is pushed, and other branches wait in line until it is published or
abandoned.
