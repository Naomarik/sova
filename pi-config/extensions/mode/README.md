# Mode switcher for Pi

A **per-session** toggle between **normal** mode (pi as usual) and
**claude-heavy** mode, where the main agent becomes an orchestrator and
delegates work to Claude Code background workers through the `subagents` +
`claude-code` extensions:

- **Coding implementation** → `claude-code` workers on `opus[1m]`; the
  orchestrator picks `low` effort for mechanical changes and `medium` where
  precision matters (concurrency, migrations, public interfaces…).
- **Planning** → a `claude-code` worker on `claude-fable-5-1[1m]` at `medium`
  (the user can override effort per task). If the fable model is not offered,
  planning automatically falls back to `opus[1m]` at `high`, and the status
  bar says so.
- The main thread stays the only voice to the user and verifies every worker
  result (reads diffs, runs tests) regardless of worker effort.

Simple questions, command runs, and trivially obvious one-line fixes stay with
the main thread; anything that would normally need a subagent or non-trivial
edit goes to a worker. Both extensions must be loaded; no changes to pi and no
Claude plan mode are involved — workers run with bypassed permissions as usual.

## Install

```sh
~/pi-config/install.sh   # links this directory into ~/.pi/agent/extensions/
# /reload in pi
```

## Usage

| Action | Effect |
| --- | --- |
| `ctrl+p` → **Mode**, or bare `/mode` | Open the mode selector (see below) |
| `alt+m` | Toggle normal ↔ claude-heavy |
| `/mode normal` · `/mode claude-heavy` | Set explicitly |
| `/mode status` | Show this session's mode, the default for new sessions, active planner, strict flag, minor modes, state file |
| `/mode default` | Save this session's mode, strict flag and minor modes as the default for new sessions (the only command here that writes `mode.json`) |
| `/mode strict on\|off` | Also remove `edit`/`write` from the orchestrator while heavy (off by default) |
| `/mode align [on\|off]` | Toggle (or set) the `align` minor mode |
| `/align`, or `alt+a` | Open the read-only alignment-doc viewer (see below) |
| `/align status` · `/align clear` · `/align export [path]` · `/align on\|off` | Summarize, clear, write the doc to a file (default `.pi/align.md`), or toggle align |
| `pi --mode claude-heavy` | Start that launch in a mode (not persisted) |
| `pi --minor align` | Start that launch with these minor modes on, comma-separated; `none` clears them (not persisted) |

### Mode selector

The command palette (`ctrl+p`) has a **Mode** category right after *Models &
thinking*; bare `/mode` opens the palette straight at it. It lists:

- **normal** and **claude-heavy**, radio-style: the current one is marked `✓`,
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

- `• normal` (dim)
- `◆ claude-heavy` (accent)
- `◆ claude-heavy · plan:opus` (warning: fable planner not offered, opus/high in use)
- `◆ claude-heavy · strict`
- `normal · align` (accent: a minor mode is on)
- `claude-heavy · strict · align`

Every switch appends a `── mode → … ──` marker to the transcript; minor-mode
switches append `── align on ──` / `── align off ──`, and strict toggles
`── strict on ──` / `── strict off ──`. Each of those entries also carries the
full post-switch snapshot, which is what makes the state per session (see
**Behaviour**).

## Minor modes

Minor modes are extra instructions toggled independently of the major mode:
zero or more can be active at once, in normal or claude-heavy. Their blocks
are appended after the heavy block (when heavy) in registry order.

- **align** — before building anything non-trivial, the agent investigates
  (via a non-editing planning worker when heavy, itself otherwise), replies
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
1. [ ] Question — with a recommendation
2. [x] Settled question — the decision
### Rejected
- Alternative — why not
### Status
aligning | confirmed | implementing
```

The agent re-emits the whole block whenever something changes (answers,
scope, new findings), ticking settled questions `[x]`. An explicit "go ahead"
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
  such as pi-web) `/align` shows the summary and markdown as a notification.
- **Persistence** — every revision is a session custom entry
  (`customType: "align-doc"`, `{ version: 1, doc }`, `doc: null` after
  `/align clear`), so the doc travels with the transcript, restores on
  `/resume`, `/reload`, `/fork` and `/tree`, and is readable by pi-web. The
  transcript shows a dim `── alignment v2 · questions open · 1/2 settled ──`
  marker per revision. There is no global file; `/align export [path]`
  writes the markdown on demand.
- **Read-only** — the viewer never writes back; the agent's block is the only
  source of truth. `/mode status` includes an `align doc:` line.

The viewer key is `alt+a` by default; set `"viewerShortcut"` in `mode.json`
to change it. If it collides with the mode toggle or the `align` toggle key,
it is not registered and a warning says so at session start.

## Behaviour

While heavy, the extension appends orchestration instructions to the system
prompt on every turn (`before_agent_start`), so toggling takes effect on the
next prompt without `/reload`.

### Two scopes

The **active** state — major mode, `strict`, minor modes — belongs to **one
session**. Switching in one pi window, or in one pi-web chat, changes nothing
anywhere else. It is persisted by snapshotting the whole triple into the same
`mode` custom entry every switch already appended:

```json
{"customType":"mode","data":{"minor":"align","on":true,
  "active":{"version":1,"mode":"claude-heavy","strict":false,"minorModes":["align"]}}}
```

So it travels with the transcript: it restores on `/resume`, `/reload`,
`/fork`, `/tree` and a pi-web reopen, exactly like the alignment doc. The
newest entry with a readable `active` wins; entries written before this
existed, and any future schema this build cannot read, are skipped (they still
render as markers). Restoring writes nothing, so merely opening a session
never appends to it.

`~/.pi/agent/mode.json` holds the shortcuts and the **default a new session
starts from**:

```json
{ "version": 1, "mode": "claude-heavy", "strict": false, "minorModes": ["align"] }
```

A session that has never switched anything follows that default, re-read on
every start — so editing the file (or `/mode default`) moves every untouched
session at once. The first switch in a session pins it, and it stops following.
Launch flags (`--mode`, `--minor`) apply on top of the default at startup only,
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

Planner availability is probed on entering heavy mode and on every session
start while heavy, through the `subagents:backend-discover` contract — the same
model discovery `agent_models` uses (a ~1–3 s `claude` initialize call, cached
60 s, 15 s timeout). No worker starts at load or in normal mode. If the probe
fails, planning uses `opus[1m]` at `high`; at runtime the injected instructions
also tell the orchestrator to retry a failed planning worker once on opus/high.

## Limits

Delegation bias is instruction-level. Even in strict mode the orchestrator
keeps `bash`, so nothing hard-forces delegation; strict only makes `edit` and
`write` unavailable. Mid-turn toggles apply from the next prompt. The
alignment checklist is agent-driven: the viewer cannot tick questions, and a
block with renamed headings is not captured.

## Verification

```sh
cd extensions/mode
node --test index.test.ts   # pure state/prompt/minor/planner logic
node --test align.test.ts   # alignment-doc parser, status, restore, scroll math
node tests/smoke.mjs        # real index.ts against a fake pi host, no model requests
```
