---
watches: ["src/vis/parse.ts", "src/vis/registry.ts", "src/vis/core/**", "src/vis/kinds/*/parse.ts", "src/share/markdown.ts", "src/lib/message.ts", "src/lib/tool-diff-stats.ts", "src/lib/diff/parse.ts", "src/lib/format.ts", ".claude/skills/**"]
alsoUpdate: ["agents/frontend/overview.md"]
---
# Frontend

The SolidJS web app in `src/`: its conventions, the `src/` files the server imports at runtime (which
must stay DOM- and Solid-free), browser testing, and the project skills.

## What lives here, and its docs

- `src/`: SolidJS + TS (Vite, vite-plugin-solid; HMR = live reload). Owned by **frontend**, except
  `src/design/` (design tokens, base CSS), which with `public/` (fonts/icons) is owned by **designer**.
- `.claude/skills/`: project skills, registered for pi by `.pi/settings.json`
  (`"skills": ["../.claude/skills"]`; the folder is also trusted in `~/.pi/agent/trust.json`, or pi
  prompts each session).
  - `.claude/skills/fold-ai-dev-design/`: the design system skill (copied from foldaidev). READ IT
    ([SKILL.md](../../.claude/skills/fold-ai-dev-design/SKILL.md)).
  - `.claude/skills/playwright/`: CDP browser automation via
    `.claude/skills/playwright/scripts/start-browser.sh` + `.claude/skills/playwright/scripts/pw.sh`;
    read its [SKILL.md](../../.claude/skills/playwright/SKILL.md) before any browser work (own browser
    per caller, `resize` must follow `navigate`, a bare `console` reloads the page).
- Related guides: the wire and the pi boundary [agents/server/harness/overview.md](../server/harness/overview.md);
  the vis kinds [agents/modes/vis/overview.md](../modes/vis/overview.md); the pi-config files `src/`
  imports [agents/extensions/overview.md](../extensions/overview.md).

## Rules and contracts

### Conventions

- SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.
- The server normalizes JSONL entries into `TranscriptItem`; the frontend renders those, and renders
  live streaming from `SovaEvent`s (it asks for `wire=2`; `shared/wire-v1.ts` maps an older server's v1
  frames and rows). `src/` never branches on pi event or entry names, and wire additions use
  `SovaEvent`/`RowFacts` (`shared/harness-wire.ts`).
- **Solid's `on(deps, fn)` does not equality-gate the deps' VALUE: it re-fires whenever any signal read
  while evaluating the accessor changes.** `on(() => props.group.id, …)` reads `props.group`, a fresh
  object on every background refresh of the list, so the effect fired on every refresh while the id
  string never changed. Two real misses from that one shape on `fanout-groups`: every pane width
  (Wider/Narrower/Fit) was reset by `setWidths({})` one fetch after the click (styles written at 280px,
  observed resetting to 490px ~283ms later), and the effect that re-read the groups re-triggered itself
  on its own response, a standing fetch loop. When only the VALUE matters, make the dep a memo
  (`const gid = createMemo(() => props.group.id)`) so equality gating happens where you can see it. The
  green build catches none of this: the bug is between two re-runs, not inside either.

### `src/` files the server imports (keep them DOM- and Solid-free)

One runtime import direction runs from the server into `src/`, so these files must load without a DOM
or Solid, and an edit to them reaches the running server only at its restart:

- `server/vis-check.ts` (the vis retry and the `vis_check` tool) imports `src/vis/parse.ts` and
  `src/vis/kinds/frame/parse.ts`: the parse side of `src/vis/` (`parse.ts`, `registry.ts`, `src/vis/core/`,
  `kinds/*/parse` and height/layout) stays DOM- and Solid-free at load.
- `server/baton-view.ts` (the share pages' markup backstop) imports `src/share/markdown.ts`
  (`shareFences`: the share page's own markdown-it parse, so it finds fences exactly as the page draws
  them) with `src/vis/parse.ts` and `registry.ts`.
- `server/transcript.ts` imports `src/lib/message.ts` (`argsSummary`, `contentText`, `spawnName`) and
  `src/lib/tool-diff-stats.ts` (with `src/lib/diff/parse.ts`), so a slim tool row's folded line and
  "+n −m" are the card's own (§chat.transcript/slim-rows).

The other way, `src/` imports a few pi-config files at runtime (`src/lib/format.ts` re-exports
`pi-config/extensions/stamp/format.ts` and imports `pi-config/extensions/claude-code/catalog.ts`;
`src/components/Thread.tsx` imports `pi-config/extensions/show-changes/details.ts`). Vite bundles them
for the browser, so each imports nothing at all; the rules are in
[agents/extensions/overview.md](../extensions/overview.md).

### Browser testing

- Playwright in a fresh worktree: symlink the live tree's
  `.claude/skills/playwright/scripts/node_modules` and remove it afterwards. If port 4810 is taken by
  another worktree, never kill it: run `PORT=481x PI_CODING_AGENT_DIR=<wt>/.agent pnpm exec tsx server/index.ts`.
  After a rebuild, unregister the app's service worker and clear its caches, or the page keeps the
  previous build.
- Web Push testing: use `CHROMIUM_BIN=/usr/bin/google-chrome-stable` (bundled Chromium cannot
  subscribe), and grant, enable, trigger and check inside ONE `pw.sh run`: a CDP permission grant
  resets on detach and Chrome drops the subscription.

## When you change X, also update Y

| You change | Also |
| --- | --- |
| a server-imported `src/` file (list above) | keep it DOM- and Solid-free; say the live server needs a restart (AGENTS.md) |
| a new server import of a `src/` file | add it to the list above |
| a `src/` import of pi-config | the extensions guide's list; the file must import nothing |
| UI | follow the fold-ai-dev-design skill; `src/design/` and `public/` are the designer's |
| what a user sees | a spec claim through a draft (AGENTS.md, Product documentation) |

While working: `pnpm test` (`src/lib/*.test.ts`, `src/vis/**/*.test.ts`; `*.browser.test.ts` run in the
browser-conditions pass), `pnpm run typecheck`, `pnpm run build`, and drive the change in a browser
against `pnpm run dev:hermetic`.
