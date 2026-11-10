# §app/session-commands — Session actions a script can run
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's command catalogue (`shared/commands-catalog.ts`, assembled from one file per area under
`shared/commands/`) lists each user-visible action as plain data pointing at the route that already
does it, so `node scripts/sova.mjs list|describe|run` reaches it. This claim covers the session
actions beyond listing, reading, starting, renaming, tagging, archiving, configuring and sending.

## §app.session-commands/sessions-sweep — The session actions in the catalogue

`sova list` shows these entries, and `sova run <id>` sends exactly the request the web app's own
control sends to the route named, so every answer and refusal is the route's own, word for word:

- `session.fork` (`POST /api/sessions/fork`): fork a session at one of its entries; makes a new session.
- `session.draft.get`, `session.draft.set` (`GET`/`PUT /api/sessions/draft`): read or replace a session's composer draft;
  a draft set this way is a message, never a command (§chat.shell-mode/box).
- `session.shell.output` (`GET /api/sessions/shell-output`): one page, about 1 MB, of a finished
  command's whole output (§chat.shell-mode/card).
- `session.sandbox.set` (`POST /api/sandbox`): set a held chat's sandbox state.
- `session.tools.get` (`GET /api/sessions/tools`): the tools a held chat declares to its model.
- `session.context` (`GET /api/sessions/context`): what pi loads for a session's folder.
- `session.context.view` (`GET /api/sessions/context-view`): what fills a chat's context window now, each part with its estimated size, and the last reply's total (§app.subagents-pane/context-tab).
- `session.align.triage` (`GET /api/sessions/align-triage`): each open alignment question's guessed stakes (§app.decisions/align-triage).
- `session.workers.checks` (`GET /api/sessions/worker-checks`): whether each worker's newest done report says it ran its tests or checks (§app.decisions/worker-report).
- `session.group.list|create|rename|delete|assign|send` (`/api/session-groups…`): the sidebar's groups, and one message to a group's sessions.
- `session.insights` (`GET /api/insights/session`): one session's insight.
- `worker.resume` (`POST /api/workers/resume`): resume one restored subagent worker of a held chat.
- `session.cleanup` (`POST /api/sessions/cleanup`): delete session files for good, by age (7 or 30
  days), as empty husks, or the named archived sessions; live, busy and just-written ones are
  skipped, and a dry run only lists what would go.
- `session.title.auto` (`POST /api/sessions/auto-title`): name the given sessions with the title
  model, as Auto-title does; with redo, replace one session's title.
- `session.title.shorten` (`POST /api/sessions/shorten-titles`): rename this host's long generated
  titles with the title model; a typed title is kept.
- `session.worktree.summary`, `session.worktree.status` (`GET /api/worktrees/summary`): count a
  session's repository's worktrees, held and retired (§chat.worktrees/cleanup). `session.worktree.cleanup`
  is retired: nothing lists or removes worktrees by name, and `POST /api/worktrees/cleanup` is page
  plumbing, for its one release.
- `session.worktree.retirement` (`GET /api/worktrees/retirement`): what retirement took and holds in a
  project, its reasons and how many only wait (§chat.worktrees/retirement).
- `session.worktree.restore` (`POST /api/worktrees/restore`): put a retired branch back at its last
  commit and its folder at its old place (§chat.worktrees/retirement).
- `session.worktree.remove` (`POST /api/worktrees/remove`): remove one worktree with nothing left to land,
  on an install where automatic cleanup is off; refused everywhere else (§chat.worktrees/pane).
- `session.diff.summary` (`GET /api/diff/summary`): the files a session's worktree, commit, merge or
  dirty folder changed, as the changes viewer lists them. Its session is given as `--session-path`
  (sent under the query key `session`), not as a session param.

Each entry's mesh need is what the peer listener's classifier gives its route. A file's patch
(`/api/diff/patch`) is not an entry, and `session.diff.summary` has no `paths` filter: that is a
repeated query key, which an entry cannot express.
