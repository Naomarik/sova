# Brand files for documents

The app's mark is `public/icons/sova-mark.svg`, drawn in `currentColor` so it takes the color of
the text around it. A README on GitHub has no such text color to inherit, and no theme variable,
so these two files carry the same geometry with a fixed stroke:

| File | Stroke | Use |
| --- | --- | --- |
| `sova-mark-light.svg` | `#4A43D8` — the light theme's accent | On a light background |
| `sova-mark-dark.svg` | `#8E88FF` — the dark theme's accent | On a dark background |

The path is byte-identical to the shipped mark; only the `stroke` attribute differs. A `<picture>`
with `media="(prefers-color-scheme: dark)"` picks between them, which is what `README.md` does.

The wordmark is the word `sova`, lowercase, set in whatever body face the document already uses.
There is no wordmark image and no font to install: the app sets it in Inter 640 at the tracking in
`--ls-wordmark`, and a document that has no Inter should not pretend otherwise.

The name, the decision behind the mark and its misuse rules are in
[`ai/branding/naming.md`](../../ai/branding/naming.md).
