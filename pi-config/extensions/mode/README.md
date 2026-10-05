# Mode switcher for Pi

A **per-session** toggle between **normal** mode (pi as usual) and
**delegate** mode, where the main agent becomes an orchestrator and routes work
to background workers through the `subagents` extension (and `claude-code`, for
Claude workers). Delegate sorts work into four **profiles**, each routed to one
configurable worker — backend · model · effort — with an optional fallback:

| Profile | Covers | Default worker | Default fallback |
| --- | --- | --- | --- |
| **Planning & specs** | Non-editing design: plans, specs, architecture, and any investigation that feeds a design decision | `claude-code` · `claude-fable-5-1[1m]` · `medium` | `claude-code` · `opus[1m]` · `high` |
| **Investigation** | Focused read-only research or diagnosis of a specific question, with no design to settle | `claude-code` · `opus[1m]` · `low` | none |
| **Routine implementation** | Mechanical, well-specified, low-risk changes | `claude-code` · `opus[1m]` · `low` | none |
| **Complex implementation** | Ambiguous, cross-cutting, or high-risk changes | `claude-code` · `opus[1m]` · `medium` | none |

The defaults: fable/medium planning with an opus/high fallback, opus low for
mechanical work and medium where precision matters. Investigation is
deliberately conservative: read-only work on the same model as implementation,
at its cheapest effort.

- The orchestrator picks the profile by the work, not the cost: investigation
  that feeds a design is **Planning**, not Investigation; unsure between
  Routine and Complex, it picks Complex.
- A user's explicit choice for a task (backend, model or effort) wins over the
  profile. The model policy (`model-policy.json`) still applies at spawn, and a
  spawn it refuses is reported, not rerouted.
- The main thread stays the only voice to the user and **verifies every worker
  result** (reads diffs, runs tests) regardless of worker effort.

Simple questions, command runs, and trivially obvious one-line fixes stay with
the main thread; anything that would normally need a subagent or non-trivial
edit goes to a worker. `subagents` must be loaded, and `claude-code` for any
profile on that backend; no changes to pi and no Claude plan mode are involved
— workers keep their usual permissions, so "Planning and Investigation don't
edit" is a prompt-level rule the orchestrator checks.

## Install

```sh
~/pi-config/install.sh   # links this directory into ~/.pi/agent/extensions/
# /reload in pi
```

## Usage

| Action | Effect |
| --- | --- |
| `ctrl+p` → **Mode**, or bare `/mode` | Open the mode selector (see below) |
| `alt+m` | Toggle normal ↔ delegate |
| `/mode normal` · `/mode delegate` | Set explicitly |
| `/mode status` | Show this session's mode, the default for new sessions, the Delegate routing (and, in delegate, what each profile is actually using), the spec writer (and, with spec on, what it is actually using), strict flag, minor modes, state file |
| `/mode default` | Save this session's mode, strict flag and minor modes as the default for new sessions (the only command here that writes `mode.json`) |
| `/mode sync` | Change nothing and say nothing: keep this session's mode block in the prompt whoever starts the turn (see below). Sova runs it at every chat open |
| `/mode strict on\|off` | Also remove `edit`/`write` from the orchestrator while in delegate (off by default) |
| `/mode align [on\|off]` | Toggle (or set) the `align` minor mode |
| `/mode spec [on\|off]` | Toggle (or set) the `spec` minor mode |
| `/align`, or `alt+a` | Open the read-only alignments viewer (see below) |
| `/align status` · `/align export [path]` · `/align on\|off` | List the alignments, write the open ones to a file (default `.pi/align.md`), or toggle align |
| `pi --major delegate` | Start that launch in a mode (not persisted) |
| `pi --minor align` | Start that launch with these minor modes on, comma-separated; `none` clears them (not persisted) |

Note: `--mode` is pi's own flag (the output mode: `text | json | rpc`), so the
mode switcher's launch flag is `--major`. Core consumes `--mode <value>` before
extension flags are read; `--mode=<value>` only ever reached this extension by
accident.

### Mode selector

The command palette (`ctrl+p`) has a **Mode** category right after *Models &
thinking*; bare `/mode` opens the palette straight at it. It lists:

- **normal** and **delegate**, radio-style: the current one is marked `✓`,
  and Enter switches to the highlighted mode and closes the palette.
- One row per minor mode (`align`, …) with a live `◉` on / `○` off marker.
  Enter toggles it **in place**; the palette stays open so several can be
  flipped in one visit. Esc goes back, Ctrl+P closes.
- **align: open viewer**, which opens the alignments overlay.
- **save as default**, the same as `/mode default`. Everything above it
  changes this session only; this row is the one that changes `mode.json`.

Root-level palette search finds these rows too (type `align`, press Enter).
Without an interactive palette (print/RPC mode, or the `command-palette`
extension not loaded), bare `/mode` shows the current status and usage as a
warning instead of changing anything; the `/mode <argument>` forms are the
scriptable interface. The category is registered through
`command-palette/contracts.ts`; rows are built in `palette.ts`.

The footer always shows the current mode:

- `normal` (dim)
- `delegate` (accent)
- `delegate · fallback:plan` (warning: Planning & specs is on its fallback)
- `delegate · ask:routine,complex` (warning: those profiles have no worker that
  can run; the orchestrator asks before routing that work)
- `delegate · strict`
- `normal · align` (accent: a minor mode is on)
- `normal · spec · writer:fallback` (warning: the spec writer is on its
  fallback; `writer:ask` when neither can run)
- `delegate · strict · align`

Every switch appends a `── mode → … ──` marker to the transcript; minor-mode
switches append `── align on ──` / `── align off ──`, and strict toggles
`── strict on ──` / `── strict off ──`. Each of those entries also carries the
full post-switch snapshot, which is what makes the state per session (see
**Behaviour**).

## Minor modes

Minor modes are extra instructions toggled independently of the major mode:
zero or more can be active at once, in normal or delegate. Their blocks
are appended after the delegate block (when in delegate) in registry order
(`align`, then `spec`). Only `align` adds a bridge sentence to the delegate
block; `spec` composes with either major mode and with `align` unchanged, and
carries one paragraph of its own when a spec writer is set (see **Spec
writer**).

- **align** — before building anything non-trivial, the agent investigates
  (in delegate, through a non-editing **Planning & specs** worker — never the
  cheaper Investigation profile, since this is design work; itself otherwise),
  records an alignment with the `align` tool (findings, approach, rejected
  alternatives, and questions with recommendations on architecture, UX, scope
  and trade-offs), then stops and waits for the user's answers. Questions,
  explicit commands, pointed-at one-liners and confirmations are exempt. Text
  in `minor.ts`; see **Alignments**.
- **spec** — every behavior change is spec'd: the agent finds its roots in the
  project's `.sova/spec/` documentation with `map` and `where`, looks at their
  contents with `toc`, runs `impact --near` on what it will change, and `read`s
  each root and each passage it needs, exact, finishing fragments at
  `end == total`; whole-chain `packet` and `scope` remain available for
  deliberate machine inspection and review. A page's success
  or `done` status is not complete context or proof of reading. It writes a claim for behavior no claim
  covers in a feature draft before coding, claims only the files the task
  changed, checks with `census --changed` before finishing that none of them is
  left unclaimed, and promotes what it verified (or says why it could not).
  Work that changes no behavior — refactors, tests, tooling — is exempt, and
  the agent says it is claiming the exemption. The documentation changes only
  through drafts; a promotion `conflict` is per declaration, and it is
  re-applied in a new draft from current. The discipline itself
  is [`spec-mode.md`](spec-mode.md), and nowhere else. `minor.ts` reads it at
  load: the injected block is that file byte for byte, minus trailing
  whitespace, and its one `sh` block is the shell prefix `minor.ts` exports as
  `SPEC_CORE_SHELL`. A missing, repeated or multi-line block fails the load. A
  project may point its agents at the same file without the mode; Sova's
  `CLAUDE.md` does. The tools it runs without asking are the three linked into
  the agent directory (`<agent dir>/extensions/spec/core/`, resolved like pi's
  own agent dir: an exact `~` or a leading `~/` is home), always through that
  `sh` recipe, never a guessed path. A copy inside the
  project is read and asked about first. A reply on a turn that edited,
  committed, promoted or merged ends with one exact line,
  `Also changes: §X — <what>` or `Also changes: none`, nothing after it: it
  names foreign § only, never the task's new claims (a § the user asked for
  is still foreign), and notes (the exemption, a gap) go above it; a turn
  that only answered writes none. A request, hook, helper or CSS class is
  plumbing and never flags. No widget, command or entry of its own, but two
  mechanical checks (`spec-guard.ts`, plain node, shared with the Claude Code
  workers' hooks). Local coverage needs a spec, Git, and the trusted tools;
  unavailable or partial inputs are not complete coverage. Reply-format diagnostics
  may still run without them. The parent checks are disabled in a remote session:
  - **Census on a Git delta.** After any tool call, bash included, each work
    tree the call writes in (the cwd, a command's `cd`/`git -C`/`--root`, an
    edit's file) has its `git status` (paths and mtimes) compared with what the
    session saw; its baseline is taken at the run's start or just before the
    first call that touches it. When a path is new
    (a commit's files count too), `census --changed --base <session-start
    HEAD> --own-base …` runs (`--spec` the draft this session created, else
    the newest one created since the session started, else in a linked
    worktree its newest) and, on the first in-boundary change,
    each new file in the boundary or mapped outside it, or a new foreign §, a
    short `[spec census]` digest is appended to that tool result, with a
    "No draft yet" line while there is none. It stays short: each file in
    `New:` names at most 3 §, then `(+N more)`; the `Rule:` and "No draft yet"
    lines print once a session per tree, and each "New claims under a foreign §"
    pair once (only printed pairs count as said). Both pi and Claude Code workers
    retain a separate census state per tree, including when returning to a tree
    already seen; the state still keeps every foreign § seen. Tools that cannot write the repo
    (`CENSUS_SKIP_TOOLS`, exact names: read, grep, find, ls, align, the agent
    and team listing tools, agent_wait (it waits on workers and writes nothing
    to the repo), the link inbox tools; never bash) skip the census:
    no look, no baseline move, so the next writing call reports it all. The same digest says, on the call
    that did it, when the current spec (`manifest.json`, `claims/**`) was
    written by hand: an edit or write call on it, or a shell command that is
    neither a draft tool nor git and changed it; and when a git operation
    rewrote a commit a draft's evidence names (a rebase, reset or amend: the
    commit was on the branch before the call and isn't after), with the
    way back: `git rebase --abort` while the rebase is under way, else, with
    no uncommitted changes, `git reset --hard <the exact old tip>` (the census
    relay, which has no sha, says to find it in `git reflog`); then merge
    master in instead. Both look at the trees the call works in (`cd`, `git -C`).
    Evidence commits `census --changed` reports as orphaned (`orphanedEvidence`)
    that the guard didn't already name are relayed once; a manifest conflict
    during a rebase says to abort it rather than run merge-manifest. A
    promote call's `driftWarnings` (a removed quantity another § still states)
    are relayed on its result as a `[spec check]` warning, never a block.
    `PI_SPEC_CENSUS_HOOK=0` turns it off.
  - **The `Also changes:` line.** One grammar and parser (`also-changes.ts`, no
    imports; the Claude Code Stop hook and the A/B scorer use it too): items
    separated by `;`, each led by the § it names (`, /d` completes from the
    preceding full id), a § inside a description never named, a broken line a
    format error of its own. At the end of a run (`agent_before_settle`):
    - **Landings**, each judged on its own range (`judgeOp`): this session's
      commits, merges (worktree tool, bash, fast-forward; a `worktrees:merged`
      event's `before`/`after`/`top`) and promotes; an interrupted run's
      (checked with the next run); and its workers' from the ledger
      (`SOVA_SPEC_LEDGER`, one JSONL file per parent session, appended by
      `spec-worker.ts` and the Claude Code hooks), taken in a run that relays
      a worker or changes something itself. A merge that only brought the
      default branch into another branch is absorbed, not landed.
    - **The list** is the union of their `sova-spec.mjs foreign` lists, the
      task's own claims out (`--own-base`: absent at the default tip at run
      start and at the fork point), plus the session tree's uncommitted
      changes and edited drafts. Tracked worktrees join only in a relay run,
      from where the last run that took them left them; a Q&A run leaves them
      (and the ledger) for later, so a background promotion forces no line.
    - **The landing gate** (`foreign --landing`): each changed file no claim
      maps needs a `Plumbing: <path> — <why>` line, each unpromoted draft
      record's § a `Deferred: §X — <why>` line, except at a landing on the
      default branch, where only a promotion or the override line passes
      it; § whose mapped code changed with their text untouched may be named
      without being extras.
    - A landing run is re-prompted (hidden `spec-check` message) up to twice,
      as the Stop hook; a line on a Q&A run once; any other wrong line gets a
      warning, on screen and as a hidden note with the next prompt. A
      `manifest.json` Git holds in conflict is named with the `merge-manifest`
      command. `Spec check override: <why>` above the last line excuses an
      omission only, never an extra. A check that fails says so, to the model
      too. `PI_SPEC_CHECK=0` turns it off.

  - **In pi workers.** Workers start with `--no-extensions`, so the mode
    extension is absent there; the subagents spawn path loads
    `spec-worker.ts` (`-e`) into every code-writing pi worker and member a
    spec-on session spawns: the same census digest (forbidden writes
    included), the same turn-end line check over its own operations and tree
    (landings re-prompted twice, anything else once), and a ledger entry per
    git operation for the parent.

  - **No automatic assessments.** Neither the session, its pi workers (`spec-worker.ts`)
    nor Claude Code workers' hooks run the assessment companion, capture a task
    baseline or write a receipt, and none of them has an assessment tool. An
    assessment is an explicit `sova-spec-assess.mjs prepare <name> --base <known rev>`,
    `record` and `status` (`.sova/spec/USAGE.md`, `../spec/README.md`). A spawned
    worker's `SOVA_SPEC_OWNER_SESSION`/`SOVA_SPEC_WORKER_ID`/`SOVA_SPEC_TEAM_ID` are
    there for a caller to pass as `--attribution-json`. Receipts and task entries
    left by the earlier automatic observer stay as they are; an old native hook state
    keeps its assessment fields unchanged and ignored, while its census and turn
    fields update as usual.

  See `../spec/README.md`.
- **codemode** — gives the model pi's `codemode` tool (pi's `docs/codemode.md`):
  a JavaScript script that calls the session's other tools in parallel and
  filters their output. It has no prompt block and no mode note
  (`MINOR_PROMPTLESS` in `minor.ts`): the tool's own description is the guide.
  The extension keeps the tool in the loadout exactly while the mode is on
  (`syncCodemodeTool`, where `vis_guide` syncs, and right after a switch made
  between runs; a switch during a run applies when it settles), removing it
  even when `defaultTools` or a restored transcript activated it, except while
  a registered tool has `codemode` or `deferred` exposure (MCP). Where the tool
  isn't registered (an SDK runtime without the factory) it does nothing. A host
  that keeps the tool's activation itself (Sova in a Claude Code chat) pins it
  with `codemode:host` (`CODEMODE_HOST_EVENT`). Never reaches workers. With
  spec on, a census or guard note for a call a script made is repeated on the
  script's own result, the one the model reads.

Like the major mode, the prompt is read per turn, so toggles apply from the
next prompt. The active triple (`mode`, `strict`, `minorModes`) is published
on `pi.events` as `mode:state` (`state.ts` `MODE_STATE_EVENT`) on every change,
and again on `mode:discover`: the subagents extension reads it to brief the
workers a spec-on session spawns. Unknown names hand-edited into `minorModes` are dropped on load.
Toggle them from the palette's Mode category or with `/mode <minor> [on|off]`.

### Alignments

While `align` is on, the agent records every alignment with one tool, `align`
(`align-tool.ts`), which is in its loadout only while align is on. An
alignment is a structured document, `al_N`, one per concern; several can be
open at once. It holds a title, a one-line summary, findings (`fN`), approach
steps (`aN`), rejected alternatives with why (`xN`) and questions (`qN`). A
question has a topic, the ask, optional context and options (label and
trade-off), a recommendation (choice and why) and, once answered, a decision
(its text, `user` or `accepted-recommendation`, and when). Ids are never
reused, so "q3" means one question for the document's life.

One call applies a batch of ops to one document, atomically (one bad op fails
the call, with the reason, and changes nothing). The schema has one branch per
op, each with exactly its fields, the required ones required: `create` (inline),
`import` (`path`: a JSON file a planning worker wrote at an absolute path
outside the repository, validated strictly; only a regular file up to 256 KB,
and refused in a remote session, whose files live on the target: create inline
there), `add`, `edit` (a finding's or step's `text`), `edit_question`,
`edit_rejected`, `edit_doc` (title, summary), `remove`, `decide`, `accept`
(`qs`: the recommendation becomes the decision; never over a question already
decided, which must be reopened first), `accept_all`, `reopen`,
`drop_question` and `drop_alignment` (each with a `reason`), `status`
(`implementing`, `done`, back to `open`), `exempt` (alone, with a `reason`: a
work request needs no alignment) and `get`. A field or op borrowed from
elsewhere gets a did-you-mean (`newText` → `text`, `why` → `reason`, op
`delete` → `remove`, `create` with `fromFile` → `import`, a bare op without
`{ops: [...]}`). The result is a compact echo of what is still open. Sessions
written with the older op names (`create` + `fromFile`, `drop`, `accept`
`"open"`) still fold: the state is read from the results' snapshots, never
from the call's arguments.

Status is derived from the data: `aligning` while a question is open (or
there are none yet), `confirmed` once every question is decided or dropped,
and `implementing`, `done` or `dropped` when the agent moved it there. The
agent answers nothing itself: the user answers in chat ("q2: yes", "your
recs", or "3a": q3's option a, recorded as that option's label), and the
agent records it with `decide`/`accept`. Options are lettered a, b, c… wherever
they are listed, and a recommendation that names an option by its label reads
"b — <label>".

- **State** — each changing call returns the document's full snapshot in the
  tool result's `details`; the newest snapshot per id on the branch wins
  (`foldAlignments` in `align.ts`, node builtins only, also read by Sova). So
  `/resume`, `/reload`, `/fork`, `/tree`, a rewind and a compaction all land on
  the right state with nothing else written.
- **What the model sees** — the tool's description and guidelines (in pi's
  tools section, so they survive a dropped mode section), the align prompt
  block, and a hidden `align-state` message on each user prompt listing the
  open alignments and their open questions, each with its lettered options. A
  compaction writes one more, right after its summary, that also lists their decided and dropped questions: a run
  no user prompt starts (a worker's report) gets no per-prompt note, and the
  summary may state the alignments loosely. Nothing about alignments goes into
  the system prompt: a prompt change restarts a Claude Code session's CLI.
- **No gate; one nudge** — nothing blocks edits or spawns while a question is
  open. A run that is about to settle with no align call, whose final reply
  reads like a plan asking the user to decide (`planSignal`: an old
  `## Alignment: <title>` block; a closing question that asks for a decision or a
  go-ahead, never a merge, push or restart confirmation, and not options offered
  back to a user who asked a question; or questions listed under a label such as
  "Questions for you:"), gets one hidden
  `align-nudge` and one more request; never twice in a run. Only a successful
  align call that changed a document or recorded an exemption counts as recorded:
  a refused call or a bare `get` does not.
- **Widget** — one line above the editor while align is on and an alignment is
  open: `◇ align · al_3 2/7 open · al_2 implementing · alt+a view`.
- **Tool row** — the call as one dim line (`◇ align al_3 · decide q3 · → implementing`),
  the result as a compact card (the whole document when expanded).
- **Viewer** — `/align`, `alt+a`, or the palette row open a read-only overlay
  rendering one alignment as markdown; `←/→` switch between them, `↑↓` or
  `j/k` scroll, `pgup/pgdn` page, `g/G` top/bottom, `q`/`esc` close. It
  refreshes live after each call. Outside the TUI (RPC hosts such as Sova)
  `/align` shows them as a notification. `/align status` lists them (also the
  `alignments:` line of `/mode status`); `/align export [path]` writes the open
  ones as markdown (default `.pi/align.md`).
- **Older sessions** — before the tool, the agent wrote a markdown block that
  the extension parsed into `align-doc` custom entries. Those stay read-only:
  the viewer shows the newest one when a session has no tool alignments, the
  transcript keeps its dim `── alignment v2 · questions open · 1/2 settled ──`
  marker, and nothing parses markdown any more.

- **Adversarial review (experimental)** — behind the boolean launch flag
  `--adversarial-review` (off by default; Sova passes it per hosted session).
  Off, nothing here exists: the tool, its schema and the prompt are exactly as
  without the feature (`tests/review-smoke.mjs` pins them to a fixture). On,
  from `session_start` the tool is re-registered with two more ops — `review
  {phase: plan | diff, state, reason, model?, blockers?}` and `close_blocker
  {phase, id, by: check | evidence | waiver, evidence}` — and the rules for when
  to review in its description and guidelines, and `/review plan|diff [al_N]`
  asks for one. Each alignment then carries a `review` record (a `plan` and a
  `diff` entry: state, reason, model, blockers), so it folds, resumes and
  rewinds with the document. Starting a phase reserves it before the reviewer
  spawns and never runs twice; `status implementing` waits for a running plan
  review and `status done` for every review and every open blocker. The
  reviewer is the chat's subagent profile's `reviewer` route (routed like the
  spec writer; none = no review), spawned read-only (pi `read, grep, find, ls`;
  claude-code `Read, Grep, Glob`) with the fixed prompt `review-prompt.ts`
  writes, which the start's result carries filled in.

The viewer key is `alt+a` by default; set `"viewerShortcut"` in `mode.json`
to change it. If it collides with the mode toggle or the `align` toggle key,
it is not registered and a warning says so at session start.

## Behaviour

While in delegate, the extension appends orchestration instructions to the system
prompt on every turn (`before_agent_start`), so toggling takes effect on the
next prompt without `/reload`.

How those instructions reach the model depends on the host. On pi >= 0.86 the
handler writes the blocks into `systemPromptOptions.sections.mode`, which pi
diffs against the section the model already has, and switching back to normal
deletes the section so the instructions stop applying. On older hosts without
sections (pi < 0.86) there are no sections, and the blocks stay a whole-prompt
append as before.

A changed section is a cheap tail patch only on models that take
mid-conversation system messages (`compat.supportsMidConvoSystemMessages`:
Opus on pi's anthropic provider, gpt-5.4+, kimi-k3, …). Everywhere else pi
folds it into a new head, and the claude-code provider restarts its CLI and
re-sends the whole history uncached. So a **minor-mode toggle never changes the
section**: its minor blocks are the **head**'s, the minor modes the first run
after the session's start (or its last compaction) was built with. The switch
reaches the model instead as a hidden `mode-note` custom message
(`display: false`) at the next run, one path for every provider: beside the
user's prompt (`sendMessage(…, {deliverAs: "nextTurn"})` in
`before_agent_start`), or steered in ahead of the first request of a run an
extension's message starts (`agent_start`). Turning a mode on carries its whole
block, the text the head would have had, unless that block is already in
context (in the head, or in an earlier note since the last compaction), when
the note points back to it; turning one off says its instructions no longer
apply. A run already under way keeps its mode to its end.

The head is persisted additively in the `mode` entry: a switch records `head`
only while it differs from that entry's `active.minorModes`, and each note's
`details` (`{v: 1, minorModes, guides}`) records what the model has been told,
so a reopened session rebuilds the head it started with and replays its notes
(`restoreHead` in `state.ts`). A compaction loses the cached prefix anyway: the
next run rebuilds the head from the modes active then, and notes the compaction
kept in its recent tail are dropped from requests (`context`) once it has. A
major-mode switch, a Delegate routing change, and align in delegate (whose
bridge paragraph follows the active align) still change the section. Spec-writer
routing changes the section when spec is in its head; when spec was introduced
by a note, a new hidden routing note supersedes the earlier writer instead,
without resending the whole guide. This refresh also runs at a worker-wake turn
boundary. Clearing the writer tells the session to write its own draft and
evidence. Align also changes the tool set (its `align` tool), which breaks the
prefix on every provider and restarts the claude-code CLI regardless.

The prompt is the same whoever started the turn. pi runs `before_agent_start`
only for a turn the user's prompt starts; a turn an extension's message starts
(`sendMessage(…, {triggerTurn: true})` — a subagent settling, a team question)
skips it, and pi's own refresh before that turn's second request rebuilds the
prompt from the session's *base* options, which know nothing of extension
sections. Left alone, that patched the mode section out mid-turn and back in at
the next user prompt, and the claude-code provider restarted its CLI (and
re-sent the whole history) at every switch. So the extension also keeps the
block in the base options: they are reachable only through a command context
(`ctx.getSystemPromptOptions`), which `/mode` and `/align` adopt — Sova runs
the quiet `/mode sync` at every chat open — and from then on every switch, every
`before_agent_start` and every run start (`agent_start`, after pi may have
rebuilt the base on a tool change) writes the current block there. A session
driven only by the shortcut or the palette, with no `/mode` yet, keeps the old
behaviour until one runs. Covered by `tests/wake-turn.mjs`.

### Two scopes

The **active** state — major mode, `strict`, minor modes — belongs to **one
session**. Switching in one pi window, or in one Sova chat, changes nothing
anywhere else. It is persisted by snapshotting the whole triple into the same
`mode` custom entry every switch already appended:

```json
{"customType":"mode","data":{"minor":"align","on":true,
  "active":{"version":1,"mode":"delegate","strict":false,"minorModes":["align"]}}}
```

So it travels with the transcript: it restores on `/resume`, `/reload`,
`/fork`, `/tree` and a Sova reopen, exactly like the alignments. The
newest entry with a readable `active` wins; entries written before this
existed, and any future schema this build cannot read, are skipped (they still
render as markers). Restoring writes nothing, so merely opening a session
never appends to it.

`~/.pi/agent/mode.json` holds the shortcuts and the **default a new session
starts from**:

```json
{ "version": 1, "mode": "delegate", "strict": false, "minorModes": ["align"] }
```

A session that has never switched anything follows that default, re-read on
every start — so editing the file (or `/mode default`) moves every untouched
session at once. The first switch in a session pins it, and it stops following.
Launch flags (`--major`, `--minor`) apply on top of the default at startup only,
and lose to a session's own snapshot.

`/mode default` and the palette's **save as default** row are the only things
here that write `mode.json`; `/mode <x>`, `/mode strict on|off`, `/align
on|off`, `alt+m` and the palette toggles never do. Other fields in the file are
preserved when it is rewritten.

**Migration.** Files written before this change are read as the default, so a
global `"minorModes": ["align"]` would still start every new session in align.
Set the file to what new sessions should start as — by hand, or with
`/mode default` from a session already in that state. Sessions that predate
this change carry no snapshot, so they follow the default until their next
switch.

An optional `"shortcut"` field (a pi-tui KeyId such as `"alt+h"`) changes the
toggle key on the next reload. An optional `"minorShortcuts"` object (for
example `{ "align": "alt+l" }`) binds a toggle key per minor mode, also on the
next reload; there are none by default. An optional `"viewerShortcut"`
(default `"alt+a"`) opens the alignments viewer. Files written before minor modes
existed load with no minor modes on.

## Delegate routing

`~/.pi/agent/mode-delegate.json` holds the four profiles. It is **its own
file** on purpose — `mode.json` is rebuilt from known fields on every write, so
a routing kept there would vanish on the next `/mode default`:

```json
{ "version": 1, "profiles": {
    "planning":      { "primary":  { "backend": "claude-code", "model": "claude-fable-5-1[1m]", "effort": "medium" },
                       "fallback": { "backend": "claude-code", "model": "opus[1m]", "effort": "high" } },
    "investigation": { "primary":  { "backend": "claude-code", "model": "opus[1m]", "effort": "low" }, "fallback": null },
    "routine":       { "primary":  { "backend": "pi", "model": "zai/glm-5.3", "effort": "high" }, "fallback": null },
    "complex":       { "primary":  { "backend": "claude-code", "model": "opus[1m]", "effort": "medium" }, "fallback": null } } }
```

- `backend` is `pi` or `claude-code`. A pi `model` is `provider/modelId` and its
  `effort` a pi thinking level (`off`…`max`); a Claude `model` is the CLI's own
  id or alias and its `effort` one of `low medium high xhigh max`.
- `fallback: null` means none. A missing file reads as the defaults; a slot that
  doesn't parse takes its default; an unknown `version` reads as all defaults.
- Edit it by hand. Sova no longer writes it: Delegate routing is edited per
  subagent profile in Settings → Subagents, and this file only seeds that
  library and is its fallback. Nothing in this extension writes it.

**Global, read at every turn boundary, never snapshotted.** The file is shared
by every session, TUI and Sova alike. A session in delegate re-reads it (one
`stat`) in `before_agent_start`, so an edit reaches sessions already in delegate
from their next prompt. Normal mode never reads it. No session keeps a copy:
transcripts carry the mode, never the routing.

**Which worker a profile uses** (`routing.ts`), decided per turn:

1. The **primary**, if it may run.
2. Else the configured **fallback**, if it may run — **disclosed**: the status
   bar shows `fallback:<profile>`, a warning notification names the reason, and
   the prompt tells the orchestrator to say so the first time it uses it. While
   the primary is in use, the prompt offers the fallback for a retry only if it
   can run too; a fallback known not to run is named with its reason, and a
   failed primary then means asking.
3. Else **nobody**: the prompt tells the orchestrator to ask the user which
   model to use before delegating that kind of work. It never picks a model of
   its own — not even one that is offered.

"May run" is decided from **discovery** and the **model policy**:

- Discovery runs on entering delegate, on every session start or `/tree` while
  in delegate, and at a turn when the routing changed or a backend's last answer
  has aged out — a model list after 10 minutes, a failed discovery after 1
  minute, a backend that wasn't loaded at the very next turn — in the
  background, never blocking a turn. A turn while a probe for the same routing
  is still running joins it rather than restarting it, so a notice the probe
  owes (entering delegate announces fallbacks) is never dropped. pi models come from
  the session's model registry (with each model's supported thinking levels);
  Claude models from the `claude-code` backend's `listModels` through the
  `subagents:backend-discover` contract (a ~1–3 s `claude` initialize call,
  cached 60 s, 15 s timeout). No worker starts at load or in normal mode.
- A backend that answers and doesn't list the model, or lists it without that
  effort, makes the tuple unavailable (efforts are never clamped silently). A
  model's efforts are what the backend reported, cut to what the backend accepts
  at all (`effectiveEfforts` in `delegate.ts`, the rule Sova's settings use
  too); nothing usable reported — no list, `[]`, or only efforts the backend
  would refuse — means unconstrained. A
  backend that isn't loaded at all counts as unavailable too — `agent_spawn`
  would refuse it.
- **Except a Claude alias the CLI's list omits.** The `claude` initialize model
  list is remote and account-gated, and alternates within minutes between a
  shape that carries `opus[1m]` / `claude-fable-5-1[1m]` and one that does not,
  while the CLI accepts a valid alias at runtime either way (verified on
  2.1.280). So a shape-valid Claude model (an alias: no `/`, no leading `-`)
  missing from a successful list is "not verified" and stays in use, exactly
  like a failed discovery; only a shape-invalid id is refused. pi's registry is
  local and reliable, so a pi model it doesn't list stays unavailable.
- **A failed discovery is not absence.** CLI missing, timed out, logged out:
  the tuple stays in use, "not verified", and spawn has the final word. If a
  spawn then fails on model availability, the prompt says to retry once with
  that profile's fallback and say so, and otherwise ask.
- The **policy** is re-read per turn: a model or provider it keeps from
  subagents makes that tuple unavailable, so the profile moves to its fallback
  — disclosed, with the policy's reason — or asks. Spawn still enforces the
  policy on its own; nothing here routes around a denied provider to a model
  nobody configured.

## Spec writer

`~/.pi/agent/mode-spec.json` (`spec.ts`) names the worker that writes the spec
while the `spec` minor mode is on — in **either** major mode, since spec is
independent of Delegate:

```json
{ "version": 1, "writer": {
    "primary":  { "backend": "claude-code", "model": "opus[1m]", "effort": "medium" },
    "fallback": null } }
```

- `writer: null` (the default, and what a missing or unreadable file reads as)
  means none: the session writes draft claims and evidence itself, as before.
  A primary that doesn't parse reads as no writer (there is no default worker
  to fall back to); a fallback that doesn't parse, or repeats the primary,
  reads as none.
- Tuples are exactly Delegate's (`WorkerChoice`, `parseChoice`), and the file
  is its own for the same reason `mode-delegate.json` is. Edit it by hand;
  Sova no longer writes it (the spec writer is edited per subagent profile in
  Settings → Subagents; this file only seeds that library and is its
  fallback). Nothing in this extension writes it.
- **Global, read at every turn boundary, never snapshotted.** A session with
  spec on re-reads it (one `stat`) in `before_agent_start`; with spec off it is
  never read.
- **Routed and probed like a Delegate profile** (`routeWriter` in
  `routing.ts`): primary, else the disclosed fallback, else nobody — ask. Its
  backends are discovered whenever spec is on, outside delegate too, with the
  same TTLs; a writer off its primary shows in the footer and is announced.
- **The prompt.** When spec is on and a writer is set, one paragraph follows
  the spec block (`buildSpecWriterPrompt` in `prompt.ts`; `spec-mode.md` stays
  byte-identical): spawn that one worker with `agent_spawn` on exactly that
  backend, model and effort to write draft claims and record evidence; give it
  the relevant spec passages quoted literally, the files the task changed and
  the verification done; it writes only under `.sova/spec/drafts/`, never
  `claims/` or `manifest.json`; the session checks its draft and promotes. An
  unavailable model means one retry on the listed fallback, disclosed, else
  asking the user — never a substitute. A writer that can't run at all is
  rendered as Delegate renders a profile with no worker. The paragraph is the
  session's alone: a worker is never offered a writer (see **Workers**).

## Workers

A worker is not a chat, and it gets only what its parent's modes mean for it
(`MINOR_WORKER` in `minor.ts`, a record over every minor mode, so a new one
cannot compile without deciding):

- **Major modes never reach a worker**: workers spawn no workers, so Delegate
  has nothing to route there.
- **`spec` does; `align` and `vis` do not** (a worker's replies are read by its
  parent session, not rendered for the user). `composeWorkerPrompt` (`prompt.ts`) is the
  worker-scope minors only: for spec, the `spec-mode.md` block byte for byte,
  then `SPEC_WORKER_NOTE` (the brief is the go-ahead; the parent promotes unless
  the brief says otherwise; flags go as one question in the final report).
  Never the Delegate block, the align block or bridge, the vis guide, or the
  writer paragraph.
- **Delivered over the bus** (`events.ts`), like the sandbox's state: the
  extension emits `mode:worker` `{version: 1, minorModes, prompt?}` whenever the
  session's state is resolved or switched, at `/mode sync`, and on
  `mode:worker-discover`. It follows the active modes, not the prompt head: a
  minor toggle that reaches the chat only as a hidden note reaches the next
  worker whole. The
  subagents extension appends `prompt` last to each worker's system prompt at
  spawn (pi and Claude Code alike), and takes it afresh at a resume. A switch
  never reaches a running worker.
- **The worker role.** A worker on its worktree's own agent dir loads that
  tree's copy of this extension. The worker marker (`subagents/worker-mark.ts`,
  loaded first) answers `subagents:worker-discover`, which this extension asks
  at load; answered, it ignores `mode` snapshots on the branch (a `fork` copies
  the parent's) and `mode.json`, runs normal with the worker-scope minors of
  `--minor`, never strict, offers no writer and injects `composeWorkerPrompt`
  (its prompt head is its own; a mode note, if any, carries the worker form).
  An older extension never asks, and nothing is passed as a flag it would
  reject.

## Limits

Delegation bias and profile choice are instruction-level: the orchestrator
decides which profile a task is, and a user can always name a worker outright.
Even in strict mode the orchestrator
keeps `bash`, so nothing hard-forces delegation; strict only makes `edit` and
`write` unavailable. Mid-turn toggles apply from the next prompt. Alignments
are agent-driven: the viewer cannot answer a question, and the user's answers
reach a document only through the agent's `align` calls.

## Verification

```sh
cd extensions/mode
node --test index.test.ts     # pure state/prompt/minor/palette logic
node --test delegate.test.ts  # the routing file: defaults, parsing, persistence, per-turn re-read
node --test routing.test.ts   # primary → fallback → ask, discovery failure, policy
node --test spec.test.ts      # the spec writer file: parsing, persistence, per-turn re-read
node --test align.test.ts     # alignments: ops, strict input and import, hints, fold, echo, note, nudge heuristic, legacy entries
node --test review.test.ts    # adversarial review: the review and close_blocker ops, slots, guards, the record's normalization, the reviewer prompt
node tests/smoke.mjs          # real index.ts against a fake pi host, no model requests
node tests/review-smoke.mjs   # the adversarial-review flag through index.ts: off equals master's tool and prompt (fixture); on registers and runs the ops
node tests/wake-turn.mjs      # real pi session + scripted provider: same prompt whoever starts the turn
node tests/note-turn.mjs      # real pi session + scripted provider: a minor toggle keeps the head; notes, reopen, compaction
node tests/align-turn.mjs     # real pi session + scripted provider: the align tool, its hidden notes (per prompt, after a compaction) and the settle nudge
node --test also-changes.test.ts # the Also-changes grammar (s2-3's line, suffix ids, format errors), Plumbing/Deferred lines, landingGate
node --test spec-guard.test.ts # the spec checks: census per tree (real Git + spec tools), judgeOp (M3-B-s2-2's own claim), the ledger, command detection
node --test spec-assessment.test.ts # the assessment transport, and that nothing else is left to capture with
node tests/assessment-absence.mjs # session, worktree-config worker, pi worker and Claude Code hooks never call a trapped companion by themselves
node tests/spec-turn.mjs      # real pi session + scripted provider: census digest, forbidden writes, landings (two merges, Plumbing, Deferred, a worker's ledger commit), Q&A line, re-prompts, mode:state
node tests/spec-worker.mjs    # real pi session loading only spec-worker.ts (a pi worker's -e): the census digest; the turn-end check (edit, promote x2, Q&A line) and its ledger entry
```

Sova repository integration only, from its root: `node server/tests/spec-assessment.mjs`
exercises actual common worker spawning through a scripted RPC child running the pinned SDK,
owner reopen, readiness and a spec-on mode session with no assessment call, then the explicit
companion CLI against the known start revision.
This cross-boundary fixture is not required by, and does not run on, a standalone copy of
`pi-config/`; the extension and its portable tests import no Sova runtime.
