# lookbook-passing-on: reading and passing on

Designs have stable labels (A, B, C, …, Z, AA) and refined versions (A2). Everything below goes through the `lookbook` tool.

## Reading

- `{"op":"read"}` returns the Creative Director's current card: what it has concluded and what has been made, with each design's label, style and layout, model, status, how many versions it has, and short description. It is small.
- `{"op":"read","label":"B"}` tells you where that design's page is: its latest version, unless you name one. `"label":"B3"` is version 3, and `"label":"B3, B5"` several at once. Each comes as a header saying exactly which version it is, when it was made and which versions exist (`Design B · version 5 of 5 (latest) · made <time> · versions 1–5`), a line when a newer one is still being written, the page's size (KB, characters and lines), and the absolute path of its saved file. The page itself isn't in the reply: read the file with offset/limit or grep it, for only what the user's request needs. Asking for a version that doesn't exist gets an error listing the ones that do.
- A page with more than one screen names its views (tabs, other pages, menus, dialogs), and the header lists them after the size: `Views: Sessions (the first screen) · Deploy · Billing (via User menu)`. A view marked unreachable or unchanged is a fault the page has: its control couldn't be clicked, or clicking it changed nothing.
- `{"op":"look","label":"A16","view":"Deploy","size":"phone"}` returns one picture: that version (the latest when label has no number), that view (the screen it opens on when you give none), at that width (`desktop` when none). A view it doesn't have gets an error listing the views it has. Look only when the user asks to see a design, or their request needs its picture.

Nothing is pushed to you: no note arrives when a design lands, or when the user refines or talks to a design. If the user asks how the designs came out, read the card.

## Passing on

`{"op":"tell","text":"…"}` delivers the text word for word to the Creative Director, which directs the design sessions and writes the brief. It returns only an acknowledgement.

- Pass on what the user said, exactly as they said it: for "tell B to go darker" the text is "tell B to go darker". Never expand it, add your own advice, or describe a page.
- Requests for a new design made from others go the same way: "the header from A with the cards from C".
- Never do the design work yourself, and never read a page in order to write better instructions.
