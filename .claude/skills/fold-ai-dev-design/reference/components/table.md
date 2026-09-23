# Table

## Purpose

Aligned columns for comparing runs. Below 768px a table is not a table — it stacks into rows, because horizontal scroll on a phone is a defeat, not a fallback. **The 768 is its `.table-wrap`, not the window**: a five-column table in a 660px pane inside a 933px window has to stack too, and a media query cannot see that.

Rendered: `site/components/table.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.table-wrap` | Scroll container **and** query container | Required around `.table-stack` |
| `.table` | Base table | Mono uppercase headers |
| `.table-stack` | Collapses below 768 **of its wrapper** | Requires `data-label` on every cell |
| `.table-num` | Right-aligned tabular | Numbers and times |
| `.table-mono` | Mono cell | Diffs, IDs, paths |

## Tokens used

- `--fs-micro` — Header size.
- `--color-sunken` — Row hover.
- `--bp-unfolded` — 768px — where it stacks.

## Variants & states

### Stacking table

```html
<div class="table-wrap">
  <table class="table table-stack">
    <thead><tr><th>Run</th><th>Changed</th></tr></thead>
    <tbody>
      <tr><td data-label="Run">Add rate limiting</td>
          <td data-label="Changed" class="table-mono">+142 −38</td></tr>
    </tbody>
  </table>
</div>
```


## DO / DON'T

- **DO** Add `data-label` to every cell — it becomes the label when the table stacks.
- **DO** Wrap every `.table-stack` in a `.table-wrap` — the wrapper is the box the stack rule measures.
- **DO** Right-align numbers with `.table-num` — a ragged numeric column cannot be compared.
- **DO** Keep status as a chip inside the cell — the same status language as everywhere else.
- **DON'T** Scroll a table horizontally on a phone — stack it — that is what `.table-stack` is for.
- **DON'T** Ship a `.table-stack` with no `.table-wrap` — it falls back to the window and unstacks inside a narrow pane.
- **DON'T** Let a `.table-wrap` size itself from its table — it is a query container, so it has no intrinsic width: as a `flex: none` item it measures 0px and vanishes. Give it `flex: 1`, a grid `1fr`, or `width: 100%`.
- **DON'T** Ship more than five columns — the sixth is never read; put it in the detail view.
- **DON'T** Use a table for a single-column list — that is a list.
