# Org charts: event vocabulary (refit)

The events the eleven refit charts take, their payloads, the effects they emit and what the host
answers. Owned by `charts` (`org-charts/src/sova/org_charts/charts/`); CHARTS.md maps each chart
element to the inventory. The engine's contract is `engine/API.md`.

Conventions at the JS boundary: event names are `"ns/name"` strings (keywords inside); payload and
envelope keys are camelCase in TS and kebab keywords in the charts; values stay strings, numbers and
booleans. Times inside charts are epoch ms (`at` on every delivered event; the host converts to ISO in
its projections). Session ids: `<chart>/<org>[/<project>]/<id>` (`base.cljc`). New ids (people,
projects, sessions, offers, decisions, conflicts, gaps) are minted by the host and passed in the
payload: the charts are deterministic.

A refusal is `{sentence, status (400·404·409·410), code?, tail?}`; `tail` reaches the model only.

Feed classes (r8a): every transition declares `:sova/feed`. `:feed`: every act (taken, refused or
held), every move of where an item stands (a state change of the course, lane, decision, conflict,
tenure, build setup/merge/tree), anything that reaches a person or code. `:quiet`: timer re-arms,
lease renewals, reply/turn bookkeeping, fact mirrors (link/moved, facts/changed, settings), the budget
region, the owner-update gates, the whole watch loop but Run Now, the residence's commit/push loop,
every reconciler step but its acts, queued-send flushes. registry-test enumerates them; feed-test pins
one of each per chart.

## The envelope (every act)

Stamped by the host (`server/org-envelope.ts`) inside the org's serialized step:

| key | meaning |
|---|---|
| `by` | `operator` · `overseer` · `system` · `model` (a gathering's model) · `person` · `wrapup` · `chart` (the chart's own act, r3) · `sova` (Sova on its own: a settle session's reconcile) |
| `via` | `"overseer"`: the global Overseer acting for the operator (with `overseerId`, `card`) |
| `attended` | the operator's turn (their message entered the overseer's context, W20) |
| `autonomy`, `paused`, `rosterActive` | the level in force (`rules/levels.cljc effective-autonomy`: paused → L0, no active person → L0, else the setting) |
| `archived` | the project's shelf |
| `allowance {gather,promote,create,prompt: {used,max}}`, `ledger` | the ledger this turn draws on (message when attended, else day); `used` includes pending holds of the kind but the one being released (F2) |
| `atOnce {gatheringsOpen,gatheringsCap,codingRunning,codingCap}` | counted from chart states (+ pending holds that would open one) |
| `card {people,projects,sessions}` | the confirm card of the global Overseer's turn |
| `holdMs` | the project's hold (`holdMin` × 60 000; 0 = no hold) |
| `invalid` (+ `invalidStatus`) | the host's own argument refusal (name resolution, abilities and mode ceilings, a folder, a root, field shapes) — the chart refuses with it where today's code checks it |
| per act | `target {id,name,status,referral?,tz?,hours?}` / `targets [..]` (r7: every person an act reaches, with their zone and hours), `namesTaken [lowercased]`, `ownerAreas [..]`, `chosen` (hand_to's holder-chose, a transcript check), `live` (a terminal holds the session), `leak` (the owner update's 24-char backstop sentence), `ownerActive`, `buildFinishedAt`, `blockers {gatherings,coding,overseerWorking}`, `authorOwnsArea`, `operatorName`, `projectName` |

Level refusals come first (engine, `registry/options :level-check`): the operator's click, a person, a
gathering model, the wrap-up and the system are never level-checked; `overseer` and `chart` acts are
checked against the level in force (a chart act is never attended). Holds (q10, r4, r6): an act whose
registry entry says `hold: true` is held when not the operator's click, not attended and `holdMs > 0`;
at the hold's end it is delivered again with a fresh envelope and every check re-runs (F2).

## org (`org/<org>`, portable)

Start: `{id, name, slug, createdAt, holder: {hostId, hostName, since}}`.

| event | by | payload | notes / refusals |
|---|---|---|---|
| `org/rename` | op | `{name}` | "name must be 1–80 characters" (400) |
| `project/add` | op | `{projectId, name, root}` + `invalid` (root rules) | spawns `project/<org>/<projectId>` |
| `person/add` | op | `{personId, person: PersonInput, byKind?}` + `namesTaken` | `rules/person apply-change` (caps, "{name} is already on the roster." 409); spawns `person` active |
| `owner/set` | op | `{personId \| null}` + `target` | "Only an active person on the roster can be the owner." (400); same person: nothing; effect `revoke-owner-links {why: owner-changed}` |
| `holder/claim`, `holder/release` | residence | `{hostId, hostName, since}` / `{hostId}` | r1: the holder record |
| `link/moved` (person) | engine | | the owner left → `owner-cleared`, effect `revoke-owner-links {why: left}` |

About (`about.md`, `org-history.jsonl`) is plain data written by its route; never a chart event.

## residence (`residence/<org>`, host-local)

Start: `{orgId, orgName, hostId, hostName, mode: "create"|"attach", commitEveryMs?}`.
Effects: `read-holder {fetchMs}` → `effect/done {result: {local, remote}}` (holder records, or failed:
unreachable remote, the clone's alone was read); `commit {message?}` → `{result: {headAt, pushFailed?, error?}}`;
`push`; `pause-overseers` (attach only); `revoke-owner-links {why: detached}`.
Acts: `attach/confirm` (op, in `held-elsewhere`), `org/detach` (op), `commit/now` (op).
Host events: `store/written`, `commit/look` (its own 1-min timer). The attach route answers 409
`code: "held"` with `held-sentence(heldBy)` while in `held-elsewhere`.

## person (`person/<org>/<pid>`, portable)

Start: `{orgId, id, person (cleaned), changed [{field,from,to}], by: ChangeBy}` (from `org` or a baton's referral).

| event | by | payload | notes |
|---|---|---|---|
| `person/edit` | op · wrapup · overseer | `{patch, byKind?, sessionId?, entryId?, quote?}` + `namesTaken` | a `status` in the patch is the lifecycle move (one transition per pair); field authority "A {kind} change may not write {field}." (409) |
| `person/approve`, `person/decline` | op · overseer (L2 `sova_roster`, held unattended) | | "{name} is not waiting for approval." / overseer: "{name} is {status}, not proposed." (409) |
| `person/leave` | op (GO: card) | | |
| `person/revert` | op | `{row: {at, field, from, to}}` (read from roster-history.jsonl) | "No such change" 404; creation 409; C6 "{name}'s {field} has changed since then, so reverting this would undo a later change. Revert the latest change instead." (409) |

Effects: `roster-history {personId, lines, by, revertOf?}` (the host appends with a unique `at`),
`revoke-person-links {personId}` (entry of `left`). Exported: `name, decides, referral, status, tz, hours`.

r7 working hours: `person/edit {patch {tz, hours}}` (the operator's; history lines like contact, not
private): `tz` an IANA zone ("" clears), `hours {days [0–6, 0 = Sunday], from "HH:MM", to "HH:MM"}` or
null (`to` ≤ `from`: overnight). Refusals (400): "tz must be an IANA time zone, like Europe/Istanbul",
"hours must be { days, from, to } or null", "hours.days must list days 0–6 (0 is Sunday), each once",
"hours.from and hours.to must be times like 09:00", "hours.from and hours.to must differ". The pure
`rules.hours/next-window [person nowMs] → ms | nil` (nil: in hours or no hours) is what the server's
`hoursNow {open, nextOpen?}` reads. Acts that reach a person carry `:hours` (baton `hand-to`,
`handoff`, `offer`; conflict `reroute`; project `baton/start`; item `gather/start`): the
engine holds an automatic or unattended one until the window (`wait: "hours"`), the operator's goes at
once with `offHours`. Several people: it goes when any of them is in hours.

## project (`project/<org>/<p>`, portable)

Start: `{orgId, id, name, root, createdAt, origin}`; spawns `reconciler/<org>/<p>` and `watch/<org>/<p>`.

| event | by | payload | notes |
|---|---|---|---|
| `project/edit` | op | `{name?, root?, ownerHidden?}` + `invalid` | |
| `spec/freeze` | op | `{frozen}` + `invalid` ("spec must be { frozen: boolean }") | |
| `project/archive` / `project/unarchive` | op (GO: card for archive) | + `blockers` | "Stop these first: {list}." (409); idempotent |
| `overseer/start` / `overseer/clear` | op | `{conversationId}` | clear keeps ≤ 20 earlier; sends `ledger/reset-message` to the watch |
| `stakeholder/set` | op | `{personId \| null}` + `target` | "Only an active person on the roster can be a project's main stakeholder." (400) |
| `owner-update/post` | overseer (L1, held unattended) · op | `{text}` + `ownerActive`, `leak`, `buildFinishedAt` | today's order: owner, blank, 2,000, leak, then unattended only: 24 h ("An update was posted {…}: at most one a day."), milestone; effect `owner-update {text, run}` |
| `gap/file` | overseer (L0 `sova_idea add §gap/…`) | `{gapId (g_…), ideaId}` | spawns `item/<org>/<p>/<gapId>` |
| `milestone/noted` | baton · decision · build | `{kind, shown}` | |
| `baton/start` | op · overseer (L1, `gap: "none"`, held) · GO (card: the project and every person) | BatonStartInput + `sessionId` | "{project} is archived. Unarchive it first." (409); caps; spawns a baton |
| `build/start` | op · overseer (L3, `gap: "none"`, attended only: q7) · GO | `{sessionId, title?, prompt?, model?, thinking?, mode?, opItem?, folder?}` | q7: "Without a gap, a coding session starts only in a turn the operator started: …"; spawns a build |
| `session/prompt` | overseer (L3 `sova_send`, held; confirm kind `prompt`) · op | `{sessionId, title, text, mode?}` + `live` (a terminal holds it), `invalid` (the mode check) | "\"{title}\" is open in a terminal, so it is read-only.", "text must not be blank."; caps (a prompt); effect `prompt {session, text, mode?}` (`session`: an effect's own sessionId is the chart's). A coding session under the root that is NOT a build (a build's is `build/prompt`); never a gathering (F-128, r10) |

Owner-update withdraw (`updates.jsonl`) is plain data: its route, no chart event.

r11 started list: data/exported `started [{sid, kind gathering|offer|coding|operator-coding, at, settled}]`,
oldest first: its own `baton/start`/`build/start` and its items' (`started/noted {sid, kind}`, from the item;
the project then watches it). Settled (from the session's link): a gathering done/closed whose wrap-up is
done or skipped; a build merged or tree removed with no turn running. Past 200 the oldest settled rows get
`session/retire` (the baton/build goes to its final `retired` state only if settled; the host archives a
final session); never a live one: the list exceeds 200 only while more are live.

## watch (`watch/<org>/<p>`, host-local)

Start: `{orgId, projectId, paused?, settings?, tickOrigin?, tickMs?}` (the host starts it paused at attach).

Host events: `facts/changed {rosterActive}`, `settings/changed {settings}` (overseer.json as read),
`operator/level-set {resumeAt}` (ends a pause; not `autonomy`, the envelope's level in force), `org/attached-here`, `turn/started {look}`,
`turn/user-entered` (the operator's message entered the context: the per-message ledger resets),
`turn/ended`, `reason/noted {kind, params, key, by} | {reasons: [..]}`, `ledger/take {kind, n, ledger, by}`,
`ledger/reset-message`, `limit/refused {kind, ledger, used, max}`, `look/finished`, `look/stopped {detail}`,
`look/not-started {detail}`, `look/skipped {detail}` (a refused Run Now, recorded), `sova/resumed`.
Acts: `operator/run-now` (409 "Not started: {why}." / archived "{project} is archived. Unarchive it to use its overseer.").
Invocation `:sova/look {reasons, autonomy, text (watchText), projectId}`.
Exported: `paused, rosterActive, archived, looksToday, lastRun, held, reasons, ledgers, settings`.

## baton (`baton/<org>/<sid>`, portable)

Start: BatonSession's fields (`orgId, projectId, sessionId, owner, goal, publicTitle, question, briefing,
to | targets, model, thinking, messagesMax, abilities, parent, conflict, startedVia, mintLink, opItem,
names, operatorName, leaseMs`). Effects at birth: `create-session`, `mint-links {n, offerId?}` (unless
`mintLink: false` or to the operator).

| event | by | payload + envelope | refusals (today's) |
|---|---|---|---|
| `baton/hand-to` | model | `{target, chosen, question, briefing}` + `invalid` | "This conversation is {state}.", target, holder-chose, "Give the question…", "They already hold the baton.", the limit |
| `baton/goal-done` | model | `{summary}` | "Give a summary of what was established.", "This session is already {state}." |
| `baton/record-decision` | model | `{decisionId, area, areaKey, ownerArea, statement, quote, entryId, markerId}` + `ownerAreas` | "Give the area, the statement and their exact words.", owner area; spawns `decision`; a settle session sends `reconcile/request {delayMs: 2000, by: sova}` |
| `baton/propose` | model | `{personId, name, role, contact, why, quote, decides?, same}` + `namesTaken` | the referral's name and completeness refusals; spawns a proposed `person` |
| `baton/message` | person · operator | `{from, active}` | "It's not your turn anymore." (`taken`), "Someone else is answering right now." (`taken`), budget (`budget`), "You are no longer taking part…" |
| `message/refused` | host | | the runtime refused it after all: undone (503 busy counts nothing) |
| `baton/take-back`, `baton/handoff {target, question, briefing}`, `baton/offer {targets, question, briefing, offerId}`, `baton/withdraw` | op (GO: card) | | while a reply runs: effect `stop-reply`, the move waits for `reply/ended` and is checked again |
| `baton/close` | op · overseer (L1 `sova_close_gathering`, held) · system · chart (the r3 move) | `{reason, ownerProject}` | overseer's order: reason, own, settle, ended, wrote |
| `baton/extend {more}` (the route's `by`; `by` is the envelope's actor), `baton/abilities {abilities}`, `baton/hide {hidden}`, `baton/wrapup-retry` | op | | |
| `budget/recount {n}` | host | | never raises |
| `reply/starting`, `reply/writing`, `reply/ended` | host (chat layer) | | |
| `wrapup/finished {applied, refused}`, `wrapup/stopped {detail}` | host | | invocation `:sova/wrapup {sessionId}` |

Effects: `baton-entry {type: handoff|offer|lease|done|proposal, …}` (the transcript entry), `mint-link`,
`mint-links`, `revoke-links {all|offerId, why}`, `stop-reply`.
Exported: `course, holder, needsYou, offerId, offers, wroteAt, owner, conflict, decisions, publicTitle,
budget, hiddenFromOwner, wrapup, handoffs, participants, reply, createdAt, closedAt`.

## decision (`decision/<org>/<p>/<did>`, portable)

Start: `{orgId, projectId, id, area, areaKey, ownerArea, statement, quote, by, name, sessionId, entryId,
markerId, item, resolves, shown, recordedAt}`. Tells its reconciler at birth (`decision/recorded`).
Host/chart events: `reconcile/result {state: pending|conflict|drafted|superseded, recordId?, supersededBy?,
folded?, checkedWith?, authorOwnsArea?}`, `promote/done {textHash, commit}`, `spec/facts {recordPresent,
fieldsMatch, editedInSpec, build}`.
Acts: `decision/owner-area {ownerArea}` (+ `ownerAreas`, `authorOwnsArea`, `operatorName`),
`decision/settle-text {action: keep|restore, textHash}` (effect `restore-text`).

## reconciler (`reconciler/<org>/<p>`, portable)

Acts: `reconcile/request {delayMs, by, owner}` (op · overseer L1 `sova_reconcile` · GO · sova · chart),
`decision/promote {ids, bulk?}` (op · overseer L2 `sova_promote`, held · chart), `draft/rewrite` (op),
`correct/clear-failed {reason}` (L1). Host events: `settings/reconcile {on}`, `reconcile/finished
{decisions [{id,…result}], conflicts [{id, a, b, area, areaKey, ownerArea, p, routedTo, routeReason,
selfAsserted?, routeError?, batonSessionId, model?, thinking?}], resolved [{id, outcome, resolvedBy}],
compared, draftedIds, error?}`, `reconcile/stopped {detail}`, `settle/results {decisions}`,
`decision/owner-area-changed`. Invocation `:sova/reconcile {by, owner, projectId}`.
Effects: `promote {ids, refused, by, byActor, ledger}` → `effect/done {result: {promoted, refused,
commit, textHashes}}`; `draft`; `route-conflict-of {decisionId}` (the host re-routes and sends
`conflict/reroute {…, keepIfSame: true}`).

## conflict (`conflict/<org>/<p>/<cid>`, portable)

Start: the reconciler's conflict row (above) + `{owner, operatorName, createdAt}`; spawns its settle
baton (`mintLink: false`).
Acts: `conflict/reroute {to, sessionId, routeReason?, selfAsserted?, keepIfSame?}` + `target` (op, GO card)
— "Route to an active person or the operator" (400); `conflict/settle {keep | statement, decisionId}`
(op) — effect `settle` → `effect/done {result: {decisions}}`. Host event: `conflict/resolved {outcome,
resolvedBy}`. Settled: "That conflict is resolved" (409).

## item (`item/<org>/<p>/<g_id>`, portable)

Start: `{orgId, projectId, id, ideaId, stallAfterMs?}` (spawned when the overseer files a `§gap/…` idea).
Acts: `gather/start {sessionId, to|targets, publicTitle, question, goal, briefing, …}` (overseer L1, held;
op; GO: card lists the project and every person), `gather/plan {…same}` (overseer L0: a planned gathering), `build/start {sessionId, title?, prompt?,
decisions?}` (overseer L3, held; op), `gap/drop {fromIdea?}` (L0 `sova_idea`; op), `item/hold`,
`item/resume` (op only), corrections `correct/reopen`, `correct/skip-stall`, `correct/relink {session,
toItem}` (L1, `sova_correct`), `hold/cancel {id, reason}` (L0). Host/chart events: `link/moved` (its
batons, decisions, builds, its watch), `item/adopt {session}`, `item/stalled` (its own timer).
Drive (`dsl/drive`, by chart): `reconcile/request` and `decision/promote` to the reconciler,
`build/start` and `gather/start` to itself, `baton/close` to a baton.
Effect: `idea-status {ideaId, status: dropped}`.

## build (`build/<org>/<p>/<sid>`, portable)

Start: started.json's row `{orgId, projectId, sessionId, kind, title, prompt, startedBy, via, gap, item,
decisions, model, thinking, mode, opItem, folder, createdAt}`.
Setup effects in order: `make-worktree` → `{result: {branch, base, target} | {inRoot}}` (failed: not
started, "No session was started: its worktree could not be made ({line})."), `set-mode` (failed:
`modeNotSet`), `first-prompt {prompt, branch, target}`.
Host events: `turn/started`, `turn/ended {failed}`, `workers/changed {n}`, `git/probe {tree, branch,
ahead, dirty, newSinceMerge, branchGone, error}`.
Acts: `build/prompt {text, mode?}` + `invalid`, `live` (overseer L3 `sova_send`, held; op),
`build/merge` + `elsewhere` (op only) → effect `merge` → `effect/done {result: {commit}}` |
`effect/failed {detail}` (git's refusal, today's words); `build/remove-worktree` → effect
`remove-worktree`; `correct/merged {commit, reason}` (L2).
Exported: `…, turn, workers, running, tree, branchState, merged, lastTurnAt`.

## Reasons (to the watch)

`reason/noted {kind, params, key, by}`; kinds and sentences in `reasons.cljc`: baton/done, baton/closed,
baton/proposal, baton/asked-operator, reconcile/{conflict,resolved,drafted,promoted}, coding/settled,
build/merged, build/merge-refused, held/{looks,day,message,raised}, item/{stalled,built}, hold/review.
`key` is typed (C3). A reason sent in a step whose event is `by` chart (r3, a drive) says `by: chart`,
and the watch never looks for it (R3): it starts no look and uses none, and reaches the overseer as
the next look's feed. item/answered-nothing and item/reopened are feed entries only, never sent (R4);
their sentences stay in `reasons.cljc` for older rows.
