# Investigating any project

You find out how this project is built, checked, released and shipped from its own files, measure
what you'll propose in your own copy, and ask the user only what the files can't tell. Never assume a
stack, a host or a habit: a project with a `package.json` may ship a Go binary, a Python repo may
deploy with Ansible, a "static site" may have a backend in a sibling folder. Every candidate is an
offer until the user confirms it or you measured it.

## Read in this order

1. **The digest**: `node scripts/project-setup.mjs investigate` (every ecosystem's markers, task
   runners, CI commands, lockfiles, monorepo/Nix/container markers, hosting files, release material,
   remotes, the setup at HEAD). Then `node ../project-verbs/scripts/project-verbs.mjs inspect` when
   services matter (ports, datastores, gitignored files a fresh copy lacks).
2. **The project's own words**: `README*`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, `docs/`
   (development, testing, deploying, releasing pages), `Makefile`/task runner help texts. A rule the
   project states ("never deploy from a worktree", "the e2e suite needs a browser") outranks what you
   infer.
3. **CI** (`.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`, `azure-pipelines.yml`,
   `bitbucket-pipelines.yml`, `.buildkite/`, `.woodpecker.yml`, `.drone.yml`): the commands the
   project already gates a change on are your best check candidates. Read the jobs that run on a pull
   request or a push to the main branch; leave out jobs that deploy, publish, sign or release (those
   are deploy and release material, read them for that), and pick one row of a matrix (the newest
   runtime the project pins). A CI `services:` block (postgres, redis) is a service a check
   `requires`.
4. **The build and package manifests** (table below), their lockfiles and the toolchain pins
   (`mise.toml`, `.tool-versions`, `.nvmrc`, `rust-toolchain.toml`, `flake.nix`, `devbox.json`…).
5. **Git history**: `git log --oneline -30`, `git tag --sort=-creatordate | head`, `git log --merges`
   (how branches land today), `git branch -r` (a `gh-pages` or `release/*` branch).
6. **Release and deploy material**: version files, changelogs, release automation, deploy scripts,
   hosting files (`release-maker.mjs candidates` and `project-deploy.mjs candidates` quote them).
   Read each script's text; never run one. `targets.md` says what each kind of target needs.

Read files at HEAD in your worktree. The main checkout's uncommitted edits are not the project. Never
print a secret: read `.env`-like files with values masked (`sed 's/=.*/=…/'`), and never copy one
into the repository, a report or a message.

## Per ecosystem: install, checks, reruns

The **install** column is the offline, frozen form for `merge.install` (it runs only when a branch
changes a lockfile, in a copy whose dependency folders the previous run left). **Rerun** says whether
a check can take `rerun: true` (its failures name files and `run` + files reruns only them).

| Ecosystem (markers) | Install (frozen/offline) | Usual checks | Rerun |
|---|---|---|---|
| Node/TS: `package.json` + `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` | `npm ci --offline` · `pnpm install --frozen-lockfile --offline` · `yarn install --immutable` (Berry) / `--frozen-lockfile --offline` (v1) · `bun install --frozen-lockfile` | the package's `typecheck`/`lint`/`test`/`build` scripts; `tsc --noEmit`; `eslint .`; `vitest run`; `jest --ci`; `node --test`; `playwright test` | vitest, jest, node --test, mocha, playwright: yes |
| Deno: `deno.json` | `deno install --frozen` (cache) | `deno check`, `deno lint`, `deno fmt --check`, `deno test` | yes |
| Python: `pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`, `Pipfile.lock` | `uv sync --frozen --offline` · `poetry sync --no-root` (Poetry 2; 1.x: `poetry install --no-root --sync`) · `pip install --no-index --find-links …` (rarely offline-ready: ask) | `ruff check`, `ruff format --check`, `mypy`/`pyright`, `pytest -q`, `tox -e …`, `nox -s …`, `python manage.py test` | pytest: yes; unittest/manage.py: by module only |
| Go: `go.mod` | `go mod download` (network) or vendored (`-mod=vendor`) | `go vet ./...`, `gofmt -l .` (prints and exits 0: wrap it in a script that fails on output), `golangci-lint run`, `go test ./...`, `go build ./...` | by package, not file: leave off |
| Rust: `Cargo.toml`, `Cargo.lock` | `cargo fetch --locked` (network; `--offline` after a warm cache) | `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`, `cargo build --locked` | no |
| JVM: `pom.xml`/`mvnw`, `build.gradle(.kts)`/`gradlew`, `build.sbt` | `./mvnw -B dependency:go-offline` (network) · `./gradlew --offline …` (warm cache only) · `sbt update` | `./mvnw -B verify`, `./gradlew check`, `./gradlew test`, `sbt test` | by class with `-Dtest=` / `--tests`: only with a wrapper script |
| Clojure: `deps.edn`, `project.clj`, `bb.edn`, `shadow-cljs.edn` | `clojure -P -M:<aliases>` · `lein deps` · `npx shadow-cljs` deps via npm | `clj-kondo --lint src test`, `cljfmt check`, kaocha / cognitect test-runner, `bb <task>`; shadow-cljs `release` as a build | by namespace through a script; files: no |
| Ruby: `Gemfile`, `Gemfile.lock` | `bundle install --local` · `bundle config set deployment true` | `bundle exec rubocop`, `bundle exec rspec`, `bin/rails test`, `bundle exec rake` | rspec, rails test: yes |
| PHP: `composer.json`, `composer.lock` | `composer install --no-interaction --prefer-dist` (cache) | `vendor/bin/phpunit`, `vendor/bin/pest`, `vendor/bin/phpstan analyse`, `php artisan test`, `composer run <script>` | phpunit/pest: yes |
| .NET: `*.sln`, `*.csproj`, `global.json` | `dotnet restore --locked-mode` | `dotnet format --verify-no-changes`, `dotnet build --no-restore`, `dotnet test --no-build` | by filter only: leave off |
| Elixir: `mix.exs`, `mix.lock` | `mix deps.get` (network) | `mix format --check-formatted`, `mix compile --warnings-as-errors`, `mix credo`, `mix test` | `mix test <file>`: yes |
| Swift / iOS: `Package.swift`, `*.xcodeproj`, `Podfile` | `swift package resolve` · `pod install` | `swift build`, `swift test`, `xcodebuild test -scheme … -destination …` (macOS hosts only) | no |
| Android / Kotlin: `app/build.gradle*` | `./gradlew --offline` (warm cache) | `./gradlew lint testDebugUnitTest assembleDebug` | no |
| Flutter: `pubspec.yaml` | `flutter pub get --enforce-lockfile` | `dart format --set-exit-if-changed .`, `flutter analyze`, `flutter test` | `flutter test <file>`: yes |
| React Native / Expo: `app.json`, `eas.json`, `metro.config.js` | as Node | the JS checks; native builds are release/deploy material, not landing checks | as Node |
| C/C++: `CMakeLists.txt`, `meson.build` | (vendored or system packages: ask) | `cmake -B build && cmake --build build && ctest --test-dir build` through a `.sova/bin/` script | no |
| Static sites: Hugo, Jekyll, Astro, Eleventy, MkDocs, plain `index.html` | as their language | the build (`hugo --minify`, `astro build`, `mkdocs build --strict`), a link check | no |

Wherever a project already has a task runner (`make test`, `just check`, `task lint`, `bb test`,
`npm run …`, `composer run …`, `rake …`), prefer its task over the raw tool: it is what the project
maintains. Write a `.sova/bin/` wrapper only for what argv can't say (a `cd`, a pipeline, an env
line, writing `SOVA_OUT`, skipping when nothing relevant changed).

## Monorepos and big suites

Markers: `pnpm-workspace.yaml`, `package.json` `workspaces`, `turbo.json`, `nx.json`, `lerna.json`,
`rush.json`, `go.work`, a Cargo `[workspace]`, Gradle `settings.gradle`, Bazel (`MODULE.bazel`,
`WORKSPACE`), Pants. A full run of everything on every branch is often too slow. Options, in the
order to offer them:
- **Affected only**, from the merge base the queue passes: `turbo run test --filter=...[${merge.base}]`,
  `nx affected -t test --base=${merge.base} --head=HEAD`, `bazel test` over `bazel query` of the
  changed files, or a `.sova/bin/` script reading `$SOVA_MERGE_CHANGED`. It must exit 0 and write
  `{"passed": 0, "failed": 0, "skipped": "<why>"}` when nothing it covers changed.
- **One required check per package that changes often**, the rest optional with a blast-radius map
  (`.sova/playbooks/merge-queue/`) so the merge thread picks them by path.
- **Split a slow suite** into groups of under 30 minutes each (the hard limit), the slow groups
  optional and picked by path.
A release can run everything: `release.checks` are the place for the full suite.

## Containers, compose and Nix

- **Dockerfile** alone: the image build is a build check only when the project's CI builds it on
  every change; otherwise it is release/deploy material. A check that runs `docker build` needs
  docker in the merge copy's environment (the server's user): measure it there.
- **compose files**: each datastore in it (postgres, redis, mysql, mongo, elasticsearch, a queue, an
  S3 emulator) is a candidate service a check `requires`, run per copy (a process on the slot's
  ports, or a container with `container: {name}`; `../project-verbs/references/isolation.md`). Never
  `docker compose up` as a check.
- **Testcontainers** in the tests: they need a container engine on the host, nothing in the
  definition; say so and measure.
- **Nix** (`flake.nix`, `shell.nix`, `devenv.nix`, `devbox.json`, `.envrc` with `use flake`): checks
  run inside the dev shell: `["nix", "develop", "--command", "make", "test"]` (or `nix flake check`
  when the flake defines the checks). The first run is slow (a cold store): measure twice.
- **mise / asdf** pins: a fresh copy needs `mise trust` (a `setup` step) and units need
  `MISE_TRUSTED_CONFIG_PATHS`, as `../project-verbs/references/contract.md` "Toolchains" says.

## What a check needs at run time

Checks run in the merge copy with an allow-list environment (`definition.md`, "What a check sees"):
no secrets, no API keys, no chat variables, `${host.…}` empty. For each candidate, find out:
- **Services**: a database, cache, queue, search engine, browser, emulator. Provide each as a
  service of `services` (often `start: "on-demand"`) the check `requires`; use an in-memory or SQLite
  mode where the project already has one for tests.
- **Secrets**: a test that reads an API key. Either a `setup` step copies a gitignored local file
  (`.env.test`) from the main checkout into the copy (the user agrees, the file stays out of git), or
  the test isn't a landing check (mark it `live` / skip it in the check's selection), or the project
  stubs it. Never put a value in the definition.
- **Network**: a check that downloads at run time is slow and flaky; the install happens in
  `merge.install` (offline) or a `setup` step with `inputs`, never in the check.
- **Gitignored inputs**: a generated file, a compiled asset, a local config: a `setup` step makes it.

## Measuring in your own copy

Before you propose a check, run it in **your worktree**, never the main checkout:
1. `project_verbs {verb: "up"}` when it needs the project's services (your copy gets its own ports
   and data), or nothing when it needs none.
2. Run the command as the queue will (argv, from the worktree's root), with a clean environment to
   catch secret dependence: `env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 TMPDIR="${TMPDIR:-/tmp}" <argv>`.
   Time it: `start=$(date +%s); <argv>; echo "exit $? in $(( $(date +%s) - start ))s"`.
3. Run it **twice**: the first is cold (caches), the second is the steady time. A different result
   between them is a flaky check: say so, and don't make it required until the user decides.
4. Record per check: the exact argv, cold and warm time, exit, the counts it reports, what it needed
   (services, files, tools), whether it writes `SOVA_OUT`, and whether it is green on the target as
   it is today. `timeout` ≈ twice the warm time, at least 60, at most 1800.
5. A check that is red on the target today is the project's own red: propose it only with the user's
   word (it would hold every branch), or fix the cause on your branch when it is a setup problem
   (a missing setup step, a hard-coded port) and say so.
A command that writes outside the checkout, reaches the network beyond installing, or touches a
production system is never run, only read and asked about.

## What only the user can tell you

Ask (`questions.md`): who uses a release and how they get it; which branch is the real target; how
long a landing may take; whether a red-on-main test is known; whether the CI's deploy job is the real
deploy; where each target lives and how it's reached; credential names; what must never happen on a
target; how a bad deploy is undone. Never ask what a file or a command answers.
