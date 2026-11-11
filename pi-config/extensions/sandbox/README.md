# sandbox

Confines what an agent's **tools** do to the machine, per session, in one of three states set by
the user (§chat.sandbox/states): **On** (the session's tools and its workers), **Subagents only**
(the default: the session's tools are pi's own, and only a worker in a tracked worktree is
confined, write-only) and **Off** (nothing is confined, workers included).
`bash` runs inside an OS sandbox (Linux: bubblewrap; macOS: Seatbelt); `read`, `write`, `edit`, `ls`, `find` and
`grep` check every canonical path against the same policy. The agent process itself is not
confined (a Claude Code worker included: it is a pi worker, and its tools are pi's). The generic
launch seam that runs a whole process inside the sandbox (`launch.ts`, below) stays, though no
worker uses it today. Spec: `§chat/sandbox`, `§chat.sandbox/workers`.

## Contract (what Sova and the workers see)

| Surface | Shape |
|---|---|
| Command | `/sandbox on`, `/sandbox subagents`, `/sandbox off`, bare `/sandbox` (shows the state, then a second line about the cache copies), `/sandbox clean [all]` (cleans the cache copies now, changes no state); anything else answers `usage: /sandbox on \| subagents \| off \| clean [all]`. Sova calls the same handler through `extensionRunner.getCommand("sandbox")`, only ever with a state. |
| Flag | `--sandbox on\|subagents\|off`: the initial state of a new runtime. Workers get it from their parent. A session started with `--sandbox on` cannot lower it (a parent's agent could otherwise send `/sandbox off` to its worker). |
| Entry | `custom` entry `sandbox`: `{version: 1, on, level, backend, enforcement, reasons?, workers?}` (`state.ts` `SandboxActive`; `workers: "off"` only with `on: false` is Off, an entry without it Subagents only, and `on: true` with it reads as On), appended on every change; `restoreActive(branch)` reads the newest. Opening a session writes nothing, except when it comes up **on** without an entry saying so (the flag or `defaultOn`): then the state is pinned so a later default change cannot loosen it. Turning On when the newest entry isn't already On first appends a provisional entry `{on: true, enforcement: "unavailable", reasons: ["starting"]}` (`SANDBOX_STARTING`, `isStarting`) before the confined tools are registered, then the real state after the probe, also when the probe fails or throws: whenever the tools are confined, the newest entry says On. A provisional entry left newest by an interrupted start is not a record, so the next start records the real state. Changes run one at a time. `describeActive` reads it as "Sandbox turning on…". |
| Workers | Every worker start goes through ONE call, the event's `workerLaunch({cwd, root?, backend, owner})` (`state.ts` `WorkerLaunch`). It returns `{kind: "pi", extensionPath, flags}` for a pi worker (`{sandbox: "on", "sandbox-parent": <ParentScope JSON>}`: the parent's level, writable roots without its session tmp, and its read-only paths inside them, each tracked worktree's `.agent` included), `{kind: "confine", scope}` for any other backend (the opaque serializable scope its whole process would run under, `launch.ts`; the subagents extension refuses such a start), `{kind: "refused", reason}` (the cwd outside the parent's roots, the sandbox unavailable, or partial without `acceptPartial`), or `{kind: "none"}` (Subagents only and no tracked worktree, or Off for every worker; the event then carries `workers: "off"`, and the subagents gate accepts `none` for a worktree's worker only with it). A worker started with `--sandbox-parent` is on, writes exactly where its parent may (its own cwd is never added), and refuses every tool with `Sandbox: worker cwd <x> is outside the parent's sandbox` when its cwd is outside them. A malformed flag fails closed. Grandchildren inherit the same roots. |
| Worktrees | The worktrees extension's `worktrees:state` (`{version: 1, active: string[]}`) lists the session's active tracked worktrees. While on, each is a writable root of the session (and of its workers' scope), and each `<worktree>/.agent` stays read-only inside it (`ResolveInput.extraWritable` / `extraReadOnly`). `workerLaunch` with `root` set confines a worker started inside one of them, so it writes only there (its `.agent` read-only): on, the parent's scope narrowed to `root`; **off**, a write-only scope (`writeOnly: true`: no policy file is read, nothing is hidden, the network is the host's (`network.mode: "host"`, no `--unshare-net`) and the environment is passed as is; only writes are confined, to `root`, its git dirs, the session tmp and the private copies (caches, tool state); on Linux its `/tmp` is its own session tmp, exactly as On's (`TMPDIR=/tmp`, short enough for any Unix socket path): `bash` no longer sees the host's `/tmp` or its sockets, writes there land in the private tmp, and the file tools map `/tmp/x` to the same place, while a file-tool **read** of a `/tmp` path the private tmp lacks still falls back to the host's (a brief another chat left there). Nothing in the host's `/tmp` is scanned or masked, so a socket vanishing there can never stop a command from starting. On macOS nothing is remapped: a literal `/tmp` stays refused and `TMPDIR` names the session tmp); **Off**, `none`. Absent in a remote session. §chat.worktrees/workers. |
| Parent scope | `--sandbox-parent` also carries the parent's resolved `hidden`, `proxyAllow` and `envAllow`: a worker's hidden list is its own plus the parent's, and the two allowlists are the parent's, never the worker's own file's (a worktree's `.agent` may hold a looser one). `browser: true` (only a literal `true` parses) is the parent's policy `browser`, the same way: a worker's is its parent's. A write-only scope gets it from the parent's own policy file and its cwd's project file (`parentBrowser`), read when the worker starts; a file that cannot be read means no browser, and the worker still starts write-only. |
| Stand-in cwd | `--sandbox-cwd-not-writable` (boolean, Sova sets it on a session that runs in the home folder because its own folder is gone): the cwd is not a writable root; the session writes only in its tmp, the policy's `writable` roots and its tracked worktrees, and its workers' scope carries the same roots. `resolveSessionPolicy({cwdWritable: false})` is the same rule for a caller outside the extension. |
| Presence | `extensionRunner.getCommand("sandbox") !== undefined`. |
| Event bus | `sandbox:state` (`SandboxStateEvent`: `on`, `extensionPath`, `enforcement`, `workerLaunch?`) on `session_start`, every change, and in answer to `sandbox:discover`. `on` is false under a remote target, and `workerLaunch` is absent there. |
| Confined launch | `launch.ts` (builtins only): `encodeLaunchScope`/`decodeLaunchScope`, the `confine` answer's scope (the parent's scope as a pi worker in that cwd gets it, its agent dir, session and owner). Nothing launches a whole worker process confined: the subagents extension refuses a backend other than pi while the sandbox is on or the start is worktree-confined, and a Claude Code worker is a pi worker. The launcher that ran one (`confineLaunch`, for the retired native Claude Code worker) is gone. |

`state.ts` and `policy.ts` import node builtins only (and each other), so Sova's server may import
them like the mode trio. So does `session-policy.ts` (with `backend.ts`, `backends/*` and `env.ts`,
all builtins only): `resolveSessionPolicy({agentDir, cwd, sessionId, worktreeRoots?, parent?})` is the
one resolution of a session's policy (platform defaults, git-protected paths, shadowed caches, the
session tmp `sessionTmpDir(id)`, tracked worktrees with their `.agent` read-only). `snapshot()`
calls it before the proxy and the probe, and Sova's server calls it (`server/link-sandbox.ts`) to
refuse a linked-session file transfer the session's own tools could not make.

`prepareSessionCommand(input, argv, {env?})` is the runtime-free whole-command seam for a
server-hosted recording tool. Trusted session input includes the worker's parent tightening and
tracked worktrees. It resolves the same policy, owns a fresh attempt tmp and allowlisting proxy,
probes the exact backend profile (the policy's `browser` included, as `snapshot()` passes it), and
returns confined argv/env/inherited-fd payloads plus `dispose()`. An unavailable or unaccepted partial backend refuses; a failed proxy tightens to no
network. The caller runs the whole recording controller and its browser under that argv, writes
fd payloads, reaps them before disposal, and never substitutes an unconfined command on failure.
It does not call an extension command handler or change the session's sandbox state. A caller's own
`tmpDir` (a macOS recording's short one) replaces that attempt tmp, and the proxy socket goes beside
it, since a socket under a long `TMPDIR` would mean no network.

`{proxy?}` passes attempt-only options to that attempt's own proxy (`proxy.ts`), all off by
default; the session's own proxy never gets them and nothing changes without them. `forbid(address)`
refuses more resolved addresses on top of `forbiddenAddress` (a recording refuses every non-public
one: private, carrier-grade NAT, unique-local, IPv4-mapped); names are still resolved only after
they pass the allowlist, and the proxy connects to the address it checked. `local {host, port,
admit}` lets the proxy reach exactly one loopback host:port outside the allowlist (a project tour's
own verified running copy), calling `admit()` on every contact; false or a throw refuses that
contact, and the exception ends with the attempt's proxy. `admit(host, port)` is asked for every
contact before any lookup, allowlist answer or dial; false, a throw or a rejection refuses it.

## Off is pi as it is

A session that has never been on registers **no tool**: the registry is pi's built-ins and every
call is pi's own. On registers the seven confined definitions: pi's stock definitions (same
factories, same options) with sandboxed operations underneath, so the names, descriptions,
parameters, prompt snippets and guidelines are byte-identical and the system prompt does not change
on a flip (no cache bust, no Claude CLI restart). Off after on re-registers pi's stock factory
definitions with the SDK's options (`shellPath`, `shellCommandPrefix`, `images.autoResize` from the
settings), because pi has no unregister; until the session is next opened those seven report
`sourceInfo.source === "extension"`.

A flip reaches the **next** tool call. Each confined call takes one snapshot at its start (policy
re-read, proxy up, probe cached per policy by the backend); a running command finishes under the
rules it started with.

## Fail closed

The snapshot fails when the policy file is missing, malformed or has an unknown key, the session
tmp cannot be made, or the backend's probe of the exact profile fails (or the platform has no
backend). Then every tool errors with `Sandbox unavailable: {reason}. Nothing ran. Turn the sandbox
off to run tools unconfined.` It never falls back to running unconfined. Under a remote target the
remote extension owns the seven tools; the sandbox registers nothing and records
`not enforced on remote`.

## Policy

`<agentDir>/sandbox-policy/<platform>/policy.json` (agent dir = pi's `getAgentDir()`, i.e.
`PI_CODING_AGENT_DIR` or `~/.pi/agent`), seeded by **copy** from `pi-config/sandbox-policy/` by
`install.sh` (and `scripts/hermetic-agent-dir.mjs` for a test agent dir). Keys and their meaning:
`pi-config/sandbox-policy/linux/CLAUDE.md`. Re-read on every tool call (mtime-cached). A project's
`<cwd>/.sova/sandbox.json` may only tighten (`policy.ts` `applyProjectTightening`); loosening keys
are ignored with a notice.

`browser` is the one optional key: `"none"` (the template's, and the meaning when absent) or
`"headless-shell"`; anything else fails closed. It becomes `ResolvedPolicy.browser` and
`Policy.browser` (part of `policyKey`, so the probe re-runs), and the Seatbelt profile adds
`BROWSER_RULES` for Playwright's `chrome-headless-shell` run with `--no-sandbox`
(`pi-config/sandbox-policy/darwin/CLAUDE.md` has the tradeoff). A project file may set `"none"`;
its `"headless-shell"` is ignored with the notice.

Always protected, whatever the file says: every `policy.json` under `<agentDir>/sandbox-policy` is
hidden, the directory itself (with the `CLAUDE.md` notes, which are written for an agent to read)
is read-only, and so is the whole agent dir (sessions, settings and extensions there run later
outside the sandbox). That holds when the agent dir is inside the workspace (the test server's
`<worktree>/.agent`): the file tools refuse by canonical path, and the backend masks (Seatbelt:
denies) the files and pins their ancestors.

The chat's shared folder (`shared-folder.ts`): `~/.local/state/sova/shared/<session id>`, outside
the agent dir and every repository, is a writable root of every confined session that knows it
(On or write-only; never at the read-only level). A top-level chat's is its own, by its session id
(`resolveSessionPolicy`); a worker's rides in its scope as `ParentScope.shared` (the root chat's,
at every depth; `narrowScope` and `parentScopeOf` keep it, never as a plain writable root). Its
`teams/` is read-only; `ParentScope.note`, a team member's own note folder inside `teams/`, is
writable for that member alone and never handed on (a note folder anywhere else is ignored). The
folder and the note folder are made before a worker starts (a missing path can't be bound).

## File tools

Paths resolve like pi's, then (Linux, On and write-only alike) `/tmp` maps into the session tmp
(bash sees that at `/tmp`) unless a writable root is bound over it; a read of a `/tmp` path the
session tmp lacks stays at the host's `/tmp` (pi's own truncated-output files, a brief another chat
left there). Then `canonicalize` (realpath of the deepest existing ancestor,
dangling links followed). Reads are refused under `hidden`. Writes are refused outside the
writable roots, under `hidden` or `readOnlyWithinWritable`, and when creating an ancestor of a
protected path; they open the checked canonical path with `O_NOFOLLOW`. `find` and `grep` (pi
spawns fd/rg itself) are pinned to the checked absolute root, and output lines under hidden paths
are dropped with a note. Refusals end with `[sandbox: …]`.

These checks run in the agent process: policy-enforced, not OS-enforced. A directory swapped for
a link between the check and the write is a residual race (only a confined `bash` could race it).
Writes also pass the backend's own `checkWrite` (the same write set its mounts use: git paths,
trust stores), and a path under a shadowed cache is read and written at its private copy.

Known gap (decided, plan OQ9): in a linked worktree the main checkout's git dir is writable so
commits work, so a sandboxed session can move other branches' refs there. Its hooks, config,
`HEAD`, index and the other worktrees' admin dirs stay read-only.

## Tool state (mise, pnpm)

Beside the policy's `shadowed` caches, the backend's `privateState` (`PlatformDefaults`) gets a
private copy for every confined session, On and write-only alike, whatever the policy file says:
Linux `~/.local/state/mise`, `~/.local/state/pnpm`, `~/.local/share/pnpm/store` and
`~/.local/share/pnpm/package-manager-store`; macOS `~/.local/state/mise` (through `MISE_STATE_DIR`).
A `writable` entry at or inside one (older templates listed `~/.local/state/mise`) is dropped, never
failing closed; the file's own `writable` inside its own `shadowed` still does.

- **mise.** Before each command `seedShadow` links every host trust and ignore entry
  (`trusted-configs`, `ignored-configs`) into the copy and removes one it linked earlier that the
  host has since removed (`<copy>.seeded.json` beside the copy names them: a file in the shadow root,
  which the cleanup never removes, so a pruned trust dir is re-seeded and a host removal still
  mirrored), so the sandbox trusts what the host trusts. The host trust stores (`trustStores`) stay pinned read-only wherever a real
  writable root holds them, but not inside a copy, which no host tool reads: `mise trust` and mise's
  tracking list write only the copy, and the host's trust list never changes. The copy is shared
  by every sandboxed session, as the caches are, so a config one confined session trusts is trusted
  in every other one (never on the host).
- **pnpm.** Its store, its own package-manager downloads and its state live in the copies, so an
  install works in a worker (the first one downloads cold). Global installs
  (`~/.local/share/pnpm/global`) stay read-only.
- **Cleanup.** These copies are tool caches for the cache cleanup (`toolCacheDays`, removed after
  the scratch entries).
- **Paths.** The default locations only: a host that moves mise's or pnpm's state elsewhere
  (`MISE_STATE_DIR`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, a store-dir setting) gets no copy of it on
  Linux, where those stay read-only as before; on macOS `MISE_STATE_DIR` names the copy whatever the
  host's says.
- **The denial note.** `classifyRun` drops mise's `tracking config` warning (`BENIGN_DENIAL_LINES`)
  before matching the denial signatures: that warning alone never earns
  `[sandbox: a write or connection outside the policy was refused]`.

## Backends

| Backend | `bash` runs under | Differences |
|---|---|---|
| `linux-bwrap` | `bwrap`: every namespace unshared, read-only binds, hidden paths masked, session tmp at `/tmp`, a relay to the proxy inside the empty network namespace | the reference; `localPorts` not implemented |
| `darwin-seatbelt` | `/usr/bin/sandbox-exec -f <profile>`, a Seatbelt profile generated per policy (a 0600 file named by its hash beside the session tmp; never inline `-p`) | no remapping: hidden paths are refused (EPERM) rather than emptied, no `/tmp` mapping (bash uses `$TMPDIR`), shadowed caches are read-only with the tool variables (`XDG_CACHE_HOME`, `npm_config_cache`, `MAVEN_OPTS`) pointed at the private copy; SBPL is last-match-wins, so the write rules go shallow to deep (`writeLayers`); mach services denied except a short allowlist, Keychain always denied; the proxy is reached through a host TCP relay on one loopback port, and `localPorts` are allowed; setuid programs cannot run; the policy's `browser` adds `BROWSER_RULES` (the `RootDomainUserClient` IOKit client, the `org.chromium.Chromium.MachPortRendezvousServer.` names) right after the mach allowlist, before the hidden paths and the Keychain deny; linux-bwrap ignores `browser` with a note |
| `unsupported` | nothing: every sandboxed tool refuses | Windows and the rest |

**Git's background cleanup.** Every process a sandboxed command starts ends with it, so a
`git maintenance run --auto --detach` started by a commit, merge or fetch would be killed partway
(a killed run can leave `objects/pack/multi-pack-index.lock` behind, and every later run then writes
a whole pack and gives up). Both backends add `GIT_CONFIG_SYSTEM` after the allowlist, naming
`sova-no-background-cleanup.gitconfig` in the session tmp (`$TMPDIR` inside): the machine's own
system config copied in, then `maintenance.auto = false` and `gc.auto = 0` (`env.ts`
`addGitCleanupEnv`), and drop `GIT_CONFIG_NOSYSTEM`. It is git's lowest level: a repository's or the
user's own `maintenance.auto`/`gc.auto`, `-c`, or a command's own `GIT_CONFIG_SYSTEM` or
`GIT_CONFIG_NOSYSTEM` still override it; a command's own `GIT_CONFIG_COUNT` does not drop it. The
file holds no `[include]` of its own (a machine config with includes is included by path instead).
Sova's server gives its chat processes the same file through `writeGitCleanupConfig`.

User-facing notes for macOS: `pi-config/sandbox-policy/darwin/CLAUDE.md`.

## Cache cleanup

The shadowed caches' private copies (`<agentDir>/sova/sandbox/shadow/<name>`, `backend.ts`
`shadowSource`) are cleaned by `shadow-prune.ts` (builtins only, imports nothing, not even its
siblings). Spec: §chat.sandbox/cache-cleanup.

- **When.** `session_start` of a chat that comes up On (not remote) calls `startAutoPrune`: at most
  once per 24 h per agent dir (the stamp's `lastRun`/`lastAttempt`), never awaited, never throws.
  `/sandbox clean` (mode `clean`) ignores the throttle; `/sandbox clean all` (mode `all`) removes
  every entry not used in the last hour, tool caches included. Both wait for the result line and are
  refused (`BUSY_TEXT`) while the lock is held.
- **Where it runs.** A detached child (`shadow-prune-run.ts`, the runtime that runs the extension:
  bun, or node with type stripping) under `nice -n 19` and, on Linux, `ionice -c3`, where found, plus
  `os.setPriority(19)` in the child. The walk never runs in the chat's process.
- **Units.** Each top-level entry of each shadow dir (`home-.cache/pnpm`, `home-.npm/_cacache`, an
  older layout's entries). A shadow dir itself is a live bind source and is never removed. Tool
  caches: every entry of `home-.npm`, `home-.m2` and the mise and pnpm state copies ("Tool state"),
  and the `toolCaches` names in `home-.cache`. A file in the shadow root (a seeded list) is no unit.
- **Measure.** `lstat` only, never following a link, never leaving the shadow dir's `st_dev`. Size is
  `st_blocks * 512`, a hard-linked file counted once (by dev and inode) over the whole scan. Recency
  is the newest regular file's mtime (protected 24 h) and atime (protected 48 h); directory atimes
  never count (the walk moves them), and directory and link mtimes count only for an entry holding no
  regular file.
- **Plan** (`planPrune`, pure). By age: scratch after `scratchDays` unused, tool caches after
  `toolCacheDays`. Then by size: while over the cap, least recently used first, every scratch entry
  before any tool cache. The cap is `max(2 GiB, min(maxSizeGB GiB, 5% of statfs total, 5% of statfs
  free))`, with the bound that set it (`setting`, `disk`, `free`, `floor`). Protected entries are
  never removed; `overCap` records that the copies stayed over the cap.
- **Delete.** Each chosen entry is renamed into `<agentDir>/sova/sandbox/shadow-trash/<ts>-<i>-<name>`
  (skipped if its own mtime moved since the scan), the stamp is written, the result reported, and
  only then is the trash deleted. Each run first empties what an earlier one left there.
- **Lock.** `<agentDir>/sova/sandbox/shadow-prune.lock`, created `O_EXCL`, holding the pid; touched
  as a heartbeat during the walk and the delete. It stops blocking once older than 2 h or once its pid
  is gone.
- **Stamp.** `<agentDir>/sova/sandbox/shadow-prune.json`: `{version: 1, lastRun, lastAttempt, mode,
  freed, sizeBefore, size, cap, capReason, overCap, removed, errors?}`. Bare `/sandbox` reads its
  caches line from it (`cachesLine`), never walking the caches.
- **Settings.** `<agentDir>/sandbox-policy/<platform>/caches.json` (template beside `policy.json` in
  `pi-config/sandbox-policy/`): `on`, `maxSizeGB`, `scratchDays`, `toolCacheDays`, `toolCaches`.
  Missing: the defaults. Invalid (not JSON, an unknown key, a wrong value): cleanup off, with the
  notice `Sandbox: \`caches.json\` is invalid ({error}); cache cleanup is off. The sandbox is
  unaffected.`; the sandbox never fails closed on it. `policy.json` and its strict validator do not
  know these keys, and a project's `.sova/sandbox.json` cannot set them (ignored with the usual
  notice).

## Session resources

Per session: a tmp at `<os tmpdir>/pi-sandbox-<uid>/<session id>/tmp` (0700, ownership checked)
and, under `workspace-write`, the allowlisting proxy on a Unix socket (`proxy.ts`), started on the
first confined call. Both go at `session_shutdown`. On macOS the Seatbelt profile sits beside the
tmp, and a host TCP relay to the proxy socket lives until that socket is gone.

## Files

| File | Owner | Role |
|---|---|---|
| `index.ts` | extension | flag, command, restore, lazy registration, entry, events, session resources |
| `state.ts` | extension | the entry type, `restoreActive`, `parseOnOff`, event names, copy |
| `policy.ts` | extension | load/validate, tighten-only project file, canonical paths, read/write verdicts |
| `tools.ts` | extension | `stockDefinitions`, `confinedDefinitions` |
| `launch.ts` | extension | `encodeLaunchScope`, `decodeLaunchScope`: the `confine` answer's scope |
| `shadow-prune.ts`, `shadow-prune-run.ts` | extension | the cache copies' cleanup: settings, scan, plan, lock, stamp, the low-priority child and its entry point, the `/sandbox` lines |
| `backend.ts`, `backends/*`, `env.ts`, `proxy.ts` | backend | the seam, bwrap, Seatbelt, env allowlist and the git cleanup config, proxy |
| `tests/unit/*.test.ts` | backend | unit tests of the backend files, and of `shadow-prune.ts` (`shadow-prune.unit.test.ts`, in-process, temp dirs only; its real child process in `shadow-prune.integration.test.ts`) |
| `tests/*.unit.test.ts` | extension | unit tests of the four files above (`index.unit.test.ts` drives the factory on a fake `pi`) |
| `tests/*` (other) | red-team | contract and escape suite |

## Tests

```sh
cd pi-config/extensions/sandbox && node --test tests/*.unit.test.ts tests/unit/*.test.ts
```

No model requests. `tools.unit.test.ts` includes one run through the real bwrap backend when
`/usr/bin/bwrap` exists; `tests/unit/darwin-seatbelt.unit.test.ts` runs real `sandbox-exec` on
macOS (writes, git paths including a linked worktree, hidden paths, Keychain with and without the
browser rules, loopback, probe). `tests/unit/darwin-seatbelt-browser.integration.test.ts` runs the
real `chrome-headless-shell` under the real profile (a write-only worker's and an On session's):
a screenshot lands with `browser: "headless-shell"`, and the shell crashes without it. It takes
the binary from `SANDBOX_TEST_HEADLESS_SHELL`, else the newest Playwright revision installed, never
an app-bundle Chrome, and skips with the reason off macOS, without the shell, or inside a sandbox
(Seatbelt cannot nest).
