---
title: Themes
description: Light, Dark or Auto, a dark theme and a light theme of your choice, a theme of your own as one JSON file, and the fonts and text size this browser shows.
group: Features
order: 18
---

Settings → Themes sets how Sova looks in this browser. Everything on it applies as you pick, with no
Save and no reload.

## Light, Dark or Auto

At the top, **Appearance** offers **Light**, **Dark** and **Auto**. Light always shows your light
theme and Dark your dark theme. Auto shows the light one while your device's system setting is light
and the dark one while it is dark (no preference counts as dark), and switches the moment that
setting changes.

## Pick a dark theme and a light theme

Below it, every theme Sova can find, the ones it ships and the ones you add, is split into two lists
of cards: **Dark theme** first, then **Light theme**. The order never changes, whatever the mode. Each
list's heading says when it shows: **Showing now**, or when it will, such as "Shows in Light mode" or
"Shows while your system is light".

The checked card in each list is that list's pick. Picking in the list that's showing changes the
window at once. Picking in the other list changes nothing on screen until that list shows; switch
Appearance to see it. Arrow keys move the choice within a list.

Your mode and both picks are kept in this browser, and the page puts the right theme on before it
first draws, so a reload never flashes the other one. Another open tab follows a change at once.

A browser with nothing saved starts in Dark, with the built-in Dark and Light picked. A theme picked
before this release becomes the pick of its own list, and the mode is set to match, so the window
looks as it did.

## A theme of your own

A theme is one JSON file in `~/.pi/agent/sova/themes/`. Save one and it appears in its list within a
couple of seconds while the tab is open, or press **Refresh**. No rebuild, no restart.

```json
{
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": {
    "accent": "$amber",
    "accent-tint": "#3a2f1c"
  }
}
```

`extends` names its base, `dark` or `light`, which fills in every colour the file leaves out and
decides which list it goes in. `vars` are names you can use as `$name` in `colors`.

**A file Sova can't use stays in the list**, as a disabled card with its filename and the reason. A
file that doesn't parse shows the parser's own message, which names where it stopped. A value Sova
won't use names the key, the value and the forms it takes: a hex value, or one call to `rgb`,
`rgba`, `hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `color-mix` or `color`.

**When a pick goes away.** If the file you picked is deleted, renamed, can't be read, or now names the
other base, that list goes back to its built-in theme, and a notice names the theme, the list and why.
The other list keeps its pick.

## Fonts and text size

Under the two lists are the fonts this browser puts over whichever theme is on:

- **Text**, for the sidebar, messages and headings: Inter, Source Sans 3, Atkinson Hyperlegible Next,
  IBM Plex Sans or Noto Sans.
- **Code**, for paths, diffs and code blocks: JetBrains Mono, Fira Code, IBM Plex Mono or Source Code
  Pro.

Each starts on **Theme default**, the theme's own fonts. Every font is bundled with Sova, so it works
offline and on a phone. **Use Theme Fonts** takes both picks off.

**Text size** is Small, Medium or Large, Medium by default, and scales every size on the page. Fonts
and text size stay the same across theme switches, Auto's included, and another open tab follows a
change at once.

## Back to the default

Open Sova with `?theme=default` on its address to reset this browser: Dark mode, the built-in Dark
and Light picks, the theme's own fonts and Medium text. A theme too dark to read never shows first,
and the parameter comes off the address straight after.
