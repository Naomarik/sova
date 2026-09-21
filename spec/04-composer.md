# 04 · Composer
> Part of the pi-web design spec · [overview](overview.md)

## Anatomy

```html
<footer class="composer" data-drop="active|reject (only while dragging over it)">
  <!-- drag-over overlay; see §4b -->
  <div class="composer-drop" aria-hidden="true">
    <span class="icon" style="--icon: url(/icons/image.svg)"></span><span>Drop images to attach</span>
  </div>
  <form class="composer-inner" aria-label="Message the agent">
    <!-- while streaming only -->
    <p class="run-status"><span class="live-dot"></span>Working<span class="run-status-detail">· running bash</span></p>
    <!-- or, idle with ≥ 1 worker working: the subagents trigger, button.run-status-link (§11) -->

    <!-- pending attachments; omit the <ul> when there are none; see §4b -->
    <ul class="attachments" aria-label="Attachments">…</ul>

    <div class="composer-row">
      <!-- the one flyout trigger; the menu itself is below -->
      <button class="button button-icon button-ghost composer-menu-trigger" type="button" id="composer-menu-trigger"
              aria-label="More Actions" title="More Actions" aria-haspopup="menu" aria-expanded="false"
              aria-controls="composer-flyout">
        <span class="icon" style="--icon: url(/icons/plus.svg)" aria-hidden="true"></span>
      </button>
      <div class="model-menu composer-flyout" id="composer-flyout" popover="auto">…see "Composer flyout"…</div>
      <input class="visually-hidden" type="file" multiple tabindex="-1" aria-hidden="true"
             accept="image/png,image/jpeg,image/gif,image/webp">
      <label class="visually-hidden" for="composer-input">Message</label>
      <textarea class="input textarea composer-input" id="composer-input" rows="1"
                placeholder="Ask pi to…" aria-describedby="composer-reason"></textarea>
      <div class="composer-actions">
        <button class="button button-primary" type="submit">
          <span class="icon" style="--icon: url(/icons/arrow-right.svg)" aria-hidden="true"></span><span class="button-label">Send</span>
        </button>
        <!-- streaming only; last in the row, after the primary -->
        <button class="button button-destructive" type="button">
          <span class="icon" style="--icon: url(/icons/stop.svg)" aria-hidden="true"></span><span class="button-label">Stop</span>
        </button>
      </div>
    </div>

    <div class="composer-foot">
      <!-- chat sessions only: the model indicator, the flyout's second trigger -->
      <button class="composer-model" type="button" aria-haspopup="menu" aria-controls="composer-flyout"
              aria-expanded="false" title="zai/glm-5.3 · Change model & thinking"
              aria-label="zai/glm-5.3, thinking high — Change Model &amp; Thinking">
        <span class="composer-model-id">glm-5.3</span>
        <span class="composer-model-meta">zai</span>
        <span class="composer-model-sep" aria-hidden="true">·</span>
        <span class="composer-model-level">high</span>
        <span class="icon icon-sm composer-model-caret" style="--icon: url(/icons/chevron-down.svg)" aria-hidden="true"></span>
      </button>
      <span class="composer-reason" id="composer-reason"><!-- reason when disabled; else empty --></span>
      <span class="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
    </div>
  </form>
</footer>
```

## Behavior

- **Auto-grow.** The textarea grows from 1 line (44px) up to `--composer-max` (40vh), then
  scrolls. `field-sizing: content` handles it in Chromium. As a fallback, on input set
  `style.height = "auto"` and then `style.height = scrollHeight + "px"`.
- **Keys.**
  - `Enter` sends.
  - `Shift+Enter` inserts a newline.
  - Ignore `Enter` while `event.isComposing` (IME).
  - Empty or whitespace-only text doesn't send, and Send is `aria-disabled` with no reason text,
    because the reason is obvious.
- **Send.** Sends `{type:"prompt"}`. Clear the textarea only after the socket accepts the message.
  Show the user bubble optimistically and resume auto-follow.
- **While streaming.** Send stays available and its label changes to `Steer`, which sends
  `{type:"steer"}`. The placeholder becomes "Steer the current turn…". `Stop`
  (`.button-destructive`, outlined, never filled, one word so the button stays narrow) sends
  `{type:"abort"}`. Show it only while streaming, after Steer. `Esc` does **not** abort, to prevent
  accidental stops.
- **After Stop.** The status reads "Stopping…" until the turn settles. Then the run status
  disappears, and an info row says "Stopped by you at `14:08`."
- **Focus.** Returns to the textarea after Send, Steer, or Stop.
- **Drafts** are never discarded. The draft survives disable/enable, reconnects, and errors. Keep
  a draft per session path in memory, so switching sessions and coming back restores it.
- **The foot** reads left to right: the model indicator, the disabled reason, then the keyboard
  hint pushed to the right edge.
- **Model indicator.** Chat sessions only. It says what this turn will run — the id in mono, the
  provider beside it, then `· {level}` for the thinking level — and clicking it opens the flyout
  on its **model panel**, anchored above itself, which holds exactly those two controls (§4b).
  The thinking
  segment is omitted when the model's ladder has one level or none, exactly as the flyout's group
  is. While a switch is pending it shows the **target** with a `.live-dot`, the model's and the
  level's each before their own value; with no model yet it reads "Choose model". The full
  `provider/id` is in `title`. It carries `aria-haspopup="menu"`,
  `aria-controls="composer-flyout"` and an `aria-expanded` that is true only while the flyout is
  open **and anchored to it** — clicking it again closes it; the "+" trigger keeps its own. The
  id is the one part that shrinks, so a long ref ellipsizes rather than pushing the hint out.
  While the composer is disabled it still shows the model and is `aria-disabled` with a dead
  click, like the flyout's own rows. It stays at every width — the hint goes under 768px, this
  doesn't, because it's the only place the model is on screen.

## Disabled states

The reason goes in `.composer-reason` and the control is disabled. The reason is one line, per
the skill's copy ladder.

| Condition | Textarea | Buttons | Reason (with icon) |
|---|---|---|---|
| Session is live in a TUI | `disabled` | Send hidden | `attention` — "Read only while this session is open in the TUI." |
| Chat socket connecting (first connect) | enabled (typing is fine) | Send `aria-disabled` | `clock` — "Connecting…" |
| Chat socket dropped | enabled | Send `aria-disabled` | `clock` — "Reconnecting. Your draft is kept." |
| Model switch pending (§4c) | enabled | Send `aria-disabled` until `{type:"model"}` or an error | `clock` — "Switching model…" |
| Server `error` with `code:"busy"` | enabled | Send `aria-disabled` until the next `agent_settled` | `attention` — "pi is busy with another turn. Send when it finishes." |

Use `aria-disabled="true"` rather than `disabled` on buttons whose reason matters. That keeps them
focusable, so the reason (tied to them with `aria-describedby="composer-reason"`) gets read. The
click handler checks the state and does nothing. The textarea takes a real `disabled` only in the
read-only live case.

## Composer flyout

Everything you do to a session that isn't typing lives behind one ghost `plus` button, first in
`.composer-row`. It replaced the two icon buttons that used to sit there (Attach Images and
Commands) and took the model trigger and the session's own facts out of the head (§3): the
composer is where the session is acted on, and the head is for reading.

**One popover, two triggers, three panels.** The `plus` button opens the **menu** panel — Attach
images, Commands, Session info. The model indicator in `.composer-foot` (§4) opens the **model**
panel — the Model row and this model's Thinking ladder, the two things the indicator is the label
for. The Model row opens the §4c **picker** as the third panel, which comes back to the model
panel it was opened from. Each trigger anchors the popover above **itself**: the math is the same,
measured on whichever element opened it, and closing returns focus there. The composer holds the
flyout's handle (`show(panel, anchor)` · `close()` · `open` · `anchor`, handed over once on
mount), so the indicator can toggle the menu it opened and mirror its state in `aria-expanded`.

The model row and the ladder live in the panel the indicator names, not in the `plus` menu:
one control, one way in, and the thing that says what the session runs is the thing that changes
it.

```html
<!-- the "menu" panel: what the "+" button opens -->
<div class="model-menu composer-flyout" id="composer-flyout" popover="auto"
     style="--menu-bottom: 72px; --menu-left: 388px">
  <div class="composer-flyout-list" role="menu" aria-label="More actions">
    <div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-attach" tabindex="0"
         aria-describedby="composer-reason">
      <span class="icon icon-sm composer-flyout-icon" style="--icon: url(/icons/attach.svg)" aria-hidden="true"></span>
      <span class="composer-flyout-label">Attach images</span>
    </div>
    <div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-commands" tabindex="-1">…Commands…</div>

    <div class="composer-flyout-sep" role="separator"></div>
    <div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-info" tabindex="-1">…Session info…</div>
  </div>
</div>

<!-- the "model" panel: what the model indicator opens, in the same popover -->
<div class="composer-flyout-list" role="menu" aria-label="Model and thinking">
  <div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-model" tabindex="0"
       aria-haspopup="true" title="zai/glm-5.3">
    <span class="icon icon-sm composer-flyout-icon" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
    <span class="composer-flyout-label">Model</span>
    <span class="composer-flyout-value">glm-5.3</span>
    <span class="composer-flyout-meta">zai</span>
    <span class="icon icon-sm composer-flyout-chevron" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </div>

  <div class="composer-flyout-sep" role="separator"></div>
  <div class="model-menu-group" role="group" aria-labelledby="composer-flyout-thinking">
    <div class="list-group-label" id="composer-flyout-thinking">Thinking</div>
    <div class="mode-option composer-flyout-item" role="menuitemradio" id="composer-flyout-thinking-high"
         tabindex="-1" aria-checked="true">
      <span class="icon icon-sm mode-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
      <span class="composer-flyout-label">high</span>
    </div>
    …one row per level…
  </div>
</div>
```

- **Mechanism.** A native `[popover="auto"]` in the model menu's shell (`.model-menu`), so it's in
  the top layer, no `.pane` clips it, and a click outside or `Esc` closes it for free. It's
  **anchored above** whatever opened it, because the composer is pinned to the bottom: on open,
  measure that element and set `--menu-bottom: {innerHeight − rect.top + 4}px` and `--menu-left:
  {rect.left}px`. A resize re-anchors it; it closes only when the anchor isn't laid out anymore.
  Under 768px it's the same bottom sheet the model menu is.
- **Panels.** Three, one popover: **menu** (the `plus` button's), **model** (the indicator's), and
  the §4c **picker**, which the Model row opens and a `Back` button above its search field returns
  from — to the model panel, which is the only way in. Only the panel in front is rendered, so it
  is also the whole keyboard order. One popover means no nested light-dismiss to reason about, and
  `Esc` always means "close the flyout".
- **Keyboard.** `↑`/`↓` move and wrap, `Home`/`End` jump, `Enter`/`Space` activate, `Esc` closes
  and returns focus to the trigger that opened it, and tabbing out closes it (`focusout` outside
  the menu). Rows carry real focus with a roving `tabindex`, so they draw the standard
  `:focus-visible` ring. Opening a panel — including arriving back from the picker — focuses its
  first row that isn't disabled. **`Ctrl+P` / `⌘P`** opens the flyout straight on the picker (and
  closes it if the picker is already in front), with `preventDefault()` so print never fires. It's
  bound in chat sessions only; watch sessions print as usual.
- **Rows.** Attach images, Commands and Session info are the menu panel's; Model and Thinking are
  the model panel's.
  - **Attach images** opens the composer's hidden file picker (§4b). `aria-disabled` and
    `aria-describedby="composer-reason"` while the composer is disabled.
  - **Commands** closes the flyout and opens the slash menu exactly as the old button did (§4d).
    `aria-disabled` when the composer is disabled or there's no command list; then its `title` is
    "No commands available".
  - **Model** is the model panel's first row: the current id in mono with its provider, and a
    chevron. It's the picker's trigger: `aria-haspopup="true"`, and while a switch is pending it's `aria-busy` with a
    `.live-dot` before the target id, and `aria-disabled` (§4c "Pending"). Choosing applies
    immediately, closes the flyout, and focus returns to the textarea.
  - **Thinking** follows the Model row on the same panel: one `menuitemradio` per level of the **current model's** `thinkingLevels`,
    in ladder order, checked on the active one. **The whole group is hidden when the model has
    one level or isn't in the model list yet** — a ladder with one rung is not a choice. Picking
    sends `{type:"set_thinking"}`; the checked state follows the server's `{type:"thinking"}`
    echo, never the click, because the server clamps to what the model supports. The flyout stays
    open so that echo is visible, including when it lands on a different level than the one
    picked. While the agent is running or the composer is blocked, every row is `aria-disabled`
    with the reason in `title`.
  - **Session info** closes the flyout and opens §4h.
- **Changing the model re-reads the ladder.** The server re-clamps on a model switch and sends
  `{type:"thinking"}` again, so the group re-renders for the new model: switching from a model at
  `low` to one whose ladder is `off · high · max` shows those three, checked wherever the server
  put it.
- **Refusals.** A `{type:"error"}` while a thinking change is pending ends the pending state and
  shows a `.banner-error` in the transcript's banner slot, exactly like a refused model switch
  (§4c "Errors"). The level on screen never changes on a refusal.

## Tokens

Composer ground is `--color-surface` with a top border in `--color-border`, and padding
`--space-3` / `--space-4` plus `env(safe-area-inset-bottom)`. The textarea uses `.input`: 44px
min, `--r-md`, `--color-border-strong` border, and an accent focus border. Send is
`.button-primary` (`--color-accent` / `--color-on-accent`). Stop is `.button-destructive`
(`--status-error` border and label, `--status-error-bg` on hover). The reason is `--fs-caption` in
`--color-ink-2`, and the hint is `--color-ink-muted`. The hint is hidden under 768px. The model
indicator borrows the same pair — the id `--fs-mono` in `--color-ink-2`, everything else
`--fs-caption` in `--color-ink-muted` — with a `--color-sunken` fill on hover and while open, and
a `--tap-min` target stretched over a `--control-sm` row by a `::after`.
`.composer-inner` is centred at `--measure` plus `--space-9`, the transcript column's width, so it
widens with the column on desktop (§3 "Column width"). The slash menu spans it, and the model
menu keeps its own 360px cap.

## Accessibility

- **Label.** The textarea has a real (visually hidden) `<label>`. The placeholder is never the
  label.
- **Contrast.** On-accent on accent (Send) is 5.61 (dark) and 6.81 (light). The control border
  (border-strong on surface) is 3.47 and 3.61, clearing 3:1. Error on surface (Stop) is 5.42
  and 6.01.
- **Stop placement.** It sits to the right of Steer, last in the row, with an `--space-2` gap. One
  word plus the square glyph makes it narrower than the primary it follows, so the destructive
  action reads as the smaller, secondary one. It's the only time the two appear together.

---

