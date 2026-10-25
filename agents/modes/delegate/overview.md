---
watches: ["pi-config/extensions/mode/delegate.ts", "pi-config/extensions/mode/routing.ts", "server/delegate.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md"]
---
# Delegate

The major mode in which the session orchestrates workers by four profiles (planning, investigation, routine and
complex implementation), each a backend, model and effort with an optional fallback.

## What lives here

- `pi-config/extensions/mode/README.md`, "Delegate routing" and "Workers"; the site page
  `site/src/content/docs/modes/delegate.md`.
- Code: `mode/delegate.ts` (the routing file), `mode/routing.ts` (primary → fallback → ask), `server/delegate.ts`.
- Tests: `cd pi-config/extensions/mode && node --test delegate.test.ts routing.test.ts`.

## What Sova relies on

- `mode-delegate.json` (agent dir) is Delegate's global routing: four profiles, each backend, model and effort plus an
  optional fallback. Sova no longer writes it: Settings → Subagents edits routing per profile, and this file seeds and
  backs that library ([subagents](../../extensions/subagents/overview.md), "Subagent profiles").
- Every Delegate session re-reads its routing at each turn boundary, never snapshotted into a session. With a
  subagent profile picked, the routes come from `resolveSubagents`.
- `delegate.ts` is builtins only and imported by the server (`server/delegate.ts`, `server/sync/docs.ts`, the settings
  modules) and by `subagents/subagent-profiles.ts`; it imports claude-code's `catalog.ts` for model names.

## When you change it, also update

- The routing shape or resolution: the README's "Delegate routing", `subagent-profiles.ts`'s seeding, and the site page.
