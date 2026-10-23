---
watches: ["server/app.ts", "server/project-services/routes.ts", "shared/project-contract.ts", "shared/commands-*.ts", "shared/commands/*.ts", "shared/extension-offers.ts", "scripts/sova.mjs", "src/lib/reply-slot.ts", "src/lib/reply-place.ts", "src/components/ReplyPlace.tsx", "src/lib/menu-place.ts", "src/components/MenuPlace.tsx", "src/components/SessionRowMenu.tsx", "src/lib/row-place.ts", "src/components/RowPlace.tsx"]
alsoUpdate: ["shared/commands-catalog.ts", "shared/commands-ids.json", "agents/server/commands/overview.md", "docs/customization.md"]
---
# Commands and extensibility

Sova's user-visible actions as one catalogue of plain data, the command line that runs them, and
what extensions may add. The point is that a new action is reachable from a script, a later server
list, or an extension, by default, without anyone re-implementing it. Spec: `§app/commands`.

## What lives here

- `shared/commands-catalog.ts`: the catalogue. Each entry names an existing route (method, path,
  where each param goes), its `effect` (`looks` or `changes`), how it names a session
  (`sessionKey`), whether it can touch a session's file (`sessionFile`) and its `meshNeed`. Pure:
  it imports only `shared/project-contract.ts` (the `project.verb.*` family is made from `VERBS`
  and `DEPLOY_VERBS`, its params from `VERB_PARAMS` and `VERB_FLAGS`, the table the agents' verb
  tools are made from too). Erasable syntax only, with `.ts` import extensions, because the command line
  loads it through Node's type stripping.
- `shared/commands-ids.json`: every id ever shipped. Append-only: `ids` are the live entries'; an id
  whose action is removed is retired, never deleted (below).
- `shared/commands/chat.ts` (spread into `other.ts`'s `OTHER_ENTRIES`) and `server/chat-actions.ts` (`§app/chat-actions`): the in-chat actions
  (`chat.stop`, `chat.compact`, `chat.rewind`, `chat.regenerate`, `chat.queue.remove`,
  `chat.reload-code`), all on `POST /api/chat/action?path=&wait=`. The route hands the chat the frame
  its button sends, through a chat socket's own path (`server/ws.ts` `recordFrame`), once the chat's
  hello is in and at most once, and answers with the reply naming its request id. Past the wait, or
  when the chat restarts or reconnects first, it answers 202 `unknown` and nothing sends it again; the
  command line exits 5 then (below). A chat that never opens, or goes away before the frame went
  over, answers 503 `not-sent` ("The chat did not open; nothing was sent."), exit 1. A session a terminal holds is refused before any chat is asked;
  Stop and Reload Now on a chat that isn't open start nothing; an action stamps no seen mark.
- `docs/commands.md`: the generated inventory of every route (catalogue, not-a-command class, or a
  pending row that may only shrink); `node scripts/commands-inventory.mjs` regenerates it and
  `--check` fails when it is stale (`server/commands-inventory.test.ts`).
- `shared/commands-ext.ts`: an extension's `commands` manifest key, as the command line reads it.
- `shared/commands-watch.ts`: `sova watch`'s lines: from the event stream (`/ws/events`,
  `fromStreamFrame`: the diff's fields plus `source` and `cursor`) and, as the fallback, a pure
  diff of two list reads.
- `server/commands-routes.ts`: `GET /api/commands` (`§app.served-commands/route`), the catalogue as
  the running server knows it: core entries, then each installed extension's offered commands
  (`server/extensions.ts` `installedExtensionCommands`, the manifest only, no backend probe), then
  the server's version. Main listener only (`full` on the peer listener, no route on the share
  listener). It is the inventory's `catalogue` class, not a catalogue entry.
- `scripts/sova.mjs`: the command line (`list`, `describe`, `run`, `watch`); its header documents it.
  Not the installed launcher named `sova`. Its exit classes are sova-project's (0 done, 1 failed,
  2 refused, 3 invalid, 4 busy) and, for `chat.*` only, 5. Exit 5: the action was handed to the chat
  but its outcome is unknown; it was not and will not be retried. That is a 202 `unknown` answer, or
  a connection that opened and then broke before any answer; one that never opened stays exit 1.
  `list` and `describe` print the served list and fall back
  to the checkout's copy; `watch` reads the event stream and falls back to the list diff.
- `server/caller-keys.ts` and `server/command-audit.ts` (`§app/command-audit`): who ran what. Each
  chat process gets its own key in `SOVA_CALLER_KEY` (issued at launch in `server/chat-host.ts`, kept
  hashed, naming its chat only while the supervisor tracks that process). `scripts/sova-token.mjs`
  sends it as `x-sova-caller` beside the token; the gate never reads it. Each call that shows the
  token in `x-sova-token` leaves a row `{at, caller, command?, method, route, status}` (the route as
  registered, never params; `sova run` names its command in `x-sova-command`), written off the
  request path and rotated; `audit.list` (`GET /api/audit`) reads it; a `/ws/events?with=command.ran`
  socket hears each row live. `scripts/chat-key-census.mjs <sessions dir>` counts what past chats
  ran with the operator's token, printing only names Sova defines.
- `server/extension-keys.ts` (`§app.extensions/backend-key`): each installed extension's own key, a
  credential its backend sends in `x-sova-token` (the gate takes it everywhere the token goes but
  `/api/auth/*`; never as a cookie; the peer listener never reads it). Its calls are rows with the
  caller `ext:<id>`. Kept in step with the manifest by a 3 s sync that closes a revoked key's sockets; with nothing
  installed and no key kept the timer stops and a watch on the manifest's folder wakes it.
- `shared/extension-offers.ts`: what an extension offers (its manifest `commands` and `screens`),
  validated and bounded on the server into `GET /api/extensions`'s `offers` field
  (`ExtensionInfo.offers`). The one mechanism every place on Sova's screens reads: a place asks only
  the extensions whose `screens` name it. `SCREEN_PLACES` lists the places.
- Places on Sova's screens. Each has Sova's own built-ins first (trusted, interactive) and then what
  extensions add (walled). `reply`, under a delivered message, and `row` (below):
  `src/lib/reply-place.ts` (the place, its built-ins and the extension lane: one request per such
  extension per session, keyed by entry), `src/components/ReplyPlace.tsx` (draws it: `MessageActions`
  for the built-ins, then `ReplySlot`), `src/lib/reply-slot.ts` and `src/components/ReplySlot.tsx`
  (an extension's answer validated into chips Sova draws and one sealed static frame).
- The row place, `row`, line 3 of a session row in the sessions pane (`§app.extensions/row-chips`):
  `src/lib/row-place.ts` (its built-in, the readiness badge in `ROW_BUILT_INS`; the chip validator
  and caps; the lane, one request per such extension for the whole list, keyed by session id, at
  most once per 10 s on a list change; its own off switch and auto-mute, the reply slot's policy
  under `ROW_OFF_KEY`), `src/components/RowPlace.tsx` (`RowPlaceView` draws the built-ins exactly
  as the row always drew its badge, then `RowAdded`, plain text, never a control: the row is the
  link). The pane (`Sidebar.tsx`) runs the one lane and hands it to every row through
  `RowPlaceContext`.
- Menu places: a menu Sova's own items and extensions both add to. Today there is one, `session`,
  the Agents board row's ⋯ menu: `src/lib/menu-place.ts` (built-ins, which commands are entries
  (`"menu": "session"` on a manifest command, `MENU_PLACES` in `shared/extension-offers.ts`), the
  8-row cap, and running one through the proxy), `src/components/MenuPlace.tsx` (draws
  `MenuBuiltIns` where the menu stands them, then `MenuAdded`, one group per extension),
  `src/components/SessionRowMenu.tsx` (the menu; Copy Path is its built-in). It reads the page's
  extension list and asks no backend until a row runs.

## Rules, and the test that holds each

| Rule | Held by |
| --- | --- |
| A new user-visible action gets a catalogue entry by default, in the same change | review, and this guide's `watches` (the merge round's also-update nudge on `server/app.ts`) |
| An entry points at the existing route and never re-implements it: running it is the web app's own request | `server/commands-catalog.test.ts` (every route registered; an entry's request gets the route's own answer, refusals word for word) |
| Additions only add: nothing intercepts, vetoes or rewrites one of Sova's actions | the catalogue holds no handler, only data; `src/lib/reply-slot.test.ts` (a chip can't take one of Sova's action names) |
| Agents get an action only when it is opened to them on purpose | nothing in the catalogue becomes an agent tool by being listed; a tool is its own change, reviewed as one |
| An entry's `meshNeed` is exactly what `server/mesh/access.ts` `classifyRequest` gives its route | `server/commands-catalog.test.ts` |
| No entry points at the peer, auth, share-page or extension-proxy routes (`/api/peer`, `/peer`, `/api/auth`, `/h`, `/i`, `/s`, `/ext`) | `shared/commands-catalog.test.ts` |
| Ids are append-only; core ids never start with `ext.` | `shared/commands-catalog.test.ts` against `shared/commands-ids.json` |
| A retired id stays listed and no live entry ever uses it again | `shared/commands-retired.test.ts` |
| An extension's actions are only ever `ext.<id>.<name>`, run through the existing proxy (which strips the token) | `shared/commands-ext.test.ts`, `server/sova-cli.integration.test.ts` |
| Extension content on Sova's screens is data Sova draws, or a walled-off frame (`sandbox=""`, its own CSP, no pointer or focus), never markup in the page | `src/lib/reply-slot.test.ts`, `src/lib/reply-place-rule.test.ts` |
| Sova's own features use the same places as extensions: a place draws its built-ins first, then what extensions add, through one component; no second strip beside it | `src/lib/reply-place-rule.test.ts`, `src/lib/reply-place.browser.test.ts` |
| The session ⋯ menu draws Sova's items exactly as before (snapshot), its built-ins through the place, then extension rows through `MenuAdded` only; a down backend or a session on another host shows none | `src/lib/session-row-menu.test.ts`, `src/lib/menu-place-rule.test.ts`, `src/lib/menu-place.test.ts` |
| A command's `menu` key is validated on the server; a bad value drops the menu entry, never the command | `server/extension-offers-menu.test.ts` |
| A place asks only extensions whose offers name it: none, no request; one per extension when the view opens and when a run ends, never one per item | `src/lib/reply-place.browser.test.ts`, `src/lib/reply-slot-answers.test.ts` |
| A session row draws exactly what it drew before line 3 became a place (snapshot), its readiness badge as the place's built-in; extension chips only through `RowAdded`, plain data, never a control; one request per extension per list, never per row; none on another host's rows | `src/lib/session-row.test.ts`, `src/lib/row-place-rule.test.ts`, `src/lib/row-place.test.ts`, `src/lib/row-place.browser.test.ts` |
| What an extension offers is validated and bounded on the server; one that declares nothing gets the payload it always got; no secret rides along | `server/extension-offers.test.ts`, `server/extension-offers.integration.test.ts` |
| The command line talks only to this machine, the same in a chat and outside one | `scripts/sova.test.ts` |
| The served list is the catalogue plus exactly what installed extensions' offers name; it asks no backend; only the main listener has it | `server/commands-routes.test.ts`, `server/commands-served.integration.test.ts` |
| An in-chat action reaches its chat at most once; past the wait it is `unknown` (202, exit 5), never a retry; one that never reached its chat is `not-sent` (503, exit 1); only a reply naming its request id answers it | `server/chat-actions.test.ts`, `server/chat-actions.integration.test.ts`, `scripts/sova-unknown.integration.test.ts`, `scripts/sova-not-sent.test.ts` |
| A chat's key says who called and never lets anything in: every request gets the same answer with any `x-sova-caller` or none; only a call showing the token adds a row; no param value is recorded; neither step can change an answer | `server/caller-auth.test.ts`, `server/command-audit.test.ts`, `server/sova-caller.integration.test.ts`, `scenarios/audit.json` |
| An extension's key opens what the token opens but `/api/auth/*`, only in `x-sova-token`, is its extension's row, never reaches another backend or a peer, never appears in a page, and dies with its entry or file (its sockets too) but never with a bad save | `server/extension-keys.test.ts`, `server/extension-key-auth.integration.test.ts`, `server/extension-keys.integration.test.ts`, `scenarios/extension-key.json` |
| A key names its chat only while its process runs; a take-back's prune runs only after a whole take-back; a loadout can't choose a key | `server/caller-keys.test.ts`, `server/chat-host-caller-key.test.ts` |
| `command.ran` reaches only a socket that asked; the stream's ring, seqs and resumes are the same with it as without | `server/command-audit-events.test.ts` |
| `list`/`describe` use the served list and print the copy's output exactly when the server has none; `watch` hears hosted turns through the stream and falls back to the diff | `server/commands-served.integration.test.ts`, `scenarios/served.json` |

When a rule changes, change its test in the same change; a rule without a test is a wish.

## What is not a command

- Answering a chat's waiting dialog. It can approve a sandbox widening (`pi-config/extensions/worktrees`)
  and the Overseer's `sova_answer_dialog` records who chose; `POST /api/chat/action` refuses
  `ui_response` with a 400. (Stop, Compact, Rewind, Regenerate, Remove and Reload Now are `chat.*`
  entries now, above.)
- Anything at a door the operator keeps closed: the peer listener's routes, `/api/auth/*`, the
  share pages, `/ext/*` (an extension's own actions are `ext.*`, reached through the proxy).
- Settings writes that grant power, trust or reach, or that show a secret: autonomy and permits,
  profile and schedule approvals, logins, keys, decisions settings, mesh grants, an offers
  file's run-button approval (`POST /api/projects/:pid/offers/approve`) and applying a project's
  Settings change card or landing its folder's settings edits (`POST /api/projects/:pid/settings/apply`,
  §app.project-overseer/settings), the inventory's Trust grants class. The project overseer's own settings
  PATCH is a command (`project.overseer.settings.set`): it is the page's and a script's plain write, and what
  the overseer widens reaches it only through a card the operator applies. A plain preference
  a person sets (`settings.align.set`, the Overseer's own notes `overseer.notes.set`) is a command.
  A write to a file the runtime no longer reads is left out (`settings.spec.set`, `settings.delegate.set`).
- A public link that is minted or lengthened (`project.preview.create|extend`) or a list that
  prints live capability links (`project.preview.list`); revoking one (`project.preview.off`) is a command.
- Background sweeps and internal plumbing (a request the page makes to draw itself, a hook, a
  helper). An entry is something a person does.

## Adding an entry

1. Find the route that already does it. If there is none, the action is built first, as any
   feature is; the entry comes after.
2. Add the entry in its area file under `shared/commands/` (`sessions.ts`, `projects.ts`,
   `overseer.ts`, `other.ts`; `shared/commands-catalog.ts` assembles them): `meshNeed` is what
   `classifyRequest` says for the route, and the params name what the route reads. Add its id at
   the end of `shared/commands-ids.json`.
3. Add its bad-input case to `server/commands-fuzz.test.ts` (an addition to `FIXTURES`, or to
   `VALIDATE_ONLY` with a real reason, plus a per-id `anchors()` line when the route refuses an
   unknown id before it reads the body: a refused anchor and a real one that reaches the body's
   own checks; no other line of that file changes), then regenerate the
   route inventory with `node scripts/commands-inventory.mjs`.
4. `pnpm test -- shared/commands-catalog.test.ts server/commands-catalog.test.ts server/commands-inventory.test.ts server/commands-fuzz.test.ts` must pass, the first two unchanged.
5. Add the id to `§app.commands/catalogue`'s list through a spec draft.

## Removing an entry

An id is never deleted, renamed or reused. When the action behind an entry is removed, retire its id:
move it from `ids` to the end of `retired` in `shared/commands-ids.json` (append-only too), remove
the entry, its fuzz case and its route, regenerate the inventory, and take it out of
`§app.commands/catalogue`'s list and add it to that claim's retired ids through a spec draft.
`shared/commands-retired.test.ts` fails when a live entry uses a retired id; add the id to its list
of retired ids that must stay listed.

## When you change X, also update Y

| You change | Also |
| --- | --- |
| add or change a user-visible action (a route, a verb) | its catalogue entry and `shared/commands-ids.json` |
| a route an entry points at (path, method, body keys) | the entry; the catalogue tests tell you which |
| `shared/project-contract.ts` `VERBS` / `DEPLOY_VERBS` | the new `project.verb.*` id in `shared/commands-ids.json` |
| `shared/project-contract.ts` `VERB_PARAMS` / `VERB_FLAGS` (a verb's params) | both the tools (`server/project-services/tools.ts`) and the catalogue change: a tool wording change regenerates `server/agent-loadouts.snapshot.json` and reviews it as one; a catalogue param change updates the hash in `server/project-verb-params.test.ts`; a new flag goes into `scripts/sova-project.mjs` `VALUE`/`FLAG` |
| `server/mesh/access.ts` classification of a route an entry uses | the entry's `meshNeed` |
| the `commands` or `screens` manifest key, or the `offers` field | `docs/customization.md` "Sova extensions", `§app.extensions/offers`, the extension contract version in `§app/extensions` |
| add a place on Sova's screens | its name in `shared/extension-offers.ts` `SCREEN_PLACES` and `ScreenPlace`; Sova's own items there as its built-ins; the rule test above; `docs/customization.md` |
| add a menu place | its name in `shared/extension-offers.ts` `MENU_PLACES` and `ExtensionCommandInfo.menu`; Sova's own items there as its built-ins (`MenuBuiltIns`); `src/lib/menu-place-rule.test.ts`; `docs/customization.md` |
| add or change an item in the session ⋯ menu | `src/lib/session-row-menu.snapshot.json` (regenerate as its test's header says, and review the diff) |
| add a Sova action under a message | a built-in of the reply place (`ReplyPlace.builtIns` in the view), never a strip of its own |
| the in-chat actions' route or outcomes (`server/chat-actions.ts`) | `shared/commands/chat.ts`, `§app/chat-actions`, exit 5 in `scripts/sova.mjs` |
| what the command line prints or exits with | its header in `scripts/sova.mjs`, `§app.commands/cli`, `§app/served-commands` |
| the audit row's fields, the caller key's header or lifetime (`server/command-audit.ts`, `server/caller-keys.ts`) | `§app/command-audit`, `COMMAND_HEADER` in `scripts/sova.mjs`, `CALLER_HEADER` in `scripts/sova-token.mjs`, `CommandFrame` in `shared/events.ts` |
| what `GET /api/commands` answers | `server/commands-routes.ts`, `isServedList` in `scripts/sova.mjs`, `§app.served-commands/route` |
