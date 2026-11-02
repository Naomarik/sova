# §app/command-audit — Who ran what
> Part of the Sova design spec · [overview](../design/overview.md)

Every chat Sova runs carries a key of its own, and every script's call to the main listener leaves
a row saying who made it, what it ran and how it was answered. The key only says who is calling: it
opens nothing, and nothing that works without it is refused. The operator's token is still what
lets a call in.

## §app.command-audit/keys — A key for each chat process

- Each chat process Sova starts (a browser's chat, a worker, a team member, a hidden chat) gets
  its own key in `SOVA_CALLER_KEY`, beside `SOVA_CHAT_ID`, passed the way its other `SOVA_CHAT_*`
  variables are (§app.chat-processes/supervision). A chat that starts again, or a reload's
  replacement, gets a new key.
- Sova keeps only a hash of each key, under `<state root>/caller-keys/`, readable by the user
  only. The key itself is never written there, logged, recorded or sent in an event. The chat
  process's environment does carry it, so it is also in the file only the user can read that
  passes that environment (§app.chat-processes/supervision), which stays after the process starts;
  once the process ends that copy names nobody.
- A key names its chat only while that chat's process runs. Once the process ends (closed,
  archived, stopped when idle, crashed, replaced by a reload), its key names nobody.
- When the server restarts, the chats it takes back keep their keys. Once the whole take-back has
  succeeded, the keys an earlier server issued for chats it didn't take back are deleted; a key
  this server issued itself (a chat still starting) never is, and after a take-back that failed
  none is deleted until the next start. A key that can't be deleted is logged and left; the start
  goes on either way. Until the take-back is done, a call with a taken-back key
  is unattributed.
- A worker's own environment settings can't choose its key.
- A chat that runs inside the server process (when its own process could not start) has no key.
- The key never leaves this machine's own door: a request passed to an extension's backend or to
  a peer host loses `x-sova-caller`, as it loses the token.

## §app.command-audit/attribution — Beside the token, never instead of it

- A caller sends its key as `x-sova-caller`. `scripts/sova-token.mjs`'s headers add it whenever
  `SOVA_CALLER_KEY` is set, so `scripts/sova.mjs`, `sova-project` and the repo's own scripts send
  it from a chat with no change of theirs.
- The gate never reads it. The same request gets the same answer with the header, without it,
  with a dead key or with a malformed one, whatever its cookie, token, Host and Origin. A key
  without the token is refused 401, with the same answer as no credential at all. A key with the
  token is let in exactly as the token alone is.
- After the gate lets a call in, the key says who it was: `chat:<chat id>` while the key's chat
  runs, `unattributed` for any other key, and `no-key` when the call carried none. A call let in
  by an installed extension's own key (§app.extensions/backend-key) is always `ext:<extension id>`,
  whatever `x-sova-caller` says.
- A command a transcript card's view runs (§chat.transcript-cards/view-api) is recorded as
  `card:<card type>` (`card:project.chart`, `card:pulse.check`); no key or header chooses that.

## §app.command-audit/record — One row per call a script makes

- Sova records each call to the main listener's API, extension or socket paths that the gate let
  in and that shows the token itself, or an installed extension's own key, in `x-sova-token`: a
  script, the command line, a chat's tools, an extension's tools, an extension's backend. Only a
  holder of the token or of such a key can add a row, with one exception: a command a transcript
  card's view runs from the page is recorded by the server as run by that card
  (§chat.transcript-cards/view-api). Not recorded: a
  browser's own calls (its cookie only, apart from that), the app's page and files, calls Sova makes to itself, the
  peer listener's calls, a call the gate refused, and any call without the right token in that
  header, even where the gate doesn't ask for it (the health check, the unlock route, a test rig
  with the gate off), whatever key or command name it carries.
- A row holds when (`at`), who (`caller`, as §app.command-audit/attribution says), the
  command it names (`command`, when given), the method, the route that answered, as the server
  registers it (`/api/sessions/:id/rename`), and the answer's status (101 for a socket). Never
  the request's path, query, body, headers, parameters, token or key.
- `scripts/sova.mjs run <id>` names its command (`x-sova-command: <id>`) on the request the entry
  makes, so each run leaves exactly one row naming the command. A run that first looks up its
  `--session` leaves one more row for that look-up, naming none. A command name that is neither a
  catalogue id, an extension's `ext.<id>.<name>` (the id in the manifest's id alphabet, the name
  in its command-name rule), nor a project mode's `mode.<id>.<name>`
  (§chat.mode-menu/project-mode-commands) is left out of the row.
- Recording never holds up the answer: rows are written in batches, at most a quarter second
  after the call. The record is `<state root>/audit/commands.jsonl` and two older files beside
  it, at most 4 MB each; the oldest goes when a new one starts. Rows that pile up faster than they
  can be written are dropped beyond 10,000, oldest first, and the record says how many. A server
  that is killed may lose its last quarter second of rows.
- A socket that opens Sova's event stream with `?with=command.ran` also hears each row as it is
  recorded: a frame of `type: "command"`, `name: "command.ran"`, with the row's fields and no
  `seq`. It is live only: never kept, never replayed on a resume, and it takes no `seq`, so the
  stream's other events, their numbering and what a resume returns are the same as without it. A
  socket that doesn't ask never gets one. Under backpressure a command frame may be dropped with no
  `gap` frame, and dropping one never closes the socket as too slow. Any other `with` is ignored:
  the socket connects as it does without one.

## §app.command-audit/list — Reading the record

- `GET /api/audit` answers the newest rows first: at most `limit` (1 to 1,000, default 100),
  only `caller`'s or `command`'s when either is given. A `limit` out of range, or a `caller` or
  `command` longer than 128 characters, is refused with a sentence (400). The command line runs it
  as `audit.list`.
- On the peer listener it needs the `full` grant, which is what it would need with no rule of its
  own; no other route's need changes.

## §app.command-audit/census — What past chats used

`scripts/chat-key-census.mjs <sessions dir>` counts the tool calls that past chats' models made
to Sova with the operator's token: `sova-project`, `scripts/sova.mjs`, the `sova` launcher,
requests to a loopback Sova port, reads of the token file and the link extension's tools. It
prints each kind's calls and chats and each command or route (ids as `:id`, query values and
peer names left out), never a command line, prompt, header, token or path. It only reads.
