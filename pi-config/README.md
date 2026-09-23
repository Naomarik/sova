# pi-config

Configuration and custom extensions for the [pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). This directory lives in the
[Sova](https://github.com/Naomarik/sova) repository and installs from a Sova
checkout: run `~/.local/share/sova/pi-config/install.sh` for the default Sova
installation, or `pi-config/install.sh` from a checkout. Running it reproduces
the whole setup: settings, keybindings, model catalog additions, the pinned
third-party packages, and the extensions kept in-tree.

Everything in this directory is self-contained: a copy of this directory
installs with `install.sh` alone, without the web app.

## Layout

| Path | What it is |
| --- | --- |
| `settings.json` | Seed for pi's settings, including the pinned package list; merged into the live file by `install.sh`, not linked |
| `vision-delegate.json` | Fallback vision models and budget for the `vision-delegate` extension |
| `keybindings.json` | Key overrides |
| `models.json` | Extra providers and model overrides (local Ollama and Ollama Cloud) |
| `extensions/subagents/` | Background subagents with steering, wake-on-complete, fork, a monitor, and native coordinated teams |
| `extensions/claude-code/` | `claude-code` worker backend for the subagent tools, driving the installed Claude Code CLI |
| `extensions/command-palette/` | `Ctrl+P` palette over models, sessions, settings, extension commands and skills |
| `extensions/extension-toggle/` | `/extensions` to switch extensions on and off in-session |
| `extensions/explain/` | `/explain <topic>`: one forked subagent writes a self-contained HTML explanation into `~/.pi/agent/explanations/`, kept forever and read in Sova |
| `extensions/model-policy/` | The shared model policy (`model-policy.json`): which providers and models may be used at all, and which of them subagents may be given. Written by Sova's Settings → Models tab; this extension enforces the global half in the TUI |
| `extensions/mode/` | Per-session normal ↔ delegate mode switcher plus minor modes (`alt+m`, `ctrl+p` → Mode, `/mode`). Delegate (formerly claude-heavy) orchestrates workers by four profiles — planning, investigation, routine and complex implementation — each a configurable backend/model/effort with an optional fallback (`mode-delegate.json`) |
| `extensions/spec/` | Not a pi extension (no `index.ts`; pi skips it): standalone `.sova/spec` tools that the `spec` minor mode in `extensions/mode/` tells the agent to run. `core/sova-spec.mjs` is read-only; `core/sova-spec-draft.mjs` keeps proposed documentation in full-copy drafts and promotes the implemented, verified part, writing only with `--write`; `core/sova-spec-review.mjs` records review evidence, and writes only under `.sova/spec/reviews/` and only with `--write` or `record` |
| `extensions/sessions/` | Live pi sessions on this machine find each other through a filesystem presence registry; ships the `pi-sessions` CLI (`bin/pi-sessions.ts`) and the record schema (`public/SCHEMA.md`) |
| `extensions/remote/` | `--target <name>`: runs the session's tools on an ssh / AWS-SSM / docker / incus target from `targets.json`; inert without the flag. Its `argv.ts` is imported by Sova |
| `extensions/codefold/` | Folds long fenced code blocks in assistant messages into one band |
| `extensions/topic-outline/` | Display-only live topic outline of the conversation, with jump-to-topic |
| `extensions/vision-delegate/` | Lets a text-only model work with images: a `look_at_image` tool plus automatic descriptions of read results and TUI attachments, routed to a fallback vision model |
| `extensions/usage-status/` | Subscription usage (Ollama Cloud, OpenAI Codex, Claude, Z.ai, DeepSeek balance) in the footer, plus a `/usage` overlay. Its `fetch.ts` (fetchers, cache, lock) is imported by Sova |
| `extensions/wake-nudge.ts` | Lets the model schedule one-shot wakeups |
| `extensions/working-subagent-count.ts` | Busy subagent and team-member counts on the "Working" line and in an idle widget |
| `install.sh` | Merges `settings.json` into `~/.pi/agent/settings.json`, symlinks the other config files and every `extensions/*` directory and single-file `extensions/*.ts` extension into `~/.pi/agent`, and `pi-sessions` into `~/.local/bin` |

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
`pi install <source>@<new version>`; pi rewrites the entry in the live
`~/.pi/agent/settings.json`, and `install.sh --save` copies it back here.

| Package | Pinned | Notes |
| --- | --- | --- |
| `npm:pi-web-access` | 0.29.0 | Web search and fetch tools |
| `npm:pi-lens` | 4.1.6 | Extension entry disabled; skills and prompts still load |
| `npm:pi-powerline-footer` | 0.17.1 | Extension entry disabled |
| `git:github.com/tmustier/pi-extensions` | commit `09706a7` | Only the usage extension is selected, and it is currently toggled off |
| `npm:pi-btw` → local fork | 0.4.1 | Forked into `extensions/btw/`; degrades on headless hosts instead of going silent |
| `npm:@narumitw/pi-stamp` | 0.51.0 | |

## Install

Requirements: pi installed globally (`npm i -g @earendil-works/pi-coding-agent`;
this config is used with 0.87.0; Sova's own `package.json` pins 0.86.1) and Node.js. Nothing is installed into this
directory: there is no `package.json`, and the extensions load through pi.
`claude-code` also needs an authenticated `claude` CLI.

```sh
~/.local/share/sova/pi-config/install.sh   # the default Sova installation
# or, from a Sova checkout:
pi-config/install.sh
pi            # installs missing pinned packages on first start
/reload
```

A copy of this directory can live anywhere. `install.sh` resolves its own
location, and the links it creates point at the real path of the copy.

For each of `keybindings.json`, `models.json`, `vision-delegate.json`, every
`extensions/*/` directory and every `extensions/*.ts` file, `install.sh`
creates a symlink in the agent directory. It also links
`extensions/sessions/bin/pi-sessions.ts` to `~/.local/bin/pi-sessions`. An
existing symlink at a target is replaced, and an existing regular file or
directory is moved to `<name>.bak`. Nothing else under `~/.pi/agent` is
touched. The agent directory is `$PI_AGENT_DIR`, else `$PI_CODING_AGENT_DIR`,
else `~/.pi/agent`.

Edits in the checkout take effect in pi on the next `/reload`.

`settings.json` is not linked, because pi writes runtime state into its
settings file: the model last picked in the TUI (`defaultProvider`,
`defaultModel`), `lastChangelogVersion`, `/settings` changes, `pi install`.
Linked, all of that landed in this repository. Instead `settings.json` here is
a seed that `install.sh` deep-merges over the live `~/.pi/agent/settings.json`
and writes there as a regular file: every key the seed declares takes the
seed's value, and every other live key is kept as it was. Arrays such as
`packages` are replaced, not concatenated. With no live file, the seed is
copied as is. When the merge changes the live file, its previous content is
copied to `settings.json.bak` first; a symlink left by an older `install.sh` is
replaced without writing into its target. The seed pins no provider or model,
and runtime keys are deliberately not tracked: they live only in the live file.

Config moves between the two files explicitly:

- outward: edit the seed and re-run `install.sh`;
- back: after a deliberate change in the TUI or with `pi install`, run
  `./install.sh --save`. It copies the live values of the keys the seed already
  declares into the seed and lists them; a key the seed does not declare is
  never added, so a model choice stays out. Declaring a new key is an edit to
  the seed.

`./install.sh --check` changes nothing. It exits nonzero if any of those links
is missing or points elsewhere, if the agent's `extensions/` directory holds
anything that is not a symlink into this checkout (for example a hand-copied
extension file), or if `~/.pi/agent/settings.json` is a symlink, is missing, or
differs from the seed in any key the seed declares (each is printed with the
seed's and the live value).

### Credentials and external tools

This repository holds no credentials and pins no default model: pick one with
`/model` (or `Ctrl+P`) and pi remembers it in the live settings file. Each
machine needs the logins for the providers it uses:

| Needed for | Credential | Where it lives | How to set it up |
| --- | --- | --- | --- |
| `zai` provider | Z.ai API key | `~/.pi/agent/auth.json`, key `zai` | `/login` in pi, or `ZAI_API_KEY` |
| `ollama-cloud` provider (`models.json`) | Ollama API key | `auth.json`, key `ollama-cloud` | `/login` in pi |
| `openai-codex` models | ChatGPT Plus/Pro OAuth | `auth.json`, key `openai-codex` | `/login` in pi |
| `deepseek` provider (built-in catalog: `deepseek-flash`, `deepseek-v4-pro`), and the DeepSeek balance in `usage-status` | DeepSeek API key | `auth.json`, key `deepseek` | `/login` in pi, or `DEEPSEEK_API_KEY` |
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
`.gitignore`. The runtime keys pi writes into its settings file (the chosen
model, `lastChangelogVersion`, ...) stay in `~/.pi/agent/settings.json`; see
Install. `models.json` contains no keys; the local Ollama entry's
`apiKey` is the literal placeholder Ollama expects.

## Tests

```sh
node --test install.test.mjs
cd extensions/subagents && node tests/run.mjs && node tests/smoke.mjs && node tests/team-smoke.mjs
cd extensions/claude-code && node tests/run.mjs && node tests/smoke.mjs && node tests/ui-permissions.mjs
cd extensions/extension-toggle && node --test index.test.ts
cd extensions/mode && node --test index.test.ts delegate.test.ts routing.test.ts align.test.ts && node tests/smoke.mjs
cd extensions/model-policy && node --test policy.test.ts index.test.ts
cd extensions/command-palette && node --test test.mjs
cd extensions/sessions && node --test test.mjs
cd extensions/spec && node --test tests/*.test.mjs
cd extensions/codefold && node tests/run.mjs
cd extensions/remote && node --test argv.test.ts
cd extensions/explain && node tests/run.mjs && node tests/smoke.mjs
cd extensions/topic-outline && node test.mjs
cd extensions/vision-delegate && node tests/run.mjs
```

These make no model requests. `install.test.mjs` runs a copy of `install.sh`
against a temporary `HOME` and agent directory. The subagent and Claude tests resolve the
globally installed pi package through the subagents TypeScript loader; no
dependencies are installed in this repository. Opt-in live tests that do make
small requests (`--live`) are described in each extension's README. A separate
real-TUI regression harness (`extensions/subagents/tests/team-ui-smoke.mjs --phase all`)
drives `/agents` and the native `/team` workspace in a private tmux server with fake
providers/workers and no model requests.
