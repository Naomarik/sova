# List & row

## Purpose

A scannable column of things to decide on. The whole row is the target — 44px tall with 12px padding, because the target grew and the row didn't.

Rendered: `site/components/list.html#anatomy`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.list` | Column container | No padding of its own |
| `.list-row` | 44px row, 12/16 padding | Bottom border except last |
| `.list-row-interactive` | Hover and focus affordance | Use on `<a>` or `<button>` |
| `.list-row-selected` | Tinted current row | Detail-pane selection |
| `.list-main` | Growing text column | `min-width:0` for truncation |
| `.list-title` | 14.5px, truncates | One line |
| `.list-meta` | 12.5px muted | Second line |
| `.list-group-label` | Mono uppercase divider | Section heading |

## Tokens used

- `--row-height` — 44px minimum.
- `--color-accent-tint` — Selected row.
- `--color-sunken` — Hover fill.

## Variants & states

### Interactive row

```html
<a class="list-row list-row-interactive" href="/runs/8f21c4">
  <div class="list-main">
    <p class="list-title">Add rate limiting to /api/runs</p>
    <p class="list-meta">Wants a decision · <span class="text-mono">+142 −38</span></p>
  </div>
  <span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>
</a>
```


## DO / DON'T

- **DO** Make the whole row the link — a 44px row with a 20px hit area wastes the row.
- **DO** Group rows with `.list-group-label` — "Waiting on you" is the most useful heading in the product.
- **DO** Put the machine facts in mono on the meta line — they are scannable exactly because they look different.
- **DON'T** Put row actions behind hover — a phone has no hover, so they do not exist there.
- **DON'T** Let the title wrap to three lines — truncate; the detail pane has the full text.
- **DON'T** Use a list where a table is right — if you need aligned columns, use the table.
