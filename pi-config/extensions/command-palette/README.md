# Pi command palette

Global extension for the installed `@earendil-works/pi-coding-agent`.
Run `/reload` once after installation, then press **Ctrl+P** or use `/palette`.

- Type to search the current category and all its descendants. Literal matches
  rank before fuzzy matches, so `opus` shows Opus models first. Space- or
  slash-separated search terms can combine provider and model names.
- Enter opens a submenu or performs the selected action.
- Up/Down (also Ctrl+K/J) and Page Up/Down move the selection.
- Escape, Alt+Left, or Backspace with an empty search goes back; at the root it closes.
- Ctrl+P or Ctrl+C closes from any depth.
- `/palette <category>` opens directly at a root category by id (matched
  case-insensitively), e.g. `/palette mode`.
- Categories include models, thinking, mode, sessions, settings, providers,
  export, display, installed extension commands, prompt templates, and skills.
- Rows marked `○`/`◉` are on/off toggles: Enter flips them in place and the
  palette stays open (footer: *Enter toggle*). A failed toggle shows an inline
  error without closing.
- Extension commands are discovered when the palette opens. Each has Run and
  With arguments options. Skills/templates compose editable text for review;
  they do not start a model request until you submit from the main editor.
- Sharing asks for confirmation before uploading anything.
- Session-changing operations are blocked while Pi is busy.

## Models & thinking

This category opens a searchable model list, showing **favorites by default**.
Each row shows its pending thinking level; the current model is marked with a
check and favorites with a star.

- **Ctrl+F** toggles Favorite for the highlighted **model/provider pair**. The
  same model from another provider is a separate favorite. Changes save
  immediately, even if you later close the palette without choosing a model.
- **Ctrl+A** switches between **Show all** and **Favorites**. Both shortcuts are
  shown in the menu, including when no favorites exist. Start with Ctrl+A, then
  highlight models and press Ctrl+F to build your list.
- The model filter also applies to root-level search; Ctrl+A works there too.
  Search text, highlighted model (when still visible), and pending thinking
  levels survive filter changes. Each palette opening starts in Favorites.
- Left/Right cycles only through levels advertised by that model, wrapping at
  either end. Non-reasoning models show `[off]` and do not cycle.
- Enter applies the highlighted model and its chosen level to the current session.
- Browsing or closing without Enter does not change the active model or thinking
  level. Favorite changes are saved separately. Pending thinking choices are retained
  while filtering or navigating in that palette opening, but not across openings.
- Both Favorites and Show all honor Pi's scoped models when configured;
  otherwise they use available models. Favorites outside that list are retained
  on disk, not displayed. Initial levels use the active level or a scoped model's pinned level,
  clamped to that model's capabilities by Pi itself.
- **Settings → Configure model cycling** manages the scoped list. The native
  `/model` (Ctrl+L) and `/thinking` pickers remain available for saving defaults.

## Mode

Provided by the `mode` extension, right after *Models & thinking*: the two
major modes (current marked `✓`; Enter switches and closes, like picking a
model) and one toggle row per minor mode (Enter toggles in place). Bare `/mode`
opens the palette at this category. See `extensions/mode/README.md`.

## Remembered startup model

Changing models through the palette, native Ctrl+L picker, or model cycling
also saves that provider/model pair as the global startup default in
`~/.pi/agent/settings.json`. New Pi launches and `/new` read it; the latest
change across interactive panes wins. Other settings, including thinking
defaults and per-model thinking preferences, are preserved.

- Startup, reload, session restoration, and non-interactive/background agents
  do not overwrite the saved default. Browsing or cancelling a picker does not
  save anything. Selecting the already-active model emits no change event.
- Explicit CLI models, trusted project defaults, and configured model scope
  retain Pi's normal precedence. Resuming a conversation retains its saved model
  when available, unless explicitly overridden.
- Model changes made by other extensions within an interactive Pi also count.
- The handler uses Pi's public SettingsManager with its normal settings lock and
  merge behavior, reports persistence failures, and never reads or writes project
  settings. No additional state file is needed.

Run `/reload` in existing panes to enable this behavior.

## Keybindings

`~/.pi/agent/keybindings.json` frees Ctrl+P from its built-in bindings:

| Action | New shortcut |
| --- | --- |
| Cycle to next model | Ctrl+Alt+P |
| Toggle paths in session picker | Alt+P |
| Toggle provider in scoped-model picker | Ctrl+Alt+A |

Previous-model cycling remains Ctrl+Shift+P; model selection remains Ctrl+L.
The scoped-picker shortcuts are also remapped because Pi reports extension
conflicts against selector-local bindings, not just main-editor bindings.

## Integration

`menu.ts` implements the overlay using Pi's Input, SelectList, fuzzy filtering,
key parser, theme, and width utilities. It handles resizing and input focus.

`index.ts` adds categories and command dispatch. Built-in interactive commands
are **not** sent through `sendUserMessage`: that API does not execute built-in
UI commands. Instead, the extension captures an editor through the supported
`setEditorComponent` factory and invokes its public `onSubmit` callback, which
Pi wires to its interactive command handler. An existing custom editor is
retained; otherwise the standard CustomEditor is used with the border spinner.
The host's callback wiring was checked against Pi 0.85.1 and should be rechecked
if a future Pi release changes editor integration.

Browsing/cancelling leaves the main editor untouched. Built-in commands restore
an unfinished draft if they clear the editor. Text intentionally supplied by a
picker is not overwritten; session replacement follows Pi's normal behavior.
Other extensions that change editor text retain their own behavior.

### Category provider contract

`contracts.ts` lets other extensions add root categories without importing the
palette at runtime (the same versioned event pattern as
`subagents/contracts.ts`):

- `registerPaletteCategory(pi.events, { version: 1, id, label, description?, items(ctx) })`
  answers `command-palette:category-discover`. The palette emits discovery on
  **every** open and never caches providers, so load order does not matter and
  `items(ctx)` must be cheap and read live state. Use lowercase ids that do not
  collide with the built-in group ids (`Sessions`, `Settings`, `display`,
  `extension`, …); duplicate ids after the first are ignored.
- Provider categories are inserted after *Models & thinking*, in discovery
  order. If `items()` throws, that category is skipped with an error
  notification; the rest of the palette still opens.
- Items may use `run` (Enter closes the palette, then runs it), `children`, or
  `toggle: { isOn, toggle }` (Enter flips in place).
- `requestPaletteOpen(pi.events, ctx, path?)` emits `command-palette:open`. The
  palette claims it only for TUI contexts while no palette is open, and returns
  a promise that settles when the palette closes (and its chosen action has
  run); `undefined` means nobody claimed it, so callers need a fallback.

No additional dependencies or background processes. `favorites.ts` stores
preferences in `~/.pi/agent/model-favorites.json` (or Pi's `PI_CODING_AGENT_DIR`
override). The file is created on the first favorite change, not while browsing.
It contains `{ "version": 1, "models": [{ "provider": "…", "id": "…" }] }`.

Writes reread current preferences under a short-lived `.lock` directory and
atomically replace the file, preserving changes from other panes. Preferences
refresh when the palette reopens. Failed writes show an error without changing
the star; invalid files are never silently overwritten. If a crashed process
leaves `model-favorites.json.lock`, remove that empty directory only after
confirming no other palette is saving, then retry.

## Verification

```sh
node --test ~/pi-config/extensions/command-palette/test.mjs
```

Tests resolve imports from the installed Pi. They cover filtering, navigation,
empty results, width constraints, dispatch, draft restoration, busy-state guards,
non-TUI behavior, model-specific thinking limits, per-row pending choices,
cancellation, and model/thinking application order. Also verified with a separate tmux Pi instance: Ctrl+P,
`/palette`, nested theme menu, real model picker, cancellation with draft
restoration, resizing, and `/reload` without shortcut-conflict warnings.
The combined model list was also tested in an isolated Pi with a local fixture
provider: supported-level cycling, fixed off for non-reasoning models, Enter
application, and cancellation preserving both the active level and draft.
Strict TypeScript checking passed against the installed Pi declarations.
Favorites tests cover first use, persistence, provider-pair identity, root search,
filter switching, selection and pending levels, cancellation, malformed files,
write failures, and lock contention. Search regressions cover literal model-name
priority over scattered-letter matches, combined provider/model queries, and
root/category selection. Startup-default tests cover selection and cycling,
ignored restores/non-TUI events, preserving unrelated settings, cross-pane
updates, malformed settings, and surfaced write failures. Isolated real Pi
sessions verified palette/native/cycling saves, `/new` in an already-open pane,
fresh startup, and explicit CLI model precedence.

## Remove

Remove this directory and remove the palette's overrides from
`~/.pi/agent/keybindings.json`, then run `/reload`. Optionally remove
`~/.pi/agent/model-favorites.json` to discard saved favorites.
