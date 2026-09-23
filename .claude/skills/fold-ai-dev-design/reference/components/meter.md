# Meter

## Purpose

A measured number against what bounds it — 31 GB free of 48 GB allocated, on a 64 GB machine. Number first, bar second, and never a bar alone: a bar answers "roughly how full" and refuses "how much", which is the question the person placing a worktree is actually asking.

Rendered: `site/components/meter.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.meter` | The block — number, bar, context | Column, `min-width:0` |
| `.meter-head` | Label and value on one line | Wraps at narrow widths |
| `.meter-label` | What is being measured | 12.5px medium |
| `.meter-value` | The number | Mono, tabular numerals |
| `.meter-of` | The denominator inside the value | Muted — it is the bound, not the fact |
| `.meter-track` | The bar | 6px, 3:1 border, `--r-full` |
| `.meter-fill` | The measured part | Inline `width:` — the only inline style this system asks for |
| `.meter-context` | The third term | `64 GB machine` — not the denominator |
| `.meter-ghost` | No value yet | Dashed track, no fill |

## Tokens used

- `--color-border-strong` — The track border — a graphical object needs 3:1, not the divider value.
- `--color-sunken` — The empty part of the track.
- `--color-accent` — The fill.
- `--r-full` — Both ends of the track.
- `--fs-mono` — The number.

## Variants & states

### A meter

```html
<div class="meter">
  <p class="meter-head"><span class="meter-label">Free</span>
    <span class="meter-value">31 GB<span class="meter-of"> of 48 GB allocated</span></span></p>
  <div class="meter-track" aria-hidden="true"><span class="meter-fill" style="width:65%"></span></div>
  <p class="meter-context">64 GB machine</p>
</div>
```

### No value yet

```html
<div class="meter meter-ghost">…<div class="meter-track" aria-hidden="true"></div></div>
```


## DO / DON'T

- **DO** State the number — the bar is the shape of a fact, never the fact.
- **DO** Keep the third term separate from the denominator — a full allocation and a full machine are different problems.
- **DO** Leave the track `aria-hidden` — the number above it is already the accessible value; the bar would say it twice.
- **DON'T** Ship a bar with no number — it answers "roughly" to a question asked in gigabytes.
- **DON'T** Ship a bar with no denominator — a track with no whole behind it is a picture of nothing — state the number and stop.
- **DON'T** Color the fill to mean a status on its own — pair it with the word, per Accessibility.
- **DON'T** Animate the fill on load — nothing drifts or pulses but the live-run indicator.
