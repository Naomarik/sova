# pi-config

Configuration and custom extensions for the [pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). Cloning this repository and running
`install.sh` reproduces the whole setup: settings, keybindings, model catalog
additions, the pinned third-party packages, and the extensions kept in-tree.

> **Mirror.** The public repository
> [Naomarik/pi-config](https://github.com/Naomarik/pi-config) is a
> `git subtree split` mirror of the `pi-config/` directory of a private
> monorepo (the pi-web app, which embeds pi and reads some of these
> extensions' files). Development happens there, and changes reach this
> repository as ordinary fast-forward pushes. Everything in this
> directory is self-contained: clone the mirror and `install.sh` works
> without the web app.

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
| `extensions/mode/` | Global normal ↔ claude-heavy mode switcher plus minor modes (`alt+m`, `ctrl+p` → Mode, `/mode`), orchestrating Claude Code workers with a fable/opus planner fallback |
| `extensions/sessions/` | Live pi sessions on this machine find each other through a filesystem presence registry; ships the `pi-sessions` CLI (`bin/pi-sessions.ts`) and the record schema (`public/SCHEMA.md`) |
| `extensions/codefold/` | Folds long fenced code blocks in assistant messages into one band |
| `extensions/topic-outline/` | Display-only live topic outline of the conversation, with jump-to-topic |
| `extensions/usage-status.ts` | Subscription usage (Ollama Cloud, OpenAI Codex, Claude, Z.ai) in the footer, plus a `/usage` overlay |
| `extensions/wake-nudge.ts` | Lets the model schedule one-shot wakeups |
| `extensions/working-subagent-count.ts` | Busy subagent and team-member counts on the "Working" line and in an idle widget |
| `install.sh` | Symlinks the config files and every `extensions/*` directory and single-file `extensions/*.ts` extension into `~/.pi/agent`, and `pi-sessions` into `~/.local/bin` |

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

Requirements: pi installed globally (`npm i -g @earendil-works/pi-coding-agent`;
this config tracks 0.85.1) and Node.js. Nothing is installed into this
directory: there is no `package.json`, and the extensions load through pi.
`claude-code` also needs an authenticated `claude` CLI.

```sh
git clone https://github.com/Naomarik/pi-config.git ~/pi-config
~/pi-config/install.sh
pi            # installs missing pinned packages on first start
/reload
```

The clone can live anywhere. `install.sh` resolves its own location, and the
links it creates point at the real path of the checkout. If you have the pi-web
monorepo, run `pi-config/install.sh` from there instead; it is the same script.

For each of `settings.json`, `keybindings.json`, `models.json`, every
`extensions/*/` directory and every `extensions/*.ts` file, `install.sh`
creates a symlink in the agent directory. It also links
`extensions/sessions/bin/pi-sessions.ts` to `~/.local/bin/pi-sessions`. An
existing symlink at a target is replaced, and an existing regular file or
directory is moved to `<name>.bak`. Nothing else under `~/.pi/agent` is
touched. The agent directory is `$PI_AGENT_DIR`, else `$PI_CODING_AGENT_DIR`,
else `~/.pi/agent`.

Edits in the checkout take effect in pi on the next `/reload`.

`./install.sh --check` changes nothing. It exits nonzero if any of those links
is missing or points elsewhere, or if the agent's `extensions/` directory holds
anything that is not a symlink into this checkout (for example a hand-copied
extension file).

### Credentials and external tools

This repository holds no credentials. Each machine needs these logins:

| Needed for | Credential | Where it lives | How to set it up |
| --- | --- | --- | --- |
| Default model (`zai` / `glm-5.3` in `settings.json`) | Z.ai API key | `~/.pi/agent/auth.json`, key `zai` | `/login` in pi, or `ZAI_API_KEY` |
| `ollama-cloud` provider (`models.json`) | Ollama API key | `auth.json`, key `ollama-cloud` | `/login` in pi |
| `openai-codex` models | ChatGPT Plus/Pro OAuth | `auth.json`, key `openai-codex` | `/login` in pi |
| Local `ollama` provider | none (placeholder key; Ollama at `localhost:11434`) | | |
| `claude-code`, the Claude side of `mode`, the `topic-outline` Claude summarizer | Claude Code login | Managed by the `claude` CLI (`~/.claude/.credentials.json` on Linux) | Install [Claude Code](https://claude.com/claude-code) and log in once inside `claude` |

pi writes `auth.json` with mode `600`; keep it that way (`chmod 600 ~/.pi/agent/auth.json`).
The `claude-code` extension spawns `claude` from `PATH`. The topic-outline summarizer runs
`~/.local/bin/claude` unless `claudeBin` in `~/.pi/agent/topic-outline.json` says otherwise.

`usage-status` reads these same credential files to show subscription usage, falling back to
`~/.codex/auth.json` for OpenAI if pi has no `openai-codex` login. A provider without a login
shows as unavailable. The `sessions` extension's jump-to-session focus uses `tmux` and, on
Hyprland, `hyprctl`. `pi-sessions` needs `~/.local/bin` on `PATH`. The extensions' TypeScript
tests and the `pi-sessions` CLI need Node's built-in type stripping (Node ≥ 22.19, pi's own floor).

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
cd extensions/sessions && node --test test.mjs
cd extensions/codefold && node tests/run.mjs
cd extensions/topic-outline && node test.mjs
```

These make no model requests. The subagent and Claude tests resolve the
globally installed pi package through the subagents TypeScript loader; no
dependencies are installed in this repository. Opt-in live tests that do make
small requests (`--live`) are described in each extension's README. A separate
real-TUI regression harness (`extensions/subagents/tests/team-ui-smoke.mjs --phase all`)
drives `/agents` and the native `/team` workspace in a private tmux server with fake
providers/workers and no model requests.
