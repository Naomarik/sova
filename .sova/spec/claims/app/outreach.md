# §app/outreach — Outreach
> Part of the Sova design spec · [overview](../design/overview.md)

**Outreach** is how Sova reaches a person of an organization's roster (§app/organizations) outside
Sova: it sends a person a link, a short note, or both, on WhatsApp. The layer is
channel-generic — a channel is an adapter the core hands an intent, the person's address on that
channel and the rendered text — so email or Slack slot in later; WhatsApp is the first and only
channel now. Inbound replies are ignored: nothing listens for them.

There is no consent mechanism: no flag, no check. Everyone on a roster agreed to be contacted when
they were added, so a person with a WhatsApp number can be messaged.

The WhatsApp channel is a client of a separate process, the **sender** (§app.outreach/sender),
that holds the one WhatsApp Web connection of one number. Sova never spawns, installs, restarts,
pairs or unlinks it.

## §app.outreach/channels — Channels and addresses

- A channel is an adapter with an id (`whatsapp`), a status (ready, or not and why) and a send that
  answers either `{ok: true, ref, at}` or `{ok: false, code, retryable, why}`; nothing else about it
  reaches the core.
- A person's WhatsApp address is their roster contact's `whatsapp` field
  (§app.organizations/field-authority), reduced to its digits (a leading `+` and any spaces, dashes
  or brackets dropped); it must include the country code. With none, the send is refused with "{name}
  has no WhatsApp number on the roster." Sova never falls back to `phone`.
- The message is the note, else the link's own default line, then a blank line and the link. The
  default lines are fixed, never model-written: a gathering link's "{operator name} asked you a
  question: {public title}", a preview link's "{operator name} shared a preview with you." The
  operator name is this host's operator display name (`orgs.json` `operator.name`,
  §app.organizations/registry). The hand-off's question, the goal and the briefing never go into it.
- A note is at most 500 characters, shown to the person as written. One that repeats private text
  (About this organization, the overseer's notes, a goal or briefing, the operator's instructions, a
  profile) or any roster contact value is refused, as an owner update is (§app.owner-page/updates):
  "This note repeats private text (…). Write it again in your own words."

## §app.outreach/sender-route — How this host reaches the sender

- `<stateRoot>/outreach.json` (mode 0600, written atomically, parsed strictly like
  `public-links.json`): `{version: 1, sender: "off" | {local: {socket?}} | {via: {nodeId}},
  acceptFrom: "all" | StableID[], paused: boolean, authDir?}`. No file means `sender: "off"`,
  `acceptFrom: []`, not paused. A file that can't be read as that shape is treated as off, and a save
  over it is refused with the parse problem.
- `local`: the sender runs on this host; Sova connects to its Unix socket (`socket`, else
  `$SOVA_WA_SOCKET`, else `<agent dir>/sova/whatsapp/sender.sock`) and speaks the sender's IPC v1
  (`services/whatsapp/IPC.md`): newline-delimited JSON requests `{id, op, …}` answered by `{id, ok,
  …}`, and events `{ev, seq, …}`. One connection is kept open and re-opened, at most every 10
  seconds, while it's down; a request waits at most 30 seconds for its answer.
- `via`: the sender runs on a peer (typically the public-links gateway). Sova calls that peer's own
  Sova over the peer listener (§mesh.peers/listener) at `POST /api/peer/outreach/{op}` for `status`,
  `check`, `send` and `events`. The peer answers only a caller its `acceptFrom` lists and its
  `peers.json` names, and only when its own sender is `local`; otherwise 403 `not-accepted` or 404
  `no-sender`. It namespaces the caller's idempotency key by the caller's StableID and gives each
  caller only the receipts of its own sends. Linking, reconnecting, unlinking and pausing the sender
  itself are never offered over the relay.
- `GET /api/outreach` answers the setting, the sender's state (`off`, `unreachable`, or the state the
  sender reports, with its why), the paused switch, and the secret coverage
  (§app.outreach/secrets). `PUT /api/outreach` saves the setting whole; each save takes effect at once
  (the local connection is re-made).

## §app.outreach/send — One act for every send

- `outreach/send {target, link?, note?}` on the project's statechart sends a roster person a link, a
  note, or both: a link and a note may not both be missing ("Send a link, a note, or both."). Its
  triggers: the operator's **Send on WhatsApp** on a gathering (`POST /api/baton/:sid/send-link
  {person?, note?}`), any send by the operator's app (`POST /api/outreach/send {orgId, projectId,
  personId, link?, note?}`), the global Overseer's `sova_gather` `send_link`, and a project
  overseer's `sova_send_to_person` (§app.outreach/decisions). The statechart checks that the person is
  active, the link (the host's check, below), the note, the level (L1) and, for the global
  Overseer, its confirm card (the person and the link's session).
- **Held and in hours.** An operator's send, and one in a turn the operator started, goes at once,
  whatever the hours. A project overseer's send in a run the operator did not start waits in the
  project's hold (§app.project-overseer/holds) as "A WhatsApp message to {name}", which the operator
  can cancel; with **send** ("Messaging a person on WhatsApp") among the kinds needing the overseer's
  confirmation (on by default, §app.project-overseer/reviews) it then waits for the overseer's
  review; and it goes only in the person's working hours (§app.organizations/working-hours).
- The act's `outreach-send` effect runs the send when the act is taken or released. It refuses,
  making nothing, when outreach is paused or the sender is off, the person has no WhatsApp number, or
  the link no longer passes its check (a held send is checked again). Otherwise the link's resolver
  makes the URL (§app.outreach/links), the message is composed and handed to the channel with the
  idempotency key `<projectId>#<personId>#<effect key>`.
- Sent (the sender accepted it): `{outcome: "sent", channel}`; a gathering link's Needs-you wait
  clears, as after Get Link. A definite failure turns off exactly what the step made (the hand-off
  link, or the preview sibling), so "Send {name} their link" comes back unless an older link of
  theirs still works, and the result is `{outcome:
  "failed", code, retryable, why}`. An uncertain one — the request left and no answer came (a
  timeout, the connection closed, or the sender's own `unknown`) — keeps what the step made (the
  person may have it) and is logged as `unknown`, code `unknown`. A result never carries a token, a
  link, a number or the message.
- The routes answer `200 {outcome: "sent", channel, name}`, `200 {outcome: "failed" | "refused",
  code, why, name}`, or the statechart's refusal (409 with its sentence).
- After a server restart, a step run again sends nothing: its outcome is uncertain, so what it made
  stays and it is logged as `unknown`, code `unknown-after-restart` (`<stateRoot>/outreach-pending.json`
  remembers each step in flight).
- **Not sent is never ok.** A project overseer's send that is refused or fails when its step runs
  (at once, or when its hold ends or is approved) never reads as sent anywhere. Its tool says "Not
  sent to {name}: {why}"; an approval with `sova_hold` that released it answers as a refusal,
  "Approved {id}, but the WhatsApp message to {name} was not sent: {why}"; the project's feed
  (§app.project-overseer/reviews) gets an entry `outreach/not-sent`, refused "Not sent to {name}:
  {why}", which `sova_pipeline` and the overseer's next look list; and Needs you shows it
  (`outreach-not-sent`, §app.overseer/attention-digest), "The WhatsApp message to {name} was not
  sent: {reason}.", the reason said from its log code, opening the person's page, until a later
  send to that person in that project goes, or 7 days pass.

- **On the strip.** The baton strip (which the Organizations region's Needs you row "Send {name}
  their link" opens) shows **Send on WhatsApp** in its bar, after the primary action (Take Back;
  Get Link is in its More actions menu, §app.baton/strip-layout), while a person holds the baton, and
  one per reached invitee while an offer is open, in a row under the invitees' links. `GET /api/baton/:sid/outreach` says, per person it
  could go to, whether it is ready and why not; a button that isn't ready is disabled with its
  reason as its title ("No WhatsApp number on the roster.", "Outreach is off: set it up in Settings
  → Outreach.", "Outreach is paused."); while outreach is off, **Set Up Outreach** beside it opens
  Settings → Outreach. Sent: a toast "Sent {name} their link on WhatsApp.".
- **Fallback.** After a failure or a refusal the strip shows, below its bar, a warn banner with the why and three
  ways on: **Retry** (the same act), **Open in WhatsApp** (mints a fresh link through Get Link and
  opens `https://wa.me/<digits>?text=<the same message>` in a new tab, so the operator sends it from
  their own WhatsApp; only when the person has a number) and **Copy Link** (Get Link, shown once as
  today).

## §app.outreach/links — Links are references the server resolves

- A send names its link by reference, never by URL: `{kind: "handoff", session}` (the person's own
  link to a gathering session of the project) or `{kind: "preview", preview}` (a public preview link
  of the project, `pv_…`, §mesh.public/preview). Each kind has a resolver that checks the reference
  for the person and makes the URL in the send's own step; the core knows no kind.
- `handoff`: the session is this project's and open; the person holds its current hand-off, or is a
  reached invitee of its open offer (else "{name} does not hold the baton, so there is no link to
  send.", "{name} is not invited to its open offer.", "{name} is not reached yet: …"). It mints a
  fresh link; once the message went, their older links of that hand-off (or of that offer) stop, as
  after Get Link. A send that fails leaves the older ones as they were.
- `preview`: the preview is this project's and active. The host keeps only a preview's hash, so the
  person gets their own **sibling** of it (a new `pv_…`): the same organization, project and port,
  expiring when the original does and never later (an Extend of a sibling stops at the original's
  expiry), and turned off whenever the original is (§mesh.public/preview). The preview named stays
  as it is. The previews lists (the project's card, the Shares page) name a sibling's person on its
  original's **Sent to** line (as "sent to {name}" on a row of its own when its original isn't
  listed), each with its own Delete, so each person's link can be deleted on its own
  (§mesh.public/preview-card). The person's link the resolver makes is kept host-local from that
  step on, beside the previews (`siblingLinks`, §mesh.public/preview), so the operator can copy it
  again from that Sent to line; a send that fails turns the sibling off and drops its link with it.
  It is kept for the operator's lists only: never in the send log, a tool's answer or a model's
  context. A sibling records who sent it (`createdBy`): `operator` for the
  operator's own send, else `session:<id>` of the overseer that sent it (the project's overseer
  conversation for a project overseer's send, the current Overseer for the global Overseer's), so
  the lists say "Sent by the overseer" (the name's tooltip on a Sent to line) or "Made by the
  overseer" (a row of its own on the card) for an overseer's.
- Both refuse while the public address warning is `off`, `unreachable` or `not-accepted` (a link
  nobody outside can open), with that warning's text (§app.baton/links), and a preview while no
  preview address is set.
- The preview resolver reads the preview address once, before it mints the sibling, and makes the
  URL from that reading. A routed host's address reads as unset for a moment each time its gateway
  comes back and states its kinds again (§mesh.public/registry), so a send whose check passed never
  fails on a second reading after the sibling exists; one that finds no address mints nothing and
  is refused `preview-address`.
- Each refusal carries a code for the send log, never a URL or a number: `session-unknown`,
  `other-project`, `session-ended`, `not-invited`, `not-reached`, `not-holder` (a hand-off);
  `preview-unknown`, `other-project`, `preview-off`, `preview-expired`, `preview-address` (a
  preview: no preview address, or a gateway that doesn't route previews); `address-off`,
  `address-unreachable`, `address-not-accepted` (the public address's warning). `link` is left for
  a reference of the wrong kind or an unexpected error.
- No model sees a link, a token or a number: tools take ids and answer with the outcome.

## §app.outreach/log — The send log

- Every send's outcome is appended to `<workspace>/outreach.jsonl`, in the organization's
  workspace repo: `{at, id, personId, channel, intent: "send", projectId, link?: "handoff" |
  "preview", sessionId?, n?, offerId?, previewId?, note?: true, by: "operator" |
  "operator-via-overseer" | "project-overseer", event: "sent" | "delivered" | "read" | "failed" |
  "refused" | "unknown", code?}`; a preview send records its sibling's `pv_…` id, never its URL. It never holds a number, a token, a link, a channel message id, the message or
  the note's text. A refusal's `code` names its reason exactly: outreach's own (`off`, `paused`,
  `no-number`) or the link's (§app.outreach/links); a failure's is the sender's.
- A project overseer reads its project's lines with `sova_send_status` (§app.project-overseer/tools):
  each send's latest event, code and time, never a number, a link or the note.
- Receipts (delivered, read) are matched host-locally: `<stateRoot>/outreach-receipts.json` (0600)
  maps the channel's message ref to its log line's id for 7 days; a receipt appends a `delivered` or
  `read` line with the same `id`.
- A person's page (§app.organizations/person-page) lists their sends under **Sent on WhatsApp**,
  newest first: what went (the gathering's public title, "A preview" or "A message"), a chip with the latest event of each (Sent, Delivered,
  Read, Failed, Unknown, Not sent), when, and the failure's code.

## §app.outreach/limits-and-pause — Pause and limits

- **Pause all sending** in Settings → Outreach stops every send from this host at once
  (`outreach.json` `paused`); a send then is refused with "Outreach is paused.".
- The rate limits of the number (at most one send per 3 s, 20 an hour, 60 a day by default) are the
  sender's, shared by every host that sends through it; a send over them fails with code `limited`,
  retryable, and Sova shows the sender's why.

## §app.outreach/secrets — The sender's credentials are secret

- The Overseer's file tools deny (§app.overseer/tools) the default sender home `<agent
  dir>/sova/whatsapp`, pi's default `~/.pi/agent/sova/whatsapp` (so a hermetic server covers the real
  one too), `outreach.json`'s `authDir` when set, the auth directory the local sender reports in its
  hello (kept as `senderAuthDir`), `<stateRoot>/outreach.json` and `outreach-receipts.json`, from the
  next tool call after any of them is configured.
- The seeded sandbox policy hides `$AGENT_DIR/sova/whatsapp` from sandboxed agents.
- Settings → Outreach says which paths are protected, and warns when the sender reports an auth
  directory the sandbox policy does not hide (only the Overseer's tools then cover it).

## §app.outreach/decisions — Who may send

- The operator: Send on WhatsApp on a gathering's strip, at once.
- The global Overseer: `sova_gather` `send_link {session, person?, note?}` (their gathering link) or
  `{preview, person, note?}` (their own link to a preview), only in the turn a confirm card's click
  opened that lists the person and the session (§app.overseer/org-people-facing); at once. Its result
  says only "Sent {name} their link on WhatsApp." (or "the preview link") or why not.
- A project overseer at L1 or above: `sova_send_to_person {person, session?, preview?, note?}`, a
  gathering link of its project, a preview of its project, a note, or a link with a note; through the
  hold when it acts on its own (§app.outreach/send). Its result says "Sent {name} a WhatsApp
  message.", or "Held: the WhatsApp message to {name} waits until {time} so the operator can cancel
  it; …", or why not. Its prompt and the tool's description say plainly that it can message roster
  people on WhatsApp and that each message it sends on its own waits in the cancellable hold.
- A gathering's own model never sends. No model sees a link, a token or a number.

## §app.outreach/sender — The WhatsApp sender

- The sender is its own program, `services/whatsapp` in this repository (`sova-whatsapp`): its own
  pnpm package, lockfile and pinned Baileys, importing nothing from Sova. Its commands are `run`,
  `pair [--code <digits>]`, `status [--json]`, `unlink --yes`, `reconnect`, `pause`, `resume` and
  `check-config`; the operator ones act on the running sender over its local socket only, and
  the relay (§app.outreach/sender-route) never carries `pause`, `link`, `reconnect` or `unlink`. Every setting
  comes from the environment, else `$SOVA_WA_HOME/config.json` (strict: unknown keys refuse), else
  a default: `SOVA_WA_HOME` (`<PI_CODING_AGENT_DIR or ~/.pi/agent>/sova/whatsapp`),
  `SOVA_WA_AUTH_DIR` (`$SOVA_WA_HOME/auth`), `SOVA_WA_SOCKET` (`$SOVA_WA_HOME/sender.sock`),
  `SOVA_WA_LIMITS` (`3/20/60`), `SOVA_WA_RECONNECT_BUDGET` (`3/10`), `SOVA_WA_SEND_WAIT_S` (15),
  `SOVA_WA_DEVICE_NAME` (`Sova`), `SOVA_WA_LOG_LEVEL` (`warn`). `check-config` prints the resolved
  values and where each came from, and exits non-zero on any problem.
- It refuses to start when its home or auth directory is readable or writable by group or others,
  or lies inside a git work tree, or its socket path is too long; and (exit 3) when another live
  sender holds its home's `sender.lock` (an exclusive file naming its pid; a dead holder's lock is
  taken over) or already answers on its socket, so exactly one process owns an auth directory.
- It holds one long-lived WhatsApp Web connection as a linked device (never shown online), drops
  every inbound message and the history bootstrap unread, and serves IPC v1
  (`services/whatsapp/IPC.md`) on its Unix socket (0600 in a 0700 directory), never on a network.
- States: `unpaired`, `linking`, `connecting` (with the next attempt's time while it waits), `open`,
  `logged-out`, `replaced`, `blocked`, `down`, each but `open` with a sentence saying why; `status`
  adds the next step. It reconnects on its own only after a transient close (428, 408, 503, 515): 30 s
  first, doubling to at most 30 min, the backoff reset by an open lasting 10 min; each automatic
  attempt, starting the process included, spends the reconnect budget (3 an hour, 10 a day), kept in
  `state.json` across restarts; the operator's `reconnect` does not.
  Past it, it is `down`. 401 → `logged-out` (credentials kept), 440 → `replaced`, 403 → `blocked`
  and paused, 500 or any unknown close → `down`, 405 → the WA Web version is fetched again and one
  immediate retry, a second 405 → `down`. A QR asked for on saved credentials → `logged-out`, never
  shown. These stops survive a restart: nothing reconnects until the operator's `reconnect`.
- Never automatic: logging out, deleting credentials, showing a QR, linking. `pair` (or IPC `link`,
  refused while linked) shows a QR in the terminal, or with `--code` returns a pairing code; a
  leftover of an unfinished link is cleared first. `unlink` needs an explicit yes, logs the device out
  when connected and deletes the credentials.
- Sends: digits 7–15, text up to 4096 characters. At least `gapS` seconds apart (queued, not
  refused), at most `perHour` and `perDay` (then `limited` with the time a slot frees), none while
  paused (persisted); a number with no account is `not-on-whatsapp`. The same idem within 24 h never
  sends twice: it answers the recorded result; an idem whose outcome a crash left unknown answers
  `unknown` for good. Delivered and read receipts go out as events carrying the ref and the idem, in
  order, once each; a message failed with 463 holds `blocked` and pauses, and later sends say
  `restricted`.
- It never writes a message body, a full phone number or a credential to its files or its log: its
  log masks digit runs to the last three, Baileys's logger passes only message text at the configured
  level (never an object), and every
  `console` call from its dependencies (libsignal prints whole sessions, private keys included) is
  dropped, or at debug kept as words only, objects and long key-like runs removed.
- `scripts/fake-whatsapp-sender.mjs` runs the same state machine and IPC over a fake WhatsApp for
  hermetic runs: same socket resolution, refuses the real default directory, numbers absent via
  `SOVA_WA_FAKE_ABSENT`, receipts via `SOVA_WA_FAKE_RECEIPTS`, and a `fake` op (`ctl`) that closes
  the connection with any code, fails the next send with an ack error, or makes it throw.

## §app.outreach/guide — Setting up the sender

- `docs/outreach/README.md` explains the layer (channels, who may send, what is logged) and
  `docs/outreach/whatsapp.md` is the from-scratch guide to the WhatsApp sender on a fresh host:
  requirements and risks, install (pnpm only, `pnpm install --frozen-lockfile` in
  `services/whatsapp`), the systemd user unit template `services/whatsapp/sova-whatsapp.service.example`
  (or any supervisor that restarts on failure and never runs two copies), configure, pair, connect
  Sova (on this host or through the gateway), protect the credentials, verify, operate and recover.
  A table maps every sender state to the guide's section for it.
