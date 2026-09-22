# Bundled fonts

Every face pi-web can wear is shipped here, served same-origin from `/fonts/`, and declared in
`src/design/tokens.css`. Nothing is fetched from a CDN at runtime: a `@font-face` is only
downloaded by the browser when a rule actually uses that family, so the faces a user never
picks cost nothing on the wire. All files are the **latin subset**, like the two originals, and
all are licensed under the SIL Open Font License 1.1 — the full text of each family's license is
in `licenses/`.

Inter and JetBrains Mono are the defaults (`--font-body`, `--font-display`, `--font-mono`) and
are unchanged. The other seven are the closed catalogue behind Settings → Themes → Typography
(`src/lib/typography.ts`).

| File | Family | Weights | Bytes | License | Source (fetched 2026-09-22) |
|---|---|---|---|---|---|
| `Inter-Variable.woff2` | Inter | variable 100–900 | 48256 | OFL 1.1 (`licenses/inter-OFL.txt`) | copied from the fold-ai-dev design skill `fonts/` (Inter Project, github.com/rsms/inter) |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono | variable 100–800 | 40404 | OFL 1.1 (`licenses/jetbrainsmono-OFL.txt`) | copied from the fold-ai-dev design skill `fonts/` (JetBrains) |
| `SourceSans3-Variable.woff2` | Source Sans 3 | variable 200–900 | 28740 | OFL 1.1 (`licenses/sourcesans3-OFL.txt`) | Google Fonts, `sourcesans3/v19` — https://fonts.gstatic.com/s/sourcesans3/v19/nwpStKy2OAdR1K-IwhWudF-R3w8aZQ.woff2 |
| `AtkinsonHyperlegibleNext-Variable.woff2` | Atkinson Hyperlegible Next | variable 200–800 | 33996 | OFL 1.1 (`licenses/atkinsonhyperlegiblenext-OFL.txt`) | Google Fonts, `atkinsonhyperlegiblenext/v7` — https://fonts.gstatic.com/s/atkinsonhyperlegiblenext/v7/NaPNcYPdHfdVxJw0IfIP0lvYFqijb-UxCtm5_wdGseiJn3o.woff2 |
| `IBMPlexSans-Variable.woff2` | IBM Plex Sans | variable 100–700 | 45712 | OFL 1.1 (`licenses/ibmplexsans-OFL.txt`) | Google Fonts, `ibmplexsans/v23` — https://fonts.gstatic.com/s/ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxeKYY.woff2 |
| `NotoSans-Variable.woff2` | Noto Sans | variable 100–900 | 35820 | OFL 1.1 (`licenses/notosans-OFL.txt`) | Google Fonts, `notosans/v42` — https://fonts.gstatic.com/s/notosans/v42/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5a7duw.woff2 |
| `FiraCode-Variable.woff2` | Fira Code | variable 300–700 | 36276 | OFL 1.1 (`licenses/firacode-OFL.txt`) | Google Fonts, `firacode/v27` — https://fonts.gstatic.com/s/firacode/v27/uU9NCBsR6Z2vfE9aq3bh3dSD.woff2 |
| `IBMPlexMono-400.woff2` | IBM Plex Mono | static 400 | 14708 | OFL 1.1 (`licenses/ibmplexmono-OFL.txt`) | Google Fonts, `ibmplexmono/v20` — https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2 |
| `IBMPlexMono-500.woff2` | IBM Plex Mono | static 500 | 14888 | same | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2 |
| `IBMPlexMono-600.woff2` | IBM Plex Mono | static 600 | 15620 | same | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2 |
| `IBMPlexMono-700.woff2` | IBM Plex Mono | static 700 | 14908 | same | https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3pQPwlBFgg.woff2 |

The Google Fonts files were taken from the `/* latin */` block of the CSS API
(`https://fonts.googleapis.com/css2?family=<family>:wght@<range>`), which is the same asset
Google serves to browsers; the license texts are the `OFL.txt` of each family in
github.com/google/fonts (`ofl/<family>/OFL.txt`). Axes and weight classes were verified with
fontTools after download (`fvar` present on every `-Variable` file).

## Weights

The type scale uses four weights: 400, 530, 600 and 640 (`--fw-*` in `tokens.css`). Every
variable file above covers all four exactly. **IBM Plex Mono is the one static family**, so the
browser's font-matching picks the nearest declared face: 530 renders as 600 (SemiBold) and 640
as 700 (Bold) — one step heavier in the medium and display slots. No other family has this
approximation.
