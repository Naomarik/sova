---
watches: ["pi-config/extensions/remote/**", "server/targets.ts"]
alsoUpdate: ["pi-config/extensions/remote/README.md"]
---
# remote

`--target <name>` runs a session's tools on an ssh, AWS-SSM, docker or incus target from `targets.json`; without the
flag it does nothing. Sova imports its argv builder.

## What lives here

- [`README.md`](../../../pi-config/extensions/remote/README.md).
- Tests: `cd pi-config/extensions/remote && node --test argv.test.ts`.

## What Sova relies on

- `server/targets.ts` imports `argv.ts`: the target schema, its validation, and the single argv builder that both
  this extension and the web server use to run a command on a target.
- `argv.ts` also owns the connect-timeout derivation (`connectTimeoutS`, `connectTimeoutMs`): the server's
  `remoteTimeoutMs` and the extension's channel start and preflight bounds all come from it, so an unset field
  leaves every one at its fixed constant.
- `argv.ts` is the quoting boundary. Every path that reaches a far shell is single-quote-escaped there, and callers
  spawn its argv without a local shell.
- Sova has no sshfs or mount support: a remote session's cwd is always its local placeholder, and every tool runs on
  the target.
- No watcher watches this directory: an edit to `argv.ts` doesn't restart the running server, which keeps the old
  code until its next restart.

## When you change it, also update

- The target schema or argv: the README, and run `pnpm test -- server/targets.integration.test.ts` (a named file runs whatever its tier), which pins
  the server's use of it.
