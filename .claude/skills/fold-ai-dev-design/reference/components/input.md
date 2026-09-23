# Input

## Purpose

A 44px field with a real label. The placeholder is never the label — it disappears the moment someone types, and a form you cannot re-read is a form you cannot check.

Rendered: `site/components/input.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.field` | Label + control + message column | `--space-2` gap |
| `.field-row` | Same field, laid out as a row | A switch beside its label |
| `.field-label` | 12.5px semibold label | Always present |
| `.field-hint` | Muted help text | Below the control |
| `.field-error` | Error message | Pairs with `aria-invalid` |
| `.input` | Base — 44px, 8px radius | `--control-md` |
| `.textarea` | Multi-line, vertical resize | Min 88px |
| `.input-mono` | Mono content | IDs, paths |
| `.input-invalid` | Error border | Use with `aria-invalid="true"` |
| `.is-hover / .is-focus / .is-disabled` | Static states on `.input` | **Demo only** — production uses pseudo-classes |

## Tokens used

- `--control-md` — 44px height.
- `--r-md` — 8px corner.
- `--color-border-strong` — Resting border, 3:1.
- `--color-accent` — Focused border and ring.
- `--status-error` — Invalid border and message.

## Variants & states

### Labeled field

```html
<div class="field">
  <label class="field-label" for="run-name">Run name</label>
  <input class="input" id="run-name" placeholder="Add rate limiting">
  <span class="field-hint">Shown in the queue and in the run log.</span>
</div>
```

### Invalid

```html
<input class="input input-invalid" aria-invalid="true" value="prototype/gone">
<span class="field-error">That branch doesn't exist. Pick one that does.</span>
```

### Field as a row

```html
<div class="field field-row">
  <label class="field-label" for="live">Follow the run</label>
  <span class="toggle-switch"><input type="checkbox" id="live" checked></span>
</div>
```

Every state is rendered together in the site page's state matrix. The `.is-hover`,
`.is-focus`, `.is-active` and `.is-disabled` helpers are **documentation scaffolding
only** — production code uses the real pseudo-classes.

## DO / DON'T

- **DO** Always ship a visible `<label>` tied by `for` — a placeholder vanishes exactly when the user needs it.
- **DO** Say what to do in an error, not just what broke — "Pick one that does" is actionable; "Invalid" is not.
- **DO** Use `.input-mono` for IDs and paths — it signals the value is exact.
- **DO** Add `.field-row` when a field is a row — `.field` is a column, and a class that sets only `display:flex` inherits it.
- **DON'T** Use the placeholder as the label — it fails on review, on autofill, and for screen readers.
- **DON'T** Shrink an input below 44px — it is the most-tapped control in any form.
- **DON'T** Color an invalid field without a message — color alone does not say what is wrong.
- **DON'T** Restate `flex-direction` on your own class to undo `.field` — `.field-row` is the supported name; a second one drifts.
