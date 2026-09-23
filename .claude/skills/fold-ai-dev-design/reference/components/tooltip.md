# Tooltip

## Purpose

One sentence behind a term or a figure, for the user who wants it defined once. It opens on hover and on keyboard focus, and it is never the only place a fact lives — a touch user may never open it, so anything a decision depends on goes in the row or on the control instead.

Rendered: `site/components/tooltip.html#term`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.tip` | The trigger — the term itself, dotted underline | `tabindex="0"` and `aria-describedby` |
| `.tip-bubble` | The sentence, above the trigger | `role="tooltip"`; ≤32ch |
| `.tip-start|end` | Anchor the bubble to the trigger's start or end edge | From 768px; under it every bubble is a strip above the bottom bar |
| `.tip-static` | Demo helper — bubble held open | Documentation only |

## Tokens used

- `--color-ink / --color-bg` — Inverted bubble, so it reads over any surface in either theme.
- `--fs-caption` — 12.5px sentence.
- `--dur-fast` — 120ms open.
- `--shadow-2` — Lift off the page.

## Variants & states

### Term with a tooltip

```html
<span class="tip" tabindex="0" aria-describedby="t-free">free memory<span class="tip-bubble" role="tooltip" id="t-free">Inside this machine's share, latest reading.</span></span>
```


## DO / DON'T

- **DO** Keep it to one sentence — a second sentence is a paragraph that found a hiding place.
- **DO** Use `.tip-start` or `.tip-end` on a trigger in a first or last column — a centered bubble on an edge chip is clipped at phone width.
- **DO** Put the trigger on the term, not on an icon — the word is what the user is unsure of.
- **DO** Give the trigger `tabindex="0"` and `aria-describedby` — a tooltip only a mouse can open is a tooltip half the users never see.
- **DON'T** Make a tooltip the only place a fact lives — touch users may never open it; put the fact in the row or on the control.
- **DON'T** Put a control's reason in a tooltip — a disabled control carries its own reason.
- **DON'T** Explain why the product behaves as it does — the tooltip defines a term; it does not argue.
