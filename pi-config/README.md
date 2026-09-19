# pi-config

Configuration and custom extensions for the [pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). Cloning this repository and running
`install.sh` reproduces the whole setup: settings, keybindings, model catalog
additions, the pinned third-party packages, and five extensions kept in-tree.

## Layout

| Path | What it is |
| --- | --- |
| `settings.json` | Pi settings, including the pinned package list |
| `keybindings.json` | Key overrides |
| `models.json` | Extra providers and model overrides (local Ollama and Ollama Cloud) |
| `extensions/subagents/` | Background subagents with steering, wake-on-complete, fork, a monitor, and native coordinated teams |
| `extensions/claude-code/` | `claude-code` worker backend for the subagent tools, driving the installed Claude Code CLI |
| `extensions/command-palette/` | `Ctrl+P` palette over models, sessions, settings, extension commands and skills |
| `extensions/extension-toggle/` | `/extensions` to switch extensions on and off in-session |
| `extensions/mode/` | Global normal ↔ claude-heavy mode switcher (`alt+m`, `/mode`), orchestrating Claude Code workers with a fable/opus planner fallback |
| `install.sh` | Symlinks the config files and every `extensions/*` directory and single-file `extensions/*.ts` extension into `~/.pi/agent` |

Each extension directory has its own README with usage and verification steps.
`claude-code` only works alongside `subagents` and needs an installed,
authenticated `claude` CLI; it starts no process until a Claude worker or
model discovery is requested. `subagents` also provides session-scoped coordinated
**teams** (`team_create`/`team_add`/`team_list`, `/team`): explicit roles and advisory
owned paths, a native roster/transcript workspace with direct follow-up and redirect
controls, and a status widget. See [docs/native-teams.md](docs/native-teams.md). Teams
stop with this Pi session; they do not provide peer-to-peer worker messaging.

## Pinned packages

`settings.json` pins every third-party package to an exact version or commit,
so `pi update --extensions` leaves them alone. To move one, run
`pi install <source>@<new version>`; pi rewrites the entry.

| Package | Pinned | Notes |
| --- | --- | --- |
| `npm:pi-web-access` | 0.29.0 | Web search and fetch tools |
| `npm:pi-lens` | 4.1.6 | Extension entry disabled; skills and prompts still load |
| `npm:pi-powerline-footer` | 0.17.1 | Extension entry disabled |
| `git:github.com/tmustier/pi-extensions` | commit `09706a7` | Only the usage extension is selected, and it is currently toggled off |
| `npm:pi-btw` | 0.4.1 | |
| `npm:@narumitw/pi-stamp` | 0.51.0 | |

## Install

```sh
git clone <this repo> ~/pi-config
~/pi-config/install.sh
pi            # installs missing pinned packages on first start
/reload
```

`install.sh` moves any existing regular file it would overwrite to `<name>.bak`
and replaces existing symlinks. Nothing under `~/.pi/agent` other than the
linked files is touched.

## What is deliberately not here

Credentials (`auth.json`), sessions, the model catalog cache, model favorites
and the trust list are runtime state or secrets and are ignored by
`.gitignore`. `models.json` contains no keys; the local Ollama entry's
`apiKey` is the literal placeholder Ollama expects.

## Tests

```sh
cd extensions/subagents && node tests/run.mjs && node tests/smoke.mjs && node tests/team-smoke.mjs
cd extensions/claude-code && node tests/run.mjs && node tests/smoke.mjs && node tests/ui-permissions.mjs
cd extensions/extension-toggle && node --test index.test.ts
cd extensions/mode && node --test index.test.ts && node tests/smoke.mjs
cd extensions/command-palette && node --test test.mjs
```

These make no model requests. The subagent and Claude tests resolve the
globally installed pi package through the subagents TypeScript loader; no
dependencies are installed in this repository. Opt-in live tests that do make
small requests (`--live`) are described in each extension's README. A separate
real-TUI regression harness (`extensions/subagents/tests/team-ui-smoke.mjs --phase all`)
drives `/agents` and the native `/team` workspace in a private tmux server with fake
providers/workers and no model requests.
