# `.sova/project.json`, the contract

One JSON file at the checkout's root, `"version": 1`, parsed strictly: an unknown key, a wrong type,
a bad name, a dangling or cyclic `requires`, or an unknown template variable makes the whole file
invalid (`invalid-definition`, naming the JSON path of the first problem). Names are lowercase
letters, digits and hyphens, starting with a letter, at most 31 characters. Every command is an
**argv array** of non-empty strings, never a shell string: use `["sh", "-c", "…"]` only inside a
project script, never in the definition. `project-verbs.mjs check` parses it with Sova's own parser.

Canonical form (`project-verbs.mjs fmt`): 2-space JSON, keys in the order below, services, data,
ports and env in declaration order.

## Top level
| key | value |
|---|---|
| `version` | `1` |
| `slots` | `{cap}` (`cap`): instances besides the main checkout's, 1–16, default 4. Conformance uses slots cap+1 and cap+2 |
| `host` | names (`A-Z0-9_`) of host variables kept in Sova's state, read as `${host.NAME}`; never put their values in the repo |
| `sources` | the checkout files the definition was derived from (at most 50, relative, each once). Drift is a change to one of them at HEAD. Not hashed |
| `setup` | steps `{id, run, inputs?, timeout?}` run at create, in order; skipped while the rendered argv and the hash of `inputs` (checkout files) are unchanged |
| `data` | `{name: resource}` in declaration order, below |
| `services` | `{name: service}` in declaration order, at least one, below |
| `open` | `{endpoint, path?}`, below: the app's entry point, where a person opens it. Required for every project with a page; absent only for a library or an API-only project. Not hashed |
| `hooks` | `probe` (`{run, timeout?}`, a step): conformance calls `<run> write <token>` and `<run> read <token>` (exit 0: the token is there) |
| `test` | `{run, requires?, timeout?, smoke}`, below |
| `share` | `{endpoints, maxDays?, allow?}`, below: what a running copy may share as a preview link. Absent: never shared. Hashed |
| `deploy` | reserved: accepted, unused |

## A step (`setup`, a service's `build`, `hooks.probe`)
| key | value |
|---|---|
| `id` | the step's name (setup only), unique |
| `run` | argv (templates), run in the checkout as its own waited-for unit, stdin from /dev/null, no terminal |
| `inputs` | checkout files whose content, with the rendered argv, is the step's fingerprint (setup and build) |
| `timeout` | seconds, default 120, max 1800; the unit is killed whole at it |

## A service
Exactly one of `cmd` and `static`.

| key | value |
|---|---|
| `cmd` | argv (templates), run in `cwd` with `env` |
| `static` | a folder of the checkout Sova serves itself on 127.0.0.1; exactly one port, and none of `cwd`, `env`, `build`, `container`, `ready`; `reload` is `none`; never shared |
| `cwd` | relative to the checkout, default `.` |
| `env` | `{NAME: template}`; never a name Sova sets (`SOVA_V`, `SOVA_SLOT`, `SOVA_PORT_…`, see below) |
| `ports` | `{name: {base, stride?}}` → `base + slot × stride` (`stride` default 1), or `{name: {fixed}}` (`fixed`), the same in every slot. 1024–65535 in every slot up to cap+2, and no two ports' ranges may meet |
| `requires` | services started first (a shared service requires only shared ones) |
| `ready` | `{tcp: <port name>}` (`tcp`) or `{http: <port name>, path?}` (`http`, `path`) (any answer below 500), `timeout` seconds (default 60, max 600). Without it: ready when its first port listens, or after 1 s with no ports |
| `reload` | `"restart"` (default), `"none"`, `{signal: HUP\|USR1\|USR2\|INT\|TERM}` (`signal`) or `{cmd: argv}` |
| `build` | `{run, inputs?, timeout?}`: run by apply when its fingerprint changed |
| `scope` | `"checkout"` (default: one per instance) or `"shared"` (one per project, fixed ports only) |
| `container` | `{name, engine?: docker\|podman}` (`name`, `engine`): `cmd` runs that container in the foreground; Sova removes it by name at each stop. Conforms only after approval |
| `start` | `"up"` (default) or `"on-demand"`: up leaves it stopped unless named or required; a test run's `requires` starts it; down stops it. Checkout services only |
| `about` | ≤ 200 characters, a template without `${host.…}`: how a builder uses it ("Backend nREPL: clj-nrepl-eval -p ${ports.web.nrepl}"). Shown in the instance note. Not hashed |
| `isolation` | `{method, why}`: `method` one of `ports`, `names`, `process`, `container`, `netns`, `shared`; `why` ≤ 200 characters. A record for readers, never applied. Not hashed |
| `onMerge` | `"reload"` (`reload`): whenever main's HEAD moves (at once after Sova's Merge Branch, within 5 minutes after any other merge, release or commit on main), Sova runs apply for this service on the main checkout's copy (slot 0), as itself: its `build` when its fingerprint changed, then its `reload`. Only while that copy runs the service: a stopped one stays stopped. Never on the checkout Sova itself runs from. Opt in only for a server that should follow main and loses nothing by reloading; never a REPL, a long job or a datastore. Checkout `cmd` services only. Hashed |
| `adopt` | `{unit, ports}`: in slot 0 only, this service is a systemd user unit the operator already runs (`unit`, a whole `<name>.service`, never `sova-svc-…`), on these fixed `ports` (every port of the service; no slot may allocate one). Sova only reads it: up, down, reset and teardown of slot 0 are refused, and apply schedules a gated restart the operator confirms. One cmd checkout service at most, no container. Hashed. Sova's own definition adopts `sova-runtime.service`; a project you onboard almost never needs it |

## A data resource
Each has a `kind`, and may carry `sensitive: true`: its contents derive from production, so no instance holding it is ever shared. `sensitive` is inside the approval hash.
- `{kind: "dir", path?, from?}` (`path`, `from`): a folder, by default under the instance's data dir (`${data.<name>}`); `path` places it inside the checkout (it must be gitignored). `from` is `"empty"` (default) or a template naming a folder to copy at create and reset, e.g. `"${main}/infra/datomic/data"`. Keep `from` inside the project: a path outside it is refused before approval.
- `{kind: "hook", provision: argv, deprovision: argv, timeout?}` (`provision`, `deprovision`): your scripts make and remove it; provision prints its ref.

## `test`
`run` (argv template) gets the selectors appended as its last arguments (none: the whole suite), runs in the instance's checkout with its env plus `SOVA_VERB=test`, `SOVA_TEST_SELECT` (JSON array) and `SOVA_OUT`. `requires` names the services a run needs. `timeout` default 600, max 1800. `smoke`: 1–50 selectors (`^[A-Za-z0-9_][A-Za-z0-9_./:*-]{0,199}$`), a small selection green on main; conformance runs it twice and wants the same counts.

The runner should write `SOVA_OUT` as JSON: `{"passed": n, "failed": n, "errors"?: n, "skipped"?: n, "failures"?: [{"name", "message"?, "file"?, "line"?}]}`. Without it the counts are null and only the exit code counts.

## `share`
- `endpoints`: `["<service>.<port>", …]`, the ports of the copy's own (checkout) services a stakeholder may open through a share link: the app's web page, its public API. Never a shared service, and never a REPL, nREPL, shadow-cljs, debugger, metrics or admin port: a link gives whoever has it everything that port does. Each at most once, at most 20.
- `maxDays` (1–7, default 7): the longest a link of a copy lasts. Every link lasts 1 day unless the operator asks for more, at most 7.
- `allow` (`false`): copies are never shared, whatever is listed (Sova itself, a tool with no stakeholder view).
A project with any `sensitive` data resource is never shared, whatever `share` says. The whole key is inside the approval hash, so the operator approves what is exposed.

## `open`
- `endpoint`: `"<service>.<port>"`, a declared port of a checkout service (never a shared service's): the port the app's page is served on, in every copy.
- `path` (default `/`): where on that port a person lands, starting with `/`, at most 200 characters, no spaces or backslashes. The home page, never an API, health or readiness route: `ready.path` is for Sova's probe, `open.path` is for a person.
Sova's Branches tab offers **Open** on each running copy (`http://<host>:<its port><path>`, in a new tab), and conformance (suite 4) checks in scratch copy A that a `GET` of the entry answers below 500, naming its content type in the `open` check's detail (`web.http (port 41010): GET /home answered 200 (text/html; charset=utf-8)`). It exposes nothing a copy doesn't already listen on, so it is outside the approval hash.

## Templates
`${slot}`, `${instance}`, `${project}`, `${checkout}`, `${main}` (the main checkout), `${branch}`, `${data}` (the instance's data dir), `${data.<resource>}`, `${ports.<service>.<port>}`, `${host.<NAME>}`; `$$` is a literal `$`. Every process and hook also gets `SOVA_V=1`, `SOVA_PROJECT`, `SOVA_INSTANCE`, `SOVA_SLOT`, `SOVA_CHECKOUT`, `SOVA_MAIN`, `SOVA_BRANCH`, `SOVA_DATA`, `SOVA_PORT_<SERVICE>_<PORT>` for every port of the instance and `SOVA_PORT_<PORT>` for its own; a hook also `SOVA_VERB`, `SOVA_STEP`, `SOVA_OUT`; a test run also `SOVA_TEST_SELECT`. `<SERVICE>` and `<PORT>` are upper case with anything else `_`.

## The approval hash
Approval covers the whole parsed definition (a data resource's `sensitive` and `share` included) except every `timeout`, readiness `path`, `about`, `isolation`, `sources`, `open` and the default `start: "up"`. So rewording a `why` or an `about`, listing another source or moving the entry point needs no new approval; any command, env, port, hook, data source, `test` or `start: "on-demand"` does.

## Error codes
| code | exit | meaning for you |
|---|---|---|
| `invalid-definition` | 3 | the parser's path and message: fix the file |
| `invalid-request` | 3 | a bad verb argument |
| `not-found` | 3 | no such project, instance or ref |
| `not-approved` | 2 | `up`/`test` before approval (expected); conform of a container definition before approval |
| `not-conformant` | 2 | a verb that needs a passing conformance |
| `cap-reached` | 2 | no free slot |
| `port-held` | 2 | something else holds a port of the slot: change `base`/`stride`, never stop the holder |
| `dirty-worktree` | 2 | commit first |
| `unsupported` | 2 | the verb or method isn't available here (no `test` declared, no supervisor) |
| `refused-slot0` | 2 | teardown of the main checkout |
| `share-denied` | 2 | a share refused: no `share`, `allow: false`, sensitive data, an endpoint not listed, the copy not running, or an unregistered project |
| `forbidden` | 2 | not your checkout or instance |
| `needs-confirm` | 2 | the operator must do it |
| `not-ready` | 1 | a service didn't pass `ready` in time: read its log lines |
| `start-failed` | 1 | a service exited: read its log lines |
| `hook-failed` | 1 | a setup step, build, data hook or probe failed |
| `tests-failed` | 1 | the test run did not pass |
| `busy` | 4 | another verb holds the instance's lock: wait and retry |

## Toolchains
- mise shims (`mise.toml`, `.mise.toml`, `.tool-versions`) refuse an untrusted checkout: give each service `"MISE_TRUSTED_CONFIG_PATHS": "${checkout}"` in `env`. Setup steps, hooks, builds and the test run take no `env`: run them through a `.sova/bin/` script that exports `MISE_TRUSTED_CONFIG_PATHS="$SOVA_CHECKOUT"` first.
- A JVM resolving dependencies under confinement goes through the sandbox's proxy; Sova sets the proxy properties for it. The first confined run warms its caches and is slow.
