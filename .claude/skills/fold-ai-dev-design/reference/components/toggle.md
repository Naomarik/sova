# Toggle

## Purpose

Checkbox, radio, and switch, sharing one label row. The label row is the target, not the 18px box — a control you have to aim at is a control that gets missed on a moving train.

Rendered: `site/components/toggle.html#variants`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.toggle` | Label row — 44px target | Wraps a hidden native input |
| `.toggle-box` | 18px visual box | Checkbox by default |
| `.toggle-radio` | Round box | Radio semantics |
| `.toggle-switch` | 40×24 track and knob | Immediate-effect settings |

## Tokens used

- `--tap-min` — 44px row height.
- `--r-xs / --r-full` — Square checkbox / round radio and switch.
- `--color-accent` — Checked fill.
- `--dur-fast` — Knob travel.

## Variants & states

### Checkbox

```html
<label class="toggle">
  <input type="checkbox" checked><span class="toggle-box">✓</span>
  Auto-approve runs that only touch tests
</label>
```

### Switch

```html
<label class="toggle toggle-switch">
  <input type="checkbox" checked><span class="toggle-box"></span>
  Notify me when a run wants a decision
</label>
```


## DO / DON'T

- **DO** Wrap the input in the label — the whole row becomes the target with no extra markup.
- **DO** Use a switch only for settings that apply immediately — a switch that needs a Save button is lying.
- **DO** Keep the native input in the DOM — it carries keyboard and screen-reader behavior for free.
- **DON'T** Replace the native input with a `<div>` — you inherit every accessibility bug you then have to fix.
- **DON'T** Use a switch inside a form that submits — use a checkbox.
- **DON'T** Shrink the row below 44px to fit more settings — a settings list is not where density pays.
