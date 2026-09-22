<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/sova-mark-dark.svg">
    <img src="docs/brand/sova-mark-light.svg" alt="" width="72" height="72">
  </picture>
</p>

# sova

**Sessions, Orchestration, Viewing & Agents.** A local web app for reading, watching, and
continuing your [pi](https://pi.dev) sessions.

Sova runs on your own machine beside the pi coding agent and reads the same `~/.pi/agent` the
terminal does. It lists every session on the machine, opens any transcript, shows a session that
is open in a TUI as it runs, and lets you chat in the sessions it started itself. It is one
person's tool for one person's agent: a single local user, no accounts, no authentication,
loopback by default.

There is no Sova service and no Sova account: the app, its state and your transcripts stay on the
machine, and nothing is sent anywhere on Sova's behalf. What does leave the machine is what you
ask the agent to do. A turn sends your prompt and the session's context to whichever model
provider it is pointed at, exactly as the TUI would. A session started against a remote target
runs its tools on that host. Extensions and tools reach the network on their own — web search and
fetch, the usage endpoints behind the Usage page, an authenticated `claude` CLI. Sova is local; the
agent it drives is as local as the providers and tools you give it.

## Install

You need `git`, `node` **≥ 22.19** and `npm` already on the machine. This installs none of them,
installs no version manager, and never uses `sudo`.

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.1.0/scripts/install.sh | bash
```

That clones the tag into `~/.local/share/sova`, installs its dependencies, builds the frontend,
and writes a launcher to `~/.local/bin/sova`. Then:

```sh
sova            # http://127.0.0.1:4800
```

| Detail | What holds |
| --- | --- |
| Where it writes | The install directory, and `~/.local/bin/sova`. `--dir <path>` and `--bin <path>` move either one |
| `~/.pi` | Never read or written by the installer. Your pi config, credentials and sessions are untouched, and `pi-config/install.sh` is **not** run — it would replace the config of a machine that already runs pi, so that stays your call |
| Autostart | None. No systemd unit, no shell profile edit. You start it |
| Dev dependencies | Installed on purpose: the server runs through `tsx`, which is one of them |
| Re-running | Safe. The install directory is replaced only when it is a clone of this repository with nothing uncommitted; anything else is refused and left alone. The build happens in a staging directory beside it and is promoted only after it succeeds, with the previous install restored if the promotion fails |
| Uninstall | `rm -rf ~/.local/share/sova ~/.local/bin/sova`. State Sova wrote stays in `~/.pi/agent/sova/` until you remove that too |

To read the script before running it, open [`scripts/install.sh`](scripts/install.sh) — or clone
first and run it from there. It installs the same pinned tag either way, not your checkout:

```sh
git clone https://github.com/Naomarik/sova.git && sova/scripts/install.sh
```

Sessions already on the machine are listed and readable as soon as the server starts. Chatting
needs pi's provider credentials in `~/.pi/agent/auth.json`. Sova embeds its own pinned pi
(`@earendil-works/pi-coding-agent` **0.86.1**), so nothing has to be installed globally — if you
have never logged in, use the copy that came with it:

```sh
~/.local/share/sova/node_modules/.bin/pi      # or <install dir>/node_modules/.bin/pi
#   /login
```

A global `pi` on your PATH does the same job; either way the credentials land in the same file,
and the server reads them from there.

## What it does

Every feature below is verified against the code at `6b641b5` (2026-09-22): the route or socket
message, and the component that renders it. Where one needs an extension from
[`pi-config/`](pi-config), it is in the extensions table at the end of the section and says so;
those are optional, and nothing before it depends on them.

### The session list

Every session in `~/.pi/agent/sessions` is listed, grouped by the folder it runs in, with the
sessions currently open elsewhere at the top and a live count on the ones that are working. (A
terminal announces itself through the presence registry the `sessions` extension writes; without
it a TUI's session is still listed and readable, just not marked as open.) The list is the
directory: there is no import step and no copy. Search filters by title, folder and model. A row
carries its own title — the first user message, or a name you gave it, kept in Sova's own store,
so renaming never writes a byte into the transcript. Sessions you are done with go to the
archive, which is grouped by date and has a cleanup pass for the empty ones.

### Reading a transcript

Any session opens read-only: messages, thinking, tool calls with their output, file writes and
edits as diffs, images inline with a lightbox, and markdown with syntax-highlighted code. Long
transcripts render the branch that is active, so a rewound session reads the way it ended up.
The session head shows the model, the context window as a gauge, and the folder.

### Watching a session that is open in a TUI

A session another process owns is shown **live and read-only**: Sova tails the JSONL and appends
rows as they land, roughly every 1.5 seconds. It never writes to a file a TUI owns, and the
composer is not there to be tempted by — the rule is in the code, not in a warning.

### Chatting in a session Sova started

Sessions Sova created are its own, and those you can drive from the page: send, steer a running
turn, stop it, queue messages and remove one from the queue, regenerate the last answer, rewind
to an earlier point, switch model or thinking level mid-session, attach images and files, and
`@`-mention a path from the session's folder (a git repo uses `git ls-files`, so no
`node_modules`). Slash commands come from the session itself, including the ones its extensions
add. Drafts survive a reload. A dialog an extension raises appears in the page.

### Several sessions at once

A group is a set of sessions you name. Opened as a workspace it becomes panes — split or
tabbed — with one composer that writes to every member, so a question goes to all of them and
you read the answers side by side. **Fanout** makes a whole workspace in one gesture: fork an
existing session at a leaf, or start fresh, with per-model counts and a cost preview before
anything runs. A forked session is marked at its fork point.

### Subagents, usage and agents

A hosted session's workers appear as a count in the head and open a pane with each worker's own
transcript. The **Usage** page shows subscription and spend windows; the **Agents** page shows
what is running across the machine, with teams and their members. A session's timeline puts
chapters, inputs, tool density and idle gaps on one axis, and an input row rewinds the chat to
that point.

### Themes and type

A theme is one JSON file; **18** ship in [`themes/`](themes). Drop your own in
`~/.pi/agent/sova/themes/` and it appears in **Settings → Themes** within 2 seconds of saving —
no restart, no rebuild. Editing the theme you are wearing re-applies it on the same beat.

```json
{
  "$schema": "sova-theme/v1",
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": { "accent": "$amber", "accent-hover": "#ffc46e", "accent-tint": "#3a2f1c" }
}
```

That is a whole theme: three colors over the dark base, and everything left out comes from the
base it extends, so you can change one token or all 30. `extends` is `dark` or `light`. `colors`
takes the semantic tokens without their `--color-` / `--status-` / `--diff-` prefix; `vars` are
named values a later key uses by writing `"$name"` as its whole value. `typography` is optional
and takes font *stacks* naming faces already on the machine — a theme cannot ship a font file —
plus any `fs-*`, `lh-*`, `fw-*` or `ls-*` step. Every value is validated against a grammar
rather than a blocklist, because a color reaches a `background` and a background can load an
image: a hex value or one un-nested `rgb`/`hsl`/`oklch`/`color-mix`-style call, lengths in `px`
or `em`, plain numbers for line heights. A value that fails makes the file a broken row with the
reason on it, and the theme is not applied. `shared/theme.ts` is the definition that runs.

If a theme leaves the app unreadable, you can always get back: delete or fix the file — an id
that no longer resolves falls back to Dark — or clear the `sova:theme` key in `localStorage`.
Give your file the id of a built-in and yours wins, marked `replaces the built-in` in the picker.

### Models, and what may be used

**Settings → Models** decides what this machine may use. Every provider and every model has two
switches: **Enabled** — usable at all — and **Subagents** — may a worker be given it. Enabled
covers Subagents, and a model turned off globally keeps its Subagents preference, so turning it
back on returns it.

It is a rule, not a filter. The policy lives in `~/.pi/agent/model-policy.json` and every session
on the machine reads it: the picker stops offering the model, the chat socket refuses to switch to
it, a chat already sitting on it refuses to send until you pick another — nothing falls back on
its own — and a turn nobody typed (a subagent wake-up, a continuation, a retry) is stopped at the
last point before the request leaves. Sova writes the file itself; the
[`model-policy`](pi-config/extensions/model-policy) extension is what enforces the same rule
inside the TUI.

### On a phone

The layout folds to one pane with a back affordance, and the app installs as a PWA: the shell,
its assets and the icons are cached, so it opens without a network round trip and survives a
reload with the server down. That is an offline **shell**, not an offline agent — live data
(`/api`, `/ws`) is never cached, and with the server unreachable there is nothing to read and
nothing to send.

### With the bundled extensions

[`pi-config/`](pi-config) is the pi configuration and the extensions this setup runs with. They
are pi extensions, not part of the web app: they load in the TUI and in the runtimes Sova embeds
once they are linked into `~/.pi/agent` (`pi-config/install.sh`, your decision to run). Each has
its own README. These six change what Sova can show:

| Extension | What it adds to Sova |
| --- | --- |
| [`usage-status`](pi-config/extensions/usage-status) | The Usage page's subscription meters. It writes `~/.pi/agent/cache/usage-status.json`; without it, Sova has no usage data to show |
| [`subagents`](pi-config/extensions/subagents) | Background workers and coordinated teams — the workers pane and the Agents page read what it records |
| [`explain`](pi-config/extensions/explain) | `/explain <topic>` writes a self-contained HTML explanation into `~/.pi/agent/explanations/`; Sova lists them on its landing page and serves them at `/explain/<id>` |
| [`remote`](pi-config/extensions/remote) | Targets in `~/.pi/agent/targets.json` (ssh, AWS SSM, docker, incus). A session started against a target runs every tool there and keeps a local placeholder folder for its identity; you bring your own targets, and Sova has no mount support |
| [`mode`](pi-config/extensions/mode) | The per-session mode menu in the composer |
| [`sessions`](pi-config/extensions/sessions) | The presence registry (`~/.pi/agent/sessions/live/*.json`) that tells Sova which sessions a terminal has open, and how many workers each is running. Sova writes records for its own hosted sessions either way |

[`topic-outline`](pi-config/extensions/topic-outline) feeds the transcript's outline strip the
same way. The rest — the palette, the session registry, `codefold`, `vision-delegate` and the
others — are TUI features that Sova does not surface.

## Running

| Command | What it does |
| --- | --- |
| `sova` | The installed launcher: the built app and the API on port **4800** |
| `npm start` | The same thing from a checkout (`tsx server/index.ts`); serves `dist/` when a build exists |
| `npm run dev:server` | API and WebSocket server on **4800** with watch |
| `npm run dev:web` | Vite dev server on **5173** with HMR, proxying `/api` and `/ws` to 4800 |
| `npm run build` | Typecheck, then `vite build` into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (`server/*.test.ts`, `src/lib/*.test.ts`) under `tsx --test` |

Open <http://localhost:4800> after an install, or <http://localhost:5173> in development.

| Variable | Effect |
| --- | --- |
| `PORT` | Server port (default 4800) |
| `HOST` | Bind address (default `127.0.0.1`) |
| `PI_CODING_AGENT_DIR` | pi's agent directory (default `~/.pi/agent`) — point it at a scratch directory to experiment without touching real sessions |

Sova's own state lives in `~/.pi/agent/sova/`: which sessions it created, groups, the archive,
drafts, defaults, attachments, your themes and remote targets. It writes nowhere else in the
agent directory and never rewrites a session file. Sessions, credentials and caches are pi's,
shared with the TUI, and none of it is in git.

## Security and scope

The server has no authentication of its own. What protects it is the interface it listens on: it
binds **loopback only** (`127.0.0.1:4800`) unless `HOST` says otherwise. Setting `HOST=0.0.0.0`
exposes an unauthenticated app that can read any file and run any command you can — do that only
behind something that authenticates, and keep the port firewalled.

The embedded pi reads and writes the same `~/.pi/agent` as the TUI: your real sessions, your
logins, your extensions. A session another process owns is read-only here. It is not a hosted
service, not a team product, and not a replacement for pi's TUI.

## Development

| Path | What it is |
| --- | --- |
| `server/` | Node backend: Hono REST and `ws`, with the pi SDK embedded |
| `src/` | SolidJS + TypeScript frontend (Vite) |
| `shared/protocol.ts` | The REST/WS wire contract between the two |
| `public/`, `src/design/`, `spec/` | Fonts, icons, design tokens, and the UX spec the frontend builds |
| `themes/` | The built-in themes, one JSON file each |
| `pi-config/` | The pi configuration and extensions this setup runs with, linked into `~/.pi/agent` by `pi-config/install.sh` |
| `scripts/install.sh` | The installer above; `scripts/install.test.sh` tests it against stubbed `node` and `npm` in a temporary `HOME` |
| `ai/branding/`, `docs/brand/` | How Sova describes itself, and the mark for documents. Nothing in the app reads either |
| `docs/`, `notes/`, `WISHLIST.md` | Research, working notes and ideas. Not features |
| `CLAUDE.md` | Architecture, ownership and pi SDK facts for coding agents. Read it before changing the server |

`npm run typecheck`, `npm test` and `npm run build` are the gate. `npm run dev:server` is a
watch server, so editing anything in its import graph restarts it and kills workers a hosted
session spawned; `CLAUDE.md` has the rules for that and for not corrupting a session a TUI owns.
Each extension under `pi-config/extensions/` has its own tests, run from its directory.

This repository was named `pi-web` until September 2026. The package, the app, the state
directory and the browser keys are all Sova now; the `pi-web` spellings that remain are
read-compatibility for data written before the rename — transcripts are never rewritten, so
removing one would orphan real data. The ledger is in
[`ai/branding/naming.md`](ai/branding/naming.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). The bundled fonts carry their own licenses in
`public/fonts/`, and `pi-config/` has [its own](pi-config/LICENSE).
