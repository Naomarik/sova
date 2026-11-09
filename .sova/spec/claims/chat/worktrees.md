# §chat/worktrees — Session-owned worktrees
> Part of the Sova design spec · [overview](../design/overview.md)

A session records the git worktrees it works in. pi's `worktrees` extension
(`pi-config/extensions/worktrees`) keeps the set in the session's own file, the subagents
extension lets workers start only in the session's cwd or in one of those worktrees, and Sova
shows the set in the session pane and each merge the session made as a card in the transcript.
It works the same in the TUI and in Sova, for sessions Sova holds and sessions it only watches.
One shared answer says whether a branch has anything of its own left to land
(§chat.worktrees/nothing-left). Only when the user asks does Sova remove the merged worktrees of a
repository (§chat.worktrees/cleanup).

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
as history. A record whose path is a project's main checkout, attached before that was refused
(§chat.worktrees/tool), is left out of every list, count and reading, with the session's file
untouched: nothing can land from it, so no row ever offers it Land.

## §chat.worktrees/tool — The `worktree` tool

The parent session's agent manages the set with one tool, `worktree`, and there is no command
and no pane control for the set: the user asks the agent (the pane's and composer's Land and Remove from Queue act on the queue, §app.merge-queue/approve, not the set). Workers and team members never have the tool (it
is not in their loadout, and a worker's `extensions` may not load it). The tool runs git itself,
by argument list with no shell, locally only (a remote session refuses it).

- **create** `{name, base?, path?}`: `git worktree add -b feat/<name>` from the session repo's
  main checkout, at `<parent of the main checkout>/.worktrees/<repo>-<name>` unless `path` is
  given, based on `base` or the session cwd's `HEAD`. The branch it is based on (`base` when it names a
  branch, else the branch the cwd has checked out; none for a commit or a detached HEAD) is kept as
  its base branch, which is where git first looks for it merged (§chat.worktrees/merged-state); it
  is not the `merge` default. It is tracked as `created`. In a project with a spec, each spec draft
  of the session's checkout that holds a record not yet official carrying `agreed` (a decision the
  user made there) is copied, whole, into the new worktree's drafts, unless one of that name is there
  already, so it becomes official when that branch lands; the answer names them, and the checkout
  keeps its copy.
- **attach** `{path}`: tracks an existing worktree top level (a subdirectory, or a detached HEAD,
  is refused) as `attached`; its base is its fork point from `master` (else `main`). A worktree
  another session created may be attached. A project's main checkout can't be: "That folder is the
  project's main checkout, not a worktree. Nothing was attached."
- **detach** `{path}`: marks it `dropped`. Nothing is deleted on disk.
- **merge** `{path, target?, withoutDocs?}`: merges the worktree's branch into `target` (default `master`, or
  `main` in a repository without `master`, whatever its base branch) and records the merge (§chat.worktrees/merge-card). Where `target` is checked out, that checkout
  must have no tracked changes, and the merge runs there (fast-forward when possible, else a merge
  commit; a conflict is aborted and reported, changing nothing). Where it is not checked out, only
  a fast-forward is done. In a chat Sova runs, in a repository the merge queue serves
  (§app.merge-queue/served), a merge into the branch others land into (the
  project's declared merge-queue target, its `.sova/project.json` `merge.target` as committed at the
  main checkout's head or on that branch; and always `master`, `main` and the branch the
  repository's main checkout has, §app/merge-queue) is refused, with nothing changed: the answer says branches reach it only
  through Sova's merge queue, and that the user may type "land it" or press Land. In a repository
  the queue doesn't serve, nothing is refused: a merge into `master` or `main` is a plain merge
  like any other, with no confirm beyond the sandbox's (§chat.worktrees/sandbox), except a setup
  branch's (§app.project-setup/land-gate), refused below. Which it is, the
  tool reads from Sova's shared answer at that moment (§app.merge-queue/served), never from what it
  read when the chat started. Any other merge needs no recorded
  go-ahead. In a project with a spec, the worktree's spec drafts become
  official first, on its branch: the draft tool's `land --write` at the branch's head (§tools.spec/land),
  then one commit of exactly the spec files it wrote, with its message and the trailer
  `Sova-Spec-Landing: worktree-tool`, and the answer says so with its counts. Drafts that don't fit
  (`land` refuses), uncommitted changes in the spec, or a docs commit that would clash with the
  target stop the merge with what to fix and nothing changed: the docs commit is taken back and
  the drafts read as they did. A merge that can't run anyway gets no docs commit. With
  `withoutDocs: true`, which its description says to pass only on the user's word, the drafts are
  left behind and the spec warnings name them.
- **land** `{path?}`: records the user's go-ahead, typed in this chat ("land it", "merge it"), to
  land the worktree's branch, which approves it in the project's merge queue
  (§app.merge-queue/approve, §chat.worktrees/landing-answers). It is taken
  only when the user's newest message in the chat says to land or merge (a message that says not
  to, such as "don't merge it" or "not yet", is refused), and only when the user typed that message
  themselves: one the Overseer, a baton or another session sent is refused
  (§chat.worktrees/land-own-word); one that also says "without specs" records the go-ahead
  without the branch's specs, and one that says "skip review" ("land it, skip review") without the
  review step (§app.merge-queue/review). One that asks for a pull or merge request ("open a PR",
  "create an MR", "open a merge request", "land it as a PR") is taken the same way and lands as a
  request on `origin`'s host (a pull request on GitHub, a merge request on GitLab, whichever word was
  typed), whatever the project's way of landing (§app.merge-queue/strategies); its answer says
  "Queued {branch} at {sha} to land as a request on origin's host (a merge request on GitLab, a pull
  request on GitHub)…". The worktree is one the session tracks, or by default the
  worktree the session's own folder is in; it must be on a branch with no uncommitted files, since
  the go-ahead is for its head commit. In a repository the merge queue serves it merges nothing
  itself: the queue checks the branch and lands it, exactly as on the Land button, and the answer
  says it was queued. Its answer also tells the chat to leave the branch alone until it lands
  (§chat.merge-queue/chat-turns). The tool itself doesn't ask what is left: a branch with nothing left
  and no draft to land is refused by the queue when it reads the go-ahead, as on the Land button, and
  the chat hears that at its next turn (§app.merge-queue/approve). In a repository the queue doesn't serve it records nothing and queues
  nothing: it merges the branch into the main checkout's branch itself, exactly as `merge` would
  (spec drafts made official first; "without specs" leaves them behind), and the answer says it
  merged; asked for a pull or merge request there, it merges nothing either: the answer tells the
  chat to open the request itself, as the user asked, with `gh pr create` or `glab mr create`, after
  pushing the branch. In a repository the queue doesn't serve, `land` and `merge` both refuse a setup
  branch (one that changes the project's setup, by the land gate's rule as Sova's server answers it,
  §app.project-setup/land-gate), merging nothing: "This branch changes the project's setup: press
  Merge Branch on its Setup card, which needs a passing trial first. Nothing was merged." When Git
  can't tell, they refuse too: "Sova can't confirm whether this branch changes the project's setup, so
  nothing was merged. If it does, press Merge Branch on its Setup card, which needs a passing trial
  first." The tool's description and guidance name no merge queue and no Land: they say `merge`
  merges into the main branch only as the turn's Sova landing note allows, and that on the user's
  typed "land it" or "merge it" the agent commits what's left and calls `land`, which lands the
  branch the way that note says (§chat.worktrees/landing-note).
- **list**: the set with each worktree's status.

`detach`, `merge` and `land` take the worktree's path or its branch name. Every answer lists the
resulting set.

## §chat.worktrees/land-own-word — `worktree land` takes only the user's own word

- `worktree land` (§chat.worktrees/tool) never records a go-ahead when the chat's newest user
  message was sent by the Overseer, a baton or another session: one that a `sova-overseer-sent`,
  `sova-baton-sent` or `sova-session-sent` marker names (§app.overseer/sent-marker), whatever its
  words. It refuses, records nothing in `landing.json`, queues nothing, and says the newest
  message wasn't typed by the user, so the go-ahead must be the user's own word in this chat (or
  the Land button, §app.merge-queue/approve).
- An extension's message (§app.extensions/name-badge) is never the user's word either: it carries the
  `sova-session-sent` marker, so the refusal calls it another session's, and its text starts
  `[from session `, which is refused as not typed by the user whatever marker it has. So is a card's or an
  offer's press marked during an alignment's wait (§chat.alignment/session-mark).
- A merge queue message (§chat.merge-queue/chat-turns) is never the user's word either, in any
  chat: it carries another sender's marker, and a message whose text starts `[merge-queue` (in any
  form, `[merge-queue]` included) or `[overseer-brief]` is refused as not typed by the user whatever
  marker it has. A chat takes this
  at its next reload.
- No note on a chat queue (§chat/topics) is ever the user's word, whatever the queue is called
  (one named `merge-…` or `land-…` included) and whoever pushed it, the merge queue's requests
  (§chat.merge-queue/requests) included: a message whose text starts `[topic ` is refused as not
  typed by the user, and so is one the batch's delivery marker (`sova-topic-delivered`,
  §chat.topics/delivery) names, whatever its words; the refusal says the newest message was sent by
  a chat queue.
- A decision's held note (§chat.merge-queue/decision) reaches the chat in the same turn as the
  user's own answer: the user's message counts as their own word, and the note never does. When the
  user's message carries the held note (its last block, starting `[merge-queue held note`), only
  the user's own words before it are read for "land it", "without its specs" and "skip review";
  a "land it" only the note contains records nothing.
- It never looks past that message to an older one: only the newest user message counts.
- The same holds in a repository the merge queue doesn't serve, where `land` merges plainly
  (§chat.worktrees/tool): a message the user didn't type merges nothing.

## §chat.worktrees/landing-note — How each repository lands, told per turn

A chat Sova runs (not a merge thread or a reviewer) learns how each repository it works in lands
from a hidden line in its turn, never from its tool's fixed wording: one line for its folder's
repository and one for each repository of the worktrees it tracks. The block starts "From Sova
(not the user's words; nothing to answer):". It is said at the chat's first turn and again only
when a repository's answer changes (§app.merge-queue/served), never at every turn; after Sova
restarts, each chat hears its lines once more.
- A repository the queue serves: "Landing note for {root}: branches reach {target} only through Sova's merge queue.
  Never merge into {target} yourself. When the user types "land it" or "merge it" here, commit
  what's left and call worktree land (it queues the branch; the queue checks and lands it). When a
  branch is ready, tell them they can type "land it" or press Land."
- Any other repository: "Landing note for {root}: no merge queue here. When the user asks to land or merge a branch,
  commit what's left and merge it into the main branch yourself (worktree merge, or worktree land
  on their typed "land it")."

A chat with worktrees in both kinds of repository gets the right line for each, and a project
listed or set up while the chat is open changes its line at the next turn, with no reload.

## §chat.worktrees/sandbox — With the sandbox on

While the session's sandbox is on (§chat/sandbox), `create`, `attach` and `merge` ask the user
first, with the path and branch named, and so does `land` where it merges plainly (a repository
the merge queue doesn't serve, §chat.worktrees/tool); a declined or unanswerable request (no UI) changes
nothing. Every active worktree of the set is a writable root of the session and of its workers
while the sandbox is on (one under a shadowed cache stays a real root, like the session's cwd),
and its `.agent` directory stays read-only inside it, like the session's own agent dir. A
worker's sandbox scope also carries the parent's hidden list, proxy and environment
allowlists and `browser` setting (§chat.sandbox/policy-file), so a worker on a worktree's own agent dir (§chat.worktrees/worktree-config) is never
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
included) and the environment is passed as it is, but for `TMPDIR` (below) and the
sandbox's own git config, `GIT_CONFIG_SYSTEM` (§chat.sandbox/git-cleanup). No policy file is read
for it, except that it gets the parent's `browser` setting (§chat.sandbox/policy-file): the parent
reads its own policy file and its cwd's project file when the worker starts, and a file it cannot
read means no browser, never a refused start.

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
- **Long jobs.** A background process ends with its command here (§chat.sandbox/limits). A write-only
  worker runs a long job through `background_job`, under this same confinement: the job writes only
  where the worker can, and it is listed and reported as any job is
  (§app.background-jobs/request). A worker under On has no such way (§app.background-jobs/where).

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
explicitly in normal mode, with the spec minor mode only while the chat that started it has spec
on, and the project is trusted for the run (`--approve`). A Claude Code worker, being a pi worker, may use it too. It is refused outside an
active tracked worktree, or when the worktree has no `.agent`. Extension discovery stays off, and
the tree's subagents and worktrees extensions are never loaded. The model policy is still the
parent's. The choice is recorded with the worker, so a resume applies it again.

While Sova runs chat modes (§chat.mode-menu/sova-runs-modes), no mode extension is loaded from the
tree and none needs to be there: Sova gives the worker its modes itself, exactly as the next
paragraph says the tree's extension does. With the switch off, the tree's own extension is loaded as
above.

That mode extension knows it runs in a worker (the worker marker tells it on the extension bus,
so an older tree's extension just doesn't hear it): it ignores the `mode` snapshots a `fork` copied
from the parent's branch and the tree's `mode.json`, so the worker is always in normal mode and
never strict, with spec as the chat that started it has it when the worker starts or resumes; it is
never offered a spec writer; and its spec block, when it has one, is the worker form
(§chat.mode-menu/workers). None of the parent's other worker modes are added.

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
the merge brings in, said once per draft in a session and again when its pending § change (the
merge made the worktree's own drafts official first, so its own left are ones the merge was told to
leave: into a branch other than the repository's default, copy the draft into that branch's
worktree so it lands with it; into the default branch, master or main: they didn't land with the
code, and stay in the worktree's drafts folder until they land with a fresh branch from the default
branch, never on it directly; another session's land when its worktree's branch lands); a merge
commit that resolved § by hand (they differ from both parents); and that the spec warnings could
not be computed.
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
(§chat.worktrees/pane). The merge card is for a merge a chat makes itself, into a branch no merge
queue manages, `land`'s plain merge in a repository the queue doesn't serve included: a branch that lands through a project's merge queue is shown by its queue card
instead (§chat.merge-queue/chat-card).

## §chat.worktrees/merged-state — When git finds a worktree merged

A tracked worktree counts as merged when its branch has commits beyond its base and all of them
are in its base branch or in the repository's main branch (master, else main), whether or not a
merge was recorded. Where the project's merge queue lands on another branch, being in master or main
doesn't read merged, by one rule for the Session tab (§chat.worktrees/pane) and a chat's branch rows
(§chat.worktrees/readiness). This is git's "already merged" answer, by ancestry alone. What else has nothing left
to land reaches a row through the shared answer it carries (§chat.worktrees/nothing-left), not through
this one. A worktree made from another feature branch whose commits reached master but
never that branch is merged into master. The target it is merged into is its base branch when
that branch has it, else the main branch; one merged into neither is checked against its base
branch (the main branch when it has none). A check that names its target, such as the one after
a turn against the target seen at the turn's start, looks at that target only.

## §chat.worktrees/nothing-left — Does this branch have anything of its own left to land?

Sova has one answer to this question, worked out on the server from git, the queue's landings and
the branch's spec drafts, with no model call. These places read it and keep no rule of their own, so
no two of them can disagree about one branch: the composer's worktrees control
(§chat.composer/worktrees-control), the Worktrees section (§chat.worktrees/pane), the Merge Queue
tab's Ready to land list (§app.merge-queue/view), the project card's count
(§app.projects/home-cards), the Overseer's list (§app.overseer/roundup), the Agents board's worktree
lines (§app.insights/subagent-cards) and Land (§app.merge-queue/approve). A further screen, a Merge
Queue tab among them, reads this answer too and works out none of its own.

**Clean Up Merged and archive's folder removal don't read it.** They keep their own reading
(§chat.worktrees/cleanup, §app.overseer/tools) and offer exactly what they offered before: a branch
whose leftover merge now conflicts can read Landed on its row while Clean Up Merged still says "Not
merged into {main}". The answer decides labels, lists, counts and Land, and nothing on disk.

**Three outcomes.** Every reader gets one of these for a branch's head against the branch it lands on:
- **Nothing** is left: any of the rules below holds.
- **Work** is left: git answered, and none of them holds.
- **Unknown**: git failed, or the branch's history can't be connected to the target. It is never
  nothing. A place with no way to say so reads it as something left, never as finished: a row keeps its
  own reading and its Land, the branch stays on Ready to land, and Land is not refused as nothing to
  land. The last stop of a landing (§app.merge-queue/run) still keeps a run that changes nothing off the
  target.

**Two readings.** The **whole** reading counts the code and the spec drafts; the **code-only**
reading counts the commits alone. Only the whole reading can say a branch is finished. The code-only
reading is what lets a row say its code has landed while drafts are left, and what lets Land carry
just those drafts.

**Nothing is left** when any of these holds:
- the head is on the target;
- every commit the target doesn't have is a merge;
- the head is exactly the commit that landed: an entry's approved commit, or one the queue moved the
  target to or the host merged;
- its only commits past a landing are merges on top of it, a landing the host squashed included;
- merging it would change nothing: a trial merge leaves the target's tree as it is.

They are asked in that order, cheapest first. A head that read nothing left because merging changes
nothing keeps that answer once the target moves on, even if the same merge would now conflict; while
the target stays at that commit the trial still decides. Those heads are kept in
`<state root>/nothing-left.json`, the newest 5,000.

**Spec drafts not proved landed always count as something left**, whatever git says. A draft is
proved landed when it has a landing receipt (§app.merge-queue/land), when it matches the target now
(§tools.spec/draft-official), or when it matches the target at the commit that landed it: the commit
whose subject says it landed that draft (`Spec: land draft <name> at …`, the newest 3 of them), or the
branch's own tip on the target. A subject that names no draft (`Spec: land {n} drafts at …`) proves
nothing: those drafts rest on a receipt or on matching the target now. A draft edited since is proved by
none of them. A branch with no commit left but such a draft still has something to land, and Land
lands just the drafts (§app.merge-queue/approve).

**How recently it landed doesn't matter.** The answer doesn't depend on when the branch landed, how
many landings came after it or which landings the queue's view still shows: it reads every entry the
queue has, and a host's landing is kept past its entry (per branch the newest 8, for the newest 500
branches); one from before they were kept is read in at load, from its landed entries still there. So it never changes by itself as newer landings
arrive. Only a new commit on the branch or an edited draft changes it.

**A merge that holds a hand edit reads as landed.** The answer looks at which commits exist, never
inside a merge. Work committed normally is a real commit and reads as new work.

**Nothing left isn't always Landed.** A branch that never had a commit of its own also has nothing
left of its code. It reads No commits yet on its row, never Landed or Merged. One with a draft not
proved landed has something left whatever else it reads, so a chat drafting before its first commit
shows Drafts to land, with Land, and is on Ready to land. A branch fast-forwarded to the target, whose
head moved past its base with no commit of its own, reads Merged.

## §chat.worktrees/pane — The Worktrees section

The session pane's Session tab (§app.subagents-pane/tabs) shows a **Worktrees** section right after
Repository: a count line ("2 active · 1 merged · 1 removed · 1 dropped", a worktree tracked active
whose folder is gone counted as its status chip reads), then one row per worktree in recorded order,
dropped and merged ones included. When the branch tracks none the section stays, with one line:
"This session tracks no worktrees." While the insight's first load is out the section shows its
heading over a placeholder line as tall as that sentence (most sessions track none), never the
sentence itself. A row is the modal's row (§chat.composer/worktrees-control): the title of the chat
that owns the branch, as a link, then the branch, then "archived" when that chat is archived; that
line names no worktree folder. Under it comes the branch's place line, which unfolds to its folder
(§chat.worktrees/place). Under its facts it shows the branch's summary once written
(§app.merge-queue/branch-summary). It carries a status chip — Active, Dropped, or Merged with "into
<target> at <sha>" — plus, when true, `.agent`, the number of this session's workers with a live
process inside it, and "Shared with session <id>" linking the session it was inherited from. An
active worktree whose branch git finds already in its target reads Merged too, with a title saying
this session didn't record it. A worktree whose folder is gone never reads Active: its status chip
says what its work came to, by the same answer readiness gives (§chat.worktrees/readiness, removed),
the row's readiness when it has one: Landed when that work is merged, beside the row's
**Landed · cleaned up** and with no Land, and counted as merged in the count line; else Removed
(warn; neutral for one with no commits of its own), with the reason line "Removed
· not merged", "Removed · no record of a merge" or "Removed · no commits". A dropped or
merged-recorded worktree whose folder is gone keeps its status chip and adds Removed or Cleaned up.
A row with a readiness (§chat.worktrees/readiness) adds a chip after the status chip — Ready to
merge (the row's and the digest's words), Waiting for your OK, In progress, Blocked or Stale, with
the reason as its `title` — and none while merged or removed, which the status chip already says.
Its tone follows mergeability: Ready to merge and Waiting for your OK are success, In progress
neutral, Blocked and Stale warn. A worktree that is Ready to land (§chat.worktrees/ready-to-land)
reads **Ready** (success) in place of Ready to merge or Waiting for your OK, and its line starts
"Ready to land". No other worktree reads Ready, and in a repository the queue serves none other
counts as ready: one with real work says its own reading (Ready to merge, Waiting for your OK,
Conflicts with {target}, In progress, Blocked), with its reason, and keeps Land, and one with no
reading of the branch says No reading and keeps it too. One whose code has nothing left but whose
spec drafts aren't proved landed (§chat.worktrees/nothing-left) reads **Drafts to land** (info), with
the line "Code landed · 2 spec drafts not landed" and Land, which lands just the drafts. One Landing
specs reads **Landing specs** (info; warn, with the session's reason as
its `title`, when it can't land them) with the line "Landing specs · docs don't fit" (or "· can't
land them: <why>"). When docs land with a Ready to land worktree its line ends with them: "Ready to
land · 3 commits ahead · docs: 2 new, 1 changed".

**In the merge queue**, a row reads its entry's state and offers the queue's actions, the modal's
own (§chat.worktrees/pane-queue).

**In a repository the merge queue doesn't serve** (§app.merge-queue/served) a row never reads Ready,
Landing specs or a queue state and offers no Land: a ready branch reads Ready to merge, and its line
ends "Say “land it” in the chat to merge it into {target}.", with the repository's real target
(§chat.worktrees/place). A project on the Projects list whose merge
setup isn't done keeps **Set Up Queue** on such a row, which opens its Merge Queue tab
(§app.merge-queue/setup). The section's **View Merge Queue** shows, as the modal's Merge Queue link
does, only for a repository on the Projects list, and, as there, one link per project when the chat's
branches are in several (§chat.composer/worktrees-control). The pane, the
composer's control and the Merge Queue view read the same state and stay in sync; nothing in the
section shows live state or offers a restart. Under the facts, one visible muted line gives the
reason, so a phone gets it without hover: the readiness's `reason` ("Ready to merge · checks passed
· 19 commits ahead", "Conflicts with master · 17 files"), else the chip's word and the why joined by
" · ", and no line when there is neither. It wraps; it never truncates. The section follows the file
and the queue: it updates as the session's file changes and as the queue moves, and its only
controls are the queue actions above.

## §chat.worktrees/pane-queue — A Worktrees row in the merge queue

**In the merge queue** (§app/merge-queue) a worktree's chip and line read its entry's state instead,
in the words the composer's worktrees control uses (§chat.composer/worktrees-control): Queued · 2nd
(with "starts in ~N min · takes ~N min"), Checking, Conflict, Behaviour differs, Needs you, Can't
tell whose failure, Out of tries, Drafts changed, Approved · waiting for a fix, Back with the chat
("try {n} of 3"), Waiting for the merge thread, Paused: you stopped the chat, and Landed with its
commit, the fix commits that landed with the user's Land and its notes (§app.merge-queue/note) under
it. A row reads Landed only while nothing is left (§chat.worktrees/nothing-left): a catch-up merge on
top changes nothing and is never mentioned, and a real new commit brings back the branch's own
reading, with Land and "1 newer commit not included" under it. A landed entry with no reading of the
branch (the Overseer's rows) stays Landed; with real newer commits it keeps that line, and Land where
the queue serves the repository: nothing of its own says otherwise. **The row's
action** is the modal's, from the same row: Land (with its menu), which asks once before it queues
anything, its confirmation right-aligned under the row (§chat.composer/land-confirm), laid out as
the modal's rows are (§chat.composer/worktrees-control, "Row layout"), on Ready, Drafts changed, Drafts
to land, Out of tries, a row of real work reading Ready to merge, Waiting for your OK, Landing specs,
Conflicts with {target}, In progress, Blocked or No reading, or a finished branch blocked for
something its chat can fix (approved as Approved · waiting for a fix, §app.merge-queue/approve); never while the user's Land stands and the chat fixes
it (§app.merge-queue/standing-approval). Remove from Queue on every row of an approval that stands, a queued one included, Accept (with a proposal) and Answer in Chat on Behaviour differs, Answer in
Chat on Needs you, Land Anyway and Try Again on Can't tell whose failure. No row offers Send Back,
Land This Commit Again or Land Newest Commit; each action counts only as the user's own click
(§app.access/your-click). While the branch's review runs, and after it ends, the row adds a line for
its run's newest reviewer chat: "Review running" or "Review: {verdict}" ("no verdict" when it
failed), then **Open Reviewer Chat**, or "· Reviewer chat cleared" with no link once the user
cleared it (§app.merge-queue/chats); the reviewer chat itself is never a row of any session list. A
project whose definition doesn't parse keeps Land (never Set Up Queue), with the modal's line saying
so (§chat.composer/worktrees-control); the row keeps Review Changes and its workers and `.agent`
chips. A row's Review Changes, first among its actions, is the modal's own button: the branch as it
is now against the branch it lands on, its uncommitted files included and marked as uncommitted; a
merged branch shows what its landing or merge brought in (§chat.changes/entry).

## §chat.worktrees/place — A branch's place

A chat can hold branches of several projects, so every branch row in a chat says, by one rule, which
project the branch belongs to and where it merges. Every row has it, not only another project's.

**The place line.** On the composer's Worktrees modal rows (§chat.composer/worktrees-control), the
session pane's Worktrees rows (§chat.worktrees/pane) and the chat's queue card
(§chat.merge-queue/chat-card), one line under the branch reads `{place} · merges into {target}`: for
example "AmalMoney · merges into master", "~/code/tools · merges into main". It wraps rather than
cutting off.

**`{place}`** is the project's name when the branch's repository is on the Projects list and not
archived; otherwise that repository's main folder, written from home (`~/...`).
- An archived project, a repository not on the list, or a project with a blank name: the folder.
- Two projects with the same name: the name plus just enough of the folder to tell them apart, as
  Needs you does ("Notes · work/notes", §app.session-list/needs-you).
- A branch whose folder is deleted: the project's name if Sova can still work it out, else the folder
  as last recorded. The row keeps its Removed or Cleaned up state (§chat.worktrees/pane).
- A branch of a session on a remote target: `{target}:{folder}`, its folder there, never matched on
  this computer's list, and its paths aren't written from this computer's home.

A project's name wins over a folder because Land follows the branch's own folder, so the name always
agrees with where Land goes.

**`{target}`** is the branch the queue lands on in a repository the merge queue serves
(§app.merge-queue/served). In any other repository it is what the `worktree` tool merges into
(§chat.worktrees/tool): master when the repository has master, else main.

**The clause changes with the branch.**
- A merged branch says where it actually went, " · merged into {recorded target}", which can differ
  from the project's usual target. A landed branch reads the same, and so does a branch git found
  already merged (§chat.worktrees/merged-state), with the target git found it in.
- A dropped branch has no clause: the line is `{place}` alone.
- When the target can't be known the clause is left out rather than guessed, and a line that would
  name it says less: "Say “land it” in the chat to merge it."

**The exact folder is one tap away.** The line is a button with `aria-expanded`: tapping it, clicking
it or pressing it by keyboard unfolds, under it, `Branch folder: {~/path}`, `Merges into: {target} of
{~/main folder}` and a **Copy Folder** button, which copies the branch's folder. Hover is never the
only way to reach the folder; the row's existing folder hover may stay. The second line follows the
clause above: a merged branch's reads `Merged into: {recorded target} of {~/main folder}`, a line
with no clause has no second line, and with no main folder known it names the target alone.

**Beside a branch's name.** Where one line names a branch and says something about it, the place goes
right after the branch, in one form: `{branch} in {place}`. The merge queue's requests in the
transcript (§chat.merge-queue/requests), the "not sent yet" note above the message box
(§chat.merge-queue/decision), the hover of a sidebar session row's branch status
(§app.session-list/content-rules "Row line 3") and the Overseer's roundup rows that show a branch
(§app.overseer/roundup) use it. With no place known (a card written before the line, a read that
failed) such a line names the branch alone.

**Left alone.** Pages inside one project (the Merge Queue tab's rows, run pages, the Branches tab)
show no place line, and old merged cards in a chat's history stay as they were.

## §chat.worktrees/readiness — Is it ready to merge, and what did a merge leave

Every worktree a session tracks and created or attached itself (not one it inherited, and not a
dropped one) gets a **readiness**, worked out on the server from git and the session's file with
no model call (`server/merge-readiness.ts`):

- **merged** — git finds the branch in its base branch, by ancestry or by content (a squash or a
  rebased merge train), or the shared answer finds none of its own commits left to land
  (§chat.worktrees/nothing-left), after at least one commit of its own, **and** the tree is clean. A
  worktree whose folder is gone reads as what its work came to (below, **removed**). Git is the
  source, never the merge card: a branch merged by someone else reads merged, and a card whose
  branch git no longer finds merged does not. A worktree still tracked active once git finds it
  merged is merged with a **cleanup** follow-up. A merged tree whose folder still holds spec
  drafts not proved landed (§chat.worktrees/nothing-left), as when a catch-up merge took the base's
  spec and the drafts were never promoted again, or the branch landed without its specs, is still
  merged, but it has something left and its reason never says plain Merged: it reads "Code landed ·
  2 spec drafts not landed", the count of those drafts. Drafts proved landed stay in the folder and
  never read that way.
- **stale** — merged, but the tree has uncommitted changes while nothing runs in the session:
  never "merged". A branch with no commit of its own is never merged, dirty or not.
- **in progress** — a turn is running or subagents are working in the session, the tree has
  three or more uncommitted files, the branch has no commit of its own yet, it **conflicts with
  its base** (the trial merge git already runs for an unmerged branch reports conflicts), a
  commit subject on the branch starts with `TEMP`, `WIP`, `fixup!`, `squash!` or `amend!`, or the
  session's newest check run (a `bash` call running a test, typecheck or build) failed.
- **removed** — the worktree's folder is gone, and what its work came to is said plainly, never
  "in progress" or "active". A folder with no `.git` left in it (what a delete that stopped part way
  leaves) counts as gone. Only a folder that is gone is ever called
  gone: one that is there and that git can't read says "Git can't read this worktree", never
  "worktree folder gone". It is **merged** instead, with the reason "Landed · cleaned up", when
  git still finds its branch in the project's real landing target, the one a live worktree is compared
  against (the merge queue's target when a queue is loaded, else master, else main), by ancestry or by
  the shared answer (§chat.worktrees/nothing-left), after at least one commit of its own past the
  recorded base; when Sova's
  own cleanup removed it (§chat.worktrees/cleanup's ledger); when another session's file records
  the same path and branch merged (a record another chat made of a merge, which outlives a later
  `git branch -d`), as far as readiness has read that session; or when it is recorded merged. Otherwise it is removed: "Removed · not
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
working now", "Merged", "Merged · still tracked active", "Landed · cleaned up", "Code landed · 2 spec drafts not landed", "Removed · not merged", "Stale
· merged, with uncommitted changes". Uncommitted files are named by the first one and how many more.

Routine follow-ups, also mechanical:

- **restart pending** — a merge this session made (a merge card) landed in the branch this
  server's own checkout runs, changed a file the server runs, and happened after this server
  process started. The files the server runs are the ones Sova's merge thread restarts for
  (§chat.merge-queue/sova-restart): code under `server/`, `shared/` or `pi-config/` but not tests
  or Markdown docs, a `src/` file the server itself imports, and `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml` and `mise.toml`. A merge of only other `src/` files, tests or docs never
  asks for a restart. It reads file names only, so a release commit, whose `package.json` changes
  only its version, still asks for one, though the merge thread doesn't restart for it. The next
  start clears it.
- **not pushed** — the merge's commit is not yet on the target's `origin` branch. Said in the
  badge's `title`, never counted as a follow-up.
- **cleanup** — merged worktrees still tracked active.

Git is read in the background, at most every 20 seconds per session while the file doesn't change,
and only for session files that ever wrote a `worktrees` entry, so a listing never waits on git.
The same read also reads the branches the session's chat counts in its worktrees control
(§chat.composer/worktrees-control): every non-dropped worktree, its own and inherited ones, each with
its folder, git's "already merged" and its merge queue entry, which travel with the row
(`SessionSummary.branches`) for the row's branch status (§app.session-list/content-rules "Row line
3"). It reads them for every session but an Overseer or a project Overseer, a worker's, a baton's
and a target session's included, though readiness itself still covers none of those and they never
own a branch.

Each branch's queue entry is joined at listing time from its queue's newest view, with no git read,
and a change there re-lists the sessions, as does a queue's first view after a server start when it
holds entries. So a change the queue makes reaches the list within seconds, as the queue publishes
it. Reading a row runs no queue view unless the list has none of that queue yet. Every few seconds
while the list is being watched, a look that spawns no git catches what moves with no queue change:
the target's head, a sent-back branch or its worktree going, a project leaving the list. That reads
the view once; a read that failed counts for nothing and is tried again at the next look, and refs
moving during a read get it read again. A repo nothing can stamp has its view read every 20 seconds.

Git's "already merged" answer and a repo's merge setup are kept while the refs they rest on don't
change, so sessions on one tree share a read and an idle row asks git nothing; refs moving during a
read are never taken as seen. Past that:

- each is kept 30 minutes at most, which bounds what no stamp sees (the queue's view has the same
  limit) and all a failed "already merged" read can last. A setup read that found no commit, or that
  failed outright, is never kept;
- where nothing can stamp them (a folder with no `.git` left, a reftable repo), an "already merged"
  answer stands five minutes and a merge setup isn't kept at all;
- a tree's project stands while its `.git` is unchanged, five minutes where it has none.

A row whose queue view failed is put right by its next read. Rows read before the queue started and
rows of a repo gaining service are read again then, archived ones too, and a queue leaving service
takes its facts off its rows. What this means for a row against its chat, and the known bounds, is
in §app.session-list/content-rules "Row line 3".

**What's left.** A worktree with commits and none left to land, or with no commits, also carries the
shared answer (§chat.worktrees/nothing-left): nothing left, or only {n} drafts. The chat's other branch
rows carry the same answer for a merged one.

**Merged, clean or not.** Each worktree's readiness carries, beside its state, whether git finds
its branch merged into its base (the merged rule above without the clean tree), clean or not, or,
its folder gone, whether it reads merged by the removed rule above (`merged: true`). A merged tree
with uncommitted changes carries it while its own state stays stale or in progress, as above: the
Session tab's chip, the badge and the attention digest still read that state. The session row no
longer counts merged worktrees: it shows the chat's branch status instead
(§app.session-list/content-rules "Row line 3", §chat.composer/worktrees-control).

**The row's badge** (§app.session-list/anatomy) is one short phrase from the session's worktrees,
the first that holds: "Waiting for your OK" (a worktree waits for the go-ahead) and "Ready to
merge" (one is ready) — two states the row's branch status already says, and the two the
Overseer's decide tier words ("Ready to merge: {branch}", §app.overseer/attention-digest) — none
while another worktree is in progress, stale or blocked (the busy and open-question
marks say it), "restart pending", the follow-up count ({n} = only the
§app.decisions/merge-followup answer when it names small or significant work; leftover worktrees
— cleanup — are said only in the `title`, never counted), and "merged". **The row writes only the
two its branch status cannot**: "restart pending", and the follow-up count as "{n} follow-up(s)",
after the status — never "merged", and never the ready or waiting phrases, which the status and
its words carry. An **empty leftover
worktree** — no commit of its own, a clean tree, nothing running — never changes the badge. Its `title` names each worktree with its state and every
routine follow-up in words, one line each.
The session's `readiness` travels with its row in the session list (`SessionSummary.readiness`),
so the Overseer reads the same answer. An open offer card (§chat.offers/card) is no reply that
asks: it never makes a worktree wait for your OK. Offers' conditions read readiness as it will be
once the turn ends (§chat.offers/conditions).

**The branch status line**, counted in code with no model call, for the session's newest merge:
"merged {sha7} · pushed (or not pushed) · live (or restart owed) · spec promoted (or {n} spec
draft(s) not promoted)". Merged and the commit come from the merge card; pushed from the target's
`origin` branch (left out when there is no `origin`); live when this server already runs the
merge (it started after it, or the merge changed no file the server runs, the set above), else
restart owed; spec from
the merged worktree's own `.sova/spec/drafts/`, while that folder still exists: a draft counts as
promoted when it is official (§tools.spec/draft-official), the one rule the merge queue's docs
step reads too, when it is marked landed: it carries the receipt of a queue landing
(§app.merge-queue/land), its `spec/` is unchanged since by hash, and the commit the receipt names
is on the receipt's target, or when it matches the target at the commit that landed it
(§chat.worktrees/nothing-left). A draft edited after its landing counts as not promoted again, as does
one none of these proves, and a draft that rule can't read. The
line is the first line of the badge's `title` (§app.session-list/anatomy) and travels with the
row (`SessionSummary.readiness.status`).

Routine session-list and merge-readiness refreshes never run a spec tool, including for idle
merged worktrees.
The spec facts readiness carries are which drafts aren't promoted (an unreadable one included), for the status line's count,
a merged tree's reason and the landing (§chat.worktrees/ready-to-land), worked out by the draft
rule's own function in the server's process from the drafts' files and kept until one of them
changes; a receipt adds one ancestry question to Git and no spec tool. Readiness carries no other spec observation, and the row and its title display none. Ordinary git readiness, bash checks,
attention items, and routine follow-ups keep the rules above.

**In the attention digest** (§app.overseer/attention-digest), decide tier, never Needs you, a brief
or a phone notification: "Ready to merge: {branch}" for a ready worktree and "Waiting for your OK:
{branch}" for one waiting for the go-ahead, while the session is idle, except that a worktree with a
landing says its landing's word, "Ready to land: {branch}" or "Landing specs: {branch}"
(§chat.worktrees/ready-to-land), as its reason line does; "Merged with open work:
{cue}" for a merge the follow-up check calls significant; and one "Restart pending" item for the
whole server, however many sessions' merges ask for it, naming how many merges and their
branches.

## §chat.worktrees/ready-to-land — Ready to land

Ready to land is the one reading behind the word **Ready**, on a chat's rows, in its counts and in
its reason line. It is stricter than Land: Land is offered on every branch with something left
(§chat.worktrees/nothing-left) and no uncommitted files that isn't already in the queue, whatever it
reads, and the row says its true state beside it (§chat.composer/worktrees-control,
§app.merge-queue/view). So a row says Ready only when this holds, and a row that doesn't say Ready can
still be landed. A finished branch blocked only for something its chat can fix
(§chat.worktrees/blocks-landing) is approved as Approved · waiting for a fix;
and Sova reads Ready to land again on each fix to decide when a standing approval goes back in line
by itself (§app.merge-queue/standing-approval). It is worked out only in a repository the merge
queue serves (§app.merge-queue/served); in any other repository no worktree is ever Ready to land or
Landing specs, its readiness reads as it would with no queue, and Sova sends its chat none of the
messages below. A worktree a session tracks in a served repository is **Ready to land** at its head
commit when, worked out with no model call beside its readiness (§chat.worktrees/readiness):

- git can read it, it has commits of its own left to land (§chat.worktrees/nothing-left), it has **no uncommitted files at all** (the one-or-two-file
  caveat of ready doesn't apply), at least one commit ahead and no temporary commit subject. A
  conflict with its base doesn't keep it from Ready to land, so a finished branch that only
  conflicts reads Ready to land, and its chat is never asked to resolve the conflict itself
  (§chat.worktrees/blocks-landing): once the user lands it, the merge thread judges the conflict in
  line (§app.merge-queue/conflicts). The worktree's own readiness still says it conflicts until it
  has a landing;
- the session's newest check run isn't failing, it has no open alignment question, and nothing runs
  in it;
- on a setup branch (one that changes the project's pipeline settings), a trial of its head commit
  passed (§app.project-setup/land-gate); until then the note that names what still blocks landing
  names the missing trial;
- and **the work is finished**: the session's latest turn outcome for its last reply
  (§app.decisions/attention-signals, the turn card) says either that it did what was asked, which
  covers done and done-but-unverified, or that it waits only for the go-ahead to land, merge, push
  or restart, whether from the user or a teammate (outcome waiting-on-user or waiting-on-team with
  ask kind restart-or-merge-go). Any other outcome, or a wait for anything else (a choice, an
  approval, information), is not finished. Whether the last reply asks something doesn't matter: a
  finished reply that asks "shall I merge?" or ends 'You can type "land it" here' is still Ready to
  land. When Decisions' attention signals are off, or turned off for the session's folder, there is
  no outcome to read, and the code-only conditions above decide alone.

Once a head commit is Ready to land it **stays** so for that commit, kept per session and worktree
in `<state root>/ready-to-land.json`, even when a later reply asks nothing or its outcome says
something else; it goes when the branch's head moves, it has no commit of its own left to land
(however it landed, and whichever commit was approved), or a live condition above
stops holding (a new uncommitted file, a failing check, an open question, a turn running).

**Docs land with the branch** (§chat.worktrees/landing-specs): its spec drafts don't keep it from
Ready to land, but each promise in them needs its chat's verification note, and drafts that wouldn't
land read **Landing specs** instead. **What still blocks landing** a finished branch, and why a
branch back with its chat isn't going back in line, is told to its chat and shown on its row
(§chat.worktrees/blocks-landing).

**One word wherever it is written.** While a landing holds, the worktree's reason line itself reads
it, in place of Ready to merge or Waiting for your OK: "Ready to land · 3 commits ahead" (ending "·
docs: 2 new, 1 changed" when drafts land with it), or "Landing specs · docs don't fit" (with "·
can't land them: <why>" once the session said why). Every reader that writes the reason shows it as
is: the Session tab's chip and line, `session_detail`, and the branch labels the Overseer's and the
agents' session lists print ("branch feat/x (ready to land)"), and so do the attention digest's
decide item ("Ready to land: feat/x", §chat.worktrees/readiness) and the Overseer's roundup, whose
sections "Ready to land" and "Landing specs" list such branches apart from Ready to merge
(§app.overseer/roundup). The row's lit count and badge and the offers' `branch-ready` still read the
readiness state, which stays ready or waiting for your OK underneath.

## §chat.worktrees/landing-specs — Landing specs: the drafts that land with a branch

Spec drafts in the worktree don't keep it from Ready to land: the merge queue makes them official in
its merge copy before the checks run (§app.merge-queue/run; whether a draft is official is
§tools.spec/draft-official). A draft proved landed (§chat.worktrees/nothing-left) has landed already:
on a branch with newer commits it is neither tried again nor counted as docs that land. Each promise
in them still needs its chat's own short verification note (the draft tool's `evidence --note`,
§tools.spec/land) before the head counts as Ready to land. Once per head commit and set of drafts
(their files and verification notes alike, so a note added later is tried again), Sova tries the
drafts the way the landing will (the draft tool's `land` without writing, in a process of its own
for at most a minute, never holding up readiness) and keeps the answer per worktree, head and
drafts; until it has answered, the head isn't Ready to land yet. When they would land, the landing
is Ready to land and carries its docs: how many drafts, how many promises are new and how many
changed, and their names. When they wouldn't (a promise with no verification note, one that changed
in the branch's spec since its draft was made, a proposal mixed into a file that lands), the landing
reads **Landing specs** instead (the Session tab's chip and its line "Landing specs · docs don't
fit"). Sova then tells the session once per head commit, as a merge queue request in its chat
(§chat.merge-queue/requests: marked as the queue's, never as the user's), what doesn't fit and to
fix it in its drafts, which needs no commit (never while that commit is in line or already landed,
§chat.worktrees/blocks-landing); before Land it ends "Once they fit, the user presses
Land; nothing has been landed or approved yet." The chat answers the request
(§chat.merge-queue/answers): Fixed (drafts), Needs you, or Can't with its why, which is shown on the
chip ("can't land them: <why>"); the free-text `Can't land specs: <why>` line is no longer read.
Drafts whose files change after the user approved the branch are the queue's to catch: a change that
only makes them fit, confirmed by the merge thread, is re-pinned with no new Land; any other waits
for the user as "Drafts changed since you approved" (§app.merge-queue/after-approval).

**After a send-back for its drafts.** When the queue's docs step sent the branch back because its
drafts don't fit (§app.merge-queue/run), the sent-back commit can be Ready to land again with no new
commit: once its drafts have changed since it was sent back (adding a verification note counts), the
branch's head is still that commit, its worktree is still there, and Sova's try of the drafts as
they are now finds nothing that doesn't fit, the head reads Ready to land at that same commit. With
the user's Land standing and the merge thread's check of the fix, Sova re-pins the drafts and puts
the entry back in line by itself (§app.merge-queue/standing-approval); no Land is offered for it. An
edit that leaves something unfit keeps it with the chat. A branch sent back for any other reason is
never Ready to land at the sent-back commit; a newer commit is. "land it" typed in its chat is still
the user's approval of the head at that moment, with its drafts as they are then.

## §chat.worktrees/blocks-landing — What still blocks landing, and why a branch isn't back in line

**What still blocks landing.** When the session's latest turn outcome says its work is finished but
a worktree it tracks isn't Ready to land at its head for reasons the session can fix itself
(uncommitted files, a temporary commit subject, the chat's own last test run failing; never a
conflict with its base, which the merge thread judges once the user lands it), and the merge queue
serves its repository (§app.merge-queue/served), Sova tells the session once per head commit, as a
merge queue request in its chat (§chat.merge-queue/requests), what still blocks its landing, each
blocker counted ("1 uncommitted file, a temporary commit ("…")"), and, when the branch also
conflicts, "It also conflicts with {base} in {n} files: don't resolve them yourself; once the user
presses Land, the merge thread judges them.". A failing check run is named as whose run it is and
what failed, never as "a failing check run", here and in the worktree's readiness reason alike, so
the chat reruns or fixes it rather than taking it for the queue's run: "this chat's last test run
failed: 1 failing file, server/x.test.ts". The run is a "test run", a "typecheck" or, when its
output doesn't say, a "check run"; what failed is what its output names: "{n} failing files" with up
to three named ("+{n} more" past them), "{n} failing tests", "{n} type errors" with their files, or
nothing ("this chat's last check run failed"). It is told to fix them on its branch and answer the
request (§chat.merge-queue/answers). Before Land, it is told to fix them, then that the user presses
Land or types "land it" in that chat (which the session records with `worktree land`,
§chat.worktrees/tool), and "Nothing has been landed or approved yet." The user may press Land
already: the branch then waits as Approved · waiting for a fix and goes in line by itself once
nothing blocks it. After Land, it is told the user's Land stands and the branch goes in line by
itself, and never to ask the user to land it again. The request names no card. It goes as a merge
queue request (§chat.merge-queue/requests), which waits for the chat's turn to end; nothing is sent
for an archived or terminal session, or when the outcome doesn't say the work is finished (or no
outcome is ever recorded for the session). Nothing is sent, either, while the branch sits at exactly a
commit the user approved that is in line, checking, waiting for the user's decision, open on the host
or already landed:
a change made now would only move the branch off that commit. And nothing is sent when no commit of
its own is left to land (§chat.worktrees/nothing-left). A note comes again only once the branch has a
new commit of real work. A branch that is Approved · waiting for a fix or back with its chat isn't in
line and still gets its requests: they are how it hears what to fix. The Landing specs request
(§chat.worktrees/landing-specs) holds back the same way.

**Why a branch back with its chat isn't going back in line.** A branch back with its chat whose fix
isn't Ready to land says why, on its row and card ("Not back in line yet: {why}.",
§app.merge-queue/view), and its chat is told the same in a request. {why} comes from the reading of
that worktree its owning chat last published, read only, never a fresh read, and kept for a few
seconds:
- the reading's own words when the worktree isn't ready: "this chat's last test run failed: …", "2
  open questions", "working now", "temporary commit: …", or another of the worktree's reasons;
- "its spec drafts don't fit" when it reads Landing specs at that commit;
- "{n} uncommitted files in its folder: commit or remove them first", or "its chat hasn't said the
  work is finished", when the code conditions alone hold but it isn't Ready to land;
- nothing when it is Ready to land at that commit.

When no reading can say (no owning chat, an archived one, a chat not read yet, no such worktree in
the reading, a merged or gone worktree, or a reading that is Ready to land at another commit), the
queue's own checks answer: "its newest commit is a temporary commit ("…")" or "{n} uncommitted files
in its folder: commit or remove them first", else nothing.

## §chat.worktrees/landing-answers — The typed go-ahead, kept and handed to the queue

Sova keeps the user's go-ahead typed in a branch's own chat in `<state root>/landing.json`,
outside every repository. That chat's `worktree land` (§chat.worktrees/tool) records it for the
branch at its head commit, marked as typed in the owner's chat, with or without specs, with or
without review, and as a pull or merge request when the words asked for one
(§app.merge-queue/strategies), as the user said; the newest 200 are kept. Each one also keeps the branch's spec
drafts as they were: their names and one hash over the files under each draft's `spec/` (its
`draft.json`, where notes and evidence go, apart). Every writer holds one lock while it re-reads and
replaces the file, so two records written at once never drop each other. The file holds go-aheads
only: the Not Yet answers and docs entries an older file still lists are ignored, and the next write
drops them; older records' `by` values still read.

The merge queue reads each new typed go-ahead once (the go-aheads already in the file when it first
starts are never taken) and turns it into an approval of that branch at
that commit, exactly as a Land would be (§app.merge-queue/approve): the same pinned commit and
drafts, the same refusals. A go-ahead the queue refuses (uncommitted files, nothing to land, a repository
the queue doesn't serve: "not a project the merge queue serves: merge it into main from the
chat", with no queue record made, §app.merge-queue/served; in a served repository, a commit that is
no longer its branch's head because the branch was amended or rebased since: "{branch} at {sha}
couldn't be queued to land: that commit is no longer the head of {branch}. Type "land it" again
to land its new head.", never the not-served sentence) is told to that chat's model with the reason, as a hidden line at its next turn,
never as a message drawn as the user's (§chat.merge-queue/chat-turns). Nothing else acts on
the file, and a go-ahead is never the user's agreement to the promises that land: no record is
stamped `agreed` by it.

**Enforced by the queue.** A served project's merge queue is the only way into its target: `worktree
merge` into it is refused (§chat.worktrees/tool), and the Project Overseer's Merge Branch reads
Land and approves the branch in the queue (§app.project-overseer/coding-worktrees). A merge into
any other branch needs no go-ahead. A commit made to the target from outside the queue is allowed,
and the queue pauses on it (§app.merge-queue/master-moved).

## §chat.worktrees/cleanup — Removing merged worktrees

Sova removes merged worktrees only when asked: by the user from a new session's empty state
(§chat.transcript/empty-worktrees), or by `sova_archive` with `worktrees: "remove"` for the
archived session's own worktrees (§app.overseer/tools), both through one service on the server
(`server/worktree-cleanup.ts`). Nothing else removes a worktree on its own, but for the merge
queue's own scratch copies (below), and the `worktree` tool's merge stays non-destructive.

- **Which trees.** Git's own list (`git worktree list`) for the repository the session's folder is
  in: every linked worktree in it, wherever its folder is; the main checkout is never one. A remote
  session's folder has none. Each is **merged** (§chat.worktrees/merged-state, against the
  repository's main branch, master else main: its branch's tip is in it by ancestry, or by content
  — a trial merge that leaves the main branch's tree unchanged — after at least one commit of its
  own), **empty** (its branch has no commit of its own: its tip is still the commit git's reflog
  says the branch was created at; with no reflog, a branch in the main branch counts as merged), or
  **unmerged** (anything else, a tree on no branch included). The merge queue's own scratch copies
  (§app.merge-queue/resolve-copy) are none of these: they are never counted, listed, kept or
  removed here.
- **Nothing left in the folders, on a git that can do it.** The trial merge behind "by content"
  normally runs outside the project, so nothing it writes, a merge driver's temporary files included,
  is left in the main checkout or any worktree, even when git is stopped at its time limit. The
  exception is a project with a `.gitattributes` file on a git older than 2.43, or one whose version
  can't be read: that git can't read the attributes from outside, so the merge runs in the checkout.
  Its answers stay right, and a merge stopped at its time limit can still leave git's temporary files
  there.
- **The count.** `GET /api/worktrees/summary?path=<session>` answers the repository's linked
  total and its merged, empty and unmerged counts, from git alone. It is cached per repository for
  about 30 seconds, and a change to git's list of worktrees or a removal drops it.
- **What is kept, and why.** A merged or empty tree is removed only when none of these holds, each
  checked again right before its removal: it is locked; it has any uncommitted change or untracked
  file; it holds what can't be rebuilt (an ignored file outside the rebuildable folders, or a nested
  repository or worktree), or its files can't be read (§chat.worktrees/leftovers); a session's folder (its header cwd),
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
  alone. A `dryRun` that is present and not a boolean ("dryRun must be true or false"), or an
  `expect` that is not a list of absolute paths, is a 400 before anything is removed. The answer says, per path, removed or kept and why.
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
- **The merge queue** never removes a worktree of yours: a landed branch's worktree stays until the
  user cleans it up here. It removes only its own scratch copies, itself, once their attempt ends
  (§app.merge-queue/resolve-copy).

## §chat.worktrees/leftovers — What can't be rebuilt keeps a worktree, and Remove Anyway

Git's own `worktree remove` deletes, without asking, every file the tree ignores and every
repository nested in its folder, uncommitted work included. So wherever Sova removes a worktree of
yours (Clean Up Merged and `sova_archive` with `worktrees: "remove"`, §chat.worktrees/cleanup;
project services' teardown of a worktree Sova cut, §app.project-services/teardown; a coding
session's Remove Worktree on the project page or by the build's effect,
§app.project-overseer/coding-worktrees), it reads what
the tree holds, at the dry run and again right before the removal, after the use checks (unmerged,
locked, a session's folder, a tracking session, a live process or record).

- **The read.** Git's status of every uncommitted and untracked file, and its list of ignored
  files, then a walk of the folder that never follows a symlink.
- **Rebuildable.** A file git lists by itself is judged by itself (an ignored `build/.env` in a
  tracked `build/` is work). The folders `node_modules`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache` and `.ruff_cache` count at any depth, inside your own ignored folders too; `dist`,
  `dist-*`, `build`, `out`, `target`, `coverage`, `.cache`, `.turbo`, `.vite`, `.next`, `.nuxt`,
  `.svelte-kit`, `.parcel-cache`, `.cpcache`, `.shadow-cljs` and `.gradle` count only where git
  lists that folder itself as ignored. The files `.DS_Store`, `*.tsbuildinfo` and `*.pyc` count
  too. `node_modules` is never walked; the other rebuildable folders are walked only to find nested repositories. A
  top-level `.agent` is rebuildable only while every regular file in it is one a hermetic agent dir
  generates (its settings, trust, copied-sessions, models, keybindings and vision-delegate files,
  `sova/auth-token`, anything under `sandbox-policy/` or `extensions/`); otherwise its files are
  listed and it is named `.agent (sessions)`, `.agent (auth.json)` (an `auth.json` or
  `claude-accounts/` in it) or `.agent (server state)`.
- **What keeps it**: any ignored file that isn't rebuildable, any uncommitted or untracked file, and
  any nested repository or worktree, a folder below the top holding a `.git`, untracked, ignored or
  inside a rebuildable folder (never under `node_modules`), and any initialised submodule. Its one reason names them (copy:
  §design.copy-deck/worktree-cleanup); a tree with only uncommitted files keeps today's reason.
- **A failed read keeps it**: git's status, ignored list or submodule list fails, a folder can't be
  read, or the tree holds more than 200,000 entries.

**Remove Anyway.** In the Clean Up Merged dialog (and on the project page's Remove Worktree,
§app.project-overseer/coding-worktrees), on a Stays row whose only reason is what it
holds (never after a failed read, and never for a use reason); `sova_archive` and teardown only name
the reason, and a merged or empty tree they keep shows in Clean Up Merged. It first lists in the
dialog exactly what goes: the uncommitted files, the ignored files that can't be rebuilt, each
nested repository (deleted whole) or worktree (its uncommitted work goes, its commits stay in its
repository), and the rebuildable folders that go with it, each list its first 500 and then the
count; focus starts on Back.
- The removal, `POST /api/worktrees/cleanup {path, force: {path, digest}}` (exactly one of
  `dryRun`, `expect` and `force`; a malformed `force` is a 400), answers only your own page: any
  other caller gets 403 and nothing is deleted. The dry run gives each such row `removeAnyway:
  {uncommitted, ignored, nested, rebuildable, counts, digest}`.
- Sova runs every check again and removes the tree only when the use checks pass and the digest of
  the full listing now equals the one you confirmed, with `git worktree remove --force -- <path>`
  (one `--force`) from the main checkout; the branch and the ledger are as for any removal
  (§chat.worktrees/cleanup). A nested worktree of another repository that went with it is then
  dropped from that repository's worktree list by name (`git worktree remove -- <path>` there, never
  a bare prune); its branch and commits stay. Otherwise nothing is deleted and the row shows why; a tree that is clean
  by then is removed as usual.

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
  look, the Session tab's or the session list's, reads the tree as removed ("Landed · cleaned up").
- A change of the session's file or of its row (its running state, last activity, TUI presence,
  archived flag, open questions or attention answer) reads every tree's changes again at once.
- An explicit look at the session's worktrees (the Session tab's Worktrees section, or
  `sova_session`'s Merge facts) re-reads every tree's changes when one of its readings may have
  stood the 5 minutes, or when the session is idle with its trees checked without Git
  (§app/idle-git-cache) and its answer is 10 seconds old: that look returns the answer it has at once, and the re-read shows on the next one. A look at an archived, idle session re-reads them under its own rule
  (§app/idle-git-cache, "Archived-idle exception").
