---
watches: ["pi-config/extensions/stamp/**", "src/lib/format.ts"]
alsoUpdate: ["pi-config/extensions/stamp/README.md"]
---
# stamp

A dim, right-aligned `1:43 PM · 5m ago` under each message in the TUI transcript. Its formatter is also Sova's, so
both show the same times.

## What lives here

- [`README.md`](../../../pi-config/extensions/stamp/README.md).
- Tests: `cd pi-config/extensions/stamp && node --test format.test.ts index.test.ts`.

## What Sova relies on

- `format.ts` (no imports): the 12-hour clock, the date-prefixed stamp and the relative age. `src/lib/format.ts`
  re-exports it for the web app; Vite bundles it for the browser, so it must import nothing at all.
- The server imports it directly for the ages on `sova_session`'s topics (`server/overseer-tools.ts`) and in the
  Overseer's org view (`server/overseer-org-view.ts`).

## When you change it, also update

- The format: the README, and run `pnpm test` (web and Overseer tests read these strings).
