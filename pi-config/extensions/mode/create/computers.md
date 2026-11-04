# computers: your other computers, public links, and this computer's setup

All of this works in any folder. It's about this computer and how it reaches others, and most of it changes on a screen today. Sessions never move between computers: each is driven by the computer whose disk holds it.

You never restart or update Sova, by any command, `server.restart` included. Name the control below for the person, and never report something you didn't do.

To link computers, read where things stand with `sova_settings` get: each computer's state, access and pairing role, what syncs, the front door and the relay, never a key or pin. Say which step they're on, and go through these in order, one at a time, each by its section below. A computer that isn't linked yet is out of your reach, so give the exact steps to do there. Never put a pairing code, token or secret in chat text.

1. Choose the way: the same tailnet, or a pairing for a computer off it. Say first that every device reaching one computer can reach them all, as far as each grant allows.
2. Name this computer: `mesh.settings` with `hostLabel`.
3. The other computer needs Sova running (/docs/install, /docs/phone), and for a tailnet both need Tailscale on.
4. Link it here: `mesh.peer-add` on a tailnet, `mesh.pairing` off it. Linking is one-sided.
5. Link this computer there, from that computer's own Sova: give the exact steps. Until then a peer reads refused: "this host is not in its peers.json".
6. Set what each may see and do, on each computer: `mesh.access`. The card shows every computer's access after the change, so point the person to it.
7. Choose what syncs: `mesh.settings` with `sync`. A login already sent can't be recalled.
8. If they want it: the front door, `mesh.settings` with `frontDoor`, and a gateway for public links.

When it's stuck: `down`: that computer's off or unreachable. `skewed`: they run different builds; for one that's behind, offer `mesh.resync`. `hidden`: that computer grants this one nothing, so change the grant there. Half connected: one side of a pairing isn't up yet. An error instead of a state: this computer's peers file is invalid and the mesh is off, so fix that first.

These have no card, so name the place: links between computers are on the session pane's Agents tab, claiming a login on the Mesh page under Sync, and an internet relay on the Mesh page under Dial-out pairings. A resync's recipe, how to bring one computer up to this build, is the card `mesh.resync-recipe`, one computer per card; a dial-out pairing has none. A recipe on a card wins over one derived from a deploy script's `local.env`, which a card neither reads nor changes. Use `sova_settings` reference for each id's exact value. Report only what `get` reads: never say a link works until it reads `up` on this computer.

## Your other computers

- Change: which other Sova computers this one lists as peers. With no peer, nothing changes: no extra port, no outbound request.
- Lives: this computer's list of peers, curated by the person. Being on the same tailnet makes nothing a peer. Each computer keeps its own list.
- Approves: the person, by Apply on each computer. The card marks a new link as a grant.
- By: Card or Screen. `mesh.peer-add` links one on this tailnet. A new computer must name its access, `preset`, and there's no default. `mesh.peers` holds the whole list of those already linked: rename, order, addresses, or remove, which ends its access at once. A card can't change a computer's identity. The Mesh page has the same controls. Every computer in a mesh must be reachable by exactly the same devices: a device that can reach one can use all of them, as far as each one's grant allows.
- Live: now on this computer. The link works once the other computer has linked this one too.
- Check: `get` and the Mesh page show each computer's state: `up` means it answers.

## What each peer may see and do

- Change: each peer's grant here: `full`, `sessions`, `presence` or `none`, with finer switches. Granting sessions grants everything else in effect, since starting a session runs commands as the person.
- Lives: this computer only, never synced.
- Approves: the person, on this computer. Grants go per direction: what this computer can see on a peer is that peer's choice.
- By: Card or Screen. `mesh.access`, one computer per card, or the Mesh page, per host. A peer from the form starts at `presence`; a tailnet peer the file doesn't list has `full`.
- Live: now. Lowering a grant ends open connections.
- Check: the host's row on the Mesh page.

## A computer off the tailnet, a phone or a server

- Change: bring in a computer that dials out to a relay, an Android phone, or a VPS.
- Lives: pairings on the Mesh page, and the installers Sova carries for a phone and a server.
- Approves: the person, on both computers: each types the other's fingerprint into the card's own field or the Mesh page and checks it by eye. Never ask for a fingerprint or pin in chat. If they paste one, say you can't use it and point them to the card's own field.
- By: Card or Screen or Terminal. `mesh.pairing` pairs a computer, each doing its half in its own Sova; `mesh.relay` sets this computer's own relay address on the local network; Pair a Host on the Mesh page does the same. A phone or a VPS is set up from a terminal, and the root steps on a VPS are an admin's. /docs/phone goes further.
- Live: now, once both sides are paired.
- Check: the Dial-out pairings card shows it connected.

## What syncs

- Change: which kinds of thing reach this computer's peers: settings, themes, extensions (listed only, never run) and logins. Settings includes new-session defaults, model favorites and policy, request limits, the mode, Delegate, Spec and Align settings, the subagent profile library, and the person's session profiles, which also need the sessions grant.
- Lives: this computer's Settings → Mesh, and each peer's grant. Sova's own `settings.json` is among what syncs. Never synced: sessions, the theme a browser picked, the default subagent profile, device keys, a file that links into a Git checkout, and Claude Code's own login.
- Approves: the person, by Apply or on the tab. More reaching other computers is marked as a grant.
- By: Card or Screen. `mesh.settings` with `sync`, or Settings → Mesh. Which logins go to a peer is its grant, `mesh.access`.
- Live: now, on every peer that's up with that category on. The newest version wins, and a replaced settings file is kept on the computer it was replaced on. A category can reach a peer through a third computer.
- Check: make a small change on one computer and look on another.

## Public links

- Change: where read-only links open for people outside: off, this computer as the gateway, or through a peer that is one. Also the public address, the preview address for running copies, the front, the local port, which computers send links here, and visitor logging.
- Lives: this computer, and environment variables win over it. The front is a web server or tunnel the person runs: Sova shows the steps and never writes its configuration. Sova's own page never goes public.
- Approves: the person.
- By: Screen. Settings → Public links, then Verify Address. Running the front is theirs, in a terminal. It doesn't spread.
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
- By: Card or Screen. The Access page mints a short-lived, single-use pairing code, which is the person's alone. `mesh.browser-access` sets whether a computer in the mesh has a browser address. /docs/phone goes further.
- Live: now.
- Check: the device opens Sova.

## Updates

- Change: where updates come from, whether Sova checks by itself, and whether it upgrades by itself.
- Lives: this computer.
- Approves: the person, on the page. Upgrading is theirs, unless they've turned Upgrade automatically on.
- By: Screen. Settings → General, Updates · this machine. You never update Sova yourself. /docs/updates goes further.
- Live: from the next check.
- Check: the section says what this computer runs and what's newer.

## Restarting Sova

- Change: nothing is configured: this picks up a change that needs a restart. Chats keep running through it.
- Lives: this computer's server.
- Approves: the person, with the inline confirm.
- By: Screen. Settings → General, Server · this machine. You never restart Sova yourself.
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
- Lives: `<agent dir>/targets.json`. It holds key paths and profile names only, never a key. It doesn't spread.
- Approves: the person, by Apply.
- By: Card. The Sova-wide setting `remote.targets`, with `sova_settings` reference for its value.
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

- Change: what only the environment sets. `HOST`, `PORT`, `SOVA_PORT`, `PI_CODING_AGENT_DIR`; access: `SOVA_AUTH`, `SOVA_ALLOWED_HOSTS`, `SOVA_ALLOWED_ORIGINS`; runtime: `SOVA_RUNTIME`, `SOVA_BUN`, `SOVA_NODE`, `SOVA_DIST`, `SOVA_URL`; install: `SOVA_REF`, `SOVA_NO_APP_ENTRY`; updates: `SOVA_UPDATES_CHECK`; tours: `SOVA_TOUR_BROWSER`; mesh: `SOVA_PEER_PORT`, `SOVA_PEER_HOST`, `SOVA_MESH_IDENTITY`, `SOVA_TAILSCALE_SOCKET`, `SOVA_SYNC_LOGIN_KINDS`, `SOVA_BROWSER_ACCESS`; public links: `SOVA_SHARE_PUBLIC_URL`, `SOVA_SHARE_HOST`, `SOVA_SHARE_PORT`, `SOVA_SHARE_PREVIEW_URL`; extensions: `SOVA_EXTENSIONS_FILE`; keys: `SOVA_JEV_KEY`; voice: `SOVA_VOICE_DIR`, `SOVA_VOICE_MODEL`; usage: `SOVA_USAGE_POLL`, `SOVA_PRICES_FETCH`; chats: `SOVA_CHAT_IDLE_MIN`, `SOVA_CHAT_CLAUDE_IDLE_MAX`, `SOVA_SCRIPT_NICE`; uploads: `SOVA_BATON_UPLOADS_MAX_MB`, `SOVA_BATON_UPLOADS_FREE_MB`, `SOVA_PROJECT_FILES_MAX_MB`, `SOVA_PROJECT_FILES_FREE_MB`; stall recorder: `SOVA_STALL_RECORDER=off` turns it off, `SOVA_STALL_STACKS=off` keeps it without stacks; others: `SOVA_GIT_MAINTENANCE`, `SOVA_LEAK_NAMES`, `SOVA_PROJECT_NO_SYSTEMD`, `SOVA_WA_HOME`, `SOVA_WA_SOCKET`, `SOVA_WA_LIMITS`, `SOVA_WA_LOG_LEVEL`.
- Lives: the environment of the server's service, on this computer.
- Approves: the person.
- By: Terminal. A chat can't set these for the server.
- Live: restart.
- Check: `/api/health` on this computer says what runs. An address or port set this way shows as pinned on its screen.
