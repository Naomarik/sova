# Local deltas — Sova's skill vs this playbook

The vendored playbook beside this file is a verbatim snapshot (see `PROVENANCE.md`). This file
records the **intentional** divergences between it and the skill Sova actually ships at
`.claude/skills/fold-ai-dev-design/`.

Read it before walking `PARITY.md` item by item: without it, every future audit re-discovers
these as defects and "fixes" one of them back into a state the skill was deliberately moved out
of. Nothing here is an excuse for a defect — each row names the checklist line it diverges from,
what the skill does instead, and the failure the divergence prevents.

| # | Playbook says | Sova does | Why | Where it lives |
|---|---|---|---|---|
| 1 | `PARITY.md:52-53` — `reference/foundations/` is "**exactly these six**": colors, typography, spacing, radius, shadow, grid-composition | Seven: `motion.md` is a foundation | Motion carries a real stance here — three durations, one curve, what never animates, and the `prefers-reduced-motion` behaviour — and it has its own rendered page plus a mandated `## Focus & motion` section in `SKILL.md`. Folding it into `grid-composition.md` would put motion rules behind a layout filename, the one place a reader looking for them would never open. `.build/audit.mjs` also asserts `7 foundations` / `35 site pages` against disk | `reference/foundations/motion.md`, `site/foundations/motion.html` |
| 2 | `PARITY.md:9-10` + `templates/skill-md.md:15` — frontmatter `name: <brand>-design-skill`, and phase 07 installs into `.claude/skills/<brand>-design-skill/` | The skill is `fold-ai-dev-design`, directory and `name` alike | The name predates the playbook and is load-bearing in eight places: `CLAUDE.md`, `spec/overview.md`, `src/design/tokens.css`, `ai/branding/overview.md`, two `ai/branding/logos/*/build.py` scripts, `server/skills.test.ts`. Renaming it touches app, spec, docs and a server test and teaches a reader nothing — the routing rule that matters is the `description`, and that is conformant | the skill directory name, `SKILL.md:2` |
| 3 | No concept — `PARITY.md` knows only files inside the skill | `SKILL.md`'s `## Components` table carries a **`Ported`** column (`yes` / `no` / `partial`), and `src/lib/design-port.test.ts` falsifies every row against `src/design/base.css` | Sova's app does not load this skill's stylesheets: it imports `src/design/tokens.css` + `src/design/base.css`, and `base.css` is a hand-ported subset. So "the component exists" is ambiguous in this repo, and a prose note would rot exactly the way the old `How to use` did. A row is a claim a check can fail: a `yes` needs a rule in `base.css`, a `no` needs none | `SKILL.md` (`## How to use`, `## Components`), `src/lib/design-port.test.ts` |
| 4 | `phases/07-install.md` (referenced from `PLAYBOOK.md:114`) — install the skill into a Rakiba project and wire its SASS pipeline | Phase 07 does not apply to Sova and was not executed | Phase 07 requires `rakiba.edn` and `bb sass`; this is not a Rakiba project. Sova consumes the system through `src/design/*`, which is what delta 3 makes checkable | — |
| 5 | `phases/05-references-and-site.md` anticipates "one content model" and `phases/06-qa.md` a link/parity script | The generator and its audit are committed inside the skill: `.build/build.mjs`, `content.mjs`, `components.mjs`, `tokens.mjs`, `audit.mjs` | Phase 05 asks for exactly this, and adds "have the generator parse `tokens.css` rather than restate it" — `.build/tokens.mjs` does: it resolves `var()` chains and computes WCAG contrast, so a superseded hex cannot survive a rebuild. `.build/audit.mjs` runs 48 checks and fails the build on a regressed count, hex, stance, spelling, or reference-section shape | `.build/` |

## What is *not* a delta

Everything else in this playbook is followed, including the parts the skill got wrong before this
file existed: the heading set and order, `## Marks`, `## Licensing`, one `Scale & spec` per
foundation and brand reference (nine of nine), `Variants & states` per component (25 of 25), the
`is-*` namespace for demo state helpers, the single-prose-document rule, and the ban on a
`README.md`, a `CHANGELOG.md` and inline revision history.
