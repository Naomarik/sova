# The upgrade

Only after the user's yes to this run's plan, in this chat. Two helpers as one team: the implementer does the work and the boundary keeper reads each commit as it lands. You conduct and keep your context light.

Start from the plan the user agreed, with their answers to the questions as decisions. If `<W>` is older than a few days, or master moved under `server/harness/**` or `pi-config/**` since, say so and re-check what the plan rests on.

In this order, with no step skipped (the plan says which steps this upgrade needs):

1. **Own branch.** `worktree create pi-<new>` (it makes `feat/pi-<new>`), `mise trust <worktree>`. Never the live checkout.
2. **Pins.** `package.json`: every `@earendil-works/*` to `<new>`; `typebox` and anything in `EXTENSION_DEPS` to what the new pi's own `package.json` asks for.
3. **Release-age list.** `pnpm-workspace.yaml`, `minimumReleaseAgeExclude`: one entry per `@earendil-works/*` package at `<new>`. Drop what pi dropped, add what it added. Write it from the reader's dependency table, install, then check it agrees: `rg -o '@earendil-works/[a-z-]+@<new>' pnpm-lock.yaml | sort -u`.
4. **Install.** `pnpm install`, never a hand-edited lockfile. Read the output: a new "ignored build scripts" line means an `allowBuilds` decision, and that is the user's.
5. **Typecheck.** `pnpm run typecheck`. Fix at the adapter (`server/harness/pi/`) where you can.
6. **QUIRKS, row by row.** `pnpm test -- server/harness/pi/contract.test.ts`. A failing canary is a triage, never a test edit: find its row in `server/harness/pi/QUIRKS.md`, read what Sova relies on, read the sites. If pi stopped needing the workaround, retire it (workaround, canary, row, `quirks.ts`). If pi changed shape, change the sites and the canary together. Then read every row whose prose the research flagged, even though its canary passes. A new reach adds its row, canary and sites in the same change.
7. **Stand-ins.** Classify each new file in `server/harness/pi/headless-files.json` as stand-in or kept, by what it imports and who loads it, and make `STANDIN_FILTER` agree. `SOVA_HEADLESS_FILES_OUT=<absolute path> pnpm test -- server/harness/pi/headless.test.ts` writes the current list to compare; a person's judgement decides each new line. Then `pnpm test:int -- server/harness/pi/headless.integration.test.ts`.
8. **Deep imports and copied code.** Fix each item of concern 8 the research flagged. Where you can replace a copy with a public export, do.
9. **Behaviour.** Fix what the alignment agreed, handler by handler. A behaviour change gets a spec draft and a test first, as `WRITING.md` says.
10. **pi-config on the new pi.** Run its whole `## Tests` block and `typecheck.mjs` on the branch's pi (`references/commands.md`), and `pnpm test:int -- server/harness/pi/extension-deps.integration.test.ts`. The merge queue's `extensions` check can't stand in for this: it runs only the suites of extensions the branch changed, and runs them on the global pi. So run the changed ones with `PI_PACKAGE_DIR` unset too: one that fails only there will fail in the queue (`references/stop-and-ask.md`).
11. **Goldens, last.** Explain each diff first: one line per golden saying which pi change caused it. Only then re-record, and a diff you can't explain is a finding, not a re-record. The commands are in `references/commands.md`.
12. **Boundary.** The baseline only shrinks. Never add a file, raise a count or list a wrapper to make `server/harness-boundary.test.ts` pass; if it seems to need that, stop and ask the user.
13. **Docs.** `AGENTS.md`'s "pinned" version; `agents/server/harness/overview.md`'s version labels and any SDK fact that changed; each QUIRKS row's "pi" column if a member moved. `rg -n '<old>' AGENTS.md agents server/harness/pi` finds the rest. `docs/perf/` is history: leave it.
14. **Check.** The regression checker runs `phases/check.md`'s list; the implementer fixes what it finds.
15. **Land.** Commit by explicit path. Then say what still blocks landing (Sova's note names it), or that the user can press Land or type "land it" here. Only the user's Land lands it, through the merge queue; `worktree merge` won't. Once they have pressed it, never ask again. After it lands: `phases/after-landing.md`.

Refactor where it keeps pi at the edge, so the next upgrade is smaller: a reach moved behind the harness contract, a copy of pi's code replaced by a public export, a workaround retired. Not more than the plan names; anything bigger goes in the report as a follow-up.

Stop and ask the user on anything in `references/stop-and-ask.md`.
