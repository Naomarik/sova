# Playbook: derive a small website

> Part of [Sova branding](../overview.md). For the day someone wants a page for Sova that
> isn't the README. There is no such page today and nothing here commits anyone to one.

## What the site is for

A pi user found the repo and wants to know in 30 seconds whether to clone it. That's the whole
job. It is not a landing page for a service, so it has no sign-up, no pricing, no testimonials,
no "get started free". It has what the README's first paragraph has, with room to show it.

## Source order

Derive, don't write from scratch. Each page pulls from a source in this order and links back.

| Page | Source | What it adds |
|---|---|---|
| Home | `README.md` opening paragraph, [identity.md](../identity.md) | One screenshot of the real app, both themes. The one-line and the one-paragraph, verbatim. |
| Setup | `README.md` Fresh machine setup, Running | Nothing. Copy the commands; link the README for the rest. |
| Themes | `README.md` Themes | Swatches of the 18 shipped themes rendered from `themes/*.json`, so they can't drift. |
| Extensions | `pi-config/README.md` and the extension READMEs | A one-line index. Each line links to its README. |
| About | [identity.md](../identity.md), [naming.md](../naming.md) | What it isn't. The firewall sentence. |

No features page. A features page is the brittle table [truth-sources.md](../truth-sources.md)
warns about. If a feature deserves a page, write it with
[explain-feature.md](explain-feature.md) and give it a page of its own with a verified-at note.

## Visual system

The site is the product's design system, not a separate one. Link `tokens.css` and `base.css`
from `src/design/` (or the skill's `tokens.css` and `fold-ai-dev.css`) and use their classes.
Dark by default with the light set complete, as the app. Inter and JetBrains Mono from
`public/fonts/`, served with the site, no CDN. The mark is the chosen one,
`public/icons/sova-mark.svg` (Astra's Fold). Its source and the lockup are under
`logos/selected/` and `logos/round-2/astra/`.

Everything the skill forbids stays forbidden on the site: no gradients, no blur, no decorative
accent, no hero animation. The one saturated color is for links and the one primary action on
each page, which on this site is probably "Clone" or "Read the README".

## Voice

[voice.md](../voice.md), with one extra rule: the site may not claim more than the README.
Every sentence on the site should be findable in the README, the spec with a verified-at note, or
this folder. If the site knows something the README doesn't, fix the README first.

## Build

Static files. No framework, no build step beyond copying, no analytics, no fonts fetched. A
`site/` directory anywhere the owner chooses; not inside `ai/branding/`. Render it with the
Playwright skill at folded (475) and unfolded (933) widths in both themes before publishing,
and read the skill's `SKILL.md` first: resize after navigate, and assert the width.

## Before it goes up

- Every command on the Setup page was run on a fresh clone at the revision the footer names.
- The screenshot on Home is of the app at that revision, not a mockup.
- Every page has the same footer: the revision, the date, and a link to the repo
  ([Naomarik/sova](https://github.com/Naomarik/sova)).
- Nothing on the site says "team", "cloud", "hosted", "sign in", or "plan".
