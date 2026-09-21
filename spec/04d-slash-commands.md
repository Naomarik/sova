# 04d · Slash commands
> Part of the pi-web design spec · [overview](overview.md)

pi's slash commands, offered while you type. The server sends the list once per connection as
`{type:"commands", commands}`. Names come without the slash (`sessions`, `skill:omarchy`).
Sending `/name args` as a normal prompt runs the command.

## When the menu opens

- **Trigger.** A `/` at the very start of the text, or right after whitespace, opens the menu.
  The **token** is everything from that `/` up to the caret, and it can't contain whitespace.
  The menu stays open while the caret is inside a token, and re-filters on every input.
- **Closing.** The menu closes when:
  - the token ends (a space is typed, or the caret leaves it);
  - `Esc` is pressed, which leaves the text alone;
  - an option is inserted;
  - the textarea loses focus.

  A token dismissed with `Esc` doesn't reopen until its text changes.
- **When it never opens.**
  - No `commands` message has arrived yet, or the list is empty.
  - The composer is disabled (read-only, connecting, reconnecting, or a model switch is pending).
    If it becomes disabled while the menu is open, close it.
- **While streaming it works as usual.** Sending `/name args` with **Steer** is fine. pi runs
  extension commands immediately, even mid-turn, and queues `skill:` and prompt templates as a
  steer with expansion. A turn starting or ending doesn't close the menu. The "Ran" row (below)
  applies in both states.

## Markup

The menu is the **first child of `.composer-inner`** (which is `position: relative`), so it sits
just above the composer at full composer width, at every width including 320.

```html
<div class="command-menu" id="command-menu">
  <p class="command-menu-head" id="command-menu-head" aria-hidden="true">Commands · 3</p>
  <div class="command-list" id="command-listbox" role="listbox" aria-label="Commands">
    <div class="command-option" role="option" id="cmd-sessions" aria-selected="true" data-active>
      <span class="command-option-name">/sessions</span>
      <span class="chip">ext</span>
      <span class="command-option-desc" title="{full description}">Search and focus live pi sessions</span>
      <span class="command-option-location" title="{path}">user</span>
    </div>
    <div class="command-option" role="option" id="cmd-skill-omarchy" aria-selected="false">
      <span class="command-option-name">/skill:omarchy</span>
      <span class="chip">skill</span>
      <span class="command-option-desc">…</span>
      <span class="command-option-location">…</span>
    </div>
  </div>
  <p class="command-menu-foot"><kbd>Enter</kbd> or <kbd>Tab</kbd> to insert · <kbd>Esc</kbd> to close</p>
</div>
```

The textarea gains these attributes, and keeps them only while the menu is open:

```html
<textarea class="input textarea composer-input" id="composer-input" …
          aria-autocomplete="list" aria-controls="command-listbox"
          aria-activedescendant="cmd-sessions"></textarea>
```

- **Pattern.** This is the combobox pattern with a **listbox**, because inserting a name is
  choosing one value. Focus never leaves the textarea, and the active option is
  `aria-activedescendant`.
  - HTML doesn't allow `role="combobox"` on a `<textarea>`, so the textarea keeps its native
    role. It carries `aria-autocomplete="list"`, `aria-controls`, and `aria-activedescendant`,
    which are all valid on a textbox.
  - The active option gets `aria-selected="true"` plus `data-active` (the inset focus ring and
    sunken fill). It's the same treatment as the model menu.
  - Remove the three attributes when the menu closes.
- **Rows.** Each row has two lines and is at least 44px tall.
  - Line 1: the name with its slash, in mono, then the source chip.
  - Line 2: the description (muted, truncated, full text in `title`), then `location` (muted
    mono, up to 16ch, and 8ch when the composer is under 480px wide, with `path` in `title`).
    Leave out whatever is missing.
  - **No description** (`description` is optional, and extension commands may leave it out):
    render only the name, the source chip, and the location if present. Don't render an empty
    `.command-option-desc` or placeholder text. The location stays in the right column under
    the chip, so line 2 is just the right-aligned location. With no location either, the row is
    a single line and still 44px tall. The description tier of filtering skips it.
- **Source chip.** A neutral `.chip` with no dot and no color: `ext` (extension), `prompt`, or
  `skill`. It's a category, not a status, so it carries no hue and no dot.
- **Id.** Option ids are `cmd-` plus the name, with anything outside `[a-z0-9-]` replaced by
  `-`. Add a suffix if two names collide.
- **Head.** "Commands · {n}" is the visible count. It's `aria-hidden` because the announcement
  (below) says the same thing.
- **Size.** Height is capped at `min(320px, 40vh)`, and the list scrolls inside it (keep the
  active option in view with `block: "nearest"`). The foot is hidden under 768px.
- **Motion.** It fades in once.

## Filtering and order

- **Query.** The query is the token without its `/`, matched case-insensitively against `name`.
- **Order.**
  1. Names that **start with** the query.
  2. Names that **contain** it.
  3. Names whose **description** contains it.

  Within each tier, sort by name. An empty query (just `/`) lists every command by name.
- **Active option.** The first row becomes active whenever the results change.
- **Empty result.** Keep the menu open, drop the list, and show
  `<p class="command-menu-empty">0 commands match “/{query}”. Enter sends it as a message.</p>`.
  While it's empty, `Enter` is **not** intercepted: it sends, as the copy says.

## Keyboard and mouse

| Input | Does |
|---|---|
| `↓` / `↑` | Moves the active option, wrapping. It never moves the caret while the menu is open |
| `Enter` / `Tab` | Replaces the token with `/{name} ` (with a trailing space) and closes the menu. The caret lands after the space, so arguments come next. `Enter` doesn't send; the *next* `Enter` does |
| `Esc` | Closes the menu and leaves the text unchanged. It doesn't blur the textarea or clear the draft |
| Typing | Keeps filtering. A space or a caret move out of the token closes the menu |
| `Shift+Enter` | Newline as usual. The newline ends the token, so the menu closes |
| Mouse down on a row | Inserts, the same as `Enter`. Use `mousedown` + `preventDefault()` so the textarea keeps focus. Hover makes a row active |

## Commands row

A tap target for the same menu, for phones (where nobody types `/` from habit) and for
discoverability. It's the flyout's **Commands** row, second in the flyout's menu panel, right under Attach
images (§4 "Composer flyout"):

```html
<div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-commands"
     tabindex="-1" title="Commands">
  <span class="icon icon-sm composer-flyout-icon" style="--icon: url(/icons/command.svg)" aria-hidden="true"></span>
  <span class="composer-flyout-label">Commands</span>
</div>
```

- **Icon.** `/icons/command.svg` is a `/` inside a rounded square, drawn on the system grid
  (24 viewBox, 1.5 stroke, round caps).
- **Tap.** It closes the flyout first, then does what the old button did:
  - It **inserts `/` at the caret**, with a space before it if the character before the caret
    isn't whitespace, and focuses the textarea. The existing trigger rule then opens the menu
    with an **empty query**, so nothing new is needed in the menu logic.
  - If the caret is already inside a `/` token, it just refocuses the textarea and reopens.
  - Focus stays in the textarea, and `aria-activedescendant` works as before.
- **Undo on dismiss.** If the menu closes with `Esc` or blur while the token is **still exactly
  the bare `/` this button inserted**, remove that `/` (and the space it added). Opening and
  dismissing leaves the text as it was. A `/` the user typed is never removed.
- **`aria-expanded`** belongs to the textarea's combobox, not to this row: the menu it opens is
  the textarea's autocomplete, and the flyout is closed by the time it appears.
- **Disabled.** The row takes `aria-disabled="true"` exactly when the menu couldn't open:
  - the composer is disabled (it shares `aria-describedby="composer-reason"`, like Attach);
  - there's no command list yet, or it's empty. Then its `title` becomes "No commands
    available", and there's no composer reason.

  A tap on it does nothing.
- **Unchanged.** Typing `/`, and all the keyboard and touch behavior above, stay as they are.
- **Width budget.** The flyout trigger is 44, and Send collapses to 44 under 480px of composer
  width (§4b), with 8px gaps:

  | Composer width | Idle textarea | Streaming (adds Stop 44) |
  |---|---|---|
  | 390 viewport (358 composer) | about 246px | about 194px |
  | 320 viewport (288 composer) | about 176px | 132px, with nothing hidden — one flyout replaced two buttons |

## Announcements

In the composer's polite live region, announce "{n} commands available." when the menu opens,
and again when the count changes, at most once a second. When there are none, announce
"0 commands match."

## In the thread

- **Sending.** A command goes as a normal `prompt` with the text `/{name} {args}`, or as a
  `steer` while streaming.
- **No optimistic bubble.** When the first token is a known command, don't add the optimistic
  user bubble. The command isn't a message to the model, and a template or skill expands into
  different text.
- **Local row instead.** Append a local `.info-row`:

  ```html
  <div class="info-row" role="note">
    <span class="info-row-text"><span class="icon icon-sm" style="--icon: url(/icons/terminal.svg)" aria-hidden="true"></span>
      <span>Ran <code>/sessions</code></span></span>
  </div>
  ```

  Args go inside the `<code>` too, truncated at 60 characters.
- **What follows.** Everything after that arrives as normal events and items, and renders with
  what already exists:
  - **Prompt templates and skills** expand into a **user** message (the expanded text), then an
    assistant turn.
  - **Extension commands** may add `custom` entries, which render as **info rows** (or
    **unknown** rows with the Raw entry disclosure). They may also send `ui_request`s (§6), or
    produce nothing visible.
- **Reload.** The persisted entries render the same way. The local "Ran" row is local only and
  isn't restored.
- **Unknown commands.** A `/word` that isn't in the list is sent and rendered as an ordinary
  message, with the optimistic bubble.
- **Local commands.** A few commands pi-web answers itself and never sends: a bare `/new`
  (below), and a bare `/agents` / `/subagents`, which opens the subagents pane (§11 Trigger).
  Those two are still listed and inserted like any other command — the runtime registers them —
  but Enter runs them here, clears the draft, and adds no row to the thread: the pane opening is
  the result. Once the whole text is a bare local command the menu closes, and Enter runs it
  rather than inserting a match (`/new` would otherwise pick `btw:new`); a partial token like
  `/ne` still opens it. Anything with arguments belongs to the runtime and goes through
  untouched.
- **`/new`.** Bare `/new` is a local command too, as in the TUI: it creates an empty session in
  the chat's folder, opens it with the composer focused, and archives the session it left (only
  once the new one exists). A session that isn't web-spawned, or whose subagents are working,
  stays unarchived: archiving closes the runtime. The runtime doesn't register it, so it isn't
  in the menu. With arguments or images it's an ordinary message.

## Commands that need the terminal UI

Some extension commands open TUI-only interfaces, such as custom overlays and pickers. pi-web
can't show those. When a command's `ui_request` has a kind §6 doesn't support, or the server
reports the command needs the TUI (answer the request with `ui_response` `value: null` so the
command isn't left waiting), replace the "Ran" row with:

```html
<div class="info-row" role="note">
  <span class="info-row-text"><span class="icon icon-sm" style="--icon: url(/icons/attention.svg)" aria-hidden="true"></span>
    <span><code>/sessions</code> needs the terminal UI. Run it in pi in a terminal.</span></span>
</div>
```

Nothing in the contract says ahead of time which commands are TUI-only, so every command is
listed and choosable. If a flag is added later (for example `tui: true`), show "Needs the
terminal UI" in place of the description on line 2, and keep the row choosable.

## Tokens

- **Menu.** `--color-surface` with a `--color-border` edge, `--r-md`, `--shadow-2`, and
  `max-height: min(320px, 40vh)`. It sits `--space-3 + --space-1` above the composer's content,
  on `z-index: 5` inside the composer's own stacking context.
- **Head.** Eyebrow style (`--font-mono`, `--fs-micro`, `--ls-eyebrow`) in `--color-ink-muted`.
- **Rows.** `--control-md` minimum. Name in `--font-mono` / `--fs-mono` / `--color-ink`.
  Description `--fs-caption` in `--color-ink-muted`; location `--font-mono` in
  `--color-ink-muted`. Hover and active use `--color-sunken`, and active adds the
  `--focus-ring` inset.
- **Chip.** The neutral `.chip`: `--color-ink-2` on `--color-surface`, with a `--color-border`
  edge.

## Contrast

| Pair | Dark | Light |
|---|---|---|
| Ink on surface or sunken (name) | 12.34 / 13.43 | 17.86 / 14.78 |
| Muted on surface or sunken (description, location) | 4.96 / 5.40 | 5.74 / 4.75 |
| Ink-2 on surface (chip) | 7.03 | 8.72 |
| Accent ring on sunken | 5.08 | 5.63 |

---

