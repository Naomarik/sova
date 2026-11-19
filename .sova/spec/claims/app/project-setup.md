# §app/project-setup — Setting a project up with a chat
> Part of the Sova design spec · [overview](../design/overview.md)

How a project's branches land, how it releases and how it ships are set up, and changed later, in
one place: the project's **Setup chat**. It is one standing chat per project, separate from the
merge thread (§chat.merge-queue/thread). It reads the project, asks the user only what the
project can't tell it, draws the plan, proves the proposed checks with a dry run on its own branch, and
proposes the whole setup (the merge queue's checks, the releases and the deploy targets) on that
branch for the user to land. It is the only way to set a project up: there is no form, and nothing
it does is saved until the user lands or merges its branch. It works for any project, whatever its
language, build, test runner, services, CI or hosting, Sova's own included.

The parts it sets up behave as their own claims say: the merge queue (§app/merge-queue), releases
(§app/release) and deploys (§app.project-services/deploy). The chat changes only what the project's
definition (`.sova/project.json`) and its playbooks say; it never changes how those behave.

## §app.project-setup/start — Set Up with a Chat, and Change Setup

**The empty states say what setting up means.** While a part isn't set up, its place says so in
plain words, then offers **Set Up with a Chat**:
- the Merge Queue tab (§app.merge-queue/view) and Settings → Merge Queue (§app.merge-queue/settings):
  what the queue does ("Every branch you approve is merged onto {target} in a separate copy and
  checked there; {target} then moves to exactly that commit.") and what setting it up changes
  ("Once it is set up, branches land here only through the queue.");
- the Releases tab (§app.release/tab): what a release is and that the setup proposes a release
  playbook and the `release` section on a branch to land;
- the Deploy tab's panel (§app.project-runtime/deploy-panel): that the setup asks how the
  project ships and proposes its deploy targets on a branch, running nothing.

**Change Setup.** Once a part is set up, the same places offer **Change Setup** instead: the Merge
Queue tab's head, Settings → Merge Queue's head, the Releases tab's head and the Deploy tab's panel. Every
project gets it, Sova's own included; a project whose every part is set up gets Change Setup only.

**One chat, opened, never doubled.** Set Up with a Chat and Change Setup start the project's Setup
chat when it has none, and otherwise open the one it has: a second press never starts a second chat.
They say which part the user came from, so the chat starts there. Settings → Merge Queue's button
closes Settings once the chat opens, never before, so a refusal stays readable where it was pressed. Each is a catalogue command over the route that does it (§app/commands).
Starting is refused, with the reason shown where the button is, when the project is archived, when
its folder isn't on this computer ("{name}'s folder is on {target}: setup runs only on a local
folder.", "{name}'s folder {root} is missing on this host."), and when no model for it is offered
(§app.project-setup/chat).

## §app.project-setup/chat — One standing Setup chat per project

Each project has at most one Setup chat, titled "Setup · {project}". It is an ordinary coding chat of
the project in a worktree of its own, started the way any of the project's coding chats is
(§app.project-overseer/coding-worktrees), listed with its other chats, never one of the merge queue's
own chats (§app.merge-queue/chats) and never a verb playbook's run: Sova keeps it per project, apart
from the software registry's run (§app.project-runtime/onboard). It keeps its memory across changes, so a later Change Setup carries on
from what it learned. It is replaced only by **Start Fresh…**, offered beside **Open Setup Chat**
wherever the chat shows: confirmed, the chat is archived and a new one starts; while the chat is
working it is refused ("The Setup chat is working: wait for its turn to end (or stop it), then Start
Fresh."). A setup branch with commits beyond the target stays: the new chat carries on in the same
worktree, setup branch and proposal, and is told the old chat's path. One with no commits beyond the
target ends with the old chat: its run ends and Sova removes the empty worktree and branch, and the
new chat starts on a new setup branch. Archiving the Setup chat any other way does the same: with
no commits beyond the target its run ends and the empty worktree and branch are removed; with commits,
the branch and its proposal stay, and the next Set Up with a Chat or Change Setup starts a new chat on
that same branch and proposal, never refusing it as already running. No path leaves the user to
remove a worktree by hand. An archived Setup chat, current or replaced, lists nothing in Needs you,
not even a failed turn or worker (§app.overseer/attention-digest); an open one's failures still show.

**Its model** is the one the project's setup asks for, else claude-code's current Opus in Sova's
catalog (`claude-opus-5-5`) when this computer offers it, else openai-codex `gpt-6-astra`, each at
medium thinking, the same choice a verb playbook's run makes (§app.project-runtime/onboard). Release setup and
deploy setup are never started on their own: `verbs/onboard` naming either opens this chat, and the
Playbooks dialog and every other list of playbooks leave them out (§app.release/maker,
§app.project-runtime/deploy-playbook). With none of them
offered, nothing starts: "No model for the Setup chat: this host offers neither Claude Code Opus 5.5
nor openai-codex gpt-6-astra. Pick a model to run it with."

**Full coding access, in its own copy.** The chat works in a worktree of its own, on a setup branch
cut from the target's newest commit, with every coding tool an ordinary project chat has: it reads
anything, runs the project's own commands (installs, builds, tests, its services through the
project verbs) and edits files there. It never touches the main checkout or its running processes.
Once its branch lands or merges, or its worktree is removed, its next change starts a new setup
branch from the target's newest commit. It starts in the normal mode with align and vis on (vis to draw
the plan, §app.project-setup/drawing) and no other minor mode, whatever this computer's default modes
are, so the spec minor mode is off: setting up the
pipeline is configuration, not a change to the product.
A chat Start Fresh starts gets the same modes before its first message.

**One open proposal.** The project has at most one setup branch proposed at a time
(§app.project-setup/proposal); a new change continues on that branch until it lands, merges or is
removed. The Setup chat never holds up the project's verb playbooks: a Project verbs run
(§app.project-runtime/playbook) proceeds alongside it, and neither refuses the other as already
running.

## §app.project-setup/context — What the chat knows when it starts

Its first message is Sova's setup playbook (`playbooks/project-setup/`, §chat.playbooks), then which
part the user came from. The playbook has it read the project's own setup notes when the project
has them (its `.sova/playbooks/project-setup/PLAYBOOK.md`), which win where the two differ, never
over what the chat may not do (§app.project-setup/trust). The playbook gives it the whole
picture before it reads a file:
- what every part of `.sova/project.json` means and what it accepts: services and data, test,
  `merge`, `release`, `deploy`, `host`, `share` and the rest (§app.project-services/contract);
- how the merge queue, releases and deploys behave and what each refuses: checks read from the
  target's copy, blame, the frozen queue, Publish and Withdraw, plans and confirms;
- a guide to investigating any project without assuming a stack: which files say how it builds,
  tests and runs (manifests, task files, scripts, compose and container files, CI workflows), its
  version tags, changelogs and release scripts, and where it is hosted (a server reached over ssh,
  containers, a hosting platform, a static host, an app store, or none);
- what it may and may not do (§app.project-setup/trust).

## §app.project-setup/investigate — It investigates first, and asks what it can't find

Before it proposes anything, the chat reads the project: its test and build commands and how long
each takes (by running them in its own copy), the services they need (a database, a queue, a
browser), its CI, its version tags, files holding a version, its changelog, its release scripts and
tag-triggered automation, its remotes and where it is hosted. On a project already set up it reads
the current setup from the target's head first.

It asks the user only what the project can't tell it, as alignment questions, each with the answer
it suggests and why (§chat.alignment/tool), and waits for the answers rather than guess. The release
half asks what Set Up Releases asked (the version rule, the notes and their audience, the channels,
each step in order and who does it, release-only checks, a live try-out, after-publish steps, where
built files go; §app.release/maker); the deploy half asks what the Project deploy playbook asked
(each target, its branch, its exact commands, host value names, credential names and their
read-only checks, verify, rollback; §app.project-runtime/deploy-playbook). A part the user doesn't
want (no releases, no deploy) is left out, and the chat says so.

## §app.project-setup/drawing — The plan, drawn before it is written

Before writing the proposal, the chat draws the plan in the chat (a `vis` drawing,
§chat.markdown/visuals), in three parts:
- **each approved branch**: what happens to it, from approval to landing, with the real commands of
  each check, its time limit, what starts first, and how it lands;
- **each release step**, in order, marked **Sova**, **Before Publish**, **After Publish** or **Held
  for you**;
- **each deploy target**: its steps, its verify and its rollback.

On a project already set up, its first message draws the current setup the same way, read from the
target's head. A Change Setup redraws the plan with what changes marked.

## §app.project-setup/trial — Dry runs of a setup branch

A **dry run** proves a setup branch's new or changed checks on its exact commit before they judge
every branch after it. A landing is checked with the target's merge checks, never the branch's own,
so a branch can't weaken the checks that judge it (§app.merge-queue/checks); the flip side is that a
check a branch adds or changes never runs while it lands. A setup branch (§app.project-setup/land-gate)
therefore needs a dry run of its head commit that passed before it lands. A dry run merges nothing,
saves nothing and moves no branch, on every project the queue serves and on a listed project it
doesn't serve yet. Every word a person or a chat reads calls it a **dry run**, never a trial: the
screens, the chips and buttons, the run page, the docs, the queue's requests and wake notes to chats,
and readiness's lines (§design.copy-deck/merge-queue); internal names (`merge.try`) may stay.

**Why it is needed, always said.** Wherever a dry run is needed, running or ended, its reason is said
with it, read from what the branch's setup change is against the target: "adds the merge check
{label}", "changes the merge check {label}", "removes the merge check {label}", "changes the release
check {label}", "changes the release step {label}", "changes the release playbook", "changes the merge
settings", "changes the deploy target {name}", or "changes the service {name} a merge check needs".
With several changes the first is named, then "and {n} more", and every one shows in its hover and
on the run page (§app.merge-queue/dry-runs).

**Who starts one.** A dry run starts by:
- **Land** on a setup branch with no passing dry run of its head, which runs it first and then lands
  by itself (§app.project-setup/land-gate);
- **Run Dry Run** (or **Run Dry Run Again**) on the branch's row, the operator's own click
  (§app.merge-queue/dry-runs), and on the Setup chat's proposal (§app.project-setup/proposal);
- **`merge.try`** (a branch or a commit), from any chat of the project, for its own project only;
  naming neither, it dry-runs the chat's own branch (its one worktree in the project), and asks which
  when the chat has several ("name the branch to dry-run: this chat has {n} worktrees"). The Overseers and the merge thread may not: they would take the merge copy
  away from landings on their own.

**What it runs.** It checks out that commit in the project's merge copy (§app.merge-queue/run) and
runs, from setup on and with logs:
- the project's setup steps, always;
- the branch's own spec drafts, made into docs in the copy before any check: the same Docs step a
  landing runs (§app.merge-queue/run), with the drafts as they stand when the dry run starts;
- the merge checks the branch's own `.sova/project.json` declares that are **new or changed** against
  the target's (a check id the target doesn't have, or one whose argument list, time limit, rerun
  rule or required services differ), and any check whose required service the branch adds or changes
  (§app.project-setup/land-gate), with the services they require started from the branch's definition
  in the copy's own slot, so a script or service the branch adds is part of the dry run;
- the release-only checks its `release` section declares (§app.release/settings) that are new or
  changed against the target's, or that the chat or the operator names for this dry run.

Every other check shows as **Not run (unchanged)**: it runs again in the landing, on the branch merged
with the newest target, so nothing goes unchecked and a dry run stays short. A branch whose setup
change touches no check (a deploy target or the release playbook alone) runs its setup steps only,
and passes when they do; so does a commit that declares no merge checks ("no automated tests"). A dry
run runs no install step and no review, and never a tag, push, publish, release step or deploy step:
those are only drawn (§app.project-setup/drawing). Each check it runs runs as
though every file in the commit changed and the merge thread had picked it, so none skips itself for
its paths or for not being picked, and runs fresh (§app.merge-queue/checks).
A dry run names no selection: an optional check that takes one (§app.merge-queue/checks) runs with
none, and either works out for itself what this branch calls for or says "skipped" and why; it
never fails for lack of one. Sova's **Slow test group** runs the slow groups a landing would
run for the branch's changes against the target (its files changed since the merge base,
§app.server-runtime/slow-groups), and reads "Slow test group · skipped: no slow group applies to
this branch's changes" when there are none; a skipped check doesn't fail the dry run.
A commit with no valid `.sova/project.json` is refused (`invalid-request`), and so is a check named
for the dry run that the commit doesn't declare.

**The spec as it will be.** Because the drafts are made into docs first, a spec check the dry run
runs (Sova's Spec check, or No new spec findings) judges the spec as it will be once the branch
lands, never the target's spec without them. The docs exist only in the merge copy: the dry run
saves, promotes, publishes and lands nothing, keeps no spec commit, and leaves the branch's drafts
as drafts. A branch with no drafts of its own, or a project with no spec, skips the step and says
so, as a landing does ("no spec drafts of the branch's own"). Drafts that don't fit fail the dry
run there, before any check, as the branch's own failure, with the reason a landing would give;
fixing them in the drafts needs no commit, and Run Dry Run Again checks them at the same commit.

**Whose failure it is, as a landing tells it.** A check that fails is run once more on the commit, and
one that passes then counts as flaky, not failed. One that fails again, when the target also declares
a check with that id, is run on the target's newest commit alone, in the same copy, with the target's
own definition of it, by the landing's rules (§app.merge-queue/blame): failures the target doesn't
have are the branch's ("This branch's change breaks it"). A failure the target shares is never noted
and passed over: the dry run stops and asks the user, as a landing that can't place a failure does
(§app.merge-queue/needs-user), its line "Fails on {target} too: not this branch's", with **Fix**,
**Fix in New Chat** and **Run Dry Run Again**, and **Land Anyway** in the ▾ menu (the dry run counts as
passed for that commit: a standing Land goes on, and with none it is the user's Land of that commit)
(§app.merge-queue/fix); its chat is not told to fix it. When a Land waits on it, it waits in the Merge
Queue tab's Needs you, with one notification. And when it can't be told, the dry
run waits for the user as Can't tell whose failure, with **Land Anyway** (the dry run counts as passed
for that commit, and a standing Land goes on), **Try Again** (a new dry run of the same commit) and
**Fix in New Chat** (§app.merge-queue/fix). A check the target doesn't have is the branch's alone.
Setup failing on the commit and on the target too is the machine's: the dry run ends **Couldn't run**,
blames nobody and pauses nothing. No dry run pauses the queue or counts a try.

**One at a time, with the landings.** The queue and dry runs share the merge copy one at a time: a
running dry run counts as using it, landings that come due wait for it, and the queue's view says so
(§app.merge-queue/dry-runs). A chat's `merge.try` of a branch while a landing, a run or another dry
run uses the copy, or while a release holds the queue, waits its turn the same way (one waiting dry
run per branch); only one naming a commit alone is refused (`busy`, "a landing or a dry run is using
the merge copy now: try again when it ends (name the branch to have it wait its turn)"). The
operator's **Run Dry Run** (or **Run Dry Run Again**)
is never refused for it, and its button is never a dead disabled one: the dry run waits its turn and
starts by itself once the copy is free, reading "Dry run waiting · starts after {what holds the
copy}" ("the landing of {branch}", "the dry run of {branch}", "release {tag}") on the Merge Queue
tab's Waiting and the branch's rows (§app.merge-queue/dry-runs), with **Stop Dry Run**, which cancels
it while it waits: nothing ran, nothing is blamed, and the branch reads as it did before. When the
copy is free, a waiting dry run whose branch moved on starts at the branch's **newest commit**, never
the older one it was asked for, as long as that commit still needs one by the land gate's rule
(§app.project-setup/land-gate; one asked of a commit that needed none runs at the head all the same).
Otherwise it is dropped, nothing runs, and the chat that asked for it is told why it won't start:
"The dry run of {branch} at {sha7} that waited for the merge copy won't start: {why}. Nothing ran and
nothing failed.", {why} being "the branch is gone", "the branch moved to {sha7}, a commit that
doesn't follow it", "the branch moved on to {sha7}, which needs no dry run", or the error that kept
it from starting. The same note, with its own {why}, tells that chat when the user stopped it before
it started, or a Land took it over. A dry run a
Land started waits its turn in the line too (§app.project-setup/land-gate). A Land never races a
dry run: when a dry run of the same commit is already waiting or running, the Land waits for it and
takes its result; and a `merge.try` of a commit whose Land- or Run Dry Run-started dry run is waiting
or running answers with that dry run, starting no second one.

**Stop Dry Run.** A running dry run can be stopped (a waiting one, cancelled, above): by the
operator, with **Stop Dry Run** on the Merge Queue tab's Checking now and on its run page, and by the chat that started it, with a merge
verb of its own (§app.project-services/merge-verbs). Stopping frees the merge copy at once: the run
stops, the copy is reset, nothing is blamed, and the next landing in line starts. The dry run ends
**Stopped**, "stopped by you" (or "by {chat}"), and the branch needs a new one: its row offers Run
Dry Run Again, never "fix it". A Land waiting on a stopped dry run still stands, waiting: Run Dry Run
Again starts it again and the Land goes on from there, and Remove from Queue takes it back. The chat
that started a stopped dry run, and the branch's chat, are told: "The dry run of {branch} at {sha7}
was stopped by you: nothing failed. It needs a new dry run before it lands."

**A restart stops it.** A dry run is running only while the server runs it: when Sova starts, any dry
run its records still call running, and its run's record too, reads **Stopped**, "stopped by a Sova
restart", never Running. One a standing Land waits on starts again by itself when its turn comes, as
a voided landing run is rerun (§app.merge-queue/pausing); any other shows Run Dry Run Again.

**When it ends.** `merge.try` answers at once with the dry run and its run, and the dry run goes on by
itself. When it ends, the chat that started it, and the branch's chat when a Land is waiting on it,
are woken with its result: "The dry run of {branch} at {sha7} passed" (or "failed: {check} · {whose}",
"was stopped by {who}: nothing failed", "couldn't run: {why}: the machine, not this branch"), then one
line per check it ran with its result, its time and how to read its log, so the chat ends its turn
rather than wait; a step the stop or the restart cut off reads "stopped", never "failed". A pass a
Land waits on says the user's Land stands and it lands by itself: "The user's Land stands: {branch}
at {sha7} lands now by itself; nothing to do. Never ask them to land it."; a pass with no Land says
Land is offered at that exact commit. A dry run with no Land behind it reaches its chat as a plain
note, never a request: it ends "This is a note, not a request: there is nothing to answer with
merge.respond. Tell your user what it found and end your turn; change nothing for it unless they
ask." A dry run a restart stopped is told to the chat that started it once, by the next server, a
normal restart included. A failure the branch's change causes goes back to its chat by itself only while a
Land stands on it (§app.merge-queue/send-back); it is never told to fix a failure the target shares,
one that can't be told, a stopped dry run or a machine's. Sova keeps the project's newest 20 dry runs,
listed on the Merge Queue tab's Dry runs tab (§app.merge-queue/dry-runs). Each dry run's result shows
on the branch's rows, on the Merge Queue tab and on the Setup chat's proposal
(§app.project-setup/proposal): the commit it ran on, who started it, its result, each check's result,
time and **View Log**, and **View Checks** (its run page).

## §app.project-setup/proposal — The proposal, on a branch

The chat writes its proposal on its setup branch and commits it there: the `merge`, `release` and
`deploy` sections of `.sova/project.json` and the names in `host`, the project's release playbook
folder, and any script or service the checks need. Every line traces to what it read or to the
user's answer. It checks its own work before proposing: its driver's `check` (the definition's
parser, the merge checks' lints, the release setup's and the deploy recipe's checks), `deploy.check`,
and dry runs (§app.project-setup/trial).

While a setup branch is proposed, the Merge Queue tab, the Releases tab and the Deploy card show
what it proposes, read by Sova from the branch's files at its head, never from the chat's words: the
queue's settings and each check, the release settings and
each step with its phase, each deploy target's steps, what changes against the current setup, and
the newest dry run of that head (its result, who started it and why it was needed), with **Run Dry
Run** (or **Run Dry Run Again**) while none of the head passed. Under **What it brings in** it lists every file the branch changes
against its target ("Changes {n} files against {target}"), the setup's own files first; any other
file is marked **Outside the setup**, with "{n} outside the setup, which Land (or Merge Branch)
brings in too.", so nothing lands unseen. **Review Changes** shows the branch in full
(§chat.changes/viewer). Each shows **Land** (on a project the queue serves) or **Merge
Branch** (on one it doesn't), **Read Report** (the chat's report) and **Open Setup Chat**. While a
setup branch is proposed (it has commits beyond the target and the current Setup chat runs no turn;
an archived chat's open questions never hold it), the project page
shows a banner on every tab, "Project setup proposes the project's setup on {branch}." (the same title
as the Needs-you item and push), with "Read it
before it reaches {target}." while a dry run of its head is needed, then "Read it, then land it: it's
checked on {target} first." (served) or "Read it, then merge it into {target}." (not served), and
**Read Report** and the card's button; and the Setup chat has a Needs-you item and a push, labelled
"Project setup", with the same button (§app.project-runtime/review). Land answers "Queued {branch} to
land on {target}.", Merge Branch "Merged the setup into {target}."

Landing or merging it is the user's alone. Land and Merge Branch on a setup proposal record the
operator's approval of the exact commit shown, refused when the proposed setup changed since it was
shown ("The proposed setup changed since it was shown: look again."), when the branch has a newer
commit ("The branch has a newer commit than the one shown: look again."); Land on a head with no
passing dry run runs one first, and Merge Branch refuses it (§app.project-setup/land-gate). On a project the queue serves, the approval
lands through the queue, which checks the branch with the target's current checks
(§app.merge-queue/checks), and its new checks take effect once it lands; on one it doesn't serve, it
merges the branch into the target, and from then on the queue serves the project. Sova never moves
the target itself for it. Only the operator can do it, from their own page on this computer: it is
refused to every chat, both Overseers and any script ("Only the user merges the Setup chat's
proposal. Ask them to press Merge Branch or Land on its card. Nothing was merged."). The user's own
"land it" typed in the Setup chat approves that exact head as on any branch, through `worktree land`
and the queue, on a project the queue serves (§chat.worktrees/landing-answers), running a dry run of
the head first when none passed (§app.project-setup/land-gate). On a project it
doesn't serve, no chat merges a setup branch on any word, the Setup chat's or any other's: `worktree
land` and `worktree merge` refuse it by the land gate's rule, the same rule the queue uses: "This branch
changes the project's setup: press Merge Branch on its Setup card, which needs a passing dry run first.
Nothing was merged.", and refuse too when Git can't tell (§chat.worktrees/tool).

## §app.project-setup/land-gate — Land runs a dry run first on a setup branch

A **setup branch** is any branch of the project whose changes since its merge base with the target
touch the `merge`, `release` or `deploy` sections of `.sova/project.json`, or files in the release
playbook folder (the one `release.playbook` names, read from both the branch's and the target's
definition, and `.sova/playbooks/release/`), or
that add, remove or change a service a merge check requires (in the branch's merge section or the
target's): the Setup chat's, and any other chat's that changes the same things. A branch that changes
only other services is not one: conformance covers it (§app.project-services/conform). It
lands, or is merged, only once a dry run of its exact head commit passed
(§app.project-setup/trial), since the queue checks a branch with the target's checks, not the
branch's. A newer commit on the branch needs a new dry run.

**Land runs the dry run first, then lands by itself.** Land on a setup branch whose head has no
passing dry run is taken, never refused for it: one press, as on any branch. Land on the tabs, the
banner, the Needs-you row, the Worktrees rows, a typed "land it" and `merge.add` each take it the same
way. The approval joins the line as any does (§app.merge-queue/approve), reading **Approved · dry run
first** with its place; at its turn its dry run runs, and on a pass its landing run follows at once,
with no second press. A dry run that fails on the branch's own change sends it back to its chat with
the user's Land standing, as a failed landing check does (§app.merge-queue/send-back); one that can't
tell whose failure it is waits for the user (§app.project-setup/trial); one stopped waits as stopped.
Land's confirmation says so: "A dry run of {sha} runs first: {why}. Once it passes, it lands by
itself." (§chat.composer/land-confirm). A branch whose head already passed a dry run lands as any
branch; one whose dry run of the head is running waits for it. One with nothing left and no draft to
land is refused first, as nothing to land (§app.merge-queue/approve), and is never offered a dry run.

**Merge Branch** (a project the queue doesn't serve yet: the Setup chat's first setup) has no line to
wait in, so its proposal offers **Run Dry Run** in Merge Branch's place, with "Run a dry run of {sha7}
first: it merges only once its new checks pass." until one of its head passed; Merge Branch refuses a
head with no passing dry run ("This setup branch has no passing dry run at {sha7}: run one first.", or
that its dry run is still running, or failed), merging nothing. It checks the dry run against the head
it actually merges, and refuses when the branch's head moved since the proposal was read ("The branch
has a newer commit than the one shown: look again.").

When Sova can't read the dry run record, Land and Merge Branch refuse ("Sova can't confirm a passing
dry run of this branch now: try again in a moment."), and so they do when Git can't read either
definition to tell whether the branch is a setup branch ("Sova can't tell whether this branch changes
the project's setup: try again in a moment."), never letting the branch through. The chat is never
told to start its own dry run before Land: its Ready to land reading offers Land, saying the dry run
comes first and why (§chat.worktrees/ready-to-land).

## §app.project-setup/trust — What the Setup chat may and may not do

The Setup chat may:
- read and edit anything in its own worktree, and run the project's commands there;
- use the project verbs on its own copies, as any project chat with the tool does
  (§app.project-services/callers); it is always offered the tool (§app.project-services/tool-offered);
- start dry runs with `merge.try`, for its own project only, and stop one it started;
- read the queue, releases and deploys (`merge.status`, `merge.logs`, `release.status`,
  `deploy.status`, `deploy.logs`) and prove a recipe offline with `deploy.check`;
- ask the user with align.

It may never land, approve, push, tag, publish, start a release or deploy. It is refused, as every
chat is:
- `merge.setup`, whatever its options, its Test run of the checks included, and from a chat's script on the
  operator's route too: it stays the operator's, from their own page, and answers "only the user
  saves the checks, from their own page: a chat proposes the setup on its branch and runs a dry
  run with merge.try" (§app.project-services/merge-verbs);
- `merge.add` and every other user's merge verb; `release.start`, `release.publish` and the other
  release verbs that act (§app.release/callers); `deploy.plan`, `deploy.run`, `deploy.rollback`
  and `deploy.request` (§app.project-services/deploy-callers);
- a merge into the target, and a push.

Its playbook says the same, and says it never commits outside its setup branch.

## §app.project-setup/sova — Sova's own setup

Sova's own project is already set up, so it shows Change Setup only. Its Setup chat's first message
draws Sova's current queue, release and deploy setup from the target's head
(§app.project-setup/drawing), and a change goes through the same branch, dry run and Land as any
project's. It is how Sova's own pipeline settings are changed beyond the values Settings → Merge
Queue saves (§app.merge-queue/settings-save).
