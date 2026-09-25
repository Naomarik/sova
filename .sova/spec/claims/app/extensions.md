# §app/extensions — Extensions
> Part of the Sova design spec · [overview](../design/overview.md)

An extension is a small web app the user installs into Sova: a built UI (a folder with an
`index.html`) and a backend the user runs on this machine. Sova shows it as a card on the landing
page and as a page at `#/ext/<id>`, serves its UI and forwards its API and sockets from Sova's own
origin, and knows nothing about what it does. The host is generic: no extension is named, special
cased or shipped by Sova. The interface is `ext-contract-v1.14`; any change to it is a version bump
agreed with the extensions built on it.

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
text `Unknown extension` on the UI paths.

- **HTTP forwarding** (`hono/proxy`). Every request header goes along except `host` (the backend
  sees its own) and the hop-by-hop headers, plus `X-Forwarded-Host` (the host the browser used) and
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
`id`, `title`, `description?`, `icon?`, `status: "ok" | "down"`, `error?`. `dist` and `api`
are never sent. `status` comes from `GET <api>/api/health` with a 1.5 s limit: a 2xx is `ok`;
anything else is `down` with the reason in `error`: `connection refused`, `no answer in 1.5 s`,
`health check answered HTTP 503`, or the socket error's code. Each answer is cached for 10 s per id
and api, so a manifest edit that moves the backend is probed afresh.

## §app.extensions/design-css — Sova's design for extension UIs

`GET /design/tokens.css` and `GET /design/base.css` serve `src/design/` as is (`text/css`,
`Cache-Control: no-cache`), so an extension UI can link Sova's tokens and base styles at stable
URLs, not the app's hashed bundle. No other file is served there. The base classes an extension
may rely on (ext-contract-v1.14 §3.5) are:

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
  (reloads the iframe's document) and `Open in New Tab` (`/ext/<id>/`, `target="_blank"`).
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
an **Extensions** section between the opening and the Explained grid: the same section eyebrow
(`Extensions {n}`), then a grid of cards (1 column folded, 2 unfolded), one per extension in
manifest order. With none installed it renders nothing: no head, no empty state.

Each card is one link to `#/ext/<id>`: the icon (the manifest's, else `sliders`), the title, the
status chip (`Running` or `Down`, dot and word), the description, and for a `down` one the reason
in the error colour: "Its backend isn't answering: {error}.". **A down card is still a link**: the
extension's own UI may say more than the host can. Hover and a focus ring, like the Explained
tiles.

## §app.extensions/trust — What an extension can do

An extension's UI runs on Sova's origin, unsandboxed. It can read Sova's `localStorage` and call
every Sova API. For example, it can create a session with `POST /api/sessions`. That is acceptable
for Sova's one local user. Nothing loads that the user didn't list in the manifest, and the
manifest holds only loopback backends.

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
  at 5, the subagents pane at 10) and below Sova's scrim and modals (50, 51), toasts (60) and the
  skip link (100), so Sova's dialogs and toasts still show over a maximized extension.
- **It restores** on `sova:restore`, on any `hashchange` of the page (a navigation, including to
  another sub-route of the same extension), before the Reload button reloads the iframe, and when
  the view unmounts (leaving the page, another extension). The replaceState that mirrors
  `sova:route` fires no `hashchange`, so the extension's own navigation never restores.
- **No key is bound.** Esc and every other key stay with the extension. Its own control (a Restore
  button, a shortcut) is how the user leaves.
- **Browser fullscreen** is the extension's choice: the iframe carries `allow="fullscreen"` and
  `allowfullscreen`, so it may call `requestFullscreen` itself.

