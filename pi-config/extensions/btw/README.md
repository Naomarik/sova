# btw (forked)

Forked from `npm:pi-btw` 0.4.1 (github.com/dbachelder/pi-btw, MIT). Diverges from upstream:

- Headless hosts (Sova's web UI, pi's rpc mode): the extension detects that
  `ui.custom()` overlays are unsupported and degrades instead of going silent —
  answers persist as displayable `btw-note` messages, bare `/btw` asks its
  question through `ui.input`, and inject/summarize confirm through `ui.confirm`.
- The side thread is a hidden chat in a process of its own (`chat.ts`), started by
  Sova's worker host like any worker, never a pi session inside the main chat's
  process: seeded with the main thread's conversation (none for a tangent) and the
  thread so far, the read/bash/edit/write tools, and the main thread's system prompt
  plus the aside instructions (`child.ts` replaces the chat's prompt with that text,
  read from a 0600 file in `<agent dir>/btw/.runs/<id>/`). Its model calls are
  counted like any chat's. A reload of the main session leaves it running; the
  reopened session reattaches it and records an answer it finished meanwhile, once
  (by the answer's entry id). `/btw:summarize` writes its summary in a second hidden
  chat with no tools. Without Sova's host (the pi TUI) `/btw` says it needs Sova's
  chat runtime.

`index.ts` is what pi loads (a subdirectory extension needs one).

Tests: `npx tsx --test btw.test.ts` (in this directory), against the shared fake worker
host. Strict typecheck, through claude-code's generator:
`node ../claude-code/provider/typecheck.mjs ../../btw/btw.ts ../../btw/chat.ts ../../btw/child.ts`.
