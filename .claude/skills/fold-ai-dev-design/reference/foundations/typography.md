# Typography

## Purpose

Inter for what a person reads, JetBrains Mono for what a machine produced. The mono does the technical work so the sans can stay calm — which is why run IDs, paths and diffs are always mono and prose never is.

Rendered: `site/foundations/typography.html#spec`

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

## Scale & spec

| Step | Size | Line height | Usage |
|---|---|---|---|
| `display-xl` | `40px` | `1.05` | Page title. One per page. |
| `display-l` | `29px` | `1.12` | Section opener. |
| `heading-m` | `20px` | `1.25` | Card group heading, modal title. |
| `heading-s` | `16px` | `1.35` | Card title, list section header. |
| `body` | `14.5px` | `1.55` | Everything else. |
| `caption` | `12.5px` | `1.45` | Metadata, hints, timestamps. |
| `mono` | `12.5px` | `1.5` | IDs, paths, diffs, counts. |
| `micro` | `11px` | `1.3` | Eyebrow labels and chips only. Never a sentence. |

**Weights:** regular `400` · medium `530` · semibold `600` · display `640` (display sizes only). Nothing else is on-system.

**Sizes are px, not rem** — in a dense product UI, rem drift across nested containers costs more than it buys. **Sizes and weights are the same in both themes** — no per-theme type adjustment ships.

**The 72ch measure is opt-in.** `.measure` caps one element and `.prose` caps the running text inside a block; a bare `<p>` is never capped, because a `<p>` is a one-line status strip as often as it is prose, and a strip capped short still renders — the mistake is invisible.

**The fonts are real, not placeholders:** Inter and JetBrains Mono, variable, latin subset, shipped in `fonts/`. Swapping a face means replacing the `@font-face` block in `tokens.css` and the `--font-*` stacks — nothing else names a family.

## DO / DON'T

- **DO** Use mono for anything the user might copy — it signals "this is exact" before they read it.
- **DO** Cap prose with `.prose` or `.measure` — past ~72ch the eye loses the line return.
- **DO** Use `.text-num` in any numeric column — proportional digits make a column of numbers jitter.
- **DON'T** Expect a bare `<p>` to be capped — it is not — a `<p>` is a status strip as often as it is prose.
- **DON'T** Set body text in mono because it looks technical — it costs ~20% reading speed and says nothing.
- **DON'T** Add a weight outside the four permitted — a fifth weight is a decision nobody documented.
- **DON'T** Use `.text-eyebrow` for a sentence — it is uppercase and letterspaced; sentences become unreadable.
