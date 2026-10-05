# server/harness/pi — the pi adapter

The only code in `server/`, `shared/` and `src/` that may reach pi (`@earendil-works/*`) beyond the
shrinking list in `server/harness/boundary-baseline.json` (§app.harness/boundary). Everything else
speaks the contract in `shared/harness.ts`.

## The pi contract suite

`contract.test.ts` pins the pi behaviours Sova relies on. It loads pi only through
`testing/load-pi.ts`, so the same file runs against the repo's pinned pi (in every `pnpm test`) or
against another copy. Run it on every pin bump and every upgrade of the pi the TUI runs:

```sh
# the global pi the TUI runs (installed with npm -g; pi's bin sits in dist/bundle/, so don't derive
# the directory from the binary's path)
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" pnpm test -- server/harness/pi/contract.test.ts
# or name the package directory outright
PI_PACKAGE_DIR=<prefix>/lib/node_modules/@earendil-works/pi-coding-agent pnpm test -- server/harness/pi/contract.test.ts
```

`PI_PACKAGE_DIR` is the `pi-coding-agent` package directory. Its pi-ai and typebox are resolved
from its real path, as Node would from inside it.

Its P1–P20 and T1 tests are the quirk canaries: `QUIRKS.md` (typed in `quirks.ts`) lists every pi
behaviour Sova leans on beyond pi's promises, where Sova relies on it, and when it can go. A failing
canary is triaged by its row there; `quirks-meta.test.ts` keeps the registry, the canaries and the code
in step.

## The reader

`reader.ts` is pi's session files as neutral history (`HEntry`, `shared/harness-history.ts`,
§app.harness/reader): `parsePi`/`readPi`, `branchOf`/`readBranch`/`readTailBranch`, `parsePiBranch` (only
the active branch converted: what a reader that needs no off-branch entry uses), `historyOf` and `toHEntry`
for raw entries already in hand, `liveRead(owner)` and `liveHistory` for a held session (each entry converted
once; HEntries shared between calls, never written), the line scanners
(`lineHead`, `lineMay`, `lineEntry`, `lineHeader`, `appendLines`, `atLineStart`, `BranchScan`) and
the display text helpers (`typedText`, `firstText`, `joinedText`). `usage.ts` holds the context-fill
rules (`contextOfBranch`, `contextStep`, `resetsContext`) and the worker adapter's usage accumulator.
Rows come from `rowsOf(history)` / `rowsOfEntry(h)` in `server/transcript.ts`.

`parseLines`, `activeBranch`, `readActiveBranch` and `rawOf` are the raw API, counted by the boundary's
reader ratchet wherever they are imported; `liveRead` is counted as a reach. An entry this pi doesn't
write is `kind: "unknown"` and is counted for `GET /api/health` (§app.harness/unknown-entries);
`insertion.test.ts` proves no non-display golden probe changes when one is inserted anywhere. An HEntry
keeps its raw entry on a non-enumerable symbol property (`rawOf`), not in a WeakMap: a process-wide WeakMap
made every parse cost more in GC than the conversion itself.
