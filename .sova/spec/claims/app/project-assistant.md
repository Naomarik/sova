# §app/project-assistant — The Project Assistant: the owner's own chat on the owner page
> Part of the Sova design spec · [overview](../design/overview.md)

The organization's owner (§app.owner-page/owner) gets one ongoing chat on their owner page
(§app/owner-page), named **Project Assistant**. In it they ask about their projects, report a bug
or that the app is down, ask for a fix, a new feature or a release, and get plain answers. It
knows each project from its overview and spec and can read its code (§app/spec-lookup, read only,
cleaned for outsiders), remembers every earlier conversation with them, and writes new
requirements into its own conversation draft (§app.requirements/conversation-drafts). What else it may set off is
the project's Project Assistant column of power switches (§app.project-overseer/autonomy-levels): anything
Off reaches the operator as a request. The operator picks its models, sees its requests in Needs
you and on the Owner card, and can write in the chat themselves.

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

## §app.project-assistant/tools — What it can always do, and what its switches allow

- **Always, no switch** (§app.project-overseer/autonomy-levels, "always"):
  - read the project's spec and code, cleaned for outsiders: `spec_lookup` and `code_read`
    (§app.spec-lookup/tool, §app.spec-lookup/code-read), each naming one of the org's shown
    projects;
  - write the owner's new requirements into its conversation draft, one per project, with the
    repeat-back and the explicit yes (§app.requirements/conversation-drafts, §app.requirements/lock-in);
  - `report_issue {project, kind: "bug" | "outage" | "question" | "feature", title, text}`: files an
    owner request (§app.project-assistant/requests) with the team;
  - `owner_requests {}`: the owner's requests and where each stands, to answer "what happened to…".
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
- Each tool's answer says, in plain words for the owner, what happened: started, waiting a few
  minutes, or with the team.
- **Never**: the shell, files, any operator-only act, another org, a project hidden from the owner
  (§app.owner-page/conversations), a link URL.

## §app.project-assistant/requests — The owner's requests, and where they stand

- **Stored in the org's workspace** (`projects/<pid>/owner-requests.jsonl`, append-only): a filed
  line `{kind: "filed", id: "or_…", request: "bug" | "outage" | "question" | "feature" | "fix" | "deploy",
  title, text, at}`, then a line `{kind: "status", id, status: "with-team" | "started" | "done" |
  "declined", at, sessionId?}` per change; read folded. `title` is the owner's own words, at most 120 characters; `text` at most
  2,000.
- **Where it stands**, worked out, never typed by a model: `with-team` when filed; `started` when a
  fix's coding session started; `done` or `declined` only by the operator.
- **Needs you** (§app.overseer/attention-digest), act tier: each open (`with-team`) request is an
  `owner-request` item, an outage an `owner-outage` item, which also sends a phone notification at
  once (§app/notifications, kind `owner-outage`); an owner's ask for a new link is an
  `owner-link-request` item (§app.owner-page/link). Each opens the org's People tab.
- **The operator answers** on the Owner card: `Mark Done` or `Decline` on each open request
  (`POST /api/orgs/:id/owner/requests/:rid {status}`); the item leaves Needs you.
- **The project overseer** sees its project's open owner requests in its project read, as data for
  the operator; its prompt says it never acts on one on its own.

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
- **Opened through the owner link**: the page's `Open` is `/i/<token>/v/<handle>` (an HMAC handle of
  the copy, §app.owner-page/conversations), which checks the link and the copy again, then sends
  the browser on (302) to a preview link (§mesh.public/preview) bound to the owner link. No answer
  of `/api/i/*` carries a preview address.
- **They never expire on their own and die with the link**: an owner-bound preview's expiry follows
  the owner link's (7 days after its last use, §app.owner-page/link), and every one is turned off
  when the owner link is turned off, replaced, or stops naming the owner. One is made per copy and
  endpoint and kept while both last; a copy torn down turns its own off.
- No act and no switch: they need no sharing step (§app.project-overseer/autonomy-levels, share is never the
  assistant's).

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
  finds none.
