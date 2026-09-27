# §app/owner-page — The owner page: one read-only page where an organization's owner follows its work
> Part of the Sova design spec · [overview](../design/overview.md)

An organization (§app/organizations) may have one **owner**: a person on its roster, picked by the
operator, who is usually the client's boss (the director of an academy, the head of a company).
The owner gets one personal link on the share listener (§app.baton/share-listener) to one page,
phone first, where they read how every project is going: a status per project, the updates the
project overseer posts at each real milestone, who was asked and what was decided, how much work
was built (as counts), and the client conversations themselves. The page only reads: nothing on it
changes anything.

The word **owner** here always means the organization's owner. It is not a baton session's owner
(who started the session, §app/baton) and it is not a project's main stakeholder
(§app.organizations/stakeholder); the three are unrelated.

The page is written for people who are not technical. None of Sova's own words reach it: the exact
copy is §design.copy-deck/owner-page, and its list of words never used there is part of this claim.

## §app.owner-page/owner — One owner per organization, picked by the operator

- **Stored on the org**, in the workspace repo, so it travels (§app.organizations/portability):
  `org.json` `owner` (a person id, or absent or `null`: none), `ownerHistory` (`{at, from, to,
  why}`, oldest first, the last 50; `why` is `operator`, or `left` when Sova cleared it because the
  person left) and, after a clearing, `ownerCleared` (`{personId, name, at}`) until the operator
  saves the select again.
- **Only an active roster person.** `PUT /api/orgs/:id/owner {personId | null}` (main listener
  only) accepts an active person of that org or `null`. A proposed, left or unknown person is
  refused (400, "Only an active person on the roster can be the owner.") and nothing is written.
  Saving the same person again writes nothing.
- **The operator's alone.** No model, wrap-up, referral or project overseer has a tool or a route
  that sets it (§app.organizations/field-authority).
- **Changing the owner** turns off the previous owner's owner link at once (§app.owner-page/link).
- **When they leave** (their status becomes `left`, by an edit or a revert): the owner is cleared
  (`why: "left"`, `ownerCleared` kept), their owner link stops working at once, and the People
  tab's owner card says so until the operator picks someone or chooses None.
- **Not a decider.** Being the owner changes no routing, no promotion and no prompt: no model is
  told who the owner is. The owner may also be a project's main stakeholder; that is a separate
  choice on each project page.
- **Still an ordinary person.** Their own `/h/` links to conversations they are asked in keep
  working as before (§app.baton/links); the owner page adds reading, it replaces nothing.

## §app.owner-page/link — One personal link, 90 days, one at a time

- **Shape.** `/i/<token>` on the share listener's public address, built exactly like a hand-off
  link (§app.baton/links): 32 random bytes, base64url; the host keeps only its SHA-256, compared
  in constant time; logs show at most 6 characters. The `/i/` path is meant to become each
  person's one door later (their own inbox too), so the store is per person, not per page.
- **Where it lives.** `<stateRoot>/person-links.json` (mode 0600), host-local, never in the
  workspace repo: `{hash, orgId, personId, scope: "owner", gen, createdAt, expiresAt, revokedAt?,
  revokedWhy?}` per link, and the host's handle key (§app.owner-page/conversations). A clone and attach on another host has no owner link: the operator sends
  a new one there.
- **90 days.** A link expires 90 days after it was made, absolutely; nothing renews it.
- **One live link per org.** `GET /api/orgs/:id/owner/link` (main listener only) makes a new link
  for the current owner and turns off every older one of that org at once, so the host never shows
  a token it no longer has; the answer is `{link, expiresAt, linkWarning?}` (`linkWarning` as for
  hand-off links when no share address is known). With no owner it is refused (400, "Pick an owner
  first."), and the preview answers 409.
- **Turning it off.** `POST /api/orgs/:id/owner/revoke` turns the live link off. It is also turned
  off, with nothing asked, when the owner changes, when the owner leaves, and when the org is
  detached.
- **Checked on every request.** A request resolves only a link that is not turned off, not expired,
  whose org is attached, and whose person is active and still that org's owner; anything else
  answers as a dead link, even if nothing turned it off yet.
- **Dead links** answer 410 with no org name, no person's name and nothing else: expired links say
  so ("This link has expired."); every other dead link (replaced, turned off, owner changed,
  person left, org detached) gets one generic answer ("This link is no longer active."), so a
  forwarded link never says why. An unknown token answers 404 ("This link doesn't open anything.").
- **Visits** are logged in the org's `visits.jsonl` as for hand-off links (§app.baton/visits), with
  `via: "owner"`, the link's `gen` (1 for the org's first owner link on this host, then one more
  per link made) and no `sessionId` or `n`: the same continuation by tab (`?v=`), the same 10-minute
  window, 20 new visits per link per day, previews and refused attempts. The owner never sees any
  visit, their own included.

## §app.owner-page/content — What the page shows

- **Three views**, each in the URL fragment so the browser's Back works:
  - **Home** (`/i/<token>`): the org's name, a greeting to the owner by first name, the
    read-only line, when it was last updated; **Waiting on you**, only when something waits on
    them; **Your projects**, one card per shown project (name, status, the newest update, and a
    line of counts), the whole card a link.
  - **A project** (`#p/<handle>`): its name and status, then in this order: **Updates**,
    **Waiting on you** (this project's, only when there is something), **Who we've talked to**,
    **What's been decided**, **What's been built**, **Conversations**. Updates, decisions and
    conversations show 5, then a button that shows all.
  - **A conversation** (`#c/<handle>`): its title, one status line, then the conversation.
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
  root while it works); a worktree removed without a merge is not counted. Git state is read at most
  once a minute. Nothing else about a coding session reaches the page.
- **Conversations**: every shown conversation of the project (§app.owner-page/conversations),
  newest first, each its public title, a status (`Waiting on you`, `Waiting on {first name}`,
  `With {operator's first name}`, `Asked {n} people`, `Finished`, `Ended`), when it started and how
  many messages it has.
- **A conversation** reads exactly as a share page shows it (§app.baton/outsider-view), with the
  owner as the viewer: the same filter, redaction and sender labels; briefings only when addressed
  to the owner; how many people an offer went to, never who; never cut at an offer; done and closed
  conversations included; no composer. When it is the owner's turn in it, the page says to answer
  through the link the operator sent for it.

## §app.owner-page/conversations — Which conversations the owner reads

- **Client conversations, all of them, by default**: every gathering, offer and settle session of
  a shown project, other people's messages included. Staff are not told the owner reads them.
- **Hide from the owner**, per conversation: the baton strip's `Hide From {first name}` sets
  `hiddenFromOwner: true` on its `baton.json` row (`POST /api/baton/:sid/owner {hidden}`), and
  `Show To {first name}` clears it. A hidden conversation disappears everywhere on the page: its
  row, its decisions, its conflicts, its share of "Who we've talked to", every count and the
  project's status. Its handle answers 404, the same as a handle that never existed. No count of
  hidden things is ever shown.
- **Switch a project off**: the project page's `Show this project on {first name}'s page`
  (`projects.json` `ownerHidden`, shown by default; `PATCH /api/orgs/:id/projects/:pid
  {ownerHidden}`). A project switched off disappears from the page with everything in it, and its
  handle answers 404.
- **Never shown**: the project overseer's conversations (current and history), coding sessions
  (their titles and topic summaries too), and every other session of the operator's.
- **Handles.** Projects and conversations are addressed on the page by a handle (`q_` + 8
  characters for a project, `k_` + 8 for a conversation, lower-case letters and digits 2–9): an
  HMAC of the id under a random key the host keeps in `person-links.json`. Nothing is stored on the
  rows; a handle is stable on this host and means nothing elsewhere. A handle outside the token's
  org answers 404.

## §app.owner-page/updates — The project overseer's updates, posted at real milestones

- **Posted by the project overseer, on its own.** A tool, `sova_owner_update({text})`, at level
  L1 (§app.project-overseer/autonomy-levels), appends a post to `projects/<pid>/updates.jsonl` in
  the workspace repo: `{kind: "post", id: "u_…", at, by: {kind: "overseer", run: "auto" |
  "operator"}, text}`. Nothing waits for approval. With no owner set it refuses: there is no page
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
  demo address goes there: Sova hosts no demo sites). Like everything the model wrote, it passes
  the outsider redaction before it is shown.
- **Logged on the project page.** Every post, taken down or not, is listed on the project page's
  Owner Page card with its text, when, and whether the overseer posted it on its own or because
  the operator asked (`run`); every tool call, refused or not, is also in the overseer's `actions.jsonl`.
- **Taking one down.** The operator's `Take Down` (`POST /api/orgs/:id/projects/:pid/updates/:uid/
  withdraw`) appends `{kind: "withdraw", id, at}`: the post disappears from the owner page at its
  next read and stays in the file and on the project page's list, marked as taken down. The
  operator cannot write or edit a post.

## §app.owner-page/never — What the page never shows

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
  - conflict routing reasons, stakeholder history, Needs-you items, proposed people;
  - hidden conversations and switched-off projects, their counts included.
- A test plants a distinct marker in every one of those fields, checks each marker is present in
  the operator's own views (so its absence means something), then reads every owner-page answer
  and the shell and finds none of them.

## §app.owner-page/page — Phone first, read only

- One column at every width, at most 720px wide and centred; at 390px nothing scrolls sideways,
  every button and row is at least 44px tall, and lines wrap rather than being cut. It is part of
  the share build (`dist-share/`), using its styles; light and dark follow the device.
- **Read only.** The share listener has only GET routes for it: `GET /i/<token>` (the same page
  shell as `/h/`), `GET /api/i/<token>` (home), `GET /api/i/<token>/p/<q_handle>` and
  `GET /api/i/<token>/c/<k_handle>`. Any other `/i/` or `/api/i/` path, any other method, and a
  WebSocket on it answer 404. Nothing the owner does reaches a model.
- **Fresh.** The page reads again every 60 seconds while it is visible (paused while hidden, at
  once when shown again) and says when it last did.
- **Limits.** The listener's per-address limit applies, and per token at most 120 requests a
  minute (429).
- **Errors.** When a read fails for any reason but a dead link, the page says it couldn't load,
  that the link still works, and offers `Try Again`; what it showed before stays.

## §app.owner-page/controls — The operator's side

- **People tab: an Owner card**, above the roster (§app.organizations/org-page): what the owner
  can see, in one sentence; a select (None, then the org's active people by name); the latest
  change ("Set by you {time}." or, after a clearing, the person who left); the link's state (when
  it was made, when it expires, how many times it was opened, the expiry warned once under 14 days
  are left); `Get Owner Link` (with a confirm while a live one exists), `Preview Owner Page`, and
  `Turn Off Owner Link` set apart as destructive. A new link is shown once, with Copy Link, as on
  the baton strip.
- **Preview.** `Preview Owner Page` opens a modal that shows exactly what the owner sees, from the
  same function with no token (`GET /api/orgs/:id/owner/preview[?project=<q_handle>|?c=<k_handle>]`, main listener only); it
  records no visit and changes nothing. A test pins that the preview's data equals the token
  route's for the same org.
- **Project page: an Owner Page card** (only while the org has an owner): the `Show this project
  on {first name}'s page` switch and the updates log with `Take Down` (§app.owner-page/updates).
- **Baton strip**: `Hide From {first name}` / `Show To {first name}` on each conversation of an org
  with an owner, and a line while it is hidden (§app.owner-page/conversations).
- **Person page**: an `Owner` chip beside the owner's status, their owner link among their links
  (state, made, expires, Turn Off), and their visits to the owner page as "Opened the owner page"
  rows (§app.organizations/person-page).

## §app.owner-page/rejected — Considered and not done

- **Telling staff the owner can read their conversations** (rejected by the user): one more line
  on every share page, for a fact the operator already manages with Hide From.
- **An operator news editor or an approval step** (rejected by the user): the overseer posts on its
  own at real milestones; the server's limits and the About backstop hold what a human review
  would, and Take Down undoes a post.
- **Showing coding session titles or summaries**: they are written for the operator and name
  files, branches and tools; the counts and the updates say what was built.
- **Showing or summarising the overseer's conversation**: it is candid, technical, and its tool
  results carry roster data and the About text.
- **Writing from the page** (replying, asking): v1 reads only; the owner answers their own
  questions through the links they are sent. A later per-person inbox on the same `/i/` link may
  add it.
- **An owner per project, or a login**: one person per org with one personal link is what the
  user asked for.
- **Showing costs**: never on this page.
