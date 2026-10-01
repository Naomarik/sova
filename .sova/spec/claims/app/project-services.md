# §app/project-services — Project services and verbs

> Part of the Sova design spec · [overview](../design/overview.md)

A project declares how it runs in one file in its own repository, `.sova/project.json`. Sova runs it
from that declaration as **instances**, one per checkout of the project, each with its own slot,
ports and data. The primary user is a coding agent: each worktree gets its own running copy of the
project, isolated from the others and from the main checkout, without hand-rolled `nohup` loops. One
engine in the server implements a closed set of **verbs** (create, up, down, apply, status, logs,
reset, teardown, doctor, conform) the same way for every project, and every caller gets the same
JSON from it: the REST routes, the `sova-project` CLI, the coding session's `project_verbs` tool and
the Overseers' `sova_project_verbs` tool.

How a project is isolated (ports per slot, per-slot names on shared infrastructure, a container per
worktree, or a mix per service) is the project's choice, written into its declaration; Sova's verbs
are the same whichever it picks, and conformance proves the isolation, not the method. The engine
never calls a model. Share links, the Services page and drift detection come later; `share`,
`revoke` and `deploy` are reserved verb names that answer `unsupported`.

Wire shapes are in `shared/project-contract.ts`, never `shared/protocol.ts`. The engine is
`server/project-services/`.

## §app.project-services/contract — The declaration, `.sova/project.json`

The file sits at the root of the checkout it describes, so each branch carries its own. It is JSON
with `"version": 1`, parsed strictly: an unknown key anywhere, a value of the wrong type, a name
that is not lowercase letters, digits and hyphens (starting with a letter, at most 31 characters),
a dangling or cyclic `requires`, or an unknown template variable makes the whole file invalid
(`invalid-definition`, with the JSON path of the first problem), and nothing runs from it. No
shell string is accepted anywhere: every command is an argv array of non-empty strings.

- **`services`** (at least one), each exactly one of:
  - `cmd`: an argv, run with `cwd` (relative to the checkout, default the checkout) and `env`
    (names `A-Z0-9_`, never one of the variables Sova sets itself, listed below; values are templates).
  - `static`: a folder of the checkout (relative, no `..` and no dot-segment) that Sova serves itself
    on 127.0.0.1, with exactly one port and nothing else to run.

  Every service may declare `ports` (`{name: {base, stride?}}`, allocated per slot as
  `base + slot × stride`, stride default 1; or `{name: {fixed}}`, the same port for every slot),
  `requires` (services started first), `ready` (`{tcp: <port name>}` or `{http: <port name>,
  path?}`, answered below 500, with `timeout` seconds, default 60, at most 600), `reload`
  (`"restart"`, `"none"`, `{signal: HUP|USR1|USR2|INT|TERM}` or `{cmd: argv}`), `build` (`{run:
  argv, inputs?, timeout?}`), `scope` (`checkout`, the default: one per instance; or `shared`: one
  per project, fixed ports only, requiring only shared services) and `container` (`{name, engine?:
  docker|podman}`: the service's `cmd` runs a container in the foreground under that name, and
  Sova removes the container by name whenever it stops the service). A `cmd` service without
  `ready` is ready once its first port listens, or, with no ports, once it has run for a second.
- **`setup`**: steps `{id, run: argv, inputs?: [checkout files], timeout?}` run at create, in order.
- **`data`**: resources `{kind: "dir", path?, from?}` (a folder: by default under the instance's
  data dir; `path` places it inside the checkout, where it must be ignored by git; `from` is
  `"empty"`, the default, or a template naming a folder to copy) or `{kind: "hook", provision:
  argv, deprovision: argv, timeout?}`.
- **`hooks`**: `probe` (`{run: argv, timeout?}`), the optional isolation probe conformance calls as
  `<argv> write <token>` and `<argv> read <token>` (exit 0: the token is there).
- **`slots`** (`{cap}`, 1–16, default 4: how many instances besides the main checkout's), **`host`**
  (names of host variables the templates may read as `${host.NAME}`, kept in Sova's state, never
  in the repo), and the reserved **`share`** and **`deploy`** (accepted, not used yet).

**Templates** (`${…}`, `$$` for a literal `$`): `slot`, `instance`, `project`, `checkout`, `main`,
`branch`, `data`, `data.<resource>`, `ports.<service>.<port>`, `host.<NAME>`. Every process and hook
also gets `SOVA_V=1`, `SOVA_PROJECT`, `SOVA_INSTANCE`, `SOVA_SLOT`, `SOVA_CHECKOUT`, `SOVA_MAIN`,
`SOVA_BRANCH`, `SOVA_DATA`, `SOVA_PORT_<SERVICE>_<PORT>` for every port of the instance and
`SOVA_PORT_<PORT>` for its own, and a hook also `SOVA_VERB`, `SOVA_STEP` and `SOVA_OUT`.

A static site is one service: `{"version": 1, "services": {"site": {"static": ".", "ports":
{"http": {"base": 8731}}}}}`.

## §app.project-services/instances — Instances, slots and ports

An instance is one checkout of one project. The project is the main checkout's root (as
§chat.profiles/projects resolves it), and a checkout has at most one instance. Each instance has a
stable **id** (`<project folder slug>-<8 hex>`, random at create and never reused), a
**generation** that counts its starts from nothing, and a **slot**, a small number that is only an
allocation and is reused after teardown. Slot 0 is the main checkout's and no other; another
checkout takes the slot asked for, or the lowest of 1 to the cap that is free. A slot is free when
no instance of the project holds it and none of its allocated ports is held by any other instance
on this host (any project) or has a listener right now. The registry is
`<state root>/project-services/registry.json`, changed only under a file lock and written by an
atomic rename, so two callers can never get the same slot or port. An instance's data dir is
`<state root>/project-services/data/<id>/`, never inside a worktree.

## §app.project-services/result — One result shape, closed codes, exit classes

Every verb answers one JSON object with keys in this order: `v` (1), `verb`, `project`,
`instance`, `slot`, `generation`, `checkout`, `branch`, `ok`, `changed`, `state` (`absent`,
`stopped`, `running` or `degraded`), `steps` (`{id, kind, result: done|skipped|failed, ms, detail?,
fingerprint?}`), `services` (`{name, scope, kind: process|static|container, state: stopped|starting|
ready|degraded|failed|external, unit, pid, ports, ready?}`), `data` (`{name, kind, ref, exists}`),
`links` (empty until sharing exists), then the verb's own key (`instances` for status of a whole
project, `lines` for logs, `checks` for doctor and status (status: the supervisor's alone), `conform` for conform), then `error?` (`{code,
message, step?, service?}`), `defHash`, `approved` and `at`. Arrays follow declaration order.
Running a verb again with the same inputs gives the same object apart from `at`, `ms`, pids and a
new generation.

The error codes are a closed list: `not-found`, `invalid-request`, `invalid-definition`,
`not-approved`, `not-conformant`, `cap-reached`, `port-held`, `not-ready`, `start-failed`,
`hook-failed`, `dirty-worktree`, `busy`, `unsupported`, `refused-slot0`, `share-denied`,
`forbidden`, `needs-confirm`. Each maps to one exit class, the CLI's exit code and the route's
status: **0** done, a no-op included (200); **1** failed part-way — `not-ready`, `start-failed`,
`hook-failed` — with `state` saying what runs, and a re-run converges from there (502); **2**
refused, nothing changed — `not-approved`, `not-conformant`, `cap-reached`, `port-held`,
`dirty-worktree`, `unsupported`, `refused-slot0`, `share-denied`, `forbidden`, `needs-confirm`
(409); **3** invalid — `invalid-request`, `invalid-definition`, `not-found` (400, 404 for
not-found); **4** `busy` (423). `status`, `logs` and `doctor` answer 0 when the app is unhealthy;
the object says so.

## §app.project-services/lock — One verb at a time per instance

Every verb that changes an instance holds that instance's lock (per project and checkout, before
the instance exists) for its whole run. A second caller meanwhile gets `busy` at once, never a
queue, and nothing it asked for happens. `status`, `logs` and `doctor` take no lock.

## §app.project-services/supervisor — Who runs the processes

Exactly one supervisor owns each process. The supervisor is an adapter behind one driver interface,
and each server uses one: systemd on Linux, the portable detached driver elsewhere or when forced,
and `launchd` a reserved slot with no adapter built yet. `SOVA_PROJECT_DRIVER=systemd|detached`
forces one; otherwise it is systemd when the systemd user manager answers, else the detached
driver. Forcing `launchd` or a name that is no adapter leaves no supervisor, and verbs that would
start or stop a process answer `unsupported` before anything changes, as they do when the chosen
adapter can't run here. The server logs its choice at start, and `doctor` and `status` carry it as
the check `supervisor`: the adapter's id, what it reads, and why it was chosen (the switch, or the
probe's answer).

- **systemd**: each `cmd` service is a transient user unit
  `sova-svc-<state hash>-<instance id>-<service>` in `sova-services.slice`, started with
  `systemd-run --user` by argv, outside the Sova server's own cgroup, so it survives a restart of the
  server, and started again 2 s after it fails (`Restart=on-failure`). Its logs are the unit's
  journal. Hooks, setup and build steps run the same way as their own transient units
  (`sova-hook-…`), waited for, killed whole at their timeout (default 120 s, at most 1800 s), with
  stdin from `/dev/null` and no terminal.
- **detached** (any Unix, macOS included): each process is started in a session of its own, so it
  survives a restart of the server; its output is appended to
  `<state root>/project-services/logs/<unit>.log`, and it is recorded by pid and start time, so a
  later process that reuses the pid is never taken for it. The unit is that whole session, process
  groups inside it included. It is stopped by signalling every process in it (TERM, then KILL after
  15 s). On Linux, processes are read from `/proc`; elsewhere from `ps`, and where `ps` has no
  session column (macOS) the unit is its first process's tree plus every process group a member of
  it created. A process that starts a session of its own escapes the stop; without session ids, so
  does an orphan that left for a process group of its own. systemd has no such gap. While the server
  runs, a unit that ends with a failure (an exit other than 0, or one the server did not see) is
  started again after 2 s, at most 5 starts in 10 s, after which it stays failed. Meanwhile its
  status is `activating` (auto-restart), as with systemd. Hooks run the same way and are waited for;
  whatever they leave behind is killed with them. Which process listens on a port is read from
  `/proc` on Linux, else from `lsof`.

Sova stops, restarts and signals only units with its own prefix and state hash, never a process it
did not start. A `static` service is served inside the server's process (as
§mesh.public/preview-serve serves folders), and it is bound again when the server starts. A
`container` service is also removed by name (`docker rm -f` / `podman rm -f`) after each stop and
before each start.

## §app.project-services/create — create

In: `project`, and `checkout` (an existing worktree of the project, adopted), or `branch` (with
`from`, default the main checkout's HEAD: Sova adds a worktree for it beside the repository, as
§app.project-overseer/coding-worktrees places them, creating the branch when it is new), or neither
(the main checkout, slot 0); `slot` optional. The definition is read and checked, and its approval
too, before anything is made. Then the slot is allocated, the worktree cut when asked, each data
resource provisioned (skipped when it exists) and each setup step run (skipped when its
fingerprint, its rendered argv plus a hash of its `inputs`, is unchanged). A second create of the
same checkout answers the same instance with `changed: false`.

## §app.project-services/up — up

In: an instance (or create's arguments: the instance is created first), `services` optional. The
shared services it requires start first, then its own in `requires` order; each waits for its
readiness before the next starts. A service already ready is left alone (same pid, `skipped`).
Before a start, every port of the service is checked: a holder that is not the instance's own
refuses with `port-held`, naming it (its pid and folder, or the container that publishes the port)
and is never stopped. The instance's own are its unit's processes, the server for a `static`
service, and for a `container` service the container its `container.name` renders to, whenever the
engine (`docker|podman port`, else `inspect`) says that running container publishes the port,
whichever process listens for it (`docker-proxy`, `rootlessport`, `pasta`, Docker Desktop's own
process, or none visible when the engine publishes by firewall rules alone). After stopping a
service, Sova waits (at most 5 s) until none of its ports is listened on or still published by its
container. A service
that exits or does not become ready in time fails the verb (`start-failed`, `not-ready`) with the
instance `degraded`; the others keep running. A service the instance's record still wants that its
definition no longer declares (removed from `.sova/project.json`, or no longer a checkout service)
is stopped and marked stopped first, as a `stop:<name>` step that says so.

## §app.project-services/down — down

In: an instance, `services` optional. Stops its checkout services in reverse `requires` order,
and every service the instance's record still names that the definition no longer declares (all of
them when the definition is unreadable): by its unit's name, and by its container's name, which the
record keeps (with its engine) from the service's last start. Each is marked stopped, so nothing
comes back when a later definition declares it again. Data, slot, worktree and branch stay; nothing is deleted. A shared service is never stopped by an
instance's down; stopping one by name needs a confirm (`needs-confirm`), which only the operator
gives. Idempotent: a second down answers `changed: false`.

## §app.project-services/apply — apply

In: an instance, `services` optional, `restart` optional. For each running service, in `requires`
order: its `build` runs when the build's fingerprint changed, then its `reload` (restart, a signal,
a command, or nothing), or a restart when `restart` is set, then Sova waits for its readiness
again. A service that is not running is skipped. A service the record still wants that the
definition no longer declares is stopped and marked stopped, as up does. `changed` is true only when something reloaded or such a service was stopped.

## §app.project-services/status-logs — status and logs

Both are reads. `status` of an instance reports each service as observed now (stopped, starting,
ready, degraded, failed, or `external` when something else holds its port) with its unit, pid and
ports, each data resource's existence, the definition's hash and approval, and the supervisor in use
as the one check `supervisor` (informational: it never makes `ok` false). `status` of a project
lists every instance as `instances`, with the shared services. `logs` returns at most 500 lines
(default 100) of one service or all, oldest first, as `{t, service, text}`, from the journal or the
log file; for a model they are redacted and wrapped as untrusted text.

## §app.project-services/doctor — doctor

A read-only preflight: the definition parses, it is approved, the supervisor is reachable (its check
names the adapter in use and why it was chosen), every
command's program is on the PATH, every `host` name is set, every `dir` resource's `from` exists,
and the instance's ports are free or held by its own (as §app.project-services/up counts them). Each is a check `{id, ok, detail}`;
`ok` is false when one fails, and the exit is still 0.

## §app.project-services/reset — reset

Destructive to one instance only. Its running services go down, each data resource (or those
named) is removed and provisioned again from its `from` (a `hook` resource runs deprovision then
provision), the setup steps run again, and what was running comes back up. With no data declared it
answers `changed: false`.

## §app.project-services/teardown — teardown

The only verb that deletes. Down (every service down covers, those that left the definition
included), then each data resource deprovisioned and the data dir removed
(unless `keepData`), then the worktree removed only when Sova cut it and it is clean (a dirty one
stays, named in a skipped step), then the slot freed. The branch is never deleted. Slot 0 is
refused (`refused-slot0`). An instance that is absent answers `ok` with state `absent`.

## §app.project-services/reserved — Reserved verbs

`share`, `revoke` and `deploy` (and `deploy.plan`, `deploy.run`, `deploy.status`,
`deploy.rollback`) are verb names now and answer `unsupported` (exit 2), changing nothing.

## §app.project-services/trust — Approval of a definition

A definition runs only after the operator approved its hash on this host. The hash
(`sha256:<hex>`) covers the whole parsed definition except timeouts and readiness paths, so a
branch that changes any command, env template, port, hook or data source needs approving again,
while tuning a timeout does not. Approvals live in `<state root>/project-services/approvals.json`,
keyed by project root and hash, outside every repo, so no branch can approve itself; only the
operator's own routes and CLI approve, never a session or an Overseer, and an approval is refused
when the definition's hash is no longer the one shown. Every verb that runs something answers
`not-approved` before changing anything; reads and doctor still work.

## §app.project-services/reconcile — After a server start

When the server starts, it brings each instance back to its recorded desired state: a service that
should run but is not active is started again (static folders bound again), and a unit of its own
whose instance should be stopped is stopped. It never starts a service the instance's current
definition does not declare, and a unit of one that left the definition is stopped, its container
removed, and the service marked stopped; then the detached driver's restart watch takes charge
of the units already running. It never touches a process it did not start.

## §app.project-services/conform — Conformance

`conform` (project, `ref` default the main checkout's HEAD) proves a definition with a fixed,
versioned suite that no project can change, in two scratch instances A and B on new branches from
the ref, in slots above the cap so they never clash with real ones: doctor; create A, and again
(`changed: false`); every setup step run a second time exits 0; up A (ready), and again (same
pids); every declared port held by A's own (as §app.project-services/up counts them: its
processes, or its container publishing the port); status agrees; create and up B in parallel
(both ready, ports and data refs disjoint); with a `probe`, a token written in A reads in A, not in
B, and not in the main checkout's instance when it runs; apply A (ready, B's pids unchanged); logs
of A non-empty; reset A when data is declared (the token is gone); down A (its processes gone, its
ports free, B still ready), and again (`changed: false`); teardown A and B, and again (`absent`);
then nothing is left of either: no unit or process, no listener on their ports, no data dir, no
container, no registry entry, no worktree. Beyond A and B, a unit, data dir or registry entry
that appeared during the run is a leak only when it belongs to no registered instance (nor the
project's shared services): another instance's, registered before the run or made meanwhile by
another caller (a session's `up`, the server's reconcile), is never one. The report and a stamp keyed by project, hash and suite
version are written to Sova's state. A definition that is not approved is refused for now: running
it confined before approval comes with the onboarding playbook.

## §app.project-services/callers — Who may call which verb

The verbs are served by `POST /api/project-services/<verb>` (and `POST
/api/project-services/approve`), which act as the operator, and by `scripts/sova-project.mjs <verb>`,
a thin client of those routes that prints the result and exits with its class. Two tools call the
same engine in-process, never over HTTP:

- **`project_verbs`**, in every ordinary hosted session: reads (status, logs, doctor) on its own
  project; create, up, down and apply on instances of checkouts that are its own (its tracked
  worktrees, and its cwd's checkout unless that is the main checkout); reset and teardown only on
  instances it created; conform of its project. Anything else is `forbidden`.
- **`sova_project_verbs`** for the Overseers. The global Overseer reads any project and acts in a
  turn the user started; the project overseer is confined to its project: reads at any level,
  and every other verb only once its project statechart took the act (`services/down` at L0,
  `services/run` at L3 for create, up, apply, reset, teardown and conform; any of them in a run the
  operator started; §app.project-overseer/tools). Above its level the statechart refuses with a
  sentence telling it to file the gap as an idea or raise a confirm card, and the engine never
  runs; the engine itself checks no level. For both, reset and teardown of an instance it did not
  create, and stopping a shared service, answer `needs-confirm`: the operator does it.

`deploy` is `unsupported` for everyone, and nothing but the operator approves a definition.
