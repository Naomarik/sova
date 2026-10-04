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
