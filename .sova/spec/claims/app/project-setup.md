# §app/project-setup — Setting a project up with a chat
> Part of the Sova design spec · [overview](../design/overview.md)

How a project's branches land, how it releases and how it ships are set up, and changed later, in
one place: the project's **Setup chat**. It is one standing chat per project, separate from the
merge thread (§chat.merge-queue/thread). It reads the project, asks the user only what the
project can't tell it, draws the plan, tries the proposed checks for real on its own branch, and
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
- the Overview's Deploy card (§app.project-runtime/deploy-panel): that the setup asks how the
  project ships and proposes its deploy targets on a branch, running nothing.

**Change Setup.** Once a part is set up, the same places offer **Change Setup** instead: the Merge
Queue tab's head, Settings → Merge Queue's head, the Releases tab's head and the Deploy card. Every
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

## §app.project-setup/trial — Trial runs of the proposal

The chat may try its proposal for real, on its own, with **`merge.try`** (a branch, by default its
own, or a commit). Any chat may try a commit of its own project, and the operator may too; the
Overseers may not. A trial checks out that commit in the project's merge copy
(§app.merge-queue/run) and runs, from setup on and with logs:
- the merge checks the branch's own `.sova/project.json` declares (each one, optional ones
  included), with the services they require started from the branch's definition in the copy's own
  slot, so a script or service the branch adds is part of the trial;
- the release-only checks its `release` section declares (§app.release/settings), but only those
  that are new or changed against the target's, or that the chat or the operator names for this
  trial; the others show as Not run (unchanged), so a trial stays short enough not to hold landings for
  long.

A trial runs no install step, no review and no spec docs step. A check that fails is run once more,
and one that passes then counts as flaky, not failed. Each check runs as though every file in the
commit changed and the merge thread had picked it, so no check skips itself for its paths or for
not being picked: each runs in full.
A commit with no valid `.sova/project.json` is refused (`invalid-request`), and so is a check named
for the trial that the commit doesn't declare. A commit that declares no merge checks is tried as
"no automated tests": the copy and its setup run, and the trial passes when they do. A trial merges nothing, saves nothing and moves no branch. It never runs a tag, push, publish, release step or deploy step: those
are only drawn (§app.project-setup/drawing).

The queue and the trials share the merge copy one at a time: a trial is refused (`busy`) while a
landing, a run or another trial uses it, or while a release holds the queue ("a landing or a run is
using the merge copy now: try again when it ends"), and a landing that comes due while a trial runs
waits for it to end. It works on a
listed project the queue doesn't serve yet as well. A failure is the setup's own, never a branch's: no branch is
blamed and nothing pauses.

`merge.try` answers at once with the trial and its run, and the trial goes on by itself. When a
trial a chat started ends, that chat is woken with its result: "The trial of {branch} at {sha7}
passed" (or "did not pass ({why})"), then one line per check with its result, its time and how to
read its log, so the chat ends its turn rather than wait. Sova keeps the project's newest 20 trials.
Each trial's result shows in the chat and on the proposal (§app.project-setup/proposal): the commit
it tried, passed or failed, each check's result and time, and **View Log**. The operator can start
one too, with **Run Trial** on the proposal.

## §app.project-setup/proposal — The proposal, on a branch

The chat writes its proposal on its setup branch and commits it there: the `merge`, `release` and
`deploy` sections of `.sova/project.json` and the names in `host`, the project's release playbook
folder, and any script or service the checks need. Every line traces to what it read or to the
user's answer. It checks its own work before proposing: its driver's `check` (the definition's
parser, the merge checks' lints, the release setup's and the deploy recipe's checks), `deploy.check`,
and trials (§app.project-setup/trial).

While a setup branch is proposed, the Merge Queue tab, the Releases tab and the Deploy card show
what it proposes, read by Sova from the branch's files at its head, never from the chat's words: the
queue's settings and each check, the release settings and
each step with its phase, each deploy target's steps, what changes against the current setup, and
the newest trial of that head. Under **What it brings in** it lists every file the branch changes
against its target ("Changes {n} files against {target}"), the setup's own files first; any other
file is marked **Outside the setup**, with "{n} outside the setup, which Land (or Merge Branch)
brings in too.", so nothing lands unseen. **Review Changes** shows the branch in full
(§chat.changes/viewer). Each shows **Land** (on a project the queue serves) or **Merge
Branch** (on one it doesn't), **Read Report** (the chat's report) and **Open Setup Chat**. While a
setup branch is proposed (it has commits beyond the target and the current Setup chat runs no turn;
an archived chat's open questions never hold it), the project page
shows a banner on every tab, "Project setup proposes the project's setup on {branch}." (the same title
as the Needs-you item and push), with "Read it
before it reaches {target}." while a trial of its head is needed, then "Read it, then land it: it's
checked on {target} first." (served) or "Read it, then merge it into {target}." (not served), and
**Read Report** and the card's button; and the Setup chat has a Needs-you item and a push, labelled
"Project setup", with the same button (§app.project-runtime/review). Land answers "Queued {branch} to
land on {target}.", Merge Branch "Merged the setup into {target}."

Landing or merging it is the user's alone. Land and Merge Branch on a setup proposal record the
operator's approval of the exact commit shown, refused when the proposed setup changed since it was
shown ("The proposed setup changed since it was shown: look again."), when the branch has a newer
commit ("The branch has a newer commit than the one shown: look again.") or when no passing trial of
that commit is known (§app.project-setup/land-gate). On a project the queue serves, the approval
lands through the queue, which checks the branch with the target's current checks
(§app.merge-queue/checks), and its new checks take effect once it lands; on one it doesn't serve, it
merges the branch into the target, and from then on the queue serves the project. Sova never moves
the target itself for it. Only the operator can do it, from their own page on this computer: it is
refused to every chat, both Overseers and any script ("Only the user merges the Setup chat's
proposal. Ask them to press Merge Branch or Land on its card. Nothing was merged."). The user's own
"land it" typed in the Setup chat approves that exact head as on any branch, through `worktree land`
and the queue, on a project the queue serves (§chat.worktrees/landing-answers), refused with the
land gate's words without a passing trial of the head (§app.project-setup/land-gate). On a project it
doesn't serve, no chat merges a setup branch on any word, the Setup chat's or any other's: `worktree
land` and `worktree merge` refuse it by the land gate's rule, the same rule the queue uses: "This branch
changes the project's setup: press Merge Branch on its Setup card, which needs a passing trial first.
Nothing was merged.", and refuse too when Git can't tell (§chat.worktrees/tool).

## §app.project-setup/land-gate — Land only after a passing trial of that commit

A **setup branch** is any branch of the project whose changes since its merge base with the target
touch the `merge`, `release` or `deploy` sections of `.sova/project.json`, or files in the release
playbook folder (the one `release.playbook` names, read from both the branch's and the target's
definition, and `.sova/playbooks/release/`), or
that add, remove or change a service a merge check requires (in the branch's merge section or the
target's): the Setup chat's, and any other chat's that changes the same things. A branch that changes
only other services is not one: conformance covers it (§app.project-services/conform). It
can be landed or merged only once a trial of its exact head commit passed
(§app.project-setup/trial), since the queue checks a branch with the target's checks, not the
branch's. Until then the proposal offers **Run Trial** in Land's (or Merge Branch's) place, with
"Run a trial of {sha7} first: it lands only once its own checks pass." A newer commit on the branch
needs a new trial. Every way in asks the same rule: Land on the tabs, the banner, the Needs-you row,
the Worktrees rows, a typed "land it", `merge.add` and Merge Branch each refuse a setup branch whose
head has no passing trial (one with nothing left and no draft to land is refused first, as nothing to
land, §app.merge-queue/approve, and is never told to run a trial), with "This setup branch has no passing trial at {sha7}: run a trial of
it first." (or that its trial is still running, or failed), queueing and merging nothing. Merge
Branch checks the trial against the head it actually merges, and refuses when the branch's head moved
since the proposal was read ("The branch has a newer commit than the one shown: look again."). When
Sova can't read the trial record, the gate refuses too ("Sova can't confirm a passing trial of this
branch now: try again in a moment."), and so it does when Git can't read either definition to tell
whether the branch is a setup branch ("Sova can't tell whether this branch changes the project's
setup: try again in a moment."), never letting the branch through. Its Ready to
land reading offers no Land meanwhile, and its note names the missing trial
(§chat.worktrees/ready-to-land).

## §app.project-setup/trust — What the Setup chat may and may not do

The Setup chat may:
- read and edit anything in its own worktree, and run the project's commands there;
- use the project verbs on its own copies, as any project chat with the tool does
  (§app.project-services/callers); it is always offered the tool (§app.project-services/tool-offered);
- start trials with `merge.try`, for its own project only;
- read the queue, releases and deploys (`merge.status`, `merge.logs`, `release.status`,
  `deploy.status`, `deploy.logs`) and prove a recipe offline with `deploy.check`;
- ask the user with align.

It may never land, approve, push, tag, publish, start a release or deploy. It is refused, as every
chat is:
- `merge.setup`, whatever its options, a dry run included, and from a chat's script on the
  operator's route too: it stays the operator's, from their own page, and answers "only the user
  saves the checks, from their own page: a chat proposes the setup on its branch and runs a trial
  with merge.try" (§app.project-services/merge-verbs);
- `merge.add` and every other user's merge verb; `release.start`, `release.publish` and the other
  release verbs that act (§app.release/callers); `deploy.plan`, `deploy.run`, `deploy.rollback`
  and `deploy.request` (§app.project-services/deploy-callers);
- a merge into the target, and a push.

Its playbook says the same, and says it never commits outside its setup branch.

## §app.project-setup/sova — Sova's own setup

Sova's own project is already set up, so it shows Change Setup only. Its Setup chat's first message
draws Sova's current queue, release and deploy setup from the target's head
(§app.project-setup/drawing), and a change goes through the same branch, trial and Land as any
project's. It is how Sova's own pipeline settings are changed beyond the values Settings → Merge
Queue saves (§app.merge-queue/settings-save).
