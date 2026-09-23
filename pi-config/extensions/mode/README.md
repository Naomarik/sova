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

The defaults are what this mode always did (it was called **claude-heavy**
until 2026-09: fable/medium planning with an opus/high fallback, opus low for
mechanical work and medium where precision matters). Investigation is new and
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
| `/mode normal` · `/mode delegate` | Set explicitly (`/mode claude-heavy` still works and selects delegate) |
| `/mode status` | Show this session's mode, the default for new sessions, the Delegate routing (and, in delegate, what each profile is actually using), strict flag, minor modes, state file |
| `/mode default` | Save this session's mode, strict flag and minor modes as the default for new sessions (the only command here that writes `mode.json`) |
| `/mode strict on\|off` | Also remove `edit`/`write` from the orchestrator while in delegate (off by default) |
| `/mode align [on\|off]` | Toggle (or set) the `align` minor mode |
| `/align`, or `alt+a` | Open the read-only alignment-doc viewer (see below) |
| `/align status` · `/align clear` · `/align export [path]` · `/align on\|off` | Summarize, clear, write the doc to a file (default `.pi/align.md`), or toggle align |
| `pi --major delegate` | Start that launch in a mode (not persisted; `--major claude-heavy` still works) |
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
- **align: open viewer**, which opens the alignment-doc overlay.
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
- `delegate · strict · align`

Every switch appends a `── mode → … ──` marker to the transcript; minor-mode
switches append `── align on ──` / `── align off ──`, and strict toggles
`── strict on ──` / `── strict off ──`. Each of those entries also carries the
full post-switch snapshot, which is what makes the state per session (see
**Behaviour**).

## Minor modes

Minor modes are extra instructions toggled independently of the major mode:
zero or more can be active at once, in normal or delegate. Their blocks
are appended after the delegate block (when in delegate) in registry order.

- **align** — before building anything non-trivial, the agent investigates
  (in delegate, through a non-editing **Planning & specs** worker — never the
  cheaper Investigation profile, since this is design work; itself otherwise), replies
  with its findings, proposed approach, and numbered open questions on
  architecture, UX, scope and trade-offs, then stops and waits for
  confirmation. Questions, explicit commands, pointed-at one-liners and
  confirmations are exempt. Text in `minor.ts`.

Like the major mode, the prompt is read per turn, so toggles apply from the
next prompt. Unknown names hand-edited into `minorModes` are dropped on load.
Toggle them from the palette's Mode category or with `/mode <minor> [on|off]`.

### Alignment doc

While `align` is on, the agent is asked to put its alignment in a fixed
markdown block that the extension captures at the end of every turn
(`align.ts`), so the alignment accumulates into one inspectable document:

```markdown
## Alignment: <short title>
### Findings
### Approach
### Open questions
- [ ] **1. Topic:** Question — with a recommendation
- [x] **2. Topic:** Settled question — the decision
### Rejected
- Alternative — why not
### Status
aligning | confirmed | implementing
```

Questions are numbered inside the checkbox label (`**1. Topic:**`), not with
a markdown list number: the viewer turns the marker into a glyph and drops
list numbering, so only a number in the label survives into what the user
reads. The parser still accepts `1. [ ] …` from older blocks.

The agent re-emits the whole block whenever something changes (answers,
scope, new findings), ticking settled questions `[x]` and keeping each
question's number and topic. An explicit "go ahead"
while questions are still open is honoured: the agent sets Status
`implementing`, keeps those questions unticked, and proceeds. Identical
re-emits are ignored; every change is a new **revision**. The parser tolerates
heading-level, case and punctuation drift but needs the headings verbatim;
turns that end in an error or abort are never captured.

Status is derived from the block: `implementing` and `confirmed` when the
Status section says so, else `questions open` while any `[ ]` remains,
`ready to confirm` when every question is ticked, and `aligning` for a block
without questions.

- **Widget** — one line above the editor while align is on and a doc exists:
  `◇ align · questions open · 2/5 settled · 41 lines · alt+a view`. It is
  hidden when align is off or the doc is cleared; the doc itself is kept.
- **Viewer** — `/align`, `alt+a`, or the palette row open a read-only overlay
  rendering the block as markdown with `☐`/`☑` checklist glyphs. Keys: `↑↓`
  or `j/k` scroll, `pgup/pgdn` page, `g/G` top/bottom, `q`/`esc` close. It
  refreshes live when a new revision is captured. Outside the TUI (RPC hosts
  such as Sova) `/align` shows the summary and markdown as a notification.
- **Persistence** — every revision is a session custom entry
  (`customType: "align-doc"`, `{ version: 1, doc }`, `doc: null` after
  `/align clear`), so the doc travels with the transcript, restores on
  `/resume`, `/reload`, `/fork` and `/tree`, and is readable by Sova. The
  transcript shows a dim `── alignment v2 · questions open · 1/2 settled ──`
  marker per revision. There is no global file; `/align export [path]`
  writes the markdown on demand.
- **Read-only** — the viewer never writes back; the agent's block is the only
  source of truth. `/mode status` includes an `align doc:` line.

The viewer key is `alt+a` by default; set `"viewerShortcut"` in `mode.json`
to change it. If it collides with the mode toggle or the `align` toggle key,
it is not registered and a warning says so at session start.

## Behaviour

While in delegate, the extension appends orchestration instructions to the system
prompt on every turn (`before_agent_start`), so toggling takes effect on the
next prompt without `/reload`.

How those instructions reach the model depends on the host. On pi >= 0.86 the
handler writes the blocks into `systemPromptOptions.sections.mode`, which pi
diffs against the section the model already has: a toggle costs one small
mid-conversation patch instead of a whole new prompt, so the cached prefix
survives, and switching back to normal deletes the section so the instructions
stop applying. On older hosts without sections (pi < 0.86) there are no
sections, and the blocks stay a whole-prompt append as before.

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
`/fork`, `/tree` and a Sova reopen, exactly like the alignment doc. The
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
(default `"alt+a"`) opens the alignment-doc viewer. Files written before minor modes
existed load with no minor modes on.

### The rename

Delegate was called `claude-heavy`. That name is a **permanent read alias**
(`LEGACY_MODE_ALIASES` in `state.ts`): it is accepted by `/mode`, `--major`,
`mode.json`, the per-session snapshots in transcripts, and Sova's API. Recorded
history is not relabelled: an old `── mode → claude-heavy ──` marker still
reads exactly that, in the TUI and in Sova. The name is never written: every new marker, snapshot and `mode.json` write says
`delegate`, and an existing `mode.json` becomes canonical on its next write.
Transcripts are never rewritten. (A build from before the rename reads a
`delegate` snapshot as unknown and falls back to the default — the one-way
cost of the rename.)

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
- Edit it in Sova (Settings → Modes → Delegate, which offers only what each
  backend actually lists) or by hand. Nothing in this extension writes it.

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
- **A failed discovery is not absence.** CLI missing, timed out, logged out:
  the tuple stays in use, "not verified", and spawn has the final word. If a
  spawn then fails on model availability, the prompt says to retry once with
  that profile's fallback and say so, and otherwise ask.
- The **policy** is re-read per turn: a model or provider it keeps from
  subagents makes that tuple unavailable, so the profile moves to its fallback
  — disclosed, with the policy's reason — or asks. Spawn still enforces the
  policy on its own; nothing here routes around a denied provider to a model
  nobody configured.

## Limits

Delegation bias and profile choice are instruction-level: the orchestrator
decides which profile a task is, and a user can always name a worker outright.
Even in strict mode the orchestrator
keeps `bash`, so nothing hard-forces delegation; strict only makes `edit` and
`write` unavailable. Mid-turn toggles apply from the next prompt. The
alignment checklist is agent-driven: the viewer cannot tick questions, and a
block with renamed headings is not captured.

## Verification

```sh
cd extensions/mode
node --test index.test.ts     # pure state/prompt/minor/palette logic, the legacy alias
node --test delegate.test.ts  # the routing file: defaults, parsing, persistence, per-turn re-read
node --test routing.test.ts   # primary → fallback → ask, discovery failure, policy
node --test align.test.ts     # alignment-doc parser, status, restore, scroll math
node tests/smoke.mjs          # real index.ts against a fake pi host, no model requests
```
