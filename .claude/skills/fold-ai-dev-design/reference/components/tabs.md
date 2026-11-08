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
  <button class="tab tab-active" role="tab" id="tab-queue" aria-selected="true" aria-controls="panel" tabindex="0">Queue</button>
  <button class="tab" role="tab" id="tab-runs" aria-selected="false" tabindex="-1">Runs</button>
</div>
<div role="tabpanel" id="panel" tabindex="0">2 runs working. Nothing queued.</div>
```


## DO / DON'T

- **DO** Put the active tab in the URL — `?tab=chats` survives reload and can be shared.
- **DO** Use `role="tab"` and `aria-selected` — the underline alone is invisible to a screen reader.
- **DO** Let the strip scroll horizontally — truncating tab labels hides what the tabs are.
- **DO** Leave the edge fade to `.tabs` — an edge fades only while tabs are hidden past it, with no script. It is the one sanctioned exception to "No gradients": an alpha mask that fades content at an overflowing edge and paints no color.
- **DO** Give a panel with nothing focusable `tabindex="0"` — Tab from the strip then reaches what the empty tab says.
- **DON'T** Use tabs to submit or act — tabs change what you see, never what exists.
- **DON'T** Nest tab strips — the second level is a segmented control or a filter.
- **DON'T** Ship more than about five tabs — beyond that it is navigation, not a view switch.
- **DON'T** Set a heading just above the strip louder than its tabs — it reads as the strip's title, not a section beside it.
