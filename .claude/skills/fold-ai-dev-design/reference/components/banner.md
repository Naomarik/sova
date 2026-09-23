# Banner

## Purpose

An in-flow, persistent statement of fact. A banner carries the fact itself — unlike a toast, which is allowed to disappear because the fact lives somewhere else.

Rendered: `site/components/banner.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.banner` | Base — 12px radius, in flow | Border by default |
| `.banner-icon` | Leading glyph | Takes the status color |
| `.banner-title` | Semibold first line | The fact |
| `.banner-body` | Muted second line | The consequence |
| `.banner-success|warn|error|info` | Soft background | Border becomes transparent |

## Tokens used

- `--status-*-bg` — Soft fill per status.
- `--status-*` — Icon color.
- `--r-lg` — 12px corner.

## Variants & states

### Error banner

```html
<div class="banner banner-error">
  <span class="banner-icon">×</span>
  <div>
    <p class="banner-title">This run failed at step 4 and stopped.</p>
    <p class="banner-body">Nothing was merged. Retry or discard it.</p>
  </div>
</div>
```


## DO / DON'T

- **DO** Lead with what happened, follow with what it means — the second line is where the user finds their next move.
- **DO** Say what was *not* affected on a failure — "Nothing was merged" is the sentence that lowers a pulse.
- **DO** Keep banners in the flow — a floating banner is a toast with commitment issues.
- **DON'T** Use a banner for a transient confirmation — that is a toast.
- **DON'T** Stack more than two banners — past two, none of them get read.
- **DON'T** Add an exclamation mark — the color already carries the urgency.
