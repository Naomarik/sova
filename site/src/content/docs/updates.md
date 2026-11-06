---
title: Updates
description: Keep Sova current, from the install command or from Settings. An upgrade never moves to older code, and the version that runs keeps running until the new one answers.
group: Setup
order: 31
---

Sova updates only from its own repository, `github.com/Naomarik/sova`, never from a fork. There are
two ways: run the install command again, or let Sova update itself from Settings.

## Run the install command again

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash
```

With no `SOVA_REF`, the installer installs whatever the `stable` tag points at. `stable` is the one
tag that moves: each release points it at its own numbered tag, such as `v0.3.3`, and numbered tags
never move. So a re-run installs the newest stable release, or the older one again if `stable` was
moved back. The script installs the same `stable` default from any tag or branch you fetch it from.

To pin a version, set `SOVA_REF`:

- `| SOVA_REF=v0.11.0 bash` installs that release, and a re-run with it stays there.
- `| SOVA_REF=master bash`, or any other branch, updates to that branch's latest commit on each run.
- A commit works too, as seven or more hex digits.

A ref the repository doesn't have stops the install before anything is written. The closing message
names what it installed, such as "installed v0.3.3 (1a2b3c4) in ~/.local/share/sova", or says the
install is already there and there's nothing to rebuild. See [Install](/docs/install/#run-it-again)
for the options to pass again.

## Updates · this machine

Once Sova runs, the **Updates · this machine** section at the bottom of Settings → General keeps it
current. The server runs it, so checks happen whether or not a browser is open.

Its first line names what this server runs: a release, such as `Sova v0.3.2 · stable release`, or a
branch and how far past the newest release it is, such as `master · 86 changes past v0.3.2`, with
the commit's short id. A chip names the kind of copy, which decides what an upgrade may do:

| Copy | What it is | Upgrades |
|---|---|---|
| **Installed copy** | The copy the install command made | Yes |
| **Developer copy** | Any other checkout whose server runs as a user service | Only by fast-forward, from a clean tree |
| **Check only** | Anything else: a worktree, a server started in a terminal | No: it checks and shows what it finds, and says why it can't upgrade |

### Where updates come from

**Update from** picks the source:

- **Stable releases**, the default: the `stable` tag, named by the release it points at.
- **Latest changes (master)**: the `master` branch.
- **A branch**: a branch you type in. Save Changes checks that the repository has it, and refuses a
  name it doesn't have, such as "Updates: Sova's repository has no branch `feat/x`."

Changing the source installs nothing. It's saved with Settings' Save Changes, and the next check
compares against it.

### Checking

**Check for updates automatically** is on by default: the server checks once a day, and an hour
later after a check that couldn't reach the repository. **Check Now** checks at once. A check moves
no branch, tag or file of your copy. It finds one of:

- **Up to date.**
- **Update available**: "Update available: v0.3.3" with **Release Notes**, or for a branch "12 new
  commits · latest: …" with **See the Changes**.
- **Ahead**: this copy is newer than the source, such as "You're ahead of Stable; updates resume
  when Stable catches up." Sova never moves to older code.
- **Diverged**: neither contains the other, for example after a branch was rewritten. An installed
  copy offers to install the source as it is now; a developer copy refuses.
- **Another branch**: a developer copy follows a source only from the branch that source names, and
  says so ("You're on topic; switch to master to follow it.").
- **Withdrawn**: the release this copy runs was taken back. A warning says which release, why, and
  when, and that Stable is back on the release before. An installed copy is offered **Go Back to**
  that release, with the upgrade's own confirm; a developer copy is told the same and offered
  nothing. Nothing moves on its own.

While an update is waiting, the Settings gear at the foot of the sidebar carries a small dot, and
its label reads "Settings · update available". Nothing else announces it.

## Upgrade

The section's button names the update: **Upgrade to v0.3.3**, **Upgrade to Latest master**, or
**Switch to feat/x** for another branch. It asks once: "Sova restarts once v0.3.3 is built. Chats
keep running and move to the new code when they're idle." Then press **Upgrade Now**, or **Cancel**.

The upgrade runs as a job of its own, so the restart can't cut it off. The section shows its steps:
Downloading, Installing, Building, Restarting, Checking.

- **The version that runs keeps running** until the new one is built. Then Sova restarts and waits
  up to a minute for the new version to answer. Only then is the previous version deleted.
- **If the new version doesn't start in time**, the previous one is put back and restarted: "v0.3.3
  didn't start within a minute, so we put v0.3.2 back."
- **A failure before the restart** changes nothing. The section names the step that failed and
  gives the log.
- An upgrade never touches your sessions, settings or chats.

An installed copy upgrades by running the new version's own install script on it, keeping the
replaced install until the new one answers. A developer copy moves only by fast-forward, and only on
the branch its source names; with uncommitted changes it refuses and changes nothing ("Your copy has
uncommitted changes in 3 files. Commit or stash them, then upgrade.").

Only one upgrade runs at a time, and none starts while a restart is scheduled. Its outcome stays in
the section for a day, with the path of its log. A developer copy's upgrade runs no installer, so its
launcher and app entry stay as they are.

**From v0.9.0 or v0.10.0:** Upgrade in Settings fails on these two releases ("Cannot find module"),
and nothing changes. Run the install command once instead; from v0.10.1 on, Upgrade works again.

### Upgrade automatically

**Upgrade automatically** is off by default. Turned on, a check that finds an update this copy can
install starts the same upgrade, with the same refusals and the same put-back, without asking. A
refusal, such as uncommitted changes, shows in the section and is tried again at the next check. A
version that was put back is never installed again automatically; the button still offers it.
Going back from a withdrawn release is never automatic.

### After an upgrade

A Sova page that was open across the upgrade shows a banner at its top, "A newer Sova is available.
Reload when you're ready.", with **Reload Tab** and **Dismiss**. It shows when the page itself changed, and
whether or not you use a mesh.
A card in a chat that can't load because Sova changed under the page asks for a page reload too.
Each chat moves to the new code at its next quiet moment.

## Who can update

Only you, at a signed-in browser, can check, change the update settings, upgrade or restart Sova:
each answers only your own page on this machine. A script, a chat's terminal, the Overseer, agents
and schedules are refused (`sova run server.restart` answers with where to click), and another
Sova machine in your mesh needs its full grant even to read what the section shows. To stop every check on a server, start it with `SOVA_UPDATES_CHECK=off`.
