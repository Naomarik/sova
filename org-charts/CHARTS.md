# Org charts: the charts, and every source rule they stand for

Two charts in the fulcrologic/statecharts CLJC DSL (`com.fulcrologic/statecharts 1.4.0-RC18`),
under `src/sova/org_charts/charts/`, compiled into the vendored ESM by the engine. They **observe**
in this spike (authority = shadow): they take the same events today's code reacts to, and their
acts only append effect intents to an outbox the host may ignore. Nothing here is wired into the
live overseer.

| file | what |
|---|---|
| `project.cljc` | the project chart (one session per org project with an overseer conversation) |
| `work_item.cljc` | the work-item chart (one session per `§gap/<name>`) |
| `guards.cljc` | L0–L3 and the caps as guards: TOOL_NEEDS, autonomyRefusal, effectiveAutonomy, overRefusal, the at-once refusals, and `explain` (the engine's trial) |
| `reasons.cljc` | one reason kind per `noteReason` call site, rendering today's sentence, `soon`, `own` |
| `facts.cljc` | what an item reads from the stores: the decision phase, landed, all built, coverage |
| `common.cljc` | envelope, time (local midnight, day key, clock time as Sova formats them), outbox, stall clocks |
| `events.cljc` | malli schemas of every event of both charts (test/doc only: the bundle leaves malli out) |
| `../EVENTS.md` | the event vocabulary: names, payloads, envelope, facts contract, reason kinds |

Tests (`test/sova/org_charts/charts/`, CLJC: they run on the JVM and under shadow `:node-test`):
`work_item_matrix_test` (every lane state × every follow-up state it can have × every event under
10 envelopes, each act SENT and its result held against `explain`: a refusal sentence for every act
the chart does not take, none for every act it takes; every state × 16 fact changes, and again from
each live follow-up state), `work_item_rules_test`, `project_test`.
The harness (`harness.cljc`) runs the real v20150901 processor with a virtual-clock queue and turns
any error the engine logs into a thrown one (an expression that throws is otherwise silent). Under
Node the processor carries the engine's step limit (`engine/bounded.cljs`), so an eventless cycle
fails its test instead of hanging the suite; the JVM run has no such bound.

Run: `node scripts/build-org-charts.mjs --test` (worktree root), or on the JVM:
`cd org-charts && clojure -M -e "(require 'clojure.test 'sova.org-charts.charts.work-item-matrix-test 'sova.org-charts.charts.work-item-rules-test 'sova.org-charts.charts.project-test) (clojure.test/run-all-tests #\"sova.org-charts.charts.*\")"`.

---

## 1. The charts

### 1.1 Project chart (`project.cljc`, `version` 1)

```
project ‹parallel›
├─ attach   ‹live | paused›          fact :paused (attach on this host; any level-set clears it)
├─ archive  ‹active | archived›      fact :archived
├─ switch   ‹watch-on | watch-off›   fact settings.watch
├─ watch    ‹quiet → waiting → due → running | held›
│     quiet    ─reason/noted→ waiting
│     waiting  arms watch/due at the first tick ≥ min(soonAt, lastRunAt + gap, retryAt)
│              ─reason/noted | settings/changed→ waiting (re-armed)   ─watch/due→ due
│     due      eventless: live ∧ active ∧ watch-on ∧ idle ∧ looks left → running
│              eventless: live ∧ active ∧ watch-on ∧ idle ∧ looks used → held
│     held     records skipped + held "looks"; ─reason/noted ∧ looks left→ due
│     running  invoke :sova/look; ─look/finished→ quiet | waiting; ─look/stopped | sova/resumed | look/not-started→ waiting (reasons re-queued)
│     (on watch) reason/noted adds; operator/run-now → running, or a skipped run with why
└─ clock    ‹day›  day/rollover at local midnight: looks per day reset, held items due released
(on project) overseer/busy|idle, facts/changed, operator/level-set, project/(un)archived,
             org/attached-here, settings/changed, limit/refused, overseer/act
```

Pause and archive are **separate regions** because they are separate facts in the source
(`pausedOverseers` in the host index, `project.archived`): the design doc's single
`live | paused | archived` region would lose a pause across an archive and unarchive.

### 1.2 Work-item chart (`work_item.cljc`, `version` 3)

```
item
├─ live ‹parallel›      facts/changed (targetless); gap/status dropped → dropped, any other status only recorded
│  ├─ lane
│  │  ├─ pipeline  (deep history pipeline-h; item/hold → on-hold; decision/reconcile, decision/promote)
│  │  │  ├─ open                     facts: baton open → asking, needs-you → needs-operator, decisions → deciding
│  │  │  ├─ gathering ‹gather-starting | asking | needs-operator›
│  │  │  │     baton ended ∧ decisions → deciding;  ended ∧ none → open (+1 attempt, "answered nothing")
│  │  │  ├─ deciding ‹unreconciled | conflicted | drafted | spec-edited›   routed by the decision phase
│  │  │  │     phase promoted → promoted
│  │  │  └─ promoted ‹awaiting-build | building ‹build-starting | working | idle | failed› | merged | done›
│  │  │        phase pending|conflict|drafted|edited → deciding ("reopened")
│  │  ├─ on-hold      item/resume → pipeline-h (where it was, re-derived from facts)
│  ├─ follow-up ‹no-follow-up | follow-up-starting | follow-up-asking | follow-up-needs-operator›
│  │     gather/start once the lane is deciding or promoted; the baton's state moves it; its
│  │     decisions reach the lane only through the facts (reopen, promote); gather/close on its
│  │     session (not while the item is on hold); its effects are the lane's (no follow-up flag)
│  └─ attention ‹calm | stalled›   item/stalled (a stall clock per waiting phase) → stalled; item/moved → calm
└─ dropped ‹final, nested: the session keeps running so it can be shown›
```

16 atomic lane states + dropped; 13 of them carry a stall clock (every waiting phase; not
working, done or on hold), and so do the two live follow-up states. The item ends only at `done`
(built) or `dropped`.

The item's position is **derived from facts**: every forward move is an eventless transition on
the item's linked baton, decisions and build. An act (the LLM's event tool, the operator's click)
appends an effect intent and, for gather/start and build/start, moves to a `…-starting` state
that ignores the previous baton's or build's facts until the new one shows (`baton-before`,
`build-before`). So a restart, a hold or a missed event re-derives where the item is (R9).

---

## 2. Source rule → chart element

References are to the source at `7e5f184d`. "host" means the part the shadow host does (stamping
the envelope, projecting facts, sending the event); "tool" means it stays in the tool's code and
reaches the chart as the envelope's `invalid` sentence.

### 2.1 Autonomy (shared/project-overseer.ts, server/project-overseer-store.ts, server/project-overseer-tools.ts)

| source rule | chart element | test |
|---|---|---|
| `Autonomy` L0–L3, `levelAtLeast` (indexOf) | `guards/level-at-least?` (an unknown level ranks −1: refused, as TS) | rules: the-level-in-force |
| `effectiveAutonomy`: paused → L0 + PAUSED_REASON; no active roster → L0 + EMPTY_ROSTER_REASON; paused wins | `guards/effective-autonomy`, from the envelope's `autonomy`, `paused`, `roster-active`; project chart: `effective` for the look's `autonomy` | rules: the-level-in-force; matrix envelopes `:l3-paused`, `:l3-no-roster` |
| `TOOL_NEEDS` table | `guards/tool-needs` (verbatim) → per act `level-check` in `work-item/checks`; item-less tools via `overseer/act` | matrix `level-of`, project: item-less-tool-calls |
| `sova_roster` approve/decline needs L2 (per op) | `guards/tool-refusal` with `op` | project: item-less-tool-calls |
| `autonomyRefusal`: attended or "read" → allowed | `autonomy-refusal` (attended passes every level, never the caps); read tools never refused | matrix `:attended`, `:attended-capped`; rules: attended-passes-every-level-never-the-caps |
| `autonomyRefusal`: "operator" need (sova_todos / sova_todo sentences) | `guards/autonomy-refusal` verbatim | project: item-less-tool-calls |
| `autonomyRefusal`: the L-level sentence ("This run was not started by the operator, and your autonomy here is …; X needs Ln. Do not retry it. …") | verbatim, with the in-force reason in parentheses | matrix: l0-refusals-are-todays-sentences |
| a level change applies from the next tool call | guards read the envelope of each act | — |
| an operator's own click (page routes) is not under `act()` | `operator-act?` skips the level and the caps | matrix `:operator` with spent caps |
| attach pauses (`attachOrg` → `pausedOverseers`) | `org/attached-here` → fact → `attach` region `paused` | project: the-gates-hold-a-due-look |
| PATCH with `autonomy` (any, same too) resumes (`resumeOverseer`) | `operator/level-set` clears `:paused` | same |

### 2.2 Limits (PoLimits, overRefusal, gather(), sova_create_session)

| source rule | chart element | test |
|---|---|---|
| attended turns draw on the per-message ledger, others on the per-day ledger | the host stamps `allowance` for the ledger the turn draws on; `over-allowance` names the ledger from `attended` | rules: caps-refuse-with-todays-sentences |
| `take(kind, n)`: used + n > max refuses; max null = Unlimited | `over-allowance` (n = ids for promote) | same; matrix `:l3-capped` |
| `overRefusal` said + tail (day / message) | `over-refusal` verbatim; the model's text is `said + " " + tail` | same |
| at-once `gatheringsOpen` (its own batons not done/closed) and `codingRunning`, in every turn, checked before the allowance | `at-once-refusal`, first in `cap-refusal` | same; matrix `:attended-capped` |
| promote: the whole request against what is left before promoting; only what was promoted counts (`giveBack`) | the guard checks n ≤ left before; what is counted after is PoLimits' (tool) | rules: promote-verdicts |
| a refusal holds an item (`host.hold`): day → retry next midnight; message → retry now; one per key, first `since` kept, ≤ 10 | `limit/refused` → `hold-item` / `refused-item` | project: held-allowances |
| `releaseHeld` (tick): looks / day:k / message:k sentences, soon except message | `release-due-ops` + `released-reason` at `day/rollover`, at `limit/refused` (message: due at once) | project: held-allowances, the-daily-looks-hold-until-midnight |
| tick skips paused and archived projects, so held items wait | release only while `open?`; leaving a pause or archive releases what came due | project: held-items-wait-out-a-pause |
| `releaseRaised`: a PATCH raising a limit (or Unlimited) releases its held keys, "You raised the limit on {what}." soon | `settings-ops` + `raised-keys` (per-day, per-turn, looks) | project: held-allowances |
| `capProblem`, `gapProblem`, `soonProblem` (PATCH validation) | not in the chart: the PATCH refuses before any event | — |

### 2.3 The watch loop (server/project-overseer.ts)

| source rule | chart element | test |
|---|---|---|
| `noteReason` is a no-op before the overseer's conversation exists | the project session starts with the conversation | — |
| `noteReason(own)`: dropped while `session.isStreaming` | `dropped-own?` on `:streaming` (kept when the reason names a non-overseer `by`: D2) | project: own-acts-are-dropped-while-busy, streaming-and-queued-are-two-facts |
| `withReason`: dedupe by exact text; the first soon reason since the last look sets `soonAt = now + soonLookSec` (null = Off: none) | `with-reason` (key = `:key` or the text), `soon-at` | project: reasons-are-deduped-by-text, a-soon-reason-looks-after-the-soon-delay, soon-off-waits-for-the-gap |
| memo pending trimmed to the last 50; the look lists the last 20 | `pending-max` 50; `watch-text` `take-last 20` | project: watch-text-is-todays |
| every `noteReason` call site (baton done/closed/proposal/asked-operator, reconciler conflict/resolved/promoted/drafted, coding settled, merge ok/refused, held releases, raised limits) | one `reason/noted` kind each (`reasons.cljc`, EVENTS.md table); the host decides *whether* (e.g. asked-operator only for its own baton's model hand-off, coding only for rows kind "coding", merge refusals not starting "The project root", reconcile events only with ids) | project: reason-sentences-are-todays, soon-and-own-follow-todays-arguments |
| `watchDecision`: exists, idle (`!streaming && queue.size === 0`), watch on, pending, soon or gap, looks per day | `due` eventless `may-look`: `In :live`, `In :active`, `In :watch-on`, `idle?` (streaming, queued), `looks-left?`; `waiting` only with reasons; the gap/soon in `due-at` | project: a-reason-starts-a-look-after-the-gap, the-gates-hold-a-due-look |
| the 20 s ticker: a look starts on a tick | `on-tick` rounds the due time up to the first tick (`tickOrigin`, `tickMs`) | project: looks-start-on-the-watch-tick |
| tick skips paused, archived | `due` waits on `In :live`, `In :active` | project: the-gates-hold-a-due-look |
| `lookNow`: archived → not started ("the project is archived") | Run Now: `run-now-refusal` first case | project: run-now |
| `lookNow`: daily limit with pending (or forced) → lastRun skipped + held "looks" until midnight ("Today's N looks on its own are used.") | `due` → `held` (on entry: `skip-ops`); Run Now refused daily: `skip-ops` holds too | project: the-daily-looks-hold-until-midnight, run-now |
| other refusals (busy, too soon, watch off, nothing new) are not recorded | `due`/`waiting` wait silently | — |
| Run Now (`force`): skips watch, pending and gap; not archived, busy, daily; runs while paused (at L0) | `operator/run-now` on `watch`: guard `run-now-refusal`, else a skipped run with why | project: run-now |
| look starts: pending cleared, soonAt cleared, lastRunAt = start, perDay++, lastRun started | `running` on-entry `start-run-ops` | project: a-reason-starts-a-look-after-the-gap |
| `watchText(reasons, effective autonomy)` | `watch-text` verbatim; passed as the invocation's `text` | project: watch-text-is-todays |
| `acceptPrompt` queued behind a start/compaction: ends at the next settle | host: `look/finished` when it settles | — |
| `acquireChat`/`acceptPrompt` throw → lastRun skipped with the error, nothing counted | `look/not-started` → `not-started-ops` (counters restored, retried at the next tick) | project: a-look-that-never-started-is-skipped-and-retried |
| `runEnd`: finished / stopped (stream trip, "Stopped.", model error, error message, "The run ended without an answer.") / cut-off (shutdown) | `look/finished`, `look/stopped {detail}` (the host words the detail), `sova/resumed` → cut-off, "The server restarted during the run." | project: a-stopped-or-cut-off-run-keeps-its-reasons |
| `recordRunEnd` only if lastRun is still that started run | end events are handled only in `running` | — |
| `sweepCutOffRuns` at start | engine sends `sova/resumed` after load | same |
| looks per day keyed by the local day | `looks-today`, reset by `day/rollover` at local midnight (`next-midnight` as `nextMidnight`) | project: the-daily-looks-hold-until-midnight |
| operator's Watch switch | `switch` region from `settings.watch` | project: the-gates-hold-a-due-look |

### 2.4 Gathering / baton (shared/baton.ts, server/baton.ts, server/baton-guards.ts, server/baton-events.ts)

The baton stays its own machine (decision al_1: batons exist without gaps; the item reads its
state as a fact).

| source rule | chart element |
|---|---|
| baton states open / needs-you / done / closed | item fact `:baton :state`; `open` → asking, `needs-you` → needs-operator, done/closed → deciding or open |
| `createBaton` to the operator starts in needs-you | `gather-starting` → `needs-operator` on a new baton in needs-you (the design doc lacked it) |
| a gathering linked by any path (Send to person… / the tool) | `open` moves on a live linked baton |
| decisions recorded while the baton is open are not a reason; its end is | the item stays in gathering until the baton ends |
| done with no decision (and goal_done's event before its decision entry) | → `open`, +1 `attempts`, `item/answered-nothing`; a late decision moves `open` → deciding (verifier #9) |
| closed with decisions (operator Close after answers) | → deciding (decisions come from the transcript whatever the baton's state) |
| `sova_close_gathering`: reason required; own (`overseerOf`) only; never a settle session; not done/closed; nobody wrote | `gather/close` `close-check`, same sentences in the same order; the operator's Close: anything not closed |
| baton events done / closed / proposal / asked-operator → reasons; decision / handoff / offer / wrapup are not | host → `reason/noted` kinds `baton/*` |
| `handoffChosen` (hand_to: the holder chose the person) | baton machine: not charted |
| `aboutSomeoneElse`, `detectLanguage` (wrap-up profile guards) | wrap-up: not charted |
| `moveRefusal`, `offerRefusal`, `budgetSpent`, `BudgetSpent`, lease lapse, `noteMessage` refusals, `extendBudget`, `setAbilities`, links | baton machine: not charted |
| gather(): missing fields, offer < 2, "operator" in an offer, not on the roster / not active, abilities | tool → `invalid` |

### 2.5 Decisions (shared/decisions.ts, server/reconcile.ts)

| source rule | chart element | test |
|---|---|---|
| DecisionState pending / drafted / conflict / promoted / superseded; `settleStates` precedence | host projects rows; `facts/dphase` aggregates live rows: conflict > pending > drafted > edited > promoted, none | matrix facts columns |
| promoted but spec not up to date ⇒ drafted (settleStates) | phase drafted from a promoted item → reopen → deciding | matrix `:done` × drafted |
| `editedInSpec` on a promoted row; Keep Spec's Words / Promote Theirs Again | phase `edited` → `spec-edited`; `decision/settle-text` (operator only) | matrix |
| `build` built / not-built (spec record `code` + evidence) | `all-built?` → merged → done | matrix facts `merged-built` |
| `promoteDecisions`: unknown decision; "it is X; only a reconciled (drafted) decision can be promoted"; out of area unless operator-explicit ("outside N's decision area: promote it explicitly by id"); the overseer is always `by: overseer`, attended too | `promote-verdicts`, `promote-check` ("Promoted 0, refused N: id (reason); …."), effect `promote {ids, by}` with only the promotable ids | rules: promote-verdicts |
| `sova_reconcile` (L1), Reconcile off → 409 relayed | `decision/reconcile` anywhere in the pipeline; a 409 → `invalid` | matrix |
| conflicts routed to a settle session (a baton) and resolved there or by the operator | item waits in `conflicted`; the winner reaches the item's decisions through `supersededBy` (host) | — |
| `watchResolutions`: settle-session decision → reconcile after a 2 s in-memory debounce | not charted (the reconciler's own; R8 stays) | — |

### 2.6 Ideas (server/overseer-ideas.ts)

| source rule | chart element |
|---|---|
| statuses open / exploring / started / done / dropped | `gap/status` (L0, `sova_idea status` / the page) |
| dropped is final ("This idea was dropped; dropped is final. File a new idea instead.") | nested final `:dropped`; `explain` → that sentence |
| done means answered: a gap is "a decision the project needs that nobody has made" (`§app.project-overseer/gaps`), and builds rest on promoted decisions, not on the gap; done can be reopened | recorded only (`:idea-status`, effect `idea-status`); the item keeps its lane (version 2: the `closed` state is gone) |
| `autoStatus`: a linked session sets started, an explorer exploring | recorded (`:idea-status`); not the item's position (R4: status conflated gathering with building) |
| `sova_idea` errors (unknown id, renamed, too long, 100 ideas…) | tool → `invalid` |
| the operator's own ideas and to-dos are not work items (`§app.project-overseer/ideas-and-todos`) | items only for `§gap/…` ids |

### 2.7 Coding sessions and branches (CodingWorktree, mergeCodingWorktree, noteCodingSettled)

| source rule | chart element |
|---|---|
| running / idle / last turn failed | `working` / `idle` / `failed` from `running`, `last-failed` |
| merged (by Merge Branch or by hand), newSinceMerge (then merged is false), root | `landed?` = merged, or root and not running → `merged`; not landed → back to idle/failed |
| `sova_create_session` L3, mode / folder / blank prompt, at-once coding, allowance create | `build/start` checks: level, `invalid`, blank prompt, `cap-check "create"` |
| `sova_send` L3: mode; a gathering session; unknown; open in a terminal; worktree removed; blank text; allowance prompt | `build/prompt`: level, `invalid`, `prompt-check` (live, removed, blank), `cap-check "prompt"` |
| Merge Branch: runs in the root; on another host; the session is working; its workers are running | `build/merge` operator only, `merge-check` (+ `invalid` for "On another host") |
| coding settled → reason only for its own (`kind: "coding"`) sessions | host → `reason/noted coding/settled` |

### 2.8 The prompt (server/project-overseer-prompt.md)

| rule | chart element |
|---|---|
| steps 1–3: watch decisions, infer gaps, act within autonomy (gather, reconcile, promote, build on promoted decisions) | the item pipeline: `open → gathering → deciding → promoted → building → merged → done` |
| "Do not retry a refused tool; file a gap or raise a sova_confirm" | `explain` returns the same sentence for the same state and envelope |
| never promise a look "next time" | not chart |

---

## 3. What the charts change, or add (divergences on purpose)

Numbered so the replay and the verifier can cite them.

- **D1 (R2).** A stopped, cut-off or never-started look re-queues its reasons in front of the ones
  noted since. Today the pending list is cleared when the look starts, and those reasons are lost.
- **D2 (R3).** An own-act reason (reconciler conflict/resolved/drafted, the overseer's promotion)
  is dropped while the session streams only when it does not name a non-overseer `by`. Without `by`
  the rule is today's (dropped while streaming, whoever acted).
- **D3 (R5).** A reason may carry a typed `key`, which then replaces the exact-text dedupe. Without
  a key it dedupes by text, as today.
- **D4 (R4, R6).** Stall clocks. Every waiting phase arms a durable `item/stalled` (3 days by
  default, `stallAfterMs` per phase), which reaches the project as a reason `item/stalled`. This is
  new: today nothing notices a gap never gathered, a drafted decision waiting at L1, or a promoted
  decision never built.
- **D5.** New item reasons: `item/answered-nothing`, `item/reopened`, `item/built`. The items never
  re-send reasons today's code already notes (no double reasons).
- **D6.** `item/hold` and `item/resume`, operator only, with deep history. New.
- **D7 (withdrawn: it was a chart bug).** Version 1 closed the item when its idea was marked
  done, and then refused the promote and build that follow. Today's meaning is the right one: a
  gap marked done has been answered, and its decisions still get promoted and built (real-26).
  The status is now only recorded. `droppedFrom` records the phase a dropped gap was in.
- **D8 (R4).** Build coverage. With `build.decisionIds` (the decisions → coding edge), a decision
  promoted after the build ran sends the item to `awaiting-build`, not `merged`.
- **D9.** A held message allowance is released at the refusal. Today it is released at the next
  tick (≤ 20 s). The reason is the same, and so is its look (tick-aligned).
- **D10.** The day's looks reset and held day items are released at local midnight, by a durable
  delayed send. Today this happens at the first tick after midnight (≤ 20 s later). A look still
  starts on a tick.
- **D11.** gather/start from open or gathering moves the lane (the first gathering, or one
  replacing a live one). Once the gap is deciding or promoted it is a follow-up, tracked in its own
  region beside the lane, one at a time, and replaceable while live. Today `sova_start_gathering` has
  no gap and nothing tracks a follow-up.
- **Fixed (was a chart bug): a follow-up gathering beside a build.** In version 2 a follow-up moved
  the single lane into gathering. The lane then showed `needs-operator` while the branch merged
  (real-26 @2067817, 2094370), and under Guard it would have refused Merge Branch and prompts. In
  version 3 a follow-up runs in the `follow-up` region, and the lane keeps following decisions and
  the build.
- **D12.** build/start is taken only once the item's decisions are promoted (awaiting-build) or
  after a merge. Today `sova_create_session` has no gap and may build on nothing promoted. This is
  the R4 edge made explicit.
- **D13.** Pause and archive are separate regions (a fix of the design doc, not of Sova).
- **D14.** Stale facts are ignored after an act (`baton-before`, `build-before`), so an old closed
  baton does not bounce a new gathering back to open.
- **Fixed (was a chart bug): promote during a follow-up gathering.** Version 2 as first committed
  took `decision/promote` only in `deciding`. A drafted decision could then not be promoted while
  the gap's follow-up gathering was in flight (real-26 @2065652, refused in `needs-operator`), but
  today it can. Reconcile and promote now sit on `pipeline`, and promote's own check (≥ 1 asked id
  is a drafted decision of this item) decides. The lane still follows the gathering until it ends.

## 4. What the charts do not express, and why

- **Argument validation** (fields, roster, abilities, mode, folder, owner-update rules, sova_idea
  errors, the reconciler's 409): this stays in the tools. The chart receives the tool's sentence as
  `invalid` and refuses with it where the tool checks it (after the level, before the caps), so the
  answers agree. Duplicating these checks in CLJS would fork them.
- **What an allowance counts after the act** (`giveBack` of refused promote ids): PoLimits owns the
  counters, and the host stamps what is left on each act.
- **The baton, decision and reconciler machines' internals** (hand-off guards, leases, budgets,
  wrap-up guards, conflict routing, settleStates, the 2 s debounce): by decision al_1 they stay
  their own machines, and the item reads their states as facts.
- **The LLM's judgement** (which gap, whom to ask, what to build): this is the prompt's job. The
  chart only bounds the moves.
- **Several hosts on one project (R7)** are not solved by a chart. That needs a single writer
  (holder + generation), which is the engine and storage decision.
- **R1** (the lost update in lookNow) disappears only with the engine's single queue per project.
  The chart has no memo to race on.
- **Gap links** (gap → baton, decision → gap, coding → decisions) are not in the stores today.
  The shadow host (the scenarios miner) infers them. Without them an item stays in `open`.

## 4b. The store shapes the pipeline needs (operator ruling: no real org exists, so no compatibility)

The charts read facts the stores do not record today. The shadow host infers them. The clean shape is:

- **gap → gathering.** Put `gap` on `sova_start_gathering`/`sova_offer` and on the baton row
  (`baton.json`). The item's `baton` fact is then the latest row with its gap.
- **decision → gap.** A decision inherits its baton's `gap`. A settle session's decision or the
  operator's resolution inherits the gap of the decisions it supersedes, so an item never loses its
  decisions to a conflict (today the host must follow `supersededBy`).
- **decisions → coding.** Put `decisions: [ids]` on `sova_create_session` and Start coding session,
  recorded on the `started.json` row. `build.decisionIds` is then always present. The "absent =
  covers all" reading in `facts/covers?` exists only for the inferred corpus, and should be dropped
  once the edge is recorded.
- **idea status.** It should not carry pipeline meaning: `started` on a session link conflates
  gathering with building (R4). The item's lane is the position, and idea status stays the list's
  own open/done/dropped.

## 4c. Mutation checks

The verifier's full mutant set (M01–M38, F1–F6, N01–N12, R1–R2) and mutants of the step limit and
the follow-up region are killed by a failing test, each run against this suite and the replay from a
scratch copy of the tree (never the worktree). Mutants whose code is gone are re-anchored: M08, M09 and
M11 as M08b, M09b, M11b and M11c; M28 (the removed dead guards) as M28b; N08 as N08b (the close's
on-hold guard); N11 (the removed `:follow-up` flag) as N11b and N11c (the follow-up's effect differs
from the lane's). The CLJS suite alone kills the follow-up mutants the replay used to be the only
oracle for (N02, F1), and M34 fails on the step limit instead of hanging.

`~/.cache/org-charts/charts-mutants.py` mutates a scratch copy (never the worktree) and runs this
suite. Every mutant the verifier found surviving (M02, M03, M06, M07, M08, M09, M12, M19, M21,
M22) is now killed, and so is "attended no longer passes the level" (M28: the dead guards `may`,
`may-level?`, `left?`, `at-once?`, `operator?` were removed; the conditions are the checks).
Results: `~/.cache/org-charts/charts-mutants-result.json`.

## 5. SCXML points this code relies on (and the tests pin)

- **Eventless transitions run before raised internal events.** A reason raised at midnight would
  otherwise arrive after the look started. So `held` leaves on the releasing `reason/noted`, not
  eventlessly (project: the-daily-looks-hold-until-midnight).
- **Transition content runs after the exit set.** `In(phase)` is already false inside the content,
  so each lane state notes `:phase` on entry, and `droppedFrom` reads it.
- **Every element id is chart-global.** This includes `Send` ids, which are also send ids. So the
  timers are `:due-timer`, `:rollover-timer` and `:stall-<phase>`.
- **Delayed sends are not cancelled by exit.** Every stall clock cancels its own on exit.
- **A top-level final ends the interpreter** and the configuration becomes empty. So `:dropped` is
  a final nested in `:item`.
- **The deepest matching transition wins per atomic state**, and a targetless one on a parallel
  root is selected once. That is where the facts handlers live, and they conflict with nothing.
- **An expression that throws is only logged** (as `:error.execution`). The harness fails the test
  on any logged error or warning.
- **An eventless cycle loops for minutes.** The library logs only after 1,000 eventless iterations,
  and repeats that up to 1,000 times. The engine bounds each event at 200 microsteps and throws
  `:sova/step-limit` (the replay's longest real event takes 5).

## 6. Contract with the engine

- It registers `project/chart` and `work-item/chart` under `"project"`/`"work-item"`, and snapshots
  carry `version`.
- It uses the flat working-memory data model and the lambda execution model. Charts read the event
  as `(:_event data)`.
- It converts JSON camelCase keys ↔ kebab keywords at the boundary. Values stay strings. Event
  names become keywords.
- It stamps `at` on every delivered event and keeps `now` in the data.
- It drains `:outbox` after each step.
- `guards/explain [chart event data envelope]` answers trial, with `data` carrying
  `:sova/configuration` and `:sova/running?`.
- The `:sova/look` invocation reports back `look/finished`, `look/stopped`, `look/not-started`, and
  `sova/resumed` after a load.
- malli (`events.cljc`) is for tests and docs only. The bundle aliases guardrails' malli away.
