# Radius

## Purpose

Seven steps, assigned by element rather than by taste. The load-bearing rule: status is round, actions are not — shape alone tells you what's clickable, before color does.

Rendered: `site/foundations/radius.html`

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

## DO / DON'T

- **DO** Keep chips fully round and buttons at 8px — the shape difference is what separates state from action at a glance.
- **DO** Give a card one step more radius than its contents — nesting then reads as nesting.
- **DO** Use `--r-sm` around monospace blocks — round corners fight a monospace grid.
- **DON'T** Round a button to a pill — it becomes indistinguishable from a status chip, and pills eat width at folded sizes.
- **DON'T** Use `--r-lg` on a 16px checkbox — at that size it is a circle, which means "radio".
- **DON'T** Add an eighth radius step — seven already covers every element in the inventory.
