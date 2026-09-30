# §app/new-session-dialog — New Session dialog
> Part of the Sova design spec · [overview](../design/overview.md)

Triggered by `New Session` (sidebar head, and the empty states).

The folder is **chosen, never typed**. The Folder field is a button showing the chosen path. It
opens a folder picker in place, under the field, inside the same dialog.

```html
<!-- Portal to body -->
<div class="scrim"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title">
  <div class="modal-head"><h2 class="modal-title" id="ns-title">New Session</h2></div>  <!-- the title reads "Fan out" while that type is chosen -->
  <form class="modal-body" id="ns-form">
    <!-- The first field: what this dialog starts (see "Type" below). .fanout-source is §workspace/fanout's
         radio presentation, reused so both dialogs that offer fanout render the choice the same. -->
    <div class="field">
      <span class="field-label" id="ns-type">What to start</span>
      <div role="radiogroup" aria-labelledby="ns-type" class="fanout-source">
        <label><input type="radio" name="ns-type" checked> One session</label>
        <label><input type="radio" name="ns-type"> Fan out…</label>
      </div>
    </div>
    <div class="field">
      <label class="field-label" for="ns-cwd">Folder</label>
      <button type="button" class="input input-mono folder-field" id="ns-cwd" title="/home/user/webapps/sova"
              aria-expanded="true" aria-controls="ns-picker" aria-describedby="ns-cwd-hint ns-cwd-error">
        <span class="folder-field-value truncate">~/webapps/sova</span>  <!-- none yet: .folder-field-empty "Choose a folder" -->
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
            <li><span class="folder-crumb-current" aria-current="location">sova</span></li>
          </ol>
        </nav>  <!-- outside $HOME the first crumb is "/" (li.folder-crumbs-root); Recent view: one current crumb "Recent folders" -->
        <button type="button" class="button button-ghost">Home</button>
        <button type="button" class="button button-ghost" aria-pressed="false">Recent</button>
      </div>
      <div class="search">
        …search icon…
        <input class="input" type="text" role="combobox" aria-label="Filter folders in sova"
               aria-expanded="true" aria-controls="ns-picker-list" aria-autocomplete="list"
               aria-activedescendant="ns-pf-0" aria-describedby="ns-picker-note" placeholder="Filter">
      </div>
      <ul class="list folder-list folder-picker-list" id="ns-picker-list" role="listbox" aria-label="Subfolders of sova">
        <li id="ns-pf-0" class="list-row list-row-interactive" role="option" aria-selected="true" title="/home/user/webapps/sova/docs">
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
          …folder… <span class="list-title truncate">~/webapps/sova</span>
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
We rejected a nested `.modal` (the §app/new-session-dialog dialog opening another dialog): it hides the dialog it
belongs to, and on a phone it becomes a bottom sheet over a bottom sheet. A §chat/model-menu-style popover
doesn't fit either, because the picker needs a filter, a scrolling 44px list, and a breadcrumb,
and a popover inside a sheet would clip them.

**No free typing.** The user asked for it gone, so there is no path input and no paste
affordance. Every folder is reached by clicking or by the keyboard, and the filter only narrows
the current list. A folder with no readable route to it (say, an unreadable parent) can't be
chosen here. Start that session from a TUI.

**Type.** The first field (§workspace.fanout/entry-points says why it exists): radios **One session** — the
default, and everything else on this page — and **Fan out…**. One session is the default because
one session is what `New Session` has always made and what most presses of it want; fanout is
offered, not advertised. Choosing **Fan out…** re-aims the dialog: the title reads "Fan out", the
primary reads `Fan Out…` (`aria-disabled` until a folder is chosen, exactly as Create Session
is), and the Where-pi-runs tabs leave — §workspace/fanout's fresh mode is N sessions in one **local** folder,
so there is no remote choice to make, and none that could carry over. Pressing `Fan Out…`
creates nothing here: this dialog closes and §workspace/fanout's opens on **A fresh prompt**, carrying the
folder the field shows (picker open or closed) as its cwd — one folder choice, not two. Nothing
else carries, because nothing else was asked: this dialog has no first message, so there is no
prompt to retype. Enter never submits from the radios — Space and the arrows choose — so the
implicit submit a form would otherwise give Enter on a radio is suppressed.

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
  is `aria-disabled`. Enter inside the picker never submits. With **Fan out…** chosen, the
  primary reads `Fan Out…` and posts nothing: the dialog closes and §workspace/fanout's opens on a fresh
  prompt carrying the field's folder (see **Type** above).
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

### Remote

Above the Folder field, a `.tabs` strip (`role="tablist"`, `aria-label="Where pi runs"`):
**This Computer** (`folder`) and **Remote** (`terminal`). Selection follows ←/→/Home/End, like the
session pane's tabs. The dialog opens on Remote when the prefill is a remote session's placeholder
(below), with that target and folder chosen. Switching tabs closes the picker and clears the field
error; each tab keeps its own choice.

```html
<div class="tabs" role="tablist" aria-label="Where pi runs">
  <button type="button" role="tab" class="tab" id="ns-tab-local" aria-selected="false" tabindex="-1">…folder… This Computer</button>
  <button type="button" role="tab" class="tab tab-active" id="ns-tab-remote" aria-selected="true" tabindex="0">…terminal… Remote</button>
</div>
<div class="stack" role="tabpanel" id="ns-tabpanel" aria-labelledby="ns-tab-remote">
  <div class="field">
    <span class="field-label" id="ns-targets">Target</span>
    <ul class="list folder-list" role="listbox" aria-labelledby="ns-targets">
      <li class="list-row list-row-interactive" role="option" tabindex="0" aria-selected="true" title="192.0.2.10 · ssh">
        …terminal… <span class="list-title truncate">acme prod</span>
        <span class="folder-picker-link truncate">192.0.2.10</span>
        <span class="chip chip-success"><i class="chip-dot"></i>Reachable</span>  <!-- chip-error "Offline" / plain "Not checked" -->
      </li>
    </ul>
  </div>
  <div class="field">
    <label class="field-label" for="ns-rcwd">Folder on acme prod</label>
    <button type="button" class="input input-mono folder-field" id="ns-rcwd" aria-expanded="false" aria-controls="ns-picker"
            aria-describedby="ns-rcwd-hint ns-cwd-error">
      <span class="folder-field-value truncate">/home/deploy/acme-site</span> …chevron-down…
    </button>
    <span class="field-hint" id="ns-rcwd-hint">pi's tools run in this folder on 192.0.2.10. Its transcript stays here.</span>
    <span class="field-error" id="ns-cwd-error"></span>
  </div>
  <!-- open: the same .folder-picker, browsing the target -->
  <div class="field">
    <span class="field-label" id="ns-rrecent">Recent remote folders</span>
    <ul class="list folder-list" role="listbox" aria-labelledby="ns-rrecent">
      <li class="list-row list-row-interactive" role="option" tabindex="0" title="acme-prod:/home/deploy/acme-site">
        …terminal… <span class="list-title truncate">/home/deploy/acme-site</span> <span class="folder-picker-link">acme prod</span>
      </li>
    </ul>
  </div>
  <div class="field">
    <span class="field-hint" id="ns-connect-hint">A new host? An agent asks for its address, checks it answers, and adds it to your targets.</span>
    <div><button type="button" class="button" aria-describedby="ns-connect-hint">…plus… Connect a New Target…</button></div>
  </div>
</div>
```

- **Targets.** `GET /api/targets`, fetched the first time the Remote tab shows. Each row shows the
  `label` (else the name), the `host` (else the `kind`) as a muted caption, and the server's last
  probe as a chip: `ok` → success "Reachable", `error`/`offline` → error "Offline" (its `error` in
  `title`), anything else → plain "Checking…". The server answers within 4 s and reports a probe
  still running as `unknown`, so the dialog asks again every 6 s, three times at most, then says
  "Not checked". While loading: "Loading targets…" as a hint. The
  wait is capped at 10 s, then the error below shows instead. A failed read shows `.field-error`
  "Couldn't read the targets. {message}". None configured: the hint "No targets yet. They live in
  `~/.pi/agent/targets.json`, and the connection agent can write one for you." The Connect button
  is there in every one of these states.
- **An offline target stays pickable.** The probe is a cached guess, and the host may be back. Its
  Folder hint says so instead: "The last check couldn't reach {target}: {error}. Browsing tries
  again." Browsing then says what happened, never an empty list.
- **Picking a target** clears the folder. The Folder field reads "Choose a folder on {target}"
  until one is chosen, and Create Session stays `aria-disabled` until both are.
- **Browsing** reuses the picker with these differences: `GET /api/targets/:name/folders?path=`
  lists the target's subfolders (no path: the folder the target is set to start in). Crumbs
  always start at `/`, since the target's `$HOME` isn't ours, and **no remote path is ever shown
  with `~`**. The Home button reads **Start** and opens the target's start folder. Recent lists
  this target's recent folders. The client gives up after 20 s ("Couldn't reach {target}. No answer
  within 20s."), so "Asking {target} for its folders…" always ends.
- **Recent remote folders.** No endpoint of their own. A remote session's local cwd is a
  placeholder that mirrors the remote folder, `~/.pi/agent/sova/targets/<target>/<remote path>`,
  so the recents from `GET /api/cwds` already hold them. The Remote tab lists those (up to 20,
  newest first, the remote path with the target beside it), and This Computer's recents leave them
  out. Click or Enter/Space picks target and folder at once, and double-click also submits.
- **Submitting** posts `{target, remoteCwd}` instead of `{cwd}`. Errors behave as on This Computer.
- **Connect a New Target…** posts `POST /api/sessions/connect` and hands the returned session over
  like a created one: the dialog closes, the new chat opens, and the composer takes focus. While
  pending it reads "Starting…" and is `aria-disabled` (Create Session too). A failure shows a
  `.banner.banner-error` at the top of the panel: "Couldn't start the connection agent. {message}"
  and the dialog stays.

**Picker states, remote** (the local table below otherwise applies):

| State | Note |
|---|---|
| Loading | Asking {target} for its folders… |
| 403 | Sova can't read this folder on {target}. Pick another one. |
| 404 | This folder doesn't exist on {target}. Pick another one. |
| 400, 502 (unreachable, or no such folder: the message says which) | Couldn't list this folder on {target}. {server message} |
| Client timeout (20 s), server gone | Couldn't reach {target}. {message} |
| Recent, none yet | No recent folders on {target} yet. |

**Picker states** (in `.folder-picker-note`, `aria-live="polite"`; empty when there's nothing to
say):

| State | Note |
|---|---|
| Loading | Loading folders… (the list is `aria-busy`) |
| No subfolders | No subfolders in {name}. You can still start the session here. |
| Filter matches nothing | 0 of {n} match “{filter}”. |
| Over 500 | Showing the first 500 folders, A to Z. Filter to narrow them. |
| 403 | Sova can't read this folder. Pick another one. |
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

