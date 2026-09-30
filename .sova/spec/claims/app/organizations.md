# §app/organizations — Organizations, rosters and workspace repos
> Part of the Sova design spec · [overview](../design/overview.md)

An **organization** is a client (or the operator's own team) that Sova talks to through baton
sessions (§app/baton). It has a **roster** of people with terse profiles, a set of **projects**,
and a **workspace repo**: one plain git repo per organization that holds all of it. The operator
is not a roster person; the operator's display name is host-local.

Orgs open as a page, `#/orgs` (the list) and `#/orgs/<id>` (one org), with a back link to the
landing page like Usage and Agents. The entry point is the landing page's Organizations card, its
last section (§chat.transcript/landing-page): totals across every org, the most recently active
orgs as links, and a link to `#/orgs`, shown whether or not any org exists. The sidebar has no
navigation row for orgs; it lists their sessions in its Organizations region, each org's head linking
to its page (§app.session-list/organizations). `#/orgs` is
a grid of organization cards (§app.organizations/org-cards); an org's page has four tabs, each in
the URL (§app.organizations/org-page); each roster person has a page of their own,
`#/orgs/<id>/people/<pid>` (§app.organizations/person-page).

## §app.organizations/registry — Attached orgs and residence

- An org lives on exactly **one home host**. Each host keeps a local index,
  `<stateRoot>/orgs.json` (`{version:1, operator:{name}, orgs:[{id, dir, attachedAt}]}`), of the
  orgs **attached** to it; attached means resident here. It is never part of any workspace repo.
- **Create** (`POST /api/orgs {name, dir?}`) makes the workspace repo (`git init`) at `dir`, or at
  `<stateRoot>/workspaces/<slug>` by default, starts the org's chart with an empty roster
  (§app.project-overseer/org-charts), and makes the first commit. **Attach** (`POST /api/orgs/attach {dir}`) adds an existing workspace repo (a
  restored clone) to this host's index (§app.organizations/portability); a dir with no org's chart
  in it is refused (400, "No organization in that dir: not a workspace repo."). **Detach** removes it from
  the index and deletes nothing.
- A workspace dir must be absolute and must not lie inside Sova's own checkout unless that
  checkout git-ignores it (Sova's repo is public; the hermetic `.agent/` is ignored). An install
  that is not a git checkout (a copied or unpacked tree) has no ignore rules to ask: inside it only
  the default workspaces dir, `<stateRoot>/workspaces` and below, is allowed (never when that dir
  would be the install itself), so the default the New Organization form advertises works in
  either install and every other dir in the tree stays refused. A refused dir answers 400 and
  nothing is written.
- Moving an org is detach here, clone and attach there. One host holds an org at a time: the repo
  records which (§app.organizations/holder), and attaching an org another host holds warns and
  asks to confirm.
- **A broken org stays listed.** An attached org whose own chart snapshot can't be read is still
  in the org list and still opens (`GET /api/orgs/:id`): named by its id, with whatever else of it
  loads and its workspace problem, so the operator reaches the problem banner and its **Reload**
  (§app.organizations/org-page). Every org-level act on it (rename, About save and revert, owner,
  add project, add person, Commit Now), and an edit of a person whose own snapshot is broken, is
  refused (409) with the workspace sentence
  (§app.project-overseer/org-charts) until it loads.

## §app.organizations/holder — One holder at a time

- **The holder record** is kept in the org's own chart, whose snapshot is in the workspace repo's
  `charts/` (§app.project-overseer/org-charts); there is no `holder.json`. It names the host that
  holds the org, `{host:{id, name}, since}`, or, once released, `{host:null, releasedBy:{id,
  name}, at}`. A host's `id` is its own, made once and kept host-local in `<stateRoot>/host.json`
  (`h_` + 8 characters); `name` is the machine's hostname, shown in the warning, followed by the
  id in parentheses when it is this host's own name too (two installs on one machine).
- **Written by the holder.** Creating an org and attaching one write this host as the holder and
  commit at once (then push, when a remote is set), so a clone made after that names it.
  **Detach** writes the release, commits and pushes it (best effort: a failure is logged and the
  detach still happens), so moving an org (detach here, clone and attach there) never warns.
- **Held elsewhere.** Attach reads the record twice: in the clone, and on the clone's `origin`
  when it has one (`git fetch`, at most 15 seconds; the remote's copy of the checked-out branch).
  The org is held elsewhere when either names a host other than this one and not released; when
  the remote can't be reached, only the clone's record counts. Held elsewhere, attach adds nothing
  and answers 409 with `code: "held"`, the holder's name and since when, and the sentence: "{name}
  holds this organization (since {time}). If it still runs there, attaching it here too makes two
  copies that drift apart, and one host's work can't be pushed. Detach it on {name} first, or
  attach anyway if {name} is gone." The attach form shows it as a warn banner with **Attach
  Anyway** (`POST /api/orgs/attach {dir, confirm: true}`) and Cancel; confirmed, the attach goes
  ahead and this host becomes the holder.
- A record naming this host (a clone this host held) is not held elsewhere.

## §app.organizations/org-cards — The list: one card per organization

- `#/orgs` shows the attached orgs as a responsive grid (`ul.org-grid`) of cards, one per org, in
  the index's order: one column in a narrow pane, two from 640px of pane width, three from 1024px
  (container queries on the `insights` pane). The New Organization, Attach a Restored Repo and
  Your Name forms follow the grid, unchanged.
- **Each card** is a single link, the whole `.card.org-card` an `<a>` to `#/orgs/<id>`, with a
  focus ring. It reads, top to bottom: the org's name (`heading-s`); `{n} people · {n} projects ·
  {n} open hand-offs` (open = baton sessions not done or closed; archived projects are not counted,
  §app.organizations/archive); the Needs-you line, when
  anything waits; `Active {relative time}` (§chat/transcript's relative form, `src/lib/format.ts`),
  the exact stamp in its title.
- **Needs you.** When anything in the org waits on the operator the card carries a warn chip,
  `Needs you · {n}` (dot and word, never hue alone), a warn border, and a line naming each kind
  that waits: `{n} reply/replies · {n} link(s) to send · {n} person/people to approve · {n}
  stakeholder(s) to pick · {n} held act(s)`, zero kinds left out. It counts the same items the attention list raises (§app.baton/needs-you): baton
  sessions the operator holds and hasn't answered (state `needs-you`); open baton sessions whose
  holder, or an open offer's invitee, has no live link (the operator must send one); and roster
  people with status `proposed`, waiting for Approve or Decline — every proposed person, whether or
  not a session proposed them; and open decision conflicts the reconciler routed to the operator
  that no baton session asks about yet (`{n} conflict(s) to settle`; one with a session is already
  counted once, as that session's reply); and projects whose main stakeholder left
  (§app.organizations/stakeholder); and acts a project's chart holds before they reach a person or
  the code (§app.project-overseer/holds).
- **Last activity** is the newest of the org's creation and its newest transition-log row
  (§app.project-overseer/org-charts): a roster change, a baton session's start, hand-off, offer or
  close, a person's message, anything any of its charts took.
- **The server computes both** on `GET /api/orgs` only: each `OrgSummary` gains optional
  `needsYou: {replies, links, proposals, conflicts, stakeholders, held}` and `lastActivityAt` (ISO). Absent (an older server),
  the card shows no Needs-you highlight and no activity line. `shared/protocol.ts` is unchanged.
- **Zero orgs:** in place of the grid, one card: "Create your first organization", the line
  "Each organization keeps its roster, projects and hand-off sessions in its own git repo.", and a
  secondary `New Organization` button that focuses the New Organization form's Name field.

## §app.organizations/org-page — One org's page: four tabs

- Under the title, in this order: the workspace-problem banners and the new-links banner (they
  stay above the tabs whichever tab is open), then a tab strip (`.tabs`, `role="tablist"`), then
  the open tab's panel (`role="tabpanel"`). Each workspace problem is its own banner, "The
  workspace repo has a problem." with the problem as its body (its file path breaks anywhere, so it
  never widens the page); the last one carries a **Reload** button, which retries what didn't load
  (`POST /api/orgs/:id/reload`) and shows the page it answers: with no problem left the banners go
  and the toast says "Reloaded. Everything in the workspace loads now.", otherwise the rest stay
  and it says "Reloaded. {1 problem remains|n problems remain}: fix or restore it, then reload
  again."; a failed Reload shows in the page's error banner. The tabs:
  - **Sessions**: the hand-off sessions list, and the start form behind a `Start a Hand-off
    Session` button (closed by default; `Cancel` closes it; a started session closes it). Its
    project select leaves archived projects out. With no project yet (none that isn't archived) it
    says to add one on the Projects tab, linked.
  - **People**: the Owner card (§app.owner-page/controls), then the roster, proposed people
    included, then Recent Profile Changes under it. A
    person's head is their name and status chip, the role · language line under them, and the
    actions (Approve and Decline for a proposed person, Start a Session for an active one, Edit),
    each named with the person ("Approve Sam Okafor"); the actions wrap under the name as one
    group when the card is narrow, and a name never breaks to fit them. The name is a link to the
    person's page (§app.organizations/person-page). A person with a time zone or working hours
    has an "Hours" row among the card's facts (§app.organizations/working-hours). A proposed person's
    "Decides: … — approving {name} approves …" line shows only when they have decision areas.
    Under the role · language line, one line says when they last opened a link (§app.baton/visits): `Last opened
    {relative time}`, the exact stamp as its title, from their newest visit (link previews,
    scanners, scripts and turned-off-link attempts don't count); `Hasn't opened a link yet` when a
    link was ever minted for them on this host and no visit exists; no line otherwise. The card has
    no History disclosure: a person's history and its Revert buttons are on their page. A
    person's name in Recent Profile Changes links to their page too.
  - **Projects**: the About this organization card (§app.organizations/about), then the org's projects, each row one link to its project page (folder icon, name,
    folder path, the project's cost at API prices, a trailing chevron) under the org's total
    (§app.project-costs/org-rollup), and the Add Project form (`Project name`, `Folder`); with none,
    "No projects yet. A project is a folder that hand-off sessions and its overseer work in."
    Archived projects are not in that list: a collapsed **Archived Projects ({n})** disclosure
    under it (absent with none) lists them, each row the same link with the archive's age and
    **Unarchive** (§app.organizations/archive). With every project archived, the list's line reads
    "The 1 project here is archived. Unarchive one below, or add a project." (or "All {n} projects
    here are archived. …") instead of "No projects yet."
- **Rows and width.** A hand-off session row's title and meta line wrap rather than truncate. Each
  card on the org list, org and project pages stops at 880px wide, left-aligned. The project
  page's title, cut with an ellipsis when it doesn't fit, carries the whole project name as its
  tooltip (`title`).
  - **Workspace**: the workspace repo card: how often changes are committed ("Changes are
    committed hourly[ and pushed to the remote], when there are any. Commit Now does it at once."),
    the last commit (relative time with the exact stamp as its title, short sha, message) and
    "· uncommitted changes" while the repo has any, Commit Now, and the push remote. Commit Now
    says what it did: "Committed {short sha} and pushed.", "Committed {short sha}.", "Nothing new
    to commit. Pushed the commits the remote lacked." or "Nothing new to commit."
- **Counts.** Each tab's label is followed by a count: Sessions, every baton session of the org;
  People, every roster person (active, proposed and left); Projects, the projects not archived. Workspace shows
  no count: it holds one repo, not a list.
- **Needs-you dot.** A tab carries a warn dot, with its words as hidden text and as the tab's
  title, when something in it waits on the operator, by the same definitions as the card
  (§app.organizations/org-cards): Sessions — sessions the operator holds unanswered (`{n} to
  answer`) and sessions with a link to send (`{n} link(s) to send`); People — proposed people
  (`{n} to approve`); Projects — open conflicts routed to the operator with no session
  (`{n} conflict(s) to settle`) and held acts (`{n} held act(s)`); Workspace — file problems in the repo and a failed last commit
  or push. A session row with a link to send shows a `Link to send` warn chip in place of `Open`.
- **In the URL.** `#/orgs/<id>/sessions`, `/people`, `/projects`, `/workspace`; the bare
  `#/orgs/<id>` is Sessions. `#/orgs/<id>/start/<person>` opens Sessions with the start form open
  and that person ticked — on load, and whenever the hash changes to it while the page shows.
  Closing the form (Cancel, or a session started) replaces the hash with `#/orgs/<id>/sessions`,
  so a reload doesn't reopen it, and every link afterwards (a session row, the sidebar) still
  opens its page. Picking a tab replaces the hash (no history entry per tab), and the page
  is not reloaded: the fetched org stays. `#/orgs/<id>/projects/<project>` stays the project page,
  and its back link opens the Projects tab; `#/orgs/<id>/people/<pid>` is a person's page, and its
  back link opens the People tab; the project page, its overseer and a person's page are untabbed.
- **Keyboard.** The selected tab is the strip's one tab stop; Left/Right move focus along the
  strip (wrapping), Home/End jump, Enter or Space selects. Selecting keeps focus on the tab at
  every width: the phone's move-focus-to-the-title on a route change happens only when the page
  changes (another org, the list, a project page or a person's page), never for a tab or a start
  link.
- **Width.** Under 480px of pane width the tabs tighten (`--space-1` padding and gap), so the four
  fit a 420px window with two-digit counts; narrower, the strip scrolls sideways and the selected
  tab is scrolled into view whole. A section's heading (on an org, project or person page) keeps
  its whole word: when it and its buttons don't fit one line, the buttons wrap below it rather
  than cutting it off.
- **Live.** The page re-reads its org every 10 seconds while the browser tab shows (paused while
  hidden, at once when shown again), so a session that finishes, closes or changes hands
  elsewhere updates its row (`With <holder>`, the state chip) without a reload; each read is
  reconciled in place, so an open form keeps what was typed. Saving a person's Edit form (on a
  People card or their page) sends only the fields changed in the form, so what someone else
  changed meanwhile (a wrap-up, another tab) is kept; with nothing changed it closes and sends
  nothing. A row's "started …" age moves on
  every 30 seconds.
- **Where the data comes from.** Every route that answers an `OrgDetail` adds `needsYou`, each
  baton row's `waiting` (`"reply"` or `"link"`), `projectConflicts` (`{projectId: n}`) and
  `lastOpened` (`{personId: {at?, minted}}`, the People card's line), all optional on the wire;
  without `lastOpened` the card shows no such line.

## §app.organizations/person-page — One person's page

- `#/orgs/<id>/people/<pid>` is one roster person's page, active, proposed or left: an untabbed
  page like the project page. Its back arrow (named `People`, shown where the app shows one: at
  folded width) opens `#/orgs/<id>/people`, and so does the meta line's `People` (the one way back from
  unfolded width, where there is no back arrow; on a phone a long org name may clip it). A person id
  the org doesn't have answers 404, and the page says "This organization has no person with that
  id." with the back link. It is reached from the name on their People card, from their name in
  Recent Profile Changes, and by URL. Each card on it stops at 880px wide, left-aligned, like the
  org and project pages.
- **Head.** Their name is the page's one title (the page head's `h1`, as on the project page),
  with their status chip beside it (`Active`, `Proposed`, `Left`: dot and word; the name alone is
  the heading's accessible name) and, for the org's owner, an `Owner` chip (§app.owner-page/controls), and the meta line `Organizations · {org name} · People`, each a
  link (the list, the org page, its People tab). The first card holds the role · language line. Then the same actions as
  their People card, each named with the person: Approve and Decline (proposed), Start a Session
  (active; it opens the org's start form aimed at them), Edit (the card's form, in place).
  - **Left**: an info banner, "{name} left the organization {when}. Their links no longer open,
    and nothing they send is accepted." — `{when}` from the history line that set `left` ("on Mar
    4", "2d ago"), "left the organization." with no date when none records it.
  - **Proposed**: an info banner with the referral, "{referrer} proposed {name} {when} in
    {session title}: {why}", and, when they have decision areas, the card's "Decides: … —
    approving {name} approves …" line.
- **Profile.** In that first card, the People card's facts: Decides (then, when they are one, "Main
  stakeholder of {project}, {project}", each a link to its project page), Skills, Competence (per skill, `level {n} of 5 · {n}
  sessions`), Voice, Hours (their time zone and working hours, and whether they are in hours now:
  §app.organizations/working-hours), Contact, Referred. Contact shows here and on the card, nowhere else
  (§app.organizations/privacy).
- **Sessions** (`Sessions · {n}`; card headings are Title Case, like the org page's `Recent
  Profile Changes`), newest activity first: every baton session of the org, in any
  project, where they are or were the holder, a hand-off's target or source, an offer's invitee, a
  participant, the person who referred someone in it or was referred from it, or the addressee of
  a conflict it asks about. Coding sessions and the operator's other sessions are not listed, even
  when they mention the person. A row reads:
  - the public title, a link to the session (`#/s/<path>`), the project name, and the session's
    state chip (the org page's words: `Open`, `Needs you`, `Done`, `Closed`);
  - where the baton is: `Holds it now` (theirs), `With {holder}`, `With you` (the operator),
    `Open to them and {n} others` (an offer that includes them, nobody holding it), `Open to {n}
    people` (an open offer without them), or nothing once done or closed;
  - each way they relate to it, in order of hand-off number: `Started with them`, `Handed to them
    by {from} · #{n}`, `Passed on to {to} · #{n}`, `Offered to them with {n} others · #{n}`,
    `Took the offer · #{n}`, `Their lease lapsed · #{n}`, `Referred here by {name}`, `Proposed
    {name} here`, `Asked to settle {area}`, and `Took part` for a participant with none of those
    ({from}/{to} are names, `you` for the operator; an offer passed on names its invitees, "Ana
    and Ben"). An invitee who never held the offer reads `Offered to them …` only;
  - `{n} messages · last wrote {relative time}` (from the transcript's sent markers; `0 messages`
    when they never wrote), and `Started from {parent title}` (a link) when the row has a parent;
  - `Preview as {first name}` (below), on a session they were addressed in — they held it, were
    handed or offered it, or wrote in it; a session they relate to only as referrer, referred or
    conflict addressee has no link of theirs to preview, and no button.
  - With none: "{name} is on the roster, with 0 hand-off sessions so far." and, for an active
    person, `Start a Session with {name}`; for someone who left, "{name} took part in 0 hand-off
    sessions before leaving."
- **Decisions** (`Decisions · {n}`), newest first, across every project: each decision whose `by`
  is them — its area, the statement, their quote as a block quote, `{relative time} · in {session
  title} · {project}` (links to the session and the project page), and its state chip in the
  project page's words (`Pending`, `Drafted`, `Conflict`, `Promoted`, `Superseded`). A decision
  outside their decision areas adds `outside their decision areas`. Then the open conflicts the
  reconciler routed to them, under `Conflicts routed to {first name}`: `Asked to settle {area}`, with its session when one asks about it.
  With neither: "{name} has recorded 0 decisions so far."
- **Links and visits** (`Links and Visits`).
  - A summary line first: `Opened {n} times · last {relative time}` (`Opened once · …` for 1);
    `Hasn't opened a link yet.` when a link was ever minted for them on this host and there is no
    visit; nothing when neither.
  - **Their links on this host**, newest first: the session's public title, `hand-off #{n}`, the
    link's state word (`Can write`, `Reads only`, `Turned off`, `Expired`, `Session closed`; the
    words of §app.baton/links' writes/reads/410; a closed session's link reads `Session closed`,
    though closing also turned it off), `sent {relative time}`, `expires {relative
    time}` while it can still open, and `{n} visits`: a visit counts on the newest of this host's
    links for its session, hand-off (and offer) and person that was made at or before the visit,
    so a new link for the same hand-off never takes an older visit. A link that can still open has `Turn Off
    Link` (that one link; the session and every other link stay as they are). The row for the
    hand-off they hold now, or an open offer they are invited to, has `Get New Link`: the strip's
    Get Link (`GET /api/baton/:sid/link`, `?person=` for an offer), shown once with Copy Link.
    With 2 or more links that can open, the section has `Turn Off All {n} Links` (a destructive
    button, apart from the others), confirmed with "{name}'s {n} links stop opening at once.
    Their sessions, messages and visits stay." With no link: "No links for {name} on this host."
    and, when their visits name links minted elsewhere, "Links sent from another host don't open
    here."
  - **Owner links** (for the org's owner, §app.owner-page/link), newest first, under their own
    heading after their links: `The owner page`, its state (`Can read`, `Turned off`, `Expired`),
    `sent {relative time}`, `expires {relative time}` while it can open, `{n} visits`, and on the
    live one `Turn Off Owner Link`. `Turn Off All` never touches them.
  - **Sent on WhatsApp** (§app.outreach/log), after the owner links, when they were sent anything:
    one row per send, newest first: what went (the gathering's public title, "A preview" or "A
    message"), the latest event as a chip (Sent, Delivered, Read, Failed, Unknown, Not sent), when,
    and a failure's code.
  - **Visits**, newest first, one row per visit (§app.baton/visits): `Opened {session title}`
    (`Opened the owner page` for a visit through an owner link),
    the device family, `for about {duration}` once it lasted a minute or more, and the relative
    time, the exact stamp in mono as its title (`2026-09-27 14:06`); a visit whose newest record
    is from a link minted on another host (no link of this host for its hand-off was made at or
    before it) adds `link from another host`. Rows never counted as
    opened: `Tried a turned-off link · {session title}`, and, muted, `Link preview by {service} ·
    {session title}` (`Link preview · {session title}` for a generic unfurler), `{Security scanner
    | Script} · {session title}` (a `bot` visit, its device family), and `Too many visits on this
    link today; we stopped recording until tomorrow`. The first 20 show; `Show All {n} Visits` shows
    the rest. With none and no link: "Nothing yet: visits show here once {name} opens a link.", or, for
    someone who left, "{name} opened no links before leaving."
- **Preview as {first name}** (a session row's button) opens a modal — a sheet at folded width —
  titled `{session title}, as {first name} sees it`, showing exactly what the share page shows
  them for that session now (the same server-side filter, §app.baton/outsider-view: an invitee
  who never held an offer sees up to its card), with no composer. It needs no link and uses no
  token, records no visit, claims nothing and changes nothing. One line under the title says:
  "Read-only. Nothing you do here reaches {first name}, and no visit is recorded." When no link of
  theirs could open the session now (they left, it's closed, or they were never given one), it
  adds "{first name}'s links don't open this session now." `Close` closes it.
- **Profile changes** (`Profile Changes`): the person's history, newest first — field, old → new,
  who changed it (`you`, `you, via the Overseer` for a change the global Overseer made for the
  operator, §app.overseer/org-attribution, `wrap-up`, `referral`, `overseer` for the project's
  overseer) and the quote, `a revert`, when —
  each with `Revert` (§app.organizations/history-and-revert). With none: "No changes since
  {name} was added."
- **Live.** The page re-reads every 10 seconds while the browser tab shows (paused while hidden,
  at once when shown again), reconciled in place so an open form, an open modal and `Show All`
  keep their state; ages move on every 60 seconds. A person who leaves, is approved or declined
  elsewhere updates head, banner and actions without a reload. Focus moves to the title only when
  the page changes (another person, or from the org page), never on a re-read.
- **Width.** Under 768px of pane width (folded) every row stacks: meta lines wrap and never
  truncate, the actions wrap under the name as one group, a visit row is a list row (never a
  table), and every control is at least 44px tall; the page fits a 390px window without
  sideways scrolling.
- **Where the data comes from.** `GET /api/orgs/:id/people/:pid` answers the page (`PersonPage`
  in `shared/orgs.ts`): the person, the org's id and name, sessions with their relations,
  decisions, routed conflicts, this host's links with their states, the visit rows (every
  one, newest first), how many of them are openings and the newest one's time, and the history. `POST /api/orgs/:id/people/:pid/links/revoke
  {sessionId?, n?}` turns off one link (both given) or every link of theirs (neither) and answers
  the page. `GET /api/orgs/:id/people/:pid/preview?session=<sid>` answers the preview's view,
  plus `linkOpens` (whether a link of theirs on this host opens that session now, which the
  "links don't open this session now" line reads); its viewer can never write. None
  of them is reachable on the share listener.

## §app.organizations/workspace-repo — What the workspace repo holds, and what it never holds

- It is the org's **whole portable state** (§app.organizations/portability). Files:
  - `charts/`: the snapshot of every portable chart session of the org, and the transition log
    `charts/log/<yyyy-mm>.jsonl` (§app.project-overseer/org-charts). They hold the org (id, name,
    slug, its owner with its history, §app.owner-page/owner, and the holder record,
    §app.organizations/holder), every person and their profile, every project and its settings
    kept in the chart (root, archived, main stakeholder, hidden from the owner, frozen), every
    gathering session (holder, participants, hand-offs, offers and their leases, message budget,
    model, wrap-up state, abilities, whether it is hidden from the org's owner,
    §app.owner-page/conversations, when someone it was sent to first wrote, and for a settle session
    the conflict it settles), every decision and conflict with what the reconciler decided, each
    project's last reconcile run and last promotion, each gap's item, and every coding session the
    project started with its worktree's branch — never a link;
  - `roster-history.jsonl`: the roster's per-field history (§app.organizations/history-and-revert);
  - `about.md` and `org-history.jsonl`: the org's About text and its history (§app.organizations/about);
  - `sessions/*.jsonl`: every baton session transcript and every project overseer conversation
    (current and history), written there directly by pi (`SessionManager.create(cwd, sessionDir)`);
  - per project, `projects/<projectId>/`: `updates.jsonl` (the updates the overseer posted to
    the owner page, and the ones taken down, §app.owner-page/updates), `costs.json` (each session's
    title and token counts as last counted, by model, time and token kind, §app.project-costs/ledger),
    `usage.jsonl` (the reconciler's decide calls' usage, §app.project-costs/recording), and the
    overseer's `overseer/` — `overseer.json` (autonomy, models, the coding sessions' mode, caps,
    watch, extra instructions), `notes.md`, `ideas/` and `todos.json`;
  - `visits.jsonl`, the visit log: each time a roster person opened one of their links, and each
    link preview and turned-off-link attempt (§app.baton/visits) — never a token, a token's hash,
    an IP address or a raw user agent;
  - `outreach.jsonl`, the send log (§app.outreach/log): each link sent to a person outside Sova and
    its receipts — never a number, a token, a link, a message id or the message.
  JSONL files are only ever appended to. A `.gitignore` excludes temp files (`*.tmp`, `*.lock`).
- Sova opens those transcripts like any session: a `.jsonl` directly inside an attached
  org's `sessions/` is accepted wherever a session path is (nothing nested, nothing else in the
  repo), and the session list reads those dirs beside the sessions dir. The sidebar lists them only
  in its Organizations region (§app.organizations/org-sessions).
- **Never in the repo**: link tokens and their hashes (host-local, `<stateRoot>/baton-links.json`
  and, for owner links, `<stateRoot>/person-links.json`, both mode 0600; links are minted again after a restore), credentials and auth, and Sova's own
  settings (Settings → Decisions, new-session defaults, the model policy).
- **Host-local, by design** — a restore starts these fresh or derives them again: this host's
  attach index `<stateRoot>/orgs.json` (where each repo lives here); the host-local charts under
  `<stateRoot>/org-charts/<org>/` (§app.project-overseer/org-charts): this host's hold on the org
  and its commits, and each project overseer's watch loop — the pause an attach set, its
  allowances used, reasons waiting, held items, last run and runs per day — which rate-limit what
  runs on this host; the share listener's rate limits and the live share pages (memory); and what the session list keeps about any session — listing title, web origin, seen
  marks, archive and tags, the write guard's stats — which an attach derives again for the org's
  sessions. A project's own spec (`.sova/spec` under the project root, drafts local) is the
  project repo's, not the workspace's.
- **Commits.** Creating an org makes the first commit. After that a committer looks at every
  attached org's repo each minute and commits whatever changed once at least an hour has passed
  since the repo's last commit (counted from HEAD, so Commit Now, a restart or a commit made on
  another host all count; `SOVA_WORKSPACE_COMMIT_MS` shortens the hour for tests only). Nothing
  changed: no commit. The message names what changed by top-level entry ("Workspace changes:
  charts/ (3 files), sessions/ (2 files)"), never contents. Every commit Sova makes in the repo is
  authored and committed as `Sova <sova@localhost>`, whatever git identity the host has, so no
  operator's name or email travels with a backup. **Commit Now** (`POST /api/orgs/:id/commit`)
  commits at once. A graceful shutdown (SIGINT or SIGTERM) stops every running turn first, then
  commits every repo with changes, due or not, after the runtimes are disposed; the process exits
  within 20 s whatever a step is waiting on. Commits of one repo run one at a time; a failed commit or
  push is logged and shown as the org's last git error, and never undoes the write that caused it.
- **Push**: after each commit, to the repo's configured remote (`PUT /api/orgs/:id/remote {url}`,
  stored as the repo's own `origin`; an empty url removes it); a push that failed is tried again at
  the next due look, even with nothing new to commit. Commit Now with nothing new still pushes the
  commits the remote doesn't have yet (a just-set remote gets the history); nothing to push is a
  no-op with no network call. No remote means local commits only.
  Profiles are personal data: the page says the remote must be private. Sova never creates a
  remote.
- **Restore** = clone the repo onto a host and attach it (§app.organizations/portability).

## §app.organizations/portability — Clone and attach: the whole organization on another host

- Cloning an org's workspace repo onto any Sova host and attaching it ("Attach a Restored Repo",
  `POST /api/orgs/attach {dir}`) brings the whole organization: the org, its roster with every
  history line, its projects, every baton session with its transcript, holder, hand-offs, offers
  and wrap-up state, the decisions and conflicts, every recorded visit (§app.baton/visits), and each
  project overseer with its conversations, settings, notes, actions, ideas, to-dos and the
  sessions it started. Nothing is read from the old host.
- **Links must be re-issued.** No link is in the repo, so every old link answers 404 on the new
  host; the operator sends new ones (Get Link, or Needs you's "Send <name> their link"), the owner
  link included (the owner itself travels, in the org's chart). The attach form says so. A person's page lists no links until new ones are sent; their old visits still
  show, marked `link from another host`, and new visits append to the same log.
- **Project overseers start paused at L0.** The attach pauses every project of the org in its
  host-local watch chart (§app.project-overseer/org-charts). While paused, the level in force is L0 ("Paused at L0: this organization
  was attached on this host. Set its level to resume."), the watch loop starts nothing for it (its
  reasons wait), its chat head shows the warn chip "L0 in force" and the reason with **Resume at
  {level}** (§app.project-overseer/page), and the project page shows a warn banner "Paused
  at L0 on this host" with a **Resume at {level}** button. Setting its level on this host
  (`PATCH …/overseer {autonomy}`, any level, the one it had included) ends the pause; no other
  setting does. An org created on this host, and a project added after the attach, are not paused;
  detaching and attaching again pauses again.
- **This host's view is derived again.** For each baton session the attach sets its listing title
  to the public title, and for each overseer conversation "Overseer · <project>" (a title the
  operator already gave one here stays); marks them as web sessions; and records their files'
  current stat as this server's write, so the operator's composer is not refused as recently
  written by someone else right after the clone wrote them.
- **Working directories come from this host.** A session file's header keeps the cwd of the host
  that created it; the header is never rewritten. A baton session opens in the org's workspace dir
  here, and a project overseer in its project's root as the project's chart says now (after a move,
  the operator edits the project's folder).
- The coding sessions an overseer started are ordinary sessions on the host that ran them: on
  another host they are listed "(not on this host)", and the project's cost counts what they had
  spent when last counted (§app.project-costs/ledger).
- A conflict's settle session is found by its id on this host; the conflict's chart stores no path
  for it, so its card opens the session here after a move.
- Attaching an org another host holds warns and asks to confirm first (§app.organizations/holder).

## §app.organizations/org-sessions — Which sessions are organizational

A session is **organizational** when an org's own records make it one — never by its folder. The
session list marks it with `SessionSummary.org` (`{ orgId, orgName, projectId?, projectName?, kind,
finished? }`, `kind` one of `gathering`, `offer`, `overseer`, `coding`, `other` — an unregistered
workspace file), and the sidebar lists it only
in the Organizations region (§app.session-list/organizations). The list's flag and the org's own records
apply the same rule, as the Overseer's flag does (§app.overseer/identity-and-clear).

- **Every file in an attached org's workspace `sessions/`** — a hand-off or gathering session, an
  offer, the project overseer's current and cleared conversations, and any unregistered file there.
  The path decides (its parent is `<attached org dir>/sessions`); the gathering session's chart and
  the project's chart (its overseer's conversations) give the project, the kind and `finished`.
- **Coding sessions the org's project started**: a session that is a coding session's chart
  (§app.project-overseer/org-charts) of some attached org's project, of kind `coding` (the project
  overseer's `sova_create_session`, or one its chart started, §app.project-overseer/drive) or
  `operator-coding` (**Start Coding Session** or **New Coding Session** on the project page).
  The overseer's concurrency caps still count `coding` rows only.
- **`kind`**: a baton that has had an offer is an `offer`, any other baton a `gathering`; a file with
  THAT org's project-overseer marker is an `overseer` conversation, even one the project's chart no
  longer lists (pushed past the history cap); anything else in the workspace is `other`, with no project.
- **`finished`**: a hand-off `done` or `closed`; an overseer conversation that isn't the current one
  (the sidebar lists such a conversation nowhere: its overseer's History opens it,
  §app.project-overseer/page); or a coding session whose worktree branch is **merged** into its
  target per git (the same answer as the project page's, §app.project-overseer/coding-worktrees:
  git's while the branch exists and can be read, else the recorded merge or the branch's removal).
  The listing reads git for it at most every 30 s per session, in the background: until git has
  answered once it says what the coding session's chart recorded, and a Merge Branch updates it at
  once.
- **What the list says of a baton session**, beside its holder and state (`SessionSummary.baton`,
  shared/baton.ts): `written` once someone it was sent to has sent a message (the operator, for one
  sent to the operator), from the chart's `wroteAt`; `opened` once a person (not a link
  previewer or a scanner) opened one of its links, from the visit log (§app.baton/visits); and
  `settle: { area }` for a **settle session**, one started to settle a conflict
  (§app.requirements/routing), with the conflict's area.
- Names come from the org's and the project's charts.

**Not organizational**, and listed as today:
- sessions the operator opens by hand in a project folder — a project root may be their everyday repo;
- sessions the main Overseer starts in a project folder with `sova_create_session`. A coding
  session it starts as the project's (`sova_project_overseer` `code`,
  §app.overseer/org-project-overseers) is an `operator-coding` row, and a gathering session it
  starts lives in the workspace: both are organizational, as above;
- forks and copies of an org session, which live in the sessions dir (a copy or a fork is an ordinary
  session, §app.project-overseer/identity);
- coding sessions **Start coding session** made before `operator-coding` rows existed (no backfill: an
  item can link any session, so a link doesn't prove the org started it), and any a project retired
  from its list of sessions it started once it passed 200 (§app.project-overseer/coding-worktrees);
- every session of an org that isn't attached on this host (detached or moved).

**The digest keeps them.** The attention digest (§app.overseer/attention-digest) still lists an org
session's items, and each carries the same org and project names (`AttentionItem.org`), so the
Overseer's badge, briefs and `sova_attention` still count them while the sidebar lists them in the
Organizations region's own Needs you, never the global one.

**Groups refuse them.** `POST /api/session-groups/assign` answers 400 for an org session with
"Organization sessions stay with their project."; an assignment made before is kept but not drawn.

## §app.organizations/roster — People and their profiles

- A person has `id` (`p_` + 8 characters), `name`, `status` (`active`, `proposed` or `left`),
  `contact` (`email`, `phone`, `whatsapp`, `other`; any subset), `role`, `decides` (decision areas),
  `skills`, `competence` (per skill: level 1–5 and the number of sessions observed), `language`
  (BCP-47), `voice` (how to talk to them), and, optionally, `tz` (an IANA time zone) and `hours`
  (the days and the from–to window they work, in that zone; §app.organizations/working-hours). The active people's `decides` entries are the owner
  areas a recorded decision picks from (§app.requirements/owner-area).
- The Edit form (on the People card and the person's page) has a "Working hours" group for the time
  zone and hours (§app.organizations/working-hours).
- Caps: `name` ≤ 80, `role` and `voice` ≤ 300 characters; `decides` and `skills` ≤ 12 items of
  ≤ 40 characters each. Over a cap is refused (400), never cut. A `decides` entry with no letter
  (`*`, `-`, `2024`: area keys keep letters only) names no area and is refused: "“{entry}” names no decision area: use words, like
  “website”." (it would otherwise mean the area `general`).
- **A proposed person must carry referral details**: a name, at least one contact channel, a role,
  why they were referred, and who referred them (`referral: {why, referredBy}`). A proposed person
  missing any of them is refused, on create and on every later change. Proposed people are not
  offered as hand-off targets until the operator makes them active.
- Only active people are offered when starting or handing a baton session.
- A person the operator declined keeps `status: left` and their referral, so the roster remembers
  who was turned down and why; `hand_to` them is refused with that reason.
- **Someone leaves** (their status becomes `left`, by an edit or a revert): every link of theirs
  answers 410 at once — they no longer read the organization's conversations either — and no
  message of theirs is accepted. A baton session they hold goes to the operator (a hand-off from
  them with the question "(left the organization)", so Needs you reads "<name> → you: (left the
  organization)"), stopping a reply in flight — at the message limit too: a holder who leaves
  there shows "(left the organization)", not the limit question, and the strip still offers
  Extend (§app.baton/goal-and-loadout); an open offer whose pool includes them is withdrawn
  to the operator ("(<name> left the organization; offer withdrawn)"). An offer someone else holds
  carries on; if its lease lapses they can't claim it, and no new link is minted for them. When they
  are the org's owner, the owner is cleared and their owner link stops working
  (§app.owner-page/owner).

## §app.organizations/working-hours — Nothing reaches a person outside their hours on its own

- **Their hours.** A roster person may have a time zone (`tz`, an IANA name like
  `Asia/Dubai`) and working hours (`hours`: the days of the week and a from–to time in that zone; a
  window may run past midnight). They are set on the person's Edit form, like any profile field,
  and each change is a roster history line, revertible (§app.organizations/history-and-revert),
  where an hours change reads as the Hours row does ("Mon–Fri 09:00–17:00", overnight noted, "—"
  when cleared) and a zone change as the zone;
  they are not private: they are no contact detail. Only the operator writes them. The person's
  page and the org's reads say whether they are in hours now and, if not, when their next window
  opens (`hoursNow`, worked out on each read, never stored). With no hours set, the person is always in
  hours, as before.
- **Company hours, the default.** The org may have a time zone and working hours of its own, in
  the same shape; they are not private. A person with no hours of their own uses the company's;
  their own win when set; with neither, they are always in hours. Only the operator sets them, on
  the org page's Projects tab in a "Company hours" card below About, with the hint "The default
  for anyone without working hours of their own; theirs win when set. What Sova starts on its own,
  and what the overseer does unattended, waits for them. Yours go at once." The card shows them as
  the Hours row does ("Mon–Fri 09:00–17:00 · Europe/Istanbul", "{zone} · no hours set"), or "None
  set: anyone without hours of their own is always in hours."; Edit opens Time zone, a "Set
  company hours" toggle, the days and From/To ("In the company's time zone. An end before the
  start runs overnight."; "Turn them off to clear them."), Cancel and Save, which says "Saved.
  Anyone without hours of their own works these." or "Saved. Nobody works company hours now."; a
  bad zone is refused with the person form's sentence (`PUT /api/orgs/:id/hours {tz?, hours?}`;
  null or "" clears; anyone but the operator is refused, 403, "Only the operator sets the company's
  working hours."). Each change is logged in the org's history
  as About changes are (§app.organizations/about), shown read-only under History ({n}) ("Time zone:
  — → Europe/Istanbul · 40m ago · by you", "· by you, via the Overseer"; "Hours: {from} →
  {to}"), each with **Revert**, which sets that field back as a new change, as a person's revert
  does (§app.organizations/history-and-revert; `POST /api/orgs/:id/hours/revert {at}`): one whose
  field has changed since is refused and changes nothing ("The company's time zone has changed
  since then, so reverting this would undo a later change. Revert the latest change instead.",
  "working hours have" for hours), and a revert moves the waits on the hours like any hours edit. The button is
  disabled, its reason as its title, when the field changed since (the server's refusal sentence
  above) or already holds that value ("The time zone is already this." / "The
  hours are already these."); pressing it says "Reverted." or the server's refusal, and the
  revert's own line reads "Reverted. Time zone: {from} → {to}". A person working company hours has "(company hours)" after the hours on
  their Hours row ("Mon–Fri 09:00–17:00 (company hours) · Europe/Istanbul · open now") on the
  People card and their page, and their off-hours note uses the company's zone for their clock;
  the person form's hours hint adds "Leave them off to use the company's hours ({line})." when
  the company has hours. A person's own hours count only with both a valid zone and valid hours;
  with Set working hours on and no time zone, the form says "Without a time zone these don't
  count: the company's hours apply ({company line})." or, when the company has no zone and hours,
  "Without a time zone these don't count: they are always in hours." Everything below reads these
  effective hours. They limit only what reaches a person: the overseer's looks and held acts that
  reach nobody are not held to them, and the operator's own clicks go at once, with the off-hours
  note. A change to someone's working hours (their own, the company's, or a revert of either) moves
  every act waiting for their hours (a held act waiting for them, an offer waiting to reach them)
  to their new window, or at once when they are in hours now; the act is checked against the
  hours in force when it goes.
- **The next window** is worked out by the person's chart from their effective zone and hours,
  whatever the host's own zone, across daylight-saving changes (a skipped or repeated hour
  included).
- **What waits.** An act that reaches the person — a message to them, an offer to them (for
  several invitees, see below), a new gathering session with them, a hand-off to them, a conflict re-routed to them —
  checks their hours first. Outside them, an act that a chart starts on its own or the overseer
  makes in a run the operator did not start waits on a chart timer until their next window opens:
  an act-tier Needs-you item (`held-act`, no phone notification; the digest's text "{what} waits
  for {person}'s working hours: it starts in {n} min unless you cancel it."), which the
  Organizations region and the Pipeline show as "{what} waits for {person}'s working hours: it
  starts at {send time} your time ({in how long}) unless you cancel it." ("their working hours"
  when {what} already names the person; the send time on the operator's clock: "18:30" today, "Thu 09:00" within six days, else "Oct 12 09:00"),
  listed in the overseer's looks, and cancellable like a hold (§app.project-overseer/holds); the
  same guards are checked again when it goes. Such an offer to several people opens when the
  first invitee's window opens, and reaches each invitee only inside their own window
  (§app.baton/offers-and-leases); someone without hours is always in hours.
- **On the Edit form**, a group "Working hours" with the hint "What Sova starts on its own, and what
  the overseer does unattended, waits for their hours. Yours go at once.": "Time zone" (suggestions
  from the browser's zone list), a toggle "Set working hours", then the days Mon…Sun (Mon–Fri by
  default) and "From"/"To" (09:00–17:00 by default), "In their time zone. An end before the start
  runs overnight." It refuses, before sending: "\"{zone}\" isn't a time zone this browser knows. Use
  an IANA name, like Europe/Istanbul.", "Pick at least one working day, or turn working hours off.",
  "Working hours need a start and an end." It sends only a changed zone or hours; turning hours off
  clears them.
- **Shown** on the People card and the person's page as an "Hours" fact: "{days} {from}–{to}
  (overnight when it is) · {zone} · open now", or "· opens {when} your time (in {how long})"; a zone
  with no hours reads "{zone} · no hours set"; with neither, no row. Days read "Mon–Fri", "Mon, Wed,
  Fri", "Fri–Mon", "Every day".
- **The operator's own click sends at once**, and so does the overseer's act in a turn the operator
  started. Starting a hand-off session, Send to person… and the baton strip's Hand On say so first,
  in warn, under whom they go to, once per person outside their hours: "Outside {name}'s working hours ({their time} for
  them). It goes now; their hours start {when} your time (in {how long})." (with no zone known,
  without the clock). Once it has gone, its done line adds "{name}'s working hours start {when}
  your time (in {how long})." (after "Handed to {name}.", "Hand-off session started." — a second
  toast when a hand-off session starts — or "Sent. A hand-off session asks them to settle it." for
  a routed conflict).

## §app.organizations/history-and-revert — Per-field history

- Every profile write appends one line per changed field to `roster-history.jsonl` —
  `{at, personId, field, from, to, by:{kind, sessionId?, entryId?, quote?, via?, overseerId?},
  revertOf?}`, plus an internal `key` that makes the write happen once, never shown — in the same
  step as the person's chart takes the change
  (§app.project-overseer/org-charts). Creating a person is one line per set field,
  from `null`. `via: "overseer"` (with the Overseer's id) marks an operator change the global
  Overseer made for the operator (§app.overseer/org-attribution); a request without the server's
  sender secret never records it.
- **Revert** (`POST /api/orgs/:id/people/:pid/revert {at}`) writes a new change that sets the field
  back to that line's `from`, with `revertOf` naming the reverted line. History is never edited.
  It undoes that change only: when the field no longer holds that line's `to` (it was changed again
  since), the revert is refused (409, "{name}'s {field} has changed since then, so reverting this
  would undo a later change. Revert the latest change instead.") and changes nothing. About's
  revert keeps its own rules (§app.organizations/about). A status
  revert is the same move as a status edit, with everything that follows it (a revert that sets
  `left` runs the whole leaving, §app.organizations/roster).
- A person's page (§app.organizations/person-page) shows their history, newest first — field,
  old → new value, who changed it (`you, via the Overseer` for a `via` line; and the quote when
  there is one), when — with a Revert button. Recent Profile Changes names the writer the same way.
- **Recent profile changes**: the org's history across people, newest first, with each person's
  current name (`GET /api/orgs/:id/changes?limit=`; the org detail carries the last 20), each with
  one-click Revert — where the wrap-up's autonomous changes are seen and undone.

## §app.organizations/field-authority — Who may write which field

- Enforced on the server for every change, whatever asked for it:
  - `operator`: every field; so does a change the global Overseer makes for the operator, which is
    the operator's with `via: "overseer"` (§app.overseer/org-attribution). `via` never widens or
    narrows what a change may do.
  - `wrapup` and `overseer` (autonomous writers; `overseer` is a project's overseer, never the
    global Overseer): only `skills`, `competence`, `language`, `voice`.
  - `referral`: only creating a `proposed` person with its referral details; its contact must be a
    real channel (§app.organizations/referrals).
- A change outside its writer's fields is refused whole and appends nothing.
- One exception, and only through approve/decline: the project overseer (`overseer`) may settle a
  referral, setting a **proposed** person's `status` to active or left; the history line says
  `overseer`. No other status write is allowed to it, and none to the wrap-up.
- A project's main stakeholder (§app.organizations/stakeholder) is the operator's alone: it is
  written only through the project PATCH, which no autonomous writer has (the global Overseer
  calls it for the operator, as the operator), and cleared by Sova only when that person leaves.
  The org's owner (§app.owner-page/owner) is the same: written only through
  `PUT /api/orgs/:id/owner`, cleared by Sova only when that person leaves.

## §app.organizations/privacy — Profiles stay private

- `contact` never enters any model prompt. The global Overseer's organization tools carry none:
  not in a read, a result, an error, a confirm card or the action log, and contact it writes is
  write-only (§app.overseer/org-projection). Its file tools never open a workspace
  (§app.overseer/tools).
- In a baton session only the **current holder's** steering fields (`language`, `voice`, `skills`,
  `competence`) enter the prompt, inside a block marked private steering data never to be disclosed
  or paraphrased; every other participant enters as name, role and decision areas only.
- `voice` and skill strings of 16 characters or more are **profile phrases**. A phrase is a
  secret only where it is not ordinary vocabulary: never one that appears in the public title, in
  any roster person's name, role or decision areas, in a decision's area, or in what someone wrote
  in the conversation (a skill "Accounts payable" beside the role "Accounts payable clerk", a skill
  "finance approvals" that is an area name, Bob's own "Microsoft 365 administration"). Secret
  phrases are redacted, as whole words, only from what the **model** wrote: on the share page from
  every roster person's (replies, streaming text, hand-off and offer questions and briefings,
  decision statements, the done summary — never people's messages, the title or a decision's
  area), and in the model's own context the holder's, from its earlier replies. People's messages
  reach the model and the page as they wrote them. So a verbatim repeat of a profile by the model
  reaches an outsider as `[redacted]`, and no ordinary word, job title or area is ever blanked
  for it. A paraphrase is not caught; that residual risk is the prompt's to hold.
- The org's name is never in the baton prompt; as a backstop the share page redacts it, as a
  whole word, from what the model wrote (a goal may carry it), unless the title or someone in the
  conversation used it.
- **The transition log keeps no contact.** Every row of the org charts' transition log
  (§app.project-overseer/org-charts), and the overseer's feed made from it, shows each contact field
  as `[contact]` wherever it sits (a `contact.email` change is a contact change), keeps only a
  digest of the About text and of anything a person wrote, and drops every token, hash and link;
  `roster-history.jsonl` and the person's own chart are the only places a contact value lives in
  the workspace repo.
- Profiles appear only on the org's own pages (the org page and a person's page), never in a baton
  session pane, except the holder's steering profile inside the prompt What It's Told shows the
  operator on request (§app.baton/told). The owner page shows people by name only (§app.owner-page/never).

## §app.organizations/referrals — People not on the roster

- When the right person is not on the roster, the baton model asks the person it is talking to for
  their full name, at least one contact channel, their role and why they are the one to ask, and
  calls `propose_roster_edit({name, role, contact, why, quote, decides?})`. `referredBy` is always
  the current holder (never an argument). Until everything is there, and the contact is a real
  channel (an email address; a phone or WhatsApp number of 7+ digits; another channel naming a
  handle or number — never a placeholder like "ask Tony"), the tool refuses and says exactly what
  is missing, so the model keeps asking. A name already active or already proposed is refused, and
  so is the name of someone who left ("<name> has left the organization": the model asks who covers
  their area, or hands to the operator for a different person of the same name) or was declined.
- Accepted: the person enters the roster as `status: proposed` with `referral: {why, referredBy,
  sessionId, quote}` (history `by.kind: "referral"`), a `sova-baton-proposal` entry `{v:1,
  personId, name, role, why, by}` records it in the transcript, and the model tells the holder the
  operator must approve them. Proposed people are offered nowhere; `hand_to` them is refused.
- The operator approves (`POST /api/orgs/:id/people/:pid/approve`: active) or declines
  (`…/decline`: left, referral kept) from the Needs-you item, the baton strip's card or the org
  page, and may then **start a session for them** (a new baton with `parentSessionId`) or **hand
  this session to them** (`POST /api/baton/:sid/handoff`).

## §app.organizations/wrap-up — Profiles learn from each session, on their own

- When a baton session is done (`goal_done`) or closed, and a roster person wrote in it, Sova runs
  **one unattended turn** in that session's own runtime — its own model and thinking level — once
  (again only when the operator retries one that stopped, below). When
  no roster person wrote anything, no turn runs: the session's chart records the wrap-up
  `skipped`, and it is never tried again. A session done and then closed runs its wrap-up once.
  Its prompt lists the participants' current language, voice, skills and competence; its only
  active tool is `write_profile_updates([{personId, field, to, quote}])`, which ends the turn.
- Each update is applied by the roster's one writer as `by.kind: "wrapup"`, so only `skills`
  (added to, never dropped), `competence` (a level per skill; each observation counts one more
  session), `language` and `voice` can change; anything else is refused. It must concern a person
  who took part, and its `quote` must be that person's own words in this session, before the
  wrap-up: someone's words never change someone else's profile. A `language` already set changes
  only when the quote states a preference (it names a language: "please write to me in English");
  a message merely written in another language changes nothing. A person with no language yet
  gets the one they wrote in: a first language the model proposes is refused when their own
  messages clearly show another ("they wrote in en"), and after the turn everyone who wrote and
  still has none gets the one their messages show, without the model (a function-word count over
  English, Spanish, Portuguese, French, German, Italian and Dutch; nothing when the text is too
  short or no language clearly wins), as a wrap-up history line quoting the start of their
  longest message.
- **About themselves only.** A `skills`, `competence` or `voice` update is refused when its quote
  is about someone else: it names another roster person (full name, or first name as written on
  the roster) or the operator, or it speaks of a he/she with no first person in it ("the quote is
  about Bob Diaz, not Tony Reyes"). What someone says about a colleague changes nobody's profile;
  the prompt says so too. What people say about themselves and how they want to be addressed
  is what the wrap-up records (a stated preference is data, not an instruction to it); a stated
  skill ("fluent in Portuguese") is a skill. The history line carries the
  session, the quoted message's entry id and the quote. Refusals are logged.
- The turn is marked by `sova-baton-wrapup` entries (`{phase: "start"}` before its prompt,
  `{phase: "end", applied, refused, error?}` after): nothing from the start marker on reaches a
  share page (view or stream), and its prompt is not a message against the budget. The session's
  chart records `wrapup: {state, at, applied, refused, error?}` for the operator's strip; its changes are
  committed with the org's next workspace commit. No approval: history, the Recent profile changes feed
  and Revert are the control (§app.organizations/decisions).
- **A turn that stops is a failed wrap-up.** A wrap-up turn that errors, or is stopped (by the
  stream guard, §chat.transcript/runaway-stream, or an abort), records `state: "failed"` with its
  reason — "A tool call's arguments passed 65,536 characters, so the stream guard ended the turn."
  for a guard stop, "The server shut down during the wrap-up." for a graceful shutdown's stop, else
  the model's error, else "The wrap-up turn ended without an answer." Only the wrap-up turn's own
  answer counts: a stop that leaves it none is failed, never read as the session's earlier turn. The strip says "Wrap-up stopped: {reason} Profiles it didn't reach are
  unchanged." Updates it applied before stopping stay applied.
- **A wrap-up can't stay running.** A wrap-up still running when the server stops is recorded
  `failed` when the server next starts ("The server shut down during the wrap-up."), and one still
  running 11 minutes after it started (the guard's 10-minute limit plus a minute; a chart timer) is
  recorded `failed` then ("It ran past 10 minutes without finishing.").
- **Retry Wrap-Up.** A failed wrap-up never runs again on its own (a model that degenerated once may
  do it again). The strip shows **Retry Wrap-Up** beside it; it clears the failure and runs the
  wrap-up again (`POST /api/baton/:sid/wrapup/retry`, answered with the strip's info once the new run
  shows), only while no wrap-up and no reply runs in the session — otherwise it is refused (409) and
  says why, checked in this order: "The wrap-up is already running." while one runs, a retry's
  included; "Only a wrap-up that stopped can be retried." for a wrap-up in any other state, which is
  never retried; "A reply is running in this session. Retry when it finishes." while a reply runs. While a wrap-up runs, the strip
  re-reads itself until it ends.

## §app.organizations/projects — The org's projects

- Each org has projects, each its own chart (§app.project-overseer/org-charts): `{id, orgId, name,
  root, createdAt, origin: "manual", archived?}` (`archived`: §app.organizations/archive). `root` is an absolute directory on the home host; it need not be a
  git repo. Added and renamed from the org page (`POST /api/orgs/:id/projects`,
  `PATCH /api/orgs/:id/projects/:pid`). A root (at its realpath) may not be an attached org's
  workspace, sit inside one or hold one, nor sit inside Sova's state folder (400): the project
  overseer reads its root (§app.project-overseer/identity).
- A project may name its **main stakeholder**, `stakeholder` (a person id, or absent or `null`:
  none), §app.organizations/stakeholder.
- A project may be switched off the org owner's page, `ownerHidden: true` (absent: shown),
  §app.owner-page/conversations.
- This is the minimal registry baton sessions need; a host-wide Projects registry may absorb it
  later, keyed by the same ids and `orgId`.

## §app.organizations/archive — Archive a project

- **What it does.** Archiving puts a project away without deleting anything: its files, sessions,
  decisions, costs and overseer state stay in the workspace repo as they are, and **Unarchive**
  brings it back as it was. `POST /api/orgs/:id/projects/:pid/archive` and `…/unarchive` (main
  listener only) set the project's `archived: {at, via?}` in its chart (`via: "overseer"`
  when the global Overseer did it for the operator, §app.overseer/org-attribution) and remove it;
  archiving an archived project, or unarchiving one that isn't, changes nothing. It travels with the
  repo (§app.organizations/portability).
- **Refused while anything is open** (409), naming each thing, so the operator stops them first:
  "Stop these first: {list}." with, only those that apply, "{n} gathering session(s) open
  ({titles})" (a baton session or offer of the project not done or closed), "{n} coding session(s)
  running ({titles})" (a coding session of the project that is mid-turn or has workers
  running) and "its overseer is working" (a turn of its overseer is running). Nothing is written.
- **While archived:**
  - its overseer is paused: the watch loop starts nothing for it and its reasons wait
    (§app.project-overseer/watch-loop), Run Now and a message to it (its composer, the global
    Overseer's route) are refused with "{project} is archived. Unarchive it to use its overseer.",
    and its settings are kept unchanged, so unarchiving resumes it as it was set;
  - nothing new starts in it: a gathering session or offer (`POST /api/baton`, Send to person…),
    Start Coding Session, New Coding Session (§app.project-overseer/new-coding-session), and the
    overseers' own starts are refused (409, "{project} is archived. Unarchive it first.");
  - it is left out of the org page's Projects list and count, the start form's project select and
    the org card's count (§app.organizations/org-page, /org-cards), and listed under **Archived
    Projects** on the Projects tab; the global Overseer's `sova_orgs` lists it apart, marked
    archived (§app.overseer/org-reads);
  - it is left out of the sidebar's Organizations region too (§app.session-list/organizations): no
    project heading, no overseer eye, none of its rows, none of them counted. The session list marks
    its sessions (`SessionSummary.org.projectArchived`) so the region can tell;
  - anything of it that waits on the operator (a conflict to settle, a stakeholder to pick, a
    session waiting on a reply or a link) still shows in Needs you: the attention list, and the
    Organizations region's own Needs you list. Its sessions are not moved or archived: its project
    page lists them, and their links and URLs open them;
  - the owner page (§app/owner-page) is unchanged: it shows the project as before.
- **The project page** stays reachable by its URL. Its head carries **Archive Project**
  (destructive, outlined), confirmed with "{project} leaves the Projects list and its overseer stops
  looking. Nothing is deleted; Unarchive brings it back." (`Archive Project` · `Cancel`); a refusal
  shows under it in the server's words. Archived, the page shows an info banner, "{project} was
  archived {when}. Its overseer is paused and nothing new starts here. Nothing was deleted."
  ("… archived by you, via the Overseer {when} …" for a `via` record), with **Unarchive**, and the
  start gestures (Start Overseer, Run Now, Start Coding Session, New Coding Session, Send to
  person…) are disabled with
  the reason "Archived". Copy: §design.copy-deck/overseer-orgs.

## §app.organizations/stakeholder — A project's main stakeholder

- **What it is.** One active roster person per project who decides every area of that project that
  no active roster person decides by name, and every decision whose owner area is `none`
  (§app.requirements/routing, /owner-area): promotion (their decisions
  there are in their area, §app.requirements/promotion) and conflicts there go to them. An area
  someone decides by name stays theirs. It is stored on the project's chart (`stakeholder`), so a person can be the main stakeholder of one project and not another, and it
  travels with the workspace repo.
- **Setting it.** The project page's **Main stakeholder** select (None, then the org's active
  people by name) sends `PATCH /api/orgs/:id/projects/:pid {stakeholder}` (a person id, or `null`).
  Only an active person of the org is accepted; a proposed, left or unknown one is refused (400,
  "Only an active person on the roster can be a project's main stakeholder."). It can be changed at
  any time; a change applies from the next promotion or conflict, and never re-routes a conflict
  already routed.
- **When they leave.** When the person becomes `left` (an edit or a revert), every project naming
  them has its stakeholder cleared at once. Until the operator picks someone or chooses None, the
  project page says why, and the attention digest has a decide-tier item for the project
  (`project-stakeholder`, listed in the Organizations region's Needs you): "Pick a main
  stakeholder for {project}: {name} left the organization." A save of the select clears it.
- **History.** Each change is kept on the project's chart, `stakeholderHistory`
  (`{at, from, to, why, via?}`, oldest first, the last 50; `why` `operator`, or `left` when Sova
  cleared it because the person left; `via: "overseer"` when the global Overseer set it for the
  operator, §app.overseer/org-attribution), and a clearing also leaves `stakeholderCleared`
  (`{personId, name, at}`) until the operator saves the select. Under the select the page shows the
  latest: "Set by you {time}.", "Set by you, via the Overseer {time}." or "Cleared {time}: {name}
  left the organization."
- **Suggested, never automatic.** A project with no main stakeholder and exactly one active
  person on the roster shows "{name} is the only person on the roster. Make them this project's
  main stakeholder?" with **Make Main Stakeholder**; nothing is set until the operator presses it.
- **Seen elsewhere.** The person page names the projects they are main stakeholder of
  (§app.organizations/person-page); the project overseer's prompt, `sova_project` and `sova_roster`
  name them (§app.project-overseer/identity, /tools), and its gaps go to them before the operator
  (§app.project-overseer/gaps). The global Overseer's `sova_orgs` and `sova_org_project` name them
  too, and it may set one for the operator (§app.overseer/org-writes).

## §app.organizations/about — About this organization: the operator's context for project overseers

- **What it is.** Free text the operator writes about the organization (who they are, how they
  work, what to be careful with), at most **4,000 characters**. Every project overseer of the org
  reads it, and the global Overseer when it asks for it (below); nothing else does.
- **Where it lives.** `about.md` in the workspace repo, plain UTF-8 text, saved trimmed; absent or
  blank means none. It is its own file, never in the org's chart, so nothing that reads the org
  (its summary, the share hub's name lookup) carries it, and the transition log records only its
  hash and length. A PATCH ignores a `notes` field.
- **Editing.** On the org page's Projects tab, a card **About this organization**, above the
  projects (§app.organizations/org-page): the hint "Every project overseer in this organization
  reads this at its next run, and the Overseer when it looks it up for you. Nothing else does: not
  hand-off sessions, share pages, wrap-ups or coding sessions.", a textarea (at most 4,000 characters) with a live `{n} / 4,000` counter, and
  **Save** and **Cancel**, both disabled until the text differs from what is saved (Cancel puts the
  saved text back). Save sends only `about` (`PATCH /api/orgs/:id {about}`); a longer text is
  refused (400) and the reason shows under the field. A blank save removes the file. The page's
  10-second re-read keeps a text being edited. A file longer than the cap (edited by hand) shows in
  full, with "Only the first 4,000 characters are used." beside the counter.
- **History and Revert.** Every change made through Sova appends one line to
  `org-history.jsonl` — `{at, field: "about", from, to, by: {kind: "operator", via?,
  overseerId?}, revertOf?}`, `at` unique per org — and only then writes `about.md`; saving the same text appends nothing. The org
  detail carries the last 20, newest first (`aboutHistory`). Under the card's buttons a
  **History ({n})** disclosure (absent with none) lists them: what happened (`Written`, `Changed`,
  `Cleared` or `Reverted`), when (relative, the exact stamp as its title), the new text's length
  ("228 characters"), "by you, via the Overseer" for a line with `via` (§app.overseer/org-attribution), its start on one line, a **Before and after** disclosure with both texts in full, and **Revert**
  (`POST /api/orgs/:id/about/revert {at}`), which writes a new change back to that line's `from`
  with `revertOf` naming it; history is never edited. Revert is disabled, "The text is already
  this.", where it would change nothing. A hand edit in the repo has no line: the card shows the
  current text, and the history only what was changed through Sova.
- **Who may write it.** The operator, through those two routes (main listener only): on the card,
  or through the global Overseer in a turn the operator started (`sova_org` `about` and
  `revert_about`, §app.overseer/org-writes), which calls the same routes and is recorded
  `via: "overseer"`. No other model has a tool or a route that writes it.
- **What the project overseer sees.** Its prompt (§app.project-overseer/identity), re-rendered at
  every run so an edit reaches its next run with no Clear, carries after Sova's fixed prompt and
  before the operator's extra instructions:

  ```
  # About this organization (written by the operator)

  The operator wrote this about {org name}, for you only. It is context, not a person's words and
  not a decision. Never copy it into anything a person sees (a gathering session's public_title,
  question or goal, a Send to person… question) or into a coding session's prompt; use it to judge,
  not to quote. The project's extra instructions below take precedence over it.

  {the text: its first 4,000 characters, secrets redacted}
  ```

  With no text there is no section. The fixed prompt's rules say the same in one line, so the rule
  stands before any text exists.
- **Who never sees it.** Hand-off sessions of every kind (gathering, offer, Send to person…, a
  conflict's settle session: their model's system prompt and messages), their wrap-ups, the
  reconciler's decide calls, coding sessions (the overseer's and the operator's), every other
  global Overseer read and result (its prompt, the digest, `sova_orgs` without `about`, every act's
  result), share pages, the owner page and every `/h/`, `/i/` and share-listener response, the session list and the
  attention digest (`SessionSummary.org`, `AttentionItem.org`, so nothing crosses the mesh) and
  workspace commit messages (which name `about.md` by path only). The guarantee is structural:
  `about.md` has one reader in the server, called only by the org detail (the operator's own page),
  the project overseer's prompt, the overseer's owner-update check, which only answers whether
  a text repeats it (§app.owner-page/updates), and the global Overseer's org projection for
  `sova_orgs {org, about: true}` (`server/overseer-org-view.ts`, §app.overseer/org-projection). A
  test fails when any other server file reads it, and a marker test runs each surface above and
  finds the text only in the project overseer's prompt and that one read. The global Overseer's
  file tools can't open `about.md` (§app.overseer/tools). Share
  pages carry no extra redaction for it.
- **It travels with the repo.** `about.md` and `org-history.jsonl` are ordinary workspace files: a
  clone and attach brings both (§app.organizations/portability).

## §app.organizations/host-offline — An org whose host is down

The page of an organization attached on a peer (the host the mesh has learnt holds it) shows a
warn banner above the page's content while the mesh reports that peer `down`: "{host} is offline,
so its links can't be opened." `{host}` is the peer's label, else its id. It shows even when the
org itself couldn't load (a down host can't answer), follows the mesh's own peer state and goes
when the peer is back. A
local org, and a peer that is up, skewed, refused or unknown, never shows it. A routed host's
unreachable gateway is not this banner: it is the `unreachable` link warning
(§mesh.public/setting).

## §app.organizations/decisions — Why it is shaped this way

- **One repo per org, outside Sova.** Sova's repo is public and profiles are personal data; one
  repo per org can be pushed to that org's own private remote and restored alone.
- **Tokens are host state.** A link is a capability on the host that serves it; committing even a
  hash would let anyone with the repo test guesses offline, and a restored host mints new links.
- **Field authority, not approval.** Autonomous profile edits are allowed only on fields that
  steer tone; the fields that route decisions (`role`, `decides`) and reach people (`contact`)
  change only through the operator. History plus revert does the rest.
