# Choosing isolation, per service

Every checkout's copy must be unable to see or change another copy's state, the main checkout's
included, and must run beside them on this host. Conformance proves that (two scratch copies side
by side, a probe token written in A and absent from B and from main); the method is your choice,
recorded per service as `isolation: {method, why}`. Choose in this order and stop at the first
that fits.

## 1. `ports` — a stateless process per checkout
Servers, watchers and REPLs that keep no state outside the checkout: the copy's own process on
its own ports. `scope: "checkout"`, every port `{base, stride}`.
- **base** = today's literal, so slot 0 keeps exactly the port the main checkout uses now.
- **stride** ≥ 10 when a service has several ports (base 4000 stride 10 gives 4000, 4010, 4020…),
  and wide enough that no two declared ports' ranges meet over slots 0…cap+2 (the parser refuses
  a meeting).
- Check every slot from 1 to cap+2 against `inspect`'s "listening now" and "held by Sova
  instances": `check` reports a collision. Move the base (keep slot 0's literal by choosing the
  stride) rather than hope the port is free later.
- An app that reads a port from a file or a literal needs the adapter: an env read
  (`(or (System/getenv "PORT") 4000)`, `process.env.PORT ?? 4000`) with the literal as default.

## 2. `process` — a datastore per checkout, on data copied from main
The copy's own database, cache or queue process on strided ports, with its files in a data
resource: `data: {db: {kind: "dir", from: "${main}/<where main keeps it>"}}` (or `"empty"` plus a
seeding setup step), and the service started on `${data.db}`.
- Datomic dev transactor, Redis, Postgres, SQLite files, Elasticsearch: each copy gets its own,
  so a migration or a wiped table on a branch never reaches main.
- When the program reads a config file, a `.sova/bin/` wrapper renders it from `SOVA_PORT_*` and
  `SOVA_DATA` into the data dir and execs the program; never edit main's config.
- Mind RAM: a JVM datastore costs hundreds of MiB per copy. Conformance measures it; report it.
- Copy only from inside the project (`${main}/…`). A large copy (hundreds of MiB) is fine; a copy
  of data that holds production secrets is not: seed instead, and say so.
- The copy must be consistent. Files copied while the main checkout's datastore writes them may
  not be (Datomic's H2 file, a Postgres data dir, an SQLite file mid-transaction). Take the
  per-copy data from a store at rest (`inspect`'s "listening now" shows whether main's runs; a
  `dir` `from` is copied at create and reset), or from the store's own dump (a `hook` resource
  whose provision restores the project's backup, `pg_dump` / `redis-cli --rdb` / Datomic
  `backup-db` made by the operator), or start empty and seed with the project's own schema and
  seed scripts. Never connect to the main checkout's running datastore to copy it. Say in the
  report which you chose and that the probe (and a test, if any) passed on it.

## 3. `names` — shared infrastructure, a namespace per checkout
When one server must stay shared (a system Postgres, a Redis you can't run twice), each copy uses
its own names on it: database `app_${slot}`, Redis db `${slot}`, key prefix `${instance}:`, bucket
`app-${instance}`. Declare the server as `scope: "shared"` with `fixed` ports only when Sova
starts it; when something outside Sova runs it, declare nothing for it and pass its address in
`env`. Use `shared`-scope or an outside server only when its port is free now or already Sova's.
- Creating and dropping the per-slot names is a `data` hook (`provision` / `deprovision`).
- The adapter reads the name from env, with today's name as the default.

## 4. `shared` — one service every copy may use as is
Only for something whose sharing can't leak state between copies: a mail catcher, a read-only
asset server. Say in `why` why sharing is safe. If the tool isn't installed (inspect marks it
missing), leave it out and say so in the report.

## 5. `container` — a container per checkout
Last, and only when the software can't run as a process here. `cmd` runs the container in the
foreground (`docker run --rm --name ${instance}-db -p ${ports.db.port}:5432 …`) with
`container: {name: "${instance}-db"}`. A container definition conforms only after the operator
approves it: say so in the report instead of looping.

`netns` (a private network namespace per copy) is reserved: never choose it.

## Writing `why`
One sentence a reviewer can check: what state the service keeps and why this method keeps the
copies apart. "Keeps all app data; each copy runs its own transactor on a copy of main's dev
data." "Stateless HTTP server; its own port per copy." Keep an existing `why` as written unless it
is wrong.

## Probe hook
`hooks.probe` proves the isolation of the state that matters most: `write <token>` stores the
token through the copy's own datastore (or its data dir), `read <token>` exits 0 only when it is
there. Write it as a `.sova/bin/probe` script against the copy's own ports from `SOVA_PORT_*`.
For a project with no state (a static site), declare no probe.
