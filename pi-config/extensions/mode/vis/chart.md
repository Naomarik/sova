<!-- owner: data member. kinds/chart: parse.ts, scale.ts (axes, ticks), layout.ts (geometry, tested), View.tsx. Emphasis target: row label (key = row index). -->
# vis chart
Numbers to compare. `type:` `bar` (default; `series:` makes grouped bars), `stacked`, `line` (a trend across ordered rows) or `scatter` (two measures per item). `unit:`, `x:` and `y:` name the axes; `scale: log` for values spanning decades (both axes in a scatter).
```vis chart
type: bar
unit: ms
"Quicksort" 120
"Merge sort" 150
"Bubble sort" 9800
mark "Bubble sort" warn "quadratic"
```
- A row: a label (quote it if it has spaces), one number per series (`-` for none), then an optional tone (single series only). Negatives, `12%` and `1.2k` are fine. At most 40 rows, 6 series.
- Scatter rows are `label x y [tone]`, with no `series:`.
- `type: parts`: one bar split into its rows, for a whole and its parts; `of:` a capacity draws the unused rest (rows past it don't draw: drop `of:`, say so in the caption).
```vis chart
type: parts
unit: tokens
of: 200000
"System prompt" 9000 muted
"Earlier turns (cached)" 60000 info
"New input" 6000
mark "New input" "only this part is uncached"
```
- `mark` targets: a row's label.
