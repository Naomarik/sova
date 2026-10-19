---
watches: ["scripts/run-tests.mjs", "scripts/test-tier-guard.mjs", "scripts/test-changed.mjs", "scripts/test-sentinel.mjs", "scripts/hermetic-agent-dir.mjs", "pi-config/extensions/claude-code/tests/hermetic-env.mjs", "server/test-scratch.ts"]
alsoUpdate: ["agents/testing/overview.md"]
---
# Testing

Sova's two test tiers, the one runner that holds the file list, the tier guard, the hermetic test
environment every runner starts in, and the hermetic dev server.

## What lives here, and its docs

- `scripts/run-tests.mjs`: the runner (`pnpm test`, `pnpm test:int`, `pnpm test:all`, the project's
  `test.run`); its header comment documents the runner in full. GLOBS there is the file list.
- `scripts/test-tier-guard.mjs`: the tier guard, the runner's second preload.
- `scripts/test-changed.mjs`: the `--changed` selection.
- `pi-config/extensions/claude-code/tests/hermetic-env.mjs`: the throwaway-home preload.
- `scripts/test-sentinel.mjs`, `server/test-scratch.ts` (`scratchRoot`).
- `scripts/hermetic-agent-dir.mjs`: builds the hermetic `.agent` for `pnpm run dev:hermetic`.
- Spec: §app.server-runtime/test-tiers, §app.server-runtime/test-repo-fence.
- Related guides: Bun runtime [agents/server/overview.md](../server/overview.md); the fake `claude`
  CLI, Claude login fixtures and the multi-host pool run
  [agents/extensions/claude-code/overview.md](../extensions/claude-code/overview.md); pi-config's own
  per-extension tests [agents/extensions/overview.md](../extensions/overview.md); the spec tools'
  tests and replay [agents/modes/spec/overview.md](../modes/spec/overview.md); browser work
  [agents/frontend/overview.md](../frontend/overview.md).

## Rules and contracts

### Two tiers, by file name (§app.server-runtime/test-tiers)

- `pnpm test`, the **unit tier**: every `*.test.ts` the runner's GLOBS match except
  `*.integration.test.ts`. In-process only: git is fine (Sova's org store is a repository), but no
  other program, no socket (TCP or unix), no http(s) fetch, no import of `server/index.ts`. Run it
  constantly while working; it must stay fast and never depend on wall-clock speed.
- `pnpm test:int`, the **integration tier**: `*.integration.test.ts` (a sibling beside the unit file it
  splits from): real processes, ports, the whole server, time measured. Runs at a quarter of the cores
  (`TEST_INT_JOBS=<n>`), with its own durations (`.cache/test-durations-integration.json`). While
  working run `pnpm test:int --changed` before asking to land: files whose relative-import closure
  holds a file changed since the merge base with `--base <rev>` (default master), committed or not,
  plus files in a changed file's folder. The merge round runs the whole tier at landing, after
  `pnpm test`. `pnpm test:all` runs both tiers. Named files run whatever their tier.
- The tier guard records what each file starts, binds, connects to, fetches and whether it imports
  `server/index.ts` (`.cache/test-audit.json`); in a unit file it refuses any of it but git and fails
  the file ("rename to .integration.test.ts"), listing those files after the run.
  `SOVA_TEST_GUARD=report` only lists them; `=off` turns it off. A test that needs one real thing:
  split those cases into the `.integration.test.ts` sibling, keep the logic in the unit file.
- Every test file under `server/`, `shared/` or `src/` must match a glob in `scripts/run-tests.mjs`,
  and only `*.integration.test.ts` may name itself an integration test (the harness boundary test
  enforces both; [agents/server/harness/overview.md](../server/harness/overview.md)).

### The runner, on Bun

- The summary line reads `run-tests (bun): …`. `*.browser.test.ts` files need Solid's browser build
  and run in a second pass with `--conditions=browser`; `pnpm test -- <files>` runs only those, each
  routed to its pass. On Bun it runs files longest first by the times recorded last in the worktree's
  gitignored `.cache/test-durations.json`, and ends with the 10 slowest.
- Verify your work with `pnpm test` and `pnpm run dev:hermetic`, which are Bun, the runtime the user
  runs; never switch to Node unless the user asks. Node only on request: `pnpm run test:node`
  (`--runtime node`, `tsx --test`; plain `node --test <file>` fails with ERR_MODULE_NOT_FOUND on the
  extensionless imports) or `SOVA_RUNTIME=node pnpm test`; an explicit `--runtime` wins. No Bun found:
  the runner exits 2 naming `pnpm run test:node`, never a quiet Node pass. `pnpm run test:bun` is kept
  as an explicit Bun alias.
- Tests run on Bun only through the runner (`pnpm test`, `test:int`): it sets HOME before bun starts
  (Bun's `os.homedir()` ignores an in-process change), puts the real node and `mise bin-paths` first
  on PATH (shims refuse in a throwaway HOME; tests spawn `node` and `python3`), and sets
  `SOVA_PRICES_FETCH=off`. `bun test` itself runs with TZ=UTC and NODE_ENV=test, unlike `node --test`.
- **No real Claude.** On both runtimes the runner puts a stand-in `claude` (`scripts/fake-claude.mjs`)
  first on every test process's PATH: code under test resolves the Claude program from PATH, and the
  inherited one holds the installed CLI (a paid model). A test that needs another `claude` sets its
  own PATH. A unit file whose in-process chats load this tree's pi-config extensions links them with
  `linkPiConfigExtensions` (`server/testing/agent-dir.ts`), never a bare symlink: its
  `topic-outline.json` runs the outline's check at once after each turn and never calls a summarizer
  model on its own. A bare link left topic-outline's 3 s debounce, so a file still running 3 s after
  a turn spawned `claude` (a tier-guard failure only on slow runs). `server/outline-no-claude.test.ts`
  proves both.

### The hermetic test environment

- Every test runner starts in a throwaway home (`hermetic-env.mjs`: `pnpm test` loads it with
  `--import`, the extension runners import it first). A session that itself runs on an added Claude
  login passes that login's directory down as `CLAUDE_CONFIG_DIR`, and tests falling back to the host's
  agent dir once wrote leases into it. A new runner imports it too.
  `node scripts/test-sentinel.mjs -- <cmd>` runs a suite against a sentinel HOME / agent dir / login dir
  and fails if anything there changed.
- The same preload stops git's repository search at the temp dir (`GIT_CEILING_DIRECTORIES`) and drops
  `GIT_DIR`-like variables, and `pnpm test` exits 2 when its temp dir is inside any git repository:
  tests register plain temp folders as projects, and a `TMPDIR` inside a worktree once made them Sova's
  own checkout, so tests committed promotions on master and cut `sova/*` worktrees
  (§app.server-runtime/test-repo-fence). A test that needs a plain folder makes its temp root with
  `scratchRoot` (`server/test-scratch.ts`); one that needs a repository runs `git init` under it.

### Tour recording tests (real Chrome)

- `server/tours/*.integration.test.ts` drive a real Chrome or Chromium through `playwright-core`: one
  found on PATH (`chromium`, `google-chrome-stable`, …) or named by `SOVA_TOUR_BROWSER`; nothing is
  ever downloaded. They don't skip when none is installed: they fail.
- Chrome puts named Unix sockets under `TMPDIR`, and `assertTourBrowserTempPath`
  (`server/tours/browser.ts`) refuses a base whose socket path would pass 100 bytes. Run them with a
  short temp dir outside any repository, e.g. `TMPDIR=/dev/shm/q` (create it first); a sandboxed
  session's long `TMPDIR` fails them.
- The runner kills any one file after 300 s (`TEST_FILE_LIMIT_MS`), the per-file cap, under the
  integration tier's load too. Each browser launch costs seconds: split a growing Chrome file by
  scenario (as `runner-signin`, `-landed` and `-inplace` are) rather than raising its test timeouts.
- Shared stand-in sites and probes are `*.integration.fixture.ts` beside the tests (not test files, so
  no glob matches them). Test credentials are short fakes (`fake-pw-01`): the merge round's leak scan
  flags any `password`/`token`/`secret`/`apiKey` assigned a literal of 16+ characters with no space. A test that needs
  a long value builds it at runtime (`"x".repeat(17)`, `"fake-copy-token".padEnd(48, "x")`).

### The hermetic dev server (`pnpm run dev:hermetic`)

- Once `.agent` holds copies of real sessions (or `--copied-sessions` announces them), the script
  leaves out the wake-nudge extension and blanks the copied scheduler state, so no copied nudge or
  schedule fires; the mode is sticky (`.agent/copied-sessions.json`).
- Gaps: 4810 by default, one server per port (`SOVA_PORT` for a second), and a symlinked
  `node_modules` can break `pnpm run` in a worktree.
- Claude logins in a hermetic run (fake `claude`, `SOVA_CLAUDE_ACCOUNTS_DEV`, the pool e2e):
  [agents/extensions/claude-code/overview.md](../extensions/claude-code/overview.md).

## When you change X, also update Y

| You change | Also |
| --- | --- |
| add a test file in a new folder | a glob in `scripts/run-tests.mjs` GLOBS (the boundary test fails otherwise) |
| a unit test needs a process, port or fetch | split those cases into the `.integration.test.ts` sibling |
| add a test runner | import `hermetic-env.mjs` first |
| a unit file's chats need pi-config's extensions | `linkPiConfigExtensions(agentDir)` from `server/testing/agent-dir.ts` |
| the runner, tier guard or preload | the runner's header comment, this guide, and §app.server-runtime/test-tiers or /test-repo-fence through a spec draft |

While working: `pnpm test` constantly, `pnpm test:int --changed` before asking to land. Landing (the
merge round) runs `pnpm test`, then the whole integration tier.
