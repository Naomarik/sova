# §app/owner-page — The owner page: one page where an organization's owner follows its work and talks to its Project Assistant
> Part of the Sova design spec · [overview](../design/overview.md)

An organization (§app/organizations) may have one **owner**: a person on its roster, picked by the
operator, who is usually the client's boss (the director of an academy, the head of a company).
The owner gets one personal link on the share listener (§app.baton/share-listener) to one page,
phone first, where they read how every project is going: a status per project, the updates the
project overseer posts at each real milestone, who was asked and what was decided, how much work
was built (as counts), and the client conversations themselves. On it they also talk to their
Project Assistant (§app/project-assistant), see their requests and where they stand, and open the
versions they can try. Reading changes nothing; only the Project Assistant's chat, the owner's
answer in a conversation that waits on them, and the ask for a new link write. Reviewed checked tours attached within a conversation it already exposes are
readable there (§app.tours/handoffs), without any new application access or agent controls.

The word **owner** here always means the organization's owner. It is not a baton session's owner
(who started the session, §app/baton) and it is not a project's main stakeholder
(§app.organizations/stakeholder); the three are unrelated.

The page is written for people who are not technical. The organization's name is its title; Sova
shows only as a small mark and name at the top. Beyond that name none of Sova's own words reach
it: the exact copy is §design.copy-deck/owner-page, and its list of words never used there is part
of this claim.

## §app.owner-page/owner — One owner per organization, picked by the operator

- **Stored on the org**, in its statechart in the workspace repo, so it travels
  (§app.organizations/portability): `owner` (a person id, or absent or `null`: none), `ownerHistory` (`{at, from, to,
  why, via?}`, oldest first, the last 50; `why` is `operator`, or `left` when Sova cleared it because the
  person left; `via: "overseer"` when the global Overseer set it for the operator) and, after a clearing, `ownerCleared` (`{personId, name, at}`) until the operator
  saves the select again.
- **Only an active roster person.** `PUT /api/orgs/:id/owner {personId | null}` (main listener
  only) accepts an active person of that org or `null`. A proposed, left or unknown person is
  refused (400, "Only an active person on the roster can be the owner.") and nothing is written.
  Saving the same person again writes nothing.
- **The operator's alone.** No model, wrap-up, referral or project overseer has a tool or a route
  that sets it (§app.organizations/field-authority), with one exception acting for the operator:
  the global Overseer's `sova_owner`, only in a turn the operator started, through the same route
  and recorded in `ownerHistory` with `via: "overseer"` (§app.overseer/org-attribution). No model
  shows or turns off an owner link, and none makes one, except the global Overseer's send of the
  owner's link to the owner on WhatsApp, behind the user's click (§app.owner-page/send), which never
  shows it.
- **Changing the owner** turns off the previous owner's owner link at once (§app.owner-page/link).
- **When they leave** (their status becomes `left`, by an edit or a revert): the owner is cleared
  (`why: "left"`, `ownerCleared` kept), their owner link stops working at once, and the People
  tab's owner card says so until the operator picks someone or chooses None.
- **Not a decider.** Being the owner changes no routing, no promotion and no prompt: no model that
  routes, decides or talks to people is told who the owner is. The global Overseer's org reads name
  them, for the operator (§app.overseer/org-reads). The owner may also be a project's main stakeholder; that is a separate
  choice on each project page.
- **Still an ordinary person.** Their own `/h/` links to conversations they are asked in keep
  working as before (§app.baton/links); the owner page adds reading, it replaces nothing.

## §app.owner-page/link — One personal link, off after a week unused, one at a time

Scoped tour reads additionally require current owner access and a tour handle bound to a conversation and cut already exposed by the owner-page view. For these byte routes, revoked or expired tokens and unauthorized or guessed handles all answer missing 404 before file access, rather than disclosing link or artifact state; ordinary owner-page dead-link answers remain as below (§app.tours/handoffs).

- **Shape.** `/i/<token>` on the share listener's public address, built exactly like a hand-off
  link (§app.baton/links): 32 random bytes, base64url; the store keeps its SHA-256, compared
  in constant time, and the token is kept in `link-tokens.json` (§app.session-share/link); logs show
  at most 6 characters. The `/i/` path is meant to become each
  person's one door later (their own inbox too), so the store is per person, not per page.
- **Where it lives.** `<stateRoot>/person-links.json` (mode 0600), host-local, never in the
  workspace repo: `{hash, orgId, personId, scope: "owner", gen, createdAt, expiresAt, revokedAt?,
  revokedWhy?}` per link, and the host's handle key (§app.owner-page/conversations). A clone and attach on another host has no owner link: the operator sends
  a new one there.
- **Off after 7 days unused.** A link turns itself off once 7 days pass with no use; there is no
  other expiry. Its `expiresAt` is that deadline: 7 days after it was made, moved to 7 days after
  each use (`lastUsedAt`), written at most once an hour. A use is a request the link answers for a person: a read
  of `/api/i/*`, a message to the Project Assistant, an Open of a version. A link previewer's fetch,
  a refused request and the operator's Preview are no use. A link that turned off never comes back.
- **Ask for a new link.** A link that turned off unused (and only such a link: not one replaced,
  turned off, or whose person is no longer the owner) offers `Ask for a new link`:
  `POST /i/<token>/ask-link` records `askedAt` on the link (asking again within a day answers the
  same and records nothing), and the operator's Needs you shows it (`owner-link-request`), with a
  phone notification, until a new owner link is made for the org (one made by the Overseer's send
  counts only once its message went, §app.owner-page/send). Every other dead or unknown link answers that route as it
  answers a read.
- **One live link per org.** `GET /api/orgs/:id/owner/link` (main listener only) makes a new link
  for the current owner and turns off every older one of that org at once (Get New Owner Link).
  With `?keep=1` (Get Owner Link) it answers the owner's live link instead when its token is kept,
  and makes one, as without it, only when none is live or the live one isn't kept; an older host
  ignores `keep` and makes one. The owner card's data (`OrgDetail.ownerPage`) carries the live kept
  link as `link.url`. The answer is `{link, createdAt, expiresAt, linkWarning?}` (`linkWarning` as for
  hand-off links when no share address is known). With no owner it is refused (400, "Pick an owner
  first."), and the preview answers 409.
- **Turning it off.** `POST /api/orgs/:id/owner/revoke` turns the live link off. It is also turned
  off, with nothing asked, when the owner changes, when the owner leaves, and when the org is
  detached.
- **Checked on every request.** A request resolves only a link that is not turned off, not expired,
  whose org is attached, and whose person is active and still that org's owner; anything else
  answers as a dead link, even if nothing turned it off yet.
- **Dead links** answer 410 with no org name, no person's name and nothing else: a link that turned
  off unused says so (`why: "idle"`, "This link turned off after a week without use.") and offers
  the ask; every other dead link (replaced, turned off, owner changed,
  person left, org detached) gets one generic answer ("This link is no longer active."), so a
  forwarded link never says why. An unknown token answers 404 ("This link doesn't open anything.").
- **Visits** are logged in the org's `visits.jsonl` as for hand-off links (§app.baton/visits), with
  `via: "owner"`, the link's `gen` (1 for the org's first owner link on this host, then one more
  per link made) and no `sessionId` or `n`: the same continuation by tab (`?v=`), the same 10-minute
  window, 20 new visits per link per day, previews and refused attempts. The owner never sees any
  visit, their own included.

## §app.owner-page/content — What the page shows

A shown conversation can include its reviewed checked tour attachments (§app.tours/handoffs), through the same filtered public projection and opaque handles. Their viewer is read-only, with no Ask control, script, report, source identity or recorded site address. Pictures belong only to the exact attached edition; message-photo count-only behavior is unchanged.

- **Three tabs**: `Home`, `Assistant` and `Requests`, a bar at the bottom on a phone and a left
  sidebar on a computer (§app.owner-page/page). `Requests` shows the count of open requests (with
  the team or being worked on) while there is one, and `Home` the count of conversations waiting on
  the owner while there is one; that count also leads the browser tab's title. A project and a
  conversation open inside Home,
  and Home stays highlighted. All three read the same Home data and keep it current the same way:
  while a version is starting, every tab reads again every 3 seconds, so it moves to `Open` on
  whichever tab is showing.
- **Its frame.** At the top of every view (the top of the left sidebar on a computer), Sova's mark
  and the name "sova" (lower case), small, with the theme toggle on the same row, to their right (§app.owner-page/page). Each view's
  main heading is the organization's name, and the browser tab's title is that name too; the
  view's own title (the greeting, a project's name, a conversation's title, `Project Assistant`,
  `Your requests`) comes under it.
- **Its views**, each in the URL fragment so the browser's Back and a shared address work:
  - **Home** (`/i/<token>`), in this order: a greeting to the owner by first name, with when it
    was last updated in small type under it; **Waiting on you**, only when something waits on
    them; the **Project Assistant card**, headed "What it can do for you" (the one strong colour
    on the page): its lines (§app.project-assistant/abilities), each tappable, and `Open the Chat`;
    one line on the owner's requests ("Your requests: 1 with the team ›"), only when they made
    one, opening the Requests tab; **Versions you can try**, only when a shown project lists one
    (§app.project-assistant/versions): each its name, its project, and `Open`, `Starting…`, "It
    didn't start. The team knows." or `Not running right now`; **Your projects**, one card per
    shown project (name, status, the newest update, and a line of counts), the whole card a link;
    **Conversations** (below); the footer.
  - **Conversations** on Home gathers every shown conversation of every shown project
    (§app.owner-page/conversations) in two tabs. `Outstanding`: everything still open, those
    waiting on the owner first, then those waiting on someone else (a person, or an offer still
    out), then those with the team; newest first within each; each row its title, its project,
    its status chip (who it waits on, by first name) and since when (the hand-off or offer that
    put it there, else when it started). `History`: every finished, agreed or ended
    conversation, the most recently ended first, each with its project, its chip and when it
    ended. A `Project` select narrows both to one project when there are several. Each shows 5,
    then a button that shows all; a row opens the conversation.
  - **New since your last visit.** A project card, an update, a conversation row and a request
    that changed after this browser's previous visit carry a `New` chip. The previous visit is
    remembered in the browser, per organization; a browser's first visit marks nothing. The
    mark's starting point holds for the tab's session, so a reload keeps the marks.
  - **The Project Assistant** (`#a`): a chat screen that fills the window's height: the title at
    the top, the conversation in the middle, newest at the bottom, its first bubble the
    assistant's greeting, and the composer (§app.project-assistant/chat) pinned at the bottom while
    the conversation scrolls, never covering the newest message as it grows (an error line,
    pending photos). It opens at its newest 50 messages and loads the 50 before them each time the
    owner scrolls near the top, back to the first message, keeping what they read where it was. A
    fresh read or a pushed update carries only the newest messages and is merged into what is on
    screen by each message's number: messages loaded earlier stay, in order. A sent message shows
    at once (§app.project-assistant/chat). It opens scrolled to its newest message, the message box focused where there is a
    mouse or trackpad (never on a touch-only screen, where focus would raise the keyboard). It
    follows an answer as it is written only while the owner is at the end (within 80px): once they
    scroll up to read, nothing moves the page until they scroll back down or send, and a send
    takes it to the end again. A fresh read of the conversation redraws only the messages that
    changed, so an interactive drawing keeps its state while a version on screen starts. The
    owner's own photos show in their messages (§app.project-assistant/photos), the assistant's
    drawings in its answers (§app.project-assistant/drawings), and a version it started as a row
    with `Open` (§app.project-assistant/versions). Before the first message, the card's lines show
    as tappable suggestions under its greeting; once there are messages, a `What Can I Ask?` button
    at the top opens a sheet with the same list and suggestions (a modal dialog, focus kept in
    it). A suggestion starts the message box as a card line does; nothing is sent until `Send`.
    On a phone the tab bar hides while the owner types in the box and comes back when they leave
    it. The operator's Preview as shows the same, read only.
  - **Requests** (`#r`): every one of the owner's requests (§app.project-assistant/requests),
    newest first, each its title, its project, kind and where it stands, an open one with `Close`;
    the ones the owner closed below the rest under **Closed**, greyed, each with `Reopen`
    (§app.project-assistant/closing); with none, a line saying nothing was asked yet and `Open the
    Chat`. `Requests`' count and Home's line leave closed requests out.
  - **Versions you can try** show each version's summary under its name when one is shown
    (§app.project-assistant/versions).
  - **A project** (`#p/<handle>`): its name and status, then in this order: **Updates**,
    **Waiting on you** (this project's, only when there is something), **Who we've talked to**,
    **What's been decided**, **What's been built**, **Versions you can try** (this project's, only
    when it lists one), **Conversations**. Updates, decisions and conversations show 5, then a
    button that shows all.
  - **A conversation** (`#c/<handle>`): its title, one status line, then the conversation. It
    pages as the Project Assistant does: its newest 60 items, then 60 more each time the owner
    scrolls near the top, back to the first; a fresh read or a socket update merges into what is
    loaded and never drops it. The page's socket says when any shown conversation changed and
    carries its reply while it is written, so the open one reads again at once.
- **Project status**, worked out from records, never typed by anyone; the first that applies:
  `Waiting on you` (the owner holds one of its shown conversations, or an open offer includes
  them) · `Asking questions` (a shown conversation is open) · `Building` (a piece of work is in
  progress) · `Quiet`.
- **Updates**: the project's posts (§app.owner-page/updates) that were not taken down, newest
  first, each its text and when.
- **Who we've talked to**: every roster person in a shown conversation of the project (holders,
  hand-offs, offer invitees, senders), by name only, with how many conversations and when they
  last wrote, or that they haven't replied yet; `Waiting on {first name}` while they hold one. The
  operator is not listed; proposed people are not listed.
- **What's been decided**: the decisions of the shown conversations, grouped by topic (the
  decision's area), each with its statement, who said it and when, a status (`Agreed` for
  promoted, `Noted` for pending or drafted, `Needs a choice` while in an open conflict), and, on
  request, the person's own words. Superseded decisions are not shown.
- **Different answers**: each open conflict of the project, as one sentence naming the two people,
  the topic, and who will choose (a person by name, the owner as "you", or the operator by name).
  Why it was routed there is never shown.
- **What's been built**: two counts only, over the project's coding sessions (the overseer's and
  the operator's): finished (its worktree merged or its branch deleted; one in the project root
  that isn't working now) and in progress (an unmerged worktree, missing or not; one in the project
  root while it works); a worktree removed without a merge is not counted. Merged is git's answer,
  as on the project page (§app.project-overseer/coding-worktrees): a branch merged once and given
  new commits since is in progress again; the recorded merge, or a deleted branch, counts only when
  the branch is gone or git can't be read. Git state is read at most once a minute. Nothing else about a coding session reaches the page.
- **Conversations**: every shown conversation of the project (§app.owner-page/conversations),
  newest first, each its public title, a status (`Waiting on you`, `Waiting on {first name}`,
  `With {operator's first name}`, `Asked {n} people`, `Finished`, `Ended`), when it started and how
  many messages it has.
- **A conversation** reads exactly as a share page shows it (§app.baton/outsider-view), with the
  owner as the viewer: the same filter, redaction and sender labels; briefings only when addressed
  to the owner; how many people an offer went to, never who; never cut at an offer; done and closed
  conversations included; a composer only while the conversation waits on the owner (below) and
  in the owner's own feature request chat while they hold it
  (§app.project-assistant/feature-chats), which also draws its plan cards. A message's photos (§app.baton/images) show as their count
  only ("2 photos"), never the pictures: only the owner's own photos, in their own Project
  Assistant chat, show as pictures.
- **Answering on the page.** While a conversation waits on the owner (they hold it through its
  current hand-off, or an open offer reached them, or they hold that offer's lease) the
  conversation shows a message box (text only, up to 4,000 characters, the hand-off page's keys)
  and says it is their turn. `POST /api/i/<token>/c/<k_handle>/message {text}` takes it exactly as
  the hand-off page's write takes a message (§app.baton/links): checked against the owner link
  (§app.owner-page/link) and the conversation being shown to them (else 404), then the same
  baton lock decides it: refused while someone else holds it (409 `not-holder`), once an offer
  went to someone else (409 `taken`), at the message limit (409 `budget`), once it is done or
  closed (409 `closed`), at 10 messages a minute per link (429), and a message starting with `/`
  (400). An accepted message is the owner's own (their person id, never operator identity), claims
  an open offer as a link's first message does, and sends the reply's live text to the page as a
  feature request chat's does. No photos or files go through the page; a hand-off link still
  takes them.

## §app.owner-page/conversations — Which conversations the owner reads

A visible conversation's reviewed tour attachment follows that same conversation's current filtered cut; when the model shows an attachment visible above in that cut, the same item appears again at that point, copied from the attachment, never from the tool result's own data. Hiding the conversation or project, an attachment outside that cut, or a different conversation's handle makes every tour read indistinguishable from missing: 404 before any file read, without counts or filenames that disclose it (§app.tours/handoffs). Current active-branch detachment removes a tour immediately even when its detachment entry is beyond the owner's exposed cut, without exposing that later entry or deleting retained snapshots.

- **Client conversations, all of them, by default**: every gathering, offer and settle session of
  a shown project, other people's messages included. Staff are not told the owner reads them.
- **Hide from the owner**, per conversation: the baton strip's `Hide From {first name}` sets
  `hiddenFromOwner: true` on its statechart (`POST /api/baton/:sid/owner {hidden}`), and
  `Show To {first name}` clears it. A hidden conversation disappears everywhere on the page: its
  row, its decisions, its conflicts, its share of "Who we've talked to", every count and the
  project's status. Its handle answers 404, the same as a handle that never existed. No count of
  hidden things is ever shown.
- **Switch a project off**: the project page's `Show this project on {first name}'s page`
  (the placement's `ownerHidden`, §app.projects/placement, shown by default; `PATCH
  /api/orgs/:id/projects/:pid/placement {ownerHidden}`). A project switched off disappears from the page with everything in it, and its
  handle answers 404.
- **A feature request chat** (§app.project-assistant/feature-chats) is shown only to the person who
  opened it, while they are the owner; Hide From is never offered for it.
- **Gathered on Home** (§app.owner-page/content, Conversations): the same shown set, across the
  shown projects, regrouped as Outstanding and History. A hidden conversation or a switched-off
  project is never in either tab, nor in any count or filter; the `Project` select lists only shown
  projects.
- **Never shown**: the project overseer's conversations (current and history), coding sessions
  (their titles and topic summaries too), and every other session of the operator's.
- **Handles.** Projects and conversations are addressed on the page by a handle (`q_` + 8
  characters for a project, `k_` + 8 for a conversation, lower-case letters and digits 2–9): an
  HMAC of the id under a random key the host keeps in `person-links.json`. Nothing is stored on the
  rows; a handle is stable on this host and means nothing elsewhere. A handle outside the token's
  org answers 404.

## §app.owner-page/updates — The project overseer's updates, posted at real milestones

- **Posted by the project overseer, on its own.** A tool, `sova_owner_update({text})`, of the power `ownerUpdates` (§app.project-overseer/autonomy-levels), appends a post to `projects/<pid>/updates.jsonl` in
  the workspace repo: `{kind: "post", id: "u_…", at, by: {kind: "overseer", run: "auto" |
  "operator"}, text}`. Nothing waits for approval; a post made in a run the operator did not start
  waits in a hold first, which the operator or the overseer may cancel
  (§app.project-overseer/holds). With no owner set it refuses: there is no page
  to post to. The operator can also ask it in chat to post something; a post made in the
  operator's own turn is marked `run: "operator"`.
- **Only at real milestones, at most one a day.** In a run the operator did not start, the tool
  refuses unless, since the project's previous post (or ever, before the first), one of its shown conversations finished
  (done), a decision of it was agreed (promoted), or one of its coding sessions finished (it is not
  working now and its session file was last written after that post) or was merged; and it refuses while the
  previous post is under 24 hours old. In the operator's own turn neither limit
  applies (the operator asked), but that post still starts the 24 hours.
- **For the client, never the private context.** The overseer's prompt says updates are for a
  non-technical client: plain words, no names of tools, branches, files or models, no judgments
  about people, and never anything from "About this organization", its notes, a goal or a
  person's profile. As a backstop the tool refuses a text that repeats 24 or more characters in a
  row (ignoring case and spacing) of the org's About text, the overseer's notes, the operator's
  extra instructions, a conversation's goal or briefing, or a roster person's role, voice, skills
  or referral reason, or that contains any of their contact details; it says which kind of text
  (About and notes, or the rest), never the text. The text is at most 2,000
  characters, plain text; an `http://` or `https://` address in it becomes a link on the page (a
  demo address the operator gave goes there). A text that holds a preview link this host keeps
  is refused: a preview link goes to people through the operator
  (§app.project-overseer/previews). Like everything the model wrote, it passes
  the outsider redaction before it is shown.
- **Logged on the project page.** Every post, taken down or not, is listed on the project page's
  Owner Page card with its text, when, and whether the overseer posted it on its own or because
  the operator asked (`run`); every tool call, refused or not, is also in the overseer's activity,
  from the transition log (§app.project-overseer/statecharts).
- **Taking one down.** The operator's `Take Down` (`POST /api/orgs/:id/projects/:pid/updates/:uid/
  withdraw`) appends `{kind: "withdraw", id, at}`: the post disappears from the owner page at its
  next read and stays in the file and on the project page's list, marked as taken down. The
  operator cannot write or edit a post.

## §app.owner-page/never — What the page never shows

Tour reads reveal only a checked public presentation bound to a conversation and cut the owner-page filter already exposes. They never reveal an authoring script, recording report, source identity, recorded site address, credentials, another conversation's tour, a later cut's attachment or a different edition's asset (§app.tours/handoffs).

- The page's data is built by one server function, field by field from its own wire shapes
  (`shared/owner.ts`); it never passes a stored row, a person, a project or a decision along
  whole. Every text a model wrote passes the outsider redaction (`said`, then the secret
  redactor); every other text passes the secret redactor.
- **Never on the page, in any answer of `/api/i/*` or in the page shell**:
  - the org's About text and the project overseer's notes, ideas, to-dos, actions, settings, extra
    instructions, levels, caps and conversations;
  - any goal, any briefing not addressed to the owner, any wrap-up, the baton prompt;
  - every profile field but a name: role, decision areas, skills, competence, language, voice,
    contact, referral details, profile history;
  - coding sessions' titles, prompts, transcripts, summaries, branches, worktree paths and
    commits; the project root; the workspace folder; git remotes;
  - any session, person, project, decision or conflict id; any token, token hash, link state or
    other person's link;
  - visits (anyone's), message limits, models, thinking levels, token counts and costs;
  - the Project Assistant's tool names, calls and results, request ids, preview addresses, ports
    and branch names (§app.project-assistant/never);
  - conflict routing reasons, stakeholder history, Needs-you items, proposed people;
  - hidden conversations and switched-off projects, their counts included.
- **One exception**: what the Project Assistant can do for the owner is shown as outcome words
  worked out from its column (§app.project-assistant/abilities): right away, on its own, the team,
  none. Never a switch's name or label, a level, the overseer's column, a model, a brake's reason
  or a limit.
- **One carve-out**: a version's summary (§app.project-assistant/versions), one or two plain
  sentences a model wrote from a fix's commits and changed files, is shown under its version: only
  through the outsider filter's `said`, then the secret redactor, never the commits, files,
  branches or messages it was written from, and never once the team hid it (their own rewrite,
  through the secret redactor, replaces it).
- Home's Conversations rows carry only what the project's own rows already show: a conversation
  handle, its public title, its project's handle and name, its status (with a first name when it
  waits on a person) and times (`since`, `endedAt`). A paged read (`older`) carries only items of
  the same filtered view and a count; no answer carries a cursor that names an entry id.
- A test plants a distinct marker in every one of those fields, checks each marker is present in
  the operator's own views (so its absence means something), then reads every owner-page answer
  (Home with its Conversations rows, the paged reads of the chat and of a conversation included)
  and the shell and finds none of them.

## §app.owner-page/page — Phone first; reading changes nothing

- Narrower than 768px (the page's own width, so the operator's preview follows its own box): one
  column, full width, with the tab bar fixed at the bottom (above the phone's home area) and the
  chat's composer above it. 768px and wider: the tabs as a left sidebar and a wider main pane,
  with chat and reading text kept at a comfortable width; never a chat beside the page. At 390px
  nothing scrolls sideways, every button, row and tab is at least 44px tall, and lines wrap rather
  than being cut. It is part of the share build (`dist-share/`), using its styles. The
  share build's page shell asks for `interactive-widget=resizes-content`, as Sova's own shell does
  (§app/shell), so an on-screen keyboard shrinks the page and a pinned composer stays above it. A
  reply's markdown reads as
  §app.session-share/reading describes.
- **Light, dark or the device's.** One small icon button, the theme toggle, sits on the same row
  as Sova's mark and name, to their right (in the sidebar's top row on a computer, the slim top
  bar on a phone), never a row of its own. Its icon shows the action: a sun while the page is
  dark ("Switch to light theme"), a moon while it is light ("Switch to dark theme"), as both its
  accessible label and its tooltip. Until the visitor clicks it, the page follows the device's
  light or dark setting, and changes with it; a click draws the opposite of what shows and makes
  that the pick. There is no "System" choice; a remembered "system" from before reads as no pick.
  A pick is remembered in that browser for the share address (its `localStorage`), so
  every page of the share build opened there (the owner page, a hand-off page, a shared session,
  a tour) follows it from its first frame; only the owner page shows the toggle. The theme is set
  by the page's own script before it draws (no inline script, the page's CSP unchanged), and the
  shell declares `color-scheme: light dark`, so the browser's own background matches before
  then. Drawings, frames, code and the photo viewer follow it (§app.baton/outsider-view).
- **The browser tab** carries Sova's icon, bundled into the share build (which has no public
  folder).
- **Its routes**, and no others: `GET /i/<token>` (the same page shell as `/h/`),
  `GET /api/i/<token>` (home), `GET /api/i/<token>/p/<q_handle>`, `GET /api/i/<token>/c/<k_handle>`,
  `GET /api/i/<token>/c/<k_handle>/older?before=<n>` (a conversation's earlier items),
  `GET /api/i/<token>/c/<k_handle>/tours/<handle>` and its narrowly scoped exact-edition asset reads
  (§app.tours/handoffs), `POST /api/i/<token>/c/<k_handle>/message` (the owner's answer, and a
  message in their feature request chat) and `POST
  /api/i/<token>/c/<k_handle>/end` (the owner's feature request chat,
  §app.project-assistant/feature-chats), `GET /api/i/<token>/assistant` (the chat), `GET
  /api/i/<token>/assistant/older?before=<n>` (its earlier messages), `POST /api/i/<token>/assistant`
  (a message to it), `POST /api/i/<token>/assistant/image` and `GET
  /api/i/<token>/assistant/img/<n>` (the owner's photos, §app.project-assistant/photos), `POST
  /api/i/<token>/requests/<r_handle>` (close or reopen a request, §app.project-assistant/closing), the socket
  `/ws/i?token=` (the chat's live view), `GET /i/<token>/v/<v_handle>`
  (a version) and `POST /i/<token>/ask-link` (§app.owner-page/link). The tour reads check current
  owner access and the already-exposed conversation cut before any file read, and recheck after
  asynchronous reads; denial is indistinguishable missing 404. They have no Ask control. Any other
  `/i/` or `/api/i/` path or method answers 404. Only a message to the Project Assistant or to the
  owner's own feature request chat, or the owner's answer in a conversation that waits on them,
  reaches a model. Each route is on the share listener's allowlist (§app.baton/share-listener)
  and routes to its own host by the token on a gateway, like the others.
- **Fresh.** The page reads again every 60 seconds while it is visible (paused while hidden, at
  once when shown again) and says when it last did.
- **Limits.** The listener's per-address limit applies, and the ordinary page and scoped tour-manifest reads share the existing per-token ceiling of 120 requests a minute (429), the paged reads (`older`) included. Exact tour-picture reads use a separate per-token bucket of 120 a minute, so reading pictures does not spend the page's allowance. The owner's photo reads (`/api/i/<token>/assistant/img/<n>`) count in the listener's photo bucket (§app.baton/share-listener), never the page's; a photo upload has the hand-off upload's body cap and time (§app.baton/share-listener). Tour denial remains indistinguishable missing 404 even when a rate bucket is exhausted; current access and exact picture membership are checked before the bucket and before any picture read.
- **Errors.** When a read fails for any reason but a dead link, the page says it couldn't load,
  that the link still works, and offers `Try Again`; what it showed before stays.
- **The Project Assistant's errors** read its answer's status as the page's own read does: a
  turned-off or replaced link (410) is the page's dead-link screen (`Ask for a New Link` where
  that applies), an unknown link (404 `not-found`) the unknown-link screen, too many requests
  (429) the busy screen, an offline host (503) the offline answer, read again with backoff. A 404
  with no `code` (an older gateway refusing the address) says the Project Assistant can't open on
  this link yet, that {op} has to update the server the link goes through, and that the projects
  still open (the Home tab), with no `Try Again`. Any other failure says it couldn't load
  the Project Assistant and offers `Try Again`, never that the link still works. The message box
  shows only once the chat's view has loaded.

## §app.owner-page/controls — The operator's side

- **People tab: an Owner card**, above the roster (§app.organizations/org-page): what the owner
  can see, in one sentence; a select (None, then the org's active people by name); the latest
  change ("Set by you {time}.", "Set by you, via the Overseer {time}." or, after a clearing, the
  person who left); the link's state (when
  it was made, when it was last used, when it turns off unused, how many times it was opened; a
  link that turned off unused says so, warned, and, once the owner asked, that they asked for a new
  one); `Copy Owner Link` while the live owner link is kept (it copies `ownerPage.link.url`),
  else `Get Owner Link` (`?keep=1`: the kept live link, or a new one when there is none to show;
  over a live link that isn't kept it asks first, with Get New Owner Link's confirm);
  `Get New Owner Link` while a live one exists (with a confirm: the current one stops);
  `Preview Owner Page`; and `Delete Owner Link` set apart as destructive (its confirm:
  §design.copy-deck/owner-page). A new link shows with Copy Link, as on the baton strip.
- **The Owner card's Project Assistant part** (§app/project-assistant): one line, "{n} open
  requests from {first name}", linking to the org's Requests tab (§app.project-assistant/requests-tab),
  which lists them and answers them, in place of a list here; `Open Assistant Chat` once the conversation exists; its models
  (§app.project-assistant/models) as three rows, `Its replies`, `Fixes it starts` and `Feature request
  chats it starts` (the `gathering` kind, which runs the feature request chats it opens), each saying where its model comes from, the model and its
  thinking level ("Default · Opus 5.5 · medium", "This organization · glm-5.3 · high") and its
  price, with `Change`, which opens the chat composer's model picker (the model row and its
  thinking ladder, then providers and models: favorites, search, the vision tag, models Settings →
  Models turned off left out) and saves the model and thinking at once, and, only on the
  organization's own pick, `Use Default`, which clears it. With no default and no pick the row says
  "Not set. Set a default in Settings → Organizations.", linking there. A reply model this host can't
  run or Settings → Models turned off is said under its row; for fixes, a project that overrides it
  is named; and, per project, its Project
  Assistant column of power switches (§app.project-overseer/autonomy-levels; its copy
  §design.copy-deck/project-powers), the same control as the project page's, with one line under
  them saying the owner sees what these let the assistant do, in plain words, on their page
  (§app.project-assistant/abilities).
- **Preview.** `Preview Owner Page` opens a modal that shows exactly what the owner sees, from the
  same function with no token (`GET /api/orgs/:id/owner/preview[?project=<q_handle>|?c=<k_handle>]`, main listener only); it
  records no visit and changes nothing. It shows the Project Assistant card, the three tabs (as a
  row at the top of the modal, never a fixed bar) and the chat's suggestions, read only. A test pins that the preview's data equals the token
  route's for the same org.
- **Project page: an Owner Page card** (only while the org has an owner): the `Show this project
  on {first name}'s page` switch, the updates log with `Take Down` (§app.owner-page/updates), and
  the versions on the owner's page with their summaries, `Rewrite`, `Use Automatic`, `Hide` and
  `Show` (§app.project-assistant/versions; `GET /api/orgs/:id/projects/:pid/versions`, `PUT
  /api/orgs/:id/projects/:pid/versions/:instance {text?: string | null, hidden?: boolean}`).
- **Baton strip**: `Hide From {first name}` / `Show To {first name}`, a row of the strip's More
  actions menu (§app.baton/strip-layout), on each conversation of an org with an owner but a feature
  request chat (§app.project-assistant/feature-chats), and a line while it is hidden
  (§app.owner-page/conversations).
- **Person page**: an `Owner` chip beside the owner's status, their owner link among their links
  (state, made, expires, Copy Link while live and kept, Delete), and their visits to the owner page as "Opened the owner page"
  rows (§app.organizations/person-page).

## §app.owner-page/send — The Overseer sends the owner their page link

- **Only when the user asks, behind a card.** The global Overseer's
  `sova_owner {op: "send_link", org, person, note?}` sends an org's current owner their owner page
  link on WhatsApp. It runs only in the turn a click on a confirm card opened, the card listing that
  person in that org (§app.overseer/org-people-facing). Anywhere else (a typed "yes", no card, a
  Retry of the click, a later turn, a card already answered, superseded or dropped, a card listing
  someone else or a same-named person of another org) it refuses before anything is made or sent.
  Like every org act it is refused in a run the user did not start, no approval for later or
  standing rule covers it (§app.overseer/tools), and it counts as one organization write
  (§app.overseer/caps). Project overseers and the Project Assistant have no way to it: the act is
  the operator's alone.
- **The owner, and only them.** `person` must be the org's current owner and active. Anyone else is
  refused, "{name} isn't {org}'s owner. Nothing was sent.", and an org with no owner "{org} has
  no owner, so there is no owner page to send. Nothing was sent.". The org statechart's
  `owner/send-link` act checks it again (the person active and the org's owner, the note), with the
  confirm card as its backstop, so a card raised before the owner changed sends nothing.
- **One step, checked as it runs.** The act's effect is the organization's own send
  (§app.outreach/send). As it runs it checks again that the person is still the org's active
  owner, the org is attached here, they have a WhatsApp number on the roster, outreach is on and
  not paused, the org's number is up and not paused, and links can be opened from outside. Any
  refusal makes nothing and sends nothing.
- **Which link.** The owner's live link, when Sova still holds its token (the one Get Owner Link
  would give): that same link goes, and nothing the owner holds stops working. Otherwise a new one
  is made exactly as Get New Owner Link makes it (§app.owner-page/link): every older owner link of
  the org stops at once, so the org still has one live link. The org's read (`sova_orgs {org}`)
  says which it will be, and the Overseer is told (its instructions and the tool's description, not
  a check) to say on its card beforehand "Their current link will stop working." when a new one
  will be made.
- **The message.** "{operator name} sent you your page for {org name}." (§design.copy-deck/owner-page),
  or the user's note instead when they asked for one, then the link (§app.outreach/channels). A
  note is at most 500 characters and is refused when it repeats a contact or private text of the
  org or any of its projects.
- **What the Overseer says.** Sent: "Sent {name} their owner page link on WhatsApp." A definite
  failure or refusal: "Not sent to {name}: {why}.", then, when the send made a new link, "A new
  owner link was made but not delivered, and their old link no longer works: copy the new one from
  the People tab.", else "You can send it yourself from the People tab.". The new link stays: it is
  the org's one live link. No answer (a timeout, the connection closed, a restart mid-send): "It
  isn't known whether the message to {name} went. It won't be sent again: check {name}'s page under
  Sent on WhatsApp before sending another.". A step is never retried, and the same step run twice
  delivers once (§app.outreach/send). Its result, its error and its action-log line never hold the
  link, the token or the number (§app.overseer/org-projection).
- **The owner's ask.** A link the send made answers the owner's `Ask for a new link`
  (§app.owner-page/link) only once its message went: until then it carries the ask (`askedAt`) and
  an `undelivered` mark, so Needs you keeps `owner-link-request` after a failed or unknown send. A
  delivered send of that link, or Get New Owner Link, clears it.
- **The owner changing meanwhile.** Changing the owner, or the owner leaving, turns every owner
  link of the org off as always (§app.owner-page/owner), a link this send made included. The send
  itself never turns off or changes a link of anyone else, so a new owner's link stays untouched.
- **Recorded.** The send log line (§app.outreach/log) says `link: "owner"` and has no
  `projectId`; the owner's person page lists it under Sent on WhatsApp as "Their owner page"
  (§app.organizations/person-page); the org's history records it as the operator's, via the
  Overseer, a message sent to the owner.

## §app.owner-page/rejected — Considered and not done

- **A send that turns the older owner link off only once its message went** (al_1 review): it
  would leave two live owner links of one org while the send is in flight. The Overseer's send makes
  a new link as Get New Owner Link does, and is told to say so on its card first (§app.owner-page/send).
- **Telling staff the owner can read their conversations** (rejected by the user): one more line
  on every share page, for a fact the operator already manages with Hide From.
- **An operator news editor or an approval step** (rejected by the user): the overseer posts on its
  own at real milestones; the server's limits and the About backstop hold what a human review
  would, and Take Down undoes a post.
- **Showing coding session titles or summaries**: they are written for the operator and name
  files, branches and tools; the counts and the updates say what was built.
- **Showing or summarising the overseer's conversation**: it is candid, technical, and its tool
  results carry roster data and the About text.
- **Showing a conversation's own link on the page**, so the owner could copy it (al_1): the page
  never shows a link, so a forwarded owner link can't leak the others; the conversation opens
  from its row and is answered there.
- **Recognising the same person across organizations by email or phone** (al_1): a shared office
  number or a typo would show one client's projects to another. The page lists this
  organization's projects only.
- **Sending a second message while an answer is written** (queued, as in Sova's own chat; al_1):
  it changes how the assistant takes turns; the instant `Sending…` row fixes the delay without it.
- **An owner per project, or a login**: one person per org with one personal link is what the
  user asked for.
- **Showing costs**: never on this page; the assistant's models and their costs are on the
  operator's Owner card only.
