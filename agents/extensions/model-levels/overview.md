---
watches: ["pi-config/extensions/model-levels/**"]
alsoUpdate: ["pi-config/extensions/model-levels/README.md"]
---
# model-levels

The real thinking levels of `models.json` providers pi has no catalog for (Ollama Cloud, local Ollama), from
Ollama's `/api/show` and models.dev. Every pi worker loads it; the server imports its core.

## What lives here

- [`README.md`](../../../pi-config/extensions/model-levels/README.md). Requirement: §app/model-levels.
- Tests: `cd pi-config/extensions/model-levels && node tests/run.mjs`.

## What Sova relies on

- `server/harness/pi/open.ts` imports `core.ts` (builtins only). The levels are cached in
  `<agent dir>/model-levels.json`. The shared runtime gets them at boot; the extension, which every pi worker also
  loads, at each session start and turn.
- One rule, `modelFetchEnabled` in `core.ts`, governs every metadata fetch: the server's boot fetches and each hosted
  session's extension alike. `PI_OFFLINE` or `SOVA_MODELS_FETCH=off` stops them, and a test process never fetches
  unless `SOVA_MODELS_FETCH=on`.
- The dev watcher doesn't watch this directory: an edit reaches a running server only at its restart.

## When you change it, also update

- The cache shape or the fetch rule: the README; keep tests offline by that same rule.
