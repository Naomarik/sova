# The WhatsApp sender

[← Outreach](README.md)

Sova sends WhatsApp messages from a real WhatsApp number through a small separate program, the
**sender** (`services/whatsapp`, command `sova-whatsapp`). The sender is a *linked device* of that
number, like WhatsApp Web: you link it once from the phone, and it holds one connection open from
then on. Sova talks to it over a Unix socket on the same host, or, from other hosts, through that
host's Sova.

```
Sova on this host ──Unix socket (IPC v1)──▶ sova-whatsapp ──WhatsApp Web──▶ WhatsApp
Sova on another host ──peer listener──▶ Sova on the sender's host ──┘
```

This guide sets it up from nothing on a fresh host. Every command is run as the user the sender runs
as, never root. Paths below are the defaults; every one of them can be changed
([Configure](#3-configure)).

- [Before you start: the risks](#before-you-start-the-risks)
- [1. Requirements](#1-requirements)
- [2. Install](#2-install)
- [3. Configure](#3-configure)
- [4. Pair](#4-pair)
- [5. Run it as a service](#5-run-it-as-a-service)
- [6. Connect Sova](#6-connect-sova)
- [7. Protect the credentials](#7-protect-the-credentials)
- [8. Verify](#8-verify)
- [9. Operate](#9-operate)
- [10. Recover](#10-recover) — with a table of every state
- [Move the sender to another host](#move-the-sender-to-another-host)
- [Uninstall](#uninstall)
- [Develop and test without WhatsApp](#develop-and-test-without-whatsapp)

## Before you start: the risks

- **It is your number.** Messages go out from the number you link, and they stay in that
  number's chats (and its phone backups). Anyone who can open that chat can open a person's link
  and act as them, the same as if you had pasted the link by hand.
- **Unofficial API.** The sender uses [Baileys](https://github.com/WhiskeySockets/Baileys), which
  speaks the WhatsApp Web protocol. WhatsApp does not endorse it, and can restrict or ban an account
  that behaves like a bot. The sender is built to look like one quiet WhatsApp Web device: one
  connection, few reconnects, a few messages an hour at most, and it never reads your chats. Keep its
  limits low ([Operate](#9-operate)).
- **A server's address may look riskier.** Whether WhatsApp treats a linked device on a datacenter
  (VPS) address differently from one at home is unknown. For the first weeks, keep the limits low and
  watch for `blocked` ([Recover](#10-recover)).
- **Whoever can read the credentials directory can send as you.** It is as sensitive as the phone
  itself ([Protect](#7-protect-the-credentials)).

## 1. Requirements

- A host that stays on: the sender keeps the connection open, and sends only while it runs. On a
  set-up with several Sova hosts, run it on the always-on one, usually the public-links gateway.
  Linux with systemd is described here; any supervisor works ([Run it as a service](#5-run-it-as-a-service)).
- **Node.js 22.19 or later** (`node --version`), and about 200 MB of memory for the sender (it idles
  at about 160 MB and a few milliseconds of CPU a minute), plus about 10 MB of disk for its keys.
- **pnpm 12.6.0**, the version `services/whatsapp/package.json` pins. Either of:
  - `corepack enable` (ships with Node; it then runs the pinned pnpm on its own), or
  - [mise](https://mise.jdx.dev): `mise use -g node@22 npm:pnpm@12.6.0`.

  pnpm only: never `npm install` or `npm ci` here, and never add a `package-lock.json`.
- A copy of this repository (the sender needs only `services/whatsapp/`), for example
  `git clone https://github.com/Naomarik/sova ~/sova`.
- The phone with the WhatsApp account to send from, at hand for pairing. It must stay a working
  WhatsApp phone: a linked device stops working if the phone is offline for about 14 days.

## 2. Install

```sh
cd ~/sova/services/whatsapp
pnpm install --frozen-lockfile
node bin/sova-whatsapp.mjs check-config
```

`services/whatsapp` is its own pnpm project, with its own lockfile: this installs the sender's
dependencies only, not Sova's. No install script runs (`pnpm-workspace.yaml` lists why none is
needed). `check-config` should end with `problems: none`.

The rest of this guide writes `sova-whatsapp` for `node ~/sova/services/whatsapp/bin/sova-whatsapp.mjs`.
To type it that way too:

```sh
alias sova-whatsapp="node $HOME/sova/services/whatsapp/bin/sova-whatsapp.mjs"
```

## 3. Configure

The defaults suit most hosts; skip this section unless you need to change one. Each setting comes
from the environment, else from `$SOVA_WA_HOME/config.json`, else its default. Prefer
`config.json`: the service and your shell then read the same values.

| Setting | Default | What it is |
|---|---|---|
| `SOVA_WA_HOME` | `<PI_CODING_AGENT_DIR or ~/.pi/agent>/sova/whatsapp` | The sender's directory: its state, its socket, `config.json`. Environment only. |
| `SOVA_WA_AUTH_DIR` | `$SOVA_WA_HOME/auth` | The linked device's credentials. |
| `SOVA_WA_SOCKET` | `$SOVA_WA_HOME/sender.sock` | Where Sova reaches the sender. |
| `SOVA_WA_LIMITS` | `3/20/60` | Seconds between two sends / sends per hour / sends per day. |
| `SOVA_WA_RECONNECT_BUDGET` | `3/10` | Automatic reconnects per hour / per day, starts included. |
| `SOVA_WA_SEND_WAIT_S` | `15` | How long a send waits for the connection before failing with `not-connected`. |
| `SOVA_WA_DEVICE_NAME` | `Sova` | The name the phone shows under Linked devices. |
| `SOVA_WA_LOG_LEVEL` | `warn` | `warn`, `info` or `debug`. No level logs a message, a full number or a key. |

`config.json` holds the same names, all but `SOVA_WA_HOME`, and anything else in it stops the
sender with an error. The sender creates its directory owner-only (`0700`) when it first runs;
creating it yourself before that, keep it so, or the sender refuses to start:

```sh
mkdir -p ~/.pi/agent/sova && mkdir -m 700 ~/.pi/agent/sova/whatsapp
cat > ~/.pi/agent/sova/whatsapp/config.json <<'JSON'
{ "SOVA_WA_LIMITS": "5/10/30", "SOVA_WA_DEVICE_NAME": "Sova (office)" }
JSON
```

The default home follows `PI_CODING_AGENT_DIR`, as Sova's does, so a Sova on the same host finds the
socket without being told. If you set `SOVA_WA_HOME` or `SOVA_WA_SOCKET` yourself, set it for the
service and in your shell profile both, and give Sova the socket path ([Connect Sova](#6-connect-sova)).

Check the result any time with `sova-whatsapp check-config`: it prints every value and where it came
from (`env`, `file` or `default`), and exits non-zero with the reason when the sender would refuse
to start. It refuses when:

- the home or the auth directory can be read or written by group or others: `chmod 700` it;
- either sits inside a git work tree (credentials never live in a repository): pick another path;
- the socket path is longer than a Unix socket allows (about 100 bytes): pick a shorter one.

## 4. Pair

Pairing links the sender to your phone. It happens once, on the sender's host: never pair a second
copy anywhere else ([Move the sender](#move-the-sender-to-another-host) instead).

```sh
sova-whatsapp pair
```

A QR code appears in the terminal (over SSH too). On the phone: **WhatsApp → Settings → Linked
devices → Link a device**, and scan it. The code is replaced every 20 seconds or so; after a couple
of minutes without a scan it stops with "The QR code expired", and you run `pair` again.

If a QR can't be scanned (no camera at hand, a terminal too small), use a pairing code instead,
with the phone's own number, country code first, digits only:

```sh
sova-whatsapp pair --code 15551234567
```

It prints an 8-character code. On the phone: **Linked devices → Link a device → Link with phone
number instead**, and type it.

Either way the terminal ends with `Paired and connected.`, and the phone lists the device under the
name `SOVA_WA_DEVICE_NAME` (default `Sova`). If the service is already running, `pair` asks it to
link instead of opening a second connection; otherwise it links, stays connected a few seconds for
the first key uploads, and exits. `pair` refuses when a device is already linked.

The sender never marks itself online, so your phone keeps notifying you of incoming messages as
before. It never reads them: incoming messages are dropped unread.

## 5. Run it as a service

The sender must run all the time, exactly once. With systemd, as a user service:

```sh
mkdir -p ~/.config/systemd/user
cp ~/sova/services/whatsapp/sova-whatsapp.service.example ~/.config/systemd/user/sova-whatsapp.service
$EDITOR ~/.config/systemd/user/sova-whatsapp.service   # the two EDIT paths: node and the checkout
systemctl --user daemon-reload
systemctl --user enable --now sova-whatsapp
loginctl enable-linger "$USER"   # keep user services running without a login session
```

The unit restarts the sender after a crash, a minute later, at most 3 times an hour (each start is
a WhatsApp connection), and not at all after a configuration refusal. Stopping it (`systemctl --user
stop sova-whatsapp`) closes the connection and leaves the device linked. Sova never starts, stops or
restarts the sender, and restarting Sova does not touch it.

Without systemd, use any supervisor that restarts on failure with a delay and never runs two
copies (runit, s6, supervisord, a container with `restart: on-failure`), running
`node <checkout>/services/whatsapp/bin/sova-whatsapp.mjs run` with a umask of 077. A second copy
refuses to start while the first answers on the socket; two copies on two hosts with the same
credentials knock each other off (`replaced`).

## 6. Connect Sova

**On the sender's host.** In Sova, open **Settings → Outreach**, choose **This host** under
**Sender**, and press **Save Changes**. Leave **Socket** empty for the default; if you changed
`SOVA_WA_SOCKET`, or the sender runs with a different `PI_CODING_AGENT_DIR` than Sova, enter the
path `sova-whatsapp check-config` prints. The sender's state appears under it as a chip; it should
read **Connected** (every chip is in the [table below](#10-recover)).

**On other hosts** (a mesh of Sova hosts, [docs/mesh.md](../mesh.md)): they reach the sender through
its host's Sova, over the same authenticated peer listener public links use.

1. The two hosts must be peers: each lists the other in its peers, as for any mesh feature.
2. On the sender's host, in **Settings → Outreach**, under **Accept sends from**, choose **All
   peers** or tick the hosts that may send, and **Save Changes**.
3. On the other host, in **Settings → Outreach**, choose **Via a peer** under **Sender**, pick the
   sender's host as the **Peer**, and **Save Changes**. Its chip shows the sender's state as well.

Pairing, unlinking and reconnecting happen only on the sender's host, with `sova-whatsapp`: no
Sova, not even the sender host's own, can pair or unlink the number. All hosts share the one
number's limits.

## 7. Protect the credentials

The auth directory is the linked device. Anyone who can read it can send, and read new messages,
as your number, from anywhere, until you unlink the device on the phone.

- It is created `0700` with `0600` files, and the sender refuses to start if that loosens.
- Keep it out of backups you would not trust with the phone, out of any repository, and never copy
  it except to [move the sender](#move-the-sender-to-another-host).
- Sova keeps its Overseer's file tools out of the default directory, pi's default one, and the
  directory the local sender reports, and its seeded sandbox policy hides `$AGENT_DIR/sova/whatsapp`
  from sandboxed agents. **Settings → Outreach** lists them under **Protected paths**, and warns
  when the sender's directory isn't hidden from sandboxed agents.
- The policy is a copy made when pi-config was installed, so an older copy lacks that entry: check
  that the `hidden` list of `<agent dir>/sandbox-policy/linux/policy.json` (`darwin` on a Mac) holds
  `"$AGENT_DIR/sova/whatsapp"`, and add it if not. With a non-default `SOVA_WA_HOME` or
  `SOVA_WA_AUTH_DIR`, add that path there too, or sandboxed agents can read it.
- No list can protect it from an unsandboxed shell running as the same user: agents you run without
  the sandbox on this host can read it. A separate user account for the sender closes that gap
  (give Sova's user access to the socket only, by group and `SOVA_WA_SOCKET` in a shared directory).

## 8. Verify

1. `sova-whatsapp status` prints `running: yes` and `state: open`, the linked number's last three
   digits, and the limits used.
2. **Settings → Outreach** on each host that sends shows the chip **Connected**.
3. Send one real link: in a test organization, put someone on the roster whose WhatsApp you can see
   (a second phone of yours, or a colleague who expects it), with that number, start a gathering that
   hands off to them, and press **Send on WhatsApp**. The message arrives from your number. Their
   page in the organization lists the send, then `delivered` and `read` as the receipts come in.

## 9. Operate

- **Limits.** By default at most one send every 3 seconds (queued, not refused), 20 an hour and 60
  a day, across every host sending through this sender. A send past them fails with `limited` and the
  time a slot frees. Lower them for a new number or a VPS; raise them slowly, if ever.
- **Pause.** **Pause all sending** in Settings → Outreach stops that host's sends. `sova-whatsapp
  pause` stops every host's, at the sender (`resume` undoes it; the sender also pauses itself when
  WhatsApp blocks or restricts the account). The connection stays up either way.
- **Logs.** `journalctl --user -u sova-whatsapp`: state changes and failures, warn level by default.
  They name no message and no full number; digit runs show as their last three digits.
  `SOVA_WA_LOG_LEVEL=info` adds each send's reference.
- **The reconnect budget.** The sender reconnects on its own only after a routine drop, 30 s later,
  then 1, 2, 4 … up to 30 minutes apart, and at most 3 times an hour and 10 a day, starts included.
  Past that it stays `down` until you reconnect it.
- **Updating.** `git pull`, then `pnpm install --frozen-lockfile` in `services/whatsapp`, then
  `systemctl --user restart sova-whatsapp`. A restart is one reconnect: don't restart it needlessly.
- **Status any time.** `sova-whatsapp status` (`--json` for scripts) asks the running sender, or,
  when it isn't running, reads its files.

## 10. Recover

Every state the sender reports: `sova-whatsapp status` prints the state, why, and the next step;
Settings → Outreach shows the chip. Only `connecting` fixes itself; every other stop waits for you,
across restarts. Every fix runs on the sender's host with `sova-whatsapp`, so a host without Sova's
page (a headless gateway) needs nothing else.

| `status` | Settings chip | What it means | What to do |
|---|---|---|---|
| `open` | Connected | Connected; sends go. | Nothing. |
| `connecting` | Connecting | Opening, or waiting to reconnect after a routine drop (`status` shows the next try's time). | Wait. If it keeps coming back, check the host's network. |
| `unpaired` | Not paired | No device linked (a new install, or after `unlink`). | [Pair](#4-pair). |
| `linking` | Not paired | A pairing is waiting for the phone. | Scan the QR or type the code. |
| `logged-out` | Logged out | The phone unlinked this device, or WhatsApp stopped accepting its credentials. | [Logged out](#logged-out) |
| `replaced` | Replaced | Another copy opened the same credentials. | [Replaced](#replaced) |
| `blocked` | Blocked | WhatsApp refused the account, or restricted it from new chats. Sending is paused. | [Blocked or restricted](#blocked-or-restricted) |
| `down` | Down | The reconnect budget is spent, WhatsApp reported a bad session, or something local failed. | [Down](#down) |
| `running: no` | Not reachable | Sova can't reach the socket. | [Sova can't reach the sender](#sova-cant-reach-the-sender) |

### Logged out

The device was removed under Linked devices on the phone, or WhatsApp no longer accepts its
credentials. The sender keeps the old credentials and does nothing on its own. To link again:

```sh
sova-whatsapp unlink --yes   # deletes the dead credentials
sova-whatsapp pair
```

### Replaced

A second process opened the same credentials: another copy on this host (a manual `run` next to
the service) or on another host (a copied auth directory). Find and stop the other one for good, then
run `sova-whatsapp reconnect` on this host. Never let two run: each start knocks the
other off, and WhatsApp sees a device flapping.

### Blocked or restricted

WhatsApp refused the account (403) or restricted it from starting chats (a send failed with 463).
The sender paused sending and stays disconnected. Stop and wait, a day or more; check the phone for
a notice from WhatsApp. Then lower the limits ([Configure](#3-configure)), restart the service to
apply them, and turn sending back on: `sova-whatsapp reconnect`, then `sova-whatsapp resume`. Never retry the failed messages in a burst: each retry counts as another reach
out.

### Down

The status says which:

- **Reconnect budget spent:** the network or WhatsApp dropped the connection too often. Fix the
  network if it's the cause, then `sova-whatsapp reconnect` (a manual reconnect is outside the
  budget).
- **Bad session (500):** reconnect once; if it comes back, [unlink and pair again](#logged-out).
- **WA Web version rejected (405):** the sender fetches the current version once by itself; if it's
  still refused, [update the sender](#9-operate): WhatsApp has changed something Baileys must follow.
- **`state.json` could not be read:** look at `$SOVA_WA_HOME/state.json` (a full disk?), move it
  aside if it's damaged, then reconnect.
- **The connection could not be opened:** the message names the error, often a permission problem
  on the auth directory.

### Sova can't reach the sender

On the sender's host, `sova-whatsapp status` should say `running: yes`; if not,
`systemctl --user status sova-whatsapp` and the log say why. Check that Sova uses the same socket
path as `sova-whatsapp check-config` prints (a different `PI_CODING_AGENT_DIR` changes the default).
From another host, check that the two are peers and that the sender's host allows this one.

## Move the sender to another host

Pair on the new host if you can: `unlink --yes` on the old one, then [install](#2-install) and
[pair](#4-pair) on the new one. To move the existing link instead, without touching the phone:

1. On the old host, stop it and keep it stopped: `systemctl --user disable --now sova-whatsapp`.
2. Copy the directory with its modes (the auth directory and `state.json`, which carries the
   reconnect budget and which messages were sent):
   ```sh
   tar -C ~/.pi/agent/sova/whatsapp -cpf - auth state.json | \
     ssh newhost 'mkdir -p -m 700 ~/.pi/agent/sova/whatsapp && tar -C ~/.pi/agent/sova/whatsapp -xpf -'
   ```
3. On the new host: [install](#2-install), then `sova-whatsapp check-config` and
   `sova-whatsapp status` (`paired: yes`), then [run it as a service](#5-run-it-as-a-service).
4. Only once it reads `open` there: delete the old copy (`rm -rf ~/.pi/agent/sova/whatsapp` on the
   old host), and point every Sova at the new host ([Connect Sova](#6-connect-sova)).

Two hosts must never run on the same credentials, not even briefly: they replace each other and race
on the key files.

## Uninstall

```sh
sova-whatsapp unlink --yes            # logs the device out and deletes its credentials
systemctl --user disable --now sova-whatsapp
rm ~/.config/systemd/user/sova-whatsapp.service
rm -rf ~/.pi/agent/sova/whatsapp      # or your SOVA_WA_HOME
```

Then set **Sender** to **Off** in Settings → Outreach on every host. If `unlink` could not reach
WhatsApp, also remove the device on the phone: **Linked devices**, tap it, **Log out**.

## Develop and test without WhatsApp

`scripts/fake-whatsapp-sender.mjs` runs the sender's own state machine and socket protocol over a
fake WhatsApp: no Baileys, no network, no credentials, and no install in `services/whatsapp`. With a
hermetic Sova (`pnpm run dev:hermetic`):

```sh
PI_CODING_AGENT_DIR=$PWD/.agent node scripts/fake-whatsapp-sender.mjs           # paired and open
PI_CODING_AGENT_DIR=$PWD/.agent node scripts/fake-whatsapp-sender.mjs --unpaired  # to try pairing
PI_CODING_AGENT_DIR=$PWD/.agent node scripts/fake-whatsapp-sender.mjs ctl close 401   # → logged-out
```

It refuses to run on the real default directory. `SOVA_WA_FAKE_ABSENT=<digits,…>` makes numbers
unknown to WhatsApp, `SOVA_WA_FAKE_RECEIPTS` sets the receipts (`delivered,read`, `delivered` or
`none`), and `ctl` also takes `ack-error 463` (the next send is failed by WhatsApp) and `send-throw`.
The protocol is [services/whatsapp/IPC.md](../../services/whatsapp/IPC.md); the sender's own tests
run with `pnpm test` in `services/whatsapp`.
