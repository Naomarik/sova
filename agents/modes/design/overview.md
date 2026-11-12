---
watches: ["pi-config/extensions/mode/design/**", "pi-config/extensions/mode/vis/lookbook*.md", "pi-config/extensions/mode/design-guide.ts", "server/design/tools.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md", "site/src/content/docs/modes/vis/lookbook.md"]
---
# Lookbook

A Lookbook has a chat send one-page prototypes out to hidden design sessions on several models. It is no
minor mode: it is a tool-backed entry in the vis catalogue, as tours are, so it exists only with vis on.
Every tool is served by Sova's server, so a terminal has nothing to run.

## What lives here

- The main chat's guide, in `pi-config/extensions/mode/vis/` (read by `minor.ts` with the rest of vis/):
  - `lookbook.md`: the core `vis_guide {kind:"lookbook"}` returns alone: when the user has asked for one
    (the trigger wording and its yes/no examples), how to start, read and pass on. It costs nothing until
    looked up; vis/overview.md's one `lookbook` line is all a chat carries before that.
  - `lookbook-setup.md`, `lookbook-directions.md`, `lookbook-passing-on.md`: the parts it names
    (`VIS_TOOL_PARTS`), each returned alone. `lookbook-directions.md` is also data: one `- Name: definition`
    line per style, read by `design-guide.ts` (`DESIGN_DIRECTIONS`).
  - `VIS_TOOL_ENTRIES` / `VIS_TOOL_PARTS` keep these files out of `VIS_KIND_FILES`: none is a drawing kind.
- `pi-config/extensions/mode/design/`, read once at load by `design-guide.ts` (node builtins only):
  - `session/`: a design session's system prompt (`designSessionPrompt`). `brief.md` holds slots filled from a
    `task-*.md` (what the first message carries) and a `delivery-*.md` (tool, or reply for a no-tool-stream model).
  - `coordinator.md`: the coordinator's system prompt (`DESIGN_COORDINATOR_PROMPT`).
- The brief and directions come from RakibaDesigns (its LLM prompts and config files), nearly word
  for word. Sova's own changes are delivery, hand-in, "THE PAGE IS SEALED" and "LATER MESSAGES".
- The site page: `site/src/content/docs/modes/vis/lookbook.md`.
- Tests: `server/design-guide.test.ts`.

## What Sova relies on

- **Rides vis.** `lookbook` (`DESIGN_TOOLS` in `server/design/tools.ts`) is active exactly when explicit vis is
  on, as `TOUR_TOOLS` are (`syncVisCheckTool` and the `sova-lookbook` served extension in
  `server/chat-manager.ts`): it changes the tool list only with vis's own toggle, so a Lookbook starting
  never resets a chat's cache. align's Visuals never brings it. Workers, design sessions and the coordinator
  never get it. Its description carries no promptSnippet or guidelines, so the system prompt never moves.
- **The trigger is the model's judgement.** No server gate: the catalogue line and `lookbook.md` say when the
  user has asked. Keep both in step.
- **Text names the tools.** The prompts name `lookbook`, `vis_guide`, `design_stream`, `design_hand_in`,
  `design_look`, `coordinator_card`, `design_brief`, `design_status`, `design_new`, `design_send`, `design_browse`, `design_capture`,
  `design_images`, `design_skill`, the Creative Director's one built-in `read`, and their arguments (the lookbook tool's `skills` too). A renamed tool or argument changes the text in the same branch.
- **Reply markers.** `DESIGN_PAGE_START` and `DESIGN_PAGE_END` equal `DESIGN_PAGE_OPEN` and `DESIGN_PAGE_CLOSE` in
  `shared/design.ts` (pi-config can't import `shared/`). `server/design-guide.test.ts` keeps them equal.
- **Design skills.** A run's skills (`server/design/skills.ts`) are the project's own, found by the harness's loader, plus
  folders the user named; they sit on the run and reach the Creative Director in each run's first message (its session
  outlives runs). Designers read them only through `design_skill`, never pi's file tools.
- **The sealed frame.** The brief says only Google Fonts load. It must keep saying what the frame actually blocks.

## When you change it, also update

- A new or removed style: the count in `parseDirections` and the site page.
- A new guide part: its file in vis/ (heading `# <part>: …`), `VIS_TOOL_PARTS`, its name in `lookbook.md`'s Parts
  line, and the `PARTS` list in `server/design-guide.test.ts`.
- What a user sees: the site page and the mode README.
