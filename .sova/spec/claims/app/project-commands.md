# §app/project-commands — Project actions a script can run
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's command catalogue (`shared/commands-catalog.ts`, assembled from one file per area under
`shared/commands/`) lists each user-visible action as plain data pointing at the route that already
does it, so `node scripts/sova.mjs list|describe|run` reaches it. This claim covers the project
actions beyond the project verbs and the Branches tab's view.

## §app.project-commands/projects-sweep — The project actions in the catalogue

`sova list` shows these entries, and `sova run <id>` sends exactly the request the web app's own
control sends to the route named, so every answer and refusal is the route's own, word for word:

- `project.list`, `project.get` (`GET /api/projects`, `GET /api/projects/:pid`): every registered project, or one.
- `project.create` (`POST /api/projects`): Add Project (a folder's `root`) or Clone from GitHub (`clone`); the operator's, on its own host.
- `project.update` (`PATCH /api/projects/:pid`): rename a project or move its root.
- `project.claude-login.get`, `project.claude-login.set` (`GET`/`PUT /api/projects/:pid/claude-login`): the Claude login a project's new chats start on (a login id, `org` or `none`; §app.claude-logins/project-login).
- `project.archive`, `project.unarchive` (`POST /api/projects/:pid/archive|unarchive`): archive a project (refused while anything in it is open) or bring it back.
- `project.preview.off` (`POST /api/previews/:id/off`): turn a preview link off at once.
- `project.worktree.list`, `project.worktree.merge`, `project.worktree.remove` (`/api/projects/:pid/overseer/worktrees…`): a project's coding sessions' worktrees; merge one's branch into its target, or remove it.
- `project.files.list` (`GET /api/projects/:pid/files`): the files a project keeps.
- `project.costs` (`GET /api/projects/:pid/costs`): a project's cost card; `fresh=1` waits for a new count.
- `project.cards.list` (`GET /api/projects/:pid/cards`): a project's transcript card and drawing folders on its main checkout, broken ones with what is wrong, and whether its cards are trusted (§chat.transcript-cards/files).

Each entry's mesh need is what the peer listener's classifier gives its route. Reading one kept
file (`GET /api/projects/:pid/files/:id`) is not an entry: its answer is the file's bytes as a
download, which the command line, reading answers as text, cannot pass on intact.

Nothing that hands out a preview link is an entry: making one (`POST /api/previews`) or lengthening
one (`POST /api/previews/:id/extend`) lets someone outside this machine reach a local app, and a
project's preview list (`GET /api/projects/:pid/previews`) carries live links, which are bearer
secrets. Those stay the operator's, on the project page; turning a link off only takes reach away.

## §app.project-commands/verb-params — One table for a verb's params

A project verb's params are written once, in `shared/project-contract.ts`: each one's wire key, its
name on the agents' tools (`project_verbs`, `sova_project_verbs`), its flag on the command line, its
type and both descriptions. The tools' parameter schemas and the catalogue's `project.verb.*` params
are both made from that table, so the two cannot name a param differently, and what an agent is told
about a verb's params is byte for byte what it was told before the table.
