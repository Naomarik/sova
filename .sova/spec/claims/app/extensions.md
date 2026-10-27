# §app/extensions — Extensions
> Part of the Sova design spec · [overview](../design/overview.md)

An extension is a small web app the user installs into Sova: a built UI (a folder with an
`index.html`) and a backend the user runs on this machine. Sova shows it as a card on the landing
page and as a page at `#/ext/<id>`, serves its UI and forwards its API and sockets from Sova's own
origin, and knows nothing about what it does. The host is generic: no extension is named, special
cased or shipped by Sova. The interface is `ext-contract-v1.16`; any change to it is a version bump
agreed with the extensions built on it. v1.15 added what an extension offers (§app.extensions/offers)
and what it adds under replies (§app.commands/reply-slot). v1.16 added each backend's own key
(§app.extensions/backend-key), a command's `menu` key (§app.extensions/session-menu), and the `row`
and `card` places (§app.extensions/row-chips, §app.extensions/card-status). An extension that
declares none of them sees no change.

## §app.extensions/manifest — The manifest

The installed extensions are listed in one JSON file, `<state root>/extensions.json`
(`~/.pi/agent/sova/extensions.json`), or the file `SOVA_EXTENSIONS_FILE` names (a second instance
sharing the agent dir points at its own). **Sova never writes it**: the user or an extension's
installer does.

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
  dropped when `id` isn't `[A-Za-z0-9._-]+` (or is `.` or `..`), `dist` isn't an absolute path, or
  `api` isn't `http(s)://127.0.0.1|localhost:<port>` with an explicit port and an optional path
  prefix, with no trailing slash, credentials, query or fragment. A second entry with an id already
  taken is dropped. Each distinct complaint is logged once per server process, not per request.
- **Optional fields fall back quietly.** No `title` → the id. `description` is omitted when empty.
  An `icon` that isn't a plain icon name (`[a-z0-9-]+`, a file in `public/icons/`) is ignored,
  because it ends up in a CSS `url()`. Unknown keys are ignored.
- **`commands` and `screens` are what it offers.** An entry may list its own actions under
  `commands` (§app.commands/extension-commands) and the places on Sova's screens it adds to under
  `screens`. The server validates both into the list's `offers` field (§app.extensions/offers); a
  bad one never drops the entry. The `sova` command line reads `commands` from this file itself.

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
text `Unknown extension` on the UI paths. A UI path whose file is, once links are followed, a
backend key file or the key hash file (§app.extensions/backend-key) is a 404 too.

- **HTTP forwarding** (`hono/proxy`). Every request header goes along except `host` (the backend
  sees its own), the hop-by-hop headers and Sova's own credential (every `sova_token_*` cookie,
  `x-sova-token`, which is also where an extension's key rides, a chat's key in `x-sova-caller`,
  and an `Authorization` carrying the token or any extension's key), plus
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

The valid manifest entries, in manifest order, as `ExtensionInfo` (`shared/protocol.ts`):
`id`, `title`, `description?`, `icon?`, `status: "ok" | "down"`, `error?`, `offers?`
(§app.extensions/offers). `dist` and `api` are never sent. `status` comes from `GET <api>/api/health` with a 1.5 s limit: a 2xx is `ok`;
anything else is `down` with the reason in `error`: `connection refused`, `no answer in 1.5 s`,
`health check answered HTTP 503`, or the socket error's code. Each answer is cached for 10 s per id
and api, so a manifest edit that moves the backend is probed afresh.

## §app.extensions/offers — What an extension offers

`GET /api/extensions` carries what each entry declares it offers Sova, as `offers` (since ext-contract-v1.15; v1.16 added `menu`, `row` and `card`):
the one generic mechanism every place on Sova's screens reads, so a place asks only the extensions
that said they add to it.

- **`offers.commands`**: its valid `commands` (§app.commands/extension-commands' rules: the first 32
  read, a bad one or a second one with a taken name left out alone), each as `{name, label,
  summary?, menu?}`; `menu` is there only when it names a menu Sova knows (today `session`,
  §app.extensions/session-menu). `params` stay the command line's.
- **`offers.screens`**: the places it adds to, from its `screens` list: only names Sova knows
  (today `reply`, §app.commands/reply-place; `row`, §app.extensions/row-chips; and `card`,
  §app.extensions/card-status), each once, the first 16 names read. An unknown name is
  left out, so a newer extension works on an older Sova.
- **Only what was declared validly.** A key with nothing valid under it is absent, and an entry with
  neither has no `offers` at all: its list item is byte for byte what it was before v1.15.
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
- **Not installed.** Once the list has loaded, an id it doesn't have shows the empty state "No
  extension named “{id}” is installed." / "Extensions come from Sova's extensions manifest, and
  this one isn't in it." with `Back to Sessions`. While the list is still loading, the page
  renders with the id as its title rather than flashing that state.
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

When at least one extension is installed, the landing page (§chat.transcript/landing-page) shows
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
every Sova API. For example, it can create a session with `POST /api/sessions`. That is acceptable
for Sova's one local user. Nothing loads that the user didn't list in the manifest, and the
manifest holds only loopback backends. Its backend has the same power through its own key
(§app.extensions/backend-key), and every call it makes with that key is recorded as its own.

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
  `/ws/events` open and run any command, its own `ext.<id>.*` too), behind the same host and
  cross-site rules, except `/api/auth/*`, which answers `403`: a key never pairs a device, reveals the
  token or sets a cookie. Full power includes starting a chat, so revoking a key stops the key, not
  what it already did.
- **Where it opens nothing.** The peer listener never reads it: a peer's request is answered by the
  peer's identity and grant alone, with or without a key. The share listener has no route it could
  open. A request proxied to an extension's backend or to a peer never carries it
  (§app.extensions/serving, §app.access/gate).
- **Rotation and revocation.** Removing an entry, renaming its id or making it invalid refuses its key
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
  `restart pending`, `{n} follow-up` or `{n} follow-ups`, the worktree count `{n} of {m}`, the
  worktree state words (`merged`, `stale`, `in progress`, `blocked`, `ready to merge`, `waiting for
  your OK`, `removed`), and the host mark's state words (`down`, `refused`, `hidden`, `other
  version`). Other keys are ignored.
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

## §app.extensions/session-menu — Entries in a session's ⋯ menu

The ⋯ menu of a row on the Agents board (§app.insights/team-cards) is a place that Sova's own
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
  menu (Session Details, Close Session Details, Open Subagents, Rename…, Use Gist as Title, Reset
  to Original Title, Move to Group…, Archive, Unarchive, Copy Path), or Open Session, which stays
  reserved though the menu no longer has it (the row's title link opens the session). It is left out with case, spacing and a trailing
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
