# §chat/worktrees — Session-owned worktrees
> Part of the Sova design spec · [overview](../design/overview.md)

A session records the git worktrees it works in. pi's `worktrees` extension
(`pi-config/extensions/worktrees`) keeps the set in the session's own file, the subagents
extension lets workers start only in the session's cwd or in one of those worktrees, and Sova
shows the set in the session pane and each merge the session made as a card in the transcript.
It works the same in the TUI and in Sova, for sessions Sova holds and sessions it only watches.

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
  given, based on `base` or the session cwd's `HEAD` (whose branch becomes its default merge
  target). It is tracked as `created`.
- **attach** `{path}`: tracks an existing worktree top level (a subdirectory, or a detached HEAD,
  is refused) as `attached`; its base is its fork point from `master` (else `main`). A worktree
  another session created may be attached.
- **detach** `{path}`: marks it `dropped`. Nothing is deleted on disk.
- **merge** `{path, target?}`: merges the worktree's branch into `target` (default `master`, or
  `main` in a repository without `master`) and records the merge (§chat.worktrees/merge-card). Where `target` is checked out, that checkout
  must have no tracked changes, and the merge runs there (fast-forward when possible, else a merge
  commit; a conflict is aborted and reported, changing nothing). Where it is not checked out, only
  a fast-forward is done.
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
session is not checked (its worker cwds are paths on the target). A hosted worker adopted after a
restart is kept even if its cwd is no longer allowed: `agent_list` flags it "outside this
session's worktrees", and nothing kills it.

A **pi** worker started inside an active worktree writes only inside that worktree (and its git
dirs, §chat.sandbox/what-on-enforces): with the parent's sandbox on, its sandbox scope is
narrowed to the worktree; with it off, the worker starts under the sandbox in **write-only**
confinement: its writes go only to the worktree, its git dirs and a private tmp (and the
sandbox's private copies of the host caches), while nothing is hidden, the network is the host's
(its resolver included) and the environment is passed as it is. No policy file is read for it.
If the sandbox extension is missing or gives no scope for the worktree, the spawn is refused. A
Claude Code worker there is confined the same way, narrowed to the worktree or write-only, with
its own state and token as §chat.sandbox/claude-state says; in write-only its environment is the
host's less any login or token variable.

## §chat.worktrees/worktree-config — A worker on the worktree's own agent dir

By default a worker runs on the session's agent dir. `agent_spawn {useWorktreeConfig: true}`,
valid only for a pi worker whose cwd is inside an active worktree that has a `.agent`
directory, runs it on `<worktree>/.agent` instead: `PI_CODING_AGENT_DIR` points there, its
session file is still written in the parent's sessions directory (so Sova shows its
transcript), that tree's `mode` extension (its real path must be a mode extension) is loaded
explicitly in normal mode with the spec minor mode, and the project is trusted for the run
(`--approve`). It is refused for a Claude Code worker, outside an active tracked worktree, or when
the worktree has no `.agent`. Extension discovery stays off, and
the tree's subagents and worktrees extensions are never loaded. The model policy is still the
parent's. The choice is recorded with the worker, so a resume applies it again.

That mode extension knows it runs in a worker (the worker marker tells it on the extension bus,
so an older tree's extension just doesn't hear it): it ignores the `mode` snapshots a `fork` copied
from the parent's branch and the tree's `mode.json`, so the worker is always in normal mode with
spec and never strict; it is never offered a spec writer; and its spec block is the worker form
(§chat.mode-menu/workers). The parent's own worker modes are not added on top.

## §chat.worktrees/inherit — Forks and fanouts share the set

A fork or a fanout member starts with its source's set, because the entry is on the copied
branch. A worktree whose recorded session is another session is **shared** with that session;
the pane says so.

## §chat.worktrees/merge-card — A card for each merge this session made

A merge made with `worktree merge`, or with plain git during one of this session's turns, is
recorded: after each turn the extension checks every active worktree's branch with
`git merge-base --is-ancestor` against its target, and a branch that became merged during the
turn is recorded as `detected`. The record appends an extension message whose text the model
reads as one line — "Merged feat/x into master at abc1234, 5 commits, +120 −30" — and the
worktree's status becomes `merged`. In a project with a spec (`.sova/spec/`), that text and the
`worktree merge` answer go on with a line naming the § the merge changed that it didn't create,
computed from the spec's history across the merge — "Foreign § this merge changes: §a, §b", or
"none" — then, when the merge deleted or renamed §, a line naming them ("Deleted § (still
foreign): §x, §y → §z"), a line naming the § whose mapped code the merge changed while their
prose didn't ("Code changed under unchanged §: …", to read, not a required name), and one
"Spec warning: …" line each for the changed files no claim maps (each needs a claim or a
"Plumbing: <path> — <why>" line in the reply), a draft with records never promoted in the
worktree or in another worktree whose branch the merge brings in (into the repository's default
branch, master or main: promote them now, since no "Deferred:" line passes there; into any other
branch: promote them, or name the § left stale on a "Deferred: §… — <why>" line), a merge commit that resolved § by hand (they differ from
both parents), an evidence commit the branch no longer contains, and code committed after the
branch's last spec commit. Those lines never change the card. The message never starts a turn; one sent while a turn runs
lands when that turn ends. A branch with no commits beyond its base is never "merged". The TUI
draws it as a card, and Sova's transcript renders a **merge card**: the worktree path, branch,
target branch, resulting commit, commit count, lines added and removed, and whether it was a
fast-forward or a merge commit; a detected one also says "seen after the turn". Details Sova
can't read render as the plain text.

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

## §chat.worktrees/pane — The Worktrees section

The session pane's Session tab (§app.subagents-pane/tabs) shows a read-only **Worktrees**
section right after Repository: a count line ("2 active · 1 merged · 1 dropped"), then one row per
worktree in recorded order, dropped and merged ones included. When the branch tracks none the
section stays, with one line: "This session tracks no worktrees." While the insight's first load
is out the section shows its heading over a placeholder line as tall as that sentence (most
sessions track none), never the sentence itself. A row
names the branch and the path, and carries a status chip — Active, Dropped, or Merged with "into
<target> at <sha>" — plus, when true, Missing (the directory is gone), `.agent`, the number of
this session's workers with a live process inside it, and "Shared with session <id>" linking the
session it was inherited from. An active worktree whose branch git finds already in its target
reads Merged too, with a title saying this session didn't record it. A row with a readiness
(§chat.worktrees/readiness) adds a chip after the status chip — Ready, Waiting for your OK, In
progress, Blocked or Stale, with the reason as its `title` — and none while merged, which the
status chip already says. The section follows the
file: it updates as the session's file changes, with no control of its own.

## §chat.worktrees/readiness — Is it ready to merge, and what did a merge leave

Every worktree a session tracks and created or attached itself (not one it inherited, and not a
dropped one) gets a **readiness**, worked out on the server from git and the session's file with
no model call (`server/merge-readiness.ts`):

- **merged** — git finds the branch in its base branch, by ancestry or by content (a squash or a
  rebased merge train), after at least one commit of its own, **and** the tree is clean. A
  worktree whose folder is gone reads as its record says: merged when recorded merged, else in
  progress. Git is the
  source, never the merge card: a branch merged by someone else reads merged, and a card whose
  branch git no longer finds merged does not. A worktree still tracked active once git finds it
  merged is merged with a **cleanup** follow-up.
- **stale** — merged, but the tree has uncommitted changes while nothing runs in the session:
  never "merged". A branch with no commit of its own is never merged, dirty or not.
- **in progress** — a turn is running or subagents are working in the session, the tree has
  uncommitted changes, the branch has no commit of its own yet, a commit subject on the branch
  starts with `TEMP`, `WIP`, `fixup!`, `squash!` or `amend!`, or the session's newest check run
  (a `bash` call running a test, typecheck or build) failed.
- **blocked** — the session waits on open alignment questions (§chat.alignment/session-mark).
- **ready** — at least one commit ahead, clean, and none of the above. The session's newest
  check run passing is recorded with it; a session that ran none is still ready, and says so.
- **waiting for your OK** — ready, and the session's last reply (no user prompt after it) asks the
  user something: the attention signal's ask answer when it has one for that reply
  (§app.decisions/attention-signals), else the reply's last 600 characters, before its closing
  `Also changes:` / `Deferred:` lines, asking to merge ("Shall I … merge…?", "Want me to merge…",
  "OK to merge?", "ready to merge", "say merge").

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

**The row's badge** (§app.session-list/anatomy) is one short phrase from the session's worktrees,
the first that holds: "waiting for your OK" (a worktree waits for the go-ahead), "ready ✓" (one is
ready), none while another worktree is in progress, stale or blocked (the busy and open-question
marks say it), "restart pending", "merged · {n} follow-up(s)" ({n} = cleanup, plus the
§app.decisions/merge-followup answer when it names small or significant work), "merged". Its
`title` names each worktree with its state and every routine follow-up in words, one line each.
The session's `readiness` travels with its row in the session list (`SessionSummary.readiness`),
so the Overseer reads the same answer.

**In the attention digest** (§app.overseer/attention-digest): "Ready to merge: {branch}" for a
worktree waiting for the go-ahead, act tier, so the sidebar's Needs you lists it
(§app.session-list/needs-you) — it is not a push kind, so it never sends a phone notification;
and, decide tier, "Merged with open work: {cue}" for a merge the follow-up check calls
significant, and one "Restart pending" item for the whole server, however many sessions' merges
ask for it, naming how many merges and their branches.
