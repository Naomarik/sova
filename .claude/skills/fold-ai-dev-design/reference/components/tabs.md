# Tabs

## Purpose

Tabs switch views; they never submit. And the active tab belongs in the address — a view you cannot link to or reload back into is a view the user will lose.

Rendered: `site/components/tabs.html#anatomy`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.tabs` | Scrolling tab strip | Bottom border |
| `.tab` | 44px tab | Transparent bottom border |
| `.tab-active` | Accent underline | Pair with `aria-selected="true"` |

## Tokens used

- `--tap-min` — 44px tab height.
- `--color-accent` — Active underline.
- `--stroke-icon` — 1.5px underline weight.

## Variants & states

### Tabs

```html
<div class="tabs" role="tablist">
  <button class="tab tab-active" role="tab" aria-selected="true">Queue</button>
  <button class="tab" role="tab" aria-selected="false">Runs</button>
</div>
```


## DO / DON'T

- **DO** Put the active tab in the URL — `?tab=chats` survives reload and can be shared.
- **DO** Use `role="tab"` and `aria-selected` — the underline alone is invisible to a screen reader.
- **DO** Let the strip scroll horizontally — truncating tab labels hides what the tabs are.
- **DON'T** Use tabs to submit or act — tabs change what you see, never what exists.
- **DON'T** Nest tab strips — the second level is a segmented control or a filter.
- **DON'T** Ship more than about five tabs — beyond that it is navigation, not a view switch.
