# pi-web

A local web app for the [pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`,
pinned **0.86.1**), plus the pi configuration and extensions it runs with. The app lists every pi
session on the machine, shows transcripts, chats in sessions it owns, live-watches sessions open in
a pi TUI (read-only), and spawns new sessions. It is for one local user.

This is a monorepo:

| Path | What it is |
| --- | --- |
| `server/` | Node backend: Hono REST and `ws`, with the pi SDK embedded |
| `src/` | SolidJS + TypeScript frontend (Vite) |
| `shared/protocol.ts` | REST/WS wire contract between the two |
| `public/`, `src/design/`, `spec/` | Design tokens, fonts, icons, UX spec |
| `themes/` | The built-in themes, one JSON file each (see [Themes](#themes)) |
| `docs/` | Research and feasibility notes |
| `pi-config/` | pi settings, keybindings, model catalog and custom extensions, symlinked into `~/.pi/agent` by `pi-config/install.sh`. It is also published on its own (see [pi-config public mirror](#pi-config-public-mirror)) |
| `.claude/skills/` | Claude Code skills for agents working in this repo: `fold-ai-dev-design` (the design system, copied from foldaidev, tracked on purpose) and `playwright` (browser driving) |
| `CLAUDE.md` | Architecture, ownership and pi SDK facts for coding agents. Read it before changing the server |

## Fresh machine setup

Requirements: Node.js **≥ 22.19** (pi's `engines` floor; the extensions' `node --test *.ts` runs and
the `pi-sessions` CLI also need Node's built-in TypeScript stripping). This machine uses Node
25.2.1, managed by [mise](https://mise.jdx.dev) in `~/.config/mise/config.toml`. The repo has no
`.tool-versions` or `engines` of its own.

```sh
# 1. Node and pi. Keep pi on the pinned version: pi loads the pi-config extensions and the
#    extension tests resolve the globally installed package.
mise use -g node@25.2.1
npm install -g @earendil-works/pi-coding-agent@0.86.1

# 2. This repo
gh auth login                       # private repo; the token is kept in the OS keyring
gh repo clone Naomarik/pi-web ~/webapps/pi-web
cd ~/webapps/pi-web
npm install                         # the server embeds its own pi 0.86.1 from node_modules

# 3. pi config and extensions -> ~/.pi/agent (and pi-sessions -> ~/.local/bin, which must be on PATH)
pi-config/install.sh
pi-config/install.sh --check        # exits 0 when every link is in place

# 4. First pi start: installs the pinned packages from settings.json. Then log in to providers.
pi
#   /login  -> zai (default model zai/glm-5.3), ollama-cloud (API key), openai-codex (ChatGPT subscription)
#   /reload

# 5. Claude Code CLI, needed by the claude-code, mode and topic-outline extensions
curl -fsSL https://claude.ai/install.sh | bash   # installs ~/.local/bin/claude
claude                                           # log in once in the CLI itself
```

`install.sh` also backs up any regular file it would replace to `<name>.bak`. Details are in
[`pi-config/README.md`](pi-config/README.md#install).

## Running

| Command | What it does |
| --- | --- |
| `npm run dev:server` | API and WebSocket server on port **4800** (`tsx watch`). `PORT=…` overrides it |
| `npm run dev:web` | Vite dev server on port **5173** with HMR; proxies `/api` and `/ws` to `localhost:4800` |
| `npm run build` | Typecheck, then `vite build` into `dist/` (git-ignored) |
| `npm start` | Server without watch. It also serves `dist/` when a build exists, so after a build the app runs on :4800 alone |
| `npm run typecheck` | `tsc --noEmit`; must pass. It does not cover `pi-config/` |

Open <http://localhost:5173> in development. The server has no authentication and binds every
interface (`*:4800`), so keep port 4800 behind a firewall.

The embedded pi reads and writes the same `~/.pi/agent` as the TUI: your real sessions, auth and
extensions. `PI_CODING_AGENT_DIR=/tmp/somewhere` points pi and the server at a scratch agent
directory for experiments, though some extensions still read fixed `~/.pi/agent` paths (for
example `usage-status` reads `~/.pi/agent/auth.json`). `CLAUDE.md` has the rules for not
corrupting sessions a TUI owns.

## Themes

A theme is one JSON file. The 18 that ship live in `themes/`; yours go in
`~/.pi/agent/pi-web/themes/`, and the file's name is the theme's id. Pick one in
**Settings → Themes**; the choice is kept in `localStorage` under `pi-web:theme` and applied
before the first paint.

```json
{
  "$schema": "pi-web-theme/v1",
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": {
    "accent": "$amber",
    "accent-hover": "#ffc46e",
    "accent-tint": "#3a2f1c"
  }
}
```

That is a whole theme: three keys over the dark base. Anything a file leaves out comes from the
base it extends, so you can change one color or all 30.

- `name` — 1–40 characters, what the picker shows.
- `extends` — `dark` (default) or `light`. It decides the base you overlay and the `data-theme`
  the document gets.
- `vars` — optional named values. A later key uses one by writing `"$name"` as its whole value;
  a var may reference an earlier var.
- `colors` — the semantic tokens without their `--color-` / `--status-` / `--diff-` prefix:
  `bg`, `surface`, `sunken`, `ink`, `ink-2`, `ink-muted`, `border`, `border-strong`, `accent`,
  `accent-hover`, `accent-tint`, `on-accent`, `status-{success,warn,error,info}` and their
  `-bg` fills, `diff-{add,del}-{bg,ink}`, `diff-gutter`, `shadow-1`…`shadow-3`, `scrim`,
  `skeleton-sweep`. The last five take whole CSS values, not just colors. `diff-gutter` is
  reserved — it is accepted and applied, but nothing reads it yet, so setting it changes nothing.
- `typography` — optional: `font-body`, `font-display`, `font-mono` — font *stacks*, naming faces
  already on the machine; a theme can't ship a font file — plus any `fs-*`, `lh-*`, `fw-*` or
  `ls-*` step, so a theme that swaps the face can retune its tracking. Set tracking in `em`: it
  scales with the size it applies to, these steps run from 11px to 40px, and every shipped value
  is an `em` or a bare `0`. The 16 palette themes leave typography out and keep Inter and
  JetBrains Mono.

Values are written onto custom properties as they stand, so every one is checked when the file
is read, against what's allowed rather than a list of what isn't:

- **Colors** — a hex value, or one call to `rgb`, `rgba`, `hsl`, `hsla`, `oklch`, `oklab`, `lab`,
  `lch`, `color-mix`, or `color`. One set of parentheses, no nesting. A color reaches a
  `background`, and a background can load an image, so the grammar is the thing that stops a
  theme file from fetching.
- **Shadows** — lengths, an optional `inset`, and a color. `scrim` and `skeleton-sweep` are colors
  and follow the color rule above.
- **Font stacks** — quotes and commas, no parentheses.
- **Sizes** — `fs-*` and `ls-*` take a `px` or `em` length or a bare `0`, `lh-*` a plain number,
  `fw-*` 100 to 900.

`shared/theme.ts` is the definition that actually runs. A value that fails makes the file a broken
row with the reason on it, and the theme isn't applied. The focus ring has no key of its own: it
follows whatever `accent` you set.

**Built-in:** `dark`, `light` (the two token blocks, exactly) · `dracula` · `tokyo-night`
(Storm), `tokyo-night-moon`, `tokyo-night-day` · `catppuccin-mocha`, `catppuccin-macchiato`,
`catppuccin-frappe`, `catppuccin-latte` · `monokai-pro`, `monokai-classic`, `monokai-machine`,
`monokai-ristretto` · `nord-classic`, `nord-frost`, `nord-aurora`, `nord-light`. Every one of
them clears WCAG AA on each text pair and 3:1 on control borders, in both the page and card
contexts. Give a file of your own the id of a built-in and yours wins — the picker marks that row
`replaces the built-in`, so an overridden theme is never a mystery.

**If a theme makes the app unreadable, you can always get back.** The picker renders in the theme
you're wearing, so a `typography` value far outside the scale can leave you unable to read the row
that would switch you off it. Delete or fix the file: an id that no longer resolves falls back to
Dark. Clearing the `pi-web:theme` key in `localStorage` does the same.

**Drop-in is live.** Save a file while the Themes tab is open and it appears within 2 seconds —
no restart, no rebuild. Editing the theme you're wearing re-applies it on the same beat, which
is the fastest way to tune one.

## Tests

The web app has no test suite; `npm run typecheck` and `npm run build` are the gate. Each extension
has its own tests, run from its directory. They make no model requests and install nothing: they
find `jiti` and pi's packages inside the global pi install (`npm root -g`, or `which pi` for
command-palette; `PI_PACKAGE_DIR` overrides the location for the subagents/codefold loaders).

```sh
cd pi-config/extensions
(cd subagents        && node tests/run.mjs && node tests/smoke.mjs && node tests/team-smoke.mjs)
(cd claude-code      && node tests/run.mjs && node tests/smoke.mjs && node tests/ui-permissions.mjs)
(cd extension-toggle && node --test index.test.ts)
(cd mode             && node --test index.test.ts && node tests/smoke.mjs)
(cd command-palette  && node --test test.mjs)
(cd sessions         && node --test test.mjs)
(cd codefold         && node tests/run.mjs)
(cd topic-outline    && node test.mjs)
```

The Playwright skill (`.claude/skills/playwright/scripts/`) declares only `sharp` in its
`package.json`. On a fresh clone, install its dependencies and a browser yourself:
`npm install && npm install --no-save playwright@1.54.1 && npx playwright install chromium`.

## Environment & secrets

Nothing below is in git. The repo holds configuration only; every credential and every piece of
runtime state stays on the machine.

**Credentials and logins**

| What | Where it lives | Used by | How to set it up |
| --- | --- | --- | --- |
| pi provider credentials: `zai` and `ollama-cloud` API keys, `openai-codex` OAuth tokens | `~/.pi/agent/auth.json`, mode **600** | pi, the embedded server runtimes, `usage-status` | `/login` in pi. Env vars such as `ZAI_API_KEY` also work (pi's `docs/providers.md`) |
| Claude Code login | `~/.claude/.credentials.json` (600), managed by the `claude` CLI | `claude-code` workers, `mode` (Claude planner/workers), `topic-outline` Claude summarizer, `usage-status` Claude usage | Log in inside `claude`. The extensions spawn `claude` from `PATH`; topic-outline defaults to `~/.local/bin/claude` (`claudeBin` in `topic-outline.json`) |
| Codex CLI login (optional) | `~/.codex/auth.json` | `usage-status` fallback for OpenAI usage when pi has no `openai-codex` token | `codex login`, only if you use the Codex CLI |
| GitHub | `gh` token in the OS keyring; git over HTTPS uses it for `origin` | Pushing this repo | `gh auth login` |
| GitHub SSH key | `~/.ssh/`, registered on the GitHub account | The pi-config mirror push (`git@github.com:…`) | Add a key to GitHub; `ssh -T git@github.com` checks it |

The local Ollama provider in `pi-config/models.json` needs no key: its `apiKey` is the placeholder
Ollama expects. It expects Ollama at `localhost:11434`.

**Runtime state in `~/.pi/agent/` (per machine, never committed)**

| Path | What it is |
| --- | --- |
| `sessions/` | Session transcripts (JSONL). `sessions/live/*.json` is the live-session registry |
| `models-store.json` | Model catalog cache |
| `model-favorites.json` | Command-palette favorites (pi-web reads it) |
| `mode.json` | Current mode from the `mode` extension |
| `topic-outline.json` | topic-outline settings (optional; defaults apply without it) |
| `trust.json` | Trusted-project list |
| `cache/usage-status.json` | Subscription usage cache (pi-web's insights read it) |
| `pi-web/web-sessions.json` | Which sessions pi-web created |
| `npm/`, `git/` | Packages pi installs from `settings.json` |
| `skills/` | Machine-local skills (here: symlinks to the Omarchy skill and `~/.agents/skills/opentui`). Nothing in this repo depends on them |
| `tmp/` | Scratch state |

`settings.json`, `keybindings.json`, `models.json` and `extensions/*` in that directory are
symlinks into `pi-config/`, so edits in this repo change the live TUI on its next `/reload`.
`pi-config/install.sh --check` verifies the links and fails if `extensions/` holds anything else.

**Environment variables the code reads**

| Variable | Effect |
| --- | --- |
| `PORT` | Server port (default 4800) |
| `HOST` | Server bind address (default `127.0.0.1`; `0.0.0.0` exposes it on the LAN) |
| `PI_CODING_AGENT_DIR` | pi's agent directory (default `~/.pi/agent`). `install.sh` also honors `PI_AGENT_DIR` first |
| `PI_SESSIONS_DIR` | Default `--dir` of the `pi-sessions` CLI |
| `PI_TOPIC_OUTLINE_DEBUG=1` | topic-outline appends jump diagnostics to `~/.pi/agent/topic-outline-debug.log` |
| `PI_EXPERIMENTAL=1` | `usage-status` shows an "xp" marker |
| `PI_PACKAGE_DIR` | Extension tests: location of the pi package instead of `npm root -g` |

**Other tools and services the extensions use**: `claude` (above); `tmux` and `hyprctl` for the
`sessions` extension's jump-to-session focus (optional, Hyprland only); and `usage-status`, which
calls the Ollama, ChatGPT, Anthropic and Z.ai usage endpoints with the credentials above.

## pi-config public mirror

[Naomarik/pi-config](https://github.com/Naomarik/pi-config) (public) is a `git subtree split` of
`pi-config/`, so it installs without this repo. Anything in `pi-config/` is published on the next
mirror push: keep it free of private details. After committing `pi-config/` changes on `master`, run
the split-and-push command in [`CLAUDE.md`](CLAUDE.md#pi-config-mirror). It is a fast-forward push;
never force it.
