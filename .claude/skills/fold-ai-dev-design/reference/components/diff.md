# Diff viewer

## Purpose

The core review act. Unified when folded, side-by-side when unfolded — and added and removed lines carry a gutter sign as well as a color, because the one screen where color blindness must not cost you anything is the one where you approve a change.

Rendered: `site/components/diff.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.diff` | Base — 6px radius, mono | Clips its rows; the query container for `.diff-split` |
| `.diff-file` | File header with stats | Sunken strip |
| `.diff-stat-add / -del` | +n / −n | Status colors |
| `.diff-hunk` | Hunk marker row | Muted |
| `.diff-line` | Gutter + code row | Wraps rather than scrolls |
| `.diff-gutter` | Line number and sign | Not selectable |
| `.diff-add / .diff-del` | Added / removed | Background + gutter sign |
| `.diff-split` | Two columns from 768 **of its `.diff`** | Unified below that, and with no `.diff` around it |

## Tokens used

- `--diff-add-bg / --diff-add-ink` — Added line, per theme.
- `--diff-del-bg / --diff-del-ink` — Removed line.
- `--diff-gutter` — Gutter background.
- `--font-mono / --fs-mono` — 12.5px mono.

## Variants & states

### Added line

```html
<div class="diff-line diff-add">
  <span class="diff-gutter">19</span>
  <span>  const ok = await limiter.take(req.ip);</span>
</div>
```

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** Keep the +/− sign in the gutter — color alone fails the exact user who most needs the review to work.
- **DO** Wrap long lines at folded width — horizontal scroll inside a diff makes review impossible one-handed.
- **DO** Show the file path and the stat together — the header answers "how big is this?" before you read a line.
- **DON'T** Use side-by-side below 768px — two 40-character columns are unreadable.
- **DON'T** Put a `.diff-split` outside a `.diff` — it has no container to measure and stays unified forever.
- **DON'T** Put a `.diff` in a grid `auto` track or set it `inline-block` — it is a query container, so it has no intrinsic width and measures 2px — its own borders — rather than its widest line.
- **DON'T** Syntax-highlight in brand colors — the accent means "action"; a keyword is not an action.
- **DON'T** Collapse context to zero lines — a diff without context is not reviewable.
