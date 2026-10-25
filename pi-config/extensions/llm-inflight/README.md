# llm-inflight

How many **logical LLM calls** this process has in flight right now. A call counts from its issue
until its response ends, fails or is aborted. Auth and request setup, a provider-limits queue, a
rate-limit cooldown and the tools run between calls never count. Only begin/end bookkeeping is
kept, plus one number per call: at its end, its reply's **output tokens** (reasoning included;
never input or cache reads) go into a ring of 60 epoch-aligned 30 s slots (30 minutes), spread
evenly back over the time the reply streamed. No payload, prompt, reply or credential is read or
stored, and nothing is written per token: the tokens change with the call's end, as one change.
At that same end each call also appends one usage record, its token counts only (below).

## The pieces

- `tracker.ts` (Node builtins only; Sova imports it): the per-process table, a `globalThis`
  singleton (`Symbol.for("sova.llm-inflight.v1")`) so every copy loaded in one process shares it.
  `beginLlmCall({source, approximate?, pending?})` returns an idempotent end with `.waiting(on)`;
  `snapshot(now?)` is `{v: 1, producer, pid, active, approximate, claudeTurns, degraded, folded,
  tokens}`, `tokens` = `{bucketMs: 30000, end, out[60], partial?}` (`out[59]` is slot `end` =
  `floor(ms / 30000)`); `subscribe(fn)` is called only when those change (the ring moving with
  time is no change). The end takes the call's tokens: `end({output, since?, at?})`. `withinLlmCall`/`currentLlmCall` scope one call
  to the code below it (the provider-limits gate marks that very call waiting in a cooldown; a call
  begun inside is a new call, never suppressed). `setChildCounts` holds a child process's reported counts
  (replaced, never added; Sova's server keeps one per chat process), their rings summed with the process's own; a child forgotten while
  summed leaves its ring in a retired ring until it ages out. A child that reported no ring makes
  `tokens.partial`. `markDegraded` and `beginClaudeTurn` report what can't be seen.
- `runtime.ts` (builtins only; Sova imports it): `instrumentModelRuntime(runtime)` wraps
  `stream`, `streamSimple`, `streamDeferred` and `cancelDeferred` on one pi `ModelRuntime`
  **instance** (marked, so a second call is a no-op). Every pi request of a process goes through
  that instance: agent turns and retries, compaction and branch summaries, cache warming, and an
  extension's `ctx.modelRegistry.*` (whose `complete*` call `this.stream*`, so a call counts once).
  A call begins pending and is in flight from the provider's `onPayload` (called just before it
  sends; composed with the caller's own, whose return value is kept) or, for a provider that never
  calls it, the stream's first event. It ends when the stream's own `result()` settles or its
  `end()` runs; no second iterator is ever taken, and the original's stream, return value and
  throws pass through unchanged. The final message's `usage.output` is the call's tokens, spread
  back to the stream's first event. A request that returns a deferred handle leaves remote work
  nobody local sees: the process is degraded until the handle's final reply or cancel. Fetching a
  handle is never a counted call.
- `claude.ts`: `createClaudeRequestObserver()` reads a provider bridge's Claude Code CLI
  stream-json frames (fed by `claude-code/transport.ts` before its owner's hooks). It counts no
  call and no token: the pi runtime counts the bridge's calls. The CLI's own subagents, side
  queries and compaction are not streamed, so a running turn (from `system/status "requesting"` or
  a reply's `message_start` to the turn's `result` or the process closing) is reported in
  `claudeTurns` (the count is partial) rather than guessed. `beginClaudeOneShot()` counts a `claude -p --output-format json` spawn to exit, as approximate
  (with no tokens).
- `index.ts` (the extension): instruments `ctx.modelRegistry`'s runtime at `session_start` and
  before each turn; with no runtime to instrument the process is degraded. No worker loads it: a
  worker is a chat process of its own, whose runtime Sova instruments and whose counts the server
  takes from that process (`setChildCounts("chat:<session id>")`, server/chat-host.ts).
- **Never twice:** a snapshot's `folded` lists the producer ids of every child process whose counts
  it includes, transitively (a child reports its own producer and its own `folded`). A reader skips
  any record whose producer is already folded into a count it took. This covers a chat process
  that also publishes a live record of its own.

## The usage ledger

The same call ends also write the process's **usage records** (`usage-record.ts`: the shape, the
strict parse and the writer; `<agent dir>/usage/v1/<UTC day>/<producer>.jsonl`, one line per call,
token counts only, never a price):

- `runtime.ts`: one record per pi call with tokens, at its stream's end (a deferred handle at its
  final reply), key `pi:<session>:<message.timestamp>:<provider>/<model>` for a registered
  session's reply, else `<producer>:<seq>`. A `claude-code-cli` reply is skipped once a bridge
  records that provider in this process.
- `claude.ts` + `claude-usage.ts` (an observer created with `usage`): one record per Anthropic
  message id (`cc:<id>`), its `message_start` / `message_delta` / `assistant` usage merged by the
  max per field; at each `result`, a `claude-residual` per model for what the cumulative
  `modelUsage` shows beyond the recorded messages, against the session's last total in
  `<agent dir>/usage/cc-baseline/<claude session>.json` (`ccr:<session>:<total>:<model>`). A
  resume, fork or re-adoption with no baseline takes its first result as the baseline; a replayed
  result at or under it adds nothing. The provider bridge (`provider/session-bridge.ts`) records,
  for chats and Claude Code workers alike; it claims `claude-code-cli` from the runtime.
- `record.ts`: `recordUsage` (fills producer, device, key), `recordClaudeEnvelope` for a
  `claude -p --output-format json` run (`cp:<envelope session>:<model>`; Sova's decisions and
  titles, topic-outline's Claude summarizer), and the provider claim.
- `attribution.ts`: whose call it is. A request's `sessionId` is a routing id: it names the owner
  only when that session registered (`registerUsageSession`: this extension at `session_start`,
  Sova's chat manager for its hosted chats, `noteUsageSession` for an Overseer's kind). Otherwise
  the caller's `withUsageContext({owner, cwd, purpose, kind, project, starter})` (an
  AsyncLocalStorage scope, so concurrent side calls keep their own), else the process's only
  session, else none. `withUsagePurpose` marks a side call that never falls back. A worker chat
  is registered by Sova's chat manager with its parent session and worker id, from its loadout.

## Who counts what

| Caller | Counted by |
| --- | --- |
| TUI, Sova-hosted pi sessions, pi workers, team members; their compaction, cache warms, nested `ctx.modelRegistry` calls | `runtime.ts` on the process's runtime (Sova instruments its own) |
| `claude-code` provider sessions (the bridge) | the pi runtime's outer stream; the bridge's transport reports only its running turns |
| Claude Code workers | `claude.ts` on the worker's transport, in the process running the worker |
| Topic outline's Claude summarizer | `beginClaudeOneShot` (approximate) |
| Sova's decisions and titles (`claude -p`, Jev) | Sova's server (`server/decide-llm.ts`, `server/decide-jev.ts`) |

The session's live record carries the process's snapshot as `presence.llm`
(`../sessions/public/SCHEMA.md`); a process that doesn't count publishes none.

Not counted: HTTP requests on the wire (a provider's own retries are inside one call), calls any
other program makes, and work a Claude Code CLI does without reporting it.

## Tests

```sh
node tests/run.mjs   # unit tests; then real pi sessions (the pinned CLI) against a local fake provider
```

`PI_PACKAGE_DIR` points at the pi install to test (default: the global one).
