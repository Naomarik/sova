# Sandbox policy (Linux)

**An agent cannot edit this file from inside the sandbox, by design: it is outside every
workspace, mounted read-only and masked, and the write tools refuse its canonical path. If you
are an agent reading this, ask the user to change it; do not try to work around it.**

`policy.json` here is what the `sandbox` pi extension (`pi-config/extensions/sandbox`) enforces
when a session's sandbox is on (`/sandbox on` in the TUI, the Sandbox row in Sova's composer
menu). It is re-read on every tool call, so an edit applies to the next tool call of every
session. This directory is a copy of the template in `pi-config/sandbox-policy/`, made by
`install.sh` when it was absent; `install.sh --check` reports drift from the template and never
overwrites your edits. A malformed file, a missing key or an unknown key makes every sandboxed
tool refuse (fail closed) until it is fixed.

Paths accept `~/…`, `$AGENT_DIR/…` (pi's agent directory) and absolute paths; relative paths are
relative to the session's cwd.

| Key | Meaning |
|---|---|
| `version` | Always `1`. |
| `level` | What "on" means. `workspace-write`: the cwd, the session tmp (`/tmp` inside) and `writable` are writable; network only through the proxy. `read-only`: only the session tmp is writable; no network. |
| `defaultOn` | Whether a session with no recorded choice starts with the sandbox on. |
| `writable` | Extra writable roots besides the cwd and the session tmp. Ignored under `read-only`. Whatever is listed here is written on the host for real, so never list a host cache here (use `shadowed`). |
| `shadowed` | Host paths (caches: `~/.cache`, `~/.npm`, `~/.m2`) the sandbox sees as its own private, persistent, writable copy, kept under `$AGENT_DIR/sova/sandbox/shadow/`. What a sandboxed tool writes there never reaches the host path, so host tools that later run cached code (AUR build dirs, editor bytecode, `npx`, Maven plugins) cannot be poisoned. A path may not be both `writable` and `shadowed`. Ignored under `read-only`. |
| `hidden` | Secrets: a directory reads as empty, a file cannot be opened; the file tools refuse them. Every `policy.json` in this directory is always hidden; this note stays readable, and the whole directory is always read-only. |
| `readOnlyWithinWritable` | Paths inside a writable root that stay read-only (git hooks and config: code that would run later outside the sandbox). pi's agent dir and this directory are always read-only. |
| `proxy.allow` | Hosts the sandbox may reach through its HTTP/CONNECT proxy; `*.example.com` matches subdomains. Everything else is refused. |
| `env.allow` | Extra environment variable names passed into the sandbox (`NAME` or `PREFIX*`). Everything not on the built-in allowlist is dropped. Adding a name is a loosening. |
| `acceptPartial` | Let unattended workers start when enforcement is only `partial` (for example Claude Code workers, whose Write/Edit the CLI's sandbox does not confine). |

A project may carry `<cwd>/.sova/sandbox.json`, which can only **tighten**: `level:
"read-only"`, more `hidden` or `readOnlyWithinWritable` entries, a subset of `writable`,
`shadowed` or `proxy.allow`. Any other key is ignored with a notice. Loosening is the user's alone: turn the
sandbox off, or edit this file from outside the sandbox.

The platform adds its own lists on top (other credential stores, shell rc files, `/run` with the
user's D-Bus, systemd and agent sockets, which is always replaced).
