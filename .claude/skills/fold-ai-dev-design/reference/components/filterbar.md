# Filter bar

## Purpose

What a set is narrowed by, what it is ordered by, and how many it is showing — one bar, because those three facts are read together or not at all. A count sitting anywhere else eventually reads 5 while three rows are hidden, and nobody notices.

Rendered: `site/components/filterbar.html#anatomy`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.filterbar` | The bar — wraps, sits on `--color-sunken` | Above the set it governs |
| `.filterbar-filters` | The controls, at the near end | Wrapping cluster |
| `.filterbar-filter` | One axis — 44px, 8px radius | A `<button>`; `aria-haspopup` when it opens a list |
| `.filterbar-filter-on` | Set | Tint, and the value in the label |
| `.filterbar-value` | The value inside the label | Muted until the filter is set |
| `.filterbar-order` | The sort control | Same control, one per bar |
| `.filterbar-count` | How many are showing | Far end; answers to the filters |

## Tokens used

- `--control-md` — 44px — a filter bar is a touch surface, so `.button-sm` is not allowed here.
- `--r-md` — 8px. Status is round; a filter is an action.
- `--color-sunken` — The bar's ground.
- `--color-border-strong` — The 3:1 control border.
- `--color-accent / --color-accent-tint` — A set filter.

## Variants & states

### A filter

```html
<button class="filterbar-filter" aria-haspopup="listbox">State <span class="filterbar-value">any</span></button>
```

### Set

```html
<button class="filterbar-filter filterbar-filter-on" aria-haspopup="listbox">Project <span class="filterbar-value">fold-ai-dev</span></button>
```

### The count

```html
<p class="filterbar-count">7 of 24 <span class="visually-hidden">worktrees shown</span></p>
```


## DO / DON'T

- **DO** Keep the count in the bar — a badge reading 5 while three rows are filtered out is a lie, and this is the only placement that catches it.
- **DO** Say the set value in the label — the tint is hue, and hue is never the signal.
- **DO** Keep every control 44px — this bar is the first thing a thumb reaches on a folded screen.
- **DON'T** Draw a filter as a chip — a chip is something you read; a filter is something you press.
- **DON'T** Use `.button-sm` to fit more filters in — wrap instead — the bar is built to.
- **DON'T** Ship a second sort control — one order per set, or the set has two orders and neither is true.
