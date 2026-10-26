# §app/git-cleanup — Git's cleanup is never cut off
> Part of the Sova design spec · [overview](../design/overview.md)

After a commit, a merge or a fetch, git starts its own cleanup in the background
(`git maintenance run --auto --detach`). Started from a command whose processes are all killed
when it ends (a sandboxed command, a chat's process when it stops or reloads), that cleanup is cut
off partway. A cut-off run can leave a lock behind (`.git/objects/pack/multi-pack-index.lock`),
and every run after it writes a whole new pack and gives up, so the repository only grows. So
nothing Sova runs or starts begins that background cleanup (/no-background), and Sova has git run
it on its own schedule instead, outside every chat and sandbox (/scheduled). The new session card
shows how big the git folder is, and says when its cleanup looks stuck or overdue
(§chat.transcript/setup-card-git-folder).

Owns: the git config that stops background cleanup, the server's own git commands, and the
scheduled maintenance of projects. Not here: how the sandbox adds that config to its commands
(§chat.sandbox/git-cleanup), the chat process's environment as a whole
(§app.chat-processes/supervision), and the card (§chat.transcript/setup-card-git-folder).

## §app.git-cleanup/no-background — Nothing Sova starts begins git's background cleanup

- **Sova's git system config.** One file, written by the code that hands it out: a copy of this
  machine's own git system config (the file git names for `GIT_CONFIG_SYSTEM` when that variable is
  unset, or the one an inherited `GIT_CONFIG_SYSTEM` names; nothing when `GIT_CONFIG_NOSYSTEM` is
  set), then `maintenance.auto = false` and `gc.auto = 0`, last so they win inside it. It holds no
  `[include]` of its own: the machine's file is copied in as text, so the idle git cache
  (§app/idle-git-cache) keeps reusing its reads. Only a machine file that itself has an `[include]`
  is included by its absolute path instead of copied, and that file already turns the cache off. The
  file is rewritten only when what it would hold changes.
- **Chat processes.** Each chat's process gets `GIT_CONFIG_SYSTEM` naming that file,
  `<agent dir>/sova/git/no-background-cleanup.gitconfig`, so every command its tools run without the
  sandbox, and the chat's own git, start no background cleanup. Sandboxed commands get the
  sandbox's own copy (§chat.sandbox/git-cleanup).
- **The server's own git.** Every git command the server runs that can start background cleanup
  (a commit, a merge or a fetch: an organization workspace's commits and fetch, Merge Branch, a
  promotion commit, the update check and the update runner, a deploy's fetch) carries
  `-c maintenance.auto=false -c gc.auto=0`; the update check's fetch has `--no-auto-gc`. A push (an
  organization workspace's) carries `GIT_CONFIG_SYSTEM` naming Sova's git system config in that one
  command's environment, because git drops `-c` when it starts the receiving side of a push into a
  local repository, and that side would start a cleanup of its own. The server
  never puts git config in its own environment: `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` stay
  unset there, because either one turns the idle git cache off.
- **What can still override it.** It is git's system level, the lowest one. A repository's own
  config, the user's global config, `-c`, `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS` setting
  `maintenance.auto` or `gc.auto`, and a command's own `GIT_CONFIG_SYSTEM` or
  `GIT_CONFIG_NOSYSTEM`, still decide. A command's own `GIT_CONFIG_COUNT` that sets other keys adds
  to it and never replaces it. A repository Sova registers has `maintenance.auto=false` in its own
  config as well (/scheduled).
- Commits are no slower: git only stops starting the extra process.

## §app.git-cleanup/scheduled — Projects get git's scheduled maintenance

- **Registered per project.** Each project whose root is a git checkout is registered with git's
  own scheduled maintenance: `git maintenance register` in that checkout, run by the server (never
  in a chat or the sandbox), when the project is added, when its root changes, at the server's
  start and every 6 hours for every project on this host. A repository no project on this host
  holds any longer is unregistered (`git maintenance unregister`), but only one Sova registered: a
  repository already in the user's `maintenance.repo` before Sova registered it is left as it was.
  What Sova registered is recorded in `<state root>/git-maintenance.json`.
- **Its settings.** In the repository's own config: `maintenance.auto=false`,
  `maintenance.strategy=incremental`, `maintenance.prefetch.enabled=false` (nothing fetches),
  `maintenance.worktree-prune.enabled=false` and `gc.worktreePruneExpire=never` (scheduled
  maintenance never forgets a worktree whose folder is missing), `maintenance.gc.enabled=true` and
  `maintenance.gc.schedule=weekly`. Each key's earlier value is recorded, and unregistering puts
  back each key Sova set that still holds Sova's value. A repository registered before a key was
  added gets it at the next sweep, its earlier value recorded the same way.
- **The schedule.** Once per machine, `git maintenance start --scheduler=auto` (systemd user timers
  on Linux, launchd on macOS), recorded so it runs again only when the record is missing. The
  timers run outside every chat and sandbox, so nothing cuts them off. Under the incremental
  strategy git updates the commit-graph hourly, and daily packs loose objects and repacks
  incrementally: one daily run packs the loose objects and the next deletes them. Weekly, a full
  `git gc` runs too, so unreachable objects are pruned and the repository stops only growing. It
  shortens no expiry: git's own defaults stand (unreachable objects are kept 2 weeks, reflog
  entries 90 days, unreachable ones 30), so recent work and anything a reflog still names survive,
  and no worktree is pruned.
- **A cut-off run recovers.** A run that was killed can leave `objects/maintenance.lock` or
  `gc.pid` (or a multi-pack-index or commit-graph lock) behind, and every later run then skips
  with "lock file exists" and still exits 0. At each sweep, for each repository it holds, Sova
  removes any of those four locks older than 1 hour, but only when it can tell no git process is
  working in that repository (on Linux, from `/proc`: no git process whose working folder or
  `GIT_DIR` is in the repository, its git folder or one of its worktrees). When it can't tell (no
  `/proc`, a git process it can't read), it removes nothing. Each removal is logged. It never
  touches `index.lock` or a ref's lock.
- **Off.** `SOVA_GIT_MAINTENANCE=off` turns all of it off. The hermetic dev server and the test
  runner set it, so neither registers anything in a real git config or starts a timer; a test that
  drives it gives it a throwaway global config. A git that fails is logged, and the next sweep
  tries again; nothing is shown.
