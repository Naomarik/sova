# Sandbox policy (macOS)

**An agent cannot edit this file from inside the sandbox, by design. If you are an agent reading
this, ask the user to change it; do not try to work around it.**

`policy.json` here is enforced by the `darwin-seatbelt` backend: `bash` runs under
`/usr/bin/sandbox-exec -f <profile>`, a Seatbelt profile generated from this file (one per policy,
named by its hash, beside the session tmp, never an inline `-p`). The keys, the project file and
the fail-closed rules are the same as on Linux: see `pi-config/sandbox-policy/linux/CLAUDE.md`.

Seatbelt filters operations; it cannot remap paths as bwrap's mounts do. So on macOS:

- **Everything outside `hidden` stays readable**, and writes are allowed only in the cwd, the
  session tmp and `writable`, minus `readOnlyWithinWritable` and git's own paths (hooks, config,
  and in a linked worktree the common dir's `HEAD`, index and the other worktrees' admin dirs).
- **`hidden` paths are refused, not emptied**: reading or listing them fails with "Operation not
  permitted". The Keychain files (`~/Library/Keychains`, `/Library/Keychains`) and the
  securityd services are always denied, whatever this file says.
- **No `/tmp` mapping**: a literal `/tmp` (and `/private/tmp`) is not writable. `TMPDIR` points
  at the session tmp; tools that honour it work.
- **`shadowed` caches work through the environment**: the host `~/.cache`, `~/.npm` and `~/.m2`
  are read-only inside, and `XDG_CACHE_HOME`, `npm_config_cache` and `MAVEN_OPTS
  -Dmaven.repo.local` point at the sandbox's private copies. mise's `~/.local/state/mise` always
  gets one too, through `MISE_STATE_DIR` (seeded with the host's trust list), whatever this file
  says; a `writable` entry at or inside it is ignored. A tool that ignores those variables
  cannot write its cache. The copies are cleaned as on Linux, with the same `caches.json` beside
  `policy.json` (see the Linux note's "Cache cleanup").
- **Network**: no DNS and no direct connections; outbound only to one loopback port, a relay to
  the session's allowlisting proxy (`proxy.allow`), through `HTTP(S)_PROXY`. Nothing can listen on
  a TCP port, and Unix sockets only work under the writable roots, so ssh-agent, Docker,
  launchd's and mDNSResponder's sockets are unreachable. Other loopback ports (for example a local
  dev server) are refused.
- **Mach services** are denied except a short allowlist (user and group lookups, notifications,
  logging, certificate checks), so pasteboard, Apple events (`osascript`), and the GUI do not
  work.
- **setuid programs cannot run** (`sudo`, `ps`, `top`): Seatbelt refuses the exec.
- **Headless browser (`browser`).** Off by default (`"none"`). With `"browser": "headless-shell"`
  the profile adds two rules (the power-management user client `RootDomainUserClient`, and
  registering and looking up `org.chromium.Chromium.MachPortRendezvousServer.*`), so Playwright's
  `chrome-headless-shell` runs inside every confined profile: On sessions and their workers, and
  write-only worktree workers, which take the value from their parent's policy. Start it with
  `--no-sandbox` (Playwright's default): Seatbelt cannot nest Chrome's own sandbox. That is the
  tradeoff: Chrome's renderers then run with the worker's own rights, so a renderer exploit in
  web content gets what the worker has. Any confined process may also claim a Chromium rendezvous
  name (a host Chromium could then fail to start). Use only the headless shell (Playwright's
  `executablePath`, or its default when its revision is installed); never `channel: "chrome"`,
  Google Chrome.app or the Chrome for Testing bundle: they need the GUI session's services and
  crash with a "quit unexpectedly" dialog. Under On nothing can listen on a TCP port, so drive
  the browser over Playwright's default pipe within one `bash` call. The Keychain stays denied.
- **Claude Code workers** run whole under the same profile, with the CLI's own sandbox off. Their
  private state is linked in rather than bound, because Seatbelt cannot remap paths. A confined
  `claude --version` must succeed before the first one starts; if it fails, the worker is refused,
  never run unconfined.

The platform adds its own lists on top: more credential stores, browser, Mail, Messages, Safari,
cookie and TCC data hidden; `~/Library/LaunchAgents`, `~/Library/Preferences`, shell rc files and
`~/.config` read-only when a writable root holds them (`darwin-seatbelt.ts` `platformDefaults`).
