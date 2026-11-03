# Sova's release-only checks

What the settings' `release.checks` run, and why. The merge queue runs them on the release's entry, after its required checks (typecheck, unit, the everyday integration set, changed extensions, build, spec, leak scan), on the release commit, in a merge copy. You never run them in place of the queue and never report one: the `checks` step is Sova's. When one fails, read its log (`release.logs {step: "checks"}`), fix it in a commit of its own on the release branch, make the release commit again if it changed, and report `commit` again.

| Check | What it runs | Why a release adds it |
|---|---|---|
| `release-notes` | `sova-release.mjs changelog-check` | the entry for `package.json`'s version is in `CHANGELOG.md` once, headed `## vX.Y.Z — YYYY-MM-DD`, no placeholder left |
| `release-integration` | the whole integration tier, every group included | landings run the everyday set and only the slow groups a branch touches (the tours never run at landing); a release runs it so, and there is no other catch-up run of the groups. A break found here may have landed since the previous release |
| `release-extensions` | `sova-release.mjs ext-all` | every pi-config extension's suite, as `pi-config/README.md`'s Tests block lists them, not only the changed ones |
| `release-spec-replay` | the spec replay suite, picked | it runs at landing only when the spec engine changes; a release runs it whatever changed (one replay per machine: the check waits on the machine's lock) |
| `release-site` | `sova-release.mjs site-check` | the site installs and builds (its build fails on a Docs page that names a spec ID or a source path), and the built landing names the `stable` install command and links `/releases/tag/vX.Y.Z` |
| `release-spec` | `sova-release.mjs spec-new` | the spec check on the release commit has no finding the previous release's tree didn't have (the check exits 1 by design while behaviours wait on investigation; only new findings fail) |
| `release-leaks` | `sova-release.mjs leak-scan` | the leak scan over everything since the previous release, which Publish is about to push |

A failing integration file that passes alone twice is flaky: Retry Step on `checks` re-runs the queue's run; name it in your final reply. One that fails the same way on the previous release's tree is old: say so in a `failed` report and let the operator decide.

The live server on the release commit is not a check here: it is the held `check` step `try-live` (PLAYBOOK.md).
