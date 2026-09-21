# 05 · New Session dialog
> Part of the pi-web design spec · [overview](overview.md)

Triggered by `New Session` (sidebar head, and the empty states).

The folder is **chosen, never typed**. The Folder field is a button showing the chosen path. It
opens a folder picker in place, under the field, inside the same dialog.

```html
<!-- Portal to body -->
<div class="scrim"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title">
  <div class="modal-head"><h2 class="modal-title" id="ns-title">New Session</h2></div>
  <form class="modal-body" id="ns-form">
    <div class="field">
      <label class="field-label" for="ns-cwd">Folder</label>
      <button type="button" class="input input-mono folder-field" id="ns-cwd" title="/home/user/webapps/pi-web"
              aria-expanded="true" aria-controls="ns-picker" aria-describedby="ns-cwd-hint ns-cwd-error">
        <span class="folder-field-value truncate">~/webapps/pi-web</span>  <!-- none yet: .folder-field-empty "Choose a folder" -->
        …chevron-down, class="icon icon-sm icon-twist" (turns 180° while open)…
      </button>
      <span class="field-hint" id="ns-cwd-hint">pi runs in this folder and can read and change files in it.</span>
      <span class="field-error" id="ns-cwd-error"><!-- on error only --></span>
    </div>

    <!-- Open picker (replaces the recent list while open) -->
    <div class="folder-picker" id="ns-picker" role="group" aria-label="Choose a folder" tabindex="-1"
         aria-activedescendant="ns-pf-0">  <!-- focused on open, not the filter -->
      <div class="folder-picker-bar">
        <nav class="folder-crumbs" aria-label="Path">
          <ol>
            <li><button type="button" class="folder-crumb" title="/home/user">~</button></li>
            <li><button type="button" class="folder-crumb" title="/home/user/webapps">webapps</button></li>
            <li><span class="folder-crumb-current" aria-current="location">pi-web</span></li>
          </ol>
        </nav>  <!-- outside $HOME the first crumb is "/" (li.folder-crumbs-root); Recent view: one current crumb "Recent folders" -->
        <button type="button" class="button button-ghost">Home</button>
        <button type="button" class="button button-ghost" aria-pressed="false">Recent</button>
      </div>
      <div class="search">
        …search icon…
        <input class="input" type="text" role="combobox" aria-label="Filter folders in pi-web"
               aria-expanded="true" aria-controls="ns-picker-list" aria-autocomplete="list"
               aria-activedescendant="ns-pf-0" aria-describedby="ns-picker-note" placeholder="Filter">
      </div>
      <ul class="list folder-list folder-picker-list" id="ns-picker-list" role="listbox" aria-label="Subfolders of pi-web">
        <li id="ns-pf-0" class="list-row list-row-interactive" role="option" aria-selected="true" title="/home/user/webapps/pi-web/docs">
          …folder… <span class="list-title truncate">docs</span> …chevron-right…
        </li>
        <li id="ns-pf-1" class="list-row list-row-interactive" role="option" aria-selected="false" title="…">
          …folder… <span class="list-title truncate">shared</span> <span class="folder-picker-link">link</span> …chevron-right…
        </li>
      </ul>
      <p class="folder-picker-note" id="ns-picker-note" aria-live="polite"><!-- state text, or empty (hidden) --></p>
      <div class="folder-picker-foot">
        <label class="folder-picker-hidden"><input type="checkbox"> Show hidden folders</label>
        <span class="modal-spacer"></span>
        <button type="button" class="button">Use This Folder</button>
      </div>
    </div>

    <!-- Closed picker: the recent list, as before -->
    <div class="field">
      <span class="field-label" id="ns-recent">Recent folders</span>
      <ul class="list folder-list" role="listbox" aria-labelledby="ns-recent">
        <li class="list-row list-row-interactive" role="option" aria-selected="true" tabindex="0">
          …folder… <span class="list-title truncate">~/webapps/pi-web</span>
        </li>
      </ul>
    </div>
  </form>
  <div class="modal-foot">
    <button class="button button-primary" type="submit" form="ns-form">Create Session</button>
    <span class="modal-spacer"></span>
    <button class="button button-ghost" type="button">Cancel</button>
  </div>
</div>
```

**Surface: an in-place panel, not a nested dialog.** The picker opens under the field, inside
the dialog that's already open. The chosen path, the breadcrumb, and Create Session stay in one
view, so there's no second scrim, no second focus root, and no sheet on a sheet at folded width.
We rejected a nested `.modal` (the §5 dialog opening another dialog): it hides the dialog it
belongs to, and on a phone it becomes a bottom sheet over a bottom sheet. A §4c-style popover
doesn't fit either, because the picker needs a filter, a scrolling 44px list, and a breadcrumb,
and a popover inside a sheet would clip them.

**No free typing.** The user asked for it gone, so there is no path input and no paste
affordance. Every folder is reached by clicking or by the keyboard, and the filter only narrows
the current list. A folder with no readable route to it (say, an unreadable parent) can't be
chosen here. Start that session from a TUI.

- **Prefill.** The `cwd` of the open session, else the most recently active session's `cwd`. The
  field shows it with `~`, and the full path goes in `title`. With no prefill it reads "Choose a
  folder" in `--color-ink-muted`, and Create Session is `aria-disabled`.
- **The choice is where you are.** Opening a folder in the picker makes it the chosen folder,
  and the field updates as you go. Create Session creates the session in the folder the field
  shows, with the picker open or closed. "Use This Folder" and Enter on an empty list just close
  the picker.
- **Opening.** Clicking the field, or Enter/Space on it, toggles the picker (`aria-expanded`). It
  opens at the chosen folder, or at `$HOME` when there is none. **Focus goes to the panel
  (`tabindex="-1"`), never the filter**, because a focused text input raises a phone's keyboard.
  Filtering starts when the user taps the filter, or types while the panel has focus. The key
  then moves into the filter.
- **Listing.** `GET /api/folders?path=` (§REST in `shared/protocol.ts`) returns subfolders only,
  never files: dot folders only with "Show hidden folders", symlinks to folders marked "link",
  names A to Z case-insensitively, at most 500. No path means `$HOME`. The first answer for
  `$HOME` also seeds `home()` when the session list couldn't.
- **Navigating.** Click a row, or Enter on the active row, to open it. Go up by clicking a
  breadcrumb segment, or with Backspace or ← while the filter is empty. **Home** opens `$HOME`.
  **Recent** (`aria-pressed`) swaps the list for the folders sessions already use, and opening one
  jumps there. Pressing Recent again goes back to the folder you were in.
- **Filter.** Narrows the current list as you type (case-insensitive substring). It clears on
  every navigation.
- **Recent folders, picker closed.** The distinct session `cwd`s, most recently active first, up
  to 20. Click or Enter/Space picks one, and double-click picks it and submits, as before. The list
  is hidden while the picker is open, since Recent is there.
- **Submitting.** Create Session posts `{cwd}`. While pending, the button shows "Creating…" and
  is `aria-disabled`. Enter inside the picker never submits.
- **On success.** Close the dialog, navigate to the new session, and focus the composer, except
  on a touch-only device (`(hover: none) and (pointer: coarse)`), where that would raise the
  keyboard over the empty session. There the user taps the composer.
- **On a server 4xx.** Show `.field-error` with the server's message, or "That folder doesn't
  exist. Pick one that does." Set `aria-invalid="true"` on the field, close the picker, and move
  focus to the field. The dialog stays open with the choice intact.
- **Other errors.** Show a `.banner.banner-error` inside `.modal-body`: "Couldn't create the
  session. Nothing was written. Try again."
- **Focus.** The dialog traps focus, with initial focus on the Folder field. While the picker is
  open it traps focus inside itself. Esc closes the picker only, and focus returns to the field.
  Esc with the picker closed, Cancel, and a scrim click close the dialog, and focus returns to
  the button that opened it. Below 768px the same markup renders as a bottom sheet. A viewport
  resize, a phone's keyboard opening included, never closes the dialog or the picker. Both are
  in-flow and have no resize handling.

**Picker states** (in `.folder-picker-note`, `aria-live="polite"`; empty when there's nothing to
say):

| State | Note |
|---|---|
| Loading | Loading folders… (the list is `aria-busy`) |
| No subfolders | No subfolders in {name}. You can still start the session here. |
| Filter matches nothing | 0 of {n} match “{filter}”. |
| Over 500 | Showing the first 500 folders, A to Z. Filter to narrow them. |
| 403 | pi-web can't read this folder. Pick another one. |
| 404 (e.g. a deleted prefill) | This folder doesn't exist. Pick another one. |
| Other failure | Couldn't list this folder. {server message} |
| Recent, none yet | No recent folders yet. Sessions you start add theirs here. |

**Keyboard** (on the panel or in the filter; both carry `aria-activedescendant` for the
listbox):

| Key | Does |
|---|---|
| ↓ / ↑ | Next / previous folder (stops at the ends) |
| Home / End | First / last folder (with an empty list they move the caret) |
| Enter | Open the active folder; with no rows, close the picker |
| Backspace, ← | Up one folder, only while the filter is empty |
| Esc | Close the picker (the dialog stays) |
| Typing | On the panel: moves into the filter with that character (Backspace there edits a non-empty filter) |
| Tab / Shift+Tab | Cycle through the crumbs, Home, Recent, the filter, Show hidden folders, and Use This Folder (Shift+Tab from the panel wraps to Use This Folder) |

**Accessibility.**

- The listbox is `role="listbox"` driven from a `role="combobox"` filter, not a `tree`. You see
  one level at a time and move between levels by opening folders, which is a list with
  navigation. A tree would claim expandable nodes and ← / → semantics that this doesn't have.
- The active option is `aria-selected="true"` (selection follows focus) and scrolls into view.
- The breadcrumb is `<nav aria-label="Path">` with the current folder as
  `aria-current="location"` and not a button.
- The field is a `<button>` labelled by the `<label for>` and described by the hint and error.
- Every control is at least 44px: crumbs (`--tap-min` wide and tall), Home, Recent, the rows,
  the checkbox row, and Use This Folder.

**Tokens.** Modal `--color-surface`, `--r-xl`, `--shadow-3`, border `--color-border`, and scrim
`--scrim`. Title `--fs-heading-m`. Field: `.input` with `--font-mono`. Picker `--color-sunken`,
`--r-lg`, `--color-border`, padding `--space-3`, gap `--space-2`. Crumbs `--font-mono` /
`--fs-mono` in `--color-accent` (links), with the current one `--color-ink` `--fw-semibold` and
`/` separators in `--color-ink-muted`. Lists `--color-bg` with `--r-md`, rows `--row-height` in
`--font-mono`, and the active or selected row `--color-accent-tint`. Note `--fs-caption` in
`--color-ink-2`. "link" `--fs-caption` in `--color-ink-muted`.

