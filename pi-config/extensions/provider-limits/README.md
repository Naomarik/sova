# provider-limits

A limit on how many model requests each provider runs **at once on this device**. Requests over
the limit wait in the provider's queue instead of failing with the provider's 429.

## The file

`<agent dir>/provider-limits.json`, written by Sova's Settings → Models ("At once" on each
provider row) and read at every request:

```json
{ "version": 1, "limits": { "zai": 5, "ollama-cloud": 10 } }
```

Each limit is a whole number from 1 to 999. A provider the file doesn't name has no limit. With no
file (or one that doesn't parse) the defaults apply: `zai` 5, `ollama-cloud` 10. The key
`claude-code` limits the Claude Code provider's streams (`claude-code-cli`); it has no default.

## How it works

- `gate.ts` (Node builtins only; Sova imports it too): the file's parse, reader and atomic writer,
  and the lease gate. A request claims a slot file
  `provider-limits/<provider>/slots/<pid>-<n>.json` under a short per-provider lock, or waits with
  a queue entry in `…/wants/`. Each process refreshes its files every 5 s; a file whose pid is dead
  or that is older than 30 s is removed by the next reader, so a crash never blocks a provider for
  long.
- Order: a session's own turns first, then background work (pi workers and team members, and every
  request with no registered session: Sova's one-shots, an extension's own calls). First come,
  first served within a class; background waiting over 2 minutes ranks as interactive.
- `stream.ts`: the gated `streamSimple`. The slot is held from just before the request is sent until
  its stream ends (done, error or abort); tool execution holds none. Stopping a turn while it waits
  leaves the queue at once.
- A 429 rate limit before any output is re-queued after a cooldown (`Retry-After`, else 10 s), at
  most 5 times, and lowers the provider's limit for 5 minutes to one below the limit the request
  was sent under (`…/lowered.json`, shared by every process; never below 1). The file's number is
  never rewritten. A 429 about quota or balance is passed on. pi's own retry is unchanged.
- `index.ts`: at `session_start` and before each turn, every provider with a limit that this runtime
  knows is re-registered with `pi.registerProvider(id, {api, streamSimple: gated})` — around pi's
  own API stream, or around the stream another extension registered. While a request waits, the
  status bar reads `Waiting for zai · 5 of 5 in use`.

Every pi worker loads this extension right after `worker-mark.ts` (subagents), so workers count
toward the same limits. Claude Code workers and the topic outline's Claude summarizer start the
`claude` CLI themselves and are not counted.

## Tests

```sh
node tests/run.mjs   # unit tests; N processes never over the limit; real pi sessions against a local fake provider
```
