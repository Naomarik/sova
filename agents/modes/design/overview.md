---
watches: ["pi-config/extensions/mode/design/**", "pi-config/extensions/mode/design-guide.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md", "site/src/content/docs/modes/design.md"]
---
# design

The minor mode that has a chat send one-page prototypes out to hidden design sessions on several models. It is one
row in the mode table plus guide text. Every tool is served by Sova's server, so a terminal has nothing to run.

## What lives here

- The text, `pi-config/extensions/mode/design/`, read once at load by `design-guide.ts` (node builtins only):
  - `overview.md`: the block every turn pays for. Keep it short; `minor.ts` composes it (`DESIGN_INSTRUCTIONS`).
  - `setup.md`, `directions.md`, `passing-on.md`: the `design_guide` topics (`DESIGN_GUIDE_TOPICS`, `designGuide`).
  - `directions.md` is also data: one `- Name: definition` line per direction, 20 in all (`DESIGN_DIRECTIONS`).
  - `session/`: a design session's system prompt (`designSessionPrompt`). `brief.md` holds slots filled from a
    `task-*.md` (what the first message carries) and a `delivery-*.md` (tool, or reply for a no-tool-stream model).
  - `coordinator.md`: the coordinator's system prompt (`DESIGN_COORDINATOR_PROMPT`).
- The brief and directions come from RakibaDesigns (its LLM prompts and config files), nearly word
  for word. Sova's own changes are delivery, hand-in, "THE PAGE IS SEALED" and "LATER MESSAGES".
- The site page: `site/src/content/docs/modes/design.md`.
- Tests: `server/design-guide.test.ts`.

## What Sova relies on

- **Web-only.** `MINOR_SURFACES.design` is `"web"`. The switch in `server/chat-manager.ts` permits it through
  `withWebMinors` (`server/memory/permit.ts`), the same way as memory. `MINOR_WORKER.design` is false.
- **Text names the tools.** The prompts name `design`, `design_guide`, `design_stream`, `design_hand_in`,
  `design_look`, `coordinator_card`, `design_brief`, `design_status`, `design_new`, `design_send`, `design_browse`
  and their arguments. A renamed tool or argument changes the text in the same branch.
- **Reply markers.** `DESIGN_PAGE_START` and `DESIGN_PAGE_END` equal `DESIGN_PAGE_OPEN` and `DESIGN_PAGE_CLOSE` in
  `shared/design.ts` (pi-config can't import `shared/`). `server/design-guide.test.ts` keeps them equal.
- **The sealed frame.** The brief says only Google Fonts load. It must keep saying what the frame actually blocks.

## When you change it, also update

- A new or removed direction: the count in `parseDirections` and the site page.
- A new `design_guide` topic: `DESIGN_GUIDE_TOPICS`, and its name in `overview.md`.
- What a user sees: the site page and the mode README.
