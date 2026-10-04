# sandbox

Confines what an agent's **tools** do to the machine, per session, in one of three states set by
the user (§chat.sandbox/states): **On** (the session's tools and its workers), **Subagents only**
(the default: the session's tools are pi's own, and only a worker in a tracked worktree is
confined, write-only) and **Off** (nothing is confined, workers included).
`bash` runs inside an OS sandbox (Linux: bubblewrap; macOS: Seatbelt); `read`, `write`, `edit`, `ls`, `find` and
`grep` check every canonical path against the same policy. The agent process itself is not
confined, except a worker of another backend (Claude Code), which runs whole inside the sandbox
through the generic launch seam (`launch.ts`, below). Spec: `§chat/sandbox`, `§chat.sandbox/workers`.

## Contract (what Sova and the workers see)

| Surface | Shape |
|---|---|
| Command | `/sandbox on`, `/sandbox subagents`, `/sandbox off`, bare `/sandbox` (shows the state). Sova calls the same handler through `extensionRunner.getCommand("sandbox")`. |
| Flag | `--sandbox on\|subagents\|off`: the initial state of a new runtime. Workers get it from their parent. A session started with `--sandbox on` cannot lower it (a parent's agent could otherwise send `/sandbox off` to its worker). |
| Entry | `custom` entry `sandbox`: `{version: 1, on, level, backend, enforcement, reasons?, workers?}` (`state.ts` `SandboxActive`; `workers: "off"` only with `on: false` is Off, an entry without it Subagents only, and `on: true` with it reads as On), appended on every change; `restoreActive(branch)` reads the newest. Opening a session writes nothing, except when it comes up **on** without an entry saying so (the flag or `defaultOn`): then the state is pinned so a later default change cannot loosen it. |
| Workers | Every worker start goes through ONE call, the event's `workerLaunch({cwd, root?, backend, owner})` (`state.ts` `WorkerLaunch`). It returns `{kind: "pi", extensionPath, flags}` for a pi worker (`{sandbox: "on", "sandbox-parent": <ParentScope JSON>}`: the parent's level, writable roots without its session tmp, and its read-only paths inside them, each tracked worktree's `.agent` included), `{kind: "confine", scope, module}` for any other backend (an opaque serializable scope plus the path of `launch.ts`), `{kind: "refused", reason}` (the cwd outside the parent's roots, the sandbox unavailable, or partial without `acceptPartial`), or `{kind: "none"}` (Subagents only and no tracked worktree, or Off for every worker; the event then carries `workers: "off"`, and the subagents gate accepts `none` for a worktree's worker only with it). A worker started with `--sandbox-parent` is on, writes exactly where its parent may (its own cwd is never added), and refuses every tool with `Sandbox: worker cwd <x> is outside the parent's sandbox` when its cwd is outside them. A malformed flag fails closed. Grandchildren inherit the same roots. |
| Worktrees | The worktrees extension's `worktrees:state` (`{version: 1, active: string[]}`) lists the session's active tracked worktrees. While on, each is a writable root of the session (and of its workers' scope), and each `<worktree>/.agent` stays read-only inside it (`ResolveInput.extraWritable` / `extraReadOnly`). `workerLaunch` with `root` set confines a worker started inside one of them, so it writes only there (its `.agent` read-only): on, the parent's scope narrowed to `root`; **off**, a write-only scope (`writeOnly: true`: no policy file is read, nothing is hidden, the network is the host's (`network.mode: "host"`, no `--unshare-net`) and the environment is passed as is; only writes are confined, to `root`, its git dirs and the session tmp; on Linux the host's `/tmp` stays visible read-only with every Unix socket in it masked (`Policy.hostTmp`, `tmpSockets`: the pathnames in `/proc/net/unix` under `/tmp`, canonicalised and still a socket by `lstat`, plus a walk of `/tmp` and the folders directly in it of at most `TMP_WALK_BUDGET` entries, for sockets bound from another namespace), `TMPDIR` names the worker's own tmp, and a list that cannot be read unambiguously (a malformed line, a relative path, a name with a line break) falls back to the private one); **Off**, `none`. Absent in a remote session. §chat.worktrees/workers. |
| Parent scope | `--sandbox-parent` also carries the parent's resolved `hidden`, `proxyAllow` and `envAllow`: a worker's hidden list is its own plus the parent's, and the two allowlists are the parent's, never the worker's own file's (a worktree's `.agent` may hold a looser one). |
| Presence | `extensionRunner.getCommand("sandbox") !== undefined`. |
| Event bus | `sandbox:state` (`SandboxStateEvent`: `on`, `extensionPath`, `enforcement`, `workerLaunch?`) on `session_start`, every change, and in answer to `sandbox:discover`. `on` is false under a remote target, and `workerLaunch` is absent there. |
| Confined launch | `launch.ts` (builtins only, no pi imports, so a hosting process imports it by path): `confineLaunch(scope, needs, {command, args, cwd, env})` returns `{command, args, env, spawnEnv, fds, tmpDir, tmpInside, enforcement, cleanup}` or `{refused}`. It resolves the worker's policy with `resolveSessionPolicy` from the scope (the same policy a pi worker gets there), probes the backend, starts a proxy of the worker's own, and wraps the command. `needs` is plain data, and nothing here knows what program it is: extra `writable` paths and `binds`, extra `proxyHosts` (the only ones under `read-only`), `env`, `secretEnv` and `fds` (never on argv or in a spawn env), `spawnEnv` (what the outer process shows outside, e.g. to a `/proc/<pid>/environ` scan), and `tmpDir`. On Linux every variable reaches bwrap over `--args FD`, never `--setenv`. `cleanup()` stops that launch's proxy; `releaseWorkerTmp(scope)` removes the worker's tmp (`workerTmpDir(scope)`, beside the parent's session tmp) when the worker closes. The Claude side (`claude-code/confined-launch.ts`) turns a login and a worker into `needs`. |

`state.ts` and `policy.ts` import node builtins only (and each other), so Sova's server may import
them like the mode trio. So does `session-policy.ts` (with `backend.ts`, `backends/*` and `env.ts`,
all builtins only): `resolveSessionPolicy({agentDir, cwd, sessionId, worktreeRoots?, parent?})` is the
one resolution of a session's policy (platform defaults, git-protected paths, shadowed caches, the
session tmp `sessionTmpDir(id)`, tracked worktrees with their `.agent` read-only). `snapshot()`
calls it before the proxy and the probe, and Sova's server calls it (`server/link-sandbox.ts`) to
refuse a linked-session file transfer the session's own tools could not make.

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

Always protected, whatever the file says: every `policy.json` under `<agentDir>/sandbox-policy` is
hidden, the directory itself (with the `CLAUDE.md` notes, which are written for an agent to read)
is read-only, and so is the whole agent dir (sessions, settings and extensions there run later
outside the sandbox). That holds when the agent dir is inside the workspace (the test server's
`<worktree>/.agent`): the file tools refuse by canonical path, and the backend masks (Seatbelt:
denies) the files and pins their ancestors.

## File tools

Paths resolve like pi's, then (Linux) `/tmp` maps into the session tmp (bash sees that at `/tmp`)
unless a writable root is bound over it, then `canonicalize` (realpath of the deepest existing ancestor,
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

## Backends

| Backend | `bash` runs under | Differences |
|---|---|---|
| `linux-bwrap` | `bwrap`: every namespace unshared, read-only binds, hidden paths masked, session tmp at `/tmp`, a relay to the proxy inside the empty network namespace | the reference; `localPorts` not implemented |
| `darwin-seatbelt` | `/usr/bin/sandbox-exec -f <profile>`, a Seatbelt profile generated per policy (a 0600 file named by its hash beside the session tmp; never inline `-p`) | no remapping: hidden paths are refused (EPERM) rather than emptied, no `/tmp` mapping (bash uses `$TMPDIR`), shadowed caches are read-only with the tool variables (`XDG_CACHE_HOME`, `npm_config_cache`, `MAVEN_OPTS`) pointed at the private copy; SBPL is last-match-wins, so the write rules go shallow to deep (`writeLayers`); mach services denied except a short allowlist, Keychain always denied; the proxy is reached through a host TCP relay on one loopback port, and `localPorts` are allowed; setuid programs cannot run |
| `unsupported` | nothing: every sandboxed tool refuses | Windows and the rest |

User-facing notes for macOS: `pi-config/sandbox-policy/darwin/CLAUDE.md`.

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
| `launch.ts` | extension | `confineLaunch`, `workerTmpDir`, `releaseWorkerTmp`: a worker process confined whole |
| `backend.ts`, `backends/*`, `env.ts`, `proxy.ts` | backend | the seam, bwrap, Seatbelt, env allowlist, proxy |
| `tests/unit/*.test.ts` | backend | unit tests of the backend files |
| `tests/*.unit.test.ts` | extension | unit tests of the four files above (`index.unit.test.ts` drives the factory on a fake `pi`) |
| `tests/*` (other) | red-team | contract and escape suite |

## Tests

```sh
cd pi-config/extensions/sandbox && node --test tests/*.unit.test.ts tests/unit/*.test.ts
```

No model requests. `tools.unit.test.ts` includes one run through the real bwrap backend when
`/usr/bin/bwrap` exists; `tests/unit/darwin-seatbelt.unit.test.ts` runs real `sandbox-exec` on
macOS (writes, git paths including a linked worktree, hidden paths, Keychain, loopback, probe).
