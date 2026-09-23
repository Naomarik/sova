# Select & combobox

## Purpose

A closed list and a searchable one. Options are 44px targets too — a menu is not somewhere to save vertical space, because the whole point of opening it is to hit one item.

Rendered: `site/components/select.html#select`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.select` | Base — 44px, native select | Appearance reset |
| `.select-wrap` | Positioning context | Holds the caret |
| `.select-caret` | Non-interactive chevron | `pointer-events:none` |
| `.combobox-list` | Floating option list | `--shadow-2` |
| `.combobox-option` | 44px option row | Tinted when selected |

## Tokens used

- `--control-md` — 44px for both the control and each option.
- `--color-accent-tint` — Selected option background.
- `--shadow-2` — List elevation.

## Variants & states

### Select

```html
<div class="select-wrap">
  <select class="select"><option>main</option></select>
  <span class="select-caret">▾</span>
</div>
```

### Combobox option

```html
<li class="combobox-option" aria-selected="true">src/api/runs.ts</li>
```


## DO / DON'T

- **DO** Keep options at 44px — a 28px option is a mis-tap waiting to happen.
- **DO** Use a native `<select>` when the list is short and closed — it gets the platform picker on a phone for free.
- **DO** Mark the active option with `aria-selected` — the tint is not announced; the attribute is.
- **DON'T** Use a combobox for two options — that is a radio pair or a switch.
- **DON'T** Let the list exceed the viewport — cap it and scroll inside the list.
- **DON'T** Rely on the caret to signal interactivity — the 3:1 border does that work.
