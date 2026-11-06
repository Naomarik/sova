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

Land approves exactly the commit the screen showed you. A branch that moved on since lands that
commit, with "1 newer commit not included"; land again for the newer one. Land refuses a branch
with uncommitted files, nothing ahead of the main branch, or a temporary commit (`WIP`, `fixup!`).

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
queued, checking, landed. The worktree stays where it is: Sova never removes it.

<!-- screen: landing-progress | A branch's card in its own chat, updated in place as the queue checks it: its place in line, the check running now and how long it takes. -->

## When something fails

A red check is blamed on the branch only once the same check has passed on the main branch alone,
in the same copy. A failure that also happens on the main branch is noted on the landing and
doesn't hold the branch; a test that passes when run again is noted as flaky.

- **Needs a fix**: the failure is the branch's. Its chat is told what failed and why, and the row
  offers **Land This Commit Again** and **Remove from Queue**. Once the chat has fixed it, Land it
  again.
- **Can't tell whose failure**: a check failed on both sides in a way that can't be pinned on
  either. It waits for you: **Land Anyway** or **Send Back**.
- **Conflict**: the merge thread resolves a conflict that changes no behaviour, such as both sides
  adding to a list, and the full checks run on its resolution. When the two sides want different
  behaviour, the row reads **Behaviour differs** with both sides in plain words and a proposed
  resolution: **Accept** or **Send Back**.
- **Review flagged**: the review found a problem. **Land Anyway** or **Send Back**.
- **Drafts changed**: the branch's spec drafts changed after you approved it. Land it again.

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
never delays a landing. When it has a question for you, it shows on its card on the Merge Queue
tab.

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
