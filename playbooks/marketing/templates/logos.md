---
title: Design the {{name}} logo
description: Starts from the marks you already have, draws new candidates as clean one-colour SVGs, compares them on a self-contained sheet checked in a browser, and records the one you pick, with its fixed-colour copies, in brand.json.
promptHint: Any marks you already have and where they are, the direction you want (a letterform, a symbol, abstract), marks you admire or want to avoid.
---

# Design the {{name}} logo

Start from what the project already has, draw new candidates where needed, compare them side by
side in the brand's colours and type, and pick one with the user over one or more rounds. The
winner is recorded in `brand.json`, and everything generated picks it up from there.

Paths are relative to the project root (see `.sova/marketing/TOOLS.md`). Beside this playbook:
`candidates.example.json` (a round's format), `build-sheet.mjs` (checks the SVGs and builds the
sheet), `check-sheet.mjs` (renders the sheet in your browser and asserts it) and
`make-variants.mjs` (writes the fixed-colour copies of the chosen mark). Read
`.sova/marketing/TOOLS.md` before step 5.

## 1. Existing marks first

A brand often has marks already: a favicon, an app icon, a logo in the README, a folder of
earlier explorations. Don't start from zero, and don't redraw what exists. **Ask the user first:
"Do you already have a logo or mark, or earlier candidates, and where are they?"** While you
wait, look for yourself, because they may not remember every copy:

```sh
git ls-files -co --exclude-standard | grep -iE '\.(svg|png|ico|webp)$' | grep -iE 'logo|mark|brand|icon|favicon|emblem|avatar'
```

Also check `mark` and `mark.variants` in `brand.json`, the first image in the README, the
`icon` fields in the package manifest or web manifest, and the design system
(`visual.designSystem`, `visual.designSystemRefs`). Icon sets (a UI's arrows and buttons) are not
marks; leave them out.

Show the user what you found, with paths, and ask which are marks and whether there are others
outside the project (a design tool export, another repository). Then import each mark the user
confirms into round 1 as a candidate:

- Copy it to `.sova/marketing/assets/logos/round-1/<slug>.svg` and give it a
  `candidates.json` entry with `source` (the original's path, relative to the project root) and
  `changes` (what you changed so it meets the rules in step 3, or `none`). The original stays
  where it is, untouched.
- Make the copy meet the rules **without changing the drawing**: a fixed fill becomes
  `currentColor`, ids go, a missing `xmlns` is added. A square viewBox of another size gets the
  round's grid by wrapping the content in `<g transform="scale(<grid>/<size>)">`.
- A mark that can't meet them without being redrawn (several colours, a gradient, a raster, a
  non-square shape) is not imported. List it for the user with its path and say why. Redraw it
  as a new candidate only if they ask.
- More than 8 marks: ask whether to import all or a shortlist. One sheet holds any number, but a
  shortlist is easier to compare.

If nothing exists, say so and go on to step 2.

## 2. Align

Read `.sova/marketing/BRAND.md`: the name, the wordmark casing, the pillars and the visual
direction are the brief. Then ask the user, a few questions at a time, and wait:

1. **Keep or replace?** If step 1 found marks, is this a choice between them, a refinement of one,
   or a new one?
2. **Direction.** Letterform (the initial or two letters sharing a stroke), symbol (an object
   the product is about), or abstract (a shape that carries a pillar). Recommend one from
   the pillars, and say why.
3. **References.** Marks they admire and marks they don't want to resemble. Ask what they like
   about each; you will not copy any of them.
4. **Constraints.** Where the mark must work: favicon (16px), app icon (the mark on an accent
   tile), README header, social avatar (a circle crop).

Record the answers as a one-sentence `brief` for the round.

## 3. Draw a round

Create `.sova/marketing/assets/logos/round-<n>/` (round 1 holds the imports from step 1, if any)
with `candidates.json` (same shape as `candidates.example.json`) and one `<slug>.svg` per
candidate. Draw **3–4 genuinely different directions** in the first round you draw, not
variations of one idea. Later rounds refine the favourites.

Each SVG, hand-written or imported:

- `viewBox="0 0 <grid> <grid>"` with the round's `grid` (32 is a good default). Use whole or half
  units, so edges land on pixels at 16px and 32px.
- `xmlns="http://www.w3.org/2000/svg"`.
- **A name a screen reader can read**, for when the mark is used on its own: either a `<title>`
  inside the `<svg>` or `role="img" aria-label="…"` on it. Either passes; what is checked is that
  the name exists and isn't empty.
- One colour: `fill="currentColor"` (or `stroke="currentColor"` with `fill="none"`). The host
  sets the colour. No gradients, filters, masks, clip paths, `<use>`, ids, embedded images,
  `<style>` or `url()`. `build-sheet.mjs` rejects all of these, because a mark must be
  inlineable anywhere and must never collide with another inlined mark.
- Strokes and gaps of at least 2 units on a 32 grid, so they stay 1px or more at 16px. Check it
  at 16px on the sheet. A counter that closes up there fails.
- No text in the mark. The wordmark is set beside it in the brand's face at the brand's casing
  (`wordmark` in `brand.json`).

In `candidates.json`, write for each candidate the `idea` (what the shape is and why) and the
`tradeoff` (where it is weak: the 16px read, a resemblance, a crop). A candidate without a stated
weakness hasn't been looked at. `source` and `changes` are for imported marks only, and go
together.

## 4. Build the sheet

```sh
node .sova/marketing/playbooks/logos/build-sheet.mjs --round .sova/marketing/assets/logos/round-<n>
```

It refuses to build if `candidates.json` and the SVG files don't match one for one, if any SVG
breaks a rule above, or if an imported candidate's `source` doesn't exist, and names the file
and the rule. It writes `comparison.html` into the round folder. That file is self-contained: the
marks inlined, the palette from `brand.json` for both themes, the local font files embedded as
`data:` URLs, and `visual.designSystem` inlined if it is a CSS file. Each candidate is shown in
light and dark, at 72px beside the wordmark, at 16, 24 and 32px, in the accent colour, and in
`accentInk` on an `accent` tile (the app icon case).

The lockup's weight and tracking come from `visual.wordmark`, and the sheet's text uses only
`visual.weights` when the brand lists them; the sheet shows the wordmark at each allowed weight.
Where `brand.json` leaves one out, the script uses a stated default (weight 640 and tracking
`-0.03em` for the lockup) and **says so**: in its output (`default: …` lines) and on the sheet's
footer. Pass those lines on to the user; a default is not the brand's decision. It stops if the
lockup's weight is not one of `visual.weights`.

## 5. Check it in a browser

Start your own browser (TOOLS.md), then:

```sh
PW_PORT=<your port> node .sova/marketing/playbooks/logos/check-sheet.mjs --round .sova/marketing/assets/logos/round-<n>
```

It parses each SVG as XML in the browser and asserts exactly 12 marks per candidate, no ids,
masks, clip paths or `<use>`, zero network or file requests, zero page errors, no horizontal
overflow at 1280 or 475 px, the right background and accent tile per theme, the lockup's
computed weight and tracking, and that the wordmark face loaded (when `brand.json` names font
files). It writes `comparison.png`, `comparison-475.png` and `validation.json` into the round
folder, with any defaults listed under `defaults`. Fix every failure.

Then **look at `comparison.png` yourself**, at full size, especially the 16px row. Revise any
candidate you drew that doesn't hold up before showing the user; for an imported one, say what
you see instead of changing it. The check proves the sheet is sound. It can't tell you whether a
mark is any good.

## 6. Choose with the user

Show the user the sheet (`comparison.html` opens from disk; `comparison.png` if they can't open
it). For each candidate give one line of idea and one line of tradeoff, and your recommendation
with a reason. Ask which they prefer and what they'd change. If they want changes, start round
`<n+1>` in a new folder: copy the favourites forward, revise, and draw a fresh alternative if
the round had no clear winner. Never overwrite an earlier round; it records what was tried.

## 7. Record the winner and its fixed-colour copies

1. **The mark.** `mark.file` may be any `.svg` in the project.
   - The winner is a mark the project already ships and its `changes` were `none`: record it
     where it is (its `source`); don't copy it.
   - Otherwise (a new drawing, or an import you had to change): copy the round's SVG to
     `.sova/marketing/assets/logos/<slug>.svg`. The round is history; this is the mark.
2. **The fixed-colour copies.** The mark is `currentColor`, which only works where the host sets
   a colour. A README, a package registry, an `<img>` tag or a social card can't, and shows it
   black. Those surfaces use `mark.variants`:

   ```sh
   node .sova/marketing/playbooks/logos/make-variants.mjs            # add --mono '#rrggbb' for a one-colour copy
   ```

   It reads `mark.file` (or `--mark <file>`), replaces `currentColor` with each theme's `ink`
   (`--colour accent` for the accent instead; ask the user which), and writes
   `<name>-light.svg` (for light backgrounds) and `<name>-dark.svg` (for dark ones) into
   `.sova/marketing/assets/logos/`. It writes a `mono` copy only when you give its colour; there
   is no default for it. It prints the `mark.variants` entries. If the project already ships
   fixed-colour copies of the winner, record those where they are instead.
3. **`brand.json`.** Set:

   ```json
   "mark": {
     "file": "<the mark's path>",
     "name": "<the candidate's name>",
     "chosen": "<YYYY-MM-DD>",
     "variants": [
       { "file": ".sova/marketing/assets/logos/<name>-light.svg", "theme": "light" },
       { "file": ".sova/marketing/assets/logos/<name>-dark.svg", "theme": "dark" }
     ]
   }
   ```

4. Re-run the generator (TOOLS.md). It validates that every file exists, and `BRAND.md` now shows
   the mark. The site picks it up as its favicon and header on the next build.

Tell the user where the mark is used next: the README header (**Rewrite the {{name}} README**,
which uses the variants, never the `currentColor` mark), the site (**Build the {{name}} site
and docs**), and any favicon or app icon in the project itself, which is theirs to wire in. This
is exploration, not a trademark search; say so.
