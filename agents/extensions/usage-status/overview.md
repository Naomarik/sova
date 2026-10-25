---
watches: ["pi-config/extensions/usage-status/**", "server/usage-poll.ts", "server/usage-history.ts"]
alsoUpdate: ["pi-config/README.md"]
---
# usage-status

Subscription usage (Ollama Cloud, OpenAI Codex, Claude, Z.ai, DeepSeek balance) in the TUI footer and a `/usage`
overlay. Sova imports its fetchers and cache.

## What lives here

- No README of its own: its row in [`pi-config/README.md`](../../../pi-config/README.md) and the credentials table
  there.
- Tests: `cd pi-config/extensions/usage-status && node --test fetch.test.ts index.test.ts ollama.test.ts && bun test ./overlay.test.ts`.

## What Sova relies on

- `fetch.ts` (fetchers, cache, lock) and `ollama.ts`: imported by `server/insights.ts`, `server/usage-poll.ts`,
  `server/usage-history.ts` and `server/index.ts`. `fetch.ts` imports `claude-code/accounts.ts` and `keychain.ts`
  (builtins only) to fetch each login's usage.
- The usage cache is a contract: `claude` is always Claude Code's own login; each added Claude login's reading is in
  the additive `claudeAccounts`, keyed by login id.
- The dev watcher doesn't watch this directory: an edit reaches a running server only at its restart.

## When you change it, also update

- The cache shape or a provider's reading: the "Layout" row and the credentials table in `pi-config/README.md`, and
  Sova's readers (`server/insights.ts`, `server/usage-poll.ts`) in the same branch.
