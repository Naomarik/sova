# §app/project-services — Project services and verbs

> Part of the Sova design spec · [overview](../design/overview.md)

A project declares how it runs in one file in its own repository, `.sova/project.json`. Sova runs it
from that declaration as **instances**, one per checkout of the project, each with its own slot,
ports and data. The primary user is a coding agent: each worktree gets its own running copy of the
project, isolated from the others and from the main checkout, without hand-rolled `nohup` loops. One
engine in the server implements a closed set of **verbs** (create, up, down, apply, status, logs,
reset, teardown, doctor, conform, test, share, revoke) the same way for every project, and every caller gets the same
JSON from it: the REST routes, the `sova-project` CLI, the coding session's `project_verbs` tool and
the Overseers' `sova_project_verbs` tool.

How a project is isolated (ports per slot, per-slot names on shared infrastructure, a container per
worktree, or a mix per service) is the project's choice, written into its declaration; Sova's verbs
are the same whichever it picks, and conformance proves the isolation, not the method. The engine
never calls a model. A running copy can be shared with a stakeholder as a preview link
(§app.project-services/share); `deploy` is a reserved verb name that answers `unsupported`.

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
  Sova removes the container by name whenever it stops the service), `start` (`"up"`, the default,
  or `"on-demand"`: a checkout service that `up` leaves stopped unless asked for, §app.project-services/up)
  and `about` (at most 200 characters, a template that may not read `${host.…}`: how a builder uses
  the service, e.g. the client command with its port, shown in the instance note,
  §app.project-services/instance-note). A `cmd` service without
  `ready` is ready once its first port listens, or, with no ports, once it has run for a second.
- **`setup`**: steps `{id, run: argv, inputs?: [checkout files], timeout?}` run at create, in order.
- **`data`**: resources `{kind: "dir", path?, from?}` (a folder: by default under the instance's
  data dir; `path` places it inside the checkout, where it must be ignored by git; `from` is
  `"empty"`, the default, or a template naming a folder to copy) or `{kind: "hook", provision:
  argv, deprovision: argv, timeout?}`. Either kind may say `sensitive: true` (default false): its
  copies hold data derived from production (a restore of a production backup, a clone of a
  production database), so no copy of an instance holding it is ever shared
  (§app.project-services/reserved).
- **`test`** (optional): `{run: argv, requires?: [service], timeout?, smoke: [selector]}`, the
  project's test command (§app.project-services/test). `run` is a template argv; `requires` names
  the services a run needs (an on-demand test REPL, say); `timeout` is in seconds (default 600, at
  most 1800); `smoke` is 1 to 50 selectors naming a small selection that is green on the main
  checkout, which conformance runs. A selector matches `^[A-Za-z0-9_][A-Za-z0-9_./:*-]{0,199}$`,
  so none can read as a flag.
- **`hooks`**: `probe` (`{run: argv, timeout?}`), the optional isolation probe conformance calls as
  `<argv> write <token>` and `<argv> read <token>` (exit 0: the token is there).
- **`slots`** (`{cap}`, 1–16, default 4: how many instances besides the main checkout's), **`host`**
  (names of host variables the templates may read as `${host.NAME}`, kept in Sova's state, never
  in the repo), and the reserved **`deploy`** (accepted, not used yet).
- **`share`** (optional): `{endpoints?, maxDays?, allow?}`, what a running copy may share
  (§app.project-services/share). `endpoints` lists `"<service>.<port>"`, each a declared port of a
  checkout service (never a shared service's), each once, at most 20 (none when absent); `maxDays` is
  1–7; `allow` is `true` (the default) or `false` (never shared, whatever is listed). Without
  `share`, no copy is shared.
- **`sources`** (optional): the checkout files the definition was written from (`bb.edn`,
  `package.json`, a compose file, `.mise.toml`: relative, no `..`, dot-files allowed, at most 50),
  whose change at HEAD is the project's drift (§app.project-services/facts). Each service may also
  say how it is isolated, **`isolation`** (`{method: ports|names|process|container|netns|shared,
  why}`, `why` a sentence of at most 200 characters): a record of the choice for the reader,
  never a rule Sova applies.

**Templates** (`${…}`, `$$` for a literal `$`): `slot`, `instance`, `project`, `checkout`, `main`,
`branch`, `data`, `data.<resource>`, `ports.<service>.<port>`, `host.<NAME>`. Every process and hook
also gets `SOVA_V=1`, `SOVA_PROJECT`, `SOVA_INSTANCE`, `SOVA_SLOT`, `SOVA_CHECKOUT`, `SOVA_MAIN`,
`SOVA_BRANCH`, `SOVA_DATA`, `SOVA_PORT_<SERVICE>_<PORT>` for every port of the instance and
`SOVA_PORT_<PORT>` for its own, and a hook also `SOVA_VERB`, `SOVA_STEP` and `SOVA_OUT`; a test
run also `SOVA_TEST_SELECT`.

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
ready|degraded|failed|external, unit, pid, ports, ready?, detail?, rssBytes?}`), `data` (`{name, kind, ref, exists}`),
`links` (`{id, instance, endpoint, port, createdAt, expiresAt, state: active|expired|revoked,
createdBy, url?}`, §app.project-services/share: share's link, the links revoke ended, and the active
links of the instance status reads; empty otherwise), then the verb's own key (`instances` for status of a whole
project, `lines` for logs and test, `checks` for doctor and status (status: the supervisor's alone), `conform` for conform,
`tests` for test), then `error?` (`{code,
message, step?, service?}`), `defHash`, `approved` and `at`. Arrays follow declaration order.
Running a verb again with the same inputs gives the same object apart from `at`, `ms`, pids,
`rssBytes` and a new generation.

The error codes are a closed list: `not-found`, `invalid-request`, `invalid-definition`,
`not-approved`, `not-conformant`, `cap-reached`, `port-held`, `not-ready`, `start-failed`,
`hook-failed`, `tests-failed`, `dirty-worktree`, `busy`, `unsupported`, `refused-slot0`, `share-denied`,
`forbidden`, `needs-confirm`. Each maps to one exit class, the CLI's exit code and the route's
status: **0** done, a no-op included (200); **1** failed part-way — `not-ready`, `start-failed`,
`hook-failed`, `tests-failed` — with `state` saying what runs, and a re-run converges from there (502); **2**
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
  stdin from `/dev/null` and no terminal; a unit of the same name still loaded is stopped and
  cleared first. A command named by a relative path (`.sova/bin/setup`) runs from the unit's
  working directory, as with the detached driver. When `systemd-run` itself cannot start a hook,
  nothing ran: the step fails with `systemd-run`'s own message, never as the hook's exit, and that
  message is the step's log, which the unit's journal lacks.
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
§mesh.public/preview-serve serves folders), and it is bound again when the server starts. The
previews' sweep, which stops the folder serves of ended previews, never stops it. A
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

In: an instance (or create's arguments: the instance is created first), `services` optional.
Without `services` it starts every checkout service but the on-demand ones (`start:
"on-demand"`), which start only when named, required by a service that starts, or required by a
test run (§app.project-services/test); once started, an on-demand service is wanted like any other
(reconcile keeps it running) until down stops it. The
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
is stopped and marked stopped first, as a `stop:<name>` step that says so; so is a shared service
that is in no definition any more, by down's rule (§app.project-services/down), when it still runs
or is still wanted.

## §app.project-services/down — down

In: an instance, `services` optional. Stops its checkout services, the on-demand ones included, in reverse `requires` order,
and every service the instance's record still names that the definition no longer declares (all of
them when the definition is unreadable): by its unit's name, and by its container's name, which the
record keeps (with its engine) from the service's last start. Each is marked stopped, so nothing
comes back when a later definition declares it again. Data, slot, worktree and branch stay; nothing is deleted. A shared service is never stopped by an
instance's down; stopping one by name needs a confirm (`needs-confirm`), which only the operator
gives. A shared service the project's record still names that no definition declares any more
(neither the main checkout's nor any registered instance's checkout's, each readable) is the
exception: down stops it by its unit's name and marks it stopped, as a `stop:<name>` step that says
it is shared and in no definition; while any of those definitions is unreadable it is left alone.
Idempotent: a second down answers `changed: false`. Down of an instance with an active share link
(§app.project-services/share) needs a confirm, which only the operator gives (`needs-confirm`
otherwise, naming how many links); its links stay, and show the not-running page while it is down.

## §app.project-services/apply — apply

In: an instance, `services` optional, `restart` optional. For each running service, in `requires`
order: its `build` runs when the build's fingerprint changed, then its `reload` (restart, a signal,
a command, or nothing), or a restart when `restart` is set, then Sova waits for its readiness
again. A service that is not running is skipped. A service the record still wants that the
definition no longer declares is stopped and marked stopped, as up does. `changed` is true only when something reloaded or such a service was stopped.

## §app.project-services/status-logs — status and logs

Both are reads. `status` of an instance reports each service as observed now (stopped, starting,
ready, degraded, failed, or `external` when something else holds its port) with its unit, pid,
ports and, while a process service runs, `rssBytes` (the resident memory of its unit's
processes now), each data resource's existence, the definition's hash and approval, and the supervisor in use
as the one check `supervisor` (informational: it never makes `ok` false). A service the definition
no longer declares whose unit (or static serve) still runs is listed too, after the declared ones,
as `degraded` with its unit and pid and the detail "no longer in the definition" (a shared one:
"shared, no longer in any definition"), so what still runs is never hidden. `status` of a project
lists every instance as `instances`, with the shared services; each instance also carries its active
share links (`links`, their `url` only for the operator) and `share` (`{endpoints, refused}`: the
endpoints its definition lists, and the sentence saying why it can't be shared, null when it can).
`status` of one instance puts its active links in the result's `links`. `logs` returns at most 500 lines
(default 100) of one service or all, oldest first, as `{t, service, text}`, from the journal or the
log file; for a model they are redacted and wrapped as untrusted text.

## §app.project-services/doctor — doctor

A read-only preflight: the definition parses, it is approved, the supervisor is reachable (its check
names the adapter in use and why it was chosen), every
command's program is on the PATH, every `host` name is set, every `dir` resource's `from` exists,
and the instance's ports are free or held by its own (as §app.project-services/up counts them). Each is a check `{id, ok, detail}`;
`ok` is false when one fails, and the exit is still 0.

## §app.project-services/test — test

In: an instance (or create's arguments: the instance is created first, as up does), `select`
optional (at most 50 selectors, each as the contract's `smoke` ones; anything else is
`invalid-request`). A definition with no `test` answers `unsupported` ("This project declares no
test command") and nothing changes. Otherwise test holds the instance's lock (§app.project-services/lock),
brings up the services `test.requires` names, with what they require, as up does
(§app.project-services/up, on-demand ones included) and waits for their readiness, then runs `run`
with the selectors appended as its last arguments (none: the whole suite), in the instance's
checkout, as one waited-for unit `sova-hook-<state hash>-<instance>-test` with the instance's env
plus `SOVA_VERB=test`, `SOVA_TEST_SELECT` (the selectors as a JSON array) and `SOVA_OUT`. At its
timeout, or when the caller aborts (a cancelled tool call), the unit is killed whole. It runs
against the instance's own ports and data, never the main checkout's. `changed` is true only when
it created the instance or started a service; the run itself is a `test` step.

The result's `tests` is `{select, pass, passed, failed, errors, skipped, failures, exit, timedOut,
ms, peakBytes}`. When the runner wrote `SOVA_OUT` as JSON with numeric `passed` and `failed` (and
optionally `errors`, `skipped`, and `failures` `[{name, message?, file?, line?}]`), the counts and
failures come from it, at most 50 failures with each message cut to 2000 characters; otherwise the
counts are null and `failures` is empty. `pass` is true only when the run neither timed out nor
exited other than 0 and counted no failure or error. `peakBytes` is the run's memory peak (the
systemd unit's own summary, or, with the detached driver, the largest sampled resident memory of
the run's processes), null when unknown. `lines` holds the run's last 100 lines of output (service
`test`), which a model reads as untrusted, like logs. A run that did not pass fails the verb with
`tests-failed`: "{failed + errors} of {passed + failed + errors} failed", "timed out after
{timeout}s", or, with no counts, "the test command exited with {exit}".

## §app.project-services/instance-note — What a builder is told about its instance

Sova tells each coding session about its own running copies in a note rendered from the checkout's
own `.sova/project.json` and the registry, never from a file in the checkout. It covers every
checkout that is the session's own (§app.project-services/callers) except the main checkout, whose
project has a definition. For a checkout with an instance it says: the checkout and branch, the
instance id and slot, and when the definition is not approved, that the operator approves it; each
port as "`<service>.<port>`: N (main checkout: M)", with its `http://127.0.0.1:N<path>` URL when
the service's readiness is http on that port, and "shared" for a shared service's; each service's
rendered `about` and whether it is on-demand; each data resource's name and where it is; how tests
run ("project_verbs {verb: "test", select: [...]} runs them in this instance; no select runs the
whole suite", with the smoke selection) or that the project declares none; "Start, reload and stop
these through project_verbs, never by hand."; and, when the session's sandbox is on, "Your shell is
sandboxed and cannot reach these ports: use project_verbs." A checkout with a definition but no
instance gets one line saying it has no running copy yet and that project_verbs up gives it its own
ports; one whose definition is invalid, one line naming the problem. A project without a definition
gets no note.

The note reaches the model as a hidden message (`sova-instance-note`, never shown in the
transcript) at the start of a turn, only when its text differs from the last such message on the
branch: the text holds no live state (no pids, no running or stopped), so it changes only when a
slot, port, data ref, `about`, the test command, the approval or the sandbox does. After a
compaction the current note is sent again. The system prompt never changes. The same text follows
the result of `project_verbs` and `sova_project_verbs` for create, up, apply and status of one
instance, so a turn that just ran up learns its ports at once, and status is the note on demand.

## §app.project-services/reset — reset

Destructive to one instance only. Its running services go down, each data resource (or those
named) is removed and provisioned again from its `from` (a `hook` resource runs deprovision then
provision), the setup steps run again, and what was running comes back up. With no data declared it
answers `changed: false`.

## §app.project-services/teardown — teardown

The only verb that deletes. First every share link of the instance is revoked, each person's
sibling of one included (§app.project-services/share, a `links` step), then down (every service down
covers, those that left the definition included), then each data resource deprovisioned and the data dir removed
(unless `keepData`), then the worktree removed only when Sova cut it and it is clean (a dirty one
stays, named in a skipped step), then the slot freed. The branch is never deleted. Slot 0 is
refused (`refused-slot0`). An instance that is absent answers `ok` with state `absent`.

## §app.project-services/reserved — Reserved verbs

`deploy` (and `deploy.plan`, `deploy.run`, `deploy.status`, `deploy.rollback`) are verb names now
and answer `unsupported` (exit 2), changing nothing. `share` refuses any instance whose definition
declares a `sensitive` data resource (`share-denied`), whoever asks (§app.project-services/share).

## §app.project-services/share — Share links to a running copy

`share` (an instance, `endpoint` `"<service>.<port>"`, `days` optional) gives a running copy of the
project a preview link (§mesh.public/preview) to one of its declared endpoints, so a stakeholder can
open it. `revoke` (`link`, or an instance with an optional `endpoint`) ends links. Both are verbs
like the others: one result shape, every caller.

- **What may be shared.** Only an endpoint the definition lists in `share.endpoints`, a port of a
  checkout service (never a shared service's). Share is refused with `share-denied`, before anything
  changes, when: the project is not registered in Sova ("Only a registered project's copies can be
  shared."); the definition has no `share` key or says `allow: false`; the endpoint is not listed;
  any data resource of the definition is `sensitive` ("Derived from production: copies are never
  shared."); the instance is not running that endpoint's service (share never starts anything: up
  first); or no preview address is set. An unapproved definition is `not-approved`, as for every verb
  that runs something.
- **The link.** A port preview of the endpoint's port in the copy's slot, kept in
  `preview-kept.json` with the target `instance` (the instance id, the endpoint, and for a static
  service the serve that must hold the port) and the copy's branch; preview-links.json's keys do not
  change. It is bound to the instance id and the endpoint: the generation is only recorded, so the
  link survives down and up, and a server restart. It lasts `days`, 1 by default and at most 7, or
  at most the definition's `share.maxDays` (1–7) when set; more is `invalid-request`. Extending it
  (`POST /api/previews/<id>/extend`) moves its expiry to `days` from now, refused above 7. A static copy's
  link dials only while that copy's own serve holds the port; a process copy's dials the port as
  any port preview does. A visit never starts anything: while the copy is down, the visitor gets the
  not-running page.
- **Idempotent.** Sharing the same instance and endpoint again while its link is active answers
  that same link, its expiry moved to the later of its current one and `days` from now.
- **Who shares.** The operator, confirmed (`confirm`; the Services tab's confirm, the CLI's
  `--confirm`), else `needs-confirm`. The project overseer through its statechart's act
  `services/share` (L1, people-facing, held like a preview; §app.project-services/callers). The
  global Overseer gets `needs-confirm` ("The operator shares it from the project's Services tab.").
  A coding session gets `forbidden`. `revoke` is open to any caller with the instance in scope and
  is never an act or held.
- **Its end.** A link ends at its expiry, at revoke, or when its copy is torn down: teardown revokes
  every link of the instance, and every person's sibling of them (§app.outreach/links), before its
  slot is freed, so a later copy in that slot never answers an old link. Down of a copy with an
  active link needs a confirm: the operator's `confirm`, else `needs-confirm`.
- **Where the URL goes.** The result's `links` carry `{id, instance, endpoint, port, createdAt,
  expiresAt, state, createdBy, url?}`; `createdBy` is `operator` or `session:<id>` (the project
  overseer's conversation), as preview-links.json keeps it; `url` only for the operator (routes and
  CLI). No tool result of any model carries a link's URL, and the redaction filter still applies.
  Status lists each instance's active links. A share or revoke that changed something is a `link`
  step (`share`, `revoke`, teardown's `links`); a held share is a skipped `share` step whose detail
  says it is held, with no link.

## §app.project-services/trust — Approval of a definition

A definition runs only after the operator approved its hash on this host. The hash
(`sha256:<hex>`) covers the whole parsed definition except timeouts, readiness paths, each
service's `about` and `isolation`, and the `sources` list, so a
branch that changes any command, env template, port, hook or data source needs approving again,
while tuning a timeout, rewording an `about` or an isolation's `why`, or listing another source does not; a `test`, a `start`, a data resource's `sensitive` and `share` are covered (`allow: true`, the default, hashes as if absent). Approvals live in `<state root>/project-services/approvals.json`,
keyed by project root and hash, outside every repo, so no branch can approve itself; only the
operator's own routes and CLI approve, never a session or an Overseer, and an approval is refused
when the definition's hash is no longer the one shown. Every verb that runs something answers
`not-approved` before changing anything; reads and doctor still work.

## §app.project-services/reconcile — After a server start

When the server starts, it brings each instance back to its recorded desired state: a service that
should run but is not active is started again (static folders bound again), and a unit of its own
whose instance should be stopped is stopped. It never starts a service the instance's current
definition does not declare, and a unit of one that left the definition is stopped, its container
removed, and the service marked stopped; a project's shared service that no definition declares
any more (down's rule, §app.project-services/down) is stopped and marked stopped the same way, and
never started again; then the detached driver's restart watch takes charge
of the units already running. It never touches a process it did not start.

## §app.project-services/conform — Conformance

`conform` (project, `ref` default the main checkout's HEAD) proves a definition with a fixed,
versioned suite that no project can change, in two scratch instances A and B on new branches from
the ref, in slots above the cap so they never clash with real ones: doctor; create A, and again
(`changed: false`); every setup step run a second time exits 0; up A (ready), and again (same
pids); every declared port of a service up started held by A's own (as §app.project-services/up counts them: its
processes, or its container publishing the port); status agrees; create and up B in parallel
(both ready, ports and data refs disjoint); with a `probe`, a token written in A reads in A, not in
B, and not in the main checkout's instance when it runs; apply A (ready, B's pids unchanged); logs
of A answer, at most 50 lines, and at least one when apply A left a process or container service of
A's own not stopped (a `static` service is served in the server and logs nothing, and an on-demand
one that has not started has nothing to log yet, so A with only those may answer none); reset A when data is declared (the token is gone); with a `test`, suite version 2
adds: up A left every on-demand service stopped; test A with the `smoke` selection passes, its
`requires` are ready afterwards and B's pids are unchanged; a second such test passes with the same
counts; without a `test`, test A answers `unsupported`; suite version 3 adds, after logs: each
endpoint the definition's `share` lists answers a `GET /` below 500 through the preview proxy's own
request path, in the server's process, with no link minted (a confined run's process service is
asked inside the run's namespace; with no endpoints, `allow: false` or sensitive data the check
passes saying so); then down A (its processes gone, the
on-demand ones' included, its ports free, B still ready), and again (`changed: false`); teardown A and B, and again (`absent`);
then nothing is left of either: no unit or process, no listener on their ports, no data dir, no
container, no registry entry, no worktree. While the suite runs, Sova samples the resident memory of
each service of A and B (its unit's processes; a static service, served in the server, has none):
the report's `memory` gives each instance's and each service's peak, and its steady reading, taken
for A once its status agrees with up and for B once it is up. When a check fails, before teardown
removes anything, the report's `logs` keeps the last 80 lines of each of A's and B's services that is
not ready (starting, degraded or failed) or that the failure names, and of a failed setup, data or
build step (its unit's output, or the supervisor's message when it could not start it), so the
cause can be read after the run. The suite's version is 3, which the report and the stamp carry. Beyond A and B, a unit, data dir or registry entry
that appeared during the run is a leak only when it belongs to no registered instance (nor the
project's shared services): another instance's, registered before the run or made meanwhile by
another caller (a session's `up`, the server's reconcile), is never one. The report and a stamp keyed by project, hash and suite
version are written to Sova's state, a failed run's too (with its first failed check), and a
confined run's stamp is kept apart from an unconfined one's. A definition that is approved on this
host runs as described; one that is not runs confined (§app.project-services/confined), whoever
calls, and a confined stamp never stands for approval or registers anything. Once the operator
approves main's definition, the project's software registry runs this unconfined conformance on main
by itself (§app.project-runtime/standing).

## §app.project-services/confined — Conformance before approval, confined

A definition that is not approved on this host conforms confined, so the Project verbs playbook
can prove a definition before the operator approves it. Before anything starts, the run is refused
with `not-approved` when the definition has a `container` service ("a container service runs only
after approval: approve this definition to conform it"), when a data `from` names a folder outside
the project's checkouts or one the host's sandbox policy hides, or when the host can't confine (not
Linux, no `bwrap` or `nsenter`, no sandbox policy file, or a read-only policy), naming why.

Each confined run gets one private network namespace of its own, held by an anchor that Sova starts
under the host's sandbox policy (`<agent dir>/sandbox-policy/`) with its proxy: the namespace has
only loopback, and its one way out is the policy's proxy allowlist (`HTTP(S)_PROXY`, and for a JVM
`JAVA_TOOL_OPTIONS` with the same proxy; Maven's resolver, which reads proxies only from
`~/.m2/settings.xml`, finds them in the sandbox's private `~/.m2`, written there once when it has no
settings file). Every process of the run (setup, hooks, build steps,
services, test runs, the probe) joins that namespace and runs in the policy's filesystem view: the
policy's hidden paths read as empty, its caches are the sandbox's private copies (the policy's, and also the Clojure CLI's user classpath cache `~/.clojure/.cpcache` and git libraries `~/.gitlibs`, never the user's config beside them), and it may write
only its own instance's checkout and data dir and a tmp of its own; the main checkout, every other
checkout and the rest of the host are read-only. So A's and B's services reach each other's ports
only inside the run, nothing of the run is reachable from the host, and a fixed port collides with
nothing on the host. Sova checks readiness, port owners and listeners inside the namespace itself.
A static service is served by the server as always. The check that the token is absent from the
main checkout's instance is recorded as skipped (confined). The stamp says `confined`, and the
report carries `confined: true`. The run's units are stopped when the server starts again, never
started.

## §app.project-services/facts — What a project's software registry reads

For each project root, Sova reads main's definition at HEAD, never the working tree (which may be
dirty): whether `.sova/project.json` is absent, invalid (with the parse error) or present (with its
hash), the commit, the software it declares (each service's name, kind, scope, slot-0 ports,
requires, start and isolation), its data resources (each one's name, kind and whether it is
`sensitive`), its `sources` with each file's blob at HEAD (`null` where missing)
and a fingerprint over them, this host's approval of that hash, and its newest unconfined and newest
confined conformance stamps with the current suite (pass, time, report, the first failed check, the
run's memory); a stamp of an older suite proves nothing. A source whose blob changed since the
software was registered is the project's drift, named by its path. The same read of a branch's tip
gives a proposed definition's hash, whether it is approved here, and its confined stamp. An approval
made through this read is refused when the definition at that ref is no longer the hash shown, or
when there is none.

## §app.project-services/callers — Who may call which verb

The verbs are served by `POST /api/project-services/<verb>` (and `POST
/api/project-services/approve`), which act as the operator, and by `scripts/sova-project.mjs <verb>`,
a thin client of those routes that prints the result and exits with its class. Two tools call the
same engine in-process, never over HTTP:

- **`project_verbs`**, in every ordinary hosted session: reads (status, logs, doctor) on its own
  project; create, up, down, apply and test on instances of checkouts that are its own (its tracked
  worktrees, and its cwd's checkout unless that is the main checkout); reset and teardown only on
  instances it created; conform of its project. Anything else is `forbidden`.
- **`sova_project_verbs`** for the Overseers. The global Overseer reads any project and acts in a
  turn the user started; the project overseer is confined to its project: reads at any level,
  and every other verb only once its project statechart took the act (`services/down` at L0,
  `services/run` at L3 for create, up, apply, test, reset, teardown and conform; any of them in a run the
  operator started; §app.project-overseer/tools). Above its level the statechart refuses with a
  sentence telling it to file the gap as an idea or raise a confirm card, and the engine never
  runs; the engine itself checks no level. For both, reset and teardown of an instance it did not
  create, stopping a shared service, and down of a copy with an active share link, answer
  `needs-confirm`: the operator does it.

`share` (§app.project-services/share) is the operator's, confirmed; the project overseer's through
its statechart's act `services/share` (L1, people-facing, held like a preview), run only after every
check of the share passed, so a refused share never reaches the statechart; the global Overseer's is
`needs-confirm` ("The operator shares it from the project's Services tab."); a coding session's is
`forbidden`. `revoke` is any caller's with the instance in scope (a session: its own checkouts'), with
no act, never held and taking no lock. `deploy` is `unsupported` for everyone, and nothing but the
operator approves a definition.

## §app.project-services/self-host — When the project is Sova itself

A project whose root is the running Sova server's own checkout (the git checkout the server's code
was loaded from) is Sova hosting itself. On it, a verb that stops or restarts the main checkout's
instance (slot 0) — `apply`, `down`, `reset` and `teardown` — always needs the operator's confirm,
whatever the caller and at every autonomy level: the operator passes `confirm` (the CLI's
`--confirm`); every other caller gets `needs-confirm` ("…stops or restarts the Sova server's own
checkout: the operator does it…"). Even confirmed, it is refused with `busy` while any session this
server hosts is busy: its live record (`sessions/live/p<server pid>-*.json`, heartbeat at most 30 s
old) shows a working subagent or a turn in flight, the asking session's own turn included. The
refusal names how many are busy, and nothing changes. Instances of the project's other worktrees
are not affected: their verbs follow the ordinary rules.

## §app.project-services/services-ui — The Services tab and Running copies

The operator sees and drives every running copy from two places, both on this host's engine.

- **The Services tab** (`#/projects/<pid>/services`) reads `GET /api/projects/:pid/services`: the
  project's status (§app.project-services/status-logs) with, per service, the port its readiness
  probes over HTTP (a static service's first port too, at `/`) and that path; and whether the main
  checkout's definition declares sensitive data. It is read every 5 seconds while the tab shows. One row per copy: the main checkout's (slot 0) first, named
  `main`, then each branch copy by slot. A row shows the branch, `slot {n}`, each checkout service's
  ports (a port with HTTP readiness is a link to `http://<this page's host>:<port><path>`), the copy's
  memory (the sum of its services' resident memory, "—" when none reports one), its state as a chip
  (Running, Degraded, Stopped, Absent; a service that is not ready is named under the row with its
  state), and who created it ("by you", "by a coding session", "by its overseer", "by the Overseer",
  "by conformance"; the caller's tag is its title). While the main checkout has no copy, **Start
  Main** (`up` of the project) sits under the rows. Shared services are listed in their own block
  under the copies, once each, with their ports, state and memory, and Start and Stop of their own.
- **Actions per copy**: **Start** (`up`), **Stop** (`down`), **Apply** (`apply`), **Reset**
  (`reset`), **Logs** and **Teardown** (`teardown`). Each runs as the operator through
  `POST /api/projects/:pid/services/:verb` (`{instance, services?, confirm?, lines?}`), which answers
  the verb's result with the status of its exit class. Reset, Teardown, and Stop of a shared service
  ask first: the first click turns the button into its confirm ("Confirm Teardown"), the second runs
  it with `confirm`, and leaving the button disarms it. While a verb runs its button says so
  ("Stopping…") and the other buttons wait. A refusal is a sentence under the row, the engine's
  message without the CLI's `(sova-project …)` hint: `needs-confirm` adds "Press it again to
  confirm." and arms that button, so its next click sends `confirm` (Stop of a copy with an active
  link, Apply or Stop of Sova's own main); `busy` adds "Try again once they are idle." unless the
  message already says when; any other failure is its message alone. A done verb toasts what it did
  ("Stopped main.", "Tore down feat-x. Its slot is free.").
- **Logs** opens the copy's logs over the page (a modal; a sheet at folded width): its last 200
  lines (`logs`, `lines: 200`), oldest first, each with its 24-hour time and its service, in mono,
  re-read every 3 seconds while open and kept at the bottom unless the operator scrolled up; Close,
  Escape or the scrim closes it and focus returns to the Logs button.
- **Narrow**: below 480px of the tab's width each row stacks (facts, then the actions wrapping
  under them), and nothing scrolls sideways.
- **Running copies** on `#/projects` (`GET /api/services`): one section listing, for every project
  on this host with a copy or shared service that runs now, standalone or placed, each running copy
  (branch or `main`, slot, state, memory) and each running shared service, with a **Stop** that
  stops it (`down` as the operator; a shared service's asks first, and a refusal reads as on the
  tab). It is read every 15 seconds. The project's name links to its Services tab, with "In {org}"
  while placed. A copy whose root no registered project holds is listed under its folder, without a
  link. A confined conformance run's copies are not listed. With nothing running it says "Nothing runs on this host now. Copies you
  start show here."
- **Share** (§app.project-services/share): a copy's row offers **Share** while its status lists
  share endpoints (`share.endpoints`). It opens a form under the row's facts: the endpoint
  (`<service>.<port>`) as a select, the expiry as 1 to 7 days (1 by default), the preview warning
  for that endpoint's port, and **Share Copy** / **Cancel**. While the chosen endpoint's service is
  not ready, Share Copy waits and the form says "This copy isn't running {service}: start it
  first. Sharing never starts anything." Otherwise Share Copy runs `share` with
  `{endpoint, days, confirm}`, then copies the link (it is kept in the page, so Copy Link works
  even when status keeps no URL) and toasts "Shared {endpoint} of {copy}." The copy's active links
  (status's `links`) are chips on its row ("web.http · expires in 5 hours"), each with **Copy Link**
  (when the page knows its URL) and **Turn Off** (the first click asks "Turn Off Link?", the second
  runs `revoke` of that link). While the main checkout's definition declares sensitive data, every
  copy's Share is disabled and the row reads "Derived from production: copies are never shared.";
  otherwise, while the engine says a copy can't be shared (`share.refused`), Share is disabled with
  that sentence under the row.
