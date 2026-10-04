# Statecharts engine API (refit, P0)

Owner: engine member. Stable contract for the statecharts member (CLJS authoring) and the server member
(TS host under `server/org-host/`). Changes are announced by team message; additions only.

## 1. Registering a statechart (CLJS, statecharts member)

Each statechart namespace exports one registry entry; `sova.statecharts.registry/statecharts` (statecharts
member) is `{"<name>" entry}`, and `api.cljs` ships exactly that map.

```clojure
{:statechart     statechart                 ; (statechart {...} (state {:id :top ...}))  ONE top-level compound state
 :version   3                     ; bump on any state-id / data-shape change
 :migrate   {1 (fn [s] s') 2 ...} ; vN -> vN+1, chained at load (see §6)
 :storage   :portable             ; or :host-local
 :exported  [:holder :decisions]  ; data keys watchers receive in link/moved
 :acts      {:gather/start {:needs "L1" :tool "sova_start_gathering"
                            :people-facing true :code-facing false :counts "gather"
                            :pre [check ...]}  ; run BEFORE "is it enabled here" (level is automatic from :needs/:tool)
             ...}
 :not-here  (fn [event config data] sentence)  ; refusal when no transition for the act exists in this configuration
 :final-refusal "…"                            ; refusal once the session is final / not running
 :redact    {:about :digest :email :contact :token :drop}  ; log privacy (TS applies; defaults: token/hash/secret dropped)
 :cold?     (fn [config data] bool)}         ; may unload after 24 h with nothing pending (host)
```

`sova.statecharts.registry/options` (statecharts member): `{:level-check (fn [tool need envelope] sentence-or-nil)}`
— the engine calls it for every act with `:needs` before any other check (operator clicks: return nil).

## 2. Authoring helpers — `sova.statecharts.engine.dsl`

A **check** is `(fn [data] nil | "sentence" | {:sentence s :tail t :status 409 :code "taken"})`
or `{:name :holder-chose :fn f :payload? true}` (named; `:payload?` checks are skipped by
`enabled-events`, which has no payload). `data` has `:_event {:name :data}`; `(dsl/evt data)` is the
event data (envelope + payload).

- `(dsl/act {:event :gather/start :target :starting :checks [c1 c2] :cond extra-guard} & content)`
  A transition whose cond is `pre-checks(act) ∧ level ∧ checks ∧ cond`, with `:sova/checks` metadata.
  explain order: **level → act :pre → state (not-here) → transition :checks → :cond** (then
  `:sova/refusal` attr of the transition, else "That can't be done now.").
- `(dsl/correction {:event :item/reopen :needs "L1" :target … :checks [...]} & content)` — q9.
  Same as `act`, tagged `:sova/correction true`; a blank `:reason` refuses with
  `dsl/reason-required` = "A correction needs a reason: say why." unless `by` is operator.
  Declare it in `:acts` like any act (needs/tool).
- `(dsl/effect kind (fn [data] {...}))` — executable content: an effect intent. The engine assigns
  `:key` (`<sid>@<generation>.<n>`, unique forever, the idempotency key) and keeps it in the session's
  `:sova/pending` until the host answers `effect/done {key result}` or `effect/failed {key detail}`
  (delivered to the statechart with the original effect under `:effect` and its `:kind`). A second answer
  for the same key is stale and dropped. Pending effects are durable (in the snapshot).
- `(dsl/held kind (fn [data] {...}) {:ms 600000 :hold? (fn [data] bool) :while-in :offered :what (fn [data] "Offer to Ana")})`
  — q10. When `:hold?` is true (default: the act was not the operator's own click, i.e.
  `(:by envelope)` ≠ "operator" and not attended) the effect waits in `:sova/holds {id {:id :kind
  :effect :since :until :what :by}}`; hold length: the helper's `:ms`, else the envelope's
  `:hold-ms` (the host stamps it from the project's hold setting, r6), else data `:sova/hold-ms`,
  else 600000; **0 = no hold** (the effect goes straight out). The engine arms `:sova/hold-due` at `:until`. At that time, if
  the hold is still there (and the session is still `In :while-in`, when given), the effect moves to
  the outbox and the statechart receives `:hold/released {:id :kind :key}`; if `:while-in` no longer
  holds it receives `:hold/lapsed {:id :kind}`. Default ms is data `:sova/hold-ms`, else 600000.
- **Act holds (q10, r4/r6) — the main kind.** An act whose `:acts` meta has `:hold true` (plus
  `:what (fn [data] "…")`, `:counts "gather"`, `:count (fn [data] n)` for promote's ids) is, when
  `engine/hold_policy.cljc` `held?` says so (THE one switch: `overseer-unattended-held?`; `by` statechart
  always; operator clicks and attended turns never; envelope `:hold-ms` 0 = never), checked in full
  (level → pre → state → checks → cond) and then NOT taken: the engine stores
  `:sova/holds {id {:id :act true :event :data :kind :what :since :until :by :overseer-id :project-id :counts :reserve}}`
  and arms `:sova/hold-due`. At `:until` it calls the host's `stamp(sid, event, payload, {by, overseerId, projectId})`
  for a fresh envelope and re-delivers the act with `:sova/released id` through the full path (never
  re-held). Then the session receives `:hold/released {:id}` (taken) or `:hold/dropped {:id :sentence
  :stage :check}` (refused now; the act's own refused step is in the log).
- **Reservations (F2).** For every act with `:counts`, the engine adds the pending act holds of the same
  project (`:project-id`, else `:scope`) and kind to the envelope before any check:
  `allowance[kind].used += n` and the at-once count (`gather` → `:gatherings-open`, `create` →
  `:coding-running`, `hold_policy/at-once-field`). A hold being released no longer counts itself. The
  ledger counts a use only when the act is taken (the statechart's taken transition). **The host's stamp
  must NOT add pending holds itself** (the engine does).
- **Drive (r3).** `(dsl/drive {:event :gather/start :target (fn [d] sid) :data (fn [d] payload)})`:
  after the step the engine calls `stamp(target, event, payload, {by: "statechart", projectId})` and delivers
  the act with `by` statechart, not attended, through the normal path (held by the policy).
- **Cancel.** `:hold/cancel {:id :reason}` (`dsl/hold-cancel-correction`); the reason is required
  unless `by` operator. The session then receives `:hold/cancelled {:id :kind :event}`.
- `(dsl/held kind f opts)` — an *effect-only* hold (the effect waits, no state is held back); at its
  end `:hold/released` or, when `:while-in` is no longer active, `:hold/lapsed`.
- `(dsl/cancel-hold (fn [data] id))` — executable content removing a hold (its timer is cancelled);
  the statechart then receives nothing more for it. Use inside a `correction` on `:hold/cancel {:id :reason}`;
  `(dsl/hold-cancel-correction {:needs "L0"})` is that transition, ready to place on the top state.
- `(dsl/spawn {:statechart "baton" :id (fn [data] sid) :data (fn [data] {...}) :link :item :watch? true})`
  — executable content: after this step (same call, same atomic batch) the engine starts session
  `sid` of `statechart` with `data`, `:sova/links {:item <this sid>}` and `:sova/watchers [<this sid>]`
  (unless `:watch? false`), and this session's `:sova/children` gains `{:sid :statechart :link}`.
  Spawning an id that exists (loaded or cold) throws (the call rolls back) unless `:if-exists :skip`.
- `(dsl/watch (fn [data] target-sid))` / `(dsl/unwatch …)` — add/remove this session as a watcher
  of another session (re-link, q9). Watching sends an immediate `link/moved` with its current state.
- Link notifications: after any step that changes a session's configuration, `running`, or any
  `:exported` key, every watcher receives
  `:link/moved {:from sid :statechart "baton" :states [..configuration..] :running bool :exported {...}}`
  (same call, queued in (time, ordinal) order). Also on spawn (start) and on resume.
- Invocations: `(invoke {:id :reply :type :sova/reply :params (fn [_ d] {...})})`. Types:
  `:sova/look :sova/reply :sova/wrapup :sova/reconcile`. The host reports back with
  `<name>/finished`, `<name>/stopped {detail}`, `<name>/not-started {detail}` carrying the run id
  (`invokeId` option); a result for a run that is no longer active is stale and dropped. Active runs
  are in `:sova/invocations {run-id {:type :invoke-id :since}}`.
- Resume: `:sova/resumed {:cut-off [{:run-id :type :invoke-id}]}` is delivered to every loaded
  session; each state holding an invocation treats it as cut off. Then `link/moved` per link.
- Time: every delivered event has `:at` in its data; the data model's `:now` is the event time.

## 3. Engine calls (CLJS `engine.core`, JS `createEngine`)

All take `now`. Every call is atomic: it throws and changes nothing, or it commits.
Before an external event (`send`) the engine delivers every delayed send due at ≤ now (W5).

| call | does |
|---|---|
| `start(sid, statechart, data)` | new session |
| `send(sid, event, data, {invokeId})` | one event, then drain (cross-session sends, spawns, link/moved) |
| `trial(sid, event, data)` | the same call on a copy, rolled back: `{taken, refusal (sentence string), refusalInfo:{sentence,tail,stage,check,status,code}, transitions, refused, before, configuration, steps, outbox, holds, spawned, sends}` |
| `explain(sid, event, data)` | refusal or null (no step) |
| `enabledEvents(sid, envelope)` | `[{event, enabled, refusal?}]` for every act the statechart declares + events on active transitions |
| `setState(sid, {states, patch, reason}, envelope)` | q9/r5 free set-state: ONLY `by` overseer ∧ attended ∧ via ≠ overseer (operator page and global Overseer refused), reason required; runs exits/entries |
| `resume(sids)` | `sova/resumed` to each, then link/moved per link; past-due timers are NOT fired: call `fireDue(now)` after |
| `fireDue(now)` | deliver everything due |
| `nextDueAt()` | earliest pending delayed event |
| `load(sid, text)` / `unload(sid)` / `dump(sid)` | snapshots (EDN); load migrates older versions |
| `holds()` | every held act of every loaded session |
| `statechartInfo(name)` / `statecharts()` | registry: version, storage, exported, acts with metadata, transitions, corrections, states (visualizer node/edge export) |

Options: `stamp(sid, event, payload, ctx) → envelope` (sync; held-act release and drive),
`loadCold(sid) → text | null` (sync; null = unknown session: a send to it throws
`sova/unknown-session` and the call rolls back; a throw from loadCold — e.g. a broken snapshot —
rolls the call back with that error), `clock`, `maxMicrosteps`, `statecharts` (runtime JS statecharts, tests).

Call result: `{steps, outbox, holds, sends, invocations, spawned, loaded, snapshots, errors}`.
A step: `{sessionId, statechart, at, event, data, by, via, before, after, changed: {path: [from, to]},
effects: [keys], refused?: {sentence, stage, check}, reason?, microsteps}` — the transition-log row
before privacy scrubbing (TS host scrubs with `:redact`). `snapshots` = every session the call
touched: write them together (journal).

## 4. TS host — `server/org-host/`

`OrgHost` per org: one FIFO, journal (`<stateRoot>/statecharts/<org>/journal/`), snapshots
(portable `<workspace>/statecharts/<statechart>/<id>.edn`, host-local `<stateRoot>/statecharts/<org>/<statechart>/<id>.edn`),
log (`<workspace>/statecharts/log/<yyyy-mm>.jsonl`, host-local under stateRoot), effect runner
(`host.effects.register(kind, async (effect) => result)`), invocation runner
(`host.invocations.register(type, {start, stop})`), one timer from `nextDueAt`, read API.

### Host API (server member calls these; `server/org-host/index.ts`)

```ts
const host = await OrgHost.open({ orgId, workspaceDir, stateDir, clock?, log? });  // loads, replays journals, resumes
host.effects.register(kind, async (effect) => result);        // idempotent by effect.key
host.invocations.register(type, { start(inv, report), stop(inv) });  // report("finished"|"stopped"|"not-started", detail?)
await host.act(sid, event, payload, envelope)   // → { taken, refusal: {sentence, tail, stage, check, status, code} | null, result }
await host.start(sid, statechart, data, envelope)    // new session (org/project roots); spawns come from statecharts
await host.setState(sid, {states, patch, reason}, envelope)
host.trial(sid, event, payload, envelope)       // sync read, nothing written
host.explain / host.enabledEvents(sid, envelope) / host.configuration(sid) / host.data(sid)
host.sessions(statechart?) / host.holds() / host.statechartOf(sid) / host.problems()  // workspace problems (broken snapshots)
await host.logAct(row)   // a log row for a non-statechart act (note, idea, to-do, confirm): {session?, event, by, via?, envelope, refused?}
host.onChange(fn)        // after every committed batch: {sessions touched, steps}
await host.close()
```
Envelope: plain JSON, camelCase in TS (`by, via, attended, autonomy, paused, rosterActive,
archived, allowance, atOnce, card, holdMs, invalid, reason`); statecharts read kebab keywords.

## 5. Matrix generator — `sova.statecharts.engine.matrix`

`(matrix/run {:statechart "baton" :starts [data ...] :drive [[event data] ...] :acts [[event payload] ...]
 :envelopes {name envelope} :sentences #{...} :max-configs 5000})` → explores reachable snapshots by
sending `:drive` events (and acts), then for every snapshot × act × envelope sends the act on a copy
and asserts `taken ⇔ explain nil`, and (when `:sentences` given) every refusal ∈ catalogue.
Returns `{:configs n :cells n :failures [...]}`; `(matrix/assert-clean! report)` for cljs.test.

## 6. Migrations

`(fn [{:keys [config data history invocation-data queue]}] {...same keys...})`: `config` a set of state ids,
`data` the data model, `history` {history-id #{state-ids}}, `invocation-data` the start data the library
keeps (left as it was when the result has no such key), `queue` pending
`[{:event {:name :data} :delivery-time :ordinal}]`. `(core/migrate-text registry text)` returns the
current-version EDN; tests load a fixture of every shipped version.

## 7. r7 hours waits, q12 confirm-required holds, r8a feed (engine 0393fc98, host 230005d7)

**Switches** (all in `engine/hold_policy.cljc`, beside `overseer-unattended-held?`):
`operator-acts-wait-for-hours?` (false: r7/q13), `unreviewed-holds-wait?` (true: q12). Each has a
test that fails when flipped (engine/refit_test.cljs).

**Hours waits (r7).** Act meta `:hours (fn [data] next-window-ms | nil)` (data has `:_event`; the statechart
computes it with its pure next-window fn over the person's tz/hours; nil or ≤ now = in hours). When the
act passes every check and the window is in the future: statechart-started and unattended overseer acts
become a hold with `:wait "hours" :until <window>` (listed in `holds()`, same cancel path, same F2
reservation, same log/privacy rules; released at the window through the full re-check like any hold);
attended turns go at once; the operator's click goes at once unless the switch is on, and its step
carries `:off-hours <window>` (TS `offHours`; log rows too). A policy hold and an hours wait chain: the
policy hold's release is then checked for hours.

**Confirm-required holds (q12).** The envelope carries `:confirm-kinds ["gather" "promote" …]` (TS
`confirmKinds`, stamped from overseer.json). An act's confirm kind is its meta `:confirm-kind`, a
string or `(fn [data] kind)` over the act (e.g. "offer" with ≥2 targets, else "gather"); else its event
name. A policy-held act whose kind is listed gets `:confirm true`. At its end, with
`unreviewed-holds-wait?` on, it is NOT released: it stays in `holds()` with `:waiting true` (stall clock
from `:until`) and the session receives `:hold/waiting {:id :event :kind :what}`, until
`:hold/approve {:id :reason}` or `:hold/cancel {:id :reason}`. Non-listed holds release at their end as
before.

**Approve early.** `(dsl/hold-approve-correction)` on the statechart's top state (declare `:hold/approve` in
`:acts` with `:needs` and `:correction true`): releases the hold now (timer cancelled), re-delivering
the act with a fresh stamp through the full path; then `:hold/released` or `:hold/dropped`. Works on
any hold (effect-only holds: the effect goes out). Reason required unless `by` operator.

**Feed class (r8a).** Every transition declares `:sova/feed :feed | :quiet` (strings accepted). Each
step carries `:feed`: refusals, corrections, held acts, starts and set-state are always `:feed`; else
`:feed` when any transition the step took is `:feed` or unclassified, `:quiet` when all are quiet.
`(core/unclassified registry/statecharts)` → `[[statechart transition-id events] …]` of transitions declaring
no class (initial/history defaults excluded, corrections count as feed): the enumeration test asserts
it is empty. Steps carry `:project-id` (session data `:project-id`, else the envelope's).

**Host.** `host.feed(projectId, {since, limit, includeQuiet, newestFirst})` → `[{at, session, statechart,
event, by, before, after, effects, feed, refused?, held?, reason?}]`: the log's rows of that project,
feed rows only unless `includeQuiet`, redacted exactly like the log. It raises nothing. Log rows gain
`feed`, `project`, `offHours`, `held.wait`, `held.confirm`. Hold (TS) gains `wait`, `confirm`, `waiting`.

**Matrix.** `matrix/run` takes `:sid`, `:load-cold`, `:stamp`, and `:absorb-unknown` (default true: a
session that exists nowhere is a sink that takes every event, so a statechart's world never throws).
`core/cold-sessions` + registry `:cold?` for retention.

## 8. F14 dangling links, resume problems, `rebuild --verify` (engine 6c5f38d5, 0a141345; host 00f53536, 3fa578ff)

**Dangling link.** A `link/moved` to a watcher that exists nowhere is dropped: the watcher is taken off
its source (a `sova/unwatched {watcher, dangling: true}` step) and listed under the call's
`dangling: [{from, watcher}]`. Explicit sends and watches to an unknown session still throw.
**Resume.** A session whose resume throws (or the past-due timers) is `host.problems()` entry
`{kind: "resume", file, why, sessionId?}`; the rest of the org resumes.

**`statecharts rebuild --verify <org>`** (r9; `pnpm statecharts rebuild --verify <org> [--workspace <dir>]`,
`server/org-host/rebuild.ts` `verifyOrg`). Every session's log rows are replayed from `sova/started` on
the current statecharts by `verifySession(sid, rows, snapshotText, {statecharts})` (JS API; CLJS
`engine/rebuild`): a scratch engine where every other session is a sink; a row's timers fire before it
(except before `sova/resumed`: the host resumes first); `sova/watched`/`unwatched` rows re-run the
watch (`core/replay-watch!`), `sova/resumed` runs resume, `sova/set-state` runs set-state with the
logged patch; a stamp returns the envelope of the next logged row of that event. The result is compared
with the snapshot by `core/outline` (states, running, links, watchers, own timers, holds). → `{session,
statechart, rows, same, differences: [{what, replayed, snapshot, why}], divergence}`. Reads only, never
restores. Log rows gain `start` (a host start's data), `invokeId`, `t` (the engine's time when `at`
was moved on) and `plain: true` (a `logAct` row: never replayed). Set-state's event data carries `patch`.

## 9. Shadowing keys, stalled timers, hold notices, nextWindow (engine-2)

**Payload vs envelope (9a929761, 01933b8b).** The host merges payload and envelope for the engine; a payload
key the envelope also carries with a DIFFERENT value throws `OrgPayloadError` (code
`payload-shadows-envelope`, a caller's bug: never stepped, never logged); equal values pass. The matrix fails
such a cell ("a payload key shadows the envelope's"; `matrix/shadowed`). Name a payload field something the
envelope doesn't use (baton/extend reads `{more}`).
**Stalled timers (3e482c49, 3d20894a).** `fireDue(now, {only, except})`, `dueSessions(now)`,
`setAside(sids)`: no call delivers a set-aside session's due events and `nextDueAt` skips them (what a call
queues for them still goes). The host fires what is due; when that throws, one due session at a time, and a
session still throwing is a `{kind: "timer"}` problem, set aside until one of its steps commits.
**Hold notices (c708a572).** A held act's session hears `hold/held {id event kind what until project-id
confirm by wait?}` in the same call (ignored unless the statechart listens); `hold/waiting` carries `project-id`.
**Log.** `prompt` is a digest (DEFAULT_REDACT).
**nextWindow(person, nowMs)** (0f2cee96): the statecharts' `rules.hours/next-window`, exported; null = open now
or no hours.
**dsl/timer-at (bff675ff).** `(dsl/timer-at id event at-fn)` / `(dsl/timer-at-ops data id event at payload?)`:
after the step, this session's timer `id` is cancelled and `event` (with `payload`) is due at the instant `at`
(ms; a past instant is due at once, in the same call); `at` nil only cancels. One pending timer per id however
often re-armed; durable in the snapshot's queue (r12's one reach timer per offer, `reach-<offer-id>`).
**r13 re-arm (4f916f23, a08e799d; host 967f6d6e).** Event `sova/rewindow {id until}` (engine-handled, like
`sova/hold-due`): an hours wait (`:wait "hours"`) moves to `until` (its timer re-armed); `until` nil or due
now releases it at once, after its own quiet row, and the release re-checks the act under a fresh stamp.
Anything else is ignored (no row). `host.rewindowHours(windowOf: (hold) => ms | null)` sends it for every
hours wait whose window changed (the server, after a person's or the company's hours edit; its stamp must
give the people's current effective records). A runtime JS act's `hours` reads JS data.
