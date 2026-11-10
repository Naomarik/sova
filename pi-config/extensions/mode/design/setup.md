# Design: filling in Setup

`design` with `{"op":"start", …}` puts a Setup card in the chat and returns its id. Every field is optional and the user can change all of them on the card, so write down only what they said.

- `brief`: what to design, in the user's words (the card's What Do You Want to Design box). A screen, an address, a project, or a new idea.
- `modelGroups`: whole groups the user named, resolved by Sova: "ollama-cloud" for "all Ollama", "claude" for "all Claude". Use these rather than listing models.
- `models`: particular models the user named, as ids.
- `directions`: direction names from the `directions` topic, when the user named or clearly described some.
- `coordinator`: the model id, only when the user named one to coordinate.

Models the user has barred for workers in Settings never appear, whatever you ask for.

What the card does after that is not yours to manage:

- The default is 6 designs: 2 models across 3 directions. Above 12 in one launch the user is asked, with an estimate, when they press Start on the brief, and a launch stops at 24.
- Each model on the card has its own Coordinator checkbox, and one model holds it at a time. It can coordinate without designing.
- A link in the box gets a row to choose Use Its Images, Just Its Feel or Not a Reference.
- Start Coordinator hands everything to the coordinator session, which writes a Design Brief on the same card. The user answers its questions there and presses Start, which launches the designs. Nothing the user does on the card reaches you, and no turn of yours is needed.

If the user asks you to change the selection after the card is up, tell them to change it on the card.
