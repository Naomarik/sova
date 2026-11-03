# §app/updates — Updates

Sova keeps itself current from its own repository, `github.com/Naomarik/sova`, and from no other.
The **Updates · this machine** section at the bottom of Settings → General
(§app.settings-dialog/general) says what this server runs, checks the chosen source for something
newer, and upgrades this machine's copy when the operator says so, or by itself when Upgrade
automatically is on. The **Server · this machine** block above it says when this server started
and restarts it, from there or from Sova's command line (§app.updates/restart). An upgrade never
moves to older code, never touches a copy it can't move
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

Only one upgrade runs at a time, and Check Now waits while it does. No upgrade starts while a
restart is scheduled (§app.updates/restart). A finished upgrade's outcome
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

## §app.updates/restart — Restart Sova

The **Server · this machine** block of Settings → General, just above Updates · this machine,
says when this server started ("Started 2h ago") and the branch and short commit it started on,
in mono (`master · abc1234`), and offers **Restart Sova**. What it shows comes with
`GET /api/updates` (in `running`: `startedAt`, `canRestart`, `restartWhyNot`, `restartUnit`,
`diskAhead`), readable like the rest of it.

- **Which copy can.** Only a copy whose server is the main process of the service that runs it
  restarts itself: an **Installed copy** run by the installer's login service, or a **Developer
  copy** (§app.updates/running). Every other copy (a hermetic or terminal-started server, an
  installed copy the launcher started with no service, any linked worktree, even one Sova's
  project tools run as a unit) shows the block with no button and says "This copy isn't run by a
  service, so it can't restart itself. Restart it where you started it."
- **Asking.** Pressing Restart Sova asks once, inline: "Sova restarts in a few seconds. Chats
  keep running; open tabs reconnect." with **Restart Now** and **Cancel**. When the code on disk is
  newer than what runs, the confirm adds a line naming only what applies: "It loads newer code: 3
  new commits and uncommitted changes since it started." ("1 new commit", or "uncommitted
  changes" alone). Commits are those on the checkout's `HEAD` since the commit the server started
  on; uncommitted changes count only when the tree's build id (the one a chat's `On older code`
  reads, §app.chat-processes/code-pickup) differs from the one the server started with, so changes
  it already started with don't. Cancel closes the question and restarts nothing.
- **One start time.** This server's start is one value, when its process started: `GET /api/health`'s
  `startedAt`, `running.startedAt` in `GET /api/updates`, and the restart's reply all give the same
  one, so the old process never answers as a new start.
- **The restart.** Confirmed, the block first reads the start to wait past from `GET /api/health`,
  falling back to the start it already shows; with neither, it restarts nothing and says "Couldn't
  restart Sova: it didn't say when it started, so we couldn't tell when it's back. Nothing was
  restarted." Then `POST /api/updates/restart` schedules the restart of the service
  that runs this server the way an adopted unit's `apply` does (§app.project-services/adopt) and
  answers 202 first (`scheduled`, the current `startedAt`, `inSeconds`); the service restarts 3
  seconds later (`systemd-run --user --on-active=3s` running `systemctl --user restart <unit>`; on
  macOS a process in a session of its own that runs `launchctl kickstart -k` on the agent).
  Nothing builds, nothing is checked for busy sessions and nothing is held: chats, workers and
  replies keep running in their own processes (§app.chat-processes/survives-restart), and each
  moves to the new code at its next quiet moment (§app.chat-processes/code-pickup).
- **While it restarts.** The button reads "Restarting…" and is disabled, and a polite live region
  says "Sova is restarting. Waiting for it to answer…". The page asks `GET /api/health` every
  second until it answers with a start other than the one it read before asking; then the same region says "Restarted just now.
  Runs master · abc1234." and the started line shows the new start. Nothing else announces it: no
  toast elsewhere.
- **When it doesn't come back.** After a minute with no new start, a warning says "Sova hasn't
  come back after a minute." and "Check its service from a terminal:
  `systemctl --user status <unit>`." (on macOS `launchctl print gui/$(id -u)/<label>`) "We keep
  asking, and say so here when it answers." It then asks every 5 seconds; when Sova answers, the
  warning goes and the block says Restarted.
- **When it can't start.** A restart that is refused, or that can't be scheduled (`systemd-run` or
  the macOS process fails: 500 with its reason), shows an error, "Couldn't restart Sova: <reason>.
  Nothing was restarted.", and the button is back as it was.
- **One at a time, never with an upgrade.** While an upgrade runs, the button is disabled and the
  block says "An upgrade is running; it restarts Sova itself."; the server refuses a restart then
  (409, the same words). While a restart is scheduled, another is refused (409, "Sova is already
  restarting."), and so is an upgrade, Upgrade automatically's included (409, "Sova is
  restarting. Upgrade once it's back."). A scheduled restart that hasn't stopped this server
  within 2 minutes didn't happen: both refusals clear and the button is back.

**Who may.** `POST /api/updates/restart` answers the operator at a signed-in browser (a
same-origin request on the main listener, as §app.updates/operator says) and a script on this
machine: a call on the main listener that passed the gate and shows the token in `x-sova-token`,
as the command line's does. The catalogue lists it as `server.restart` (§app/settings-commands),
so `sova run server.restart` restarts Sova from a terminal, without the inline question. A call
from the peer listener (a mesh peer, `sova run server.restart --host <peer>` included), a call
with no socket (the Overseer's in-process dispatch, a schedule), a call carrying the Overseer's
sender header, and an extension's backend (its key isn't the token) are refused with 403
("Restart Sova is the operator's: open Settings → General, or run `sova run server.restart` on
this machine."). No agent tool offers it; a chat's shell that runs the command line reaches it as
any script on this machine does. Every restart asked for is recorded with its origin: the server's
log names who asked (`browser`, `command server.restart (<caller>)` or `script (<caller>)`, the
caller as §app.command-audit/attribution names it), the unit, and whether it was scheduled or
refused; a script's call also leaves its row in Sova's record of who ran what
(§app.command-audit/record).

## §app.updates/operator — Only the operator

Only the operator, at a signed-in browser, can check, change the update settings or upgrade
(restarting is the one Updates action a script on this machine may also take,
§app.updates/restart):
`POST /api/updates/check`, `PUT /api/updates/settings` and `POST /api/updates/apply` answer a
request on the main listener that passed the gate (§app.access/gate) and that a browser marks as
same-origin (`Sec-Fetch-Site: same-origin`). A call with no socket (the Overseer's in-process
dispatch, a schedule), a call from the peer listener, and a call carrying the Overseer's sender
header are refused with 403 ("Updates are the operator's: open Settings → General."). No agent tool
reaches them, none of them is on the command catalogue, and a mesh peer needs the `full` grant even to read them (§mesh.peers/grants). `GET /api/updates` (what runs, what the last check found, the job's progress) is
readable like any gated route. The daily check and Upgrade automatically are the server's own.

## §app.updates/reload-note — "A newer Sova is available"

Every Sova page learns that Sova changed under it in one way, with or without the mesh: the
stale-tab banner across the top of the page (§mesh.front-door/stale-tab). The page asks
`GET /api/mesh/hello` once at load and keeps the build it reports (a fingerprint of the page the
server serves) as its baseline, then asks again on every socket reconnect and whenever the tab comes
back into view. When the build differs from the baseline, as after an upgrade or a rebuild of the
page, the banner shows. A server that restarts on other server code but serves the same page shows
nothing, and a server that reports no build (a dev server behind Vite) never shows it.

The banner says "A newer Sova is available." and "Reload when you're ready.", the same words with
the mesh on or off, with **Reload Tab**, which reloads the page, and **Dismiss**, which hides it
until the next change. A different wire protocol
shows the banner's warning instead, with Reload Tab and no Dismiss. There is no other notice: no
note in a corner of the page. Chats move to the new code when they're idle, as after any restart
(§app/chat-processes).
