# §app/settings-commands — Settings, models, usage and health as commands

The command catalogue (`shared/commands/other.ts`) lists the looks and safe changes of Settings,
the model picker, the Usage and Agents pages and the server's health, so a
script runs each one by name. Each entry points at the route the web app already calls, and a call
through it gets exactly the answer the web app's own request gets on the same state, refusals word
for word. The entries are:

- **Pickers:** `targets.list`, `folders.list`, `cwds.list`, `files.list`.
- **Models:** `models.favorite` stars or unstars one model, as the picker's star does.
- **Usage ledger:** `usage.costs`, `usage.performance`, `usage.today`, `usage.session`,
  `usage.sessions`, `usage.prices`, `usage.prices.refresh`.
- **Insights:** `insights.usage`, `insights.usage.history`, `insights.agents`,
  `insights.worktrees`, `insights.session.workers`.
- **Health:** `sova.health`.
- **The server:** `server.restart` restarts Sova, as Settings → General's Restart Sova does,
  answering at once and restarting about 3 seconds later; it takes no params and asks nothing. Only
  the operator's browser or a script on this machine may run it: a mesh peer and the Overseer are
  refused
  (§app.updates/restart; `meshNeed` `full`, its route's).
- **Settings, read:** `settings.<doc>.get` for `sova`, `models`,
  `provider-limits`, `align`, `delegate`, `spec`, `team`, `summarizer`, `overseer`, `memory` and
  `subagents`.
- **Settings, written:** `settings.align.set`, sending version 1 with the style and Visuals, and
  `settings.assistant-default.set`, the Project Assistant's default model and thinking, or `null`
  to clear it (§app.project-assistant/models; mesh `admin`).
  `settings.delegate.get` and `settings.spec.get` read the legacy files (`mode-delegate.json`,
  `mode-spec.json`) that seed the subagent profile library and are its fallback, not what
  Settings → Subagents shows; nothing on the catalogue writes them.
- **Notifications:** `push.test` sends the Send Test notification to every registered device.
- **An organization's Claude login:** `org.claude-login.get` and `org.claude-login.set` (mesh
  `admin`), the login its projects' new chats start on (§app.claude-logins/project-login).

Nothing here grants power or reveals a secret: profile and schedule approval, signing in and the
Claude logins themselves (Settings → Accounts), the decision key, the model policy's and every
other setting's writes stay off the catalogue. Which login an organization or project starts on
names a login, never its credentials, and its four entries are the only paths naming a login.
