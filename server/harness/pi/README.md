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

## The reader

`reader.ts` is pi's session files as neutral history (`HEntry`, `shared/harness-history.ts`,
§app.harness/reader): `parsePi`/`readPi`, `branchOf`/`readBranch`/`readTailBranch`, `historyOf` and
`toHEntry` for raw entries already in hand, `liveRead(owner)` for a held session, the line scanners
(`lineHead`, `lineMay`, `lineEntry`, `lineHeader`, `appendLines`, `atLineStart`, `BranchScan`) and
the display text helpers (`typedText`, `firstText`, `joinedText`). `usage.ts` holds the context-fill
rules (`contextOfBranch`, `contextStep`, `resetsContext`) and the worker adapter's usage accumulator.
Rows come from `rowsOf(history)` / `rowsOfEntry(h)` in `server/transcript.ts`.

`parseLines`, `activeBranch`, `readActiveBranch` and `rawOf` are the raw API, counted by the boundary's
reader ratchet wherever they are imported; `liveRead` is counted as a reach. An entry this pi doesn't
write is `kind: "unknown"` and is counted for `GET /api/health` (§app.harness/unknown-entries);
`insertion.test.ts` proves no non-display golden probe changes when one is inserted anywhere.
