# Changelog

What changed in each Sova release, newest first: the highlights, written by hand, not a commit
list. The install command installs the newest release (the `stable` tag); `SOVA_REF=vX.Y.Z` installs
or keeps one release. How a release is cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## v0.3.0 — 2026-10-13

Every chat now runs in a process of its own. 353 commits since v0.2.0. The highlights:

- **A server restart cuts nothing off.** Each chat, worker, team member and hidden chat keeps
  running through a restart or an update of the server, a reply in flight included; open browsers
  reconnect by themselves. A server-hosted tool that was running when the server stopped reports
  "outcome unknown" to its chat and is never retried.
- **New code reaches a chat at its next quiet moment.** A chat keeps the code it started with and
  shows **On older code** until it reloads on its own, or until you press **Reload Now**.
- **Chats outlive the server.** With no server, a chat exits by itself once it has been idle for
  its idle time; `bun scripts/stop-chats.ts` stops every recorded chat at once.
- **A chat cut off mid-reply picks up again.** A chat whose process died mid-run is resumed once
  by the next server, even across a restart, and never twice.
- **Steadier workers.** A worker start interrupted by a restart is finished when its parent asks
  again, and a finished worker's wake reaches its parent even when the first try fails.

### What you must do differently

- **Chats need Bun.** A server started on Node (`sova --node`) runs no chats or workers: opening
  one is refused. The default `sova` runs on Bun.
- After updating, open chats show **On older code** until they reload; nothing is lost.

To go back, install `v0.2.0` with `SOVA_REF=v0.2.0`, after stopping every chat
(`bun scripts/stop-chats.ts`); going back hasn't been tested on this release.

## v0.2.0 — 2026-10-13

The first stable release. The install command now installs the newest release instead of
`master`:

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash
```

Re-running it updates to the newest stable release; an install of `v0.1.0` moves to `v0.2.0` the
next time it runs this command. About 3,400 commits since v0.1.0 (2026-09-22). The highlights:

### Install and run

- **Runs on Bun.** The server runs on the Bun version Sova is tested on, which the installer
  downloads into the install directory and checks against a recorded checksum. `sova --node` runs
  it on Node instead.
- **Sova in your app launcher.** The installer adds a **Sova** entry that opens the app already
  signed in, in a window of its own (`sova open` does the same from a terminal), and offers a login
  service on macOS (launchd) and Linux (systemd).
- **One access token per install.** Every browser signs in once; `sova open` passes the token for
  you, and a phone pairs with a one-use QR code.

### Working with agents

- **Memory**, a minor mode that lets a long chat outgrow its context: a cheap model folds older
  messages into summaries the model can open back up, and the transcript you read never changes.
- **Settings → Alignment**: align's writing style, its Visuals, and an adversarial review that has
  a fresh, read-only reviewer check the plan and the diff of risky work.
- **Subagent profiles** keep Delegate's routes under one name; workers come back as idle entries
  after a server restart.
- **Worktrees and the changes viewer**: a session tracks the git worktrees it works in, and what it
  changed reads as numbered steps, each with the agent's why.
- **The Overseer**, a session that reads all the others: it says what needs you, starts and prompts
  sessions, and confirms first when a request is risky.
- **Claude Code models** in chat and in workers, across several Claude logins with failover on a
  usage limit (logins read from the macOS keychain too).
- **A sandbox per session**, playbooks and schedules, and inline diagrams and charts (vis).

### Away from the desk

- **Your phone**: add Sova to the Home Screen, pair once, and get a push notification when a
  session needs you.
- **Share links**: read-only links to a session or part of it, as a snapshot or live, on an address
  you set up.
- **Mesh (preview)**: list and drive the sessions of every Sova host on your tailnet from one page.
- **Organizations (preview)**: hand one conversation from person to person, each through their own
  link, and keep every decision.

### Also

- A usage page, a resource monitor that charges load to the session that caused it, model rules,
  and local voice input.
- A website with docs for every mode and feature.

If you go back to v0.1.0 (`SOVA_REF=v0.1.0`), settings and sessions this release wrote may not read
the same there.
