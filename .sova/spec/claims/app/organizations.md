# §app/organizations — Organizations, rosters and workspace repos
> Part of the Sova design spec · [overview](../design/overview.md)

An **organization** is a client (or the operator's own team) that Sova talks to through baton
sessions (§app/baton). It has a **roster** of people with terse profiles, a set of **projects**,
and a **workspace repo**: one plain git repo per organization that holds all of it. The operator
is not a roster person; the operator's display name is host-local.

Orgs open as a page, `#/orgs` (the list) and `#/orgs/<id>` (one org), with a back link to the
landing page like Usage and Agents. The entry point is the landing page's Organizations card, its
last section (§chat.transcript/landing-page): totals across every org, the most recently active
orgs as links, and a link to `#/orgs`, shown whether or not any org exists; the sidebar has no
Organizations row, at any width or in the collapsed spine. `#/orgs` is
a grid of organization cards (§app.organizations/org-cards); an org's page has four tabs, each in
the URL (§app.organizations/org-page).

## §app.organizations/registry — Attached orgs and residence

- An org lives on exactly **one home host**. Each host keeps a local index,
  `<stateRoot>/orgs.json` (`{version:1, operator:{name}, orgs:[{id, dir, attachedAt}]}`), of the
  orgs **attached** to it; attached means resident here. It is never part of any workspace repo.
- **Create** (`POST /api/orgs {name, dir?}`) makes the workspace repo (`git init`) at `dir`, or at
  `<stateRoot>/workspaces/<slug>` by default, writes `org.json` and an empty roster, and makes the
  first commit. **Attach** (`POST /api/orgs/attach {dir}`) adds an existing workspace repo (a
  restored clone) to this host's index (§app.organizations/portability). **Detach** removes it from
  the index and deletes nothing.
- A workspace dir must be absolute and must not lie inside Sova's own checkout unless that
  checkout git-ignores it (Sova's repo is public; the hermetic `.agent/` is ignored). An install
  that is not a git checkout (a copied or unpacked tree) has no ignore rules to ask: inside it only
  the default workspaces dir, `<stateRoot>/workspaces` and below, is allowed (never when that dir
  would be the install itself), so the default the New Organization form advertises works in
  either install and every other dir in the tree stays refused. A refused dir answers 400 and
  nothing is written.
- Two hosts attaching the same org is not detected; moving an org is detach here, clone and attach
  there.

## §app.organizations/org-cards — The list: one card per organization

- `#/orgs` shows the attached orgs as a responsive grid (`ul.org-grid`) of cards, one per org, in
  the index's order: one column in a narrow pane, two from 640px of pane width, three from 1024px
  (container queries on the `insights` pane). The New Organization, Attach a Restored Repo and
  Your Name forms follow the grid, unchanged.
- **Each card** is a single link, the whole `.card.org-card` an `<a>` to `#/orgs/<id>`, with a
  focus ring. It reads, top to bottom: the org's name (`heading-s`); `{n} people · {n} projects ·
  {n} open hand-offs` (open = baton sessions not done or closed); the Needs-you line, when
  anything waits; `Active {relative time}` (§chat/transcript's relative form, `src/lib/format.ts`),
  the exact stamp in its title.
- **Needs you.** When anything in the org waits on the operator the card carries a warn chip,
  `Needs you · {n}` (dot and word, never hue alone), a warn border, and a line naming each kind
  that waits: `{n} reply/replies · {n} link(s) to send · {n} person/people to approve`, zero kinds
  left out. It counts the same items the attention list raises (§app.baton/needs-you): baton
  sessions the operator holds and hasn't answered (state `needs-you`); open baton sessions whose
  holder, or an open offer's invitee, has no live link (the operator must send one); and roster
  people with status `proposed`, waiting for Approve or Decline — every proposed person, whether or
  not a session proposed them; and open decision conflicts the reconciler routed to the operator
  that no baton session asks about yet (`{n} conflict(s) to settle`; one with a session is already
  counted once, as that session's reply).
- **Last activity** is the newest of: the org's creation, its newest roster change, each baton
  row's creation, last hand-off, close and offer activity, and the last write of each open baton
  session's file.
- **The server computes both** on `GET /api/orgs` only: each `OrgSummary` gains optional
  `needsYou: {replies, links, proposals, conflicts}` and `lastActivityAt` (ISO). Absent (an older server),
  the card shows no Needs-you highlight and no activity line. `shared/protocol.ts` is unchanged.
- **Zero orgs:** in place of the grid, one card: "Create your first organization", the line
  "Each organization keeps its roster, projects and hand-off sessions in its own git repo.", and a
  secondary `New Organization` button that focuses the New Organization form's Name field.

## §app.organizations/org-page — One org's page: four tabs

- Under the title, in this order: the workspace-problem banners and the new-links banner (they
  stay above the tabs whichever tab is open), then a tab strip (`.tabs`, `role="tablist"`), then
  the open tab's panel (`role="tabpanel"`). The tabs:
  - **Sessions**: the hand-off sessions list, and the start form behind a `Start a Hand-off
    Session` button (closed by default; `Cancel` closes it; a started session closes it). With no
    project yet it says to add one on the Projects tab, linked.
  - **People**: the roster, proposed people included, then Recent Profile Changes under it. A
    person's head is their name and status chip, the role · language line under them, and the
    actions (Approve and Decline for a proposed person, Start a Session for an active one, Edit),
    each named with the person ("Approve Sam Okafor"); the actions wrap under the name as one
    group when the card is narrow, and a name never breaks to fit them. A proposed person's
    "Decides: … — approving {name} approves …" line shows only when they have decision areas.
    History is a disclosure with a chevron that turns when open.
  - **Projects**: the org's projects, each row one link to its project page (folder icon, name,
    folder path, a trailing chevron), and the Add Project form (`Project name`, `Folder`); with none,
    "No projects yet. A project is a folder that hand-off sessions and its overseer work in."
- **Rows and width.** A hand-off session row's title and meta line wrap rather than truncate. Each
  card on the org list, org and project pages stops at 880px wide, left-aligned.
  - **Workspace**: the workspace repo card: how often changes are committed ("Changes are
    committed hourly[ and pushed to the remote], when there are any. Commit Now does it at once."),
    the last commit (relative time with the exact stamp as its title, short sha, message) and
    "· uncommitted changes" while the repo has any, Commit Now, and the push remote.
- **Counts.** Each tab's label is followed by a count: Sessions, every baton session of the org;
  People, every roster person (active, proposed and left); Projects, the projects. Workspace shows
  no count: it holds one repo, not a list.
- **Needs-you dot.** A tab carries a warn dot, with its words as hidden text and as the tab's
  title, when something in it waits on the operator, by the same definitions as the card
  (§app.organizations/org-cards): Sessions — sessions the operator holds unanswered (`{n} to
  answer`) and sessions with a link to send (`{n} link(s) to send`); People — proposed people
  (`{n} to approve`); Projects — open conflicts routed to the operator with no session
  (`{n} conflict(s) to settle`); Workspace — file problems in the repo and a failed last commit
  or push. A session row with a link to send shows a `Link to send` warn chip in place of `Open`.
- **In the URL.** `#/orgs/<id>/sessions`, `/people`, `/projects`, `/workspace`; the bare
  `#/orgs/<id>` is Sessions. `#/orgs/<id>/start/<person>` opens Sessions with the start form open
  and that person ticked — on load, and whenever the hash changes to it while the page shows.
  Closing the form (Cancel, or a session started) replaces the hash with `#/orgs/<id>/sessions`,
  so a reload doesn't reopen it, and every link afterwards (a session row, the sidebar) still
  opens its page. Picking a tab replaces the hash (no history entry per tab), and the page
  is not reloaded: the fetched org stays. `#/orgs/<id>/projects/<project>` stays the project page,
  and its back link opens the Projects tab; the project page and its overseer are untabbed.
- **Keyboard.** The selected tab is the strip's one tab stop; Left/Right move focus along the
  strip (wrapping), Home/End jump, Enter or Space selects. Selecting keeps focus on the tab at
  every width: the phone's move-focus-to-the-title on a route change happens only when the page
  changes (another org, the list or a project page), never for a tab or a start link.
- **Width.** Under 480px of pane width the tabs tighten (`--space-1` padding and gap), so the four
  fit a 420px window with two-digit counts; narrower, the strip scrolls sideways and the selected
  tab is scrolled into view whole.
- **Live.** The page re-reads its org every 10 seconds while the browser tab shows (paused while
  hidden, at once when shown again), so a session that finishes, closes or changes hands
  elsewhere updates its row (`With <holder>`, the state chip) without a reload; each read is
  reconciled in place, so an open form keeps what was typed. A row's "started …" age moves on
  every 30 seconds.
- **Where the data comes from.** Every route that answers an `OrgDetail` adds `needsYou`, each
  baton row's `waiting` (`"reply"` or `"link"`) and `projectConflicts` (`{projectId: n}`), all
  optional on the wire.

## §app.organizations/workspace-repo — What the workspace repo holds, and what it never holds

- It is the org's **whole portable state** (§app.organizations/portability). Files:
  - `org.json` (id, name, slug, notes), `roster.json`, `roster-history.jsonl`, `projects.json`;
  - `baton.json`, the baton registry: each session's holder, participants, hand-offs, offers and
    their leases, message budget, model and wrap-up state — never a link;
  - `sessions/*.jsonl`: every baton session transcript and every project overseer conversation
    (current and history), written there directly by pi (`SessionManager.create(cwd, sessionDir)`);
  - per project, `projects/<projectId>/`: `decisions.json` (the decision index, its last reconcile
    run and last promotion), `conflicts.json`, and the overseer's `overseer/` — `overseer.json`
    (autonomy, models, caps, token budget, watch, extra instructions), `state.json` (current
    conversation and history), `notes.md`, `actions.jsonl`, `ideas/`, `todos.json` and
    `started.json` (the sessions it started, with what each of its coding sessions spent when last
    counted).
  JSONL files are only ever appended to. A `.gitignore` excludes temp files (`*.tmp`, `*.lock`).
- Sova lists and opens those transcripts like any session: a `.jsonl` directly inside an attached
  org's `sessions/` is accepted wherever a session path is (nothing nested, nothing else in the
  repo), and the session list reads those dirs beside the sessions dir.
- **Never in the repo**: link tokens and their hashes (host-local, `<stateRoot>/baton-links.json`,
  mode 0600; links are minted again after a restore), credentials and auth, and Sova's own
  settings (Settings → Decisions, new-session defaults, the model policy).
- **Host-local, by design** — a restore starts these fresh or derives them again: this host's
  attach index `<stateRoot>/orgs.json` (where each repo lives here, which overseers an attach
  paused); the project overseer's per-turn counters and its watch loop's timing (reasons waiting,
  last run, runs per day; `<stateRoot>/project-overseers/<org>-<project>/`), which rate-limit what
  runs on this host; the share listener's rate limits, the lease ticker and the live share pages
  (memory); and what the session list keeps about any session — listing title, web origin, seen
  marks, archive and tags, the write guard's stats — which an attach derives again for the org's
  sessions. A project's own spec (`.sova/spec` under the project root, drafts local) is the
  project repo's, not the workspace's.
- **The old location.** An overseer's `started` list used to live in its host-local watch memo:
  while `started.json` is absent it is read from there, and the first write of either file moves it
  into `started.json` and drops it from the memo.
- **Commits.** Creating an org makes the first commit. After that a committer looks at every
  attached org's repo each minute and commits whatever changed once at least an hour has passed
  since the repo's last commit (counted from HEAD, so Commit Now, a restart or a commit made on
  another host all count; `SOVA_WORKSPACE_COMMIT_MS` shortens the hour for tests only). Nothing
  changed: no commit. The message names what changed by top-level entry ("Workspace changes:
  baton.json, sessions/ (2 files)"), never contents. **Commit Now** (`POST /api/orgs/:id/commit`)
  commits at once. A graceful shutdown (SIGINT or SIGTERM) stops every running turn first, then
  commits every repo with changes, due or not, after the runtimes are disposed; the process exits
  within 20 s whatever a step is waiting on. Commits of one repo run one at a time; a failed commit or
  push is logged and shown as the org's last git error, and never undoes the write that caused it.
- **Push**: after each commit, to the repo's configured remote (`PUT /api/orgs/:id/remote {url}`,
  stored as the repo's own `origin`; an empty url removes it); a push that failed is tried again at
  the next due look, even with nothing new to commit. No remote means local commits only.
  Profiles are personal data: the page says the remote must be private. Sova never creates a
  remote.
- **Restore** = clone the repo onto a host and attach it (§app.organizations/portability).

## §app.organizations/portability — Clone and attach: the whole organization on another host

- Cloning an org's workspace repo onto any Sova host and attaching it ("Attach a Restored Repo",
  `POST /api/orgs/attach {dir}`) brings the whole organization: the org, its roster with every
  history line, its projects, every baton session with its transcript, holder, hand-offs, offers
  and wrap-up state, the decisions and conflicts, and each project overseer with its
  conversations, settings, notes, actions, ideas, to-dos and the sessions it started. Nothing is
  read from the old host.
- **Links must be re-issued.** No link is in the repo, so every old link answers 404 on the new
  host; the operator sends new ones (Get Link, or Needs you's "Send <name> their link"). The attach
  form says so.
- **Project overseers start paused at L0.** The attach records every project of the org as paused
  in this host's index. While paused, the level in force is L0 ("Paused at L0: this organization
  was attached on this host. Set its level to resume."), the watch loop starts nothing for it (its
  reasons wait), its strip says "watch paused", and the project page shows a warn banner "Paused
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
  here, and a project overseer in its project's root as `projects.json` says now (after a move, the
  operator edits the project's folder); the session list groups them under those same dirs.
- The coding sessions an overseer started are ordinary sessions on the host that ran them: on
  another host they are listed "(not on this host)", and the token budget counts what they had
  spent when last counted.
- Two hosts attaching the same org is still not detected (§app.organizations/registry).

## §app.organizations/roster — People and their profiles

- A person has `id` (`p_` + 8 characters), `name`, `status` (`active`, `proposed` or `left`),
  `contact` (`email`, `phone`, `whatsapp`, `other`; any subset), `role`, `decides` (decision areas),
  `skills`, `competence` (per skill: level 1–5 and the number of sessions observed), `language`
  (BCP-47) and `voice` (how to talk to them).
- Caps: `name` ≤ 80, `role` and `voice` ≤ 300 characters; `decides` and `skills` ≤ 12 items of
  ≤ 40 characters each. Over a cap is refused (400), never cut.
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
  carries on; if its lease lapses they can't claim it, and no new link is minted for them.

## §app.organizations/history-and-revert — Per-field history

- Every profile write appends one line per changed field to `roster-history.jsonl` —
  `{at, personId, field, from, to, by:{kind, sessionId?, entryId?, quote?}, revertOf?}` — and only
  then rewrites `roster.json`. Creating a person is one line per set field, from `null`.
- **Revert** (`POST /api/orgs/:id/people/:pid/revert {at}`) writes a new change that sets the field
  back to that line's `from`, with `revertOf` naming the reverted line. History is never edited.
- The org page shows each person's history, newest first — field, old → new value, who changed it
  (and the quote when there is one), when — with a Revert button.
- **Recent profile changes**: the org's history across people, newest first, with each person's
  current name (`GET /api/orgs/:id/changes?limit=`; the org detail carries the last 20), each with
  one-click Revert — where the wrap-up's autonomous changes are seen and undone.

## §app.organizations/field-authority — Who may write which field

- Enforced on the server for every change, whatever asked for it:
  - `operator`: every field.
  - `wrapup` and `overseer` (autonomous writers): only `skills`, `competence`, `language`, `voice`.
  - `referral`: only creating a `proposed` person with its referral details; its contact must be a
    real channel (§app.organizations/referrals).
- A change outside its writer's fields is refused whole and appends nothing.
- One exception, and only through approve/decline: the project overseer (`overseer`) may settle a
  referral, setting a **proposed** person's `status` to active or left; the history line says
  `overseer`. No other status write is allowed to it, and none to the wrap-up.

## §app.organizations/privacy — Profiles stay private

- `contact` never enters any model prompt.
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
- Profiles appear only on the org page, never in a baton session pane.

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
  no roster person wrote anything, no turn runs: the row records `wrapup: {state: "skipped"}`, and
  it is never tried again.
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
  share page (view or stream), and its prompt is not a message against the budget. The row records
  `wrapup: {state, at, applied, refused, error?}` for the operator's strip; its changes are
  committed with the org's next workspace commit. No approval: history, the Recent profile changes feed
  and Revert are the control (§app.organizations/decisions).
- **A turn that stops is a failed wrap-up.** A wrap-up turn that errors, or is stopped (by the
  stream guard, §chat.transcript/runaway-stream, or an abort), records `state: "failed"` with its
  reason — "A tool call's arguments passed 65,536 characters, so the stream guard ended the turn."
  for a guard stop — and the strip says "Wrap-up stopped: {reason} Profiles it didn't reach are
  unchanged." Updates it applied before stopping stay applied.
- **A row can't stay running.** A row whose wrap-up says `running` while no process runs it — left
  by a server that stopped mid-run, or older than any run can be (the guard's 10-minute limit plus a
  minute) — is recorded `failed` ("The server shut down during the wrap-up." / "It ran past 10 minutes
  without finishing."), at startup and at most a minute later while the server runs.
- **Retry Wrap-Up.** A failed wrap-up never runs again on its own (a model that degenerated once may
  do it again). The strip shows **Retry Wrap-Up** beside it; it clears the failure and runs the
  wrap-up again (`POST /api/baton/:sid/wrapup/retry`, answered with the strip's info once the new run
  shows), only while no wrap-up and no reply runs in the session — otherwise it is refused (409) and
  says why, and a wrap-up in any other state is never retried. While a wrap-up runs, the strip
  re-reads itself until it ends.

## §app.organizations/projects — The org's projects

- Each org has projects in its workspace repo's `projects.json`: `{id, orgId, name, root,
  createdAt, origin: "manual"}`. `root` is an absolute directory on the home host; it need not be a
  git repo. Added and renamed from the org page (`POST /api/orgs/:id/projects`,
  `PATCH /api/orgs/:id/projects/:pid`). A root (at its realpath) may not be an attached org's
  workspace, sit inside one or hold one, nor sit inside Sova's state folder (400): the project
  overseer reads its root (§app.project-overseer/identity).
- This is the minimal registry baton sessions need; a host-wide Projects registry may absorb it
  later, keyed by the same ids and `orgId`.

## §app.organizations/decisions — Why it is shaped this way

- **One repo per org, outside Sova.** Sova's repo is public and profiles are personal data; one
  repo per org can be pushed to that org's own private remote and restored alone.
- **Tokens are host state.** A link is a capability on the host that serves it; committing even a
  hash would let anyone with the repo test guesses offline, and a restored host mints new links.
- **Field authority, not approval.** Autonomous profile edits are allowed only on fields that
  steer tone; the fields that route decisions (`role`, `decides`) and reach people (`contact`)
  change only through the operator. History plus revert does the rest.
