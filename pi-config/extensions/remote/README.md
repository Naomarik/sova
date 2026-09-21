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
| `read`, `write`, `edit` | Operations: one far command each: `read` = the existence/readability check folded into `cat` (`ENOENT: no such file on …` / `EACCES: not readable on …`), `write` = `mkdir -p` + `cat >` (content on stdin), `edit` = that read + that write. Writes and edits are serialized per **far** file in pi's `withFileMutationQueue` |
| `ls`, `find` | Operations: one far command per `ls` (the kind check and the listing together); far `find` with fd-like glob semantics, skipping `.git` and `node_modules` |
| `grep` | Re-registered whole (`GrepOperations` can't run a search): far `rg` when installed, else `grep -rnI` |

**The pinned channel** (`channel.ts`). After the preflight answers, a long-lived far shell is
started in the background over its own ssh connection, so its setup (~1.6 s) never lands on a tool
call. File operations (`read`, `edit`'s read, `ls`, `find`, `grep`) run there when it is idle; a
second call while it is busy, anything with stdin (`write`), scripts over 100 KB, and `bash` spawn
their own ssh as before. It closes after 120 s idle; 2 failures within 60 s turn it off for 60 s.
Off entirely with `PI_REMOTE_CHANNEL=0` or `--no-channel`.

Every channel open is a fresh ssh login on its own TCP connection, and hosts rate-limit those
(acme-prod: ~6 new logins per 30 s per source IP, a sliding window shared by the master, the
channel, per-call fallbacks and your own shells; over it, fresh logins get `Connection refused`
while the existing master keeps working). So the channel spends logins sparingly:

1. It is warmed once and kept. After an abort, timeout or poison teardown it is reopened only by
   the next tool call **and** no sooner than 30 s after the teardown (an idle close just waits for
   the next call).
2. A start refused with `Connection refused` is the host's rate limit, not a channel fault: it
   doesn't count toward the 2-failures rule; the channel backs off 45 s, with no retry loop.
3. During the backoff every call goes per call through the existing master, and the channel is
   tried again only by the first tool call after the backoff. `/remote reconnect` bypasses it once.
4. The status says so: `channelState: "rate-limited"`, `channelRetryAt`, `pinned: false`, `error`
   = ssh's line; `state` stays `online` (per call works); the footer adds `· ssh rate-limited`.

Budget: one master login plus one channel login per session leaves ~4 fresh logins per 30 s for
everything else from this machine (other sessions, the folder browser, `check.ts`, your shells).

Three deliberate departures from the obvious design, for the next reader:

- **`bash` never rides the channel.** `dispatch()` in `index.ts` sends anything with `onData`,
  `input` or `holdStdin` per call. A streaming tool result must not be reordered or attributed to
  the wrong request; a write payload must not travel inside the request framing; and the meaning of
  exit code 255 stays clean (per call it is ssh's "unreachable", over the channel it is the
  command's own code, see the `viaChannel` check in `run()`). The channel is a fast lane for the
  short, idempotent file operations, not a second bash transport.
- **The far script goes to a private temp file, not `sh -c "$script"`.** One argv string is capped
  at 128 KB on Linux, and a script can carry write content; the loop writes each request into a
  `mktemp -d` directory and runs `sh <file>`, removing the directory on exit, HUP, PIPE and TERM.
- **The channel has its own watchdog instead of `argv.ts`'s `hangupGuard`.** The guard watches its
  own stdin for EOF, which inside the loop is `/dev/null` (fires at once) or the request stream
  (would eat the next request). The loop's watchdog reads the channel's stdin only while a command
  runs, when the client sends nothing, so it wakes only when the ssh client dies and then kills the
  command's process group. It is reaped before the terminator is printed.

Measured on acme-prod (RTT ~117 ms): a file op costs ~135 ms over the channel against ~255 ms
per call over a warm ControlMaster; `bash` and `write` are unchanged. Over one representative turn
(read, edit, ls, grep, two bash calls) the channel captures three of eight ssh spawns.

**Mounted mode** (`mount.ts`). An entry with a `mount` block (`{"remote": "/abs/far/path",
"local": "~/…"}`) can be mounted over sshfs: `/remote mount` (or pi-web's toggle, which calls the
same code). A session whose cwd is inside the mount point is a **mounted session**, decided once
at session start:

| Tool | Mounted mode |
| --- | --- |
| `read`, `write`, `edit` | **local**, through the mount — every tool shares one view and pi's own per-file mutation queue applies natively |
| `bash`, `ls`, `find`, `grep` | **remote, always** — a recursive search through fuse measured 135 s vs 14 ms far side |
| the channel | **never built** — fuse provides the fast lane; a channel would cost a second ssh login |

Paths inside the mount point map to `mount.remote` + suffix (so is the session's far cwd). An
absolute path outside the mount still means the host, as today. If the mount goes down mid-session,
file tools fail closed with a clear error (`the sshfs mount … is gone; remount it`) — never a silent
ENOENT from the empty mount-point dir. Placeholder sessions and CLI sessions with a cwd outside
the mount point behave exactly as without a mount config, and mounting later does not re-route
them.

Every mount carries `reconnect,ServerAliveInterval=15,ServerAliveCountMax=3` (mount.ts's
SSHFS_MOUNT_OPTIONS, asserted in mount.test.ts): without them a dead host turns a `stat` on the
mount into an event-loop freeze — the caller is often pi-web's server. `isMounted` checks
`/proc/mounts` (never a stat of the fuse path); `verifyMounted` reads through the mount on
fs/promises inside a timeout race, so a mount that exists but doesn't answer is never reported as
success. `unmount` runs `fusermount3 -u`, retries briefly on EBUSY, then falls back to the lazy
`-u -z` (measured: a local process holding an fd through the mount — e.g. an open node_modules —
leaves plain `-u` busy; lazy detaches and the mount leaves the table at once), and reports what
the table actually says.

**Mount-point placement.** Prefer `~/.pi/agent/mounts/<name>`: the mount must NOT live where
other tools casually traverse — a module-resolving process that walks into `~/remote/…` under
$HOME held the mount open and made it EBUSY.

**Status.** Two `setStatus` keys, always together: `remote`, the footer line
(`⇄ <label> · user@hostname`, `· unreachable`, `· ssh rate-limited`, `· pinned`), and
`remote-status`, JSON for pi-web's connection chip: `{state: "online"|"unreachable"|"unknown",
target, host?, latencyMs?, pinned, mounted, mountPoint?, channelState?: "off"|"warming"|"idle"|"busy"|"dead"|"rate-limited",
channelRetryAt?, lastOkAt, runningMs?, error?, at}`. `mounted` is a live `/proc/mounts` lookup
target-level (true in every session of the target, whatever its cwd); `mountPoint` is present iff
the entry has a mount config, mounted or not. Re-published
on session start, every probe and call outcome, every channel transition, and every 5 s while a
command runs (`runningMs`). `/remote check` runs a fresh per-call probe; `/remote reconnect` drops the
channel and re-probes; `/remote mount`/`/remote unmount` toggle the target's sshfs mount (safe to
call twice; both re-publish the status); `/remote status` only re-publishes both keys from the current state (no
ssh, no channel, no toast), for a client that reconnected to a live session. A first loss and a recovery also toast (`remote: …`).

`before_agent_start` sets the prompt's cwd to the far cwd and adds a `remote-target` section,
using prompt sections rather than replacing the prompt.

**Fail fast, fail closed.** A bounded preflight (`id -un; hostname; $HOME; pwd`) runs at session
start. ssh always runs with `BatchMode=yes` and `ConnectTimeout=10`. An unreachable target makes
every tool fail with the target's name and ssh's stderr. The failure is cached for 15 s, then
retried. An unknown or invalid target name makes every tool refuse, and never falls back to local
execution.

**Paths.** pi-web opens target sessions in a local placeholder,
`<agentDir>/pi-web/targets/<name>/<remote/abs/path>`, which maps back to `/remote/abs/path`. From
any other directory, the local cwd maps to the entry's `cwd` (or the far login directory), and
`~/…` maps to the far `$HOME`.

## Workers (subagents of a remote session)

A remote session's subagents run on the target too — both backends, through the same argv, channel
and far scripts as the session itself (`workers.ts` is the contract the subagents extension reads):

| Backend | How |
| --- | --- |
| pi | The subagents extension loads this extension into the child (`-e remote/index.ts --target <name>`, `--no-channel` when the session has it), so the worker's `bash`/`read`/`write`/`edit`/`ls`/`find`/`grep` are exactly the session's. Its own channel; its own preflight over the parent's ControlMaster |
| claude-code | The child launches `mcp-server.ts` as a stdio MCP server named `remote` (tools `mcp__remote__remote_bash`, `remote_read`, `remote_write`, `remote_edit`, `remote_ls`, `remote_find`, `remote_grep`) and starts with `--tools ""`: no built-in tool at all, so nothing can touch this machine's filesystem. The identity (`PI_REMOTE_MCP`: target name, far cwd, agent dir — never a credential) rides in the worker's private mcp.json env |

How the subagents extension knows: this extension emits `remote:session` on `pi.events` at session
start (and again on `remote:discover`), since `pi.getFlag("target")` is only answered for the
extension that registered the flag; a placeholder cwd (`<agentDir>/pi-web/targets/<name>/<far path>`)
is the fallback. A target that failed to load is announced with `error`, and the session then refuses
to spawn workers at all — never a worker with local tools in an empty placeholder.

A worker's `cwd` in a remote session is a FAR path (absolute, or relative to the session's far cwd;
`~` is refused — the parent does not know the far home); its local cwd is that path's placeholder,
created if needed. The worker is told all of this in its system prompt (`remoteWorkerInstructions`),
and a claude worker again through the server's `initialize.instructions`.

## Files

| File | What |
| --- | --- |
| `argv.ts` | Pure, node-builtins-only. The entry schema, validation, the one argv builder (`buildTargetArgv`), the folder listing (`buildListDirsArgv`), quoting, and the placeholder path helpers. **pi-web's server imports it**, so keep it pi-runtime-free |
| `exec.ts` | Spawns an argv with no local shell, with a timeout, abort handling and stdin |
| `channel.ts` | The pinned channel: one far shell over its own ssh, length-prefixed requests, base64 + marker responses |
| `mount.ts` | The sshfs mount: the one argv builder (the measured-safe options), the `/proc/mounts` lookup, mount/unmount/verify with honest reports. **pi-web's server imports it**, so keep it pi-runtime-free |
| `connection.ts` | Pure, loadable by plain node. `Connection`: one session's probe, status and the choke point every far command takes — the pinned channel when idle, else per call — with the whole channel policy (lazy warm, hold after a teardown, failure cooldown, login rate-limit backoff). `Remote` in index.ts extends it; a worker's MCP server uses it directly. Both lanes run in the far cwd |
| `check.ts` | `node check.ts entry.json [--list PATH] [--cmd …]`: validates an entry and runs it end to end through the same builder. The connection agent uses it before it writes an entry |
| `workers.ts` | Pure. What a session hands its workers: the `remote:session` event, the MCP identity env and the worker blurb; imported by index.ts, mcp-server.ts and the subagents extension |
| `mcp-server.ts` | The `remote` stdio MCP server a claude-code worker launches (node builtins + the pure modules; never index.ts) |
| `index.ts` | The extension |

## Entry schema

```json
{ "name": "acme-prod", "label": "acme prod", "kind": "ssh",
  "ssh": { "user": "deploy", "host": "192.0.2.10", "port": 22, "key": "~/.ssh/id_rsa", "options": [] },
  "proxy": { "type": "aws-ssm", "profile": "p", "region": "eu-central-1", "pushKey": "ec2-instance-connect" },
  "incus": { "sudo": true, "sandbox": "foldai-sandbox", "cell": "foldai-cell-abc", "uid": 70000, "gid": 70000 },
  "docker": { "container": "web", "user": "app" },
  "via": "other-target", "cwd": "/home/deploy/acme-site", "env": { "TERM": "dumb" },
  "mount": { "remote": "/home/deploy/acme-site", "local": "~/.pi/agent/mounts/acme-prod" } }
```

`kind` names the environment. `"ssh"` is the plain host, `"incus-cell"` uses the `incus` block, and
`"docker"` uses the `docker` block. The transport is derived: an `ssh` block means ssh; otherwise a
`via` entry nests inside that target; otherwise the command runs on this machine. `mount` needs
the target's own ssh block — refused at use by `mountArgv`, never by validation (a validation
failure would drop the whole entry, mount and all). The file is
credential-free: key paths and profile names only. ssh always gets `ControlMaster=auto`,
`ControlPath=~/.ssh/cm-%C` and `ControlPersist=10m` (a cold login can cost over 1.5 s), after the
entry's own `options`, so the entry's options win.

**Quoting.** The folder browser's path is user input. Every value spliced into far shell code is
single-quoted, and the far argv is re-quoted word by word for ssh's login shell. `argv.test.ts`
runs a path like `/tmp/it's/$(touch …/pwned)` through both layers and asserts it stays data.

## Tests

```sh
npx tsx --test pi-config/extensions/remote/*.test.ts
```

`mount.test.ts` needs no network either: the argv, the real `/proc/mounts`, and fake sshfs/fusermount3
seams for the reporting.

`index.test.ts` counts far invocations per tool (read 1, edit 2, write 1, ls 1) with a fake runner
that executes the far command locally, and runs the real channel loop under a local `sh`; the
mounted-mode tests run the same fake against a scaffolded mount point (the `isMounted` dep swapped).

When a proof run drives a model against a live target: Name exact paths. Never tell the model to read whatever find/ls returned; list freely, then read only a named file you have judged non-secret.

`argv.test.ts` needs no network. To check a live target:
`node check.ts entry.json`, then `pi --target <name>` and run `!hostname`.

Known limits: the target's `AGENTS.md` is not loaded into the prompt. `find` doesn't honour
`.gitignore` (it only skips `.git` and `node_modules`). Without `rg` on the target, `grep` uses
POSIX ERE (`grep -E`) rather than Rust regex syntax.
