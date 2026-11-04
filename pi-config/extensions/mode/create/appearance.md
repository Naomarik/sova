# appearance: colours, type and how this browser shows Sova

<!-- Every fact checked against the code at 5d3c54e96. Browser preferences stay Screen: no card reaches them. -->
Recommend a custom theme when the person wants their own colours, and name the screen for everything else. Sova's own stylesheets aren't yours to change: a theme reaches the same colours and type.

## Custom themes

- Change: a theme of the person's own: colours, shadows and type.
- Lives: `<agent dir>/sova/themes/<id>.json`. The file name is the theme's id: letters, digits, dots, dashes and underscores, up to 64 characters, starting with a letter or digit. An id Sova already uses replaces that built-in, so pick a new one.
- Approves: the person, by their OK on the whole file.
- By: OK. Show the path and the whole theme first. With sync on, say first that the file reaches their other computers.
- Live: within 2 seconds in an open Settings → Themes, and now once picked there. It shows only in a browser that picks it.
- Check: it's listed in Settings → Themes. A bad value shows there on its row with the reason, and isn't applied.

```json
{
  "$schema": "sova-theme/v1",
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": {
    "accent": "$amber",
    "accent-hover": "#ffc46e",
    "accent-tint": "#3a2f1c"
  }
}
```

`extends` is `dark` or `light`, and anything left out comes from it. A `vars` value is used as `"$name"`, and may name only a var above it. `colors` keys: `bg surface sunken ink ink-2 ink-muted border border-strong accent accent-hover accent-tint on-accent status-success status-warn status-error status-info status-success-bg status-warn-bg status-error-bg status-info-bg diff-add-bg diff-add-ink diff-del-bg diff-del-ink diff-gutter scrim skeleton-sweep shadow-1 shadow-2 shadow-3`. A colour is a hex value or one call to `rgb rgba hsl hsla oklch oklab lab lch color-mix color`, with no nested call and no `var()`. `typography` keys: `font-body font-display font-mono`, then `fs-` and `lh-` for each of `display-xl display-l heading-m heading-s body caption mono micro`, `fw-regular fw-medium fw-semibold fw-display`, and `ls-display ls-heading ls-heading-s ls-wordmark ls-body ls-mono-caps ls-eyebrow`. A theme names fonts already on the computer; it can't bundle one.

## Theme, type and text size for this browser

- Change: which theme this browser wears, its text size, and its font from the list on that tab. The list has only sans-serif and monospaced fonts: for a serif, or any other font, use a custom theme's `font-body` and name a font already on the computer, as in `"typography": { "font-body": "Georgia, serif" }`.
- Lives: this browser's own storage, out of your reach.
- Approves: the person, by making the change.
- By: Screen. Settings → Themes.
- Live: now, in this browser only. Each browser keeps its own.
- Check: the page changes as they pick.

## Sidebar and transcript preferences

- Change: how many sessions Recent shows (3 to 20), compressing thinking and tool calls, and the summary line under titles.
- Lives: this browser's own storage, out of your reach.
- Approves: the person, by making the change.
- By: Screen. Settings → General.
- Live: now, in this browser only.
- Check: the sidebar or the transcript changes as they set it.

## Keyboard shortcuts

- Change: nothing: Sova's browser shortcuts are fixed, and can't be rebound.
- Lives: inside Sova. The palette and the `?` sheet list them.
- Approves: nobody: there's nothing to approve.
- By: None. Say so plainly. There's no nearer way.
- Live: never, today.
- Check: there's nothing to check.
