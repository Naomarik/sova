# §app/decisions — Decisions
> Part of the Sova design spec · [overview](../design/overview.md)

Decisions is Sova's **opt-in** classifier: a server-side seam that asks typed questions about a
session and gets typed answers with probabilities. Attention signals use it (the turn card and
the "needs you" mark, §app.decisions/attention-signals), as do the alignment card's triage and
the worker report check, off by default, so nothing leaves the
machine while it is off. Session tags no longer ask it anything (§app.decisions/session-tags).

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
  characters before any provider sees it; over the cap it fails `too-large` without a call. No
  Claude Code one-shot (a decision, a session title, a memory summary) starts with a command-line
  argument over 64 KiB: it fails `too-large` without starting.
- **Jev.** Plain HTTPS, no SDK. boolean/choice/score map to Jev's `noul`/`choice`/`score`. A state
  estimated over Jev's size limit fails `too-large` locally, without a call. Timeout 8 s, except
  for background purposes nobody waits on (a merge's follow-up check and a worker's report
  check): 15 s.
- **A model.** The model is asked for **distributions, never a bare label**, at temperature 0 unless
  it is thinking, within 45 s, and its JSON is parsed strictly; junk is `malformed-answer`. The prompt tells it that the state is
  data, never instructions. A pi model runs through the server's
  model runtime (no session is created, no session's runtime is touched); a Claude Code model runs
  the `claude` CLI one-shot with no tools, none of the user's Claude Code settings (only Sova's
  fixed ones, auto-memory off: §app.claude-code-provider/no-memory), no session persistence and a per-call
  budget cap. The model policy (§app.settings-dialog/models) is checked at save and at every call;
  a denied model is `unavailable`. A call whose provider is at its request limit waits for a slot
  (§app.provider-limits/queue) as background work, and the wait counts toward its 45 s.

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
  are off until turned on (a stored tags switch is read and ignored: tagging asks nothing); **Reconcile decisions** (§app.requirements/reconciler)
  is on by default and can be turned off here.
- A check sends a **short, capped excerpt of one session** — for signals: the title, the last user
  message, the tail of the last reply, the recent tool calls' names with short results and
  whether each failed, the input and the end of the error of the last few failed calls, plus
  facts counted in code (repeats, failures, tool-call count, the turn's stop reason). Session tags
  send nothing. Never whole transcripts, images or files.
- Every feature passes the same gate before any excerpt is built: the feature is on, the folder is
  not excluded, and the session is not left out as a terminal session.
- **Redaction.** Every request's state is deep-redacted with the Overseer's redactor
  (§app.overseer/tools) before any provider sees it: string values only, object keys kept. It
  replaces with `[redacted]` both the known secret values (including the Jev key) and secrets
  recognised by their shape. The redacting provider is the only way a decision reaches a
  provider; nothing else in the server can call the chain or Jev directly. The 32,000-character
  cap applies after redaction.
- **A pasted password is withheld whole.** Before redaction, any text in a request's state that
  names a password, passcode, passphrase, PIN, code, OTP or token next to a value (`pw: hunter2`,
  `password is …`, `token=…`, `code 482913`; for code, PIN, OTP and token the value has a digit)
  is replaced as a whole by `[withheld: may carry a password]`. It is done in the redacting
  provider, so it holds for every provider and every fall-through: no provider in the chain, Jev
  or the configured model, ever sees that text.
- **Exclusions**: sessions under any listed folder are never sent, matched on whole path
  segments (`/a/b` excludes `/a/b/c`, never `/a/bc`; a leading `~/` is the home folder). **Never send
  TUI sessions** (a switch) leaves out every terminal session: one open in a TUI now, or one
  started outside Sova that this server doesn't host — so a turn isn't sent right after its TUI
  exits, and the backfill never sends closed terminal sessions. The Overseer's own
  sessions and worker sessions' files are never classified as sessions, and a baton session
  (§app/baton) — outsiders' words — is never sent.
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
- **The turn card.** One request per finished main-session turn (no pre-filter on its words) asks,
  over one state, five typed questions: `asks_user` (§app.decisions/asks-user); `outcome`, a
  choice of did-what-was-asked / partial-stopped / waiting-on-user / waiting-on-team /
  hit-unfixed-failure / progress-report; `ask_kind`, a choice of choose-between-options /
  approve-risky-action / needs-info / restart-or-merge-go / optional-offer / none;
  `claims_unverified`, a boolean (it says it is done but names something not run, tested or
  checked); and `left_open`, a boolean (it names work still to do). It replaces the attention
  call: there is no other.
- **The card's state** is the asks excerpt (§app.decisions/asks-user: the title, the head of the
  last user message, the tail of the reply, closing spec lines cut) plus facts counted in code:
  the session's open alignment questions, its subagents working now, whether merge readiness
  says a restart is owed, and the turn's stop reason. Never tool calls, diffs or files.
- **No card** for a turn that stopped with an error (that is the file's turn error, a code-derived
  Needs you item), a turn a partner's link message or a topic batch opened, the Overseer's,
  workers', baton and archived sessions, and anything the privacy gate stops. Such a turn makes no
  decision call and drops the stored answers of the turn before it.
- **Retired:** the `stuck` question about a main session's turn and every check of a running
  subagent (the `worker` purpose). Neither asks anything; `looping` and a stuck subagent never
  show. Records stored before stay readable and are read by nothing.
- **Thresholds, fixed in code and applied when read:** `asks-you` when `asks_user ≥ 0.85` and the
  card's `ask_kind` is not optional-offer or none (an older record without `ask_kind` needs only
  the first); `unverified` when `outcome` is did-what-was-asked and `claims_unverified ≥ 0.8`.
  The wire carries the kinds and the card's answers (`card`: outcome, ask kind, the two
  probabilities); the server derives the kinds and the client never re-derives them. Records
  stored before may still hold `stuck`, `outcome`-only or `work_failed` answers: no kind comes
  from them.
- **The outcome is kept per turn** for the branch work that reads it later: each card's outcome,
  ask kind and probabilities, keyed by session and turn id with the reply's time, in
  `<stateRoot>/turn-outcomes.json` (the last 20 turns per session, pruned when a session leaves
  the list). It is the durable "work finished" record a branch's merge readiness can read: a
  session's newest outcome and the reply time it belongs to.
- **Showing and clearing** is decided on the server: a session's `signals` are sent only while it
  has a kind, the feature is on, it is not running, and — for every kind but `asks-you` and
  `unverified`, which stay until the user acts (§app.decisions/asks-user) — no pane has it open
  and it hasn't been seen since it was checked (the seen store, §app.overseer/seen); a newer turn
  replaces them. A look never clears `asks-you` or `unverified`. Switching
  the feature off hides every mark and keeps the stored answers. The row's mark is
  §app.session-list/anatomy; the Overseer's view is §app.overseer/attention-digest.

## §app.decisions/asks-user — Does the reply ask the user?

- Every finished main-session turn's card (§app.decisions/attention-signals) asks one boolean,
  `asks_user` ("does the reply end by asking the user a question, or for a decision, approval or
  information it needs before it can go on?"). A session with an **open alignment question**
  (§chat.alignment/session-mark: those already put it in Needs you) shows that instead, and a
  turn a partner's link message (its question is to the partner) or a topic batch
  (§chat.topics/row) opened gets no card.
- **Looks like it asks** is counted in code on the last 1,000 characters of the reply, after the
  closing spec lines (`Also changes:`, `Also updates:`, `Deferred:`, `Plumbing:`, `Spec check override:`) are cut:
  a question mark, or a phrase such as "should I", "shall I", "want me to", "do you want", "would
  you like", "tell me", "let me know", "say if/when/which", "if you want", "your call", "up to you",
  "confirm and", "once you say", "after you confirm" or "say yes", a quoted reply command (`Say
  "restart now"`, `Reply "your recs"`, `say OK`), "awaiting your" or "needs your (or the operator's)
  approval / go-ahead / OK / confirmation". It only picks the sentence the digest quotes; it
  never decides whether a call is made.
- The excerpt is the title, the head of the last user message (≤600 characters) and the tail of
  the reply (≤1,500), after the closing spec lines are cut; it is asked as one question of the
  turn card (§app.decisions/attention-signals).
- At `asks_user ≥ 0.85` the turn's kind is `asks-you` (a courtesy offer scores 0.5–0.8). The
  cutoff is applied when the store is read, so moving it re-classifies nothing. The reply's asking sentence (of its last
  three sentences, the last that ends in "?", else the last), redacted and at most 160
  characters, is stored with the answer for the attention digest only; it never reaches the
  session list or the feed.
- **A restart or merge go is not asked again.** When the asking sentence only asks for a server
  restart or a merge (or push) go-ahead and the session's merge readiness already says a restart
  is owed (§chat.worktrees/readiness, `restartPending`), the row carries no `asks-you`: the
  readiness badge says it.
- **Where it came from.** The mark's tooltip ends with its source: "Guessed by {provider}" for a
  decision's answer, named by the provider that actually answered (Jev, or the configured
  model's name), and "From code." for a mark counted in code (open questions, a team gone quiet).
- It shows while the feature is on and the session is idle, and, unlike the other signals, a look
  does not clear it: opening or viewing the session leaves it, as with open questions. It clears
  when the user answers (a turn runs, and the next turn replaces or drops it) or the session is
  archived. An open alignment question that appears later takes its place.
- It is a guess, so it is **never a blocker**: the attention digest carries it as a **soft decide**
  item (§app.overseer/attention-digest), a quiet mark on the session's row (a chat glyph in muted
  ink, never the accent, §app.session-list/anatomy) and a line in the
  Overseer's digest. Needs you lists it in its softer tier and the Overseer's "need you" count
  counts it, but it never wakes the Overseer with a brief and never sends a phone notification.
  It goes after 7 idle days (no reply since), like every soft item.
- **An open offer asks too.** While an idle session shows an open offer card (§chat.offers/card),
  its row carries `asks-you` as if its last reply asked, with no model call, while the feature is
  on. It clears when the card is answered, set to Not Now, no longer offered or replaced by a newer
  commit, and open alignment questions still take its place. The digest doesn't list it as a soft
  `asks-you` item: the open card is a Needs you item of its own (`offer-waiting`,
  §app.overseer/attention-digest), idle or working.

## §app.decisions/team-stall — A team gone quiet

- Counted in code, never asked of a model, by the attention signals' 10 s scan while the feature
  is on: a session **waits on a stalled team** when all of these hold —
  - it is idle (not running a turn), not archived, and not an Overseer, worker or baton session;
  - it has live subagents, none of them working, and at least one that **counts**: not killed,
    not a team member whose duty is `monitor` or `coordinator`, not one that has delivered a
    finished report (idle with a successful outcome), and whose last activity came **after** the
    session's last reply. A leftover worker of a finished session — its report delivered and
    answered before the last reply, like one restored idle when an old session is opened again —
    never counts; it is never stopped for this either;
  - the end of its last reply (after the closing spec lines) says it waits on them: "still
    running", "in progress", "when it arrives", "once the verifier signs off", "reports to me",
    "will send me", "as they come", "waiting on the team" and the like. A phrase whose subject
    is "you" ("When you report a bug…") is advice to the user and never counts;
  - nothing has happened for 15 minutes: no counted subagent's last activity (monitors' and
    coordinators' check-ins never count).
- It is stored in `<stateRoot>/signals.json` with the time the quiet began and the quiet
  subagents' names, re-checked every scan, and dropped as soon as any condition fails.
- The attention digest shows it as a **decide** item of the session, kind `team-stalled`:
  "Waiting on {names}, quiet for {n} min.", dated by when the quiet began — unless the session
  already has an `open-questions` or `asks-you` item. Like `asks-you` it is a quiet row mark (a clock glyph in muted ink, never the accent,
  §app.session-list/anatomy) and a line
  in the Overseer's digest only: never Needs you, the "need you" count, a brief or a phone
  notification.

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

- **Automatic tags are retired.** No session is sent for a topic or a throwaway guess: there is
  no live tagging pass and no backfill, and nothing asks a provider about tags. A topic or
  throwaway answer stored before stays readable in `<stateRoot>/session-tags.json` and is never
  sent or shown; no row carries a topic tooltip, and search no longer matches topics. A stored
  "tags" switch in `decisions.json` is read and ignored.
- **Manual tags**, per session (`POST /api/sessions/tags`): trimmed, lowercased, a leading `#`
  dropped, deduplicated, letters, digits and `-`, at most 32 characters each and 8 per session;
  an empty list or `null` clears them. They are stored in `<stateRoot>/session-tags.json`, keyed
  by session id, always shown, and matched by search (§app.session-list/search).
- The row shows no tag word; its line 3 carries the readiness badge instead
  (§app.session-list/anatomy).

## §app.decisions/backfill — Tagging existing sessions

- **Retired** with automatic tags (§app.decisions/session-tags): Settings → Decisions offers no
  backfill, and the server runs none, nor resumes one a job file says was running. The
  `/api/sessions/tags/backfill` routes are gone.

## §app.decisions/push — Live marks

- The server **pushes** signal, tag and turn-error (`turnError`, §app.overseer/seen) changes: the read-only watch socket has a session-less
  feed (`/ws/watch?feed=sessions`) that sends a full snapshot of every session's marks on every connect (even an empty one),
  then one message per change (a signal, a manual tag or a turn error set, cleared or pruned). The same socket also carries the LLM calls in flight
  (`llm_inflight`, §app.insights/llm-inflight): a snapshot on every connect, then one frame per
  change of the total or its coverage; it never prompts a list read.
- The server compares only when something a row reads changed, while a feed is connected,
  Sova's event stream has a subscriber (§app.events/idle: it observes through these same
  comparisons), or the Overseer's background loop reads the attention digest (an Overseer exists,
  or a phone waits for its notifications; the loop reads the digest from these comparisons' list): a store written or a pane attached; anything that starts the next listing afresh
  (§app.session-list/listing-reuse); a session file written, added or removed in a session folder
  (an organization's included); an organization's statecharts changing; merge readiness reading a
  new answer, including for a worktree whose Git state moved with no session-file write (a commit,
  add, checkout or branch switch there, or its base branch moving: every 5 s, the index, HEAD and
  branch and base refs of each worktree a row's readiness tracks are compared as file stamps, with
  no Git run, and only a row whose stamps moved is read again; rows whose worktrees are all merged
  or removed, and archived ones not open anywhere, are not compared); and a live record whose
  owner, status or activity changed, or whose process died (the live-record folder is watched, and
  its records re-judged every 5 s; a heartbeat alone is no change). A burst of changes is one comparison, and comparisons run at most once a second, so a
  change reaches the feed within about 5 s, and a turn that starts in a TUI clears its mark. A
  safety-net comparison runs once a minute while a feed is connected, for a change none of these
  tell of (a file written by another program outside the watched folders). With nothing
  changing, no comparison runs and the list is not built between safety nets.
- The same socket pushes the attention digest and the Overseer's state, so no window polls them:
  `attention` (the digest, as `GET /api/overseer/attention` returns it,
  §app.overseer/attention-digest) and `overseer` (as `GET /api/overseer` returns it: its unread
  count, "need you" badge, busy state, history and proactivity), each only when its value differs
  from the last one sent, built from the comparison's own list. Neither is sent on connect: the
  app reads both once when the feed opens (first connect and every reconnect) and once when the
  tab becomes visible again, then takes each pushed value as it comes.
- The same comparison sends `list_changed` (no payload; never on connect) when a session appears
  in or leaves the list, or a row's live record, running state, last activity, archived flag or
  title changes (a stored title changes in Sova's title store, never in the file: the Overseer's
  rename, the automatic namer's, §app.session-list/auto-titles), or its merge readiness changes
  (read from git in the background, §chat.worktrees/readiness), or the group it is in changes. The sidebar then reads the list again: at once if its last such read was at least a
  second ago, otherwise once, a second after that read, however many more arrive meanwhile. It
  also reads the list after every reconnect of the feed, since the list may have changed while
  the socket was down. The feed adds no polling of its own. The in-flight count adds none in the
  browser either: on the server, while any feed (or a peer's count feed) is connected, one 5 s
  timer re-judges the live records it already holds (a stale heartbeat, a dead pid) and re-reads
  the live-record folder every 30 s, or every 5 s where the folder can't be watched; it never
  reads the list. So a session started in a TUI reaches
  the sidebar within seconds, without a reload.
- Every write to the session groups (a group made, renamed, reordered or deleted, a session put
  into or taken out of one, by any window or the Overseer) sends `groups_changed` (no payload;
  never on connect) at once, from the group store itself, not after a comparison: each window
  reads its groups and the list again (§app.session-list/groups), and reads its groups after every
  reconnect too. A window that predates it ignores it.
- The sidebar holds the feed open while it is mounted. Once the snapshot arrives, the feed's
  signals, tags and turn error replace the list's on this server's rows, matched by session path (rows from mesh peers keep their list
  fields); each change applies at once, and a cleared field is removed. While the socket is not
  open the overlay is dropped and the list poll is the truth again: the app's re-read of the list
  every 5 s while a row is busy runs only then, since an open feed says when a row changes; after the socket stops
  retrying, it tries again when the window regains focus.
- The feed never writes and ignores anything the client sends.

## §app.decisions/align-triage — Triage on an alignment card

- **What it asks.** One request per alignment card version (`al_N` at its `rev`): for each open
  question, `stakes_{qN}`, a choice of low-risk / deletes-data / costs-money /
  changes-architecture-or-contract. The state is the document's title and summary and each open
  question's topic, ask, options with their consequence lines, and recommendation; never the
  findings, notes, code or files. Redacted before it leaves, like every request.
- **When and which.** When a card with open questions is shown (`GET /api/sessions/align-triage`),
  only with **attention signals on**, through the same privacy gate and exclusions as the turn
  card (§app.decisions/attention-signals). The answer is stored per session, document and `rev`
  in `<stateRoot>/align-triage.json`, so a card is asked once per version; a new version asks
  again. A failed or refused request stores nothing and the card shows no chips.
- **What it shows.** A chip per open question, after its state chip (§chat.alignment/card):
  "Low risk" in muted ink (`--color-ink-muted`), or, flagged, "Deletes data", "Costs money" or
  "Changes architecture" in the error tone (`chip-error`), never the warn tone of a state chip. Its `title` names the source ("Guessed by Jev."). Accepting works exactly as before:
  no new button, no warning, no change to Go With Recommendations or any answer.

## §app.decisions/worker-report — A worker's report check

- **What it asks.** One request per worker report: when a subagent or team member reports done
  (a `subagent-complete` message whose task outcome is success, or a coordinator's team report),
  `report_outcome`, a choice of finished / partial / blocked / failed, and `claims_unverified`, a
  boolean: the report says the work is done but doesn't say it ran the tests or checks, or names
  something not run, tested or checked. The state is the report's text only (the worker's name,
  its status and task outcome, and the body, at most 4,000 characters); never the worker's
  transcript, its diffs or files. Redacted before it leaves, like every request.
- **When and which.** When the session's worker rows are shown
  (`GET /api/sessions/worker-checks`), for each worker's newest report on the session's branch,
  only with **attention signals on** and through the same privacy gate and exclusions as the
  parent's turn card (§app.decisions/attention-signals). The answer is stored per session,
  worker and report in `<stateRoot>/worker-checks.json`, so a report is asked once; a newer
  report asks again. A failed or refused request stores nothing and the row shows nothing.
- **What it shows.** A worker whose report reads finished with `claims_unverified ≥ 0.8` gets an
  "Untested" warn chip on its row, before the status chip (§app.subagents-pane/worker-rows), whose
  `title` says "Says it's done, but the report doesn't say it ran tests or checks." and names the
  source ("Guessed by Jev."). Nothing else changes: the status chip, the worker and its report
  stay as they are, and the check never wakes the Overseer, adds a Needs you item or sends a
  notification.

## §app.decisions/merge-followup — One follow-up check per merge

- **What it asks.** Once per merge card (§chat.worktrees/merge-card), on the first reply that ends
  a turn after the card: `follow_up`, a boolean — does the reply name work still to be done beyond
  a restart, push or cleanup (open gaps, a known regression, "I'd fix it separately", unverified
  parts)? — and `follow_up_weight`, a score over none / small / significant.
- **The excerpt**: the branch, target, commits and lines of the card, the reply's last 1,500
  characters with its closing spec lines cut (`Also changes:`, `Also updates`, `Deferred:`,
  `Plumbing:`, `Spec check override:`), its `Deferred:` line apart when it has one, and the
  mechanical follow-ups (§chat.worktrees/readiness) as facts so they are not judged again.
  Redacted before it leaves.
- **When and which.** Only with **attention signals on** and through the same privacy gate
  (§app.decisions/privacy), for the sessions readiness covers, never for a merge captain's
  session (its reply after a merge is a round report about other branches) or an Overseer's, and only for a reply from the last
  24 hours: switching the feature on never checks old merges. A merge is checked at most once; a
  failed check is retried after 5 minutes, at most 3 times. The answer is stored per merge card in
  `<stateRoot>/merge-followups.json`, kept only while its session is listed.
- **Reading it.** Follow-up work when `follow_up` P ≥ 0.5 and the weight's score is 0.5 or more:
  significant at 1.5 or more with confidence ≥ 0.5, else small. The cue shown is the reply's own
  first line naming open work, else its `Deferred:` line; with neither, nothing is shown (no
  badge count, no title line, no digest item), whatever the answer. The model never writes
  the follow-up; it only says whether there is one and how much.
