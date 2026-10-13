---
watches: ["pi-config/extensions/sessions/**"]
alsoUpdate: ["pi-config/extensions/sessions/README.md", "pi-config/extensions/sessions/public/SCHEMA.md"]
---
# sessions

Live pi sessions on this machine find each other through a filesystem presence registry, `sessions/live/*.json`
in the agent dir; it also ships the `pi-sessions` CLI. Sova reads the registry to find TUI-live sessions, presence
and busy state.

## What lives here

- [`README.md`](../../../pi-config/extensions/sessions/README.md) and the record schema
  [`SCHEMA.md`](../../../pi-config/extensions/sessions/public/SCHEMA.md) (with the JSON schemas beside it).
- Tests: `cd pi-config/extensions/sessions && node --test test.mjs`.

## What Sova relies on

- The live registry `<agent dir>/sessions/live/*.json` is a contract Sova parses (`server/insights.ts`). The
  extension also loads inside Sova's embedded runtimes and writes their records.
- Sova's archive guard reads these records (`presence.workerCounts.working`, `server/live.ts`). No restart
  waits on them any more.
- Sova imports no file from this directory.

## When you change it, also update

- A record field: `pi-config/extensions/sessions/public/SCHEMA.md`, its JSON schema, the README, and Sova's
  readers in the same branch.
