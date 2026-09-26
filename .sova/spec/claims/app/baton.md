# §app/baton — Baton sessions
> Part of the Sova design spec · [overview](../design/overview.md)

A **baton session** gathers information from the people of an organization (§app/organizations),
one person at a time. The model talks to whoever **holds the baton**; when that person cannot
answer, the model hands the baton to someone else on the roster (or back to the operator) with a
question and a briefing, and Sova mints that person a link. People outside the operator's tailnet
reach it only through the **share listener** and see only the conversation.

Vocabulary: **owner** (who started it: the operator, or a project's overseer), **holder** (who has
the baton now: a roster person, or the operator; nobody while an offer waits in its pool),
**hand-off** (one move of the baton, numbered from 1), **offer** (a hand-off to several people at
once), **lease** (an offer's lock on its first taker).

## §app.baton/goal-and-loadout — Start, goal and runtime

- The operator starts one from an org's project on the org page: the first holder (an active
  person, or the operator), a **public title** (all an outsider sees of the goal), the **goal**
  (never shown to outsiders and never repeated verbatim by the model), a first question (default:
  the public title), and optionally a model and thinking level (else the new-session defaults). `POST /api/baton {orgId, projectId, to,
  publicTitle, goal, question?, briefing?, parentSessionId?, model?, thinking?}` answers 201 with the
  session's path and, when `to` is a person, that hand-off's link, or, when `to` is a list of two or
  more people, one link per invitee (§app.baton/offers-and-leases); links are shown once.
- **Start a session for this person**: `parentSessionId` names the baton session it came from (a
  referral's approval card); the new row records it as `parent`, and the project defaults to the
  parent's. `briefing` is the first hand-off's briefing, for its addressee.
- In-process callers (the project overseer, the reconciler) may also set `owner: {overseerOf:
  projectId}` and `mintLink: false` (no link minted: the session then asks the operator to send
  one, §app.baton/needs-you). A request body's `owner` and `mintLink` are ignored.
- It is a webapp-owned session whose file lives in the org's workspace repo (`sessions/`), whose
  cwd is that repo, and whose file carries an invisible `sova-baton` marker `{v:1, orgId,
  projectId}`. It is listed in the sidebar like any web session, under its public title, with
  ` · <holder>` after the title. Open, a strip above its transcript shows org, project,
  holder, state and message count — and the public title, only when the session head above shows a
  different one (a renamed session): otherwise it would say the title twice — and Get Link / Turn Off Link / Take Back / Close
  Session; the strip never shows a profile. Each strip action re-reads the session list at once,
  so the ` · <holder>` suffix moves without waiting for the list's next poll.
- **Loadout.** No pi-config extension, skill, prompt template or context file is loaded; the only
  extension is Sova's inline baton extension. The SDK tool list is exactly `hand_to`, `goal_done`,
  `record_decision`, `propose_roster_edit` and `write_profile_updates`: no built-in tool, no file
  access, no shell, no subagents. `write_profile_updates` is inactive (the model does not see it)
  except during the wrap-up turn (§app.organizations/wrap-up), when it is the only active tool, and
  it refuses outside one. The system
  prompt is Sova's (`server/baton-prompt.md`), rendered at the start of every run with the public
  title, the goal, the holder's name and private steering profile, the other participants (name,
  role, decision areas), the roster's active people it may hand to, the operator's name and the
  rules; the user's `APPEND_SYSTEM.md` is not included, and the prompt's working-directory line
  reads `(none)`. The model's own context has the holder's profile phrases redacted
  (§app.organizations/privacy).
- It has no mode (no mode extension loads); its composer has no mode switch.
- **Budget**: 60 messages in (outsiders' and operator's together; the wrap-up's prompt is not one). At the limit the share page
  refuses more, the baton goes to the operator, and the session needs them.

## §app.baton/hand-off — hand_to, goal_done, record_decision

- `hand_to({person, question, briefing})`: `person` is an active roster person (by id, or exact
  name, case-insensitive) or `operator`. A name not on the roster is refused, telling the model to
  collect the person's name, a contact channel, their role and why they are the one to ask, then
  hand to the operator with those. A proposed or former person is refused. Handing to the current
  holder is refused. Accepted: an invisible `sova-baton-handoff` entry `{v:1, n, from, to,
  question, briefing}`, the registry moves the baton, a hand-off to a person mints their link, and
  the turn ends (`terminate`). The model is told to say who takes over in the same reply, before
  the call.
- `goal_done({summary})`: the goal is met. An invisible `sova-baton-done` entry `{v:1, summary}`;
  the session is **done**, no one holds the baton, and the turn ends.
- `record_decision({area, statement, quote})`: an invisible `sova-baton-decision` entry `{v:1,
  area, statement, quote, by}` (`by` = the holder); the turn goes on — unless the same reply also
  calls `hand_to` or `goal_done`, when it ends the turn with them (pi ends a run only when every
  tool of the batch agrees). Slice 1 only logs decisions.
- `hand_to` also takes the roster line the prompt shows ("Maria Lopez (id p_…)", "Maria Lopez —
  Payroll"). A string whose id and name disagree, or that names two roster ids, is refused with a
  question back ("That id is Maria Lopez's, but the name says Mallory. Which did you mean?"): a
  hand-off routes someone's conversation, so nothing is guessed.
- `propose_roster_edit` (§app.organizations/referrals) records a person who is not on the roster;
  the turn goes on.
- The operator may **Take back** at any time: recorded as a hand-off from the holder to the
  operator with the question "(taken back)".
- The operator may **hand the session to a person** (`POST /api/baton/:sid/handoff {to, question,
  briefing?}`, "Hand this session to Bob"): an active roster person only (a proposed one is
  refused: approve first); recorded like any hand-off, and answered with that hand-off's link.
- **Close** ends it without a goal: state **closed**, every link answers 410. Done and close both
  start the wrap-up (§app.organizations/wrap-up), once.
- In-process events (`server/baton-events.ts` `onBatonEvent`): `decision` (with the decision
  entry's id), `handoff`, `offer`, `done`, `closed`, `wrapup`, `proposal`, each with the org,
  project and session; the project overseer and the reconciler listen. A listener that throws is
  logged and stops nothing.

## §app.baton/links — One link per hand-off

- A link is `/h/<token>`, on the share listener's public address (`SOVA_SHARE_PUBLIC_URL`, else
  the bound address): 32 random bytes, base64url. One is minted when a session starts with a
  person, and when the operator asks for one (Get Link, for the current hand-off); a `hand_to`
  mints none — the host could never show it — so until the operator gets one, the session needs
  them (§app.baton/needs-you). The host stores only
  its SHA-256, bound to (org, session, hand-off, person), with an expiry of 14 days, in
  `<stateRoot>/baton-links.json` (mode 0600) — never in the workspace repo. Tokens are compared in
  constant time. Logs show at most 6 characters of a token.
- A link **writes** only while its person holds the baton through that hand-off and the session is
  open. After the baton moves on, or once the session is **done**, the link still **reads** the
  conversation; after **close**, revoke or expiry it answers 410. An unknown token answers 404.
- The operator can get the current link (`GET /api/baton/:sid/link` mints a fresh one for the
  current hand-off and turns off the older ones for it: the host cannot show a token it no longer
  has) and turn it off (`POST /api/baton/:sid/revoke`). A link is shown once, with a Copy Link
  button; it stays on the strip until the operator dismisses it or a later hand-off exists (a
  reload of the strip's own data never clears it). During an offer, `GET /api/baton/:sid/link?person=<id>` re-mints one invitee's link and
  turns off that invitee's older one.

## §app.baton/attribution — Every message by name

- Every user message in a baton session carries an invisible `sova-baton-sent` entry `{v:1,
  targetId, by}` (`by` = a person id or `operator`), written once the message has entered the
  context, by the same mechanism as the Overseer's sent marker (§app.overseer/sent-marker).
- A message from the share page is attributed to its token's person; the share routes take no
  sender field. A message from the operator's own composer is attributed to the operator, and is
  accepted only while the operator holds the baton and the session is open (refused otherwise,
  and the composer says why: "<name> holds the baton. Take it back to write." or "This hand-off
  session is done."). `POST /api/sessions/prompt` (the Overseer's `sova_send`) refuses a baton
  session with a 409.
- The operator's transcript shows the sender's name on each user row, and the hand-off, done and
  decision entries as cards.

## §app.baton/outsider-view — What the share page shows

- Only: the public title; user messages with their sender's name; the model's reply text;
  hand-off cards (from and to names, the question, and the briefing only when the viewer is its
  addressee); the done card; the decision cards ("Noted", the area and the statement); and who
  holds the baton now ("Waiting on <name>", "Your turn, <name>.", or done/closed). The composer
  appears only while the link writes, with the hint "{n} of 4,000 characters · Ctrl+Enter sends"
  (figures with a thousands comma).
- Never: thinking, tool calls or results, the system prompt, the model, session id, path or cwd,
  the project or org beyond the public title, the goal, any profile field, other sessions, or any
  other Sova UI. The filter runs on the server; the page receives nothing else.
- Live: the page receives the filtered view again after every change and, while the model writes,
  only the reply's text so far — never raw events.
- Text only: images are refused; a message starting with `/` is refused; ≤ 4000 characters.
- An **offer** shows as a card with the question, how many people were asked (never who: with two,
  "someone else" would name the other) and the briefing for an invitee. An invitee who has never
  held the offer sees the conversation only up to that card, is not told who holds it ("Someone
  else is answering right now"), and gets none of its streaming reply text. Nothing from the
  wrap-up's marker on is ever in the view.

## §app.baton/offers-and-leases — One baton, several people, the first to answer

- The operator offers a session to two or more active people at once (`POST /api/baton/:sid/offer
  {to[], question?, briefing?}` → `{info, links}`, one link per invitee, shown once; or `to` as a
  list at start). An offer is a hand-off (it takes the next number) to the **pool**: nobody holds
  the baton (`holder: null`, state `open`) until someone answers. A `sova-baton-offer` entry
  `{v:1, n, offerId, from, to[], question, briefing}` records it. Starting a new offer withdraws
  the current one.
- **The first accepted message claims it.** Opening the page claims nothing (link previews open
  links). The message route decides in one synchronous step: a lapsed lease returns to the pool,
  then an invitee's message on an open offer makes them the holder under a **lease**, then the
  holder rule applies as for any hand-off. Everything else is refused (409, code `taken`) — the
  route is the lock, the page's state is a courtesy.
- **Lease**: 15 minutes idle, measured from the later of the holder's last message and the last
  reply; each renews it. A lapsed lease returns the offer to its pool (the transcript records
  `sova-baton-lease` `{v:1, n, offerId, event: "claimed"|"expired", by}`), and any invitee's
  message may claim it again — at once in the route, and within 30 seconds on every waiting page
  (a ticker pushes their view). `SOVA_BATON_LEASE_MS` shortens the lease for hermetic tests only.
- **Withdrawn** when the holder hands on (`hand_to`), the operator takes it back or withdraws it
  (`POST /api/baton/:sid/offer/withdraw`: the operator then holds it), a new offer is made, or the
  session is done or closed. From then on every invitee who never held it gets 410; anyone who did
  is a participant and keeps reading, like any earlier holder.
- Whoever claims an offer is its holder like any other: their page shows the whole filtered
  conversation, including what an earlier claimer whose lease lapsed wrote, under that person's
  name. Only invitees who have never held it see nothing past the offer card.
- The operator's strip shows the offer (invitees, state, who holds it, the lease's end); the
  session list shows "N invited" while it waits, then the holder's name.

## §app.baton/share-listener — The public entry point

- A second HTTP server, bound only when `SOVA_SHARE_HOST` and `SOVA_SHARE_PORT` are set (no
  listener otherwise). It serves only: `GET /h/<token>` (the share page), `GET /h/assets/*` (the
  share page's own build, never the operator app's), `GET /api/h/<token>` (the filtered view and
  state), `POST /api/h/<token>/message {text}` and the WebSocket `/ws/h?token=`. Every other path
  answers 404 before any routing; the operator app, `/api/*`, `/ws/chat`, `/ws/watch`, `/peer/*` and
  `/ext/*` are unreachable on it. The main listener never serves the share page.
- Limits: request bodies over 16 KB (or without a length) are refused (413); per token 10 messages
  a minute (429) and one WebSocket (a new one replaces the old, which is told it opened
  elsewhere); per client address 60 requests a minute (429). Behind a proxy on loopback or the
  tailnet, the client address is the last `X-Forwarded-For` hop; a direct client's is its own.
- Every response is `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (the token is in
  the URL); the page carries a CSP allowing only its own scripts, and reply links open with no
  referrer.
- The share page is its own Vite build (`vite build --mode share` → `dist-share/`).
- Public exposure is a deployment step outside Sova: a TLS reverse proxy (e.g. Caddy on the VPS)
  forwarding to the share port, over the tailnet when the home host is the laptop.

## §app.baton/needs-you — The operator's turn

- When the baton is handed to the operator (by `hand_to`, by Take back, or at the budget limit)
  the session **needs the operator**: an act-tier attention item `baton-needs-you`, "<from> → you:
  <question>" (≤ 200 characters), in the digest (§app.overseer/attention-digest) and so the
  sidebar's Needs you region. The operator's reply clears it.
- When a person holds the baton through a hand-off with no live link, the same item says "Send
  <name> their link: <question>"; getting the link clears it.
- An open offer whose invitees don't all have a live link (started in-process with `mintLink:
  false`) says "Send <names of those without one> their link: <question>" the same way, until
  every invitee has one.
- A person proposed from the session and still waiting (§app.organizations/referrals) is a
  decide-tier item `roster-proposal`, "Approve Bob Smith (IT lead) proposed by Tony Reyes?", listed
  in Needs you. Approving or declining clears it at once (the session list is re-diffed; a baton
  row's state is part of what the list compares).
- Baton sessions are not classified by attention signals (§app.decisions/attention-signals).
- A composer send the session refuses (someone else holds the baton, it is done, the budget is
  spent) comes back on `/ws/chat` as an error with code `refused` and the reason, never `internal`.

## §app.baton/rejected — Considered and not done

- **One link per session** (rejected): a forwarded link would let anyone post as anyone; one per
  hand-off binds a link to one person and one stretch of the conversation.
- **Outsiders on the main listener with a filter** (rejected): one mistake in a route would expose
  the operator app; a separate listener with an allowlist fails closed.
- **Committing link hashes with the workspace** (rejected): see §app.organizations/decisions.
