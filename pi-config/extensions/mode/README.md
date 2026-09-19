# Mode switcher for Pi

A global toggle between **normal** mode (pi as usual) and **claude-heavy**
mode, where the main agent becomes an orchestrator and delegates work to
Claude Code background workers through the `subagents` + `claude-code`
extensions:

- **Coding implementation** → `claude-code` workers on `opus[1m]`; the
  orchestrator picks `low` effort for mechanical changes and `medium` where
  precision matters (concurrency, migrations, public interfaces…).
- **Planning** → a `claude-code` worker on `claude-fable-5-1[1m]` at `medium`
  (the user can override effort per task). If the fable model is not offered,
  planning automatically falls back to `opus[1m]` at `high`, and the status
  bar says so.
- The main thread stays the only voice to the user and verifies every worker
  result (reads diffs, runs tests) regardless of worker effort.

Simple questions, command runs, and trivially obvious one-line fixes stay with
the main thread; anything that would normally need a subagent or non-trivial
edit goes to a worker. Both extensions must be loaded; no changes to pi and no
Claude plan mode are involved — workers run with bypassed permissions as usual.

## Install

```sh
~/pi-config/install.sh   # links this directory into ~/.pi/agent/extensions/
# /reload in pi
```

## Usage

| Action | Effect |
| --- | --- |
| `alt+m` or `/mode` | Toggle normal ↔ claude-heavy |
| `/mode normal` · `/mode claude-heavy` | Set explicitly |
| `/mode status` | Show mode, active planner, strict flag, state file |
| `/mode strict on\|off` | Also remove `edit`/`write` from the orchestrator while heavy (off by default) |
| `pi --mode claude-heavy` | Start that launch in a mode (not persisted) |

The footer always shows the current mode:

- `• normal` (dim)
- `◆ claude-heavy` (accent)
- `◆ claude-heavy · plan:opus` (warning: fable planner not offered, opus/high in use)
- `◆ claude-heavy · strict`

Every switch appends a `── mode → … ──` marker to the transcript.

## Behaviour

While heavy, the extension appends orchestration instructions to the system
prompt on every turn (`before_agent_start`), so toggling takes effect on the
next prompt without `/reload`. The mode persists globally across projects and
restarts in `~/.pi/agent/mode.json`:

```json
{ "version": 1, "mode": "claude-heavy", "strict": false }
```

An optional `"shortcut"` field (a pi-tui KeyId such as `"alt+h"`) changes the
toggle key on the next reload.

Planner availability is probed on entering heavy mode and on every session
start while heavy, through the `subagents:backend-discover` contract — the same
model discovery `agent_models` uses (a ~1–3 s `claude` initialize call, cached
60 s, 15 s timeout). No worker starts at load or in normal mode. If the probe
fails, planning uses `opus[1m]` at `high`; at runtime the injected instructions
also tell the orchestrator to retry a failed planning worker once on opus/high.

## Limits

Delegation bias is instruction-level. Even in strict mode the orchestrator
keeps `bash`, so nothing hard-forces delegation; strict only makes `edit` and
`write` unavailable. Mid-turn toggles apply from the next prompt.

## Verification

```sh
cd extensions/mode
node --test index.test.ts   # pure state/prompt/planner logic
node tests/smoke.mjs        # real index.ts against a fake pi host, no model requests
```
