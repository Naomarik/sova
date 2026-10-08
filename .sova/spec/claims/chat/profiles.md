# §chat/profiles — Session profiles
> Part of the Sova design spec · [overview](../design/overview.md)

A profile says what one session can do: which of the default tools it loses, and which session
powers it gains. Profiles are files: Sova's, yours, and each project's own (§chat.profiles/projects).
It is picked on the new session's empty screen (or started from the list or by the Overseer), fixed
once the first message is sent, and kept by the session itself. The UI says
"profile"; "abilities" is the baton's word (§app.baton/abilities) and is not used here.

## §chat.profiles/model — Capabilities, sources and the session's copy

- **Capabilities, not tool names.** A profile names groups (`shared/profiles.ts`, one map for server
  and client). Removable: **Shell** (`bash`), **Edit files** (`edit`, `write`), **Workers & teams**
  (`agent_*`, `team_*`), **Web** (`web_search`, `fetch_content`, `get_search_content`,
  `source_check`), **Worktrees** (`worktree`), **Timers** (`wake_nudge`). The link tools are no
  capability: a session has them only as a link member, born or joined (§mesh.links/tools), so
  no profile or board lists, keeps or removes them. A profile file that still names the old
  `links` removal reads as if it didn't, and the rest of it is kept.
  Grantable: **Read other sessions** (`sessions.read`), **Message other sessions**
  (`sessions.message`), **See all Sova sessions** (`sessions.all`). Messaging and See all each turn
  reading on; turning reading off turns both off.
- **A profile** is `{id, label, icon, description, remove[], grant[], singleton, limits, mode?,
  model?, thinking?, subagents?, firstMessage?, playbook?, overseerMayStart}`. `singleton` is
  labelled **One at a time** in the UI (§chat.profiles/singleton). `limits` are
  §chat.profiles/limits's five numbers. `playbook` links a playbook (§chat.profiles/playbook).
  `model` is the main thread's model ref (`provider/id`); `thinking` its effort, one of pi's levels
  (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `subagents` the subagent profile the
  session uses (§chat.subagent-profiles/file), by its id, or `"off"`. Each is optional: absent, the
  session keeps the new-session default model and effort, and follows this device's default
  subagent profile. A file whose `thinking` is no level, or whose `subagents` isn't `off` or a
  subagent profile id (lowercase letters, digits and dashes, at most 48), doesn't parse.
- **Capability-neutral.** A profile that removes and grants nothing, isn't One at a time, and links
  no playbook and no first message (so it sets only model, effort, subagents or mode) is
  capability-neutral.
- **Where profiles come from** is §chat.profiles/projects: **Default** in code (nothing changed),
  the **Built in** files Sova ships (**Read-only reviewer**: reads sessions; no shell, edits or
  workers. **Mini overseer**: reads and messages sessions in its project; no edits. The Overseer
  may start either), **Yours**, and **This project**'s files. Sova writes only Yours, and only when
  you save one (§chat.profiles/picker's Save Current As Profile).
- **The session keeps its own copy.** A session's profile is its invisible `custom` entry
  `customType: "sova-profile"`, data `{v: 1, profile: {…the whole profile…, source, project?,
  projectName?}}` or `{v: 1, profile: null}` (Default), newest on the branch wins. `source` is
  `sova`, `user` or `project`, and a project profile keeps its project's root and name. An older
  entry's `builtin: true` reads as `sova`. It is never LLM context, the TUI ignores it, and it draws
  no transcript row of its own. Changing, hiding or deleting a profile's file never changes a session
  that already has one. No entry means Default, exactly as before profiles existed.
- `SessionSummary.profile` carries `{id, label, icon, singleton, source, project?, projectName?,
  neutral?}` of the branch's newest entry (absent for Default; `neutral: true` for a
  capability-neutral profile), read by Sova's own file reader, so a TUI-live file is never opened.

## §chat.profiles/picker — Picking a profile on the empty screen

On an ordinary session's empty screen (§chat.transcript/setup-card's empty state), right under the
title and above the setup card, sits a **grid of profile cards**: one click picks a profile. The
Overseer, project overseers, baton, organization and TUI-live sessions show no picker.

- **The grid** is a radio group labelled "Profile", each card a radio checked while its profile is
  the session's; one card is in the tab order. Arrow keys move focus between cards, Home and End to
  the first and last, and Enter, Space or a click picks (moving focus never picks: every pick
  reopens the runtime). The focused card shows the focus ring, and focus is back on the picked card
  once the runtime has reopened. Cards fill the 560px column in as many columns as fit at 160px or
  wider. Where the picker is narrower than 480px (a phone), the cards are one column of single-line
  cards: icon, label, caption and chips on one 44px line (chips that don't fit take a second), the
  caption cut short with an ellipsis first, the label keeping up to about two thirds of the card
  before it is cut. A card that can't be used keeps its whole reason, on its own line below. **Built in** comes first (Default, then the shipped profiles), then **This project ({name})**, then **Yours**, each under its own label; hidden
  profiles are left out, and Default can't be hidden. A last card, **Custom…**, opens the capability
  board. With more than 9 cards, a **Find a profile** field above the grid filters them by name.
  While a profile file here can't be read, a muted line under the grid says "{n} profile files have
  mistakes. See Manage Profiles." ("1 profile file has mistakes.") **Manage Profiles** opens
  Settings → Profiles (§app.settings-dialog/profiles).
- **A card** shows the profile's icon, its label and one caption line: what it sets of
  "{model} · {effort} · subagents: {footprint}" (the model's short name, the effort level, and the
  subagent profile's footprint, its distinct primary models, or "off"), or its description when it
  sets none of them. Chips say **Running** (a One at a time profile already live in another
  session), **Needs approval** (an unapproved project profile, §chat.profiles/trust) and **One at a
  time**.
- **A card that can't be used here** is disabled (`aria-disabled`, still focusable so its reason is
  read), with the reason as its caption, in the warn tone, and as its title, and a click on it does
  nothing. It looks off by shape as well as tone: no fill and a dashed edge, a muted label and
  dimmed icon, a not-allowed pointer, and no change on hover. It is off because its model is turned off in Settings → Models (that page's sentence),
  has no credentials on this host ("No credentials here for {model}."), or its subagent profile
  isn't in this device's library ("Its subagent profile "{id}" isn't in this device's library.").
- **Default shows nearly nothing**: its card checked and one muted line, "Everything a new session
  has today: {n} tools, no session powers."
- **Save Current As Profile**, beside Manage Profiles, asks for a name and saves this session's
  model, effort and subagent pick (its own pick, when it has one; none otherwise, so the profile
  follows the device's default) as a new capability-neutral profile in Yours
  (§chat.profiles/projects), with the wrench icon. It changes nothing about this session; the new
  card shows at once. A name you already use in Yours is refused ("You already have a profile named
  "{name}". Pick another name."), and a Yours file that can't be read refuses with its error and is
  never overwritten. A refusal stays under the name field ("Couldn't save {name}. {reason}"), the
  field marked invalid and the form open, until the name changes or the form closes.
- **Any other profile** shows its one-line description, then **What changes** (vs Default): a row per
  grant, `+` and tinted, with its limits under Message other sessions ("Up to {hops} hops · {n} sends
  per message you send · {n} a day on its own · {n} to one session per 10 min"), then a row per
  removal, `−`, naming its tools. A folded line follows: "Same as Default: {n} tools. Show All", which
  lists them. A One at a time profile adds that badge.
- **Guardrail note.** While anything is removed and the shell is kept, an info note says "The shell
  is on, so removals are guardrails, not a boundary. Bash can still change files and call Sova's
  API." With the shell removed: "The shell is off, so these removals hold."
- Under it, muted: "Fixed once you send your first message."
- **Custom…** opens the capability board: one toggle per removable capability ("on" = kept) and per
  grant, starting from the profile picked before. A toggle it can't change right now is disabled
  with its reason in its title (§chat.profiles/enforcement's workers rule). Its head reads "{label},
  edited" once it differs from where it started, with **Reset**. Every flip applies at once, like a
  pick. The board changes this session only and never makes a profile: profiles are files
  (§chat.profiles/projects).
- **A profile that links a playbook** shows its playbook card under What changes
  (§chat.profiles/playbook).
- **A session the Overseer started from a profile** shows the same screen with it preselected and
  one muted line: "Started by the Overseer with {label}." It stays changeable until a message is sent.

## §chat.profiles/applying — A pick writes the entry and reopens the runtime

- `POST /api/sessions/profile {path, profile}` (`profile`: `{source, id}` or a bare id, resolved
  against the session's own project (§chat.profiles/projects), or a custom `{remove, grant}`; `null`
  is Default) writes the new `sova-profile` entry at once, after the
  open-time model and thinking entries, then disposes the held runtime, the move the Overseer's model
  change makes: open tabs get `reloaded` and reconnect, keeping the draft. The reopened runtime reads
  the entry. A profile's `mode` is pinned (the mode extension's own entry), its `model` becomes
  the opening model, its `thinking` the opening effort, and its `subagents` is written as the
  session's subagent pick (the `subagent-profile` entry, §chat.subagent-profiles/resolution), in the
  same step; its `firstMessage` fills an empty composer. None of these moves a default: the
  new-session model and effort (`defaults.json`) and the device's default subagent profile stay as
  they were.
- **Checked before anything is written.** A pick whose model is turned off in Settings → Models,
  has no credentials on this host or isn't a model here, whose effort isn't one of the levels, or
  whose subagent profile isn't in this device's library is refused (400) with a sentence that says
  which, and nothing is written.
- **Switching back.** A pick made while the session's current profile sets `subagents`, of a
  profile that sets none (Default included), pins this device's default subagent profile (`off`
  when the default is Off or missing) as the session's pick, since a pick is newest-wins and can't
  be cleared; a session with no pick entry gets none. Likewise a pick of a profile without `model`
  or `thinking`, made while the current profile sets it, puts back the model or effort a new
  session would open on: the new-session default's (`defaults.json`) when it names a usable one,
  else pi's own default, the same fallback a new session takes. That file is never written.
- **Refused** (409, nothing written) once a user message is on the branch ("The profile is fixed
  once a message is sent."), mid-turn, TUI-live, for a foreign writer, for the special sessions
  above, and for a project profile that needs approval (§chat.profiles/trust). A rewind to before the first message leaves a branch with no user message, so the picker
  is back, with the profile that branch holds.
- The chat socket sends a `profile` message after `hello`, whenever there is something to show (a
  profile, or a session still before its first message): the branch's profile (or null), who
  picked it, whether it is `locked`, the runtime's active tool names, the tools its removals took
  away and the tools its grants added. The client never keeps its own tool list. A Default session
  with a message on its branch gets none, so its socket frames are as before.

## §chat.profiles/enforcement — What a profile changes in the runtime

- **Removals** are the SDK's `excludeTools`, given when the runtime is built. They filter the tool
  registry itself, so no extension's `setActiveTools` (mode strict's restore, align, vis_check,
  vision-delegate) and no re-registration (the sandbox's bash) brings a removed tool back.
- **Workers never exceed their session.** A profile that removes anything also removes Workers &
  teams, since a worker would start with every default tool. The board shows that toggle off and
  disabled while another removal is on: "Workers would get every tool back, so removing anything
  removes them too."
- **Grants** are one in-process extension, `sova-session-powers`, added only when the profile grants
  something. Its tool names and its prompt section are fixed for the runtime's life, and a Default
  session gets neither, so it is byte-identical to a session before profiles.
- **Fixed for the runtime's life.** A profile never changes mid-turn; a pick rebuilds the runtime
  before the first message (§chat.profiles/applying), and nothing changes it after.
- **Guardrails, not a security boundary.** While the shell is kept, a session can still change files
  and reach Sova's REST API on this host. Removing the shell (or the sandbox) is what contains it;
  the picker and the chip say so.

## §chat.profiles/session-tools — The session powers

With **Read other sessions**: `session_list`, `session_detail`, `session_read`. With **Message other
sessions**: `session_send` too, and `queue_open`, which opens a topic other sessions answer on
(§chat.topics/open).

- **Which sessions it sees.** Without See all Sova sessions: sessions on this host in its project
  (§chat.profiles/projects): the main checkout, its worktrees and their subfolders, or, outside git,
  its folder and below. With it: every session this host's list shows (Live & web and
  the Archive, TUI-live ones included). Never, either way: itself, the Overseer's conversations,
  project overseers' conversations, organization and baton sessions, and workers' own sessions. A
  session it can't see answers "No session with id {id} that this session can see."
- `session_list {query?, limit?}`: one row per session: id · title · folder · state · profile ·
  last active, then "hosted here" when this server runs it and "{n} workers working" while it has
  working subagents; newest active first, 25 by default, at most 50. It ends with one line while
  any session it never shows is hosted here and busy (a turn in flight or workers working): "Also
  busy on this server, not listed: {n} Overseer, {n} project overseer, …", counts by kind only,
  never ids or content.
- `session_detail {session}`: the row, its summary's purpose and now, its open alignment questions
  ("Open alignment questions: {n}"), each tracked worktree's readiness line, and, when this server
  holds it, whether it is mid-turn and how many messages it has queued.
- `session_read {session, from?, items?, chars?}`: the Overseer's bounded read (at most 40 rows and
  12,000 characters), wrapped as untrusted content from another session and redacted as the
  Overseer's reads are.
- `session_send {session, text, delivery?}`: idle, it starts a turn; mid-turn it is queued as a
  follow-up, or as a steer with `delivery: "steer"`, exactly like `sova_send`. Also refused: a
  TUI-live session, an archived one, and one another process is writing. Each refusal is a sentence
  that says why, and takes nothing.
- **Reads and sends are guarded in code, shared with the Overseer** (`server/session-guards.ts`):
  the target refusals, the untrusted wrapping and the audit writer. The Overseer's and project
  overseers' own tools are unchanged.

## §chat.profiles/limits — Loops, fan-out and the audit log

Enforced in the tool, never by the prompt; each has a default and is editable per profile.

- **Hops, 3.** A message the user sends is hop 0; a send made in a run that a session's message
  opened carries that message's hop plus 1, and a send past the limit is refused. The hop comes
  from the server's own record of the message, never from its text.
- **Per message you send, 10.** Sends in runs the user started, counted until the user's next
  message.
- **On its own, 40 a day.** Sends in runs the user didn't start (a timer's wake-up, another session's
  message), counted per local day. A wake-up turn may send; it spends this allowance.
- **Targets per run, 5.** Distinct sessions one run sends to.
- **To one session per 10 minutes, 6.** Sends from this session to one target in any 10 minutes.
- A refused send takes nothing from any allowance. The per-message and per-day counts outlive a
  server restart; the per-run and per-pair counts are in memory.
- **Audit.** Every `session_send` and `session_read`, refused or not, is one line in
  `<state root>/session-actions.jsonl`: `{at, sessionId, profile, tool, target?, hop?, outcome,
  error?}`. The message text is never logged.

## §chat.profiles/delivery — A message from another session

- **The model sees who sent it.** The text the target receives begins with one line,
  `[from session "{title}" ({id}), hop {n}]`, then the sender's text.
- **The transcript knows it for sure.** Once the message enters the context, the server writes an
  invisible `custom` entry `customType: "sova-session-sent"`, data `{v: 1, targetId, from: {sessionId,
  title}, hop}` (§app.overseer/sent-marker's mechanism, its third sender). Only the in-process tool
  can set it. The target's transcript then draws a sender header, "From {title}" linking to the
  sender and "hop {n}", above a neutral message row whose author reads "From a session", never
  "You", and hides the header line from the row's text. On reload and live alike.
- While queued in the target, its row carries the same sender header, **From {title}** (the queue
  snapshot's `fromSession`).
- **The sender's transcript** shows each `session_send` as a card naming the target (a link) and
  how it went: "Sent to {title}", "Queued in {title}" or the refusal.

## §chat.profiles/after-first-message — The chip, the row and the badge

- **Head chip.** A session with a profile shows a chip in the session head: its icon and label
  (icon only in a narrow head). It opens a popover: one sentence ("A {label} session. It {powers}
  and keeps {n} of {m} tools{ with Web off}."), what is added and removed, "Fixed when the first
  message was sent.", and, while the profile it came from still exists, **Run Again** (a new session
  in this session's folder with this profile picked, opened on its empty screen,
  §app.session-list/profile-shelf) and **Manage Profiles** (Settings → Profiles), "Changes reach new
  sessions only.", and for a live One at a time session **Stop {Label}**, which archives it. A
  project profile's chip title and the popover's name read "{label} · {project}". Default shows no chip, and neither does a session before its first
  message (the picker is there instead).
- **Info row.** A muted row where the entry sits, "Profile: {label}" (with "· One at a time"), once
  a message is on the branch. Before that, the entry draws nothing and doesn't count as a row,
  so the empty state stays.
- **List badge.** The session's row in the list carries the profile's icon, its label as the title.

## §chat.profiles/singleton — One at a time

- At most **one live (non-archived) session per One at a time profile**, on this host, where a
  profile is its identity (§chat.profiles/projects): a project's profile allows one per project, so
  the same id in two projects runs twice, and one of yours or a built-in one per host. A session
  counts from the moment the profile is picked for it, so a session that carries a profile is
  listed even before its first message (an empty session is otherwise never listed), where it can
  be opened or archived.
- **Picking a running one** never makes a second: the pick stays as it was and a warn alert says
  "{label} is already running. It's set to One at a time, so only 1 session can use it.", with
  **Open the Running {Label}** and **Pick Another Profile**. The server refuses the pick the same way.
- **Race at Send.** When another session took it between the pick and the first message, Send is
  refused and the draft kept: "{label} started in another session. Nothing was sent. Open it or pick
  another profile."
- **Stop** archives the session; **Start** makes a fresh one.

## §chat.profiles/projects — A session's project, and where profiles come from

- **A session's project** is where its profiles and playbooks come from. For a folder inside a git
  checkout it is that repository's main checkout: a linked worktree maps to the checkout that owns
  its git directory, so the main checkout, every worktree and every subfolder of them are one
  project. Any other local folder is its own project, with no walk up to a parent. The project's
  name is its root folder's name. A relative or remote cwd has no project; that is decided before any
  filesystem call, as for playbooks (§chat.playbooks/the-project-listing).
- **Four sources.** **Default** is in code and changes nothing. **Built in**: one JSON file per
  profile in `profiles/` at the Sova repo root (Read-only reviewer, Mini overseer). **Yours**:
  `<state root>/session-profiles.json` `{version: 1, profiles: [...]}`. **This project**:
  `<project root>/.sova/profiles/<id>.json`, one profile per file, whose `id` must equal the file's
  name.
- **Every file is parsed strictly** (§chat.profiles/model's fields). A file that doesn't parse, or
  whose id doesn't match its name, is skipped and listed as a problem, with its path and the exact
  error; one bad file never hides the others. A malformed Yours file lists none of yours, with its
  error.
- **Identity.** A profile is its source and id, plus the project root for a project profile:
  `sova:<id>`, `user:<id>` or `project:<root>#<id>`. The same id in two projects is two profiles.
- **Picking** names the source (`{source, id}`). A bare id (the Overseer's `profile`, an older
  caller) is looked up in the session's project first, then Yours, then Built in. Either way it is
  resolved against the session's own project, never another one.
- **Profiles are files.** An agent or you edit them, and a change reaches new picks only. Sova
  writes one file, Yours, and only when you ask (Save Current As Profile, §chat.profiles/picker):
  it re-reads the file, refuses when it doesn't parse, adds the one profile and replaces the file
  atomically (a temporary file renamed over it). Built-in and project files are never written.
  Sova keeps two things of its own, outside every repo: which profiles are hidden from the pickers
  (`<state root>/profile-hidden.json`) and approvals (§chat.profiles/trust). The file format, with
  examples, is `docs/profiles.md`.
- **Yours on every device.** With the mesh on, Yours syncs as a settings document
  (§mesh.sync/categories): the whole file, newest edit wins, checked with the strict parse above
  before it is written.

## §chat.profiles/trust — Approving what a project's profile may do

- **What needs approval.** A project profile that grants a session power (Read other sessions,
  Message other sessions, See all Sova sessions), or that the Overseer may start, needs your
  approval before its first pick or start. It needs it again whenever those powers widen: a new
  grant, or Overseer starts turned on. A project profile that only removes capabilities needs none,
  and Default, Built in and Yours never do. Sova can't tell who wrote a file, so this includes
  profiles you or your agent wrote.
- **Approvals** are `<state root>/profile-trust.json`
  `{version: 1, approved: {<identity>: {grant: [...], overseerMayStart, at}}}`, outside every repo.
  Approving records the powers the file has at that moment. `POST /api/profiles/approve {cwd, id,
  grant, overseerMayStart}` is refused when those aren't the powers the file has now (it changed
  since you looked), so what you approve is what you saw.
- **Where.** In the picker, an unapproved project profile reads **Needs approval**. Picking it
  changes nothing and shows a warn alert, "{label} comes from {project}'s files and can {powers}.
  Approve it to use it.", with **Approve** and **Pick Another Profile**. Settings → Profiles shows
  **Approve** on its row (§app.settings-dialog/profiles).
- **Refused until approved**, with nothing written or created: a pick, `POST /api/sessions` with it,
  and the Overseer's `sova_create_session` (no cap taken). The sentence: "{label} is a profile from
  {project}'s files that can {powers}. Approve it in Settings → Profiles or on the picker first."
- A session that already has the profile keeps its copy; approval gates new picks only.

## §chat.profiles/playbook — A profile that runs a playbook

- **The link.** A profile may name a playbook, `playbook: "<id>"`. It is looked up among the
  playbooks the session's folder lists (§chat.playbooks/where-playbooks-come-from): the profile's
  own source first, then This project, Yours and Sova.
- **The playbook card.** On the empty screen, a session whose picked profile links a playbook
  shows a card under what the profile changes. It holds the playbook's title and description,
  **View Playbook**, which opens its entry file (`PLAYBOOK.md` or `SKILL.md`) read-only with its path, and **Run Playbook**.
  The message box holds the playbook's arguments: "Anything you type in the message box goes with
  it." Run Playbook sends the playbook's turn (§chat.playbooks/what-gets-sent) with the message
  box's text as your text, through the ordinary send path, and empties the message box. Nothing is
  sent before it is pressed, and Send still sends a plain message.
- **A missing playbook.** When no listed playbook has the id, the card says "This profile runs the
  playbook "{id}", but this folder has no playbook with that id." and has no Run Playbook.
- **The Overseer.** `sova_create_session` with a profile that links a playbook sends that
  playbook's turn as the first message, with its `prompt`, if any, as your text. So it counts as a
  prompt against the Overseer's caps even without `prompt`. A missing playbook refuses before
  anything is created or capped.
- The turn is built by one function, `playbookTurnText` in `shared/playbooks.ts`, for both.

## §chat.profiles/live-commit — What the live server runs

- `GET /api/health` answers `{ok: true, startedAt, head, runtime, unknownEntries}`: when this server process started (ISO
  time) and the commit its own checkout had then (`git rev-parse HEAD` in the server's folder, read
  once at start; `null` when that fails), the runtime it runs on (§app.server-runtime/health), and
  how many session entries its pi can't read the server has met since it started, a number only
  (§app.harness/unknown-entries). So a merge round checks that the live server runs
  master's commit with one request.
