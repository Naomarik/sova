# §chat/sandbox — Sandbox
> Part of the Sova design spec · [overview](../design/overview.md)

pi's sandbox extension (`pi-config/extensions/sandbox`) confines what an agent's **tools** do to
the machine: the `bash` tool runs inside an OS sandbox, and the file tools (`read`, `write`,
`edit`, `ls`, `find`, `grep`) check every path against the same policy. In a Sova chat, a command
you run from the message box in shell mode is confined as its `bash` is (§chat.shell-mode/running).
The agent process itself
is not confined; the server and every worker keep their own state writable. Each
session's sandbox is in one of three states, **Off**, **Subagents only** or **On**
(§chat.sandbox/states), per session. The user sets it; the Overseer may set it on a session it
creates or acts on only as §app.overseer/tools allows, and the agent in the session itself never
can.

It is local containment of an agent's mistakes on a single-user machine. It is not a boundary
for hostile code and has not been security-audited (§chat.sandbox/limits).

Owns: the three states, the `/sandbox` toggle, what On enforces on Linux and macOS, cleaning its
cache copies, failing closed,
the policy file and per-project tightening, what workers inherit, the chat's shared folder, the
note a confined agent gets, toolchains inside, and what it does not
cover. Not here: the composer's shield and Sandbox group
(§chat.composer/sandbox-shield, §chat.composer/composer-flyout), a worktree worker's write-only
confinement (§chat.worktrees/workers), and what the Overseer may set (§app.overseer/tools).

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
- **Turning on.** Turning a chat On first records a provisional On entry (enforcement
  unavailable, reason `starting`) before the confined tools are registered. Once the policy is
  resolved and probed, it records the real state. If that fails, throws or is overtaken by a
  later change, the newest entry still ends truthful: On with unavailable enforcement when the
  confined tools stay registered, or the later state. Whenever a chat's tools are confined, its
  newest entry already says On. A provisional entry left last by an interruption is not taken as
  recorded: the next start records the truthful state. Only the latest of overlapping changes
  registers tools or records a state. Sova's sandbox shield shows the provisional state with the
  word "Turning on…", never as Unavailable or broken, and its status line reads "Sandbox turning
  on…" (§chat.composer/sandbox-shield). The two entries are one change to the person: Sova draws no transcript row
  for either, the shield follows the newest entry ("Turning on…", then the real state), and the change
  gives at most one toast, with the state it ended in. A provisional entry overtaken by Off or
  Subagents only leaves no trace but a brief "Turning on…" on the shield: it ends on the later
  state, and no row or toast reports the provisional one.
- **Lowering it is your click.** Any move to a state that confines less passes only on what Sova
  takes for your own click in the page (§app.access/your-click, with its limit), a rewind or regenerate
  past a raise included (§chat.sandbox/toggle); raising it stays open.
- **Workers take it at their start.** A change reaches the session's own tools from their next
  tool call, and its workers only when they start or resume afterwards
  (§app.worker-restore/resume): a running worker keeps the confinement it started with until it
  is stopped and resumed. A worker started under On stays confined whatever its parent changes to
  (§chat.sandbox/workers). `agent_list` names each worker's confinement as it was at its start:
  "sandbox: on", "sandbox: on, narrowed to {path}", "sandbox: write-only to {path}" or
  "sandbox: none" (nothing for a worker restored after a restart).
- **Nothing the model sees changes** between any two states (§chat.sandbox/toggle): Off and
  Subagents only both leave the session's own tools pi's own, and the state lives in the plain
  `sandbox` entry, never in the system prompt or a tool description, so a change never busts the
  prompt cache or restarts a Claude-backed session's CLI. The one thing the model is told is the
  hidden note a confined agent gets at a turn's start (§chat.sandbox/confined-note): an appended
  message, which busts no cached prefix and restarts no CLI. Off and Subagents only give the
  session's own model no note.
- **MCP servers.** Under On a chat's command servers run inside its sandbox and its address
  servers stay off. A change to or from On keeps the chat's tool list, stops its running copies
  and applies from the next call (§app.mcp/sandbox).
- **Off unconfines writes too.** Under Off a worker in a worktree can write wherever the user
  can: the main checkout, sibling worktrees, the agent dir, other branches' refs. The worktree
  start gate (§chat.worktrees/workers) still decides where a worker may start, not where it
  writes. Off is for workers that need the host as it is: Docker, ssh with the host's own config,
  the user's services, which Subagents only and On keep out of reach by design.
- **Remote.** A remote session's tools run on the target, so no state is enforced there
  (§chat.sandbox/backends), and none confines its workers.

## §chat.sandbox/toggle — The toggle

The `/sandbox` command, or the `--sandbox` flag at start, sets a session's state, which reaches its
tools from their next call and is recorded in a `sandbox` entry.

- **Where.** In pi, `/sandbox on`, `/sandbox subagents` and `/sandbox off` set On, Subagents only
  and Off (§chat.sandbox/states), and bare `/sandbox` (or `/sandbox status`) reports the current
  state; `/sandbox clean` and `/sandbox clean all` clean the sandbox's cache copies
  (§chat.sandbox/cache-cleanup), and change no state; anything else answers with the usage line,
  "usage: /sandbox on | subagents | off | clean [all]". A runtime started with
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
- **Caches line.** Bare `/sandbox` prints one more line after that status line, about the
  sandbox's cache copies (§chat.sandbox/cache-cleanup): their size, their limit and what set it
  (such as "5% of free space"), when they were last cleaned and how much that freed. When the
  copies are over their limit because everything left was used recently, the line says so instead,
  giving their size, the limit and what set it, without when they were cleaned or what that freed. It is
  read from the last cleanup's record, so printing it never measures the caches. The status line
  itself, the footer and the composer shield's title are unchanged.
- **Cleaning now.** `/sandbox clean` runs the same cleanup at once, even if one ran in the last
  24 hours, and reports what it freed. `/sandbox clean all` removes every entry of the copies not
  used in the last hour, tool caches included, and reports what it freed. Either is refused, with
  nothing removed, while another cleanup is running.
- **Effect.** A change reaches **this session only**: its own tools from their **next tool
  call**, its workers when they start or resume (§chat.sandbox/states). A tool call
  already running finishes under the rules it started with; nothing is killed, and no turn is
  interrupted. A batch of parallel calls already started runs under the old state and the next
  batch under the new one. The session never restarts, reconnects or loses its workers.
- **Nothing the model sees changes on a change.** Confined tools keep exactly the stock tool
  names, descriptions and parameters, and the system prompt is the same in every state. The sandbox
  shows only in tool results (a denial note, below), in the session's own `sandbox` entry and, for
  an agent whose tools are confined, in one hidden note at the start of a turn
  (§chat.sandbox/confined-note), never in the system prompt or a tool description.
  A changed tool list or prompt would bust the prompt cache and make a Claude-backed session
  restart its CLI; an appended hidden message does neither.
- **Persistence.** Each change appends a `custom` entry `sandbox`
  `{version: 1, on, level, backend, enforcement, reasons?, workers?}` (`workers` as
  §chat.sandbox/states says): turning On appends a provisional entry, then the real state
  (§chat.sandbox/states); Off and Subagents only append one; opening the session restores the newest one on its branch. A
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
  unshared), so it cannot change it through the server either. An unsandboxed `bash` can reach the
  API, so there a lowering is refused unless Sova takes it for your own click, by `POST /api/sandbox`, by a
  `/sandbox` sent through the send request, or by going back past a raise (§app.access/your-click). A rewind or
  regenerate in the page past a raise still lowers the sandbox, since the state is the one on the branch it lands
  on, and the page shows the new state. The Overseer can set it on another
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

On makes the filesystem read-only outside a few writable roots, hides credentials and host
services, and sends the network through an allowlisting proxy, on Linux and on macOS.

On means the policy file's `level`: `workspace-write` by default, `read-only` if the file says
so. It is not a choice in the UI. Under `workspace-write`:

- **Filesystem.** The whole filesystem is readable and read-only, except the session's cwd (not
  when it is the home folder standing in for a folder that is gone, §app.shell/missing-folder-home), a
  per-session tmp mounted as `/tmp`, the policy's `writable` roots, the session's active tracked
  worktrees, each with its `.agent` read-only (§chat.worktrees/sandbox), and the chat's shared
  folder (§chat.sandbox/shared-folder). `read-only` drops the cwd, the `writable` roots, the
  worktrees and the shared folder from that list.
- **Shadowed caches.** Build caches (`~/.cache`, `~/.npm`, `~/.m2`: the policy's `shadowed`) are
  the sandbox's own private copies, kept between sessions; nothing written there reaches the
  host's caches. They are cleaned by age and size, never of anything used recently
  (§chat.sandbox/cache-cleanup). Each copy lives under `<agentDir>/sova/sandbox/shadow/`, is shared by all
  sandboxed sessions and is mounted at the cache's usual path, so host tools that later run
  cached code (build dirs, editor bytecode, npx packages, Maven plugins) never see what the
  sandbox wrote, and the host's own cache is not visible inside. They start cold: the first
  install or build in the sandbox downloads what the host already had. The file tools see the
  same copies as `bash`. A `writable` entry at or inside a shadowed path is a policy error, and
  the sandbox fails closed on it. Under `read-only` nothing is shadowed and the caches are
  read-only.
- **Toolchain state is a private copy too.** mise's state (`~/.local/state/mise`, on Linux and
  macOS) and, on Linux, pnpm's (`~/.local/state/pnpm`, `~/.local/share/pnpm/store`,
  `~/.local/share/pnpm/package-manager-store`) are private copies like the caches, for every
  confined agent, a write-only worker included (§chat.sandbox/toolchains), kept under the same
  `<agentDir>/sova/sandbox/shadow/` and shared by all sandboxed sessions. They are the sandbox's own
  default, whatever the policy file says: a `writable` entry at or inside one (the
  `~/.local/state/mise` an older policy file carries) is dropped, never failing closed, and the
  template's `writable` is now empty. Only those default paths get a copy on Linux (an
  `XDG_STATE_HOME` or `XDG_DATA_HOME` elsewhere doesn't move it); on macOS `MISE_STATE_DIR` always
  names the copy. Nothing written there reaches the host. Unlike a cache's, a toolchain state folder the
  host doesn't have is never created on the host (nor any folder above it); on Linux it then gets no
  copy: it stays absent, and a confined write there is refused as outside the policy. The mise copy mirrors the host's trust
  and ignore lists, removals included, so the sandbox trusts what the host trusts; a `mise trust`
  inside changes only the copy, which the host's own mise never reads, so a trust store inside a
  copy is not pinned read-only as the host's are below.
- **Hidden secrets.** Credential directories read as empty and read-only (`~/.ssh`, `~/.gnupg`,
  `~/.aws`, `~/.docker`, `~/.config/gh`, GitLab's tool's `~/.config/glab-cli` (and on macOS
  `~/Library/Application Support/glab-cli`), the agent dir's `claude-accounts/`, where every added
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
  `full`, because that is a tightening. A guided-tour recording from a sandboxed chat gets a proxy
  of its own for that one attempt, with the chat's allowlist and two additions the chat's own
  proxy never has: it also refuses an allowlisted name that resolves to any other non-public
  address (private, carrier-grade NAT, unique-local or IPv4-mapped), and it may reach exactly the
  one loopback host and port of a project tour's own verified running copy, whose endpoint is
  `http://127.0.0.1:<port>`, rechecked at each contact and gone when the attempt ends; a site tour
  of a loopback origin gets no exception (§app.tours/sandbox). A recording from a chat whose
  sandbox is Off runs through a per-attempt proxy too, but that one is Sova's own (the sandbox
  plays no part): it admits only origins that tour declares or its pages already requested, while approved (§app.tours/sites), and leaves the
  chat's sandbox Off. A recording attempt can hand its own sandbox proxy an admission check, which refuses a
  connection before any lookup or dial; without one, the proxy behaves exactly as before.
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
  is dropped: session-bus and agent sockets, `DISPLAY`, `TMUX`, provider API keys, tokens. To
  these the sandbox adds one of its own, `GIT_CONFIG_SYSTEM` (§chat.sandbox/git-cleanup).
- **The file tools see the same view.** For `read`, `write`, `edit`, `ls`, `find` and `grep`,
  `/tmp` is the session tmp, as it is for `bash`, except where a writable root sits under `/tmp`:
  every write goes there, and a read goes there when the session tmp holds the path, else falls
  back to the host's `/tmp` (pi's own truncated-output files live there, and a brief another
  session left there stays readable). A write-only worker's file tools map its private `/tmp` the
  same way (§chat.worktrees/workers).
  `find` and `grep` drop results under hidden paths and say how many they dropped.
- **Denials are ordinary tool failures.** A blocked write or connection returns the command's
  real output plus a trailing note naming the sandbox, which the model reads like any failure. A
  harmless command gets no such note (§chat.sandbox/toolchains). A
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
  With the policy's `browser` set to `"headless-shell"` (§chat.sandbox/policy-file), the profile
  adds two Chromium rules: opening the power-management user client (`RootDomainUserClient`)
  and registering and looking up the `org.chromium.Chromium.MachPortRendezvousServer.` names.
  Playwright's `chrome-headless-shell` then runs and takes screenshots inside the sandbox when it
  is started with `--no-sandbox` (Playwright's default), since Seatbelt cannot nest Chrome's own
  sandbox. The rules sit before the hidden paths and the Keychain deny, which still win. Every
  command confined under the session's policy gets them, a tour recording's included
  (§app.tours/sandbox). An app-bundle Chrome (Google Chrome, Chrome for Testing) is not supported
  and still crashes; a sandboxed tour recording on macOS therefore uses the headless shell and
  refuses before launch when only an app-bundle Chrome is installed (§app.tours/sandbox).

## §chat.sandbox/cache-cleanup — Cleaning the cache copies

The sandbox's private cache copies (§chat.sandbox/what-on-enforces) are cleaned on their own, by
age and by size, and nothing used recently is ever removed from them.

- **When.** When a sandboxed chat starts, at most once every 24 hours for each agent directory;
  a remote chat never starts it. The cleanup runs in the background at low priority (the lowest
  CPU priority everywhere, and the lowest disk priority where the system offers one, as Linux
  does), and never delays the chat being ready. `/sandbox clean` runs it at once (§chat.sandbox/toggle).
- **What it removes.** Whole top-level entries of the copies: each `~/.cache/<name>`,
  `~/.npm/<name>` and `~/.m2/<name>` as the sandbox sees them, each entry of the toolchain state
  copies (mise's and pnpm's, §chat.sandbox/what-on-enforces), and each entry of a copy left under
  `<agentDir>/sova/sandbox/shadow/` by an older layout. It never removes a copy's own folder. The
  toolchain state copies count toward the same limit. The list of what the mise copy took from the
  host's trust lists is kept beside the copy, out of the cleanup's reach, so after the cleanup
  removed the copy's trust folder a trust you later withdraw on the host is still withdrawn inside.
- **By age.** An entry nothing in which was used for 7 days is removed. Known tool caches are kept
  30 days instead: in `~/.cache`, the entries named `pnpm`, `ms-playwright`, `pip`, `uv`,
  `go-build`, `node-gyp`, `yarn`, `deno`, `typescript`, `puppeteer`, `mise`, `huggingface` and the
  voice install cache's, and every entry of `~/.npm`, `~/.m2` and the toolchain state copies.
  Everything else is scratch.
- **By size.** Then, while the copies together are over their limit, the least recently used
  entries are removed first, scratch before tool caches, until they are under it. The limit is the
  smallest of the `maxSizeGB` setting (50 GB by default), 5% of the size of the disk holding the
  copies and 5% of that disk's free space, and never less than 2 GB.
- **Recent use is protected.** Neither pass removes an entry with any file written in the last 24
  hours or read in the last 48 hours. When only such entries are left and the copies are still
  over their limit, the cleanup records that they stayed over, and bare `/sandbox` says so.
- **Nothing half-removed.** An entry is first moved aside, into
  `<agentDir>/sova/sandbox/shadow-trash/`, and deleted from there in the background, so no chat
  ever finds part of one. Each cleanup first empties what an earlier one left there. One cleanup
  runs at a time for each agent directory; a lock left by one that ended without releasing it
  stops blocking at once when its process is gone, else within 2 hours.
- **Its record.** Each cleanup writes `<agentDir>/sova/sandbox/shadow-prune.json`: when it ran, how
  much it freed, the copies' sizes, the limit it used and which bound set it, and whether the copies
  stayed over it. Bare `/sandbox` reports from that record (§chat.sandbox/toggle).
- **Sizes.** A size is the disk space the files take, counting a hard-linked file once. Freed space
  is "up to" that amount (§chat.sandbox/limits).
- **Settings.** An optional file, `<agentDir>/sandbox-policy/<platform>/caches.json`, beside the
  policy file (§chat.sandbox/policy-file), whose template is the repo's
  `pi-config/sandbox-policy/<platform>/caches.json`: `on` (`true`), `maxSizeGB` (`50`),
  `scratchDays` (`7`), `toolCacheDays` (`30`) and `toolCaches` (the names above). `"on": false`
  turns automatic cleanup off; `/sandbox clean` still runs. A missing file means those defaults. An invalid one turns cleanup
  off, with a visible notice saying why; it never touches the sandbox itself, which keeps working
  and never fails closed on it. Like the policy, it cannot be changed from inside the sandbox, and
  a project cannot set it (§chat.sandbox/project-tightening).

## §chat.sandbox/fail-closed — Fail closed

When the sandbox can't be set up, the tools refuse instead of running unconfined, and an effect it
can't govern marks enforcement `partial`.

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
  `shadowed`, `proxy` (`allow`), `env` (`allow`), `acceptPartial`, and the optional `browser`.
- **`browser`** is `"none"` (the template's value, and the meaning when the key is absent) or
  `"headless-shell"`, which lets Playwright's `chrome-headless-shell` run inside every confined
  macOS profile (§chat.sandbox/what-on-enforces). Any other value, `true` included, fails closed
  like every other malformed key. It has no effect on Linux.
- **The template hides the WhatsApp sender's home**, `$AGENT_DIR/sova/whatsapp` (its linked
  device's credentials, §app.outreach/secrets), beside `$AGENT_DIR/auth.json`. A policy seeded
  before that keeps its own list: `install.sh --check` reports the drift.
- **The template hides MCP's secrets and sign-ins**, `$AGENT_DIR/sova/secrets/mcp` and
  `$AGENT_DIR/mcp-auth.json` (§app.mcp/secrets, §app.mcp/sign-in), the same way.
- **The template's `writable` is empty.** mise's state, which it used to list, is now a private
  copy whatever the file says (§chat.sandbox/what-on-enforces); a policy seeded before keeps its
  entry, which is dropped rather than failing closed, and `install.sh --check` reports the drift.
- **Re-read on every tool call.** An edit applies to the next tool call of every session.
- **Cache cleanup has its own file.** The cleanup settings (§chat.sandbox/cache-cleanup) live in
  an optional `caches.json` beside `policy.json`, never in it: `policy.json` keeps exactly the keys
  above and its strict check, and a mistake in `caches.json` only turns cleanup off, never the
  sandbox. It is seeded from its template like the policy and never overwritten; since a missing
  one means its defaults, `install.sh --check` only notes it missing and does not fail on that.
- **Never writable from inside.** The whole agent directory is read-only (it holds sessions,
  settings and extensions that pi runs later outside the sandbox), `<agentDir>/sandbox-policy/`
  included. Each `policy.json` there is also hidden; each `CLAUDE.md` stays readable. The file tools refuse those canonical
  paths too. This holds even when the session's cwd contains the agent directory. The one place
  Sova keeps for confined agents to write, the chat's shared folder (§chat.sandbox/shared-folder),
  lies outside the agent directory, so the rule has no exception.
- **Its `CLAUDE.md`** explains each key, says per-project files may only tighten, and opens by
  telling an agent that it cannot edit the policy from inside the sandbox by design and should
  ask the user instead of working around it. It names the tool state that always gets a private
  copy whatever the file says (§chat.sandbox/what-on-enforces). The `darwin/` copy explains what
  Seatbelt enforces differently on macOS (§chat.sandbox/what-on-enforces).

## §chat.sandbox/project-tightening — Per-project config only tightens

A project's own config can tighten the sandbox, never loosen it.

A project may carry `<cwd>/.sova/sandbox.json`. It may only **tighten**: lower the level to
`read-only`, add hidden paths, remove proxy hosts, remove writable roots, remove shadowed
paths, set `browser` to `"none"`. A loosening key (`browser: "headless-shell"` included) is
ignored with a visible notice. The cache cleanup settings (§chat.sandbox/cache-cleanup) are not a
project's to set either: a cleanup key in that file is ignored with the same notice. Loosening is the user's alone: flipping the toggle off, or editing
the global policy file from outside the sandbox.

## §chat.sandbox/workers — Workers inherit

A worker starts with its parent's state at spawn time: a parent that is on starts its pi workers
with the sandbox extension and `--sandbox on`, and each worker's own extension probes and
enforces independently. If the parent's sandbox is unavailable, or `partial` without
`acceptPartial`, the spawn is refused with a message naming the sandbox. If a pi worker's own
probe fails after it starts, every tool it calls refuses; it never runs unsandboxed. A worker gets exactly its parent's writable roots; its
own cwd is not added. A pi worker started inside one of the session's tracked worktrees gets
only that worktree instead (§chat.worktrees/workers). A worker is also held to its parent's
hidden list, its proxy and environment allowlists and its `browser` setting, whatever the
policy file of its own agent dir says. Any worker, pi or Claude Code, whose cwd is outside those roots is refused
at spawn with a message naming the sandbox. A worker started with `--sandbox on` cannot lower
it: its `/sandbox off` and `/sandbox subagents` refuse, so the parent's agent cannot switch it
off by sending the command as a steer. A parent that is not on confines a worker only under
Subagents only and only in a tracked worktree, write-only (§chat.worktrees/workers); under Off no
worker is confined (§chat.sandbox/states).

A Claude Code worker is a pi worker on the Claude Code provider
(§app.subagents-pane/claude-code-workers), so it inherits exactly as above: its `claude` runs with
no built-in tools, and every tool it calls is pi's, confined per call like any pi worker's. The
same holds for a session whose model is Claude (the chat provider).

A worker's MCP servers (§app.mcp/who-gets) follow §app.mcp/sandbox: a worker under the session's
sandbox runs its command servers inside it and has no address servers, and a worker under write-only
confinement runs its command servers under that same confinement.

Any worker whose enforcement is `partial` refuses to start unattended unless the policy sets
`acceptPartial`.

Every worker, confined or not and at any depth, shares the top-level chat's shared folder
(§chat.sandbox/shared-folder): a confined one gets it as a writable root whatever else its scope
is narrowed to.

## §chat.sandbox/shared-folder — The chat's shared folder

Each top-level chat has one folder that the chat, every worker it starts (pi or Claude Code, at
any depth) and every member of its teams can read and write, confined or not. It is where they
leave files for each other: briefs, reports, alignment files and team handover notes.

- **Where.** `~/.local/state/sova/shared/<chat key>/`, where the key is the top-level chat's
  session id reduced to `[A-Za-z0-9._-]`; a chat with no session id yet has none. An absolute
  `SOVA_SHARED_BASE` in the server's environment replaces `~/.local/state/sova/shared`, and a
  hermetic copy of Sova (`dev:hermetic`) sets it to its worktree's `.cache/sova-shared`, so its
  chats never make or remove a folder in your real home. It is outside the agent directory, which stays wholly
  read-only to every confined agent (§chat.sandbox/policy-file), and outside every repository, so
  nothing left there shows in a branch or blocks Land. A worker's folder is always its top-level
  chat's, never one of its own. Sova never loads or runs code from it.
- **Writable while confined.** It is a writable root of a write-only worker
  (§chat.worktrees/workers), of a chat whose sandbox is On and of every worker under On, narrowed
  or not (§chat.sandbox/what-on-enforces), for `bash` and the file tools alike, on Linux and
  macOS. It travels in the worker's scope apart from its other roots, so narrowing a scope to a
  worktree never drops it. The `read-only` level drops it, as it drops every other root.
- **Team notes.** Its `teams/` folder holds the teams' handover notes (§teams.defaults/handover)
  and is read-only to every confined agent, except that each coordinated member and coordinator
  may write its own note's folder and no other's, so a member can never write or plant another
  member's note, make a folder for a new role, or move `teams/` aside. A member's own note folder is
  never handed on to the workers it starts, and the monitor has none. Nothing a team routes on
  (mailboxes, the roster) lives in the shared folder.
- **Named where it is needed.** Every worker's environment carries it as `SOVA_SHARED_DIR`; the
  results of `agent_spawn` and `team_create` name it, so the parent knows where to put a brief;
  the confined agent's note names it (§chat.sandbox/confined-note); and the alignment hand-off
  names it as the place for the planning worker's alignment file (§chat.alignment/model).
- **Kept until the chat is archived.** Archiving the top-level chat, or deleting it while it is
  still empty, removes its shared folder; until then it stays, across reloads and server
  restarts. Unarchiving it doesn't bring the folder back: the chat starts a new, empty one the next
  time it needs it.

## §chat.sandbox/confined-note — What a confined agent is told

An agent whose tools are confined is told, in one short hidden note, where it may write and where
to leave files for others. No other agent, and never you, sees it.

- **Who.** A write-only worker in a tracked worktree (§chat.worktrees/workers), and a chat or a
  worker whose sandbox is On (§chat.sandbox/states), at either level. A chat whose sandbox is Off
  or Subagents only, an unconfined worker and a remote session, whose tools nothing confines
  (§chat.sandbox/backends), get none: a chat whose folder is a target's, or whose sandbox is On
  but enforced nowhere ("not enforced on remote"), is told nothing.
- **What it says.** "Sandbox: you can write only in {folders} and $TMPDIR. /tmp and ~/.cache are
  private to you: leave files for other chats in {shared}. Set up, serve and test through
  project_verbs." {folders} is the agent's writable roots, comma-separated, the shared folder not
  among them: a write-only worker's worktree; under On the chat's cwd and its tracked worktrees,
  or a worker's roots as its parent handed them; under the `read-only` level none, and the
  sentence reads "you can write only in $TMPDIR". {shared} is the chat's shared folder
  (§chat.sandbox/shared-folder): a worker's from its scope, else from `SOVA_SHARED_DIR`, a chat's
  its own; where none is known, ": leave files for other chats in {shared}" is left out. Under the
  `read-only` level it is left out too, since the agent cannot write there
  (§chat.sandbox/shared-folder): the note reads "Sandbox: you can write only in $TMPDIR. /tmp and
  ~/.cache are private to you.", then the project_verbs sentence where it applies. On macOS, whose `/tmp` is never private (§chat.sandbox/what-on-enforces), the second
  sentence reads "/tmp is read-only and ~/.cache is private to you". The last sentence is there
  only when the agent is offered `project_verbs` (§app.project-services/tool-offered).
- **How it arrives.** As a hidden message (`sova-sandbox-note`, never shown in the transcript) at
  the start of a turn, only when its text differs from the last such message on the branch, so
  again only when the confinement changes (a new tracked worktree, a change of state) and, with
  the current text, after a compaction. It is never in the system prompt or a tool description
  (§chat.sandbox/toggle), so it busts no cached prefix and restarts no Claude-backed CLI.

## §chat.sandbox/toolchains — Toolchains work inside

The tools a coding agent runs every turn work inside a confined agent with no recipe or
workaround: the version manager, the package manager, the project's tests and Sova's browser
helper.

- **mise.** It runs quietly: its own state is a private copy (§chat.sandbox/what-on-enforces), so
  `mise trust` and `mise exec` succeed inside without touching the host's trust list, and no
  warning about tracking its configs buries a command's output. The copy is one for every
  confined session: a config one of them trusts is trusted in every other confined session, never
  on the host.
- **pnpm.** `pnpm install`, type-checking and builds work in a worker's worktree: pnpm's own
  state is a private copy, and its lock files in `/tmp` go to the worker's private `/tmp` on Linux
  (§chat.worktrees/workers). Its private store is a mount of its own, which pnpm can't hard-link
  across, so it installs into a store inside the project (`node_modules/.pnpm-store`): each
  worktree's first install downloads cold. A `node_modules` linked to another checkout stays
  read-only and is no way around it.
- **No false refusals.** A command whose only match is a harmless warning (mise's about tracking
  configs) gets no denial note (§chat.sandbox/what-on-enforces): the note is added only when the
  sandbox really refused something.
- **No misfire from another sandbox's files.** On Linux no confined command sees the host's
  `/tmp` (§chat.worktrees/workers), so nothing there is scanned or masked as a command starts, and
  a socket in another sandbox's temp folder that vanishes at that moment never stops a command
  from starting.
- **Short temp paths.** On Linux a confined agent's `TMPDIR` is `/tmp`, its private one, so a
  Unix socket path inside it fits the path limit, and test servers and browsers that bind one
  there start.
- **Sova's own tests and browser helper.** Sova's unit tests write their temp files under
  `TMPDIR` wherever a fixed `/tmp` path isn't needed; the few that must sit directly in `/tmp`
  (the attachment route serves that literal folder, §chat.images/path-attachments) write to the private `/tmp` on
  Linux and skip those cases where `/tmp` can't be written (a macOS sandbox). The Playwright skill's
  start script keeps its pid and port files under `TMPDIR`.

## §chat.sandbox/git-cleanup — Sandboxed commands start no background git cleanup

A sandboxed command's processes all end when the command ends (§chat.sandbox/limits), so a
background git cleanup started by a commit, a merge or a fetch inside it would be cut off partway
(§app/git-cleanup). So every sandboxed command, in every project and at either level, a
write-only worker's included, runs with `GIT_CONFIG_SYSTEM` naming a git system config the sandbox
writes into the session's tmp, `sova-no-background-cleanup.gitconfig` under the command's
`TMPDIR`: the machine's own git system config, then `maintenance.auto = false` and `gc.auto = 0`,
written as §app.git-cleanup/no-background says. The backend adds it itself, after the environment
allowlist, on Linux and on macOS; an inherited `GIT_CONFIG_SYSTEM` is dropped by the allowlist as
before and only decides which machine config is copied in. Commits are as fast as before.

- **What still overrides it** is §app.git-cleanup/no-background's list: a command's own
  `GIT_CONFIG_SYSTEM` or `GIT_CONFIG_NOSYSTEM`, `-c`, or `maintenance.auto` or `gc.auto` set in a
  repository's or the user's own config. A command's own `GIT_CONFIG_COUNT` adds to it and never
  drops it.
- **The file is the command's to change.** It sits in the session's tmp, which commands may
  write; the sandbox writes it again before every command, so one that deletes or edits it changes
  only itself and the commands it starts.

## §chat.sandbox/backends — Platform-neutral: Linux and macOS

The sandbox is built on a platform-neutral backend interface (probe, confine) with one shared
contract test suite that asserts real host-side effects. Two backends are implemented: Linux
(bubblewrap) and macOS (Seatbelt, through `/usr/bin/sandbox-exec -f` with a profile file
generated from the policy, never an inline profile). On macOS a hidden path under a
TCC-protected directory still gets its canonical spelling (resolved one component at a time when
realpath is refused), so the Seatbelt profile builds. On any other platform the probe refuses, so
the tools refuse as above; there is never a passthrough. Remote sessions run their tools on the target, so the extension registers
no confined tools there: an on state is recorded with enforcement `none` and the reason "not
enforced on remote", and reads "Sandbox on · not enforced on remote" (§chat.sandbox/toggle).

## §chat.sandbox/limits — What it does not cover

These are the gaps the sandbox leaves, each named so that nobody relies on it there.

- **The file tools are policy-enforced, not OS-enforced.** `read`, `write`, `edit`, `ls`, `find`
  and `grep` run inside the agent process and check canonical paths against the policy; only
  `bash` is inside the OS sandbox. A bug in that check is not caught by the kernel.
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
  dies when that call returns, so Sova has nothing to keep as a background job, and long-running
  servers cannot be started from inside. A write-only worker's one way around that is to ask Sova
  to start the job, which runs under the worker's own confinement (§app.background-jobs/request); a
  sandboxed chat has none (§app.background-jobs/where). Exposing a host port inside (`localPorts`) is
  implemented on macOS only.
- **Kernel and bubblewrap bugs.** The boundary is as strong as user namespaces and bubblewrap on
  this kernel. On macOS it is as strong as Seatbelt, whose profile language Apple does not
  document and whose `sandbox-exec` it marks deprecated.
- **macOS tools that ignore the environment.** A tool that writes a fixed temp or cache path
  instead of honouring `TMPDIR` or the cache variables fails under the sandbox there.
- **The user's own `!` commands** are confined only in a Sova chat whose sandbox is On, run from its
  message box (§chat.shell-mode/running): never on a remote target, and never in pi's own terminal,
  outside Sova.
- **With `browser` on, Chrome's own sandbox is off** (§chat.sandbox/what-on-enforces): its
  renderer and GPU processes run with the worker's own rights, so an exploit in web content it
  loads can read what the worker reads and write where it writes. Any confined process may also
  open the power-management user client and claim a Chromium rendezvous name, which can make a
  host Chromium-branded browser fail to start. Only the headless shell is supported. Under On
  nothing can listen on a TCP port, so a browser driven over `--remote-debugging-port` (the
  Playwright skill's start script) works only under Subagents only; under On drive it over
  Playwright's default pipe within one `bash` call.
- **A file left in `/tmp` reaches no one.** A confined agent's `/tmp` is private to it on Linux, so
  a file it writes there for another chat is silently not seen; the shared folder is the place for
  those (§chat.sandbox/shared-folder), and its note says so (§chat.sandbox/confined-note).
- **A brief in the host `/tmp` reaches only the file tools.** A confined agent's commands never see
  the host's `/tmp`; its file tools fall back to it for a read (§chat.sandbox/what-on-enforces), so
  `read` finds a brief left there but `cat` in `bash` does not.
- **Toolchain copies have their limits.** pnpm installs cold once per worktree
  (§chat.sandbox/toolchains); only mise's and pnpm's default paths get a private copy on Linux, so
  one moved by `XDG_STATE_HOME` or `XDG_DATA_HOME` is read-only inside; and one mise trust copy
  serves every confined session, so a trust made in one holds in all of them.
- **The shared folder's edges.** A team member already running when its note moved into the shared
  folder keeps the note path its header named until it hands off (§teams.defaults/handover). A
  chat you unarchive gets an empty shared folder, never its old one. Under the `read-only` level
  (the merge thread's, §chat.merge-queue/thread-sandbox) the agent cannot write it, and its note
  names no shared folder (§chat.sandbox/confined-note); the workers it starts still get
  `SOVA_SHARED_DIR`, which their read-only scope cannot write either.
- **Freed cache space is "up to".** On a copy-on-write disk (Btrfs, APFS and the like), files that
  share their blocks with others give back less than their size when removed, so the space a cache
  cleanup reports freed (§chat.sandbox/cache-cleanup) is at most what the disk gained.
- **Read-only use is protected best-effort.** The 48-hour read protection relies on the disk
  recording read times. Where it does not (a `noatime` mount, for one), an entry that was only read, never written, may look older than it is
  and be removed by age or size; the next use downloads or builds it again.
