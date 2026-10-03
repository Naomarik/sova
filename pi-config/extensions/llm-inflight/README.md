# llm-inflight

How many **logical LLM calls** this process has in flight right now. A call counts from its issue
until its response ends, fails or is aborted. Auth and request setup, a provider-limits queue, a
rate-limit cooldown and the tools run between calls never count. Only begin/end bookkeeping is
kept: no payload, token, prompt, reply or credential is read or stored, and nothing is written per
token.

## The pieces

- `tracker.ts` (Node builtins only; Sova imports it): the per-process table, a `globalThis`
  singleton (`Symbol.for("sova.llm-inflight.v1")`) so every copy loaded in one process shares it.
  `beginLlmCall({source, approximate?, pending?})` returns an idempotent end with `.waiting(on)`;
  `snapshot()` is `{v: 1, producer, pid, active, approximate, claudeTurns, degraded}`;
  `subscribe(fn)` is called only when those change. `withinLlmCall`/`currentLlmCall` scope one call
  to the code below it (the provider-limits gate marks that very call waiting in a cooldown; a call
  begun inside is a new call, never suppressed). `setChildCounts` holds a worker's reported counts
  (replaced, never added). `markDegraded` and `beginClaudeTurn` report what can't be seen.
- `runtime.ts` (builtins only; Sova imports it): `instrumentModelRuntime(runtime)` wraps
  `stream`, `streamSimple`, `streamDeferred` and `cancelDeferred` on one pi `ModelRuntime`
  **instance** (marked, so a second call is a no-op). Every pi request of a process goes through
  that instance: agent turns and retries, compaction and branch summaries, cache warming, and an
  extension's `ctx.modelRegistry.*` (whose `complete*` call `this.stream*`, so a call counts once).
  A call begins pending and is in flight from the provider's `onPayload` (called just before it
  sends; composed with the caller's own, whose return value is kept) or, for a provider that never
  calls it, the stream's first event. It ends when the stream's own `result()` settles or its
  `end()` runs; no second iterator is ever taken, and the original's stream, return value and
  throws pass through unchanged. A request that returns a deferred handle leaves remote work
  nobody local sees: the process is degraded until the handle's final reply or cancel. Fetching a
  handle is never a counted call.
- `claude.ts`: `createClaudeRequestObserver()` reads a Claude Code CLI's stream-json frames (fed
  by `claude-code/transport.ts` before its owner's hooks). Claude Code 2.x writes
  `system/status "requesting"` when its query loop starts a request, before sending it; a call
  counts from there to the reply's `message_stop`, the next `requesting`, the turn's `result` or the
  process closing. A tool_use reply ends at its `message_stop`. A reply with no `requesting` before
  it is counted from `message_start` and marks the process degraded. Its own subagents, side
  queries and compaction are not streamed, so a running turn is reported in `claudeTurns` (the
  count is partial) rather than guessed; the CLI's internal retries of one request are one call. A
  re-adopted worker's replay only rebuilds state: counting starts when its host goes live.
  `beginClaudeOneShot()` counts a `claude -p --output-format json` spawn to exit, as approximate.
- `index.ts` (the extension): instruments `ctx.modelRegistry`'s runtime at `session_start` and
  before each turn; with no runtime to instrument the process is degraded. In a pi worker (the
  `subagents:worker` role, RPC mode) it reports its counts to the session that runs it with a
  fire-and-forget `setStatus("sova-llm-inflight", json)`, only when they change; the subagents
  runner folds that into its own process's counts until the worker exits.

- `hosted.ts` (builtins only; Sova imports it): `readUnadoptedWorkers(root?)` finds hosted workers
  left running with no manager (after a restart, before re-adoption). A manager holds the worker's
  `adopt.lock` while it runs the worker, and its own count includes that worker. A worker whose host
  lives with no live lock holder is unadopted: its counts come from the host's `llm.json` (the
  worker's latest report, which `subagents/host.ts` rewrites only when it changes, and zeroes when
  the worker exits), or `null` (unknown) for a worker that never reported, such as a Claude Code
  worker. Reads are cached by file stat; nothing is scanned per token. A detached transport emits
  `detached`, and the runner then stops counting the worker.
- **Never twice:** a snapshot's `folded` lists the producer ids of every worker whose counts it
  includes, transitively (a worker reports its own producer and its own `folded`). A reader skips
  any record or worker file whose producer is already folded into a count it took. This covers a
  worker that also loads the sessions extension (the agent_spawn `extensions` parameter allows it).

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
