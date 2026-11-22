# Sova's picks

Sova's folder rules (the `rules` of `.sova/project.json`'s merge section) already run these where their paths change. What each check is, what it costs, and when it is worth adding beyond the rules' match:

| Pick | What runs | Cost | Add it when |
|---|---|---|---|
| `statecharts` | compile the statecharts and run their tests | ~2 min | anything under `statecharts/` or the scripts that build them changed |
| `spec-replay` | replay recorded spec sessions (one at a time on the machine) | ~20 min | the spec engine (`pi-config/extensions/spec/core/**`), its replay fixtures, or the procedure texts (WRITING.md, PROMOTE.md, spec-mode.md) changed |
| `e2e` + `select` | a build, then the named browser walkthroughs (`scripts/e2e/*.mjs`, each hosting its own Sova) | ~1–3 min each, plus the build | the composer, the transcript view, the Overseer's schedules menu or the flow view changed (the rules), or a shared helper they import |
| `integration-group` + `select: ["tours"]` | the Tours slow group | ~10 min | tours code changed; a landing never runs this group on its own |
| `integration-group` + `select: ["trial"]` | the Chat processes slow group | ~6 min | chat processes changed (its trigger already runs it; the rule shows the reason) |
| `integration-group` + `select: ["merge-queue"]` | the merge queue's own slow group | ~5 min | the queue, its checks or `.sova/project.json` changed |

`integration-group` runs `run-tests.mjs --integration --picked-groups <select>`, once per group (`perSelector`). Sent with no `select` it runs the slow groups a landing already runs for the branch's changes (or skips: "no slow group applies to this branch's changes"), never the one you meant: always send the group.

The required floor (typecheck, unit with browser tests, the landing integration set with its triggers, changed extensions' suites, build, spec check, leak scan) runs whatever you pick.
