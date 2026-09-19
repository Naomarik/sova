# Typography

## Purpose

Inter for what a person reads, JetBrains Mono for what a machine produced. The mono does the technical work so the sans can stay calm — which is why run IDs, paths and diffs are always mono and prose never is.

Rendered: `site/foundations/typography.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.text-display-xl` | 40px display | One per page |
| `.text-display-l` | 29px display | Section openers |
| `.text-heading-m` | 20px | Card group, modal title |
| `.text-heading-s` | 16px | Card title |
| `.text-body` | 14.5px | Default |
| `.text-caption` | 12.5px | Metadata |
| `.text-mono` | 12.5px mono | Machine facts only |
| `.text-eyebrow` | 11px mono, uppercase | Labels — never a sentence |
| `.text-num` | Tabular numerals | Any column of numbers |

## Tokens used

- `--font-body / --font-display` — Inter, with a system fallback stack.
- `--font-mono` — JetBrains Mono. Reserved for machine facts.
- `--fs-* / --lh-*` — Eight steps, each with its line height.
- `--fw-regular|medium|semibold|display` — 400 / 530 / 600 / 640. Nothing else is on-system.
- `--measure` — 72ch cap on any reading column. Applied by `.prose` and `.measure`, never by a bare element.

## DO / DON'T

- **DO** Use mono for anything the user might copy — it signals "this is exact" before they read it.
- **DO** Cap prose with `.prose` or `.measure` — past ~72ch the eye loses the line return.
- **DO** Use `.text-num` in any numeric column — proportional digits make a column of numbers jitter.
- **DON'T** Expect a bare `<p>` to be capped — it is not, since 1.6.0 — a `<p>` is a status strip as often as it is prose.
- **DON'T** Set body text in mono because it looks technical — it costs ~20% reading speed and says nothing.
- **DON'T** Add a weight outside the four permitted — a fifth weight is a decision nobody documented.
- **DON'T** Use `.text-eyebrow` for a sentence — it is uppercase and letterspaced; sentences become unreadable.
