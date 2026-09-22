# Naming

> Part of [Sova branding](overview.md). The name is decided: **Sova**. This page is the decision
> record — the expansion, the chosen mark, what a rename touches, and how far it has gone.

## The decision

**Sova.** *Sessions, Orchestration, Viewing & Agents.* Four letters, said in most languages,
and it names what the product mostly does: watch a set of sessions, in parallel, from one window.
A short made-up word that also reads as a plain noun. The earlier note reached for an owl (the
word is "owl" in several Slavic languages) because watching was the through-line; the expansion
keeps the same through-line without hanging the brand on a mascot.

The rejected candidate was **TAVI**, a made-up word with no meaning to carry. It read as a name
rather than a noun, and the branch/ligature metaphors on the table were good — but it needed a
mark and a sentence next to it for a year, and Sova's own letters could carry a monogram without
one. TAVI stays in the exploration sheets as history, not as a live option.

**The mark is Astra's Fold**, drawn in round 2: one stroked path, a V and an A sharing a stem,
with the A's crossbar as the only added move. The source is
[`logos/round-2/astra/sova-fold.svg`](logos/round-2/astra/sova-fold.svg); the shipped copy is
`public/icons/sova-mark.svg` and is byte-identical. It survives 16px, which is the test it was
drawn to pass. The selected lockup is rendered at
[`logos/selected/sova-fold.html`](logos/selected/sova-fold.html).

The wordmark is set **lowercase**, `sova`, in Inter 640 at −0.03em, and that is what the app's
brand element renders (`src/components/Sidebar.tsx`). Running prose capitalizes the name: **Sova**.

## What a rename touches, and how far it has gone

This table is the ledger. "Done" means the new name is on disk and can be checked. The rename
completed on 2026-09-22: every row below is done, and the `pi-web` spellings that remain are
read-compatibility for data written before it, not places the old name is still the true one.

| Place | Before | Now |
|---|---|---|
| Package | `pi-web` in `package.json`, `package-lock.json` | `sova` — **done** |
| Repository | GitHub `Naomarik/pi-web` | [Naomarik/sova](https://github.com/Naomarik/sova) — **done** |
| Page title, manifest, PWA name | `pi-web` in `index.html`, `public/manifest.webmanifest` | `sova` — **done** |
| Brand element and mark | `.brand` wordmark, `public/icons/pi-web-mark.svg` | `sova` + `public/icons/sova-mark.svg` (Astra Fold) — **done**; the old mark is left on disk |
| Worktree path | `~/webapps/pi-web` | `~/webapps/sova` — **done** (2026-09-22). `~/.pi/agent/settings.json`, `models.json`, `keybindings.json` and `vision-delegate.json` are absolute symlinks into the worktree, so `pi-config/install.sh` was re-run after the move (`--check` passes). Session cwds recorded under the old path are mapped at open/list time by `<state root>/path-map.json`. |
| Persistent state | `localStorage` keys `pi-web:theme` and `pi-web:typography` (and the `pi-web:archive-*`, `pi-web:group-view-*`, `pi-web:folder-open-*`, `pi-web:recent-count` keys); the directory `~/.pi/agent/pi-web/` | `sova:*` and `~/.pi/agent/sova/` — **done**. The directory was MOVED (atomic rename, backup kept) and is read at the new root only; the keys write `sova:*` while reading and mirroring the legacy ones. Absolute `pi-web/` paths embedded in transcripts still resolve via `unlegacyStatePath`. |
| Theme schema | `"$schema": "pi-web-theme/v1"` in every `themes/*.json` and in `shared/theme.ts` | Reader **done**: `shared/theme.ts` accepts `sova-theme/v1` and the legacy `pi-web-theme/v1`. The shipped `themes/*.json` still carry the old id, as do user themes on disk — cosmetic, both load. |
| Session markers | `customType: "pi-web-rewind"`, `"pi-web-fanout-member"` | **Not renamed**: they are written into existing transcripts, so the old id stays readable. |
| Prose | `README.md`, `CLAUDE.md`, `spec/*.md` | **Sova** — this rebrand. |
| `pi-config/` extension READMEs | e.g. the mirror and `pi-web` mentions | **Done**: the app is called Sova in that prose, and the state paths name `sova/`. What is left is deliberate — the `npm:pi-web-access` package name, and the legacy spellings the compat notes point at. |

The state keys and the directory were the costly rows, because a rename that changed them without
a migration would have lost the theme choice, the dropped-in themes and the archive. That is why
the directory was moved rather than re-pointed, and why the keys read the old spelling and write
the new one. The remaining `pi-web` strings are load-bearing for data already on disk: removing one
orphans it.

## What doesn't change

Whichever surface is mid-move, these hold:

- The wordmark is `sova` in Inter 640 at the tracking in `--ls-wordmark`, per the design skill's
  Logo section and [`spec/07-deviations.md`](../../spec/07-deviations.md). No other face.
- The mark is `currentColor`, one color, drawn on the system's grid, legible at 16px. It takes
  the accent in the sidebar head; the word never does. Clear space is one panel width; minimum
  size 16px for the mark.
- The product is still "a local web app for pi", and the README's first sentence still says so.
- "pi" stays lowercase and is never part of the name. The agent belongs to someone else.

## The exploration history

Twelve candidate marks were drawn in round 1 (four each by Astra, Fable and K3) and twelve more in
round 2, half for Sova and half for the rejected TAVI. They stay as drawn, under `logos/`, because
they record how the Fold was chosen and what was rejected. Compare them side by side before
reopening the decision; don't average them.
