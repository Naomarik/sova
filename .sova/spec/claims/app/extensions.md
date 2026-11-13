# §app/extensions — Extensions
> Part of the Sova design spec · [overview](../design/overview.md)

An extension is something the user adds to Sova from a folder on this computer (§app.extensions/folder):
any of a built UI (a folder with an `index.html`), a program that runs on this machine, and what it
adds to Sova's screens and chats. Sova shows it as a card on the landing page and as a page at
`#/ext/<id>`, serves its UI and forwards its API and sockets from Sova's own
origin, and knows nothing about what it does. The host is generic: no extension is named, special
cased or shipped by Sova. The interface is `ext-contract-v1.22`; any change to it is a version bump
agreed with the extensions built on it. v1.15 added what an extension offers (§app.extensions/offers)
and what it adds under replies (§app.commands/reply-slot). v1.16 added each backend's own key
(§app.extensions/backend-key), a command's `menu` key (§app.extensions/session-menu), and the `row`
and `card` places (§app.extensions/row-chips, §app.extensions/card-status). v1.17 added the card
types and drawing kinds it adds to chat transcripts (§app.extensions/views), additions only. v1.18
added a command's `overseer`, `description` and `job` keys, and the job status route the Overseer
asks (§app.overseer/extension-commands). An extension that declares none of them sees no change.
v1.19 added card news (§app.events/card-news), the contract's number in the served list
(§app.served-commands/route) and cards that update (§chat.transcript-cards/updating-cards), and it
narrowed what a key does: a message it sends carries its extension's name
(§app.extensions/name-badge), and it is refused at the doors that would count as the user
(§app.extensions/not-you). So an extension that sends messages does see a change.
v1.20 added the folder and its description file (§app.extensions/folder), the list Sova writes and what you
approve (§app.extensions/loader), the program Sova runs (§app.extensions/program), and entries with no
page or no program. A hand-written entry still works once it is approved.
v1.21 added the group, pane and worktree menu places. v1.22 makes the 4 places in
§app.context-menus/places the served contract's complete menu-place list.

An extension is a guest with a name badge. It can hear what happens, show things, ask the user with a
card and say things to a chat, always under its own name. It can never be the user.

**With no extension installed, a chat's tools, prompts and recorded goldens don't change.** v1.19 adds no
catalogue entry, route or place. A chat with a project's cards or offers, or an open alignment, does see
what was decided for every card:

- a card that takes no answer starts open (§chat.transcript-cards/updating-cards);
- Needs You lists a waiting card without the guess that the reply asks something
  (§app.decisions/asks-user), and a row with an open question stays Question
  (§app.session-list/needs-you);
- cards and offers can stand beside an open alignment question (§chat.transcript-cards/raise-command,
  §chat.offers/card);
- a press on one during that wait goes out marked (§chat.alignment/session-mark);
- a card shows at once in an open pane (§app.events/card-news).

**With no extension listed, v1.20 changes nothing** but the Settings tab itself: Sova starts no program and
no folder is read.

## §app.extensions/manifest — The manifest

The installed extensions are listed in one JSON file, `<state root>/extensions.json`
(`~/.pi/agent/sova/extensions.json`), or the file `SOVA_EXTENSIONS_FILE` names (a second instance
sharing the agent dir points at its own). **Settings → Extensions writes it** (§app.extensions/loader), and
the user can still edit it by hand; what is added outside that screen waits for approval. The mesh
never writes it (§mesh.sync/categories).

```json
{ "version": 1,
  "extensions": [
    { "id": "notes", "title": "Notes", "description": "Scratch notes per project", "icon": "file",
      "dist": "/abs/path/to/dist", "api": "http://127.0.0.1:4840" } ] }
```

- **Re-read on every request** that needs it, so an install or an edit is live at once, with no
  restart. A missing file is no extensions. A file that isn't JSON, or isn't `version: 1` with an
  `extensions` array, is no extensions too, and the server logs why.
- **Each entry is validated on its own**, and an invalid one is dropped while the rest stay. It is
  dropped when `id` isn't `[A-Za-z0-9._-]+` (or is `.` or `..`), a `dist` it has isn't an absolute path, or
  an `api` it has isn't `http(s)://127.0.0.1|localhost:<port>` with an explicit port and an optional path
  prefix, with no trailing slash, credentials, query or fragment. A second entry with an id already
  taken is dropped. Each distinct complaint is logged once per server process, not per request. A
  dropped entry serves nothing, and its row on Settings → Extensions reads Not Usable and says why.
- **`dist` and `api` are each optional** (v1.20). An entry with no `dist` has no page and one with no
  `api` has no program; neither is an error.
- **What the loader adds.** `folder` (the absolute folder it came from), `run` and `programFolder` (the
  program, §app.extensions/program), `needsContract` and `off: true`. An older Sova ignores them, as it
  does every unknown key, `off` included: after a downgrade it serves an off entry that has a `dist` and
  an `api`. The docs say so, and nothing guards against it.
- **Optional fields fall back quietly.** No `title` → the id. A `title` that isn't one plain line
  of at most 80 characters (one with a control character, U+2028 or U+2029 among them) is not used
  either: the id stands in, the rest of the entry stays, and the server logs why.
  `description` is omitted when empty.
  An `icon` that isn't a plain icon name (`[a-z0-9-]+`, a file in `public/icons/`) is ignored,
  because it ends up in a CSS `url()`. Unknown keys are ignored.
- **`commands`, `screens`, `cards` and `drawings` are what it offers.** An entry may list its own
  actions under `commands` (§app.commands/extension-commands), the places on Sova's screens it adds
  to under `screens`, and the transcript card types and drawing kinds it adds under `cards` and
  `drawings` (§app.extensions/views). The server validates them into the list's `offers` field
  (§app.extensions/offers); a bad one never drops the entry. The `sova` command line reads `commands` from this file itself.

## §app.extensions/serving — The UI, the API and the sockets

Everything an extension has lives under `/ext/<id>/` on Sova's origin. These routes come before
Sova's own static files and SPA fallback, so an `/ext/` path never answers with the Sova shell.

| Path | What answers |
|---|---|
| `GET /ext/<id>` | a redirect to `/ext/<id>/`, so relative asset URLs resolve inside the extension |
| `GET /ext/<id>/…` | a file from `dist`. A path whose last segment has no dot is a client route and gets `index.html`; a missing file with a dot is a 404, never `index.html`. HTML is sent `Cache-Control: no-cache`. No path reaches outside `dist` (`..`, encoded or not, is a 404) |
| `ANY /ext/<id>/api/…` | the backend's `<api>/api/…`, same method, body and query |
| `GET /ext/<id>/ws/…` (upgrade) | a WebSocket to the backend's `<api>/ws/…` (`ws:` for `http:`, `wss:` for `https:`), same query; a plain GET there is a 426 |

An unknown id is a 404 everywhere: JSON `{"error":"Unknown extension"}` on `/api` and `/ws`, the
text `Unknown extension` on the UI paths. An id on the list that isn't active (§app.extensions/loader) is
an unknown id here. A UI path whose file is, once links are followed, a
backend key file or the key hash file (§app.extensions/backend-key) is a 404 too.

Three more answers, none of them a 502 or the Sova shell:

- **An extension that reads Changed** (§app.extensions/loader): its UI paths are a 404 with the text
  `This extension changed and is waiting for your approval.` Its API and sockets still forward, to the
  program running on the code you approved.
- **An entry with no `dist`:** its UI paths are a 404 with the text `This extension has no page.`
- **An entry with no `api`:** `/api` is a 404, `{"error":"This extension has no program"}`, and `/ws`
  refuses the upgrade the same way.

- **HTTP forwarding** (`hono/proxy`). Every request header goes along except `host` (the backend
  sees its own), the hop-by-hop headers and Sova's own credential (every `sova_token_*` cookie,
  `x-sova-token`, which is also where an extension's key rides, a chat's key in `x-sova-caller`,
  the Overseer's in-process sender mark `x-sova-overseer` and the card it was opened by,
  `x-sova-overseer-card`, and an `Authorization` carrying the token or any extension's key), plus
  `X-Forwarded-Host` (the host the browser used) and
  `X-Sova-Origin: http://127.0.0.1:<the port this server listens on>`, which is how a backend
  learns where to call Sova back. The response comes back as the backend sent it: status, headers
  (minus hop-by-hop), streamed body. A backend that can't be reached is
  `502 {"error":"extension down","id":"<id>"}`. Node's fetch gives up connecting after 10 s. Sova
  sets no read timeout of its own, so a streamed response runs while the backend keeps it open,
  though Node's fetch cuts a body that goes 300 s with no chunk. The contract therefore requires
  an extension's HTTP streams to send a chunk at least every 60 s.
- **WebSocket forwarding.** Sova dials the backend first and upgrades the browser's socket only
  once the backend has accepted, so a backend that is down refuses the upgrade with an HTTP 502
  (same JSON) and no socket ever opens. After that, frames pass both ways untouched (text stays
  text, binary stays binary), the backend's chosen subprotocol is the browser's, and a close on
  either side closes the other with the same code and reason. Frames the backend sends before
  the browser's handshake completes are held and delivered in order.
- **No auth and no CSRF check**, the same as every other Sova route: one local user.

## §app.extensions/list — `GET /api/extensions`

The active manifest entries (§app.extensions/loader), in manifest order, as `ExtensionInfo`
(`shared/protocol.ts`):
`id`, `title`, `description?`, `icon?`, `status: "ok" | "down"`, `error?`, `offers?`
(§app.extensions/offers). An entry with no page adds `page: false` and one that reads Changed adds
`changed: true`; any other entry's item is byte for byte what it was. `dist` and `api` are never sent.
An entry with no `api` is `ok`, and nothing is probed. Otherwise `status` comes from `GET <api>/api/health` with a 1.5 s limit: a 2xx is `ok`;
anything else is `down` with the reason in `error`: `connection refused`, `no answer in 1.5 s`,
`health check answered HTTP 503`, or the socket error's code. Each answer is cached for 10 s per id
and api, so a manifest edit that moves the backend is probed afresh.

## §app.extensions/offers — What an extension offers

`GET /api/extensions` carries what each entry declares it offers Sova, as `offers` (since ext-contract-v1.15; v1.16 added `menu`, `row` and `card`; v1.17 added `cards` and `drawings`):
the one generic mechanism every place on Sova's screens reads, so a place asks only the extensions
that said they add to it.

- **`offers.commands`**: its valid `commands` (§app.commands/extension-commands' rules: the first 32
  read, a bad one or a second one with a taken name left out alone), each as `{name, label,
  summary?, menu?, overseer?, job?}`; `menu` is there only when it names a menu Sova knows (today `session`,
  §app.extensions/session-menu); `overseer` and `job` (v1.18) only as `true`, when the command
  declared them validly (§app.commands/extension-commands). `params` and `description` stay the
  command line's and the Overseer's.
- **`offers.screens`**: the places it adds to, from its `screens` list: only names Sova knows
  (today `reply`, §app.commands/reply-place; `row`, §app.extensions/row-chips; and `card`,
  §app.extensions/card-status), each once, the first 16 names read. An unknown name is
  left out, so a newer extension works on an older Sova.
- **`offers.cards`** and **`offers.drawings`**: its valid card types and drawing kinds
  (§app.extensions/views), each as its checked declaration, by its namespaced name.
- **Only what was declared validly.** A key with nothing valid under it is absent, and an entry with
  none of them has no `offers` at all: its list item is byte for byte what it was before v1.15.
- **Built from checked strings, never copied.** Only the fields above, from values that passed
  their rule, reach the list; nothing else in the entry (an env, a header, a token) does. Sova's
  token never appears in it.
- **This host's only.** The offers ride beside the entry, not in it, so the entries the mesh
  publishes to peers don't carry them, and a peer's listed-only entry never has any.
- **What a bad declaration costs.** Each part left out is logged once per server process; the
  entry itself always stays.
- The route keeps its mesh need (`sessions` for a read), and what a place then asks goes through
  the extension proxy, which no peer reaches below `full`.

## §app.extensions/design-css — Sova's design for extension UIs

`GET /design/tokens.css` and `GET /design/base.css` serve `src/design/` as is (`text/css`,
`Cache-Control: no-cache`), so an extension UI can link Sova's tokens and base styles at stable
URLs, not the app's hashed bundle. No other file is served there. The base classes an extension
may rely on (ext-contract-v1.14 §3.5, unchanged since) are:

- `.button` `.button-sm` `.button-icon` `.button-ghost` `.button-primary` `.button-destructive`;
- `.card`, `.cluster`, `.text-num`, `.icon` `.icon-sm`;
- `.chip` + `.chip-dot` + `.chip-success|warn|error|info`;
- `.banner` + `.banner-icon|main|title|body|action` + `.banner-info|success|warn|error`;
- `.toast-stack` `.toast` `.toast-body` `.toast-timer`;
- `.tabs` `.tab` `.tab-active`;
- `.skeleton` `.skeleton-line|row|title`;
- `.empty` `.empty-mark|title|body|action`;
- `.visually-hidden`.

The extension styles anything else itself, tables included.
Checking that list is part of any change to `base.css`'s class names.

**Following the theme is the extension's job**, and it has what it needs: a user theme is inline
custom properties on `documentElement` plus `data-theme` (§app.settings-dialog/themes), and the
iframe is same-origin. So the extension copies the parent's `data-theme` and `style.cssText` onto
its own `documentElement` at load, and again from a `MutationObserver` on the parent's `style`,
`data-theme` and `class`. A theme picked in Settings then reaches the extension at once, with no
reload.

## §app.extensions/page — The extension page (`#/ext/<id>`)

`#/ext/<id>` (a trailing slash tolerated; any id outside the manifest's alphabet is not this
route) shows the extension in the main pane, at its home. `#/ext/<id>/<sub>` shows it at its own
route `#/<sub>`. The sessions list stays beside it. At folded width it
is a main-pane page like a session (`data-view="session"`), with the back link.

- **A page head** (`.session-head`, as on Usage and Agents): back link to `#/`, the title, and a
  meta line with the status chip (`Running` in success, or `Down` in error) and the description, or
  for a `down` extension "Backend not answering: {error}". Two icon buttons: `Reload Extension`
  (reloads the iframe's document) and `Open in New Tab` (`/ext/<id>/`, `target="_blank"`). For an
  extension whose offers name the reply place, a text button before them is the user's switch for
  what it adds under replies (§app.commands/reply-slot): `Hide Under Replies`, and `Show Under
  Replies` once hidden. While Sova has muted it, the meta line adds "Hidden under replies until you
  reload: what it sent broke Sova's rules for them."
  For an extension that adds to session rows, the head also has `Hide on Session Rows` (or `Show
  on Session Rows`) before the icon buttons, and its meta line says when Sova has muted it there
  (§app.extensions/row-chips). One that adds a home card status line has `Hide on Home Card` (or
  `Show on Home Card`) the same way (§app.extensions/card-status).
- **Under it, the iframe**: `src="/ext/<id>/"`, `title` = the extension's title, filling the rest of
  the pane. It is **not sandboxed**. The extension needs Sova's origin to mirror the theme and call
  Sova's API (§app.extensions/trust). An extension that is down still loads its UI; its own API
  calls get the 502.
- **Not installed, or off.** Once the list has loaded, an id it doesn't have shows the empty state "No
  extension named “{id}” is on." / "Extensions are in Settings → Extensions. This one is off, or
  isn't on this computer's list." with `Back to Sessions`. While the list is still loading, the page
  renders with the id as its title rather than flashing that state.
- **No page, or Changed.** In place of the iframe, an entry with `page: false` says "{title} has no page
  of its own." and one with `changed: true` says "{title} changed, so its page is off until you
  approve it." with `Open Settings`, which opens Settings → Extensions.
- The list is polled every 15 s while the tab is visible. A poll never reloads the iframe.
- **Sub-routes.** The extension's own route is its iframe's hash. The page mirrors it in both
  directions:
  - The page opened at `#/ext/<id>/<sub>` loads the iframe at `/ext/<id>/#/<sub>`. A `<sub>` with
    characters outside `[A-Za-z0-9._~:%/-]` is dropped, and the extension opens at its home.
  - The extension posts `{type: "sova:route", hash}` whenever it navigates. `hash` must match
    `#/[A-Za-z0-9._~:%/-]*`; anything else is refused and logged once in the console. The page
    rewrites its own URL to `#/ext/<id>/<sub>` (`#/` → `#/ext/<id>`) with `history.replaceState`.
    That adds no history entry, fires no `hashchange` and never reloads the iframe. A reload, or a
    copied link, therefore returns to the same place inside the extension.
  - A real navigation of the page to another sub-route of the same extension (a pasted link, Back)
    sets the iframe's hash. The extension moves there without reloading.
  - The view is keyed by the id alone: no sub-route change remounts it.
  - `Open in New Tab` follows the current sub-route.
  - The iframe's own hash navigations add entries to the tab's session history, as any iframe
    navigation does, so the browser's Back steps back inside the extension.
- **Opening a session the extension created.** The extension posts
  `{type: "sova:open-session", session: <SessionSummary>}` to the parent. The page accepts it only
  when the event's origin is Sova's own AND its source is this page's iframe window. Any other
  message is ignored without a word. The session must be a whole `SessionSummary`, as
  `POST /api/sessions` returns it: every required field has its type, `path` is an absolute
  `.jsonl` path, `cwd` isn't empty, and an optional string field is a string when present. The
  list, the sidebar's sort and the view read these fields at once. An incomplete session is refused
  and logged once in the console with the reason, and it never throws. An accepted session opens exactly as New Session opens its own
  (§app/new-session-dialog): the route resolves at once, although a message-less session is not in
  the list, and the composer takes the focus. Setting `parent.location.hash` to `#/s/<path>`
  still opens a session the list already has. For a brand-new one it shows "Couldn't find this
  session", and that is why the message exists.

## §app.extensions/cards — Landing-page cards

When at least one extension is active (§app.extensions/loader), the landing page (§chat.transcript/landing-page) shows
an **Extensions** section between the opening and the Explanations card: the same section eyebrow
(`Extensions {n}`), then a grid of cards (1 column folded, 2 unfolded), one per extension in
manifest order. With none installed it renders nothing: no head, no empty state.

Each card is one link to `#/ext/<id>`: the icon (the manifest's, else `sliders`), the title, the
status chip (`Running` or `Down`, dot and word), the description, and for a `down` one the reason
in the error colour: "Its backend isn't answering: {error}.". **A down card is still a link**: the
extension's own UI may say more than the host can. Hover and a focus ring, like the Mesh and
Explanations cards.

## §app.extensions/card-status — A status line on the home card

The card's lines under its description are one place, drawn in this order: Sova's own (for a
`down` one, the reason line of §app.extensions/cards, unchanged), then one line an extension adds
about itself. An extension adds it by naming `card` in its manifest `screens`; Sova then asks
`GET /ext/<id>/api/screens/card` once each time the landing page's Extensions section is drawn
(one that comes up later, the first time a poll shows it running), never again on a later poll,
and never while it is down, off or muted. The answer is data, never
markup: `{"status": {"text": "This week: 12 h", "tone": "ok"}}`, plain text of at most 60
characters and one of the reply chips' tones (`muted` when absent). Text that reads as Sova's own words on a card (`Running`, `Down`, or starting "Its backend") is refused. A card that is down shows only Sova's reason, never the line its extension sent while running. Sova draws it as a muted line,
with a tone dot like the status chip's; anything else, an answer past 2 s, over 64 KiB, or not
HTTP 2xx, draws nothing and counts as a miss.

- **Off and mute.** The extension's page has `Hide on Home Card` / `Show on Home Card` for one that
  names `card`, kept in this browser. Three misses in a row mute it until the page reloads, and its
  page then says so. An extension that doesn't name `card` is never asked and its card is as before.

## §app.extensions/trust — What an extension can do

An extension's UI runs on Sova's origin, unsandboxed. It can read Sova's `localStorage` and call
every Sova API, including adding other extensions: Sova's refusal of a request it can tell comes from an
extension's page stops accidents, not a hostile page (§app.extensions/loader). For example, it can create a
session with `POST /api/sessions`. That is acceptable
for Sova's one local user, who approves that before it is on. Nothing loads that the user didn't approve
(§app.extensions/loader), and the
manifest holds only loopback backends. Its page keeps acting with the user's login: Sova doesn't tell it
apart from the user, but for a badge on the sends it can place (§app.extensions/page-badge). Its backend
has the same power through its own key (§app.extensions/backend-key), less what a key can't do
(§app.extensions/not-you), and every call it makes with that key is recorded as its own and speaks under
its name (§app.extensions/name-badge). None of that stops a hostile extension: its page runs on Sova's
own address and any program on this computer can read Sova's token, so installing one stays a trust
decision.
Its card views and drawing kinds in a chat's transcript are the exception: they never run on Sova's
origin, only in a sealed box walled off from Sova and the network, and they act through the view
API only once the user has trusted that extension's cards (§chat.transcript-cards/sealed-box,
§chat.transcript-cards/trust).

## §app.extensions/backend-key — Each backend's own key

Every installed extension has a key of its own, so its backend can call Sova back without the
operator's token (since `ext-contract-v1.16`).

- **Where it is.** Within a few seconds of Sova reading an entry (at start, then every 3 s while any
  extension is installed or any key is kept; with none, as soon as the manifest's file is written,
  so an idle server with nothing installed reads nothing), the key is in `<state root>/extension-keys/<file>` (`~/.pi/agent/sova/extension-keys/`), where `<file>` is
  the id in lower case, `-`, the first 8 hex digits of the sha256 of the id as written, and `.key`,
  so two ids that differ only in case never share a file: 43 base64url characters, readable only by the
  user (0600, in a 0700 folder). Sova keeps only the key's sha256, in
  `<state root>/extension-key-hashes.json`, written before the key file, and never accepts a key
  because a file holds it. A key file that no longer matches its hash (edited, or left half-made by a
  crash) is replaced with a new key at the next sync. A restart keeps every key.
- **How it is sent.** In `x-sova-token: <key>`, in the token's place, so
  `SOVA_TOKEN=$(cat <key file>) node scripts/sova.mjs …` works as is. Nowhere else: not as a cookie,
  not as `Authorization`, and `POST /api/auth/unlock` never takes it.
- **What it opens.** On the main listener, everything the token opens, sockets included (it may hold
  `/ws/events` open and run any command but those §app.extensions/not-you refuses, its own `ext.<id>.*`
  too), behind the same host and
  cross-site rules, except `/api/auth/*`, which answers `403`: a key never pairs a device, reveals the
  token or sets a cookie. It also stops at the doors that would count as the user
  (§app.extensions/not-you), and what it sends into a chat carries its extension's name
  (§app.extensions/name-badge). Full power includes starting a chat, so revoking a key stops the key, not
  what it already did.
- **Where it opens nothing.** The peer listener never reads it: a peer's request is answered by the
  peer's identity and grant alone, with or without a key. The share listener has no route it could
  open. A request proxied to an extension's backend or to a peer never carries it
  (§app.extensions/serving, §app.access/gate).
- **Only while active.** An entry has a key only while it is active (§app.extensions/loader), so one waiting
  for approval has none. Turn On writes the key before the program starts. Turn Off is revocation as
  below, and Turn On later may bring a new key.
- **A bad id is no file.** A record in the key hashes under an id no valid entry can have loses its record
  and removes no file.
- **Rotation and revocation.** Removing an entry, turning it off, renaming its id or making it invalid refuses its key
  at the next call; the key file and its hash go at the second sync in a row that reads the manifest
  whole without it (so a save that moves the file away for a moment keeps every key), which also
  closes every socket the key opened. Deleting the key file refuses the key at once; the next sync writes a new one and closes
  the old key's sockets. An id installed again after its key went (two whole reads without it) gets a new key, never
  the old one. A manifest Sova
  can't read whole (not JSON, not `version: 1`, caught mid-write) changes no key: until it reads
  whole again, its extensions' keys are refused but kept. A backend whose key was replaced reads the
  file again on a `401`.
- **Never in a page.** No answer carries a key or its hash, and `GET /ext/<id>/…` never serves a key
  file or the hash file, even with a `dist` that contains them or a link to them, symbolic or hard.
- **On the record.** Every call the main listener answers for a key is a row of the record of who ran
  what with the caller `ext:<id>` (a socket's with status 101); an `x-sova-caller` sent beside a key is
  ignored, so an extension can't pass for a chat. The Overseer can't read or match a key file (a
  `.key` name is one of its secret names), and a key's text is `[redacted]` in what its tools return. A command name the row may carry is a catalogue id
  or exactly what an extension command's id can be: `ext.<id>.<name>`, with `<id>` in the manifest's
  id alphabet and `<name>` in the command-name alphabet, so the record names every command a valid
  extension id can declare.

## §app.extensions/name-badge — A message from an extension

Since `ext-contract-v1.19`, every message an extension's key sends into a chat says whose it is: in the
chat, on the Timeline and to the model.

- **Its key names it.** `session.send` (`POST /api/sessions/prompt`) called with a key is marked as that
  extension's, where the send enters the chat, and other roads are refused (§app.extensions/not-you). The
  send button of a card that extension owns is marked the same way, whoever presses it. The id comes from the key alone and the title from its manifest entry as it is then (the id when
  it has no usable title, §app.extensions/manifest). No body field and no header can name a sender: a
  `Referer` or an `x-sova-caller` sent beside the key changes nothing, so a key can't pass for another
  extension, a chat or the user. A press's own mark carries a secret made at server start, held in memory
  and sent to no client, so no caller can send it.
- **What the model reads.** The stored text starts with the line `[from session "the extension {title},
  not this chat or its name" (ext:{id}), hop 0]`, then the extension's words. It has the same form as
  another session's line (§chat.profiles/delivery), on purpose: a chat still on older code already refuses
  a message starting `[from session ` as the user's word to land, and wouldn't refuse any other spelling.
  The quoted words say plainly that this is someone else, not the chat's own name.
- **The marker.** Once the message enters the context, the server writes the same invisible
  `sova-session-sent` entry a session's message gets, with `from: {sessionId: "ext:<id>", title}` and
  `hop: 0`. A queued one is marked when it is handed over, and one removed before that leaves no marker
  (§app.overseer/sent-marker).
- **What the user sees.** Above the message, a sender header: the `sliders` icon and "From {title}",
  with no link and no hop, because there is no session to go to. The row's author reads "From an
  extension", never "You", and its text leaves out the header line. On reload, live and while queued
  alike. The Timeline's row carries the same sender line (§chat.timeline/rows), and Inputs Only and the
  composer's input count leave it out: the user didn't type it. A linked computer's older page draws it
  as a message from a session.
- **Never the user's word.** `worktree land` refuses it, on older code too
  (§chat.worktrees/land-own-word), it never ends a chat's wait on its alignment answers
  (§chat.alignment/session-mark), and it isn't the operator speaking in a chat opened for an owner's
  request (§app.project-assistant/request-chat).
- **The limit.** An extension's message can ask that chat's agent to use `session_send`, and what the
  agent then sends arrives under that chat's mark, so it can end another chat's wait on its alignment
  answers. Sova doesn't trace an extension through an agent's relay.
- **The rest is `session.send`'s.** It starts a turn in an idle chat, and in a busy one it is a queued
  row the user can remove. A chat that refuses `session.send` (open in a terminal, archived, the
  Overseer's, a project overseer's, a baton's) refuses this too, and so do the merge queue's own chats.

## §app.extensions/not-you — What a key can't do

An extension's key never counts as the user. At each door below it is refused, whatever it carries, and
nothing changes. Only what is listed here is promised: anything else a key can do is neither closed nor
promised by this claim. This is about a key: a program holding the operator's token is a script
(§app.access/callers), and an extension's page rides the user's login (§app.extensions/page-badge). The
approvals only the user's click passes refuse a key already (§app.access/your-click).

- **The key is asked first.** After the Overseer's sender secret and the peer listener, Sova asks whether
  a request shows a key before it looks at `x-sova-caller`, so a chat's key sent beside it never turns a
  key into a chat, at any door here or in §app.access/your-click.
- **How a refusal reads.** A route below, a new chat's first prompt and `POST /api/chat/frames` answer
  `403` with `extensionRefused: true` and the sentence named here, so a backend can tell this from any
  other refusal. A socket's frame gets an `error`, code `refused`, and `POST /api/chat/action` a `409`,
  `outcome` and `code` both `refused`, each with the frame's sentence. A card's refusal is a `403` with its
  sentence, and no flag.
- **Speaking.** `session.send` is the one way a key speaks (§app.extensions/name-badge). Each of these
  says "An extension speaks through session.send, which names it. Nothing was sent." and leaves no queued
  row, no turn and nothing in the chat's draft:
  - `prompt` and `steer` frames, and `compact` with `instructions`;
  - a group send (`session.group.send`, `POST /api/session-groups/:id/prompt`);
  - a new chat's first prompt, `prompt` on `POST /api/sessions` (`session.new`): no chat is made.

  `session.send` into the merge thread or a run's reviewer is a `409`, "That is one of the merge queue's own
  chats: an extension doesn't write in it."
- **Other frames.** `ui_response`: "Only the user answers a chat's dialog. Nothing was answered."
  `rewind`: "An extension doesn't move a chat back: its messages are the user's. Nothing changed."
  `regenerate`: "An extension doesn't send a message over: its messages are the user's. Nothing changed."
- **Landing, releasing, deploying.** Through `/api/project-services/<verb>` and
  `/api/projects/:pid/services/<verb>`, every `merge.*`, `release.*` and `deploy.*` verb but those that read
  (`status`, `logs`, `deploy.check`). Merge verbs and every write under `/api/merge-queue`: "Only the user
  lands a branch or answers the merge queue. Nothing changed." Release and deploy verbs and
  `/api/updates/settings`: "That is the operator's to do. Nothing changed."
- **The user's own.** "That is the user's own to do. Nothing changed.", on any write to: `/api/mode` and
  `/api/mode/command` (turning align off would end an alignment's wait with no answer);
  `/api/session-offers/choose`; `/api/attention/dismiss`; a project's `draft-specs/:sid/approve` and
  `/build`, `setup/merge` and `runtime/merge`; a tour's `jobs/:jobId/approve` and `/approve-all`;
  `/api/schedules/revoke`; and everything under `/api/baton`, `/api/orgs`, `/api/outreach` and `/api/mesh`.
- **Settings.** "Sova's settings are the user's. Nothing changed.", on any write under `/api/settings`, and
  to `/api/push/settings`, a project's `settings/undo` and its `settings/cards/:card/withdraw`.
  `PUT /api/settings/overseer` says "An extension can't change the Overseer's settings. Nothing was saved."
- **Overseers.** "An extension doesn't write to an overseer: what it reads is the user's. Nothing changed.",
  on any write under `/api/overseer` or `/api/projects/:pid/overseer`, a project's `worktrees/merge` among
  them. `PUT /api/overseer/notes` (and so `overseer.notes.set`) says "An extension can't change the Standing
  notes: they are the user's own instructions. Nothing was saved."
- **Sova's special chats.** Every frame and chat action a key sends into an overseer's, a baton's or a merge
  queue chat: "An extension takes no action in that chat. Nothing changed." With that chat's process not
  open, `abort` and `reload_code` through `POST /api/chat/action` are no refusal: they answer `200` with
  `outcome` `stopped` or `not-running`, as for any chat that isn't open, and run nothing.
- **Cards.**
  - A key raises and changes only its own extension's types: "Nothing was raised: an extension raises only
    its own card types." and "Nothing was raised: an extension changes only its own cards."
  - `session.card.answer` with a key: "An extension answers only its own cards. Nothing was answered." On a
    button that sends or runs: "Only the user presses a button that acts. Nothing was answered."
  - A button or view on a card an extension owns, whoever presses it and however trusted it is, can't run a
    command whose route is closed above: "An extension's card can't run {label}. Nothing ran." Its send
    button goes out under that extension's name (§app.extensions/name-badge). A project's own cards are
    unchanged.
  - A card or offer beside an open alignment question leaves that chat's row a question: it stays Question
    (§app.session-list/needs-you).
- **A limit, not a door.** A key's message can ask a chat's agent to use `session_send`. What the agent then
  sends arrives under that chat's mark, not the extension's, so it can end another chat's wait on its
  alignment answers (§chat.alignment/session-mark). Sova doesn't trace an extension through an agent's relay,
  and nothing here refuses it.

## §app.extensions/page-badge — An extension's page

An extension's page keeps acting with the user's login (§app.extensions/trust). Sova doesn't try to stop
that, and the docs say so plainly.

- **A badge where Sova can tell.** A `session.send` that comes with no key and whose `Referer` is a page
  under `/ext/<id>/` of an extension this server installs is marked as that extension's, as
  §app.extensions/name-badge says. `POST /api/chat/frames`, a group send and a new chat's first prompt with
  such a `Referer` are answered as that extension's key would be (§app.extensions/not-you). The `Referer`
  must be on the request's own host, and the peer listener doesn't ask. Sova's own page never sends that `Referer`: `#/ext/<id>`
  is a hash on Sova's page, and only the iframe's document is under `/ext/<id>/`.
- **It guards against accidents only.** A page chooses its `Referer`: it can leave it out or name another
  extension, and a socket has none, so a hostile page avoids the badge. No message counts as the user's
  because it has no badge, and no badge from a page proves which extension sent it.
- **Authors send through their program.** `docs/customization.md` tells them to send from their backend
  with its key, where the name can't be left out, and never to hand the key to their page.

## §app.extensions/folder — An extension's folder

A folder is an extension when it holds a description file, `sova-extension.json`, at its root. The
folder stays where it is: Sova points at it and never copies, moves, changes or deletes it.

```json
{ "version": 1, "id": "notes", "title": "Notes", "description": "Scratch notes per project", "icon": "file",
  "needsContract": "1.20",
  "page": "dist",
  "backend": { "run": ["node", "backend/server.mjs"], "folder": "backend" },
  "commands": [], "screens": [], "cards": [], "drawings": [] }
```

- **What it says.** Required: `version: 1`, `id`, `title` and `needsContract`. All else is optional, so a
  folder can be a page alone, a program alone, or cards drawn only from Sova's own parts. `id`, `title`,
  `description` and `icon` follow §app.extensions/manifest. `commands`, `screens`, `cards` and `drawings`
  mean what they mean in a list entry, with `dist` read as `page`.
- **What it needs from Sova.** `needsContract` is the extension rules it needs, a string `"<major>.<minor>"`
  (a string because `1.20` as a number is `1.2`), compared part by part as numbers with this Sova's
  `ext-contract-v<major>.<minor>`. Higher than this Sova's is **Needs a Newer Sova**, and nothing runs.
- **What it runs.** `backend.run` is the program as words, never a shell line: the first is the program,
  the rest its arguments. `backend.folder` is the program's own code, for what approval covers
  (§app.extensions/loader); with none, that is the whole extension folder.
- **Code stays where approval can see it.** Approval never counts the folders named under
  §app.extensions/loader. So a `page` or `backend.folder` inside one of them (`data` or `logs` directly in the
  extension's folder, or a library folder at any depth), or a `run` word naming a file
  inside one, once links are followed, can't be used, while `lib/data/dist` can, and recognition says so plainly. Sova can't see what a
  program loads for itself once it runs.
- **Paths stay inside.** `page` and `backend.folder` are relative, and each must lie inside the folder once
  links are followed. A `page` must hold an `index.html`.
- **Choosing a folder names it or says why not.** A folder is read in this order, and the first thing that
  fails is the one answer, in the words of §design.copy-deck/settings-extensions: no description file; a file
  that can't be read or isn't JSON; a `needsContract` missing, malformed or too new, read first so a
  newer file says it needs a newer Sova and not that it is broken; a key it doesn't know (naming it);
  a bad `version`, `id`, `title`, `page` or `backend`; code in a folder approval doesn't count; the id `project` in any case, a namespace of Sova's
  own; an id already on this computer's list from another folder; `commands`, or `screens` naming
  anything, with no `backend`, because they need a program to answer.
- **What is left out and why.** One bad command, screen, card or drawing leaves out only itself, by the
  rules of §app.extensions/offers and §app.extensions/views, and the review says so on screen, where a
  hand-written entry's complaints only reach the server's log.
- **Reading a folder runs nothing.** It reads that one file and checks the paths it names. Review and
  Approve read it by the same rules, so a description changed to something that can't be used can't be
  approved.

## §app.extensions/loader — The list Sova writes and what you approve

The list file stays the one live source, read as §app.extensions/manifest says. Sova adds what you approve
to it, and nothing on it is live until it is approved.

- **Adding.** Install and Turn On writes one entry made from the description file: the fields it declares
  plus `folder`, and `dist`, `run`, `programFolder` and a free loopback `api` as it has a page and a
  program. It is written atomically by read, change and write, keeping other entries and every key it
  doesn't know. Install, Approve and Choose Folder each give a program a free port when it has none. A list file that can't be read whole, or is a link into a git checkout, is never written:
  the action is refused, says why, and changes nothing.
- **Two readers.** Everything that acts reads the **active** entries: serving and forwarding, the key sync,
  `GET /api/extensions`, a chat's snapshot, commands, the Overseer's commands and what the mesh publishes.
  Only Settings → Extensions reads **every entry with its state**. An entry is active when it is approved
  and on, with its folder there and no Needs a Newer Sova; Changed stays active, with its page off.
- **Approval is per version.** It covers the exact entry (all but `off`, and the port Sova assigned) and the
  **code folders**: the description file, the page folder and the program folder, every file by its bytes.
  Inside them, folders named `.git`, `node_modules`, `.worktrees` or `.agent` at any depth, `data` or `logs`
  directly in the extension's folder, and files ending `.log` never count, so data, logs, libraries and git
  history never ask again. A `data` or `logs` deeper down is code, and counts; an entry with no `folder`
  has no such top, so both count there. A file the program writes anywhere else that counts, such as
  `./state.json`, reads Changed: data belongs in `SOVA_EXTENSION_DATA_DIR` or the top `data`. A file over 4 MB
  counts by its size and time, and past 20,000 files in a folder the rest go uncounted, as at
  §app.mcp/approval. It is kept in `<state root>/extension-trust.json`, outside every repository, and never
  copies to another computer. An entry with no `folder` covers the entry and its `dist`.
- **What you approve is what you saw.** The request carries the version the review showed, and it is
  refused when the folder or entry has changed since.
- **Added or edited outside this screen.** Sova can't tell who wrote a file, so an entry it has no approval
  for, or whose list record no longer matches its approval, reads Waiting for You and runs nothing: no key,
  no serving, no commands, no cards. Its program stops. Only a change in the code folders reads Changed.
- **Already in use.** At the first start of this version, when there is no `extension-trust.json`, every valid
  entry is approved once as it stands, and the file is written even with none, so anything later waits.
- **A named list.** Only a server started with `SOVA_EXTENSIONS_FILE` set is exempt: the entries of that file
  count as approved as they appear and never read Changed, because that server's own environment named
  the file, and no chat sets it. They can still be turned off and removed. Every server started without
  the variable holds to this section whole. This is what test copies use.
- **Changed.** A background pass, about every 3 s, compares the code folders' sizes and times and hashes
  only when those moved; a request reads its last result, and no list read, served file, key check or
  forwarded call ever walks a folder. So within about 3 s of an edit the row reads Changed and its page
  stops being served. Its views stop at once (§app.extensions/views). Review, Approve, each program start and
  each new view build hash afresh, without holding up other
  requests. The running program goes on with its old code until it stops, and it won't start again until
  approved. Approving re-reads the description file into the entry, records the new version, and restarts
  the program if the extension is on. A new version with no program stops the old one. An extension that is off stays off, and while off it isn't active, though
  its row reads Changed.
- **Folder Not Found.** A folder that is gone stops the program and takes the extension out of active.
  Its entry, approval and data stay. When the folder is back unchanged, it is as it was; changed, it reads
  Changed. Choose Folder points the entry at a folder holding the same id, after the same review. A folder describing another id is refused at the pick, with no Review.
- **On at once, no restart.** Approving and turning on start the program and take effect at once: Sova
  re-reads its list per request, and this page refreshes it right away, any other page within its 15 s
  poll. The page, chips, menu rows and commands reach every chat. Cards reach new chats only: an open chat
  keeps the cards it started with (§app.extensions/views), and the screen says so.
- **Turn Off.** The entry gains `off: true`. Its program stops and its key is refused at once. Its home card,
  chips, menu rows and Overseer commands go. Its old cards say it is turned off. Its open cards leave Needs
  You and return on Turn On. Its place on the list, data and approval stay, so Turn On brings it back
  without another review unless it changed.
- **Remove.** All of Turn Off, and the entry leaves the list with its approval. Old cards show "{title} is
  no longer installed.", open cards close, and its card trust is forgotten, so another extension using
  the id later inherits nothing. The folder stays. Its data, `<state root>/extension-data/<id>`, stays
  unless **Also delete its data** is ticked, and the folder is never touched either way. Removing an entry
  whose id isn't valid only takes it off the list: no unit, cards or data folder is touched.
- **An id is never a path unless it is valid.** An id no valid entry can have (`.`, `..`, anything with a slash)
  never names a unit or a folder. One in a hand-edited `extension-trust.json` stops nothing and deletes
  nothing: only its approval is forgotten.
- **Off the list by hand.** An entry missing from two whole reads of the list in a row, about 6 s, gets
  Remove's clean-up, data kept, so a save that moves the file away for a moment closes nothing. The same id
  added again by hand waits for approval.
- **A program you run yourself.** A hand-written entry with `api` and no `run` keeps working as it did: Sova
  stops serving, forwarding and its key when it is off or removed, but the process is yours to stop, and the
  row says so.
- **Who may.** Only your own page changes any of this (§app.access/your-click). Adding, approving, Turn
  On, Turn Off, Remove, Choose Folder, and starting or stopping a program refuse a chat, a script, an
  extension's key, the Overseer and another computer, and each refusal says where to click. A request whose
  `Referer` is a page under `/ext/` is refused the same way, which stops accidents, not a hostile page
  (§app.extensions/trust). None of it is a catalogue command or an agent tool, and the only command here
  stays `extensions.list`. A chat can build an extension and send you to this screen.
- **The routes.** `GET /api/extensions/installed` is every entry with its state, version, folder and what
  it asks for, and needs `full` from another computer, since it names folders and commands;
  `GET /api/extensions/:id/log` is the same, and answers 404 unless the id is on the list or among the units.
  `POST /api/extensions/inspect` reads a folder, and with
  `POST /api/extensions/install`, `POST /api/extensions/:id/approve|folder|on|off|program` and
  `DELETE /api/extensions/:id` it answers only your own page. `GET /api/extensions` stays as it was for its
  callers (§app.extensions/list).

## §app.extensions/program — The program Sova runs

When an extension names a program, Sova runs it, on your approval: it starts, stops, watches and logs it.
It runs as you with no sandbox, and the review says so before anything is on.

- **The one start path.** It runs through the project services driver (§app.project-services/supervisor),
  systemd where the user manager answers and the detached driver elsewhere, as a unit of its own named
  `sova-ext-<state hash>-<id>`, so two copies of Sova never touch each other's. It is no instance of
  a project: it takes no slot, doesn't count toward the copy limit, isn't on Running Branches and is never
  offered as a leftover process (§app.overseer/copies).
- **Sova restarts it, not the driver.** Both drivers run it with their own restart off, so nothing can bring
  changed code back by itself. Sova's background pass restarts a failed program, at most 5 starts in
  60 s, then it stays Stopped until you press Start. It never restarts one that reads Changed.
- **What it is given.** It runs from the extension's folder, with the same small allow-listed environment
  and Sova's `PATH`, plus `PORT` (the port in its `api`), `SOVA_URL` (where to call Sova), `SOVA_EXTENSION_ID`,
  `SOVA_EXTENSION_KEY_FILE` (§app.extensions/backend-key) and `SOVA_EXTENSION_DATA_DIR`
  (`<state root>/extension-data/<id>`, made for it, kept apart by the key file's name rule when ids differ
  only in case). Sova's token is not in it. A bare program name is looked for on that `PATH`, through mise's
  shims. `node` always has an answer, `SOVA_NODE` and then Sova's own runtime, because a service's `PATH`
  often holds none. A program that can't be found reads Stopped, with the reason.
- **When it is watched.** Starting means its unit is starting, or it hasn't yet answered `GET /api/health` and
  has been up under 30 s. Running means its health check answers. Stopped means it exited or stopped
  answering, with the reason and its log, and offers **Start**. Each start clears its cached health
  (§app.extensions/list), and so does each read of a program still in its starting time, so one that answers
  reads Running within seconds, not after the cache's 10 s.
- **A Sova restart.** The program keeps running through one, and Turn Off still stops it afterwards. At each
  server start Sova brings units back to the list: an active, approved one not running is started; a Changed
  one is not; a unit whose id isn't active, or whose active entry names no program, is stopped, and the
  3 s pass stops those too. Only a start checks the version.
- **While Sova isn't running,** nothing brings a program back, with a service manager or without one (macOS
  has none here). One that stopped, at a crash or a reboot, returns when Sova starts, not by itself at
  login. The review says so.
- **The log.** **View Log** shows the unit's last lines, from the driver.
- **Names come only from a valid id.** A program's unit name and data folder refuse an id no valid entry can
  have (§app.extensions/loader).
- **Stopping Sova for good** leaves the program running, as it leaves a project's services. The docs say so
  plainly.

## §app.extensions/maximize — Maximize and restore

An extension can ask for the whole browser window, for example for a terminal. It posts
`{type: "sova:maximize"}` or `{type: "sova:restore"}` to the page. The page accepts either only
under the same checks as `sova:open-session`: Sova's own origin, and this page's iframe window as
the source. Anything else is ignored, and nothing thrown. After applying either request the page
answers `{type: "sova:maximized", on}` into the iframe. It answers even when nothing changed, so an
extension that waits for the answer never times out. An extension that gets no answer within 300 ms
is on an older host, and it maximizes inside its own iframe instead.

- **Maximized** means: the app root (`.app`) carries `data-ext-maximized="1"`; the sessions pane
  (`.app-sidebar`) and this page's head (`.ext-head`) are `display: none`, out of the layout and the
  tab order; and the iframe (`.ext-frame-max`) is `position: fixed; inset: 0` over the whole
  viewport. `data-view` stays `session`.
- **Stacking.** The iframe's `z-index` is 40. That is above the app's own chrome (the pane resizer
  at 5, the session pane at 10) and below Sova's scrim and modals (50, 51), toasts (60) and the
  skip link (100), so Sova's dialogs and toasts still show over a maximized extension.
- **It restores** on `sova:restore`, on any `hashchange` of the page (a navigation, including to
  another sub-route of the same extension), before the Reload button reloads the iframe, and when
  the view unmounts (leaving the page, another extension). The replaceState that mirrors
  `sova:route` fires no `hashchange`, so the extension's own navigation never restores.
- **No key is bound.** Esc and every other key stay with the extension. Its own control (a Restore
  button, a shortcut) is how the user leaves.
- **Browser fullscreen** is the extension's choice: the iframe carries `allow="fullscreen"` and
  `allowfullscreen`, so it may call `requestFullscreen` itself.

## §app.extensions/row-chips — Chips on a session row

Line 3 of a row in the sessions pane (§app.session-list/anatomy) is a place that Sova's own badge
and extensions both add to. Sova's merge-readiness badge (§chat.worktrees/readiness) is the place's
built-in: Sova draws it through the place, in the same spot, with the same words, title and markup
as before. The chips that extensions add come after it, then the model. With no extension that
adds to rows, every row is exactly the row it was, and the pane asks nothing.

- **Declaring one.** Since `ext-contract-v1.16`, a manifest entry may name `"row"` in its
  `screens`. `GET /api/extensions` then lists `row` in that entry's `offers.screens`.
- **Asking.** The pane asks each extension whose `status` is `ok` and whose offers name `row`,
  unless the user has hidden it or Sova has muted it. It sends `GET /ext/<id>/api/screens/row`,
  with no query, through Sova's extension proxy (§app.extensions/serving). It asks once when it has
  its session list, again when the set of such extensions or one of their titles changes, and again
  after the session list changes, at most once every 10 seconds per extension. It never sends a
  request per row.
- **The answer.** It must come within 2 seconds, as at most 1 MB of JSON keyed by session id (the
  `id` of a session in the list): `{"sessions": {"<session id>": {"chips": [ … ]}}}`. Past 2000
  sessions the rest are not read.
- **A chip** is data Sova draws. It has a `label` of at most 16 plain characters (letters, digits,
  spaces and plain punctuation), a `tone` (`ok`, `warn`, `error`, `info` or `muted`), and an
  optional `title` of at most 120 plain characters. A row chip does nothing when pressed, because
  the row is the link to its session: a chip with an `href` or an `action` is dropped. A chip whose
  label is one of Sova's own words on a row is dropped too, with case ignored: `TUI`, `Draft`,
  `restart pending`, `{n} follow-up` or `{n} follow-ups`, `{n} of {m}` (the merged count rows used to show), the
  branch status's words as a figure, any number then the words, built from the one word table the
  status and the chat's worktrees control read (§chat.composer/worktrees-control), one and many:
  `{n} needs you`, `{n} need you`, `{n} needs a fix`, `{n} need a fix`, `{n} ready`, `{n} checking`,
  `{n} queued`, `{n} worktree`, `{n} worktrees` (`1 needs you`, `2 ready`, `3 worktrees`), the
  worktree state words (`merged`, `stale`, `in progress`, `blocked`, `ready to merge`, `waiting for
  your OK`, `removed`), and the host mark's state words (`read only`, `display may be wrong`, `update
  needed`, `down`, `refused`, `hidden`, §mesh.compatibility/marks). Other keys are ignored.
- **How many.** One chip from each extension on a row, and at most 2 on a row, from the extensions
  in manifest order.
- **Drawing.** Each chip follows a ` · ` in the meta line's own muted voice. It has a dot in its
  tone's colour (the meta's muted colour for `muted`) and then the label, and it never wraps. Its
  tooltip is its `title`, or else its label, followed by " · From {extension title}". Its accessible
  name is "{label}, from {extension title}". Chips show only on rows of sessions on this machine:
  an extension belongs to this host.
- **Bad answers.** An answer that is late, malformed, too large or not a 2xx is dropped whole, and
  the extension's last good answer stays drawn. An answer with any part dropped counts as bad, and
  the rest of it is drawn. After 3 bad answers in a row, the pane stops asking that extension and
  draws none of its chips until the page reloads. Its extension page then says "Hidden on session
  rows until you reload: what it sent broke Sova's rules for them."
- **The user's switch.** The page of an extension that adds to rows has `Hide on Session Rows`,
  which becomes `Show on Session Rows` while hidden. The choice is kept in this browser. While an
  extension is hidden, the pane asks it nothing and draws none of its chips.

## §app.extensions/session-menu — Entries in a session row's menu

The menu of a row on the Agents board (§app.insights/team-cards) is a place that Sova's own
items and extensions both add to. Sova's items come first, in their groups and order, as they
were. Copy Path, the menu's last item, is the place's built-in: Sova draws it through the place,
in the same spot. After Sova's items come the groups that extensions add.

- **Declaring one.** Since `ext-contract-v1.16`, a command in a manifest entry's `commands` may
  carry `"menu": "session"`.
  `GET /api/extensions` then lists it in `offers.commands` with `menu: "session"`. Any other value
  of `menu` is left out, with a log line once per server process. The command itself stays, so the
  command line still runs it. A command without `menu` is listed as before, with no `menu` key.
- **The rows.** Each extension with an entry to show gets one group after Copy Path, in manifest
  order. The group is headed by the extension's title and named by it. It holds that extension's
  entries in declared order. The menu shows at most 8 extension rows in all. An entry whose
  label is a reserved name is left out of the menu: the name of one of Sova's own items in this
  menu (Session Details, Close Session Details, Rename…, Use Gist as Title, Reset
  to Original Title, Move to Group…, Archive, Unarchive, Copy Path), or Open Session, which stays
  reserved though the menu no longer has it (the row's title link opens the session). Open Subagents is not reserved:
  reserved labels stop an extension's row colliding with a Sova row, and no Sova row uses that name now. A reserved entry is left out with case, spacing and a trailing
  "…" ignored; the command itself stays. A row shows the
  command's `label`, with its `summary` as the line under it when it has one. Its tooltip is the
  label followed by "· From {extension title}", and its accessible name says the same and names
  the session.
- **When rows show.** A row shows only when its extension's `status` is `ok`, so a backend that
  is down hides its rows until a later poll finds it up. A session on another host never shows
  any, because an extension belongs to this host. With no entry to show, the menu has no group and
  is exactly the menu as it was. The place reads the extension list the page already polls, so it
  makes no request of its own until a row is run.
- **Running a row.** It sends `POST /ext/<id>/api/commands/<name>` with `{"session": <session
  id>}`, through Sova's extension proxy (§app.extensions/serving), the same path a reply chip's
  action takes. A 2xx answer toasts "Sent to {extension title}." A non-2xx answer toasts "{extension
  title} answered HTTP {status}." No answer, or none within 10 seconds, toasts "{extension title}
  isn't answering." Each toast is
  also announced to screen readers.

## §app.extensions/views — Card types and drawing kinds in chat transcripts

Since `ext-contract-v1.17`, an entry may declare transcript card types and drawing kinds
(§chat/transcript-cards). Both are additions: an entry without them, and an older extension, sees no
change.

- **`cards`**: up to 16 card types, each `{name, title, when?, draws, data?, answer?, placement?,
  height?, view?, toolkit}`, with the meanings and rules of a project's `card.json`
  (§chat.transcript-cards/files), except that `view` is the path, inside the entry's `dist`, of the
  extension's built view module (an ES module built against the toolkit version `toolkit` names,
  §chat.transcript-cards/versions). Its type is `<extension id>.<name>`.
- **`drawings`**: up to 8 drawing kinds, each `{name, accepts, data?, height?, view, guide,
  toolkit}`, as a project's kind (§chat.transcript-cards/drawing-kinds), with `view` and `guide`
  (a markdown file) as paths inside `dist`. Its fence word is `<extension id>.<name>`.
- **Checked one at a time.** Each declaration is validated on its own; a bad one (an unknown key, a
  bad name, a missing or out-of-bounds field, a second one of the same name, one past the limit, a
  `view` or `guide` path outside `dist` or missing) is left out and logged once per server process,
  and never drops the entry or its other declarations. An extension whose id is `project` (in any
  case) declares none: that is the namespace of a project's own cards and kinds.
- **Run only in the sealed box.** Sova bundles a view module from `dist` with its own toolkit and
  `solid-js` and the files beside it (§chat.transcript-cards/building), and watches them, so a
  rebuilt view redraws its cards (§chat.transcript-cards/redraw); it runs only in a sealed box,
  never on Sova's origin (§chat.transcript-cards/sealed-box). A backend's key file is never served
  this way.
- **Fixed per chat.** A chat's snapshot takes the declarations of the extensions active when it
  starts, after the project's own, each name once (§chat.transcript-cards/files). So one turned on
  reaches new chats, and an open chat keeps the cards it started with. The merge queue's own chats take no
  card types of an extension (§chat.transcript-cards/queue-chats). A card or drawing
  whose extension is no longer on the list shows its error box, "{title} is no longer installed."
  While it is on the list but not active, the box reads "{title} is turned off." when it is Off, and
  otherwise "{title} can't run right now. Settings → Extensions says why."
- **While it reads Changed**, an open chat's and a new chat's cards keep the declarations you approved,
  and its views stop, because new code never runs unseen. A card or drawing drawn by its view shows the plain
  state "{title} changed and is waiting for your approval." until it is approved, then draws again on its
  own. No view of it is built or handed to a page and none of its view API answers. A new build is handed
  over only after a fresh check finds its code folders approved, so an edited view never runs, not even in
  the seconds before the row reads Changed; a request for a build already checked walks no folder. A data
  card runs none of its code and is unchanged.
- **Its own trust.** Its cards ask to act, and are trusted, by its id, apart from any project's
  (§chat.transcript-cards/trust); its page says so while they are, with **Stop Trusting Cards**.
