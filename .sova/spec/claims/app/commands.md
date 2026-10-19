# §app/commands — Commands
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's user-visible actions are listed in one catalogue, `shared/commands-catalog.ts`, assembled
from one file per area under `shared/commands/` (`sessions.ts`, `projects.ts`, `overseer.ts`,
`other.ts`, `chat.ts`). Each entry
names an action Sova already has and points at the route that already does it. The `sova` command
line (`scripts/sova.mjs`) lists, describes and runs those entries from a terminal, and streams what
changes in the session list. Extensions add actions of their own under `ext.`. Nothing in the
catalogue intercepts, vetoes or rewrites one of Sova's actions: an entry only adds a way to reach it.
The running server serves the catalogue, with its installed extensions' own entries, at `GET /api/commands` (§app/served-commands), and the command line reads it there.

## §app.commands/catalogue — The catalogue

Each entry has an `id`, a `label`, a one-line `summary`, an `effect` (`looks` changes nothing,
`changes` does), its `params`, its `route` (method, path, and whether each param travels in the
body, the query or the path), a `sessionKey` (whether it names a session by `path`, by `id`, or not
at all), a `sessionFile` (`never` touches the session's file, `refuses-live` is refused while a
terminal has the session open, `new` makes a new one) and a `meshNeed`.

- **It points, it never re-implements.** Running an entry is exactly the HTTP request its route
  takes from the web app, as the operator. Its answers, and every refusal, are the route's own,
  word for word: archiving a session open in a terminal still answers "This session is open in a
  TUI, so it stays on top while live. Nothing was archived." A value that travels in the path is
  never `.` or `..` (nor a `%2e` spelling of one): those would take the request off the entry's own
  route, so the request is never made, wherever the entry runs (`sova run` exits 3, the palette
  says why, a peer's run is refused as off the command's route).
- **The entries**, every id in `shared/commands-ids.json`'s `ids`, in the order they were added:
  `session.list`, `session.get`, `session.read`, `session.create`, `session.title.set`,
  `session.title.reset`, `session.tags.set`, `session.archive`, `session.unarchive`,
  `session.configure`, `session.mode.get`, `session.mode.set`, `session.send`,
  `project.verb.create`, `project.verb.up`, `project.verb.down`, `project.verb.apply`,
  `project.verb.status`, `project.verb.logs`, `project.verb.reset`, `project.verb.teardown`,
  `project.verb.doctor`, `project.verb.conform`, `project.verb.test`, `project.verb.share`,
  `project.verb.revoke`, `project.verb.deploy.check`, `project.verb.deploy.plan`,
  `project.verb.deploy.run`, `project.verb.deploy.status`, `project.verb.deploy.logs`,
  `project.verb.deploy.rollback`, `project.verb.deploy.request`, `project.services.view`,
  `overseer.attention`, `overseer.todo.list`, `overseer.todo.add`, `overseer.todo.update`,
  `overseer.todo.remove`, `models.list`, `extensions.list`, `session.fork`, `session.draft.get`,
  `session.draft.set`, `session.sandbox.set`, `session.tools.get`, `session.context`,
  `session.group.list`, `session.group.create`, `session.group.rename`, `session.group.delete`,
  `session.group.assign`, `session.group.send`, `session.insights`, `worker.resume`,
  `overseer.todo.reorder`, `overseer.todo.clear-done`, `overseer.idea.list`, `overseer.idea.get`,
  `overseer.idea.update`, `overseer.notes.get`, `overseer.notes.set`, `project.overseer.idea.list`,
  `project.overseer.idea.get`, `project.overseer.idea.add`, `project.overseer.idea.update`,
  `project.overseer.todo.list`, `project.overseer.todo.add`, `project.overseer.todo.update`,
  `project.overseer.todo.remove`, `project.overseer.todo.reorder`,
  `project.overseer.todo.clear-done`, `project.list`, `project.get`, `project.create`,
  `project.update`, `project.archive`, `project.unarchive`, `project.preview.off`,
  `project.worktree.list`, `project.worktree.merge`, `project.worktree.remove`,
  `project.files.list`, `project.costs`, `targets.list`, `folders.list`, `cwds.list`, `files.list`,
  `models.favorite`, `usage.costs`, `usage.performance`, `usage.today`, `usage.session`,
  `usage.sessions`, `usage.prices`, `usage.prices.refresh`, `insights.usage`,
  `insights.usage.history`, `insights.agents`, `insights.worktrees`, `insights.session.workers`,
  `sova.health`, `settings.sova.get`, `settings.models.get`, `settings.provider-limits.get`,
  `settings.align.get`, `settings.delegate.get`, `settings.spec.get`, `settings.team.get`,
  `settings.summarizer.get`, `settings.overseer.get`, `settings.memory.get`,
  `settings.subagents.get`, `settings.align.set`, `push.test`, `chat.stop`, `chat.compact`,
  `chat.rewind`, `chat.regenerate`, `chat.queue.remove`, `chat.reload-code`, `audit.list`,
  `chat.mode-command`.
  The `project.verb.*` ids are made from the verb lists of `shared/project-contract.ts`, so a new
  verb is a new entry. The in-chat actions are the `chat.*` entries (§app.chat-actions/catalogue),
  and `chat.mode-command` runs a project mode's command (§chat.mode-menu/project-mode-commands).
  Running `audit.list` reads Sova's record of who ran what (§app.command-audit/list).
- **Its mesh reach is its route's.** Each entry's `meshNeed` is the capability the peer listener's
  classifier gives its method and path (§mesh.peers/grants), and a test fails when they differ.
- **Never a door the operator keeps closed.** No entry targets the peer routes (`/api/peer`,
  `/peer`), the token routes (`/api/auth`), the share pages (`/h`, `/i`, `/s`) or the extension
  proxy (`/ext`).
- **Ids are append-only.** Every id ever shipped stays in a committed list; an id is never removed,
  renamed or given to another action. Core ids never start with `ext.`. An id whose action is
  removed is retired, never deleted: it moves from `ids` to the same file's `retired`, which is
  append-only too, and no entry may ever use it again. Retired: `settings.agents.get` (Settings →
  Agents, removed before it was released).

## §app.commands/cli — The `sova` command line

`node scripts/sova.mjs list [--json] [--session <id|path>]` prints every entry, the extensions'
included, and with `--session` the commands of that chat's project modes that are on
(§chat.mode-menu/project-mode-commands); `describe <id>` prints one entry as JSON;
`run <id> [--<param> <value>]… [--session <id|path>] [--json '<object>' | --json -] [--host <peer>]`
runs one and prints the route's JSON answer on stdout; `watch [--events a,b] [--since <stream>:<seq>]`
streams changes (§app.commands/watch).

- **Run from a checkout**, as `node scripts/sova.mjs`. The installed launcher named `sova`
  (§app.access/callers) is a different program and doesn't run these commands.
- **This machine only.** The server is `--url`, else `$SOVA_URL`, else
  `http://127.0.0.1:$SOVA_PORT` (4800). Any host but `127.0.0.1`, `localhost` or `::1` is refused
  before a request is made. It sends the token as `x-sova-token`, read as every script reads it
  (§app.access/callers), and in a chat Sova runs the chat's own key beside it as `x-sova-caller`.
  `run` names its command on the entry's request as `x-sova-command: <id>`; both headers only say
  who ran what (§app.command-audit/attribution). `run --host <peer>` (or `sova --host <peer> run
  <id>`) runs the command on a mesh peer through this machine (§mesh.peers/remote-commands).
- **Sessions by id or path.** `--session` takes either. Where the route takes a path, an id is
  turned into one through `GET /api/sessions/summary?id=`; where it takes an id, a path is turned
  into one the same way the list names it.
- **Exit classes**, as `sova-project`'s: 0 done; 1 failed (no answer, a 5xx, an answer that isn't
  JSON); 2 refused (a 401, 403 or 409, a host that isn't this machine); 3 invalid (a usage mistake, an
  unknown id or param, a 400 or 404); 4 busy (a 423 or 429); 5 outcome unknown, for an in-chat
  action only (§app.chat-actions/never-replay). A project verb exits by its own result code.
- **The same in a chat and outside one.** It never checks where it runs. In a chat, an entry that
  only looks takes the chat's own session (`SOVA_CHAT_ID`) when `--session` is left out; an entry
  that changes something always needs `--session` named.

## §app.commands/watch — Changes as a stream

`sova watch` changes nothing. It reads Sova's event stream when the server has one (§app.served-commands/watch); otherwise it opens `/ws/watch?feed=sessions` with the token header and prints
one JSON object per line: each frame the feed sends, as `{"event":"feed","frame":…}`, and the
changes it works out itself. It reads `GET /api/sessions` once to start from, then again after each
`list_changed` or `marks` frame (one read at a time, a burst folded into one more read), and prints
what differs between two reads: `created`, `removed`, `renamed`, `tagged`, `archived` (with
`archived: true` or `false`), `turn.started` and `turn.ended`, each with the session's `id`, its
`path` and `at`. `--events` keeps only the names it lists.

- **Best effort.** Without the event stream (§app.served-commands/watch), the changes are the difference between two reads of the list, so a turn that
  starts and ends between two reads is never printed, and two renames between reads print once,
  with the last title. `turn.*` follow the list's `busy`, which only sessions this server runs set.
  The list leaves out an empty session (no message of the user's yet), so a new one is `created`
  only once it is listed.
- When the socket closes it says so on stderr and exits 1.

## §app.commands/extension-commands — An extension's own actions

An extension's manifest entry (§app.extensions/manifest) may carry
`commands: [{name, label, summary, params, menu?}]`. Each valid one is listed as `ext.<extension id>.<name>`,
with `effect: changes`. Its optional `menu` key puts it in a menu of Sova's too
(§app.extensions/session-menu).

- `name` is `[a-z0-9][a-z0-9-]` up to 48 characters; `label` and `summary` are text; `params` is an
  object of `{type, description?, required?}` with `type` one of `string`, `number`, `integer`,
  `boolean`, `array` or `object`. A command that isn't valid is left out alone, and so is a second
  one with the same name; the rest of the extension stays.
- Its id is always under `ext.<extension id>.`, so an extension can never name, replace or shadow
  one of Sova's own entries.
- Running one is `POST /ext/<id>/api/commands/<name>` with the params as a JSON object, through
  Sova's extension proxy (§app.extensions/serving), which takes Sova's token off before the
  backend sees the request. The answer is the backend's, printed as it came.
- The command line reads the manifest file itself (`SOVA_EXTENSIONS_FILE`, else
  `<agent dir>/sova/extensions.json`). The server applies the same rules to list them in
  `GET /api/extensions`'s `offers` (§app.extensions/offers), where a reply chip's action is checked
  against them (§app.commands/reply-slot).

## §app.commands/reply-place — The reply place

What hangs under a delivered message is one place, the **reply place**, with two lanes in a fixed
order: Sova's own built-in contributions first, trusted and interactive, then what extensions add,
walled off. Sova's message actions (Copy, Share, Rewind or Regenerate, Fork:
§chat.transcript/message-actions) are its built-in contribution, drawn exactly as the strip was
before the place existed. Extensions add only under replies, after the strip
(§app.commands/reply-slot), never under your own message.

- **One component draws it.** A delivered message's strip and its extension lane are drawn only
  through the place; no feature hangs a second strip of its own beside it. A new Sova action under
  a message is one more built-in of the place.
- **Nothing extra without an extension that adds to replies.** Unless an installed, running
  extension's offers name `reply` (§app.extensions/offers), the place makes no request, holds no
  answer, and draws exactly what the strip drew before: the same buttons, order, labels,
  conditions, keyboard behaviour, classes and DOM.
- **Asked per session, never per reply.** Each extension whose offers name `reply` is asked once
  when the view has its session, again when the set of such extensions changes, once more when a
  run in that chat ends (a watched session, having no run of its own here, is asked when the view
  opens), and after one of its own chips' actions ran: `GET /ext/<id>/api/screens/reply?session=<id>`
  through the proxy. Its answer covers the whole session, keyed by entry id. A session on another
  host is never asked about: an extension is this host's.
- **The queued message's Remove is not in the place**: it is about the outgoing queue, not about an
  entry.

## §app.commands/reply-slot — What an extension adds under a reply

Under a reply, after Sova's own message actions in the reply place (§app.commands/reply-place), an
extension whose offers name `reply` may add **chips** and one **walled-off frame**. Each addition
names its extension.

- **The answer.** One JSON answer per extension for the whole session:
  `{"entries": {"<entry id>": {"chips": [...], "content": {...}}}}`, where an entry id is the reply's
  id in the session file (a transcript row's id up to its first `:`). Each entry is validated on its
  own; an entry id that isn't `[A-Za-z0-9_-]` up to 128 characters, or past the first 2000 entries,
  is dropped. The answer is read as it arrives and dropped whole past 1 MB.
- **Chips are data Sova draws in its own style:** a label of at most 24 plain characters (letters,
  digits, spaces and plain punctuation, never `<`, `>`, quotes or `&`), a tone (`ok`, `warn`,
  `error`, `info`, `muted`; every tone but `muted` with Sova's dot and the word), an optional icon
  from Sova's own icon names, and exactly one of an `http(s)` link, opened in a new tab, or one of
  the extension's own declared actions (its `offers.commands`). At most 3 chips from one extension
  and 6 under one reply. A chip that breaks a rule is dropped on its own. A chip whose label is one
  of Sova's own action names (Copy, Share, Rewind, Regenerate, Fork, Remove, or their button
  labels) is dropped too, as is an icon that stands for one of them, so a contribution never
  imitates, replaces or hides Sova's buttons.
- **An action asks first, then runs once.** A chip with a `confirm` sentence arms on the first
  press: the chips give way to the sentence with the extension's title, a button with the chip's
  label, and `Cancel`; focus moves to that button, and Esc or `Cancel` puts the chips back. Running
  it is `POST /ext/<id>/api/commands/<action>` with `{"session", "entry"}` through the proxy, then
  the extension is asked again. A failure stays under the reply in the error colour, and is
  announced: "{title} answered HTTP {status}." or "{title} isn't answering." No answer within 10
  seconds is "{title} isn't answering.", so one hung backend never keeps the reply's other chips,
  other extensions' included, waiting.
- **The frame is a picture, walled off.** It is `sandbox=""`: no scripts, no forms, no popups, no
  top navigation, no meta refresh, and an opaque origin, so no cookies, no storage and no way to
  reach Sova, its token or the page. Scripts stay off because a scripted frame can navigate itself
  away, and the request leaves before the page could stop it. Its document starts with the CSP
  `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src
  data: blob:` and DNS prefetch off, before any of the extension's markup; the same CSP is the
  frame's `csp` attribute, which browsers that support it (Chromium) also hold any later document
  to. It sends no referrer, takes no pointer and no keyboard focus, so no link inside it can be
  followed. Should it load a second document anyway, it is removed at once and its extension is
  muted until the page reloads. Its height is the one it declared, held between 32 and 320 px,
  and its document is at most 64 KB.
- **The reply never waits.** Nothing is drawn until an answer lands. Each extension gets 2 s; an
  answer that is late, malformed, too large or throws is dropped whole while that extension's last
  good answer stays, and a newer ask supersedes one still out without counting against it. An error
  boundary around the slot means a failure there renders nothing while the reply renders as before.
- **The user's switch, and Sova's.** The user turns one extension's additions off, or back on, from
  its page (§app.extensions/page), and the page remembers it; they leave every reply at once. An
  extension whose answers are dropped, or have a part dropped, 3 times in a row, or whose frame
  navigated, is muted: no longer asked, and nothing of it drawn, until the page reloads.
