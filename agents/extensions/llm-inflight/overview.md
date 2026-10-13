---
watches: ["pi-config/extensions/llm-inflight/**", "server/usage-helper/**"]
alsoUpdate: ["pi-config/extensions/llm-inflight/README.md"]
---
# llm-inflight

Counts each process's model calls in flight and writes the usage ledger, the one record per model call that
prices every spend figure Sova shows. Every pi worker loads it.

## What lives here

- [`README.md`](../../../pi-config/extensions/llm-inflight/README.md). Requirement: §app.insights/usage-ledger.
- Tests: `cd pi-config/extensions/llm-inflight && node tests/run.mjs`.

## What Sova relies on

**The usage ledger.** `usage-record.ts` (builtins only) holds the record's shape, its writer and the strict parse
`parseUsageLine`. Records live at `<agent dir>/usage/v1/<UTC day>/<producer>.jsonl`, one per model call:
`{v: 1, key, ts, device, producer, src, provider, model, responseModel?, input, output, cacheRead, cacheWrite,
cacheWrite1h?, owner, parent, worker?, kind, purpose?, cwd?, project?, starter?, stop?, launch?}`. `launch`
`{how, why, fallback?}` is on the first call of each Claude Code process the bridge launches for a conversation.
- Written at each call's end by this extension (one writer per file: the process's producer id) and by the
  server's own one-shots (`server/decide-llm.ts`, `server/decide-jev.ts`, `server/session-autotitle.ts`).
- Read only by the server's usage helper (`server/usage-helper/`), through `parseUsageLine`.
- A worker's records name their parent as Sova's chat manager registered it (`WorkerSpec.parent`).

**Claude baselines.** `claude-usage.ts` keeps `<agent dir>/usage/cc-baseline/<claude session id>.json` `{v: 1, at,
models}`, each Claude session's last cumulative `modelUsage`, so a resume never recounts. Beside it,
`<claude session id>.since.jsonl` holds one line per message recorded since that baseline, so a process killed
mid-turn is never recounted.

**Other server imports** (builtins and each other only): `attribution.ts` (whose model call it is; a `globalThis`
table every copy in one process shares), `record.ts` (one record per call, from whichever observer saw it end),
`tracker.ts` (the in-flight count the live record carries, `presence.llm`), `runtime.ts` (the pi runtime's
observer). A cache warm's spend is the ledger's record,
written when the warm call ends (`runtime.ts`).

The dev watcher doesn't watch this directory: an edit reaches a running server only at its restart.

## When you change it, also update

- The record shape: `parseUsageLine` and the usage helper's readers in the same branch, and the README.
- Run `pnpm test` (the server's usage tests import these files) and the extension's own suite.
