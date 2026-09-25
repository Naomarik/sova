# §chat/sandbox — Sandbox
> Part of the Sova design spec · [overview](../design/overview.md)

pi's sandbox extension (`pi-config/extensions/sandbox`) confines what an agent's **tools** do to
the machine: the `bash` tool runs inside an OS sandbox, and the file tools (`read`, `write`,
`edit`, `ls`, `find`, `grep`) check every path against the same policy. The agent process itself
is not confined; the server and every worker keep their own state writable. The sandbox is **on
or off per session**, and only the user turns it either way.

It is local containment of an agent's mistakes on a single-user machine. It is not a boundary
for hostile code and has not been security-audited (§chat.sandbox/limits).

## §chat.sandbox/toggle — The toggle

- **Where.** In pi, `/sandbox on` and `/sandbox off` flip it, and bare `/sandbox` (or
  `/sandbox status`) reports the current state; anything else answers with the usage line. A
  runtime started with `--sandbox on|off` starts in that state. How another host (such as Sova's
  web composer) offers the toggle is that host's own surface; it drives the same command.
- **Status.** While on, the TUI footer shows `sandbox on`, or `sandbox on (partial)`,
  `sandbox on (unavailable)`, or in a remote session `sandbox on (not enforced on remote)`. Off
  shows nothing. Bare `/sandbox` prints the extension's status line: "Sandbox off", "Sandbox on ·
  workspace-write · full enforcement", "Sandbox on · workspace-write · partial enforcement
  ({reasons})", "Sandbox on · workspace-write · unavailable: {reasons} (tools refuse)", or, for a
  session that is on but enforced nowhere (a remote session), "Sandbox on · not enforced on
  remote" ("Sandbox on · not enforced" when no reason is recorded).
- **Effect.** A flip reaches **this session only**, from its **next tool call**. A tool call
  already running finishes under the rules it started with; nothing is killed, and no turn is
  interrupted. A batch of parallel calls already started runs under the old state and the next
  batch under the new one. The session never restarts, reconnects or loses its workers.
- **Nothing the model sees changes on a flip.** Confined tools keep exactly the stock tool
  names, descriptions and parameters, and the system prompt is the same on or off. The sandbox
  shows only in tool results (a denial note, below) and in the session's own `sandbox` entry.
  A changed tool list or prompt would bust the prompt cache and make a Claude-backed session
  restart its CLI.
- **Persistence.** Each change appends a `custom` entry `sandbox`
  `{version: 1, on, level, backend, enforcement, reasons?}`; opening the session restores the
  newest one on its branch. A session with no entry takes the `--sandbox` flag, else the policy
  file's `defaultOn`, which ships as `false`. Opening a session writes nothing, except when it
  comes up on with no entry saying so: then one entry pins it on, so a later change to
  `defaultOn` cannot loosen that session.
- **Marker.** Each change is rendered in the TUI transcript from its `sandbox` entry: "Sandbox → on ·
  workspace-write · full enforcement", or "Sandbox → off". On, it names the level and the
  enforcement, and `partial` or `unavailable` add " · {reasons}". An entry that is on but
  enforced nowhere (a remote session) reads "Sandbox → on · not enforced on remote" ("Sandbox → on ·
  not enforced" when no reason is recorded), never "none enforcement". `/sandbox on` while already on
  probes again and records an entry only if the state changed.
- **Only the user flips it.** The agent has no tool that changes the state; `/sandbox` is a
  command, not a tool. A sandboxed `bash` cannot reach Sova's API (its network is unshared), so it
  cannot flip the toggle through the server either. A worker started with the sandbox on cannot
  turn it off (§chat.sandbox/workers).

## §chat.sandbox/off-is-today — Off is Sova as it is today

Off, every tool behaves exactly as it does without the extension installed. In a session that
has never been on, the extension registers no tools: the registry is pi's own built-ins, and a
`bash` command runs in the host's own mount namespace with the host's environment.

After on → off in the same session, pi cannot unregister a tool, so the seven names stay
registered by the extension but are built by pi's own stock factories with the same options pi
uses: no policy, no backend, no wrapper. The only visible difference until the session is next
opened is that pi reports those tools' source as the extension rather than built-in.

## §chat.sandbox/what-on-enforces — What on enforces

On means the policy file's `level`: `workspace-write` by default, `read-only` if the file says
so. It is not a choice in the UI. Under `workspace-write`:

- **Filesystem.** The whole filesystem is readable and read-only, except the session's cwd, a
  per-session tmp mounted as `/tmp`, and the policy's `writable` roots (`~/.local/state/mise` in
  the shipped policy). `read-only` drops the cwd and the `writable` roots from that list.
- **Shadowed caches.** Build caches (`~/.cache`, `~/.npm`, `~/.m2`: the policy's `shadowed`) are
  the sandbox's own private copies, kept between sessions; nothing written there reaches the
  host's caches. Each copy lives under `<agentDir>/sova/sandbox/shadow/`, is shared by all
  sandboxed sessions and is mounted at the cache's usual path, so host tools that later run
  cached code (build dirs, editor bytecode, npx packages, Maven plugins) never see what the
  sandbox wrote, and the host's own cache is not visible inside. They start cold: the first
  install or build in the sandbox downloads what the host already had. The file tools see the
  same copies as `bash`. A `writable` entry at or inside a shadowed path is a policy error, and
  the sandbox fails closed on it. Under `read-only` nothing is shadowed and the caches are
  read-only.
- **Hidden secrets.** Credential directories read as empty and read-only (`~/.ssh`, `~/.gnupg`,
  `~/.aws`, `~/.docker`, `~/.config/gh`), and credential files cannot be opened at all
  (`~/.netrc`, `~/.git-credentials`, pi's `auth.json`, Claude Code's credentials). The list is
  the policy's `hidden`.
- **Hidden service sockets.** Nothing served by a process outside the sandbox is reachable:
  `/run` (and so `/run/user/<uid>`: the user's D-Bus and systemd, gpg-agent, Wayland) is empty, the
  Docker socket is gone, and abstract Unix sockets and every host TCP port, Sova's API included,
  are cut off by a private network namespace.
- **Network through an allowlisting proxy.** The only way out is a per-session HTTP/CONNECT proxy
  whose allowlist defaults to GitHub and the package registries (npm, PyPI, crates, Maven
  Central and Clojars, the Go proxy) and is the user's to edit. Only ports 80 and 443 by default,
  and an allowlisted name that resolves to a loopback, link-local or unspecified address is
  refused too. Any other host is refused with a 403 and a visible message. A tool that ignores
  proxy variables cannot connect at all. If the proxy cannot be reached inside (its relay or its
  socket is missing), the network is **none**, with a note, never the host's; enforcement stays
  `full`, because that is a tightening.
- **Git's delayed-execution files.** Inside the writable tree, `.git/hooks`, `.git/config`,
  `.git/config.worktree`, `.git/worktrees/`, each submodule's `.git/modules/*/hooks` and `config`,
  a `.git` gitfile and a linked worktree's `commondir` are read-only, so the agent cannot plant a
  hook or a `core.hooksPath` that runs later outside the sandbox. `git config --local` fails by
  design; commits work. In a linked worktree, its gitdir and the common dir are writable so
  commits work, while the main checkout's hooks, config, `HEAD` and index stay read-only.
- **Host trust stores.** mise's trusted and tracked configs and direnv's allow and deny lists are
  always read-only when they fall inside a writable root, created first if missing, and their
  parent folders cannot be renamed. The policy file cannot turn this off. Otherwise the agent
  could mark the project's `.mise.toml` or `.envrc` trusted, and the user's host shell would run
  it on the next `cd`.
- **Protected paths cannot be moved aside.** Every ancestor of a protected path inside the
  writable tree is pinned, so renaming `.git`, or a directory that contains the policy, fails
  ("Device or resource busy") instead of letting a fresh copy be planted in its place.
- **Environment allowlist.** Commands see only allowlisted variables (`PATH`, `HOME`, locale,
  `TERM`, `TZ`, `TMPDIR`, pi's own `PI_*`, toolchain homes, the proxy variables). Everything else
  is dropped: session-bus and agent sockets, `DISPLAY`, `TMUX`, provider API keys, tokens.
- **The file tools see the same view.** For `read`, `write`, `edit`, `ls`, `find` and `grep`,
  `/tmp` is the session tmp, as it is for `bash`, except where a writable root sits under `/tmp`.
  `find` and `grep` drop results under hidden paths and say how many they dropped.
- **Denials are ordinary tool failures.** A blocked write or connection returns the command's
  real output plus a trailing note naming the sandbox, which the model reads like any failure. A
  failure of the sandbox itself (the command never ran) is a tool error naming the sandbox, never
  passed off as command output.
- **Credentialed actions fail cleanly.** With no keys, agent socket or credentials visible,
  `git push` fails; the user pushes, or turns the sandbox off.
- **On macOS** the same policy is enforced by Seatbelt, which filters operations but cannot
  remap paths, so a few effects differ. Hidden paths are refused ("Operation not permitted")
  rather than read as empty, and the Keychain files and the securityd services are always
  denied, whatever the policy lists. There is no private `/tmp`: a literal `/tmp` is not
  writable, for `bash` or the file tools, and `TMPDIR` points `bash` at the session tmp.
  Shadowed caches are reached through the environment: the host `~/.cache`, `~/.npm` and `~/.m2`
  are read-only, and `XDG_CACHE_HOME`, `npm_config_cache` and Maven's local repository point at
  the private copies.
  Protected paths and their ancestors cannot be renamed ("Operation not permitted"). The network
  is denied except one loopback port, a host-side relay to the session's proxy, plus the
  policy's `localPorts`; there is no DNS, nothing can listen on a TCP port, and Unix sockets work
  only under the writable roots, so ssh-agent, Docker, launchd's and mDNSResponder's sockets and
  every other host port, Sova's API included, are unreachable. Mach services are denied except a
  short allowlist (user lookups, notifications, logging, certificate checks), so the pasteboard,
  Apple events and the GUI do not work, and setuid programs (`sudo`, `ps`) cannot run.

## §chat.sandbox/fail-closed — Fail closed

Before confining, the backend probes the exact profile it will use. If the probe fails, or the
platform has no backend, the tools **refuse** with an error naming the sandbox and the reason,
and the state reads `unavailable: {reason}`. They never fall back to running unconfined. The
refusal lasts until the user turns the sandbox off or the cause is fixed.

When some promised effect cannot be governed on this machine, enforcement is `partial` with its
reasons, shown in the status and in the marker. An unattended worker refuses to start under
`partial` unless the policy sets `acceptPartial: true`.

## §chat.sandbox/policy-file — The policy file

The policy is `<agentDir>/sandbox-policy/<platform>/policy.json`, with a `CLAUDE.md` beside it,
where `<agentDir>` is pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). It is a
real directory, seeded by **copying** the repo template `pi-config/sandbox-policy/` when absent,
never a link into the repo: a policy inside a checkout would be writable whenever that checkout
is the workspace. `install.sh --check` reports drift from the template and never overwrites it.

- **Keys.** `version`, `level`, `defaultOn`, `writable`, `hidden`, `readOnlyWithinWritable`,
  `shadowed`, `proxy` (`allow`), `env` (`allow`), `acceptPartial`.
- **Re-read on every tool call.** An edit applies to the next tool call of every session.
- **Never writable from inside.** The whole agent directory is read-only (it holds sessions,
  settings and extensions that pi runs later outside the sandbox), `<agentDir>/sandbox-policy/`
  included. Each `policy.json` there is also hidden; each `CLAUDE.md` stays readable. The file tools refuse those canonical
  paths too. This holds even when the session's cwd contains the agent directory.
- **Its `CLAUDE.md`** explains each key, says per-project files may only tighten, and opens by
  telling an agent that it cannot edit the policy from inside the sandbox by design and should
  ask the user instead of working around it. The `darwin/` copy explains what Seatbelt enforces
  differently on macOS (§chat.sandbox/what-on-enforces).

## §chat.sandbox/project-tightening — Per-project config only tightens

A project may carry `<cwd>/.sova/sandbox.json`. It may only **tighten**: lower the level to
`read-only`, add hidden paths, remove proxy hosts, remove writable roots, remove shadowed
paths. A loosening key is
ignored with a visible notice. Loosening is the user's alone: flipping the toggle off, or editing
the global policy file from outside the sandbox.

## §chat.sandbox/workers — Workers inherit

A worker starts with its parent's state at spawn time: a parent that is on starts its pi workers
with the sandbox extension and `--sandbox on`, and each worker's own extension probes and
enforces independently. If the parent's sandbox is unavailable, or `partial` without
`acceptPartial`, the spawn is refused with a message naming the sandbox. If a pi worker's own
probe fails after it starts, every tool it calls refuses; it never runs unsandboxed. A worker gets exactly its parent's writable roots; its
own cwd is not added. Any worker, pi or Claude Code, whose cwd is outside those roots is refused
at spawn with a message naming the sandbox. A worker started with `--sandbox on` cannot turn it
off: its `/sandbox off` refuses, so the parent's agent cannot switch it off by sending the
command as a steer.

Claude Code workers get the policy as the CLI's own settings (`--settings`): its sandbox enabled
with `failIfUnavailable` and no unsandboxed commands, the writable roots as its allowed writes, the
hidden list as denied reads, and the proxy allowlist as its allowed domains; plus permission rules
that allow Edit only under the writable roots and deny Read of hidden paths. Its permission mode
is forced to `dontAsk`, never `bypassPermissions`. Its Bash is OS-confined by the CLI; its Write,
Edit and Read are confined by those permission rules, the same policy-not-OS shape as pi's file
tools (§chat.sandbox/limits). Enforcement is `full`. A Claude Code worker whose CLI sandbox is
unavailable refuses to start.

Any worker whose enforcement is `partial` refuses to start unattended unless the policy sets
`acceptPartial`.

## §chat.sandbox/backends — Platform-neutral: Linux and macOS

The sandbox is built on a platform-neutral backend interface (probe, confine) with one shared
contract test suite that asserts real host-side effects. Two backends are implemented: Linux
(bubblewrap) and macOS (Seatbelt, through `/usr/bin/sandbox-exec -f` with a profile file
generated from the policy, never an inline profile). On any other platform the probe refuses, so
the tools refuse as above; there is never a passthrough. Remote sessions run their tools on the target, so the extension registers
no confined tools there: an on state is recorded with enforcement `none` and the reason "not
enforced on remote", and reads "Sandbox on · not enforced on remote" (§chat.sandbox/toggle).

## §chat.sandbox/limits — What it does not cover

- **The file tools are policy-enforced, not OS-enforced.** `read`, `write`, `edit`, `ls`, `find`
  and `grep` run inside the agent process and check canonical paths against the policy; only
  `bash` is inside the OS sandbox. A bug in that check is not caught by the kernel. The same
  holds for a Claude Code worker: its Bash is OS-confined by the CLI's sandbox, while its Write,
  Edit and Read are held only by the CLI's permission rules.
- **Delayed escapes.** Whatever the agent writes in the workspace, the user may later run outside
  the sandbox: `npm run`, `make`, `direnv allow`, an editor or mise task, a Clojure alias. The
  sandbox bounds what the agent does now, not what is done later with its output. Reviewing the
  diff before running project scripts is the control.
- **`git init` in a folder that is not a repository** creates hooks the sandbox does not
  protect; a later `git commit` there on the host runs them.
- **Other branches' refs.** In a linked worktree the common dir is writable, so the agent can
  move refs of branches other than its own.
- **Writable roots the user adds** to `writable` are still the host's own folders: whatever the
  agent writes there, host tools may later run. Removing a cache from `shadowed` and adding it to
  `writable` shares the host's copy again, with that risk.
- **Check, then act.** The in-process file tools check a path and then use it, so a `bash`
  command running at the same time could swap in a symlink between the two steps.
- **Background processes end with the command.** Anything a `bash` call starts in the background
  dies when that call returns; long-running servers cannot be started from inside. Exposing a
  host port inside (`localPorts`) is implemented on macOS only.
- **Kernel and bubblewrap bugs.** The boundary is as strong as user namespaces and bubblewrap on
  this kernel. On macOS it is as strong as Seatbelt, whose profile language Apple does not
  document and whose `sandbox-exec` it marks deprecated.
- **macOS tools that ignore the environment.** A tool that writes a fixed temp or cache path
  instead of honouring `TMPDIR` or the cache variables fails under the sandbox there.
- **The user's own `!` commands** are not confined.
