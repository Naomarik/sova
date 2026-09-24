# sandbox

Confines what an agent's **tools** do to the machine, per session, on or off, only by the user.
`bash` runs inside an OS sandbox (Linux: bubblewrap); `read`, `write`, `edit`, `ls`, `find` and
`grep` check every canonical path against the same policy. The agent process itself is not
confined. Spec: `§chat/sandbox` (draft `sandbox-feature`).

## Contract (what Sova and the workers see)

| Surface | Shape |
|---|---|
| Command | `/sandbox on`, `/sandbox off`, bare `/sandbox` (shows the state). Sova calls the same handler through `extensionRunner.getCommand("sandbox")`. |
| Flag | `--sandbox on\|off`: the initial state of a new runtime. Workers get it from their parent. A session started with `--sandbox on` cannot turn it off (a parent's agent could otherwise send `/sandbox off` to its worker). |
| Entry | `custom` entry `sandbox`: `{version: 1, on, level, backend, enforcement, reasons?}` (`state.ts` `SandboxActive`), appended on every change; `restoreActive(branch)` reads the newest. Opening a session writes nothing, except when it comes up **on** without an entry saying so (the flag or `defaultOn`): then the state is pinned so a later default change cannot loosen it. |
| Workers | While on, the event carries `workerFlags` (`{sandbox: "on", "sandbox-parent": <ParentScope JSON>}`: the parent's level and writable roots, without its session tmp) and `checkWorker({cwd, backend})`, a refusal when the cwd is outside those roots (any backend) or the parent's sandbox is unavailable. A worker started with `--sandbox-parent` is on, writes exactly where its parent may (its own cwd is never added), and refuses every tool with `Sandbox: worker cwd <x> is outside the parent's sandbox` when its cwd is outside them. A malformed flag fails closed. Grandchildren inherit the same roots. |
| Presence | `extensionRunner.getCommand("sandbox") !== undefined`. |
| Event bus | `sandbox:state` (`SandboxStateEvent`: `on`, `extensionPath`, `enforcement`, `claudeSettingsJson?`, `claudePermissionMode?`, `claudeRefusal?`) on `session_start`, every change, and in answer to `sandbox:discover`. `on` is false under a remote target. Claude Code workers under on get `claudeSettingsJson` (the CLI's sandbox for Bash plus `Read`/`Edit` permission rules for the file tools, `tools.ts` `claudeSettingsFor`) and must run with `--permission-mode dontAsk`, never `bypassPermissions`, which skips the rules (`plan/PROBE.md`). `claudeRefusal` is set only when the sandbox is unavailable, or partial without `acceptPartial`. |

`state.ts` and `policy.ts` import node builtins only (and each other), so Sova's server may import
them like the mode trio.

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
`<worktree>/.agent`): the file tools refuse by canonical path, and the backend masks the files and
pins their ancestors.

## File tools

Paths resolve like pi's, then `/tmp` maps into the session tmp (bash sees that at `/tmp`) unless a
writable root is bound over it, then `canonicalize` (realpath of the deepest existing ancestor,
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

## Session resources

Per session: a tmp at `<os tmpdir>/pi-sandbox-<uid>/<session id>/tmp` (0700, ownership checked)
and, under `workspace-write`, the allowlisting proxy on a Unix socket (`proxy.ts`), started on the
first confined call. Both go at `session_shutdown`.

## Files

| File | Owner | Role |
|---|---|---|
| `index.ts` | extension | flag, command, restore, lazy registration, entry, events, session resources |
| `state.ts` | extension | the entry type, `restoreActive`, `parseOnOff`, event names, copy |
| `policy.ts` | extension | load/validate, tighten-only project file, canonical paths, read/write verdicts |
| `tools.ts` | extension | `stockDefinitions`, `confinedDefinitions`, `claudeSettingsFor` |
| `backend.ts`, `backends/*`, `env.ts`, `proxy.ts` | backend | the seam, bwrap, env allowlist, proxy |
| `tests/*.unit.test.ts` | extension | unit tests of the four files above (`index.unit.test.ts` drives the factory on a fake `pi`) |
| `tests/*` (other) | red-team | contract and escape suite |

## Tests

```sh
cd pi-config/extensions/sandbox && node --test tests/*.unit.test.ts
```

No model requests. `tools.unit.test.ts` includes one run through the real bwrap backend when
`/usr/bin/bwrap` exists.
