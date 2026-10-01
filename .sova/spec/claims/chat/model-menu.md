# §chat/model-menu — Model menu
> Part of the Sova design spec · [overview](../design/overview.md)

A searchable model picker, like pi's Ctrl+P palette. It exists only for **chat** sessions. A
watched (TUI-owned) session keeps the model as plain mono text in `.session-head-meta`, because it
can't be changed from here.

## §chat.model-menu/trigger — Trigger

**It has no trigger of its own.** The picker is the composer flyout's third panel (§chat.composer/composer-flyout), opened from the Model row on the flyout's model panel — which the composer's model
indicator (§chat/composer) opens — or straight from `Ctrl+P` / `⌘P`. `Back` returns to that model panel. The
Model row carries the label ({id} in mono, the provider beside it, the full `provider/id` in `title`,
"Choose model" with no model yet) and the pending state. Everything below describes the panel.

## §chat.model-menu/menu — Menu

The picker has two steps in one panel: **Providers** (what the Model row and `Ctrl+P` open) and
**one provider** (its models). Typing on either step searches instead (Content and order).

```html
<!-- inside the flyout's popover; the panel replaces the root menu. Step 1, Providers -->
<div class="composer-flyout-head">
  <button class="button button-sm button-ghost composer-flyout-back" type="button">…chevron-left… Back</button>
</div>
<div class="model-menu-search">
    <div class="search">
      <span class="icon" style="--icon: url(/icons/search.svg)" aria-hidden="true"></span>
      <input class="input" type="text" role="combobox" aria-label="Search models"
             placeholder="Search models" autocomplete="off" spellcheck="false"
             aria-expanded="true" aria-controls="model-listbox" aria-autocomplete="list"
             aria-activedescendant="mp-ollama-cloud">
    </div>
  </div>

  <!-- only when changing is blocked; see Disabled -->
  <div class="banner banner-info" role="status">…</div>

  <div class="model-menu-list" id="model-listbox" role="listbox" aria-label="Models" tabindex="-1"
       aria-activedescendant="mp-ollama-cloud">  <!-- focused on open -->
    <div class="model-menu-group" role="group" aria-labelledby="mg-fav">
      <div class="list-group-label" id="mg-fav">Favorites</div>
      <div class="model-option" role="option" id="mo-openai-gpt-5" aria-selected="false">
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">gpt-5</span>
        <span class="model-option-vision">vision</span>  <!-- only when ModelInfo.input has "image" -->
        <span class="model-option-provider">openai</span>
      </div>
      …
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mg-providers">
      <div class="list-group-label" id="mg-providers">Providers</div>
      <div class="model-option model-option-nav" role="option" id="mp-ollama-cloud" aria-selected="true" data-active>
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">ollama-cloud</span>
        <span class="model-option-count">20 models</span>
        <span class="icon icon-sm model-option-chevron" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
      </div>
      …one row per provider…
    </div>
  </div>

<p class="model-menu-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close</p>

<!-- Step 2, one provider: the head names it, and the search and listbox are scoped to it -->
<div class="composer-flyout-head">
  <button class="button button-sm button-ghost composer-flyout-back" type="button">…chevron-left… Back</button>
  <span class="model-menu-head-title">ollama-cloud</span>
</div>
…search: aria-label and placeholder "Search ollama-cloud"…
<div class="model-menu-list" id="model-listbox" role="listbox" aria-label="ollama-cloud models" tabindex="-1">
  <div class="model-option" role="option" id="mo-ollama-cloud-kimi-k3" aria-selected="true" data-active>
    <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
    <span class="model-option-id">kimi-k3</span>
  </div>
  …its other models…
</div>
```

- **Role.** The list is a **listbox**, not a menu. Choosing a model is selecting one value from a
  set, which is exactly what a listbox is for — the panel is a combobox input plus that listbox,
  and the flyout row that opens it says `aria-haspopup="true"`. A provider row is an option that
  opens its step instead of choosing; its chevron says so. Both steps use the same input and the
  same listbox, so a step change never drops focus out of the flyout. **Showing the panel, or
  changing step, focuses the listbox (`tabindex="-1"`), never the input.** On a phone a focused
  text input raises the keyboard over the sheet, and nobody asked to type yet. Focus moves to the
  input when the user taps it or starts typing. The listbox and the input both carry
  `aria-activedescendant`, which is the keyboard position. The option it points to gets
  `data-active` and draws the focus ring (inset 2px accent), because focus can't be seen anywhere
  else.
- **Steps.** Step 1's `Back` returns to the model panel. Step 2's `Back` returns to Providers, with
  the provider it came from active. When exactly 1 provider has models you can use, there is no
  step 1: the panel opens on that provider, and its `Back` returns to the model panel.
- **Mechanism.** The flyout owns the popover; this panel is what's inside it (§chat.composer/composer-flyout has the anchoring, the resize rule, and the `Back` affordance). Mounting the
  panel re-fetches the list and shows the cached one meanwhile; the cache is shared with the
  Thinking group, which reads the same models to know their ladders (`src/lib/models.ts`).
- **Positioning.**
  - At ≥768 (e.g. 1440) the flyout is 360px wide (or the viewport minus 32px) with
    `max-height: min(440px, 70dvh)`, `--r-md` and `--shadow-2`, sitting above the trigger. The
    list scrolls, and the back row, the search field and the foot stay put.
  - Under 768 (e.g. 320) it's a bottom sheet: full width, up to 85dvh tall, with `--r-xl` top
    corners, the scrim backdrop, and the search at the top. The keyboard hint foot is hidden.
- **Motion.** It fades in once (`--dur-base`). Nothing loops.

## §chat.model-menu/content-and-order — Content and order

- **Step 1, Providers.**
  - **Favorites** (`favorite: true`) come first, sorted by `ref`, as model rows you can choose
    right here, each with its provider in a muted caption.
  - A 1px `--color-border` rule separates them from **Providers**: one row per provider that has a
    model you can use, sorted by name. The row shows the name in mono, "{n} models" ("1 model")
    in a muted caption, and a chevron. A provider whose models are all turned off in Settings →
    Models has no row.
  - The current model's provider row has `aria-selected="true"`, the check, and the accent-tint
    fill. With no favorites there's only the Providers group.
- **Step 2, one provider.** That provider's models, sorted by id, with no provider caption: the
  head names it.
- **Rows.** Each row is 44px. A model row has a check mark (visible only on the current model),
  the id in mono, and, where the step says so, the provider in a muted caption on the right. The
  current model has `aria-selected="true"`, the check, and the accent-tint fill, so the mark isn't
  color alone. Every other row has `aria-selected="false"`.
- **Search.**
  - Matching is case-insensitive. The query is split on whitespace, and every token must appear
    in `provider/id`. So "anth opus" finds `anthropic/claude-opus-5`, and "zai" finds every zai
    model.
  - On step 1 it searches every model you can use: the Favorites and Providers groups give way to
    the matching models grouped under their provider's name, sorted by provider, then id, each
    one chosen right there. On step 2 it searches only that provider's models. The active option
    resets to the first match whenever the query changes.
  - Filtering starts when the user types or taps the input. A printable key on the listbox (or
    Backspace with a query) moves focus into the input and applies that key, so typing is still
    the typeahead on a desktop.
- **On open, and on each step change.** The query is empty and the listbox has focus, not the
  input, so no on-screen keyboard. On step 1 the current model's provider is active; on step 2 the
  current model is, if it's there, else the first row. The active row is scrolled into view
  (`block: "nearest"`).

## §chat.model-menu/keyboard — Keyboard

| Key | Where | Does |
|---|---|---|
| `Ctrl+P` / `⌘P` | anywhere while a **chat** session is open | Opens the flyout on this panel's first step, and closes it if that panel is already open. Call `preventDefault()` so print never fires. In watch sessions and on the list view it isn't bound, and the browser prints as usual |
| `Enter` / `Space` | on the flyout's Model row | Opens this panel |
| `↓` / `↑` | in the menu | Moves the active option, wrapping. While changing is blocked the model rows are disabled but it still moves through them, so the list stays browsable, and `Enter` on one does nothing |
| `PageDown` / `PageUp` | in the menu | Moves 8 options |
| `Home` / `End` | on the listbox | First / last option (in the input they move the caret) |
| Typing, `Backspace` | on the listbox | Moves into the input with that key, which filters |
| `Enter` | in the menu | Chooses the active model, or opens the active provider. Choosing the current model just closes the menu |
| `→` | on the listbox, or in the input with no query | Opens the active provider |
| `←` | on the listbox, or in the input with no query | Goes back, like `Back` |
| `Esc` | in the menu | Closes the whole flyout (native popover behavior). The query doesn't survive |
| `Tab` | in the menu | Closes it (on `focusout` outside the menu), and focus moves on |
| Mouse | | Hovering a row makes it active. Clicking a model chooses it; clicking a provider opens it. `Back` on step 2 returns to Providers; otherwise it returns to the model panel and focuses the Model row |

When the flyout closes without a choice, focus returns to its trigger; after a choice it goes to
the textarea, where the next thing you do is type.

## §chat.model-menu/states — States

| State | Flyout's Model row | Panel |
|---|---|---|
| **Loading models** (first open; fetched on every open and cached, so later opens show the cache while it refreshes) | normal | After 300ms, 4 × `<div class="skeleton skeleton-row">` in the list, with `aria-busy="true"` on the listbox |
| **Load failed** | normal | `.banner.banner-error`: **Couldn't load models.** Your current model is unchanged. Action: `<button class="button button-sm">Retry</button>` |
| **0 models** | normal | `<p class="model-menu-empty">` "0 models have credentials. Log in with `pi` in a terminal to add one." |
| **0 models, because they're all off** (the list has models; Settings → Models turned every one of them off — §app/settings-dialog) | normal | `<p class="model-menu-empty">` "Every model is turned off in Settings → Models. Turn one back on to switch to it." |
| **No matches** | normal | `<p class="model-menu-empty">` "0 models match “{query}”." |
| **Blocked: agent running** (`isStreaming`) | enabled, so pressing it shows the reason | `.banner.banner-info`: **Model changes wait until this turn finishes.** Stop or wait, then pick one. It shows on both steps. Every model row gets `aria-disabled="true"`; provider rows still open their step, so the list stays browsable. If a turn starts while the menu is open, the banner appears right away |
| **Blocked: composer disabled** (connecting, reconnecting, a foreign writer, the TUI took over) | enabled | Same banner, with the current `.composer-reason` text as the title, and model rows disabled |
| **Pending** (after choosing, until `{type:"model"}`) | `aria-busy="true"` and `aria-disabled="true"`. The row shows the *target* id, with `<span class="live-dot"></span>` before it. It isn't faded: `aria-busy` restores full opacity, because pending is work in progress, not an unavailable control | Closed with the flyout; focus is in the textarea |
| **Switched** (`{type:"model"}` arrives) | The row shows the echoed model, and the dot is removed | The Thinking group re-renders for the new model's ladder (§chat.composer/composer-flyout) |

- **While pending.**
  - The composer's Send takes `aria-disabled` with the reason "Switching model…" (`clock`
    icon), so a prompt can't land on an ambiguous model.
  - If there's no echo after **15s**, treat it as an error (below) with the message "The server
    didn't confirm the switch."
- **On switch.**
  - Announce "Model changed to {id}." in the polite live region and show the same sentence as a
    toast.
  - Leave no row in the transcript (§chat.transcript/transcript-items): a machine fact belongs
    next to the control that sets it, not in the thread, and a row written into the thread also
    came back after every reload.
  - The pulse is the sanctioned live indicator, and it's legitimate here because work is
    happening.

## §chat.model-menu/errors — Errors

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
| `is turned off in Settings → Models` | Quoted as the server sends it: it names the model and the switch that has to move (§app/settings-dialog). The menu doesn't list disabled models, so this one arrives only when the policy changed under an open menu. |
| `Unknown model` | pi doesn't know this model. It may have been removed from your config. |
| `Cannot switch models while the agent is running` | Model changes wait until this turn finishes. |
| `code: "busy"` / `"recent"` / `"reloaded"` | the same copy the composer uses for that code |
| anything else | {server message verbatim}. |

The banner goes away on Dismiss, after the next successful switch, or when you leave the session.
It never auto-dismisses, because it's the only record of the failure.

## §chat.model-menu/saved-default — The default for new sessions

A new session starts on the saved default model and thinking level (`defaults.json` in Sova's
state directory; a model since turned off in Settings → Models is skipped). **Only an explicit
pick in a brand-new session's composer becomes that default**: choosing a model in this picker, or
a level in the flyout's Thinking group, while the session's branch has no message from the user
yet. After the first message a pick is that session's alone. A switch the user did not pick in
the composer never saves: one the Overseer makes on a session it creates or acts on
(§app.overseer/tools), or Settings → Overseer applying its choice to the Overseer's own
conversation. The Overseer's own composer saves to `overseer.json` instead, never to this default
(§app.overseer/hosting). Another special session's composer (a baton or project overseer session,
§app/baton, §app/project-overseer) never saves this default either: its pick stays that session's
own, or goes where that kind keeps it.

## §chat.model-menu/tokens — Tokens

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

## §chat.model-menu/contrast — Contrast

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

