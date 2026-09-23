# Button

## Purpose

The decision, made tappable. One primary per view — the thing the user came to do — and destructive actions are outlined rather than filled, because a filled red button is the most tappable thing on screen, which is exactly backwards.

Rendered: `site/components/button.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.button` | Base — 44px, 8px radius, 1.5px border | `--control-md` `--r-md` `--color-border-strong` |
| `.button-primary` | Filled accent | `--color-accent` / `--color-on-accent` |
| `.button-destructive` | Outlined error | Never filled |
| `.button-ghost` | Borderless, muted | Cancel and tertiary |
| `.button-sm / .button-lg` | 36px / 52px | Label size shifts with it |
| `.button-icon` | Square 44px | Requires `aria-label` |
| `.button-row` | Demo helper — wrapping row | Demo only |
| `.is-hover / .is-focus / .is-active / .is-disabled` | Static states on `.button` | **Demo only** — production uses pseudo-classes |

## Tokens used

- `--control-sm|md|lg` — 36 / 44 / 52px heights.
- `--r-md` — 8px corner.
- `--color-accent / --color-on-accent` — Primary fill and its label.
- `--color-border-strong` — Secondary border — the 3:1 value.
- `--status-error` — Destructive border and label.
- `--dur-fast / --ease-standard` — 120ms state transition.

## Variants & states

### Primary

```html
<button class="button button-primary">Approve</button>
```

### Secondary

```html
<button class="button">Review Changes</button>
```

### Destructive

```html
<button class="button button-destructive">Discard Run</button>
```

### Ghost

```html
<button class="button button-ghost">Cancel</button>
```

### Icon only

```html
<button class="button button-icon" aria-label="More actions">…</button>
```

Every state is rendered together in the site page's state matrix. The `.is-hover`,
`.is-focus`, `.is-active` and `.is-disabled` helpers are **documentation scaffolding
only** — production code uses the real pseudo-classes.

## DO / DON'T

- **DO** Keep exactly one primary per view — two primaries mean the product has not decided what the user should do.
- **DO** Name the object on a destructive action — "Discard" alone is a question, "Discard Run" is an answer.
- **DO** Keep destructive out of the thumb arc beside primary — one mis-tap on a train should not throw work away.
- **DON'T** Fill a destructive button — it becomes the most inviting target on screen.
- **DON'T** Use `.button-sm` as the only action on a touch surface — 36px is below the 44px minimum.
- **DON'T** Ship the `.is-*` state helpers in production — they are documentation scaffolding; use the real pseudo-classes.
