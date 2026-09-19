# Toast

## Purpose

A transient acknowledgment with an optional escape hatch. The rule that keeps it honest: a toast is never the only copy of a fact — if it vanishes and the information is gone, it should have been a banner.

Rendered: `site/components/toast.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.toast` | Floating strip, `--shadow-2` | Max 420px |
| `.toast-body` | Message | Grows |
| `.toast-action` | Trailing action | Usually Undo |
| `.toast-stack` | Fixed container | Bottom centre, right from 768 |

## Tokens used

- `--shadow-2` — Elevation.
- `--dur-base` — 200ms entry.
- `--r-lg` — 12px corner.

## Variants & states

### Toast with undo

```html
<div class="toast">
  <span class="toast-body">Run discarded.</span>
  <button class="button button-sm button-ghost toast-action">Undo</button>
</div>
```

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** Offer Undo for anything destructive — reversibility is a brand value, not a nicety.
- **DO** Keep it to one line — a toast is read in passing or not at all.
- **DO** Anchor toasts above the approval bar at folded width — never cover the decision the user is making.
- **DON'T** Put the only record of an error in a toast — use a banner, which stays.
- **DON'T** Stack more than three — the fourth is invisible by the time it arrives.
- **DON'T** Auto-dismiss a toast that has an action — the user needs time to reach Undo.
