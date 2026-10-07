# §app/server-runtime — The server's runtime: Bun, or Node on request

Sova's server runs on Bun. It runs on Node only when the operator asks for it explicitly
(§app.server-runtime/choice), and the test suite, both its tiers, follows the same switch. A launcher starts the
server on that runtime; when Bun is wanted but missing or the server fails to start on it, that is
an error, never a quiet start on Node (§app.server-runtime/fallback). The server says which
runtime it is on in `GET /api/health` (§app.server-runtime/health). There is no picker in Settings
and no setting file: the operator sets the environment or the launcher's option, and the change
takes effect at the server's next start.

## §app.server-runtime/choice — Choosing Node

- The runtime is Node only when `SOVA_RUNTIME=node` is in the environment or the launcher is
  started with `--node`. Anything else (unset, `bun`, any other value) means Bun. No file is read:
  a `<state root>/runtime.json` left from earlier versions is ignored.
- `scripts/start-server.sh [--node] [server arguments]` is the launcher: from the repository root it
  execs `bun server/index.ts` or, for Node, `node --import tsx server/index.ts` in place, so the
  server is the launcher's own process (a service manager's main pid stays the server's). A
  leading `--node` is taken by the launcher and the server gets `SOVA_RUNTIME=node`, so it and
  what it starts see the same choice. `pnpm start` runs the launcher.
- `pnpm run dev:server` (the gated watcher) and `pnpm run dev:hermetic` follow the same choice:
  each (re)start spawns `bun server/index.ts`, or the Node command when Node is asked for.
  `pnpm run dev:hermetic:node` is the hermetic server on Node.
- The test suite follows it too: `pnpm test`, `pnpm test:int`, `pnpm test:all`
  (§app.server-runtime/test-tiers) and the project's test verb run on Bun, and on Node with
  `SOVA_RUNTIME=node` or through `pnpm run test:node`. The runner's own `--runtime node|bun`
  wins over the environment; `pnpm run test:bun` runs Bun whatever the environment says.
- The Bun binary is `$SOVA_BUN` when set, else `bun` on `PATH`, else what `mise which bun`
  answers. The Node binary the launcher uses is `$SOVA_NODE`, else `node` on `PATH`.

## §app.server-runtime/fallback — No fallback to Node

When Bun is wanted and no Bun binary is found (or `$SOVA_BUN` names one that is missing or not
executable), the launcher and the dev watcher print one line on stderr naming the reason and how
to ask for Node (`SOVA_RUNTIME=node` or `--node`), and exit with an error; nothing starts. The unit
test runner does the same, exiting 2 with one line that names `pnpm run test:node`, before any test
file runs. A Bun server that fails to start fails like any other: nothing counts its boots and
nothing switches to Node, and no `runtime-fallback.json` or `runtime-bun-boots` file is written.

## §app.server-runtime/health — The runtime in /api/health

`GET /api/health` adds `runtime: {name, version, chosen}` to its answer
(§chat.profiles/live-commit): `name` is the runtime this process runs on (`"bun"` when
`process.versions.bun` is set, else `"node"`), `version` that runtime's version, `chosen` the
runtime the choice asks for (`"node"` when its environment has `SOVA_RUNTIME=node`, else `"bun"`),
read once at start. The answer's other fields, `unknownEntries` among them (a number only, never an
entry's type or content: the route needs no sign-in), are §chat.profiles/live-commit's.

## §app.server-runtime/quirks — Runtime differences, worked around in one place

Where Bun behaves differently from Node in a way Sova depends on, the workaround lives in
`server/runtime-quirks.ts`. It detects the broken behaviour, never the runtime's name or version, and
no call site names a runtime. `docs/bun-quirks.md` lists every quirk with the Bun version, the
upstream issue, the workaround and a canary test, which runs under Bun only and fails once Bun
fixes the bug.

- **WebSocket size caps hold on both runtimes.** Every WebSocket the server accepts or dials is built
  through the capped factories. The first message over a socket's `maxPayload` (ws's 100 MiB when
  none is named) closes it with 1009, or ends a share hop as lost, and no listener sees that
  message or any after it.
- **A WebSocket's handshake timeout holds on both.** A dialed socket whose peer never answers the
  upgrade errors ("Opening handshake has timed out") and closes once, after its `handshakeTimeout`.
- **A stopped stream stops as soon on both.** Provider response bodies are read at most 64 KiB at a
  time, Node's own read size, with every byte unchanged, and no read follows an abort. So the
  runaway-stream guard's stop (§chat.transcript/runaway-stream) costs about the same on Bun as on
  Node. Google adapters, which refuse a custom fetch, read as their runtime does.
- **The event-loop delay reads the same on both.** See §app.resource-monitor/lightness-budget.
- **A refused connection is named "connection refused" on both.** The error is classified by its
  code (its own or its cause's), never by its message.
- **Imports are unambiguous.** No two module files or directories in one folder of `src/`,
  `server/`, `shared/` or `pi-config/extensions/` differ only by case once the extension is
  dropped; a repo test enforces it.
- **The test suite runs on Bun** through `pnpm test` and `pnpm test:int` (§app.server-runtime/choice). Each test file runs in its own
  process with a throwaway home set in the environment before Bun starts. The test preload refuses
  to run where `os.homedir()` doesn't follow the HOME it set.

## §app.server-runtime/test-repo-fence — Tests never reach a repository they didn't create

A test may commit, branch or add worktrees only in a repository it made itself. A plain folder a
test makes in its temp dir stays plain: Git never finds an enclosing repository from it, so a
project registered there is that folder, not the checkout around it.

- **The runner refuses a temp dir inside a repository.** `pnpm test`, `pnpm test:int` and
  `pnpm test:all` (`scripts/run-tests.mjs`, on either runtime, either tier) exit 2 before running anything when the folder its temp roots go in (`TMPDIR`
  on Bun, `/tmp` on Node) is inside a Git work tree or Git directory, with one line naming that
  repository and the fix: a `TMPDIR` outside every repository.
- **Discovery stops at the temp root.** Every test process (`pnpm test`'s and each extension
  runner's, through the shared preload) has `GIT_CEILING_DIRECTORIES` set to its temp dir and the
  folder above it, and none of the variables that point Git at a repository (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`), so Git started from a test's
  temp folder never looks above it, whatever `TMPDIR` the run inherited.
- **A suite test proves both** against a scratch repository with a linked worktree, `TMPDIR` inside
  the worktree: the runner's refusal, given the files that once leaked, leaves the repository's
  refs, worktrees and files as they were; and a folder made under the preload's temp root
  registers as itself, not as the repository's main checkout.

## §app.server-runtime/test-tiers — Two test tiers: in-process unit tests, and integration tests

The suite has two tiers, told apart by file name alone, so a file's tier can't drift from a list.

- **The unit tier** is every test file the runner's patterns match except `*.integration.test.ts`:
  in-process tests. They may run Git (Sova's own org store is a Git repository), but no other
  program, no socket (bound or connected, TCP or unix), no network fetch, and they never import
  `server/index.ts`. `pnpm test` runs this tier; it is the everyday run.
- **The integration tier** is `*.integration.test.ts`, a sibling beside the unit file it splits
  from: real processes, ports, the whole server, and time measured. `pnpm test:int` runs it, at a
  quarter of the cores (`TEST_INT_JOBS=<n>` sets the width; the unit tier's is `TEST_BUN_JOBS`),
  longest first by its own recorded times (`.cache/test-durations-integration.json`, beside the
  unit tier's `.cache/test-durations.json`). `pnpm test:all` runs both tiers, unit first, each at
  its own width. Files named on the command line run whatever their tier.
- **`pnpm test:int --changed`** runs only the integration files a change may break: those whose
  import closure (relative imports, followed file to file) holds a file changed since the merge
  base with `--base <rev>` (default `master`), committed, uncommitted or untracked, and those in the
  same folder as a changed file. It prints how many files it chose of how many; when it chooses
  none it runs nothing and exits 0. An agent runs it before asking to land; landing runs the whole
  tier (§chat.merge-round/driver).
- **The tier guard.** A second test preload (`scripts/test-tier-guard.mjs`) records, for each file
  in either tier, the programs it starts, the addresses it listens on or connects to, the URLs it
  fetches and whether it imports `server/index.ts`, merged into `.cache/test-audit.json`. After the
  run, the runner lists each unit file that did any of these except run Git. With
  `SOVA_TEST_GUARD=enforce` the guard refuses the call itself, with an error naming the file and
  telling to rename it (or split those cases into) `.integration.test.ts`, and the runner fails
  the file even when the error was caught; `SOVA_TEST_GUARD=off` turns the guard off.
  `server/tier-guard.test.ts` proves each refusal on both runtimes: an ESM named-import `spawn`,
  `execFileSync`, `net.connect`, `http.createServer().listen`, a `fetch` to localhost (and Bun's
  `Bun.connect`, `Bun.spawn`, `Bun.serve`), and a dynamic import of `server/index.ts`.
