# §design/menu-rows — Menu rows
> Part of the Sova design spec · [overview](overview.md)

Every row of a menu is the design system's popover row, `.popover-item`, ported into `base.css`.
A menu row is any element with `role="menuitem"`, `"menuitemradio"` or `"menuitemcheckbox"`: the
session list's `⋯` menus and every other `ActionMenu`, Move into group, a workspace's narrow More
Actions, the composer flyout, the mode menu and its subagent profile panel, the host menu, the
align chips and the Costs tab's pickers. The row owns its alignment, its height and its states, so
every menu's rows line up the same way.

```html
<div class="model-menu-list" role="menu" aria-label="Move into group">
  <div class="model-menu-group" role="group" aria-labelledby="…-groups">
    <div class="list-group-label" id="…-groups">Groups</div>
    <!-- One line: a verb or a value. -->
    <div class="popover-item popover-item-mono" role="menuitemradio" aria-checked="true" tabindex="0">
      <svg class="icon icon-sm popover-item-check" aria-hidden="true">…check…</svg>
      <span class="popover-item-text"><span class="popover-item-label">Work</span></span>
    </div>
  </div>
  <div class="popover-sep" role="separator"></div>
  <!-- Label + description: a mode, a profile, a row that says why it can't run. -->
  <div class="popover-item popover-item-detail" role="menuitem" tabindex="-1" aria-disabled="true">
    <svg class="icon icon-sm" aria-hidden="true">…external…</svg>
    <span class="popover-item-text">
      <span class="popover-item-label">Open workspace</span>
      <span class="popover-item-desc">Nothing is in it yet. Drag a session into it first.</span>
    </span>
  </div>
</div>
```

- **Height.** A row is at least `--control-md` (44px) tall, with `--space-2` between its parts and
  `--space-3` at each side. A one-line row has `--space-1` above and below; a row whose label
  wraps grows with it.
- **One line.** A `.popover-item` row's icon, check and label sit on the row's centre line.
- **Label + description.** A row with a second line is `.popover-item.popover-item-detail`: the
  label and its description stack in `.popover-item-text` (`.popover-item-label` over
  `.popover-item-desc`, caption, muted), with `--space-2` above and below. Its icon and check stay
  on the first line: each sits in a box as tall as the label's line, centred in it. A label in
  mono (a mode or group name) is `.popover-item-mono`, which sets the label's face and that box
  together.
- **Slots.** A leading `.icon` (or `.popover-item-icon`) is muted. `.popover-item-check` comes
  first in a `menuitemradio` or `menuitemcheckbox` row, in ink, shown only while the row is
  checked. `.popover-item-end` holds a trailing chevron or value, pushed to the row's end, muted.
- **States.** Hover fills `--color-sunken`. Keyboard focus draws `--focus-ring` inside the row. A
  checked row (`aria-checked="true"`) is `--color-accent-tint` and shows its check. A row with
  `aria-disabled="true"` is drawn at .42 opacity with a not-allowed cursor (a menu that is saving
  shows `progress` instead); one with `aria-busy="true"` stays at full ink with a progress cursor.
  A row that goes somewhere is an `<a>` and reads in the row's ink, not as a link.
- **Groups and separators.** A labelled group inside a menu keeps `.list-group-label`; a
  separator is `.popover-sep` with `role="separator"`. `.popover-label` is the system's section
  label for a menu without groups.
- **A side action is a button beside the row.** Configure Delegate's gear and a host's Resync are
  real `.button`s with `role="menuitem"`, siblings of the row inside a wrapper, never nested in it.
- **Nothing else sets a row's alignment.** No stylesheet sets `align-items`, vertical padding or a
  min height on a rule that names `.popover-item` or `.popover-item-detail` outside the
  primitive's own block in `base.css`. `src/lib/menu-rows.test.ts` checks this and that every menu
  row in `src/` carries `.popover-item`.
- **Pickers you type into are listboxes.** The model picker, the slash and file menus, the profile
  picker, the folder picker and the option lists in the New Session dialog and extension dialogs
  are `role="listbox"` with their own `role="option"` rows, not menu rows.
- **The panel.** Sova's menus keep their own shells (`.model-menu` and its `.action-menu`,
  `.group-menu`, `.mode-menu`, `.composer-flyout` variants), which run their rows edge to edge, so
  the rows are square. A row inside the system's `.popover` panel is rounded `--r-sm`.
- **Move into group's height.** From 768px up the panel is as tall as its rows, up to 70dvh or the
  room on the side of the trigger it opens towards, whichever is less; only past that does its
  list scroll.
