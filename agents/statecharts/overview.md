---
watches: ["statecharts/**"]
alsoUpdate: ["statecharts/STATECHARTS.md", "statecharts/EVENTS.md", "server/vendor/statecharts.js"]
---
# Statecharts

The org's statecharts: CLJC statecharts under `statecharts/`, built into the vendored bundle
`server/vendor/statecharts.js` that the server runs. Their own docs are the reference; this guide is
the fast loop and what to keep in step.

## What lives here, and its docs

- `statecharts/src/sova/statecharts/`: the statecharts, registered in `registry.cljc`; the engine is
  `statecharts/src/sova/statecharts/engine/` ([API.md](../../statecharts/src/sova/statecharts/engine/API.md)).
- [statecharts/STATECHARTS.md](../../statecharts/STATECHARTS.md): the fast loop, every statechart and
  the inventory items it stands for. Read it first.
- [statecharts/EVENTS.md](../../statecharts/EVENTS.md): the event vocabulary, payloads, effects and the
  JS-boundary conventions.
- [statecharts/SPIKE.md](../../statecharts/SPIKE.md): the engine spike, the build and the numbers.
- `scripts/build-statecharts.mjs`: the release build into `server/vendor/statecharts.js` (from HEAD,
  never the working tree), `--check`, and `--test` (the full cold path); its header documents it.

## Rules and contracts

- Start `pnpm statecharts:watch` first and run `pnpm statecharts:test` (`<ns>…` for only those
  namespaces; `--matrix` adds the matrix pieces). Never cold-compile in a loop; run the matrices only at
  the end, and `release lib` (the vendored bundle build) only for the final bundle. The details are in
  STATECHARTS.md's "Fast loop".
- `pnpm build` never rebuilds the bundle: Sova's own build and tests use the committed
  `server/vendor/statecharts.js`, so a statechart change reaches the server only through a rebuilt,
  committed bundle (and, for the live server, a restart: AGENTS.md).

## When you change X, also update Y

| You change | Also |
| --- | --- |
| a statechart's states or transitions | its row and inventory in `statecharts/STATECHARTS.md` |
| an event, payload or effect | `statecharts/EVENTS.md` |
| anything the server should run | rebuild `server/vendor/statecharts.js` with `node scripts/build-statecharts.mjs` once committed; `--check` confirms it matches HEAD |

While working: `pnpm statecharts:test` on the watch's output. At the end: the matrices
(`pnpm statecharts:test --matrix`), then `pnpm test` for the server side.
