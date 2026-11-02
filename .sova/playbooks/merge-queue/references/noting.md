# What's worth noting: the paths behind each line

| Line | Paths (changed by the branch, `git diff --name-only <target>...<commit>`) | Note |
|---|---|---|
| Restart | `server/**`, `shared/**` (not `*.test.ts`) | "Changes server code; restart Sova to pick it up." |
| Reload | `pi-config/**` (not `tests/**`, `*.test.*`, `*.md`) | "Changes pi-config; chats pick it up at their next reload." |
| Dependencies | `package.json` (`dependencies`, `devDependencies`, `packageManager`), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml` | "Adds/removes/bumps <name>." |
| State | code writing under `stateRoot()`; files named `*-store.ts`, `*migrat*`; a changed `version` in a state file's reader | "New state file <name>." / "Migrates <file>: <how old data is read>." |
| Contracts | `shared/protocol.ts`, `shared/harness*.ts`, `shared/commands-ids.json`, `pi-config/extensions/*/` files the extensions guide lists as parsed by Sova | "Changes the wire contract: <what>." |
| Spec drafts | the run's docs step (`merge.logs {run, step: "docs"}`) | "Lands spec draft <name>." |
| Left for later | `TODO`/`FIXME` added in the diff; a setting whose default is off; "follow-up" in the commit messages | "Leaves <what> for later." |

Not worth noting: `src/**` alone, `public/**`, tests, docs, `.sova/spec/**`, `agents/**`, scripts used only by tests.
