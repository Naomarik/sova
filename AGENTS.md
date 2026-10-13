# Sova

Webapp interface for the pi coding agent (npm: `@earendil-works/pi-coding-agent`, pinned **1.0.3**).
Single local user. Goals: list all sessions, view transcripts, chat in webapp-owned sessions,
live-watch sessions open in the CLI/TUI, spawn new sessions.

The remote is `github.com/Naomarik/sova`; the live worktree is `~/webapps/sova`, the state directory
`~/.pi/agent/sova/`. Moving the worktree breaks the absolute symlinks in `~/.pi/agent/`
(`keybindings.json`, `models.json`, `vision-delegate.json`): re-run `pi-config/install.sh` after one
(`--check` verifies them and changes nothing).

This file holds the rules for every task. Each area's own rules, contracts and "when you change X,
also update Y" list live in its guide: read the guide of every area your task touches before you edit.

## Areas of work

| Area | Guide | Covers |
| --- | --- | --- |
| Server | [agents/server/overview.md](agents/server/overview.md) | `server/`, `shared/`: Bun runtime, live restart detail, dev watcher, prices, share listener; the pi harness boundary in [agents/server/harness/overview.md](agents/server/harness/overview.md) |
| Frontend | [agents/frontend/overview.md](agents/frontend/overview.md) | `src/`: Solid, files the server imports, browser testing, project skills |
| Testing | [agents/testing/overview.md](agents/testing/overview.md) | test tiers, the runner, tier guard, hermetic test env |
| pi-config extensions | [agents/extensions/overview.md](agents/extensions/overview.md) | `pi-config/`: the contracts Sova parses, what the server imports, one guide per extension |
| Modes | [agents/modes/overview.md](agents/modes/overview.md) | the mode extension and its minor modes; the spec mode and spec tools in [agents/modes/spec/overview.md](agents/modes/spec/overview.md) (CHANGELOG, EVOLUTION, GOALS, replay) |
| Statecharts | [agents/statecharts/overview.md](agents/statecharts/overview.md) | `statecharts/`: the org's statecharts |

## Layout & ownership

- `shared/protocol.ts`: the REST/WS wire contract. Change only with team coordination.
- `shared/harness.ts` (types-only barrel over `shared/harness-*.ts`): the harness contract Sova code
  speaks instead of pi's shapes. `server/harness/pi/` is the pi adapter, the only code outside the
  baseline that may reach `@earendil-works/*`. Owned by **backend**.
- `server/`: backend (Hono REST + `ws`, embeds the pi SDK). Owned by **backend**.
- `src/`: SolidJS + TS frontend (Vite; HMR = live reload). Owned by **frontend**, except `src/design/`.
  Some `src/` files are imported by the server and must stay DOM- and Solid-free (frontend guide).
- `src/design/`, `public/`, `.sova/spec/claims/` + `.sova/spec/manifest.json`: design tokens, base CSS,
  fonts/icons and the product documentation (the UX spec). Owned by **designer**.
- `.sova/spec/`: the product documentation and its tools (**Product documentation** below).
- `.claude/skills/`: project skills, registered for pi by `.pi/settings.json`. READ
  `.claude/skills/fold-ai-dev-design/` (the design system) for UI work and
  `.claude/skills/playwright/SKILL.md` before any browser work (frontend guide).
- `pi-config/`: the user's pi config and extensions, in this repo with no separate home (`~/pi-config`
  is a compat symlink). Shared, owned by no team. Self-contained: its `install.sh` and README work on
  a plain copy, importing nothing from Sova. `~/.pi/agent` symlinks into it, so an edit changes the
  user's LIVE TUI on its next `/reload` and every runtime Sova embeds. Treat it like
  `shared/protocol.ts`: coordinate before changing any contract Sova parses (extensions guide).
- `statecharts/`: the org's statecharts (statecharts guide).

## Commands

- pnpm, pinned by `packageManager` and `mise.toml`: `pnpm install --frozen-lockfile`. Settings live in
  `pnpm-workspace.yaml` (`.npmrc` is gitignored); only esbuild may run its install script (`allowBuilds`).
- `pnpm run dev:server` (port **4800**) and `pnpm run dev:web` (Vite, proxies /api + /ws to 4800).
- Feature work never edits `~/webapps/sova`, the live tree. Each feature session works in its own
  worktree and branch (`git worktree add ~/webapps/.worktrees/sova-<name> -b feat/<name>`; an agent uses
  the `worktree` tool, whose `create <name>` does exactly that and tracks it so its workers may start
  there); only a release merges it into master. Uncommitted edits in the live tree block a release.
- Test from the worktree with `pnpm run dev:hermetic` by default (`scripts/hermetic-agent-dir.mjs`
  builds `<worktree>/.agent`: this tree's pi-config, own sessions and state, nothing in `~/.pi`; port
  4810, `SOVA_PORT=<n>` for another; it copies no auth, copy `auth.json` in by hand). Create, archive,
  restart and mutate sessions, workers and settings freely; never restart `sova-runtime.service` to
  test. A feature that mutates nothing and needs real sessions to compare against may read real
  state, never through a second server (a server on the real `~/.pi` still writes: seen marks,
  summaries, titles, signals, worker restores; there is no read-only mode): copy the sessions into `.agent`, or view them through the live server. Details
  and gaps: testing guide.
- `pnpm run typecheck` and `pnpm run build` must pass.
- Tests (testing guide): `pnpm test` is the unit tier, in-process only; run it constantly.
  `pnpm test:int` is the integration tier (`*.integration.test.ts`); while working run
  `pnpm test:int --changed` before asking to land. The merge round runs both tiers at landing. Verify
  on Bun (the runner's default, the user's runtime); Node only when the user asks.
- Never run the spec replay suite (`pi-config/extensions/spec/tests/replay`) while working: it is a
  landing gate the merge round runs.
- Editing `statecharts/`: start `pnpm statecharts:watch` first and run `pnpm statecharts:test`; never
  cold-compile in a loop (statecharts guide).

## Live server restart (worker suicide)

The live server on 127.0.0.1:4800 is the systemd user unit `sova-runtime.service` (macOS: a launchd
agent, server guide). It has no file watcher: an edit to `server/**`, `shared/**` or
`pi-config/extensions/mode/**` goes live only on `systemctl --user restart sova-runtime.service`. With
the chat switch off, that restart ends every worker, team member and hidden chat (they are the server's
child processes); their parents' records keep them, listed restored and resumable with `agent_resume`.
With it on (`SOVA_CHAT_HOST=out`, Linux), they run in units of their own and their parents reattach to
them. Hosted chats survive either way (JSONL; the webapp reconnects).

- After a server-side change, say it is not live yet and needs that restart.
- Before any restart, read the live records `~/.pi/agent/sessions/live/p<server-pid>-*.json`
  (heartbeat ≤ 30 s) of every hosted session; hold it if any shows `presence.workerCounts.working > 0`
  or `presence.activity.state === "working"` (your own turn counts).
- Never run `systemctl restart` from inside a hosted session: you are the server's child. The one
  allowed form is a delayed transient unit, `systemd-run --user --on-active=30s systemctl --user
  restart <unit>`, scheduled right after a final busy check as your turn's LAST tool call, the turn
  ending at once (a turn another session starts in those 30 s can still be cut off). If `systemd-run`
  fails (a sandboxed session can't reach the user bus, by design), never work around it: ask the user.
  Confirm afterwards with `GET /api/health` (`startedAt`, `head`).
- The verb form (Sova as its own project, `.sova/project.json`; slot 0 adopts
  `sova-runtime.service`): the operator's Apply on the Services tab, or
  `sova-project apply --checkout ~/webapps/sova --confirm` (`--project` alone is refused,
  `invalid-request`). A confirmed restart is scheduled 3 s out without a busy check. up, down, reset
  and teardown of slot 0 are refused. Never point a test at `sova-runtime.service`: tests and gates
  use a stand-in unit.
- The claude-code bridge is a `globalThis` singleton (`getSessionBridge()`), so provider edits also
  need a restart. Before trusting a live test, compare the unit's start time
  (`systemctl --user status sova-runtime.service`) with the edited files' mtimes.

The server runs on Bun; Node only when the user asks (server guide). An agent never edits the unit.

## Working rules

- When planning a Sova feature, only Sova matters: ignore the pi TUI and standalone Claude Code
  (sessions run outside Sova). Never widen scope, add questions or add work to cover them. Sova's
  own claude-code backend and its workers are Sova and count.
- Never use Opus 5 (`claude-opus-5`). "opus" means Opus 5.5: claude-code `claude-opus-5-5` (an old
  alias such as `opus[1m]` runs as its catalog id; `pi-config/extensions/claude-code/catalog.ts` names
  every model).
- Throwaway test sessions run on `zai/glm-5.3`. New web sessions default to a costlier model: set the
  model before the first prompt, and archive the session afterwards.
- Never `git stash`, `checkout`, `reset` or `restore` in a worktree others share. Take baselines with
  `git archive <rev> | tar -x -C ~/.cache/<name>`, never `git worktree add` (it writes the shared `.git`).
- Run `mise trust <worktree>` in a fresh worktree before any node/pnpm command (again after a
  `mise.toml` change).
- Retire a worker past 50% of its context window: have it write a checkpoint, then hand off to a fresh
  worker instead of resuming or steering the old one.
- The pi-web archive and the pi-config mirror are private repositories: never link, fork or expose
  them. In public docs, describe `pi-config/` as a directory in this repo.
- `dev:hermetic` regenerates `.agent/settings.json` on every start. For a custom pi setting, run
  `node scripts/hermetic-agent-dir.mjs`, add the key, then start the server yourself.

## Product documentation

`.sova/spec/` is the requirement for what Sova does: `manifest.json` plus `claims/<ns>/<name>.md`,
under `§` IDs. A record labelled `authority: migrated`, `evidence: unreviewed` carries prose that is
the requirement, but nothing has checked that the code does it: verify the implementation before you
claim a feature.

- Drafts and reviews are local only (`.sova/spec/.gitignore`); commit by explicit path, as
  `.sova/spec/README.md` shows, never `git add -A`.
- **Before and while a task changes behavior, follow the spec discipline.** If your system prompt
  already includes the `# Minor mode: spec` block, follow it without rereading. Otherwise read
  `pi-config/extensions/mode/spec-mode.md`, the same text, and follow it. It applies in Sova whether or
  not that mode is on; don't turn any mode on. Commands are in `.sova/spec/USAGE.md`.
- A change to the spec tools themselves: read [agents/modes/spec/overview.md](agents/modes/spec/overview.md).
- Before planning anything that changes what a Claude Code chat's model sees or which tools it has,
  read §app/claude-code-provider: Sova owns the conversation and the tools; the CLI is only the model.

## Method

Rules earned by at least two real misses each on the `fanout-groups` branch (reasoning in its commit
messages and `§workspace.groups/decisions`):

- **Prefer the form that cannot be accidentally satisfied**, in tests, rules and copy alike: a
  collision assertion beats a literal string, a behaviour name beats a property name, a sentence true
  in every branch beats one right only in the common one. The rules below are instances of this one.
- **A worked example is a second implementation of its rule, not documentation of it.** Review it as
  you review the rule (a rule and its own example disagreed three times in one file).
- **Reading verifies claims; running verifies neighborhoods.** Exercising a surface finds the
  instance; enumerating the inputs finds the class. The defects that mattered were seams, invisible to
  a green build, found only by driving the thing.
- **Before trusting a check, ask what it returns in the case you're trying to rule out.** A check that
  cannot tell the two states apart is no evidence. A what-instrument cannot answer a when-question:
  greps and test counts say what's there; `git show <sha>:<file>` and `git merge-base --is-ancestor`
  say since when. Name the commit a claim is true at, and read the live tree, not an archive of it.
- **A frame that is confirming itself feels exactly like a frame that is correct.** When a class is
  salient every event reads into it and the pattern-match feels like recognition; a count of
  instances is an instrument too: measure it, don't repeat it.

## The pi boundary (detail: [agents/server/harness/overview.md](agents/server/harness/overview.md))

- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it (no
  prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json`; live sessions are read-only via
  `/ws/watch`.
- Only the adapter, `server/harness/pi/`, reaches pi; any other import of `@earendil-works/*` fails
  `pnpm test`.
- **The boundary baseline only shrinks.** Never add a file, raise a count or list a wrapper to make
  `server/harness-boundary.test.ts` pass; if a change seems to need it, stop and ask the user.
- New work is harness-neutral: no pi imports, no raw custom entries, no new pi-config extension or
  extension command call for a new Sova agent feature.
- Every reach into pi's internals is a quirk row in `server/harness/pi/QUIRKS.md`, with its canary and
  sites, in the same change.

## Conventions

TS strict, ESM, no new dependencies without asking. The server normalizes JSONL entries into
`TranscriptItem`; the frontend renders those, and live streaming from `SovaEvent`s. The frontend is
SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.

- Never keep secrets or machine-specific details in the repo (it is public): no keys, tokens, real
  IPs, hostnames, tailnet names, device IDs or home paths in code, scripts, tests, docs or commit
  messages. Read them from a gitignored env file (e.g. `local.env`, with a committed
  `local.env.example` of placeholders); when you create one, tell the user so they can fill it in.
