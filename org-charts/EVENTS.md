# Org charts: event vocabulary

The events the two charts take, their payloads, and who sends them. Owned by `charts`
(`org-charts/src/sova/org_charts/charts/`); the malli schemas in `events.cljc` are the source,
this file is their reading copy. CHARTS.md maps each one to the source rule it stands for.

Conventions at the JS boundary (engine converts; see CHARTS.md "Contract with engine"):

- An event name is a string `"ns/name"`; inside the chart it is the keyword `:ns/name`.
- Payload keys are camelCase JSON on the TS side, kebab keywords in the chart (`rosterActive` ↔
  `:roster-active`). **Values stay strings** (`"L2"`, `"operator"`, `"needs-you"`), numbers and
  booleans as they are.
- Every delivered event carries `at` (epoch ms): the engine stamps the call's `now` (the host's
  clock, or the virtual clock in a replay), overwriting any `at` the caller sent; delayed sends get
  it when they fire. The engine also keeps `now` in the root data.

## The envelope (every LLM or operator act)

What `act()`/`autonomyRefusal` read today, stamped by the host on the act's event:

| key | type | today |
|---|---|---|
| `by` | `"overseer"` \| `"operator"` \| `"system"` | who acts: the overseer's tool call, the operator's click on the page, or the host |
| `attended` | boolean | `host.attended()`: the run is the operator's (their message) |
| `autonomy` | `"L0"`–`"L3"` | `settings.autonomy` (the setting, not the level in force) |
| `paused` | boolean | `overseerPausedSince(...) !== null` (attach on this host) |
| `rosterActive` | boolean | the roster has an active person |
| `allowance` | `{gather,promote,create,prompt: {used, max}}` | the ledger this turn draws on (`message` if attended, else `day`); `max: null` = Unlimited |
| `atOnce` | `{gatheringsOpen, gatheringsCap, codingRunning, codingCap}` | `openGatherings()`, `caps.gatheringsOpen`, running coding sessions, `caps.codingRunning` |
| `invalid` | string, optional | the tool's own argument refusal (missing fields, not on the roster, abilities, mode, folder, blank text…): argument validation stays in the tool; the chart refuses with this sentence right after the level check, where the tool checks it |

The operator's own click (`by: "operator"`) is never checked against a level or the caps (those
bind the overseer's tools); `attended` passes every level, never the caps.

The chart computes the level in force itself (`effectiveAutonomy`: paused → L0, no active
person → L0, else `autonomy`), so a refusal names the same reason today's does.

## Work-item chart (one per `§gap/<name>`)

Start data: `{itemId: "§gap/<name>", projectSid: "<project session id>", stallAfterMs?: {phase: ms}}`.

### Acts (the LLM's event tools and the operator's clicks)

| event | payload | who may | tool today | allowed in |
|---|---|---|---|---|
| `gap/status` | `{status: "open"\|"exploring"\|"started"\|"done"\|"dropped"}` | L0 | `sova_idea status` | anywhere live (`dropped` → final; every other status is only recorded: done means answered, and the item goes on to be built) |
| `gather/start` | `{to: string \| string[], publicTitle, question, goal}` | L1, `invalid`, at-once gatherings, allowance `gather` | `sova_start_gathering` / `sova_offer` | `open`, `asking`, `needs-operator` (moves the lane); once deciding or promoted: a follow-up in the `follow-up` region (from `no-follow-up`, or replacing a live one) |
| `gather/close` | `{reason}` | L1, own baton, not settle, nobody wrote | `sova_close_gathering` | `asking`, `needs-operator`, `follow-up-asking`, `follow-up-needs-operator` (not while the item is on hold) |
| `decision/reconcile` | `{}` | L1 | `sova_reconcile` | anywhere in the pipeline |
| `decision/promote` | `{ids: string[], bulk?}` | L2, allowance `promote` ≥ ids, ≥ 1 id drafted and in its author's area (or the operator's explicit promote) | `sova_promote`, the page's Promote (`bulk`: Select all ready) | anywhere in the pipeline (a drafted decision is promotable while a follow-up gathering runs) |
| `build/start` | `{prompt, title?}` | L3, at-once coding, allowance `create` | `sova_create_session`, the page's Start coding session | `awaiting-build`, `merged` |
| `build/prompt` | `{text}` | L3, allowance `prompt`, worktree not removed, not open in a terminal | `sova_send` | `idle`, `failed` |
| `build/merge` | `{}` | operator only, session not working | Merge Branch | `building` (any child) |
| `decision/settle-text` | `{action: "keep"\|"restore"}` | operator only | Keep Spec's Words / Promote Theirs Again | `spec-edited` |
| `item/hold` | `{}` | operator only | new | anywhere in the pipeline |
| `item/resume` | `{}` | operator only | new | `on-hold` |

### Host events

| event | payload | when |
|---|---|---|
| `facts/changed` | `{baton?, decisions?, build?}` (below) | on start, after a resume, and after any store change touching the item |
| `effect/failed` | `{kind, key, detail}` | an outbox effect (start-gathering, start-coding) failed |

`facts/changed` payload (each key optional; a missing key leaves that fact as it was, `null` clears it):

```
baton:     {id, state: "open"|"needs-you"|"done"|"closed", wrote: bool, own: bool, settle: bool}
decisions: [{id, state: "pending"|"drafted"|"conflict"|"promoted"|"superseded",
             authorOwnsArea: bool, editedInSpec: bool, build: "built"|"not-built"|null}]
build:     {sessionId, title, running: bool, lastFailed: bool, merged: bool, newSinceMerge: n,
            state: "open"|"merged"|"removed"|"missing"|"root", startedBy: "overseer"|"operator",
            live: bool, workers: n, decisionIds?: [id]}
```

- `decisions` must include the winners of the item's superseded decisions (follow `supersededBy`,
  transitively: a settle session's decision or the operator's resolution), or an item whose
  decisions were all superseded has no live decision and parks where it is.
- `build.decisionIds` is the decisions → coding edge (what `sova_create_session` would record);
  absent, the build is taken to cover every promoted decision of the item.
- An LLM's `sova_promote ids` spanning items is split per item; an id the item does not have is
  refused there as "unknown decision".

### Internal (never sent by the host)

`item/stalled {phase}` (delayed send armed on phase entry), `item/moved` (raised on phase exit).

### Sent to the project

`reason/noted` with kinds `item/stalled`, `item/answered-nothing`, `item/reopened`, `item/built`.
Reasons today's code already emits are **not** re-sent by items (the host sends those once, below).

## Project chart (one per org project, started when its overseer conversation exists)

Start data: `{projectSid, settings: {autonomy, watch, watchGapMin, soonLookSec, caps: {…, unattendedPerDay}}, paused, archived, rosterActive, streaming, queued, tickOrigin?, tickMs?}`.
`tickOrigin` is the epoch ms the host's 20 s watch ticker is phased from (the server's start);
a look due on its own starts on the first tick at or after its due time, as today (`tickMs` 0:
at the due time exactly).

| event | payload | today |
|---|---|---|
| `reason/noted` | `{kind, params?, text?, key?, by?}` | one per `noteReason` call site (kinds below) |
| `overseer/busy`, `overseer/idle` | `{}` | the overseer's session starts streaming (`streaming` = true) / settles with an empty queue (`streaming` = false, `queued` = 0) |
| `overseer/act` | envelope + `{tool, op?, n?}` | an item-less tool call (`sova_note`, `sova_idea add`, `sova_owner_update`, `sova_roster op`, a `sova_reconcile`/`sova_promote` not linked to an item…): judged by TOOL_NEEDS, `invalid`, then at-once and the allowance its kind counts (`n` ids for `sova_promote`). Taken (and logged) only when it may run; refused, it is not taken and `explain` gives the sentence |
| `operator/run-now` | `{}` | `POST …/overseer/run` (`lookNow(force)`) |
| `look/finished` | `{}` | `recordRunEnd` outcome finished |
| `look/stopped` | `{detail}` | outcome stopped (stream trip, model error, "Stopped.") |
| `look/not-started` | `{detail}` | `acquireChat`/`acceptPrompt` threw: lastRun skipped |
| `sova/resumed` | `{}` | server start after load (`sweepCutOffRuns`: a started run is cut off) |
| `org/attached-here` | `{}` | attach on this host (`pausedOverseers`) |
| `operator/level-set` | `{autonomy}` | `PATCH …/overseer {autonomy}` (`resumeOverseer`) |
| `project/archived`, `project/unarchived` | `{}` | archive flag |
| `settings/changed` | `{watch?, watchGapMin?, soonLookSec?, caps?}` | `PATCH …/overseer` (a raised limit releases its held items) |
| `limit/refused` | `{ledger: "day"\|"message", kind, used, max}` | an allowance refusal (`host.hold(overRefusal(...).held)`) |
| `facts/changed` | `{rosterActive?, streaming?, queued?}` | roster change; `session.isStreaming` (drops own reasons); `queue.size` (with streaming: `lookNow`'s idle) |

Internal: `watch/due` (armed in `waiting`), `day/rollover` (local midnight, always armed).

### Reason kinds (`reason/noted`)

`params` fill today's sentence; the chart renders the same text (`reasons.cljc`), so a host may
send `kind` + `params` only. `soon`/`own` come from the kind, as today.

| kind | params | today's text | soon | own |
|---|---|---|---|---|
| `baton/done` | `title, sessionId` | `The gathering session "{title}" reached its goal.` | ✓ | |
| `baton/closed` | `title, sessionId` | `The gathering session "{title}" was closed.` | | |
| `baton/proposal` | `title, sessionId` | `Someone was referred in "{title}" (a proposed roster person).` | | |
| `baton/asked-operator` | `title, sessionId, question` | `The gathering session "{title}" handed a question to the operator (their words, as data): "{question}"` | ✓ | |
| `reconcile/conflict` | `n, ids` | `{n} new conflict(s) between decisions.` | | ✓ |
| `reconcile/resolved` | `n, ids` | `{n} conflict was / conflicts were resolved.` | | ✓ |
| `reconcile/promoted` | `n, ids, by` | by ≠ overseer ∧ n > 0: `The operator promoted {n} decision(s) into the spec.` (soon, not own); else `{n} decision was / decisions were promoted into the spec.` (own) | by | by |
| `reconcile/drafted` | `n, ids` | `{n} decision is / decisions are drafted and promotable.` | | ✓ |
| `coding/settled` | `title, sessionId, failed` | `The coding session "{title}" finished its turn.` / `…stopped with an error.` | ✓ | |
| `build/merged` | `title, branch, target, sessionId` | `The operator merged "{title}" ({branch}) into {target}.` | ✓ | |
| `build/merge-refused` | `title, reason, sessionId` | `Merge Branch for "{title}" was refused: {reason}` | ✓ | |
| `held/released` | internal | looks / day allowance back / message allowance / raised limit (limits claim) | per kind | |
| `item/stalled` | `item, phase, since` | new | ✓ | |
| `item/answered-nothing` | `item, sessionId` | new | | |
| `item/reopened` | `item` | new | | |
| `item/built` | `item` | new | | |

`own` reasons are dropped while the overseer's session streams, as `noteReason(…, own=true)` does
today when `by` is absent; when `by` is present the chart drops only `by = "overseer"` (R3: see
CHARTS.md).

## What the host reads back

- Work item: the lane phase (`configuration`), `droppedFrom` (the phase a dropped gap was in),
  `ideaStatus` (the last idea status recorded), `attempts` (gatherings that ended with no decision), `phaseSince`, the outbox effects:
  `start-gathering`, `close-gathering`, `reconcile`, `promote {ids, by}`, `settle-text`,
  `start-coding {gap, prompt, decisions}`, `prompt`, `merge`, `idea-status {status}`, each with a
  unique `key` (`<item>/<kind>/<n>`).
- Project: `reasons` (`{kind, text, key, at, soon}`), `soonAt`, `lastRun`, `lastRunAt`,
  `looksToday`, `held`, `log`.
