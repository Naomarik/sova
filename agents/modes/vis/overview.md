---
watches: ["pi-config/extensions/mode/vis/**", "pi-config/extensions/mode/vis-guide-tool.ts", "src/vis/**", "server/vis-check.ts", "server/baton-vis-guide.ts", "server/baton-view.ts", "src/share/markdown.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md", "site/src/content/docs/modes/vis.md"]
---
# vis

The minor mode that has the agent draw small inline visuals (`vis` fences: flow, sequence, tree, timeline, chart, …)
where a picture explains faster than prose. The model is taught exactly the formats Sova's renderer draws, and the
server parses fences with the renderer's own code.

## What lives here

- The guide the model reads: `pi-config/extensions/mode/vis/` (`overview.md` is the prompt, `shared.md` the shared
  rules, one file per kind), read once at load by `minor.ts`; the `vis_guide` tool (`vis-guide-tool.ts`) returns
  `shared.md` then the asked kind's file. A kind file carrying the stub marker is never taught. A worker, which has no
  `vis_guide`, reads the files directly (`VIS_GUIDE_DIR`).
- The tool-backed catalogue entry `tour` is not a fence kind and never joins the renderer registry.
  `vis_guide {kind:"tour"}` returns `vis/tour.md` alone (no shared fence grammar): the core, about 3,000
  tokens, must-know rules first. `vis_guide` also takes the parts the core names (`VIS_TOOL_PARTS`:
  `tour-signin`, `tour-sites`, `tour-sova`, `tour-sharing`), each returned alone and never listed as a kind
  (the tool's enum is `VIS_GUIDE_NAMES`). Each rule lives in exactly one of these files; the recorder's
  failure messages and the sign-in notice cite the part names, so renaming a part changes `server/tours/` too.
  Sova's served `record_tour` / `show_tour` require explicit vis mode; align Visuals alone never
  grants them. A hand-off has only scoped show, independent of drawing switches.
  `VIS_TOOL_ENTRIES` separates these workflow files from `VIS_KIND_FILES`; `src/vis/guide.test.ts` validates
  the core's one worked script with the actual strict normalizer, without treating it as a fence example,
  and `server/tours/tools-signin.test.ts` the two `signIn` examples in `tour-signin.md`.
- The renderer: `src/vis/` (parse side `parse.ts`, `registry.ts`, `core/`, and per kind under `kinds/`). The site
  page: `site/src/content/docs/modes/vis.md`.
- Tests: `pnpm test -- src/vis/*.test.ts src/vis/core/*.test.ts src/vis/kinds/*/*.test.ts` (golden, parse, lenience, layout and guide tests; `src/vis/guide.test.ts` checks the
  guide against the renderer).

## What Sova relies on

- **One rule for the tools.** `visToolsWanted` in `minor.ts`: the vis tools (`vis_guide`, and in Sova's hosted
  sessions `vis_check`) are in the loadout when vis is on, or align is on in a session started with Visuals.
  Tour tools require explicit vis on instead.
  `server/vis-check.ts` and `server/chat-manager.ts` take it from there. Sova's vis retry asks the same rule, so a chat
  whose drawings come from align's Visuals gets it too, for its reply's fences and the visuals its `align` calls write
  on the card; a hard error or a cramped wireframe (`wireframeCramped`, §chat.markdown/vis-wireframe-room) triggers it.
- **The parse side runs on the server.** `server/vis-check.ts` (the vis retry and the `vis_check` tool) imports
  `src/vis/parse.ts`, `src/vis/kinds/frame/parse.ts` and `src/vis/kinds/wireframe/layout.ts` (the cramped check). So the parse side of `src/vis/` (`parse.ts`, `registry.ts`,
  `core/`, each kind's parse and height/layout) must stay DOM- and Solid-free at load, and an edit there reaches the
  running server only at its restart.
- **Share pages.** `server/baton-view.ts` (the share pages' markup backstop) imports `src/share/markdown.ts`
  (`shareFences`, the share page's own markdown-it parse, so it finds fences exactly as the page draws them) with
  `src/vis/parse.ts` and `registry.ts`: keep `src/share/markdown.ts` DOM- and Solid-free too.
  `server/baton-vis-guide.ts` builds a gathering session's drawing guide from the same `vis/` files (`minor.ts`'s
  `VIS_FILES`).
- The other DOM-free imports from `src/` into the server are in [the frontend guide](../../frontend/overview.md).

## When you change it, also update

- A kind's grammar: its file in `mode/vis/`, the renderer under `src/vis/kinds/<kind>/`, and the golden data
  (`src/vis/golden.json`) together; run those tests.
- A new kind: `mode/vis/overview.md`'s line for it, the registry, and the site page.
- A wireframe's sizes (wireframe.css): `layout.ts` in step. What the drawing sizes from its content (a desktop dialog's
  width, a grid's columns) is decided in `layout.ts` and set by the View, so the drawing, the height estimate and the
  server's cramped check agree; the rendered-height table in `layout.test.ts` is recaptured in a browser.
- Anything the parse side imports: keep it DOM- and Solid-free, and say the server needs a restart.
