# 04c · Model menu
> Part of the Sova design spec · [overview](overview.md)

A searchable model picker, like pi's Ctrl+P palette. It exists only for **chat** sessions. A
watched (TUI-owned) session keeps the model as plain mono text in `.session-head-meta`, because it
can't be changed from here.

## Trigger

**It has no trigger of its own.** The picker is the composer flyout's third panel (§4 "Composer
flyout"), opened from the Model row on the flyout's model panel — which the composer's model
indicator (§4) opens — or straight from `Ctrl+P` / `⌘P`. `Back` returns to that model panel. The
Model row carries the label ({id} in mono, the provider beside it, the full `provider/id` in `title`,
"Choose model" with no model yet) and the pending state. Everything below describes the panel.

## Menu

```html
<!-- inside the flyout's popover; the panel replaces the root menu -->
<div class="composer-flyout-head">
  <button class="button button-sm button-ghost composer-flyout-back" type="button">…chevron-left… Back</button>
</div>
<div class="model-menu-search">
    <div class="search">
      <span class="icon" style="--icon: url(/icons/search.svg)" aria-hidden="true"></span>
      <input class="input" type="text" role="combobox" aria-label="Search models"
             placeholder="Search models" autocomplete="off" spellcheck="false"
             aria-expanded="true" aria-controls="model-listbox" aria-autocomplete="list"
             aria-activedescendant="mo-openai-gpt-5">
    </div>
  </div>

  <!-- only when changing is blocked; see Disabled -->
  <div class="banner banner-info" role="status">…</div>

  <div class="model-menu-list" id="model-listbox" role="listbox" aria-label="Models" tabindex="-1"
       aria-activedescendant="mo-anthropic-claude-opus-5">  <!-- focused on open -->
    <div class="model-menu-group" role="group" aria-labelledby="mg-fav">
      <div class="list-group-label" id="mg-fav">Favorites</div>
      <div class="model-option" role="option" id="mo-openai-gpt-5" aria-selected="false" data-active>
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">gpt-5</span>
        <span class="model-option-vision">vision</span>  <!-- only when ModelInfo.input has "image" -->
        <span class="model-option-provider">openai</span>
      </div>
      <div class="model-option" role="option" id="mo-ollama-cloud-kimi-k3" aria-selected="true">
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">kimi-k3</span>
        <span class="model-option-provider">ollama-cloud</span>
      </div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mg-all">
      <div class="list-group-label" id="mg-all">All models</div>
      …options…
    </div>
  </div>

<p class="model-menu-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close</p>
```

- **Role.** The list is a **listbox**, not a menu. Choosing a model is selecting one value from a
  set, which is exactly what a listbox is for — the panel is a combobox input plus that listbox,
  and the flyout row that opens it says `aria-haspopup="true"`. **Showing the panel focuses the
  listbox (`tabindex="-1"`), never the input.** On a phone a focused text input raises the
  keyboard over the sheet, and nobody asked to type yet. Focus moves to the input when the user
  taps it or starts typing. The listbox and the input both carry `aria-activedescendant`, which is
  the keyboard position. The option it points to gets `data-active` and draws the focus ring
  (inset 2px accent), because focus can't be seen anywhere else.
- **Mechanism.** The flyout owns the popover; this panel is what's inside it (§4 "Composer
  flyout" has the anchoring, the resize rule, and the `Back` affordance). Mounting the
  panel re-fetches the list and shows the cached one meanwhile; the cache is shared with the
  Thinking group, which reads the same models to know their ladders (`src/lib/models.ts`).
- **Positioning.**
  - At ≥768 (e.g. 1440) the flyout is 360px wide (or the viewport minus 32px) with
    `max-height: min(440px, 70dvh)`, `--r-md` and `--shadow-2`, sitting above the trigger. The
    list scrolls, and the back row, the search field and the foot stay put.
  - Under 768 (e.g. 320) it's a bottom sheet: full width, up to 85dvh tall, with `--r-xl` top
    corners, the scrim backdrop, and the search at the top. The keyboard hint foot is hidden.
- **Motion.** It fades in once (`--dur-base`). Nothing loops.

## Content and order

- **Groups.**
  - **Favorites** (`favorite: true`) come first, sorted by `ref`. They're marked by the group
    label; rows carry no star.
  - A 1px `--color-border` rule separates the favorites from **All models**: every other model,
    sorted by provider, then id.
  - A model appears in only one group. With no favorites there's a single group, and its label
    is still "All models".
- **Rows.** Each row is 44px: a check mark (visible only on the current model), the id in mono,
  and the provider in a muted caption on the right. The current model has `aria-selected="true"`,
  the check, and the accent-tint fill, so the mark isn't color alone. Every other row has
  `aria-selected="false"`.
- **Search.**
  - Matching is case-insensitive. The query is split on whitespace, and every token must appear
    in `provider/id`. So "anth opus" finds `anthropic/claude-opus-5`.
  - It filters both groups and hides a group with no matches. The active option resets to the
    first match whenever the query changes.
  - Filtering starts when the user types or taps the input. A printable key on the listbox (or
    Backspace with a query) moves focus into the input and applies that key, so typing is still
    the typeahead on a desktop.
- **On open.** The query is empty, the current model is active and scrolled into view
  (`block: "nearest"`), and the listbox has focus, not the input, so no on-screen keyboard.

## Keyboard

| Key | Where | Does |
|---|---|---|
| `Ctrl+P` / `⌘P` | anywhere while a **chat** session is open | Opens the flyout on this panel, and closes it if that panel is already open. Call `preventDefault()` so print never fires. In watch sessions and on the list view it isn't bound, and the browser prints as usual |
| `Enter` / `Space` | on the flyout's Model row | Opens this panel |
| `↓` / `↑` | in the menu | Moves the active option, wrapping. Normally it skips disabled rows. When *every* row is disabled (Blocked), it moves through all of them, so the list stays browsable, and `Enter` does nothing |
| `PageDown` / `PageUp` | in the menu | Moves 8 options |
| `Home` / `End` | on the listbox | First / last option (in the input they move the caret) |
| Typing, `Backspace` | on the listbox | Moves into the input with that key, which filters |
| `Enter` | in the menu | Chooses the active option. Choosing the current model just closes the menu |
| `Esc` | in the menu | Closes the whole flyout (native popover behavior). The query doesn't survive |
| `Tab` | in the menu | Closes it (on `focusout` outside the menu), and focus moves on |
| Mouse | | Hovering a row makes it active, and clicking chooses it. `Back` returns to the model panel and focuses the Model row |

When the flyout closes without a choice, focus returns to its trigger; after a choice it goes to
the textarea, where the next thing you do is type.

## States

| State | Flyout's Model row | Panel |
|---|---|---|
| **Loading models** (first open; fetched on every open and cached, so later opens show the cache while it refreshes) | normal | After 300ms, 4 × `<div class="skeleton skeleton-row">` in the list, with `aria-busy="true"` on the listbox |
| **Load failed** | normal | `.banner.banner-error`: **Couldn't load models.** Your current model is unchanged. Action: `<button class="button button-sm">Retry</button>` |
| **0 models** | normal | `<p class="model-menu-empty">` "0 models have credentials. Log in with `pi` in a terminal to add one." |
| **0 models, because they're all off** (the list has models; Settings → Models turned every one of them off — §12) | normal | `<p class="model-menu-empty">` "Every model is turned off in Settings → Models. Turn one back on to switch to it." |
| **No matches** | normal | `<p class="model-menu-empty">` "0 models match “{query}”." |
| **Blocked: agent running** (`isStreaming`) | enabled, so pressing it shows the reason | `.banner.banner-info`: **Model changes wait until this turn finishes.** Stop or wait, then pick one. Every option gets `aria-disabled="true"`, and the list stays browsable. If a turn starts while the menu is open, the banner appears right away |
| **Blocked: composer disabled** (connecting, reconnecting, a foreign writer, the TUI took over) | enabled | Same banner, with the current `.composer-reason` text as the title, and options disabled |
| **Pending** (after choosing, until `{type:"model"}`) | `aria-busy="true"` and `aria-disabled="true"`. The row shows the *target* id, with `<span class="live-dot"></span>` before it. It isn't faded: `aria-busy` restores full opacity, because pending is work in progress, not an unavailable control | Closed with the flyout; focus is in the textarea |
| **Switched** (`{type:"model"}` arrives) | The row shows the echoed model, and the dot is removed | The Thinking group re-renders for the new model's ladder (§4 "Composer flyout") |

- **While pending.**
  - The composer's Send takes `aria-disabled` with the reason "Switching model…" (`clock`
    icon), so a prompt can't land on an ambiguous model.
  - If there's no echo after **15s**, treat it as an error (below) with the message "The server
    didn't confirm the switch."
- **On switch.**
  - Announce "Model changed to {id}." in the polite live region.
  - Append an `.info-row` locally: "Model changed to `{provider/id}`". On reload, the persisted
    `model_change` entry renders in the same place, so the two never appear together.
  - The pulse is the sanctioned live indicator, and it's legitimate here because work is
    happening.

## Errors

An `{type:"error"}` that arrives while a switch is pending belongs to that switch. It ends the
pending state, the Model row reverts to the current model, and a `.banner.banner-error` shows in
the chat's `.transcript-banner` slot (sticky at the top of the transcript; chat sessions don't
use it otherwise):

```html
<div class="banner banner-error" role="alert">
  <span class="icon banner-icon" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span>
  <div class="banner-main">
    <p class="banner-title">Couldn't switch to <code>claude-opus-5</code>.</p>
    <p class="banner-body">{body per table} You're still on <code>kimi-k3</code>.</p>
  </div>
  <button class="button button-sm button-ghost banner-action" type="button">Dismiss</button>
</div>
```

The body depends on the server message (the server sends free text, so match on the prefix):

| Server message starts with | Body |
|---|---|
| `No credentials configured for` | {provider} has no credentials set up. Log in with `pi` in a terminal, then try again. |
| `is turned off in Settings → Models` | Quoted as the server sends it: it names the model and the switch that has to move (§12). The menu doesn't list disabled models, so this one arrives only when the policy changed under an open menu. |
| `Unknown model` | pi doesn't know this model. It may have been removed from your config. |
| `Cannot switch models while the agent is running` | Model changes wait until this turn finishes. |
| `code: "busy"` / `"recent"` / `"reloaded"` | the same copy the composer uses for that code |
| anything else | {server message verbatim}. |

The banner goes away on Dismiss, after the next successful switch, or when you leave the session.
It never auto-dismisses, because it's the only record of the failure.

## Tokens

- **Trigger.** The flyout's `plus` `.button-icon.button-ghost` at 44px, `--color-sunken` while
  open. Its Model row carries the id in `--font-mono` / `--fs-mono` in `--color-ink-2`.
- **Menu.** `--color-surface` with a `--color-border` edge, `--r-md`, and `--shadow-2`. At
  folded width it's a sheet with `--r-xl`, `--shadow-3`, and `--scrim`.
- **Rows.** `--control-md` tall. Id in `--font-mono` / `--color-ink`, provider `--fs-caption` in
  `--color-ink-muted`.
  - Hover and active: `--color-sunken`, and the active row also gets the `--focus-ring` inset.
  - Current: `--color-accent-tint`.
  - Disabled: opacity .42.
- **Group rule.** `--color-border`.
- **Foot.** `--fs-caption` in `--color-ink-muted`.

## Contrast

| Pair | Dark | Light |
|---|---|---|
| Ink on surface (ids) | 12.34 | 17.86 |
| Muted on surface (provider) | 4.96 | 5.74 |
| Ink on sunken (active row) | 13.43 | 14.78 |
| Muted on sunken | 5.40 | 4.75 |
| Ink on accent-tint (current row) | 12.57 | 14.57 |
| Muted on accent-tint | 5.06 | 4.68 |
| Accent ring on sunken (active marker) | 5.08 | 5.63 |

---

