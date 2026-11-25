# lookbook-setup: filling in Setup

`lookbook` with `{"op":"start", …}` puts a Setup card in the chat and returns its id. Every field is optional and the user can change all of them on the card, so write down only what they said.

- `brief`: what to design, in the user's words (the card's What Do You Want to Design box). A screen, an address, a project, or a new idea.
- `modelGroups`: whole groups the user named, resolved by Sova: "ollama-cloud" for "all Ollama", "claude" for "all Claude". Use these rather than listing models.
- `models`: particular models the user named, as ids.
- `directions`: style names from `lookbook-directions`, when the user named or clearly described some.
- `layouts`: layout names from `lookbook-directions` ("try a compact and a bento version": Compact, Bento), only when the user named or clearly described some. With none, each designer arranges its own page.
- `coordinator`: the model id, only when the user named one to be the Creative Director (or "coordinator").
- `efforts`: the thinking level the user named for a designer, by model (`{"anthropic/claude-opus-5-5": "high"}`), or `"all"` for every ticked designer. Without one, each designs at low. A level the model doesn't take is refused, naming the ones it takes.

- `images`: the paths of the images the user attached when asking (a screenshot of the screen to redesign, a logo), exactly as `tell` takes them. They join the run's own images: Setup shows them, and the Creative Director sees them from its first turn. Pass every attached image here, never as a path in `brief`; images attached later go with `edit` while the card is in Setup, with `tell` after. Each must be a PNG, JPEG, WebP or GIF up to 8 MB, directly in `/tmp`, in Sova's attachments folder, or in your own shared folder (any folder below it); copy one from anywhere else into your shared folder first (with your sandbox on, `/tmp` is your own, as your tools see it). A refused one is named with why (not in one of those places, not an image, over 8 MB, no file there) and the places.
- `skills`: design skills the user named for this Lookbook, and only those: nothing loads by itself, this project's own skills included. Pass each as a skill's name ("use the brand skill": `brand`; "use this project's design skill": that skill's name) or as a folder holding SKILL.md, by an absolute or `~` path ("the kit in ~/kits/acme"). When the user named none, pass none. Pass their words as they said them rather than guessing a path: one Sova can't find becomes a question on the brief.

Models the user has barred for workers in Settings never appear, whatever you ask for.

What the card does after that is not yours to manage:

- The default is 6 designs: 2 models across 3 styles. With layouts ticked, the card pairs each style with a layout (Pair Up) or makes every style in every layout (Every Mix); the user chooses. Above 12 in one launch the user is asked, with an estimate, when they press Start on the brief, and a launch stops at 24.
- The card has one Creative Director dropdown: one model holds it at a time. It can coordinate without designing.
- A link in the box gets a row to choose Use Its Images, Just Its Feel or Not a Reference.
- The card shows the skills the run uses, and the brief the ones the Creative Director chose for the designers; there is nothing to tick.
- Start Creative Director hands everything to the Creative Director session, which writes a Design Brief on the same card. The user answers its questions there and presses Start, which launches the designs. Nothing the user does on the card reaches you, and no turn of yours is needed.

## Changing the card

When the user asks for a change after the card is up, call `lookbook` with `{"op":"edit", …}` and only what they asked to change; it never opens a second card and never presses a button. The latest change wins the whole card, so a field you don't send stays as the user left it.

- `models` / `removeModels`, `modelGroups` / `removeModelGroups`: designers to add or take off. Only models on the card; a provider the user hid, or one that can't run now, is refused by name.
- `efforts`: as on start.
- `coordinator`: the Creative Director, only before Start Creative Director.
- `directions` / `removeDirections`, `layouts` / `removeLayouts`: styles and layouts to tick or untick. `combine`: `pair` (Pair Up) or `every` (Every Mix).
- `brief`: the request's whole new words. `images`: pictures to add; `removeImages`: names (img-1) to take off this run (they stay in the chat's images). These three only before Start Creative Director; after it they go to the Creative Director with `tell`. `skills` / `removeSkills`: until Start on the brief. After Start Creative Director Sova tells the Creative Director of the change itself (never `tell` it), and a skill not found is only named in the result, never asked about on the brief.
- `run`: only when it isn't this chat's newest Lookbook.

It answers with what the card now holds (designers with their efforts, the Creative Director, styles, layouts, how many designs, images by name) and each thing that couldn't change, and why. Say what you changed in your reply. Once Start on the brief is pressed, nothing on the card changes any more.
