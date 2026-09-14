# pi-config

Configuration and custom extensions for the [pi coding agent](https://pi.dev)
(`@earendil-works/pi-coding-agent`). Cloning this repository and running
`install.sh` reproduces the whole setup: settings, keybindings, model catalog
additions, the pinned third-party packages, and three extensions kept in-tree.

## Layout

| Path | What it is |
| --- | --- |
| `settings.json` | Pi settings, including the pinned package list |
| `keybindings.json` | Key overrides |
| `models.json` | Extra providers and model overrides (local Ollama and Ollama Cloud) |
| `extensions/subagents/` | Background subagents with steering, wake-on-complete, fork, and a monitor |
| `extensions/command-palette/` | `Ctrl+P` palette over models, sessions, settings, extension commands and skills |
| `extensions/extension-toggle/` | `/extensions` to switch extensions on and off in-session |
| `install.sh` | Symlinks the above into `~/.pi/agent` |

Each extension directory has its own README with usage and verification steps.

## Pinned packages

`settings.json` pins every third-party package to an exact version or commit,
so `pi update --extensions` leaves them alone. To move one, run
`pi install <source>@<new version>`; pi rewrites the entry.

| Package | Pinned | Notes |
| --- | --- | --- |
| `npm:pi-web-access` | 0.29.0 | Web search and fetch tools |
| `npm:pi-lens` | 4.1.6 | Extension entry disabled; skills and prompts still load |
| `npm:pi-intercom` | 0.13.0 | |
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
cd extensions/subagents && node tests/run.mjs && node tests/smoke.mjs
cd extensions/extension-toggle && node --test index.test.ts
cd extensions/command-palette && node --test test.mjs
```

The subagent tests resolve the globally installed pi package through its own
TypeScript loader; no dependencies are installed in this repository.
