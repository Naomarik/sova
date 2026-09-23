# Radius

## Purpose

Seven steps, assigned by element rather than by taste. The load-bearing rule: status is round, actions are not — shape alone tells you what's clickable, before color does.

Rendered: `site/foundations/radius.html#spec`

## Styles

| Class | Role | Notes |
|---|---|---|
| `—` | Radius is applied by component, not by utility | No `.radius-*` helpers exist, on purpose |

## Tokens used

- `--r-xs` — Focus ring, checkbox.
- `--r-sm` — Code block, diff hunk.
- `--r-md` — Button, input, select.
- `--r-lg` — Card, panel.
- `--r-xl` — Sheet, modal, drawer.
- `--r-full` — Chip, badge, avatar.

## Scale & spec

| Token | Value | Assigned to | Why |
|---|---|---|---|
| `--r-none` | `0` | Full-bleed regions | Nothing that meets a screen edge is rounded |
| `--r-xs` | `4px` | Focus ring, checkbox | 8px on a 16px box is a circle, which means "radio" |
| `--r-sm` | `6px` | Code block, diff hunk | Round corners fight a monospace grid |
| `--r-md` | `8px` | Button, input, select | 4px disappears on a 44px control |
| `--r-lg` | `12px` | Card, panel | One step above its contents, so nesting reads as nesting |
| `--r-xl` | `16px` | Sheet, modal, drawer | Reads as a surface arriving, not a card growing |
| `--r-full` | `999px` | Chip, badge, avatar | Status is round; actions are not |

**Radius is assigned by element, never by taste,** and there are no `.radius-*` utilities: a component takes its radius from this table, so shape alone tells a reader what is clickable before color does.

## DO / DON'T

- **DO** Keep chips fully round and buttons at 8px — the shape difference is what separates state from action at a glance.
- **DO** Give a card one step more radius than its contents — nesting then reads as nesting.
- **DO** Use `--r-sm` around monospace blocks — round corners fight a monospace grid.
- **DON'T** Round a button to a pill — it becomes indistinguishable from a status chip, and pills eat width at folded sizes.
- **DON'T** Use `--r-lg` on a 16px checkbox — at that size it is a circle, which means "radio".
- **DON'T** Add an eighth radius step — seven already covers every element in the inventory.
