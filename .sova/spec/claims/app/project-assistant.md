# §app/project-assistant — The Project Assistant: the owner's own chat on the owner page
> Part of the Sova design spec · [overview](../design/overview.md)

The organization's owner (§app.owner-page/owner) gets one ongoing chat on their owner page
(§app/owner-page), named **Project Assistant**. In it they ask about their projects, report a bug
or that the app is down, ask for a fix, a new feature or a release, and get plain answers. It
knows each project from its overview and spec and can read its code (§app/spec-lookup, read only,
cleaned for outsiders), remembers every earlier conversation with them, and writes new
requirements into its own conversation draft (§app.requirements/conversation-drafts). What else it may set off is
the project's Project Assistant column of power switches (§app.project-overseer/autonomy-levels): anything
Off reaches the operator as a request, and it offers only what would happen now
(§app.project-assistant/offers). The owner can send it photos and screenshots
(§app.project-assistant/photos), its answers may carry a drawing (§app.project-assistant/drawings),
and it can start a version the owner may try and hand them an `Open` button for it
(§app.project-assistant/versions). The operator picks its models, sees its requests in Needs
you and on the org's Requests tab, where Start Chat opens a project chat with a request in it,
and can write in the chat themselves.

The owner page also lists the owner's requests and where each stands, and **Versions you can
try**: the current version and every running fix of each project, opened through the owner link.

The owner is never the operator: nothing an owner writes is operator identity, whatever it says.

## §app.project-assistant/chat — One chat per owner, always on

- **A special session of its own kind**, `project-assistant`, the baton's pattern
  (§app.chat-processes/special-kinds): its own system prompt (`server/project-assistant-prompt.md`),
  no extensions, skills, prompt templates, themes or context files, none of the operator's
  `APPEND_SYSTEM.md`, no shell and no file tools; its tools are served by the server
  (§app.project-assistant/tools). Its memory is on (§chat.memory/overseer), so the conversation
  never fills up and it remembers earlier days.
- **One per org and owner.** Its file lives in the org's workspace repo
  (`sessions/`, beside its batons, so it travels with the org); `<workspace>/project-assistant.json` names the
  current conversation per owner. It is made at the owner's first message. A new owner gets a
  conversation of their own; the previous owner's stays in the workspace, closed. The org's
  sessions list shows it as `Project Assistant · {first name}`.
- **Its memory switch** is `project-assistant.json`'s `memory` (absent = on, UniiChat 128 KB).
- **Its prompt** tells it who it talks to (the owner's first name, never their profile), the
  operator's first name, each shown project (§app.owner-page/conversations) with its overview
  (§app.spec-lookup/overview) and a project word to name it by, what it can set off now
  (§app.project-assistant/offers), and how to answer: plain words for a
  non-technical client, never a file, path, branch, tool, model or internal name, never a promise
  about when, and never the words spec, draft, claim, branch, session or model: "what's been
  agreed", "the project's plan", "the team" instead. It is not told the org's About text, the overseer's notes, any profile but the
  owner's name, any conversation's goal or briefing, or anything of other people's conversations.
- **No message limit.** The owner's messages are limited only as a hand-off link's are
  (§app.baton/share-listener): 10 a minute per link, 16 KB bodies, the listener's per-address limit.
  A message carries text, photos (§app.project-assistant/photos) or both.
- **The composer's keys** are Sova's own chat's (§chat.composer/behavior): Enter sends and
  Shift+Enter starts a new line; Ctrl+Enter or ⌘+Enter always sends; after the owner's last press
  on the box was a touch, Enter starts a new line and only `Send` sends; while a keyboard is
  composing characters (`isComposing`), Enter never sends. The placeholder carries the hint
  ("Write a message. Enter sends") only while Enter sends, and the box's `enterkeyhint` is `send`
  then, `enter` after a touch. An Enter that sends leaves no new line behind. While an answer is
  being written, an Enter or `Send` sends nothing and says "Wait for the answer first.", a line
  that goes once the answer is done; the box keeps the text, so the next Enter sends it.
  Hand-off pages keep their own keys (§app.baton/outsider-view).
- **Nothing runs on a model nobody chose.** Its replies run on the org's resolved reply model, its
  own pick or else the host's default (§app.project-assistant/models), set on the chat with its
  thinking level at each owner message; with none resolved, one this host can't run, or one
  Settings → Models turned off, the chat is not ready and does not answer: the page says it isn't
  ready yet and the owner's message is not taken (409 `not-ready`).
- **The operator in the chat.** The operator opens the same conversation in Sova (Owner card,
  `Open Assistant Chat`) and may write in it. The owner sees the operator's messages under the
  operator's first name. A turn the operator starts gets no exception: the Project Assistant column
  decides what it offers and sets off, as in the owner's turns (§app.project-assistant/offers).
- **Rewind, regenerate and modes are refused**: every message in it is someone's.

## §app.project-assistant/photos — The owner's photos

- **When.** The owner can send photos and screenshots only while photos are on (the outsider photo
  settings, Settings → Organizations, §app.settings-dialog/organizations) and the assistant is ready
  on a resolved reply model (the org's pick or the default, §app.project-assistant/models) that sees
  images (its `input` lists `image`). Only then does the chat's view (`GET
  /api/i/<token>/assistant`) carry `photos {perMessage, maxBytes}` and the composer show its
  paperclip; otherwise it shows none, a pasted or dropped picture is not attached, and the upload
  and message routes refuse a photo (409, code `no-photos`). The Owner card's reply row then
  says "This model can't see photos: {first} won't get an attach button.", and Settings →
  Organizations says "This model can't see photos: owners who follow it won't get an attach
  button." under a default that can't.
- **The hand-off page's composer** (§app.baton/images) with photos only, never files: the
  `Attach Photos` paperclip, paste and drop, the same on-device processing (orientation, 2000 px,
  re-encoded, metadata dropped), upload at attach, the pending strip with progress, Retry and
  Remove, "Waiting for photos to finish." while an upload runs, and the polite live region.
- **Upload.** `POST /api/i/<token>/assistant/image` with the raw bytes and their type
  (`image/jpeg`, `image/png`, `image/webp` or `image/gif`), answering 201 `{id, size, mime}`; 404
  and 410 for an unknown or dead owner link; 409 `not-ready` while the chat isn't ready (no reply
  model resolves, or it can't run here or is turned off);
  409 `no-photos` (above); 413 over the largest photo; 400 when the bytes aren't the declared type;
  429 past 20 uploads a minute per link; 507 while the host's staging area is full, as on a hand-off
  page. The server strips metadata again as a backstop. A photo is staged host-local in the hand-off
  photos' staging area (never the workspace repo), per org and owner (so before the conversation
  exists too), and removed once sent or after 24 hours.
- **Sending.** `POST /api/i/<token>/assistant {text, images?: [id]}`: each id a photo this link
  staged; at most the per-message limit (400 `too-many`); text may be empty when there are photos.
  An id that is gone answers 409 `photo-expired`, and the page uploads that photo again once and
  resends. There is no total or daily limit on photos: only the size, the per-message limit and
  the request limits. A message counts once against the message limit, whatever its photos. The
  photos enter the transcript inline, as image content in the owner's message (the session file,
  in the org's workspace repo); a refused message keeps its staged photos for the retry.
- **Who sees them.** The owner, in their own messages (one fitted in 320 × 240, more as 96 px tiles;
  a lightbox scoped to the message; alt "Your photo" or "Your photo {i} of {n}"), fetched from `GET
  /api/i/<token>/assistant/img/<n>`, `n` numbering the owner's photos of the whole conversation in order; the
  operator's Preview as the same, from `GET /api/orgs/:id/owner/preview?assistant=1&img=<n>`; and the
  operator in Sova, as thumbnails (§chat.images/thread-thumbnails). Pixels never ride the view or
  its socket: a message carries `images [{n, mime}]` only. Photo reads count in the share
  listener's photo bucket (§app.baton/share-listener), never the page's.
- **The model** sees each photo as an image in the owner's message. While photos can be sent, its
  prompt says the owner may attach photos and screenshots, that it may ask for a screenshot when
  that would help with a problem they report, that it says in words what a photo shows that
  matters (its memory keeps the words; a photo far back is no longer seen), and that it never
  describes a face or reads a document's personal numbers back; otherwise it says photos can't be
  sent here.
- **The operator's images** in the assistant chat reach the model as in a hand-off session
  (§app.baton/images): an image the operator attached is sent inline as image content and its path
  line is removed from the text, so no local path reaches the owner.

## §app.project-assistant/drawings — Drawings in its answers

- **Taught to draw.** Its prompt carries the drawing guide hand-off conversations get with Draw and
  Interactive drawings on (§app.baton/abilities), written for the owner: at most one drawing in a
  reply and only when a picture helps; never people, roles or anything private, nor how this
  conversation is run; only the owner's own words and figures and what the projects' plans say.
  Every kind the share page draws is taught, interactive (`vis html`) drawings included.
- **Drawn on the owner page** (and the operator's Preview as) as on a hand-off page
  (§app.baton/outsider-view): figures and still pictures inline, interactive drawings in the
  sandboxed frame (§chat.markdown/visuals); a drawing that can't be drawn shows the quiet line "A
  drawing couldn't be shown here." The outsider redaction's markup backstop runs on them, in views
  and while streaming alike.
- **One hidden retry.** When a run of the assistant settles with a `vis` block that has a hard
  error, it gets the hidden retry note Sova's own chats get (§chat.markdown/visuals, "Feedback to
  the model": one `sova-vis-retry` message, at most one retry per run, the same exceptions), so the
  owner sees the fixed drawing. The note is never in the owner's view, its socket or the operator's
  transcript.

## §app.project-assistant/tools — What it can always do, and what its switches allow

- **Always, no switch** (§app.project-overseer/autonomy-levels, "always"):
  - read the project's spec and code, cleaned for outsiders: `spec_lookup` and `code_read`
    (§app.spec-lookup/tool, §app.spec-lookup/code-read), each naming one of the org's shown
    projects;
  - write the owner's new requirements into its conversation draft, one per project, with the
    repeat-back and the explicit yes (§app.requirements/conversation-drafts, §app.requirements/lock-in);
  - `report_issue {project, kind: "bug" | "outage" | "question" | "feature", title, text}`: files an
    owner request (§app.project-assistant/requests) with the team;
  - `owner_requests {}`: the owner's requests and where each stands, to answer "what happened to…";
  - `owner_versions {}`: the versions the owner can try (§app.project-assistant/versions), each its
    label, its project and whether it is running, starting, failed to start or not running, so it
    answers "can I try it?" truthfully. Never a handle, port, branch or address.
- **By the project's Project Assistant column** (§app.project-overseer/autonomy-levels), each act set off as
  the caller kind `assistant`, never as the operator:
  - `start_fix {project, title, text}`: files a `fix` request, then the project's `build/start` act
    with that request as its basis. With Start coding sessions On it waits out the waiting period
    like any held act (Cancel in Needs you), then starts a coding session on its own branch on the
    assistant's coding model, and the request reads `started`; Off (or a brake, or no coding model
    set) it stays with the team and Needs you shows it.
  - `deploy {project}`: files a `deploy` request, then the project's `deploy/run` act. On: the
    project's own deploy recipe runs as the operator's Deploy would, without overrides
    (§app.project-services/deploy-callers). Off: it asks the operator to deploy (deploy.request).
  - `start_version {project?, version}`: starts a version the owner names, `version` a label
    `owner_versions` gave (the project's only version when it lists one). It starts only a copy the
    versions list holds (the Current version or a fix's copy), never a branch, the team's work in
    progress or a new copy. Before any act it refuses, in plain words, when the project lists no
    versions or its copies can't be shown outside the team. An already running (or starting) copy answers
    that it is running (or starting), with its `Open` button, whatever the switches. Otherwise it is the project's `services/run` act
    (`copiesRun`, never held, logged in the project's activity), then the engine's `up` of exactly
    that copy as the assistant caller (§app.project-services/callers). With Create, start and update
    running copies On it starts at once and the answer says it
    is starting; Off (or a brake), checked before the act, nothing starts and no act is logged, a `try` request is filed
    (§app.project-assistant/requests) and the answer says it went to the team. A start the engine
    refuses, or one that fails or doesn't answer within its time (§app.project-assistant/versions),
    says "it didn't start; the team knows" and files the same `try` request. The tool waits at most
    3 seconds for the engine; a start still booting carries on after its answer.
  - `start_feature_chat {project, title, text}`: opens a feature request chat with the owner
    (`gather`, §app.project-assistant/feature-chats). Off (or a brake, or the engine refusing the
    start) it files a `feature` request with the team instead; with the owner's one feature request
    chat already open, or no gathering model set, it starts and files nothing and says so.
- Each tool's answer says, in plain words for the owner, what happened: started, waiting a few
  minutes, or with the team.
- **Before it acts**, each of `start_fix`, `deploy`, `start_version` and `start_feature_chat` asks the one question the
  owner page asks (§app.project-assistant/abilities) for its project, and on `team` sets nothing off:
  the request stays with the team (`deploy` asks the operator to deploy), and its answer says it went
  to the team (`started: false`). A turn the operator started asks the same question, with no part
  skipped (§app.project-assistant/offers).
- **In the tool list** only as §app.project-assistant/offers says: `start_fix` and
  `start_feature_chat` only while some shown project would act; `deploy`'s and `start_version`'s
  descriptions follow what would happen now.
- **Never**: the shell, files, any operator-only act, another org, a project hidden from the owner
  (§app.owner-page/conversations), a link URL, stopping, removing or making a copy.

## §app.project-assistant/abilities — What the owner is told it can do

- **Where.** Home's Project Assistant card, headed "What it can do for you", the chat's
  suggestions before its first message, and its `What Can I Ask?` sheet (§app.owner-page/content)
  list what the assistant can do for the owner: up to 6 lines, each a plain name and how it
  happens (copy: §design.copy-deck/owner-page). While the assistant isn't ready (no runnable reply model,
  §app.project-assistant/chat) the card shows the not-ready line and no list, and the chat no
  suggestions.
- **Always, whatever the switches**: `Ask about your projects` (answers right away), `Report a
  problem` (goes to the team at once; an "app is down" report alerts the operator at once,
  §app.project-assistant/requests), `Ask for something new` (written up with the owner, then sent to
  the team). The owner may also always ask where their requests stand and see the versions they
  can try; those are no line of their own.
- **By the project's Project Assistant column** (§app.project-overseer/autonomy-levels):
  `Get a problem fixed` (Start coding sessions), `Try the latest version` (Create, start and update
  running copies; listed only while some shown project lists a version the owner could open,
  §app.project-assistant/versions), `Release a new version` (Deploy) and `Plan something new with
  you` (Open feature request chats with the owner, §app.project-assistant/feature-chats). While
  some shown project would open a feature request chat (`now`), `Plan something new with you` takes
  the place of `Ask for something new`; while none would, `Ask for something new` shows as it
  always did and the planning line doesn't. Coding prompts are never listed: the assistant can't
  use them.
- **The same question as the act.** One server function answers, for one shown project and one of
  fix, version, release or feature, what the assistant would do if asked now, without doing anything:
  `now` (it starts at once), `held` (it starts on its own after the project's waiting period) or
  `team` (it goes to the team); a version also `none` (no version listed that could be opened). It
  asks, in this order, and the first that fails answers `team`: the project's settings are readable
  and its Project Assistant column is there; the act's switch is On; no brake holds the switches
  (paused by an attach, an empty roster), read as the project page reads it; for a fix, a coding
  model resolves (the project's, the org's or the default, §app.project-assistant/models); for a
  feature, a gathering model resolves the same way; for a
  release, the project declares release steps
  (a deploy target in its definition, §app.project-services/deploy-callers); the project's engine
  would take that act from the assistant now, unattended (the same check the act gets: switch,
  brake, limits, at-once caps, archived), and an engine not open on this host is `team`. Then a fix
  or a release is `held` while the project's waiting period is above 0, else `now`; a version and
  a feature are never held. Unclear is `team`: it never promises what then goes to the team.
- **The tools ask it too** (§app.project-assistant/tools), so a line that says the team handles it
  is a tool that answers it went to the team: Deploy On while the engine or a brake refuses
  `deploy/run` reads "The team releases it" and `deploy` answers `started: false`. The page always
  asks as the owner (unattended), and so do the assistant's prompt, its tool list and its acts,
  in the operator's turns too (§app.project-assistant/offers).
- **Several projects.** When every shown project the line covers gives the same answer, the line
  is one plain sentence; when they differ, it names the projects of each answer, in the order
  right away, on its own, the team ("Get a problem fixed: on its own for RakibaDesigns, the team
  starts it for Rakiba Shop."). Project names only, never a switch's name.
- **Photos.** While the owner can send photos (the chat's view carries `photos`), one note under
  the list: "You can add photos and screenshots."
- **Tapping a line** opens the Assistant tab with the message box started with that line's words
  (an in-page prefill, never in the address), and puts the cursor in it (not on a touch screen, so
  no keyboard springs up); nothing is sent until `Send`.
- **On the wire**: `OwnerHome.abilities` (`shared/owner.ts`), present only while the assistant is
  ready: `{photos, projects: [{project, fix, version, release, feature?}]}` (`feature` `now` or
  `team`; an older server sends none, read as `team`), `project` the shown project's
  `q_` handle and each answer one of the words above. Never a power id or label, a level, the
  overseer's column, a model, a brake's reason or a limit.
- **Fresh.** Worked out at each read of Home, so a switch change shows on the owner's page at its
  next read (within a minute, or at once on returning to the tab); nothing is pushed. The
  assistant follows a change from its next reply (what it offers, §app.project-assistant/offers)
  and its next act (the tools read the column at each call).

## §app.project-assistant/offers — What it offers is what would happen now

- **At each reply.** As each reply starts, the assistant's system prompt and its tool list are
  worked out again from the question Home's card asks (§app.project-assistant/abilities), for fix,
  version, release and feature and each shown project: everything that question counts (the
  switch, a brake or pause, no model set, the limits, no release steps, no version that could be
  opened). An ability is offered only where it answers `now` or `held`. One that answers `team` or
  `none` everywhere is hidden completely: the prompt says nothing of it and the assistant never
  offers it.
- **A fix.** While no shown project would start a fix, the prompt has no fix offer and `start_fix`
  is not in its tool list; a problem is filed with the team as always (`report_issue`).
- **Planning something new.** While no shown project would open a feature request chat
  (§app.project-assistant/feature-chats), the prompt has no planning chat and `start_feature_chat`
  is not in its tool list. Asking for something new then takes the path that is always there,
  presented as the normal way and never as a refusal: work out what they want, repeat it back, and
  after a clear yes send it to the team.
- **A release.** `deploy` stays in the tool list (asking the team is always allowed), but its
  prompt line and description follow the answer: only while it would release on its own does it
  say it releases; otherwise it says it asks the team; and for a project with no release steps it
  never says the team will release it, only that the request is with the team.
- **Versions.** Opening a version that is already running or starting is always offered, whatever
  the switches (`owner_versions`, and `start_version` answering with its `Open` button,
  §app.project-assistant/versions). Starting a version that isn't running is offered only where its
  project's version answer is `now`; elsewhere the assistant says a request to start one goes to
  the team, and `start_version` files it (a `try` request).
- **Several projects.** When an ability is offered for only some shown projects, the prompt names
  those projects, as Home's card does; a call for another project still goes to the team.
- **A change mid-chat** applies from the next reply. That reply's run starts with a hidden note to
  the assistant naming each ability newly offered or no longer offered, and telling it not to
  follow up an earlier offer that is no longer true. The note comes once per change and never when
  nothing changed, and it is never in the owner's view. It compares with the offers this server last worked out for the chat (at its
  open, or when the server reconnected to it), so a change made while no server ran gets no note;
  the prompt follows it all the same.
- **No exception for the operator.** A turn the operator started in the chat gets the same prompt,
  the same tool list and the same checks at each act as the owner's turn.
- **The act still asks.** Each act asks the question again at its call
  (§app.project-assistant/tools), so what changed since the reply started, or a project the offer
  didn't name, goes to the team.

## §app.project-assistant/requests — The owner's requests, and where they stand

- **Stored in the org's workspace** (`projects/<pid>/owner-requests.jsonl`, append-only): a filed
  line `{kind: "filed", id: "or_…", request: "bug" | "outage" | "question" | "feature" | "fix" | "deploy",
  title, text, at}` (`try`: a version the owner asked to try, from `start_version`), then a line `{kind: "status", id, status: "with-team" | "started" | "done" |
  "declined", at, sessionId?}` per change, and a line `{kind: "linked", id, sessionId, at}` when the
  operator's Start Chat links a chat to it (§app.project-assistant/request-chat), which changes no
  status; read folded, a line of a kind it doesn't know skipped. `title` is the owner's own words, at most 120 characters; `text` at most
  2,000.
- **Where it stands**, worked out, never typed by a model: `with-team` when filed; `started` when a
  fix's coding session started, or when the operator sends the first message in the chat Start Chat
  opened for it; back to `with-team` when that chat is archived while the request is neither
  `done` nor `declined` (archiving a fix's own coding session changes nothing); `done` or `declined`
  by the operator, except that an open `try` request is `done` on its own once its version's copy is
  running, whoever started it (the operator from the Branches tab, or a later `start_version`).
  Every change is an appended `status` line. A `feature` request whose feature request chat is open
  reads `Planning with you` on the owner's page (worked out at read time; its stored status stays
  `with-team`), and `Plan agreed` once the chat is done while the request is still with the team.
- **Needs you** (§app.overseer/attention-digest), act tier: each open (`with-team`) request is an
  `owner-request` item, an outage an `owner-outage` item, which also sends a phone notification at
  once (§app/notifications, kind `owner-outage`); an owner's ask for a new link is an
  `owner-link-request` item (§app.owner-page/link). A request's item opens the org's Requests tab at
  that request (`#/orgs/<id>/requests/<rid>`, §app.project-assistant/requests-tab); a link ask opens
  the People tab; an open `try` request is an `owner-version-request` item and opens the project's
  Branches tab. A second ask to try the same version while its request is open files none: the open
  one stands. A `feature` request with a feature request chat reads as that chat stands
  (§app.project-assistant/feature-chats), and one whose chat ended because its owner stopped being
  the owner is an `owner-feature-ended` item.
- **The operator answers** on the Requests tab: `Mark Done` or `Decline` on each open request
  (`POST /api/orgs/:id/owner/requests/:rid {status}`); the item leaves Needs you.
- **The project overseer** sees its project's open owner requests in its project read, as data for
  the operator; its prompt says it never acts on one on its own.

## §app.project-assistant/requests-tab — The org's Requests tab

- **Where.** The organization page's **Requests** tab, between Sessions and People
  (§app.organizations/org-page), at `#/orgs/<id>/requests`; `#/orgs/<id>/requests/<rid>` opens it
  with that request's row scrolled into view and marked. It shows while the org has an owner or any
  request; an org with neither keeps its five tabs.
- **Count and dot.** Its count is the open requests (`with-team` and `started`). Its warn dot,
  "{n} to answer", shows while any request is `with-team`, the same requests Needs you raises.
- **The panel.** One sentence saying these are what the owner asked for through their Project
  Assistant, then a status filter: **Open** (the default: `with-team` and `started`), **Done**,
  **Declined**, **All**. Rows are grouped under their project's name, newest first. Each row: the
  title, its kind and age, a status chip (dot and word: With the team, Being worked on, Done,
  Declined) and the owner's text as its summary. With nothing under Open it says how many are done
  and that nothing from the owner is open now ("{n} done. Nothing open from {first name} right now.").
- **Actions.** An open row has **Start Chat** (or **Open Chat** while it has a chat,
  §app.project-assistant/request-chat), **Mark Done** and **Decline**. A done or declined row has
  no action buttons, except **Open Chat** while it has a chat. A fix the assistant started has that
  fix's coding session as its chat. A row with a chat Start Chat opened reads "Chat started {time}".
- **Data.** The rows are the Owner card's `GET /api/orgs/:id/owner/assistant` `requests`, each
  with an optional `chat: {sessionId, path, startedAt?}`, present only while that chat exists and
  is not archived (worked out at read time). Every `OrgDetail` carries
  `ownerRequests: {open, withTeam, total}`, and `needsYou.requests` (the `with-team` count) on
  `GET /api/orgs` and `OrgDetail` alike; both optional on the wire.
- **Remote orgs** (`?host=`): every call goes to the org's host, and Open Chat opens the chat there.

## §app.project-assistant/request-chat — Start Chat: a project chat with the request as a note

- **`POST /api/orgs/:id/owner/requests/:rid/chat`** answers 200 `{sessionId, path}`. It refuses
  an unknown request (404), a done or declined one (409, `code: "closed"`), and one that already
  has a chat that exists and isn't archived (409, `code: "has-chat"`, with that chat's
  `sessionId` and `path`): one chat per request.
- **The chat** is what New Session's Project tab starts (§app.project-overseer/new-coding-session,
  `worktree: "later"`): in the request's project folder, no worktree or branch until the work is
  named, on the project's coding model and thinking (switchable before sending), titled after the
  request's title.
- **The request as a note.** Before anything else is sent, the request is appended to the chat as a
  note that starts no turn (after the session's own opening entries): "Request from {owner's first
  name} (the organization's owner) through the Project Assistant · {kind word} · {project} · filed
  {date} · {status}", then the title, the text, and "The operator will say what to do with it." The
  model reads it with the operator's first message, in Claude Code chats too
  (§app/claude-code-provider). The transcript draws it as a card, **Request from {first name}**:
  kind, project, filed time, the text, and **Open in Requests**, which opens
  `#/orgs/<id>/requests/<rid>` (wire: an `info` row with `ownerRequest: {orgId, requestId, kind,
  projectId, project, title, text, filedAt, ownerName}`; an older client shows the plain text). No
  reply starts; the chat opens with an empty, focused message box. The request is linked only once
  its note is in the chat: when the note can't be written, the new chat is archived, nothing is
  linked, and Start Chat answers 409 `code: "not-started"`, "Couldn't start the chat. Try again.",
  which the Requests tab shows.
- **Linking changes no state.** Start Chat appends a `linked` line (§app.project-assistant/requests):
  a `with-team` request stays `with-team` (still in Needs you), a `started` one stays `started`.
  Only that chat counts here, never a fix's own coding session. The request reads `started` (Being
  worked on) when the operator's first message in that chat starts its first turn; a turn the Overseer sent doesn't count. The server hears it whether or not
  it restarted in between. Once the chat is archived, Start Chat comes back, and a request not done
  or declined goes back to `with-team`: Needs you raises it again and the owner's page says With
  the team.
- **Catalogue:** `org.owner.request.chat` (Start Chat), `org.owner.request.done` (Mark Done) and
  `org.owner.request.decline` (Decline) (§app.commands/catalogue).

## §app.project-assistant/versions — Versions you can try

- **What is listed**, per shown project: **Current version**, the project's main checkout's running
  copy (§app.project-services/instances) while that checkout is on master (or on `main` where the
  repository has no master branch); on any other branch, a detached HEAD or no Git, no Current
  version row is listed. Then each running copy of a coding worktree: `Fix:
  {request title}` for a fix the assistant started (`sessionId` of its request), else `Fix {n} ·
  started {date}`. Never a branch name, a coding session's title, a port or a path.
- **Openable** only where a running copy could be shared at all
  (§app.project-services/share: share endpoints declared, `share.allow` not false, no sensitive
  data) and its first share endpoint answers now; any other listed copy says `Not running right
  now`. A project whose copies can never be shared lists none.
- **Starting and failed.** A copy `start_version` started is `starting` from the start until its
  first share endpoint answers (then running), and `failed` when the start failed or it hasn't
  answered 5 minutes after the start; the mark lives in the server's memory and a restart forgets
  it (a known limitation: a copy still booting then reads `Not running right now` until it
  answers, and one that never answers is not marked failed). Home and the chat show `Starting…` (disabled) while it starts and re-read every 3 seconds
  until it is running or failed; a failed copy says "It didn't start. The team knows." with no
  `Open`; the operator learns of it from its `try` request in Needs you, and a start the engine
  failed also shows on the project's Branches tab as the engine reports it. `/i/<token>/v/<handle>` of a starting copy
  answers a small page saying it is starting that reloads itself every 3 seconds (200, `Refresh:
  3`), so an `Open` pressed early lands on the copy once it answers; of a failed one, 409 "This
  version didn't start. The team knows."
- **The `Open` button in the chat.** The assistant's message that followed a `start_version` that
  started a copy, or found it running, carries that version as a row (`versions`, the Home row's
  shape), resolved again at each read, so the chat draws it with `Open`, `Starting…` or the failed
  line as Home does. The model's text never carries an address.
- **They run until stopped.** Nothing stops a copy on its own: one the assistant started runs
  until the operator stops it (the project's Branches tab), within the project's slots.
- **Opened through the owner link**: the page's `Open` is `/i/<token>/v/<handle>` (an HMAC handle of
  the copy, §app.owner-page/conversations), which checks the link and the copy again, then sends
  the browser on (302) to a preview link (§mesh.public/preview) bound to the owner link. No answer
  of `/api/i/*` carries a preview address.
- **They never expire on their own and die with the link**: an owner-bound preview's expiry follows
  the owner link's (7 days after its last use, §app.owner-page/link), and every one is turned off
  when the owner link is turned off, replaced, or stops naming the owner. One is made per copy and
  endpoint and kept while both last; a copy torn down turns its own off.
- Opening needs no act and no switch: no sharing step (§app.project-overseer/autonomy-levels, share is never the
  assistant's). Starting one is `start_version`'s (§app.project-assistant/tools).

## §app.project-assistant/models — Which models it runs on

- **Per kind of work**: the assistant's replies (`reply`), the coding sessions it starts
  (`coding`), the gatherings it starts (`gathering`); each a provider and model with an optional
  thinking level. The `gathering` pick runs the feature request chats it opens
  (§app.project-assistant/feature-chats); with none resolved, `start_feature_chat` opens none. The
  Owner card shows all three kinds as rows (§app.owner-page/controls), the gathering kind as
  "Feature request chats it starts".
- **One default for every organization**: the host's Project Assistant default, one model and
  thinking level for all three kinds, set in Settings → Organizations
  (§app.settings-dialog/organizations). Host state (`<stateRoot>/baton-settings.json`, `assistant`),
  never the workspace, and never the new-chat default (§chat.model-menu/saved-default). It is set
  only through `PUT /api/settings/project-assistant {assistant}` (`null` clears it; command
  `settings.assistant-default.set`), which a mesh peer may call only with `admin`, as for an
  organization's own pick (§mesh.peers/grants); `PUT /api/baton/settings`, which `sessions` reaches,
  refuses an `assistant` key (400).
- **An organization's own pick**, per kind, in `<workspace>/project-assistant.json` (`models`), set
  on the Owner card (`PUT /api/orgs/:id/owner/assistant {models}`, each kind `{model, thinking?}`;
  `null` clears the org's pick, so that kind follows the default again); for `coding` and
  `gathering` a project may override it (its Project Assistant column's models,
  §app.project-overseer/autonomy-levels).
- **One resolution, read everywhere**: the project's override (coding and gathering only), else the
  organization's pick, else the default, with its source (`project`, `org` or `default`). Replies,
  readiness, the photo button and photo uploads, the chat's setup, fixes, feature request chats and
  what the owner page says the assistant would do all read it, so a change of the default moves every organization
  without its own pick from its next read.
- **Ready** (§app.project-assistant/chat): a reply model resolves, this host can run it (it is in
  the host's model list, so known and with credentials) and Settings → Models hasn't turned it off
  (§app.settings-dialog/models). A default turned off later leaves every organization that follows
  it not ready; Settings and the Owner card say so.
- **The first default adopts matching picks, once.** The first time a default is saved on a host,
  each organization's pick that equals it exactly (same model and same thinking; a pick with no
  thinking never equals one with a level) is cleared, so it follows the default; every other pick
  stays the organization's own. Later saves of the default never clear a pick.
- **Cost shown**: each model with its price per million input and output tokens
  (§app.project-costs/price-table), or that its price isn't known.
- **None resolved = not run**: no reply model, no reply (§app.project-assistant/chat); no coding
  model, a fix isn't offered and `start_fix` stays a request; no gathering model, a planning chat
  isn't offered (§app.project-assistant/offers).

## §app.project-assistant/never — What the owner and the assistant's model never get

- Every text the assistant's model wrote passes the outsider redaction before the owner sees it
  (§app.baton/outsider-view: `said`, then the secret redactor); its context gets the server's
  secret redactor.
- **Never to the owner** (the page, `/api/i/*`, `/ws/i`, the shell): models, thinking levels,
  costs, token counts; tool names, calls or results; branch names, coding session titles, paths,
  ports, preview addresses; session, person, project or request ids; Needs you; anything
  §app.owner-page/never lists.
- **Never to its model**: the org's About text and the overseer's notes; any profile field but the
  owner's name; other conversations' messages, goals or briefings; spec and code but through the
  outsider projection (§app.spec-lookup/outsider-view); link URLs.
- A test plants a marker in each of those fields, checks it is present in the operator's views,
  then reads every owner answer, socket frame and the model's system prompt and tool results, and
  finds none; the version rows in the chat and the `owner_versions` and `start_version` results
  included, which carry no address, port or branch.

## §app.project-assistant/feature-chats — Feature request chats: planning something new with the owner

- **What it is.** When the owner asks for something new and the project's Project Assistant column
  has `gather` On (in that column it reads "Open feature request chats with the owner",
  §app.project-overseer/autonomy-levels), the assistant opens a **feature request chat**: a
  gathering conversation (§app/baton) of that project whose first holder is the owner, in which a
  planning partner works out with them what they want, on plan cards, with drawings and clickable
  prototypes. It only plans and draws: it has no tool that writes, edits or runs anything, no copy
  of the code, no branch, and nothing it does changes the project's files or its plan. Nothing it
  agrees is ever merged or built on its own.
- **The tool.** `start_feature_chat {project?, title, text}` (§app.project-assistant/tools), for the
  power `gather`. It asks the owner page's question for `feature` first
  (§app.project-assistant/abilities). Before anything is filed or started it refuses, saying so
  and offering to send it to the team instead, when the owner already has an open feature request
  chat (one open chat per owner, across all the organization's projects) or no gathering model is
  set (§app.project-assistant/models). On `team` (the switch Off, a brake, the engine refusing the
  start: the project's at-once and daily gathering limits, §app.project-overseer/limits) it files a
  `feature` request (§app.project-assistant/requests) and says it went to the team, as with the
  switch Off today. Otherwise it files the `feature` request, then starts the gathering in-process
  as the caller `assistant` (never the operator, §app.project-overseer/autonomy-levels): its
  public title the title, its goal the owner's ask, its first holder the owner, no link minted (the
  owner uses their page), `started {by: "assistant"}`, the message limit from Settings (default
  60; Extend works, §app.baton/goal-and-loadout), Draw and Interactive drawings on and Read links
  off whatever the project's set (§app.baton/abilities), on the assistant's gathering model (a
  project's override first). The request is linked to the chat. Its answer tells the model the
  chat is open; the assistant's message after it carries an `Open Feature Chat` button for it
  (`featureChat {conversation, title}` on that message in the chat's view, resolved again at each
  read, shown only while the chat is the owner's to read).
- **The owner's own.** A record in the org's workspace (`project-assistant.json`
  `featureChats [{sessionId, personId, projectId, requestId, at, ended?}]`) names who opened it.
  Only that person, while they are the organization's owner, sees it on their page and writes in
  it; on any other owner's page it does not exist (its handle answers 404). When the owner changes
  or leaves (the moment their owner link is turned off, §app.owner-page/owner), each open feature
  request chat of the former owner is closed (Ended), its record notes why, and Needs you tells the
  operator (`owner-feature-ended`, until its request is marked done or declined). The record is
  written before the close is tried, so Needs you tells the operator even when the close fails.
  Ending converges: a close that failed, and an owner change the server restarted before finishing,
  is done again when each organization opens at the server's start and on every Needs you scan,
  until each open chat of anyone who is not the owner is recorded as ended and closed.
- **On the owner page** (§app.owner-page/content): it is a conversation of its project, listed
  under Waiting on you on Home while the owner holds it (whose hint then says to open it and answer
  there) and under the project's Conversations.
  Opened, it reads like the assistant chat: the conversation, its plan cards and drawings, and at
  the bottom a message box (text only, up to 4,000 characters; the hand-off page's keys) while the
  owner holds it. Its status: `Planning with you` (the owner holds it), `With {first}` (someone
  else or the operator holds it), `Plan agreed` (done), `Ended` (closed). `End Chat` (with a
  confirm) lets the owner drop it.
- **The plan card** (§app.baton/outsider-view): each plan the chat keeps shows once, at its latest
  change, with its title, summary, what we found, the plan (the steps), what was ruled out, its
  drawings and its questions. An open question shows its options with the recommended one marked;
  the owner taps an option per question and presses `Send My Answers`, or `Go With
  Recommendations`, or types; each sends an ordinary message in the alignment card's own words
  (§chat.alignment/card: "al_1: take your recommendation on q1. My answers: 2b — {option}.";
  "al_1: go with your recommendations for every open question.", never "go ahead": nothing is
  built here). A decided question shows its answer. Technical notes never exist in these plans and
  never show.
- **Messages** go through `POST /api/i/<token>/c/<k_handle>/message {text}` and the drop through
  `POST /api/i/<token>/c/<k_handle>/end`, both checked against the owner link
  (§app.owner-page/link) and against "this conversation is a feature request chat this person
  opened, and they are the owner now"; anything else answers 404. A message counts as that person's
  message in the conversation (their person id, never operator identity), under the limits of a
  hand-off page (§app.baton/share-listener: 10 a minute per link, 4,000 characters); it is refused
  while someone else holds the chat (409 `not-holder`), at the message limit (409 `budget`) and
  once it is done or closed (409 `closed`). The `/ws/i` socket tells the page when one of the
  owner's feature request chats changed (`{type: "conversation", conversation}`) and carries its
  reply's text while it is written (`{type: "conversation-streaming", conversation, text}`),
  filtered as a hand-off page's streaming text.
- **What its model is told and has** (§app.baton/goal-and-loadout): the gathering prompt, with
  a "# Planning something new" section: it is a planning partner in the Project manager writing
  style (§chat.alignment/style), finds out how the project works today from the project's
  description and code (outsider view), asks what the person needs, keeps one plan card per need
  with the `align` tool, draws a wireframe, a flow or a clickable prototype where a picture helps,
  never promises that or when anything is built, and closes only after repeating the agreed plan
  back and getting a clear yes from the person who asked. It knows the holder's first name, never
  that they are the organization's owner. Its tools: `hand_to`, `goal_done`, `record_decision`,
  `spec_lookup`, `code_read`, the three requirement tools, scoped `show_tour` and `align`; never
  `propose_roster_edit`, `read_link`, `inspect_files` or `confirm_file`, and, as for every gathering,
  no built-in, file, shell or subagent tool.
- **`align`, served by Sova**: the align tool's operations on the same documents (§chat.alignment/tool)
  except `import`, `status`, `exempt` and the review operations; its schema has no `technical`
  field, and a call that carries one is refused; visuals are on (§chat.alignment/visuals). Its
  results are the plans the plan card shows.
- **Others, when the owner names them.** `hand_to` works as in every gathering (§app.baton/hand-off):
  the person talking chooses who answers next, and the operator is always reachable. A hand-off to
  another person mints their link, which the operator sends. The chat stays the owner's: it counts
  against their one open chat, and only the owner can agree the final plan: `requirements_confirm`
  and `goal_done` are refused while anyone else holds it ("Only {first}, who asked for this, can
  agree the plan: hand it back to them first.").
- **Plan agreed.** `goal_done` after the owner's yes makes it done: the owner page says Plan agreed,
  its confirmed requirements are in the operator's draft specs (§app.requirements/conversation-drafts),
  and the request stays With the team. Building it is the operator's own act (Build on the draft
  spec, §app.requirements/draft-approval); nothing starts coding on its own.
- **It never ends on its own.** No idle time closes it. It ends when the plan is agreed, when the
  owner presses End Chat, when the operator closes it, or when its owner stops being the owner.
- **The operator's side**: an ordinary gathering conversation of the project. Its strip says
  "Feature request · {owner's first name}" and offers no Hide From (`POST /api/baton/:sid/owner` answers
  409: "A feature request chat is {first}'s own: it can't be hidden from them."); Take Back, Close
  Session, Extend and writing in it work as in any gathering (the owner sees the operator's
  messages under their first name). Needs you: its `feature` request, "{owner} is planning a new
  feature with the assistant on {project}: {title}" while the chat is open, "{owner} agreed a plan
  on {project}: {title}" once it is done. The agreed plan is an item of its own (its own id), so
  having been told about the planning item, or having put it aside, never hides it.
- **Never to the owner**: technical notes, tool calls or results other than the plan card's
  allowlisted fields, file names, code, models, costs, the goal and the why.
