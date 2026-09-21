# remote

Runs a pi session's tools on a **remote target**: an ssh host, a host reached through AWS SSM,
a docker container, or an incus cell, optionally chained through another target. Targets are
configured in `~/.pi/agent/targets.json` (`$PI_CODING_AGENT_DIR/targets.json`).

```sh
pi --target acme-prod          # any local directory; tools run in the target's cwd
```

Without `--target` the extension registers nothing, and the session behaves exactly as it would
without it. pi-web sets the same flag per runtime (`extensionFlagValues`) for sessions opened from
New Session → Remote.

## What runs where

With `--target <name>`, these tools are replaced by versions that run on the target:

| Tool | How |
| --- | --- |
| `bash`, and `!` / `!!` commands (`user_bash`) | `BashOperations` → the target argv. The far command runs in its own session under a watchdog, so abort or timeout kills it on the far side too |
| `read`, `write`, `edit` | Operations: `cat`, `cat >` (content on stdin), `mkdir -p`, `test -r` |
| `ls`, `find` | Operations: one listing per directory for `ls`; far `find` with fd-like glob semantics, skipping `.git` and `node_modules` |
| `grep` | Re-registered whole (`GrepOperations` can't run a search): far `rg` when installed, else `grep -rnI` |

`before_agent_start` sets the prompt's cwd to the far cwd and adds a `remote-target` section,
using prompt sections rather than replacing the prompt. The footer status shows
`⇄ <label> · user@hostname`.

**Fail fast, fail closed.** A bounded preflight (`id -un; hostname; $HOME; pwd`) runs at session
start. ssh always runs with `BatchMode=yes` and `ConnectTimeout=10`. An unreachable target makes
every tool fail with the target's name and ssh's stderr. The failure is cached for 15 s, then
retried. An unknown or invalid target name makes every tool refuse, and never falls back to local
execution.

**Paths.** pi-web opens target sessions in a local placeholder,
`<agentDir>/pi-web/targets/<name>/<remote/abs/path>`, which maps back to `/remote/abs/path`. From
any other directory, the local cwd maps to the entry's `cwd` (or the far login directory), and
`~/…` maps to the far `$HOME`.

## Files

| File | What |
| --- | --- |
| `argv.ts` | Pure, node-builtins-only. The entry schema, validation, the one argv builder (`buildTargetArgv`), the folder listing (`buildListDirsArgv`), quoting, and the placeholder path helpers. **pi-web's server imports it**, so keep it pi-runtime-free |
| `exec.ts` | Spawns an argv with no local shell, with a timeout, abort handling and stdin |
| `check.ts` | `node check.ts entry.json [--list PATH] [--cmd …]`: validates an entry and runs it end to end through the same builder. The connection agent uses it before it writes an entry |
| `index.ts` | The extension |

## Entry schema

```json
{ "name": "acme-prod", "label": "acme prod", "kind": "ssh",
  "ssh": { "user": "deploy", "host": "192.0.2.10", "port": 22, "key": "~/.ssh/id_rsa", "options": [] },
  "proxy": { "type": "aws-ssm", "profile": "p", "region": "eu-central-1", "pushKey": "ec2-instance-connect" },
  "incus": { "sudo": true, "sandbox": "foldai-sandbox", "cell": "foldai-cell-abc", "uid": 70000, "gid": 70000 },
  "docker": { "container": "web", "user": "app" },
  "via": "other-target", "cwd": "/home/deploy/acme-site", "env": { "TERM": "dumb" } }
```

`kind` names the environment. `"ssh"` is the plain host, `"incus-cell"` uses the `incus` block, and
`"docker"` uses the `docker` block. The transport is derived: an `ssh` block means ssh; otherwise a
`via` entry nests inside that target; otherwise the command runs on this machine. The file is
credential-free: key paths and profile names only. ssh always gets `ControlMaster=auto`,
`ControlPath=~/.ssh/cm-%C` and `ControlPersist=10m` (a cold login can cost over 1.5 s), after the
entry's own `options`, so the entry's options win.

**Quoting.** The folder browser's path is user input. Every value spliced into far shell code is
single-quoted, and the far argv is re-quoted word by word for ssh's login shell. `argv.test.ts`
runs a path like `/tmp/it's/$(touch …/pwned)` through both layers and asserts it stays data.

## Tests

```sh
cd extensions/remote && node --test argv.test.ts
```

When a proof run drives a model against a live target: Name exact paths. Never tell the model to read whatever find/ls returned; list freely, then read only a named file you have judged non-secret.

`argv.test.ts` needs no network. To check a live target:
`node check.ts entry.json`, then `pi --target <name>` and run `!hostname`.

Known limits: the target's `AGENTS.md` is not loaded into the prompt. `find` doesn't honour
`.gitignore` (it only skips `.git` and `node_modules`). Without `rg` on the target, `grep` uses
POSIX ERE (`grep -E`) rather than Rust regex syntax.
