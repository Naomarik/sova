# §app/command-palette — The plus button's Commands dialog and the shortcut sheet
> Part of the Sova design spec · [overview](../design/overview.md)

One small dialog titled Commands (the Commands palette, as other claims and the code call it),
opened from a chat composer's `plus` button, that lists that chat's own actions, and one sheet that lists the app's keyboard shortcuts. Both live in the browser only, and neither
asks the server for anything to draw itself.

Owns: the `plus` button's opening of the dialog, what it lists, how a row is picked, the reasons a
row is disabled, and the sheet with its `?` key. Not here: the dialogs and panes a row opens
(§chat/playbooks, §chat/images), the slash menu (§chat/slash-commands), the Timeline's Rewind
(§chat.timeline/rewind), and the other app-wide keys, which keep their own claims (Alt+O
§app.overseer/identity-and-clear, Ctrl/⌘+P §chat.model-menu/keyboard, Ctrl/⌘+B and `/`
§app.session-list/spine, a character typed outside a text field §chat.composer/type-anywhere).

There is no app-wide list of everything any more: no view, Settings tab, slash command or server
action is listed or run from it, and no key opens it. A server action runs from the command line
(`sova run`, §app/commands); a view opens from its own place in the app; the shortcut sheet opens
with `?`.

All app-wide keys are rows of one table (`src/commands/keys.ts`), and no keydown fires two of
them. The sheet's key takes over one browser default, and nothing else in the app used it:

| Key | Was | Now |
|---|---|---|
| `Ctrl+K` / `⌘K` | Chrome and Edge: focus the address bar for a search. Firefox: focus web search | The browser's own again: Sova doesn't take it, in a text field or out of one |
| `?` outside a text field | Nothing | Opens the shortcut sheet. In a text field it types `?` as before |

## §app.command-palette/opening — Opening and closing the dialog

- **The composer's `plus` button** (§chat.composer/composer-flyout) is the one way in, in any chat
  (a watched one included) and at every width. Every row acts on the chat whose `plus` was
  pressed, even in a workspace whose focused pane is another (§workspace/groups). No key opens it.
- It's a modal (`.modal`, a bottom sheet under 768px): the title **Commands**, a search field
  with focus and the placeholder "Type a command", the list, and one line of help at the foot:
  "Choose with ↑ ↓, then Enter. Esc closes."
- **On a phone** (a coarse pointer, or a window under 768px) nothing takes focus that would raise
  the keyboard: the search field is left unfocused, and tapping it types as usual. The help line,
  which is about keys, isn't shown on a phone.
- **Closing:** `Esc`, the scrim, or picking a row that closes it. `Esc` and the scrim return focus
  to the `plus` button that opened it. Each opening starts empty: no query and no row active.
- **Nothing before the first open.** Its code is a separate file the browser fetches on the first
  open; it asks the server for nothing, so its rows show at once.

## §app.command-palette/rows — What the dialog lists

Four rows, the chat's own actions, under the **This chat** label, always in this order:

1. **Attach images**
2. **Hide tool calls** (**Show tool calls** while they're hidden)
3. **Hide thinking** (**Show thinking** while it's hidden)
4. **Playbooks**

Nothing else is listed: no Undo last turn (a rewind starts from the Timeline, §chat.timeline/rewind),
no views or Settings tabs, no slash commands (they're typed with `/`, §chat/slash-commands), no
server commands and no extension entries. There are no Sandbox rows either: the sandbox shield is
the one place to set the sandbox (§chat.composer/sandbox-shield).

**Filtering.** Typing narrows the rows by label, best match first. With nothing matching:
"{n} commands. None match “{query}”."

## §app.command-palette/picking — Nothing runs on its own

- No row is active when the dialog opens, and none after each change of the query. `↓` / `↑`
  make a row active, wrapping; hovering a row makes it active.
- `Enter` acts on the active row, and only on it. With no active row `Enter` does nothing: the
  dialog never acts on the first match, a lone match, or anything at all on close.
- A click acts on the clicked row.
- Each row acts on the chat whose `plus` opened the dialog, and closes the dialog:
  - **Attach images** opens the composer's file picker within the same click or key press (a
    phone's browser opens a picker only from the tap that asked for it).
  - **Hide tool calls** and **Hide thinking** (and their Show forms) flip whether this chat's
    transcript hides its tool calls or its thinking, a view preference this browser keeps per
    session; the next opening shows the other word.
  - **Playbooks** opens the Playbooks dialog (§chat/playbooks).

## §app.command-palette/disabled — Disabled rows say why

A row that can't act now is `aria-disabled="true"`, with its reason as the row's description
(`.popover-item-desc`), never a silent gray-out. It stays in the list and reachable with the
arrows, and acting on it does nothing.

| Row | Disabled while | Reason |
|---|---|---|
| Attach images, Playbooks | The composer is off (a watched session, read-only, connecting) | The composer's own reason |
| Playbooks | The chat can't send one (no Sova chat holds it) and the composer gives no reason | "Only a chat open in Sova can send a playbook." |

Hide tool calls and Hide thinking are never disabled: they change only how this tab draws the
chat, so they work in a watched session too.

## §app.command-palette/shortcut-sheet — The shortcut sheet

- **`?`** opens it from anywhere outside a text field (on a US keyboard, `Shift+/`). In a text
  field `?` types as before. It is the one way in: the Commands dialog has no row for it.
- It's a modal titled **Keyboard Shortcuts**: one row for each app-wide key in the key table, its
  key in mono and what it does, then the message box's own keys: shell mode's `!`, "In an empty
  message box: runs a command in this chat's folder.", and `!!`, "In an empty message box: runs a
  command the model never sees." (§chat.shell-mode/box), then its two `Esc` rows, "In an empty ! or
  !! box: leaves shell mode for a message box." (§chat.shell-mode/box) and "In the composer while a
  reply runs: stops it." (§chat.composer/esc-stop). It has no `Ctrl/⌘+K` row: that key is the
  browser's. The keys inside one panel (a workspace's `Ctrl+Alt+←/→`, a dialog's `Esc`, the
  Commands dialog's `↑` `↓` and `Enter`, which its own help line names) keep their own claims and
  aren't listed.
- `Esc`, the scrim, or **Close** closes it, and focus returns to what had it.
- Like the Commands dialog, its code loads on its first opening.
