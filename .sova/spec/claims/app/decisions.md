# §app/decisions — Decisions
> Part of the Sova design spec · [overview](../design/overview.md)

Decisions is Sova's **opt-in** classifier: a server-side seam that asks typed questions about a
session and gets typed answers with probabilities. Two features use it — attention signals (the
"needs you" mark, §app.decisions/attention-signals) and session tags (§app.decisions/session-tags).
Both are **off by default**, and nothing leaves the machine while both are off.

The seam is provider-neutral. **Jev** (TypeSafe's classifier, `api.typesafe.ai`) and **one
configured model** (a pi model or a Claude Code model, the same backend/model/effort tuple the
Delegate and Spec pickers store) are two interchangeable providers; a chain picks between them.
Nothing above the seam names a provider: the features see only answers and, for display, which
provider gave them.

Sova-owned state under `<stateRoot>`: `decisions.json` (settings), `secrets/jev-key` (the key),
`signals.json` (classified turns), `session-tags.json` (tags), `decisions-calls.jsonl` (the call
ledger, §app.decisions/call-ledger). All are sidecars: no decision ever
writes a byte into a session file. All writes are atomic tmp+rename, except the ledger's
appends (one line each).

## §app.decisions/interface — The decision interface

- A request is `{purpose, state, questions}`. `state` is text only: a string, or JSON built from
  strings, numbers and booleans — never images. Each question is one of three types:
  - **boolean** → an answer `p`, the probability of yes (0..1);
  - **choice** over 2..255 named options → the chosen option, a probability per option and a
    confidence;
  - **score** over 2..10 ordered levels → the expected level (0..n−1), a probability per level and
    a confidence.
- Confidence is computed the same way for every provider, from the returned distribution:
  `(n·peak − 1)/(n − 1)`, clamped to 0..1 — so the features' thresholds mean the same thing
  whichever provider answered.
- Answers are validated before a feature sees them: every question id answered, probabilities
  clamped and renormalised, unknown options rejected. A provider either answers every question or
  fails; there are no partial answer sets.
- Questions are validated before any network call (option and level counts, non-empty
  instructions). A malformed question is **Sova's own bug** (`bad-request`) and never falls through
  to another provider, which could accept it silently and hide the defect.
- Failures are named: `unavailable`, `auth`, `quota`, `rate-limit`, `overloaded`, `timeout`,
  `network`, `too-large`, `bad-request`, `malformed-answer`, `server`.

## §app.decisions/providers — Providers and the chain

- **Order.** Jev first, when its switch is on **and** a key is stored; then the configured model,
  when one is set. Jev's switch is independent of the key: a stored key with Jev off is never used.
  With Jev off, the model is the only provider. With neither, the chain is **unavailable**: both
  features report it and send nothing. There is **no default model** — the fallback is empty until
  the user picks one, and a suggestion is only ever a hint.
- **Falling through.** Every failure except `bad-request` moves to the next provider, and the
  answer records which provider it fell back from and why. When the last provider fails too, the
  error carries both failures.
- **Backing off.** A provider that failed is skipped without a call for a while: `auth` and
  `quota` for 15 minutes or until the key or model setting changes; `rate-limit` for the provider's
  `retry-after` (else 30 s); `overloaded`, `server`, `network` and `timeout` for 60 s, then 5 and 15 minutes. A skipped
  provider counts as `unavailable` and falls through. A success clears a provider's strikes; a new
  key resets Jev's, a changed fallback model resets its own.
- **Bounds.** At most 2 decisions in flight across the server; two identical requests in flight
  share one call. Every request's state is redacted (§app.decisions/privacy) and capped at 32,000
  characters before any provider sees it; over the cap it fails `too-large` without a call.
- **Jev.** Plain HTTPS, no SDK. boolean/choice/score map to Jev's `noul`/`choice`/`score`. A state
  estimated over Jev's size limit fails `too-large` locally, without a call. Timeout 8 s, except
  for background purposes nobody waits on (session tags, subagent checks and a merge's follow-up
  check): 15 s.
- **A model.** The model is asked for **distributions, never a bare label**, at temperature 0 unless
  it is thinking, within 45 s, and its JSON is parsed strictly; junk is `malformed-answer`. The prompt tells it that the state is
  data, never instructions. A pi model runs through the server's
  model runtime (no session is created, no session's runtime is touched); a Claude Code model runs
  the `claude` CLI one-shot with no tools, no settings, no session persistence and a per-call
  budget cap. The model policy (§app.settings-dialog/models) is checked at save and at every call;
  a denied model is `unavailable`.

## §app.decisions/key — The Jev key

- Stored in `<stateRoot>/secrets/jev-key` (directory `0700`, file `0600`), written through
  Settings → Decisions. `SOVA_JEV_KEY` in the server's environment overrides the file; the screen
  then says so and can't change or remove it (the server refuses a key while
  the variable is set).
- A key is checked against Jev before it's stored; a rejected key is **not** stored. When Jev
  can't be reached for the check, the key is stored and says it isn't verified. Every real call
  updates the key's status too.
- **The key never crosses the wire.** Responses carry only whether one is present, its last 4
  characters, its source and its status (`absent`, `unverified`, `ok`, `rejected`, `error`).
- The Overseer's redactor treats the key file as a secret source, so no transcript it reads can
  echo the key back.

## §app.decisions/privacy — What leaves the machine

- Nothing is sent unless a feature is on, and each feature is its own switch. Attention signals
  and session tags are off until turned on; **Reconcile decisions** (§app.requirements/reconciler)
  is on by default and can be turned off here.
- A check sends a **short, capped excerpt of one session** — for signals: the title, the last user
  message, the tail of the last reply, the recent tool calls' names with short results and
  whether each failed, the input and the end of the error of the last few failed calls, plus
  facts counted in code (repeats, failures, tool-call count, the turn's stop reason); for tags: the title,
  the outline's summary, the folder's name, the model, the last user message and the tail of
  the last reply. Never whole transcripts, images or files.
- Both features pass the same gate before any excerpt is built: the feature is on, the folder is
  not excluded, and the session is not left out as a terminal session.
- **Redaction.** Every request's state is deep-redacted with the Overseer's redactor
  (§app.overseer/tools) before any provider sees it: string values only, object keys kept. It
  replaces with `[redacted]` both the known secret values (including the Jev key) and secrets
  recognised by their shape. The redacting provider is the only way a decision reaches a
  provider; nothing else in the server can call the chain or Jev directly. The 32,000-character
  cap applies after redaction.
- **Exclusions**: sessions under any listed folder are never sent, matched on whole path
  segments (`/a/b` excludes `/a/b/c`, never `/a/bc`; a leading `~/` is the home folder). **Never send
  TUI sessions** (a switch) leaves out every terminal session: one open in a TUI now, or one
  started outside Sova that this server doesn't host — so a turn isn't sent right after its TUI
  exits, and the backfill never sends closed terminal sessions. The Overseer's own
  sessions and worker sessions' files are never classified as sessions, and a baton session
  (§app/baton) — outsiders' words — is never sent for signals or tags.
- **Reconcile** sends only the decisions recorded in a project's baton sessions: each one's
  statement, quote, author's name, date and area — never a transcript, goal, briefing, profile
  field, id or path — through the same redacting provider, and never for a project whose folder is
  excluded.
- The Settings tab states, in one sentence above the switches, what is sent and to whom.

## §app.decisions/attention-signals — Attention signals

- **When.** Once per finished turn. A hosted chat is checked about 1.5 s after its turn settles;
  every other session (open in a TUI, or hosted by another server) is found by a 10 s scan of the
  session list for a newer reply on an idle session, at most 6 checks per scan. A turn the scan
  first sees is checked only if it ended within the last 30 minutes: switching the feature on does
  not check old turns. A session is checked at most once per last-assistant entry on its active
  branch (the `turnId`); a rewind or a new turn changes it. A branch ending on a tool call is
  mid-turn and not checked. A turn whose last reply stopped with an error (`stopReason` error) is
  not checked either: whether a turn failed is a fact of the file (§app.overseer/seen), never a
  question; the stored answers of the turn before it are dropped, since a newer turn replaces them.
  The scan skips such a turn on the list's cached `stopReason` alone, without reading the file.
  A failed check stores nothing and is retried after 5 minutes, at most 3 times per turn (a
  `bad-request` never).
- **Which sessions.** Those the privacy gate lets through (§app.decisions/privacy), except the
  Overseer's, worker sessions, baton sessions (§app/baton: their Needs-you item comes from the
  baton itself) and archived sessions.
- **TUI sessions are read, never written**: Sova's own parser reads at most the last 1 MB of the
  file; nothing is ever appended to any session file.
- **The excerpt**: the title (≤200 characters), the last user message (≤2,000), the end of the
  last reply (≤4,000), the last 8 tool calls (≤120 characters each, the result else the input, no
  success or failure mark), the turn's error message when the reply carries one (≤300), and
  repeats counted in code. Nothing in it counts or marks failed tool calls: a failure the agent
  worked past (an exit-1 `grep -c` that found nothing) read as a failed turn.
- **Questions** (raw answers stored in `<stateRoot>/signals.json`, pruned when a session leaves
  the list): `stuck` (score over making progress / some repetition / clearly looping), asked only
  for a turn of 5 minutes or more, or 20 tool calls or more, and never for a turn whose tool calls
  are mostly waits (`agent_wait`, `wake_nudge` and the `team_*` tools): a parent waiting on its
  workers is long, not looping. `asks_user` (§app.decisions/asks-user) is asked of a turn whose
  reply looks like it asks. A turn with neither asks nothing and makes no model call; like an
  errored turn, it drops the stored answers of the turn before it. The instructions add that
  waiting is not looping: a scheduled wake-up, checking a roster or inbox and scheduling the next
  check, or waiting on other workers is progress when each cycle is short, and only this turn is
  judged.
- **Thresholds, fixed in code:** `looping` when `stuck ≥ 1.5` with confidence ≥ 0.5; `asks-you`
  when `asks_user ≥ 0.5`. The wire carries the kinds with the raw answers; the server derives the
  kinds and the client never re-derives them. Records stored before may still hold `outcome` and
  `work_failed` answers: nothing reads them, and no kind comes from them.
- **Workers**, pi and Claude Code alike, are judged on their **current turn** only: the items
  after the last task or steer item, its start being that item's time. A worker whose current turn
  has run 5 minutes or more is considered at most every 5 minutes; a worker that ended is never
  checked (one that ended in an error is the digest's deterministic `worker-error`,
  §app.overseer/attention-digest). A team member whose duty is `monitor` or `coordinator`, and a
  turn a wake nudge started, are never checked: they poll by design. A check first counts in code:
  only a turn with the same tool and arguments 3 or more times in a row, or one running 15 minutes
  or more whose last 3 tool results are all errors, is asked `stuck`; any other is stored as making
  progress without a model call. The excerpt says what started the turn and how long it has run.
  A worker is stored per parent session and worker id (`ag_NN` alone repeats across sessions;
  records keyed by it alone are dropped on read). A looping answer counts only when the check
  before it, in the same turn, was looping too (two strikes); a non-looping answer resets it. The
  parent session carries a count (`workerSignals`: stuck); details go to the attention digest. A
  subagent's check counts until the parent session is seen after it (or is on screen), and stops
  counting 11 minutes after it, so a worker that stopped running stops counting. A stored worker
  "outcome" check from before is dropped on read.
- **Showing and clearing** is decided on the server: a session's `signals` are sent only while it
  has a kind, the feature is on, it is not running, and — for every kind but `asks-you`, which stays
  until the user answers (§app.decisions/asks-user) — no pane has it open and it hasn't been seen
  since it was checked (the seen store, §app.overseer/seen); a newer turn replaces them. Switching
  the feature off hides every mark and keeps the stored answers. The row's mark is
  §app.session-list/anatomy; the Overseer's view is §app.overseer/attention-digest.

## §app.decisions/asks-user — Does the reply ask the user?

- A finished main-session turn is asked one boolean, `asks_user` ("does the reply end by asking
  the user a question, or for a decision, approval or information it needs before it can go
  on?"), only when all of these hold: the session has **no open alignment question**
  (§chat.alignment/session-mark: those already put it in Needs you); a partner's link message did
  not open the turn (its question is to the partner); and the reply's end looks like it asks.
- **Looks like it asks** is counted in code on the last 1,000 characters of the reply, after the
  closing spec lines (`Also changes:`, `Deferred:`, `Plumbing:`, `Spec check override:`) are cut:
  a question mark, or a phrase such as "should I", "shall I", "want me to", "do you want", "would
  you like", "tell me", "let me know", "say if/when/which", "if you want", "your call", "up to you",
  "confirm and", "once you say", "after you confirm" or "say yes". A reply without one makes no model call for it.
- The excerpt for this question alone is the title, the head of the last user message (≤600
  characters) and the tail of the reply (≤1,500), after the closing spec lines are cut. A long
  turn asked `stuck` too sends one request with both questions and the stuck excerpt.
- At `asks_user ≥ 0.5` the turn's kind is `asks-you`. The reply's asking sentence (of its last
  three sentences, the last that ends in "?", else the last), redacted and at most 160
  characters, is stored with the answer for the attention digest only; it never reaches the
  session list or the feed.
- It shows while the feature is on and the session is idle, and, unlike the other signals, a look
  does not clear it: opening or viewing the session leaves it, as with open questions. It clears
  when the user answers (a turn runs, and the next turn replaces or drops it) or the session is
  archived. An open alignment question that appears later takes its place in Needs you.

## §app.decisions/team-stall — A team gone quiet

- Counted in code, never asked of a model, by the attention signals' 10 s scan while the feature
  is on: a session **waits on a stalled team** when all of these hold —
  - it is idle (not running a turn), not archived, and not an Overseer, worker or baton session;
  - it has live subagents, at least one of them neither killed nor a team member whose duty is
    `monitor` or `coordinator`, and none of them is working;
  - the end of its last reply (after the closing spec lines) says it waits on them: "still
    running", "in progress", "when it arrives", "once the verifier signs off", "reports to me",
    "will send me", "as they come", "waiting on the team" and the like;
  - nothing has happened for 15 minutes: not its last reply, and no subagent's last activity
    (monitors' and coordinators' check-ins never count).
- It is stored in `<stateRoot>/signals.json` with the time the quiet began and the quiet
  subagents' names, re-checked every scan, and dropped as soon as any condition fails.
- The attention digest shows it as an **act** item of the session (Needs you, the Overseer's
  count and briefs), kind `team-stalled`: "Waiting on {names}, quiet for {n} min.", dated by when
  the quiet began — unless the session already has an `open-questions` or `asks-you` item. It is
  not a phone notification kind: the notifier tells it without sending (§app.notifications/delivery).

## §app.decisions/call-ledger — The call ledger

- Every decision request that reaches the chain appends one line to
  `<stateRoot>/decisions-calls.jsonl`: when, the purpose, the provider and model that answered (or
  the failure's name and provider), the latency, the reported token usage, and whether it fell
  back. Never the state, the questions, the answers, the dedupe key or the key.
- A request refused before the chain (over the size cap) is logged as `too-large` with no
  provider.
- The file is capped at 4 MB: when a write would pass it, the file moves to
  `decisions-calls.jsonl.1` (replacing the older one) and a new file starts. A failed write is
  ignored; it never fails the decision.

## §app.decisions/session-tags — Session tags

- Each session gets a **topic** from a fixed taxonomy — feature, bugfix, refactor, tests, docs,
  infra, research, planning, review, data, config, experiment, chore, other — and a **throwaway**
  probability (a test or scratch session with no lasting work). The taxonomy is not editable; the
  classifier never invents labels. There is **no status tag**: whether work is done, ready or
  waiting is the worktree readiness (§chat.worktrees/readiness), from git and the file. A status
  answer stored before stays readable in the store and is never sent or shown.
- **Input** comes from what the session list already reads (the file's head and tail, never a
  full read): the original first message, the outline's summary and "now" line, the folder's name,
  the model, how long it ran and how long it has been idle (both computed in code), the last user
  message (≤600 characters) and the end of the last reply (≤1,500), redacted before it leaves.
- **Shown** only when confident: topic at confidence ≥ 0.5 and inside the taxonomy;
  throwaway at P(yes) ≥ 0.75. Anything below is absent on the wire; the raw answers are stored.
- **Which sessions**, for live tagging and the backfill alike: those the privacy gate lets through
  (§app.decisions/privacy), except the Overseer's, workers', baton sessions (§app/baton) and
  never-sent drafts; a session
  mid-turn waits until it settles.
- **When.** A live pass runs every minute and about 3 s after a hosted turn settles. It tags only
  sessions with a reply since tags were switched on; switching tags off forgets that moment, so
  switching them on again never silently sends the gap — older sessions are the backfill's job.
  A session is not re-sent for the same last reply; a new reply re-tags it only when an hour has
  passed since its last tagging, so a long-running session is re-tagged at most hourly. A session
  whose check failed is not retried by the live pass for 15 minutes. The pass stops as soon as
  the chain is unavailable.
- Stored in `<stateRoot>/session-tags.json`, keyed by session id, with the basis it was tagged on.
- **Manual tags**, per session (`POST /api/sessions/tags`): trimmed, lowercased, a leading `#`
  dropped, deduplicated, letters, digits and `-`, at most 32 characters each and 8 per session;
  an empty list or `null` clears them. They are kept apart from the classifier's and always shown.
- The row shows no tag word; its line 3 carries the readiness badge instead
  (§app.session-list/anatomy). Search matches topic and manual tags (§app.session-list/search).

## §app.decisions/backfill — Tagging existing sessions

- With tags on, Settings → Decisions offers two scopes: sessions active in the **last 30 days**,
  and **all** sessions, and says a fallback model costs more and takes longer.
- The backfill runs in the background on the server, through the same chain and bounds, 2 at a
  time, over the same sessions as live tagging; one mid-turn when reached is counted done, not
  tagged, and the live pass tags it once it settles. It is resumable: a session already tagged on the
  same basis is counted done and costs nothing, and a job running when the server stops resumes
  at the next start (`<stateRoot>/session-tags-backfill.json`). One backfill runs at a time;
  starting again returns the running one. It refuses to start while tags are off or the chain has
  no provider.
- Progress — sessions done, total, failed — is readable at any time and pushed while it runs
  (§app.decisions/push), at most every half second. It stops early, saying why, when tags are
  switched off, when the chain becomes unavailable (not counted as failures), after 5 failures in
  a row, or when cancelled.

## §app.decisions/push — Live marks

- The server **pushes** signal, tag and turn-error (`turnError`, §app.overseer/seen) changes: the read-only watch socket has a session-less
  feed (`/ws/watch?feed=sessions`) that sends a full snapshot of every session's marks on every connect (even an empty one),
  then one message per change (a signal, tag or turn error set, cleared or pruned), and backfill progress
  while a backfill runs.
- Changes are sent when a store is written or a pane attaches, and the server compares every 5 s
  while a feed is connected, so a turn that starts in a TUI clears its mark.
- The same comparison sends `list_changed` (no payload; never on connect) when a session appears
  in or leaves the list, or a row's live record, running state, last activity, archived flag or
  title changes (a stored title changes in Sova's title store, never in the file: the Overseer's
  rename, the automatic namer's, §app.session-list/auto-titles), or its merge readiness changes
  (read from git in the background, §chat.worktrees/readiness). The sidebar then reads the list again: at once if its last such read was at least a
  second ago, otherwise once, a second after that read, however many more arrive meanwhile. It
  also reads the list after every reconnect of the feed, since the list may have changed while
  the socket was down. The feed adds no polling of its own. So a session started in a TUI reaches
  the sidebar within seconds, without a reload.
- The sidebar holds the feed open while it is mounted. Once the snapshot arrives, the feed's
  signals, tags and turn error replace the list's on this server's rows, matched by session path (rows from mesh peers keep their list
  fields); each change applies at once, and a cleared field is removed. While the socket is not
  open the overlay is dropped and the list poll is the truth again; after the socket stops
  retrying, it tries again when the window regains focus.
- The feed never writes and ignores anything the client sends.

## §app.decisions/merge-followup — One follow-up check per merge

- **What it asks.** Once per merge card (§chat.worktrees/merge-card), on the first reply that ends
  a turn after the card: `follow_up`, a boolean — does the reply name work still to be done beyond
  a restart, push or cleanup (open gaps, a known regression, "I'd fix it separately", unverified
  parts)? — and `follow_up_weight`, a score over none / small / significant.
- **The excerpt**: the branch, target, commits and lines of the card, the reply's last 1,500
  characters, its `Deferred:` line when it has one, and the mechanical follow-ups
  (§chat.worktrees/readiness) as facts so they are not judged again. Redacted before it leaves.
- **When and which.** Only with **attention signals on** and through the same privacy gate
  (§app.decisions/privacy), for the sessions readiness covers, and only for a reply from the last
  24 hours: switching the feature on never checks old merges. A merge is checked at most once; a
  failed check is retried after 5 minutes, at most 3 times. The answer is stored per merge card in
  `<stateRoot>/merge-followups.json`, kept only while its session is listed.
- **Reading it.** Follow-up work when `follow_up` P ≥ 0.5 and the weight's score is 0.5 or more:
  significant at 1.5 or more with confidence ≥ 0.5, else small. The cue shown is the reply's own
  first line naming open work, else its `Deferred:` line, else "see the reply after merging
  {branch}". The model never writes
  the follow-up; it only says whether there is one and how much.
