# §design/forms — Forms

One small kit draws the boxes Sova's screens take values in: text, number and long-text boxes,
lists, switches, checkboxes and choices. Each is drawn, checked and explained the same way on every
screen that uses it, with the classes §design.overview/class-index lists under Form fields and no
look of its own. Which screens use it, and the few boxes that aren't its, are
§design.forms/inventory.

## §design.forms/field — One red state, one message

A box is a field: its label, an optional hint, the control, and one line under the control for
its message. A value the field doesn't take turns the box red (`aria-invalid="true"`) and puts one
sentence under it, tied to the box (`aria-describedby`) so a screen reader reads it with the box.
A box never shows more than one message, and never the red without the sentence: a sentence the
form itself knows (a clash with another field, the server's refusal of a save) takes the rule's
place under the box, never a second line. Typing a value the field takes clears both at once.

A text box with a most length always shows its count under it, "{n} / {max}" with en-US
separators ("8,001 / 8,000"), grey, and red past the most, when its sentence says how long it may
be. Where the rule trims the text, the count is of the trimmed text. A switch, checkbox or choice is a label row
whose text and control are one target (§app.settings-dialog/toggle-target); a switch a form holds off
may say why in its tooltip. Every search box is the design system's `.search`, its magnifier inside
the box (§design.overview/class-index), so a profile list's "Find a profile" or "Find a subagent
profile" looks like the sidebar's search.

## §design.forms/typed-text — What you typed stays

A box keeps exactly what was typed or pasted. Nothing wipes, trims, rounds, cuts or snaps it back
while you type: a number box holding "", "1e", "-" or "a5" keeps that text, red, and text pasted
past the most stays whole, red, with its count. Number boxes are text boxes with a numeric keyboard
(`inputmode="numeric"`), never `type="number"`, whose browsers empty or alter what a half-typed
value holds. Only the form's own reset (Cancel, Discard, Reset to Defaults) or a save replaces the
text. What is saved is the value read from the text.

## §design.forms/limits — One limits table for the screen and the server

Each limit a field keeps (a range, a most length, the values a list allows, a port, a time) is
written once, in a table under `shared/` that the screen and the server both read. The screen
checks a value with it before anything is sent; the server checks what it receives with the same
rule and refuses it (400) in the same sentence the box shows, the sentences of
§design.copy-deck/forms. So a value the screen takes the server takes, a value it refuses the
server refuses in the same words, and a field never has a server limit the screen doesn't know.
A port is a whole number from 1 to 65,535.

## §design.forms/saving — A red box is never saved

On a form with a Save (the Settings footer, §app.settings-dialog/save-bar, or a tab's own save), a
red box holds it: the Save waits, and its status line names the form and the first red box in
page order, "{Form}: {message}". On a screen that saves as you type, or when you leave the box, a
red box isn't saved: it stays red, and the saved value stays what it was until the box holds a
value the field takes, which is then saved. The one exception is General's Sessions in Recent,
which repairs an unusable value when you leave it (§app.settings-dialog/general).

## §design.forms/inventory — Every box is the kit's

A unit test reads every `.tsx` file under `src/` and every file of the card toolkit
(`src/card-toolkit/`), and fails on a native
`input`, `textarea`, `select` or `contenteditable` drawn outside the kit (`src/components/form/`).
It allows two lists. The exemptions, each with its reason, are the chat message box, the file and
image pickers (any `type="file"` box), and the command palette's search line; an exemption that
matches nothing fails, so it comes off the list. The pending list holds, per file not moved to the
kit yet, how many boxes it draws. A box more than its count fails, and so does a file with fewer
than its count until the list is lowered to match: the list is only ever lowered, so a new box
anywhere is the kit's and the pending list shrinks until it is empty.
