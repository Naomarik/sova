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
  there); a branch lands through Sova's merge queue, on the user's go-ahead (see
  **Landing**). Uncommitted edits in the live tree block a release.
  One exception: applying a Project Overseer's Settings change card on Sova's own project
  (§app.project-overseer/settings) lands its settings files on master in the live tree as one commit,
  at the operator's click; Sova refuses it when it would touch anything but settings files, and it
  waits while a branch is checking, landing at the queue's next quiet point.
  Another: a save from Settings → Merge Queue (§app.merge-queue/settings-save) lands the changed values
  of `.sova/project.json`'s `merge` section on master as one commit, at the operator's confirm; it
  waits while a branch is checking and is refused while the project folder has an uncommitted edit.
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
  `pnpm test:int --changed` before asking to land. The merge queue runs the checks
  `.sova/project.json` declares (`merge`), `pnpm test` and `pnpm test:int -- --landing` among them
  (the everyday integration set plus the slow groups the branch triggers, `scripts/test-groups.mjs`),
  plus what the merge thread picks for the branch; a release runs every group. Verify on Bun (the
  runner's default, the user's runtime); Node only when the user asks.
- Tests wait on events, not fixed sleeps (testing guide, "Writing tests: wait on conditions").
- Never run the spec replay suite (`pi-config/extensions/spec/tests/replay`) while working: it is a
  landing check the merge queue runs when a branch touches the spec engine.
- Editing `statecharts/`: start `pnpm statecharts:watch` first and run `pnpm statecharts:test`; never
  cold-compile in a loop (statecharts guide).

## Landing

- **One way in.** Every branch reaches master through Sova's merge queue, one branch at a time, and
  only on the user's go-ahead: **Land** (the worktrees control beside the composer, the session
  pane's Worktrees section, or the project page's Merge Queue tab) or **"land it" typed by the user**
  in the branch's own chat. Nothing else approves a branch, and no chat merges into master: `worktree
  merge` into a queue-managed target is refused.
- **Ready to land** is Sova's own reading of a branch's head commit: no uncommitted files at all, no
  conflicts with master, the newest checks not failing, no open alignment questions, the session
  idle, and its latest turn outcome says the work is finished (with Decisions off: the code checks
  alone). It holds for that commit until the branch changes or lands. Land is offered on it.
- **The user's typed word.** When the user types "land it" or "merge it" in the chat that owns the
  branch, commit what is left and record it with `worktree land` (it refuses anything but their own
  newest message; one the Overseer, a baton or another session sent is refused, whatever it says, though a
  program holding the token may still pass as their word); the queue takes it as an approval of that commit. "land it without its specs"
  and "land it, skip review" are recorded as said. Never send a session "land it" on the user's
  behalf. When the work is done, say what still blocks landing (Sova's note names it), or that they
  can press Land or type "land it" here.
- **The queue lands.** An approval pins the commit and the branch's spec drafts. The queue merges it
  onto the newest master in a merge copy beside the project, makes the drafts official there, runs
  the project's checks, fast-forwards master to exactly the tested commit, then the main checkout,
  then pushes. A newer commit on the branch isn't included ("1 newer commit not included") and needs
  a new Land; drafts changed since the approval wait for a new Land. A failure reaches the branch's
  chat only when it is the branch's; the queue's own setup trouble pauses the queue instead. The
  merge thread (a chat Sova starts per project) notes each landing ("changes server code; restart
  Sova to pick it up"), picks extra tests by what changed, and judges conflicts; it never moves
  master itself.
- **Specs land with the branch.** A chat writes drafts and one verification note per promise; drafts
  that don't fit hold the branch (Landing specs) and Sova tells the chat what to fix. If it can't,
  the user may land it without them: "land it without its specs" typed in the chat, or Land without
  its specs… in the Land menu.
- **The exceptions:** a Project Overseer's settings change card on Sova's own project lands its
  settings files on master at your Apply (§app.project-overseer/settings); Save Checks and a save from
  Settings → Merge Queue each land one commit of the project file's `merge` section at your confirm
  (§app.merge-queue/setup, §app.merge-queue/settings-save). The card and the save each wait while a
  branch is checking, so neither moves master under a run.

## Live server restart

The live server on 127.0.0.1:4800 is the systemd user unit `sova-runtime.service` (macOS: a launchd
agent, server guide). It has no file watcher: an edit to `server/**`, `shared/**` or `pi-config/**`
goes live on `systemctl --user restart sova-runtime.service` (macOS:
`launchctl kickstart -k gui/$UID/<label>`, the agent's label), and only then.

- A restart cuts nothing off. Every chat, worker, team member and hidden chat runs in a process of its
  own and keeps running through it, including a reply in flight; browsers reconnect. A server-hosted
  action (a server tool) that was running when the server stopped reports "outcome unknown" to its chat
  and is never retried.
- A permanent stop of the server doesn't stop its chats either: each exits on its own once it has been
  idle with no server for its idle time, or `bun scripts/stop-chats.ts [--agent-dir <dir>]` stops every
  recorded chat of a state root.
- New code reaches a chat at its next quiet moment, not at the restart. Each chat runs the copy of the
  code it started with and shows `On older code` until it reloads (or until someone presses
  `Reload Now`). That holds for pi-config edits too, the claude-code bridge included. Reloads go one
  chat at a time and stop at the first chat that fails to start on the new code.
- After a server-side change, say that it is not live yet and needs that restart. Then confirm with
  `GET /api/health` (`startedAt`, `head`).
- A chat never restarts or updates Sova: it asks the user. Both pass only on the user's own click in
  the page (§app.access/your-click), and `server.restart` answers with where to click. The server can't
  stop raw `systemctl`, `launchctl` or `kill`, so this is a rule, not a wall.
- The operator's ways: **Restart Sova** in Settings → General, Apply on the project's Branches tab, or
  from their own terminal the raw `systemctl` or `launchctl` line above.
- The verb form (Sova as its own project, `.sova/project.json`; slot 0 adopts `sova-runtime.service`)
  is that Apply, which always needs the operator's confirm, then restarts the unit 3 s later. A page on
  another of the user's computers can press it too. `sova-project apply` of Sova's own slot 0 is refused,
  confirmed or not. up, down, reset and teardown of slot 0 are refused.
- Never restart `sova-runtime.service` to test something: tests use hermetic servers and stand-in
  units.

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

`.sova/spec/` is the requirement for what Sova does: `claims/<ns>/<name>.md`, under `§` IDs, each
with its records in the `.json` beside it, plus `manifest.json` (settings). A record labelled `authority: migrated`, `evidence: unreviewed` carries prose that is
the requirement, but nothing has checked that the code does it: verify the implementation before you
claim a feature.

- Drafts and reviews are local only (`.sova/spec/.gitignore`); commit by explicit path, as
  `.sova/spec/README.md` shows, never `git add -A`.
- **Before and while a task changes behavior, follow the spec discipline.** If your system prompt
  already includes the `# Minor mode: spec` block, follow it without rereading; otherwise read
  `pi-config/extensions/mode/spec-mode.md`, the same text, and follow it. Before your first edit that
  changes behavior, read `pi-config/extensions/spec/WRITING.md`, the writing procedure (drafts,
  agreeing, evidence, promoting), unless a census note or an alignment's go-ahead already handed it to
  you. Both apply in Sova whether or not that mode is on; don't turn any mode on. Commands are in
  `.sova/spec/USAGE.md`.
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

## Commands and extensibility (detail and the tests: [agents/server/commands/overview.md](agents/server/commands/overview.md))

- **A new user-visible action gets a catalogue entry** (`shared/commands-catalog.ts`, its id in
  `shared/commands-ids.json`) pointing at its existing route, in sessions, projects, the Overseer,
  to-dos and ideas, and chats. The areas left as is by choice (`OPTED_OUT` in
  `server/commands-inventory/scan.ts`: settings, orgs, mesh, voice, tours, shares…) need none;
  adding an area there is the user's call.
- An entry's `meshNeed` is `classifyRequest`'s for its route; never the peer, auth, share or `/ext`
  routes; ids are append-only. Additions only add; listing an action never opens it to agents.
- Extension content is data Sova draws, or a walled-off frame. Sova's own features use the same
  places on its screens as extensions, built-ins first (an action under a message is a reply-place
  built-in); a place asks only the extensions whose `offers` name it.
- Each rule has a test; change them together.

## Conventions

TS strict, ESM, no new dependencies without asking. The server normalizes JSONL entries into
`TranscriptItem`; the frontend renders those, and live streaming from `SovaEvent`s. The frontend is
SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.

- Never keep secrets or machine-specific details in the repo (it is public): no keys, tokens, real
  IPs, hostnames, tailnet names, device IDs or home paths in code, scripts, tests, docs or commit
  messages. Read them from a gitignored env file (e.g. `local.env`, with a committed
  `local.env.example` of placeholders); when you create one, tell the user so they can fill it in.
