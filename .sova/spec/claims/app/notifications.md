# §app/notifications — Phone notifications
> Part of the Sova design spec · [overview](../design/overview.md)

Sova can tell a phone (or any browser) that a session needs you, through the browser's Web Push
service, while no Sova page is open. It is the sidebar's Needs you (§app.session-list/needs-you)
arriving on the lock screen: the same act-tier blockers of the attention digest
(§app.overseer/attention-digest), organization sessions included. It is independent of the
Overseer: it has its own switch, works under every Proactivity mode (§app.overseer/proactivity),
List Only and Off included, and works before any Overseer session exists. It never starts a model
turn and costs no tokens.

Web Push is the browser's standard: the server signs each request with its own key (VAPID, RFC
8292), encrypts the payload for one device (RFC 8291, `aes128gcm`, RFC 8188), and POSTs it to the
push service that device's browser chose (Google's, Apple's, Mozilla's). The push service sees
only ciphertext and the contact address; the page need not be open, and the phone need not reach
the Sova server to receive one — only to open what it points at. Built on Node's own crypto, with
no dependency.

Sova-owned state under `<stateRoot>`:
- `secrets/vapid.json` — the server's signing key pair (`{publicKey, privateKey, createdAt}`,
  P-256, base64url). Made on first use, in a directory only the user can read (0700, the file
  0600), and never rotated by Sova: a new key orphans every device's subscription. The private key
  never leaves the server and is one of the values the Overseer's redactor hides
  (§app.overseer/tools).
- `push-subscriptions.json` — the devices: each one's push endpoint and keys, a label, when it was
  added, and its last delivery or error. The wire never carries an endpoint or a key back out.
- `push.json` — the settings (§app.notifications/settings).

All writes are atomic tmp+rename; reads are tolerant (a bad field falls back to its default, a bad
device entry is skipped).

**Platforms.** A secure context is required: `https://`, or `http://localhost`. On iPhone and iPad
(iOS 16.4+) only an app added to the Home Screen can subscribe, and the permission prompt must come
from a tap inside it; Safari in a tab cannot. iOS also revokes a subscription whose pushes don't
show a notification, so every push shows one — nothing is filtered on the phone, everything is
decided on the server. Android and desktop browsers work installed or in a tab. A subscription
belongs to one origin: the same phone opening Sova at another address is another device.

## §app.notifications/delivery — What is sent, and when

The server's Overseer loop (every 20 seconds) reads the attention digest and hands its act tier
to one pure decision, with no model call. Its unit is a blocker, `sessionId:kind` — the same key
Brief Me uses — and each is sent **at most once, until it clears**: a blocker that leaves the act
tier and comes back is new again.

- **Kinds.** `needs-input` (a dialog is open), `asks-you` (the last reply asks you something;
  exists only while attention signals are on, §app.decisions/attention-signals), `error` (the
  last turn stopped with an error), `looping` (a subagent looks stuck — a main session's own
  looping is not a blocker), `baton-needs-you` (a baton session waits on you) and `worker-error`
  (a subagent ended in an error). Each can be switched off; all are on by default except
  `worker-error`.
- **Nothing old on start.** The first reading after the server starts is the baseline: blockers
  already there are never sent. The told-set is kept in memory only.
- **Told without sending** — dropped for good, not held: when sending is off, no contact address
  is set, no device is subscribed, its kind is off, it arrives during quiet hours, or its session
  is open in a Sova page right now (a chat or watch socket shows it). Quiet hours drop, never
  queue: nothing arrives in a burst when they end.
- **One send per 30 seconds.** Blockers that arrive within 30 seconds of the last send wait and go
  out together with the next; one that clears while waiting is never sent.
- **One notification per send.** Blockers of one session: its title is "{Kind} · {session title}"
  (the most urgent kind, in the digest's order) and its body the detail sentence(s) the digest
  gives; its tag is `sova:{sessionId}`, so a newer one for the same session replaces the older
  on the device instead of stacking. Blockers of several sessions: "{n} sessions need you", the
  body one line per session ("{session title} — {Kind}"), tag `sova:several`. Kind words:
  Needs input, Asks you, Error, Subagent stuck, Baton, Subagent error. While nothing could be sent
  (sending off, no contact, no device) the loop doesn't read the digest for this at all, and its
  first reading once something could be sent is a new baseline — the same outcome as dropping.
- **Redacted.** Titles and details come from other sessions and show on a lock screen: both go
  through the server's redactor (§app.overseer/tools) before they are encrypted. Titles are cut at
  80 characters, the body at 300.
- **A tap** opens that session (`#/sid/{sessionId}`) for one session, the Overseer (`#/overseer`)
  for several. An open Sova window is focused and navigated in place; with none, a new one opens
  there.
- **App badge.** Each notification carries how many sessions need you now; where the browser
  supports app badges (an installed app), the icon shows that number. An open Sova page keeps it
  current from the digest it already reads, clearing it at zero, once notifications are allowed
  for it.
- **Every device.** A send goes to every subscribed device at once, each encrypted for itself,
  urgency high, kept by the push service up to 6 hours. A device the push service answers 404 or
  410 is gone and is removed; any other failure is kept on the device as its last error, and it
  stays subscribed.
- **No silent pushes.** The service worker shows a notification for every push it receives,
  whatever the payload — with a generic "Sova" title when it can't read one.

## §app.notifications/settings — Settings → Overseer → Phone notifications

A **Phone Notifications** section at the end of Settings → Overseer, after the Overseer form's
"Stored in" line. Two kinds of control: the settings (saved with the dialog's **Save Changes**,
as the form "Phone Notifications", §app.settings-dialog/save-bar), and actions on this device and
the device list, which run at once.

- **Intro.** One sentence: Sova can notify your phone when a session needs you, even with Sova
  closed.
- **This device.** A status line and one action:
  - Not supported here (no service worker or Push API, or not a secure context): says so, and no
    button. On an iPhone or iPad that is not running Sova from the Home Screen: "On iPhone and
    iPad, add Sova to your Home Screen first, then open it from there to turn this on."
  - Blocked in the browser's settings: says so, and no button.
  - Not subscribed: **Enable on This Device** (primary). It asks the browser's permission and
    subscribes this browser with the server's public key, then lists it. A refusal says what
    happened, and nothing is stored; so does a push service that doesn't answer within 30 seconds.
  - Subscribed: "On for this device." with **Turn Off on This Device**, which unsubscribes the
    browser and removes it from the server.
- **Devices.** Every subscribed device: its label (browser and platform, from the browser that
  subscribed; "· this device" on the one showing), when it was added, and its last delivery ("Last
  delivered 2h ago.") or last error ("Last try failed: 403 …"). **Remove** takes one off at once (on this device's own row, the
  browser drops its subscription too).
  With none: "No devices yet."
- **Send Test** sends one test notification ("Test · Sova", "Notifications reach this device.") to
  every device, ignoring the switches and quiet hours, and says under the row how many it reached
  and which failed. It is disabled with no device, and refused with the reason while no contact
  address is saved.
- **Settings (Save-gated).**
  - **Send phone notifications**, on by default: off, nothing is sent to any device (Send Test
    still works).
  - **Contact address**: a `mailto:` address or an `https://` URL, required before anything is
    sent. It rides in every signed request so the push services can reach whoever runs this
    server; Apple refuses requests without a real one. No default. The hint says so in one
    sentence. An invalid value shows its reason and holds Save.
  - **Notify me about**: one switch per kind (§app.notifications/delivery), with its kind word.
  - **Quiet hours**: a switch, off by default, and From / To times (24-hour, this server's clock,
    default 22:00–07:00; the range may cross midnight; From and To can't be equal). Blockers that
    arrive during quiet hours are never sent.
- **Fresh, and only what changed.** Like the Overseer form: the file is read each time the section
  mounts, a kept draft is rebased onto it, and Save writes only the fields changed on top of a
  fresh read. The PUT is strict.
- **Re-sync.** Each time the app loads in a browser that has allowed notifications and holds a
  subscription, it sends that subscription to the server again (a push service may have renewed
  it). When the server's key changed, the browser subscribes again with the new one. A device
  removed with **Remove** or **Turn Off on This Device** stays removed: its re-sync is refused, and
  that browser drops its subscription; only **Enable on This Device** there adds it again. A subscription the browser renews on its own is re-sent by
  the service worker where the browser supports that event.
