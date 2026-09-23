# The brand contract: `.sova/marketing/brand.json`

`brand.json` is the one hand-edited source of brand truth in a project. Everything else under
`.sova/marketing/` that the generator writes — `BRAND.md` and the six playbooks — is rendered
from it and replaced on the next run. To change the brand, edit this file and re-run the
generator, never its output.

`scripts/generate.mjs` validates every field below before it writes anything. It rejects a
missing required field, a wrong type, an empty string and an **unknown key** (a typo is an
error, not an extra), and it names each one by its path, e.g. `visual.palette.dark.ink`. It
renders nothing from a brand that fails. A field marked *optional* may be left out; when it is
present, it is checked like any other.

Validate without writing:

```sh
node <this playbook's dir>/scripts/generate.mjs --project <project root> --validate
```

A complete, valid example is `example.brand.json` beside this file. It describes a fictional
project; don't copy its words, copy its shape.

## Fields

"Line" means one line of text: no line breaks, not empty. "Text" may be longer but is still
one paragraph in JSON (write `\n` only where a break is meant). Lists must not contain empty
strings or duplicates.

### Identity

| Field | Type | Rule |
|---|---|---|
| `version` | number | Always `1`. |
| `name` | line | The name as it appears in a sentence: `Kestrel`. At most 40 characters. |
| `wordmark` | line | The lockup's exact casing: `kestrel`. Same letters as `name`, ignoring case and spaces; only the casing may differ. |
| `oneLiner` | line | What it does, in one sentence, at most 120 characters. No exclamation mark. |
| `paragraph` | text | What it is, how it works, where it runs, and its main limit. 40 to 120 words. |
| `audience` | text | Who it is for: what they already use and know, and what they need to be told. |
| `notThis` | list of lines, 1+ | What it is not, each a sentence: `Not a hosted service.` Write the ones a reader might assume. |
| `language` | line | BCP 47 locale for all prose: `en-GB`, `en-US`, `pt-BR`. Spelling follows it. |

### Voice

| Field | Type | Rule |
|---|---|---|
| `voice.pillars` | list of 3–5 objects | Each `{ "name", "means", "prevents" }`, all lines. `means` is what the pillar requires of prose; `prevents` is the failure it rules out, quoted if possible. |
| `voice.use` | list of lines, 3+ | Words to reach for: the project's own nouns. |
| `voice.avoid` | list of lines, 3+ | Words never to use. A word may not be in both lists. |
| `voice.rules` | list of lines, 0+ | Any other rule, one sentence each: `Digits, always: "3 targets", not "three targets".` |

The generated playbooks add three rules no brand may drop: no superlatives, no exclamation
marks in prose, and no claim the code at a named revision does not support.

### Visual direction

The intent the design system implements, plus the few values a script needs to render a logo
sheet or a site without guessing.

| Field | Type | Rule |
|---|---|---|
| `visual.colorway` | text | The color intent in words: how many accents, where the accent is spent, dark or light by default. |
| `visual.typography` | text | The type intent in words: families, weights, what the wordmark is set in. |
| `visual.defaultTheme` | `dark`, `light` or `system` | The theme a reader sees first. `system` follows `prefers-color-scheme`. Required: a front end has a default, and silence is not an answer. |
| `visual.palette.light` | object | `{ "bg", "ink", "muted", "accent", "accentInk" }`, each `#rrggbb`: page background, body text, secondary text, the one saturated color, and the ink that sits **on** the accent (the primary action's label). |
| `visual.palette.dark` | object | The same five keys for the dark theme. |
| `visual.fonts.sans` | line | CSS family name of the text face: `Inter`. |
| `visual.fonts.mono` | line | CSS family name of the code face: `JetBrains Mono`. |
| `visual.fonts.files` | list | Local font files, each `{ "family", "file", "weight" }`. `file` is a path relative to the project root ending in `.woff2`, `.woff`, `.ttf` or `.otf`, and must exist. `family` must be `fonts.sans` or `fonts.mono`. `weight` is a line: `400`, or a variable range `100 900`. `[]` means system fonts; nothing is ever fetched from a CDN. |
| `visual.weights` | list of weights, 1+ — *optional* | The weights the system allows, each a three-digit line: `["400", "530", "600", "640"]`. Leave it out if the system doesn't restrict them. |
| `visual.wordmark` | object — *optional* | `{ "weight", "tracking" }`, both required when it is present: `weight` a three-digit line (`"640"`), `tracking` a line (`"-0.03em"`). Left out, renderers use 640 and `-0.03em` **and say those are defaults**, never the brand's decision. |
| `visual.designSystem` | line or `null` | Path, relative to the project root, of the project's existing tokens or design-system entry point, if it has one. Must exist. The site and logo sheet use it before `palette`. When it names a file, every palette hex must appear in it (below). |
| `visual.designSystemRefs` | list of paths, 1+ — *optional* | The rest of the design system when one path can't name it: a skill folder, a deviations document. Each is relative to the project root and must exist (a file or a folder). Prose references; nothing is checked against them. |

The accent is set per theme because it is used as text (links) and as a fill behind text (the
primary action), and one value can't do both on a near-white and a near-black background: 4.5:1
on both needs a relative luminance at most 0.18 for the first and at least 0.21 for the second.
Keep the two accents the same hue. `accentInk` is set per theme for the same reason: white may
read on the light theme's accent and fail on the dark theme's lighter one. The generator prints
each theme's contrast ratios (ink, muted and accent on `bg`, and `accentInk` on `accent`) and
warns below 4.5:1; the site check fails on them.

**The palette is not a second source of truth.** When `visual.designSystem` names a file, each of
the ten palette values (`bg`, `ink`, `muted`, `accent` and `accentInk` in both themes) must
appear in that file literally, ignoring case. One that doesn't is an error naming the field and
the hex, e.g. `visual.palette.dark.accent: #8E88FE does not appear in src/design/tokens.css`.
Change the design system first, then copy the value here. When `visual.designSystem` names a
folder, nothing can be read to compare, so the generator prints a `note:` saying the palette was
not cross-checked.

### The mark

| Field | Type | Rule |
|---|---|---|
| `mark` | object or `null` | `null` until a logo is chosen. Then `{ "file", "name", "chosen" }`: `file` is any `.svg` in the project, relative to its root, and must exist (a mark the project already ships is named where it is, not copied); `name` is the concept's name, a line; `chosen` is the date, `YYYY-MM-DD`. The **Design the logo** playbook writes this. |
| `mark.variants` | list, 1+ — *optional* | The fixed-color copies a README or a marketplace needs, where `currentColor` has no text color to inherit. Each `{ "file", "theme" }`: `file` an existing `.svg` in the project, no file twice; `theme` is `light` (drawn for a light background), `dark` (for a dark background) or `mono` (one color). Leave it out if there are none. |

### Running it

| Field | Type | Rule |
|---|---|---|
| `project.repo` | URL or `null` | The public repository, `https://…`. `null` if it has none. |
| `project.install` | line | The command that installs it from a fresh clone, run from the project root. |
| `project.run` | line, or list of lines 1+ | The command that starts it for a demo, run from the project root. A list when it takes more than one process, one command per entry, each in its own terminal: `["npm run dev:server", "npm run dev:web"]`. Never join them with `&`. |
| `project.demoUrl` | URL | Where the running demo is opened: `http://localhost:4817/`. Must be `http:` or `https:`. Use a port you chose and checked is free — never one the reader's machine may already be serving (`.sova/marketing/TOOLS.md` states the rule). |
| `project.demoNotes` | text | What a demo needs that the install and run commands don't give: seed data, a login, a flag, which process listens where. `""` if nothing. |

### Social

| Field | Type | Rule |
|---|---|---|
| `social.audience` | text | Who the posts are for and where they already read. |
| `social.platforms` | list, 0+ | Any of `bluesky`, `mastodon`, `x`, `linkedin`, `hn`, `reddit`. The **Write announcement posts** playbook states each one's limits. `[]` means not decided yet: every playbook that reads it asks the user which, and never guesses. |

### Facts the site needs

| Field | Type | Rule |
|---|---|---|
| `facts.licence` | line | The key is spelled `licence`. SPDX identifier (`MIT`, `Apache-2.0`, `GPL-3.0-only`) or `UNLICENSED`. |
| `facts.hosting` | line | Where the site will be published, or `Not decided`. |
| `facts.siteUrl` | URL or `null` | The site's public URL once it has one. Its path becomes the site's base path (`https://example.github.io/kestrel/` → `/kestrel/`). |

## What is not in it

No feature list, no claims, no taglines beyond `oneLiner`, no release dates. Features come
from the code at a named revision (the **Rewrite the README** playbook records them in
`.sova/marketing/claims.md`); a feature list here would be a second, unverified copy.
