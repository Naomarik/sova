# §app/project-assistant — The Project Assistant: the owner's own chat on the owner page
> Part of the Sova design spec · [overview](../design/overview.md)

The organization's owner (§app.owner-page/owner) gets one ongoing chat on their owner page
(§app/owner-page), named **Project Assistant**. In it they ask about their projects, report a bug
or that the app is down, ask for a fix, a new feature or a release, and get plain answers. It
knows each project from its overview and spec and can read its code (§app/spec-lookup, read only,
cleaned for outsiders), remembers every earlier conversation with them, and writes new
requirements into its own conversation draft (§app.requirements/conversation-drafts). What else it may set off is
the project's Project Assistant column of power switches (§app.project-overseer/autonomy-levels): anything
Off reaches the operator as a request. The owner can send it photos and screenshots
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
  (§app.spec-lookup/overview) and a project word to name it by, and how to answer: plain words for a
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
- **Nothing runs on a model nobody chose.** Its replies run on the org's assistant reply model
  (§app.project-assistant/models), set on the chat at each owner message; with none set, or one this
  host can't run, the chat does not answer: the page says it isn't ready yet and the owner's message
  is not taken (409 `not-ready`).
- **The operator in the chat.** The operator opens the same conversation in Sova (Owner card,
  `Open Assistant Chat`) and may write in it; a turn the operator starts is attended: its acts are
  never restricted (§app.project-overseer/autonomy-levels). The owner sees the operator's messages under the
  operator's first name. A turn the owner starts is never attended. Only a message the operator typed
  in the chat's own composer counts as the operator's turn. Anything else is outside input that the
  Project Assistant column decides: a message another chat sent, one the Overseer sent, or one with
  no record of who sent it (for example a message the server stopped writing before it saved its
  sender).
- **Rewind, regenerate and modes are refused**: every message in it is someone's.

## §app.project-assistant/photos — The owner's photos

- **When.** The owner can send photos and screenshots only while photos are on (the outsider photo
  settings, Settings → Organizations, §app.settings-dialog/organizations) and the assistant's reply
  model sees images (its `input` lists `image`). Only then does the chat's view (`GET
  /api/i/<token>/assistant`) carry `photos {perMessage, maxBytes}` and the composer show its
  paperclip; otherwise it shows none, a pasted or dropped picture is not attached, and the upload
  and message routes refuse a photo (409, code `no-photos`). The Owner card's reply-model row then
  says "This model can't see photos: {first} won't get an attach button."
- **The hand-off page's composer** (§app.baton/images) with photos only, never files: the
  `Attach Photos` paperclip, paste and drop, the same on-device processing (orientation, 2000 px,
  re-encoded, metadata dropped), upload at attach, the pending strip with progress, Retry and
  Remove, "Waiting for photos to finish." while an upload runs, and the polite live region.
- **Upload.** `POST /api/i/<token>/assistant/image` with the raw bytes and their type
  (`image/jpeg`, `image/png`, `image/webp` or `image/gif`), answering 201 `{id, size, mime}`; 404
  and 410 for an unknown or dead owner link; 409 `not-ready` while the chat has no reply model;
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
    versions or its copies can't be shown outside the team. An already running copy answers that it
    is running, with its `Open` button. Otherwise it is the project's `services/run` act
    (`copiesRun`, never held, logged in the project's activity), then the engine's `up` of exactly
    that copy as the assistant caller (§app.project-services/callers). With Create, start and update
    running copies On (or in a turn the operator started) it starts at once and the answer says it
    is starting; Off (or a brake), checked before the act, nothing starts and no act is logged, a `try` request is filed
    (§app.project-assistant/requests) and the answer says it went to the team. A start the engine
    refuses, or one that fails or doesn't answer within its time (§app.project-assistant/versions),
    says "it didn't start; the team knows" and files the same `try` request. The tool waits at most
    3 seconds for the engine; a start still booting carries on after its answer.
- Each tool's answer says, in plain words for the owner, what happened: started, waiting a few
  minutes, or with the team.
- **Never**: the shell, files, any operator-only act, another org, a project hidden from the owner
  (§app.owner-page/conversations), a link URL, stopping, removing or making a copy.

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
  Every change is an appended `status` line.
- **Needs you** (§app.overseer/attention-digest), act tier: each open (`with-team`) request is an
  `owner-request` item, an outage an `owner-outage` item, which also sends a phone notification at
  once (§app/notifications, kind `owner-outage`); an owner's ask for a new link is an
  `owner-link-request` item (§app.owner-page/link). A request's item opens the org's Requests tab at
  that request (`#/orgs/<id>/requests/<rid>`, §app.project-assistant/requests-tab); a link ask opens
  the People tab; an open `try` request is an `owner-version-request` item and opens the project's
  Branches tab. A second ask to try the same version while its request is open files none: the open
  one stands.
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
  thinking level. It starts no gathering yet (no tool does); the `gathering` pick is kept and shown
  for when one does.
- **Per organization**, in `<workspace>/project-assistant.json` (`models`), set on the Owner card
  (`PUT /api/orgs/:id/owner/assistant {models}`); for `coding` and `gathering` a project may
  override it (its Project Assistant column's models, §app.project-overseer/autonomy-levels). The card
  says which applies.
- **Cost shown**: each picked model with its price per million input and output tokens
  (§app.project-costs/price-table), or that its price isn't known.
- **None set = not run**: no reply model, no reply (§app.project-assistant/chat); no coding model,
  `start_fix` stays a request.

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
