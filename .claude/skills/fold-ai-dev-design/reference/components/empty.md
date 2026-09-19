# Empty state

## Purpose

The live fact first, the absence second. "Nothing needs you right now" states only an absence; "4 runs working. Nothing to decide yet." tells the user the system is alive and their queue is genuinely clear.

Rendered: `site/components/empty.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.empty` | Centred column | `--space-8` vertical padding |
| `.empty-mark` | Muted glyph or icon | Optional |
| `.empty-title` | 16px semibold | The fact |
| `.empty-body` | Muted, ≤44ch | What will appear here |
| `.empty-action` | Single action | Optional |

## Tokens used

- `--space-8` — 64px breathing room — the one place the product goes airy.
- `--color-ink-muted` — Mark and body.

## Variants & states

### Queue clear

```html
<div class="empty">
  <p class="empty-title">4 runs working. Nothing to decide yet.</p>
  <p class="empty-body">We'll put anything that wants a decision right here.</p>
</div>
```

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** State a live fact before the absence — it tells the user the system is working, not broken.
- **DO** Say what will appear here and when — an empty state is a promise about the future.
- **DO** Offer at most one action — more than one means the screen is not actually empty.
- **DON'T** Write "Nothing needs you right now" — an absence alone is not information — this is the canonical bad line.
- **DON'T** Use an illustration — this brand is not illustrative; a muted glyph is enough.
- **DON'T** Apologize for the emptiness — a clear queue is the goal, not a failure.
