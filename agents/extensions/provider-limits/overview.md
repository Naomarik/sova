---
watches: ["pi-config/extensions/provider-limits/**", "server/provider-limits.ts"]
alsoUpdate: ["pi-config/extensions/provider-limits/README.md"]
---
# provider-limits

How many model requests each provider runs at once on this device; requests over the limit wait instead of
failing. Every pi process claims through it, and so do Sova's own one-shots.

## What lives here

- [`README.md`](../../../pi-config/extensions/provider-limits/README.md).
- Tests: `cd pi-config/extensions/provider-limits && node tests/run.mjs`.

## What Sova relies on

`gate.ts` (builtins only) holds the limits file's parse, reader and writer, the lease gate a one-shot claims its
slot through, the Overseer's background mark, and the queue read for the web. `server/provider-limits.ts`,
`server/decide-llm.ts`, `server/overseer.ts` and `server/sync/docs.ts` import it. It imports one sibling,
`usage-out.ts` (no imports at all): the one out-of-usage classifier, which the subagents extension imports too
(a team's coordinator or monitor that runs out of usage moves to its fallback). Its gate state is a `globalThis`
singleton, so the extension's copy in a hosted runtime and the server's share it.

Contracts (paths under the agent dir):
- `provider-limits.json` `{version: 1, limits: {<provider>: 1..999}}`. Missing or unreadable means the defaults,
  zai 5 and ollama-cloud 10. Written by Settings → Models, synced like the model policy.
- The per-provider queue under `provider-limits/<provider>/`: `slots/<pid>-<n>.json` `{v: 1, pid, sessionId?,
  kind, at}`, `wants/<pid>-<n>.json` (the same plus `since`), `lowered.json` `{v: 1, limit, until}` and the claim
  `lock`. Every pi process (the TUI, hosted sessions, pi workers through their `-e` list) and Sova's one-shots
  claim through them; Sova reads them by session id for the waiting state.

An edit here reaches a running server only at its restart (the singleton keeps its first code).

## When you change it, also update

- A file shape or a default: the README, and the Settings → Models reader and writer in `server/provider-limits.ts`.
- Run `pnpm test` for the server tests that import `gate.ts`.
