# Commands

## pi-config's suites on the branch's pi

From the worktree root. The variable must be absolute because the lines `cd`, and each line gets its own subshell for the same reason. The block's `spec` line is safe: `tests/*.test.mjs` is not recursive, and the replay suite is the folder `tests/replay`.

```sh
export PI_PACKAGE_DIR="$(realpath node_modules/@earendil-works/pi-coding-agent)"
(cd pi-config && sed -n '/^## Tests/,/^```$/p' README.md | grep -E '^(node|bun|cd) ' |
  while read -r line; do (eval "$line") </dev/null || echo "FAILED: $line"; done)
node pi-config/extensions/claude-code/provider/typecheck.mjs
```

## Re-recording goldens

Run these from the branch's worktree, with every other `SOVA_*` variable unset. Each makes its own throwaway `HOME` and working folder, so `agents/server/harness/overview.md`'s rule (no context file above the recording, `HOME` inside it) is met; that rule binds only if you run a recorder by hand. Each command writes tracked files, so read the diff afterwards. Anything the tester's patch shows at `<old>` too is the recording environment, not pi: don't explain it as drift.

```sh
node scripts/harness-golden/faux-record.mjs --check && node scripts/harness-golden/faux-record.mjs
node scripts/harness-golden.mjs record
SOVA_GOLDEN_RECORD=overwrite pnpm test -- server/harness/pi/session-golden.test.ts server/harness/pi/state-golden.test.ts
SOVA_GOLDEN_RECORD=1 pnpm test -- server/harness/pi/special-model-view.test.ts
SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/wire-compat.test.ts server/harness/pi/golden/wire/wire.test.ts   # never rewrites wire-1 frames
SOVA_LOADOUT_UPDATE=1 pnpm test -- server/agent-loadouts.test.ts
rm -r server/modes/golden/cases server/modes/golden/store
SOVA_MODES_GOLDEN=record pnpm test -- server/modes/modes-extension.golden*.ts
```

A bump re-takes the modes recordings on its own branch, the one tree with the new pins (`server/modes/golden/README.md`'s "from master's code" is about the modes move). The two folders go first because the store check fails on files nothing uses. A re-take also records the `spec` tool, at `<old>` too; the comparison filters it on both sides (`withoutA1`), so it isn't pi's drift.
