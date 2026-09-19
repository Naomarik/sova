# Native teams — independent real-TUI verification

Status: harness ready; `/team` checks BLOCKED until the team command and workspace land. 2026-09-19.

Harness: `extensions/subagents/tests/team-ui-smoke.mjs` (new file only; no source or existing test changed).

## What it is

A standalone offline smoke test that runs a **real interactive Pi TUI** (installed Pi 0.85.1,
`dist/bundle/cli.js`) inside a **private tmux server**. It sends real key sequences through the
pane, reads the rendered screen with `capture-pane`, and resizes the terminal. It does not
replace the component and integration tests planned for batches 2 and 3. It covers what those
tests cannot: overlay hiding and restoring in a live terminal, which component has keyboard focus
after editors and dialogs close, and survival across resizes.

```sh
cd extensions/subagents
node tests/team-ui-smoke.mjs                 # all phases
node tests/team-ui-smoke.mjs --phase agents  # harness self-check on the existing /agents workspace
node tests/team-ui-smoke.mjs --phase team    # team checks only
node tests/team-ui-smoke.mjs --keep          # keep the temp dir (screens, events.jsonl)
node tests/team-ui-smoke.mjs --source /tmp/pi-teams-preimplementation/extensions  # frozen tree
```

Exit codes: `0` all requested checks passed; `1` a check failed (the temp dir is kept and the
screen at failure is printed); `2` the harness itself passed but the team checks are **BLOCKED**
(API or workspace missing). BLOCKED never counts as a pass.

## Real vs fake

| Part | Real or fake |
| --- | --- |
| Pi interactive TUI: rendering, overlays, `setHidden`/`focus`, confirm dialog, extension editor, footer, key decoding, resize, quit | **Real** (installed Pi, real pty via tmux) |
| `registerSubagents` (`index.ts`): tools, `/agents`, workspace slot, overlay hiding, steering path, shutdown | **Real** (loaded from the repo, or from `--source`) |
| `registerClaudeCode`: `validate`, `prepare`, `PermissionQueue`, `BACKEND_DIALOG_EVENT` tokens, the `ctx.ui.confirm` permission prompt | **Real**. Only the backend's `create` is swapped for a fake worker; `listModels` is removed so no `claude` process is started. |
| Workers (both backends) | **Fake**: in-process objects that follow the `Worker` contract, with no child process and no model. Every steer, kill, dispose and permission decision goes to `events.jsonl`. |
| Parent model | **Fake provider** `harness/offline` pointing at `http://127.0.0.1:9/v1` (connection refused). Every attempt is counted through `before_provider_request`. No API keys are in the environment. |
| Test driving | Tool calls (`agent_spawn`, `team_create`) and out-of-band events (worker settle, permission request) go through a file control channel in the temp dir, with no model involved. Everything the user would do goes through tmux keystrokes. |

The wrapper extension is generated inside the temp dir. It wraps the `pi` API in a Proxy that
records `sendMessage`, `sendUserMessage` and `appendEntry` and captures registered tools and
commands. Calls are still forwarded to Pi unchanged.

## Isolation and cleanup

- Temp root `pi-team-ui-smoke-*`: `PI_CODING_AGENT_DIR`, session dir, `HOME` and XDG dirs all point
  inside it. Pi is started via `env -i` with an allowlisted environment plus `--offline
  --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes`, and the only
  extension is loaded with `-e`. The working directory is an empty temp dir, so no project trust
  prompt and no `.pi` resources.
- tmux runs with `-S <temp>/tmux.sock -f <temp>/tmux.conf` and `TMUX_TMPDIR`/`HOME` set to temp
  paths. It never touches the user's tmux server, sessions or `~/.tmux.conf`. The config enables
  `extended-keys` with `csi-u` (Pi's documented tmux setup) and `escape-time 0`.
  (`window-size manual` in the config crashes tmux 3.6b's server; `resize-window` sets it per
  window instead.)
- Cleanup: quit Pi with `Ctrl+D`. If the recorded pane PID is still alive, it gets SIGTERM and
  then SIGKILL, by exact PID only. Then `kill-server` on the private socket. The harness asserts
  `/proc/<pid>` is gone. The temp dir is removed on pass or BLOCKED and kept on failure or with
  `--keep`.
- No npm installs, commits, reloads, network requests or paid tasks.

## Checks

### Phase A: harness self-validation on `/agents` (works today)

| ID | Verifies |
| --- | --- |
| A0 | Real TUI starts in the isolated config; the pane PID is the Pi process; `/agents`, `agent_spawn` and the real claude-code backend registration are present |
| A1 | Two fake `pi` workers and one fake `claude-code` worker (`permissionMode: manual`) spawn through the real `agent_spawn`; the footer shows `3 working` |
| A2 | Typing `/agents` + Enter opens the real overlay |
| A3 | `j` then `f` reach the overlay; the editor titled `Follow up: beta` appears and the overlay is hidden while composing; submitting delivers to the exact ID in `followUp` mode; the overlay comes back |
| A4 | Focus is back on the overlay after the editor (`k`, `r` opens `Redirect: alpha`); Esc cancels and sends nothing |
| A5 | The real Claude permission handler opens `Claude worker permission`, with the overlay hidden; `j` + Enter chooses **No**. The default is Yes, so if `j` had leaked to the hidden overlay the result would be allow. The decision is `deny`, the overlay is restored, and `f` opens its editor, proving the overlay has focus again |
| A6 | Resize to 60×18, 34×10 and back to 120×40: Pi stays alive and the overlay renders again |
| A7 | `q` closes the overlay; settling a `wake:false` worker sends `subagent-complete` with `triggerTurn:false`; **0** provider requests |
| Z1 | `Ctrl+D` quits; every created fake worker was killed or disposed; one `session_shutdown`; the process is gone |

### Phase B: `/team` (BLOCKED until implemented)

The phase is skipped as BLOCKED if the `/team` command or any of `team_create`, `team_add` or
`team_list` is missing. B4–B10 are BLOCKED as a group if `/team` does not render a workspace
showing both roles and both exact member IDs.

| ID | Verifies (plan/review requirement) |
| --- | --- |
| B1 | Bare `/team`: no `sendMessage`/`sendUserMessage`, no provider request (decision 7) |
| B2 | `team_create` returns `teamId` matching `team_NN` and `members[{role, workerId}]`; the builder's task contains team name, objective, role, declared path and its own prompt (decision 3) |
| B3 | Widget shows the team name above the editor while no workspace is open (decision 8) |
| B4 | `/team` renders team name, both role names and both exact worker IDs |
| B5 | Invoking the `/agents` handler while `/team` is open does not open a second overlay; the team view is still shown (decision 1) |
| B6 | `f` opens a follow-up editor; submission reaches a team member's exact ID in `followUp` mode; the workspace is restored |
| B7 | `r` editor title contains `Redirect` and `interrupts current task` (review); Esc sends nothing |
| B8 | A real Claude permission prompt while `/team` is open: workspace hidden, dialog owns keys (deny), workspace restored and focused |
| B9 | First `x` only arms; second `x` stops exactly one team member (decision 4) |
| B10 | Survives 30, 60 and 120 columns; `q` closes |
| B11 | `/team HARNESS_PLAN_OBJECTIVE` sends one `team-plan` message with `display:true`, `deliverAs:"followUp"`, `triggerTurn:true` containing the objective. The triggered turn goes to the dead local endpoint (counted, no network). |

**UI-text assumptions batch 2/3 must meet, or the harness must be adjusted with a note here:**
the workspace shows the team name, role names and exact `ag_NN` IDs; the editor titles contain
`Follow up` / `Redirect` (case-insensitive) plus `interrupts current task` for redirect; `f`, `r`,
`x x`, `q`/Esc keep the `/agents` vocabulary; the widget includes the team name. The member under
the cursor when the workspace opens may be either role; B6 accepts either one and records which.

## Recorded runs (2026-09-19)

| Command | Result |
| --- | --- |
| `--phase agents` on the live repo, first attempt (mid-edit `index.ts`) | FAIL A2: `Extension "command:agents" error: modal is not defined`. An in-flight Batch 1 edit, fixed in the tree minutes later. It shows the harness catches a real broken `/agents`. |
| `--phase agents --source /tmp/pi-teams-preimplementation/extensions` | PASS A0–A7, Z1 (exit 0) |
| `--phase agents` on the live repo, later | PASS A0–A7, Z1 (exit 0) |
| `--phase team` on the live repo | A0, Z1 PASS; `B*` BLOCKED: missing `/team` command and `team_create`/`team_add`/`team_list` tools (exit 2). `teams.ts` exists and `team_create` is in progress in `index.ts` but not registered at run time. |

After every run: no leftover harness process and no leftover `pi-team-ui-smoke-*` temp dir
(unless `--keep`).

## Still unverified by this harness

- **Exact line widths.** tmux clips at the pane edge and pi-tui does not throw on overflow, so a
  line that is too wide cannot be detected from `capture-pane`. Exact-width rendering must stay
  covered by component tests (`render(width)` at 30/60/120).
- **Styling.** Colours, dim and inverse selection are not asserted (`capture-pane` without `-e`).
- **Hardware cursor and IME positioning**, mouse and fullscreen mode, and terminals other than
  tmux with `csi-u` extended keys (Kitty protocol, Shift+Enter).
- **Real worker processes.** Pi RPC children and the `claude` CLI are never started. The real
  permission handler runs, but a fake worker asks for the permission. Live behaviour stays with
  the opt-in live smoke.
- **Model behaviour.** Nothing checks that a parent model actually uses `team_*` tools after
  `/team <objective>`; only the queued message and the turn trigger are checked.
- **Session lifecycle in the TUI.** `/reload`, `/resume`, `/tree` branch filtering and restored
  "previous session" members are not driven here (the plan covers them with `index.test.ts`).
  Clearing the widget on shutdown is only inferred from dispose and exit, because the screen is
  gone after quit.
- **Widget width at 30 columns** is only checked for survival (B10), not content.
- **Timing.** The checks use bounded waits (`until`, deadlines of about 3–8 s) plus short fixed
  delays after keystrokes. A heavily loaded machine could produce false failures, never false
  passes: every pass needs the expected screen text or event.
