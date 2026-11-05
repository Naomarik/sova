# What's worth noting: the paths behind each line

| Line | Paths (changed by the branch, `git diff --name-only <target>...<commit>`) | Note |
|---|---|---|
| Restart | `server/**`, `shared/**`, `pi-config/**` (not `*.test.*`, `*.md`); the `src/` files the server imports (`SERVER_SRC_IMPORTS` in `server/restart-paths.ts`: `src/lib/message.ts`, `src/lib/summary-diff.ts`, `src/vis/parse.ts`, …); `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`. `server/restart-paths.ts` is the rule; `scripts/restart-sova.mjs plan` applies it | "Changes server code; Sova restarts itself once the queue is idle." |
| Reload | `pi-config/**` (not `tests/**`, `*.test.*`, `*.md`): the server restarts for it too, and each chat picks it up at its next reload | add "Chats pick it up at their next reload." |
| Dependencies | `package.json` (`dependencies`, `devDependencies`, `packageManager`), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml` | "Adds/removes/bumps <name>." |
| State | code writing under `stateRoot()`; files named `*-store.ts`, `*migrat*`; a changed `version` in a state file's reader | "New state file <name>." / "Migrates <file>: <how old data is read>." |
| Contracts | `shared/protocol.ts`, `shared/harness*.ts`, `shared/commands-ids.json`, `pi-config/extensions/*/` files the extensions guide lists as parsed by Sova | "Changes the wire contract: <what>." |
| Spec drafts | the run's docs step (`merge.logs {run, step: "docs"}`) | "Lands spec draft <name>." |
| Left for later | `TODO`/`FIXME` added in the diff; a setting whose default is off; "follow-up" in the commit messages | "Leaves <what> for later." |

Not worth noting: page-only `src/**` (not on the server's list), `public/**`, tests, docs, `.sova/spec/**`, `agents/**`, scripts used only by tests.
