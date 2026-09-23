# Phase 04 — Build core artifacts

Inputs: a complete ledger with no unconfirmed load-bearing entries. If any remain, resolve
them with the user before writing a single artifact — or, if there is no user to ask, promote
them to `AI-default-final` and carry them into the handoff as unsigned-off decisions.

You read `PARITY.md` at the start of phase 02. Re-check it here for the file-level items —
the exact six foundation files, the exact two brand files, and `SKILL.md`'s heading order.

Build in this order (later files cite earlier ones). Read the matching template right before
each artifact:

1. **`tokens.css`** — per `templates/tokens-css.md`. Every ledger decision becomes a custom
   property. `@font-face` blocks reference files that actually exist in `fonts/`. Include
   element defaults (html/body/headings/links) so a bare page already looks branded.
2. **`<brand>.css`** — per `templates/components-css.md`. One section per inventory
   component, consuming tokens only. Include the static state-helper classes
   (`.is-hover` etc.) used by the site's state matrices, documented as demo-only.
3. **Assets** — finalize `fonts/`, `assets/logos/`, `assets/icons/functional/`. Verify every
   `@font-face` path resolves. Optimize SVGs (no editor cruft, `currentColor` where the spec
   says so).

**`SKILL.md` is not written in this phase.** It states the page and reference counts, so it
cannot be true until `site/` and `reference/` exist. It is the last step of phase 05.

## Verification before leaving this phase

- Render a scratch HTML page linking `tokens.css` + `<brand>.css` and exercising one instance
  of every component class; screenshot or open it to confirm nothing is unstyled.
- Grep `<brand>.css` for raw hex values — anything outside tokens.css needs a documented
  reason.
- Check body-text and muted-text contrast (AA) against every documented background.

Mode 1: show the scratch page as a checkpoint. Modes 2/3: proceed, keep the page for phase 06.
Either way the scratch page lives outside `<brand>-skill/` or is deleted at handoff.
