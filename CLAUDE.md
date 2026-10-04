# Sova

Webapp interface for the pi coding agent (npm: `@earendil-works/pi-coding-agent`, pinned **0.87.1**).
Single local user. Goals: list all sessions, view transcripts, chat in webapp-owned sessions,
live-watch sessions that are open in the CLI/TUI, spawn new sessions.

The remote is `github.com/Naomarik/sova`. The worktree is `~/webapps/sova` and the state
directory is `~/.pi/agent/sova/`. A move of the worktree breaks the absolute symlinks in
`~/.pi/agent/` (`keybindings.json`, `models.json`, `vision-delegate.json`), so
re-run `pi-config/install.sh` after one (`--check` verifies them without changing anything).

## Layout & ownership

- `shared/protocol.ts` — the REST/WS wire contract. Change only with team coordination.
- `server/` — Node backend: Hono (REST) + `ws` (2 WS endpoints), embeds the pi SDK. Owned by **backend**.
- `src/` — SolidJS + TS frontend (Vite, vite-plugin-solid; HMR = live reload). Owned by **frontend**, except `src/design/`.
  One runtime import runs the other way: `server/vis-check.ts` (the vis retry and the `vis_check` tool) imports
  `src/vis/parse.ts` and `src/vis/kinds/frame/parse.ts`, so the parse side of `src/vis/` (parse.ts, registry.ts,
  core/, kinds/*/parse and height/layout) must stay DOM- and Solid-free at load, and an edit there only reaches
  the running server at its restart. Likewise `server/transcript.ts` imports `src/lib/message.ts`
  (`argsSummary`, `contentText`, `spawnName`) and `src/lib/tool-diff-stats.ts` (with `src/lib/diff/parse.ts`),
  so a slim tool row's folded line and "+n −m" are the card's own (§chat.transcript/slim-rows): keep
  those DOM- and Solid-free too.
- `src/design/`, `public/`, `.sova/spec/claims/` + `.sova/spec/manifest.json` — design tokens, base CSS,
  fonts/icons, and the product documentation (the UX spec). Owned by **designer**.
- `.sova/spec/` — the product documentation and its tools; see **Product documentation** below.
- `.claude/skills/` — project skills, registered for pi by `.pi/settings.json` (`"skills": ["../.claude/skills"]`;
  the folder is also trusted in `~/.pi/agent/trust.json`, or pi prompts each session).
  `fold-ai-dev-design/` — the design system skill (copied from foldaidev). READ IT.
  `playwright/` — CDP browser automation via `scripts/start-browser.sh` + `scripts/pw.sh`; read its
  SKILL.md before any browser work (own browser per caller, `resize` must follow `navigate`, a bare
  `console` reloads the page).
- `pi-config/` — the user's pi config and extensions, in this repository with no separate home.
  `~/pi-config` is a compat symlink to it. It is self-contained — its `install.sh` and README must
  keep working on a plain copy of the directory, with no imports from Sova. Shared, not owned by any
  team. `~/.pi/agent` symlinks `keybindings.json`, `models.json`, `vision-delegate.json` and the
  extensions into this directory, so an edit here changes the user's LIVE TUI on its next `/reload`,
  and every
  runtime Sova embeds. Treat it like `shared/protocol.ts`: coordinate before changing any contract
  Sova parses (sessions live registry `sessions/live/*.json`, usage-status cache (`claude` is
  always Claude Code's own login; each added Claude login's reading is in the additive
  `claudeAccounts`, keyed by login id), subagents
  teams/snapshots, topic-outline state, command-palette `model-favorites.json`, the model policy
  `model-policy.json` (extensions/model-policy: what may be used at all, and what subagents may be
  given — read by the TUI, the palette, subagent spawning and Sova alike), mode `mode.json` =
  the DEFAULT mode for new sessions; the active mode is per session, in the session's own `mode`
  custom entry, and Sova restores it with `restoreActive` from `state.ts` — and also WRITES that
  entry's shape itself (`{mode, active: activeOf(state)}`, `pinEntryFor` in `server/mode-state.ts`)
  to pin the sessions it starts with a mode (a project's coding sessions, the Overseer's
  sova_create_session / sova_set_session), so the entry's shape is a contract too; mode
  `mode-delegate.json` = Delegate's global routing (four profiles, each backend/model/effort plus
  an optional fallback), written by Sova's Settings → Modes → Delegate and re-read by every
  Delegate session at each turn boundary — never snapshotted into a session; mode `mode-spec.json`
  = the spec minor mode's writer (one backend/model/effort plus an optional fallback, or `null`: the
  session writes the spec itself), written by Settings → Modes → Spec and re-read the same way by
  every session with spec on, in either major mode), subagents `team-defaults.json` = the standing
  coordinator and monitor every new team gets (absent = off), written by Sova's Settings → Teams and
  read by the subagents extension at team creation), and subagent profiles: `subagent-profiles.json`
  = the library of named subagent setups (a profile bundles Delegate's four routes, the standing
  coordinator/monitor, the members default and the spec writer),
  `subagent-profiles-default.json` = this device's default (never synced; the library syncs whole,
  newest edit wins), and each chat's hidden `subagent-profile` custom entry `{v: 1, profile}` (an
  id or "off", newest on the branch wins — an id reference, not a snapshot: editing a profile
  reaches every chat on it from its next turn or team action). One module,
  `pi-config/extensions/subagents/subagent-profiles.ts` (builtins only, plus `mode/delegate.ts`,
  `mode/spec.ts` and `subagents/team-defaults.ts`), owns all three: the shapes, the strict parses,
  the seeding (absent = seeded from the legacy files, so nothing changes until the user switches; a
  malformed legacy `team-defaults.json` postpones seeding), atomic writers, pick entries
  (`restorePick`, `pickEntryFor`) and the one `resolveSubagents` (pick → this device's default →
  legacy files; a dangling pick falls to the default, a missing/malformed/dangling default reads as
  Off, an unusable library falls to the legacy files). Written by the mode menu, Settings →
  Subagents, `/mode subagents <id|off>`, the Overseer and the limit row; read by the mode
  extension (Delegate routing + spec writer at each turn boundary, either major mode) and the
  subagents extension (team_create / team_add / team_succeed / roster answers / `/team defaults`),
  and by `server/subagent-profiles.ts`, `server/sync/docs.ts` (the library's sync registration) and
  `server/chat-manager.ts` (the pick entry and saveModeDefault), which all import it), claude-code's Claude logins
  (`pi-config/extensions/claude-code/accounts.ts`, builtins only: the registry
  `claude-accounts.json` `{version: 1, logins, devices}`, each login's directory
  `claude-accounts/<id>/` (0700; `projects/`, `settings.json`, `CLAUDE.md`, `agents`, `commands`,
  `skills`, `plugins` symlinked to Claude Code's own directory so `--resume` and every transcript
  reader keep one `projects/`), this host's standing of each login `claude-accounts-state.json`,
  the per-device order (each account's logins together, `groupByAccount`, which the pool's order reads through too; `default`, Claude Code's own login, always last) and the one resolver
  login → `CLAUDE_CONFIG_DIR` that every `claude` spawn uses; written by Sova's Settings → Accounts
  and the pool agent, read by the chat provider, workers, model discovery and the topic-outline
  summarizer at each spawn. With the mesh on (`<agent dir>/sova/peers.json` lists a peer) logins
  form one pool (`server/claude-pool/`): a registry login's `device` is the device that HOLDS it
  (`null` = kept here, free, for lending: never run while the mesh is on), and accounts.ts also
  owns the pool's marks every spawn honours — `<login dir>/.sova-leaving` `{v: 1, at, reason}`
  (never chosen), the per-process leases `<login dir>/.sova-leases/<pid>.json` `{v: 1, owner,
  users, busy, children, lastActiveAt, at}` (`LoginUsers`, a `globalThis` singleton that also
  releases idle users of a leaving login), the chats' hand-picks `<login dir>/.sova-picks/<pi session
  id>.json` `{v: 1, session, at}` (written by the provider on a pick, dropped when that chat leaves the
  login; the pool agent never returns a picked login for idleness), the borrow requests `<agent dir>/claude-pool/wants/*.json`
  `{v: 1, at, pid, excludeAccounts?, excludeLogins?, only?}` that `acquire` / `failoverAsync` (and
  `take`, a pick in the composer that names one login) write and wait on, and the agent heartbeat `<agent dir>/claude-pool/agent.json` `{v: 1, pid, at, device}`;
  and the session's hidden `claude-login` custom
  entry `{v: 1, login, label?, from?, fromLabel?, reason?, resetsAt?, text?}` (`reason` `limit` | `auth` |
  `manual`, the user's pick | `moved`, its login stopped being usable here), written by the provider and read by Sova, which renders one with `from` as
  a note row; the web's login switch calls the provider's `/claude-login <login id>` command handler
  directly, like `/mode`, so its argument is a contract too), worktrees: the session's `worktrees` custom
  entry (the tracked set, whole snapshot, newest on the branch wins) and its `worktree-merge`
  extension message (the merge card), read by Sova and by the subagents spawn gate; mode's `align`
  tool: each result's `details` (`{v: 1, doc?, changes, line, exempt?}`, the touched alignment's
  whole snapshot, newest per id on the branch wins), read by Sova for the card, the composer chip
  and the session list, and its hidden `align-state` / `align-nudge` custom messages, which Sova
  must keep hidden (`display: false`); an older session's `align-doc` custom entries are read-only;
  show-changes' `show_changes` tool: each result's `details` (`{v: 1, scope, title?, paths?,
  steps?}`), read by Sova for the card that opens the changes viewer; provider-limits
  (`pi-config/extensions/provider-limits/gate.ts`, builtins only): the request limits
  `provider-limits.json` `{version: 1, limits: {<provider>: 1..999}}` (missing or unreadable = the
  defaults zai 5, ollama-cloud 10; written by Settings → Models, synced like the policy), and the
  per-provider queue files under `<agent dir>/provider-limits/<provider>/` — `slots/<pid>-<n>.json`
  `{v: 1, pid, sessionId?, kind, at}`, `wants/<pid>-<n>.json` (the same plus `since`),
  `lowered.json` `{v: 1, limit, until}` and the claim `lock` — which every pi process (TUI, hosted
  sessions, pi workers via their `-e` list) and Sova's own one-shots claim through, and which Sova
  reads by session id for the waiting state; usage-status
  (`pi-config/extensions/usage-status/windows.ts`, builtins only): `usage-windows.json`
  `{version: 1, ollama?: {resetDay: 1..31}}` (missing or unreadable = unknown; written by the Usage
  page's Ollama card and by `/usage reset-day ollama <1-31|clear>`, whose argument is a contract
  too; synced like the policy), from which the server derives Ollama's monthly window as it reads
  usage.
  Not covered by Sova's tsconfig, with these exceptions: the server imports
  `pi-config/extensions/mode/state.ts`, `minor.ts`, `delegate.ts` and `spec.ts` (`server/mode-state.ts`,
  `server/delegate.ts`, `server/spec-settings.ts`; hence `allowImportingTsExtensions`),
  `server/targets.ts` imports `pi-config/extensions/remote/argv.ts` (the target schema,
  validation and the single argv builder that both the `remote` extension and the web server use to
  run a command on a target), `server/model-favorites.ts` imports
  `pi-config/extensions/command-palette/favorites.ts` (`ModelFavorites`: the one reader and
  writer of `model-favorites.json`, with its lock, re-read and atomic rename, for the TUI palette
  and Sova's picker alike), `server/team-defaults.ts` imports
  `pi-config/extensions/subagents/team-defaults.ts` (builtins only: the file's types, defaults,
  strict parse, reader and atomic writer for Settings → Teams), `server/process-priority.ts`
  imports its `priority.ts` (builtins only: the `Symbol.for("sova:worker-nice")` hook through which
  the server sets the niceness its hosted sessions' workers and tool commands start at, and the
  lowering the subagents extension does; claude-code and the sandbox, which import nothing outside
  their own directory, call the server's `Symbol.for("sova:lower-worker")` and
  `Symbol.for("sova:tool-command-prefix")` instead; unset, as in the TUI, nothing changes;
  §app.load-priority/workers), and of the same package's
  `subagent-profiles.ts` (builtins only, see above: `server/subagent-profiles.ts` — Settings →
  Subagents, the `/api/subagents` pick route and the session-create field, `server/sync/docs.ts` —
  the library's mesh registration, its default file deliberately absent, `server/chat-manager.ts` —
  the pick entry helpers, and `server/sessions-configure.ts` / `server/overseer-tools.ts`,
  validation only), `server/claude-accounts.ts` imports
  `pi-config/extensions/claude-code/accounts.ts` (builtins only, see above: Settings → Accounts, and
  the login the server's own `claude` spawns — model discovery, `--version` — run on),
  `server/provider-limits.ts`, `server/decide-llm.ts`, `server/overseer.ts` and
  `server/sync/docs.ts` import `pi-config/extensions/provider-limits/gate.ts` (builtins only: the
  limits file's parse, reader and writer, the lease gate a one-shot claims its slot through, the
  Overseer's background mark, and the queue read for the web; its gate state is a `globalThis`
  singleton, so the extension's copy in a hosted runtime and the server's share it),
  `server/worktrees-state.ts` imports
  `pi-config/extensions/worktrees/state.ts` (builtins only: the `worktrees` entry, its fold, the
  merge card's details) and `git.ts` (builtins only: the extension's own "is this branch merged"
  probe, git by argv; `server/git-diff.ts` imports it too, for `mergedReviewBase`, the review
  base of an already merged branch, which show-changes' `git.ts` shares), `server/sandbox-state.ts` and `server/link-sandbox.ts` import
  `pi-config/extensions/sandbox/state.ts` (builtins only: the `sandbox` entry and its restore),
  `server/link-sandbox.ts` also imports `sandbox/session-policy.ts` and `policy.ts` (builtins only,
  with their siblings `backend.ts`, `backends/*` and `env.ts`: `resolveSessionPolicy`, the one
  resolution of a session's sandbox policy from its agent dir, cwd, session id and tracked
  worktrees, which the extension's `snapshot()` also calls, and `readDenial`/`writeDenial`/
  `hiddenBelow`, so a linked session's file transfer is refused exactly where that session's own
  tools would be), `server/project-services/confine.ts` imports `sandbox/backends/linux-bwrap.ts`,
  `env.ts`, `proxy.ts`, `policy.ts` and `session-policy.ts` (builtins only: a confined conformance
  run, §app.project-services/confined, holds its private network namespace in a bwrap anchor with
  the policy's proxy, and wraps each unit in the bwrap view a sandboxed session there would get, so
  an unapproved definition runs exactly as confined as the session that wrote it; the watcher does
  not watch these, so an edit there reaches a running server only at its restart),
  `server/transcript.ts` and `server/align-state.ts` import
  `pi-config/extensions/mode/align.ts` (builtins only: the `align` tool's details shape, its strict
  check `normalizeAlignDetails` and the one fold `foldAlignments` — the transcript's align row and
  the session list's `SessionSummary.align` read what the extension writes, with its own code),
  `server/insights.ts` imports
  `pi-config/extensions/usage-status/fetch.ts` and `windows.ts` (`server/sync/docs.ts` imports
  `windows.ts` too, for the file's sync registration; fetch.ts imports `claude-code/accounts.ts`, builtins
  only, to fetch each login's usage; `server/auth-status.ts`, `server/claude-login-state.ts` and
  the pool agent `server/claude-pool/` import `accounts.ts` too), `server/worker-context.ts` and `server/delegate.ts`
  import `pi-config/extensions/claude-code/context-window.ts` (imports nothing: the one Claude Code
  window rule, `[1m]` or natively 1M else 200k, and the list rule that adds `opus[1m]` and
  `claude-fable-5-1[1m]` after their listed base; the provider, `agent_models` and the subagents
  roster use the same file), and the worker-transcript protocol is imported by
  `server/insights.ts`, `worker-restore.ts`, `worker-adapters.ts`, `transcript-usage.ts` and
  `claude-transcript.ts`: `pi-config/extensions/subagents/worker-transcript.ts` (types, the one
  manifest fold `readWorkerManifests`, usage helpers), `subagents/adapters/index.ts` and `pi.ts`,
  `claude-code/transcript-adapter.ts` and `claude-code/provider/session-records.ts` (the per-backend
  readers: locating a worker's transcript and counting its usage, for restored workers and for
  every `/ws/watch` usage total; the dev watcher does not watch these, so an edit there reaches a
  running server only at its next restart). The shared fork core (`pi-config/extensions/subagents/fork/`,
  one owner of every fork's cache logic: Sova's "Fork from here" and the background forks /explain
  runs) has a server half: `server/chat-manager.ts`, `server/session-fork.ts` and their tests import
  `fork/cache.ts` (runtime builtins only, pi types: a fork's inherited prompt-cache key and its
  `sova-fork-cache` entry, the `prompt_cache_key` hook and the Codex `session-id` affinity routing),
  and `server/session-fork-routes.ts` imports `fork/claude.ts` (builtins only, through
  `claude-code/provider/fork-point.ts`: seeding a UI fork with its Claude Code source's live CLI
  session). The rest of `fork/` (copy, mirror, child extension, background runner) needs the pi
  runtime and stays out of the server. The frontend imports two files, the only runtime
  pi-config imports in `src/`: `src/lib/format.ts` re-exports `pi-config/extensions/stamp/format.ts` (the
  12-hour clock, stamp and relative time, shared with the TUI's `stamp` extension); the server
  imports the same file directly, for the ages on `sova_session`'s topics (`server/overseer-tools.ts`).
  And `src/components/Thread.tsx` imports `pi-config/extensions/show-changes/details.ts` at
  runtime (`SHOW_CHANGES_TOOL` and the strict check `normalizeShowChangesDetails`, for the
  `show_changes` tool's details `{v: 1, scope, title?, paths?, steps?}`, its scope named like
  `DiffScope` minus `sessionPath`; the tool refuses a diff of more than one hunk unless its steps
  place every hunk, with its own copy of the viewer's matching in `coverage.ts`, and Sova places
  every hunk again when it draws the diff); `src/lib/changes-view.ts` and `src/components/ChangesViewer.tsx` import
  only its types (`import type`, erased from the bundle). Vite bundles
  them for the browser, so each must import nothing at all. So an edit to any of these can break Sova's
  typecheck. Keep them pi-runtime-free (node builtins and, for the mode trio and the protocol set,
  each other only), and import nothing else from pi-config at runtime. `minor.ts` also reads its sibling `spec-mode.md` once at load, and
  refuses to load if that file's shell block is malformed. One test-only exception: `server/claude-models.test.ts` imports
  `pi-config/extensions/claude-code/transport.ts` (builtins only) to pin the server's Claude
  model-discovery argv to the extension's, and `src/lib/show-changes-coverage.test.ts` imports
  `pi-config/extensions/show-changes/coverage.ts` (imports nothing) to pin the tool's hunk matching
  to `src/lib/changes-steps.ts`'s; beyond that, `context-window.ts`, `accounts.ts` and the
  protocol set above and `provider/fork-point.ts` (through `fork/claude.ts`), the server never imports claude-code. `argv.ts` is also the quoting boundary: every path that reaches a far shell is
  single-quote-escaped there, and callers spawn its argv without a local shell. The web mode switch calls that extension's
  `/mode` command handler directly (`ChatSession.applyMode`), so its arguments are a contract too.
  Sova has no sshfs/mount support: a remote session's cwd is always its local placeholder, and
  every tool runs on the target. The watcher does NOT watch
  `pi-config/extensions/remote/**`, so edits there (argv.ts) don't restart the running
  server — it keeps the old code until its next restart.
  Tests run per extension (see `pi-config/README.md`). `pi-config/install.sh` must stay standalone,
  needing nothing outside `pi-config/`.

## Commands

- pnpm, pinned by `packageManager` (package.json) and `mise.toml`: `pnpm install --frozen-lockfile`.
  Settings live in `pnpm-workspace.yaml` (`.npmrc` is gitignored); only esbuild may run its
  install script (`allowBuilds`).
- Editing statecharts/ (the org's statecharts): start `pnpm statecharts:watch` first, run `pnpm statecharts:test`; never cold-compile in a loop; matrices only at the end; `release lib` (the vendored bundle build) only for the final bundle.
- `pnpm run dev:server` (port **4800**) and `pnpm run dev:web` (Vite, proxies /api + /ws to 4800)
- Isolated testing: `pnpm run dev:hermetic` builds `<worktree>/.agent` (`scripts/hermetic-agent-dir.mjs`: this tree's
  pi-config, own sessions/state, nothing in `~/.pi`) and serves it on 4810 (`SOVA_PORT=<n>` picks another); it copies no auth — copy `auth.json` in by hand.
  Once `.agent` holds copies of real sessions (or `--copied-sessions` announces them), the script leaves out the
  wake-nudge extension and blanks the copied scheduler state, so no copied nudge or schedule fires; the mode is sticky (`.agent/copied-sessions.json`).
- Feature work never edits `~/webapps/sova`: that is the live tree. Each feature session works in its own
  worktree and branch (`git worktree add ~/webapps/.worktrees/sova-<name> -b feat/<name>`; an agent uses the
  `worktree` tool, whose `create <name>` does exactly that and tracks it in the session, so its workers may start
  there), and only a release merges it into master. Uncommitted edits in the live tree block a release.
- Test from that worktree with `pnpm run dev:hermetic` by default: create, archive, restart and mutate sessions,
  workers and settings freely, and never restart `sova-runtime.service` to test. A feature that mutates nothing and
  needs real sessions to compare against (UI, read-only views) may read real state, but never through a second
  server: a Sova server on the real `~/.pi` still writes (seen marks, summaries, titles, signals, worker restores),
  and there is no read-only mode yet. Copy the sessions you need into the hermetic `.agent`, or view them through the live server.
- Hermetic gaps: 4810 by default (one server per port; `SOVA_PORT` for a second), and a symlinked `node_modules` can break `pnpm run` in a worktree.
- Claude logins in a hermetic run: `scripts/fake-claude.mjs` stands in for the `claude` CLI (auth
  login/logout/status, `--version`, a minimal stream-json turn; never contacts Anthropic). Put
  `$(scripts/fake-claude-path.sh)` first on `PATH`, point `CLAUDE_CONFIG_DIR` at a fixture directory
  under `.agent/` (the `default` login; the real `~/.claude` stays untouched), and set
  `SOVA_CLAUDE_ACCOUNTS_DEV=1` so `.agent/claude-accounts-dev.json` (`{"forceLimit": [ids],
  "forceAuth": [ids]}`) can force a login to fail and drive failover end to end. The force reaches
  only a session ON a registry-known login (`claude-accounts.json`); with no registry a session has
  no login and the force no-ops — use the login dir's own `FAKE_LIMIT` / `FAKE_AUTH` files (the
  fake's transport-level failure) instead. The fake's initialize answer lists one model
  (`fake-opus`), so `claude-code-cli/fake-opus` can be a session's model: the Claude Code provider
  is always on, and `<agent dir>/sova/settings.json` needs no key for it. The pool of logins
  across devices has its own multi-host run, `node scripts/claude-pool-e2e/run.mjs` (three Sova
  containers on an `--internal` Docker network in address-identity mode, fake `claude`, no
  Tailscale; `--down` removes it, `--keep` leaves desk on 127.0.0.1:4821): it needs the mesh lab's
  `sovamesh-plain:lab` image. `SOVA_CLAUDE_POOL_IDLE_MS` / `_CUT_MS` / `_TICK_MS` shorten the pool's
  30-minute idle, drain bounds and 5 s tick for such runs. Every test runner starts in a throwaway
  home (`pi-config/extensions/claude-code/tests/hermetic-env.mjs`: `pnpm test` loads it with `--import`,
  the extension runners import it first) — a session that itself runs on an added Claude login passes
  that login's directory down as `CLAUDE_CONFIG_DIR`, and tests falling back to the host's agent dir
  once wrote leases into it. A new runner imports it too; `node scripts/test-sentinel.mjs -- <cmd>`
  runs a suite against a sentinel HOME / agent dir / login dir and fails if anything there changed.
- `pnpm run typecheck` — must pass. `pnpm run build` — must pass.
- `pnpm run prices:update` — regenerate the checked-in price seed `shared/model-prices/seed.json` from models.dev and print
  the changes and any unpriced model (`--from <api.json>` offline, `--check` writes nothing). Aliases are hand-kept in
  `aliases.json` there. Servers refresh their own copy (`<state root>/model-prices.json`) every 3 days; `SOVA_PRICES_FETCH=off` stops that.
- The share listener serves the share page (`/h/`, `/i/`, `/h/assets/`) from `dist-share/` (`vite build --mode share`);
  `SOVA_SHARE_DIST=<dir>` names another build, read per request (tests point it at a stub page). With no built page it answers 503.
- `pnpm test` — unit tests (`server/*.test.ts`, `src/lib/*.test.ts`), **on Bun** (the summary line
  reads `run-tests (bun): …`). One runner, `scripts/run-tests.mjs` (`pnpm test`, the project's
  `test.run`), holds the file list; `*.browser.test.ts` files need Solid's browser build and run in
  a second pass with `--conditions=browser`; `pnpm test -- <files>` runs only those, each routed to
  its pass. Verify your work with `pnpm test` and `pnpm run dev:hermetic`, which are Bun, the
  runtime the user runs; never switch to Node unless the user asks. Node only on request:
  `pnpm run test:node` (`--runtime node`, `tsx --test`; plain `node --test <file>` fails with
  ERR_MODULE_NOT_FOUND on the extensionless imports) or `SOVA_RUNTIME=node pnpm test`; an explicit
  `--runtime` wins. No Bun found: the runner exits 2 naming `pnpm run test:node`, never a quiet
  Node pass. `pnpm run test:bun` is kept as an explicit Bun alias.
- `pi-config/install.sh` links `pi-config/` into `~/.pi/agent`, except `settings.json`: that is a seed
  deep-merged into a real `~/.pi/agent/settings.json` (seed keys win, runtime keys such as the chosen
  model stay there and never in the repo). `--check` verifies links and seed keys without changing
  anything; `--save` copies live values of seed-declared keys back into the seed.

## Live server restart (worker suicide)

The live server on 127.0.0.1:4800 is the systemd user unit `sova-runtime.service`
(`~/.config/systemd/user/`, `Restart=always`, ExecStart `node --import tsx server/index.ts`, or `scripts/start-server.sh` once switched: see **Server runtime**). It has
no file watcher: editing `server/**`, `shared/**` or `pi-config/extensions/mode/**` restarts nothing,
and the process keeps the code it loaded at start. A change goes live only on
`systemctl --user restart sova-runtime.service`. Workers spawned by a hosted session (pi or
claude-code, from agent_spawn/team_create) are CHILD PROCESSES of that server, so the restart kills
every one of them mid-task and zeroes the in-memory subagent registry. Hosted chat sessions survive
(JSONL persistence; the webapp reconnects and the runtime reopens). Workers don't.

Rules:
- After a server-side change, say that it is not live yet and needs that restart.
- Before any restart, read the live records `~/.pi/agent/sessions/live/p<server-pid>-*.json`
  (heartbeat ≤ 30s) for every hosted session: `presence.workerCounts.working > 0`, or
  `presence.activity.state === "working"` (your own turn counts too). Hold the restart if any is busy.
- Never run `systemctl restart` from inside a hosted session: you are the server's child, and the
  restart kills your turn mid tool call. The one allowed form is a delayed transient unit outside the
  server, `systemd-run --user --on-active=30s systemctl --user restart <unit>`, scheduled right after
  a final busy check of every session this server hosts (the rule above), as your turn's LAST tool
  call, after which the turn ends at once. A turn another session starts in those 30 s can still be
  cut off. If `systemd-run` fails (a sandboxed session can't reach the user bus, by design), never
  work around it: ask the user to restart. Confirm afterwards with `GET /api/health` (`startedAt`,
  `head`).
- The one verb form (Sova as its own project, `.sova/project.json`: slot 0 adopts
  `sova-runtime.service`): the operator's Apply on the project's Services tab, or
  `sova-project apply --project ~/webapps/sova --confirm`. It is refused while any hosted session is
  busy (your own turn included, so an agent never gets it through), and otherwise schedules
  `scripts/sova-restart-gate.mjs` 30 s out, which re-reads the live records when it fires and
  restarts only if nothing is busy then (else exit 75, logged in
  `<state root>/project-services/logs/restart-gate.log`). up, down, reset and teardown of slot 0 are
  refused. Never run the gate script against `sova-runtime.service` by hand, and never point a test
  at it: tests and gates use a stand-in unit.
- The claude-code bridge is a `globalThis` singleton (`getSessionBridge()`, Symbol.for registry): a
  fresh session that reloads the extension still gets the bridge built from the code loaded first,
  so provider edits also need a restart. Before trusting a live test, check the unit's start time
  (`systemctl --user status sova-runtime.service`) against the edited files' mtimes.

Dev only (`pnpm run dev:server`, not the live unit): `scripts/dev-server.mjs` is a gated watcher
over the server's import graph (non-test `server/**`, `shared/**`, and the whole
`pi-config/extensions/mode/` directory). It restarts within ~100ms of an edit, but holds the
restart while any live record shows working subagents or an in-flight turn (`r` key or SIGUSR2
forces). `dev:server:tsx` is the old plain watch, with no gate. While a watch server hosts your
session, apply server-graph edits from the orchestrator itself, batched, as the last step of a turn.
Hosted runtimes are never idle-disposed: they live until archived (running subagents die with it),
a foreign-writer reload, or server shutdown.

## Server runtime (Bun; Node on request)

The server runs on Bun (`bun server/index.ts`, Bun 1.4.2, pinned in `mise.toml`), and on Node
(`node --import tsx server/index.ts`) only when asked for. Spec: `§app/server-runtime`. One module
decides, `server/runtime-choice.ts` (node builtins only, run as a plain `node` script by the
launcher):

- **See what runs:** `GET /api/health` → `runtime: {name, version, chosen}`. `name` is this
  process (`process.versions.bun`), `chosen` what the environment asked for at its start. The
  start log line names it too (`sova server on http://… (bun 1.4.2)`).
- **Asking for Node:** `SOVA_RUNTIME=node` in the environment, or `--node` as the launcher's first
  argument (it then sets `SOVA_RUNTIME=node` for the server). Anything else = Bun. No setting file
  and no Settings picker: a `runtime.json` in the state root is ignored.
- **Who follows it:** `scripts/start-server.sh` (the launcher, also `pnpm start`; it `exec`s the
  server, so a unit's MainPID is the server), `pnpm run dev:server` (each watcher restart decides
  again), `pnpm run dev:hermetic` (`dev:hermetic:node` = the same on Node), and the unit tests
  (`pnpm test`, the project's test verb, merge-round's master re-runs). Helper scripts the server
  spawns follow `process.execPath`, so on Bun they run on Bun. `dev:server:tsx` is Node by name.
- **Bun binary:** `$SOVA_BUN`, else `bun` on PATH, else `mise which bun`. `SOVA_NODE` names the
  node binary the launcher uses (default `node` on PATH). Installed copies (install.sh, mesh-vps,
  mesh-termux) get Bun from `scripts/fetch-bun.sh`: bumping `bun` in `mise.toml` needs that
  release's checksum lines in `scripts/bun-release.txt`, or fetch-bun refuses.
- **No fallback:** Bun not found = the launcher (and the dev watcher) print
  `[runtime] bun not found: …` and exit 1; nothing starts. A Bun server that crashes at boot just
  fails (the unit's `Restart=` retries it); nothing switches to Node, nothing counts boots.
- **Switch the live unit:** set `Environment=SOVA_RUNTIME=node` (or `--node` on its ExecStart),
  `systemctl --user daemon-reload`, then restart under the rules of **Live server restart** above
  (the gate, never `systemctl restart` from a hosted session). An agent never edits the unit.
- **The live unit** (`sova-runtime.service`) runs `scripts/start-server.sh`, so it is on Bun.
  README's "Run on Bun (or Node)" has the complete unit example (`%h` paths, the same ExecStartPre,
  PATH, Restart and TimeoutStopSec as the live unit) and the switch steps.
- **Testing a server:** in a worktree, `pnpm run dev:hermetic` (Bun) or `SOVA_PORT=48xx pnpm run
  dev:hermetic`; check `curl -s 127.0.0.1:<port>/api/health`. On Node only when asked:
  `pnpm run dev:hermetic:node`. `SOVA_BUN=/nonexistent` drives the "bun not found" error.
- **Bun quirks:** the registry is `docs/bun-quirks.md` (each quirk's Bun version, upstream issue,
  workaround, canary and repro). Workarounds live only in `server/runtime-quirks.ts`, probe the
  behaviour and never name a runtime. Every WebSocket in `server/` is built with its
  `cappedWebSocketServer` / `cappedWebSocket` (ws `maxPayload` and `handshakeTimeout` aren't
  enforced on Bun; Sova enforces both itself). Tests on Bun only through `pnpm test`: it
  sets HOME before bun starts (Bun's `os.homedir()` ignores an in-process change), puts the real
  node and `mise bin-paths` first on PATH (shims refuse in a throwaway HOME; tests spawn `node` and
  `python3`), and sets `SOVA_PRICES_FETCH=off`. `bun test` itself runs with TZ=UTC and
  NODE_ENV=test, unlike `node --test`. A `mise.toml` change needs `mise trust <worktree>` again.

## Working rules

- Never use Opus 5 (`claude-opus-5`). "opus" means Opus 5.5: claude-code `opus` or `opus[1m]`.
- Throwaway test sessions run on `zai/glm-5.3`. New web sessions default to a costlier model, so set
  the model before the first prompt, and archive the session afterwards.
- Never `git stash`, `checkout`, `reset` or `restore` in a worktree others share. Take baselines with
  `git archive <rev> | tar -x -C ~/.cache/<name>`, never `git worktree add` (it writes the shared `.git`).
- Run `mise trust <worktree>` in a fresh worktree before any node/pnpm command.
- Retire a worker past 50% of its context window: have it write a checkpoint, then hand off to a
  fresh worker instead of resuming or steering the old one.
- The pi-web archive and the pi-config mirror are private repositories: never link, fork or expose
  them. In public docs, describe `pi-config/` as a directory in this repo.
- Playwright in a fresh worktree: symlink the live tree's `.claude/skills/playwright/scripts/node_modules`
  and remove it afterwards. If port 4810 is taken by another worktree, never kill it: run
  `PORT=481x PI_CODING_AGENT_DIR=<wt>/.agent pnpm exec tsx server/index.ts`. After a rebuild,
  unregister the app's service worker and clear its caches, or the page keeps the previous build.
- Web Push testing: use `CHROMIUM_BIN=/usr/bin/google-chrome-stable` (bundled Chromium cannot
  subscribe), and grant, enable, trigger and check inside ONE `pw.sh run`: a CDP permission grant
  resets on detach and Chrome drops the subscription.
- `dev:hermetic` regenerates `.agent/settings.json` on every start. For a custom pi setting, run
  `node scripts/hermetic-agent-dir.mjs`, add the key, then start the server yourself.

## Product documentation

`.sova/spec/` is the requirement for what Sova does: `manifest.json` plus `claims/<ns>/<name>.md`,
under `§` IDs. A record labelled `authority: migrated`, `evidence: unreviewed` carries prose that
is the requirement, but nothing has checked that the code does it. Verify the implementation
before you claim a feature.
- Drafts and reviews are local only (`.sova/spec/.gitignore`); commit by explicit path, as
  `.sova/spec/README.md` shows, never `git add -A`.
- **Before and while a task changes behavior, follow the spec discipline.** If your system prompt
  already includes the `# Minor mode: spec` block, follow it without rereading. Otherwise read
  `pi-config/extensions/mode/spec-mode.md`, the same text, and follow it. It applies in Sova
  whether or not that mode is on; don't turn any mode on. Commands are in `.sova/spec/USAGE.md`.

## Method

Rules for working on this repo, each earned by at least two real misses on the `fanout-groups`
branch (the full reasoning lives in that branch's commit messages and `§workspace.groups/decisions`):

- **Prefer the form that cannot be accidentally satisfied** — in tests, rules, and copy alike. A
  collision assertion beats a literal string; a behaviour name beats a property name; a sentence
  true in every branch beats one that is merely right in the common one. The rules below are
  instances of this one.

- **A worked example is a second implementation of its rule, not documentation of it.** Review it
  the same way you review the rule — a rule and its own example disagreed three times in one file.
- **Reading verifies claims; running verifies neighborhoods.** Exercising a surface finds the
  instance; enumerating the inputs finds the class. The defects that mattered were all seams —
  invisible to a green build, found only by driving the thing.
- **Before trusting a check, ask what it returns in the case you're trying to rule out.** A check
  that cannot distinguish the two states isn't weak evidence — it's no evidence. And a
  what-instrument cannot answer a when-question: greps and test counts say what's there;
  `git show <sha>:<file>` and `git merge-base --is-ancestor` say since when. Name the commit a
  claim is true at, and read the live tree, not an archive of it.
- **A frame that is confirming itself feels exactly like a frame that is correct.** When a class
  is salient, every event reads into it and the pattern-match feels like recognition; a count of
  instances is an instrument like any other and must be measured, not repeated.
- **Solid's `on(deps, fn)` does not equality-gate the deps' VALUE — it re-fires whenever any
  signal read while evaluating the accessor changes.** `on(() => props.group.id, …)` reads
  `props.group`, which is a fresh object on every background refresh of the list, so the effect
  fired on every refresh while the id string never changed. Two real misses from that one shape
  on `fanout-groups`: every pane width (Wider/Narrower/Fit) was reset by `setWidths({})` one
  fetch after the click — styles written at 280px, observed resetting to 490px ~283ms later —
  and the effect that re-read the groups re-triggered itself on its own response, a standing
  fetch loop. When only the VALUE matters, make the dep a memo (`const gid = createMemo(() =>
  props.group.id)`) so equality gating happens where you can see it. The green build catches
  none of this: the bug is between two re-runs, not inside either.

## pi SDK facts (verified against the installed package, 0.87.1)

Pi package on disk: the repo-pinned copy Sova runs, `node_modules/@earendil-works/pi-coding-agent/`
(docs/ and examples/sdk/ there are authoritative — read them, not your memory). Under pnpm it is a
link into `node_modules/.pnpm/`, and its own dependencies (pi-ai, pi-tui, pi-agent-core, typebox)
sit BESIDE its real path, not nested under it: resolve them from `realpath` of the package. The
global pi the TUI runs (`/home/user/.local/share/mise/installs/node/25.2.1/lib/node_modules/…`)
is a separate install and may be another version — a fact read there is not a fact about Sova.

- Sessions: `~/.pi/agent/sessions/--<cwd with /→->--/<iso-ts>_<uuidv7>.jsonl`.
  Line 1 header: `{"type":"session","version":3,id,timestamp,cwd}`.
  Entries have `id`/`parentId` (tree). Types: `message`, `custom`, `model_change`,
  `thinking_level_change`, `usage` (0.86.0+), `compaction`, `session_info`, `label`, `branch_summary`,
  `context_edit` (0.87.0+) (`SessionEntry` union, `dist/core/session-manager.d.ts:128`).
  Cheap listing: read only the first few lines; first user `message` = title; first `model_change` = model.
  Docs: `docs/session-format.md`.
- **Sova writes `custom` entries with `customType: "sova-rewind"`** (`data: {targetId, fromLeafId}`)
  into webapp-owned session files. `navigateTree(id, {summarize:false})` only moves the in-memory
  leaf and `SessionManager.open()` takes the file's LAST entry as the leaf, so without this marker a
  reload or restart reverts a rewind. It is invisible (normalizeEntry renders unknown custom types as
  nothing; the TUI ignores it too), never LLM context, no usage. Written by `rewindSession` in
  `server/chat-manager.ts`, parented on the new leaf; the open-time deferred appends are flushed
  AFTER navigating (before, they would land on the abandoned branch).
- SDK: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager.open(path)/create(cwd)`,
  `ModelRuntime.create()` (no args → reuses `~/.pi/agent` auth). Events via `session.subscribe`.
  Docs: `docs/sdk.md`; examples: `examples/sdk/11-sessions.ts`, `13-session-runtime.ts`.
- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it
  (no prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json`
  (schema: `pi-config/extensions/sessions/public/SCHEMA.md`). Live sessions: read-only via `/ws/watch`
  (tail the JSONL with fs.watch + parse appended lines).
- Extension dialog bridge (ExtensionUIContext) pattern: `dist/modes/rpc/rpc-mode.js` —
  `createExtensionUIContext` at line 83, bound via `bindExtensions({uiContext, mode:"rpc", ...})` at line 231.

## Conventions

TS strict, ESM, no new dependencies without asking. Server normalizes JSONL entries into
`TranscriptItem`; frontend renders those, and renders live streaming from the raw passthrough events.
Frontend is SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.

- Never keep secrets or machine-specific details in the repo (it is public): no keys, tokens, real IPs, hostnames, tailnet names, device IDs or home paths in code, scripts, tests, docs or commit messages. Read them from a gitignored env file (e.g. `local.env`, with a committed `local.env.example` of placeholders); when you create one, tell the user so they can fill it in.

## Backend notes (SDK surprises, pi 0.87.1)

- `SessionManager.open(path)` is NOT read-only: `loadEntriesFromFile` appends `"\n"` to a trailing
  partial line (`dist/core/session-manager.js:367`) and `_rewriteFile()` (`:754`) rewrites the whole
  file when migrating old versions (`:722`). Never call it on a file a TUI may own —
  transcript/watch use our own parser (`server/transcript.ts`); `open()` only for webapp-owned chats.
- `SessionManager.create(cwd)` defers writing the file until the first assistant reply
  (`_persist()`, `dist/core/session-manager.js:785` — body byte-identical from 0.85.1 through 0.87.1).
  `POST /api/sessions` writes the header line itself so the new session exists on disk immediately.
- pi's `theme` singleton is not re-exported from the package entry (`dist/index.d.ts` exports
  `initTheme`/`Theme` only, though `theme` exists on `modes/interactive/theme/theme.ts`). The
  ExtensionUIContext bridge calls `initTheme()` and reads
  `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` — same key pi sets in
  `dist/modes/interactive/theme/theme.js:536`.
- The sessions extension also loads inside our embedded runtimes and writes `live/*.json` with the
  server's own pid. `server/live.ts` ignores own-pid and dead-pid records, otherwise every
  webapp-owned session would look TUI-busy.
- pi 0.86.0 writes two entry shapes 0.85.1 never emitted, and since the pin moved our OWN runtimes
  write them too: `message` entries with `role:"system"` (the prompt/tool loadout — `content`,
  `sections`, `toolsAdded`/`toolsRemoved`; `SystemMessage` in pi-ai `dist/types.d.ts:331`) and
  top-level `type:"usage"` entries (`UsageEntry`, `session-manager.d.ts:36`, written by
  `SessionManager.appendUsage()`; only caller is `dist/core/cache-warmer.js:249` with
  `kind:"cache_warm"`). Cache warming is ON by default (`getCacheWarmingMode()` →`"streaming"`,
  `dist/core/settings-manager.js:637`), so expect these in webapp-owned sessions. The webapp hides
  both from the transcript (`server/transcript.ts:175` and `:315`) and counts only the usage ones in
  session totals (`piUsageTally`, `server/transcript-usage.ts:64`, through the subagents pi adapter
  `pi-config/extensions/subagents/adapters/pi.ts:109`; deduped by entry id). They never move context
  fill: `contextForBranch` reads assistant-message usage only (`messageContextTokens`,
  `server/transcript.ts:397`).
  `compaction` entries also gained a `systemMessage` field (additive; we ignore it).
- **`steer()`/`followUp()` now run extension `input` handlers** (`source` defaults to `"interactive"`,
  `dist/core/agent-session.js` `_queueUserInput`); on 0.85.1 they bypassed them entirely
  (0.85.1 `steer()` went straight to `_queueSteer`). Narrow blast radius: `prompt()` ALREADY ran them
  on 0.85.1 (`agent-session.js:842`), and `handOffQueued` (`server/chat-manager.ts:679-680`) only
  calls `steer()` while streaming, for a steer item whose text is not a `/command` — every other web
  send goes through `prompt()`. So
  the pi-config handlers (`vision-delegate`, which describes attached images for non-vision models,
  and `wake-nudge`) have always run against our runtimes; the genuinely new case is the mid-stream
  steer. A handler returning `{action:"handled"}` silently swallows the message
  (`dist/core/extensions/runner.js:1112`); returning `null`/`undefined` is the safe fall-through, and
  neither of ours returns `handled`. A mid-stream steer that CARRIES IMAGES while the active model
  cannot see them waits on `vision-delegate`'s describe call before it is queued
  (`pi-config/extensions/vision-delegate/index.ts:180-191`), so it can land after the turn it meant
  to interrupt — nothing is dropped, and plain steers are unaffected.
- Unidentified writers (e.g. a headless/orchestrating pi, not in the live registry): `/ws/chat` refuses
  (`code:"busy"`, close 4409) a session the server doesn't hold whose mtime is < 120s old
  (`RECENT_WRITE_MS` in `server/write-guard.ts`, shared constant with the frontend) unless `&force=1`.
  While holding a runtime, `ForeignWriteGuard` checks appended lines carry ids our SessionManager knows;
  any foreign line → busy on every prompt/steer until a `&force=1` reconnect reloads the runtime from disk.
  TUI-live sessions stay refused even with force.
- `SessionSummary.origin`: ids of sessions spawned via `POST /api/sessions` persist in
  `~/.pi/agent/sova/web-sessions.json` (`server/web-sessions.ts`); everything else is "external".
  Writes re-read + merge (safe with several servers); reads use the startup copy plus this
  server's own adds, so ids another running server adds show as "web" here only after a restart.
- Opening a chat runtime must not write: the SDK appends model_change/thinking_level_change at
  construction (empty sessions, or no thinking entry on the branch — `dist/core/sdk.js:261-272`,
  the same appends since 0.85.1). `openSession` defers those two
  appends and replays them right before the first prompt/steer; a never-prompted session stays untouched.
- Images: 0.87.1 `ImageContent` is still `{type:"image", data, mimeType}` (pi-ai `dist/types.d.ts:256`)
  for prompt/steer/followUp AND storage
  (sdk.md's `source:{type:"base64"}` example is stale). Model favorites are the
  command-palette's `~/.pi/agent/model-favorites.json` (`{version:1, models:[{provider,id}]}`), read
  and written through that extension's own `ModelFavorites` (`server/model-favorites.ts`; the
  picker's star and Ctrl+F → `PUT /api/models/favorite`). A malformed file lists no favorites and
  refuses every write; it is never overwritten.
- Context fill = input+cacheRead+cacheWrite of the last assistant usage on the branch; a compaction after it → `context: null` until the next reply (window: SDK registry, else models-store.json).
- pi 0.87.0 made the `SessionManager` canonical for model context: every request is built from
  `sessionManager.buildSessionProjection()` (`dist/core/agent-session.js` `prepareNextTurnWithContext`),
  and `agent.state.messages` is overwritten from it (`_refreshFinalizedContext`, `:418`). ASSIGNING
  `agent.state.messages` no longer reaches the model — append through the session's SessionManager
  and call `session.refreshContext()` (`agent-session.d.ts:314`); the `btw` extension's side-thread
  seed does exactly that (`seedBtwSession`). Sova assigns it nowhere.
- pi 0.87.0 `context_edit` entries (`ContextEditEntry`, `session-manager.d.ts`: `targetId`,
  `replacement: {content} | null`) change what an earlier entry sends the model, never raw history.
  pi writes one ITSELF on every auto-retry and overflow recovery (`_omitRecoveryAttempt`,
  `agent-session.js:667`, emitted as `entry_appended`), so webapp-owned sessions get them. The
  transcript renders nothing for them (`normalizeEntry`) and the edited message keeps its row;
  `contextForBranch` does not treat one as staleness (pi's own accounting does: usage before a later
  edit is not the context size) — in practice pi's only trailing edit is followed by a retry reply
  or a compaction, both of which already reset the fill.
- pi 0.87.0 defers a `prompt()` made while `agent_settled` is being emitted (session listeners
  included, `agent-session.js:531-553`): it resolves at once, and its turn runs inside the
  PREVIOUS `prompt()`'s promise, whose rejection then carries the deferred turn's error. An item
  still held when the queue wakes on `agent_settled` is handed off synchronously inside that window,
  so its turn takes this path: it still starts, and its failure surfaces through the previous
  call's failure handling, which every `prompt()` call site in `server/chat-manager.ts` attaches
  (`.catch`, or the returned `turn`). Topic batches (`server/topic-delivery.ts`,
  `ChatSession.deliverTopicBatch`) stay out of that window on purpose: a settle only schedules a
  drain on a timer, after the web queue's own hand-off, and a batch counts as delivered at its user
  entry's `message_end` (the `sova-topic-delivered` marker), never when its `prompt()` resolves.
- `Agent.peekQueuedMessages()` exists from 0.87.0 (pi-agent-core `agent.d.ts:100`) but Sova's queue
  deliberately does not use it; `server/chat-queue-clients.test.ts` pins its presence.
