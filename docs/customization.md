# Make Sova yours

[← Sova](../README.md)

## Themes and type

Choose a built-in theme in **Settings → Themes**, or save a JSON file in
`~/.pi/agent/sova/themes/`. While the Themes tab is open, the picker refreshes every 2 seconds—no
rebuild or restart.

For example, save this as `desk-lamp.json`:

```json
{
  "$schema": "sova-theme/v1",
  "name": "Desk Lamp",
  "extends": "dark",
  "vars": { "amber": "#ffb454" },
  "colors": {
    "accent": "$amber",
    "accent-hover": "#ffc46e",
    "accent-tint": "#3a2f1c"
  }
}
```

Use `extends: "dark"` or `"light"`; omitted values come from that base. `vars` defines reusable
values, referenced as `"$name"`. See the [built-in themes](../themes/) for examples and
[shared/theme.ts](../shared/theme.ts) for supported color and typography keys.

Optional `typography` values can select font stacks already available on the machine displaying
the app; a theme does not bundle font files. Invalid values appear with an error in the picker
rather than being applied.

A custom theme with the same id as a built-in replaces it. If a theme becomes unreadable, fix or
remove its file and reopen Settings → Themes. For a browser-side reset, clear `sova:theme` from
local storage, then reload.

## Model choices

**Settings → Models** controls which providers and models are enabled, and which may be assigned
to subagents. Disabling a model prevents its use in Sova; it does not silently substitute another
model in an existing chat. Select an enabled model to continue.

The policy is saved in `~/.pi/agent/model-policy.json`. The optional
[model-policy extension](../pi-config/extensions/model-policy/README.md) enforces the same global
restrictions in the terminal. Model favorites are read from the command palette's
`~/.pi/agent/model-favorites.json`.

## Optional extensions

Parallel web sessions, shared prompts, branching, and transcript browsing are Sova features.
Worker teams, terminal presence, and remote tool execution require the corresponding pi extensions.
The Sova installer does **not** activate the bundled configuration.

| Extension | What it adds |
| --- | --- |
| [sessions](../pi-config/extensions/sessions/README.md) | Terminal presence and live worker counts |
| [subagents](../pi-config/extensions/subagents/README.md) | Background workers and coordinated teams, visible with their transcripts |
| [remote](../pi-config/extensions/remote/README.md) | Tool execution on your SSH, AWS SSM, Docker, or Incus targets |
| [usage-status](../pi-config/extensions/usage-status/) | Subscription and spend meters |
| [mode](../pi-config/extensions/mode/README.md) | Per-session modes in the composer |
| [explain](../pi-config/extensions/explain/README.md) | Saved HTML explanations browsable from Sova |
| [topic-outline](../pi-config/extensions/topic-outline/README.md) | Conversation chapters in the outline strip |

Read each extension's setup instructions and dependencies before enabling it. Remote sessions
require your own reachable targets and credentials; configure `~/.pi/agent/targets.json` as
described in the remote guide. Tools run on the target, not through a local filesystem mount.

The [pi-config bundle](../pi-config/README.md) can install the complete setup, but it is **not a
prerequisite for Sova**. Its `install.sh` links configuration and extensions into your agent
directory, replacing existing symlinks and backing up regular files. Review it and back up your
configuration before opting in. For the default Sova installation, the script is at
`~/.local/share/sova/pi-config/install.sh`; do not run it merely to launch the web app.

## Sova extensions

A Sova extension is a small web app of your own that runs inside Sova: a card on the landing page,
and a page at `#/ext/<id>` that shows the extension's UI beside the sessions list. Unlike the pi
extensions above, it adds nothing to the agent. It is a built UI (a folder with an `index.html`)
plus a backend you run yourself, on this machine.

Install one by listing it in `~/.pi/agent/sova/extensions.json` (set `SOVA_EXTENSIONS_FILE` to use
another file). Sova reads the file on every request and never writes it:

```json
{
  "version": 1,
  "extensions": [
    {
      "id": "notes",
      "title": "Notes",
      "description": "Scratch notes per project",
      "icon": "file",
      "dist": "/home/you/notes-ext/dist",
      "api": "http://127.0.0.1:4840"
    }
  ]
}
```

- `id`: letters, digits, `.`, `_` and `-`; it appears in URLs. `title` is the card title (the
  id if omitted), `description` its body, `icon` one of Sova's icon names in `public/icons/`.
- `dist`: an absolute folder. Sova serves it at `/ext/<id>/`. A path without a file extension
  falls back to `index.html`, so client-side routes work.
- `api`: the backend, `http://` or `https://` on `127.0.0.1` or `localhost` with an explicit port and an optional
  path prefix, without a trailing slash. `/ext/<id>/api/*` is proxied to `<api>/api/*` and
  `/ext/<id>/ws/*` (WebSockets) to `<api>/ws/*`. A backend that can't be reached answers
  `502 {"error":"extension down","id":"<id>"}`. A streamed response must send something at
  least every 60 seconds, or the connection may be cut.

An entry with a bad `id`, a relative `dist` or an `api` that isn't loopback is skipped, and the
server logs why. The card shows `Running` when `GET <api>/api/health` answers 2xx within 1.5 s
(checked at most every 10 s), and `Down` with the reason otherwise. A card for an extension that
is down still opens its page.

The UI is served from Sova's own origin, so it can call every Sova API (for example
`POST /api/sessions`) and read Sova's local storage, riding the browser's Sova cookie. Install
only extensions you trust.

Proxied requests carry `X-Sova-Origin`, the address the backend can use to call Sova back. They
never carry Sova's own credential or any extension's key: Sova's `sova_token_*` cookies,
`x-sova-token` and an `Authorization` holding Sova's token or an extension's key are dropped on the
way to the backend (other cookies and headers, the extension's own `Authorization` included, pass
through).

### Your backend's key (extension contract v1.16)

Each installed extension has a key of its own, which its backend uses to call Sova back. Within a few
seconds of Sova reading your entry, the key is in
`~/.pi/agent/sova/extension-keys/<file>` (or under `$PI_CODING_AGENT_DIR/sova/`). Only your user can
read it. `<file>` is your id in lower case, `-`, the first 8 hex digits of the SHA-256 of your id as
written, and `.key`, so `notes` is `notes-` plus the first 8 hex of `sha256("notes")` plus `.key`:

```sh
id=notes; f="$(printf %s "$id" | tr A-Z a-z)-$(printf %s "$id" | sha256sum | cut -c1-8).key"
key=$(cat ~/.pi/agent/sova/extension-keys/"$f")   # macOS: shasum -a 256 for sha256sum
```

Send it as `x-sova-token: <key>`, as you would the token. `sova` from a Sova checkout takes it the
same way: `SOVA_TOKEN=$key node scripts/sova.mjs list` (or `run <id>`, or `watch`).

- It opens what the token opens, sockets included, behind the same host and cross-site checks. Your
  backend can run any of Sova's commands, keep `/ws/events` open to hear what happens (a rename, a
  turn that ends), and run its own `ext.<id>.*` actions. The only exception is `/api/auth/*`, which
  answers `403`: a key never pairs a device, reveals the token or unlocks a browser.
- Sova accepts it only in that header: never as a cookie and never as an `Authorization`.
- Every call your backend makes with it is recorded as `ext:<id>` in Sova's record of who ran what
  (`node scripts/sova.mjs run audit.list --caller ext:<id>`). `x-sova-caller` is ignored beside it.
- **Rotate** it by deleting the file: Sova refuses the old key at once and writes a new one within a
  few seconds. **Uninstall** (remove the entry, or change its id) and the key is refused at once. Its
  file goes once Sova has found the entry missing twice in a row (within about 6 seconds), and so
  does every socket it opened. A manifest that Sova can't read whole (a typo, a save caught
  half-written) or that is gone for a moment refuses your key while it lasts but never replaces it.
- Sova may also replace a key on its own, for example after a crash left the file half-written. So on
  a `401`, read the file again before you give up, and retry with what it holds.
- Sova never puts the key in a page, an answer or a proxied request, and never serves it from a
  `dist`. Do the same: never hand the key to your extension's page, never put it in a response or a
  log, and keep it out of your `dist`. Sova can't enforce that for you. Full power includes starting
  a chat, so revoking a key stops the key, not what it already did.

Reading Sova's token instead still works as before: `x-sova-token: <token>` from the `SOVA_TOKEN`
environment variable or the token file, `~/.pi/agent/sova/auth-token` (where the installer's launcher
is present, `sova token` prints it; from the Sova checkout, `pnpm run auth:token` does). Those calls
are not recorded as your extension's.

An entry may also list actions of its own under `commands`, for the command line in a Sova
checkout (`node scripts/sova.mjs list` shows them) and for what it adds under replies (below):

```json
"commands": [
  { "name": "snapshot", "label": "Take Snapshot", "summary": "Saves the current notes",
    "params": { "note": { "type": "string", "description": "A note", "required": true } } }
]
```

Each is listed as `ext.<id>.<name>`, and `node scripts/sova.mjs run ext.notes.snapshot --note hi`
sends `POST /ext/<id>/api/commands/<name>` with `{"note":"hi"}` through the proxy above, so your
backend answers it at `<api>/api/commands/<name>`. `name` is lowercase letters, digits and `-`;
a param's `type` is `string`, `number`, `integer`, `boolean`, `array` or `object`. A command that
isn't valid is left out on its own. The running Sova also serves the list, yours included, at
`GET /api/commands` (this machine only); it lists your commands only while your entry is one it
installs, and it never calls your backend to answer.

What an entry offers is in `GET /api/extensions` as its `offers` field (since extension contract
v1.15):
`commands` as `{name, label, summary?}` and `screens`, each only when something valid is declared.
An entry that declares neither has no `offers` field, as before.

**Under replies.** With `"screens": ["reply"]`, Sova shows what your backend says under the replies
of a chat on this machine, after Sova's own buttons. It asks once when the chat opens, once when a
run ends, and after one of your actions ran, never once per reply:
`GET /ext/<id>/api/screens/reply?session=<session id>`, through the proxy. Answer within 2 seconds,
with at most 1 MB of JSON keyed by entry id: the reply's `id` in the session file, which is a
transcript row's `id` up to its first `:`:

```json
{ "entries": {
    "<entry id>": {
      "chips": [ { "label": "2 unverified claims", "tone": "warn", "href": "https://…" },
                 { "label": "Create Issue", "tone": "info", "icon": "external", "action": "create",
                   "confirm": "File this reply as an issue?" } ],
      "content": { "html": "<p>Lint report</p>", "height": 64 } } } }
```

- A chip is data Sova draws: a label of at most 24 plain characters, a `tone` (`ok`, `warn`,
  `error`, `info` or `muted`), an optional Sova icon name, and either an `http(s)` `href` (opened in
  a new tab) or an `action`, one of your declared `commands`. Sova asks the `confirm` sentence, if
  any, then sends `POST /ext/<id>/api/commands/<action>` with `{"session", "entry"}`. At most 3 chips
  from one extension and 6 under one reply. A label that is one of Sova's own button names is dropped.
- `content` is a picture: drawn in a frame with no scripts, no network, no pointer and no focus,
  32 to 320 px high, at most 64 KB.
- A late, malformed or oversized answer is dropped. After 3 in a row Sova stops asking until the
  page reloads. The user can hide what an extension adds from its page (`Hide Under Replies`).

**In a session's ⋯ menu** (extension contract v1.16). A command with `"menu": "session"`
is also an entry in the ⋯ menu of each Agents board row for a session on this machine, after
Sova's own items, under a heading with your extension's title:

```json
"commands": [ { "name": "file", "label": "File Issue", "summary": "Opens an issue for it", "menu": "session" } ]
```

- The row shows `label`, with `summary` under it, and its tooltip says `File Issue · From
  <title>`. Choosing it sends `POST /ext/<id>/api/commands/<name>` with `{"session": "<session
  id>"}` through the proxy, and Sova tells the user `Sent to <title>.` on a 2xx answer, or the
  HTTP status, or that your backend isn't answering (no answer within 10 seconds counts as none).
- `menu` takes only `"session"`. Any other value leaves the command out of the menu (logged once),
  never out of `commands`. The menu shows at most 8 extension rows in all, first extensions first.
  A `label` that is one of Sova's own item names in that menu (`Archive`, `Copy Path`, `Rename…`
  and the rest; case, spacing and a trailing `…` are ignored) is left out of the menu too.
- While your backend's health check fails, your rows are hidden.

**On session rows** (extension contract v1.16). With `"screens": ["row"]`, Sova shows what your
backend says on line 3 of the rows in the sessions pane, after Sova's own merge-readiness badge and
before the model. It asks for the whole list at once, never once per row: when the pane has its
list, when your extension appears or its title changes, and again after the list changes, at most
once every 10 seconds: `GET /ext/<id>/api/screens/row`, with no query, through the proxy. Answer
within 2 seconds, with at most 1 MB of JSON keyed by session id (a session's `id` in the list):

```json
{ "sessions": {
    "<session id>": { "chips": [ { "label": "CI green", "tone": "ok", "title": "All 12 checks passed" } ] } } }
```

- A row chip is data Sova draws as text: a `label` of at most 16 plain characters, a `tone` (`ok`,
  `warn`, `error`, `info` or `muted`) shown as a dot before the label, and an optional `title` of
  at most 120 plain characters for its tooltip, which ends `· From <title>`. It does nothing when
  pressed (the row opens its session), so a chip with an `href` or an `action` is dropped. A label
  that is one of Sova's own words on a row (`TUI`, `Draft`, `restart pending`, `2 follow-ups`, `2 of 3`, a
  worktree state such as `merged` or `ready to merge`, a host state such as `down` or `hidden`) is
  dropped too.
- One chip from your extension on a row, at most 2 on a row from every extension, first extensions
  first. Only rows of sessions on this machine show chips.
- A late, malformed or oversized answer is dropped, and your last good answer stays drawn. After 3
  bad answers in a row Sova stops asking until the page reloads. The user can hide your chips from
  your extension's page (`Hide on Session Rows`), kept apart from `Hide Under Replies`.

**On your home card** (extension contract v1.16). With `"screens": ["card"]`, your card on the
landing page gets one status line, under Sova's own (the reason a down card gives). Sova asks
`GET /ext/<id>/api/screens/card` through the proxy once each time the Extensions section is drawn,
never on a later poll, and draws what you answer as data:

```json
{ "status": { "text": "This week: 12 h", "tone": "ok" } }
```

- `text` is at most 60 plain characters (no `<`, `>`, quotes, `&` or backticks); `tone` is a reply
  chip's (`ok`, `warn`, `error`, `info`, `muted`; `muted` when left out). No `status`: no line.
- Answer within 2 seconds, with at most 64 KB. A late, malformed or oversized answer draws nothing;
  after 3 in a row Sova stops asking until the page reloads. The user can hide the line from your
  page (`Hide on Home Card`). While your backend is down, Sova doesn't ask.

To open a session the extension just created, hand it to Sova rather than setting the page's
hash. A new session has no messages yet, so it isn't in Sova's list, and `#/s/<path>` would find
nothing:

```js
const res = await fetch("/api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ cwd }),
});
const session = await res.json(); // 201: a SessionSummary
window.parent.postMessage({ type: "sova:open-session", session }, location.origin);
```

Sova accepts the message only from its own origin and from the extension's own frame. `session`
must be the whole `SessionSummary` that `POST /api/sessions` returned, not just its path. An
incomplete one is ignored, and the browser console logs why. Sova opens an accepted session the
way New Session does, with the composer focused. A session that is already in the list
can still be opened with `window.parent.location.hash = "#/s/" + encodeURIComponent(path)`.

To match Sova's look, link `/design/tokens.css` and `/design/base.css`. To follow the theme the
user picks, copy the parent page's theme when the page loads, and again whenever it changes:

```js
const copy = () => {
  const from = parent.document.documentElement, to = document.documentElement;
  const theme = from.getAttribute("data-theme");
  theme ? to.setAttribute("data-theme", theme) : to.removeAttribute("data-theme");
  to.style.cssText = from.style.cssText;
};
copy();
new MutationObserver(copy).observe(parent.document.documentElement,
  { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
```

The extension's own route (its page's hash) can be part of Sova's URL. Post
`{ type: "sova:route", hash: location.hash || "#/" }` to the parent whenever it changes, and Sova
shows `#/ext/<id>/<route>`. A link like that opens the extension at `/ext/<id>/#/<route>`. To use
the whole browser window, post `{ type: "sova:maximize" }`, and `{ type: "sova:restore" }` to leave.
Sova hides its sidebar and the page head, then answers `{ type: "sova:maximized", on }`. It binds no
key, so the extension provides its own way out. Sova also restores the page when the user
navigates. The iframe may use `requestFullscreen`.

The classes an extension can rely on from `base.css`:

- buttons: `.button`, with `.button-sm`, `.button-icon`, `.button-ghost`, `.button-primary` or
  `.button-destructive`;
- `.card`, `.cluster`, `.text-num`;
- icons: `.icon` and `.icon-sm`;
- status chips: `.chip` with `.chip-dot` and `.chip-success`, `-warn`, `-error` or `-info`;
- banners: `.banner` with `.banner-icon`, `-main`, `-title`, `-body` and `-action`, and
  `.banner-info`, `-success`, `-warn` or `-error`;
- toasts: `.toast-stack`, `.toast`, `.toast-body`, `.toast-timer`;
- tabs: `.tabs`, `.tab`, `.tab-active`;
- skeletons: `.skeleton` with `.skeleton-line`, `-row` or `-title`;
- empty states: `.empty` with `.empty-mark`, `-title`, `-body` and `-action`;
- `.visually-hidden`.

Style anything else, tables included, yourself.
