# Org statecharts: the refit's eleven statecharts, and every inventory item they stand for

## Fast loop

`statecharts/` holds the org's statecharts. While editing them:

- `pnpm statecharts:watch` (repo root) starts one shadow-cljs server running `watch lib test` in `statecharts/`
  (devtools off; output only in the gitignored `out/` and `.shadow-cljs/`). A one-line edit rebuilds in about 1 s.
  Each worktree runs its own server: HTTP moves up from 9630 when taken, nREPL takes a random port.
- `pnpm statecharts:test` runs every non-matrix test namespace on the watch's output in a fresh `node` (~5 s);
  `pnpm statecharts:test <ns>…` runs only those (~2 s each); `--matrix` adds the refit matrix pieces (~17 s each).
  With no or stale output it tells you to start the watch.
- Never cold-compile in a loop; run the matrices only at the end (`node scripts/build-statecharts.mjs --test`
  is the full cold path), and `release lib` (the vendored bundle, `scripts/build-statecharts.mjs`) only for the final bundle.

Eleven statecharts in the fulcrologic/statecharts CLJC DSL (`com.fulcrologic/statecharts 1.4.0-RC18`) under
`src/sova/statecharts/`, registered in `registry.cljc` for the engine (`engine/API.md`). Every
lifecycle state and every link of the organization layer lives here (q1: no state projection files;
routes read the engine). The event vocabulary is `EVENTS.md`.

| statechart | file | storage | session id | what |
|---|---|---|---|---|
| org | `org.cljc` | portable | `org/<org>` | identity, owner ‹none·set·cleared›, holder record (r1), births of people and projects |
| residence | `residence.cljc` | host-local | `residence/<org>` | tenure ‹checking·held-elsewhere·held-here·detached› × commits ‹clean·dirty·committing› |
| person | `person.cljc` | portable | `person/<org>/<pid>` | ‹born·proposed·active·left›; field authority; one transition per status pair per event; left cascade |
| project | `proj.cljc` | portable | `project/<org>/<p>` | shelf, overseer, stakeholder, milestone × cooldown; gap filing; gap-less starts |
| watch | `watch.cljc` | host-local | `watch/<org>/<p>` | attach, shelf fact, exists, switch, turn, loop (+ `:sova/look`), clock; ledgers and held items |
| baton | `baton.cljc` | portable | `baton/<org>/<sid>` | course × reply × budget × wrapup (+ `:sova/wrapup`) |
| decision | `decision.cljc` | portable | `decision/<org>/<p>/<did>` | ‹pending·conflicted·drafted·promoted{currency·text·built}·superseded› |
| conflict | `conflict.cljc` | portable | `conflict/<org>/<p>/<cid>` | ‹unrouted·routed-to-person·routed-to-operator·settled›; spawns settle batons |
| reconciler | `reconciler.cljc` | portable | `reconciler/<org>/<p>` | ‹off·idle·debouncing·running·failed› (+ `:sova/reconcile`); decision index; promotion |
| item | `item.cljc` | portable | `item/<org>/<p>/<g_id>` | lane × follow-up × attention × drive; sets of gatherings and builds; owned links |
| build | `build.cljc` | portable | `build/<org>/<p>/<sid>` | setup × turn × tree × branch × merge |

Shared: `base.cljc` (event, time, ids, reasons and ledger sends, `relink`, `send-if`/`flush-transition`),
`reasons.cljc` (typed reasons and today's sentences), `rules/*.cljc` (pure rules: `refusal`, `levels`
(L0–L3, attended, forced L0, caps, the GO card), `person`, `baton`, `item`). Every rule is a pure
function over (data, event) returning nil or `{sentence status code? tail?}` with today's sentence.

## How the rulings land

- **q2 / r3 drive**: `item` region `drive` (eventless, each once per key, at the level in force read
  from the watched `watch` session): L2 `decision/promote` of in-area drafted decisions; L3
  `build/start` with `rules/item build-prompt` once every live decision is promoted, none built, no
  build; L1 a planned gathering (`gather/plan`, filed at L0) once, never after an attempt that
  answered nothing; L1 `baton/close` of an own unwritten gathering once a newer one to the same
  person is open. The L1 `reconcile/request` when a gathering ended with pending decisions is the
  baton's own drive (`baton` `reconcile-when-ended`, F8a), not the item's. All go through `dsl/drive`
  (by statechart) and so through every guard and the hold.
- **q7**: `project` `build/start` (gap none) refuses an unattended overseer (`gap-none-build-check`);
  `item` `build/start` needs promoted, not-built decisions (`decisions-check`; narrowing only).
- **q9 / r5 corrections**: `hold/cancel` (L0, every statechart), item `correct/reopen`, `correct/skip-stall`,
  `correct/relink` (L1), reconciler `correct/clear-failed` (L1), build `correct/merged` (L2); each a
  `dsl/correction` (reason required unless the operator's). Free set-state is the engine's.
- **q10 / r4 / r6 hold**: acts with `:hold true` in the registry: person approve/decline, project
  `baton/start` · `build/start` · `session/prompt` · `owner-update/post`, baton `close`, reconciler `decision/promote`, item
  `gather/start` · `build/start`, build `build/prompt`; `:what` gives the Needs-you words. F2: caps are
  checked at hold time and again at release; the ledger counts only the taken transition.
- **r7 working hours**: person `tz`/`hours` (operator's fields, history lines, exported);
  `rules/hours` `next-window` (pure; DST both ways, overnight; JVM + Intl), `reach-window` and
  `reach-times` (each invitee's own reach time, for per-invitee delivery); `:hours b/hours-window` on
  baton `hand-to` `handoff` `offer`, conflict `reroute`, project `baton/start`, item `gather/start` (the
  host stamps tz/hours on `target`/`targets`, an offer's invitees on `target-people`). Tests: `hours_test`,
  `holds_test` r7.
- **r12 offers (q15 = C)**: the offer opens at its first invitee's window (the act's `:hours` wait, as
  above); then `rules/reach` `step` reaches each invitee only in their own hours (no hours set: always).
  The offer's `:reach {pid {:state waiting|reached :at :next}}`, the invitees' `:people-hours` (from the
  envelope's records and their `link/moved`), ONE re-armed timer `offer-reach` (`dsl/timer-at`) at the
  next waiting window; entering `pool` reaches (a new offer, a lapse), `offer/reach` fires it, an
  invitee's hours edit re-reckons; a `mint-link {offer-id person-id n key}`
  per invitee reached in the offer's own step, keyed `reach/<offer>/<pid>` (a later reach only marks
  them reached: coordinator-50) (no `mint-links` for an offer; an offer the operator makes, or one in a turn they started, reaches everyone at once: `:at-once`). Only the reached may claim ("This offer has not
  reached you yet."). Rule 12: `leased` pauses it (timer stopped, nobody reached); a lapse resumes it;
  the offer ending (`offered` exit) stops it for good. Tests: `reach_test` (scope tests 1–8, 12),
  `baton-matrix-an-offer-in-hours`.
- **r14 (narrows R3; q12)**: every transition that sends the watch a reason declares
  `:sova/asks-overseer` (true · false · `:unwritten-false` · `:unless-auto-promoted` · a map kind → rule);
  the reason carries the resolved `:asks`; the watch (`own-act?`) looks for statechart news only when it asks.
  True: a conflict to route, a resolved conflict, drafted decisions the statechart won't promote itself, a
  gathering someone wrote in closed, a review, a stall, sessions' news; false: the statechart's own
  promotion, its close of its own unwritten gathering. (The operator's merge keeps master's reason.) Tests: `asks_test` (none undeclared; golden
  `asks_golden`), `asks_rules_test` (both branches of each rule, the watch waking or not).
- **r13 company hours (q16)**: org `org/hours {tz hours}` (operator only, a person's validation;
  exported); each person watches its org and exports `effective-hours` (`rules/hours effective`: own,
  else the company's, else nil = always in hours; zone and hours as a pair), `hours-inherited` and
  `hours-from` (own · company · none) (one quiet eventless transition
  keeps them current); a baton re-reckons an open offer's reach from an invitee's `effective-hours`, so
  a company edit re-arms reach timers; hours waits are re-armed by the host (`sova/rewindow`, engine).
  Looks and held acts that reach nobody read no hours. Tests: `company_hours_test`.
- **r8 / q12 review**: `:confirm-kind` on every held act (F12; `base/start-kind`: "offer" for ≥2
  targets); `b/hold-review` on each statechart with held acts: `hold/approve` (approve early, L0, reason) and,
  on `hold/waiting`, a soon `hold/review` reason to the project's watch, naming the hold as
  `<session-id>:<hold-id>` (F19: hold ids are per session; `params.hold`). Tests: `registry_test`,
  `holds_test` F12 + r8.
- **r8a feed classes**: every transition declares `:sova/feed` (rule in EVENTS.md); `registry_test`
  (none unclassified), `feed_test` (a pin per class per statechart, and the golden table `feed_golden` of
  every authored transition).
- **r10**: no act sends text into a gathering (F-128): `baton/send` deleted, no act of kind "message".
- **Root prompt** (coordinator-25): project `session/prompt` (L3 `sova_send`, a prompt, held, kind
  "prompt") for a coding session under the root that is not a build.
- **C-rows**: C1 C2 C3 C12 in `watch`; C4 `reconciler.debouncing`; C5 item stall clocks; C6
  `person/revert`; C7 `gap` or `"none"`; C8 C14 baton lease timer; C10 person status in the edit's
  patch; C11 item `…-starting` flags; C13 C18 (deleted/unneeded); C16 decision; C17 conflict `unrouted`;
  C20 q7 above.

Tests: `test/sova/statecharts/refit/` — `host.cljc` (a deterministic JVM/Node host: the real
processor, a virtual clock, the engine's level and `:pre` checks; hosts are values) and one test
namespace per statechart group. Run on the JVM:
`cd statecharts && clojure -Srepro -M -e "(require 'clojure.test 'sova.statecharts.refit.person-test 'sova.statecharts.refit.baton-test 'sova.statecharts.refit.item-test 'sova.statecharts.refit.org-project-test 'sova.statecharts.refit.watch-decisions-build-test 'sova.statecharts.refit.hours-test 'sova.statecharts.refit.decision-results-test 'sova.statecharts.refit.server4-findings-test 'sova.statecharts.refit.started-test 'sova.statecharts.refit.pins-test 'sova.statecharts.refit.reach-test 'sova.statecharts.refit.company-hours-test 'sova.statecharts.refit.asks-rules-test) (clojure.test/run-all-tests #\".*refit.*\")"`.
`pins_test` holds the pins for statechart mutants that survived verifier-2's run2 (each assertion names its mutant id).
The engine-level tests (`*_test.cljs`: matrix per statechart and per baton start kind, registry, feed, holds,
world) run in the shadow `:test` build. The whole CLJS suite (engine + statecharts, JVM-free under Node):
`node scripts/build-statecharts.mjs --test` (from the repo root; `pnpm --dir statecharts test` is the same).
It compiles once, then runs one process per piece, one after another, stopping at the first failure: every
test namespace except the matrices, then each `matrix-test` deftest alone (`person-matrix` `org-matrix`
`residence-matrix` `project-matrix` `watch-matrix`, baton per start: `baton-matrix-to-a-person`
`-to-the-operator` `-an-offer` `-no-link` `-a-settle-session`, `decision-matrix` `reconciler-matrix`
`conflict-matrix` `item-matrix` `build-matrix`, `every-statechart-has-its-own-world`); all of them in one
process run out of a 4 GB heap. One piece by hand, after a compile
(`clojure -Srepro -M:build -m shadow.cljs.devtools.cli compile test` in statecharts/):
`node out/test/node-tests.cjs --test=sova.statecharts.refit.matrix-test/item-matrix` (or
`--test=<ns>,<ns>/<deftest>,…`).

## Inventory map (every F-id → its element)

Kind: **statechart** (a state, transition, guard, check, timer or effect named), **proj** (read from statechart
data by a route), **host** (host code kept: prompts, loadouts, share listener, text checks stamped into
the envelope), **data** (plain data, unchanged rules), **del** (deleted, per coverage.md).

| F | inventory item | kind | element |
|---|---|---|---|
| F-001 | Create organization | statechart | `org` start (holder claimed) + `residence` mode create → `held-here` (effect commit "Create organization {name}", no pause); name/dir rules: host `invalid` |
| F-002 | Attach a restored repo | statechart | `residence` mode attach: `checking` → `held-here`, effects `commit` "Attached on {host}", `pause-overseers`; `watch` `org/attached-here` → `attach.paused` |
| F-003 | Holder check and warning | statechart | `residence.held-elsewhere` (`elsewhere` over clone + origin holder of the org snapshot, r1), `held-sentence` verbatim, `attach/confirm` |
| F-004 | Workspace dir guard | host | dir rules checked by the route, stamped as `invalid` |
| F-005 | Detach | statechart | `residence` `org/detach` → `detached` (final): effects `revoke-owner-links {why: detached}`, `holder/release` to `org`, `commit` "Released by {host}" |
| F-006 | Operator display name | data | host-local `orgs.json`; the name reaches statecharts as `operatorName` |
| F-007 | What the workspace repo holds | data | repo layout: `statecharts/` snapshots + log (q1: no state projection files) |
| F-008 | Legacy `started` migration | del | C13: deleted (no legacy started list) |
| F-009 | Attach re-derives host state | host | attach hooks (titles, web marks, stat); `wroteAt`/`conflict` are baton data from birth (C18) |
| F-010 | Working dirs come from this host | host | host rule |
| F-011 | Links must be re-issued after a move | host | host link stores are never portable |
| F-012 | Commits: the hourly committer | statechart | `residence.commits`: `dirty` arms `commit/look` every 1 min; `commit-every` since `head-at` → `committing` |
| F-013 | Commit Now | statechart | `residence` `commit/now` (any state) → `committing`; answer sentences from the effect result |
| F-014 | Push and remote | statechart | `residence` `push-pending` retried at a due look from `clean`; remote route plain data |
| F-015 | Graceful-shutdown commit | host | shutdown sequence; the commit result lands as `effect/done commit` |
| F-016 | Workspace tab and git status | proj | residence exported `last-git-error`, `push-pending`, `head-at` + git status |
| F-017 | Workspace file problems | host | C15/C19 per q1: snapshot/journal problems (engine `loadCold` errors); plain-data rules unchanged |
| F-020 | Org list `#/orgs` | proj | org list from `org`, `project.shelf`, `baton.course` exports |
| F-021 | Org Needs-you count | proj | Needs-you set over `baton` (`needs-you`, links), `person.proposed`, `conflict.routed-to-operator`/`unrouted`, `project.stakeholder-cleared` (C17) |
| F-022 | Last activity | proj | newest log row per org |
| F-023 | Org page with four tabs | proj | routes → events; reads from statechart data |
| F-024 | Sessions tab: the start form | statechart | `project` `baton/start` (archived check `not-archived`) |
| F-025 | Landing-page Organizations card | proj | totals from `org` / `project` exports |
| F-026 | Host-offline banner | host | mesh UI |
| F-027 | Peer org pages | host | peers forward to the holder's engine |
| F-030 | Person record and caps | statechart | `rules/person clean-field` caps and sentences (400) |
| F-031 | Add or edit a person (the operator) | statechart | `org` `person/add` (apply-change, duplicate name 409) and `person/edit` (C10: status in the patch is the lifecycle move) |
| F-032 | Field authority by writer | statechart | `rules/person authority-refusal` + `field-authority`; approve/decline: `person` `decider-check` |
| F-033 | Profile history and revert | statechart | `person/revert` (row from roster-history; creation refused; C6 stale row refused 409); `roster-history` effect lines |
| F-034 | Referral (`propose_roster_edit`) | statechart | `baton` `baton/propose` (`rules/person referral-refusal`, apply-change as referral) → spawn `person` proposed; `baton-entry proposal`; reason `baton/proposal` |
| F-035 | Approve or decline a proposed person | statechart | `person` `person/approve`/`person/decline` (op; overseer L2 `sova_roster`, held unattended r4/r6); `not-waiting` sentences |
| F-036 | Someone leaves (status →left by edit, revert or decline) | statechart | `person` entry of `left`: `revoke-person-links`; watchers: `org` (owner cleared), `project` (stakeholder cleared), `baton` (holder → operator "(left the organization)", pool withdrawn "({name} left…; offer withdrawn)", mid-reply stop first) |
| F-037 | Privacy of profiles | host | projections/prompts; `:redact {:contact}` in person's registry entry |
| F-038 | Person page `#/orgs/<id>/people/<pid>` | proj | person page from person/baton/decision/conflict data + host links |
| F-039 | Wrap-up: profiles learn from each session | statechart | `baton.wrapup`: `wrapup-none` → `due` (a person wrote) | `skipped`; `running` invokes `:sova/wrapup`; 11-min `wrapup/overdue`; `sova/resumed` → failed; `baton/wrapup-retry` (`retry-refusal` order); profile writes = `person/edit {by: wrapup}` |
| F-040 | Start a baton session | statechart | `baton` birth (`start-ops`: to person/operator/offer), effects `create-session`, `mint-links` unless `mintLink:false`; spawners check archived (`project` / `item` / `conflict`) |
| F-041 | Baton strip (operator) | proj | strip from baton exports; actions = baton acts |
| F-042 | Loadout | host | loadout |
| F-043 | Baton system prompt | host | prompt (reads person states) |
| F-044 | `hand_to({person, question, briefing})` | statechart | `baton/hand-to` (`rules/baton hand-to-refusal`: ended, target `invalid`, holder-chose, question, move-refusal), no link |
| F-045 | `goal_done({summary})` | statechart | `baton/goal-done` → `done` (`goal-done-refusal`), reason `baton/done`, milestone |
| F-046 | `record_decision({area, ownerArea, statement, quote})` | statechart | `baton/record-decision` (`record-decision-refusal`, `spelled-owner-area`) → spawn `decision`; settle session: `reconcile/request {delayMs 2000}` |
| F-047 | Message budget | statechart | `baton.budget` ‹under·at-limit›; eventless budget stop in `open` after the reply (`limit-question`); `message-verdict` budget refusals; `budget/recount` never raises |
| F-048 | Extend | statechart | `baton/extend` (`extend-refusal`) |
| F-049 | Operator moves and "nothing sent is dropped" | statechart | `baton` operator moves (take-back, handoff, offer, withdraw): checks first, then `stop-reply` + `pending-move`, re-delivered at `reply/ended` and re-checked; close never interrupts |
| F-050 | Offers and leases | statechart | `baton.course.open.offered` ‹pool·leased›: claim in `baton/message` (`message-verdict`), durable `lease/lapse` (`lease-ms`), re-armed on `reply/ended`, never lapses mid-reply; withdraw on moves; C8/C14 |
| F-051 | Hand-off links | host | link store; mint/revoke effects from the baton (`mint-link(s)`, `revoke-links`) |
| F-052 | Link warnings | host | link warnings |
| F-053 | Attribution | host | attribution; composer refusals = `message-verdict` operator sentences |
| F-054 | Outsider view (share page) | host | outsider view |
| F-055 | Share listener | host | share listener; message route → `baton/message`, `message/refused` |
| F-056 | Visits log | data | visits log |
| F-057 | Share-page live transport | host | share transport; lapse pushed from the lapse's own step |
| F-058 | Needs you from batons | proj | Needs-you over baton `needs-you` / holder link + `person.proposed`; an item's `needs-operator` / `follow-up-needs-operator` means the same: a gathering with the operator whose `needs-you` is true (`rules/item baton-needs-operator?`); once the operator replies it is `asking` (coordinator-38; `item_test` lane, follow-ups) |
| F-059 | Hide from or show to the owner | statechart | `baton/hide` |
| F-060 | Baton events bus | del | replaced by sends and link notifications |
| F-061 | Settle-session marker on the baton row | statechart | baton data `conflict {id area}` (from the conflict's spawn), kept |
| F-062 | Baton session in the session list | proj | session list from baton exports |
| F-063 | Abilities: Draw and Read links | statechart | baton `abilities` data; `baton/abilities` (refused once ended); ceiling = host `invalid` |
| F-064 | `read_link {url}` | host | read_link tool (inactive unless abilities.readLinks) |
| F-070 | Project registry | statechart | `org` `project/add` (name check, root `invalid`) → spawn `project`; `project/edit` |
| F-071 | Archive and unarchive a project | statechart | `project.shelf`: `project/archive` (`blockers-sentence` "Stop these first: …"), `project/unarchive`; archived → `not-archived` on starts; watch `archived-fact` |
| F-072 | About this organization | data | About: plain data and its route (never a statechart event) |
| F-073 | Project main stakeholder | statechart | `project.stake` ‹no-stakeholder·stakeholder-set·stakeholder-cleared›: `stakeholder/set` (active only, 400), history ≤50, cleared on the watched person's `:left` |
| F-080 | Decision index | statechart | decisions are born by `baton/record-decision` (spawn); the host's resume sync spawns any entry without a session |
| F-081 | Decision states | statechart | `decision` ‹pending·conflicted·drafted·promoted{currency·text·built}·superseded›; C16 |
| F-082 | Field ownership in the project spec | host | promotion effect's spec writer |
| F-083 | Owner area | statechart | `decision/owner-area` (`rules/baton owner-area-refusal`, superseded 409, history) → `decision/owner-area-changed` → reconciler `route-conflict-of` → `conflict/reroute {keepIfSame}` |
| F-084 | Reconciler switch | statechart | `reconciler.off`: only `reconcile/request` refused (`reconcile-off`); automatic ones record the error |
| F-085 | When the reconciler runs | statechart | `reconciler` `reconcile/request` (op, `sova_reconcile` L1, GO, sova 2 s `debouncing` durable C4; the L1 drive when a gathering ends with pending decisions is the baton's `reconcile-when-ended`, not the item's) |
| F-086 | What the reconciler sends | host | decide seam in `:sova/reconcile` |
| F-087 | Area filing | host | inside `:sova/reconcile` |
| F-088 | Contradiction check | host | inside `:sova/reconcile` |
| F-089 | Restatements are folded | statechart | `reconcile/result {state superseded, supersededBy, folded}` to decisions |
| F-090 | Settling by resolution | statechart | `reconcile/finished` resolved → `conflict/resolved` → `conflict.settled`; an item whose decision is superseded watches the `superseded-by` winner and follows its phase (item `moved-ops`; `item_test` follows-a-superseding-winner) |
| F-091 | Settling by hand | statechart | `conflict/settle` (`settle-check`; closes the asking session; effect `settle`) |
| F-092 | Conflict routing | host | route computed by the host (routeConflict) at the run and re-route; statechart keeps `routed-to`, `route-reason` |
| F-093 | Operator-set say (self-assertion guard) | host | decidesTrusted inside the route; `self-asserted` kept |
| F-094 | Settle session | statechart | `conflict` birth spawns the settle `baton` (`settle-baton-data`: goal, question, `mintLink:false`, `conflict {id area}`, owner) |
| F-095 | Re-route | statechart | `conflict/reroute`: new session spawned on entry, the old one closed (`close-asking`) |
| F-096 | Drafts with provenance | host | draft writer (`draft` effect, `draft/rewrite`) |
| F-097 | Promotion | statechart | `reconciler` `decision/promote` (`verdicts`, `promote-check`, cap on ids) → effect `promote` → `promote/done` fan-out; ledger counts only promoted |
| F-098 | Promotion commit | host | promotion commit inside the effect |
| F-099 | Edited in spec | statechart | `decision.promoted.text` ‹as-promoted·edited-in-spec›; `decision/settle-text` keep/restore |
| F-100 | Built or not built yet | statechart | `decision.promoted.built` from `spec/facts` |
| F-101 | Frozen spec | statechart | `project` `spec/freeze`; hash fact host |
| F-102 | Decide seam (the provider under the reconciler) | host | decide seam |
| F-103 | Reconciler usage log | data | usage log |
| F-104 | Reconciler events | del | replaced by typed reasons to the watch (C2, C3) |
| F-110 | Identity and creation | statechart | `project.overseer` ‹no-overseer·has-overseer› `overseer/start` |
| F-111 | Clear and History | statechart | `overseer/clear` (≤20 history) + `ledger/reset-message` |
| F-112 | Two writers only | host | routes; archived from `project.shelf` |
| F-113 | Loadout and confinement | host | loadout, confinement |
| F-114 | Prompt | host | prompt (level in force from `rules/levels`) |
| F-115 | Extra instructions | data | settings |
| F-116 | Models and thinking | data | settings |
| F-117 | Chat page head and status strip | proj | head and strip from watch exports |
| F-118 | Autonomy levels | statechart | `rules/levels` `effective-autonomy`, `level-check` (engine option), `tool-needs` |
| F-119 | Attended vs unattended runs | statechart | envelope `attended`; `watch.turn` ‹idle·look-turn·run-turn·operator-turn› (W20) |
| F-120 | Tool wrapper and audit | statechart | engine explain/trial with the registry's acts; refused steps = the log's refused rows |
| F-121 | Read tools | proj | reads + `sova_pipeline` from item exports |
| F-122 | L0 tools: note, confirm, idea | statechart | `project` `gap/file` (L0) spawns `item`; note/confirm/idea plain data |
| F-123 | L1 `sova_start_gathering` and `sova_offer` | statechart | `item` `gather/start` (L1, cap, held) / `gather/plan` (L0); `project` `baton/start` with `gap: "none"` (C7) |
| F-124 | L1 `sova_close_gathering {session, reason}` | statechart | `baton/close` overseer path (`close-refusal` order), held unattended (r6) |
| F-125 | L1 `sova_reconcile` | statechart | `reconciler` `reconcile/request {by overseer}` |
| F-126 | Send to person… (an operator gesture on an item) | statechart | `project` `baton/start` by the operator with `opItem` |
| F-127 | L2 `sova_promote {ids}` | statechart | `reconciler` `decision/promote` by overseer (L2, held) |
| F-128 | L3 `sova_create_session` and `sova_send` | statechart | `item` `build/start` (L3, decisions ⊆ promoted not built, held); `project` `build/start` gap none (q7 attended only); `build/prompt` (L3 `sova_send`) to a build; `session/prompt` (L3 `sova_send`, held) to a root coding session that is not a build; a gathering session is refused by the tool (r10: no statechart act) |
| F-129 | Limits: allowances, at-once, looks | statechart | `rules/levels` `cap-check` (at once, then allowance), watch ledgers (`ledger/take`), settings data |
| F-130 | Held items and release | statechart | `watch` `limit/refused` → `held` (≤10), releases at midnight / raised limit / message at once (C12) |
| F-131 | Watch-loop reasons (events → English) | statechart | typed `reason/noted` from statecharts; `watch` `own-act?` (C2; R3: news of the statechart's own act, `by` statechart from `b/tell-watch`, is never a reason: no look, no look used, it rides the next look's feed), key dedupe (C3), ≤50 pending, 20 in the text; R4: item reopened / answered-nothing are feed entries, not reasons (item/stalled stays, C5); tests `watch_decisions_build_test` R3, `item_test` R4 |
| F-132 | Tick and unattended look | statechart | `watch.loop` quiet → waiting (`due-in` on the 20 s tick) → due → running (`:sova/look`, `watch-text`) |
| F-133 | Soon looks | statechart | `with-reason` soon → `soon-at` |
| F-134 | Run Now | statechart | `watch` `operator/run-now` (`run-now-refusal`); refused → `look/skipped` recorded |
| F-135 | Last-run record and cut-off sweep | statechart | `watch` `last-run` outcomes; `sova/resumed` = cut-off; re-queue (C1) |
| F-136 | Gaps | statechart | `item` per gap, born by `gap/file` |
| F-137 | Ideas and to-dos (the operator's list) | data | ideas and to-dos stay plain data |
| F-138 | Start coding session from an item | statechart | `project` `build/start` (operator-coding, `opItem`) |
| F-139 | New Coding Session | statechart | `project` `build/start` without prompt (build `setting-mode` → `ready`) |
| F-140 | Coding mode | statechart | `build.setup.setting-mode` (`mode-not-set`); ceiling = host `invalid` |
| F-141 | Coding worktrees | statechart | `build.setup.making-worktree` (branch/base/target or `in-root`; not-started sentence) |
| F-142 | Merge Branch | statechart | `build/merge` (`root-check`, `busy-check`) → effect `merge`; reasons `build/merged` / `build/merge-refused` (not for root-checkout) |
| F-143 | Merged is read from git | statechart | `build.branch` from `git/probe`; recorded `merged` when git can't say; `correct/merged` (L2) |
| F-144 | Remove Worktree | statechart | `build/remove-worktree` → effect; `tree-removed` |
| F-145 | The project page | proj | project page from statechart data |
| F-146 | Coding rows in `started.json` | statechart (changed on purpose, r11) | project `:started` (exported): one ordered list of every baton and build it or its items started (`started/noted` from the item), cap 200 (`rules/started`); past it the oldest SETTLED one gets `session/retire` (baton/build final `retired`, guarded: never while live); tests `started_test` |
| F-148 | Idea and to-do store rules (the project's ideas and to-dos use the Overseer's stores) | data | ideas store rules; `gap/drop` agrees both ways (`idea-status` effect / `fromIdea`) |
| F-147 | Org statecharts (existing, shadow-only) | statechart | the refit engine + these statecharts replace the spike |
| F-150 | Org owner | statechart | `org.owner` ‹owner-none·owner-set·owner-cleared› |
| F-151 | Owner leaves | statechart | watched owner `:left` → `owner-cleared`, `revoke-owner-links` |
| F-152 | Owner link | host | owner link store; mint needs `org` owner |
| F-153 | Owner link: off and dead checks | host | validity check reads org owner + person status |
| F-154 | Owner page content | proj | owner page from statechart data |
| F-155 | Which conversations the owner reads | statechart | baton `hidden-from-owner`; project `owner-hidden` |
| F-156 | What the page never shows | host | owner page projection |
| F-157 | Page mechanics | host | page mechanics |
| F-158 | Operator controls | proj | operator controls |
| F-159 | `sova_owner_update({text})` (PO, L1) | statechart | `project` `owner-update/post` (L1, `update-check` order, `milestone` ‹no-milestone·since-post›, `cooldown` ‹ready·cooling› 24 h timer), held unattended |
| F-160 | Take Down an update | data | withdraw: updates.jsonl route |
| F-170 | Cost scope | data | costs |
| F-171 | Pricing and the price table | data | costs |
| F-172 | Ledger | data | costs |
| F-173 | Cost card and org rollup | data | costs |
| F-174 | Cost privacy | data | costs |
| F-180 | Scope | host | GO layer |
| F-181 | Reads | proj | GO reads |
| F-182 | Projection and redaction | host | GO redaction |
| F-183 | Writes | statechart | GO writes = operator events with `via: overseer` |
| F-184 | Attribution "you, via the Overseer" | statechart | `via` in envelope → history rows (`owner-history`, `stakeholder-history`, `archived.via`, `roster-history by.via`) |
| F-185 | People-facing acts ask first (`sova_gather`) | statechart | acts' `:people-facing` + `:card` (registry) — the card check (`rules/levels card-check`); `start`: project `baton/start` and item `gather/start` list the project and every person (`base/start-card`, never the operator) |
| F-186 | Running project overseers (`sova_project_overseer`) | statechart | operator events via GO |
| F-187 | GO prompt rules (E) | host | GO prompt |
| F-190 | Which sessions are organizational | proj | org sessions = baton/build sessions |
| F-191 | Sidebar Organizations region | proj | sidebar |
| F-192 | Guards | host | guards |
| F-193 | Special-session guards in the chat runtime | host | chat guards |
| F-200 | Public-links setting | host | mesh |
| F-201 | Gateway registry | host | mesh |
| F-202 | Routing by token hash | host | mesh |
| F-203 | Offline host | host | mesh |
| F-204 | Mesh never syncs orgs | host | mesh |
| F-205 | Mesh link messages refuse org sessions | host | mesh |
