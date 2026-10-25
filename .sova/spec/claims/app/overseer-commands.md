# §app/overseer-commands — Overseer actions a script can run
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's command catalogue (`shared/commands-catalog.ts`, assembled from one file per area under
`shared/commands/`) lists each user-visible action as plain data pointing at the route that already
does it, so `node scripts/sova.mjs list|describe|run` reaches it. This claim covers the Overseer's
and the project overseers' to-dos, ideas and standing notes beyond showing attention and listing,
adding, changing and removing the Overseer's to-dos.

## §app.overseer-commands/overseer-sweep — The Overseer actions in the catalogue

`sova list` shows these entries, and `sova run <id>` sends exactly the request the web app's own
control sends to the route named, so every answer and refusal is the route's own, word for word:

- `overseer.todo.reorder` (`PUT /api/overseer/todos/order`), `overseer.todo.clear-done` (`DELETE /api/overseer/todos/done`): put the Overseer's to-dos in a new order, or clear the done ones.
- `overseer.idea.list`, `overseer.idea.get` (`GET /api/overseer/ideas`, `GET /api/overseer/idea`): the Overseer's ideas backlog, or one idea.
- `overseer.idea.update` (`PATCH /api/overseer/idea`): change an idea's title, status, tags, links or text, or rename it.
- `overseer.notes.get`, `overseer.notes.set` (`GET`/`PUT /api/overseer/notes`): read or replace the Overseer's standing notes; a stale `base` gets the route's 409.
- `project.overseer.idea.list|get|add|update` (`/api/projects/:pid/overseer/ideas`, `…/idea`): a project overseer's ideas.
- `project.overseer.todo.list|add|update|remove|reorder|clear-done` (`/api/projects/:pid/overseer/todos`, `…/todo`, `…/todos/order`, `…/todos/done`): a project overseer's to-dos.

Each entry's mesh need is what the peer listener's classifier gives its route. Not entries: the
Overseer's autonomy (approvals, rules and their revoke) and its settings, which grant trust; and
`POST /api/projects/:pid/overseer/message`, which only the Overseer itself may call.
The standing notes are a command although Settings also edits them: they are the Overseer's working
text, not a setting that grants anything.
