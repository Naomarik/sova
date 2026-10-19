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
- **Settings, read:** `settings.<doc>.get` for `sova`, `models`,
  `provider-limits`, `align`, `delegate`, `spec`, `team`, `summarizer`, `overseer`, `memory` and
  `subagents`.
- **Settings, written:** only `settings.align.set`, sending version 1 with the style and Visuals.
  `settings.delegate.get` and `settings.spec.get` read the legacy files (`mode-delegate.json`,
  `mode-spec.json`) that seed the subagent profile library and are its fallback, not what
  Settings → Subagents shows; nothing on the catalogue writes them.
- **Notifications:** `push.test` sends the Send Test notification to every registered device.

Nothing here grants power or reveals a secret: profile and schedule approval, logins, the decision
key, the model policy's and every other setting's writes stay off the catalogue.
