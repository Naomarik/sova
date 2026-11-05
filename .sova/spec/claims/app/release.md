# §app/release — Releases

> Part of the Sova design spec · [overview](../design/overview.md)

A **release** cuts and publishes a numbered version of a project (`v0.10.0`): a name that others pull
(the installer's channel, update checks, a release page) and that is never moved or deleted once it is
public. Releasing is a project action of its own, after Landing, for any project, Sova's own included.
It is not a deploy: a deploy runs a version on a place the operator operates and can be redone or
rolled back (§app.project-services/deploy); a release can be deployed afterwards, by hand-off
(§app.release/deploy).

The work is split two ways:
- **The project's release playbook does the work** and reports each step: picking the number,
  writing the notes, bumping files, making the release commit, a live try-out, after-publish steps
  such as a release page. A chat Sova starts for the release, the **release chat**, follows it
  (§app.release/start) and reports through its own tool (§app.release/steps).
- **Sova holds what can't be undone**: the frozen merge queue (§app.release/checks), the gating
  checks, Publish (§app.release/publish), Withdraw (§app.release/withdraw), the release power
  (§app.release/power) and the record of every release, shown on the project page's **Releases** tab
  (§app.release/tab).

Releases are off until someone sets them up for the project (§app.release/settings), as the merge
queue is. Wire shapes are in `shared/release.ts` (the record, steps, view and manifest) and
`shared/project-contract.ts` (the `release` section and the `release.*` verbs); the server side is
`server/project-services/release.ts` and the queue's release methods in `server/merge-queue/`.

## §app.release/settings — The `release` section of `.sova/project.json`

A project's definition (§app.project-services/contract) may declare `release`, parsed as strictly as
the rest of the file (an unknown key or a wrong value makes the whole file invalid, naming its path).
Absent, the project's releases **aren't set up**: nothing starts a release, and the Releases tab says
how to set them up (§app.release/tab). The section is outside the definition's hash, like `merge` and
`deploy`, and Sova reads it from the merge queue target's tip, as the queue reads `merge`, never from a
working tree. It holds a pointer to the playbook plus only the facts Sova acts on itself, so playbook
wording can never change what Publish pushes:

- `playbook` (required): the folder of the project's release playbook, relative to the checkout,
  never the checkout itself; it holds the manifest `release.json` (§app.release/manifest).
- `tag` (default `v${version}`): the numbered tag's pattern, holding `${version}` exactly once and no
  other variable, and making a valid tag name.
- `scheme`: `semver` (the default: X.Y.Z with an optional `-pre`), `calver` (YYYY.MM, an optional .DD
  and .N) or `none` (any tag-safe word): how Sova checks a reported version.
- `channels` (default none, at most 3): moving tags Publish moves to the new release (`stable`), each a
  valid tag name, each once, and never one that reads as a numbered release under `tag`.
- `commit` (default `true`): `true` makes a release commit that goes through the merge queue; `false`
  is **tag-only**: the release is of the target's tip at Start, and nothing is committed.
- `checks` (at most 20): the **gating checks** the queue runs on the release after the merge's required
  set (§app.release/checks): each a merge check's id (an optional one included) or a check declared
  here with a merge check's keys but `optional` (`{id, label, run, timeout, rerun, requires}`), ids
  unique across both.
- `quietMin` (5 to 1440, default 30): minutes without a report from the release chat, while the queue
  is frozen, before Sova says so (§app.release/quiet).

No key names a remote: whether Publish pushes follows the queue's own rule, an `origin` remote and
`merge.push` not `false` (§app.merge-queue/push). A deploy target may also say `releases: "only"`
(§app.release/deploy).

## §app.release/manifest — The playbook's manifest, `release.json`

The release playbook's folder holds `release.json`, `{v: 1, steps: [...]}`, parsed strictly by
`parseReleaseManifest`: at most 30 steps, each `{id, label, phase, held?, artifact?}`, in plan order.
- `id`: lowercase letters, digits and hyphens, starting with a letter, at most 31 characters, unique;
  `checks`, `publish`, `withdraw` and `abandon` are Sova's own and refused.
- `label`: 1 to 60 characters, what the screens call the step.
- `phase`: `prepare` (before the gating checks), `check` (after the checks passed and the release
  commit landed, before Publish: a live try-out), `after` (after Publish) or `withdraw` (after a
  Withdraw); steps are listed prepare, then check, then after, then withdraw.
- `held: true`: the step ends **held** until the operator's Continue (a judgement, such as trying it
  live).
- `artifact: true`: its done report must carry a built file's facts (§app.release/steps).

The step `commit`, when declared, makes the release commit: it is a prepare step and the last one. The
step `version` reports the version. A release's **plan** is the manifest captured at Start with Sova's
two steps put in: the prepare steps, `checks`, the check steps, `publish`, the after steps, then the
withdraw steps. Nothing else adds a step to a release, and a later edit of the manifest never changes a
release already started.

## §app.release/record — The release record

Each release Sova starts has a record, `rl_…`, under
`<state root>/project-services/release/<project key>/`: its state, version and tag once picked, the
channels it moves, the target's commit at Start (its base), its release commit (for tag-only, the
base), its queue entry, its chat, its steps, its notes, the files it built, who started it (the
operator, or the release power), the operator's Release Note and the ask its chat was sent at Start
(copies, `note` and `asked {by, why}`, each only when there was one; §app.release/start), when it
last heard from its chat, and the settings and manifest captured at Start. A project has at most one
**open** release.

Beside the records, in the same folder, the project's saved **Release Note** (its text and when it was
saved) is kept in `note.json`, written atomically, one per project. It is for the next
Start, whether or not a release is open, and stays until a Start that started its chat takes it or the
operator clears it.

Its state is one of:
- **Preparing**: its chat runs the prepare steps; the queue is frozen for it.
- **Checking**: the queue runs its gating checks, or a check step or gate is still open.
- **Ready to publish**: every gate passed (§app.release/publish); it waits for Publish.
- **Publishing**: Publish runs.
- **Published**: the numbered tag exists and the channels point at it; after steps may still run.
- **Abandoned**: stopped before Publish (§app.release/abandon).
- **Withdrawn**: was published; its channels moved back (§app.release/withdraw).
Preparing, Checking, Ready and Publishing are open.

Each step is **Waiting**, **Running**, **Done**, **Failed**, **Skipped** or **Held for you**, with a
one-line summary (at most 300 characters), an optional detail (at most 20,000), its facts, who set it
(the release chat, Sova or the operator), when, and, where Sova's own check disagreed, Sova's fact.

**How a person reads a release.** A release goes by its tag once a version is picked; no refusal,
reason, Needs-you line or commit message carries its `rl_…` id. Before a version is picked it reads:
- "the open release" in saves, queue entries' reasons and Needs you ("The open release: {label}
  failed");
- "while a release is open" in refusals, and "a release is open: nothing is pushed until it is
  published or abandoned" in the push hold;
- "a release is already open (preparing)" on a second Start, and "a release" on the Merge Queue tab;
- "this release is {state}" on a closed record, and "this release" to its chat.

Lines that name no release at all: "that release doesn't hold this queue", "this release already has
a revert in line", "{tag} belongs to another release". The revert commit reads "Revert release {tag}
(abandoned)". The id stays only where it is a handle: the release chat's first message and its
withdraw restart, logs, record fields, and the branch and worktree names (`release/<id>`,
`sova/release-revert-<id>`).

## §app.release/verbs — The release verbs

A release is worked through verbs beside the deploy and merge verbs, the same way: the same route
(`POST /api/project-services/<verb>`), the same CLI (`sova-project release.*`) and the same tools, each
answering the one result shape with its own key, `release` (§app.project-services/result). Each takes
`project` (an absolute path inside it; a scoped caller's own by default).

- `release.status`: the view: whether releases are set up, the settings (or why they don't read), the
  open release and the last finished one, the history (§app.release/tab), the latest release that
  isn't withdrawn, how many commits landed since it, the target, whether Publish pushes, the deploy
  targets, the gates and the quiet-chat warning. It also applies a queue result the release missed
  (a landing recovered after a restart) and a gate that changed with no event.
- `release.logs {release?, step?, lines?}`: a step's detail, or the gating checks' run, or each step's
  line.
- `release.request {why}`: an ask that the operator release, its reason kept on one line (every run of
  spaces and line breaks one space) (`dismiss: true`, the operator's, clears it;
  a newer ask replaces it). The next Start passes a pending ask to its release chat as context and
  consumes it (§app.release/start).
- `release.note {text}`: saves the project's Release Note for the next Start (§app.release/record):
  the text trimmed, at most 4,000 characters (`invalid-request` beyond), and an empty text clears it.
  It works whether or not a release is open. The view's `note` is the saved one, `{text, at}`, or
  `null`.
- `release.start {commit?}` (§app.release/start); `commit` only for a tag-only release, and only the
  target's tip.
- `release.step {release, step, state, summary, detail?, facts?}` and `release.notes {release, text}`
  (§app.release/steps).
- `release.continue {release, step}` (a held step done) and `release.retry {release, step}` (a failed
  step again).
- `release.publish {release, confirm}`, `release.abandon {release, why, confirm}` and
  `release.withdraw {release | tag, why, confirm}`.

A gate that isn't met answers the error `release-refused` (exit class 2, nothing changed). Every
action on the Releases tab and in Needs you is one of these verbs, and each verb is a catalogue
command, `project.verb.release.*` (§app/commands).

## §app.release/callers — Who may release

- **Reads** (`release.status`, `release.logs`): anyone with the project in scope; a coding session, a
  project overseer and the Project Assistant only their own project's.
- **Reports** (`release.step`, `release.notes`): only the release's own chat, through its own
  `project_verbs` tool, for the open release, or for the published (or withdrawn) one its after (or
  withdraw) steps report. The operator's route refuses them ("reports come from the release chat's
  own tool, never the operator's route"), and so does every other chat and every overseer.
- **The operator's acts** (`release.start`, `release.note`, `release.continue`, `release.retry`,
  `release.publish`, `release.abandon`, `release.withdraw`): the operator's, from the Releases tab or the CLI; Publish,
  Abandon and Withdraw need `confirm`. A request on the operator's route that carries a chat's
  caller key (`x-sova-caller`, what a chat's scripts send) is refused: "a chat's script never acts
  as the operator on a release: the operator does it on the Releases tab". `release.start` and
  `release.publish` are also the release power's act (§app.release/power), never any other verb.
  The Release Note is the operator's alone (`forbidden`): the release chat ("the Release Note is the
  operator's: say what you need in your report"), every other chat, a chat's script on the operator's
  route, and the overseers and the Project Assistant ("the Release Note is the operator's alone; ask
  for it instead: release.request {why} raises it for the operator"). No chat's tool lists the verb,
  and no power sets it.
- **Asking** (`release.request`): the overseers', always, the power Off too. The verb takes the
  Project Assistant as a caller as well, but nothing an owner does sets that ask off. Needs you shows it as "The overseer asks you to release: {why}" (or "The Project Assistant
  asks you to release: …"), one per project, a newer one replacing it. An ask still pending when a
  release's chat starts goes to that chat as context, labelled as theirs, never as the operator's
  word (§app.release/start), and is consumed by it; a dismissed one never reaches a release.
- **Never**: a coding session reads and nothing else ("a coding session never starts or asks for a
  release: tell the operator in your report"); the release chat reports but never starts, publishes,
  abandons or asks for another release (it may ask the operator in its report); conformance and Sova
  on its own never release.

## §app.release/start — Start Release

`release.start` is refused (`release-refused`, nothing changed) when releases aren't set up ("releases
aren't set up for this project: Set Up Releases on its Releases tab …"), when the settings or the
manifest at the target's tip don't read, and while a release is open. A project that lands by request
or by pushing a branch (§app.merge-queue/strategies) can't release yet, since a release lands its
commit on the target and pushes it itself: Start is refused (`unsupported`, nothing frozen, no record)
with "this project lands by request, and a release lands its commit on {target} and pushes it itself:
set how it lands to local (Settings → Merge Queue) to release here" (or "by pushing a branch").
Otherwise it:
1. **Freezes the queue** for the release (§app.release/checks) at the target's head, the release's
   base.
2. Captures the settings and the manifest onto a new record, Preparing.
3. Cuts a worktree for the release from the base, on the branch `release/<rl_id>`, beside the project
   (`<parent of the main checkout>/.worktrees/<repo>-release-<rl_id>`).
4. Starts the **release chat** there, on the `release-thread` profile (it never owns a branch the
   queue lands), titled "Release {tag} of {project}" ("Release (version not picked yet) of {project}"
   until the version is picked). Its first message names the plan step by step, says to follow Sova's
   release method and the project's playbook (the project's winning where they differ, Sova's gates
   always), never to push, tag or move a branch, and how to report. Whoever starts it (the operator
   from the tab or the CLI, or the release power), two optional sections follow:
   - **The ask**: an overseer's or the Project Assistant's pending `release.request`, in a section of
     its own, `Asked by {who}: "{why}"` (the Project Assistant, the project's overseer, or the
     Overseer), its reason quoted on one line (every run of spaces and line breaks one space, so it
     can never hold a line of its own, nor pass for the note), then a line saying it is context from
     them and not the operator's word: it never picks the version, never skips or narrows a step. It
     comes before the note.
   - **The Release Note**: the operator's saved note (§app.release/record) as the message's final
     section: a line `---`, then the label line `Release Note from the operator (saved on the
     Releases tab):`, which only Sova writes, then the note whole to the end of the message, any `---`
     lines of its own included. It is the playbooks' place for the operator's instructions for this
     release; a version it names is the one the chat picks, over the playbook's version rule. With
     no saved note there is no label, and nothing in the message is the note.
   With no saved note and no pending ask the first message is as it was, and a missing note never
   blocks or delays a Start.

Only once the release chat started does the Start take the note and the ask: it keeps copies on the
record, clears the saved note and removes the ask it sent (so its Needs you item ends). A note saved
again, or a newer ask made, while the chat was starting isn't the one sent, and stays for the next
Start. If the worktree
or the chat can't be made, the release is abandoned at once with why and the freeze lifts, and the
saved note and the pending ask both stay for the next Start. A started release answers the record and
the view.

## §app.release/steps — How the release chat reports, and the facts win

The release chat reports each step with `release.step` (state running, done, failed, skipped or held,
a one-line summary, an optional detail, and facts as `key=value`: `version`, `commit`, `branch`,
`url`, `artifact` (a path), `sha256`, `size`) and the notes with `release.notes` (at most 20,000
characters). Each report records when it came, which ends a quiet-chat warning.

Sova refuses (`release-refused`) a step not in the release's plan, one of Sova's own (`checks`,
`publish`), and a step out of its time: a prepare step once the gating checks began, a check step
before the checks passed, an after step before Publish, a withdraw step before a Withdraw. The `commit`
step's done is refused until every other prepare step is done or skipped, naming them, since the
checks start with it. A held step reported done stays **Held for you**.

For a done step Sova checks what it can see itself, and **where a report and a fact disagree, the
fact wins**: the step reads Failed with Sova's reason, and the verb answers `release-refused`.
- `version`: fits the scheme; its tag doesn't exist yet ("a numbered version is used once"), isn't a
  channel's name and isn't another release's. The version names the release from then on.
- `commit` (a release that commits): the commit exists, is cut from the base and isn't the base, is on
  the release branch, and the version came first. Sova then adds the **release entry** to the queue
  itself (§app.release/checks).
- An artifact (`artifact: true` steps, or any reported): an absolute path; inside the repository it
  must be ignored by git and untracked ("artifacts are never committed"); where Sova can read it, its
  size and sha256 must match. The record lists the built files.

**Continue** (`release.continue`) marks a held step done by the operator and wakes the chat to go on.
**Retry Step** (`release.retry`) sets a failed step back to waiting and wakes the chat to run it again;
a prepare step can't be redone once the checks began ("abandon the release to redo a prepare step"),
`checks` reruns the release's queue entry, and `publish` only goes back to waiting, publishing nothing
and waking no chat (§app.release/publish; the tab doesn't offer that one). The chat is woken
with a line starting `[Sova · release]` whenever Sova needs it: checks passed or failed, a step
continued or retried, published, abandoned, withdrawn.

## §app.release/checks — The frozen queue and the gating checks

While a release is open, the project's merge queue is **frozen** for it (§app.merge-queue/push):
- only the release's own entries land (its release commit, or the revert of an abandoned one); every
  other entry waits in line with the reason "waits for {tag} to be published or abandoned" and no
  estimate;
- a run of another branch already checking when the release starts is voided ("a release started: it
  waits for the release") and goes back to the front of the line;
- nothing is pushed: a landing's push is held ("held: release {tag} is open: nothing is pushed until it
  is published or abandoned");
- so the target and the main checkout stay exactly on the release (its base, then its commit):
  - a Settings save waits and is made after Publish or Abandon (§app.merge-queue/settings-save). The
    save's answer and its banner say "Saves once release {tag} is published or abandoned", and How it
    lands "{how} saves to the project file once release {tag} is published or abandoned.". A save
    already waiting on a branch reads the same once the release opens, and goes back to the old words
    when the freeze lifts; a waiting save that failed names no release. The name is read from the
    freeze, never kept with the save;
  - Update Local Main (§app.merge-queue/requests) and Save Checks (§app.merge-queue/setup) are refused,
    and so is setting or clearing a how-it-lands choice kept on this computer
    (§app.merge-queue/strategies).

The **release entry** is added by Sova, approved `by: release`, without review, first in line. It must
be cut from the release's base. It runs the merge's required checks and then the release's gating
checks in order (a check the merge set already runs fully runs once; a project whose merge checks are
`none` still runs them), every one of them fresh (`SOVA_FRESH=1`): a release reuses no earlier pass
(§app.server-runtime/test-reuse), so it catches what reuse at landings could hide. It lands its commit on the target **without a push**. A conflict hands it
straight back. Its outcome reaches the release: running, then **Done** ("passed; {sha} is on {target}
(not pushed until Publish)") with the release commit recorded, or **Failed** with why, after which the
operator may Retry Step (the entry runs again) or abandon. A **tag-only** release has no commit: once
its last prepare step is done, the same entry runs check-only on the frozen tip, and nothing moves.

**The gates of Publish**, all of them, never overridable: the checks step is done; every prepare and
check step is done or skipped; notes are set; a version and its tag exist; the release commit is on
the target; and, for a project that pushes, its private names are set up (the queue's leak-scan gate,
§app.merge-queue/push: "pushes are held until this project's private names are set up …"). While one
isn't met the release stays Checking and the view lists why ("Not ready to publish: …", steps named by
label); once all are, it is **Ready to publish** and its chat is told to wait.

## §app.release/publish — Publish

`release.publish {release, confirm}` is refused unless every gate passes and the target is still at the
release commit, and fails with nothing changed (the step reads Failed, as below) on a project that by
then lands by request or by pushing a branch, in the words Start uses (§app.release/start). Then, in one queue call, **all or none**:
1. It makes the annotated numbered tag at the release commit, the notes as its message (a tag already
   there at that commit is reused; elsewhere, refused).
2. It moves each channel to it (annotated), each leased on its old commit, kept for Withdraw.
3. For a project that pushes (an `origin`, `merge.push` not `false`): it checks that `origin`'s target
   is an ancestor and that every first-parent commit on the way was landed by the queue, makes **one
   atomic push** of the target, the tag and the channels (each channel leased), and checks the result
   with `git ls-remote`.
4. A **local-only** project (no `origin`, or `push: false`) tags and moves its channels on this machine
   only, and pushes nothing.

Any failure puts every local ref back as it was and leaves the release Ready with Publish **Failed**:
the verb answers "Publish failed, nothing changed: {why}", and the step holds the cause alone. The gates
alone decide whether Publish may run, so a failed step doesn't stop it: `release.publish` runs again,
for the operator (**Retry Publish**, §app.release/tab) and the release power alike. `release.retry
{step: publish}` stays on the verb for the operator's route and CLI, but it only sets the step back to
waiting, publishes nothing, and the release reads plain Ready again (§app.release/quiet).

Success marks the release
**Published** (by the operator or the release power), lifts the freeze, so the waiting landings run and
push as usual, and wakes the chat to run the after steps, which report like any step: a failed after
step never undoes the publish; it shows Failed with Retry Step.

**Limit: a save that waited for the release isn't in it.** It is made after Publish, one commit past
the tag, which stays on the release commit with its channels, and it isn't pushed until the next
landing (§app.merge-queue/settings-save).

## §app.release/abandon — Abandon Release

`release.abandon {release, why, confirm}` (refused while Publish runs) stops a release that isn't
published. Its queue entry, if still in line or checking, is cancelled. A release commit that already
landed is **reverted as a queue landing**: a revert commit whose tree is the base's, on the branch
`sova/release-revert-<rl_id>`, lands first in line, and the freeze lifts once it lands; nothing is ever
reset. With nothing landed, the freeze lifts at once. Its running and held steps read Skipped, the
record says why, and its chat is told to stop. No tag is made and no channel moves.

## §app.release/withdraw — Withdraw

`release.withdraw {release | tag, why, confirm}` takes back a published release (one Sova made, or any
numbered tag in the history); a reason is required, and a release already withdrawn is refused. Each
channel pointing at it moves back to the newest older release that isn't withdrawn (none: the channel
is removed), leased on where it was, and Sova writes the **marker tag** `withdrawn/<tag>`, annotated at
the release's commit with the reason as its message: that is how every copy elsewhere learns of it. A
project that pushes pushes the channels and the marker atomically. **The numbered tag never moves and
is never deleted.** The record reads Withdrawn, its notes gain "Withdrawn {date}: {why}", and its
chat (or a fresh chat in its old worktree) runs the withdraw steps, if the manifest has any. Deploy
targets are not rolled back: that stays on the Deploy card. Installed copies running it are told so in
Settings → Updates (§app.updates/check).

## §app.release/quiet — Needs you for a release

Release items are act-tier attention items of no session (§app.overseer/attention-digest), linking to
the project's Releases tab, never pushed:
- `release-ready`: "Ready to publish · {tag}" while a release is ready, no power hold is pending and
  its Publish step hasn't failed.
- `release-held`: "{tag}: {label} is held for you{: summary}", one per held step ("The open release"
  in place of {tag} until a version is picked, here and on `release-failed`).
- `release-failed`: "{tag}: {label} failed{: summary}", one per failed step, after and withdraw steps
  of the last finished release included. A failed Publish is one item, "{tag}: Publish failed: {why}",
  in place of `release-ready`, and a Publish that succeeds clears it (`release.retry` on the step puts
  `release-ready` back). Its row is titled "Publish failed", chip **Failed**, with "{tag}: {why}" as its
  detail and the whole sentence as the detail's tooltip (§app.session-list/needs-you); any other failed
  step's row keeps the title "Release step failed" and its sentence. Any other failed or held step
  still shows beside `release-ready`.
- `release-quiet`: "No word from the release chat for {n} min", while a release is Preparing or
  Checking, no step is held, no gating check runs, and its chat hasn't reported for longer than
  `quietMin`; a report ends it.
- `release-request`: an overseer's or the assistant's ask (§app.release/callers), until it is
  dismissed, replaced, or taken by a Start whose release chat started.
The release power's waiting period is the existing held-act item, with Cancel (§app.release/power).

## §app.release/power — The release power

`release` is a power of the overseer's column only, in the Release group beside `share` and `deploy`
(§app.project-overseer/autonomy-levels): "Release (the project's release playbook; may publish after its
waiting period)". The Project Assistant's column has no release power. With it On, a project overseer's
`release.start`, and its `release.publish` of a release whose every gate passed, go through the
project statechart's act `release/run` (tool `sova_project_verbs`, held): the gates are checked before
the hold, and a release that isn't ready is refused at once ("Not ready to publish: …"); the act then
waits the project's waiting period, cancellable in Needs you, and the releaser checks every gate again
when it runs. The release power never overrides anything: no failed check, no missing gate. While
Publish's waiting period runs, the record keeps when it ends, and the Releases tab shows "Publishes in
{m:ss}" with **Cancel**. With the power Off, an overseer's start or publish is refused with the power's
sentence and nothing is held; asking stays allowed. With the release power and the deploy power both
On, an overseer told to release, publish and deploy does the whole chain, each act with its own wait.

## §app.release/tab — The Releases tab

The project page has a **Releases** tab after Merge Queue (§app.organizations/project-page), at
`#/projects/<pid>/releases`, reading `release.status` every 5 seconds and following the session feed's
`release` frames; the tab, the Overview card and the Deploy card share that one read. The same frames,
every project's, also drive the sidebar's landing bar, which never publishes or abandons: its Open
Releases opens this tab for both (§app.merge-queue/landing-bar). Top to bottom:

- **Head**: "Releases" (a **Not set up** chip while not set up) and **Start Release**, while releases
  are set up and read, no release is open and the project isn't archived. Beside it, **Release Note**,
  while releases are set up and read and the project isn't archived, a release open or not (the note
  is for the next Start), opens a small editor for the project's saved note (§app.release/record): a
  "Release note" field of at most 4,000 characters with its count, the hint "The next release chat
  reads it as your instructions. Start Release sends it, then clears it.", **Save Note** (saved with
  `release.note`; nothing to save while it is empty or unchanged), **Clear Note** while a note is saved,
  and Cancel (or Escape). While a note is saved and the editor is closed, the tab shows it under the
  head, "Release note" with when it was saved, its text and "Start Release sends this note to the
  release chat, then clears it." (with a release open: "The next Start Release sends this note to its
  release chat, then clears it."). Start Release stays one click and opens nothing: it sends only the
  project, the server reads the saved note itself, and an empty note changes nothing.
- **Strip**: Latest release (its tag, or "None yet"); Since then ("{n} landings since {tag}", "No
  landings since {tag}"); and where it publishes, "On {target}, published to origin" or "on this
  machine only".
- **Not set up**: "Releases aren't set up for this project", how a set-up works (a chat reads the
  project, asks how it releases, then proposes a release playbook and a `release` section of
  `.sova/project.json` on a branch to land), and **Set Up Releases** (§app.release/maker). A live
  set-up run shows in its place ("Setup chat running", or "Setup chat waiting on your answers" with
  the count) with **Open Chat**; a proposed one shows what it proposes (§app.project-runtime/run-report)
  with **Land** (or Merge Branch) and **Read Report**. A refused start shows its reason as sent, with
  **Open Chat** for the run that holds it.
- **Settings that don't read**: an error banner, "This project's release settings don't read.", with the
  problem; no release starts until it reads.
- **No release open**: "No release open. Start Release opens a chat that follows {project}'s release
  playbook; {target} waits on it until you publish or abandon."
- **Release in progress** (also a published or withdrawn release while its after or withdraw steps
  have work: "Published, finishing", "Withdrawn, finishing"): the state chip (**Publish failed** while
  the publish step is failed, here and on the Overview card, and Ready to publish again once it isn't;
  the record's state doesn't change), **Open Release Chat**, its
  name (the tag, or "The new release"), who started it and when (you, or the release power), its base
  and commit, its last report; "Step {i} of {n} · {label} · {k} done" (the step's words "{label} failed" or "{label},
  held for you" when it did, so "Step {i} of {n} · Publish failed · {k} done"); the quiet warning "No word from
  the release chat for {n} min" with Open Chat; what the release started with, when it had any: "Your
  release note" and its text, and "Asked by the Project Assistant" (or "the project's overseer", "the
  Overseer", the words its chat was sent) with the reason
  and "Passed to the chat as background, not as your instructions."; then each step numbered with its chip (Waiting,
  Running, Done, Failed, Skipped, Held for you), its phase word (Sova, Before publish, After publish,
  After withdraw), its summary, Sova's fact where it disagreed, its built file and link, **Detail**,
  **View Checks** on the checks step, **Continue** on a held step and **Retry Step** on a failed one,
  but never on Publish;
  withdraw steps only once withdrawn; the notes, folded; the built files with path, size and sha256.
- **Publish {tag}** only while the release is ready and no gate says why, else "Not ready to publish:
  {why}." and no way to retry. After a failed Publish the same button reads **Retry Publish**, and calls
  `release.publish` through the same confirm. Publish asks once inline, naming what goes out ("Publishing pushes {target}, {tag}, {channels}
  to origin in one step …", or for a local project "Publishing tags {tag} on this machine … Nothing is
  pushed."), and that "the number is never moved or deleted; Withdraw only moves {channel} back", with
  **Publish Now** and Cancel. The power's countdown, "Publishes in {m:ss}", shows with Cancel while its
  hold runs.
- **Abandon Release** (destructive) asks for a reason and says the chat stops, nothing is published, a
  landed release commit is reverted as a landing, and waiting landings go ahead.
- **Plan Deploy of {tag}**, per deploy target, on a published release and on the latest release's
  history row (§app.release/deploy).
- **History**, newest first, read from the project's numbered tags (withdrawn markers and channels
  skipped): each tag with its channel badges (`stable`), **Withdrawn** with "Withdrawn {when}: {why}",
  its commit and date, "Runs on {targets}", and its notes, folded (the tag's section of `CHANGELOG.md`
  when there is one, else the tag's message). Each release that isn't withdrawn offers **Withdraw** (none while a release
  is open or the project is archived), which names where each channel moves back to, says the tag stays
  marked withdrawn, that copies running it are told so and that deploy targets keep running it until
  rolled back, and requires a reason. With none: "No numbered release yet. Each one shows here from its
  tag, with its notes."

The project's Overview has a **Releases** card in its second column above the Deploy card: "Latest
{tag} · {n} landings since", "{tag} in progress" with its state chip, "No release yet." or "Releases
aren't set up for this project.", and **Open Releases**. On a phone (390px) nothing scrolls sideways.

## §app.release/deploy — Release to Deploy: the hand-off and releases-only targets

Release and Deploy stay two actions. After Publish, the release offers **Plan Deploy of {tag}** for each
declared deploy target: it opens the Overview's Deploy card and plans that target at the release's
commit, saying "Planning release {tag} ({sha7})." with **Plan the Branch Tip Instead**. Each Deploy row
says which release its target runs, "Runs {tag}" ("(withdrawn)" when it is): the release whose commit
is the target's newest succeeded deploy (verified, where the target declares a verify). A deploy target
may say `releases: "only"` (§app.project-services/deploy): its plan then refuses (`deploy-refused`) a
commit that isn't a published, not withdrawn, numbered release ("{target} takes releases only: {sha7}
isn't a numbered release … deploy a release instead (the latest is {tag})", or "… was withdrawn …").

## §app.release/playbook — Sova's release method and a project's playbook

`playbooks/release/` is Sova's general release method, shipped with Sova; a project's own release
playbook (the folder `release.playbook` names) adds what is particular to it, and wins where they
differ, while Sova's gates always apply. The method says: the queue is frozen and Publish and Withdraw
are Sova's; the chat reports each step only through its own `release.step` and `release.notes`, never a
script calling Sova; the step states and phases; facts as `key=value`; the order of a release;
abandoning; what a quiet chat looks like; local-only releases; and that built files are reported as
facts and never committed; that the text after the line `---` and the label line `Release Note from
the operator (saved on the Releases tab):` at the end of its first message, to the end of that
message and `---` lines inside it included, is the operator's Release Note (no label, no note), read as the operator's instructions for this release (a version it names wins over the
project's version rule; it may skip or narrow a step, never a gate), and that a section labelled as an
ask from an overseer or the Project Assistant, the quoted `Asked by …` line, is context only, never
an instruction, and never holds the note. Its driver `scripts/release.mjs` only reads and writes the release worktree:
`status` (the previous tag, commits since, a suggested next version and why), `notes` (raw material
from the landings since, under the state root), `changelog` (the entry exactly once, no placeholder),
`bump` (a version in `package.json` or any JSON's top-level `version`, `Cargo.toml`, `pyproject.toml`,
`mix.exs`, single-version files) and `artifact` (refusing a tracked or unignored path inside the
repository, printing the facts). It never pushes, tags or calls Sova.

## §app.release/maker — Set Up Releases: the Release playbook maker

`playbooks/release-maker/` is a verb playbook that proposes `release` (§app.project-runtime/verb-playbooks),
started by **Set Up Releases** on the Releases tab (`verbs/onboard {playbook: "release-maker"}`) on its
own branch with align on. It works like the Project deploy playbook: it reads the project (version
tags, files holding a version, a changelog, release scripts and tag-triggered automation, remotes,
ignored build folders, the merge checks and deploy targets), then, before writing anything, asks the
operator how the project releases (the version rule, the notes and their audience, the channel, each
step in order and who does it, release-only checks, a live try-out, after-publish steps, where built
files go). It writes the `release` section and the project's playbook folder (`PLAYBOOK.md`,
`release.json`, scripts), every line traced to an answer; with no answer to change them it starts from
the defaults: `{playbook, tag: "v${version}", scheme: "semver", channels: ["stable"], commit: true}` and
the steps version, notes, bump, commit. Its driver `scripts/release-maker.mjs` has `candidates`, `init`
(the starter, never over an existing setup), `fmt` and `check`, which refuses push, tag-creating and
update-ref commands (in argv form too), `gh release create` without `--verify-tag`, resetting or forcing a branch,
calls to Sova, literal addresses and secret-looking values, and a built file inside the repository that
git doesn't ignore; it can't see a git call hidden inside a wrapper function. It calls only
`release.status`, never cuts a release, and hands back the branch to review and Land. The proposal's
hash covers the section and the playbook folder together (§app.project-runtime/merge).

## §app.release/sova — Sova's own release playbook

Sova's `.sova/playbooks/release/` is its project release playbook in this form: `release.json` plans
version, notes, bump, stamps, docs and commit before the checks; try-live (held: the operator's Apply on the live server, then a health check; Sova's merge thread never restarts Sova while a release is open, nor for its commit, §chat.merge-queue/sova-restart) before Publish;
release-page (the notes out, `gh release create --verify-tag`) and outside-checks (held) after Publish;
and release-page-withdrawn after a Withdraw. The **docs** step runs in every release unless the operator's Release Note
says otherwise, and finishes on its own (never held): it lists every Docs page whose spec sources
changed, left stale, or new, fixes each in its own commit, and writes a new page for each new feature
that has none (one whose record won't promote is left without a page, and the step says why). Since a release entry carries no spec drafts, a new page's `§site.docs/<page>` record
is drafted, promoted and committed by explicit path on the release branch, in its own commit before
the release commit. A version the Release Note names wins over Sova's version rule, and an ask passed
with the Start is never read as the note. Its driver `scripts/sova-release.mjs` carries the steps'
mechanics and the seven release-only checks (`references/checks.md`). Pausing and resuming the queue,
the hand tag and push, and the hand fast-forward of the live tree are gone: the freeze, the release
entry and Publish replace them. Its own `release` section (this playbook, tag `v${version}`, semantic
versions, the one channel `stable`, a release commit and the seven checks) and a `site` deploy target
(the landing page and docs on Cloudflare Pages, shipped only from a published release's commit) are in
`.sova/project.json`, in the canonical form `release-maker fmt` writes, and `release-maker check`
passes on them. Both sections sit outside the definition's hash, so adding them left every recorded
conformance proof of Sova's copies standing. The `site` target's `video` step copies the hero videos from the folder in this
host's `SOVA_SITE_VIDEO_DIR` value, an env credential of the target; a deploy never ships the site
without its hero video: with that value unset the plan fails its credential check, and a folder that
misses a video fails the step.
