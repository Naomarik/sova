# computers: your other computers, public links, and this computer's setup

All of this works in any folder. It's about this computer and how it reaches others, so most of it is the person's own to do on a screen. Sessions never move between computers: each is driven by the computer whose disk holds it.

## Your other computers

- Change: which other Sova computers this one lists as peers. With no peer, nothing changes: no extra port, no outbound request.
- Lives: this computer's list of peers, curated by the person. Being on the same tailnet makes nothing a peer. Each computer keeps its own list.
- Approves: the person, on each computer.
- By: Screen. Home, Mesh. Every computer in a mesh must be reachable by exactly the same devices: a device that can reach one can use all of them, as far as each one's grant allows.
- Live: now.
- Check: the Mesh page shows each host's state, and the session list shows every host's sessions.

## What each peer may see and do

- Change: each peer's grant here: `full`, `sessions`, `presence` or `none`, with finer switches. Granting sessions grants everything else in effect, since starting a session runs commands as the person.
- Lives: this computer only, never synced.
- Approves: the person, on this computer. Grants go per direction: what this computer can see on a peer is that peer's choice.
- By: Screen. The Mesh page, per host. A peer from the form starts at `presence`; a tailnet peer the file doesn't list has `full`.
- Live: now. Lowering a grant ends open connections.
- Check: the host's row on the Mesh page.

## A computer off the tailnet, a phone or a server

- Change: bring in a computer that dials out to a relay, an Android phone, or a VPS.
- Lives: pairings on the Mesh page, and the installers Sova carries for a phone and a server.
- Approves: the person, on both computers: each pastes the other's fingerprint and checks it by eye.
- By: Screen or Terminal. Pair a Host on the Mesh page; a phone or a VPS is set up from a terminal, and the root steps on a VPS are an admin's. /docs/phone goes further.
- Live: now, once both sides are paired.
- Check: the Dial-out pairings card shows it connected.

## What syncs

- Change: which kinds of thing reach this computer's peers: settings, themes, extensions (listed only, never run) and logins. Settings includes new-session defaults, model favorites and policy, request limits, the mode, Delegate, Spec and Align settings, the subagent profile library, and the person's session profiles, which also need the sessions grant.
- Lives: this computer's Settings → Mesh, and each peer's grant. Sova's own `settings.json` is among what syncs. Never synced: sessions, the theme a browser picked, the default subagent profile, device keys, a file that links into a Git checkout, and Claude Code's own login.
- Approves: the person.
- By: Screen. Settings → Mesh. Logins are chosen per peer on the Mesh page.
- Live: now, on every peer that's up with that category on. The newest version wins, and a replaced settings file is kept on the computer it was replaced on. A category can reach a peer through a third computer.
- Check: make a small change on one computer and look on another.

## Public links

- Change: where read-only links open for people outside: off, this computer as the gateway, or through a peer that is one. Also the public address, the preview address for running copies, the front, the local port, which computers send links here, and visitor logging.
- Lives: this computer, and environment variables win over it. The front is a web server or tunnel the person runs: Sova shows the steps and never writes its configuration. Sova's own page never goes public.
- Approves: the person.
- By: Card or Screen. Settings → Public links, then Verify Address. Running the front is theirs, in a terminal. It doesn't spread.
- Live: now, once saved and the front is up.
- Check: Verify Address reads "Verified". The chip says `Not listening` when the share port can't open.

## Sharing a chat

- Change: a read-only link to a chat, one per recipient, as a snapshot or following live.
- Lives: this computer. It needs public links set up.
- Approves: the person.
- By: Screen. The chat's Session detail, Sharing tab, Share Session. A link to a running copy of a project is different: see the `project` topic.
- Live: now.
- Check: the Shares page lists it, with who opened it.

## Reaching Sova from another device

- Change: whether a device can open this computer's Sova, and whether a peer's browsers may.
- Lives: the Access page and a host's details on the Mesh page. Each browser unlocks with a pairing code or the install's token. Neither passes through you.
- Approves: the person, on a device that's already unlocked.
- By: Screen. The Access page mints a short-lived, single-use pairing code. /docs/phone goes further.
- Live: now.
- Check: the device opens Sova.

## Updates

- Change: where updates come from, whether Sova checks by itself, and whether it upgrades by itself.
- Lives: this computer.
- Approves: the person, on the page. Upgrading is theirs, unless they've turned Upgrade automatically on.
- By: Screen. Settings → General, Updates · this machine. No card or command reaches it. /docs/updates goes further.
- Live: from the next check.
- Check: the section says what this computer runs and what's newer.

## Restarting Sova

- Change: nothing is configured: this picks up a change that needs a restart. Chats keep running through it.
- Lives: this computer's server.
- Approves: the person, with the inline confirm.
- By: Screen. Settings → General, Server · this machine.
- Live: now. New code reaches each open chat at its next quiet moment.
- Check: the same block says when the server started.

## Voice

- Change: dictation: setup, which model, and calibration for this device.
- Lives: this computer for the install and model; each browser for its own calibration.
- Approves: the person.
- By: Screen. Settings → Voice, or the composer's mic when voice isn't ready.
- Live: now, once set up.
- Check: dictate into the composer.

## Remote targets

- Change: a machine or container a chat's tools can run on, reached by ssh, Docker or an Incus cell.
- Lives: `targets.json` in the person's agent folder. It holds key paths and profile names only, never a key. It doesn't spread.
- Approves: the person, by their OK on the whole file.
- By: OK. Show the path and the whole change first.
- Live: new chats, from New Session → Remote.
- Check: start a chat on it and run a command. A chat on a remote machine has no project modes or cards.

The whole file, with one target:

```json
{"version": 1, "targets": [
  {"name": "acme-prod", "label": "acme prod", "kind": "ssh", "ssh": {"user": "deploy", "host": "192.0.2.10", "port": 22}, "cwd": "/srv/acme"}
]}
```

## Experimental switches

- Change: nothing today: Settings → Experimental has no features right now.
- Lives: the Experimental tab of Settings.
- Approves: nobody: there's no change to approve.
- By: None.
- Live: never, today.
- Check: the tab says so.

## Install and service

- Change: where Sova is installed, its port, and whether it starts at login.
- Lives: the install folder and a login service. Agents never edit the service.
- Approves: the person.
- By: Terminal. Re-run the installer with `--service`, `--port` or `--no-app-entry`. /docs/install goes further.
- Live: when the service restarts.
- Check: Settings → General, Server · this machine, shows what runs.

## Environment settings

- Change: what only the environment sets. `HOST`, `PORT`, `SOVA_PORT`, `PI_CODING_AGENT_DIR`; access: `SOVA_AUTH`, `SOVA_ALLOWED_HOSTS`, `SOVA_ALLOWED_ORIGINS`; runtime: `SOVA_RUNTIME`, `SOVA_BUN`, `SOVA_NODE`, `SOVA_DIST`, `SOVA_URL`; install: `SOVA_REF`, `SOVA_NO_APP_ENTRY`; updates: `SOVA_UPDATES_CHECK`; tours: `SOVA_TOUR_BROWSER`; mesh: `SOVA_PEER_PORT`, `SOVA_PEER_HOST`, `SOVA_MESH_IDENTITY`, `SOVA_TAILSCALE_SOCKET`, `SOVA_SYNC_LOGIN_KINDS`, `SOVA_BROWSER_ACCESS`; public links: `SOVA_SHARE_PUBLIC_URL`, `SOVA_SHARE_HOST`, `SOVA_SHARE_PORT`, `SOVA_SHARE_PREVIEW_URL`; extensions: `SOVA_EXTENSIONS_FILE`; keys: `SOVA_JEV_KEY`; voice: `SOVA_VOICE_DIR`, `SOVA_VOICE_MODEL`; usage: `SOVA_USAGE_POLL`, `SOVA_PRICES_FETCH`; chats: `SOVA_CHAT_IDLE_MIN`, `SOVA_CHAT_CLAUDE_IDLE_MAX`, `SOVA_SCRIPT_NICE`; uploads: `SOVA_BATON_UPLOADS_MAX_MB`, `SOVA_BATON_UPLOADS_FREE_MB`, `SOVA_PROJECT_FILES_MAX_MB`, `SOVA_PROJECT_FILES_FREE_MB`; others: `SOVA_GIT_MAINTENANCE`, `SOVA_LEAK_NAMES`, `SOVA_PROJECT_NO_SYSTEMD`, `SOVA_WA_HOME`, `SOVA_WA_SOCKET`, `SOVA_WA_LIMITS`, `SOVA_WA_LOG_LEVEL`.
- Lives: the environment of the server's service, on this computer.
- Approves: the person.
- By: Terminal. A chat can't set these for the server.
- Live: restart.
- Check: `/api/health` on this computer says what runs. An address or port set this way shows as pinned on its screen.
