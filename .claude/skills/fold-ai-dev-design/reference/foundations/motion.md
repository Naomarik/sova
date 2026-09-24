# Focus & motion

## Purpose

One curve, three durations, and a written rule about what never moves. Motion is a foundation here rather than a flourish — without one sanctioned duration, every consumer invents their own transitions and the product starts to feel assembled rather than built.

Rendered: `site/foundations/motion.html#spec`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.button.is-focus / .input.is-focus` | Static focus — demo only | Production uses `:focus-visible` |
| `.timeline-running` | Pulsing live marker | One of two sanctioned loops |
| `.skeleton` | Sweeping placeholder | The other |

## Tokens used

- `--focus-ring / --focus-width / --focus-offset / --focus-color` — The ring, in pieces and composed.
- `--dur-fast|base|slow` — 120 / 200 / 320ms.
- `--ease-standard` — The only curve in the system.

## Scale & spec

| Token | Value | Applies to |
|---|---|---|
| `--dur-fast` | `120ms` | Hover, focus, press, tooltip |
| `--dur-base` | `200ms` | Popover, toast, sheet entering |
| `--dur-slow` | `320ms` | Full-screen transitions only |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | Everything — one curve, no bounce, no spring |
| `--focus-width` | `2px` | Focus ring stroke |
| `--focus-offset` | `2px` | Gap between the ring and the element |
| `--focus-color` | `#4A43D8` | Ring color — the accent, per theme |

**What never animates: decoration.** Nothing loops, drifts, or pulses, with two exceptions — the live-run indicator and the skeleton sweep, both of which report that work is happening. The live-run pulse fades opacity 1 → .4 → 1 over 1.6s (`run-pulse`): deep enough to read as motion, shallow enough that the mark never all but vanishes. The same pulse serves a figure (Sova's worker count): at .4 a numeral stays readable.

**Under `prefers-reduced-motion`,** `tokens.css` collapses animation and transition durations to near zero, which stops both exceptions. Nothing is exempt — opacity fades land instantly too — and transforms are not removed, only made instant.

**The focus ring is `:focus-visible` only, never removed, and never replaced by a color change alone.**

## DO / DON'T

- **DO** Animate state changes at `--dur-fast` — faster feels broken, slower feels sluggish.
- **DO** Carry meaning in the end state, not the transition — under reduced motion every transition is near-instant, fades included, so the state must read without it.
- **DO** Use one curve everywhere — mixed easings read as mixed authorship.
- **DON'T** Add a spring or bounce — motion here reports state, and a bounce on a failure reads as play.
- **DON'T** Loop anything decorative — two exceptions exist and they both mean "work is happening".
- **DON'T** Remove the focus outline — a keyboard user who cannot see focus cannot use the product.
