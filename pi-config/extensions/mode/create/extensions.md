# extensions: your own page, buttons and cards inside Sova

Say both of these before the person agrees. They must keep its backend running themselves, because Sova never starts it. And it has full access inside the page: its page runs on Sova's own address, unsandboxed, and can read Sova's browser storage and call every Sova request. What it does there passes as the person's own click, so installing one is a trust decision (`safety`).

Offer a lighter way first when one would do: a custom theme for looks (`appearance`), a project's own card or offer for a button in chats (`cards`), a project tool for something the agent calls (`tools`). A Sova extension gives the agent no tools of its own.

## Sova extension

- Change: a small web app of the person's own: a card on the home page, and a page at `#/ext/<id>` beside the sessions list.
- Lives: a folder of the person's own for its files, plus one entry in `<agent dir>/sova/extensions.json` (the agent dir is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Sova reads that file and never writes it. Keep the extension's folder outside Sova's own.
- Approves: nobody. Sova asks nothing, so the person's OK is all there is.
- By: OK. Show the whole manifest entry and every file, then write them. Then give the person the command that starts the backend: they run it and keep it running, in a terminal or a service of their own. A chat can't keep it running for them.
- Live: now. The home card appears at the next read, and within about 15 seconds on an open page. It stops working when the backend stops: its card reads `Down`, and its own requests answer 502.
- Check: the home card reads `Running`, its page opens, and `extensions.list` shows it. Other computers on the mesh see the entry listed and nothing served.

An entry needs an `id` (letters, digits, `.`, `_`, `-`), an absolute `dist` folder and a backend `api` on `127.0.0.1` or `localhost` with a port and no trailing slash. A bad entry is skipped and the server's log says why. `/ext/<id>/api/*` reaches `<api>/api/*`, and `Running` means `GET <api>/api/health` answered 2xx.

A complete example. `<your folder>` stands for the absolute path of the person's own folder for it, in the manifest as well. In `<agent dir>/sova/extensions.json`:

```json
{
  "version": 1,
  "extensions": [
    {
      "id": "hello",
      "title": "Hello",
      "description": "Says the time",
      "icon": "file",
      "dist": "<your folder>/dist",
      "api": "http://127.0.0.1:4841"
    }
  ]
}
```

`<your folder>/dist/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/design/tokens.css">
<link rel="stylesheet" href="/design/base.css">
<h1>Hello</h1>
<p id="out">Asking the backend…</p>
<script>
  fetch("/ext/hello/api/time")
    .then((r) => r.json())
    .then((d) => { document.getElementById("out").textContent = d.time; });
</script>
```

`<your folder>/server.mjs`, the backend, which the person starts with `node <your folder>/server.mjs`:

```js
import { createServer } from "node:http";
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") return res.end('{"ok":true}');
  if (req.url === "/api/time") return res.end(JSON.stringify({ time: new Date().toISOString() }));
  res.statusCode = 404;
  res.end('{"error":"not found"}');
}).listen(4841, "127.0.0.1");
```

## Things it adds to Sova's screens

- Change: chips under replies, a chip on session rows, one status line on its home card, and rows in a session's ⋯ menu.
- Lives: the extension's manifest entry (`"screens": ["reply", "row", "card"]`, and `"menu": "session"` on a command), plus answers from its backend at `/api/screens/<place>`. Sova draws what the backend answers as data.
- Approves: nobody. The person hides any of them from the extension's page with Hide Under Replies, Hide on Session Rows or Hide on Home Card.
- By: OK.
- Live: now. Three bad answers in a row stop Sova asking until the page reloads.
- Check: open a chat on this computer and see the chip, the line or the menu row.

Limits: 3 chips per extension and 6 under a reply; 1 chip per extension and 2 on a row; 8 extension rows in the menu; a home card line of 60 plain characters. A backend answers within 2 seconds.

## Its own commands

- Change: named actions of the extension that scripts, chips and menus can run.
- Lives: `commands` in its manifest entry, each `{name, label, summary?, params?, menu?}`. Each is listed as `ext.<id>.<name>` and reaches the backend at `POST /api/commands/<name>`.
- Approves: nobody.
- By: OK.
- Live: now, while its entry is installed.
- Check: it's listed in `GET /api/commands`, and running it reaches the backend.

## Its backend's key

- Change: nothing to set. Each extension gets its own key, so its backend can call Sova back on its own record.
- Lives: a file in `<agent dir>/sova/extension-keys/`, readable only by the person. Never show its contents, and never put it in a page, an answer or a log.
- Approves: nobody. It's made for the entry, and removing the entry revokes it.
- By: None. Nothing to change. Deleting the file replaces the key, and that's the person's to do.
- Live: within a few seconds of the entry.
- Check: the audit list shows the backend's calls under `ext:<id>`.

The key opens what Sova's token opens, except `/api/auth/*`, so treat a backend as having the person's reach.

## Cards and drawings in chats

- Change: an extension's own card types and drawing kinds in chats. A chat raises a card with its `card` tool; a drawing is a `vis` fence.
- Lives: `cards` (up to 16) and `drawings` (up to 8) in its manifest entry, with view modules in `dist`. Views run in a sealed box, walled off from Sova and the network.
- Approves: the person, the first time a card wants to act, with Trust {name}'s Cards. Only their click in the page passes.
- By: OK. For cards kept in a project rather than on this computer, see `cards`.
- Live: new chat, because a chat keeps the declarations it started with. A rebuilt view redraws within about a second.
- Check: start a new chat and raise the card or draw the kind.
