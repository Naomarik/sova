# §chat/sandbox — Sandbox
> Part of the Sova design spec · [overview](../design/overview.md)

pi's sandbox extension (`pi-config/extensions/sandbox`) confines what an agent's **tools** do to
the machine: the `bash` tool runs inside an OS sandbox, and the file tools (`read`, `write`,
`edit`, `ls`, `find`, `grep`) check every path against the same policy. The agent process itself
is not confined, except a Claude Code worker's, which runs whole inside the sandbox
(§chat.sandbox/workers); the server and every worker keep their own state writable. Each
session's sandbox is in one of three states, **Off**, **Subagents only** or **On**
(§chat.sandbox/states), per session. The user sets it; the Overseer may set it on a session it
creates or acts on only as §app.overseer/tools allows, and the agent in the session itself never
can.

It is local containment of an agent's mistakes on a single-user machine. It is not a boundary
for hostile code and has not been security-audited (§chat.sandbox/limits).

## §chat.sandbox/states — Three states: Off, Subagents only, On

A session's sandbox is in one of three states. Each says what is confined: the session's own
tools (the main thread) and the workers it starts. A worker is never looser than its parent, so
no state confines the main thread and leaves its workers loose.

| State | The session's own tools | A worker in one of the session's active tracked worktrees | Any other worker |
|---|---|---|---|
| **Off** | pi's own, unconfined | unconfined | unconfined |
| **Subagents only** | pi's own, unconfined | write-only confinement (§chat.worktrees/workers) | unconfined |
| **On** | confined (§chat.sandbox/what-on-enforces) | the session's sandbox, narrowed to that worktree | the session's sandbox |

- **Default.** A session with no `sandbox` entry and no `--sandbox` flag starts in Subagents only
  when the policy file's `defaultOn` is `false` (as shipped), which is what the sandbox off meant
  before Off existed, and On when it is `true`. Nothing remembers a choice across sessions: Off
  is always picked in the session it applies to.
- **Entry.** The `sandbox` entry keeps its shape and version and gains one optional field,
  `workers: "off"`, written only with `on: false`: `{on: false, workers: "off"}` is Off,
  `{on: false}` Subagents only, `{on: true}` On. An entry written before the field existed has
  none, so it restores as Subagents only (it was off) or On. An entry with `on: true` and
  `workers: "off"` reads as On: the field is dropped, never the confinement.
- **Workers take it at their start.** A change reaches the session's own tools from their next
  tool call, and its workers only when they start or resume afterwards
  (§app.worker-restore/resume): a running worker keeps the confinement it started with until it
  is stopped and resumed. A worker started under On stays confined whatever its parent changes to
  (§chat.sandbox/workers). `agent_list` names each worker's confinement as it was at its start:
  "sandbox: on", "sandbox: on, narrowed to {path}", "sandbox: write-only to {path}" or
  "sandbox: none" (nothing for a worker restored after a restart).
- **Nothing the model sees changes** between any two states (§chat.sandbox/toggle): Off and
  Subagents only both leave the session's own tools pi's own, and the state lives only in the
  plain `sandbox` entry, never in a prompt, a message or a tool description, so a change never
  busts the prompt cache or restarts a Claude-backed session's CLI.
- **Off unconfines writes too.** Under Off a worker in a worktree can write wherever the user
  can: the main checkout, sibling worktrees, the agent dir, other branches' refs. The worktree
  start gate (§chat.worktrees/workers) still decides where a worker may start, not where it
  writes. Off is for workers that need the host as it is: Docker, ssh with the host's own config,
  the user's services, which Subagents only and On keep out of reach by design.
- **Remote.** A remote session's tools run on the target, so no state is enforced there
  (§chat.sandbox/backends), and none confines its workers.

## §chat.sandbox/toggle — The toggle

- **Where.** In pi, `/sandbox on`, `/sandbox subagents` and `/sandbox off` set On, Subagents only
  and Off (§chat.sandbox/states), and bare `/sandbox` (or `/sandbox status`) reports the current
  state; anything else answers with the usage line. A runtime started with
  `--sandbox on|subagents|off` starts in that state. How another host (such as Sova's web
  composer) offers the choice is that host's own surface; it drives the same command.
- **Status.** While on, the TUI footer shows `sandbox on`, or `sandbox on (partial)`,
  `sandbox on (unavailable)`, or in a remote session `sandbox on (not enforced on remote)`. Off
  shows `sandbox off`; Subagents only shows nothing. Bare `/sandbox` prints the extension's status
  line: "Sandbox off · workers unconfined", "Sandbox subagents only · workers in tracked
  worktrees write only there", "Sandbox on ·
  workspace-write · full enforcement", "Sandbox on · workspace-write · partial enforcement
  ({reasons})", "Sandbox on · workspace-write · unavailable: {reasons} (tools refuse)", or, for a
  session that is on but enforced nowhere (a remote session), "Sandbox on · not enforced on
  remote" ("Sandbox on · not enforced" when no reason is recorded).
- **Effect.** A change reaches **this session only**: its own tools from their **next tool
  call**, its workers when they start or resume (§chat.sandbox/states). A tool call
  already running finishes under the rules it started with; nothing is killed, and no turn is
  interrupted. A batch of parallel calls already started runs under the old state and the next
  batch under the new one. The session never restarts, reconnects or loses its workers.
- **Nothing the model sees changes on a change.** Confined tools keep exactly the stock tool
  names, descriptions and parameters, and the system prompt is the same in every state. The sandbox
  shows only in tool results (a denial note, below) and in the session's own `sandbox` entry.
  A changed tool list or prompt would bust the prompt cache and make a Claude-backed session
  restart its CLI.
- **Persistence.** Each change appends a `custom` entry `sandbox`
  `{version: 1, on, level, backend, enforcement, reasons?, workers?}` (`workers` as
  §chat.sandbox/states says); opening the session restores the newest one on its branch. A
  session with no entry takes the `--sandbox` flag, else the policy file's `defaultOn`, which
  ships as `false` (Subagents only). Opening a session writes nothing, except when it
  comes up on with no entry saying so: then one entry pins it on, so a later change to
  `defaultOn` cannot loosen that session.
- **Marker.** Each change is rendered in the TUI transcript from its `sandbox` entry: "Sandbox → on ·
  workspace-write · full enforcement", "Sandbox → subagents only" or "Sandbox → off". On, it names the level and the
  enforcement, and `partial` or `unavailable` add " · {reasons}". An entry that is on but
  enforced nowhere (a remote session) reads "Sandbox → on · not enforced on remote" ("Sandbox → on ·
  not enforced" when no reason is recorded), never "none enforcement". `/sandbox on` while already on
  probes again and records an entry only if the state changed.
- **Only the user changes it from the session.** The agent has no tool that changes the state;
  `/sandbox` is a command, not a tool. A sandboxed `bash` cannot reach Sova's API (its network is
  unshared), so it cannot change it through the server either. The Overseer can set it on another
  session only as §app.overseer/tools says, and lowering it needs the user's click there. A
  worker started with the sandbox on cannot lower it (§chat.sandbox/workers).

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
  per-session tmp mounted as `/tmp`, the policy's `writable` roots (`~/.local/state/mise` in
  the shipped policy), and the session's active tracked worktrees, each with its `.agent`
  read-only (§chat.worktrees/sandbox). `read-only` drops the cwd, the `writable` roots and the
  worktrees from that list.
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
  `~/.aws`, `~/.docker`, `~/.config/gh`, the agent dir's `claude-accounts/`, where every added
  Claude login keeps its own credentials, §app.claude-logins/registry), and credential files cannot be opened at all
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
- **The template hides the WhatsApp sender's home**, `$AGENT_DIR/sova/whatsapp` (its linked
  device's credentials, §app.outreach/secrets), beside `$AGENT_DIR/auth.json`. A policy seeded
  before that keeps its own list: `install.sh --check` reports the drift.
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
own cwd is not added. A pi worker started inside one of the session's tracked worktrees gets
only that worktree instead (§chat.worktrees/workers). A worker is also held to its parent's
hidden list and its proxy and environment allowlists, whatever the policy file of its own agent
dir says. Any worker, pi or Claude Code, whose cwd is outside those roots is refused
at spawn with a message naming the sandbox. A worker started with `--sandbox on` cannot lower
it: its `/sandbox off` and `/sandbox subagents` refuse, so the parent's agent cannot switch it
off by sending the command as a steer. A parent that is not on confines a worker only under
Subagents only and only in a tracked worktree, write-only (§chat.worktrees/workers); under Off no
worker is confined (§chat.sandbox/states).

A Claude Code worker runs whole inside the same OS sandbox: the `claude` process, its Bash, its
Write, Edit, Read, Glob and Grep, and every MCP server it starts are confined by the sandbox's own
backend (bubblewrap, or Seatbelt on macOS), with the policy a pi worker would get in that cwd and
scope: the same writable roots, hidden list, protected git and trust-store paths, and proxy and
environment allowlists. The CLI's own sandbox is turned off, and the worker runs with
`bypassPermissions` unless its spawn asks for another permission mode. Every launch of the worker
is confined, its start, a resume, a move to another login and a failover alike, and a policy change
reaches a running worker at its next launch. If its confinement cannot be set up (the backend's
probe fails, or on macOS a confined `claude --version` fails), the spawn is refused with a message
naming the sandbox; it never runs unconfined. Enforcement is `full`. Its own Claude Code state and
its login's token are handled as §chat.sandbox/claude-state says. A session whose model is Claude
(the chat provider) is not wrapped this way: its `claude` runs with no built-in tools, and every
tool it calls is pi's, confined as above.

Any worker whose enforcement is `partial` refuses to start unattended unless the policy sets
`acceptPartial`.

## §chat.sandbox/claude-state — A confined Claude Code worker's own state and token

A confined Claude Code worker keeps Claude Code's own state in a private config directory,
`<agentDir>/sova/sandbox/claude/<parent-session-id>-<worker-id>/`, which is its
`CLAUDE_CONFIG_DIR` inside the sandbox. It is kept across the worker's resumes, archiving
included, and deleted at a later session start once it has sat unused for 24 hours and its parent
session's file is deleted, or its worker's record is gone from that session; a running worker's
is never deleted. A worker whose directory is gone starts a fresh one and still resumes its
conversation. Its
transcript still lands in Claude Code's own `projects/` folder, where Sova reads it
(§app.subagents-pane/claude-code-workers), through a writable view of that worker's project
folder only. Its team mailbox, its own spec-hook state directory and its own spec ledger file
(which the parent's spec mode also reads) are writable; nothing else of the agent dir, the
login's directory or `~/.claude` is. Each worker has its own tmp, removed when it closes, and
under the sandbox its own proxy, which also allows the Anthropic API hosts.

The login's credentials stay hidden inside. Before each launch, Sova reads the login's
short-lived access token outside the sandbox (never its refresh token) and hands it to the
worker over a file descriptor, so it never appears in a command line, in the spawn environment
or in the worker's own environment. When the token has under 60 minutes left, Sova first
runs Claude Code unconfined on that login, without a model call, so that it refreshes the token
when it is due. On macOS, a login whose directory holds no `.credentials.json` hands over the
access token from its keychain item instead, read again at every launch, and the refresh run
starts Claude Code's own login without `CLAUDE_CONFIG_DIR`, so that it renews that same item
(§app.claude-logins/macos-keychain). When a confined worker's request is refused as
unauthorized, Sova refreshes that login once and resumes the worker on it; only a second failure
fails over (§app.claude-logins/failover). Seen from outside, the worker's process still carries
its login's directory in `CLAUDE_CONFIG_DIR`, so the pool counts it on that login
(§app.claude-logins/drain). A hosted worker's host process reads its token and owns its proxy
and tmp, so the worker keeps its network after the parent restarts.

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
  `bash` is inside the OS sandbox. A bug in that check is not caught by the kernel. A Claude Code
  worker's file tools run inside its confined process, so for it they are OS-enforced too.
- **A confined Claude Code worker's own state and network.** Its private config directory, its
  transcript folder, its team mailbox and its spec-hook state and ledger are writable even under
  `read-only` (§chat.sandbox/claude-state), so it can forge only its own spec ledger. Under
  `read-only` its network is the Anthropic API rather than none, and under `workspace-write` its
  Bash can reach the API hosts too; each worker has its own proxy, so the parent's `bash` cannot.
  Stopping it with TERM ends the sandbox abruptly (closing its input stays graceful), a policy
  change reaches it only at its next launch, and the model sees a denial as the raw
  "Read-only file system" or "Permission denied" error. The worker's transcript says once that it
  is confined (`[sandbox: confined — the session's sandbox]`, "…, narrowed to {worktree}", or
  `[sandbox: confined — write-only to {worktree}]`) and says `[sandbox: refused — {reason}]` when
  a launch is refused.
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
- **A write-only worker's view of the host `/tmp`** (Linux, §chat.worktrees/workers) masks the
  Unix sockets found there when its command or its process starts; a socket created later in
  `/tmp` is reachable from a worker already running. The kernel's list names a socket by the
  path its server bound, in the server's own namespaces, so a socket in the host `/tmp` that
  was bound from another network or mount namespace (a container, another sandbox's private
  `/tmp`) is masked only if the shallow scan finds it: directly in `/tmp` or one folder down,
  within the scan's first 4,096 entries.
