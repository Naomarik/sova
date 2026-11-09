# §app/merge-queue — Merge queue
> Part of the Sova design spec · [overview](../design/overview.md)

Each project the merge queue **serves** (§app.merge-queue/served: on Sova's Projects list, with its
merge setup done) has one **merge queue**, owned by Sova and worked mechanically. It is the only way
a branch reaches that project's target branch (`master`; `main` where the project's definition or
repository says so). Every other repository has no queue at all: its chats merge into its main
branch plainly, with git (§chat.worktrees/tool). The one exception is the queue's own settings
commit: a save from the queue's settings (§app.merge-queue/settings-save), one commit the user
confirms. Setting the queue up, or changing its checks, goes through the project's Setup chat as a
branch the user lands (§app/project-setup). The user approves a
branch (§app.merge-queue/approve); each branch belongs to one chat, by one rule
(§app.merge-queue/owner), which hears about it. Sova then merges it onto the newest target in a merge copy of
its own, one branch at a time, and turns its spec drafts into docs there. It runs the project's
checks on that commit (§app.merge-queue/run, §app.merge-queue/checks). Then the branch lands the
way the project's **How it lands** setting says (§app.merge-queue/strategies): by default Sova
fast-forwards the target to exactly the commit it tested (§app.merge-queue/land) and pushes it
(§app.merge-queue/push); a project may instead open a pull request on GitHub or a merge request on
GitLab (§app.merge-queue/requests), or only push the branch (§app.merge-queue/publish).
Every setting the queue uses shows in Settings → Merge Queue (§app.merge-queue/settings).
Each branch's row says what the branch does, in a few bullets (§app.merge-queue/branch-summary).
A failure goes to the branch's chat only once the same check passed on the target alone
(§app.merge-queue/blame).

A chat working the project's merge playbook, the **merge thread** (§chat.merge-queue/thread),
helps:
- it adds a note to each landing (§app.merge-queue/note);
- it picks tests the change could break;
- it judges conflicts (§app.merge-queue/conflicts), in a scratch copy Sova makes for it and removes
  (§app.merge-queue/resolve-copy);
- it explains failures, in the entry's note;
- it hands a blocking review's report on to the branch's chat, which Sova keeps whole, one record
  per review, and sends in the reviewer's own words (§app.merge-queue/review-report,
  §app.merge-queue/send-back).

It acts only through the merge verbs (§app.project-services/merge-verbs). Sova starts every run by
itself, and a missing or slow thread never delays a landing.

The queue knows nothing about any one project. It reads only the project's definition
(`.sova/project.json`) and the existing verbs, so it works the same for every project: Sova's own
repository, a site with one test command, a project that has no tests. The queue models no "live"
or "not live" state anywhere and has no Restart Server control. Restarting stays where it is
(§app.updates/restart and the operator's Apply verb), with one exception that is no queue feature:
Sova's own merge thread restarts Sova after landings that change its server code
(§chat.merge-queue/sova-restart). The queue's part is generic: it tells the thread when nothing is
left to check, and holds new starts while the thread asks it to (§app.merge-queue/empty).

Batching ("test up to N branches together") is a per-project setting fixed at 1 and not shown.
There is no trial phase and no switch: a served project's queue is how its branches land.

## §app.merge-queue/served — Which projects the queue serves

One rule decides whether a repository goes through the merge queue. It is **served** when both hold:
- its main checkout is the folder of a project on Sova's Projects list that isn't archived; a
  repository that is only a git folder, or that carries its own `.sova/project.json`, is not
  enough;
- and its merge setup is done: the `.sova/project.json` at the target's head declares checks (a
  `merge` section's checks or `"none"`, or a test command, §app.merge-queue/checks), or it is there
  but doesn't parse, which is a broken setup said as such, never bypassed (§app.merge-queue/setup).

A listed project without a merge setup, and every repository not on the list, is **not served**: it
merges plainly, and nothing refuses it. Its chats merge a branch into its main branch with git when
the user asks or agrees, with no prompt beyond the sandbox's usual confirm, and the user's typed
"land it" or "merge it" makes the chat merge the branch into the main branch itself, spec drafts
made official in the same step (§chat.worktrees/tool). For it Sova makes no queue record, go-ahead,
queue card, merge thread, merge copy or `[merge-queue]` message, offers no Land, and reads no
Ready to land or Landing specs (§chat.worktrees/ready-to-land).

**One answer, read at the moment of a merge.** Sova's server works the rule out and keeps the
answer in `<state root>/merge-served.json`: each served repository's main checkout and its target.
It writes the file at every start, before it takes any typed go-ahead, and again whenever the
answer changes (a project added to the list, removed or archived, a setup saved, a target whose
definition changed). A chat reads it afresh at each merge or "land it", never once at its start,
so a project listed or set up while the chat is open takes effect at its next merge. Every chat Sova
starts is told its server's state root. A chat Sova doesn't run treats every repository as not served. A
chat Sova runs with no state root reads as served, and one that finds the file missing or
damaged treats the repository as served, so a served project never merges around its queue. When
the server can't read its Projects list, it serves nothing until it can.

**Every way in asks the same rule.** Land, a typed go-ahead the queue picks up
(§chat.worktrees/landing-answers), the merge verbs from a chat, the Overseer or the assistant
(§app.project-services/merge-verbs), the queue's view, the merge thread's wake and readiness's
messages each ask it first. A request for a repository that isn't served is answered with one
sentence, "not a project the merge queue serves: merge it into main from the chat" (a merge
verb's error `unsupported`), and leaves no record behind: asking never creates a queue for it.

**Leftover records.** A queue record on disk for a repository that isn't served (one made before
this rule, or a project since removed from the list) is never loaded at start-up: Sova neither runs it nor feeds
it go-aheads, and leaves the file as it is.

## §app.merge-queue/approve — Approving a branch

**Two ways to approve.** A branch enters the queue only on the user's approval:
- **Land**, in the composer's worktrees control (§chat.composer/worktrees-control), on the session
  pane's Worktrees rows (§chat.worktrees/pane) or on the Merge Queue view (§app.merge-queue/view);
- or the user typing "land it" (or "merge it") in the branch's own chat, which that chat records
  with `worktree land` (§chat.worktrees/tool). That action refuses any message the user didn't type
  themselves (§chat.worktrees/land-own-word).

Both approve the same thing. The Land button asks once, on the row itself, before it approves
(§chat.composer/land-confirm); a typed "land it" asks nothing more. Nothing else approves: not the
merge thread, not the branch's chat, not an Overseer card, not another chat. Land counts only as the
user's own click in Sova's page (§app.access/your-click): the same request from a chat's script, a
tool, a token script or another session is refused with where to click, and nothing is queued. The
merge thread and the branch's chat can never start a landing; they only fix what the user's Land
already covers (§app.merge-queue/standing-approval). The one entry no person approves is a release's
own (its release commit, or the revert of an abandoned one): Sova adds it itself, approved `by:
release`, without review (§app.release/checks).

**What an approval pins.**
- The commit the screen showed: the row's head on the project page, in the composer's modal and in
  the pane, or a proposed run's reviewed tip; for a typed "land it", the head at that moment. A
  commit that isn't on the branch is refused ("{sha} isn't on {branch}"); a branch that has moved
  past it lands the shown commit, with "{n} newer commits not included" when those commits hold real
  work (§app.merge-queue/after-approval).
- How it lands, as it is in effect at that moment (§app.merge-queue/strategies), so a settings
  change made after the approval never redirects it.
- A hash of the branch's own spec drafts (the files under each draft's `spec/`, as
  §chat.worktrees/ready-to-land reads them), with those drafts copied aside so the run uses exactly
  them. A branch's own drafts are the ones Git doesn't track, plus any tracked draft the branch adds
  or changes since its merge base with the target. A draft already on the target that the branch
  leaves alone is never hashed, named, landed or deleted.

The entry joins the end of the line, which runs in the order approvals came, and shows its place
("Queued · 2nd"). Approving a commit that is already queued changes nothing.

**Finished but blocked.** Land is also taken on a branch whose chat says its work is finished but
that isn't Ready to land only for something its chat can fix (§chat.worktrees/ready-to-land). A
branch that only conflicts with the target is Ready to land (§chat.worktrees/ready-to-land) and
joins the line as usual, and its run's conflict path takes over (§app.merge-queue/conflicts), using
no try. For the chat's own failing check run or spec drafts that don't fit, the entry reads
**Approved · waiting for a fix** and doesn't join the line yet; the chat is told, as a merge queue
request (§chat.merge-queue/requests), what still blocks it. Sova looks again every minute: once
nothing blocks the approved commit and its drafts, Sova puts it in line by itself, at that same
commit, with no new Land. A new commit becomes the one that goes in line only as a fix the chat
answered with, under the fix rules of §app.merge-queue/standing-approval.

**Real work keeps Land, whatever it reads.** Land is taken on a branch with something left
(§chat.worktrees/nothing-left) whatever its row says: a conflict, a chat still working, questions still
open. The row says that true state beside Land (§chat.composer/worktrees-control), and the approval goes
on as any other does.

**What it refuses**, with the reason and nothing queued:
- a branch with nothing left and no draft to land (§chat.worktrees/nothing-left), by Land, typed words
  or `merge.add`: "Nothing to land: everything on this branch is already on {target}." ({target} is the project's: "… already on master." where it lands on
  master.) No check runs, nothing reaches the target and no entry or other record is made. It comes
  first: only what is about the project and not the branch comes before it (the target branch itself,
  a repository the queue doesn't serve, an invalid or unset definition), so such a branch is never told
  to run a trial, or that it is a scratch copy or has uncommitted files or a temporary commit. A branch
  whose only leftovers are spec drafts is not refused: its approval lands just the drafts
  (§app.merge-queue/run), and an approval of it without its specs is refused with the same sentence. Such
  an approval keeps the temporary-commit refusal below. An answer of unknown is not nothing, and isn't refused here;
- a branch with uncommitted files;
- a branch with a temporary commit subject;
- the queue's own scratch copy (§app.merge-queue/resolve-copy);
- the target branch itself;
- a repository the queue doesn't serve (not on the Projects list, or its merge setup not done), with
  "not a project the merge queue serves: merge it into main from the chat", making no queue record
  (§app.merge-queue/served);
- the project's setup branch at a commit with no passing trial: "This setup branch has no passing
  trial at {sha7}: run a trial of it first." (§app.project-setup/land-gate);
- while the target's `.sova/project.json` doesn't parse, any branch but one whose own commit carries
  a valid definition declaring checks: "The project's .sova/project.json is invalid: {path}:
  {message}. Fix it on the target, or land a branch that fixes it; nothing else lands until it
  parses" (§app.merge-queue/setup);
- an approval that lands as a request (§app.merge-queue/strategies) where none can open, whether by
  Land, typed words or Land Again: "This project has no remote named origin, so Sova can't open a
  pull or merge request here"; "origin isn't on GitHub or GitLab, so Sova can't open a pull or merge
  request here"; a How it lands that names the other host than `origin`'s, "origin is on GitLab, not
  GitHub: change How it lands" (or the reverse); or this computer not signed in to that host
  (§app.merge-queue/hosts). Push branch only isn't checked here.

An approval is still taken while the queue is paused; a pause stops runs, not approvals.

**Its options.** Each is set once per approval, on the Land control's menu or in the typed words:
- **Land without review** ("land it, skip review") skips the review step (§app.merge-queue/review)
  for this approval only.
- **Land without its specs…** ("land it without its specs") leaves the branch's drafts behind. Its
  docs step then turns nothing into docs.

The Land menu has no choice of how it lands: the project's setting decides. But words typed in the
branch's chat that ask for a pull request or a merge request ("open a PR", "open an MR") are never
blocked: on a project the queue serves they record a go-ahead that lands as a request on `origin`'s
host whatever the project's setting, through the same checks (§app.merge-queue/strategies).

**After approval** (§app.merge-queue/after-approval): the user's one Land stands until the branch
lands, the user removes it, or it waits for the user's decision; Remove from Queue takes it back.

## §app.merge-queue/after-approval — After approval: one Land stands, and taking it back

**After approval: one Land stands.** The user's one Land stands until the branch lands, the user
removes it, or it waits for the user's decision (§app.merge-queue/standing-approval). It covers the
fix commits and draft fixes the branch's chat makes while working the queue's requests, once the
merge thread confirms each changes only what was asked; nothing else.
- **A new commit that isn't a checked fix** (work the user asked for meanwhile, or anything the
  merge thread doesn't confirm) doesn't change the entry. The approved commit, with any checked
  fixes, lands, and the row says "1 newer commit not included" (or "{n} newer commits") only for real
  work: it counts the branch's own first-parent commits past it that aren't merges, none the target
  already has, so a catch-up merge counts for nothing and adds no line. After the landing, **Land
  Again** on the Landed card and rows lands that later work, and shows only when there is some. The
  chat is told at approval to leave the branch alone until it lands: real new commits stay allowed and
  read as new work (§chat.merge-queue/chat-turns).
- **Drafts edited after approval** (the branch's own drafts no longer match the pinned hash; an edit
  to any other draft in its worktree doesn't count): when the chat only made them fit, answering
  Fixed to the queue's request, and the merge thread confirms it, Sova re-pins the approval's drafts
  as they are now and the entry goes on, with no new Land. A new or changed promise, an edit the
  user made, or any drafts change not answered Fixed to a request of the queue's, stops the entry
  before its run starts, or voids a run already started, and waits for the user's decision as
  "Drafts changed since you approved" (§chat.merge-queue/decision), with Land (the drafts as they
  are now) and Remove from Queue; the chat's model reads it as a hidden line at its next turn, with
  no turn started (§chat.merge-queue/chat-turns).

**Back with its chat.** An entry the queue sends back (§app.merge-queue/send-back) is not final:
while the user's Land stands, Sova puts it back in line by itself once its chat's checked fix
arrives, up to its tries (§app.merge-queue/tries). There is no button to send anything back, and no
button to land the sent-back commit again or the branch's newest commit: Send Back, Send Back to
Chat, Land This Commit Again and Land Newest Commit exist nowhere. While it is with its chat:
- **"land it" typed in its chat** is the user's approval of the head at that moment, as always; it
  replaces the standing entry with a new one at that head (§chat.worktrees/land-own-word).
- **Remove from Queue**, at every stage (approved and waiting for a fix, in line, checking, back
  with its chat, paused, waiting for the user's decision, out of tries), takes the entry off the
  queue with no confirm and deletes nothing (branch, folder, commits, drafts and run logs stay): it
  ends cancelled, "removed by you", its card gets a final Removed revision, requests not yet
  delivered to its chat are dropped, and the branch reads as itself again. A release's own entry
  (§app.release/checks) ends plainly cancelled instead.

**Taking it back.** In the line, **Remove from Queue** takes a queued entry out of the line; nothing
lands, and the branch is Ready again. On a checking entry it stops the run, resets the merge copy
and leaves the target where it was. No screen has a separate Cancel button: Remove from Queue is
`merge.cancel` at every stage. Like Land, Remove from Queue counts only as the user's own click in
Sova's page (§app.access/your-click).

## §app.merge-queue/standing-approval — One Land covers the checked fixes

The user's Land (or typed "land it") is a **standing approval**: it stands until the branch lands,
the user removes it (Remove from Queue), or it waits for the user's decision
(§chat.merge-queue/decision), and while it stands the user never presses Land again for it.

**What it covers: checked fixes only.** A **fix** is what the branch's chat changes while working a
request the queue sent it (§chat.merge-queue/requests): commits it makes for that request, spec
drafts it only makes fit, or both. A fix is **checked** once the merge thread confirms it changes
only what was asked and decides nothing that is the user's (§chat.merge-queue/thread), comparing the
branch as approved with the branch now, each against the target from its merge base, never a plain
diff from the approved commit; one that does decide something of theirs waits for them
(§app.merge-queue/needs-user). The standing approval covers checked fixes and nothing else:
- work the user asks the chat for meanwhile isn't covered, and isn't landed by it;
- when a fix sits on top of such work (commits of the branch's own, not on the target, authored
  before the request, by author date so a rebase keeps them, counted from the newest commit the Land
  already covers: the approved commit or an earlier fix the thread checked; merging the target in
  isn't such work), the card asks the user once (§chat.merge-queue/decision): **Land** takes the
  branch at the fix's commit, that work included; **Remove from Queue** ends it;
- a fix that rewrote the branch's history (a rebase or an amend, so the approved commit isn't under
  it) is never carried, with or without other work on it: the card asks the user once, "The fix
  rewrote {branch}'s history (a rebase or an amend), so Sova can't tell the fix from other work on
  it: Land takes {branch} at {sha} as it is now", with **Land** and **Remove from Queue**. That Land
  is the user's own approval of the branch as it is, so its Landed card lists no rewritten commit as
  a fix. Sova doesn't match rewritten commits to the ones they replace (by patch id);
- a fix the merge thread finds changes more than was asked (which also catches work the user asked
  for after the request) is not covered: it waits for the user the same way, with what it changes
  beyond the request;
- a fix the merge thread can't check yet, because it isn't running (its provider down, crashed or
  stopped) or hasn't ruled on it, **waits for the merge thread**: the card reads "Waiting for the
  merge thread" (§chat.merge-queue/chat-card), and Sova hands the fix to the thread again whenever
  the thread next acts on the queue, every minute, and once more when a fix it was given has no
  ruling after 15 minutes. It lands only once the thread is back and has checked it: never
  unchecked, and it never asks the user or sends a notification for this. Remove from Queue still
  ends it.

**Drafts-only fixes make no commit.** When the chat only changes spec drafts to make them fit, its
answer says so (§chat.merge-queue/answers), and once the merge thread confirms them, Sova re-pins
the approval's drafts to exactly the drafts the thread checked. Drafts edited after the answer wait
for the user as Drafts changed (Land takes them as they are now, or Remove from Queue). A new or
changed promise, or an edit the user made, is never a fix: it waits for the user
(§app.merge-queue/after-approval, "Drafts edited after approval").

**Back in line by itself.** Once a checked fix arrives, Sova re-reads the branch before it puts the
entry back: its newest commit must be free of the things Land refuses (uncommitted files, a
temporary commit subject, nothing to land) and of what Ready to land checks itself that the queue
can't settle (the chat's own failing check run, drafts that don't fit;
§chat.worktrees/ready-to-land). A conflict with the target never holds a fix out of line: its run's
conflict path takes it (§app.merge-queue/conflicts). When it is, the entry goes back in line at that
commit, keeping its options (without review, without its specs) and its tries
(§app.merge-queue/tries), and runs every check from the start. When it isn't, it stays with the chat
and the chat is told what still blocks it. A fix that arrives while the entry's run is checking
waits until that run ends: the run is never voided for it, and if the run lands, the fix is later
work, landed only by Land Again; if the run ends any other way, the merge thread checks the fix
next. A fix that arrives while the entry waits in line takes it out of the line until the fix is
checked.

**The Landed card says what it took.** When a branch lands, its Landed card and row list the checked
fix commits that landed after the user's Land (never a rewritten one) (§chat.merge-queue/chat-card),
so the user sees everything that went in on their one Land.

**Never started by a chat.** The merge thread and the branch's chat can fix, answer and raise
questions; neither can approve, re-approve, start or move on a landing the user didn't approve. A
standing approval the user ended is never revived by a fix.

## §app.merge-queue/send-back — The queue sends a branch back by itself

Every problem that is the branch's goes back to the branch's chat **by itself**, with no button and
no wait for the user, unless it needs the user (§app.merge-queue/needs-user). The user's Land stands
meanwhile (§app.merge-queue/standing-approval).

**What goes back.** A failure proven the branch's (§app.merge-queue/blame); a conflict the merge
thread rules the chat should fix (§app.merge-queue/conflicts); a blocking review's whole report
(§app.merge-queue/review); spec drafts that don't fit at landing (§app.merge-queue/run); a setup or
install failure that is the branch's; on a project that lands on its host, host checks failing,
changes requested and conflicts on the host (§app.merge-queue/requests); and, before a
finished-but-blocked branch joins the line, what still blocks it (§app.merge-queue/approve).

**With a diagnosis.** The branch's queue card reads **Back with the chat** in place, with the try
count and what failed (§chat.merge-queue/chat-card). Each send-back reaches the chat as a request on
its merge queue chat queue (§chat.merge-queue/requests): what failed, where its log is, and the
merge thread's diagnosis when it has one (what it thinks went wrong and what to change), never more
than was asked. A failure's request waits for that diagnosis at most 5 minutes, then goes without
it; with no merge thread to call in, it goes at once. A diagnosis that comes after the request went
is sent as a request of its own and counts no try. The thread's note on the landing alone never
reaches the chat.

**A blocking review goes through the merge thread.** Its whole report goes to the merge thread first
(§chat.merge-queue/thread), and the request waits for the thread to hand it on, the same at most 5
minutes as a diagnosis, then goes by itself without a note; with no merge thread to call in, it goes
at once. Sova writes the request from the saved record of that review, never from the thread's
words: the reviewer's summary and every finding exactly as written, then the thread's note when it
gives one ("Merge thread: …"), so the thread spends nothing repeating the findings and can't drop or
soften one. A later note is a further `merge.rule` chat-fixes with its text while the entry is back
with the chat: it is kept on that review's record, shows on its card, and reaches the chat as a
short request of its own ("The merge thread adds a note on the review of {branch} at {sha}: …"),
counting no try. `merge.note` stays the landing note and never reaches the chat; a review that
waited out its 5 minutes goes without one. When the merge thread asks the user before handing the
report on, nothing goes to the chat until the user answers; their answer then goes to the chat with
the report Sova writes from the same record ("The review's findings, as the reviewer wrote them:",
then the report and the thread's note), and the review's card is Fixing again. A review whose try
would run out (the last try, or the same findings twice) waits for the user at once, with nothing
handed on. The chat shows the review's own card (§chat.merge-queue/review-card), and the queue card
reads "Back with the chat · try {n} of 3 · Review found {k} issues".

A conflict's request names the conflict as it is on the newest target at that
moment, never a conflict text from an earlier run or an older target.

**Never what isn't the branch's.** A flaky test, a failure the target shares, a test check broken on
the target, a machine or setup failure, a reviewer that fails, a run voided, and a merge thread
resolution that fails a check are never sent to the chat as the branch's: they stay with the queue
and the merge thread, or wait for the user (§app.merge-queue/blame).

## §app.merge-queue/tries — Three tries, then the user

Each standing approval has **3 tries**: each run of the entry whose failure is the branch's counts
one, when it fails, also when the merge thread then rules that it needs the user. A run voided, a
machine failure and a run whose failure wasn't the branch's count none, and neither does a conflict
that was already there when the user pressed Land (once).
- **The same failure twice** stops early: when a run fails the same way as the run before it (the
  same check and the same failing tests or files, or the same conflicting files, or the same review
  findings), the queue stops at that run, whatever tries are left. The merge thread's try-again or
  retry over a failure already counted uses no second try. Known limit: when the first run after the
  Land is voided, a conflict that was already there at the Land uses a try on the rerun.
- **Out of tries**, the entry waits for the user: its card moves down as **Out of tries** with the
  reason ("Tried 3 times: Unit tests failed each time", "Failed the same way twice: …"), **Land**
  (try again: a new entry and standing approval at the branch's newest commit with 3 new tries, the
  old entry ending "landed again by you") and **Remove from Queue**. Nothing more goes to the chat
  for it. Exactly one notification is sent (§app.notifications/delivery), and it shows in the Merge
  Queue tab's Needs you and the landing bar.
- The card shows the count while the entry is with its chat: "Back with the chat · try 2 of 3 · Unit
  tests failed" (§chat.merge-queue/chat-card).

## §app.merge-queue/needs-user — What waits for the user

Only a decision that is the user's waits for the user; everything else is settled by the merge
thread and the branch's chat by themselves.

**The user's.** Anything a person sees or does differently: wording (the words a person sees in the
product), layout, controls, defaults, notifications, noticeable timing, data kept or deleted,
permissions and safety; a change of meaning to a promise the user agreed; and anything the branch's
task never decided. A behaviour conflict includes UX and UI changes: anything that can't be resolved
without the user's input.

**Not the user's.** Regenerated files, recorded test outputs, lockfiles, list order with no visible
effect, compile fixes, internal logs, and code comments, identifiers and test names.

**Who raises it.** The merge thread rules first: it judges each conflict, failure, review finding
and fix, and may rule that it needs the user (§chat.merge-queue/thread). The branch's chat may also
raise it, by answering a request "Needs you" (§chat.merge-queue/answers). Neither can overrule the
other's raise: once either raises it, it waits for the user.

**"Can't".** A chat that answers "Can't: <why>" goes to the merge thread first, which may try one
other approach (a request to the chat with a different way, or a resolution of its own). When that
too comes back "Can't", or the thread has no other approach, or it hasn't ruled within 5 minutes (a
wait a restart doesn't cut short), it is raised to the user as "can't be settled without you". A
second "Can't" after the other approach goes straight to the user.

**A check that also fails on the target.** When whose failure it is can't be told because the check
also fails on the target alone (§app.merge-queue/blame), the merge thread rules first, within the
same 5 minutes a diagnosis waits (§app.merge-queue/send-back): from the logs it may find it the
branch's (the chat fixes it) or try again, which counts no try. Only when it doesn't settle it does
the entry wait for the user as **Can't tell whose failure · waiting for you**, with the check and
its log, and exactly one notification is sent; once raised, only the user settles it:
- **Land Anyway** lands the tested commit, noted "Landed anyway: {why}". When the target has moved
  since the run, it is rerun first, and a rerun that still can't tell lands too.
- **Try Again** puts the entry back in line at the same commit, to run every check afresh; it counts
  no try (§app.merge-queue/tries).
- **Remove from Queue** ends it (§app.merge-queue/after-approval).

Nothing goes to the branch's chat for it. The queue doesn't pause, and the branches after it go on.

**Also the user's**: a fix on top of work the user asked for, a fix the thread finds too wide
(§app.merge-queue/standing-approval; a fix the thread can't check yet waits for the thread, not the
user), drafts changed beyond fitting (§app.merge-queue/after-approval), and an entry out of tries
(§app.merge-queue/tries).

Each waits as one decision on the branch's card (§chat.merge-queue/decision), in the Merge Queue
tab's Needs you (§app.merge-queue/view) and in the landing bar
(§app.merge-queue/landing-bar-states), with exactly one notification (§app.notifications/delivery).

## §app.merge-queue/run — One branch at a time, in a merge copy

**The merge copy.** Each project's queue runs in one merge copy of the project, beside it, never
inside it: `<parent of the main checkout>/.worktrees/<repo>-merge`, marked as the queue's own. A
worktree already at that path that isn't marked as the queue's (one a person made on a branch called
"merge", say) is refused and never reset. A copy whose path would fall under Sova's state root or
any directory under `~/.pi` is refused before any git command runs, with the reason, and nothing is
blamed.

**One run per entry, its steps in order.** Each step's log starts at its first line, under the run's
own folder, so a failure at any step, the first included, has its log.
1. **Copy.** Any merge in progress is abandoned, and the copy is forced back to the target's newest
   commit: the local target under Merge locally; on a project that lands on its host (a request or a
   pushed branch, §app.merge-queue/strategies), the host's target, fetched from `origin` just before
   the run, never the local one. A fetch that fails is tried once more, then counts as a machine
   failure: the queue pauses and no branch is blamed. Its untracked files are cleared, keeping
   ignored setup outputs (dependency folders, its `.agent`), and its untracked spec drafts are
   removed; tracked drafts the target already has are kept.
2. **Merge.** The approved commit is merged onto the target's commit as a merge commit, or the merge
   thread's resolution is used. Git's recorded resolutions (rerere) are never used here, whatever
   the user's git config says. A conflict goes to the merge thread's judgement
   (§app.merge-queue/conflicts). A branch landing just its drafts may skip this step (below).
3. **Setup.** The project's setup steps (the definition's `setup`, §app.project-services/contract)
   run on the merged tree, so a branch that breaks setup is caught. Their results are reused while
   their argv and inputs are unchanged.
4. **Install.** When the branch changes one of the definition's install inputs (Sova's: the lockfile
   or `package.json`), the install runs offline.
5. **Docs.** The branch's own drafts pinned at approval, and no other, are copied into the copy and
   turned into docs there (the spec tool's `land`), as one docs commit on top of the merge. A
   branch's own drafts are the untracked ones, plus the tracked ones it added or changed since its
   merge base with the target. Tracked drafts already on the target are never landed, changed or
   deleted. A draft of the branch's own that doesn't fit sends the entry back to its chat by itself
   (§app.merge-queue/send-back): a request saying what doesn't fit and that fixing it in the drafts
   needs no commit. Once the chat answers Fixed with drafts only and the merge thread confirms they
   only fit now, Sova re-pins the approval's drafts and puts the entry back in line at the same
   commit, with no new Land (§app.merge-queue/standing-approval). What it made official (the spec
   commit, each draft's hash and the spec tool's promotion entries) is kept with the run, for the
   landing to mark the branch's drafts with (§app.merge-queue/land, §app.merge-queue/publish);
   nothing reaches the branch's folder here. The step is skipped, with its reason, for a project
   with no spec, an approval without its specs, or a branch with no drafts of its own ("no spec
   drafts of the branch's own").
6. **Checks.** The checks run on that commit, in order (§app.merge-queue/checks), with the review
   (§app.merge-queue/review) alongside them.
7. **Reruns.** A red check is rerun to place the blame (§app.merge-queue/blame), always fresh: a
   rerun reuses no earlier pass.
8. **Land** the way the approval pinned (§app.merge-queue/strategies): under Merge locally, land
   (§app.merge-queue/land), then **push** (§app.merge-queue/push); otherwise publish the branch to
   its host (§app.merge-queue/publish) and, for a request, open it (§app.merge-queue/requests). Then
   the branch's chat hears of it (§chat.merge-queue/chat-card).

Under Merge locally nothing is committed after the checks: the commit that lands is the commit that
was tested, docs included. On the host the merge with the target is only tested: what is published
is the branch with its docs commit (§app.merge-queue/publish).

**A branch landing just its drafts** moves the target only by its spec commit. Whether its code is
already there the run decides from git, in the merge copy, never from a row's label: when the approved
commit is an ancestor of the target's commit, or is exactly a landing the queue has recorded for that
branch, the merge step is skipped ("{target} already has what {sha} holds"), so a leftover merge that
would conflict is never tried, and only drafts not proved landed are carried. Otherwise it merges as
usual, and a conflict goes to the merge thread. A merge that leaves the tree equal to the target's while
carrying drafts is discarded before the docs step, so the target moves by the spec commit alone; one
carrying none stops below. A release's entry and a resolved conflict always run the merge and never
discard it.

**A landing that changes nothing stops here.** A run whose tree is the same as the target's changes
neither code nor specs. It stops there, whatever let it through: right after the merge with no drafts
to land, before setup, or after the docs step. No check or review runs, the target never moves and
nothing is published. The entry ends cancelled with "Nothing to land: everything on this branch is already on {target}.", not sent back and with nothing blamed, and its card says the same
(§chat.merge-queue/chat-card).

**One at a time.** A project's queue checks one entry at a time. The next waiting entry starts once
the previous one has landed, been sent back to its chat, waits for the user, been pushed, or has its
request opened. An entry Sova puts back in line after a checked fix
(§app.merge-queue/standing-approval) joins the end of the line, as a new approval would: an open
request never holds up the line (§app.merge-queue/requests). Every run, the copy, setup and merge
included, has a run page with each step's log (§app.merge-queue/view).

**Frozen for a release.** While a release is open (§app.release/checks), the queue runs only that
release's entries, first in line; every other entry waits with "waits for {tag} to be published or
abandoned", and a run of another branch checking when the release starts is voided and goes back to
the front of the line, never blamed.

**Held for a restart.** While the merge thread holds new starts (§app.merge-queue/empty), no waiting
entry starts, each saying "Waiting: Sova is restarting"; a run already checking finishes.

**Stopping and pausing** (§app.merge-queue/pausing): a run cut off mid-way is void and rerun, never
blamed; a paused queue starts no run until Resume.

## §app.merge-queue/pausing — Stopping and pausing the queue

**Stopping.** A run that times out, is killed, or loses its server mid-way is **void**: it is
rerun from the start for the same entry, which keeps its place, and is never blamed.

**Pausing.** The user may pause the queue and resume it at any time. The queue also pauses itself,
with the reason shown, when:
- a machine or setup failure happens twice (§app.merge-queue/blame);
- the target moved outside the queue (§app.merge-queue/master-moved);
- the main checkout has uncommitted changes when a landing must update it
  (§app.merge-queue/land);
- the reviewer fails twice (§app.merge-queue/review);
- a landing the server was stopped in left the target at neither its base nor its tested commit
  (§app.merge-queue/land);
- the target's definition doesn't parse and nothing in line fixes it (§app.merge-queue/setup).

A paused queue starts no run until **Resume**.

## §app.merge-queue/checks — What must pass

The checks come from the project's definition, read from the **target's** copy of it, never the
branch's. A branch that changes the definition is checked with the target's list, and its own
list takes effect once it lands.

**The definition's `merge` section** (§app.project-services/contract) declares the project's
required checks. Each check has an id, a label, an argument list and an optional time limit, and
may be marked rerunnable per file. The section may instead say `"checks": "none"`.

**The fallback chain**, first that holds:
1. the `merge` section's checks;
2. else the definition's test command (`test.run`), with the services it requires started in the
   copy's own slot;
3. else the queue isn't set up. It takes no approval, and the project offers its Setup chat
   (§app.merge-queue/setup).

A project that declared `"none"` lands after a clean merge, labelled **No checks declared**,
never "passed".

**Sova's required checks** are:
- typecheck;
- the unit tier;
- the integration set a landing runs (the runner's landing set, with the slow groups the change
  triggers, §app.server-runtime/test-tiers);
- the changed extensions' test suites;
- the spec replay, when the spec engine changed;
- statecharts tests, when statecharts changed;
- the build;
- the spec check and census;
- the leak scan over what would be pushed (§app.merge-queue/push).

A check the project marks optional runs only when the merge thread picks it (Sova's: `e2e`, one
build and then each picked end-to-end walkthrough, and
`integration-group`, one slow integration group per pick). A pick on a required check that would
skip itself (the
statecharts check skips unless statecharts changed) makes it run. A check with nothing to do for
this change exits clean and says why ("Spec replay · skipped: no
change to its paths"). Sova's checks are standalone scripts (`scripts/merge-checks/`).
- The changed extensions' suites come from `pi-config/README.md`'s Tests block and run at lowered
  CPU priority, so a landing never starves the live server or other chats.
- The spec replay runs one at a time on the machine, under a lock that a stale holder loses.

**Extra checks picked by blast radius.** While the entry waits, the merge thread may add checks
the change could break: statecharts tests when statecharts changed, the end-to-end
walkthroughs (a build, then the named walkthroughs) when the composer or transcript changed, the
spec replay when the spec engine changed. Each pick carries its
reason and, for a check that takes one, its selection: the slow integration group, or the
walkthroughs, it names (`merge.extend`'s `select`, §chat.merge-queue/thread). It can add checks,
never drop the required ones. Picks count only if they arrive before
the run's checks start; otherwise the run uses the required checks and their triggers alone.

**Each check is shown tagged.**
- **Required** — the project declares it.
- **Triggered** — the change's files call for it.
- **Added by merge thread** — with the thread's reason.
- **Skipped** — with the reason (a test check broken on the target among them,
  §app.merge-queue/blame).

Each also shows its time, its counts when it writes them (`SOVA_OUT`), and its log.

**Passes already had.** A test file that already passed on identical code isn't run again
(§app.server-runtime/test-reuse): Sova's type check, unit tier and integration set reuse passes from
any run on this computer, a chat's or a worker's included, and the queue's own earlier runs, so
retrying an entry on an unchanged target runs only what didn't pass.
- **A random re-check.** At each landing every test check runs a random sample of the files it
  would reuse, about 1 in 20 and at least 1 (`SOVA_REUSE_SAMPLE`, 0.05). A sampled file that fails
  is a failure like any other, blamed as usual, and the run says a reused pass didn't hold, naming
  the run it came from; every other file the check reused from that run is run again as well.
- **What it reads.** A check that reused passes reads "Passed · 412 ran, 568 already passed on
  identical code (28 re-checked)": "ran" counts the files with no earlier pass, "already passed"
  the reused ones, the re-checked among them, and "(… re-checked)" is left out when none were. Only
  a
  check whose every file was reused and none re-checked, such as the type check, reads Skipped, with
  the check's own words: "Skipped · already passed on identical code at 14:02 (feat/x's chat)". The
  check's log says which way it ran ("[passes from identical code may stand; 5% of them re-checked
  (SOVA_REUSE_SAMPLE=0.05)]" or "[fresh: every test file runs (SOVA_FRESH=1)]") and lists each
  reused file with when it passed and the run it came from (§app.merge-queue/view).
- **Always fresh.** The reruns that place the blame (§app.merge-queue/blame), every check of a
  release (§app.release/checks), and every check when the project turns reuse off (Settings →
  Merge Queue, "Reuse passes from identical code", on by default, §app.merge-queue/settings) run
  every file, with `SOVA_FRESH=1`; a setup branch's trial and `merge.setup`'s dry run
  (§app.project-setup/trial) follow the same rule. A fresh run still
  keeps its passes. Setup and install steps get neither variable.

**What a check sees.** It runs in the copy with the instance's own ports and variables, through an
allow-list that passes no chat or secret variable. It is told the run's base, tip and target, the
changed files, and the project's private-names file. When the names aren't set up yet, the leak scan
scans for secrets alone and passes with "private names not set up yet: scanned for secrets only,
and the push is held" (§app.merge-queue/push). Services a check requires start through the project
engine in the copy's own slot and ports, and stop after the checks.

**Estimates.** "Starts in" and "takes" come from the project's own run history: each check's
recent passing times, never a run that reused passes. "Starts in" adds up the time of the entries
ahead. With no timed run yet,
a row shows no estimate rather than a guess; with timed steps but no passing run, each step's
median time is summed.

## §app.merge-queue/blame — Whose failure it is

A red check is never blamed on the branch until the same check has passed on the target alone,
in the same copy. Every rerun below runs fresh (§app.merge-queue/checks).

- **Named failing test files.** The failing files are rerun alone on the merge commit. Every rerun
  of named files, there and on the target, asks for exactly those files: a check that is the
  project's test command (`test.run`, after any wrapper such as `nice`) with selection flags after
  it is rerun as that test command alone with the files, so its flags (Sova's integration check:
  `--integration --landing --base …`) never drop one; any other check gets the files after its own
  command.
  - If they pass, they're **flaky**: noted on the landing, not blocking. A rerun that didn't
    actually run them (they aren't among the files it reports it ran, or it ran no test at all)
    never makes them flaky: they go on to the target's rerun, as if they had failed again.
  - If they fail again, they're rerun on the target alone, in the same copy, with the target's own
    runner as it is, so a file only the branch's change triggers still runs there.
    - Failing there too makes them the **target's**: noted on the landing ("{check}: {files} also
      fail on {target} alone (not blocking)"), not blocking.
    - Passing there, or not existing there, makes them the **branch's**, but only once the target's
      rerun is known to have run them.
  - **Never a pass on a guess.** A failed file the target's rerun didn't actually run (a check that
    reports the test files it ran, as Sova's runner does in its `SOVA_OUT` report, and doesn't list
    it), or a target rerun that ran no test at all, tells nothing: whose failure it is **can't be
    told** ("can't tell whose failure: {check}'s {files} didn't run on {target} alone"), never
    blamed on the branch. The entry waits for the user as Can't tell whose failure, as below, unless
    another of its failures is proven the branch's, which sends it back as usual. The limit: a project whose runner doesn't report the files it ran is taken at its
    counts. A target rerun that ran nothing (no counts, or none passed or failed) can't be told; one
    that ran tests and passed makes the files the branch's, since nothing says whether the failed
    files were among them, nor whether such a runner skipped some of several named files while
    running others.
- **Failures followed by name.** When a check names failing tests but no file (a runner such as
  Kaocha), or names a file the merge doesn't have at that path (a bare file name), its failures are
  compared test by test:
  - the whole check is rerun on the merge commit; a failure that passes there is **flaky**;
  - the whole check is then rerun on the target alone. A failure the target shares is the
    **target's**, noted on the landing (a "Red on the target too" note), not blocking. A failure the
    target doesn't have, or a test that doesn't exist there, is the **branch's**, even when both
    runs fail the same number of tests.
  - Failures are compared by the test itself: the runner's verdict word (FAIL, ERROR) and the file
    and line it points at don't count, and repeats of one test count once. So a branch's new failure
    is never hidden by another test red on the target, and the target's own failing test stays the
    target's even when the branch moves its lines.
- **A whole check that names no failure** (typecheck, build, a suite's exit) is first rerun whole on
  the merge commit.
  - If it passes, it's **flaky**, as above, unless its report says the rerun ran no test at all
    (none listed as run, none passed or failed): that proves nothing, and it goes on as if it had
    failed again ("the rerun ran no test"). A check that writes no report, such as a build, is
    taken at its exit. The same holds for a failure followed by name.
  - If it fails again, it's rerun on the target alone.
    - Passing there makes it the **branch's**, unless its report says that run ran no test at all:
      then whose failure it is can't be told ("can't tell whose failure: {check} ran no test on
      {target} alone"), as below; the same holds for failures followed by name.
    - Failing there too, when both runs name their failures, they are compared test by test as
      above.
    - Failing there too when either run names nothing (the target's run included) means **whose
      failure it is can't be told**. It is never taken as the target's, and the branch is never
      blamed. The entry waits for the user as **Can't tell whose failure · waiting for you**, with
      the check and its log, as one decision with Land Anyway, Try Again and Remove from Queue
      (§app.merge-queue/needs-user). When it failed on the target, the view says the check is red
      on the target alone ("Red on {target} alone: {check}"); one that only ran no test there isn't
      called red.
- **A test check broken on the target** (its three runs fail the same way with no test run) is
  neither the branch's failure nor a Can't tell whose failure: §app.merge-queue/broken-check.
- **Setup fails** on the merged tree. It is first rerun once on the merge; passing then makes it
  **flaky**, as above. Failing again, setup is rerun on the target alone, with nothing reused.
  - If the target passes, it's the **branch's**, with the setup log.
  - If the target fails too, it's the **machine's**: the run is retried once, after 60 seconds. A
    second failure pauses the queue with the step's log. No chat is told, and the entry keeps its place.
- **The install fails.** It's the branch's, since the target alone needs no install. The message
  says to install the new package once in the project when the offline store lacks it.

**The branch's failure** goes back to its chat by itself, with the check, the test and file, the
error and the run's log (§app.merge-queue/send-back); the user's Land stands meanwhile.

## §app.merge-queue/broken-check — A test check broken on the target

A **test check** is one whose command holds the project's whole test command (`test.run`), after
any wrapper such as `nice` and with any flags after it; a project with no `test.run` has none. A test check is **broken on the target**, neither the branch's
failure nor a Can't tell whose failure, when it names no failure and its three runs (on the merge,
its rerun there, and on the target alone) each fail with the same non-zero exit code and **no test
run**.
- **No test run** means the run's report exists and counts zero tests, with no failing files or
  names and no file listed as run. A run with no report at all (a crash midway, or a runner that
  writes none) shows nothing, and stays Can't tell whose failure: real failures may be in there.
  Sova's own runner writes a zero-count report on its usage-error exits
  (§app.server-runtime/test-tiers).
- **For the branch.** The queue skips that check for this branch: its steps read Skipped, and the
  branch carries on, its other checks deciding as usual, so it lands when they pass. The queue
  doesn't pause, and nothing waits for the user.
- **The flag.** "{check} is broken on {target}: no test ran ({first line it printed})" ("exit {code}"
  in the brackets when it printed nothing but the runner's framing), so the user can start a chat
  to fix the target. It shows on the run (§app.merge-queue/view), in the Merge Queue tab's Needs
  you, in the landing's note as a Red on the target too note, on the strip's "Red on {target} alone:
  {check}", and as one push notification per check (§app.notifications/delivery). Finding it again
  in later runs updates the flag and sends no second notification.
- **When it clears.** A later run of that check that runs tests again (its step passes, or counts a
  test passed or failed) lifts the flag. A run the queue voided proves nothing either way.
- **Never on a release.** A release's run is never skipped past its gates: there the same failure
  waits on the user as Can't tell whose failure, with its gates unrun (§app.release/checks).

Any other run of it (a different exit code on one side, or one that ran a test) is blamed as above. A
check that isn't a test check (a build, a type check) failing on both sides keeps the rule above:
it waits as Can't tell whose failure, and the queue doesn't pause.

## §app.merge-queue/land — Landing exactly the tested commit

This is how a branch lands under **Merge locally** (§app.merge-queue/strategies). A project that
lands on its host never moves its target here: the host merges (§app.merge-queue/requests).

**Before it moves anything**, the landing checks:
- the run passed (flaky and target-only failures noted, not blocking), or the user answered Land
  Anyway to a failure whose owner can't be told;
- the target is still at the run's base;
- the entry is still approved at its pinned commit and drafts (as a checked fix last re-pinned
  them, §app.merge-queue/standing-approval);
- and the main checkout, when it has the target checked out, has no tracked changes and no merge
  in progress.

**Then it moves the target.** The target fast-forwards to exactly the tested commit, never to a
new merge. The intent is written first, so a server stopped mid-landing finishes it at its next
start:
- target already at the tested commit → recorded landed, once;
- target still at the base → requeued in place;
- target at neither → the queue pauses for the user to look ("recovery").

A branch never lands twice, and never half-lands.

**The main checkout follows.** The main checkout (the live tree, which has the target checked out)
is fast-forwarded with it. If it has uncommitted edits, nothing is forced and the target isn't
moved: the queue pauses with "The main checkout has uncommitted changes". On Resume, once the
checkout is clean and the target hasn't moved, the tested commit lands without a rerun.

**The drafts it landed are marked, never moved.** The branch's folder never receives the spec commit,
so once the target is at the tested commit the queue writes the landing into each draft the run made
official, in the branch folder's `draft.json`: the spec tool's own promotion entries, and a `landed`
receipt naming the spec commit, the target and the draft's hash as it landed. Nothing is deleted or
moved. A failed or voided run writes nothing, nor does a landing without its specs, and a draft
edited since its approval gets nothing: it isn't what landed. A server stopped right after the target
moved writes it when it finishes the landing at its next start. The write is atomic and takes the
draft tool's own lock; a lock another writer holds for a few seconds leaves the draft unmarked,
reading as lost, and is never taken over. `scripts/mark-landed-drafts.ts` writes the receipt for such
a draft, and for one landed before receipts existed, given its spec commit: only when the draft is
official in the spec at that commit and the commit is on the target; it changes nothing it finds
already marked, and without `--write` only says what it would do.

**After a landing**, the entry reads **Landed**, with its commit and its note
(§app.merge-queue/note). In the branch's chat its queue card moves down as **Landed**, with the
note, "1 newer commit not included" and Land Again only when the branch's newer commits hold real
work (a catch-up merge isn't that), and "Not
pushed: {why}" when the push didn't happen (§chat.merge-queue/chat-card). The landing starts no turn
there: the chat's model reads one hidden line about it at its next turn
(§chat.merge-queue/chat-turns).
Removing the worktree stays the user's choice (§chat.worktrees/cleanup).

## §app.merge-queue/push — Pushing after each landing

After each landing the queue pushes the target to its `origin` (when the project has one and its
definition doesn't turn pushing off). This is Merge locally's push (§app.merge-queue/strategies);
the push setting shows only under it. Publishing a branch to the host follows the same rules,
and more (§app.merge-queue/publish).

- **Fast-forward only, never forced.** It pushes only when the remote branch is an ancestor of the
  new commit and every first-parent commit between them was landed by the queue; otherwise "master
  has {n} commit(s) the queue didn't land …".
- **A project with no `origin`** never pushes, and nothing is held.
- **Leak scan first.** The leak scan with the private names runs over what would be pushed.
- **Release hold.** While a release is open the queue is frozen for it (§app.release/checks): only
  the release's own entries land, nothing is pushed ("held: release {tag} is open: nothing is pushed
  until it is published or abandoned"), and the target stays on the release. Publish lifts the hold
  with one atomic push of the target, the numbered tag and its channels (§app.release/publish);
  Abandon lifts it once a landed release commit's revert has landed (§app.release/abandon). No
  Pause or Resume is involved.

A push that is refused or held keeps the landing. The view's strip reads "master {sha} · not pushed:
{why}", and the next landing tries again.

**What origin has.** The strip's pushed commit is what `origin` has for the target (its
remote-tracking ref), not only what the queue last pushed itself: a project whose target matches
`origin` reads **Pushed** at that commit even before its queue has pushed anything. **No remote**
shows only for a project with no `origin`.

**Private names.** The leak scan (`scripts/merge-checks/leak-scan.mjs`) reads each project's private
names from that project's names file, never committed: `<state root>/merge-queue/<project
key>/names.json`, beside its queue. Sova's own repository falls back to
`<state root>/merge-round.json` until it has its own file. A run may name another file with
`--names` or `SOVA_LEAK_NAMES`. A file with a `privateNames` list counts as set up, even an empty
one: an empty list is an answer. It scans the range from the remote
branch to the new commit.

The merge thread asks for the names (§chat.merge-queue/thread), through the branch's chat
(§chat.merge-queue/asks). Until a project has them, its pushes
are held: landings still complete locally, the strip reads "{target} {sha} · push held: private names
not set up yet", and the thread is called in once per landing. The next landing, a Resume or a
retry pushes what was held.

## §app.merge-queue/note — A note on each landing

Each entry may carry **notes**: short free text about what is worth knowing after it lands. The
merge thread's note is one text of at most 300 characters, for example "changes server code;
Sova restarts itself once the queue is idle", or "regenerated the lockfile". Sova adds its own beside it:
- the review's notes, each whole (§app.merge-queue/review);
- flaky tests;
- tests already failing on the target;
- a test check broken on the target, with its flag line (§app.merge-queue/blame);
- what a conflict resolution did;
- "No checks declared".

- **Who writes it.** The merge thread (§chat.merge-queue/thread) writes its note with the merge
  verbs, following what the project's playbook says is worth noting. The operator may also write
  one, which stands over the thread's. For each writer the newest write wins, and an empty one
  clears it. A note may be written before or after the landing.
- **On a send-back.** The thread's diagnosis of an entry sent back to its chat is added to that
  entry's queue card (§chat.merge-queue/card-states) and goes with the request
  (§app.merge-queue/send-back); its note on a blocking review shows after the findings on that
  review's card instead (§chat.merge-queue/review-card) and reaches the chat in the same words; that
  note is its `merge.rule` chat-fixes text, never `merge.note`. Its note on the landing alone never
  reaches the chat, a blocking review's included.
- **Review notes, in full.** The branch's Landed card shows a notes-only review's findings whole, as
  a folded list (§chat.merge-queue/chat-card), and the chat's model is told them quietly in its
  hidden line, starting no turn (§chat.merge-queue/chat-turns).
- **Where it shows.** On the landed row in the Merge Queue view, the composer's worktrees control,
  the session pane's Worktrees rows, on the branch's Landed queue card, and in the hidden line its
  chat's model reads (§chat.merge-queue/chat-turns).
- **No note, no placeholder.**
- **It never gates anything.** A landing never waits for a note, and Sova reads no meaning into
  it.

## §app.merge-queue/review — The optional review step

A project may declare a **review kit** in its definition's `merge` section. It is a skill-shaped
folder (instructions and references), such as `.sova/playbooks/review/`.
It is never loaded into an ordinary chat: it isn't under the skills folders or in any skill path,
and only the review step opens it. A project with no kit has no review step.

**How it runs.** For each run, a fresh, read-only chat reviews exactly the commit being checked,
in the merge copy, alongside the checks.
- It runs on the shipped **Merge reviewer** profile: no edit tools, no shell (no bash, no background
  jobs), no web, no workers, no timers, no worktrees and no MCP servers (§app.mcp/who-gets).
- It runs in mode normal with no minor modes at all: no Delegate, Align, Spec or Vis, and no
  memory. Its mode is pinned at creation, so the default modes saved on this computer never reach
  it, now or after they change.
- It opens on the review model the project has on this computer (§app.merge-queue/models), else
  on the new-chat default.
- Each attempt is a new chat, titled "Review · {branch} · {sha}" (with " · attempt {n}" after the
  first).
- Sova writes the change under review for it before it starts: the commits and the changed paths
  with their status in one file, and the whole diff from the target commit in another, in the run's
  folder (`<run>/review/change.txt`, `change.diff`), both named in its first message and removed
  when the review step ends; when Sova can't write them the step fails as the reviewer's failure.
  It reads and searches (of pi's built-in tools it has exactly read, grep, find and ls) those and
  the files of the merge copy, which is at the commit under review, and answers with `merge.review`.
  Through `project_verbs` it only reads and answers: status, logs, doctor, the merge, release and deploy
  reads, and `merge.review`; every other verb (test, up, apply, share, `merge.try` …) is refused as
  `forbidden` before it runs. Sova knows the reviewer by its own profile record (Sova's
  `merge-reviewer`), never by its title. It posts into no topic: its `queue_push` is refused before
  anything is pushed. It runs nothing and
  writes no file. A kit therefore holds instructions and references only; it has no scripts of
  its own.
- `merge.review` checks a verdict's shape before taking it and refuses a malformed one, saying
  what is wrong, so the reviewer fixes it and answers again: its text is a one-sentence summary (at
  most 300 characters), then one line per finding, `- [kind] file:line: text` (file and line
  optional; text at most 400 characters); ok carries no finding, notes and blocking at least one.
- Each attempt's chat is recorded with its run, branch, attempt and verdict (or that it failed),
  and is reached from the Merge Queue tab, the run page and the branch's own Worktrees row
  (§app.merge-queue/chats, §chat.worktrees/pane).

**Archived once done, reliably.** The reviewer answers while its own turn is still finishing, so
once the review step is done with it Sova waits for that turn (and its workers) to end, at most 2
minutes, and stops the chat if it hasn't by then; the run goes on meanwhile. Then it archives the
chat, up to 3 tries 2 seconds apart, and logs only a final failure; a second stop does nothing,
and a failure never fails the run. 30 seconds after Sova starts, it archives the same way every
reviewer chat still open that no review is waiting on. An archived
reviewer chat stays readable from its run and the tab's Queue chats until the user clears it
(§app.merge-queue/chats); a cleared one's run keeps its verdict and findings.

**Its verdict.**
- **ok** — no findings.
- **notes** — findings, attached to the landing: whole on the Landed card, and told quietly to the
  chat's model (§app.merge-queue/note). They never go to the chat to work on.
- **blocking** — the entry doesn't land. Its whole report goes to the merge thread first, which
  hands it to the branch's chat; Sova delivers the reviewer's own words, every finding as written,
  as a request (§app.merge-queue/send-back). The chat shows a **Review found issues** card for that
  review (§chat.merge-queue/review-card), and the queue card reads **Back with the chat** and points
  to it. Once the chat's fix is checked, the entry goes back in line and is reviewed again
  (§app.merge-queue/standing-approval). The merge thread may add a note and may rule that a finding
  needs the user (§app.merge-queue/needs-user); only then does it wait for the user, as a decision.
  It can't remove, rewrite or soften a finding. Land Anyway is never offered over a review.

**When the reviewer fails.** A reviewer that errs or passes its 20-minute limit is retried once,
after 60 seconds, then the queue pauses. No chat is told. The branch is never blamed for it.

**Skipping it.** "Land without review" (or "land it, skip review") skips it for that approval
only.

Each review's report is kept whole, one record per review (§app.merge-queue/review-report).

A verdict holds at most 10 findings, each of a kind: dead code, duplication, hack, missing test,
naming, or other. The kit is never a registered skill: it has no `SKILL.md`, and it is in no skills
folder or pi setting.

Sova's own first kit is simple: an ordinary code review that the branch adds no tech debt (dead
code, duplication, hacks or workarounds left in, missing tests for new behaviour, unclear names).
It also judges the diff against the project's testing principles (the testing guide's "Writing
tests" section): a clear break is blocking, a judgement call is a note. That is the reviewer's
judgement alone; nothing checks it mechanically.

The kit can be read, never edited, from Settings → Merge Queue (**Open Folder**,
§app.merge-queue/settings), as it is on the target. Review on or off is a setting saved there
(§app.merge-queue/settings-save).

## §app.merge-queue/review-report — A review's whole report, kept

The queue keeps each review's report whole (§app.merge-queue/review): the reviewer's summary and
every finding (its kind, file and line, and text), never cut, one saved record per review, so a
later review of the same entry never overwrites an earlier one. The review card
(§chat.merge-queue/review-card), the chat's request (§app.merge-queue/send-back), the Landed card's
notes (§app.merge-queue/note) and the review step's log all hold every finding, read from that
record.

Only a one-line form is short: the review step's detail line and a flagged run's reason (200
characters), and a review note's line on the queue view's and Worktrees rows (300); a cut one ends in
"…".

Each record also keeps the merge thread's note on that review, the try it counted, the commit the
reviewer read and the target it was merged onto, so a finding's file opens on the lines it names,
and its card's state, so the review card follows its own review whatever later runs of the entry do.
A run sent back for anything else (a failed check, drafts, a conflict) leaves the last review's
record and findings as they were. An entry keeps its newest 10 such records. A blocking review on
an entry with no standing approval (a release's) is kept as its verdict only, with no record. Two
reviews count as the same findings twice when they name the same findings, whatever their order or
the case and spacing of their words (§app.merge-queue/tries).

## §app.merge-queue/conflicts — When the branch conflicts with the target

A merge that conflicts is held in the copy, and the merge thread judges each conflict. A resolution
git recorded earlier is never applied silently, so the same conflict comes back to the thread every
time. A merge that fails with no unmerged paths left still counts as a conflict when git finds
conflicts between the two sides, never as a machine failure. The thread works each conflict out in a
scratch copy Sova makes for that attempt, and Sova removes the copy once the attempt ends
(§app.merge-queue/resolve-copy).

**Before Land.** A finished branch that only conflicts with the target reads Ready to land
(§chat.worktrees/ready-to-land), and its chat is never asked to resolve the conflict itself: a note
sent before Land for other blockers says not to (§chat.worktrees/blocks-landing). After Land the
merge thread judges it, as below; the chat works on a conflict only when the thread rules that it
fixes it.

The thread rules each conflict one of three ways (`merge.resolve`,
§app.project-services/merge-verbs): no behaviour change, the chat fixes it, or the two sides want
different behaviour (it needs the user, §app.merge-queue/needs-user).

**The conflict probe leaves nothing in your folder.** The sanity probe of a resolution runs in the
entry's scratch copy (§app.merge-queue/resolve-copy), a copy of the project's files that isn't your
folder, made again if it is gone, so the project's merge drivers work and anything git leaves
behind when cut off goes with that copy, never into the main checkout. Git cut off at its time
limit gets SIGTERM, and SIGKILL only 5 s later.

**No behaviour change.** Neighbouring edits, imports, formatting, both sides extending a list: the
thread resolves the conflict itself. The approval carries, and the full checks run on the
resolution. The landing's note says what it resolved and why it was safe.

Sova still checks the resolution mechanically:
- it changes only lines inside the conflict hunks;
- it changes no mode;
- it has no rename, binary or deleted file.

Anything outside that counts as behaviour that differs.

**The chat fixes it.** A conflict the thread can't resolve safely but that needs no decision of the
user's goes back to the branch's chat by itself (§app.merge-queue/send-back), with the conflicting
files and the thread's diagnosis, as they are on the newest target. The user's Land stands, and the
chat's checked fix goes back in line by itself (§app.merge-queue/standing-approval).

**The two sides want different behaviour.** The entry waits for the user as **Behaviour differs**,
one decision (§chat.merge-queue/decision). It shows both sides in plain words, the thread's question
and choices, and the resolution there is to take when there is one:
- **Accept** takes the resolution, and the checks run;
- a choice, or the user's own answer, written in the chat's message box, goes to the branch's chat
  with the queue's held note, for the chat to resolve it that way; its fix is then covered as any
  other (§app.merge-queue/standing-approval);
- **Remove from Queue** ends it.

Accept needs a resolution commit. Only a resolution the thread called no behaviour change brings
one: its contents, each conflicted file's whole merged text, which Sova commits in the scratch copy
(§app.merge-queue/resolve-copy), or its commit. The chat fixes it and needs the user carry no
contents (refused with them), so a question the thread raises has no Accept. A no-behaviour-change
resolution that fails the mechanical check counts as behaviour that differs: it waits for the user
as Behaviour differs, raised by the queue, with Accept on that resolution, and the thread may still
bring a resolution that passes.

**A safe resolution that then fails a check** is never the branch's: the branch is not blamed and
nothing goes to its chat. The conflict is held again, in a fresh scratch copy, and the thread is
told its resolution failed and rules again: another resolution, the chat fixes it, or the user
decides. With no ruling within 20 minutes, or no thread, it waits for the user as Behaviour differs,
never the chat. A decision the thread or the chat raised is never overruled: the thread's only
ruling it takes is another question for the user.

**No thread.** Under the user's standing Land, a conflict no thread judged (none running, or no
ruling within 20 minutes) waits for the merge thread: the card reads "{reason}; waiting for the
merge thread", Sova hands it to the thread again once it runs (whenever it next acts on the queue,
or every minute), and it never goes to the chat unjudged; it waits as long as that takes, with no
notification and no question to the user. The queue moves on to the next entry meanwhile. An
approval from before the standing Land keeps the old way: the conflict goes back to the branch's
chat by itself, with the conflicting files named.

## §app.merge-queue/resolve-copy — A conflict's scratch copy, made and removed by Sova

**Sova makes it.** When a landing attempt's merge conflicts and the merge thread is called in to
judge it (§app.merge-queue/conflicts), Sova first makes a scratch copy of the project for that
attempt: beside the project, like the merge copy (§app.merge-queue/run), never inside it, at the
target's newest commit, and on no branch. The message that calls the thread in says where the copy
is. The thread reads the copy and sends each conflicted file's merged text; Sova merges the branch
into the copy, writes those files there and commits the merge as the resolution. It may have Sova
run the install and selected tests in the copy (`merge.test`, §chat.merge-queue/thread-sandbox). It never makes a worktree or a branch of its own for a conflict
(§chat.merge-queue/thread). With no thread to call in, no copy is made.

**When it can't be made** (a folder Sova didn't make is already at its place, which is left as it
is; a place under Sova's state root; git refusing), the message says why, and the thread judges from
the diff alone, with no contents and no resolution commit: the chat fixes it, or it needs the user,
so you decide.

**The fix is kept out of sight.** The resolution commit the thread names when it judges the
conflict is kept by Sova under a hidden reference of the queue's own, never as a branch, so no
branch list or screen shows it and git's own cleanup can't drop it before the run merges it.

**Never something you can land.** A scratch copy is the queue's own. It never shows, even when a
branch was switched to in it:
- on the Merge Queue tab's Ready to land list (§app.merge-queue/view), so it never
  counts in the project card's Ready to merge figure, which reads that list
  (§app.projects/home-glance);
- among the branches that get bullets: no model is asked to summarize one
  (§app.merge-queue/branch-summary);
- in any chat's Worktrees section or worktrees control, the merge thread's own included
  (§chat.worktrees/pane);
- on Clean Up Merged, in its counts or its lists, even once its folder is gone
  (§chat.worktrees/cleanup).

An old branch a merge thread made to fix a conflict, whether or not it counts as a scratch copy below,
has nothing of its own left (every commit it has but a merge is on the target), so it is off the Ready
to land list by that answer alone (§chat.worktrees/nothing-left). It stays where it is: nothing here
removes it.

An approval of one, by Land, typed words or `merge.add`, naming its branch or its folder, is
refused with nothing queued: "{branch} is a scratch copy the merge queue made to resolve a
conflict, not work of yours to land: land the branch it was made for instead"
(§app.merge-queue/approve). One on a branch with nothing left is refused as nothing to land first,
whether named by its branch or its folder. That refusal comes before the setup branch's trial gate
(§app.project-setup/land-gate), so a copy that changes the project's setup is never told to run a
trial; a branch of yours with the same change still is.

**Known by who made it, never by its name.** A worktree counts as a scratch copy when Sova made it
for an attempt (by a mark Sova keeps in git's own record of the worktree, never by its folder or
branch name), or when one of the queue's own chats (§app.merge-queue/chats) created it, whatever it
or its branch is called. One a queue chat only attached is not one. So a copy a merge thread made
itself, on a branch of its own, before Sova made them, leaves every list above as soon as this
ships. A worktree of yours is never taken for one because of its name.

**Removed when its attempt ends.** As soon as the attempt the copy was made for ends (it lands, is
sent back, is cancelled or removed from the queue, or a newer approval of the branch replaces it),
Sova removes the copy, and the kept fix with it. Nothing is kept for later: a later try of the same
attempt whose fix is gone is judged afresh, never run on the missing fix, and the branch's next
attempt starts from the newest target.

**Tidied when Sova starts.** At startup Sova also removes every scratch copy it made and every kept
fix whose attempt has ended, or that the queue no longer has a record of, so one missed while Sova
was stopped isn't left behind. It never touches a copy or a fix that an attempt still in line,
checking or waiting for you needs, and removes those once that attempt ends. Sova removes only
copies it made itself: a copy a merge thread made on a branch of its own is never removed by Sova
on its own, only hidden.

## §app.merge-queue/master-moved — The target moved outside the queue

Nothing refuses a commit made to the target from outside the queue: a hand commit, or a
Settings change the operator applied. A release isn't one: its commit lands through the queue as a
release entry (§app.release/checks). The queue notices it by comparing the target with the
landings it made. The queue's own commits never count as outside: a save from the queue's
settings (§app.merge-queue/settings-save) and,
on a project that lands on its host, the host's merges and Update Local Main
(§app.merge-queue/requests). There the queue compares the host's target with what it has
recorded, and a host merge never pauses the line.
- **With nothing in line** (no entry queued or checking), the move is simply taken and nothing
  pauses.
- **During a run**, the run is voided and the queue pauses: "master moved outside the queue ({old} →
  {new}) while {branch} was checking: that run was voided; resume once that is intended".
- **While Sova was stopped**, with entries in line, the queue starts paused the same way.
- **A settings card doesn't do this.** Its commit waits (§app.project-overseer/settings' held Apply) and
  applies at the queue's next quiet point as the queue's own move, so no run voids and the queue doesn't
  pause.

**Resume** accepts the new head, and waiting entries run on it.

Nothing inside Sova merges into the target of a project the queue serves (§app.merge-queue/served): `worktree merge` into it is refused
in a chat Sova runs (§chat.worktrees/tool), the project page's and a proposed run's Merge Branch read
Land (§app.project-overseer/coding-worktrees, §app.project-runtime/merge), and any other direct merge
of a coding branch into it, whoever asks, is refused: "{target} takes branches only through the
merge queue: Land the branch instead (nothing was merged)."

## §app.merge-queue/empty — When nothing is left to check, and holding new starts

Two things every project's queue does for its merge thread (§chat.merge-queue/thread), whatever
the project. What the thread makes of them is its playbook's business; Sova's own uses them to
restart Sova (§chat.merge-queue/sova-restart).

- **Telling the thread the queue is idle.** When the queue has nothing left to check and nothing
  running after it was busy, it tells its merge thread so, once (**Idle**). That happens when a run
  ends (it landed, was sent back to its chat, or waits for the user's decision, §app.merge-queue/needs-user) and nothing else is in line, when a cancel
  takes out the last entry in line or checking, and when a release's hold of the queue lifts at its
  Publish or Abandon. "Nothing left to check" means no entry checking or in line, and no conflict
  waiting for the thread's judgement; entries waiting for the user, on the host or sent back to
  their chat don't count. The message names the entry that changed last, the queue's newest landing
  with its commit, and the target's head. It is sent again only after the queue was busy again (or
  a release's hold lifted). Like every other call to the thread, it is fire-and-forget, never holds
  the line, and a thread that is missing or fails changes nothing. The Merge thread card reads it as
  "Told the queue is idle" (§app.merge-queue/chats).
- **Holding new starts.** `merge.hold {action: "set"}` holds the queue's new starts for 5 minutes,
  and `{action: "clear"}` lifts the hold (§app.project-services/merge-verbs). The project's merge
  thread may call it, for its own project, and the operator may too. Setting it again renews the 5
  minutes from then. While held, no waiting entry starts a run, a release's included; a run already
  checking or landing goes on to its end, and approvals are still taken into the line. Each waiting
  entry's reason says "Waiting: Sova is restarting", in the Merge Queue view and in `merge.status`
  (§app.merge-queue/view), over any other wait it had. A hold ends at the first of:
  - a clear;
  - Sova's server starting again (the hold is saved with the queue, and a start lifts it);
  - 5 minutes after it was last set.

  Then the hold's words go and waiting entries start as before. A hold is not a pause: the queue's
  state stays what it was, Resume doesn't end it, and nothing records it as the user's. `merge.pause`
  and `merge.resume` stay the user's alone (§app.merge-queue/run); the thread can call neither.

## §app.merge-queue/setup — A project not set up yet

A project on the Projects list with no checks declared and no test command isn't served by the
queue yet (§app.merge-queue/served): its chats merge plainly. A repository that isn't on the list
has no Merge Queue tab and no setup. Its Merge Queue tab says so in place of the view, explains in
plain words what the queue does and what setting it up changes, and offers **Set Up with a Chat**
(§app.merge-queue/view), which opens the project's Setup chat (§app/project-setup). There is no
form: the Setup chat is the only way to set the queue up, and there is no Initialize, Try It on
{Target} or Save Checks.

The Setup chat reads the project, asks the user what it can't find, and proposes the queue's
checks on a setup branch: listed checks, one test command with its time limit and what starts first,
or "no automated tests" (`"checks": "none"`), with the way of landing suggested from `origin`
(§app.merge-queue/strategies). It tries them for real on that branch's head in the merge copy
(§app.project-setup/trial), and the branch can be merged only once such a trial of its head passed
(§app.project-setup/land-gate). Merge Branch merges it into the target, the main folder
fast-forwarded, never forced, and refused while it has uncommitted changes
(§app.project-runtime/merge); from then on the queue serves the project, and its branches land
through it. A project with no `.sova/project.json` yet gets one on that branch.

`merge.setup` stays as the operator's own verb (§app.project-services/merge-verbs): no chat may call
it, with or without a dry run.

**A definition that doesn't parse is not "not set up".** Only a missing `.sova/project.json` (or one
declaring neither checks nor a test command) is not set up. When the target's file is there but
invalid:
- the Merge Queue view shows a **Definition invalid** chip and one banner, "This project's
  .sova/project.json doesn't parse.", with "{path}: {message}. Fix it on {target}, or land a branch
  that fixes it; nothing else lands until it parses."; what is in line still shows;
- Land stays everywhere (never Set Up Queue). The queue takes a branch whose own commit carries a
  valid definition that declares checks, checks it by that declaration, and lands it while the rest
  of the line waits; every other approval is refused with the parser's path and message
  (§app.merge-queue/approve);
- with branches in line and none that fixes it, the queue pauses ("definition-invalid"), runs
  nothing and hands nothing back; once the file is fixed, Resume runs them;
- the target still counts as managed by the queue, so a direct merge into it stays refused
  (§app.merge-queue/master-moved).

## §app.merge-queue/view — The Merge Queue view

The project page has a **Merge Queue** tab between Branches and Releases
(§app.organizations/project-page),
at `#/projects/<pid>/merge-queue`. While the queue doesn't serve the project (a definition that
doesn't parse aside, which shows its error instead), the tab shows only its head, "Merge queue"
with a **Not set up** chip, and one banner: "No merge queue settings are set up for this project",
then "Until they are, its chats merge branches into {target} themselves when you ask.", then what
the queue does, "Every branch you approve is merged onto {target} in a separate copy and checked
there; {target} then moves to exactly that commit.", and what setting it up changes, "Once it is set
up, branches land here only through the queue.", with
**Set Up with a Chat**, which opens the project's Setup chat (§app.merge-queue/setup,
§app.project-setup/start). While a setup branch is proposed or the Setup chat is working, the tab
shows the proposal, its newest trial and the chat's state in that banner's place
(§app.project-setup/proposal). For a project it serves, it
shows, top to bottom:

- **The strip**: the target at its commit, and the commit `origin` has for it
  (§app.merge-queue/push), with **Pushed**, **Not pushed** or **No remote**. On a project that
  lands on its host, the strip instead reads the host's target, and "Local main is {n} commits
  behind." with **Update Local Main** when it is, held with its reason while it can't run
  (§app.merge-queue/requests). Not pushed always carries one sentence: the queue's why ("Push
  held: private names not set up yet."), or, when the target is ahead of `origin` with no why given,
  "Not pushed yet: goes out with the next landing." When a check is red on the target alone, a line
  says so: "Red on {target} alone: {check}". Nothing about live state, and no Restart control.
- **The queue's head**: its state (Idle, Running, Paused, Not set up, Definition invalid; **Frozen
  for a
  release** while a release holds it and it isn't paused), **Queue Settings**, **Change Setup**
  (§app.project-setup/start), and **Pause Queue** or
  **Resume Queue**. A setup branch that is proposed shows under the head as its proposal
  (§app.project-setup/proposal). Open Merge Thread is not in the head: it is only in the Merge
  thread card. While a
  review runs, **Review running · {branch} · Open** sits beside them (§app.merge-queue/chats). One
  summary line
  is always shown under it: the checks, the review and its model, and how it lands ("11 checks ·
  review on, Opus 5.5 · pushes to origin"; "opens pull requests on GitHub"). **Queue Settings**
  opens Settings at its Merge Queue tab, on this project (§app.merge-queue/settings). The queue is
  described as "One branch
  at a time, in order. Each is merged onto {target} in a separate copy and checked there; {target}
  then moves to exactly that commit."
- **The Merge thread card**, under the head: the thread's state, a question waiting on the user,
  **Open Merge Thread** (the tab's only one) and **Start Fresh…**, or a line saying no thread runs
  now
  (§app.merge-queue/chats).
- **Paused**, when paused: the reason in plain words (by you; the target moved outside the queue;
  setup failed on the target itself, twice; the project folder has uncommitted edits; the reviewer
  failed twice; a landing in flight at a stop needs a look), the
  queue's own why, and Resume.
- **Frozen for a release**, while one holds the queue: "{target} is frozen for release {tag}" with
  "Other landings wait in line, and nothing is pushed, until the release is published or abandoned."
  and **Open Releases** (§app.release/tab). With nothing checking, the line reads "{n} waiting for
  release {tag}: they start once it's published or abandoned." or "Nothing being checked. A branch
  you land now waits for release {tag}."

Under them, the same whatever tab is chosen:

- **Checking now**: the branch, its commit and chat, "{target} {base} + this branch → testing
  {tip}",
  the current check ("check N of M") with a meter, when it started, how long it takes, how many
  checks the merge thread added, and **View Checks**. With nothing checking, the card says so in its
  place: "Nothing being checked", then what happens next (or the frozen line above while a release
  holds the queue).
- **Waiting**, a section that opens and closes. It starts closed each time the Merge Queue tab is
  opened or reloaded, a return from a run's page included, and the project page's **Refresh
  Project** and a page the browser restores from its back-forward cache close it too; switching
  between the status tabs, and the queue's own live updates, leave it as it is. Closed, it is one
  header line with the count and, when the queue has an estimate, when the last one should be done
  ("Waiting · 3 · the last one done in ~40 min"), set no louder than the tabs under it (their size
  and weight). With nothing in line it is a plain line reading "Waiting · 0": no toggle, nothing to
  open. Opened, it shows the entries in line order. Each entry shows its place
  as its state chip ("In line · 2"), its branch and commit, its chat, when it was approved and how
  (the Land button, or typed in its chat), its options (without review, without its specs), "starts
  in ~N min · takes ~N min", newer commits not included, and **Remove from Queue**. A release's own
  entry reads **Release** as its chip; while a release holds the queue, the other entries show no
  estimate and say why they wait. While the merge thread holds new starts
  (§app.merge-queue/empty), each waiting entry says "Waiting: Sova is restarting" instead.

**The status tabs.** Under Waiting, a strip of tabs, in this order: **Ready to land**, **Needs
you**, **With its chat**, **Waiting on GitHub** (or **Waiting on GitLab**, or **Waiting on the host** for a project that
only pushes its branches; only on a project that lands on its host, or while an entry still waits
on one, §app.merge-queue/requests), **Landed** and **Queue chats**. One tab shows at a time, under the strip; **Ready to land** is chosen
first. Each tab shows exactly the rows its section showed before the tabs (Ready to land was "Ready
to land, not approved", Landed was "Recent", Queue chats was "History"), with the same contents and
actions, nothing more and nothing fewer. A tab with nothing in it stays in the strip and, when
chosen, says in one line what the queue is doing now, then what will show there ("The queue is
idle. A branch shows here when it needs your decision."; the words: §design.copy-deck/merge-queue).
The fact is the queue's live state: "The queue is idle.", "1 being checked.", "1 being checked,
{n} waiting.", "{n} waiting.", "The queue is paused." or "The queue is paused with {n} waiting."
An empty tab's panel can be reached with the keyboard (Tab from the strip focuses it, with the focus
ring), so its line is read; a panel with rows is reached through its rows' own controls. Each tab's label carries its count ("Needs you ·
2"), but for Landed, which has none; Needs you's counts its rows, the broken-check rows included,
and is in the warn colour while it is above 0. Landed shows at most the newest 20.

**The tab is in the address.** The chosen tab is part of the page's address, so a reload, Back and
Forward, and a link copied from the page keep it: Ready to land is the plain
`#/projects/<pid>/merge-queue`, and each other tab adds its word (`…/merge-queue/needs-you`,
`with-its-chat`, `waiting-on-host`, `landed`, `queue-chats`). A run opened from a tab keeps the tab
in its address (`…/merge-queue/needs-you/<run>`; from Ready to land, `…/merge-queue/<run>`), and
its **Back to Queue** returns there. Coming back from a run's page (Back to Queue, the path's
"Merge queue" or the browser's Back) scrolls the page so the tab strip is at its top, where the
rows the run was opened from are; any other visit opens at the top of the page. Opening the Merge
Queue tab from anywhere else (the project page's tab strip, the project card, the landing bar's
Queue, a chat's View Merge Queue) opens **Ready to land**. An address naming a tab the project
doesn't show (Waiting on GitHub on a project that lands locally) shows Ready to land. A typed or
pasted `…/merge-queue/ready` (and `…/merge-queue/ready/<run>`) opens Ready to land (or that run),
and the address is put back as the plain one in place, adding no history entry.

**Switching tabs never moves the strip.** Picking a tab whose rows are shorter than the one shown
leaves the strip where it was on the page: the panel keeps at least the tallest height it has had
since the tab was opened.

**On narrow room** (below), the strip keeps every tab on one line and scrolls sideways, fading at an
edge while tabs are hidden past it, as every tab strip does (§design/deviations); the tab chosen is
scrolled into view, clear of that fade.

The tabs' rows:

- **Ready to land**: the project's worktree branches with something left to land
  (§chat.worktrees/nothing-left), a clean tree, none of the queue's scratch copies
  (§app.merge-queue/resolve-copy), a head that isn't a temporary commit, and no standing approval (in
  line, checking, with its chat or waiting for the user) and no landing at that commit (a row with only
  drafts left is listed whatever its head's subject says, and though it landed at that commit; a branch removed from the queue shows here again;
  the list is read at most every 15 seconds, so that row may take that long to appear). Land on a
  row whose chip says it is blocked for something its chat can fix approves it as **Approved ·
  waiting for a fix** (§app.merge-queue/approve).
  Each shows its chat and branch, then its chip, commit and "{n} commits ahead · +{a} −{d} ·
  {when}",
  and **Land** with the same menu as the modal's (Land Without Review, Land Without Its Specs…).
  {when} is when the branch last changed, its head commit's committer date, said relative to now
  ("2h ago", "yesterday", "3d ago", then the day, "Nov 2", after a week), with the full date and
  time
  as its hover and for a screen reader. The chip is the readiness reading
  (§chat.worktrees/readiness)
  that the row's chat holds for the branch's worktree (a worker's chat: its own, then its top
  chat's),
  with its reason as its hover: **Ready to land** or **Ready to merge** or **Waiting for your OK**
  (success), **Landing specs** (info, or warn when it can't land them), **In progress** (neutral),
  **Conflicts with {target}** or **Blocked** or **Stale** (warn), **Drafts to land** (info). A branch
  with
  no known chat shows a neutral **No chat**; one whose chat holds no reading of it (the chat works
  in
  it without tracking it, or isn't among the chats Sova lists) a neutral **No reading**. The chip
  reports the branch's true state and the list doesn't wait on it. This list is wider than Ready
  (§chat.worktrees/ready-to-land): a row of real work stays on it, with Land and its menu, whatever the
  chip says, and only having nothing left takes a branch off it and out of every count that reads it. A
  row with only drafts left says "{n} spec drafts" where the commits would be, and its menu has no Land
  Without Its Specs….
  Land here asks once as the modal's does, its confirmation right-aligned under the row
  (§chat.composer/land-confirm), and only Land {n} Commits queues the branch.
  Land there names no chat: the queue records the branch's owner by the same rule the row shows
  (§app.merge-queue/owner), so the chat the row shows is the one the queue records and tells.
- **Needs you**: entries waiting for the user's decision (§app.merge-queue/needs-user), in full
  words, each with Remove from Queue. No row here has a text box: a decision answered in words
  links to the branch's chat, where the user answers in its message box (§chat.merge-queue/decision):
  - **Behaviour differs · waiting for you**, with the target's side, the branch's side, the merge
    thread's question and proposal, Accept when it proposed a resolution, and **Answer in Chat**;
  - **Needs you · {branch}**, a question the merge thread or the chat raised, with its choices
    ("Choices: a · b"), "The merge queue's note to the chat isn't sent yet: it goes with your
    answer." and **Answer in Chat** ("can't be settled without you" when it came from a chat's "Can't");
  - **Can't tell whose failure · waiting for you**, with the check that failed on both sides, its
    log, and Land Anyway and Try Again (§app.merge-queue/blame);
  - **Out of tries**, with the reason and Land (§app.merge-queue/tries);
  - **A fix needs your OK**, a fix on top of your own work or too wide, with Land
    (§app.merge-queue/standing-approval);
  - **Drafts changed since you approved**, with Land and Remove from Queue;
  - **Review the request**, a request's words waiting for you before it goes to the host, with
    Review Request (§app.merge-queue/requests);
  - a **Conflict** while it is being judged;
  - and, at the top, before the entries and apart from them, one row per test check broken on the
    target (§app.merge-queue/blame), which counts in the tab's label even with no entry: a **Broken
    on {target}** chip and when it was first found, "{check} is broken on {target}: no test ran
    ({first line})", "Every branch skips it until it's fixed, and lands without it. Start a chat in
    this project to fix it on {target}.", and **View the Log**, which opens the run that found it.
    It asks nothing and holds nothing up.
- **With its chat**: entries whose standing approval stands while their chat fixes something
  (§app.merge-queue/standing-approval), and branches **Approved · waiting for a fix**
  (§app.merge-queue/approve), each with its state in the card's words ("Back with the chat · try 2
  of 3 · Unit tests failed", "Waiting for the merge thread", "Paused: you stopped the chat"), **See
  Why** and **Remove from Queue**,
  and never Land, a re-land or a send-back button. The row reads "Your Land stands: it goes back in
  line by itself once its chat's fix is checked." An entry leaves this list once it goes back in
  line, lands, waits for the user (it moves to Needs you), is removed, or its branch is deleted or
  its worktree folder removed.
- **Waiting on GitHub** (or GitLab): entries whose request is open, each with its request and its
  host state in the request's words (§app.merge-queue/requests), its chat as a link, **Open on
  GitHub** (or GitLab), and **Land Again** where it applies; host checks failing, changes requested
  and conflicts read "Back with the chat" while its chat fixes them (§app.merge-queue/requests).
  Opening the Merge Queue tab checks them on the host.
- **Landed**: landings, each with a **Landed** chip, "Landed as {sha} · {when} · pushed" (or "not
  pushed: {why}"), "No checks
  declared" when so, every note, and **View Checks**. A request the host merged has, in place of
  Landed, a **Merged on GitHub** (or **Merged on GitLab**) chip, then "as {sha} · {when}", and never
  says pushed or not pushed; a pushed branch reads "Pushed {branch} at {sha}".
- **Queue chats**: every chat the queue has had for the project, each opening its chat,
  with **Clear** and **Clear All…** (§app.merge-queue/chats). Each run's row in Checking now, Needs
  you, With its chat and Landed also shows its review with **Open Reviewer Chat**.

**Every row's chat.** Every row of Checking now, Waiting, Needs you, With its chat, Landed and Ready to
land names its chat by title: a row in the line or landed names the chat its entry recorded; a
Ready row names the branch's owner (§app.merge-queue/owner). The row's top line is that chat's
title first, then the branch name in small mono, then an "archived" tag when the chat is archived;
its second line is its state chip, its short commit and "{n} commits ahead · +{a} −{d}" (or the
row's own facts; a Ready row's end with " · {when}", above); its branch summary sits under that
(§app.merge-queue/branch-summary). A row
names no worktree folder and carries no "Chat" label. A click or tap anywhere on the row
outside its buttons, links and menus opens that chat; a click with a modifier key, or one that ends
a text selection, does nothing. The chat's title is also a real link to it, so it opens in a new
tab too, and it is never wrapped around the row's buttons. The chat opens whatever form its
recorded id takes (the link reaches the chat, never an empty "not found" view). An archived chat
still opens, with its "archived" tag. A row with no known chat leads with "No chat found for this
worktree" in place of the title, opens nothing when tapped, and keeps its buttons. A row whose chat
is a worker
never uses the worker's first message (its instructions) as a title: it reads "Worker {name} of
“{chat title}”" ("Worker of “…”" with no name), naming and linking the chat that runs it, up to the
top chat when workers run workers; when no such chat is known it reads "A worker's chat" and links
the worker. The run page names it the same way.

**Review Changes on every row.** Every row of those sections has **Review Changes**, which opens
the changes viewer (§chat.changes/viewer) over the tab: a dialog, a full-height sheet on a phone,
closed with Close, Esc or the scrim, focus back on the button. It needs no chat, so a row with no
known chat has it too; when the row's chat is known, its turns become the viewer's steps, else the
viewer shows the files alone. What it compares, read by the server from the queue's own records
(§chat.changes/endpoint):
- **Ready to land**: the branch as it is now against its merge-base with the target it lands on;
  uncommitted files in its worktree, if any appeared since the row was listed, are included and
  marked as uncommitted;
- **Checking now, Waiting, Needs you and With its chat**: the commit that was approved (with any
  checked fix since, §app.merge-queue/standing-approval), never a newer
  one on the branch, against its merge-base with the target;
- **Landed**: what that landing brought in, from the target before it to the landed commit.

**Its layout follows the queue's own room**, the width the project page gives the tab, never the
screen's: a phone, the Fold with the sidebar open and a narrow window read alike, and opening or
closing the sidebar can change it.
- **Under about 600px of room** the tab loses its outer card frame, and the strip, the Merge thread
  card, Checking now, Waiting, the tabs' lists and the run page's cards run edge to edge, split by hairlines, with
  12px side padding. Banners stay boxed, their button under their words. Each row stacks: the
  chat's title and the branch, wrapping anywhere; a facts line led by the state chip, then the
  commit and "{n} commits ahead · +{a} −{d}" (or the row's own facts), wrapping; the summary's
  bullets, wrapping; and the row's actions
  (Review Changes, Land ▾ or the row's other actions) on their own line under it, Review Changes at
  the line's left and the row's other actions at its right, each button the same size as with room.
  A card's head (Checking now, the Merge thread, Queue chats) puts its buttons on their own line
  under its title. Nothing scrolls sideways at 360px but the strip of status tabs, which keeps its
  tabs on one line and scrolls by itself, never the page.
- **With room**, every row of the tab alike (Checking now, Waiting, Ready to land, Needs you, With its
  chat, Landed and Queue chats) puts its actions in a column at its top right,
  each button at its own width; an open Land confirmation spans the row, at its right. A card's head
  keeps its title and its buttons on one line.

Where a row's actions sit is decided by the room alone, never by how long the row's words are.
**Buttons**: every group of buttons on the tab, the run page and the Merge thread card has one even
gap between buttons and holds them on one centre line, wrapping as a group; a borderless button that
starts a line lines up with the words above it. On a touch screen the head's, the Merge thread
card's, banners', Queue chats' and the run page's buttons are 44px tall; a row's own actions keep
Land's size. Nothing is offered only on hover.

**The run page** (`…/merge-queue/<run>`) shows:
- its path, "Merge queue › {branch}", led by a back arrow named **Back to Queue** that opens the
  tab on the status tab the run was opened from (44px square on a touch screen);
- the branch and its verdict, the base, the branch's commit and the tested commit, when it started
  and how long it took, its chat, and how it was approved;
- one action row: **View Logs** (outlined, opening full width below the row: every step's log, in
  order, from the copy's first line) and **Open Merge Thread** (borderless), on one line at every
  width; Back to Queue is the path's arrow, never a third action;
- its review, when it has one: each attempt's reviewer chat, as on the rows
  (§app.merge-queue/chats);
- "Nothing has merged from this run. {target} moves only once every check passes." while it runs,
  waits or conflicts, except on a run whose owner can't be told, where its own banner says it once;
- a verdict in plain words: the branch broke a check (back with its chat, its try count); the merge
  thread's resolution failed one (back to the merge thread, the branch not blamed); red on the
  target too, or flaky (noted, not blocking); can't tell
  whose failure it is ("Can't tell whose failure · waiting for you", with the checks that failed
  on both sides, "Nobody is blamed. Land Anyway lands the commit it tested; Try Again checks it
  afresh.", Land Anyway, Try Again and Remove from Queue); a test check broken on the target (a warning banner per
  such check, "{check} is broken on {target}: no test ran ({first line})", with "Skipped for this
  branch; it doesn't block. Every branch skips it until it's fixed on {target}: start a chat to fix
  it
  there.", beside the run's own verdict, §app.merge-queue/blame); stopped at a
  step, not the branch's fault (retried once, then paused, no chat told); stopped before it
  finished (nothing blamed); or passed, the target moved to exactly the tested commit;
- for a red run, a "Whose failure is it?" block (machine or setup, already failing on the target,
  flaky), drawn from the reruns (§app.merge-queue/blame);
- **Checks and why**, its legend under the title: every step with its tag and reason, its failures,
  time and counts, and its log. Each row reads, in this order: its status mark, its name (its tag,
  such as **Required**, held to the name's last word: only the name wraps, and the tag drops under
  it
  only when that word and the tag can't share a line at all) with its
  description under it (the test counts there too, "11496 passed · 5 skipped", a failed count in
  red; a check that reused passes says so, "412 ran, 568 already passed on identical code (28
  re-checked)", and its **Log** lists the reused files with the run each came from,
  §app.merge-queue/checks), its time in a fixed column aligned right, then **Log**, in the same
  place on every row. A
  description shows at most 2 lines and ends in "…" when cut; a path in it that starts at the home
  folder shows it as `~/` (only where the path starts, never the same folder inside another path),
  and a commit is in mono. The marks: a check for passed, a cross for failed, a clock for running, a
  dash for skipped (or setup unchanged since the last run), an empty ring for waiting. A running
  check's time counts up from its start; a waiting or skipped one shows no time, and a skipped one
  no
  "0 passed".

**Open logs stay open.** A log opened on the run page (a check's **Log**, or View Logs) stays open
until the user closes it. Re-reading the run (every 3 s while it runs, and on each queue change)
never closes it, and never moves the keyboard focus or the log's scroll. The open log of a check
still running follows it: it is read again about every 3 s and stops updating once the check ends.
Whether it follows its bottom is decided when it is opened, not when the page loaded: a check that
was waiting when the page loaded and is running when its log is opened follows. A log short enough
to fit its panel counts as at its bottom, and keeps following as it grows past it. Scrolling up
stops following; scrolling back to the end resumes it.

Every action here is a catalogue command: Land, Remove from Queue,
Pause, Resume, Accept, Land Anyway, Try Again, Start Fresh, Clear and Clear All over
the merge verbs (§app.project-services/merge-verbs), Update Local Main, Publish and a
branch summary's Try Again over the queue's own routes, which the merge thread can't call. Queue
Settings and Open on GitHub only
open a place. The view follows the queue live,
from the session feed's merge-queue frames, at desktop and phone widths. The same frames, every
served
project's, also drive the sidebar's landing bar, which opens this tab at an entry for the actions it
doesn't take in place (§app.merge-queue/landing-bar).

## §app.merge-queue/run-logs — Run logs: packed as they age, cleaned only by you

Each run keeps its step logs and the spec drafts snapshot it carried (copied in at the run's start,
read only during the run) in its folder on this computer. Sova packs a finished run's logs on its
own and never deletes them: once a run ended at least a day ago, each step log (and its counts
file) is gzipped in place and the drafts snapshot is packed into one archive in the run's folder;
the run's record (`run.json`) and its small records stay as they are. A run in use is never
touched: the queue's current run, a run an entry still checking, still open or sent back to fix
names, a run whose record says it is running, and one with no recorded end. The sweep runs 1 minute after the queue starts, then
hourly, one at a time.

- **A packed log opens as before**: `merge.logs` and the run page's logs (§app.merge-queue/view)
  read it the same way, its tail and line count included.
- **Run logs, in the current merge thread's chat only.** The chat that is the project's current
  merge thread, and no other (an earlier thread's chat, a peer's session), shows a `Run logs` chip
  with the size in mono in its head, in the full chat head and the workspace pane head alike (the
  label hides on a narrow pane; its accessible name still reads "Run logs {size}" there). It opens a popover: "{size} in {n} runs, {m} packed." and "A
  finished run's logs are packed a day after it ends. Nothing is deleted unless you clean.", with
  `Clean Logs…` (destructive; disabled, with the reason, when nothing is cleanable).
- **Clean Logs** confirms first: "Deletes the logs of {n} runs ({size}). The newest 10 runs, the run
  checking now, and the runs of entries still open or sent back to fix keep theirs. Every run keeps
  its record, verdict, and steps." (`Clean Logs`, `Cancel`). The confirmation replaces the
  popover's first step in place, by mouse or keyboard, and focus moves to its `Cancel`. `Cancel` goes back to the first step with focus on
  `Clean Logs…`; Escape closes the popover from either step and gives focus back to the chip; focus
  moving outside the chip and its popover closes it, and a click on the popover's own text (not a
  button) keeps it open at the step it shows. It takes from each cleanable run (a
  finished run older than the newest 10, not checking, named by no entry still open or sent back to
  fix) everything in its folder but `run.json`, `changed.txt` and `docs-landed.json`: step logs,
  the drafts snapshot or its archive, the run's service data. Toast, shown once (a second clean
  replaces it): "Cleaned the logs of {n} runs: {size} freed." Each cleaned run is marked so, and its steps' logs read one line, "(log cleaned)",
  in `merge.logs` and on the run page.
- **Only your click cleans.** Any other caller is refused (`forbidden`: "A chat can't clean the merge
  queue's run logs: use Clean Logs in the merge thread's chat yourself."); a clean without `confirm`
  answers `needs-confirm` (409).
- **Commands** (§app/commands): `project.merge-queue.run-logs` (looks, `GET
  /api/merge-queue/run-logs?project=|session=`) and `project.merge-queue.run-logs.clean` (changes,
  `POST /api/merge-queue/run-logs/clean {project, confirm}`).

## §app.merge-queue/branch-summary — What a branch does, in a few bullets

**Each branch row of a project the merge queue serves (§app.merge-queue/served) says what the branch
does in up to 5 short bullets, written in the background for every branch on the Merge Queue tab's Ready
to land list (§app.merge-queue/view) once its chat is idle, and for every branch approved at a
commit.** A repository the queue doesn't serve gets no bullets.

- **What they say.** Plain words, most important first: what the branch adds, changes or fixes. They
  never name files or commit ids. A small branch may get 1 or 2.
- **Who writes them.** The summary-line model of Settings → Summaries
  (§app.settings-dialog/summaries): its Primary, then its Fallback when the Primary can't run or
  gives nothing usable; never the Session titles model. Settings → Models' switch applies as it does
  to the summary line: a model turned off there is skipped.
- **When.** Every branch on the Ready to land list gets bullets for its commit once
  the chat that owns it (§app.merge-queue/owner) is idle; a branch with no known chat, or whose chat
  is archived, counts as idle. Not at every commit: while its chat works, the row keeps the bullets
  it has. A sweep in the background does it, whether or not anyone is looking: about 30 seconds
  after Sova starts, then at least every 5 minutes, and within about a minute of the target moving
  or of a branch's chat being read idle. Its first run after Sova starts writes every branch already
  on the list, those with no chat included. A branch that reads Ready to land
  (§chat.worktrees/ready-to-land) or is approved at a commit gets bullets for that commit too.
  Writes go one at a time on this computer, whatever started them and across every project; an
  approved branch's and a Try Again go ahead of the ones waiting (the one being written finishes
  first), and a waiting one already reads "Summarizing…". A commit is written at most once at a
  time. Opening or refreshing a view never starts a write, and a finished write doesn't start the
  next one by being shown. Once written, every view shows them at once.
- **What they're written from.** The branch's commit messages and the parts it changed, with lines
  added and removed, against the target; never the code change itself. On a large branch the newest
  messages are read in full and older ones by their subject only, and the list of parts is capped,
  so a summary costs about the same however large the branch is; when commits were left out, the ask
  says so ("the newest 200 of {n} commits").
- **Where.** Always shown, with no switch to hide them, under the row's facts line: on every row of
  a branch not yet landed on the Merge Queue tab (Checking now, Waiting, and the Ready to land,
  Needs you and With its chat tabs; §app.merge-queue/view) and on the Worktrees rows, in the composer's modal and the
  session pane (§chat.composer/worktrees-control, §chat.worktrees/pane). A landed row on the Landed tab
  keeps the bullets it had. On a phone they wrap; nothing scrolls sideways.
- **While writing**, the row says "Summarizing…", busy to a screen reader.
- **A newer commit.** The bullets of an earlier commit stay up, marked "From an earlier commit",
  until new ones are written for the new commit.
- **When it fails**, the row says "Couldn't summarize this branch" with **Try Again**, which writes
  it again for the same commit. Try Again shows only after a failure: a summary that worked offers
  no rewrite. Nothing else on the row changes, and Land works as before. Try Again is a catalogue
  command (§app/commands). A failure because no model answered (none could run or was signed in, a
  timeout, the model service failing) is tried once more by the sweep, by itself, about 10 minutes
  later, while the branch is still on the list with its chat idle; a failure whose models answered
  with nothing usable (a reply that isn't bullets) never is. After that one retry it waits for Try
  Again.
- **Kept** per project and commit on this computer, so a restart doesn't write them again; a failure
  is kept too, with whether its retry was spent, and waits as above. Once the branch has landed or
  is gone they are dropped, unless a queue row still shows them; a live branch keeps only its newest
  few.
- **Spend.** Each write's calls are recorded in the usage ledger (§app.insights/usage-ledger) as
  one-shots under a purpose of their own, `git-branch-summary`, with the project set, so they are
  never counted as a conversation's `branch-summary`.

## §app.merge-queue/landing-bar — The landing bar in the sidebar foot

While a merge queue or an open release on **this computer** has something to show, the sidebar foot
carries one **landing bar**, directly above its other rows (above the host filter row while the mesh
is on, else above Usage, §app.insights/sidebar-foot). With nothing to show it is not drawn at all, and
the foot is as before. It covers this computer's projects only, never a peer's.

```html
<!-- in .sidebar-foot, before the host filter row; one 44px row, the same at every width -->
<div class="landing-bar landing-bar-landing">
  <button type="button" class="landing-face landing-row" aria-expanded="false" aria-haspopup="dialog"
          aria-label="Landing feat/mesh-bar. step 6 of 13 · test:int · ~3 min left. 2 in line">
    <span class="landing-icon landing-tone-accent" aria-hidden="true">…</span> <!-- status icon, tinted by tone: carries the meaning -->
    <span class="landing-lines">
      <span class="landing-line1">
        <span class="landing-title">Landing feat/mesh-bar</span>   <!-- semibold, one line, ellipsis -->
        <span class="landing-sub">step 6 of 13 · test:int · ~3 min left</span> <!-- muted, inline after "· ", ellipsis; yields first -->
        <span class="chip landing-count" aria-hidden="true">+2</span> <!-- at most one short count, never cut -->
      </span>
      <span class="landing-track-row" aria-hidden="true"><span class="landing-track"> <!-- a thin line under the words, inside the row -->
        <span class="landing-seg landing-seg-passed"></span> … <span class="landing-seg landing-seg-running"></span> …
      </span></span>
    </span>
    <span class="landing-chevron" aria-hidden="true">…</span>     <!-- turns over while the detail is open -->
  </button>
</div>
```

**What it shows.** The bar is **one size everywhere**: a single 44px row, never taller and never
wrapping. In it, left to right: a **status icon** tinted by the bar's tone, the **title**, and a
short **sub line** inline after it, each on one line and cut off with an ellipsis when they don't
fit (the sub line yields before the title); after them, at most one short **count**, and a
**chevron** at the row's end. Under the words, inside the same row, runs the **step track** as a
thin line: one segment per step, coloured passed, running, failed, waiting, skipped (a short dash) or held. The
row never carries a note or a reason in full: those are cut short, and the status icon carries the
meaning (done, running, waiting for you, failed, paused). The count is its only chip: never a
"needs you" chip, never a review marker.

**The count.** At most one, short: "+{n}", the branches waiting in line behind a running landing
(or a paused queue), or, during a release, the landings waiting for it; when several entries wait
for you with nothing running, the others beyond the one the bar names. With none there is no count.
The words are cut before the count, so the count always shows whole. The accessible name says the
title, the sub line and the count in words ("2 in line", "2 waiting for the release", "1 more needs
you"); the sheet's and the floating detail's heads show the count in those words too.

**Hover card.** Hovering the bar with a mouse, or a press-and-hold on touch, shows a small floating
card above the bar with a bit more: the full title, the sub line, the current step and how long it
has run, the review's state (a landing, or a release's gating checks), the next branch in line (when
one waits), the count in words, and the note or reason cut to about two lines. A mouse shows it after
resting on the bar a moment; a hold, after about half a second. Its look is the
card over the token chart's (§app.insights/velocity-scrub): surface fill, large radius, raised
shadow, a neutral edge, never the accent; it stays inside the window, never takes the pointer and is
hidden from assistive tech (the bar's accessible name and the detail carry the same words). Leaving
the bar, lifting the finger, Escape or opening the detail hides it; a hold that shows it never opens
the detail.

**The detail.** A click (or Enter) opens the full detail as a floating panel over the session list,
directly above the bar; the sidebar and its rows never move.

Its states are §app.merge-queue/landing-bar-states; its detail, its actions and its phone and
collapsed forms are §app.merge-queue/landing-bar-detail.

**Which state wins.** One bar shows one state, in this order: a release that needs you; a landing
that needs you (only while nothing runs; while a landing runs it shows only in the detail); a release
in progress; a running landing; a paused queue; then just landed or published.

**About a minute.** Just landed, Pull request opened, Pushed and Published each stay **about a minute**,
for every landing and release, a landing with a note too; then the bar goes. They go at once when the
project's next run starts. A landing or release once shown that way is remembered by this browser, so
a reload doesn't show it again.

**Several projects.** One bar, for the project whose state ranks first by the order above. The other
busy projects add no count to the row: the hover card says "{n} more project busy" ("{n} more
projects busy"), and the detail lists every busy project, one line each.

**Right at page open.** The bar is right the moment the page opens and after every reconnect: the page
reads one small summary of every served project's queue and open release from the server (catalogue
entry `project.merge-queue.landing-summary`, `GET /api/merge-queue/landing-summary`, effect `looks`),
then follows the session feed's merge-queue and release frames for every project
(§app.merge-queue/view, §app.release/tab).

## §app.merge-queue/landing-bar-states — What the landing bar says

Each state the landing bar (§app.merge-queue/landing-bar) can show, in the Merge Queue tab's and the
Releases tab's own words (§app.merge-queue/view, §app.release/tab). The row shows each state's title
and a short sub line, cut with an ellipsis where they don't fit; a note or reason is cut short there,
shows to about two lines in the hover card and in full in the detail:

- **Landing** (a run checking): "Landing {branch}", sub line "step {N} of {M} · {step} · ~{n} min
  left" ("left" only when the queue has an estimate, never a negative one), {N} the running step's
  place on the track and {M} the number of segments the track draws; the hover card and the detail
  use the same numbers. The count "+{n}" while others wait in line. The track has one segment per
  check and per fixed step of the run (copy, merge, setup, install, docs, land, main checkout, push),
  in their order. Every step keeps its place for every project, and none is treated specially: a
  step that didn't run (Install dependencies, Spec docs, or Push with no remote) is drawn as a short
  dash, never like a step still to come. A check that is rerun (on the tip or on the target alone,
  §app.merge-queue/blame) pulses its own segment again and never adds one; a check the merge thread
  adds mid-run adds its segment and {M} grows by one. The review runs beside the checks, so it is never a segment; its state is in
  the detail. A project that opens a pull or merge request, or only pushes the
  branch, shows its own steps the same way (§app.merge-queue/strategies).
- **Needs you** (warn tone): an entry waiting for the user's decision (Behaviour differs, a
  question the merge thread or the chat raised, Can't tell whose failure, Out of tries, a fix that
  needs your OK, Drafts changed since you approved, Review the request; §app.merge-queue/needs-user),
  its branch and one line of why, in the tab's words. An entry back with its chat is never one. A conflict the merge thread is judging is not one: at most the detail
  says "{branch} · conflict being judged". While a landing runs, a waiting entry does not take the bar
  and adds nothing to it (no chip, no count): it appears only in the detail. With nothing running,
  the waiting entry takes the bar, with the warn icon.
- **Just landed** (success tone): "Landed {branch}", "as {sha} · pushed" ("as {sha} · pushing" until the
  push is known, "as {sha} · on this machine only" with no remote) or, in warn tone, "as {sha} · not
  pushed: {why}", and the merge thread's note (cut short in the row, word for word in the detail). A request project reads "Pull request opened ·
  #{n}" (or the merge request's words, §app.merge-queue/requests), a push-only one "Pushed {branch}".
  A request that is open and waiting on its host never keeps the bar.
- **Paused** (warn tone, the stop icon): the pause's title in the tab's plain words, its reason as the
  sub line ("Nothing in line" or "{n} branches in line" when it gives none), with **Resume Queue** and
  **Queue** in the detail. It shows the whole time the queue is paused, even with nothing in line. A queue whose settings don't
  read says "Queue settings are broken: nothing runs until they are fixed" (error tone), with
  Queue only and no Resume.
- **Releasing**: "Releasing {tag}" ("Releasing a new version" before a version is picked), sub line
  "Step {i} of {n} · {label}", and while the gating checks run, the queue run's current step after it,
  without a count of its own ("Step 4 of 7 · Gating checks · build · ~3 min left"): the track shows the
  release's steps, so the run's own count would match nothing on screen. The track has one segment per release step in plan order, a held step in warn; withdraw steps
  never show. The release and the landings it freezes are **one bar**: the gating checks segment
  carries the queue run's progress, and the count "+{n}" is the landings frozen until it ends
  (§app.release/checks).
- **Release needs you** (warn tone): "Ready to publish · {tag}"; "{step} is held for you" with
  **Continue** in the detail; "{step} failed" with **Retry Step** in the detail; "Publish failed: {why}"; "No word from the release
  chat for {n} min"; and while the release power waits, "Publishes in {m:ss}" (§app.release/quiet,
  §app.release/power).
- **Published** (success tone): "Published {tag}", "pushed to origin" or "on this machine only"; while
  its after-publish steps run, "Published, finishing · {step}"; an after step that fails is Release
  needs you.

## §app.merge-queue/landing-bar-detail — The landing bar's detail, actions, phone and spine forms

**The detail.** A click on the landing bar (§app.merge-queue/landing-bar), or Enter, opens its full
detail as a **floating panel** over the session list, directly above the bar. The sidebar never moves:
nothing in it is pushed, resized or scrolled by the panel. A second click on the bar, Escape or a
click anywhere outside the panel closes it; after Escape, focus returns to the bar. Its head repeats
the full title, sub line and count in words. The panel holds everything
the row cuts short: the full title and sub line, the full note or reason, and each entry waiting for
you while a landing runs (its branch and why, with a link that opens the Merge Queue tab at it),
which shows nowhere else in the bar. For a landing: "{target} {base} + branch →
{tip}", the current step and how long it has run, the review's state (with its attempt, and a link to
the reviewer's chat while it runs), the next three branches in line with when each should start,
**Branch Chat**, **Checks** (the run page,
`#/projects/<pid>/merge-queue/<run>`) and **Queue** (`#/projects/<pid>/merge-queue`); a request just
opened adds **On GitHub** (or **On GitLab**), the request's page. For a
release: its base and commit, the release chat's last report, each step's one-line summary, why
Publish isn't offered yet, **Release Chat** and **Releases**.

**Links and buttons.** In the floating panel, the phone sheet and the collapsed popover alike, the
places to go (Branch Chat, Checks, Queue, Release Chat, Releases, On GitHub or On GitLab) are plain
links on one row, which never runs past the panel's edge. The things that do something (Land Anyway,
Accept, Try Again, Land, Remove from Queue, Answer in Chat, Resume Queue, Continue, Retry Step) are
buttons on their own row above the links, drawn only when there are any. There is no Send Back, and
no re-land button.

**Decisions.** Each entry waiting for the user's decision (§app.merge-queue/needs-user) shows in the
detail with its branch, its question or reason and its answers. A decision answered in words offers
**Answer in Chat**, which opens the branch's chat at its card, where the user answers in the message
box (§chat.merge-queue/decision); the bar never holds a text box. An entry back with its chat isn't
listed as needing you.

**Actions in place, or the tab.** Resume Queue, Retry Step and Continue act right there, through the
same catalogue commands the tabs use (the verbs `merge.resume`, `release.retry` and `release.continue`,
§app.project-services/merge-verbs, §app.release/verbs). Land Anyway,
Accept, Try Again, Land and Remove from Queue open the Merge Queue tab at that entry, where the
user's own click acts (§app.access/your-click); Publish and Abandon open the
Releases tab. Neither Publish nor Abandon is ever in the bar.

**On a phone (<768px).** The bar is the same 44px row, directly above the foot bar
(§app.insights/sidebar-foot-phone), shown only while there is something to show. A tap opens a bottom
sheet with the detail and its actions, not the floating panel; the scrim and Escape close it, focus
is trapped inside and returns to the bar. A press-and-hold shows the hover card instead
(§app.merge-queue/landing-bar).

**Collapsed (the spine).** One icon with a status dot in the spine's foot, above Usage
(§app.session-list/spine); its accessible name and `title` are the bar's (title, sub line and the
count in words), and it opens the same detail as a popover beside the spine, which Escape or a click
outside closes.

## §app.merge-queue/owner — Which chat owns a branch

One rule says which chat owns a worktree's branch, and Sova uses it everywhere the queue needs a
chat it wasn't told: the chat a Ready row names and opens (§app.merge-queue/view), the chat a
Worktrees row names first (§chat.composer/worktrees-control), and the chat an
approval records, hears about its outcomes and shows its queue card (§chat.merge-queue/chat-card).
The owner is, the first that holds:
1. the chat that created the worktree and still tracks it (its own record, not dropped;
   §chat/worktrees), when it isn't archived;
2. else the newest main chat not archived working in the worktree's folder or inside it;
3. else the chat that runs the newest worker working there, not archived;
4. else the same three, in that order, among archived chats, so the row shows it marked "archived";
5. else none: the row reads "No chat found for this worktree", and no chat gets a card.

The owner is never a worker: wherever one turns up (it created the worktree, or works there), the
chat that runs it stands in for it, up to the top chat when workers run workers (at most 8 levels),
and a worker whose chat isn't known counts for nothing. The queue's own chats
(§app.merge-queue/chats) never own a branch. So a worktree created by one chat, with a newer worker
working inside it, belongs to the chat that created it, and one with no tracking chat where only a
worker works belongs to the chat that runs that worker. Land on its row with no chat named records
and tells that chat, so its card and the queue's requests reach it.

Working out owners never rereads chats' transcripts each time the view is read: Sova keeps which
chat tracks which worktree, and updates it as those chats' worktree records change.

## §app.merge-queue/chats — The queue's own chats, out of your lists and kept until you clear them

The merge thread (§chat.merge-queue/thread) and every reviewer chat (§app.merge-queue/review) are
the **queue's own chats**. Sova knows them by the profile entry in the chat's own file (Sova's
system profile `merge-thread` or `merge-reviewer`), never by title, so a chat titled "Review · …",
or started on a profile of yours with the same id, never becomes one. Its name is Sova's too: the
title Sova starts it with, which nothing renames (§app.session-list/fixed-names).
The mark holds for chats started before this shipped and after a restart.

**Out of every list.** No session list shows them:
- in the session pane: Recent, the overview's counts, the project and folder blocks, Folders, the
  groups and every way into one, the Archive with its counts and its Clean Up, Needs you, search
  and the Agents board (§app.session-list/ordinary-surfaces);
- on the server: Needs you and the notifications that follow it, Ready-to-merge reads, the Agents
  board, the Overseer's and the project overseers' session lists, and naming sessions.

Queue chats that already existed leave these lists too. A link still opens one: from the Merge
Queue tab, a run's page and the branch's own Worktrees row (§chat.worktrees/pane). The worktrees
they create are the queue's scratch copies: never a row in any Worktrees section, a queue chat's
own included, and never on a list you land from (§app.merge-queue/resolve-copy).

**Their settings are Sova's.** A mode switch (the mode menu), a settings change
(`POST /api/sessions/configure`) or another profile pick for a queue chat is refused (409), so it
keeps its mark and its modes: "That is one of the merge
queue's own chats: it keeps the modes and settings Sova starts it with." A message or act on one
from another chat or the Overseer is refused too: "That is one of the merge queue's own chats:
only Sova writes to it. Open it from the project's Merge Queue tab.", and so is a mesh link to one.
The user may still write in the chat itself. Clean Up never sweeps one, and refuses one named by
path: "That is one of the merge queue's own chats: clear it from the Merge Queue tab's Queue chats."

The project's Merge Queue tab (§app.merge-queue/view) is where they are found, in four places:
the Merge thread card and the head's running review, on every status tab; the reviews on the runs'
rows; and the Queue chats tab.

**The Merge thread card**, under the queue's head: "Merge thread" with its state chip (**Idle**,
**Working** while its turn runs, **Asking you** while a question is open), its memory type
("UniiChat"; "No memory" when it runs without), when it started, and its last event ("last: Read a
queued branch · {branch}, {when}"). It has **Open Merge Thread**, the tab's only one, and **Start
Fresh…**, on one line, which asks
first ("This thread is archived once its turn ends, and its memory of past landings goes with it.
The next event starts a new one. The old thread stays readable in Queue chats.", **Cancel** /
**Start Fresh**). A question it asks shows on the card (§chat.merge-queue/asks); one no branch chat
can carry has one button, **Answer in Merge Thread**, which opens the merge thread's chat to answer
in its message box, and no text box or Send Answer. With no thread:
"No merge thread now: the next event starts one (it reads each branch as it is queued)."

**A running review.** While a review runs, a button in the queue's head, beside Queue Settings and
Pause Queue, reads "Review running · {branch} · Open" (" (attempt {n})" after the branch on a retry) and
opens that reviewer's chat; it goes away when the review ends.

**Queue chats**, a status tab of its own (shown even before the queue has had any chat, with an
empty tab's line, §app.merge-queue/view): every one, the current
merge thread on top, then newest first, archived ones included, with the filters **All**, **Merge
threads** and **Reviews**. A thread's row reads "Merge thread" ("Merge thread (current)"), its
memory type and why it ended; a reviewer's "Review · {branch}" (" · attempt {n}"), "running" or
"Review: {verdict}" ("no verdict" when it failed or timed out) and its run; each with when it
started and ended. Every row's title opens its chat. Each row has **Clear**, except the current
thread, a running reviewer and a row already cleared; **Clear All…** asks first: "Deletes {n}
chats for good. Runs keep their verdicts and findings. The current merge thread and a running
review stay."

**The review on every run.** Rows of Checking now, Needs you, With its chat and Landed, and the run
page, show each of the run's reviewer chats, oldest attempt first: "Review: {verdict}" or "Review
running" (with " (attempt {n})" when there are several), then **Open Reviewer Chat**.

**Kept until the user clears them.** Sova never deletes a queue chat by age: archived, it stays
readable from Queue chats and its run for good. **Clear** archives the chat and deletes it for good;
**Clear All…** does so for every row it counted. A cleared row stays in Queue chats, marked cleared
("chat cleared"; a reviewer's "Reviewer chat cleared") with no link, and a cleared reviewer's run
keeps its verdict and findings, reading "· Reviewer chat cleared" in place of its link. A delete
that is refused leaves the row as it was. Both are catalogue commands over `merge.clear`
(§app.project-services/merge-verbs).

## §app.merge-queue/settings — The queue's settings, in Settings → Merge Queue

Every setting a project's merge queue uses shows in one place: the **Merge Queue** tab of the
Settings dialog (§app/settings-dialog). **Queue Settings** on a project's Merge Queue tab
(§app.merge-queue/view) opens it already showing that project. The tab shows one project at a
time, picked in its head from the projects that aren't archived (opened any other way, the first);
the heading stays on one line beside the picker at every width, the picker giving way. A row's tag
(**Project file**, **This computer**, **Set by Sova**) is a small tag at its own width: at the row's
end, or under its value once a narrow screen stacks the row, never stretched across it.
A project the queue doesn't serve yet (its merge setup isn't done) shows, in place of the groups, the
Merge Queue tab's own words, "No merge queue settings are set up for this project", "Until they
are, its chats merge branches into {target} themselves when you ask.", what the queue does and what
setting it up changes (§app.merge-queue/view), with **Set Up with a Chat**, and under it the way of
landing suggested from `origin` (§app.merge-queue/strategies). Set Up with a Chat closes Settings
and opens the project's Setup chat (§app.project-setup/start). For a project it serves, the head
offers **Change Setup**, which does the same. What such a project shows (the suggestion, its models, Sova's fixed values,
no checks) is read from Git and this computer's files only: looking makes no queue and writes no
queue record.

**What it shows: the values the queue uses.** Project-file values are read from the target's head
("From {target} at {sha}"), never from the project folder. When the project folder's
`.sova/project.json` differs from the target's (an edit not committed yet), one line says so: "The
project folder's .sova/project.json differs from master's. These are master's values, which the
queue uses."

**Its groups**, each row tagged where its value lives: **Project file**, **This computer** or
**Set by Sova**.
- **Landing**: How it lands (§app.merge-queue/strategies), Lands into (the target), Push after each
  landing (only under Merge locally, §app.merge-queue/push), and Private names: "Set up · {n}
  names" or "Not set up", never the names themselves.
- **Checks**: "{n} always, {m} when the merge thread picks them", then each check with its time
  limit, whether it reruns failed files, and whether it always runs or only when picked
  (§app.merge-queue/checks), "Reuse passes from identical code" (On or Off, Project file, on by
  default; not shown when the project declares no checks), with "A test file that already passed
  on exactly this code isn't run again; a few are re-checked at each landing. Reruns and releases
  always run in full." while on and "Every check runs in full." while off
  (§app.server-runtime/test-reuse), and "Longest a check runs: 30 min" (Set by Sova).
- **Before the checks**: Setup (its steps), Install (when it runs, offline, its time limit), and "A
  failed setup: tried again once after 60 s" (Set by Sova).
- **Review**: Review each landing (on or off), Instructions (the kit's folder and file count,
  with **Open Folder**), Model with **Change** (§app.merge-queue/models), and Time limit ("20 min,
  tried twice, then the queue pauses", Set by Sova) (§app.merge-queue/review).
- **Merge thread**: Model with **Change**, Instructions ("Sova's method, then this project's own",
  with **Open Folder**), Fresh chat ("One endless thread with memory (UniiChat). A new one only
  when it's gone, open in a terminal, keeps refusing messages or past half of its context, or when
  you press Start Fresh.", Set by Sova) (§chat.merge-queue/thread-life).
- **Request**, on a project that lands by request: Instructions (the request kit, with **Open
  Folder**, §app.merge-queue/request-kit).
- **Where it checks**: the merge copy's location (Set by Sova).

**What can be changed here**, saved as §app.merge-queue/settings-save says:
- the review and merge-thread models (This computer);
- How it lands (§app.merge-queue/strategies);
- push on or off;
- review on or off: off takes the kit's folder out of the definition, and on puts it back, offered
  only while that folder is on the target;
- each check's time limit (at most 30 min), whether it reruns failed files, and whether it always
  runs or only when the merge thread picks it;
- reuse of passes from identical code on or off.

Everything else is read only: check commands, setup, install, the kit's folder, and every value
Set by Sova. A command is changed in a branch, where the queue tests it.

**Open Folder** opens the folder viewer's list (§app/folder-viewer) in place, under its row, on the
folder as it is at the target's head (**Close Folder** puts it away), and a picked file opens in the
reading window (§app/markdown-viewer): the review kit; the merge
thread's two playbooks as two labelled groups, "Sova's method" and "This project's"; the request
kit. It is read only, and no script in it runs. The merge thread reads the project's playbook from
the project folder (§chat.merge-queue/thread); when that copy differs from the target's (a change
not committed, or a file not tracked), its Instructions row says so: "The merge thread reads the
project folder's copy, which differs from {target}."

**On the project's Settings tab.** The All settings list has a **Merge queue** row with its state,
which opens this tab on that project, labelled "Settings → Merge Queue"
(§app.project-overseer/settings). The tab has its own link, `#/settings/merge-queue/<project id>`
(without an id: the picker's first project). The project overseer's settings tool can't change
these: they are the operator's, here.

**Commands.** `project.merge-queue.settings.get`, `project.merge-queue.models.set`,
`project.merge-queue.settings.save`, `project.merge-queue.settings.cancel`, and the folder viewer's
`project.folder.list` and `project.folder.read` (§app/folder-viewer).

## §app.merge-queue/settings-save — Saving a queue setting

Only a project the queue serves saves anything here: on one it doesn't serve yet, a save, a model
pick or cancelling a waiting save is refused with "not a project the merge queue serves: merge it
into main from the chat" (its setup comes first, §app.merge-queue/setup).

A setting kept on this computer (the models, How it lands when kept there) saves as it is picked,
with no commit, and applies from the next review, the next fresh merge thread or the next approval
("Saved the review model. Applies from the next review; one running keeps its model.").

**A setting in the project's file is one commit straight onto the target**, after the user
confirms. Changes are gathered on the tab ("{n}
changes to the project file.", with **Discard Changes** and **Save to {target}…**), and the
confirm lists each one and says "Save these changes to .sova/project.json as 1 commit on {target}?"
and "It applies from the next landing and isn't checked first." These saves are the tab's own,
not Settings' Save Changes (§app.settings-dialog/save-bar). This is the one exception to the rule
that everything reaches the target through the queue: the change itself is not checked first.
- Only the changed values of the `merge` section are rewritten (`push`; `review`; `reuse`, written
  `false` when turned off and its key removed when turned back on, listed as "Reuse passes from
  identical code: off" and titled "reuse passes from identical code off"; each check's `timeout`, `rerun`
  and `optional`, a switch turned off removing its key); every other byte of
  `.sova/project.json` stays as it was. The result must parse as a definition with exactly those
  changes, or nothing is saved.
- The commit is titled "Merge queue settings: {what changed}" ("Merge queue settings: push off;
  unit: 25 min, only when picked"), with the repository's identity, else "Sova merge queue". The main checkout is
  fast-forwarded to it, never forced.
- It is the queue's own commit: it raises no "moved outside the queue" flag
  (§app.merge-queue/master-moved), and goes to `origin` with the next landing, never on its own.
- Each change says where it went: "Saved to master as {sha}; pushed with the next landing."
- A refusal shows the queue's own words; a save that fails reads "Couldn't save the queue settings."
  and "{reason}. Nothing changed on {target}."

**It never cuts into a run.** On a project that lands locally, while a branch is checking, the confirm says so and its button reads
**Save When It Finishes**; the save then waits, "Saves when the current branch finishes.", with
**Cancel Save** ("Cancelled the waiting save. Nothing changed."). A second save made while one waits
joins it. A save also waits while a release is open (§app.release/checks) or the target has moved
outside the queue, until the queue resumes
(§app.merge-queue/master-moved). A waiting save is kept with the queue's records, so a server
restart keeps it; one that fails when its turn comes is kept as failed and not retried, shown as
"The waiting save couldn't be applied." with its changes, the reason and **Cancel Save**. The commit is made once that run has ended, so the run is never
voided and the queue never pauses for it; the next run uses the new values.

**An uncommitted edit blocks it.** While the project folder's `.sova/project.json` has an
uncommitted edit (or differs from the target's), the project-file controls are greyed out with
"Commit or discard the edit in the project folder first.", and nothing is saved. Other tracked
files with uncommitted changes in the folder that has the target checked out refuse the save too,
and so does a merge, rebase, cherry-pick or revert in progress there: "{folder} has uncommitted
changes ({n} files: …): commit or put them away first (nothing is forced)" (or "{folder} has a merge
in progress: commit or put them away first (nothing is forced)"). Untracked files never block it. The
same holds on every project, whichever way it lands.

**Unsaved changes are never dropped silently.** Gathered project-file changes are kept, without
asking, when you switch to another Settings tab; when the target moves, they are applied again on top
of its newer values.
Closing Settings over them holds the close as the dialog's own forms do (§app.settings-dialog/save-bar):
"Your Merge Queue changes aren't saved.", "Save them on their tab, or discard them and close.", with
**Keep Editing** and **Discard and Close**. Switching the tab's project over them asks too: "Your
changes to {project}'s queue settings aren't saved.", "Save them first, or discard them and switch
to {other}.", with **Keep Editing** and **Discard and Switch**.

**On a project that lands on its host** (a request or a pushed branch, §app.merge-queue/strategies)
a project-file change is never a commit on the local target, since such a project never pushes it.
It goes out on a branch of Sova's own, `sova/settings-{YYYYMMDD-HHMM}`, cut from the host's target,
the only branch Sova pushes for it, through the same path as a branch (§app.merge-queue/publish):
- on a request project, as its own request (§app.merge-queue/requests), titled "Merge queue
  settings: {what changed}", with a plain description by Sova that the request kit's checks still
  run on when the project has a kit (§app.merge-queue/request-kit);
- on a Push branch only project, as that pushed branch, and you open the request yourself.

It applies once the host merges it. The save then answers with the request it opened (its number and
address) or the branch it pushed, instead of "saved"; local main doesn't move. There the confirm
says "Save these changes to .sova/project.json in a PR into {target}?" ("in an MR into {target}", "on
a branch pushed to origin") and "It applies once it's merged into {target}.", with **Open a PR**
(**Open an MR**, **Push a Branch**) and no waiting: since the target never moves, such a save goes out
at once, even while a branch is checking; after it, "Opened PR #{n} for the settings
change. It applies once it's merged into {target}." with **Open PR** (GitLab: "MR !{n}", **Open
MR**), or "Pushed the settings change as {branch}. It applies once it's merged into {target}."

**From a Create card.** A chat in Create can prepare these same changes on a Settings change card
(§chat.create-mode/settings-cards). The card's Apply stands for the confirm and goes this same way,
with the same commit, refusals and waits: while a branch is checking the card reads "Saves when the
current branch finishes." and has **Cancel Save**, and a chat never applies one.

## §app.merge-queue/models — The review and merge-thread models, per project

Each project has two models of its own on this computer: the **review model**
(§app.merge-queue/review) and the **merge-thread model** (§chat.merge-queue/thread). Each is a
model (its provider first: `provider/model`) and an effort, picked in the same model picker as the Project Assistant's (model
first, then effort), within Settings → Models' policy.
- **Until picked**, each reads "Same as new chats ({model} · {effort} today)" and behaves as it did
  before: the chat opens on the new-chat default. **Use New-Chat Model** puts a picked one back to
  that.
- **A change applies** from the next review, or the next fresh merge thread. A review already running
  keeps its model, and so does the merge thread until it is replaced.
- **A model turned off** in Settings → Models can't be picked ("{model} is turned off in Settings →
  Models and can't be used…"). One picked that later can't run (turned off since, or its backend
  not signed in) is kept, falls back to the new-chat default, and the row says why ("{model} isn't
  signed in on this computer").
- **Only the operator's page** sets them; no chat, the Overseer included, can.
- **Kept on this computer only**, never in the project's file and never in the shipped Merge
  reviewer or Merge thread profiles: a collaborator without these models is never handed them. A
  new project starts on the new-chat default.

## §app.merge-queue/strategies — How a branch lands

Each project in the queue has one **How it lands** setting:
- **Merge locally** (the default, and what every project already in the queue keeps): the target
  moves to exactly the tested commit and is pushed (§app.merge-queue/land, §app.merge-queue/push).
- **Pull request on GitHub** or **Merge request on GitLab**: the branch is published and a request
  opened from it, which you or your team merge on the host (§app.merge-queue/publish,
  §app.merge-queue/requests).
- **Push branch only**: the branch is published, and you open the request yourself. It is how a
  project on any other host lands (§app.merge-queue/publish).

**The same start every time.** Whatever the setting, Land runs Sova's checks and the review first
(§app.merge-queue/run); only the ending differs. A project that wants its request open sooner
sets up "no automated tests" (§app.merge-queue/setup).

**Suggested from origin.** A github.com `origin` suggests Pull request; a GitLab host (gitlab.com,
a host named `gitlab.…`, or any host this computer's GitLab tool is signed in to,
§app.merge-queue/hosts) suggests Merge request; no `origin` or another host suggests Merge locally. The suggestion is offered to the Setup
chat (§app.project-setup/investigate), and shows on the settings' not-set-up note and on the setting's row while it differs from what is in effect ("Suggested from origin:
{why}"). Nothing changes until you pick.

**Where it is kept: either place, your choice when you save.**
- In the project's file, `merge.land`, shared with everyone who uses Sova on that repository, saved
  as §app.merge-queue/settings-save says. A file without the key reads Merge locally; the key is
  not part of the services definition, so changing it touches no running service.
- Or on this computer only, for that project.

When both are set, this computer's wins. The row says which one is in effect and where it comes
from ("Pull request on GitHub · this computer, overrides project: Merge locally", "{way} · project
file", "{way} · Sova's default"), with **Clear Override** while this computer's choice is in effect.
Picking another way asks where to keep it, **This computer only** or **Project file**, and saves with
**Save on This Computer** or **Save to Project File**.

**Pinned on each approval** (§app.merge-queue/approve): a setting changed after a branch is
approved never redirects it.

**The routes.** Setting how it lands, Publish and Update Local Main are the operator's page only: a
chat, a script, the Overseer or an extension is refused with a sentence. Saving `local` to the
project file removes the key.

**While a release is open** (§app.release/checks), a choice kept on this computer can't be set or
cleared: "how it lands can't change while release {tag} is open: change it after Publish or Abandon",
shown as an error, and Clear Override leaves the choice in place. A change to the project file is a
save, so it waits like any save and is made after Publish or Abandon
(§app.merge-queue/settings-save). **Releases need
Merge locally:** a release lands its commit on the target and pushes it itself, so a project that
lands by request or by pushing a branch can't release yet (§app.release/start).

**Typed words.** The Land menu offers no other way of landing. But "open a PR" or "open an MR",
typed by the user in the chat that owns the branch, is never blocked:
- on a project the queue serves, the chat records it with `worktree land` under the same rules as
  "land it" (§chat.worktrees/tool, §chat.worktrees/land-own-word), and that approval lands as a
  request on `origin`'s host, whatever the project's setting, after the same checks. The host decides,
  not the word: "open a PR" on a GitLab `origin` opens a merge request there, and "open an MR" on
  GitHub a pull request; the wording is never refused. The host and its sign-in are checked when the
  approval is taken (§app.merge-queue/approve, §app.merge-queue/hosts);
- in a repository the queue doesn't serve, nothing is recorded: the chat is told to open the request
  itself with the host's tool (`gh pr create`, `glab mr create`), with no Sova checks or scan.

"open the PR" is not a go-ahead, and the same rules as "land it" hold for not-now words and
questions (§chat.worktrees/tool).

## §app.merge-queue/publish — Publishing a branch to its host

Under Pull request, Merge request and Push branch only (§app.merge-queue/strategies), a branch
whose checks and review passed is published to `origin`. What goes out is the branch itself, under
its own name, with its spec docs: the merge with the host's target was only for testing.

**The spec docs commit, in the chat's folder.** The run's docs commit (§app.merge-queue/run) is
made again on the approved commit itself and fast-forwarded into the branch's worktree, so the
chat's folder has the same commit and its next push never clashes. Sova makes it only while the chat
that owns the branch is idle (not busy, and no workers working) and its worktree has no uncommitted
edits and is on the branch; until then the entry waits, before anything is written or pushed, and
says which ("the chat working on {branch} is busy: the spec docs commit waits until it is idle"),
and Sova tries again by itself. A branch that has moved past the approved commit is handed back to
its chat: "Land Again to include the newer commits".
An approval without its specs, or a branch with no drafts of its own, gets no docs commit. The
reviewer on the host sees the docs change with the code.

**Its drafts read as landed.** Once the branch is published, each draft the run made official and
unedited since gets the spec tool's promotion entries in the branch folder's `draft.json`, under the
draft tool's lock, as it would have had the tool landed it there; nothing is deleted or moved. The
folder holds the docs commit, so that is all the draft tool's own rule needs
(§tools.spec/draft-official): a draft reads official however the host merges the request, squash
included, and whether or not the local target has caught up. A record the landing gave
`authority: "accepted"` needs this: without the entries it differs from the draft's, and the merged
row would say its drafts didn't land (§chat.worktrees/readiness).

**Pushed as a fast-forward, never forced.** A branch on `origin` that has commits the published one
lacks (someone pushed to it on the host) is refused with the reason, never overwritten, and nothing
is pushed. Nothing is published while a push hold is on (§app.merge-queue/push).

**Scanned by Sova first, always.** Before anything is published, Sova itself scans all of it for
secrets and the project's private names (§app.merge-queue/push): every commit from the host's target
to the published tip (their messages, file names and added lines, spec text included; a merge read
against its first parent) and, for a request, its title and description. This holds whatever checks
the project lists. A finding, or a scan that can't run (git failing, names that can't be read, more
than 2,000 commits), publishes nothing; the why never repeats the text that matched. A finding in the
branch's commits sends the entry back to its chat by itself (§app.merge-queue/send-back); one
in the request's words waits for you with the reason. A project whose private names aren't set up
publishes nothing, says so, and calls the merge thread in for them (§chat.merge-queue/thread).

**Sign-in.** A request needs this computer's sign-in to its host (§app.merge-queue/hosts); a
missing one refuses it before anything is published. A request always opens on `origin`'s host. The
checks made at approval (§app.merge-queue/approve) run again here, in case anything changed since.

**When it goes out.** A new request waits for you to review its words first
(§app.merge-queue/requests). Push branch only, and Land Again onto a request already open, publish at
once; the entry reads Checking until it is out.

**Push branch only** ends here: the entry reads **Pushed**, "Pushed {branch} at {sha}", and the
request is yours to open.

**Never twice.** What Sova is about to publish is recorded before it pushes or opens a request. A
restart or a lost connection in between checks the host for the branch and the request first, so a
retry never pushes over it or opens a second request. A publication Sova stopped in the middle of is
finished from that same tested run at the next start, never rerun; until it goes out it reads "Sova
stopped while publishing it: finishing it".

## §app.merge-queue/requests — Pull and merge requests

On a project that lands by pull request on GitHub or merge request on GitLab
(§app.merge-queue/strategies), a branch that passed is published (§app.merge-queue/publish) and a
request is opened from it into the target.

**Its words, seen first.** Sova writes the request's title (the chat's title, else the branch's
name) and description (the merge thread's note, the checks that passed, the review's notes and the
specs it changes, ending "Opened by Sova"), following the project's request kit and the repository's
own template (§app.merge-queue/request-kit). Before anything goes to the host, the entry and the
chat's card show them to read and edit ("Review the request", **Review Request**): the title, the
description, **Open as a draft** (off: it opens ready), where the text came from ("Written from
{folder} · {n} checks passed", "{x} of {n} checks failed", or "No request folder: written in Sova's
plain default."), and **Publish Pull Request** (or **Publish Draft Merge Request**, and so on) and
**Remove from Queue**. There is no Send Back to Chat: a request's words are the user's to edit here.
Only Sova's own checks hold Publish (a title, on one line, at most 255 characters; a description of
at most 60,000): the kit's failed checks are shown, never a lock (§app.merge-queue/request-kit). A
wait on the chat, a finding in the words, a missing sign-in or private names not set up keep it
here, with the reason. When Sova couldn't write the text at all (a kit check that can't run), Review
Request opens an empty form with the reason and "Write the title and description yourself, then
publish." After Publish, it reads "Opening the PR" ("Opening the MR"; Push branch only: "Pushing the
branch") with the queue's reason as its line ("Publishing to GitHub."), and no Review Request, until
the request is open or refused. A refusal leaves the words as you left them, with Review Request and
"{reason}. Fix it, then publish again." The line moves on meanwhile.

**Who merges.** You or your team, on the host. Sova never merges a request and never turns on the
host's auto-merge.

**An open request never holds up the line.** The next branch starts as soon as it is opened. The
entry waits on the host (§app.merge-queue/view), and the card follows it
(§chat.merge-queue/chat-card): "PR #{n} open · checks running on GitHub" (GitLab: "MR !{n} open ·
…"), "… · checks passed on GitHub", then "Host checks failed", "Changes requested", "Approved",
"Conflicts on GitHub"; the first that holds of merged, closed, conflicts, host checks failed,
changes requested, approved, open. Host checks that report nothing read "… · no checks reported on
GitHub", never passed. **Open on GitHub** (or GitLab) shows whenever the request has an address.
Sova checks the host every 3 minutes while any request is open, and when the Merge Queue tab is
opened (at most every 20 seconds). These changes start no paid chat turn. The queue view lists open
requests newest first, with those closed or pushed in the last 7 days.

**Host checks failing** is not blamed on the branch as Sova's checks are, and the entry says nobody
is blamed. Host checks failing, changes requested and conflicts go back to the branch's chat by
themselves, as a request with the host's reason and the request's address
(§app.merge-queue/send-back), once per problem at the request's head, and the entry reads "Back with
the chat". While the user's Land stands, the chat's checked fix is checked again and pushed to the
same request by itself (§app.merge-queue/standing-approval), as Land Again would, up to its tries;
changes requested that ask for something the user must decide wait for them
(§app.merge-queue/needs-user). There is no Send Back to Chat.

**Merged.** Only when the host says merged does the entry read **Landed**, and the chat hears of it
as today (§chat.merge-queue/chat-turns). The host's merge counts as the queue's own
(§app.merge-queue/master-moved). The host may squash or rebase, so it says what Sova checked and
that the host's merge is final ("Merged on GitHub. Sova checked it merged with {target}; GitHub's
merge is final."). Deleting the branch on the host is left to the host's own setting; removing the
worktree stays yours.

**Closed without merging** reads "Closed on GitHub", with **Land Again** while the queue still
serves the project; a repository it no longer serves shows no Land at all, even on an old closed
request. Land Again also shows while a request is open, or a branch pushed, once the branch has
newer commits that hold real work.

**New commits: added on top, never rewritten.** Land Again on a branch whose request is open,
waiting for review or closed puts the same entry back in line (it keeps its request). It checks it
again, merged with the host's latest target, makes a new docs commit for any new drafts, and pushes
it to the same request as ordinary new commits: what the request had stays an ancestor of what it
gets.

**Tested against what the host has.** Every run on such a project starts from the host's target,
fetched just before (§app.merge-queue/run), so a branch waiting while the host merges another is
tested on the host's newest target, and the host's merge never pauses the line
(§app.merge-queue/master-moved).

**Update Local Main** brings the target on this computer up to the host's, only when the user
presses it (§app.merge-queue/update-local-main).

## §app.merge-queue/update-local-main — Update Local Main

The target on this computer is never moved by itself. The Merge Queue tab and the entry show "Local
main is {n} commits behind" with **Update Local Main**, which fetches the host's target and
fast-forwards the local one, and the main checkout, to it. The queue does it itself, so it never
counts as moved outside the queue, and it never pauses the line; a run checking meanwhile keeps
going on its moved base and is never voided. When the project folder has uncommitted edits
("{folder} has uncommitted changes (…): commit or put them away, then Update Local Main again"), or
the local target has commits the host lacks, it is refused with the reason and nothing is forced.
When it is already current it says "Local main is already current." While a release is open it is
refused too, since the target stays on the release: "{target} stays on the release commit while
release {tag} is open: update it after Publish or Abandon" (§app.release/checks).

## §app.merge-queue/hosts — GitHub and GitLab, signed in on this computer

The first hosts are GitHub and GitLab (gitlab.com or a GitLab of its own), together. Any other host
lands by Push branch only (§app.merge-queue/strategies).

**Their own sign-in.** Sova talks to GitHub only through its tool `gh`, and to GitLab only through
`glab`, using the sign-in the tool already has on this computer. It never asks for, stores, passes,
prints or reads a token. Before a request is published it checks the login:
- missing or expired: "Sign in to GitHub on this computer first (gh auth login)" (or "Sign in to
  GitLab on this computer first (glab auth login)", with " --hostname {host}" for a GitLab of its
  own);
- the tool not installed: "GitHub's command-line tool (gh) isn't installed on this computer" (or
  GitLab's, glab).

The How it lands row says whether this computer is signed in to the project's host.

**From the server only.** Every call to a host (find, open, read a request) is made by Sova's
server, never by a chat on a queue project: with no shell, the text passed on its input, no prompt,
pager, update check, telemetry or colour, and a time limit that stops the tool (15 s for the login,
30 s for a read, 90 s to open). An error Sova shows or keeps is cleaned first: no colour codes, no
line naming a token, secrets and credentials in addresses removed, at most 3 lines and 300
characters.

**What Sova reads of a request.** Open, draft, merged or closed; the host's checks running, passed,
failed or not reported (none reported, or a skipped GitLab pipeline, reads not reported, never
passed); its review approved, changes requested, review required or none; whether it merges cleanly
or conflicts; its head commit. Merged counts only on the host's word, with its merge or squash
commit. Before opening a request Sova looks for one already open from the same branch into the same
target, so a retry never opens a second (§app.merge-queue/publish).

**Logins kept from chats.** The Overseer's file tools can't read either tool's saved login, both
hosts' token shapes are redacted wherever the Overseer reads (§app.overseer/tools), and a sandboxed
chat sees neither tool's config (§chat.sandbox/what-on-enforces).

## §app.merge-queue/request-kit — The request skill folder

A project may declare a **request kit** in its definition's `merge` section (`merge.request`, such
as `.sova/playbooks/request/`). It is a skill-shaped folder, like the review kit
(§app.merge-queue/review): `PLAYBOOK.md`, its instructions on how to write a request's title and
description; `references/` (templates, examples); and `scripts/check*.mjs`, its own checks, run in
name order. It is never a registered skill and is in no skills folder. A named folder that is
missing, outside the project (by path or link) or has no `PLAYBOOK.md` is an error, never skipped;
a reference that links outside the folder isn't read. Sova ships an example kit in its own
repository.

**The text.** Sova writes each request's title and description by following the kit, with the
repository's own template when it has one (GitHub's `pull_request_template.md` in `.github/`, the
root or `docs/`; GitLab's `.gitlab/merge_request_templates/Default.md`, or its only one). Without a
kit, it writes a plain default: the chat's title, then "What this changes", "Sova's checks" (or "No
automated tests (the project's setting)"), "Review" and "Specs". The description always ends
"Opened by Sova".

**Its checks, before you see it** (§app.merge-queue/requests). Sova's own come first: a title, on one
line, at most 255 characters; a description, at most 60,000. Then each of the kit's checks reads the
title, description, host, branch and target, in its own folder, with a throwaway home, no token in
its environment and 20 seconds. A failing check sends the text back to be rewritten with its reason,
up to 3 tries in all. Still failing, the last text is shown for your review with the failing check
and its reason, and you may edit it and publish: the kit is house style, while the scan of the title
and description stays the safety gate (§app.merge-queue/publish). A check that can't start or runs
past its time refuses at once, and no text is shown.

It can be read, never edited, from Settings → Merge Queue's **Open Folder**
(§app.merge-queue/settings).
