# Sova's blast radius

`blast-radius.json` beside this file is the map `scripts/blast-radius.mjs` reads. What each pick is, what it costs, and when it is worth adding beyond the map's match:

| Pick | What runs | Cost | Add it when |
|---|---|---|---|
| `statecharts` | compile the statecharts and run their tests | ~2 min | anything under `statecharts/` or the scripts that build them changed |
| `spec-replay` | replay recorded spec sessions (one at a time on the machine) | ~20 min | the spec engine (`pi-config/extensions/spec/core/**`), its replay fixtures, or the procedure texts (WRITING.md, PROMOTE.md, spec-mode.md) changed |
| `tour` + `select` | the named browser tours (`scripts/e2e/*.mjs`) against a hermetic Sova | ~1–3 min each | the composer, the transcript view, the Overseer's schedules menu or the flow view changed (the map's rules), or a shared helper they import |
| `integration-group` + `select: ["tours"]` | the Tours slow group | ~10 min | tours code changed; a landing never runs this group on its own |
| `integration-group` + `select: ["trial"]` | the Chat processes slow group | ~6 min | chat processes changed (its trigger already runs it; pick it so the reason shows) |
| `integration-group` + `select: ["merge-queue"]` | the merge queue's own slow group | ~5 min | the queue, its checks or `.sova/project.json` changed |

The required floor (typecheck, unit with browser tests, the landing integration set with its triggers, changed extensions' suites, build, spec check, leak scan) runs whatever you pick.
