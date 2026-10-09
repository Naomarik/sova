# §app/outreach — Outreach
> Part of the Sova design spec · [overview](../design/overview.md)

**Outreach** is how Sova reaches a person of an organization's roster (§app/organizations) outside
Sova: it sends a person a link, a short note, or both, on WhatsApp. The layer is
channel-generic — a channel is an adapter the core hands an intent, the person's address on that
channel and the rendered text — so email or Slack slot in later; WhatsApp is the first and only
channel now. Inbound replies are ignored: nothing listens for them.

There is no consent mechanism: no flag, no check. Everyone on a roster agreed to be contacted when
they were added, so a person with a WhatsApp number can be messaged.

The WhatsApp channel is a client of separate processes, the **senders** (§app.outreach/sender),
each holding the one WhatsApp Web connection of one number. A host may use several: its own, more
it runs as added numbers, and its peers' (§app.outreach/sender-list); one is the default, and each
organization sends from its own pick or the default, never from another (§app.outreach/org-sender).
Sova never installs, restarts or stops a sender. It starts one, reconnects or pauses it, or links or
unlinks a phone, only when the operator presses that button in Settings → Outreach on the sender's
own host (§app.outreach/sender-controls, §app.outreach/sender-link); a host that sends through a
peer's sender may reconnect it too, when that peer grants it full control.

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
  `public-links.json`): `{version: 1, sender: "off" | {local: {socket?}} | {number: {id}} | {via:
  {nodeId}}, numbers?: [{id, socket}], labels?: {<entry id>: label}, orgs?: {<orgId>: <entry id>},
  acceptFrom: "all" | StableID[], paused: boolean, authDir?}`. `sender` is the default
  (§app.outreach/sender-list): off, this host's own, a number added on this host (by its name), or a
  peer's. `numbers` are the added senders (a name of lowercase letters, digits and dashes, at most
  32, and an absolute socket path; names and sockets each used once), and a `number` default must
  name one of them. `labels` keys are entry ids, each label at most 24 characters and never 4
  digits in a row. `orgs` holds each organization's pick (§app.outreach/org-sender). No file means
  `sender: "off"`, `acceptFrom: []`, not paused. Absent optional keys stay absent, so a file an
  earlier version wrote reads, works and is written back unchanged. A file that can't be read as
  that shape is treated as off, and a save over it is refused with the parse problem.
- `local`: the sender runs on this host; Sova connects to its Unix socket (`socket`, else
  `$SOVA_WA_SOCKET`, else `<agent dir>/sova/whatsapp/sender.sock`; an added number's own `socket`)
  and speaks the sender's IPC v1 (`services/whatsapp/IPC.md`): newline-delimited JSON requests `{id,
  op, …}` answered by `{id, ok, …}`, and events `{ev, seq, …}`. One connection per local sender is
  kept open and re-opened, at most every 10 seconds, while it's down; a request waits at most 30
  seconds for its answer.
- `via`: the sender runs on a peer (typically the public-links gateway). Sova calls that peer's own
  Sova over the peer listener (§mesh.peers/listener) at `POST /api/peer/outreach/{op}` for `status`,
  `check`, `send` and `events`. The peer answers only a caller its `acceptFrom` lists and its
  `peers.json` names, and only when its own default sender is on that host (its own or an added
  number), which is the one it sends through for every peer; otherwise 403 `not-accepted` or 404
  `no-sender`. It namespaces the caller's idempotency key by the caller's StableID and gives each
  caller only the receipts of its own sends. `reconnect` is the one control the relay carries: for a
  caller the peer grants full control (§mesh.peers/grants), never while the account is blocked
  (§app.outreach/sender-controls). Linking, unlinking and pausing the sender itself are never
  offered over the relay.
- `GET /api/outreach[?sender=<entry id>]` answers the setting, which sender it is about
  (`selected`: that one, else the default), that sender's state (`off`, `unreachable`, or the state
  the sender reports, with its why, its next automatic try `retryAt`, its automatic reconnects
  against their budget, and `since`, when Sova first read that state), the paused switch, the secret
  coverage (§app.outreach/secrets), and its systemd `unit` when Start Sender may be offered
  (§app.outreach/sender-controls). `PUT /api/outreach` saves `sender`, `acceptFrom`, `paused`,
  `authDir`, `numbers` and `labels`, each key whole (another key is 400); each save takes effect at
  once (the local connections are re-made, and a phone link in progress is dropped when the senders
  change) and the senders in use are read again (§app.outreach/sender-health).

## §app.outreach/sender-list — The numbers this host sends from

- Settings → Outreach's **Numbers** lists every sender this host can use, one number each, each an
  entry with an id: **This host** (`local`), always (its sender's state, or "No sender answers on
  this host."); each further sender on this host the operator added (`local:<name>`); then each
  peer whose sender answers this host's status through the relay (`peer:<StableID>`,
  §app.outreach/sender-route). A peer that doesn't accept this host, has no sender of its own, or
  doesn't answer is left out, unless this host uses it (the default, or an organization's pick),
  which is then listed with why. **Off** is last. The hint: "The default sends for every
  organization that doesn't pick its own number in its settings. A message never moves to another
  number."
- Each entry shows its label (the operator's own, else This host, the added sender's name, or the
  peer's name), the number's last 3 digits, its state as a chip, an added one's socket, and today's
  use against its own limits: "{day} of {perDay} sent in 24 h, {hour} of {perHour} this hour". Each
  number keeps its own limits, health and alerts (§app.outreach/sender-health).
- **The default.** The entry picked with its radio is the default, marked "Default": every
  organization that picks no number of its own sends from it (§app.outreach/org-sender). Off sends
  nothing from this host, whatever an organization picks.
- **Manage.** One entry at a time shows its heading ({label} …123), state, facts and controls under
  the list (the default when the tab opens; **Manage** on another row shows its), with its
  **Label** field (at most 24 characters, never 4 digits in a row, so a label never holds a number:
  "A short name for this number, like Office. Never the number itself."). The managed entry's row
  follows the state the page reads every 5 seconds; the others are as of the list's last read.
- **Add a Number** adds a sender on this host: a **Name** (lowercase letters, digits and dashes, at
  most 32) and its **Socket** path (absolute; another sender process's, with its own
  `SOVA_WA_HOME`: the sender stays one number per process). Until saved its row says "Added when
  you save." and can already be made the default. **Remove Number** (the managed added number's, or
  an unsaved row's) takes an added one off the list, never its sender or its credentials; the
  default can't be removed ("It is the default: make another number the default first.").
- The default, the labels and the added numbers are staged and saved by Save Changes, in
  `outreach.json` (§app.outreach/sender-route); a file an earlier version wrote reads and works
  unchanged, its `sender` the default. This host's optional socket path stays under its entry while
  it is the default; otherwise This host's entry is the sender on the default socket.
- `GET /api/outreach/senders` → `{senders: [{id, where: "local" | "peer", nodeId?, socket?, label,
  status, chosen}]}` (`chosen`: the default): the operator's own browser only (404 through the
  mesh proxy or from a peer, 403 for the Overseer's calls). Each sender is asked at once, a peer at
  most 5 seconds; the page reads it when the tab opens, after a save, and on Check Again.

## §app.outreach/org-sender — Each organization picks the number it sends from

- An organization's page, on its **Workspace** tab, has a **WhatsApp Number** card while the
  organization lives on this host: **Sends from**, a select of **Default ({label} …123)** and each
  number of Settings → Outreach's list ({label} …123), over "Messages to this organization's people
  go from this number. When it is down or at its limit, they wait or fail; they never go from
  another number.". A pick is saved at once, with a toast "{label} …123 sends this organization's
  messages.". The card reads the numbers again every 10 seconds while shown, so a change in
  Settings → Outreach shows. An organization on another host says "Pick its WhatsApp number on its
  own host's page." instead.
- Every send of the organization (the operator's Send on WhatsApp, an overseer's send, a held send
  at its release, and the wait for WhatsApp, §app.outreach/send) resolves the organization's number
  when it runs and uses only that one: its state decides whether it is ready or down, and the
  message goes through it. A message never falls over to another number when its own is down,
  paused or at its limit: it is refused, or waits, by the same rules as with one number.
- When the picked number is no longer on the list (an added number removed, a peer no longer this
  host's), the organization sends from the default, and the card says so in a warn banner: "The
  number this organization picked ({its name}) is gone from Settings → Outreach, so its messages go
  from the default, {label} …123." With Off, the card says "Outreach is off on this host: set it up
  in Settings → Outreach." and no message goes.
- The picks are host-local, in `outreach.json` `orgs` (`{<orgId>: <entry id>}`), and never travel
  with the workspace repo. `GET /api/outreach/orgs/:orgId` → `{off, choice, effective?: {id, label,
  me?}, gone?, default?, options: [{id, label, me?}]}` and `PUT /api/outreach/orgs/:orgId {sender:
  <entry id> | null}` (null: Default) are the operator's own browser only (404 through the mesh
  proxy or from a peer, 403 for the Overseer's calls; 404 for an organization not on this host); an
  id that names no sender this host can use is 400. A pick that changes to a number that is up
  releases the organization's sends waiting for WhatsApp at once (§app.outreach/send).

## §app.outreach/sender-health — Sova knows each sender's state, and says when it needs you

- Sova keeps, in memory, the last reading of each sender in use, by its entry id: every status it
  reads (Settings, the strip, a send) and every `state` event a local sender sends, with since when
  that state has held. At server start, every 60 seconds, and after each save of Settings →
  Outreach or of an organization's pick, it reads every sender in use (the default, each
  organization's pick, each added number) and forgets the readings of senders no longer in use.
- A send's readiness and the strip's come from that reading (§app.outreach/send), read afresh first.
- **Needs you.** One act-tier item per sender, kind `whatsapp-down`, of no session, id
  `whatsapp-sender:<entry id>`, titled "WhatsApp sending", "Settings → Outreach" as where, "WhatsApp
  sending is down for {label}: {why}" ("Sova can't reach the sender: {why}" while unreachable),
  opening Settings → Outreach (`#/settings/outreach`): while that sender is down, logged out,
  replaced, blocked or unpaired, or unreachable for 5 minutes (a restart takes seconds). Never while
  it is connecting, a backoff wait included, open or linking, nor while it is down with its next
  automatic try still ahead (it heals itself); once that try is overdue, it is. Each sender is
  judged alone: one being down never raises or clears another's item. It is a phone notification
  kind, "WhatsApp down" (§app.notifications/delivery).
- Unpaired, Sova says "No device is linked to the sender yet: link a phone in Settings → Outreach
  on the sender's host." (Needs you and the strip); the sender's own `status` keeps its own
  sentence.

## §app.outreach/sender-controls — The operator's controls for a sender

- Settings → Outreach shows the managed number's controls (§app.outreach/sender-list), each only
  when it applies and each with a hint saying what it does:
  - **Reconnect Now** ("Tries to connect once now; doesn't count against the automatic limit."):
    while the sender is down, replaced, or connecting on a backoff wait, on this host or a peer's.
    A blocked sender is reconnected only from its own host, behind a warn banner, "WhatsApp blocked
    this account." ("Reconnecting soon after a block can get the number banned for good; waiting a
    day or more is safer. Sending stays paused until you press Resume Sender too.") with
    **Reconnect Anyway** and Cancel.
  - **Pause Sender** / **Resume Sender**, on the sender's own host while it answers: the sender's
    own pause, which refuses every send through it from every host, the connection kept up ("Refuses
    every send through this sender, from every host, until you resume it. The connection stays
    up."); apart from this host's Pause all sending (§app.outreach/limits-and-pause).
  - **Start Sender**, on the sender's own host, only while it doesn't answer and a systemd user unit
    serving that sender's socket is installed and inactive or failed: `sova-whatsapp.service` for
    This host, `sova-whatsapp@<name>.service` (else the plain unit) for an added number, its socket
    resolved as the sender resolves its own. "Runs systemctl --user start {unit} once. Sova never
    restarts or stops it."; it never restarts, stops or loops.
  - **Check Again** reads the state and the list again at once.
  Link a Phone and Unlink This Number are §app.outreach/sender-link.
- `POST /api/outreach/sender/{reconnect,pause,start} {sender?, on?}` serve the operator's own
  browser only: 404 through the mesh proxy or from a peer, 403 for a request carrying the
  Overseer's sender header, so no tool reaches them. `sender` is an entry id (400 when malformed;
  409 when no sender has it, or outreach is off), else the default. Each answers that sender's info
  afresh, or 409 with the why: a peer's sender is never paused or started from here, and Start
  refuses a sender that answers ("The sender is already running.").
- Reconnect for a peer's sender goes to that peer's `POST /api/peer/outreach/reconnect`, which its
  listener lets through only with the admin grant (§mesh.peers/grants; denied, it says "The sender's
  host doesn't give this host full control, so only its own Settings can reconnect it.") and which
  is refused 403 while the account is blocked.

## §app.outreach/sender-link — Linking and unlinking a phone from Settings

- On the sender's own host, Settings → Outreach offers **Link a Phone** for the managed number
  while its sender is unpaired, and **Unlink This Number** while a device is linked (connected,
  connecting, down, replaced, blocked or logged out). A host sending through a peer, or off, links
  and unlinks nothing.
- **Link a Phone** ("Shows a QR code to scan from WhatsApp on the phone."): a QR appears only after
  the press. The page reads the link every second and draws each new QR itself, with "On the phone,
  open WhatsApp → Settings → Linked devices → Link a Device, and scan this code." and that a new
  code replaces it now and then and is to be kept private. **Cancel** ends a link in progress.
  Linked: "Linked: number ending …123.". Ended without a phone: a warn banner with the sender's
  sentence (§app.outreach/sender) and "Nothing is linked. Try again when the phone is at hand.",
  with **Try Again**.
- **Use a Pairing Code Instead**: **The phone's number** ("Country code first, digits only: 7 to
  15.", checked on the page first), then **Get Pairing Code** shows the 8-character code as
  `ABCD-1234`, with the steps for the phone with the number ending …123 (Link with phone number
  instead). Try Again then asks for the number again.
- **Unlink This Number** ("Logs this device out of WhatsApp and deletes its keys on this host.")
  first shows a warn banner, "Unlinking logs this device out of WhatsApp and deletes its keys on
  this host.", "Sending from this number stops until you link a phone again; the chats on the phone
  stay.", and a **Type UNLINK to confirm** field; **Unlink Number** is enabled only while it reads
  exactly `UNLINK`. Afterwards the page shows the sender's sentence.
- `POST /api/outreach/sender/link {phone?, sender?}`, `GET /api/outreach/sender/link[?sender=]`,
  `POST /api/outreach/sender/link/cancel {sender?}` and `POST /api/outreach/sender/unlink {confirm:
  "UNLINK", sender?}`: the operator's own browser only, as the controls (404 / 403), and 409 unless
  the sender is on this host. `phone` must be 7–15 digits (400), and the answer echoes only its last
  3; `confirm` must be exactly `"UNLINK"` (400). One link runs at a time across this host's numbers
  ("A link to another number is in progress: finish or cancel it first."), and its QR shows only on
  its own number's page.
- The QR and the pairing code are as good as the number's credentials: Sova keeps only the newest,
  in memory, drops it when the link ends, and answers it only to the link route (`no-store`), never
  in a log, a file, another route, Needs you or a model's context. A QR from a link started in a
  terminal is ignored. The relay never links or unlinks.

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
- The act's `outreach-send` effect runs the send when the act is taken or released. It resolves the
  organization's sender then (§app.outreach/org-sender) and reads its state afresh (one status
  request). It refuses, making nothing, when outreach is paused or off; when that sender is down,
  logged out, replaced, blocked, unpaired or unreachable (`sender-down`, "WhatsApp is down: {why}",
  without asking it to send); when it is paused on its own host (`sender-paused`,
  "WhatsApp sending is paused on the sender's host."); when the person has no WhatsApp number; or
  when the link no longer passes its check (a held send is checked again). Otherwise the link's
  resolver makes the URL (§app.outreach/links), the message is composed and handed to that sender,
  and no other, with the idempotency key `<projectId>#<personId>#<effect key>`.
- **Waiting for WhatsApp.** A project overseer's held send released (its hold ending, or approved
  with `sova_hold`) while its organization's sender is down, as Sova last read it, is held again:
  an outage wait (`wait: "outage"`), still cancellable, still in the person's working hours, under
  a new hold id. It goes when that sender comes back (any reading of it that isn't down releases
  the waits of every organization sending through it; another sender coming back releases nothing;
  an organization's engine that opens while its sender is up releases its own; and an organization
  whose pick changes to a sender that is up releases its own), and at most 24 h after its first
  wait: that time travels with the act, so the sender coming and going never extends it. At the
  bound it goes ahead, is refused `sender-down`, and is not sent (below). The approval says
  "Approved {id}, but WhatsApp is down: the message waits for WhatsApp to come back, at most until
  {time}, and is not sent if WhatsApp is still down then. sova_pipeline lists it."; Needs you says
  "{what} waits for WhatsApp to come back: it goes when WhatsApp is back, and is not sent if WhatsApp
  is still down in {n} min.", the Pipeline "… is not sent if WhatsApp is still down at {time} your
  time ({in …}). You can cancel it.", and the overseer's look and `sova_pipeline` "waits for
  WhatsApp to come back, at most until {time} (then it is not sent)". The operator's own sends, and
  those in a turn the operator started, never wait: they are refused at once.
- Sent (the sender accepted it): `{outcome: "sent", channel}`; a gathering link's Needs-you wait
  clears, as after Get Link. A definite failure turns off exactly what the step made (the hand-off
  link it minted, nothing when it sent a kept one, or the preview sibling), so "Send {name} their link" comes back unless an older link of
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
  could go to, whether it is ready and why not (with its code); it reads the organization's sender
  again first when its last reading is more than 5 seconds old, and the strip reads it again every
  15 seconds while it offers sends, never during one. A button that isn't ready is disabled with its
  reason as its title ("No WhatsApp number on the roster.", "Outreach is off: set it up in Settings
  → Outreach.", "Outreach is paused.", "WhatsApp sending is paused on the sender's host.", "WhatsApp
  is down: {why}"); while outreach is off, **Set Up Outreach** beside it opens Settings → Outreach.
  While WhatsApp is down (`sender-down`), the strip shows below its bar, before anyone presses Send, a
  warn banner with that sentence and the two ways on that don't need it, **Open in WhatsApp** and
  **Copy Link** (each named with the person's first name when several are down). Sent: a toast
  "Sent {name} their link on WhatsApp.".
- **Fallback.** After a failure or a refusal the strip shows, below its bar, a warn banner with the why and three
  ways on: **Retry** (the same act), **Open in WhatsApp** (the person's kept live link, else one Get Link
  makes, and opens `https://wa.me/<digits>?text=<the same message>` in a new tab, so the operator sends it from
  their own WhatsApp; only when the person has a number) and **Copy Link** (copies the kept live link, else
  shows the one Get Link makes on the strip).

## §app.outreach/links — Links are references the server resolves

- A send names its link by reference, never by URL: `{kind: "handoff", session}` (the person's own
  link to a gathering session of the project) or `{kind: "preview", preview}` (a public preview link
  of the project, `pv_…`, §mesh.public/preview). Each kind has a resolver that checks the reference
  for the person and makes the URL in the send's own step; the core knows no kind.
- `handoff`: the session is this project's and open; the person holds its current hand-off, or is a
  reached invitee of its open offer (else "{name} does not hold the baton, so there is no link to
  send.", "{name} is not invited to its open offer.", "{name} is not reached yet: …"). It sends
  the person's live link of that hand-off (or of that offer) when its token is kept
  (§app.session-share/link), as Get Link does, and makes nothing. Else it mints a fresh link, and
  once the message went their older links of that hand-off (or of that offer) stop, as after Get
  Link. A send that fails turns off only a link it made, and leaves the older ones as they were.
  A link minted by a send still in flight on this host is never handed out again, by another send
  or by Get Link's kept link (`?keep=1`, §app.baton/links), until that send settles: either
  passes it over for the person's newest other kept live link, else makes a new one as without a
  kept link, so that send's failure never turns off a link someone else delivered.
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
  "refused" | "unknown", code?, sender?, senderLabel?, from?}`; a preview send records its sibling's `pv_…` id, never its URL.
  `sender` and `senderLabel` name the number it went through (§app.outreach/org-sender), its entry id
  and label, and `from` that number's last 3 digits ("…123"), as the sender reports them, never more.
  It never holds a number, a token, a link, a channel message id, the message or
  the note's text. A refusal's `code` names its reason exactly: outreach's own (`off`, `paused`,
  `no-number`, `sender-down`, `sender-paused`) or the link's (§app.outreach/links); a failure's is the sender's.
- A project overseer reads its project's lines with `sova_send_status` (§app.project-overseer/tools):
  each send's latest event, code and time, never a number, a link or the note.
- Receipts (delivered, read) are matched host-locally: `<stateRoot>/outreach-receipts.json` (0600)
  maps the channel's message ref to its log line's id for 7 days; a receipt appends a `delivered` or
  `read` line with the same `id`.
- A person's page (§app.organizations/person-page) lists their sends under **Sent on WhatsApp**,
  newest first: what went (the gathering's public title, "A preview" or "A message"), a chip with the latest event of each (Sent, Delivered,
  Read, Failed, Unknown, Not sent), when, the number it went from when the log says ("from {label}
  …123"), and the failure's code.

## §app.outreach/limits-and-pause — Pause and limits

- **Pause all sending from this host** in Settings → Outreach stops every send from this host at
  once (`outreach.json` `paused`); a send then is refused with "Outreach is paused.". It is apart
  from **Pause Sender** (§app.outreach/sender-controls), the sender's own pause, which refuses every
  send through that number from every host.
- The rate limits of a number (at most one send per 3 s, 20 an hour, 60 a day by default) are its
  sender's, shared by every host that sends through it; each number has its own. A send over them
  fails with code `limited`, retryable, and Sova shows the sender's why. A message never goes
  through another number because its own is at its limit, paused or down.

## §app.outreach/secrets — The sender's credentials are secret

- The Overseer's file tools deny (§app.overseer/tools) the default sender home `<agent
  dir>/sova/whatsapp`, pi's default `~/.pi/agent/sova/whatsapp` (so a hermetic server covers the real
  one too), `outreach.json`'s `authDir` when set, the auth directory the local sender of This host reports in its
  hello (kept as `senderAuthDir`), each added number's home (its socket's directory) and the auth
  directory its sender reports (kept in memory), `<stateRoot>/outreach.json` and
  `outreach-receipts.json`, from the next tool call after any of them is configured.
- The seeded sandbox policy hides `$AGENT_DIR/sova/whatsapp` from sandboxed agents.
- Settings → Outreach says which paths are protected, and warns when the managed number's auth
  directory (this host's own: the one its sender reports, else `authDir`; an added number's: the one
  its sender reports, else `auth` in its home) is one the sandbox policy does not hide (only the Overseer's tools then
  cover it).

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
  the relay (§app.outreach/sender-route) never carries `pause`, `link` or `unlink`, and `reconnect`
  only for a peer granted full control. Every setting
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
  adds the next step. It rides out on its own every stop WhatsApp or the network can cause: a
  transient close (428, 408, 503, 515), a bad session (500), any unknown close and an open that
  fails are each tried again after a backoff (`connecting` with the next attempt's time and why): 30 s
  first, doubling to at most 30 min, the backoff reset by an open lasting 10 min; each automatic
  attempt, starting the process included, spends the reconnect budget (3 an hour, 10 a day), kept in
  `state.json` across restarts; the operator's `reconnect` does not.
  Past the budget it is `down` with `retryAt`, the budget's next free slot, and why ("{what ended
  it} The reconnect limit of {n} an hour is reached." or "… a day …"), and at that time it makes one
  automatic attempt by itself; a restart works the wait out again from the budget, and `status`'s
  next step then says it reconnects on its own. A budget of 0 holds `down` ("Automatic reconnects are
  off"). Only these stop it until a person acts: 401 → `logged-out` (credentials kept), 440 →
  `replaced`, 403 → `blocked` and paused, 405 → the WA Web version is fetched again and one
  immediate retry, a second 405 → `down`, and a `state.json` it can't read → `down`. A QR asked for
  on saved credentials → `logged-out`, never shown. These holds survive a restart: nothing reconnects
  until the operator's `reconnect`. A `down` hold an older sender saved for a stop it now rides out
  is dropped at start. Each close's log line names the WebSocket's close code, whether a close frame
  came, and whether the server sent a stream error or ended the stream; never a reason's text.
- Never automatic: logging out, deleting credentials, showing a QR, linking. `pair` (or IPC `link`,
  refused while linked) shows a QR in the terminal, or with `--code` returns a pairing code; a
  leftover of an unfinished link is cleared first. A link ends with the sender's sentence: "The QR
  code expired before the phone scanned it.", "The pairing code expired before it was typed on the
  phone.", or, for IPC `link {cancel: true}` (refused `not-linking` when none runs), "Linking was
  cancelled.". `unlink` needs an explicit yes, logs the device out
  when connected and deletes the credentials.
- Sends: digits 7–15, text up to 4096 characters. At least `gapS` seconds apart (queued, not
  refused), at most `perHour` and `perDay` (then `limited` with the time a slot frees), none while
  paused (persisted); a number with no account is `not-on-whatsapp`. The same idem within 24 h never
  sends twice: it answers the recorded result; an idem whose outcome a crash left unknown answers
  `unknown` for good. Delivered and read receipts go out as events carrying the ref and the idem, in
  order, once each; a message failed with 463 holds `blocked` and pauses, and later sends say
  `restricted`. A send while `down` is refused at once, `not-connected`: retryable, with `retryAt`,
  while it waits for the budget; otherwise not.
- It never writes a message body, a full phone number or a credential to its files or its log: its
  log masks digit runs to the last three, Baileys's logger passes only message text at the configured
  level (never an object), and every
  `console` call from its dependencies (libsignal prints whole sessions, private keys included) is
  dropped, or at debug kept as words only, objects and long key-like runs removed.
- `scripts/fake-whatsapp-sender.mjs` runs the same state machine and IPC over a fake WhatsApp for
  hermetic runs: same socket resolution, refuses the real default directory, numbers absent via
  `SOVA_WA_FAKE_ABSENT`, receipts via `SOVA_WA_FAKE_RECEIPTS`, the number it links as via
  `SOVA_WA_FAKE_ME` (so a second fake, with its own `SOVA_WA_HOME`, reads apart), a clock
  `SOVA_WA_FAKE_TIME_SCALE` times faster, and a `fake` op (`ctl`) that closes the connection with any
  code, fails the next send with an ack error, makes it throw, fails the next opens (`open-fail
  [n]`), or scans the link waiting for a phone (`scan`). A link issues a new fake QR every
  `SOVA_WA_FAKE_QR_MS` (3 s), 5 in all, then expires as WhatsApp's does (408).

## §app.outreach/guide — Setting up the sender

- `docs/outreach/README.md` explains the layer (channels, who may send, what is logged) and
  `docs/outreach/whatsapp.md` is the from-scratch guide to the WhatsApp sender on a fresh host:
  requirements and risks, install (pnpm only, `pnpm install --frozen-lockfile` in
  `services/whatsapp`), the systemd user unit template `services/whatsapp/sova-whatsapp.service.example`
  (or any supervisor that restarts on failure and never runs two copies), configure, pair (from
  Settings → Outreach's Link a Phone or a pairing code, the terminal's `pair` as the alternative),
  connect Sova (on this host or through the gateway, picking the sender from the list), protect the
  credentials, verify, operate (the Settings controls, the Needs you alert, the reconnect wait and
  why a connection closed) and recover, the Settings buttons first and the terminal commands kept.
  A table maps every sender state to the guide's section for it. **Run a second number** covers
  more numbers on one host: each its own home, hidden from sandboxed agents, run as the template
  unit `sova-whatsapp@<name>.service` (`SOVA_WA_HOME=%h/.pi/agent/sova/whatsapp-%i`), added with Add
  a Number, and picked per organization; peers send through a host's default number only, and each
  number keeps its own limits.
