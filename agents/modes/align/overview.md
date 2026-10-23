---
watches: ["pi-config/extensions/mode/align*.ts", "pi-config/extensions/mode/review*.ts", "server/align-state.ts", "server/align-settings.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md"]
---
# align

The minor mode in which the agent investigates, records an alignment with the `align` tool (findings, approach,
rejected alternatives, questions with recommendations), then waits for the user's answers. Sova renders the
alignments as cards and owns its settings file.

## What lives here

- `pi-config/extensions/mode/README.md`, "Minor modes", "Alignments" and "Writing style and Visuals"; the site pages
  `site/src/content/docs/modes/align/` (`index.md`, `review.md`). Requirements: §chat/alignment
  (§chat.alignment/settings-file, §chat.alignment/visuals).
- Code: `align.ts` (the details shape and fold), `align-tool.ts`, `align-file.ts`, `align-ui.ts`,
  `align-settings.ts`, the align text in `minor.ts`, and the adversarial review (`review-prompt.ts`).
- Tests: `cd pi-config/extensions/mode && node --test align.test.ts align-settings.test.ts review.test.ts && node tests/align-turn.mjs && node tests/style-turn.mjs`.

## What Sova relies on

**The tool's results.** Each `align` result's `details` is `{v: 1, doc?, changes, line, exempt?}`: the touched
alignment's whole snapshot, newest per id on the branch wins. Sova reads it for the card, the composer chip and the
session list (`SessionSummary.align`). `align.ts` (builtins only) holds the shape, its strict check
`normalizeAlignDetails` and the one fold `foldAlignments`; `server/transcript.ts` and `server/align-state.ts` import
it, so the transcript's align row and the session list read what the extension writes with its own code. A feature
request chat (§app.project-assistant/feature-chats) gets a Sova-served `align` (`server/feature-chat-align.ts`) built
on `applyAlignCall` with no `technical`, `import`, `status` or `exempt`; its results' documents become the owner
page's plan card (`server/baton-view.ts` `planOf`). A change to `applyAlignCall`'s op table or the details shape
reaches both.
- **An option's `tradeoff` is its consequence line**: one plain line on what happens if the user picks it. Sova
  sends it, with the ask and the recommendation, to the alignment card's triage (`server/align-triage.ts`,
  §app.decisions/align-triage: a stakes chip per open question, one decision per card version). Renaming the field
  or dropping the line breaks that reader; accepting never depends on it.
- The hidden `align-state` / `align-nudge` custom messages must stay hidden in Sova (`display: false`).
- An older session's `align-doc` custom entries are read-only.

**The settings file.** `mode-align.json` (agent dir) holds the writing style and Visuals:
`{version: 1, style: "default" | "simplified" | "pm", visuals}`. One module, `align-settings.ts` (builtins only plus
`mode/delegate.ts`), holds the shape, the strict parse, a reader that reads a missing or malformed file as Default
with Visuals off, the atomic writer and `resolveAlign`. Settings → Alignment writes it; it syncs like
`mode-spec.json`. A subagent profile's optional `alignment` `{style?, visuals?}` overrides it field by field
(§chat.alignment/settings-file).
- **Style** is re-read by every session at each turn boundary. A change reaches an open chat as one hidden
  `mode-note` whose details record `style` / `headStyle`. A head fixed in a style other than Default records it in the
  extension's own `mode-head` custom entry `{v: 1, style}` (none: Default, once a prompt went out since the last
  compaction).
- **Visuals** are read at session start. In Sova they come from the chat's `sova-align-launch` state entry
  `{v: 1, review, visuals}` (Sova's own, written with the chat's first message; the first in the file holds), handed
  over as the `align-visuals` flag `on` | `off`. In the TUI the flag is absent and the file is read. Visuals bring the
  vis tools ([vis](../vis/overview.md), `visToolsWanted`).

## When you change it, also update

- The details shape, the fold or a hidden message: `normalizeAlignDetails`, the README, Sova's card and session-list
  readers, and the golden fixtures under `server/harness/pi/golden/` if a recorded shape moves.
- The style or Visuals rules: the README's "Writing style and Visuals", Settings → Alignment, and the site pages.
- With spec on too, the align call that sets an alignment implementing ends with the Agree step (`align-tool.ts`):
  keep it in step with [spec](../spec/overview.md).
