# codefold — Statusband

Folds long fenced code blocks in **main-thread assistant messages** into one
full-width, background-filled band (Proposal E in `../CODEFOLD-PROPOSALS.md`):

```text
▕ python ▕ def load_config(path: str) -> Config:          ▕ 30 lines ▕ ctrl+alt+o ▕
```

- Folds only column-0 ```` ``` ```` / `~~~` fences with more than 12 body lines.
  Short blocks and fences inside lists or quotes render natively.
- `ctrl+alt+o` (or `/codefold`) toggles all blocks. Expanded blocks keep the band as a title
  bar above pi's native fence. The toggle repaints scrollback the same way `ctrl+o` does.
- While streaming, an open fence longer than 12 lines shows `● writing` with a live
  count and its last 2 lines. It folds normally once the fence closes.
- The band follows `availableWidth` and never wraps. As width shrinks it first truncates
  the signature, then switches to `NL` and drops the key hint, then shortens the
  language (`python` → `py`), and below 16 columns shows only the count.
- Display-only: session text isn't changed. `app.message.copy` copies the original,
  but a terminal selection picks up the band.
- Band fill: `customMessageBg`. If that's missing or set to the terminal default, it
  uses the `mdCodeBlock` colour as a background. If neither works, the band is plain
  `dim` text with no fill.

`alt+o` belongs to `topic-outline` and `alt+shift+letter` is invisible to most
terminals, so codefold binds `ctrl+alt+o`. `/codefold` always works; change
`TOGGLE_KEY` in `index.ts` to move the shortcut.

## Files

`fold.ts` holds the pure logic: the fence scanner, signature picker, band layout, and
markdown rewrite. It has no pi imports. `index.ts` wires the transformer, the
shortcut/command, theme lookup, and the TUI capture used for repaints.

`fold.ts` is also the engine behind the `/agents` and `/team` modals
(`../subagents/codefold.ts` adapts transcript items to it). Options they use:

- `threshold` — fold fences with more body lines than this (default 12; the modals use 6).
- `target: "text"` — emit bare band rows in place of each fence instead of markdown
  codespans and paragraph breaks, for surfaces that print lines verbatim.
- `keyLabel` — the folded-band key hint (`o` in the modals).
- `BandSpec.unit: "chars"` — count characters for one long unbroken line.
- `firstMeaningfulLine()` — signature for logs/tool output (`pickSignature()` is for code).

## Verification

```sh
cd ~/pi-config/extensions/codefold
node tests/run.mjs
timeout 30 pi -e ~/.pi/agent/extensions/codefold/index.ts -p "say only OK"
```

Manual check: in a running pi, `/reload`, ask for a 30-line Python file in a fenced
block, then press `ctrl+alt+o` twice.
