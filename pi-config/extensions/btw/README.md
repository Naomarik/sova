# btw (forked)

Forked from `npm:pi-btw` 0.4.1 (github.com/dbachelder/pi-btw, MIT). Diverges from upstream:

- Headless hosts (pi-web's web UI, pi's rpc mode): the extension detects that
  `ui.custom()` overlays are unsupported and degrades instead of going silent —
  answers persist as displayable `btw-note` messages, bare `/btw` asks its
  question through `ui.input`, and inject/summarize confirm through `ui.confirm`.

Tests: `npx tsx --test btw.test.ts` (in this directory).
