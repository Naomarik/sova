# Recipes for common stacks

Each moves one literal to a per-copy value while slot 0 keeps today's. Check each against the
project: these are starting points, and conformance is the proof.

## Ports the app reads
- **Node**: `const port = Number(process.env.PORT ?? 3000)`.
- **Clojure, aero** (`#profile`, `#env`): `#or [#env PORT 4000]`, and for a URL
  `#or [#env DATOMIC_URL "datomic:dev://localhost:4334/app?password=…"]` inside the `:dev` branch of
  `#profile` only.
- **Clojure, a literal map** (`{:port 6375}`): `(or (some-> (System/getenv "REDIS_PORT") parse-long) 6375)`.
- **Python**: `int(os.environ.get("PORT", "8000"))`. **Ruby**: `Integer(ENV.fetch("PORT", "3000"))`.

## Ports a tool takes on its command line
- **nREPL** (`-m nrepl.cmdline --port 7850` in a deps.edn alias): append `"--port",
  "${ports.<svc>.nrepl}"` to the service's `cmd`; a later `--port` wins, so deps.edn is unchanged.
- **shadow-cljs**: its nREPL, HTTP and devtools ports live in `shadow-cljs.edn`
  (`:nrepl {:port 9100}`, `:http {:port 9630}`, `:devtools {:http-port 8020}`). Read them with
  `#shadow/env ["SHADOW_NREPL_PORT" :as :int :default 9100]` and set the env in the service.
- **Vite**: `["vite", "--port", "${ports.web.http}", "--strictPort"]`.
- **Redis**: `["redis-server", "--port", "${ports.redis.port}", "--dir", "${data.redis}"]`.

## Dependencies before a service starts
A JVM or Node service that fetches its dependencies at start (Clojure CLI, `npx`, a cold `~/.m2`)
spends part of its readiness wait downloading: the first confined run starts with empty caches
(Sova points Maven at its proxy itself). Usually a generous `ready.timeout` is enough. When the
fetch is long, add a `setup` step that only fetches (`clojure -P -M:<aliases>`, `npm ci
--ignore-scripts`), with `inputs` the dependency files and a long `timeout` (up to 1800): setup
runs at create, before any service starts, in its own unit with its own log. A service's `build`
does not help here: it runs only at `apply`, when its inputs change. Git dependencies
(`:git/sha`) resolve only when the host's `~/.gitlibs` already has them; a confined run can't add
them.

## Datastores as a process per copy
- **Datomic dev transactor**: a `.sova/bin/transactor` wrapper copies the project's dev
  properties file (passwords included, as the project tracks them), overrides `port=`, and
  appends `h2-port=`, `h2-web-port=`, `data-dir=` and `log-dir=` from `SOVA_PORT_*` and the data
  resource, writes it under `$SOVA_DATA`, then `cd`s to the Datomic distribution and execs
  `bin/transactor <file>`. Keep the storage port at the transactor port + 1 (declare both with
  the same stride, bases 1 apart): peers derive storage from the transactor's port. Its data:
  `{kind: "dir", from: "${main}/<distribution>/data"}`. A Datomic distribution that is gitignored
  in the main checkout is read from `${main}/…`, never copied per copy. Peers connect with the
  copy's `datomic:dev://localhost:${ports.db.port}/<db>?password=<the properties' datomic password>`.
- **Postgres per copy**: `initdb` in a setup step or data hook into `${data.pg}`, then
  `["postgres", "-D", "${data.pg}", "-p", "${ports.pg.port}", "-k", "${data.pg}"]`.
- **SQLite**: a dir resource copied from main's file's folder, and the app reads the path from env.

## Silencing outbound sends (any `sensitive` data)
One small module the app's senders call instead of their transport: `silenced?` reads
`SOVA_SILENCE_OUTBOUND` (unset, empty or `0`: send as today; anything else: silenced) and, for
tests, a dynamic override. Each wrapper (`http-post`, `postal-send`, a shell call to a push CLI, a
bot client's request) returns the transport's success shape with a marker when silenced, so
callers keep working. Wrap at the lowest call that leaves the host, not at the feature level, and
grep afterwards that no direct transport call is left outside the module (comments aside). An
asynchronous sender (an agent, a queue worker) must check the switch when it runs, not only when
it enqueues: Clojure's `send-off` conveys dynamic bindings, so a test's override reaches it.
The test: one test asserts `silenced?` whenever `SOVA_SLOT` is set and not 0; another binds the
override, replaces every transport with one that throws, and calls each send function with
made-up recipients that pass the app's own validation (a fresh address per run when the app
rate-limits). Put it first in `smoke`. The definition: `"SOVA_SILENCE_OUTBOUND": "${slot}"` in
every service's `env`, and the module in `sources`.

## Local config a fresh worktree lacks
A gitignored file the tasks read (`.locals.edn`, `.env`) is copied from the main checkout by a
setup step: `.sova/bin/setup` runs `cp -n "$SOVA_MAIN/.locals.edn" "$SOVA_CHECKOUT/"`. Copy, never
commit, and never print its contents. If it names paths, check they are relative or point into
the main checkout read-only.

## Generated files the code reads
A gitignored file that a task generates and the code reads at load time (a `ver` file a macro
slurps, a compiled CSS the server requires) makes a fresh worktree fail to load. `inspect` lists
gitignored paths a task or config names: for each, find who writes it and add a setup step that
writes it (`git rev-parse --short HEAD > ver`), never a copy of main's.

## Test runners that write `SOVA_OUT`
First check the project's own test command works **at HEAD** in a fresh worktree: the main
checkout's uncommitted edits (a new deps.edn alias, a fixed classpath) are often what makes it
work there. If it doesn't, the adapter adds what is missing (an alias with the paths the tests
load) and the report says so. Tests that start the app's own system (`(user/load-profile :dev)`,
a test server on the app's port) need the test service to get the same per-copy env as the app
(ports, datastore URLs) and the datastores in `test.requires`; otherwise they hit slot 0's.
A test profile with its own fixed port (aero `#profile {:test 4002}`) collides between copies:
read it from env too. A smoke run that counts no test proves nothing (the template treats it as an
error).
Clojure aliases: the last alias's `:main-opts` win (`-M:test:test-repl` runs `:test-repl`'s), and
`-A:alias` still applies its `:main-opts`.

`templates/nrepl-test.bb` is a ready `.sova/bin/test` for a warm Clojure test nREPL: copy it with
`templates/bb.edn` beside it (an empty config, so bb never resolves the project's own `bb.edn`
`:deps`, which writes under your home and fails in a confined run), set its `PORT_ENV` and
`TEST_DIRS`, and `chmod +x` it. A script a hook runs should write only inside the checkout, its
data dir or /tmp: a confined run sees the rest of your home read-only.

- **Clojure, warm**: an on-demand `test-repl` service (with `reload: "restart"`, so `apply`
  restarts it on source changes) (`clojure -M:test:<repl alias> --port
  ${ports.test-repl.nrepl}` or `-M:test -m nrepl.cmdline …`), and `.sova/bin/test` that sends
  `(cognitect.test-runner.api/test {:nses [...]})` (or `clojure.test/run-tests`) over nREPL to
  `$SOVA_PORT_TEST_REPL_NREPL` with the selectors from its arguments, and writes
  `{"passed", "failed", "errors"}` from the returned summary to `$SOVA_OUT`. `clj-nrepl-eval -p
  <port> '<form>'` is the simplest client when installed; else `bb` with `bencode`.
- **Clojure, cold**: `clojure -M:test -n <ns>` per selector; counts from its "Ran N tests…
  F failures, E errors" line.
- **Node**: `node --test <files>` (or vitest/jest with `--reporter json`); count from the
  reporter's summary.
Pick `smoke`: one or two fast namespaces or files that need no network, no browser and no
production data, and pass on main.
