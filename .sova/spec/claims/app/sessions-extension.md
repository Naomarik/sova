# §app/sessions-extension — The sessions extension's live records
> Part of the Sova design spec · [overview](../design/overview.md)

pi's sessions extension (`pi-config/extensions/sessions`) publishes one live record per running
pi session, which Sova's server reads to know what is running (the live registry;
`public/SCHEMA.md` is its contract). It also reads an optional config file, `sessions.json`, and
ships the `pi-sessions` command that reads the records from a shell.

## §app.sessions-extension/agent-dir — Records live in pi's agent directory

The live-record directory is `<agent dir>/sessions/live`, and the config file is
`<agent dir>/sessions.json`. The agent dir is resolved exactly as pi's own `getAgentDir()` does:
`$PI_CODING_AGENT_DIR` when it is set and not empty (a leading `~` or `~/` expanded to the home
directory, a `file://` URL converted to its path, any other value taken as given), else
`~/.pi/agent`. A writer and its readers therefore agree: a hermetic pi or Sova runtime started
with `PI_CODING_AGENT_DIR=<dir>` writes and reads its live records under `<dir>`, never in the
user's real `~/.pi/agent`, and Sova's server, which resolves the same directory through pi,
finds them there.

What was explicit still wins. A record writer given its own directory uses it. For
`pi-sessions`, `--dir <path>` wins over `$PI_SESSIONS_DIR`, which in turn wins over the
agent-dir default.
