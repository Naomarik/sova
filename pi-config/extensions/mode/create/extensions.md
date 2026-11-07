# extensions: your own page, buttons and cards inside Sova

Say both of these before the person agrees. They turn it on themselves in Settings → Extensions, by choosing its folder, because a chat can't install one: its program then runs as them with no sandbox. And it has full access inside the page: its page runs on Sova's own address, unsandboxed, and can read Sova's browser storage and call every Sova request. What it does there passes as the person's own click, so installing one is a trust decision (`safety`).

Offer a lighter way first when one would do: a custom theme for looks (`appearance`), a project's own card or offer for a button in chats (`cards`), a project tool for something the agent calls (`tools`). A Sova extension gives the agent no tools of its own.

## Sova extension

- Change: a small web app of the person's own: a card on the home page, and a page at `#/ext/<id>` beside the sessions list.
- Lives: a folder of the person's own, outside Sova's, holding a description file, `sova-extension.json`. Sova points at the folder and never copies it. Never write `<agent dir>/sova/extensions.json`: what appears there outside the screen waits for approval.
- Approves: the person, on their own page: Add Extension in Settings → Extensions shows what it asks for, and nothing runs before Install and Turn On. Any change to its code asks again. A chat is refused.
- By: OK. Show every file and write them. Then send the person to Settings → Extensions and name the folder to choose. Stop there: only their click installs it.
- Live: at their click, with no restart. The home card appears at once on their page, and within about 15 seconds on another. Sova starts its program and keeps it running.
- Check: the row reads `Running`, its page opens, and `extensions.list` shows it. Other computers on the mesh see the entry listed and nothing served.

The description needs `version: 1`, an `id` (letters, digits, `.`, `_`, `-`), a `title` and `needsContract`, the rules it needs, a string like `"1.20"`. All else is optional: `page`, a folder holding its `index.html`, and `backend`, with `run`, the program as words, never a shell line, and `folder`, the program's own code. Leave `folder` out and the whole extension folder counts as its code. Inside what counts, `.git`, `node_modules`, `.worktrees` and `.agent` anywhere, `data` and `logs` directly in the extension's folder, and files ending `.log` never ask again. A file its program writes anywhere else, say `./state.json`, reads Changed: keep what it writes in `SOVA_EXTENSION_DATA_DIR` or `data/`. A folder that can't be used says why when it's chosen, and one bad command or card is left out alone and named in the review.

Its program gets `PORT` (listen on `127.0.0.1` there), `SOVA_URL`, `SOVA_EXTENSION_ID`, `SOVA_EXTENSION_KEY_FILE` and `SOVA_EXTENSION_DATA_DIR`, its folder for what it keeps. `/ext/<id>/api/*` reaches `<api>/api/*`, and `Running` means `GET <api>/api/health` answered 2xx.

A complete example. In `<your folder>/sova-extension.json`:

```json
{
  "version": 1,
  "id": "hello",
  "title": "Hello",
  "description": "Says the time",
  "icon": "file",
  "needsContract": "1.20",
  "page": "dist",
  "backend": { "run": ["node", "server.mjs"] }
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

`<your folder>/server.mjs`, its program, which Sova starts:

```js
import { createServer } from "node:http";
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") return res.end('{"ok":true}');
  if (req.url === "/api/time") return res.end(JSON.stringify({ time: new Date().toISOString() }));
  res.statusCode = 404;
  res.end('{"error":"not found"}');
}).listen(Number(process.env.PORT), "127.0.0.1");
```

## Things it adds to Sova's screens

- Change: chips under replies, a chip on session rows, one status line on its home card, and rows in a session's ⋯ menu.
- Lives: its description file (`"screens": ["reply", "row", "card"]`, and `"menu": "session"` on a command), plus answers from its backend at `/api/screens/<place>`. Sova draws what the backend answers as data.
- Approves: the person, in the review. They hide any of them from the extension's page with Hide Under Replies, Hide on Session Rows or Hide on Home Card.
- By: OK.
- Live: now. Three bad answers in a row stop Sova asking until the page reloads.
- Check: open a chat on this computer and see the chip, the line or the menu row.

Limits: 3 chips per extension and 6 under a reply; 1 chip per extension and 2 on a row; 8 extension rows in the menu; a home card line of 60 plain characters. A backend answers within 2 seconds.

## Its own commands

- Change: named actions of the extension that scripts, chips and menus can run.
- Lives: `commands` in its description file, each `{name, label, summary?, params?, menu?, overseer?, description?, job?}`. Each is listed as `ext.<id>.<name>` and reaches the backend at `POST /api/commands/<name>`. `overseer: true` gives the command to the Overseer, which runs it only when the person asked in their own message; `description` (at most 1,000 characters) tells it what the command does; `job: true` means the command answers at once and reports later. The person stops them by turning the extension off: there is no switch per command.
- Approves: the person, in the review, with the extension.
- By: OK.
- Live: at their click, while it's on.
- Check: it's listed in `GET /api/commands`, and running it reaches the backend. A command marked for the Overseer is listed in About the Overseer, the (i) in its head.

## Its backend's key

- Change: nothing to set. Each extension gets its own key, so its backend can call Sova back on its own record.
- Lives: a file in `<agent dir>/sova/extension-keys/`, readable only by the person. Never show its contents, and never put it in a page, an answer or a log.
- Approves: nobody. It's made when the extension goes on, and Turn Off or Remove revokes it.
- By: None. Nothing to change. Deleting the file replaces the key, and that's the person's to do.
- Live: before its program starts.
- Check: the audit list shows the backend's calls under `ext:<id>`.

The key opens what Sova's token opens, except `/api/auth/*`, so treat a backend as having the person's reach.

## Cards and drawings in chats

- Change: an extension's own card types and drawing kinds in chats. A chat raises a card with its `card` tool; a drawing is a `vis` fence.
- Lives: `cards` (up to 16) and `drawings` (up to 8) in its description file, with view modules in its page folder. Views run in a sealed box, walled off from Sova and the network.
- Approves: the person, the first time a card wants to act, with Trust {name}'s Cards. Only their click in the page passes.
- By: OK. For cards kept in a project rather than on this computer, see `cards`.
- Live: new chat, because a chat keeps the declarations it started with. A rebuilt view redraws within about a second.
- Check: start a new chat and raise the card or draw the kind.
