---
watches: ["server/memory/**", "shared/memory.ts", "server/harness/pi/memory.ts", "pi-config/extensions/claude-code/provider/memory-view.ts"]
alsoUpdate: [".sova/spec/claims/chat/memory.md"]
---
# memory

The memory minor mode lets a chat outgrow its context: a cheap model folds messages into one-line summaries (the
view), and the model opens any line back with its `zoom` tool. Its engine is Sova's own and harness-neutral; the mode
extension only lists it among the minor modes.

## What lives here

- Requirement: §chat/memory (`.sova/spec/claims/chat/memory.md`), with §chat.memory/turn for the view the model gets.
- `server/memory/`: the engine (`engine.ts`, `tree.ts`, `summarizer.ts`, `store.ts`, `settings.ts`, `routes.ts`,
  `tools.ts`, …), harness-neutral. pi's hooks for it are `server/harness/pi/memory.ts`.
- `shared/memory.ts` (imports only protocol types): the mode's half of the wire contract, read by the server and
  `src/` alike: the type copy, the sizes, the recall rows' summary and the coding-session refusal.
- Tests: the `server/memory/*.test.ts` files (`pnpm test -- server/memory/*.test.ts`).

## What Sova relies on

- **Its files are Sova's own, never pi-config's.**
  - `<agent dir>/mode-memory.json` (Settings → Memory): the summarizer's backend, model and effort with its
    fallback, and the saved default type and size. Read by the server only.
  - One sidecar per chat, `<agent dir>/sova/memory/<session id>/`: `tree.jsonl` (the built summaries) and
    `state.json` (the saved views and cache prefixes). "Fork from here" copies it; archiving or deleting the chat
    removes it.
- A chat's type and size are its `sova-memory` state entry. The Overseer's switch is `overseer.json`'s `memory`.
- The view message the engine builds (the guide, the stable prefix, the newest lines) has its declared shape in
  claude-code's `provider/memory-view.ts` (imports nothing); the Claude Code bridge sends it as written
  ([claude-code](../../extensions/claude-code/overview.md)).
- The summarizer's `claude` spawns use claude-code's `fixed-settings.ts` and the catalog.

## When you change it, also update

- `shared/memory.ts`: both the server and `src/` readers in the same branch (it is part of the wire contract;
  coordinate as for `shared/protocol.ts`).
- The view's shape: `provider/memory-view.ts` and the bridge's tests.
- What the user sees: §chat/memory, through a spec draft ([spec](../spec/overview.md)).
