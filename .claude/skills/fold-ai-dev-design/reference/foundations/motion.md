# Focus & motion

## Purpose

One curve, three durations, and a written rule about what never moves. Motion is a foundation here rather than a flourish — without one sanctioned duration, every consumer invents their own transitions and the product starts to feel assembled rather than built.

Rendered: `site/foundations/motion.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.button-focus / .input-focus` | Static focus — demo only | Production uses `:focus-visible` |
| `.timeline-running` | Pulsing live marker | One of two sanctioned loops |
| `.skeleton` | Sweeping placeholder | The other |

## Tokens used

- `--focus-ring / --focus-width / --focus-offset / --focus-color` — The ring, in pieces and composed.
- `--dur-fast|base|slow` — 120 / 200 / 320ms.
- `--ease-standard` — The only curve in the system.

## DO / DON'T

- **DO** Animate state changes at `--dur-fast` — faster feels broken, slower feels sluggish.
- **DO** Keep opacity fades under reduced motion — they carry meaning; transforms are what cause discomfort.
- **DO** Use one curve everywhere — mixed easings read as mixed authorship.
- **DON'T** Add a spring or bounce — this product reports on other people's work; playfulness reads as unseriousness.
- **DON'T** Loop anything decorative — two exceptions exist and they both mean "work is happening".
- **DON'T** Remove the focus outline — a keyboard user who cannot see focus cannot use the product.
