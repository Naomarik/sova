# lookbook-setup: filling in Setup

`lookbook` with `{"op":"start", …}` puts a Setup card in the chat and returns its id. Every field is optional and the user can change all of them on the card, so write down only what they said.

- `brief`: what to design, in the user's words (the card's What Do You Want to Design box). A screen, an address, a project, or a new idea.
- `modelGroups`: whole groups the user named, resolved by Sova: "ollama-cloud" for "all Ollama", "claude" for "all Claude". Use these rather than listing models.
- `models`: particular models the user named, as ids.
- `directions`: style names from `lookbook-directions`, when the user named or clearly described some.
- `layouts`: layout names from `lookbook-directions` ("try a compact and a bento version": Compact, Bento), only when the user named or clearly described some. With none, each designer arranges its own page.
- `coordinator`: the model id, only when the user named one to be the Creative Director (or "coordinator").

- `skills`: design skills the user named for this Lookbook ("use the brand skill in ~/kits/acme"), each a folder holding SKILL.md as an absolute or `~` path, or a skill's name. This project's own skills are always used, so never list those. Sova finds each one; one it can't find becomes a question on the brief, so pass their words as they said them rather than guessing a path.

Models the user has barred for workers in Settings never appear, whatever you ask for.

What the card does after that is not yours to manage:

- The default is 6 designs: 2 models across 3 styles. With layouts ticked, the card pairs each style with a layout (Pair Up) or makes every style in every layout (Every Mix); the user chooses. Above 12 in one launch the user is asked, with an estimate, when they press Start on the brief, and a launch stops at 24.
- The card has one Creative Director dropdown: one model holds it at a time. It can coordinate without designing.
- A link in the box gets a row to choose Use Its Images, Just Its Feel or Not a Reference.
- The card and the brief show which design skills the run uses; there is nothing to tick. The Creative Director and every designer read them.
- Start Creative Director hands everything to the Creative Director session, which writes a Design Brief on the same card. The user answers its questions there and presses Start, which launches the designs. Nothing the user does on the card reaches you, and no turn of yours is needed.

If the user asks you to change the selection after the card is up, tell them to change it on the card.
