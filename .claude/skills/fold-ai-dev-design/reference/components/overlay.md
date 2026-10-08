# Modal, sheet & popover

## Purpose

Three ways to put something on top. At folded width a modal becomes a bottom sheet, so the decision arrives inside the thumb arc rather than in the middle of a screen nobody can reach one-handed. A popover is also every menu: a ⋯ overflow, a dropdown, a picker and a flyout all use `.popover-item` rows, one line or label + description.

Rendered: `site/components/overlay.html#modal`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.scrim` | Fixed dim layer | Click closes |
| `.modal` | Centered dialog, ≤520px | `--shadow-3` |
| `.modal-head / -title / -body / -foot` | Dialog parts | Foot holds actions |
| `.sheet` | Bottom sheet, ≤85vh | Folded-width modal |
| `.sheet-grip` | Drag handle | Affordance only |
| `.popover` | Anchored menu, dropdown or picker panel | `--shadow-2`, min 200px |
| `.popover-item` | One-line 44px menu row, centered | Every menu, dropdown, ⋯ overflow and flyout row |
| `.popover-item-detail` | Label + description row | Icon and check stay on the label line |
| `.popover-item-mono` | Mono label | Machine names: ids, modes |
| `.popover-item-icon` | Leading icon slot | Muted; or an `.icon` as a direct child |
| `.popover-item-check` | Check slot | Shown while `aria-checked="true"` |
| `.popover-item-text / -label / -desc` | Row text | Desc is caption, muted |
| `.popover-item-end` | Trailing value or chevron | Pushed to the end |
| `.popover-label` | Section label inside a menu | Mono micro caps |
| `.popover-sep` | Divider, `role="separator"` | Between groups; before destructive items |

## Tokens used

- `--r-xl` — 16px — sheets and modals.
- `--shadow-2 / -3` — Popover / modal.
- `--dur-base` — 200ms entry.
- `--control-md` — 44px — the minimum height of a menu row.

## Variants & states

### Confirm modal

```html
<div class="modal">
  <div class="modal-head"><h3 class="modal-title">Discard this run?</h3></div>
  <div class="modal-body">The worker's 7 changed files go away. Nothing was merged, so nothing else changes.</div>
  <div class="modal-foot">
    <button class="button button-destructive">Discard Run</button>
    <span class="approvalbar-spacer"></span>
    <button class="button button-ghost">Cancel</button>
  </div>
</div>
```

### Action menu (⋯ overflow)

```html
<div class="popover" role="menu" aria-label="Run actions">
  <a class="popover-item" role="menuitem" href="…"><svg class="icon" aria-hidden="true">…external…</svg>Open in editor</a>
  <div class="popover-item" role="menuitem" tabindex="-1"><svg class="icon" aria-hidden="true">…copy…</svg>Copy run ID</div>
  <div class="popover-sep" role="separator"></div>
  <div class="popover-item text-error" role="menuitem" tabindex="-1">Discard run</div>
</div>
```

### Choice menu (dropdown, picker)

```html
<div class="popover" role="menu" aria-label="Move into group">
  <div role="group" aria-label="Groups">
    <div class="popover-label" aria-hidden="true">Groups</div>
    <div class="popover-item" role="menuitemradio" aria-checked="true" tabindex="0">
      <svg class="icon popover-item-check" aria-hidden="true">…check…</svg>
      <span class="popover-item-text"><span class="popover-item-label">Release work</span></span>
    </div>
  </div>
</div>
```

### Label + description row

```html
<div class="popover-item popover-item-detail" role="menuitem" aria-disabled="true" tabindex="-1">
  <svg class="icon" aria-hidden="true">…external…</svg>
  <span class="popover-item-text">
    <span class="popover-item-label">Open workspace</span>
    <span class="popover-item-desc">Nothing is in it yet. Add a session first.</span>
  </span>
</div>
```


## DO / DON'T

- **DO** State what goes away and what does not — the second half is what makes the decision easy.
- **DO** Make every menu row a `.popover-item` — one row component owns alignment, height and states for every menu.
- **DO** Use `.popover-item-detail` for a row with a second line — its icon and check stay on the label line.
- **DO** Use a sheet instead of a modal at folded width — the thumb cannot reach a centered dialog.
- **DO** Separate destructive popover items with a divider — distance prevents mis-taps.
- **DON'T** Reveal the trigger of a menu only on hover — a phone has no hover, so the menu and everything in it does not exist there.
- **DON'T** Style a menu row with the row class of another component, or set its `align-items` or vertical padding yourself — a borrowed row brings its own alignment; use `.popover-item` / `.popover-item-detail`.
- **DON'T** Stack a modal on a modal — close the first; the user has lost the thread by then.
- **DON'T** Ask "Are you sure?" — say what will happen instead.
