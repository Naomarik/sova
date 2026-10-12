---
watches: ["pi-config/extensions/command-palette/**", "server/model-favorites.ts"]
alsoUpdate: ["pi-config/extensions/command-palette/README.md"]
---
# command-palette

The TUI's `Ctrl+P` palette over models, sessions, settings and extension commands. Sova shares its model
favorites through the palette's own reader and writer.

## What lives here

- [`README.md`](../../../pi-config/extensions/command-palette/README.md).
- Tests: `cd pi-config/extensions/command-palette && node --test test.mjs`.

## What Sova relies on

- `model-favorites.json` (`~/.pi/agent/model-favorites.json`, `{version: 1, models: [{provider, id}]}`). A malformed
  file lists no favorites.
- `server/model-favorites.ts` imports `favorites.ts`: `ModelFavorites`, the one reader and writer of that file, with
  its lock, re-read and atomic rename, for the TUI palette and Sova's picker alike (the picker's star and Ctrl+F →
  `PUT /api/models/favorite`). `server/sync/docs.ts` syncs the file.
- The dev watcher doesn't watch this directory: an edit reaches a running server only at its restart.

## When you change it, also update

- The file shape or `ModelFavorites`: the README, and run `pnpm test -- server/model-favorites.test.ts`.
