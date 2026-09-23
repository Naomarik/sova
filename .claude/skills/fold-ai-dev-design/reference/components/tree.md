# Tree

## Purpose

A hierarchy that belongs to the data — a worktree's files, a scope, a set of nested groups. A branch is a `<details>`, so it collapses with no script at all; a tree that needs JavaScript to open is a tree that shows one row when the script fails.

Rendered: `site/components/tree.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.tree` | The root list | `<ul>`, no list marker, no padding of its own |
| `.tree-branch` | One node that has children | Wraps a `<details>` — `[open]` is the `<details>`'s |
| `.tree-row` | 44px row — `<summary>`, `<a>` or `<div>` | The whole width is the target |
| `.tree-twist` | The disclosure chevron | Rotates on `[open]`; the only marker |
| `.tree-mark` | Leading icon slot | Muted, never the only signal |
| `.tree-name` | The name — one line, truncated | `min-width:0` |
| `.tree-meta` | Trailing fact | Pushed to the far end |
| `.tree-children` | The nested list | 12px step and a guide rule |
| `.tree-row-selected` | The row you are on | `--color-accent-tint` |

## Tokens used

- `--row-height` — 44px at every level, folded included.
- `--space-3 / --space-4` — The one indent step and the rule offset.
- `--color-border` — The guide rule that carries depth.
- `--color-accent-tint` — The selected row.
- `--dur-fast / --ease-standard` — 120ms twist.

## Variants & states

### A branch

```html
<li class="tree-branch"><details open>
  <summary class="tree-row"><span class="tree-twist">›</span><span class="tree-name">src/api</span></summary>
  <ul class="tree-children">…</ul>
</details></li>
```

### A leaf

```html
<li><a class="tree-row" href="#"><span class="tree-name">runs.ts</span></a></li>
```


## DO / DON'T

- **DO** Keep the indent at one 12px step per level — depth is the guide rule's job; at 24px a six-deep path leaves a folded screen no room for the name.
- **DO** Use `<details>` for a branch — it collapses, it announces expanded/collapsed, and it needs no script.
- **DO** Truncate the name and keep the row 44px — the full path belongs in the detail view, not in three wrapped lines.
- **DON'T** Use a tree because the layout looks nested — if the nesting is not the data's, this is the wrong component.
- **DON'T** Hide a row's only action behind hover — a phone has no hover, so the action does not exist there.
- **DON'T** Indent by margin on the row itself — the target stops starting at the left edge, and depth eats the name.
