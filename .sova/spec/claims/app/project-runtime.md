# §app/project-runtime — The project's software registry

> Part of the Sova design spec · [overview](../design/overview.md)

Every registered project, standalone or placed in an organization, has a **software registry** on
the host that runs it: what its main checkout declares in `.sova/project.json`
(§app.project-services/contract), whether the operator approved that definition on this host,
whether conformance proved it, and whether the project's stack moved since. It is kept in a
host-local statechart, `runtime/<p>`, beside the project's watch. It is filled by the **Project
verbs** playbook, which a coding session runs on a branch of the project, and it is read by the
project page's Software card and by the overseer. What runs right now (units, pids, instances) is
never stored in it: the engine's status is the truth for that, joined in when the registry is read.

## §app.project-runtime/registry — What the registry holds

`runtime/<p>` is a project-layer statechart: it knows the project id and root, never an
organization. The project statechart spawns it at its birth, beside its watch, in either kind of
engine, and the host starts it for every existing project each time the project's engine opens.
Its history stays on this host, and after an attach to another host it starts fresh there: approval
and proof don't travel.

It holds, all of it read from the main checkout's HEAD, never its working tree:

- **The definition**: absent, invalid (with the parser's error), or present with its hash
  (§app.project-services/trust) and the commit it was read at.
- **The software**: one row per declared service, in declaration order: name, kind (process,
  static or container), scope, ports, requires, and the isolation method with its reason.
- **The data**: one row per declared data resource, in declaration order: name, kind (dir or
  hook), and whether it is sensitive (`sensitive: true`: derived from production, so no copy of it
  is ever shared).
- **The sources**: the files the definition says it was written from (its `sources`), and one
  fingerprint over their content at HEAD.
- **Approval**: the approved hash and when, on this host.
- **Proof**: the last conformance on main for this hash: suite version, pass or the failing check,
  confined or not, when, and the memory it measured (each service's and each instance's peak and
  steady resident memory, §app.project-services/conform).
- **Registered**: the hash, suite, fingerprint and commit it was registered at.
- **The playbook run**: the verb playbook it runs (its id, title and what its proposal approves,
  §app.project-runtime/verb-playbooks), the coding session, its branch, why it was started, who
  started it, while it waits the open questions it asks, and its result.

`GET /api/projects/:pid/runtime` answers this, plus each service's live state per instance from the
engine's status. A unit still running for a service that left the definition (status reports it
degraded, "no longer in the definition") is listed apart, as an orphan, with the copy it runs in.

## §app.project-runtime/standing — Unregistered, awaiting approval, conforming, registered, stale, failed

The registry has one standing, derived by one rule from the facts above, never set by hand:

- **Unregistered**: main has no `.sova/project.json`.
- **Failed**: main's definition is invalid, or the unconfined conformance of its hash failed.
- **Awaiting approval**: main's definition is valid and its hash is not approved on this host.
- **Conforming**: the hash is approved and has no unconfined pass for the current suite. Entering
  it runs the full, unconfined conformance on main by itself (the operator's approval is the
  authority), with no second gesture.
- **Registered**: approved and proven unconfined, and the sources' fingerprint is the one it was
  registered with.
- **Stale**: registered, and the sources' fingerprint changed since (a dependency manifest, a task
  file, a compose file the definition was written from changed on main). The registry names the
  changed paths. This is drift: a fact the host observes, never an act anyone takes.

A new definition on main (a new hash) or a new conformance suite is registered afresh: approved,
then conformed, then registered at the sources' fingerprint of that moment. A failed definition
stays failed until main's definition or the suite changes. A Project verbs run that ends with
nothing to change, or whose merged branch leaves main's definition hash as it was, takes the
sources' current fingerprint as the registered one, so a stale registry is current again.

The project's overseer is told when the software goes stale (once per drift) and when it fails (a
reason to look soon); a registration, a proposal and a run's end reach it as news it reads on its
next look, except the end of a run the overseer itself started, which it is told about.

The host re-reads these facts when the engine opens, after an approval, a conformance or any verb
that changed something, after a merge of a branch, when the project page reads the registry, and
every 5 minutes; it tells the statechart only when they changed.

The registry keeps a feed, one line per move, read from the statechart's log and returned with
the registry (the Software card shows it). It says, as the standing moves: "The project declares no software yet
(.sova/project.json is missing on main)." / "The definition on main ({hash12}) runs here once you
approve it." / "Conformance is running on main." / "The project's software is registered: {n}
services, proven at {hash12}." / "The project's stack changed since its software was registered
({paths}). Run the Project verbs playbook to bring it up to date." / "Conformance failed on main at
{check}: {detail}." / "The definition on main is invalid: {error}"

## §app.project-runtime/approve — Only the operator approves

`POST /api/projects/:pid/runtime/approve {hash}` approves a definition on this host
(§app.project-services/trust): main's while the standing is awaiting approval, or the branch the
playbook proposes while its run is proposed. While main's valid definition is failed, approving it
again runs its conformance again. Anyone else is refused with 403 "Only the operator
approves a definition."; a hash that is no longer the one shown is refused with "The definition
changed since it was shown: look again.", and with nothing waiting for approval it is refused with
"There is no definition waiting for approval." The feed says "You approved the definition {hash12}
on this host."

## §app.project-runtime/onboard — Starting the Project verbs playbook

`POST /api/projects/:pid/verbs/onboard {why?, model?, playbook?}` (the project act `verbs/onboard`; the
overseer's `sova_project_verbs` verb `onboard`) starts the Project verbs playbook as a coding
session of kind `onboard` in its own worktree and branch, the way a build starts
(§app.project-overseer/coding-worktrees), titled "Project verbs: {project}", whose first prompt is
the playbook's turn plus the why (§chat.playbooks/what-gets-sent). The playbook is the one with id
`project-verbs` the project's folder lists, a user playbook of that id replacing the shipped one
as everywhere (§chat.playbooks). Its model is the one asked for (with its thinking, medium unless
given). Otherwise it is chosen from the models this host offers (the model picker's list), never a
ref outside it: claude-code `opus` if listed, else claude-code `opus[1m]`, else openai-codex
`gpt-6-astra`, each at medium thinking. When the list has none of them, or can't be read, nothing
starts: "No model for the Project verbs playbook: this host offers neither Claude Code opus nor
openai-codex gpt-6-astra. Pick a model to run it with." It counts like a coding session against the
project's limits, and the operator merges its branch; nothing else does.

It needs L3 when the overseer starts it on its own, and it is refused when the project is
archived, when the project's folder is not on this host ("{name}'s folder is on {target}: the
playbook runs only on a local folder." or "{name}'s folder {root} is missing on this host."), when
the playbook is missing ("No playbook \"project-verbs\" is listed for {name}."), while a run
is already live ("The Project verbs playbook is already running: \"{title}\"."), and, for an
unattended overseer, while the software is registered and current ("The project's software is
registered and current: the playbook has nothing to do.").

`playbook` (optional, default `project-verbs`) names another verb playbook the project's folder lists
(§app.project-runtime/verb-playbooks); the run's title is then "{its title}: {project}", and every
sentence below names it by its title. The session runs in the project's coding mode with align on
beside it (§app.project-overseer/coding-mode).

The run's region moves idle → running → proposed (its branch has commits and its turn ended) →
idle (merged, or its worktree removed); a run that ended with no commits returns to idle with the
result "no change". A turn that ends while the session has open alignment questions waiting on the
operator (§chat.alignment/session-mark) moves it to waiting instead, whatever its branch holds, and
the next turn (the operator's answer) moves it back to running. The registry's feed (the Software card's, §app.project-runtime/standing) says
"The Project verbs playbook was started{: why}.", "The Project verbs playbook could not start.",
"The Project verbs playbook finished with no change.", "The Project verbs playbook proposes a
definition on {branch}: approve it, then merge.", "The Project verbs playbook waits on your answers in
its session.", "The Project verbs playbook's branch was merged." and "The Project verbs playbook's worktree was removed."

## §app.project-runtime/playbook — The Project verbs playbook

`playbooks/project-verbs/` is a Sova playbook (§chat.playbooks), so every project lists it. It
works in a worktree on its own branch: started by `verbs/onboard` it already is one; started from
the Playbooks dialog in the main checkout, it cuts one first. It reads the project at HEAD, never
the main checkout's uncommitted edits. Its driver `scripts/project-verbs.mjs` only reads
(`inspect`, `plan`, `check`, `ram`) and canonically formats the definition (`fmt`, 2-space JSON
in the contract's key order), exiting 0 when all is well, 1 when it found something to act on and
2 when it couldn't check; it never starts, stops or approves anything. Run on a project, it:

1. Reads the state: the verbs' status and doctor, the definition at HEAD, the last conformance
   report, and why it was started; `plan` says whether anything points at a change (no valid
   definition, a source changed since the definition's last commit, a stack file the `sources`
   don't list, a source gone, a service with ports but no `about`, a checkout service that may serve
   a page, static or with HTTP readiness, while the definition names no entry point).
2. Inspects the repository: its tasks, scripts, dependency manifests, compose and Procfiles, port
   and URL literals, gitignored runtime folders, the tools on PATH and the ports in use.
3. Reconciles, never regenerates: it keeps every service, key and order the sources don't
   contradict, and changes only what changed.
4. Chooses each service's isolation (ports per slot, per-slot names on shared infrastructure, a
   per-instance process on data copied from main, or a container, which needs approval before its
   first conformance) and records the method and why in the definition, with the `sources` it read.
   It marks a data resource `sensitive: true` when its contents derive from production (a store
   whose database id or name says prod, a task that clones or downloads production, a restore from
   a production backup), and its report says which resources it marked and why. It lists in
   `share.endpoints` only the ports a stakeholder should open (the app's page, a public API), never
   a REPL, nREPL, shadow-cljs, debugger, metrics, database or admin port nor a shared service, and
   declares `share: {"allow": false}` when a resource is sensitive or nothing is for a stakeholder to
   see; its report says which. Finding the app's entry point is required, as the verbs are: for
   every project with a page (a web app, a static site) it sets `open` to the endpoint and path
   where a person opens the app (its home page, never an API or health route) and checks that the
   page there answers with HTML; it leaves `open` out only for a library or an API-only project, and
   its report says why. It declares a service's `onMerge: "reload"` only when the main
   checkout's running copy of it should follow main and loses nothing by reloading, never on a
   REPL, a long-running job or a datastore; its report's service line says "reloads on merge".
5. On its own branch only, writes `.sova/project.json`, the project's helper scripts under
   `.sova/bin/`, the probe hook, a test command with a green smoke selection, `about` lines, and
   the smallest app change that reads its ports and data from the environment with today's literal
   values kept as the defaults, so the main checkout runs exactly as before, and one sentence in
   the project's CLAUDE.md or AGENTS.md: "Ports above are the main checkout's; in a Sova worktree
   use the ports in Sova's instance note, and run tests with project_verbs test."
   When a data resource is sensitive, a copy holding it must send nothing outward: the playbook
   finds the app's outbound channels in config and code (push notifications, chat bots, SMS,
   email, webhooks, payment and other third-party calls) and adds one environment switch,
   `SOVA_SILENCE_OUTBOUND`, that makes every send return without sending whenever it is set to
   anything but `0` or empty; the definition sets it to `${slot}` in every service's `env`, so
   every copy is silenced while the main checkout (slot 0, or run outside Sova with it unset)
   sends exactly as before. It adds a test to the smoke selection that fails if the switch is missing in a
   copy (`SOVA_SLOT` other than 0) and that calls each send path with transports that throw if
   reached. It proposes the definition for approval only after a confined conformance passed with
   that test; when it can't verify the silencing, it stops and says so. It never prints, copies or
   logs a channel's credentials (bot tokens, push keys, API keys), in reports, fixtures, tests or
   commit messages.
6. Formats and checks the definition (`fmt`, then `check`: Sova's own parser, plus a fixed port on
   a checkout service, a slot's port that something listens on or another Sova instance holds, a
   service without `isolation`, missing `sources`, or a data `from` outside the project), commits
   on its branch, and runs conformance on the branch (confined, before approval), reads what
   failed and fixes it, at most 6 runs.
7. Reports the services and their isolation, the entry (`open`, or why there is none), the conformance result (runs used, confined, suite,
   hash) with each service's and instance's measured memory, the test command and smoke counts,
   the app files it adapted, the outbound channels it silenced and how, the deploy entrypoints
   it found (never run), and the next step
   ("Approve & Merge {hash12} on the project page.").

When it needs a decision the repository can't settle (which of two held ports a service takes,
whether a store is production data, which service is the entry point when two serve pages), it
asks the operator with `align` and ends its turn, rather than guessing; the answer comes back as
the next message. Its frontmatter says `approves: definition` (§app.project-runtime/verb-playbooks).

A run that finds nothing to change commits nothing and ends "No change: the contract matches the
project." A rerun with nothing changed therefore leaves the branch and the definition byte for
byte as they were. It never approves, merges, pushes, touches the main checkout or its running
processes, starts anything outside the verbs, or runs deploy or production tasks.
Its contract reference names every key the parse accepts, `adopt` included (a slot-0 unit the
operator already runs, §app.project-services/adopt), which a project it onboards almost never needs.

## §app.project-runtime/software-card — The Software card

The project page's Overview has a **Software** card reading the registry. It shows the standing as a
chip (Unregistered, Awaiting approval, Checking, Registered, Out of date, Failed); one row per
service: name, kind, scope, isolation method (its why as the title), ports, its live state per
instance, and its measured memory; each orphan as its own row, "still running in {copy}, no longer
declared", with an Orphan chip in warn; one row per data resource (name and kind), a sensitive
one with a Sensitive chip in warn whose title says "Derived from production: copies of it are never
shared."; "Proven {time} at {hash12} (suite v{n})";
"Changed since: {paths}" while stale; "Failed at {check}: {detail}" while failed; the playbook
run's session as a link; and the registry's latest feed lines, newest first, with
the project's onMerge notes (§app.project-services/on-merge) among them. Its actions are
**Run Playbook** (**Run Again** once registered) and **Approve {hash12}**, each shown only while
the statechart would take it; while a run is proposed, **Approve & Merge** (or **Merge Branch**)
replaces Approve (§app.project-runtime/approve-merge). A live run shows as its strip
(§app.project-runtime/run-progress) and a proposed one as its review
(§app.project-runtime/run-report). Under its service rows, **Open Branches** links to the project's
Branches tab (§app.project-services/services-ui), where each copy is started, stopped, opened and read.

## §app.project-runtime/review — A proposed run needs you

A verb playbook run (§app.project-runtime/verb-playbooks) that ends proposed waits on the operator, and
says so where the operator looks, so a finished turn is never mistaken for a finished run. While the
run is proposed, its session has an act-tier attention item (§app.overseer/attention-digest) of kind
`playbook-review`, dated by its last turn's end: "{Title}: approve {hash12} and merge into {target}"
while the branch's definition waits for approval, "{Title}: {hash12} is approved: merge it into
{target}" once it is approved, and "{Title}: its branch {branch} has no valid definition: read its
report" when the branch's definition is absent or invalid ({Title} the playbook's title, `target`
the branch the run's worktree merges into). So it lists in the sidebar's Needs you as the run's
session row, counts in the Overseer's "need you", and is a phone-notification kind, "Playbook needs
you", on by default (§app.notifications/delivery). The item goes only when the run leaves proposed:
its branch merged, its worktree removed, or the run working again (a new turn); never on a visit or
on the approval alone.

While the run is proposed, the project page shows a banner above its summary, on every tab: "{Title}
proposes {hash12} on {branch}." with "Approve it and merge it into {target}." (or "It is approved:
merge it into {target}."; with no valid definition on the branch, "{Title} proposes changes on
{branch}." with "Its branch has no valid definition: read its report."), its action
**Approve & Merge** (§app.project-runtime/approve-merge; **Merge Branch** once approved; none when
there is nothing valid to approve) and a link to the run's session, **Read Report**. The Needs-you row
of a `playbook-review` item carries the same button under it, the one exception to that region's
rows having no button of their own (§app.session-list/needs-you).

## §app.project-runtime/approve-merge — Approve & Merge

`POST /api/projects/:pid/runtime/approve-merge {hash}` finishes a proposed run in one gesture, the
operator's only, with every rule of the two gestures it joins. It approves `hash` as
§app.project-runtime/approve does (refused, approving nothing and merging nothing, when it is no
longer the hash the branch proposes: "The definition changed since it was shown: look again.", or
for anyone else: 403 "Only the operator approves a definition."), skipping the approval when that
hash is already approved, then runs Merge Branch on the run's session
(§app.project-overseer/coding-worktrees) with all of its refusals. A merge that is refused keeps the
approval (it is keyed by the hash, so it approves nothing else) and answers 409 with "Approved
{hash12}, but the merge was refused: {its reason}". With no run proposed it is refused 409: "No
playbook run is waiting for approval." It answers the registry,
read again. The Software
card shows **Approve & Merge** in place of **Approve {hash12}** while a run is proposed (or **Merge
Branch** once its hash is approved), beside the banner's and the Needs-you row's; each says, on a
refusal, why under the button.

## §app.project-runtime/run-progress — The run as it goes

The Software card shows the live run of a verb playbook as a strip, from what Sova already keeps of
its session, with no tool of the run's own: a chip, "Working" (the live indicator) or "Idle"
("Waiting for your answers" while the run's region is waiting, "Proposed" while it is proposed),
how long since the run started ("under 1 min", "12 min", "2 h 5 min"), the session's outline "now"
line when it has one (as the session list reads it), and **Open Session**. While the run waits on
its open alignment questions, the strip says "{n} open questions in its session" in place of the
"now" line and links there as **Answer in Its Session**, where the alignment card takes the
answers.

## §app.project-runtime/run-report — The proposal, from what Sova read

While a run is proposed, the Software card shows what its branch proposes, read by the host from
the branch's `.sova/project.json` at its tip and the newest confined conformance of its hash, never
from the run's own words: each service (name, kind, scope, isolation method, slot 0's ports), each
data resource with its Sensitive chip, whether copies can be shared ("Shares {endpoints}",
"Never shared", or "Shares nothing"), the entry point ("Opens at {endpoint}{path}", or "No entry
point"), and the conformance ("Conformance passed (confined, suite v{n})" with the measured memory of
each service, or "Conformance failed at {check}: {detail}", or "No conformance of this definition
yet"). A branch with no valid definition says why ("Its branch has no .sova/project.json." / "The
definition on its branch is invalid: {error}"). Under it, **Read Report** links to the run's session,
whose last message is its report.

## §app.project-runtime/verb-playbooks — Verb playbooks

A verb playbook is a playbook whose `PLAYBOOK.md` frontmatter says what its proposal approves,
`approves: definition` (the project's `.sova/project.json`, §app.project-services/trust) or
`approves: deploy`. `project-verbs` approves `definition`. `verbs/onboard`'s `playbook` names one
by its id (lower case letters, digits and hyphens, else 400 "No playbook "{id}": a playbook id is
lower case letters, digits and hyphens."). The registry's run is keyed by the
playbook's id: it records the id, the playbook's title and what it approves, and the run strip, the
review, the banner, the Needs-you item and Approve & Merge name the playbook by its title and act on
what it approves. A playbook without `approves:` (or with any other value) is not a verb playbook,
and `verbs/onboard` refuses it: "{id} is not a verb playbook: its PLAYBOOK.md says no approves:."

A verb playbook's run may ask the operator. Its session runs with align on, beside the project's
coding mode (§app.project-overseer/coding-mode), so a decision it can't make from the repository
(which of two held ports to use, whether a resource is production data) is an alignment question,
not a guess: its open questions are the session's `open-questions` Needs-you item and push
(§chat.alignment/session-mark), and the run's region waits (§app.project-runtime/onboard). An
ordinary project coding session never gets align.
