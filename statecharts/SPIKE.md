# statecharts engine spike: fulcrologic/statecharts under Node

What was built and measured to answer design §6.4 ("Costs and risks to measure in a spike") for running
`com.fulcrologic/statecharts 1.4.0-RC18` inside Sova's Node server without escapement. The statecharts
themselves are described in `STATECHARTS.md`; this file covers the engine, the build and the numbers.

## What is here

| Path | What |
|---|---|
| `deps.edn`, `shadow-cljs.edn`, `package.json` | self-contained CLJS project; nothing in it imports Sova |
| `src/sova/statecharts/engine/queue.cljs` | durable delayed-event queue, ported from escapement `engine/queue.cljc` (copied, not a dependency) |
| `src/sova/statecharts/engine/core.cljs` | the engine: store with a save callback, `:sova/look` invocation processor, trial, enabled events, dump/load |
| `src/sova/statecharts/engine/bounded.cljs` | the step limit: the library's processor with at most N microsteps per event (see "Step limit") |
| `src/sova/statecharts/engine/probe.cljs` | `engine-probe` statechart: every engine feature in one statechart, for the CLJS tests; not in the shipped bundle |
| `src/sova/statecharts/engine/js_statechart.cljs` | a statechart written as a JS tree, registered at runtime (`createEngine({statecharts})`): how the TS tests add the probe to the shipped bundle |
| `src/sova/statecharts/engine/timbre_shim.cljc`, `no_spec.cljc` | build-time stand-ins for `taoensso.timbre` and `cljs.spec.alpha` (see "Trim") |
| `src/sova/statecharts/engine/core_test.cljs` | engine tests under `:node-test` |
| `src/sova/statecharts/api.cljs` | the narrow JS API (§6.3) and JSON marshalling |
| `bench/bench.mjs` | cold-load and per-call micro-benchmarks |
| `../server/vendor/statecharts.js` | the committed release bundle (one ESM file) |
| `../server/fixtures/statecharts-engine/probe-statechart.ts` | test-only: `probe.cljs` transcribed as a JS tree, which the TS engine tests register on the shipped bundle |
| `../server/statecharts.ts`, `../server/statecharts.test.ts` | typed TS wrapper; tests against the vendored bundle |
| `../scripts/build-statecharts.mjs` | rebuilds the bundle (`--test` runs the CLJS tests, `--check` compares) |

## Build

- `node scripts/build-statecharts.mjs` runs
  `clojure -Srepro -J-Dtaoensso.timbre.min-level.edn=:warn -M:build -m shadow.cljs.devtools.cli release lib`
  in `statecharts/` and copies `out/lib/statecharts.js` to `server/vendor/`. It needs a JVM and the Clojure
  CLI; every dependency resolves from Maven (`~/.m2` here). **No npm install**: shadow-cljs runs from its
  jar via deps.edn; `package.json` lists it as a devDependency only for anyone who prefers `npx shadow-cljs`.
  `pnpm build` and `pnpm test` never run it; Sova needs no JVM.
- `-Srepro` matters: a user-level `~/.clojure/deps.edn` alias named `:shadow` (with its own `-m`) collided
  with the first alias name and broke the CLI. The alias is now `:build` and user config is ignored.
- Build time: about 15 s for a release on this machine (JVM start included).
- **Byte-reproducible.** Two things made the release depend on more than the sources, both found by the
  verifier's fresh-checkout rebuild. First, shadow's build cache: the script deletes
  `.shadow-cljs/builds/lib` before every release. Second, reader gensyms: `cljs.spec.alpha`, loaded by
  statecharts' top-level `s/fdef`, interns `#(…)` forms named from Clojure's JVM-global id counter
  (`p1__<n>#`). Whatever the JVM did first moved it, and the constants' order then shifted Closure's
  renaming across the whole file. A `:compile-prepare` build hook
  (`sova.statecharts.engine.build-hooks/fixed-gensym-counter`) sets the counter to a fixed value, and
  `:parallel-build false` keeps the compile order stable. Result: three cache-free builds and a build in
  a fresh copy (no `.shadow-cljs`, `out` or `.cpcache`) are identical, and `--check` is meaningful on any
  checkout. Stubbing `cljs.spec.alpha` out with `:ns-aliases` was tried first and fails: spec's own
  source still gets compiled against the alias.
- The script refuses to vendor while `statecharts/src` (or the build config) has uncommitted changes
  (`--dirty` overrides): during the spike a bundle built from a shared working tree picked up another
  member's uncommitted statechart edits. The committed bundle was rebuilt in a detached scratch worktree at a
  commit, so it matches committed sources exactly.
- `:target :esm`, `:runtime :node`, `:advanced`, ES2020 output, no source map, guardrails off (its default:
  no `guardrails.enabled` property, no `:guardrails` external config). A missing var
  (`:undeclared-var`, `:undeclared-ns`, `:fn-arity`) fails the release build, so a bundle whose statechart lacks
  its `version` cannot ship.
- Logging: `taoensso.timbre` is aliased to `engine/timbre_shim.cljc` (see "Trim"). Its macros elide trace,
  debug and info at compile time (as `-Dtaoensso.timbre.min-level.edn=:warn` did for timbre); at runtime the
  engine installs one appender that captures warnings and errors into each call's `errors` array instead of
  printing.
- The script builds `:lib`, then vendors, normalises, path-checks and `--check`s it. (A test-only `:lib-probe`
  build, the same engine plus the probe, was committed beside it during the spike: 346 KB, replaced by the
  runtime registration below at the squash.)

## Trim (after the verifier's FINAL): what the shipped bundle no longer carries

All build-time only (`:ns-aliases` in `shadow-cljs.edn`, the way guardrails' malli namespaces are aliased to
its no-op); the statecharts library is neither forked nor patched.

| Build (same sources) | Raw | gzip -9 | Node import (min of 5 × median of 15 cold) | First `createEngine` + `start` |
|---|---|---|---|---|
| no aliases at all (`:lib-baseline`) | 829,720 B | 202,318 B | — | — |
| before: guardrails aliased (80b52767) | 420,902 B | 106,635 B | 36.8 ms | 10.8 ms |
| **after** | **340,401 B** | **85,376 B** | **28.1 ms** | **6.8 ms** |

Per namespace group, from `shadow.cljs.build-report` (optimized KB, before the final gzip):

| Group | no aliases | before | after |
|---|---|---|---|
| `cljs.core` | 225.6 | 194.3 | 186.4 |
| statecharts library | 75.2 | 79.5 | 56.0 |
| sova (statecharts, engine, api; probe before) | 72.2 | 77.2 | 74.2 |
| `cljs.tools.reader` + `cljs.reader` | 24.4 | 20.7 | 17.0 |
| timbre, encore, truss | 25.3 | 26.5 | 0 |
| `goog.i18n` / `goog.date` (encore's) | 6.0 | 6.0 | 0 |
| `cljs.spec` | 55.1 | 7.6 | 0 |
| malli, `cljs.pprint`, expound, edamame, fipp, dynaload, guardrails | 321.4 | 0 | 0 |
| other goog | 17.2 | 6.7 | 3.7 |
| **total** | **822.3** | **418.5** | **337.3** |

- **Timbre and encore** (~33 KB with encore's `goog.i18n` date formatting): aliased to `engine/timbre_shim.cljc`.
  The library only calls timbre's macros (`debug` ×80, `error` ×56, `spy` ×63, `warn` ×33, `trace`, `info`,
  `debugf`). The shim keeps them, elides trace/debug/info at compile time, and keeps timbre's appender
  contract (`set-config!`, `merge-config!`, `set-min-level!`, `{:level :vargs :?err :msg_}`), so the
  engine's capture into `errors` is unchanged. The statecharts code shrinks too (47.6 → 31.6 KB for
  `v20150901_impl`): each elided call also took timbre's call-site data with it. The CLJS test build uses the
  same shim. Proven by `a-library-warning-or-error-lands-in-the-calls-errors` (CLJS) and "the library's own
  warnings and errors land in the call's errors" (TS): a library warning and a library error, each exact.
- **cljs.spec** (7.6 KB): aliased to `engine/no_spec.cljc`. The library's CLJS code uses spec only for one
  `s/fdef` of its own `in-state-context` macro, which nothing checks at runtime. The engine does not need spec.
- **engine-probe** (5.5 KB): out of the shipped file. A second module of `:lib` was tried first: it turned every
  top-level of the shipped file into an `$APP` property (371,248 B instead of 343,609 B, and about 5% slower per
  event). Then a separate release build, `:lib-probe`, committed as a 346 KB test fixture. At the squash that
  became runtime registration: `createEngine({statecharts})` takes a statechart written as a JS tree
  (`engine/js_statechart.cljs`, built with the library's own element constructors, which the shipped statecharts already
  pull in: +3,610 B, 344,011 B raw), and the TS tests register `server/fixtures/statecharts-engine/probe-statechart.ts`,
  a node-for-node copy of `probe.cljs`. Its guards and scripts are JS and see the data model marshalled, so
  per-event numbers on the probe now include that marshalling.
- **`simple/register!`** (~4 KB with the statechart validation, the manually-polled queue and the statechart
  invocation processor it requires): the engine registers statecharts with the registry directly. The statecharts are
  fixed at build time; `the-statecharts-pass-the-librarys-validation` runs the same validation in the tests.
- **`cljs.reader`** (3.2 KB): snapshots are read with `cljs.tools.reader.edn` and a `#uuid` reader. No snapshot
  of the replay (2,753 dumps, stall horizon included) held a tagged literal; an unknown tag is refused
  (`a-snapshot-is-plain-edn-and-a-uuid-round-trips`).
- What is left is runtime: `cljs.core`, the library's algorithm, statechart, elements and data model, the statecharts, the
  engine, and the EDN reader that `load` needs.

Per event (µs, min of 5 alternating runs of `bench/bench.mjs`, Node 25.2.1, a loaded machine): unchanged within
noise.

| Call | before | after |
|---|---|---|
| `send` toggle / with `onSave` / guarded + outbox | 577 / 580 / 511 | 583 / 561 / 569 |
| `send` hold/resume (history + timer) | 939 | 917 |
| `send` work-item `facts/changed` (probe bench) | 462 | 455 |
| work-item facts, 4-state cycle, item + project (shipped file only) | 2,895 | 2,819 |
| `trial` refused (probe) / promote on a work item (shipped) | 466 / 698 | 470 / 688 |
| `enabledEvents` (probe: 9 candidate events before, 11 after) | 1,188 | 1,476 |
| `dump` / `load` | 9.1 / 52.5 | 8.9 / 53.6 |

## Sizes (release, measured early in the spike)

| Build | Raw | gzip -9 | Node import (median of 15 cold processes) |
|---|---|---|---|
| `:lib` (shipped): guardrails aliased to its no-op ns | **412,023 B** | **103,711 B** | **38.6 ms** |
| `:lib-baseline`: identical, without the alias | 828,515 B | 201,835 B | 54.0 ms |

First `createEngine()` + `start` after import: ~10 ms (both builds). Both rows were measured on the same
sources, early in the spike. The bundle committed now has the finished statecharts in it: **416,508 B raw,
105,374 B gzip, 43 ms import**. Statecharts add about 4 KB per revision; the library and runtime are the rest.

**malli and timbre.** From shadow's build report (`shadow.cljs.build-report`, optimized bytes):

- Baseline: `malli.*` = **134.4 KB** (`malli.core` 89.6, `malli.impl.regex` 17.0, `malli.error` 14.7,
  `malli.dev.pretty` 6.8, `malli.registry` 2.3, `malli.dev.virhe` 1.5, `malli.sci` 1.3). Pulled in with it:
  `cljs.pprint` 91.8 KB, `cljs.spec` 55.1 KB, `expound` 40.0 KB, `edamame` 38.5 KB, `fipp` 6.9 KB,
  `borkdude.dynaload` 6.6 KB, plus ~31 KB more of `cljs.core` kept alive: about **400 KB of the 820 KB**.
- None of it runs: with guardrails off, `>def` emits nothing and `>defn` emits a plain `defn`. It stays because
  `com.fulcrologic.guardrails.malli.core` requires `malli.core`, `malli.dev.pretty`, `malli.error` and
  `guardrails.core` (expound, spec) at load, and `guardrails.malli.registry` has top-level side effects
  (`defonce registry (mr/composite-registry m/default-registry …)`, `(register! :every …)`) that Closure
  cannot eliminate.
- Shipped build: **0 bytes of malli, expound, cljs.pprint, edamame**; `cljs.spec.alpha` 7.6 KB remains
  (required directly by statecharts namespaces). **Timbre stays in: 25.3 KB** (`taoensso.encore` 15.1,
  `timbre` 8.5, `appenders.core` 1.7), because the library calls `log/…` throughout.
- How: `:build-options {:ns-aliases {com.fulcrologic.guardrails.malli.core com.fulcrologic.guardrails.noop,
  com.fulcrologic.guardrails.core com.fulcrologic.guardrails.noop}}`. This is guardrails' own documented
  remedy (the `guardrails.noop` ns docstring gives this exact shadow-cljs config); the library is not
  patched. Its one runtime difference: the noop `>defn` keeps the gspec vector as a discarded expression in
  the function body. Per-call cost is within noise (table below), and the 16 TS engine tests pass against
  both builds (the baseline was swapped into `server/vendor/` for one run, then restored).
- **Proposed upstream fix** (not applied): in guardrails, keep `com.fulcrologic.guardrails.malli.core`'s
  runtime requires (malli.core, malli.dev.pretty, malli.error, guardrails.core/expound) out of the build
  when guardrails is disabled, e.g. a macros-only ns for `>defn`/`>def`/`=>`/`?` whose expansion requires the
  checking runtime only when checking is on; or ship `com.fulcrologic.guardrails.malli.noop` and have
  statecharts document the `:ns-aliases` for CLJS consumers. Either removes ~400 KB for every CLJS user of
  statecharts with guardrails off.

## Per-call cost (bench/bench.mjs, Node 25.2.1, µs per call, median of 5 rounds after warm-up)

| Call | `:lib` (shipped) | baseline |
|---|---|---|
| `send`: two-state toggle in one region of a 4-region parallel statechart | 478 | 482 |
| `send`, same, with `onSave` serializing the snapshot each step | 436 | 465 |
| `send`: guard on the envelope + outbox effect + drain | 515 | 566 |
| `send`: hold/resume (deep history, timer cancel + re-arm) | 907 | 981 |
| `send`: work-item `facts/changed` | 338 | 340 |
| `trial` (refused) | 466 | 480 |
| `enabledEvents` (8 candidate events) | 1,087 | 1,076 |
| `dump` | 9 | 9 |
| `load` | 56 | 54 |

Snapshot sizes: probe 760 B, work item 1,193 B (EDN text).

- A CPU profile (pseudo-names build, 20k sends) puts **~87% inside the library's SCXML algorithm**
  (`select-transitions*` 53%, `before-event!`/eventless selection 28%, `exit-states!` 19%: mostly
  `chart/in-document-order` over all ids, `atomic-state?` and `get-children` rescans per event). The engine
  adapter (clock, outbox drain, configuration) is ~4%; marshalling is negligible.
- Sova's rate is events per minute per project, so 0.3–1 ms per event is ample. **Proposed upstream fix**
  (perf, not needed here): precompute per statechart the atomic-state set and the transitions per state in
  document order (`::sc/id-ordinals` already exists), so selection stops rescanning the element tree.

## Engine behaviour under Node (tests)

Both suites run the same scenarios; the TS suite runs them through the TS wrapper against the **shipped
file**, with the probe registered at runtime from its JS copy, and checks that the shipped file lists no test
statechart; the CLJS suite runs `engine.core` on `probe.cljs` under `:node-test`. The replay runs the shipped
file too. Six mutations of the JS probe (no cancel on exit, `In()` always true, shallow history, a guard
blind to the envelope, no unknown op, no eventless cycle) each fail 1–2 TS tests.

- `pnpm exec tsx --test server/statecharts.test.ts` (part of `pnpm test`): 20 tests.
- `node scripts/build-statecharts.mjs --test`: `engine.core-test`, 21 tests (plus the statecharts' own `-test`
  namespaces).

| Behaviour | Proven by |
|---|---|
| event send; step log `before`/`after`; `data.at` stamped | "an event moves the lane…" |
| parallel regions entered in document order | "start enters every region…" |
| delayed send fires at its time on the injected clock, not 1 ms before | "a delayed send fires…" |
| exit cancels a pending delayed send (the library does not; statecharts `cancel` in `on-exit`) | "leaving a state cancels…" |
| deep history restores `b2`, not the default, and re-arms `b2`'s timer | "deep history restores…" |
| eventless transition guarded by `In(:open)` in another region; its raised event runs in the same macrostep | "an eventless transition reads another region…" |
| `:sova/look` invocation: host `onInvokeStart` on entry with params, `onInvokeStop` on exit; host reports back with `invokeId` | "an invocation starts on entry…" |
| `trial` saves, sends and invokes nothing; names the refusing transition with its `sova/*` tags; `enabledEvents` follows the envelope | "trial is side-effect free…" |
| a trial that would arm a timer, start an invocation or send to a peer does none of it (reports them) | "a trial arms no timer…" |
| cross-session send delivered in the same call; to an unloaded session reported `delivered:false`; `snapshots` holds both moved sessions | "a cross-session send…" |
| dump → load into a fresh engine mid-flight: same configuration and data, queue included; the timer fires after load | "dump → load mid-flight…" |
| load runs nothing; `sova/resumed` then exits the cut-off look (stop callback) and the generation continues | "a load cut off mid-look…" |
| past-due timers of several restored sessions fire in global (time, ordinal) order | "simultaneously past-due timers…" |
| `onSave` snapshots load elsewhere; any version mismatch refused (no snapshot migration, by the operator's no-back-compat ruling) | "onSave hands over…", CLJS `load-refuses-a-version-mismatch` |
| a nested `final` keeps the session running with its configuration | "a nested final keeps…" |

Mutation checks (each applied to the engine source, CLJS suite recompiled and run, source restored):
see the table at the end of this file.

## API (as built)

`createStatecharts(opts)` in `server/statecharts.ts` wraps `createEngine`. See the types there; in short:
`start`, `send`, `trial`, `configuration`, `data`, `enabledEvents`, `nextDueAt`, `fireDue(now)`, `dump`,
`load`, `unload`, `sessions`, `generation`. Every call takes `{now}`; results carry the transition log
(`steps`), the drained `outbox`, cross-session `sends`, `invocations`, captured `errors` and `snapshots`.
Keys are camelCase in JS and kebab keywords in CLJS; values untouched; event names and state ids are strings.

## Semantics worth knowing (found while building)

- **A top-level `final` empties the configuration**: entering it stops the interpreter, and
  `exit-interpreter!` removes every state, so the session can no longer say where it ended. Statecharts use a
  nested `final` instead (the probe's `:stopped`).
- **Delayed sends survive state exit** unless the statechart cancels them: the engine does not change SCXML here.
- **`cancel` is by sender**: the ported queue removes a sender's send-id from every target's queue (the
  original only looked in the sender's own queue, so a delayed send to another session was uncancellable).
- **Durability is per session**: an item's send to its project is durable once the project's step is saved.
  Within one call that step has already run, so writing `result.snapshots` together makes both durable at
  once. A due event for a session the engine does not hold is dropped (reported `delivered:false`): after a
  restart, load every session of a project before the first `send`/`fireDue`.
- `data.at` is always the engine clock (the call's `now`), overwriting any caller-supplied `at`.

## Step limit

One event (or a start) may take at most `maxMicrosteps` microsteps (default 200; the replay's longest real
event takes 5). The next one throws a typed error instead of looping: `:sova/step-limit` in CLJS
(`engine/bounded.cljs`), `StatechartsStepLimitError` (`code: "sova/step-limit"`, with the session, event,
configuration and the transitions it was about to take) through the TS wrapper. The whole call is rolled
back: sessions, generations and the queue are as before it, so the snapshots the host last wrote stay true.
The library's own guard only logs after 1,000 eventless iterations and `before-event!` repeats that up to
1,000 times, so without the bound an eventless cycle (mutant M34) blocked the replay for over 15 minutes.

How it counts: the processor is the library's `v20150901` one (the same three methods, calling
`impl/processing-env`, `impl/initialize!`, `impl/process-event!`), except that the working memory's
volatile counts every newly selected, non-empty transition set, which is one microstep. Every step in a
result reports its `microsteps`. Proven by `an-eventless-cycle-trips-the-step-limit` (CLJS) and "an
eventless cycle throws a typed step-limit error…" (TS), on the probe's `spin/facts` states (M34's shape).

## Open risks

- Library perf is fine at Sova's rate but grows with statechart size (per-event rescans); see the upstream note.
- RC18 is a release candidate. The engine uses `impl/processing-env`, `impl/select-transitions*` and
  `impl/condition-match` (public but in an `-impl` ns) for `trial`/`enabledEvents`, and `impl/initialize!`,
  `impl/process-event!`, `impl/exit-interpreter!` and the `::sc/vwmem` volatile protocol for the step limit;
  an RC bump can move them (the step-limit tests would fail).
- In-flight looks are not resumable (same as escapement): the statechart treats `sova/resumed` as a cut-off.
- Snapshot format is EDN (`pr-str`/`cljs.reader`); fine for plain data. A non-EDN value in statechart data (a JS
  object) would not round-trip; the statecharts keep data to maps, vectors, strings, numbers and keywords.

## Mutation checks (engine)

Each mutation was applied to the engine source, the `:test` build recompiled and run under Node, and the
source restored (`diff` against the backup after each). A mutation counts as caught when an
`engine.core-test` assertion fails.

| # | Mutation | Caught by |
|---|---|---|
| M1 | `cancel!` removes nothing | 4 assertions: exit cancels the timer, history re-arm, dump/load due time |
| M2 | `take-due!` ignores the due time | 14: delayed send, history, invocation, dump/load, order |
| M3 | due events ordered by ordinal only, not time | 1: past-due timers across sessions |
| M4 | `trial` runs on the real env (real queue and callbacks) | **survived at first**; the added "trial touches nothing outside the copy" test now catches it with 6 assertions |
| M5 | outbox not drained from the data model | 1: guards/trial/outbox |
| M6 | `load!` drops the session's queue | 4: dump/load, order |
| M7 | no `:at` stamp on delivered events | 1 (and a statecharts test) |
| M8 | no `:now` in the data model | 1 |
| M9 | cross-session sends not delivered | 23 (engine and statecharts tests) |
| M10 | `enabledEvents`/`trial` ignore guards | 3 |

The TS suite repeats these scenarios against the vendored bundle; the mutations were run on the CLJS suite
because it rebuilds in seconds without touching the vendored file.
