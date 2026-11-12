# lookbook-setup: filling in Setup

`lookbook` with `{"op":"start", …}` puts a Setup card in the chat and returns its id. Every field is optional and the user can change all of them on the card, so write down only what they said.

- `brief`: what to design, in the user's words (the card's What Do You Want to Design box). A screen, an address, a project, or a new idea.
- `modelGroups`: whole groups the user named, resolved by Sova: "ollama-cloud" for "all Ollama", "claude" for "all Claude". Use these rather than listing models.
- `models`: particular models the user named, as ids.
- `directions`: style names from `lookbook-directions`, when the user named or clearly described some.
- `layouts`: layout names from `lookbook-directions` ("try a compact and a bento version": Compact, Bento), only when the user named or clearly described some. With none, each designer arranges its own page.
- `coordinator`: the model id, only when the user named one to be the Creative Director (or "coordinator").

- `images`: the paths of the images the user attached when asking (a screenshot of the screen to redesign, a logo), exactly as `tell` takes them. They join the run's own images: Setup shows them, and the Creative Director sees them from its first turn. Pass every attached image here, never as a path in `brief`; images attached later go with `tell`.
- `skills`: design skills the user named for this Lookbook, and only those: nothing loads by itself, this project's own skills included. Pass each as a skill's name ("use the brand skill": `brand`; "use this project's design skill": that skill's name) or as a folder holding SKILL.md, by an absolute or `~` path ("the kit in ~/kits/acme"). When the user named none, pass none. Pass their words as they said them rather than guessing a path: one Sova can't find becomes a question on the brief.

Models the user has barred for workers in Settings never appear, whatever you ask for.

What the card does after that is not yours to manage:

- The default is 6 designs: 2 models across 3 styles. With layouts ticked, the card pairs each style with a layout (Pair Up) or makes every style in every layout (Every Mix); the user chooses. Above 12 in one launch the user is asked, with an estimate, when they press Start on the brief, and a launch stops at 24.
- The card has one Creative Director dropdown: one model holds it at a time. It can coordinate without designing.
- A link in the box gets a row to choose Use Its Images, Just Its Feel or Not a Reference.
- The card shows the skills the run uses, and the brief the ones the Creative Director chose for the designers; there is nothing to tick.
- Start Creative Director hands everything to the Creative Director session, which writes a Design Brief on the same card. The user answers its questions there and presses Start, which launches the designs. Nothing the user does on the card reaches you, and no turn of yours is needed.

If the user asks you to change the selection after the card is up, tell them to change it on the card.
