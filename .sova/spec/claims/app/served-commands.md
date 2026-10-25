# §app/served-commands — The running Sova serves its list and its events to scripts
> Part of the Sova design spec · [overview](../design/overview.md)

A running Sova tells a script which actions it can run and what happens to its sessions, so the
`sova` command line (`scripts/sova.mjs`) reads both from the server it talks to rather than from its
own copy. Nothing on screen changes. Every existing command, flag, output line and exit class of
the command line stays as it was; what follows only adds to them.

## §app.served-commands/route — `GET /api/commands`

- On the main listener, `GET /api/commands` answers `{"version": 1, "server": {"version", "head"},
  "commands": [...]}`: `server.version` is Sova's package version and `server.head` the commit its
  checkout had when this process started (null when unknown), as `GET /api/health` says it.
  `commands` is every core catalogue entry, in the catalogue's order, then each installed
  extension's own `ext.<id>.<name>` entries, in manifest order.
- An extension's entries are exactly those its manifest entry's `offers` names (the same rule
  `GET /api/extensions` uses), built with their params, only for an entry this server installs: an
  entry it drops (bad `dist` or `api`, a second one with a taken id) lists none. A peer's extension,
  listed only while the mesh syncs extensions, lists none either.
- It reads the manifest and nothing else: it probes no extension backend, so its answer never waits
  on one.
- **This machine's own door only.** On the peer listener the path needs `full`, which no grant but
  full control meets; the share listener has no such route and answers 404.
- The route is not itself a catalogue entry: it is the catalogue, served.

## §app.served-commands/list — `sova list` and `describe` read the running Sova's list

- `list` and `describe` ask `GET /api/commands` of the server they would talk to (`--url`,
  `$SOVA_URL`, `$SOVA_PORT`, this machine only, as before) and print from its `commands`. When the
  server can't be reached, answers anything but 200, or answers something that isn't that shape
  within 0.5 s, they print from their own copy instead (the catalogue file and the extensions
  manifest), exactly as they did before the route existed. The output's format is the same either way.
- With `$SOVA_EXTENSIONS_FILE` set, the caller has named the manifest: `list` and `describe` read
  their own copy with it and ask no server.
- `run` still finds its entry in its own copy, so an id that only a newer server's list has is
  listed but refused by `run` as "no command" until the checkout has it too.

## §app.served-commands/watch — `sova watch` reads the event stream

- `sova watch` first opens `/ws/events` (§app/events) with the token header. When the stream
  greets it, each event prints as the line it printed before (`created`, `removed`, `renamed`,
  `tagged`, `archived`, `turn.started`, `turn.ended`, with `id`, `path` and the same fields), plus
  `source` (`hosted` for a chat this server runs, `observed` for one it only sees in the list, a
  terminal session's included) and `cursor` (`<stream>:<seq>`); `at` is when the server recorded the
  event. A `gap` frame prints as `{"event": "gap", "reason", "from", "to"}` (`from` and `to` absent
  when the server restarted). A hosted turn is printed however short it is: a turn of 50 ms gives one
  `turn.started` and one `turn.ended`.
- `--since <stream>:<seq>` resumes: exactly the events after that cursor the server still keeps,
  then live ones, with a `gap` line for any it no longer has. A cursor the server refuses prints its
  reason on stderr and exits 3; one that isn't `<stream>:<seq>` exits 3 before any request.
- `--events` keeps only the names it lists, as before; `gap` is one more name it accepts.
- Each feed frame still prints as `{"event": "feed", "frame": …}` while feed lines are wanted (no
  `--events`, or one naming `feed`): watch then also opens the session feed, as before.
- **The fallback.** When the server has no event stream (it closes or refuses `/ws/events` before
  greeting), `sova watch` does exactly what it did before: the session feed and the difference
  between two list reads, best effort, with no `source` or `cursor`. `--since` then can't be kept:
  it says so on stderr and exits 1, printing nothing.
- When a socket it relies on closes, it says so on stderr and exits 1, as before.
