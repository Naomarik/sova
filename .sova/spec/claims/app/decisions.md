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
`signals.json` (classified turns), `session-tags.json` (tags). All are sidecars: no decision ever
writes a byte into a session file. All writes are atomic tmp+rename.

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
  estimated over Jev's size limit fails `too-large` locally, without a call. Timeout 8 s.
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

- Nothing is sent unless a feature is on, and each feature is its own switch.
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
  sessions and worker sessions' files are never classified as sessions.
- The Settings tab states, in one sentence above the switches, what is sent and to whom.

## §app.decisions/attention-signals — Attention signals

- **When.** Once per finished turn. A hosted chat is checked about 1.5 s after its turn settles;
  every other session (open in a TUI, or hosted by another server) is found by a 10 s scan of the
  session list for a newer reply on an idle session, at most 6 checks per scan. A turn the scan
  first sees is checked only if it ended within the last 30 minutes: switching the feature on does
  not check old turns. A session is checked at most once per last-assistant entry on its active
  branch (the `turnId`); a rewind or a new turn changes it. A branch ending on a tool call is
  mid-turn and not checked. A failed check stores nothing and is retried after 5 minutes,
  at most 3 times per turn (a `bad-request` never).
- **Which sessions.** Those the privacy gate lets through (§app.decisions/privacy), except the
  Overseer's, worker sessions and archived sessions.
- **TUI sessions are read, never written**: Sova's own parser reads at most the last 1 MB of the
  file; nothing is ever appended to any session file.
- **The excerpt**: the title (≤200 characters), the last user message (≤2,000), the end of the
  last reply (≤4,000), the last 8 tool calls (≤120 characters each, each marked failed or succeeded
  when known), the turn's error (≤300), repeats counted in code, and tool failures counted in
  code: how many calls failed, how many were never re-run successfully with the same tool and
  input later in the turn, whether the last call failed, and the last 3 failed calls with their
  input (≤120) and the end of their error (≤300). A call failed when pi marks its result as an
  error; in a worker's transcript, which has no such mark, when its result says a command exited
  with a non-zero code or without one.
- **Questions** (raw answers stored in `<stateRoot>/signals.json`, pruned when a session leaves
  the list): `asks_user` (boolean: does the reply end by asking the user something it needs before
  continuing), `outcome` (choice: done, partial, failed, blocked on the user — was the goal behind
  the request achieved, judged by the result, not the tone) and `work_failed` (boolean: did
  something in the turn fail and stay failed, judged by what happened, not how calmly it is told
  or whether the user expected it) for every turn;
  `stuck` (score over making progress / some repetition / clearly looping) only for a turn of 5
  minutes or more, or 20 tool calls or more.
- **Thresholds, fixed in code:** `asks-you` when `asks_user ≥ 0.7`; `task-failed` when
  `work_failed ≥ 0.7`, or the outcome is `failed` with confidence ≥ 0.5; `looping` when `stuck ≥ 1.5` with confidence ≥ 0.5. A signal can be
  `task-failed` while its outcome reads done. The wire carries the kinds with the raw
  `asksUser`, `workFailed`, outcome and stuck answers; the server derives the kinds and the
  client never re-derives them.
- **Workers**, pi and Claude Code alike: a worker running for 5 minutes or more is checked for
  `stuck` at most every 5 minutes; a worker that ended (done or error, not killed) within the last
  30 minutes gets one outcome check (`outcome` and `work_failed`). The parent session carries counts (`workerSignals`: stuck,
  failed); details go to the attention digest. A subagent's check counts until the parent session
  is seen after it (or is on screen); a stuck check also stops counting 11 minutes after it, so a
  worker that stopped running stops counting.
- **Showing and clearing** is decided on the server: a session's `signals` are sent only while it
  has a kind, the feature is on, no pane has it open, it is not running, and it hasn't been seen
  since it was checked (the seen store, §app.overseer/seen); a newer turn replaces them. Switching
  the feature off hides every mark and keeps the stored answers. The row's mark is
  §app.session-list/anatomy; the Overseer's view is §app.overseer/attention-digest.

## §app.decisions/session-tags — Session tags

- Each session gets a **topic** from a fixed taxonomy — feature, bugfix, refactor, tests, docs,
  infra, research, planning, review, data, config, experiment, chore, other — a **status** (done,
  in progress, abandoned, blocked) and a **throwaway** probability (a test or scratch session with
  no lasting work). The taxonomy is not editable; the classifier never invents labels.
- **Input** comes from what the session list already reads (the file's head and tail, never a
  full read): the original first message, the outline's summary and "now" line, the folder's name,
  the model, how long it ran and how long it has been idle (both computed in code), the last user
  message (≤600 characters) and the end of the last reply (≤1,500), redacted before it leaves.
- **Shown** only when confident: topic and status at confidence ≥ 0.5 and inside the taxonomy;
  throwaway at P(yes) ≥ 0.75. Anything below is absent on the wire; the raw answers are stored.
- **Which sessions**, for live tagging and the backfill alike: those the privacy gate lets through
  (§app.decisions/privacy), except the Overseer's, workers' and never-sent drafts; a session
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
- The row shows the status word (§app.session-list/anatomy); search matches topic, status and
  manual tags (§app.session-list/search).

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

- The server **pushes** signal and tag changes: the read-only watch socket has a session-less
  feed (`/ws/watch?feed=sessions`) that sends a full snapshot of every session's marks on every connect (even an empty one),
  then one message per change (a signal or tag written, cleared or pruned), and backfill progress
  while a backfill runs.
- Changes are sent when a store is written or a pane attaches, and the server compares every 5 s
  while a feed is connected, so a turn that starts in a TUI clears its mark.
- The same comparison sends `list_changed` (no payload; never on connect) when a session appears
  in or leaves the list, or a row's live record, running state, last activity or archived flag
  changes. The sidebar then reads the list again: at once if its last such read was at least a
  second ago, otherwise once, a second after that read, however many more arrive meanwhile. It
  also reads the list after every reconnect of the feed, since the list may have changed while
  the socket was down. The feed adds no polling of its own. So a session started in a TUI reaches
  the sidebar within seconds, without a reload.
- The sidebar holds the feed open while it is mounted. Once the snapshot arrives, the feed's
  signals and tags replace the list's on this server's rows, matched by session path (rows from mesh peers keep their list
  fields); each change applies at once, and a cleared field is removed. While the socket is not
  open the overlay is dropped and the list poll is the truth again; after the socket stops
  retrying, it tries again when the window regains focus.
- The feed never writes and ignores anything the client sends.
