# Sova

Webapp interface for the pi coding agent (npm: `@earendil-works/pi-coding-agent`, pinned **1.0.3**).
Single local user. Goals: list all sessions, view transcripts, chat in webapp-owned sessions,
live-watch sessions that are open in the CLI/TUI, spawn new sessions.

The remote is `github.com/Naomarik/sova`. The worktree is `~/webapps/sova` and the state
directory is `~/.pi/agent/sova/`. A move of the worktree breaks the absolute symlinks in
`~/.pi/agent/` (`keybindings.json`, `models.json`, `vision-delegate.json`), so
re-run `pi-config/install.sh` after one (`--check` verifies them without changing anything).

## Layout & ownership

- `shared/protocol.ts` — the REST/WS wire contract. Change only with team coordination.
- `shared/harness.ts` — the harness contract: a types-only barrel over `shared/harness-core.ts`,
  `-tools`, `-history`, `-wire`, `-state`, `-session` (each imports only its siblings, with
  `import type`, and emits no code), what Sova code outside the adapter speaks instead of pi's
  shapes. Owned by **backend**; see **Harness boundary**.
- `server/harness/pi/` — the pi adapter: the only place outside the baseline that may reach
  `@earendil-works/*`.
- `server/` — Node backend: Hono (REST) + `ws` (2 WS endpoints), embeds the pi SDK. Owned by **backend**.
- `src/` — SolidJS + TS frontend (Vite, vite-plugin-solid; HMR = live reload). Owned by **frontend**, except `src/design/`.
  One runtime import runs the other way: `server/vis-check.ts` (the vis retry and the `vis_check` tool) imports
  `src/vis/parse.ts` and `src/vis/kinds/frame/parse.ts`, so the parse side of `src/vis/` (parse.ts, registry.ts,
  core/, kinds/*/parse and height/layout) must stay DOM- and Solid-free at load, and an edit there only reaches
  the running server at its restart. `server/baton-view.ts` (the share pages' markup backstop) imports
  `src/share/markdown.ts` (`shareFences`: the share page's own markdown-it parse, so it finds fences
  exactly as the page draws them) with `src/vis/parse.ts` and `registry.ts`: keep `src/share/markdown.ts`
  DOM- and Solid-free too. Likewise `server/transcript.ts` imports `src/lib/message.ts`
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
  an optional fallback), no longer written by Sova (Settings → Subagents edits routing per profile; the file seeds and backs that library), and re-read by every
  Delegate session at each turn boundary — never snapshotted into a session; mode `mode-spec.json`
  = the spec minor mode's writer (one backend/model/effort plus an optional fallback, or `null`: the
  session writes the spec itself), seeding/backing the profiles' spec writer the same way, and re-read the same way by
  every session with spec on, in either major mode), subagents `team-defaults.json` = the standing
  coordinator and monitor every new team gets (absent = off), seeding Settings → Subagents' Teams section and
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
  mode's `spec-turn` custom entry (`{v: 1, ops, own, landed, arrived?, created, gate, check,
  prose?}`, one per changing run, mode/spec-turn.ts), read by Sova for the spec card and its claim
  sheet, and by the check itself for the § earlier runs described;
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
  usage; the usage ledger (`pi-config/extensions/llm-inflight/usage-record.ts`, builtins only,
  §app.insights/usage-ledger): `<agent dir>/usage/v1/<UTC day>/<producer>.jsonl`, one record per
  model call `{v: 1, key, ts, device, producer, src, provider, model, responseModel?, input, output,
  cacheRead, cacheWrite, cacheWrite1h?, owner, parent, worker?, kind, purpose?, cwd?, project?, starter?,
  stop?}`, written at each call's end by llm-inflight (one writer per file: the process's producer
  id) and by the server's own one-shots, read only by the server's usage helper (its strict parse
  `parseUsageLine`), which prices every spend figure Sova shows; beside it llm-inflight keeps
  `<agent dir>/usage/cc-baseline/<claude session id>.json` `{v: 1, at, models}` (`claude-usage.ts`: each
  Claude session's last cumulative `modelUsage`, so a resume never recounts) with `<claude session id>.since.jsonl`
  beside it (one line per message recorded since that baseline, so a process killed mid-turn is never recounted), and the subagents extension
  sets `PI_USAGE_PARENT=<parent sid>:<worker id>` in every worker's spawn env (the worker's records name
  their parent from it).
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
  strict parse, reader and atomic writer for the legacy team defaults), `server/process-priority.ts`
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
  `pi-config/extensions/sandbox/state.ts` (builtins only: the `sandbox` entry and its restore; its
  optional `workers: "off"` field makes the three states, §chat.sandbox/states, and `on` keeps
  meaning the session's own tools for every reader), `server/overseer.ts` imports `sandbox/policy.ts`
  (`loadPolicyFile`, `policyFilePath`: the state a new session starts in, for the Overseer's
  lowering check),
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
  `server/transcript.ts` and `server/spec-claim.ts` import `pi-config/extensions/mode/spec-turn.ts`
  (imports nothing: the spec check's per-run `spec-turn` record — a plain custom entry the mode
  extension appends at the check's final verdict, never a custom message, so never model context —
  its shape, its strict check `normalizeSpecTurnDetails` and its builder; the transcript's spec card
  and the claim sheet read what the extension writes, with its own code, §chat.spec-card/record),
  `server/harness/pi/open.ts` imports `pi-config/extensions/model-levels/core.ts` (builtins only:
  the thinking levels of models.json providers pi has no catalog for, from Ollama's `/api/show` and
  models.dev, cached in `<agent dir>/model-levels.json`; the shared runtime gets them at boot, and
  the extension, which every pi worker also loads, at each session start and turn, §app/model-levels;
  one rule, `modelFetchEnabled` there, governs every metadata fetch, the server's boot fetches and
  each hosted session's extension alike: `PI_OFFLINE` or `SOVA_MODELS_FETCH=off` stops them, and a
  test process never fetches unless `SOVA_MODELS_FETCH=on`),
  the server's one-shot paths (`server/decide-llm.ts`, `server/decide-jev.ts`,
  `server/session-autotitle.ts`) and its usage helper (`server/usage-helper/`) import
  `pi-config/extensions/llm-inflight/usage-record.ts` (builtins only: the ledger record's shape,
  writer and strict parse; the watcher does not watch it, so an edit reaches a running server only
  at its restart),
  `server/insights.ts` imports
  `pi-config/extensions/usage-status/fetch.ts` and `windows.ts` (`server/sync/docs.ts` imports
  `windows.ts` too, for the file's sync registration; fetch.ts imports `claude-code/accounts.ts`, builtins
  only, to fetch each login's usage; `server/auth-status.ts`, `server/claude-login-state.ts` and
  the pool agent `server/claude-pool/` import `accounts.ts` too), the server imports
  `pi-config/extensions/claude-code/catalog.ts` (imports nothing: Sova's own Claude model catalog,
  §app.claude-code-provider/catalog — one entry per real model, its catalog id, CLI name, window,
  output cap and efforts, no aliases and no `[1m]` forms — and the frozen read-only table of old
  ids, §app.claude-code-provider/legacy-ids; Settings lists, worker windows, Usage rows, session open,
  every one-shot's `--model` and the built-in defaults read it; `context-window.ts` is its window
  rule re-exported; the provider, `agent_models`, the subagents roster, `mode/delegate.ts`,
  `subagents/team-defaults.ts`, `subagent-profiles.ts` and topic-outline import it too, and
  `pnpm run claude:catalog` diffs it against the installed CLI's own table), and the worker-transcript protocol is imported by
  `server/insights.ts`, `worker-restore.ts`, `worker-adapters.ts` and
  `claude-transcript.ts`: `pi-config/extensions/subagents/worker-transcript.ts` (types, the one
  manifest fold `readWorkerManifests`, usage helpers), `subagents/adapters/index.ts` and `pi.ts`,
  `claude-code/transcript-adapter.ts` and `claude-code/provider/session-records.ts` (the per-backend
  readers: locating a worker's transcript and reading its turns, model and context fill for
  restored workers; the dev watcher does not watch these, so an edit there reaches a
  running server only at its next restart). The shared fork core (`pi-config/extensions/subagents/fork/`,
  one owner of every fork's cache logic: Sova's "Fork from here" and the background forks /explain
  runs) has a server half: `server/chat-manager.ts`, `server/harness/pi/fork.ts` and their tests import
  `fork/cache.ts` (runtime builtins only, pi types: a fork's inherited prompt-cache key and its
  `sova-fork-cache` entry, the `prompt_cache_key` hook and the Codex `session-id` affinity routing),
  and `server/session-fork-routes.ts` imports `fork/claude.ts` (builtins only, through
  `claude-code/provider/fork-point.ts`: seeding a UI fork with its Claude Code source's live CLI
  session). The rest of `fork/` (copy, mirror, child extension, background runner) needs the pi
  runtime and stays out of the server. The frontend imports three files, the only runtime
  pi-config imports in `src/`: `src/lib/format.ts` re-exports `pi-config/extensions/stamp/format.ts` (the
  12-hour clock, stamp and relative time, shared with the TUI's `stamp` extension) and imports
  `pi-config/extensions/claude-code/catalog.ts` (every Claude model's name, `modelLabel`,
  §app.claude-code-provider/model-names; the rest of `src/` reaches the catalog only through
  `format.ts`); the server
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
  to `src/lib/changes-steps.ts`'s; beyond that, `catalog.ts` (with `context-window.ts`), `accounts.ts` and the
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
  The same preload stops git's repository search at the temp dir (`GIT_CEILING_DIRECTORIES`) and
  drops `GIT_DIR`-like variables, and `pnpm test` exits 2 when its temp dir is inside any git
  repository: tests register plain temp folders as projects, and a `TMPDIR` inside a worktree once
  made them Sova's own checkout, so tests committed promotions on master and cut `sova/*` worktrees.
  A test that needs a plain folder makes its temp root with `scratchRoot` (`server/test-scratch.ts`);
  one that needs a repository runs `git init` under it.
- `pnpm run typecheck` — must pass. `pnpm run build` — must pass.
- `pnpm run prices:update` — regenerate the checked-in price seed `shared/model-prices/seed.json` from models.dev and print
  the changes and any unpriced model (`--from <api.json>` offline, `--check` writes nothing). Aliases are hand-kept in
  `aliases.json` there. Servers keep their own price history in `<state root>/model-prices.json`: the usage helper
  (`server/usage-helper/`) pulls models.dev every 6 hours and on Refresh Prices, a pull only adds dated periods, and
  the seed is copied there only when the file is missing; `SOVA_PRICES_FETCH=off` stops pulling.
- The share listener serves the share page (`/h/`, `/i/`, `/h/assets/`) from `dist-share/` (`vite build --mode share`);
  `SOVA_SHARE_DIST=<dir>` names another build, read per request (tests point it at a stub page). With no built page it answers 503.
- `pnpm test` — unit tests (`server/*.test.ts`, `src/lib/*.test.ts`), **on Bun** (the summary line
  reads `run-tests (bun): …`). One runner, `scripts/run-tests.mjs` (`pnpm test`, the project's
  `test.run`), holds the file list; `*.browser.test.ts` files need Solid's browser build and run in
  a second pass with `--conditions=browser`; `pnpm test -- <files>` runs only those, each routed to
  its pass. On Bun it runs files longest first by the times it recorded last in the worktree's
  gitignored `.cache/test-durations.json`, and ends with the 10 slowest. Verify your work with `pnpm test` and `pnpm run dev:hermetic`, which are Bun, the
  runtime the user runs; never switch to Node unless the user asks. Node only on request:
  `pnpm run test:node` (`--runtime node`, `tsx --test`; plain `node --test <file>` fails with
  ERR_MODULE_NOT_FOUND on the extensionless imports) or `SOVA_RUNTIME=node pnpm test`; an explicit
  `--runtime` wins. No Bun found: the runner exits 2 naming `pnpm run test:node`, never a quiet
  Node pass. `pnpm run test:bun` is kept as an explicit Bun alias.
- The spec replay suite (`pi-config/extensions/spec/tests/replay`) is a landing gate the merge round runs; never run it while working.
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
  `sova-project apply --checkout ~/webapps/sova --confirm` (apply names its instance: the main
  checkout's is slot 0; `--project` alone is refused, `invalid-request`). It is refused while any hosted session is
  busy (your own turn included, so an agent never gets it through), and otherwise schedules
  `scripts/sova-restart-gate.mjs` 30 s out, which re-reads the live records when it fires and
  restarts only if nothing is busy then (else exit 75, logged in
  `<state root>/project-services/logs/restart-gate.log`). up, down, reset and teardown of slot 0 are
  refused. Never run the gate script against `sova-runtime.service` by hand, and never point a test
  at it: tests and gates use a stand-in unit.
- On macOS the live server is the launchd agent `sova-runtime` (`~/Library/LaunchAgents/sova-runtime.plist`,
  README's launchd example), and every rule above holds. Its restart is
  `launchctl kickstart -k gui/$(id -u)/sova-runtime`, never run by hand from a hosted session: use the
  verb form (`sova-project apply --checkout ~/webapps/sova --confirm`; its gate runs detached from the server, waits the
  30 s itself and then kickstarts the agent) or ask the user. Its pid and state:
  `launchctl print gui/$(id -u)/sova-runtime`; its start time: `ps -o lstart= -p <pid>`; its log:
  `~/Library/Logs/sova-runtime.log`.
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

- Never use Opus 5 (`claude-opus-5`). "opus" means Opus 5.5: claude-code `claude-opus-5-5` (an old alias
  such as `opus[1m]` typed as input runs as its catalog id; Sova's Claude catalog, `claude-code/catalog.ts`, names every model).
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
- A change to the spec tools themselves names the goal it serves in
  `pi-config/extensions/spec/docs/GOALS.md` and is measured against today's tools by the replay harness.

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

## pi SDK facts (verified against the installed package, 1.0.3)

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
  reload or restart reverts a rewind (quirk P10). It is invisible (the transcript's `entryRows`,
  `server/transcript.ts`, gives no row for it; the TUI ignores it too), never LLM context, no usage. It is the `REWIND` kind of the
  registry `server/harness/state-kinds.ts`, written through `SessionState` (pi adapter:
  `server/harness/pi/state.ts`) by `rewindSession` (`server/harness/pi/history-ops.ts`, the chat's
  `HarnessSession.rewindTo`), parented on the new
  leaf; the open-time deferred appends are flushed AFTER navigating (before, they would land on the
  abandoned branch). Every other Sova custom entry works the same way (§app.harness/state).
- SDK: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager.open(path)/create(cwd)`,
  `ModelRuntime.create()` (no args → reuses `~/.pi/agent` auth). Events via `session.subscribe`.
  Docs: `docs/sdk.md`; examples: `examples/sdk/11-sessions.ts`, `13-session-runtime.ts`.
- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it
  (no prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json`
  (schema: `pi-config/extensions/sessions/public/SCHEMA.md`). Live sessions: read-only via `/ws/watch`
  (tail the JSONL with fs.watch + parse appended lines).
- Extension dialog bridge (ExtensionUIContext) pattern: `dist/modes/rpc/rpc-mode.js` —
  `createExtensionUIContext` at line 83, bound via `bindExtensions({uiContext, mode:"rpc", ...})` at line 231.
  Sova's is `createPiUiContext`/`bindPiExtensions` (`server/harness/pi/ui-bridge.ts`), bound by
  `PiChatHost.bindExtensions` (`server/harness/pi/host.ts`).

## Harness boundary

Sova speaks its own harness contract; pi is its one harness, behind one adapter (§app/harness).

- `shared/harness.ts` is the contract. The server drives a live session only through `HarnessSession`
  (`shared/harness-session.ts`; pi's is `PiHarnessSession`, `server/harness/pi/session.ts`): a
  `ChatSession` has `chat.harness` and holds its pi runtime as a `PiChatHost` (`server/harness/pi/host.ts`),
  never the `AgentSession`. Tests that drive or patch pi directly use `piSession(chat)`/`piRuntime(chat)`
  (`server/harness/pi/testing/handle.ts`). (§app.harness/session)
- **Every reach into pi's internals is a quirk** in `server/harness/pi/QUIRKS.md` (typed rows: `quirks.ts`):
  a monkey-patch, private read, error text, ordering or internal API, each with its sites and a canary
  (`P1`…`P20`, `T1`) in `contract.test.ts`. On a pin bump or a TUI pi upgrade, run the canaries against
  that pi (command below); a failing canary is a triage by its row, never a test edit.
  `quirks-meta.test.ts` fails on a private cast, method-table cast or SDK-member assignment that no row
  names. A new reach adds its row, canary and sites in the same change.
- `server/harness/pi/` is the only code that may reach pi:
  an import of `@earendil-works/*` in any form (static, type, `import()`, `require`,
  `import.meta.resolve`, or any string naming the package) anywhere else in `server/`, `shared/`,
  `src/` (tests included), or in a pi-config file the server or the web app imports at runtime,
  fails `pnpm test`. Only the adapter may import `pi-config/extensions/subagents/adapters/pi.ts`.
- `server/harness-boundary.test.ts` keeps five ratchets against `server/harness/boundary-baseline.json`,
  exact per file (tests are not counted for reads and writes):
  pi imports (runtime or type); raw pi entry reads — `calls` (the transcript's raw API by import
  binding: `parseLines`, `activeBranch`, `readActiveBranch`, `entryOf`, `normalizeEntries`,
  `normalizeEntry`, `rawOf`; `getBranch`/`getEntries`/`getEntry`/`rawBranch` by name), `shapes`
  (`.customType` reads, `.type` compared to a pi entry type, JSON-spelled `"type":"…"`/`"customType":"`/
  `"role":"` strings, and in `src/`/`shared/` pi event-name comparisons and `.meta` reads), `reaches`
  (`sessionManager`, members only pi's SessionManager has, the `SessionManager` class, and the
  `liveRead`/`stateOf` bridges); and custom-entry writes (`appendCustomEntry`, `appendEntry`,
  `appendSpecialEntry`, every call site whatever its type argument, plus any function that forwards
  its own parameter as the entry type, listed in `wrappers`); and pi agent-session reaches through
  `.session` (`chat.session.isStreaming`, a `.session.` member read; ask `chat.harness` instead); and
  uses of `extensionEntries` (raw custom entries for pi-config cores), in its `extension` list. With no
  baseline at all, it fails a production import of `server/harness/pi/testing/` or `host-registry.ts`, a
  cast of `chat.harness` (or a string-named member on it), and a StateKind cast, declared or built
  outside `server/harness/state-kinds.ts`.
  Above the baseline fails, and so does
  below it — lower the baseline in the change that removes the hit. It also fails when a test file
  under `server/`, `shared/` or `src/` is matched by no glob in `scripts/run-tests.mjs`.
- **The baseline only shrinks.** Never add a file, raise a count or list a new wrapper to make the
  test pass; if a change seems to need it, stop and ask the user. A working-tree baseline that grew
  past `HEAD`'s fails too. `SOVA_BOUNDARY_OUT=<absolute path> pnpm test --
  server/harness-boundary.test.ts` writes the computed baseline for the diff; after a merge,
  regenerate it on the merged tree. One file entered the baseline by design: `shared/wire-v1.ts`,
  the v1 wire shim, which must read pi's v1 event names to turn an older server's or peer's frames
  into `SovaEvent`s; it stays pi-import-free, and no other file joins it.
- New work is harness-neutral: a server feature imports `shared/harness.ts` and `server/harness/`,
  never pi; new per-session state is a `StateKind` registered in `server/harness/state-kinds.ts` and
  written through `SessionState` (`ToolCtx.state()` / `StateView` to read), never `appendCustomEntry`
  or a raw custom entry with a new customType; history is read through the neutral reader, never `parseLines` plus a switch on
  `entry.type`; wire additions use `SovaEvent`/`RowFacts`, and `src/` never branches on pi entry or
  event names. A new Sova agent feature is never a new pi-config extension and never a new call to
  an extension's command handler; existing extensions are grandfathered, and the pi-config files
  the server imports stay pi-free (the import ratchet covers them). (§app.harness/new-work)
- History is `HEntry`s (`shared/harness-history.ts`) from `server/harness/pi/reader.ts`
  (`readBranch`, `parsePi` + `branchOf`, the line scanners, `ctx.branch()`, `liveRead`), rows from
  `rowsOf(history)`. `parseLines`/`activeBranch`/`readActiveBranch` and `rawOf` are adapter-internal:
  outside it they are counted raw reads, and none is left outside the v1 shim (§app.harness/reader).
  State is read through a `StateView` (`stateView(history)`, `ToolCtx.state()`), never a fold over raw entries.
- Paths under the agent directory come from `agentRoot()` (`server/state-root.ts`), never
  `getAgentDir` (§app.harness/agent-root). A Sova tool is a `ToolSpec` (`shared/harness-tools.ts`);
  register it with `toPiTool`, read pi's context in a Sova hook only through `toolCtx(ctx)` (a
  `HookCtx`), and hand a pi tool to Sova code with `fromPiTool` (`server/harness/pi/tools.ts`,
  §app.harness/tools).
- A test that pins pi behaviour lives in `server/harness/pi/` (`contract.test.ts`), imports pi only
  through `server/harness/pi/testing/load-pi.ts`, and runs against another pi with
  `PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" pnpm test --
  server/harness/pi/contract.test.ts` (run it on every pin bump and TUI pi upgrade);
  `server/harness/**/*.test.ts` is in the runner's GLOBS.

## Conventions

TS strict, ESM, no new dependencies without asking. Server normalizes JSONL entries into
`TranscriptItem`; frontend renders those, and renders live streaming from `SovaEvent`s (it asks for
`wire=2`; `shared/wire-v1.ts` maps an older server's v1 frames and rows). `src/` never branches on pi
event or entry names, and wire additions use `SovaEvent`/`RowFacts` (`shared/harness-wire.ts`).
Frontend is SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.

- Never keep secrets or machine-specific details in the repo (it is public): no keys, tokens, real IPs, hostnames, tailnet names, device IDs or home paths in code, scripts, tests, docs or commit messages. Read them from a gitignored env file (e.g. `local.env`, with a committed `local.env.example` of placeholders); when you create one, tell the user so they can fill it in.

## Backend notes (SDK surprises, pi 1.0.3)

- `SessionManager.open(path)` is NOT read-only: `loadEntriesFromFile` appends `"\n"` to a trailing
  partial line (`dist/core/session-manager.js:367`) and `_rewriteFile()` (`:754`) rewrites the whole
  file when migrating old versions (`:722`). Never call it on a file a TUI may own —
  transcript/watch use our own parser (`server/harness/pi/reader.ts`); `open()` only for webapp-owned chats.
- `SessionManager.create(cwd)` defers writing the file until the first user or assistant message
  (`_persist()`/`_hasConversation()`, `dist/core/session-manager.js:791-800`, since 0.99.0; through 0.87.1
  it waited for the first assistant reply; quirk P11).
  `POST /api/sessions` writes the header line itself so the new session exists on disk immediately.
- pi's `theme` singleton is not re-exported from the package entry (`dist/index.d.ts` exports
  `initTheme`/`Theme` only, though `theme` exists on `modes/interactive/theme/theme.ts`). The
  ExtensionUIContext bridge (`currentTheme`, `server/harness/pi/ui-bridge.ts`, quirk P17) calls `initTheme()` and reads
  `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` — same key pi sets in
  `dist/modes/interactive/theme/theme.js:524`. It asks for `"dark"`: pi 1.0 (0.99.0) defaults
  `initTheme()` to `system` (the terminal's ANSI palette), and its `dark` is 0.99.0's revised palette.
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
  both from the transcript (their `system` and `usage-record` kinds give no rows, `server/transcript.ts` `entryRows`) and never counts them: a cache
  warm's spend is the usage ledger's record, written when the warm call ends (llm-inflight `runtime.ts`). They never move context
  fill: `contextForBranch` reads assistant-message usage only (`messageContextTokens`,
  `server/harness/pi/usage.ts`).
  `compaction` entries also gained a `systemMessage` field (additive; we ignore it).
- **`steer()`/`followUp()` now run extension `input` handlers** (`source` defaults to `"interactive"`,
  `dist/core/agent-session.js` `_queueUserInput`); on 0.85.1 they bypassed them entirely
  (0.85.1 `steer()` went straight to `_queueSteer`). Narrow blast radius: `prompt()` ALREADY ran them
  on 0.85.1 (`agent-session.js:842`), and `ChatSession.handOffQueued` (`server/chat-manager.ts`) only
  calls `harness.steer()` while streaming, for a steer item whose text is not a `/command` — every other web
  send goes through `harness.send()` (pi's `prompt()`). So
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
  While holding a runtime, `ForeignWriteGuard` checks appended lines carry ids our session knows (`harness.hasEntry`);
  any foreign line → busy on every prompt/steer until a `&force=1` reconnect reloads the runtime from disk.
  TUI-live sessions stay refused even with force.
- `SessionSummary.origin`: ids of sessions spawned via `POST /api/sessions` persist in
  `~/.pi/agent/sova/web-sessions.json` (`server/web-sessions.ts`); everything else is "external".
  Writes re-read + merge (safe with several servers); reads use the startup copy plus this
  server's own adds, so ids another running server adds show as "web" here only after a restart.
- Opening a chat runtime must not write: the SDK appends model_change/thinking_level_change at
  construction (empty sessions, or no thinking entry on the branch — `dist/core/sdk.js:281-289`,
  the same appends since 0.85.1). `openPiSession` (`server/harness/pi/open.ts`, quirk P1) defers those two
  appends and the chat replays them right before its first write (`ChatSession.flushDeferredAppends`);
  a never-prompted session stays untouched.
- Images: 1.0.3 `ImageContent` is still `{type:"image", data, mimeType}` (pi-ai `dist/types.d.ts:277`)
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
  seed does exactly that (`seedBtwSession`), and so does the chat's `enterQueued` through
  `HarnessSession.appendUserMessage`/`refreshContext` (quirk P6). Sova assigns it nowhere.
- pi 0.87.0 `context_edit` entries (`ContextEditEntry`, `session-manager.d.ts`: `targetId`,
  `replacement: {content} | null`) change what an earlier entry sends the model, never raw history.
  pi writes one ITSELF on every auto-retry and overflow recovery (`_omitRecoveryAttempt`,
  `agent-session.js:667`, emitted as `entry_appended`), so webapp-owned sessions get them. The
  transcript renders nothing for them (`entryRows`, `server/transcript.ts`) and the edited message keeps its row;
  `contextForBranch` does not treat one as staleness (pi's own accounting does: usage before a later
  edit is not the context size) — in practice pi's only trailing edit is followed by a retry reply
  or a compaction, both of which already reset the fill.
- pi 0.87.0 defers a `prompt()` made while `agent_settled` is being emitted (session listeners
  included, `agent-session.js:531-553`): it resolves at once, and its turn runs inside the
  PREVIOUS `prompt()`'s promise, whose rejection then carries the deferred turn's error. An item
  still held when the queue wakes on `agent_settled` is handed off synchronously inside that window,
  so its turn takes this path (quirk P5): it still starts, and its failure surfaces through the previous
  call's failure handling, which every `harness.send()` call site in `server/chat-manager.ts` attaches
  (`.catch`, or the returned `turn`). Topic batches (`server/topic-delivery.ts`,
  `ChatSession.deliverTopicBatch`) stay out of that window on purpose: a settle only schedules a
  drain on a timer, after the web queue's own hand-off, and a batch counts as delivered at its user
  entry's `message_end` (the `sova-topic-delivered` marker), never when its `prompt()` resolves.
- `Agent.peekQueuedMessages()` exists from 0.87.0 (pi-agent-core `agent.d.ts:102`) but Sova's queue
  deliberately does not use it; `server/chat-queue-clients.test.ts` pins its presence.
- pi 1.0 `PromptOptions.preflightResult` gets a disposition, `"started" | "queued" | "handled"`
  (`PromptDisposition`), not a boolean, and a refused prompt (already processing, compaction, no model or
  auth) gets no call at all; through 0.87.1 it was `preflightResult(false)`. The adapter drops the
  disposition: `SendOptions.onAccepted` stays `() => void` (quirk P15).
- pi 1.0 `steer()`/`followUp()` resolve to a `QueuedInputDisposition` (`"queued" | "handled"`,
  `agent-session.js:1680`); `PiHarnessSession.steer` drops it and stays `Promise<void>`.
- pi 1.0's built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:mcp`,
  `builtin:llama.cpp`, `dist/extensions/index.js`) load only in the CLI (`dist/main.js` adds them);
  SDK runtimes such as Sova's do not get them (docs/sdk.md "codemode-mcp"), so no MCP,
  tool_search or llama.cpp provider in webapp-owned sessions unless Sova adds the factories. Sova adds
  one: codemode (`server/harness/pi/codemode.ts`, in `DEFAULT_EXTENSION_FACTORIES`, quirk P21), registered
  inactive and switched by the mode extension's `codemode` minor mode (§chat.mode-menu/codemode), the
  same in Claude Code chats (off: nowhere in the loadout; a toggle restarts the CLI). Its scripts run in a `node:worker_threads` Worker with QuickJS; nested calls carry `parentToolCallId`
  (`HarnessEvent` `nested`, `SovaEvent` `parentCallId`) and are no rows or live tools.
