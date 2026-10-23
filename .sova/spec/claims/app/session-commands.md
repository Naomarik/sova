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
- `session.draft.get`, `session.draft.set` (`GET`/`PUT /api/sessions/draft`): read or replace a session's composer draft.
- `session.sandbox.set` (`POST /api/sandbox`): set a held chat's sandbox state.
- `session.tools.get` (`GET /api/sessions/tools`): the tools a held chat declares to its model.
- `session.context` (`GET /api/sessions/context`): what pi loads for a session's folder.
- `session.align.triage` (`GET /api/sessions/align-triage`): each open alignment question's guessed stakes (§app.decisions/align-triage).
- `session.workers.checks` (`GET /api/sessions/worker-checks`): whether each worker's newest done report says it ran its tests or checks (§app.decisions/worker-report).
- `session.group.list|create|rename|delete|assign|send` (`/api/session-groups…`): the sidebar's groups, and one message to a group's sessions.
- `session.insights` (`GET /api/insights/session`): one session's insight.
- `worker.resume` (`POST /api/workers/resume`): resume one restored subagent worker of a held chat.

Each entry's mesh need is what the peer listener's classifier gives its route. The changes viewer's
diffs (`/api/diff/summary`, `/api/diff/patch`) are not entries: their session travels under the
query key `session` and their `paths` filter is a repeated query key, which an entry cannot express.
