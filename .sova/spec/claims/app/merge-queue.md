# §app/merge-queue — Merge queue
> Part of the Sova design spec · [overview](../design/overview.md)

Each project the merge queue **serves** (§app.merge-queue/served: on Sova's Projects list, with its
merge setup done) has one **merge queue**, owned by Sova and worked mechanically. It is the only way
a branch reaches that project's target branch (`master`; `main` where the project's definition or
repository says so). Every other repository has no queue at all: its chats merge into its main
branch plainly, with git (§chat.worktrees/tool). The user approves a
branch (§app.merge-queue/approve); each branch belongs to one chat, by one rule
(§app.merge-queue/owner), which hears about it. Sova then merges it onto the newest target in a merge copy of
its own, one branch at a time, and turns its spec drafts into docs there. It runs the project's
checks on that commit (§app.merge-queue/run, §app.merge-queue/checks) and fast-forwards the target
to exactly the commit it tested (§app.merge-queue/land). Then it pushes (§app.merge-queue/push).
A failure goes to the branch's chat only once the same check passed on the target alone
(§app.merge-queue/blame).

A chat working the project's merge playbook, the **merge thread** (§chat.merge-queue/thread),
helps:
- it adds a note to each landing (§app.merge-queue/note);
- it picks tests the change could break;
- it judges conflicts (§app.merge-queue/conflicts);
- it explains failures, in the entry's note.

It acts only through the merge verbs (§app.project-services/merge-verbs). Sova starts every run by
itself, and a missing or slow thread never delays a landing.

The queue knows nothing about any one project. It reads only the project's definition
(`.sova/project.json`) and the existing verbs, so it works the same for every project: Sova's own
repository, a site with one test command, a project that has no tests. The queue models no "live"
or "not live" state anywhere and has no Restart Server control. Restarting stays where it is
(§app.updates/restart and the operator's Apply verb).

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
so a project listed or set up while the chat is open takes effect at its next merge. A chat Sova
doesn't run treats every repository as not served. A chat Sova runs that finds the file missing or
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

## §app.merge-queue/approve — Approving a branch, and taking it back

**Two ways to approve.** A branch enters the queue only on the user's approval:
- **Land**, in the composer's worktrees control (§chat.composer/worktrees-control), on the
  session pane's Worktrees rows (§chat.worktrees/pane) or on the Merge Queue view
  (§app.merge-queue/view);
- or the user typing "land it" (or "merge it") in the branch's own chat, which that chat records
  with `worktree land` (§chat.worktrees/tool). That action refuses any message the user didn't type
  themselves (§chat.worktrees/land-own-word).

Both approve the same thing, with no second confirm. Nothing else approves: not the merge thread,
not an Overseer card, not another chat.

**What an approval pins.**
- The commit the screen showed: the row's head on the project page, in the composer's modal and in
  the pane, or a proposed run's reviewed tip; for a typed "land it", the head at that moment. A
  commit that isn't on the branch is refused ("{sha} isn't on {branch}"); a branch that has moved
  past it lands the shown commit, with "{n} newer commits not included".
- A hash of the branch's own spec drafts (the files under each draft's `spec/`, as
  §chat.worktrees/ready-to-land reads them), with those drafts copied aside so the run uses exactly
  them. A branch's own drafts are the ones Git doesn't track, plus any tracked draft the branch adds
  or changes since its merge base with the target. A draft already on the target that the branch leaves alone is
  never hashed, named, landed or deleted.

The entry joins the end of the line, which runs in the order approvals came, and shows its place
("Queued · 2nd"). Approving a commit that is already queued changes nothing.

**What it refuses**, with the reason and nothing queued:
- a branch with uncommitted files;
- a branch with nothing ahead of the target;
- a branch with a temporary commit subject;
- the target branch itself;
- a repository the queue doesn't serve (not on the Projects list, or its merge setup not done),
  with "not a project the merge queue serves: merge it into main from the chat", making no queue
  record (§app.merge-queue/served);
- while the target's `.sova/project.json` doesn't parse, any branch but one whose own commit carries
  a valid definition declaring checks: "The project's .sova/project.json is invalid: {path}:
  {message}. Fix it on the target, or land a branch that fixes it; nothing else lands until it
  parses" (§app.merge-queue/setup).

An approval is still taken while the queue is paused; a pause stops runs, not approvals.

**Its options.** Each is set once per approval, on the Land control's menu or in the typed words:
- **Land without review** ("land it, skip review") skips the review step (§app.merge-queue/review)
  for this approval only.
- **Land without its specs…** ("land it without its specs") leaves the branch's drafts behind.
  Its docs step then turns nothing into docs.

**After approval.**
- **A new commit on the branch** doesn't change the entry. The approved commit lands, and the row
  says "1 newer commit not included" (or "{n} newer commits"). Landing the newer commits takes a new
  Land.
- **Drafts edited after approval** (the branch's own drafts no longer match the pinned hash; an edit
  to any other draft in its worktree doesn't count) stop the entry before
  its run starts, or void a run already started. It waits as "Drafts changed since you approved",
  and the branch's queue card moves down as Drafts changed; the chat's model reads it as a hidden
  line at its next turn, with no turn started (§chat.merge-queue/chat-turns). A new Land makes a new entry for the drafts as they are now,
  and the old one is cancelled as "approved again".

**Taking it back.** **Cancel** on a queued entry takes it out of the line; nothing lands, and the
branch is Ready again. The screens offer Cancel only on queued entries. `merge.cancel` of a checking
entry stops the run, resets the merge copy and leaves the target where it was.

## §app.merge-queue/run — One branch at a time, in a merge copy

**The merge copy.** Each project's queue runs in one merge copy of the project, beside it, never
inside it: `<parent of the main checkout>/.worktrees/<repo>-merge`, marked as the queue's own. A
worktree already at that path that isn't marked as the queue's (one a person made on a branch
called "merge", say) is refused and never reset. A copy whose path would fall under Sova's state
root or any directory under `~/.pi` is refused before any git command runs, with the reason, and
nothing is blamed.

**One run per entry, its steps in order.** Each step's log starts at its first line, under the
run's own folder, so a failure at any step, the first included, has its log.
1. **Copy.** Any merge in progress is abandoned, and the copy is forced back to the target's newest
   commit. Its untracked files are cleared, keeping ignored setup outputs (dependency folders, its
   `.agent`), and its untracked spec drafts are removed; tracked drafts the target already has are
   kept.
2. **Merge.** The approved commit is merged onto the target's commit as a merge commit, or the
   merge thread's resolution is used. Git's recorded resolutions (rerere) are never used here,
   whatever the user's git config says. A conflict goes to the merge thread's judgement
   (§app.merge-queue/conflicts).
3. **Setup.** The project's setup steps (the definition's `setup`, §app.project-services/contract) run on the merged tree, so a
   branch that breaks setup is caught. Their results are reused while their argv and inputs are
   unchanged.
4. **Install.** When the branch changes one of the definition's install inputs (Sova's: the
   lockfile or `package.json`), the install runs offline.
5. **Docs.** The branch's own drafts pinned at approval, and no other, are copied into the copy and
   turned into docs there (the spec tool's `land`), as one docs commit on top of the merge. A
   branch's own drafts are the untracked ones, plus the tracked ones it added or changed since its
   merge base with the target. Tracked drafts already on the target are never landed, changed or
   deleted. A draft of the branch's own that doesn't fit hands the entry back to its chat ("your spec
   drafts don't fit…", with what to fix). The step is skipped, with its reason, for a project with
   no spec, an approval without its specs, or a branch with no drafts of its own ("no spec drafts
   of the branch's own").
6. **Checks.** The checks run on that commit, in order (§app.merge-queue/checks), with the review
   (§app.merge-queue/review) alongside them.
7. **Reruns.** A red check is rerun to place the blame (§app.merge-queue/blame).
8. **Land** (§app.merge-queue/land), then **push** (§app.merge-queue/push), then the branch's chat
   hears of it (§chat.merge-queue/chat-card).

Nothing is committed after the checks: the commit that lands is the commit that was tested, docs
included.

**One at a time.** A project's queue checks one entry at a time. The next waiting entry starts once
the previous one has landed, been handed back or waits for the user. Every run, the copy, setup and
merge included, has a run page with each step's log (§app.merge-queue/view).

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
3. else the queue isn't set up. It takes no approval, and the project shows the onboarding screen
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

A check the project marks optional runs only when the merge thread picks it (Sova's: `e2e`, one build and then each picked end-to-end walkthrough, and
`integration-group`, one slow integration group per pick). A pick on a required check that would skip itself (the
statecharts check skips unless statecharts changed) makes it run. A check with nothing to do for
this change exits clean and says why ("Spec replay · skipped: no
change to its paths"). Sova's checks are standalone scripts (`scripts/merge-checks/`).
- The changed extensions' suites come from `pi-config/README.md`'s Tests block and run at lowered
  CPU priority, so a landing never starves the live server or other chats.
- The spec replay runs one at a time on the machine, under a lock that a stale holder loses.

**Extra checks picked by blast radius.** While the entry waits, the merge thread may add checks
the change could break: statecharts tests when statecharts changed, the end-to-end
walkthroughs (a build, then the named walkthroughs) when the composer or transcript changed, the spec replay when the spec engine changed. Each pick carries its
reason. It can add checks, never drop the required ones. Picks count only if they arrive before
the run's checks start; otherwise the run uses the required checks and their triggers alone.

**Each check is shown tagged.**
- **Required** — the project declares it.
- **Triggered** — the change's files call for it.
- **Added by merge thread** — with the thread's reason.
- **Skipped** — with the reason.

Each also shows its time, its counts when it writes them (`SOVA_OUT`), and its log.

**What a check sees.** It runs in the copy with the instance's own ports and variables, through an
allow-list that passes no chat or secret variable. It is told the run's base, tip and target, the
changed files, and the project's private-names file. When the names aren't set up yet, the leak scan
scans for secrets alone and passes with "private names not set up yet: scanned for secrets only,
and the push is held" (§app.merge-queue/push). Services a check requires start through the project
engine in the copy's own slot and ports, and stop after the checks.

**Estimates.** "Starts in" and "takes" come from the project's own run history: each check's
recent passing times. "Starts in" adds up the time of the entries ahead. With no timed run yet,
a row shows no estimate rather than a guess; with timed steps but no passing run, each step's
median time is summed.

## §app.merge-queue/blame — Whose failure it is

A red check is never blamed on the branch until the same check has passed on the target alone,
in the same copy.

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
      the check and its log:
      - **Land Anyway** lands the tested commit, noted "Landed anyway: {why}". When the target has
        moved since the run, it is rerun first, and a rerun that still can't tell lands too.
      - **Send Back** hands it to its chat as **Needs a fix**.

      The queue doesn't pause, and the branches after it go on. When it failed on the target, the
      view says the check is red on the target alone ("Red on {target} alone: {check}"); one that
      only ran no test there isn't called red.
- **Setup fails** on the merged tree. It is first rerun once on the merge; passing then makes it
  **flaky**, as above. Failing again, setup is rerun on the target alone, with nothing reused.
  - If the target passes, it's the **branch's**, with the setup log.
  - If the target fails too, it's the **machine's**: the run is retried once, after 60 seconds. A
    second failure pauses the queue with the step's log. No chat is told, and the entry keeps its place.
- **The install fails.** It's the branch's, since the target alone needs no install. The message
  says to install the new package once in the project when the offline store lacks it.

**The branch's failure** goes back to its chat: its queue card moves down as **Needs a fix** with
the check, the test and file, the error, and the run's log, and a turn marked as coming from the
merge queue starts there (§chat.merge-queue/chat-card, §chat.merge-queue/chat-turns). Fixing it
takes a new Land.

## §app.merge-queue/land — Landing exactly the tested commit

**Before it moves anything**, the landing checks:
- the run passed (flaky and target-only failures noted, not blocking), or the user answered Land
  Anyway to a flagged review or to a failure whose owner can't be told;
- the target is still at the run's base;
- the entry is still approved at its pinned commit and drafts;
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

**After a landing**, the entry reads **Landed**, with its commit and its note
(§app.merge-queue/note). In the branch's chat its queue card moves down as **Landed**, with the
note, "1 newer commit not included" and Land Again when the branch moved past the approval, and "Not
pushed: {why}" when the push didn't happen (§chat.merge-queue/chat-card). The landing starts no turn
there: the chat's model reads one hidden line about it at its next turn
(§chat.merge-queue/chat-turns).
Removing the worktree stays the user's choice (§chat.worktrees/cleanup).

## §app.merge-queue/push — Pushing after each landing

After each landing the queue pushes the target to its `origin` (when the project has one and its
definition doesn't turn pushing off).

- **Fast-forward only, never forced.** It pushes only when the remote branch is an ancestor of the
  new commit and every first-parent commit between them was landed by the queue; otherwise "master
  has {n} commit(s) the queue didn't land …".
- **A project with no `origin`** never pushes, and nothing is held.
- **Leak scan first.** The leak scan with the private names runs over what would be pushed.
- **Release hold.** A release pauses the queue for its length (the release playbook presses Pause,
  then Resume), so nothing lands or pushes while it runs.

A push that is refused or held keeps the landing. The view's strip reads "master {sha} · not pushed:
{why}", and the next landing tries again.

**Private names.** The leak scan (`scripts/merge-checks/leak-scan.mjs`) reads each project's private
names from that project's names file, never committed: `<state root>/merge-queue/<project
key>/names.json`, beside its queue. Sova's own repository falls back to
`<state root>/merge-round.json` until it has its own file. A run may name another file with
`--names` or `SOVA_LEAK_NAMES`. A file with a `privateNames` list counts as set up, even an empty
one: an empty list is an answer. It scans the range from the remote
branch to the new commit.

The merge thread asks for the names (§chat.merge-queue/thread). Until a project has them, its pushes
are held: landings still complete locally, the strip reads "{target} {sha} · push held: private names
not set up yet", and the thread is called in once per landing. The next landing, a Resume or a
retry pushes what was held.

## §app.merge-queue/note — A note on each landing

Each entry may carry **notes**: short free text about what is worth knowing after it lands. The
merge thread's note is one text of at most 300 characters, for example "changes server code;
restart Sova to pick it up", or "regenerated the lockfile". Sova adds its own beside it:
- the review's notes;
- flaky tests;
- tests already failing on the target;
- what a conflict resolution did;
- "No checks declared".

- **Who writes it.** The merge thread (§chat.merge-queue/thread) writes its note with the merge
  verbs, following what the project's playbook says is worth noting. The operator may also write
  one, which stands over the thread's. For each writer the newest write wins, and an empty one
  clears it. A note may be written before or after the landing.
- **On a hand-back.** The thread's explanation of an entry handed back to its chat is added to that
  entry's queue card (§chat.merge-queue/chat-card).
- **Where it shows.** On the landed row in the Merge Queue view, the composer's worktrees control,
  the session pane's Worktrees rows, on the branch's Landed queue card, and in the hidden line its
  chat's model reads (§chat.merge-queue/chat-turns).
- **No note, no placeholder.**
- **It never gates anything.** A landing never waits for a note, and Sova reads no meaning into
  it.

## §app.merge-queue/review — The optional review step

A project may declare a **review kit** in its definition's `merge` section. It is a skill-shaped
folder (instructions and references, later its own scripts), such as `.sova/playbooks/review/`.
It is never loaded into an ordinary chat: it isn't under the skills folders or in any skill path,
and only the review step opens it. A project with no kit has no review step.

**How it runs.** For each run, a fresh, read-only chat reviews exactly the commit being checked,
in the merge copy, alongside the checks.
- It runs on the shipped **Merge reviewer** profile: no edit tools, no web, no workers, no timers
  and no worktrees.
- Each attempt is a new chat, titled "Review · {branch} · {sha}" (with " · attempt {n}" after the
  first).
- It reads the kit, checks its verdict with the kit's own script, and answers with `merge.review`.
  It writes no file.
- It is archived once the review step is done with it.

**Its verdict.**
- **ok** — no findings.
- **notes** — findings, attached to the landing.
- **blocking** — the entry waits for the user as **Review flagged**, with the findings, and
  doesn't land until the user chooses:
  - **Land Anyway** lands the tested commit without a rerun, noted "Landed over the review: …".
    When the target has moved since the run, it goes to the front of the line and is rerun
    without review first;
  - **Send Back** hands it to its chat with the findings, as a conflict's Send Back does.

**When the reviewer fails.** A reviewer that errs or passes its 20-minute limit is retried once,
after 60 seconds, then the queue pauses. No chat is told. The branch is never blamed for it.

**Skipping it.** "Land without review" (or "land it, skip review") skips it for that approval
only.

A verdict holds at most 10 findings, each of a kind: dead code, duplication, hack, missing test,
naming, or other. The kit is never a registered skill: it has no `SKILL.md`, and it is in no skills
folder or pi setting.

Sova's own first kit is simple: an ordinary code review that the branch adds no tech debt (dead
code, duplication, hacks or workarounds left in, missing tests for new behaviour, unclear names).

## §app.merge-queue/conflicts — When the branch conflicts with the target

A merge that conflicts is held in the copy, and the merge thread judges each conflict. A resolution
git recorded earlier is never applied silently, so the same conflict comes back to the thread every
time. A merge that fails with no unmerged paths left still counts as a conflict when git finds
conflicts between the two sides, never as a machine failure.

**No behaviour change.** Neighbouring edits, imports, formatting, both sides extending a list: the
thread resolves the conflict itself. The approval carries, and the full checks run on the
resolution. The landing's note says what it resolved and why it was safe.

Sova still checks the resolution mechanically:
- it changes only lines inside the conflict hunks;
- it changes no mode;
- it has no rename, binary or deleted file.

Anything outside that counts as behaviour that differs.

**The two sides want different behaviour.** The entry waits for the user as **Behaviour differs**.
It shows both sides in plain words and the thread's proposed resolution:
- **Accept** takes the resolution, and the checks run;
- **Send Back** hands the conflict to the branch's chat: its queue card moves down as Sent back,
  and a turn marked as coming from the merge queue starts there (§chat.merge-queue/chat-turns).

Accept needs a proposed resolution commit. A resolution the thread called no behaviour change also
needs its commit, and one that fails the mechanical check counts as behaviour that differs.

**A safe resolution that then fails a check** comes back to the user as Behaviour differs. The
branch is not blamed, and no chat is told.

**No thread.** With no thread the conflict goes back to the branch's chat at once, with the
conflicting files named; a thread that hasn't answered in 20 minutes hands it back the same way.
The queue moves on to the next entry meanwhile.

## §app.merge-queue/master-moved — The target moved outside the queue

Nothing refuses a commit made to the target from outside the queue: a hand commit, a release, or a
Settings change the operator applied. The queue notices it by comparing the target with the
landings it made.
- **With nothing in line** (no entry queued or checking), the move is simply taken and nothing
  pauses.
- **During a run**, the run is voided and the queue pauses: "master moved outside the queue ({old} →
  {new}) while {branch} was checking: that run was voided; resume once that is intended".
- **While Sova was stopped**, with entries in line, the queue starts paused the same way.

**Resume** accepts the new head, and waiting entries run on it.

Nothing inside Sova merges into the target of a project the queue serves (§app.merge-queue/served): `worktree merge` into it is refused
in a chat Sova runs (§chat.worktrees/tool), the project page's and a proposed run's Merge Branch read
Land (§app.project-overseer/coding-worktrees, §app.project-runtime/merge), and any other direct merge
of a coding branch into it, whoever asks, is refused: "{target} takes branches only through the
merge queue: Land the branch instead (nothing was merged)."

## §app.merge-queue/setup — A project not set up yet

A project on the Projects list with no checks declared and no test command isn't served by the
queue yet (§app.merge-queue/served): its chats merge plainly. Its Merge Queue tab says so in place
of the view, "No merge queue settings are set up for this project", with an **Initialize** button
(§app.merge-queue/view).
Initialize opens the onboarding screen. A repository that isn't on the list has no Merge Queue tab
and no setup. The onboarding offers three answers, and only the user gives them (`merge.setup`):
- **list its checks**, one "Label: command" per line;
- **give one test command**, with about how long it takes (its time limit is twice that, at most
  30 minutes) and what must start first;
- or say **it has no automated tests**, which it says once.

**Try It on {Target}** ("Try It on Master" or "Try It on Main"; with no tests, **Try the Merge
Copy**) runs the chosen checks on the target alone, in the merge copy, from setup on, with logs. It
merges nothing and saves nothing, and is refused while a landing run is using the merge copy ("a
run is using the merge copy now: try again when it ends"). A failure there is the project's own: "{why}: it fails on master
itself, so it is the project's setup to fix, not any branch's.", then "No branch was blamed. Fix it,
then try again.", with View Log.

After a pass, **Save Checks** writes the `merge` section into the definition on the target as one
commit, and the queue moves the target to it. The main folder is fast-forwarded, never forced. It is
refused when the main folder has uncommitted changes. A project with no `.sova/project.json` yet gets
a minimal one, `{version: 1, merge: {checks}}` with no services: Try It runs against it, and Save
creates it in that same commit (its subject ending "; new .sova/project.json"). A project that has
a definition gets only its `merge` section changed. The commit uses the repository's
identity, else "Sova merge queue". It counts as the queue's own: it raises no "moved outside" flag
and is pushed with the next landing, never on its own: until then the strip reads the remote's
commit with "not pushed yet: goes out with the next landing". From then on the queue serves the
project, and its branches land through it.

**A definition that doesn't parse is not "not set up".** Only a missing `.sova/project.json` (or one
declaring neither checks nor a test command) gets the onboarding. When the target's file is there but
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

The project page has a **Merge Queue** tab between Branches and Cost (§app.organizations/project-page),
at `#/projects/<pid>/merge-queue`. While the queue doesn't serve the project (a definition that
doesn't parse aside, which shows its error instead), the tab shows only its head, "Merge queue"
with a **Not set up** chip, and one banner: "No merge queue settings are set up for this project",
then "Until they are, its chats merge branches into {target} themselves when you ask.", with
**Initialize**, which opens the onboarding (§app.merge-queue/setup). For a project it serves, it
shows, top to bottom:

- **The strip**: the target at its commit, and the commit pushed to `origin`, with **Pushed**,
  **Not pushed** or **No remote**. Not pushed always carries one sentence: the queue's why ("Push
  held: private names not set up yet."), or, when the target is ahead of `origin` with no why given,
  "Not pushed yet: goes out with the next landing." When a check is red on the target alone, a line
  says so: "Red on {target} alone: {check}". Nothing about live state, and no Restart control.
- **The queue's head**: its state (Idle, Running, Paused, Not set up, Definition invalid), **Pause Queue** or **Resume
  Queue**, and **Open Merge Thread** when the project has one. The queue is described as "One branch
  at a time, in order. Each is merged onto {target} in a separate copy and checked there; {target}
  then moves to exactly that commit."
- **Paused**, when paused: the reason in plain words (by you; the target moved outside the queue;
  setup failed on the target itself, twice; the project folder has uncommitted edits; the reviewer failed twice; a landing in flight at a stop needs a look), the
  queue's own why, and Resume.
- **Checking now**: the branch, its commit and chat, "{target} {base} + this branch → testing {tip}",
  the current check ("check N of M") with a meter, when it started, how long it takes, how many
  checks the merge thread added, and **View Checks**.
- **Waiting**, in order, with when the last one should be done. Each entry shows its place as its
  state chip ("In line · 2"), its branch and commit, its chat, when it was approved and how (the Land button, or typed in its chat), its
  options (without review, without its specs), "starts in ~N min · takes ~N min", newer commits not
  included, and **Cancel Landing**.
- **Needs you**: entries waiting for the user, in full words:
  - **Behaviour differs · waiting for you**, with the target's side, the branch's side and the merge
    thread's proposal, and Accept and Send Back;
  - **Review flagged · waiting for you**, with Land Anyway and Send Back;
  - **Can't tell whose failure · waiting for you**, with the check that failed on both sides, its
    log, and Land Anyway and Send Back (§app.merge-queue/blame);
  - **Drafts changed since you approved**, with Land;
  - a **Conflict** while it is being judged.
- **Sent back to its chat**: entries that need a fix, with **See Why**.
- **Recent**: landings, each with a **Landed** chip, "Landed as {sha} · {when} · pushed" (or "not pushed: {why}"), "No checks
  declared" when so, every note, and **View Checks**.
- **Ready to land, not approved**: the project's worktree branches with commits the target hasn't, a
  clean tree, a head that isn't a temporary commit, and no entry in line or landed at that commit.
  Each shows its branch, commit, Ready chip, its chat, worktree and "{n} commits ahead · +{a} −{d}",
  and **Land** with the same menu as the modal's (Land Without Review, Land Without Its Specs…).
  Land there names no chat: the queue records the branch's owner by the same rule the row shows
  (§app.merge-queue/owner), so the chat the row shows is the one the queue records and tells.

**Every row's chat.** Every row of Checking now, Waiting, Needs you, Sent back, Recent and Ready to
land names its chat by title: a row in the line or landed names the chat its entry recorded; a
Ready row names the branch's owner (§app.merge-queue/owner). A click or tap anywhere on the row
outside its buttons, links and menus opens that chat; a click with a modifier key, or one that ends
a text selection, does nothing. The chat's title is also a real link to it, so it opens in a new
tab too, and it is never wrapped around the row's buttons. The chat opens whatever form its
recorded id takes (the link reaches the chat, never an empty "not found" view). An archived chat
still opens, with "archived" after its title. A row with no known chat reads "No chat found for
this worktree", opens nothing when tapped, and keeps its buttons.

**Review Changes on every row.** Every row of those sections has **Review Changes**, which opens
the changes viewer (§chat.changes/viewer) over the tab: a dialog, a full-height sheet on a phone,
closed with Close, Esc or the scrim, focus back on the button. It needs no chat, so a row with no
known chat has it too; when the row's chat is known, its turns become the viewer's steps, else the
viewer shows the files alone. What it compares, read by the server from the queue's own records
(§chat.changes/endpoint):
- **Ready to land**: the branch as it is now against its merge-base with the target it lands on;
  uncommitted files in its worktree, if any appeared since the row was listed, are included and
  marked as uncommitted;
- **Checking now, Waiting, Needs you and Sent back**: the commit that was approved, never a newer
  one on the branch, against its merge-base with the target;
- **Recent**: what that landing brought in, from the target before it to the landed commit.

**On a phone** (a screen narrower than 600px) the sections lose their outer card frame and inner
box: rows are split by hairlines, with 12px side padding. Each row stacks: the branch on its own
line, wrapping anywhere; a facts line led by the state chip, then the commit and "{n} commits ahead
· +{a} −{d}" (or the row's own facts); the chat line, where the worktree is named by its folder's
last name, with the full path as its `title`; and an actions line, Review Changes on the left and
Land ▾ (or the row's other actions) on the right, every control at least 44px tall. Nothing scrolls
sideways at 390px. Wider screens keep the actions at the row's end and show the full path. Nothing
is offered only on hover.

**The run page** (`…/merge-queue/<run>`) shows:
- the branch and its verdict, the base, the branch's commit and the tested commit, when it started
  and how long it took, its chat, and how it was approved;
- **View Logs** (every step's log, in order, from the copy's first line), **Open Merge Thread** and
  **Back to Queue**;
- "Nothing has merged from this run. {target} moves only once every check passes." while it runs,
  waits or conflicts, except on a run whose owner can't be told, where its own banner says it once;
- a verdict in plain words: the branch broke a check; the merge thread's resolution failed one (back
  to you, the branch not blamed); red on the target too, or flaky (noted, not blocking); can't tell
  whose failure it is ("Can't tell whose failure · waiting for you", with the checks that failed
  on both sides, Land Anyway and Send Back); stopped at a
  step, not the branch's fault (retried once, then paused, no chat told); stopped before it
  finished (nothing blamed); or passed, the target moved to exactly the tested commit;
- for a red run, a "Whose failure is it?" block (machine or setup, already failing on the target,
  flaky), drawn from the reruns (§app.merge-queue/blame);
- **Checks and why**: every step with its tag and reason, its failures, time and counts, and its log.

Every action here (Land, Cancel, Pause, Resume, Accept, Send Back, Land Anyway) is a catalogue
command over the merge verbs (§app.project-services/merge-verbs). The view follows the queue live,
from the session feed's merge-queue frames, at desktop and phone widths.

## §app.merge-queue/owner — Which chat owns a branch

One rule says which chat owns a worktree's branch, and Sova uses it everywhere the queue needs a
chat it wasn't told: the chat a Ready row names and opens (§app.merge-queue/view), and the chat an
approval records, hears about its outcomes and shows its queue card (§chat.merge-queue/chat-card).
The owner is, the first that holds:
1. the chat that created the worktree and still tracks it (its own record, not dropped;
   §chat/worktrees), when it isn't archived;
2. else the newest chat not archived working in the worktree's folder or inside it, a worker
   included;
3. else the same two, in that order, among archived chats, so the row shows it marked "archived";
4. else none: the row reads "No chat found for this worktree", and no chat gets a card.

So a worktree created by one chat, with a newer worker working inside it, belongs to the chat that
created it, and Land on its row with no chat named records and tells that chat.

Working out owners never rereads chats' transcripts each time the view is read: Sova keeps which
chat tracks which worktree, and updates it as those chats' worktree records change.
