# Chip

## Purpose

A status, said twice — once in color and once in words. Chips are fully round because status is round and actions are not; the shape alone tells you this is something you read, not something you press.

Rendered: `site/components/chip.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.chip` | Base — pill, mono micro, uppercase | `--r-full` `--fs-micro` |
| `.chip-dot` | 6px dot inheriting `currentColor` | Structural, not decorative |
| `.chip-success|warn|error|info|accent` | Status color | Sets text and dot |
| `.chip-solid` | Soft background fill | Pairs with a status class |
| `.chip-count` | Tabular numerals, no uppercase | For counts only |

## Tokens used

- `--r-full` — The pill shape that separates status from action.
- `--fs-micro` — 11px label.
- `--status-*` — Text color per status.
- `--status-*-bg` — Fill for `.chip-solid`.

## Variants & states

### Status chip

```html
<span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>
```

### Solid

```html
<span class="chip chip-solid chip-success"><i class="chip-dot"></i>Merged</span>
```

### Count

```html
<span class="chip chip-count">7</span>
```


### Status words

A word that appears on many surfaces takes one chip everywhere, so it cannot be two things. The words and what each means belong to whatever spec defines them; this table assigns only the color. No spec owns these four words yet; the mapping stands for the first surface that uses them.

| Word | Chip | Why this severity |
|---|---|---|
| `available` | `.chip-success` | Working, inside its allowance. |
| `degraded` | `.chip-info` | Works now, worse than usual. A caveat, not a wait. |
| `rate-limited` | `.chip-warn` | Not right now, and it returns on its own. A wait. |
| `quota-exhausted` | `.chip-error` | Not until the allowance resets. A switch. |

**The order follows how far the thing is from doing the work you are about to start** — choose it · choose it knowing that · wait or choose another · choose another. `degraded` sits below `rate-limited` because a degraded thing answers now and a rate-limited one does not; coloring it higher tells a reader to avoid something that works.

**Severity is not selectability.** The chip is never the reason a row is disabled, so a warn or info chip must not be drawn as one. Every word carries a dot and the word — `available` included, because a row with no chip is neither.

## DO / DON'T

- **DO** Always include the dot and the word — hue alone fails for colorblind users and in sunlight.
- **DO** Keep chip labels to one or two words — it is a label, not a sentence.
- **DO** Use `.chip-count` for numbers — tabular numerals stop a column from jittering.
- **DON'T** Put a click handler on a chip — if it does something it is a button — use `.button-sm`.
- **DON'T** Invent a sixth status color — four statuses plus accent cover every run state.
- **DON'T** Use a chip as a tag input — that is a combobox.
