# Provenance

First-party: written for Sova on 2026-09-23. It isn't copied from anywhere. It is maintained here,
and this copy is the authority. Contrast `playbooks/brandmaker/`, which is vendored from rakiba
and records its source and commit in its own `PROVENANCE.md`.

What it draws on, all in this repository:

- **Structure:** `playbooks/brandmaker/PLAYBOOK.md`. That means one entry file that names which
  sibling file to read at which step, an interview of a few questions at a time with
  recommended defaults, and the agent deciding details while the user decides direction.
- **Content rules:** `ai/branding/`. The claim ladder and "name the revision" come from
  `truth-sources.md`; the four pillars and the words discipline from `voice.md`; the site rules
  (static, no CDN, no more than the README, checked at folded and desktop widths in both
  themes) from `playbooks/derive-website.md`; and the README's shape from
  `playbooks/readme-update.md`. These are generalised: no Sova paths, names or counts
  survive in the templates.
- **The logo pipeline:** `ai/branding/logos/` (`build.py`, `render.mjs`, and `round-2/*/check.mjs`),
  with the same shape of SVG candidates, a self-contained comparison sheet and a CDP check, but
  the constants (paths, the 4-candidate count, the 32 grid, Sova's colors) are read from the
  round's `candidates.json` and the project's `brand.json`.
- **The browser:** `.claude/skills/playwright/`. The generated scripts borrow its Playwright
  install (recorded per machine in `.sova/marketing/local.json`) rather than adding one to the
  project.

Where it departs from those sources on purpose:

- `derive-website.md` says "no framework, no build step beyond copying". This playbook's site is
  an Astro project, as decided for the marketing system. What that rule protected, it keeps:
  static output, nothing remote, no client framework. Astro lives only in the generated site's
  own `package.json`.
- The palette has an accent per theme, not one accent. One value can't reach 4.5:1 as link text
  on both a near-white and a near-black background (see `brand.md`).
