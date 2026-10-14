# §app/updates — Updates

Sova keeps itself current from its own repository, `github.com/Naomarik/sova`, and from no other.
The **Updates · this machine** section at the bottom of Settings → General
(§app.settings-dialog/general) says what this server runs, checks the chosen source for something
newer, and upgrades this machine's copy when the operator says so, or by itself when Upgrade
automatically is on. An upgrade never moves to older code, never touches a copy it can't move
safely, and keeps the version that runs now until the new one answers. The server owns all of it:
checks run whether or not a browser is open, and the state lives in `<stateRoot>/updates.json`.

## §app.updates/running — What runs, and what kind of copy it is

The section's first line names what this server runs: the release when its commit is a release
tag (`Sova v0.3.2 · stable release` on an installed copy, `Sova v0.3.2 · release` on any other),
otherwise the branch (or `detached`) and how far past the newest release it is
(`master · 86 changes past v0.3.2`), with the commit's short id in mono and a chip naming the kind
of copy (**Installed copy**, **Developer copy**, **Check only**). It
is read from the server's own checkout with git (`git describe --tags --match 'v[0-9]*'`, the
moving `stable` tag excluded), never from `package.json`. A server that runs from no git checkout
says so and offers neither a check nor an upgrade.

The second fact is the kind of copy, which decides what an upgrade may do:

- **Installed copy** — the checkout `scripts/install.sh` made: a `sova` launcher it wrote
  (`# sova-launcher v1`) points at this checkout, and the checkout holds its own Bun
  (`.bun/bin/bun`). Its server runs as the installer's login service (`sova.service` on Linux, the
  launchd agent `io.github.naomarik.sova` on macOS, each carrying `sova-service v1`) or, with no
  service, as a process the launcher started.
- **Developer copy** — any other git checkout (not a linked worktree) whose server is the main
  process of a user service: a systemd user unit (such as an adopted `sova-runtime.service`,
  §app.project-services/adopt) or a launchd agent.
- **Check only** — anything else: a linked worktree, a hermetic dev server, a checkout started in a
  terminal. The section checks and shows what it finds, and offers no upgrade (Upgrade
  automatically is disabled there); a line says why ("This copy runs from a worktree, so it updates
  with git, not from here."). A check from a worktree fetches into the repository it shares with its
  main checkout, still only under `refs/sova-updates/*`.

## §app.updates/source — Where updates come from

**Update from** chooses the source, always a ref of Sova's own repository:

- **Stable releases** (the default): the moving `stable` tag, named by the numbered release it
  points at (`v0.3.3`).
- **Latest changes (master)**: the `master` branch.
- **A branch**: a branch named in a text field. Save Changes asks the repository whether the
  branch exists (`git ls-remote`) and refuses a name it doesn't have ("Updates: Sova's repository
  has no branch `feat/x`.") or that isn't a valid branch name; nothing is written then.

The repository is never a setting: no field names another, and a fork is never followed. The
test-only environment variable `SOVA_UPDATES_REPO_URL` points a server at a stand-in repository;
the section never shows or sets it.

Changing the source installs nothing. It is saved with the dialog's Save Changes, like every
server-backed form (§app.settings-dialog/save-bar), and the next check (or Check Now) compares
against it; the upgrade button then names the act: `Upgrade to v0.3.3` for a release,
`Upgrade to Latest master` when the copy already runs that branch, `Switch to feat/x` when it runs
another.

## §app.updates/check — Checking, once a day or now

**Check for updates automatically** is a checkbox, **on by default**. While it is on, the server
checks once a day, whether or not any browser is open. When the last check ran is kept in
`updates.json`, so a restart doesn't check early: a server that starts within a day of the last
check waits for the rest of the day. A check that couldn't reach the repository tries again an hour
later. **Check Now** checks at once, whatever the checkbox says.

A check reads the repository's refs with `git ls-remote` (no GitHub API), and fetches the source's
commit into a private ref namespace of the checkout (`refs/sova-updates/*`), touching no branch,
no tag, no `HEAD` and no working file. In a shallow clone (the installer's) the first check fetches
the history it needs to compare. It finds one of:

- **Up to date** — the source is at the commit that runs.
- **Update available** — the source is newer: "Update available: v0.3.3" with **Release Notes**
  (that release's section of `CHANGELOG.md` at the release, shown in the section, and a link to it
  on GitHub), or for a branch "12 new commits · latest: <subject>" with **See the Changes**, the
  comparison on GitHub.
- **Ahead** — the commit that runs is newer than the source: "You're ahead of Stable; updates
  resume when Stable catches up." No button. Sova never moves to older code: a newer numbered
  release is the only way forward from a release, and otherwise the source must contain the
  running commit.
- **Diverged** — neither contains the other (the branch was rewritten, or the copy runs a branch
  the source never had). An installed copy offers to install the source as it is now, saying it was
  rewritten; a developer copy refuses ("Your copy's branch isn't part of master's history, so we
  won't move it."). For Stable, a diverged copy whose newest release is the source's release or a later one is
  ahead, never offered the older one.
- **Another branch** — a developer copy follows a source only from the branch that source names:
  master for Latest changes, the named branch for a branch source, and master or a detached HEAD
  for Stable. On any other branch the check offers nothing and says why ("You're on topic; switch to
  master to follow it."); nothing of the developer's is moved to follow a source it isn't on.

A check that fails says what failed and when ("Couldn't reach Sova's repository: …"), and leaves
everything as it was. The section shows when the last check ran and what it found; a check made
against another source, or before the running commit changed, reads "Not checked against Stable
yet." until the next one.

`SOVA_UPDATES_CHECK=off` stops every check (the daily one and Check Now); the section says checks
are off on this server. Unset, a test process (`NODE_ENV=test`, or `node --test`) never checks, and
`pnpm run dev:hermetic` sets it off unless you set it yourself.

## §app.updates/indicator — A dot on Settings

While the last check found an update this copy can install, the Settings gear at the foot of the
sidebar (and the spine's Settings button) carries a small accent dot at its top right, and its
label says "Settings · update available". Nothing else announces it: no popup, no toast.

## §app.updates/upgrade — Upgrading, keeping the version that runs

An update this copy can install has one button that names it. Pressing it asks once, inline:
"Sova restarts once v0.3.3 is built. Chats keep running and move to the new code when they're
idle." with **Upgrade Now** and **Cancel**. Confirmed, the upgrade runs as a job of its own,
outside the server's service, so the restart it causes can't cut it off: a transient systemd user
unit (`systemd-run --user`) where there is a user manager, else a process detached in a session of
its own (macOS). The job writes its progress, its result and a log under
`<stateRoot>/updates/jobs/<id>/`, and the section shows the steps as it goes — Downloading,
Installing, Building, Restarting, Checking — and, after the restart, the outcome.

The version that runs keeps running until the new one is built. Then the server restarts, and the
job waits up to 60 seconds for `GET /api/health` to report the new commit. Only then is the
previous version deleted. If the new version doesn't answer in time, the job puts the previous one
back, restarts it, and says so ("v0.3.3 didn't start within a minute, so we put v0.3.2 back.").
A failure before the restart changes nothing: the section names the step that failed, says once
that nothing changed, and gives the log.
Sessions, settings and chats are never touched by an upgrade.

- **Installed copy**: the job runs the target's own `scripts/install.sh` (taken from the target
  commit) on this checkout, with this install's launcher directory and port, non-interactively,
  asking it to keep the replaced install (`SOVA_KEEP_PREVIOUS`, §app/installer). The
  installer's service restarts as it always does; with no service, the job stops the old server and
  starts the launcher again, on the same port and the same `HOST`.
- **Developer copy**: only by fast-forward, only from a clean tree, and only on the branch the source
  names (master, the named branch, or for Stable master or a detached HEAD): the button, Upgrade
  automatically and the job itself each refuse another branch, changing nothing. The job refuses, changing
  nothing, when tracked files have uncommitted changes ("Your copy has uncommitted changes in 3
  files. Commit or stash them, then upgrade.") or when the move isn't a fast-forward. On a branch it
  moves with `git merge --ff-only`; a detached checkout is moved to the new commit only when it
  contains the old one. It then installs dependencies (`pnpm install --frozen-lockfile`), builds into
  a staging directory, swaps the build into `dist/` and `dist-share/`, and restarts the unit. A
  rollback moves the branch back to the commit it was at, reinstalls and puts the previous build
  back. Local branches, other worktrees, stashes and untracked files are never touched.

Only one upgrade runs at a time, and Check Now waits while it does. A finished upgrade's outcome
stays in the section for a day, with the path of its log, and is kept in `updates.json`
(`lastUpgrade`: from, to, when, outcome, log).

## §app.updates/auto-upgrade — Upgrade automatically

**Upgrade automatically** is a checkbox, **off by default**. On, a check that finds an update this
copy can install starts the same upgrade the button would, with the same refusals, keep-previous and
rollback; nothing is asked. A refusal (uncommitted changes, not a fast-forward, another branch) is shown in the
section and tried again only at the next check. A version that was put back because it didn't start
within a minute is never installed again automatically ("v0.3.3 was put back last time, so it isn't
installed again automatically. Upgrade by hand to try it again."); the button
still offers it. An upgrade that failed and changed nothing (a network error) is tried again at the
next check.

## §app.updates/operator — Only the operator

Only the operator, at a signed-in browser, can check, change the update settings or upgrade:
`POST /api/updates/check`, `PUT /api/updates/settings` and `POST /api/updates/apply` answer a
request on the main listener that passed the gate (§app.access/gate) and that a browser marks as
same-origin (`Sec-Fetch-Site: same-origin`). A call with no socket (the Overseer's in-process
dispatch, a schedule), a call from the peer listener, and a call carrying the Overseer's sender
header are refused with 403 ("Updates are the operator's: open Settings → General."). No agent tool
reaches them, and a mesh peer needs the `full` grant even to read them (§mesh.peers/grants). `GET /api/updates` (what runs, what the last check found, the job's progress) is
readable like any gated route. The daily check and Upgrade automatically are the server's own.

## §app.updates/reload-note — "Sova was updated"

A page that was open across an upgrade notices it when its sockets reconnect (or at its next
read, every 10 minutes): the commit the server started on, as `GET /api/updates` reports it, differs
from the one the page loaded with. It then shows a small note,
"Sova was updated · Reload", whose **Reload** button reloads the page; the note stays until then.
Chats move to the new code when they're idle, as after any restart (§app/chat-processes).
