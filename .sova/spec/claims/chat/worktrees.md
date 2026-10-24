# §chat/worktrees — Session-owned worktrees
> Part of the Sova design spec · [overview](../design/overview.md)

A session records the git worktrees it works in. pi's `worktrees` extension
(`pi-config/extensions/worktrees`) keeps the set in the session's own file, the subagents
extension lets workers start only in the session's cwd or in one of those worktrees, and Sova
shows the set in the session pane and each merge the session made as a card in the transcript.
It works the same in the TUI and in Sova, for sessions Sova holds and sessions it only watches.
Only when the user asks does Sova remove the merged worktrees of a repository
(§chat.worktrees/cleanup).

## §chat.worktrees/entry — The set lives in the session

The set is a `worktrees` custom entry in the session file. Every change appends the **whole
set**, and the newest usable entry on the active branch wins, the same rule as the mode and
sandbox entries: tree navigation, a fork and a rewind move the set with the branch. Sova reads
the set from the file itself, so it shows it for sessions it holds and sessions a TUI owns. An entry
with another version or a malformed shape is skipped, never half-read. Opening a session writes
nothing.

Each worktree records its path, its branch, the commit it was based on, its status (`active`,
`dropped` or `merged`; a merge adds the target branch and the resulting commit), and who put it
there: the session id, and `created` or `attached`. Dropped and merged worktrees stay in the set
as history.

## §chat.worktrees/tool — The `worktree` tool

The parent session's agent manages the set with one tool, `worktree`, and there is no command
and no pane control: the user asks the agent. Workers and team members never have the tool (it
is not in their loadout, and a worker's `extensions` may not load it). The tool runs git itself,
by argument list with no shell, locally only (a remote session refuses it).

- **create** `{name, base?, path?}`: `git worktree add -b feat/<name>` from the session repo's
  main checkout, at `<parent of the main checkout>/.worktrees/<repo>-<name>` unless `path` is
  given, based on `base` or the session cwd's `HEAD`. The branch it is based on (`base` when it names a
  branch, else the branch the cwd has checked out; none for a commit or a detached HEAD) is kept as
  its base branch, which is where git first looks for it merged (§chat.worktrees/merged-state); it
  is not the `merge` default. It is tracked as `created`.
- **attach** `{path}`: tracks an existing worktree top level (a subdirectory, or a detached HEAD,
  is refused) as `attached`; its base is its fork point from `master` (else `main`). A worktree
  another session created may be attached.
- **detach** `{path}`: marks it `dropped`. Nothing is deleted on disk.
- **merge** `{path, target?}`: merges the worktree's branch into `target` (default `master`, or
  `main` in a repository without `master`, whatever its base branch) and records the merge (§chat.worktrees/merge-card). Where `target` is checked out, that checkout
  must have no tracked changes, and the merge runs there (fast-forward when possible, else a merge
  commit; a conflict is aborted and reported, changing nothing). Where it is not checked out, only
  a fast-forward is done. In a project that turns the merge guard on, a merge into `main` or
  `master` also needs the user's go-ahead for that exact commit (§chat.worktrees/merge-guard).
- **list**: the set with each worktree's status.

`detach` and `merge` take the worktree's path or its branch name. Every answer lists the
resulting set.

## §chat.worktrees/sandbox — With the sandbox on

While the session's sandbox is on (§chat/sandbox), `create`, `attach` and `merge` ask the user
first, with the path and branch named; a declined or unanswerable request (no UI) changes
nothing. Every active worktree of the set is a writable root of the session and of its workers
while the sandbox is on (one under a shadowed cache stays a real root, like the session's cwd),
and its `.agent` directory stays read-only inside it, like the session's own agent dir. A
worker's sandbox scope also carries the parent's hidden list and proxy and environment
allowlists, so a worker on a worktree's own agent dir (§chat.worktrees/worktree-config) is never
looser than its parent because of that dir's policy file.

## §chat.worktrees/workers — Where workers may start

A worker may start only in the session's own cwd (or below it), or inside one of the set's
**active** worktrees; any other cwd is refused at spawn with a message naming the session's
worktrees. The check is one gate every start goes through: `agent_spawn`, `team_create`,
`team_add`, a team successor and `agent_resume`, for pi and Claude Code workers alike. A remote
session is not checked (its worker cwds are paths on the target). A worker the parent picks back up after a reload or a server restart is kept even if its cwd is no longer allowed: `agent_list` flags it "outside this
session's worktrees", and nothing kills it.

A **pi** worker started inside an active worktree writes only inside that worktree (and its git
dirs, §chat.sandbox/what-on-enforces) unless the session's sandbox is Off
(§chat.sandbox/states): under On its sandbox scope is narrowed to the worktree; under Subagents
only it starts under the sandbox in **write-only** confinement: its writes go only to the
worktree, its git dirs and a private scratch tmp (and the sandbox's private copies of the host
caches). Its reads are the host's, no secret is hidden, the network is the host's (its resolver
included) and the environment is passed as it is. No policy file is read for it.

- **`/tmp`.** On Linux it sees the host's `/tmp` read-only, so a file another session wrote
  there (a brief) is readable, and every Unix socket found there as its command or its process
  starts reads as an empty file, so it cannot drive a terminal multiplexer, an ssh agent or
  another service through one. The sockets are found in the kernel's list of bound sockets
  (`/proc/net/unix`), so how many files `/tmp` holds does not matter, and in a shallow scan of
  `/tmp` and the folders directly in it. `TMPDIR` points at its private scratch, which is where
  Claude Code and other tools that honour it keep their temp files; a tool that writes a literal
  `/tmp` path fails with "Read-only file system". When that list cannot be read, or cannot be
  read unambiguously (a socket path with a line break in it, or one bound by a relative path),
  its `/tmp` is the private scratch instead. On macOS Seatbelt never remapped `/tmp`: the host's
  is readable there, as before.
- **Still a sandbox.** `/run` is empty, so the Docker socket and the user's D-Bus and systemd are
  gone, and the worker runs in a user namespace, where root-owned files belong to the overflow
  user: ssh refuses a root-owned config file ("Bad owner or permissions"; `ssh -F /dev/null`
  works). A worker that needs Docker or the host's own ssh config needs Off.

Under Off the worker starts unconfined, like one outside a worktree. Under On or Subagents only,
if the sandbox extension is missing or gives no scope for the worktree, the spawn is refused. A
Claude Code worker is a pi worker (§app.subagents-pane/claude-code-workers) and is confined exactly
as above.

## §chat.worktrees/worktree-config — A worker on the worktree's own agent dir

By default a worker runs on the session's agent dir. `agent_spawn {useWorktreeConfig: true}`,
valid only for a pi worker whose cwd is inside an active worktree that has a `.agent`
directory, runs it on `<worktree>/.agent` instead: `PI_CODING_AGENT_DIR` points there, its
session file is still written in the parent's sessions directory (so Sova shows its
transcript), that tree's `mode` extension (its real path must be a mode extension) is loaded
explicitly in normal mode with the spec minor mode, and the project is trusted for the run
(`--approve`). A Claude Code worker, being a pi worker, may use it too. It is refused outside an
active tracked worktree, or when the worktree has no `.agent`. Extension discovery stays off, and
the tree's subagents and worktrees extensions are never loaded. The model policy is still the
parent's. The choice is recorded with the worker, so a resume applies it again.

That mode extension knows it runs in a worker (the worker marker tells it on the extension bus,
so an older tree's extension just doesn't hear it): it ignores the `mode` snapshots a `fork` copied
from the parent's branch and the tree's `mode.json`, so the worker is always in normal mode with
spec and never strict; it is never offered a spec writer; and its spec block is the worker form
(§chat.mode-menu/workers). The parent's own worker modes are not added on top.

## §chat.worktrees/inherit — Forks share the set

A fork (pi's `/fork` or `/clone`) starts with its source's set, because the entry is on the copied
branch. A worktree whose recorded session is another session is **shared** with that session;
the pane says so.

## §chat.worktrees/merge-card — A card for each merge this session made

A merge made with `worktree merge`, or with plain git during one of this session's turns, is
recorded: after each turn the extension checks every active worktree's branch with
`git merge-base --is-ancestor` against its target, and a branch that became merged during the
turn is recorded as `detected`. The record appends an extension message whose text the model
reads as one line — "Merged feat/x into master at abc1234, 5 commits, +120 −30" — and the
worktree's status becomes `merged`. In a project with a spec (`.sova/spec/`), the model also gets
"Spec warning: …" lines, only ones it can act on, and each only once: a `worktree merge` says them
in its answer, and its card's message carries the merge line alone; a merge seen after a turn says
them in its message. They are: the changed files no claim maps (spec any whose change a user
sees); a draft with records never promoted, in the worktree or in another worktree whose branch
the merge brings in, said once per draft in a session and again when its pending § change (into
a branch other than the repository's default: promote them on it before it lands; into the
default branch, master or main: they didn't land with the code, and stay in the worktree's drafts
folder until they are promoted on a fresh branch from the default branch, never on it directly;
another session's are named); a merge commit that resolved § by hand (they differ from both parents); an
evidence commit the branch no longer contains; and that the spec warnings could not be computed.
No line names the § the merge changed, deleted or renamed, or the § whose mapped code changed
under unchanged prose, and none asks for a line in the reply. Those lines never change the card. The message never starts a turn; one sent while a turn runs
lands when that turn ends. A branch with no commits beyond its base is never "merged". The TUI
draws it as a card, and Sova's transcript renders a **merge card**: the worktree path, branch,
target branch, resulting commit, commit count, lines added and removed, and whether it was a
fast-forward or a merge commit; a detected one also says "seen after the turn". At the end of its
head (below it when the column is narrow) a **Review Changes** control, labelled with the branch
for a screen reader, opens the changes viewer on what the merge brought in (§chat.changes/entry);
a card in a transcript Sova can't tie to a session has none. Details Sova can't read render as the
plain text.

A tool merge's commit is the target's new tip, and its count and lines are the target's own change.
For a merge seen after a turn, the commit is the first one on the target's first-parent history
since the turn started that contains the branch: the branch tip itself when the target
fast-forwarded through it, which is then shown as a fast-forward. Its count and lines are the
branch's own commits and changes relative to the target at the turn's start, never the whole
turn's. Branches that arrive together, such as several merged into an integration branch that is
then merged into the target, each get their own card with their own numbers, and several may name
the same commit.

A merge this session did not make gets no card; the pane still shows the worktree as merged
(§chat.worktrees/pane).

## §chat.worktrees/merged-state — When git finds a worktree merged

A tracked worktree counts as merged when its branch has commits beyond its base and all of them
are in its base branch or in the repository's main branch (master, else main), whether or not a
merge was recorded. A worktree made from another feature branch whose commits reached master but
never that branch is merged into master. The target it is merged into is its base branch when
that branch has it, else the main branch; one merged into neither is checked against its base
branch (the main branch when it has none). A check that names its target, such as the one after
a turn against the target seen at the turn's start, looks at that target only.

## §chat.worktrees/pane — The Worktrees section

The session pane's Session tab (§app.subagents-pane/tabs) shows a read-only **Worktrees**
section right after Repository: a count line ("2 active · 1 merged · 1 removed · 1 dropped", a
worktree tracked active whose folder is gone counted as its status chip reads), then one row per
worktree in recorded order, dropped and merged ones included. When the branch tracks none the
section stays, with one line: "This session tracks no worktrees." While the insight's first load
is out the section shows its heading over a placeholder line as tall as that sentence (most
sessions track none), never the sentence itself. A row
names the branch and the path, and carries a status chip — Active, Dropped, or Merged with "into
<target> at <sha>" — plus, when true, `.agent`, the number of
this session's workers with a live process inside it, and "Shared with session <id>" linking the
session it was inherited from. An active worktree whose branch git finds already in its target
reads Merged too, with a title saying this session didn't record it. A worktree whose folder is
gone never reads Active: its status chip says what its work came to, by the same answer readiness
gives (§chat.worktrees/readiness, removed), the row's readiness when it has one: Merged when that
work is merged, then a neutral Cleaned up chip; else Removed (warn; neutral for one with no commits
of its own), with the reason line "Removed · not merged", "Removed · no record of a merge" or
"Removed · no commits". A dropped or merged-recorded worktree whose folder is gone keeps its status
chip and adds Removed or Cleaned up. A row with a readiness
(§chat.worktrees/readiness) adds a chip after the status chip — Ready to merge (the row's and
the digest's words), Waiting for your OK, In progress, Blocked or Stale, with the reason as its
`title` — and none while merged or removed, which the status chip already says. Its tone follows
mergeability, as the list row's lit worktree count does (§app.session-list/content-rules): Ready
to merge and Waiting for your OK are success, In progress neutral, Blocked and Stale warn. A
worktree that is Ready to land (§chat.worktrees/ready-to-land) reads **Ready to land** (success) in
place of Ready to merge or Waiting for your OK, and its line starts "Ready to land"; one Landing
specs reads **Landing specs** (info; warn, with the session's reason as its `title`, when it can't
land them) with the line "Landing specs · 2 drafts" (and "· can't land them: <why>"). Under the facts, one visible
muted line gives the reason, so a phone gets it without hover: the readiness's `reason` ("Ready to
merge · checks passed · 19 commits ahead", "Conflicts with master · 17 files"), else the chip's
word and the why joined by " · ", and no line when there is neither. It wraps; it never truncates. The section follows the
file: it updates as the session's file changes, with no control of its own.

## §chat.worktrees/readiness — Is it ready to merge, and what did a merge leave

Every worktree a session tracks and created or attached itself (not one it inherited, and not a
dropped one) gets a **readiness**, worked out on the server from git and the session's file with
no model call (`server/merge-readiness.ts`):

- **merged** — git finds the branch in its base branch, by ancestry or by content (a squash or a
  rebased merge train), after at least one commit of its own, **and** the tree is clean. A
  worktree whose folder is gone reads as what its work came to (below, **removed**). Git is the
  source, never the merge card: a branch merged by someone else reads merged, and a card whose
  branch git no longer finds merged does not. A worktree still tracked active once git finds it
  merged is merged with a **cleanup** follow-up.
- **stale** — merged, but the tree has uncommitted changes while nothing runs in the session:
  never "merged". A branch with no commit of its own is never merged, dirty or not.
- **in progress** — a turn is running or subagents are working in the session, the tree has
  three or more uncommitted files, the branch has no commit of its own yet, it **conflicts with
  its base** (the trial merge git already runs for an unmerged branch reports conflicts), a
  commit subject on the branch starts with `TEMP`, `WIP`, `fixup!`, `squash!` or `amend!`, or the
  session's newest check run (a `bash` call running a test, typecheck or build) failed.
- **removed** — the worktree's folder is gone, and what its work came to is said plainly, never
  "in progress" or "active". It is **merged** instead, with the reason "Merged · cleaned up", when
  git still finds its branch in the repository's main branch (master, else main), by ancestry or
  by content as above, after at least one commit of its own past the recorded base; when Sova's
  own cleanup removed it (§chat.worktrees/cleanup's ledger); when another session's file records
  the same path and branch merged (the Merge Captain's own record of the merge it made, which
  outlives the `git branch -d` of its clean-up step, §chat.merge-round/round), as far as readiness
  has read that session; or when it is recorded merged. Otherwise it is removed: "Removed · not
  merged" when git finds its branch with commits of its own that are in neither, "Removed · no
  commits" when the branch never moved past its base (an empty leftover, which changes no count
  or badge), and "Removed · no record of a merge" when the branch is gone too and nothing records
  a merge. Git is read from the session's folder, another of its trees still there, or a folder
  beside the gone one (a sibling worktree, or the main checkout the `worktree` tool's layout
  names), only in a repository that has the recorded base and where the branch descends from it;
  a branch git finds there decides over every record.
- **blocked** — the session waits on open alignment questions (§chat.alignment/session-mark).
- **ready** — at least one commit ahead, and none of the above. One or two uncommitted files do
  not stop it: it is ready with a caveat that names them (a regenerated report file is the usual
  case). The session's newest check run passing is recorded with it; a session that ran none is
  still ready, and says so.
- **waiting for your OK** — ready, and the session's last reply (no user prompt after it) asks the
  user something: the attention signal's ask answer when it has one for that reply
  (§app.decisions/attention-signals), else the reply's last 600 characters asking to merge ("Shall
  I … merge…?", "Want me to merge…", "OK to merge?", "ready to merge", "say merge"). The closing
  spec lines (`Also changes:`, `Also updates:`, `Deferred:`, `Plumbing:`, `Spec check override:`) are cut from the
  whole reply **before** its last 1,500 characters are kept, here and for the follow-up check
  (§app.decisions/merge-followup), so a long spec line never crowds out the reply's body.

Each worktree carries a **reason**, one line a person reads without hovering (the Session tab
shows it under the worktree, §chat.worktrees/pane): its state and why, joined by " · " — "Ready to
merge · checks passed · 19 commits ahead", "Ready to merge · 1 uncommitted file:
NAIVE-RUN.txt", "Waiting for your OK · checks passed", "Conflicts with master · 17 files",
"Blocked · 2 open questions", "In progress · 3 uncommitted files: a.ts and 2 more", "In progress ·
working now", "Merged", "Merged · still tracked active", "Merged · cleaned up", "Removed · not merged", "Stale
· merged, with uncommitted changes". Uncommitted files are named by the first one and how many more.

Routine follow-ups, also mechanical:

- **restart pending** — a merge this session made (a merge card) landed in the branch this
  server's own checkout runs, changed a file under `server/`, `shared/` or `pi-config/` (or
  `package.json`, `pnpm-lock.yaml`), and happened after this server process started. A merge of
  only `src/` or docs never asks for a restart. The next start clears it.
- **not pushed** — the merge's commit is not yet on the target's `origin` branch. Said in the
  badge's `title`, never counted as a follow-up.
- **cleanup** — merged worktrees still tracked active.

Git is read in the background, at most every 20 seconds per session while the file doesn't change,
and only for session files that ever wrote a `worktrees` entry, so a listing never waits on git.

**The row's count** (§app.session-list/content-rules) counts a worktree as merged when git finds
its branch merged into its base (the merged rule above without the clean tree), clean or not, or,
its folder gone, when it reads merged by the removed rule above. A merged tree with uncommitted changes therefore
counts as merged there while its own state stays stale or in progress, as above: the count's
`title`, the Session tab's chip, the badge and the attention digest still read that state. Each
worktree's readiness carries the fact (`merged: true`) beside its state.

**The row's badge** (§app.session-list/anatomy) is one short phrase from the session's worktrees,
the first that holds: "Waiting for your OK" (a worktree waits for the go-ahead) and "Ready to
merge" (one is ready) — the two states the row's count already lights for, and the two the
Overseer's decide tier words ("Ready to merge: {branch}", §app.overseer/attention-digest) — none
while another worktree is in progress, stale or blocked (the busy and open-question
marks say it), "restart pending", the follow-up count ({n} = only the
§app.decisions/merge-followup answer when it names small or significant work; leftover worktrees
— cleanup — are said only in the `title`, never counted), and "merged". **The row writes only the
two a count cannot**: "restart pending", and the follow-up count as "{n} follow-up(s)" — never
"merged", which the count already says, and never the ready or waiting phrases, which the count's
own light and `title` carry. An **empty leftover
worktree** — no commit of its own, a clean tree, nothing running — never changes the count. Its `title` names each worktree with its state and every
routine follow-up in words, one line each.
The session's `readiness` travels with its row in the session list (`SessionSummary.readiness`),
so the Overseer reads the same answer. An open offer card (§chat.offers/card) is no reply that
asks: it never makes a worktree wait for your OK. Offers' conditions read readiness as it will be
once the turn ends (§chat.offers/conditions).

**The branch status line**, counted in code with no model call, for the session's newest merge:
"merged {sha7} · pushed (or not pushed) · live (or restart owed) · spec promoted (or {n} spec
draft(s) not promoted)". Merged and the commit come from the merge card; pushed from the target's
`origin` branch (left out when there is no `origin`); live when this server already runs the
merge (it started after it, or the merge changed no server file), else restart owed; spec from
the merged worktree's own `.sova/spec/drafts/`, while that folder still exists: a draft counts as
promoted when every spec file it changed now reads the same in the worktree's current spec, or a
promotion the draft records wrote that file after the draft's last edit to it (a promotion into a
spec that had moved merges the two, so the current file is not the draft's copy). The
line is the first line of the badge's `title` (§app.session-list/anatomy) and travels with the
row (`SessionSummary.readiness.status`).

Routine session-list and merge-readiness refreshes never query spec assessment status or
recapture assessment inputs, including for idle merged worktrees, and never run a spec tool.
The one spec fact readiness carries is the status line's draft count, read from the drafts'
files and kept until one of them changes. Readiness carries no other spec observation, and the
row and its title display none. Ordinary git readiness, bash checks,
attention items, and routine follow-ups keep the rules above. Explicit companion CLI
assessments remain separate and available; their observations are not passed tests or release
gates.

**In the attention digest** (§app.overseer/attention-digest), decide tier, never Needs you, a brief
or a phone notification: "Ready to merge: {branch}" for a ready worktree and "Waiting for your OK:
{branch}" for one waiting for the go-ahead, while the session is idle; "Merged with open work:
{cue}" for a merge the follow-up check calls significant; and one "Restart pending" item for the
whole server, however many sessions' merges ask for it, naming how many merges and their
branches.

## §chat.worktrees/ready-to-land — Ready to land

A worktree a session tracks is **Ready to land** at its head commit when, worked out with no model
call beside its readiness (§chat.worktrees/readiness):

- git can read it, it isn't merged, it has **no uncommitted files at all** (the one-or-two-file
  caveat of ready doesn't apply), at least one commit ahead, no conflicts with its base and no
  temporary commit subject;
- the session's newest check run isn't failing, it has no open alignment question, and nothing
  runs in it;
- and **the work is finished**: the session's latest turn outcome (§app.decisions/attention-signals,
  the turn card) says it did what was asked, which covers done and done-but-unverified. Whether the
  last reply asks something doesn't matter: a finished reply that asks "shall I merge?" is still
  Ready to land. When Decisions' attention signals are off, or turned off for the session's folder,
  there is no outcome to read, and the code-only conditions above decide alone.

Once a head commit is Ready to land it **stays** so for that commit, kept per session and worktree
in `<state root>/ready-to-land.json`, even when a later reply asks nothing or its outcome says
something else; it goes when the branch's head moves, the branch lands, or a live condition above
stops holding (a new uncommitted file, a failing check, an open question, a turn running).

**Specs land with the branch.** When the worktree holds spec drafts not yet promoted, the landing
reads **Landing specs** instead (the Session tab's chip, its line "Landing specs · 2 drafts", and
the merge board, §chat.worktrees/merge-board). Sova then tells the session once per head commit,
as a message in its chat, to make its specs official on its own branch (promote its drafts) and
commit them, or, when it can't, to answer with one line `Can't land specs: <why>`; the user is
never asked. The session's newest reply with that line gives the why, shown on the chip and the
Landing card (§chat.offers/sova-landing). Once the drafts are promoted and committed the new head
is Ready to land by the same rule.

**What still blocks the card.** When the session's latest turn outcome says its work is finished
but a worktree it tracks isn't Ready to land at its head for reasons the session can fix itself
(uncommitted files, spec drafts not promoted, conflicts with its base, a temporary commit subject,
a failing check run), and the project's offers file has an offer shown only when Ready to land
(`ready-to-land`, as Sova's own Landing offer), Sova tells the session once per head commit, as a
message in its chat, what still blocks its landing card, each blocker counted ("1 uncommitted file,
11 spec drafts to make official"): to fix them on its branch, and that the card shows only once
nothing does. That message never mentions Land It. When spec drafts are the only thing left, the
specs message above is sent instead. Nothing is sent while a turn runs, for an archived or
terminal session, or when the outcome doesn't say the work is finished (or no outcome is ever
recorded for the session).

The Session tab's chip reads **Ready to land** (or **Landing specs**) in place of Ready to merge or
Waiting for your OK while it holds; every other reader of readiness (the row's badge, the digest,
the offers' `branch-ready`) is unchanged.

## §chat.worktrees/merge-guard — Merging into master needs your go-ahead

A project turns this on in its offers file with `"mainMerges": "go-ahead"` (§chat.offers/file);
Sova's own repository does. Read from the target branch itself (`git show
refs/heads/<target>:.sova/offers.json`), so a branch can't switch it off for its own merge. Then:

- the `worktree merge` tool (§chat.worktrees/tool) into `main` or `master` refuses, merging
  nothing, unless the user's go-ahead for that branch at exactly its current head commit is
  recorded: "This project lands branches on master only with the user's go-ahead for this exact
  commit. Once the branch is Ready to land, the merge captain queues it and Sova shows its landing
  card; until then there is no card to press." Land It (§chat.offers/sova-landing) records it in
  `<state root>/landing.json`, outside every repository. A session on the Merge Captain profile
  (its newest profile entry) is exempt: it lands on the user's Land It as before.
- the Project Overseer's Merge Branch (§app.project-overseer/coding-worktrees) into `main` or
  `master` follows the same rule: pressed on the operator's own page it is the go-ahead itself (and
  is recorded); asked any other way it is refused without one for the branch's head.

**A clean master merge keeps the go-ahead.** A go-ahead recorded for a branch at commit P also
counts at its head M when M is a clean merge of the target into P: M has exactly two parents, P
first and a commit already on the target branch second, and M's tree is exactly the tree `git
merge-tree --write-tree` makes of those two parents (no conflict, nothing edited by hand). It
carries through a chain of such merges (master merged in again after it moved), up to 20. Any
other new commit (a merge with an extra edit, a resolved conflict, three parents, or a commit of
the branch's own) needs a new go-ahead. The `worktree merge` tool, Merge Branch and the merge
round's driver (§chat.merge-round/driver) all apply this one rule; `landing.json` is unchanged.

Merges into any other branch, typed `git` commands and projects without the key are unchanged.

## §chat.worktrees/cleanup — Removing merged worktrees

Sova removes merged worktrees only when asked: by the user from a new session's empty state
(§chat.transcript/empty-worktrees), or by `sova_archive` with `worktrees: "remove"` for the
archived session's own worktrees (§app.overseer/tools), both through one service on the server
(`server/worktree-cleanup.ts`). Nothing removes a worktree on its own, and the `worktree` tool's
merge stays non-destructive.

- **Which trees.** Git's own list (`git worktree list`) for the repository the session's folder is
  in: every linked worktree in it, wherever its folder is; the main checkout is never one. A remote
  session's folder has none. Each is **merged** (§chat.worktrees/merged-state, against the
  repository's main branch, master else main: its branch's tip is in it by ancestry, or by content
  — a trial merge that leaves the main branch's tree unchanged — after at least one commit of its
  own), **empty** (its branch has no commit of its own: its tip is still the commit git's reflog
  says the branch was created at; with no reflog, a branch in the main branch counts as merged), or
  **unmerged** (anything else, a tree on no branch included).
- **The count.** `GET /api/worktrees/summary?path=<session>` answers the repository's linked
  total and its merged, empty and unmerged counts, from git alone. It is cached per repository for
  about 30 seconds, and a change to git's list of worktrees or a removal drops it.
- **What is kept, and why.** A merged or empty tree is removed only when none of these holds, each
  checked again right before its removal: it is locked; it has any uncommitted change or untracked
  file (ignored files don't count, as with git's own remove); a session's folder (its header cwd),
  archived or not, is inside it; a session tracking it as active (§chat.worktrees/entry) is open in
  a TUI, running (a turn in flight or workers working), or has its sandbox on; a live process's
  working directory or an open file is inside it; a live record under its own
  `.agent/sessions/live` names a process that is still alive. A tree tracked active only by idle,
  sandbox-off sessions whose folders are elsewhere is removed: git says its work is in the main
  branch. Each kept tree carries one reason. An unmerged tree is always kept.
- **Dry run first, then only what was confirmed.** `POST /api/worktrees/cleanup {path, dryRun:
  true}` answers what would go (path, branch, merged or empty, and whether its branch would be
  deleted) and what stays, each with its reason. A removal posts `{path, expect: [paths]}` and acts
  only on those paths, each only if it is still removable at that moment; every other tree is left
  alone. The answer says, per path, removed or kept and why.
- **Removal.** From the main checkout, `git worktree remove -- <path>`, never `--force`, so git
  refuses a tree that changed under it; for a folder already gone the same command only drops it
  from git's list. The branch is deleted with `git branch -d` only when it is an ancestor of the
  main branch (merged by ancestry, or empty); a content-merged branch is kept, so its commits keep
  a ref. Git's refusals are reported, never forced. Nothing else on disk is touched, and no
  session file is written.
- **The ledger.** Each removal appends `{v: 1, path, branch, commonDir, tip, merged: "ancestor" |
  "content" | "empty", branchDeleted, at}` to `<state root>/removed-worktrees.json`, written by
  atomic rename, the newest 2,000 kept. Readiness reads it for a removed tree whose branch was
  deleted (§chat.worktrees/readiness).
- **The Merge Captain** removes the worktree of a branch it has landed with plain git in its own
  playbook step (§chat.merge-round/round), not through this service: git's own checks, and no
  ledger entry.

## §chat.worktrees/dirty-freshness — How old a tree's uncommitted-changes reading may be

Readiness (§chat.worktrees/readiness) reads each worktree's uncommitted changes with `git status`,
and a reading stands for a while before it is read again:

- **10 seconds** while the session is running: a turn, or working subagents.
- **5 minutes** while the session is idle and the tree's last answer was **merged** (merged and
  clean). A hand edit in an idle merged tree can therefore take up to 5 minutes to read "Stale ·
  merged, with uncommitted changes".
- An idle session's other trees are read again with the session, every 5 minutes
  (§app/idle-git-cache, "Idle sessions"). A hand edit in an idle tree that isn't merged can
  therefore also take up to 5 minutes to show, as "In progress · 3 uncommitted files" or as a
  caveat on ready.
- Whatever the lifetime, a commit, `git add`, a checkout or a branch switch in the tree ends the
  reading at once: the tree's index and HEAD are part of what it was read from. While the session
  feed runs (§app.decisions/push), such a change, or its base branch moving, is noticed within
  5 s with no session-file write: that row alone is read again and the list says so.
- A removal through Sova's cleanup (§chat.worktrees/cleanup: the Clean Up Merged button, its
  confirm, or `sova_archive`'s removal) ends the reading at once for every session that tracks
  the removed tree: the cleanup answers only once those sessions are read again, so the very next
  look, the Session tab's or the session list's, reads the tree as removed ("Merged · cleaned up").
- A change of the session's file or of its row (its running state, last activity, TUI presence,
  archived flag, open questions or attention answer) reads every tree's changes again at once.
- An explicit look at the session's worktrees (the Session tab's Worktrees section, or
  `sova_session`'s Merge facts) re-reads every tree's changes when one of its readings may have
  stood the 5 minutes, or when the session is idle with its trees checked without Git
  (§app/idle-git-cache) and its answer is 10 seconds old: that look returns the answer it has at once, and the re-read shows on the next one. A look at an archived, idle session re-reads them under its own rule
  (§app/idle-git-cache, "Archived-idle exception").

## §chat.worktrees/merge-board — The merge board file

Sova keeps its readiness view (§chat.worktrees/readiness) of every tracked worktree in one file,
`<state root>/merge-board.json`, so a playbook's script learns who owns which branch with no token
and no HTTP call (the merge round's driver, §chat.merge-round/driver); the schedule keeper's
`merge-ready` trigger reads the same board in-process.

- **What it holds.** `{v: 1, at, read, pending, rows}`: when it was written, how many sessions
  readiness has read and how many it hasn't yet (`pending`: while above 0, a missing row is
  unknown, never "no owner"). A row per worktree path: its canonical `path`, `branch`, `repo` (the
  common git directory, read from the worktree's `.git` entry without running git; null when
  unreadable), readiness `state` and `reason`, its `landing` when it is Ready to land or Landing
  specs (§chat.worktrees/ready-to-land: `state`, the full head `commit`, the unpromoted `drafts`, the
  session's `specsWhy`), `readAt`, and its `owner`: session id, title, status
  `idle` | `busy` | `archived`, profile id (null for Default) and last activity. Rows are sorted by
  path.
- **Who owns a row.** Built only from readiness's own last answers, never by reading git or a
  session file for it. Sessions readiness never covers are left out, and so are sessions running
  as the merge captain's profile (`merge-captain`), which attach worktrees only to check them. When
  several sessions track one path, one not archived wins, then the most recently active. An owner
  is busy while its turn runs, a worker is working, or it holds a queued message.
- **When it is written.** Rebuilt every minute while the server runs (first about 10 seconds after
  start); the file is replaced whole by atomic rename, mode 0600, only when its content (all but
  `at`) changed, and at least every 2 minutes, so a reader never takes a running server's board for
  stale. A rebuild lists the sessions and waits up to 20
  seconds for the readiness reads that listing asked for; concurrent asks share one rebuild. A
  write that fails is logged and the board is still used in-process.
