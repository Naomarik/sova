# §app/command-palette — Command palette and shortcut sheet
> Part of the Sova design spec · [overview](../design/overview.md)

One place, opened from the keyboard or a chat composer's `plus` button, that lists where you can
go and what you can run from where you are, and one sheet that lists the app's keyboard shortcuts. Both live in the browser only: the
palette reads the server's command list (`GET /api/commands`) and runs an entry as exactly the request its route takes, so every refusal is
the route's own. It adds no route and changes none.

Owns: the two keys that open them, the `plus` button's opening of the palette, what the palette lists, how a row is picked, the panel a
command runs from, the reasons a row is disabled, and the sheet. Not here: the slash menu itself
(§chat/slash-commands), the dialogs a row opens (§app/new-session-dialog, §app/settings-dialog),
and the other app-wide keys, which keep their own claims (Alt+O §app.overseer/identity-and-clear,
Ctrl/⌘+P §chat.model-menu/keyboard, Ctrl/⌘+B and `/` §app.session-list/spine).

All app-wide keys are rows of one table (`src/commands/keys.ts`), and no keydown fires two of
them. The two keys here take over these browser defaults, and nothing else in the app used them:

| Key | Was | Now |
|---|---|---|
| `Ctrl+K` / `⌘K` | Chrome and Edge: focus the address bar for a search. Firefox: focus web search | Opens or closes the palette (`preventDefault()`) |
| `Ctrl+K` in a text field on a Mac | Delete to the end of the line (the system's text binding) | Unchanged: the palette doesn't take it there; `⌘K` opens it |
| `?` outside a text field | Nothing | Opens the shortcut sheet. In a text field it types `?` as before |

## §app.command-palette/opening — Opening and closing the palette

- **`Ctrl+K` or `⌘K`** opens the palette from anywhere in the app, text fields included, and
  closes it when it's open. On a Mac, `Ctrl+K` in a text field stays the field's own.
- **The composer's `plus` button** (§chat.composer/composer-flyout) opens it too, in any chat
  (a watched one included) and at every width. Opened that way, every row about the open chat or
  session acts on the chat whose `plus` was pressed, even in a workspace whose focused pane is
  another (§workspace/groups). Opened by the key, they act on the open chat, a workspace's
  focused pane.
- It's a modal (`.modal`, a bottom sheet under 768px): the title **Commands**, a search field
  with focus and the placeholder "Type a command", the list, and one line of help at the foot:
  "Choose with ↑ ↓, then Enter. Esc closes."
- **On a phone** (a coarse pointer, or a window under 768px), opened from `plus`, nothing takes
  focus that would raise the keyboard: the search field is left unfocused, and tapping it types as
  usual. The key still focuses it. The help line, which is about keys, isn't shown on a phone.
- **Closing:** `Esc` (from a command's panel, `Esc` goes back to the list first), the scrim, or the
  key again. Focus returns to what had it before; opened from `plus`, `Esc` and the scrim return
  it to that `plus` button. Each opening starts empty: no query, no row
  active, no panel. Holding the key down toggles it once, never open and closed again.
- **Nothing before the first open.** Until it's first opened the palette costs the page only its
  key: its code is a separate file the browser fetches on the first open, and it asks the server
  for the command list at each opening, never before. From the second opening on, the list this
  tab got last shows at once while the new answer comes; an unchanged answer changes nothing on
  screen. With 300 rows it paints within 50 ms of the key.

## §app.command-palette/rows — What the palette lists

Rows come in groups, each under a `.popover-label`, in this order. A group with no rows is left
out.

1. **This chat:** the chat's own actions, in this order: **Attach images**, **Hide tool calls**
   (**Show tool calls** while they're hidden), **Hide thinking** (**Show thinking** while it's
   hidden), **Playbooks**, and **Undo last turn**. Only while a chat with a composer is open, or
   the one whose `plus` opened the palette. There are no Sandbox rows: the sandbox shield is the
   one place to set the sandbox (§chat.composer/sandbox-shield).
2. **Go to:** the views of this window. The Overseer, Overview, Usage, Agents, Projects,
   Organizations, Mesh and Shares pages; Search Sessions; Collapse Sessions Pane (Expand Sessions
   Pane while collapsed); Keyboard Shortcuts; each Settings tab ("Settings: Models"); and each
   installed extension's page, by its title. A keyed row does exactly what its key does (Collapse
   Sessions Pane is `Ctrl/⌘+B`). A view that has a key shows it at the row's
   end (`Alt+O`, `/`, `Ctrl/⌘+B`, `?`).
3. **Slash commands:** the chat's slash commands, as the slash menu lists them
   (§chat/slash-commands), each as `/name` with its description. Only while a chat with a
   composer is open, as This chat.
4. **Commands:** every entry of the server's command list, core first, each by its label with its
   id in mono. Entries an installed extension adds come last, under **Extensions**.

While the list loads the Commands group says "Loading commands…". If the server can't give it:
"Couldn't load the server's commands. Go to and chat rows still work."

**Filtering.** Typing narrows every group at once by label, id, and description, best match
first within a group; the groups keep their order. With nothing matching: "{n} commands. None
match “{query}”."

## §app.command-palette/picking — Nothing runs on its own

- No row is active when the palette opens, and none after each change of the query. `↓` / `↑`
  make a row active, wrapping; hovering a row makes it active.
- `Enter` acts on the active row, and only on it. With no active row `Enter` does nothing: the
  palette never acts on the first match, a lone match, or anything at all on close.
- A click acts on the clicked row.
- **Go to** rows go there and close the palette.
- **This chat** rows act on that chat:
  - **Attach images** opens the composer's file picker within the same click or key press (a
    phone's browser opens a picker only from the tap that asked for it) and closes the palette.
  - **Hide tool calls** and **Hide thinking** (and their Show forms) flip whether this chat's
    transcript hides its tool calls or its thinking, a view preference this browser keeps per
    session, and close the palette; the next opening shows the
    other word.
  - **Playbooks** closes the palette and opens the Playbooks dialog (§chat/playbooks).
  - **Undo last turn** takes two picks, in place, with no modal: the first relabels the row
    "Confirm: undo last turn", with "Pick it again to rewind." as its description, and the palette
    stays open; the second rewinds to just before your last message, as §chat.timeline/rewind
    does, and closes the palette. Each opening starts disarmed, and closing disarms it.
- **Slash commands** rows put `/name ` in the composer (with a trailing space, as the slash menu's
  `Enter` does, §chat.slash-commands/keyboard-and-mouse), close the palette and focus the
  textarea. Nothing is sent: the composer's own `Enter` sends it.
- **Commands** rows open the command's panel (§app.command-palette/command-panel). Picking never
  runs a command.

## §app.command-palette/disabled — Disabled rows say why

A row that can't act now is `aria-disabled="true"`, with its reason as the row's description
(`.popover-item-desc`), never a silent gray-out. It stays in the list and reachable with the
arrows, and acting on it does nothing. The reasons are hints for the display: a command's route
still decides when it runs.

| Row | Disabled while | Reason |
|---|---|---|
| A command that names a session | No session is open | "Open a session first." |
| A command its route refuses while a terminal has the session open | The open session is open in a terminal | "Not while a terminal has this session open." |
| A command with a required param the panel can't take | Always | "Needs the command line: `sova run {id}`." |
| A slash command row | The composer holds a draft | "The composer has a draft." |
| A slash command row | The composer is off (read-only, connecting) | The composer's own reason, as it shows under the composer |
| Attach images, Playbooks | The composer is off (a watched session, read-only, connecting) | The composer's own reason |
| Playbooks | The chat can't send one (no Sova chat holds it) and the composer gives no reason | "Only a chat open in Sova can send a playbook." |
| Undo last turn | It can't rewind now | The composer's own reason; else "Stop the turn first, then undo.", "Wait for compaction to finish, then undo.", "A rewind is already in progress." or "Nothing to undo yet." (§design.copy-deck/timeline-tab); before the chat has said where its last message is, "This chat is still loading."; with no Sova chat holding it, "Only a chat open in Sova can rewind." |

Hide tool calls and Hide thinking are never disabled: they change only how this tab draws the
chat, so they work in a watched session too. A draft disables only the slash command rows.
| Collapse Sessions Pane | The window is under 768px | "Only on a wide window." |

## §app.command-palette/command-panel — Running a command

Picking a command opens its panel in place of the list: its label as the heading, its summary,
a form made from its params, and one button.

- **The form.** One field per param: a text field for a string, path or list (a list takes
  commas: "Separate with commas"), a number field for a number, a checkbox for a boolean, and a
  select for a param with a fixed set of values. A required field says so. The session a command
  names is the open session, shown by its title and not editable. A param that takes JSON is left
  out, and then the panel says "The command line takes more: `sova run {id}`"
- **Its own dialog.** A command that has a dialog in the app opens that dialog instead of a panel,
  and closes the palette: New Session opens the New Session dialog; Save Alignment Settings opens
  Settings at Alignment.
- **The button** is the command's label. A command that only reads runs on the first press. A
  command that changes something takes two presses, the app's existing two-step press: the first
  arms it ("{Label}?") and shows "Press again to run it.", the second runs it. Leaving the button
  disarms it, and so does any change to a field, so a run only ever uses the values the armed
  button stood over. The arming also holds the session it stood over: the second press runs on
  that session, and the open session changing while it is armed (another chat, the Overseer,
  Back) disarms it, so the next press arms again on the new session and nothing runs. `Enter` in a
  field presses the button.
- **Running** sends exactly the request the command's route takes, as `sova run` does, to the host
  that holds the open session when it is a peer's (a command that names it by id, as Show Session
  or Set Session Tags, goes there as one that names it by path does), and shows
  the answer under the button: "Done." and the answer's body in mono, or the route's own refusal
  sentence. An in-chat action whose outcome isn't known (`sova run`'s exit 5) never says "Done.":
  "Handed to the chat, but its outcome is unknown. Check the chat before you run it again: it
  wasn't and won't be retried." While it runs the button says "Running…". The panel stays open,
  so the answer can be read, and the next run starts from the same form. A field left empty or
  out of shape stops the run before any request: "Fill in {param}." or "Give {param} a whole
  number."

- `Esc`, or **Back**, returns to the list with the query as it was.

## §app.command-palette/shortcut-sheet — The shortcut sheet

- **`?`** opens it from anywhere outside a text field (on a US keyboard, `Shift+/`). In a text
  field `?` types as before. The palette's Keyboard Shortcuts row opens it too.
- It's a modal titled **Keyboard Shortcuts**: one row for each app-wide key in the key table, its
  key in mono and what it does, then the palette's own keys (`↑` `↓`, `Enter`, `Esc`). The
  keys inside one panel (a workspace's `Ctrl+Alt+←/→`, a dialog's `Esc`) keep their own claims and
  aren't listed.
- `Esc`, the scrim, or **Close** closes it, and focus returns to what had it.
- Like the palette, its code loads on its first opening.
