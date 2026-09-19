# Modal, sheet & popover

## Purpose

Three ways to put something on top. At folded width a modal becomes a bottom sheet, so the decision arrives inside the thumb arc rather than in the middle of a screen nobody can reach one-handed.

Rendered: `site/components/overlay.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.scrim` | Fixed dim layer | Click closes |
| `.modal` | Centred dialog, ≤520px | `--shadow-3` |
| `.modal-head / -title / -body / -foot` | Dialog parts | Foot holds actions |
| `.sheet` | Bottom sheet, ≤85vh | Folded-width modal |
| `.sheet-grip` | Drag handle | Affordance only |
| `.popover` | Anchored menu | `--shadow-2` |
| `.popover-item` | 44px menu row | Never the only path |
| `.popover-sep` | Divider | Before destructive items |

## Tokens used

- `--r-xl` — 16px — sheets and modals.
- `--shadow-2 / -3` — Popover / modal.
- `--dur-base` — 200ms entry.

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

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** State what goes away and what does not — the second half is what makes the decision easy.
- **DO** Use a sheet instead of a modal at folded width — the thumb cannot reach a centred dialog.
- **DO** Separate destructive popover items with a divider — distance prevents mis-taps.
- **DON'T** Put the only path to an action in a popover — hidden actions do not exist on touch.
- **DON'T** Stack a modal on a modal — close the first; the user has lost the thread by then.
- **DON'T** Ask "Are you sure?" — say what will happen instead.
