# §app/overseer — The Overseer
> Part of the Sova design spec · [overview](../design/overview.md)

The Overseer is **a special Sova session** that watches every session and acts on them. (Baton
sessions, §app/baton, and project overseers, §app/project-overseer, are the other kinds of special
session: the server picks a session's special loadout by its marker, the Overseer's first. A project
overseer watches one organization project only; this Overseer watches everything.) The
user lives in it, and it steers their attention. It's an ordinary webapp-owned pi session hosted by
this server, and it opens as a full page like any chat. Four things make it special: a marker entry
in its file, a fixed cwd under Sova's state dir, a runtime loadout (its own prompt, an inline
extension with `sova_*` tools, a tool allowlist), and a stable route `#/overseer` that points to
whichever file is current. The name is "Overseer" everywhere in the UI.

Sova-owned state under `<stateRoot>` (`~/.pi/agent/sova/`, or `$PI_CODING_AGENT_DIR/sova/`):
`overseer/` (its cwd, otherwise empty), `overseer.json` (settings), `overseer-state.json`
(`{current, history[≤20]}`), `overseer-notes.md` (standing notes), `overseer-actions.jsonl` (audit
log), `seen.json` (the seen store), `ideas/` (the ideas backlog: `manifest.json` plus one `.md`
per idea, §app.overseer/ideas) and `todos.json` (the user's todos, §app.overseer/todos). All writes
are atomic tmp+rename.

## §app.overseer/identity-and-clear — Identity, the route and `/clear`

- **Marker.** When the server creates an Overseer file it writes one `custom` entry with
  `customType: "sova-overseer"`. The flag lives in the file, so a restart can't forget it. It
  renders as nothing in the transcript, is never LLM context, and the TUI ignores it.
- **The marker alone is not enough.** A file is an Overseer file only when it carries the marker
  **and** `overseer-state.json` names it (`current` or `history`). A copy of a marked file, such as
  the fork `/explain` makes with `pi --fork`, carries the marker too; it is an ordinary session:
  listed, searchable and counted, opened with the ordinary loadout (no `sova_*` tools, no Overseer
  prompt). The session list's flag and the runtime's loadout apply the same rule, so they never
  disagree.
- **Singleton.** `GET /api/overseer` returns the current file (`overseer-state.json` `current`),
  creating a marked file when `current` is missing or no longer a marked file. The list poll never
  creates one. The answer carries the path, up to 20 previous files, the attention badge, the chat
  unread count, the proactivity mode and whether it is mid-turn.
- **Route.** `#/overseer` is the identity. The app resolves it through `GET /api/overseer` and
  mounts the normal chat view on that path, keyed on the path, so a rotation remounts it cleanly.
  The view's head reads "Overseer" (no cwd).
- **Hidden everywhere else.** `SessionSummary.overseer` is set by that rule. An Overseer file,
  current or historical, is a special session (§app.session-list/ordinary-surfaces, the one list of
  what that means, shared with organization sessions): it appears on no ordinary surface — no
  sidebar region, Recent, the spine, the cleanup count or a group's candidates — and, unlike an
  organization session, in no search and no region of its own. Its folder (`<stateRoot>/overseer/`)
  is never offered as a recent folder (`GET /api/cwds`, the New Session dialog's Recent folders,
  `sova_list_folders`), even if some other session was once started there.
- **`/clear`.** A bare `/clear` is a local command recognised **only** in the Overseer's composer
  (elsewhere it is an ordinary message). It and the head's **Clear** action (a button on a head
  900px and wider, in ⋯ below that, §app.overseer/head-layout) call
  `POST /api/overseer/clear`, which never refuses: it stops a running turn, disposes the runtime,
  creates a new marked file, pushes the old id onto `history` (≤20; older ids fall off the list)
  and repoints `current`. The requesting tab lands on the new file. Other tabs that showed the
  Overseer re-resolve `#/overseer` when their socket reports the runtime was closed.
- **History.** A **History** menu in the head (in ⋯ as History… below a 900px head,
  §app.overseer/head-layout) lists the previous files (≤20), each row its first message (at most two lines, the rest in its tooltip) over how long ago it was active; a list taller than the window scrolls. One opens read-only at
  `#/overseer/h/<id>` (watch view, no composer); the server refuses a chat on any Overseer file
  but the current one. Settings, standing notes, the audit log and live standing rules
  (§app.overseer/approvals) survive a clear.

## §app.overseer/hosting — Runtime loadout

- **cwd** is `<stateRoot>/overseer/`.
- **Prompt.** A repo-owned prompt file (`server/overseer-prompt.md`) says what the Overseer is,
  every tool, its scope and its rules. It is **appended** through the resource loader's
  append-override, so the user's own `APPEND_SYSTEM.md` is kept. The standing notes and the limits
  ride inside it, and the user's **extra system prompt** from Settings is appended after it. Both the
  notes and the extra prompt are redacted (§app.overseer/tools) as they are put in: a secret value in
  either reaches the model as `[redacted]`. The ideas backlog's table of contents rides in it too
  (§app.overseer/ideas), never an idea's text, and so do the todos' open and done counts
  (§app.overseer/todos), never a todo's text.
- **Live.** The notes, the limits, the ideas table of contents, the todos counts and the extra system prompt are read again at the start of every
  run, so a `sova_note`, a `sova_idea`, a `sova_todo`, a notes, idea or todo edit or a Settings save reaches the Overseer from its next run (the
  next message, brief or wake-up), with no `/clear`. A run an extension's message starts (an
  `/explain` result, a worker's report) picks them up from its next request. The rest of the prompt
  (the prompt file, the tool list, the time it opened) is fixed for the runtime, so an unchanged
  prompt adds nothing to the conversation and a change adds one prompt update.
- **Tools.** The session runs with an allowlist: every `sova_*` tool, `read`, `grep`, `find`,
  `ls` and `wake_nudge`. It never has `bash`, `edit`, `write` or subagent tools: the only
  subagents it can start are ideas' explorers, through `sova_idea` (§app.overseer/explorer).
- **Model.** Its model and thinking level come from `overseer.json`, never from the new-session
  defaults. A model or thinking change made in the Overseer's composer writes back to
  `overseer.json` and never becomes the default for new sessions. A model switch writes the
  **effective** thinking level with it (the level re-clamped to the new model's ladder), so the next
  conversation starts on what the composer showed.
- **No topic outline** runs for it: no list shows it.
- **Mode.** It is always in the normal mode with no minor modes (align and spec off); Delegate's
  strict flag is left as it is. Every open of its runtime brings it back to that, whatever mode
  entry its branch restored, and an Overseer already there opens without a write. Its composer
  has no mode switch. A switch (`POST /api/mode?path=`) or a save of its mode as the default
  is refused with a 409, and a `/mode` sent to it, with or without arguments, is refused and never
  runs (the chat socket answers with an error whose code is `refused`, a deliberate refusal rather
  than a failure): its composer answers a typed `/mode` itself with a toast, "The Overseer is always in
  normal mode.", and leaves `mode` out of its `/` menu.

## §app.overseer/tools — The `sova_*` tools

The tools call the existing REST routes in-process, so every guard those routes have already
(TUI-live refusal, archived refusal, the model policy; for archive and set-session, the mid-turn and
working-subagent refusals) applies unchanged, and their refusal sentences come back as the tool's
error. Sessions are addressed by id, bare or in any form the tools print it (`sova://s/<id>`,
`s/<id>`, a `[title](sova://s/<id>)` link). No tool passes `force`. A call that names a peer (`host`) goes
to that host over the peer hop (§mesh.peers/listener), never through the page's proxy, so this
host's sender secret never leaves it. The peer's own routes and refusals apply.

- **Read** (no side effects): the attention digest; list sessions (compact rows); one session's
  detail, whose summary topics read newest first, as the insight strip lists them
  (§app.insights/insight-strip), each heading with how long ago its own section of the conversation ended
  (§app.insights/summary-sections; how long ago the summary last wrote it, for a topic without one)
  (`Topics (newest first): Merge (1m ago); Sandbox menu (2h ago)`); a bounded transcript read (≤40 items, ≤12,000 characters, each item ≤1,000, wrapped as
  untrusted content from another session, read with Sova's own parser so a TUI-live file is never
  opened for writing); list groups, targets, models and folders; the ideas backlog (`sova_ideas`: its table of contents,
  a search, one idea, an idea's scope and impact, an idea's explorer; §app.overseer/ideas); the
  user's todos (`sova_todos`: open, done or all; §app.overseer/todos); the links this host knows
  (`sova_links`, §app.overseer/links-tools); this host's organizations, their projects and project
  overseers, and one roster person (`sova_orgs`, `sova_org_project`, `sova_org_person`,
  §app.overseer/org-reads), never a contact or a link (§app.overseer/org-projection).
- **The transcript read reaches peers.** `sova_read_session` takes an optional `host`: with a
  peer's id it reads that peer's session by id (§mesh.links/by-id), with the same bounds and
  untrusted wrapping. The peer renders the slice with its own parser and redacts it with its own
  secrets before it leaves, and this host redacts it again. A peer that is down or skewed is a
  refusal naming the host, never an empty transcript.
- **Act:** create a session in any folder, on a remote target, or on a mesh peer (`host`,
  §app.overseer/links-tools), with an optional first prompt, model,
  mode and minor modes (`minor_modes`, e.g. `["spec"]`); the mode and minor modes are set before the
  first prompt is sent, so its first turn already runs in them, and written into the session as its
  `mode` entry even when they equal the default, so a later change to the default never moves it
  (the same for `sova_set_session`). An unknown mode or minor mode refuses
  the whole call before any session is created, and a mode switch that fails sends no prompt: the
  result says the session was created but its first prompt was not sent. Send a message to a
  session (below); archive and unarchive
  (never permanent delete); rename; give a session an alias (§app.overseer/session-names); groups (create, move a session in, remove it); set a session's
  model or mode; answer a hosted session's pending extension dialog; standing notes; navigate;
  ask with cards (`sova_card`, §app.overseer/confirm); the ideas backlog (`sova_idea`: file, grow, update, link and rename ideas, launch and
  message an idea's explorer); the user's todos (`sova_todo`: add, tick, untick, edit, remove, clear the
  done ones); link sessions across hosts and end a link (`sova_link`, `sova_unlink`,
  §app.overseer/links-tools); this host's organizations: orgs, projects, rosters, owners and
  decisions (`sova_org`, `sova_org_project`, `sova_roster`, `sova_owner`, `sova_project_decisions`,
  §app.overseer/org-writes), gathering sessions (`sova_gather`, §app.overseer/org-people-facing) and
  project overseers (`sova_project_overseer`, §app.overseer/org-project-overseers).
- **Sending (`sova_send`) is typing in that session's composer.** Idle, with subagents working or
  not, the message starts a turn. Mid-turn it is **queued as a follow-up** behind the running turn
  by default: a queued row in that session, "Queued", which the user can remove
  (§chat.transcript/a-queued-message), and which goes in when the turn ends. With
  `delivery: "steer"` it is queued as a **steer** instead and goes into the running turn at its
  next step, as the composer's Steer does; the Overseer's prompt reserves that for a user who asked
  to interrupt or redirect the turn. A compaction running holds the message the same way until it
  ends. Queued messages go in the order they were sent, one at a time, whatever their kind. A
  leading `/` runs that session's command, as in the composer. The tool's result says which
  happened: sent, queued behind the turn, queued as a steer, or held for the compaction. Never a
  terminal-owned, archived or worker session, and never the Overseer's own. The route is
  `POST /api/sessions/prompt` (`delivery` optional, `"followUp"` or `"steer"`; anything else is a
  400).
- **Profiles (§chat/profiles).** `sova_create_session` takes `profile`: a profile's id, on this
  host only, resolved against the new session's folder (its project first, then yours, then built
  in, §chat.profiles/projects). Only a profile marked "The Overseer may start it" is taken, and a
  project profile only once you approved it (§chat.profiles/trust); any other refuses before
  anything is created. A profile that links a playbook sends that playbook as the first message,
  with `prompt` as its text (§chat.profiles/playbook). The session is created with that profile's snapshot
  (and its mode and model unless the call names its own), and the tool's result renders as a
  **Started from {label}** card with Open Session. A One at a time profile that is live refuses
  with a card saying "{label} is already running. It's set to One at a time, so only 1 session can
  use it." and **Open the Running {Label}**; nothing is created and no cap is taken.
  `sova_set_session` never changes a profile: it has no such parameter, so it can't widen one.
- **TUI-live sessions are read-only**: every act on one is refused.
- **Files: anywhere but credentials.** The Overseer's `read`, `grep`, `find` and `ls` reach any
  file on the machine except secret files, which none of them reads, lists or matches:
  - fixed places: `auth.json` and `models.json` in `~/.pi/agent` and in the active agent dir, and
    `models.json` anywhere under `~/.pi` and under the active agent dir (the model registry, whose
    `apiKey` and headers may be a literal key or a `!command`); Claude Code's
    `~/.claude/.credentials.json` and `~/.claude.json`; `~/.netrc`; `~/.config/gh/hosts.yml`;
    `<stateRoot>/outreach.json` and `outreach-receipts.json` (§app.outreach/secrets);
  - whole directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.claude/backups`, `/proc` (every
    process's environment and command line, the server's own included), `/sys` and `/dev/fd`
    (the server's own open files; on Linux it resolves into `/proc`, on macOS it does not), and
    the WhatsApp sender's home and its auth directory wherever configured (§app.outreach/secrets);
  - names, anywhere on the machine, so a copy is denied like the original (another worktree's
    `.agent/auth.json`, a `.credentials.json.mtn` backup): `auth.json` and `auth.json.*`;
    `.claude.json` and `.claude.json.*`; any name containing `credentials`; `.env` and `.env.*`
    except `.env.example` and `.env.sample`; `id_*` except `*.pub`; `*.pem`, `*.key`, `*.p12`,
    `*.pfx`; `.netrc`; `.pgpass`;
  - hard links: a file with the same device and inode as one of the fixed files, whatever its name.

  A path is checked as written, with `..` resolved, and at its realpath, so a symlink or a `..`
  can't reach a secret under another name (a symlink to a copy is denied by the copy's name); a
  fixed file's own symlink target is secret too. A path that names one is refused with "That file
  holds credentials; the Overseer can't read it."; a search or listing from a parent directory
  (`~`, `~/.pi`) leaves them out of its results, uncounted. The list is kept in one place in the
  server, and the Overseer's prompt names every entry. Only the Overseer's tools are guarded; every
  other session keeps pi's own.
- **Organizations: through their tools only.** The same four tools never reach an attached org's
  workspace directory, any file in it (the roster and its history with every contact, the About
  text, the baton transcripts, the overseers' state), nor the host's link stores
  (`<stateRoot>/baton-links.json`, `<stateRoot>/person-links.json`). The workspaces are the ones
  attached when the call runs, checked as written and at their realpath like the secret files, so
  a symlink or a copy's parent can't reach one. A path inside one is refused with "That folder is
  an organization's workspace; read it with sova_orgs and sova_read_session."; the link stores are
  refused as credentials; a search or listing from a parent leaves them out, uncounted. The
  prompt says so.
- **Secret values are redacted everywhere the Overseer reads or writes.** Where the file rules
  can't reach (a key copied into an ordinary file, a token a session printed into its transcript),
  every occurrence of a known secret value becomes `[redacted]`. The values are read by the server
  from pi's `auth.json` in `~/.pi/agent` and in the active agent dir (every value), Claude Code's
  `~/.claude/.credentials.json` (every value but the descriptive fields: scopes, subscription type,
  rate-limit tier) and `~/.claude.json`'s `primaryApiKey`, the literal `apiKey` and header values
  in both `models.json` files (the literal parts of a `$NAME` template; a `!command` is never run
  and never taken as a value), and the server's environment variables whose name contains `KEY`,
  `TOKEN`, `SECRET`, `PASSWORD` or `AUTH` (not `AUTHOR`/`AUTHORITY`). A value counts only when it
  is at least 12 characters and not a boolean, a number, a path or a URL without credentials. A
  secret cut short at either end (a truncated transcript row, `sk-…`) is redacted from 16 of its
  characters on. The values are kept in memory, re-read only when a file's mtime, size or inode (or
  the environment) changes, and never logged or sent anywhere.
  The Jev key file (§app.decisions/key) and the private half of the Web Push signing key
  (`secrets/vapid.json`, §app/notifications) are among these sources. Secrets no file names are
  also recognised by their shape and replaced: PEM private-key blocks (to their END line, or the
  end of a cut text), `sk-…` keys (16+ characters with a digit), GitHub `ghp_`/`gho_`/`ghu_`/
  `ghs_`/`ghr_` and `github_pat_` tokens, AWS `AKIA`/`ASIA` key ids, Slack `xox?-` tokens, JWTs,
  and the token after `Bearer ` (the word stays). In `NAME=value` (env lines, flags, query
  strings) and `"name": "value"` (JSON), where the name contains key, token, secret, password,
  passwd, auth (not author…) or credential, the value is replaced and the name stays. A value
  that is only a number, a boolean, null/none or empty is never replaced. Paths, short git
  hashes, `key: value` prose and fields such as author, authority or keywords are left alone.
  - **Every Overseer tool** goes through one wrapper, so a tool added later is covered by default:
    its result (text and details, partial updates, an error's message; an image's bytes are left
    alone) is redacted, and so are its arguments before it runs, so what a tool stores or sends
    (notes, a confirm card, a prompt to another session, the action log) never holds a value.
    `read`, `grep`, `find` and `ls` keep their arguments as given (they store nothing, and a
    redacted pattern would be a different search); what they return is redacted.
  - The standing notes and the extra system prompt are redacted when they are put into the prompt
    (§app.overseer/hosting), and a brief's body is too (§app.overseer/proactivity).
  - Messages an extension puts into the Overseer's context (a worker's or explorer's report, an
    `/explain` result) are redacted in every request the model gets; the session file keeps them
    as they came, for the user.
  - Only the Overseer is redacted; other sessions and pi-config are unchanged. (Decisions runs
    the same redactor over what it sends, §app.decisions/privacy.)
- **Runs the user did not start are read-only.** Who a run belongs to is decided per run, as the
  user turn in §app.overseer/caps. **Every run starts unattended**, whatever the run before it was,
  and it becomes the user's only when a message the user sent from the UI (typed, a quick action, a
  confirm-card click, a steer, a regenerate), with or without images and whatever its text became on
  the way in, enters it. A brief, a fired `wake_nudge`, an extension's message that starts a run (an
  `/explain` result, a subagent's or team member's report: `sendMessage(…, {triggerTurn: true})`),
  a run with no message at all, or any message of unknown origin is **unattended**, and so is a
  fresh runtime after a restart: it fails closed.
  - **Foreign input ends the user's part of a run.** Once the model has replied to the user's
    message, any other input entering the context (a wake-up or a worker's report queued into the
    run, an extension's context-only message) makes the rest of that run read-only, so such input
    never acts on the user's authority, not even for the rest of the run it joined. An extension's
    context that rides in with the user's own message, before the model's first reply to it, is
    part of that message. The Overseer's own hidden open-cards note (§app.overseer/confirm) is
    state, not input: wherever it lands it changes nothing about who the run belongs to. A user message queued into a run makes the rest of it the user's.
  - **A retry is the same run.** When the SDK re-runs the user's request after a provider error or
    a context overflow, the re-run keeps the attendance it failed with, but only if the model's
    reply is the first thing in it; any input that arrives first decides it instead.

  In an
  unattended turn every acting tool refuses without doing anything: create, send, archive and
  unarchive, rename and set model/thinking/mode (`sova_set_session`), group operations,
  answering a dialog, linking and unlinking (`sova_link`, `sova_unlink`), every `sova_idea` operation (filing, changing, linking or renaming an idea,
  launching or messaging an explorer), every `sova_todo` operation, ticking included, and every
  organization act (`sova_org`, `sova_org_project`, `sova_roster`, `sova_owner`,
  `sova_project_decisions`, `sova_gather`, `sova_project_overseer`, a message to a project overseer
  included). Still allowed: every read, `sova_note`, `sova_card`, `sova_navigate`
  (which never moves a tab in such a turn), and `read`/`grep`/`find`/`ls`. The refusal tells the
  model to stop and raise a `sova_card` card instead; the user's click starts a turn in which it
  may act, within the caps. The one exception is an act on sessions that a live approval for later
  or a standing rule covers (§app.overseer/approvals): it runs, and says what it ran under. The
  Overseer's prompt states the rule. Sessions the Overseer creates
  keep their full tools.
- **Itself:** tools refuse to act on the Overseer's own session.
- **A model, thinking level, mode or minor mode the Overseer sets applies to that session only.**
  Whether it sets them on a session it creates (`sova_create_session`) or on one it acts on
  (`sova_set_session`), even one with no messages yet, the saved default new sessions start from is
  never changed: only the user's own pick saves one (§chat.model-menu/saved-default), and the
  default mode (`mode.json`) moves only as §chat/mode-menu says.
- **Archived sessions** take no prompt from the Overseer: `sova_send` refuses one and says that
  unarchiving it (`sova_archive`, itself an act, on the caps) comes first, as the UI's "Unarchive it
  to send" does for the user. The route itself is unchanged.

## §app.overseer/confirm — Decision cards

The Overseer asks with **cards**: `sova_card({card?, ops: [...]})`, a clone of the align tool's
model (§chat.alignment/card). A card is a small record the model creates and closes with ops; its
state is the tool results' snapshots, folded along the branch, and a click only composes a message.
The Overseer decides when a request is ambiguous or dangerous enough to ask. The prompt and the
tool's description tell it to write its reply first (what it found, the sessions as links, why it
asks), to name a card by its id, never "the card above", and to list in `items` every session,
idea, todo, person or project a card about specific things acts on (archive, tick, send, …), each
with a **note**: what it is, then why the action fits it, in at most 2 short sentences ("Push
notifications for Overseer briefs. Merged to master yesterday, nothing running."). That rule is the
prompt's; the server cannot tell such a card from any other, so it never requires `items` or notes.
When a button also acts on an idea or a todo, that item's note says the effect ("Covered by the
push session's final report. Ticking marks it done."), and every option's `reply` says exactly what
it does to which items, never just its label. These too are the prompt's and the tool description's.

- **Ids and handles.** Each card gets the next id `c_N` of its conversation (one past the highest on
  the branch; a new conversation starts at `c_1`), and never another. Its items are numbered 1..N in
  display order when it is created and never renumbered; its answer options are lettered a, b, c…
  in order, and so are its per-item choices. "c_4 b" is card c_4's option b; "c_4 2a" is its item 2
  taking choice a. Link options carry no letter.
- **The tool never ends the turn.** A call applies its ops to one card, atomically: if any op is
  invalid nothing changes and the error says why (a field another op takes is named). Ops:
  `create {title, detail?, options, items?, choices?, recommendation?, replaces?}` (alone in its
  call); `answer {text, option?, items?}` records the user's answer in their words, a card-level
  option by its letter, or per item (`{"2": "b"}` a choice letter, or the user's words); `accept
  {items?}` records "your recommendation" (the recommended option, or each named item's default);
  `reopen`; `drop {reason}`; and `get`. The result echoes the card, its lettered options and numbered
  items with their exact ids (sessions as `[title](sova://s/<id>)`, each followed by ` — <note>`),
  then the other open cards, and returns like any tool: the run goes on, so no call is ever held
  waiting for the user.
- **States: open, answered, superseded, dropped; only the model's ops move them.** A card-level
  answer, or every item decided, makes it answered; a partial per-item answer keeps it open with
  those items decided. `create` with `replaces: "c_3"` marks c_3 superseded by the new card in the
  same result. `drop` closes a card that no longer applies, with its reason; `reopen` makes an
  answered or dropped card open again. A later message, typed or clicked, never changes a card by
  itself: a card stays open until the model records it.
- **A hidden note every turn.** Every run a user message starts carries a hidden note (never in the
  thread, never the system prompt) listing each open card: id, title, lettered options, numbered
  items with their ids and names, choices, recommendation and any item already decided, and a line
  telling the model to record answers with `answer` or `accept` and to drop or replace a card that
  no longer applies. After a compaction the same note is written once, after the summary. The note
  is persisted, so it survives restarts, folds and compaction, and it never changes who a run belongs
  to (§app.overseer/tools). Typed replies ("2", "archive a and c, keep b") are mapped by the model,
  using the note; the server parses none.
- **Items.** `items` is `{sessions?, ideas?, todos?, people?, projects?}`, each a list whose
  entries are an id or `{id, note?, default?}`; a person or a project also names its org,
  `{org, id, note?, default?}`, by id or exact name, as the org tools take them
  (§app.overseer/org-tools). Sessions are addressed in
  any form the tools print them (§app.overseer/tools), and any session on this host will do (a
  card only points at it: TUI-live or archived is fine); ideas by their § id (a former id resolves
  to the idea it was renamed to); todos by their `td_` id. The server resolves every id when the card
  is raised. An id that matches nothing refuses the whole card, and the refusal names every such id
  by kind; so does a card with more than 50 ids. The same thing named twice shows once. A person
  or project of an org not attached here matches nothing.
- **Refusals.** Each of these refuses the whole card, and one refusal names every case at once: an
  id that matches nothing; the asking overseer's own conversation (any Overseer file; for a project
  overseer, its own); a note over 220 characters (whitespace collapsed), named with its item and
  length. Before any of that, a key in `items` other than the five lists refuses on its own, with
  an example of where an entry goes.
- **A snapshot.** The resolved rows are stored in the card, so the card shows what the Overseer
  asked about then, whatever changes later. A session row carries its title, its folder's short
  name, its last activity, its one-line summary when it has one, and how many subagents were working
  in it; a person row their name, status and org; a project row its name and org; every row carries
  its note when it was given one. Never a contact or a link (§app.overseer/org-projection).
- **Per-item choices.** `choices` (2 to 4 labels, lettered) apply to every item of any kind; an
  item's `default` is the choice it starts on and the recommendation for it. Each item row then
  shows a segmented control of the choices, set to its default, or to its decided choice once one is
  recorded; **Apply** sends one message for the items that have a choice, "c_4: 1a Archive, 2b Keep".
- **Link options.** An option with `link` (a session, a group, a page, a Settings tab, an org, a
  project, a person, or an `https` URL) is a link, not an answer. The server resolves it when the card
  is raised, with the same targets as `sova_navigate` (§app.overseer/navigation) plus `https` URLs;
  any other scheme and a URL with credentials refuse the card. It renders as a ghost button with an
  arrow, live in every state and in read-only views; clicking it sends no message, runs no turn and
  never answers the card. An in-app target opens in the same tab (Back returns to the Overseer); an
  `https` URL opens in a new tab (`noopener noreferrer`).
- The chat renders the newest snapshot of each card as the card in the thread: its id as the
  eyebrow ("c_4"), title, detail, the items, and its options, each with its letter; an earlier
  snapshot of the same card is one line (its id, title and what that call changed).
  - The items sit between the detail and the buttons, one compact row each, numbered: ideas, then
    todos, then projects, then people, then sessions. A project row is an in-app link to its project page,
    reading the project's name and, after it, the org's; a person row an in-app link to their page
    (§app.organizations/person-page), reading their name, then the org and their status chip when
    it isn't `Active`. A session row is an in-app link (resolved like a session link,
    §app.overseer/links) whose text is the session's summary, or its title when it has none (the
    title is the first prompt, which rarely names the work); then its folder and how long ago it was
    active ("sova · 3d ago"), and a warning chip ("2 subagents working") when it had working
    subagents. An idea row is its § id and title as plain text, never a link (§app.overseer/ideas).
    A todo row is its text.
  - Under each row, its note in body text (not muted), up to 2 lines and then clamped; a row
    without a note has nothing under it.
  - Ideas, todos, projects and people always show: a card's effect on them (ticking a todo,
    closing an idea, a person's links stopping) is never behind a toggle. Only sessions collapse: past 8 sessions the card shows the first 8 and a **Show
    all N sessions** toggle (Show fewer, open), so the rows it reveals are only ever sessions; a card
    with 9 sessions shows all 9, since hiding one row saves nothing.
  - The card's state comes from the fold, never from later messages: open (live buttons);
    answered ("You chose b — Archive all", or "Answered: <the user's words>"); "Replaced by c_7",
    a link to that card; dropped, with its reason. An item decided shows its choice or words.
- **Clicks compose a message.** An option's click sends "c_4 b: <its reply, else its label>" as the
  user's next message, marked as a click on c_4 (§app.overseer/org-people-facing). While the turn
  it started runs, the card shows "Sent: b" and its buttons wait; if the turn ends without an answer
  op, the buttons come back and the note keeps the card in front of the model. While the card is
  open, "Or type your answer." follows the buttons. A card that may gate an act that reaches people
  or ends something, the global Overseer's card listing a person, a project or a gathering session
  (`clickOnly`), has no such hint: only its click approves that act.
- **Approve-later and rule options.** An answer option may carry `at` (and `until`), which makes its
  click an approval for later, or `rule`, which makes its click adopt a standing rule; the button
  says so under its label, and the card shows the approval's state (§app.overseer/approvals).
- **The composer chip.** While the Overseer's thread has open cards, its composer shows a chip
  ("2 open cards") whose menu lists each one (id, title) and jumps to its card.
- **Hide tool calls never folds it.** The card is the Overseer's question, not its working, so
  "Hide tool calls" leaves it (and its result) in the thread, like the link card
  (§app.overseer/links-tools).
- Its title, detail, options and items never hold a secret value: the arguments are redacted before
  the card is built, so a card shows `[redacted]` in its place (§app.overseer/tools).
- **Cards from before ids.** A `sova_confirm` card in an older conversation is never folded and
  never feeds the note. It renders as it did, read-only: "You chose X" or "Answered below." when a
  later user message exists, else no live buttons and "From before card ids: ask the Overseer
  again."
- **The project overseer** raises the same card with the same tool: it says "the operator" where
  this one says "the user", and it resolves only the sessions it may read (the project's coding and
  gathering sessions, §app/project-overseer), its own ideas and its own todos; it takes no people,
  projects or org links.

## §app.overseer/project-card-clicks — Cards in a project overseer's chat

- In a project overseer's current conversation its open cards take clicks as the global
  Overseer's do: an option's click sends "c_4 b: <its reply, else its label>" as the operator's next
  message, the card shows "Sent: b" while that turn runs and its buttons come back when the turn
  ends, and "Or type your answer." follows the buttons. The click is only that message: it approves
  nothing and shows no approval state, since the project overseer's cards carry no `at` or `rule`.
- An earlier project overseer conversation stays read only: its cards show no live buttons.

## §app.overseer/caps — Limits and the audit log

- **Per user turn:** at most 5 sessions created, 10 prompts sent to other sessions, 50 archive
  operations, 2 explorers launched (§app.overseer/explorer), 3 links made
  (§app.overseer/links-tools), 20 organization writes (`orgWritesPerTurn`) and 3 gathering
  sessions or offers started (`gatherPerTurn`). **At once:** at most 10 Overseer-started sessions
  running (5 before; a settings file that stores its own number keeps it); a session a playbook
  schedule started or woke counts as Overseer-started, as a resumed one does (§chat.schedules/fire),
  and a fire with no slot free is skipped. All eight are
  configurable in Settings → Overseer; a settings file without the two new ones reads them as their
  defaults.
- **The running count shows.** While any Overseer-started session counts as running, the
  Overseer's composer shows "3 of 10 running" beside its chips, from the same count the cap
  checks, and the refusal and the prompt name Settings → Overseer → Limits. The text is a button
  that opens Settings → Overseer scrolled to Limits. The running-at-once refusal tells the model
  to tell the user in plain words which limit was reached and that it can be raised in Settings →
  Overseer → Limits.
- **What the organization caps count.** A gathering session or an offer started (`sova_gather`
  `start` and `offer`) takes one of the gathering cap. Every other organization act takes one org
  write, whatever it changes (a promotion of several decisions is one), except a message to a
  project overseer, which takes one prompt (§app.overseer/org-project-overseers), and a coding
  session it starts as a project's, which takes one session created and a running slot. A refusal
  takes nothing.
- **A user turn** starts when a message the user sent from the UI (typed, a quick action, a
  confirm-card click, a steer, or a regenerate) enters the Overseer's context. It is recognised by
  identity, not by its text: the chat runtime hands such a message to the SDK marked as the user's,
  and a user-role message starting in the context opens a user turn only when it is the message
  that send produced. So it still counts after an extension rewrites it (an attached image
  described into the text for a text-only model), after a `/template` expands, and while it waited
  in the queue; and a brief, a wake-up or an extension's message never counts, even with the same
  text as something the user sent. Each send counts once: a message queued from inside the run it
  started (a wake-up set during it) is not the user's. A user message the runtime holds back until
  the previous run has fully settled is not recognised and opens a read-only turn (it fails closed).
  Only a user turn (or `/clear`) resets the seven per-turn counters. A brief, a fired `wake_nudge`,
  an extension's message that starts a run and any other server-started run are unattended
  (§app.overseer/tools): read-only, on the budget of the user message before them, never a renewed
  one. The
  counters are kept in `<stateRoot>/overseer-turn.json`, so a server restart between a message and
  the wake-ups it scheduled does not renew them.
- **Running at once** counts Overseer-started sessions that are mid-turn or have subagents working,
  plus any the Overseer prompted in the last 15 s that have not yet been seen running, plus slots
  reserved by create/send calls still in flight. A session counts once: a send into a session that
  already counts (one the Overseer started and that is running now, or prompted within those 15 s)
  takes no new slot, and a send into any other session, running or idle, makes it count from then
  on, so it needs a free slot. A call reserves its slot before it does any work, so parallel calls
  in one message cannot all pass the check. A session the Overseer created on a peer with a first
  prompt counts while that peer reports it busy, and for 15 s after the prompt, as a local one does.
- Over a cap, the tool refuses with a message telling the model to stop and ask with `sova_card`
  or explain, and not to schedule a wake-up to carry on. Nothing partial happens past the cap.
- Every act tool call appends one line to `overseer-actions.jsonl`: time, Overseer id, tool call id,
  tool, arguments, outcome and error. The arguments and the error are redacted before the line is
  written (§app.overseer/tools), so the log never holds a secret value.

## §app.overseer/approvals — Approvals for later and standing rules

A run the user did not start is read-only (§app.overseer/tools), unless the user approved ahead of
time. Both kinds of approval come only from the user's click on a card option the Overseer proposed
(§app.overseer/confirm); the server writes them, and the model has no way to write one.

- **An approval for later (`g_N`).** A card option with `at` (when the Overseer means to act, e.g. a
  usage limit's reset) approves ahead of time: its click lets any run until the deadline do **any
  act on the sessions the card lists**. The deadline is the option's `until`, else one hour after
  `at`; `at` and the deadline lie ahead of the card and within 7 days of it. Such an option needs at
  least one session among the card's items. The button reads what it approves under its label
  ("Approves any act on these 3 sessions until 6:00 PM").
- **A standing rule (`r_N`).** A card option with `rule {text, acts?, any_session?}` proposes a
  standing instruction ("Send continue to a session after its usage limit resets"); its click adopts
  it. A rule lasts until revoked. It covers the acts it names (`sova_send`, `sova_set_session`,
  `sova_archive`, `sova_answer_dialog`, `sova_group`; all of them when it names none) on the
  sessions the card lists, or on any session with `any_session: true`. Its button reads "Adopts a
  standing rule: <text>".
- An option carries `at` or `rule`, never both, and never on a link option. Only the global
  Overseer's cards take them; the project overseer's refuse them.
- **Written by the server, on the click.** When the message a click composes enters the Overseer's
  context (the same exact-click test as the people-facing gate, §app.overseer/org-people-facing:
  the WS click mark, the card open, the text exactly what that click composes), the server appends
  a hidden custom entry to the Overseer's file (`overseer-grant` or `overseer-rule`: id, the card and
  option it came from, the sessions, the deadline or the rule's text and acts). Typed text, however
  it reads, writes nothing. Grants and rules are numbered per conversation and never reused.
- **`/clear` carries live rules, never approvals.** When `/clear` starts a new conversation
  (§app.overseer/identity-and-clear), the server copies each rule still live in the old one into
  the new file as an `overseer-rule` entry of its own: the same id, text, acts and sessions, the same
  card and option, and `from`, the id of the earlier conversation that card lives in (kept through
  later clears). The new conversation numbers its next rule past the carried ones. A revoked rule,
  an approval for later (`g_N`, live or not) and a rule's uses never carry, and the model still has
  no way to write one. In the panel a carried rule's "From c_3 a" links to that earlier
  conversation in the Overseer's history, not to a card in the thread.
- **Only whole coverage acts.** In a run the user did not start, an acting tool that targets
  sessions (send, set, archive, answer a dialog, a group's add or remove) first looks for one live
  approval or rule that covers the tool and every session it names: an approval whose deadline has
  not passed and that lists them all, or a rule whose acts include the tool and whose sessions
  include them all. With one, the act runs within the caps (§app.overseer/caps), and its result
  ends with "Done under g_2 (<its label>)." Without one, or for any act that names no session
  (creating a session, ideas, todos, links, organizations), the refusal is the unattended one. A
  run the user started never needs or uses one.
- **Every use is logged.** An act that ran under an approval or a rule appends a hidden
  `overseer-grant-use` entry (which one, the tool, the sessions, the tool call) and its line in
  `overseer-actions.jsonl` carries `under: <id>`. The prompt tells the Overseer to say "done under
  g_2" or "done under r_1" in the reply that reports it.
- **Revoke.** Revoking appends an `overseer-revoke` entry. A revoke is read from the whole file,
  never only the current branch, so rewinding the conversation never brings a revoked approval back.
  It applies from the next tool call on: an unattended run that starts after it finds nothing to act
  under.
- **The chip and its panel.** While the Overseer holds a live approval or rule, its composer shows a
  chip ("2 approvals · 1 rule"). It opens a panel listing each live one: what it allows (any act on
  the sessions, as links, until the deadline; or the rule's text, its acts and sessions), where it
  came from (a link to its card and the option letter), when it expires ("Until 6:00 PM", or "Until
  revoked"), its uses (the last one's time, and each use as a link to the act in the thread), and a
  **Revoke** button. There is no Settings page for them. The same chip and panel also count and list
  every playbook schedule, approved or not ("1 approval · 2 schedules"), each with **Approve
  Schedule** or **Revoke Schedule** (§chat.schedules/where-shown); the chip shows while there is
  one, even with no live approval or rule.
- **The card shows it.** An option whose click wrote one shows its state under the card's answer:
  "Approved until 6:00 PM (g_2)", then "Expired" or "Revoked"; "Rule r_1 adopted", then "Revoked".
- `GET /api/overseer/autonomy` returns the running count, the cap and every grant and rule of the
  current conversation with its state and uses; `POST /api/overseer/autonomy/revoke {id}` revokes
  one (404 for an id the conversation doesn't hold, 409 for one already ended).

## §app.overseer/auto-resume — Resuming runs a restart cut off

- **What counts.** The server keeps a small ledger of the runs its hosted chats have in flight
  (`<stateRoot>/runs-in-flight.json`: a session is added when a run starts and removed when it
  settles). A server stop freezes the ledger first, so the aborts of the stop itself remove nothing;
  a crash leaves it as it was. At the next start, every session still in it was cut off by that
  stop. Sessions stopped any other way (a usage limit, an error, the user's Stop) settle, so they are
  never resumed.
- **Resume.** A few seconds after start, with Settings → Overseer → Advanced → **Resume interrupted sessions**
  on (the default), each such session gets one message: "The Sova server restarted and cut off your
  last turn. Continue where you left off." marked as sent by the Overseer (§app.overseer/sent-marker)
  and counted as Overseer-started for the running-at-once cap (§app.overseer/caps). Never the
  Overseer, a project overseer, a baton session, an archived session, a session open in a terminal,
  or a session that is gone. Past the cap the rest are not resumed.
- **Once per stop.** The ledger is read and emptied at start, before any resume. A run the resume
  itself started that is cut off again is recorded as such and never resumed a second time.
- **Told once.** Under Brief Me (§app.overseer/proactivity) the Overseer gets one brief listing each
  session resumed and each one not resumed with why, as in-app links. Every resume is also a line in
  `overseer-actions.jsonl` (tool `auto_resume`).

## §app.overseer/session-names — How the Overseer names sessions

- **Summary-first.** Where the Overseer or the server writes a session's name for the user — a
  brief's links (§app.overseer/proactivity), `sova_attention`'s rows, the links in every tool result,
  a phone notification's title and lines (§app.notifications/delivery) and a card's echo of its
  session items — the name is the session's alias, else a title the user, the Overseer or Sova's
  auto-title set, else its one-line summary (the outline's gist, else its "now" line), else its
  title (the first message). The attention item carries it as `name`.
- **Aliases.** `sova_set_session {alias}` gives a session a short name the user chose ("overseer
  fixes"): at most 40 characters, one line, unique on this host (case-insensitive); an empty alias
  clears it. It is stored in Sova's own `<stateRoot>/session-aliases.json`, never in the session
  file. Every tool that takes a session also takes its alias, matched case-insensitively and
  exactly, and `sova_list_sessions` shows it. Setting one is an act (§app.overseer/tools).

## §app.overseer/links-tools — Linking sessions across hosts

Three tools let the Overseer make and end links between sessions on different hosts
(§mesh/links). The Overseer is never a member of a link.

- **`sova_link {members: [{host?, session}, …]}`** (an act) links two or more sessions, each by
  its host (a peer id; this host when left out) and session id. A peer's member is resolved on its
  own host by id (§mesh.links/by-id). It refuses, naming the member, a TUI-live session, an archived
  one, a worker's session, the Overseer's own, a baton session, a project overseer's session, any
  other organization's session (§app.session-list/organizations), a session on a host that is down or skewed, and a second member on the same host as another. There
  is **no confirmation card**: linking changes no session and sends nothing, so it is not
  destructive. Like every act it is refused in an unattended turn (§app.overseer/tools), counts
  against a per-turn cap of 3 links (§app.overseer/caps), and is written to the action log. The
  transcript shows the call as a card naming the members and their hosts; "Hide tool calls" never
  folds that card, or `sova_unlink`'s.
- **`sova_unlink {link}`** (an act) ends a link on every member host (§mesh.links/record).
- **`sova_links {}`** (a read) lists every link this host knows, with each member's host, state
  and last activity, ended links included and marked.
- **Creating a member on a peer.** `sova_create_session` takes an optional `host`; with a peer's id
  it creates the session on that peer, with the same caps and refusals. Title and first prompt go
  through the peer's own routes; a group can't be given with `host` (groups are per host); model,
  thinking, mode and minor modes are set through the peer's configure route
  (§mesh.links/configure) before the first prompt is sent, and a configure that fails sends no
  prompt, as on this host. A mode or minor modes it sets end up in the peer's session as the same
  `mode` entry a create on this host writes, even when they equal that host's default. That first prompt is not Overseer-marked (§app.overseer/sent-marker).
- Its peer calls never carry this host's sender secret.
- To say something to a member, the Overseer uses `sova_send` to a local member like any session; it never
  sends into a link.

## §app.overseer/sent-marker — Prompts the Overseer sent

- To the target session's model, a message the Overseer sent is an ordinary user message in plain
  text, whether it started a turn, was queued as a follow-up, or was a steer.
- Beside it, once it has entered the context, the server writes an invisible `custom` entry
  `customType: "sova-overseer-sent"` that names the user message's entry id. It is never LLM
  context, and the TUI ignores it. A queued message is marked only when it is handed to the agent,
  so a message the user types meanwhile with the same text is never taken for it; one that is
  removed, cleared by Stop, refused at hand-off or handled by an extension instead leaves no marker.
- While it waits in the queue, its row reads **Overseer** rather than "Sent by Sova" (the queue
  snapshot's `overseer` flag, set only for a message carrying the sender secret).
- The transcript renders an **Overseer** tag on that user row, on reload and live.
- **One mechanism, three senders.** Baton sessions attribute every user message the same way, with
  their own `sova-baton-sent` marker (§app.baton/attribution), and so does a session's
  `session_send`, with `sova-session-sent` (§chat.profiles/delivery); the pending-mark list, the
  queue hand-off rule and the settle sweep are shared, and each marker is written only for its own
  sender, with the bytes of the Overseer's and the baton's markers unchanged.
- **A project overseer's conversation too.** The one route that writes into a project overseer's
  conversation, the Overseer's message route (§app.overseer/org-project-overseers), marks every
  message it hands in the same way, with the same `sova-overseer-sent` entry, the same queued-row
  word and the same tag.
- **Only the Overseer can tag.** `POST /api/sessions/prompt` and that route mark a prompt as the
  Overseer's only when the request carries the server's sender secret: random, made at server start, held in memory
  only, never written to disk or sent to a client, and carried only by the Overseer's own in-process
  tool calls. Any other caller (a worker with `bash`, a script) gets an ordinary, untagged prompt,
  whatever header it sends.
- **Rewind and Regenerate work exactly as on any user row**: the marker changes nothing about
  the row's actions.
- **Never across hosts.** A first prompt the Overseer sends to a session it created on a peer is
  not marked: the marker is vouched for by this host's sender secret, which never leaves it.

## §app.overseer/dialog-answers — Answering other sessions' dialogs

- The Overseer may answer a hosted session's **live-pending** extension dialog (select, confirm,
  input). Headless dialogs with no browser attached resolve to their fallbacks on their own, so only
  dialogs pending right now can be answered. TUI-live sessions' dialogs are never answered.
- Each answer writes an invisible `custom` entry `customType: "sova-overseer-dialog-answer"`, and the
  transcript renders it as a machine row: **Overseer chose: {answer}**.

## §app.overseer/attention-digest — The attention digest

A server-side digest, built with no model call from live records, summaries, held-chat state, the
seen store and — when attention signals are on — the signals store (§app.decisions/attention-signals),
which it reads and never fills. It is memoised for about 3 seconds and never includes the Overseer
itself.

- **Needs you (act):** a dialog open (`activity.state` needs-input, own and foreign, or a hosted
  pending dialog); an errored turn (`turnError`, §app.overseer/seen, or `activity.state` error
  while a live record is up; one item either way, dated by the reply, its detail the error message
  — the file's first — else "The last turn stopped with an error."); a worker that ended in an error. A
  killed worker is left out: a kill is usually the user's own gesture. So is a worker the server's
  own restart ended: a worker this server restored (§app.worker-restore/restore) in its own
  runtime, whose recorded ending is an error at a time between the previous server's stop and this
  server's start, on any backend (a claude-code worker's "Claude exited before expected closure
  (SIGTERM)", a pi worker's "pi exited with code 143" alike). The stop is the moment the previous
  server began shutting down, which it writes to `<stateRoot>/server-stop.json` (`{v: 1, pid,
  at}`) before anything else; the next start reads it and deletes it, and allows it 5 s of slack
  (the workers die on the same signal). Without that file (a crash, or a stop by a server that
  predates it) the stop is taken as 30 s before this start. A worker error while the server keeps
  running is never one of these, and still shows. A worker error counts as
  seen once the session is on screen, or its seen stamp (§app.overseer/seen) is at or past the
  latest error; a new error after that raises it again. An error's time is its worker row's
  `endedAt` (else `lastActivity`, else `startedAt`); when rows were dropped from the live record
  for size, the time this server saw the error count rise stands in (in memory, so after a restart
  such an error shows again until the session is seen). A session never seen, or an error of
  unknown time, still shows. This holds for archived sessions too.
- **Needs you, open questions** (§chat.alignment/session-mark): an idle session that is not
  archived, whose `align` counts say it waits on the user's answers (align on, and no user prompt
  since the alignment last changed), is `open-questions` ("{n} open
  question(s) in {al_N} {title}" with one open alignment, else "… in {m} alignments"), dated by its
  last reply. It needs no signal and no model; it shows with the attention feature off too.
- **Only real blockers are act.** The act tier — Needs you, the Overseer's "need you" count, its
  briefs and phone notifications — is exactly: open alignment questions, open dialogs, errored
  turns, subagent errors, and the baton and roster hand-offs and held acts below. A guess (a
  reply that seems to ask, a team that seems stalled) and a branch ready to merge are decide
  items: a line in the digest and a quiet mark on the session's row, never a brief.
- **Nothing puts an item away.** The digest lists act items by the rules above and nothing else:
  no choice of the user's hides one. A `<stateRoot>/needs-you-later.json` left by an earlier
  version, whose choices once hid items, is deleted once when the server starts (best-effort; a
  failure is logged and never stops the start), so no old choice keeps anything hidden.
- **Finished (decide), from signals** (§app.decisions/attention-signals, only while the list carries them):
  `asks-you` when the last reply asks the user something (§app.decisions/asks-user) and the
  session has no `open-questions` item, "Asks you: {the asking sentence}", else "The last reply
  asks you something.", dated by the classification; `team-stalled` when the session waits on
  subagents that have all been quiet 15 minutes (§app.decisions/team-stall), "Waiting on {names},
  quiet for {n} min.", dated by when the quiet began. With the feature off, neither appears.
- **Finished (decide), from signals:** `looping`, one item per session, for its stuck subagents
  (two looping checks in a row; "A subagent looks stuck: {name}.", "Subagents look stuck: {a},
  {b}.", else "{n} subagents look stuck."; adding " The last turn looks like it went in circles
  too." when it does) or for its own last turn alone ("The last turn looks like it went in
  circles."). A stuck subagent is the parent session's item, never a blocker: the user acts
  through the parent. The names are stored with the signal and reach only the digest, never the
  session list or the feed. With the feature off, none of these appear.
- **Needs you, from a baton session** (§app.baton/needs-you): `baton-needs-you` while the baton is
  with the operator, "<from> → you: <question>", or while a person holds it through a hand-off no
  live link exists for, "Send <name> their link: <question>".
- **Needs you, a held act** (§app.project-overseer/holds): `held-act`, one per act a project's
  statechart holds before it reaches a person or the client's code, "{what} starts in {n} min unless
  you cancel it.", carrying the hold (`held: {id, goesAt, what}`) so the list can offer Cancel.
  Never a phone notification.
- **Needs you, a message not sent** (§app.outreach/send): `outreach-not-sent`, one per project
  overseer's WhatsApp send whose last outcome is refused, failed or unknown, "The WhatsApp message
  to {name} was not sent: {reason}.", opening the person's page, until a later send to that person
  in that project goes, or 7 days pass. Never a phone notification.
- **Finished (decide), a conflict for the operator** (§app.requirements/routing):
  `conflict-to-operator`, one per open conflict routed to the operator, or not routed, that no open
  settle session asks about: "Settle a conflict in {project}: {nameA} and {nameB} disagree about
  {area}.", linking to the project page. Never a phone notification.
- **Finished (decide):** replied since last seen and now idle; idle with an unsent draft or queued
  input.
- **Ready to merge (decide)** (§chat.worktrees/readiness): an idle, unarchived session with a
  worktree ready, "Ready to merge: {branch}", or ready and waiting for the go-ahead, "Waiting for
  your OK: {branch}". Never Needs you, a brief or a notification.
- **Merges (decide)** (§chat.worktrees/readiness): a merge the follow-up check
  (§app.decisions/merge-followup) calls significant, "Merged with open work: {cue}"; and one
  `restart-pending` item of no session, "Restart pending: {n} merge(s) changed the server since it
  started ({branches})", linking the newest such session.
- **FYI:** running now; context at or above 85%; idle web sessions older than 3 days that aren't
  archived and have no draft.
- Items are sorted by tier, then age, capped at 30 (every kind present keeps at least its newest
  item, which takes the place of the last kept item of the lowest tier, so a flood of one kind
  never hides another), each with at most 200 characters of detail and
  an in-app link. The `sova_attention` tool and `GET /api/overseer/attention` return it; the
  sidebar's Needs you region (§app.session-list/needs-you) lists its act tier, and the Overseer
  head's "need you" count is its count of sessions with an act item.

## §app.overseer/seen — The seen store and unread dots

- `seen.json` maps a session id to when a Sova chat or watch socket last **attached to or
  detached from** it. A view mounts only while it's on screen, so an open socket is the proxy for
  "the user had it in front of them". This is imperfect for background tabs.
- **The last finished reply** is read from the end of the session file (at most its last 256 KB),
  in file order, not along the active branch: after a rewind it can be a reply the head no longer
  shows. A reply that leaves the turn open — pi's `stopReason` `toolUse`, `pending` or `deferred` —
  is skipped for the one before it. Its time, its `stopReason` and, for `error`, the first 300
  characters of its `errorMessage` are kept per file (size and mtime).
- `SessionSummary.unread` is set when that reply is newer than the stamp, the session is not
  mid-turn, and no pane of this server has it open. Any session with a stamp qualifies, whatever
  its origin (web, TUI, external); a session never stamped is never unread, so the whole archive
  does not light up. The sidebar row shows an **unread dot**, except for the session this tab is
  showing.
- `SessionSummary.turnError` (`{ message? }`) is set when that reply's `stopReason` is `error`,
  the session is not mid-turn (not busy in this server, no live record saying working: pi may be
  between auto-retries), no pane has it open, and it has not been seen since that reply. Unlike
  `unread`, a session **never stamped shows it**: a blocker errs on the side of showing. It clears
  exactly like the dot: opening the session stamps it, and the next finished reply replaces what
  it judges. An aborted turn (`aborted`, the user's own stop) is no error; neither is a failed
  tool call in a turn that ended `stop`. It needs no decisions feature and no model call. The row
  shows it as a red mark in the dot's place (§app.session-list/anatomy), the digest as an act
  `error` item (§app.overseer/attention-digest), and the session feed pushes it like the decision
  marks (§app.decisions/push). A worker's failure stays the digest's `worker-error`.
- The Overseer's own unread assistant messages give the entry button's **unread count**, its only
  badge (§app.overseer/entry-button).

## §app.overseer/navigation — Navigation

- `sova_navigate({to})` validates the target and returns `{href, label}`. It has no other effect.
  Targets: `#/s/<path>`, `#/g/<id>[/<path>]`, `#/usage`, `#/agents[/<team>]`, `#/overseer`,
  settings sections as `settings:<tab>[/<section>]`, and the global Overseer's org pages: an org,
  one of its projects, or a roster person (`#/orgs/…`, §app/organizations), each by id or exact name
  as the org tools take them. The same resolver builds a card's link options
  (§app.overseer/confirm), which also take an `https` URL without credentials.
- The Overseer's chat view applies it (`location.hash = href`, or opening Settings on that tab)
  **only in the tab that started the running turn**: the tab whose own send went straight to the
  model, or whose queued send was delivered. Other tabs, other devices, reloads, and proactive turns
  never move.
- The tool card always shows a **Go** link to the same target, so history and other tabs can follow
  it by hand.

## §app.overseer/links — Session links

In Overseer messages, `sova://s/<id>` and `sova://g/<groupId>` links render as **in-app** links:
same tab, no new-tab glyph. The client resolves the id to the session's route from the session list.
A session id the list doesn't carry (or a list not loaded yet) still links, by id (`#/sid/<id>`):
an unlisted id is not proof the session is gone. Opening it asks the server, which swaps in the
session's route, or says "That session is gone." and goes back to `#/`. An unknown **group** id
renders as its text, unlinked.

A card's link option (§app.overseer/confirm) opens an in-app target the same way, in the same tab
(so Back returns to the Overseer on the phone), and an `https` URL in a new tab, with
`noopener noreferrer`; neither sends a message or runs a turn.

## §app.overseer/quick-actions — Quick actions

- **One button, Quick Actions,** sits at the right end of the Overseer's composer foot, in the
  slot the mode switch holds in every other chat (the Overseer has none, §app.overseer/hosting).
  It opens a flyout listing the quick actions, each with its label and a short description.
  Picking one sends its prompt (queued as a follow-up while a turn runs).
- While the composer is disabled the button still opens, and each quick action carries the
  disabled reason instead of running.
- Defaults: **What Needs Me**, **What Finished**, **What's Running**, **Tidy Up**, **Where Was I**.
- They are editable in Settings → Overseer (label, description, prompt; add, remove, reorder,
  reset to defaults).

## §app.overseer/head-layout — The head at every width

The Overseer page's head is one row at every width, and it changes by the width of **its own
box**, never the window's, so a phone, the Galaxy Z Fold's two screens and a narrow desktop pane
(a wide sidebar, an open side pane) get the same rules. The widths are the head's inner width,
inside its padding, as for the context readout (§chat.context-window/width-budget). From a 344px
head to 1600px nothing in it is clipped, covered or scrolled sideways, the title reads "Overseer"
in full, and every control on the row is at least 44px wide. The rules below never move the
head's height, so a width change is no layout shift.

- **Wide, 900px and up.** Back (below a 768px window only, as on every chat head), the title and
  meta line, the context readout (§design.copy-deck/context-window; its ring and "222k / 1M"), the proactivity cycle (a bell and the current mode,
  §app.overseer/proactivity), **Ideas** and **Todos** with their icons and counts, **History** ▾ and
  **Clear**. No ⋯.
- **Medium, 660 to 899px** (the Fold's inner screen held upright, about 704px; a desktop window
  about 1024px wide): History and Clear leave the row for **⋯**. The proactivity cycle keeps its
  bell and mode; Ideas and Todos keep their words and counts, without their icons. The context
  readout drops its window below a 720px head ("222k").
- **Narrow, below 660px** (phones and the Fold's cover screen): the proactivity cycle leaves the
  row too. Ideas and Todos are their icons with the count as a corner badge. The row is back, the
  title and meta, the context readout, Ideas, Todos and ⋯.
- **⋯** ("Overseer actions") holds the same three items wherever it shows: **Proactivity…** (its
  note the current mode), **History…** (its note "{n} earlier" while there are any) and **Clear**
  (its note "Start a new conversation. This one moves to History."). It keeps an 8px gap from the
  control before it. Proactivity… opens a screen of the three modes, each with its hint and the
  current one checked; choosing one saves it exactly as the cycle does, and says so. History…
  opens a screen listing the earlier conversations as the History menu does, or "No earlier
  conversations yet.". Clear is the head's Clear action.
- **The mode is never a bare word.** On the row the proactivity cycle shows the mode with its
  bell; below 660px it is off the row, and ⋯ names it under Proactivity….
- **The meta line** says what the Overseer watches, in plain text: "{n} sessions · {w} working ·
  {a} need you", each part after the first only when it is not 0. `{a}` is the digest's count of
  sessions with an act item (`OverseerInfo.badge.act`, §app.overseer/attention-digest), the
  sessions the sidebar's Needs you region lists (§app.session-list/needs-you). It carries no
  menu: who replied since you last looked is each row's unread dot (§app.overseer/seen), and a
  session with an unsent draft is marked in the list. From a 660px head up the row leaves it at
  least 220px, so "181 sessions · 5 working · 2 need you" (about 218px) shows in full; below that, or when it is
  longer, it ends in "…".
- **Context.** The context readout stays on the row at every width, as on every chat head
  (§chat.context-window/width-budget): the ring and "222k", with the window ("222k / 1M") from a
  720px head. No percent shows; it is in the readout's `title`. The meta line carries no context.
  Below a 360px window (a 320px phone) the row's gaps close to 2px and its side padding to 4px,
  so back, the title in full, the readout, Ideas, Todos and ⋯ still fit without clipping.
- **An earlier conversation** (`#/overseer/h/<id>`): back, its title and age, and History ▾ at
  900px and up; below that, ⋯ holding History… only.

## §app.overseer/entry-button — Entry button

- An **eye** icon button (aria-label "Overseer") sits in the session-list search row, beside the
  filter. It is **removed** while the filter is focused or has a query, and comes back on blur with
  an empty query. On a phone, where the search opens inline in the list's one toolbar line
  (§app.session-list/search), it is also removed for as long as that search is open.
- The collapsed spine carries the same button.
- **Alt+O** opens the Overseer from anywhere.
- **Badge:** one count, top-right in the accent pill (`.overseer-entry-count`, "99+" past 99): the
  Overseer's own assistant messages the user hasn't seen (`OverseerInfo.unread`,
  §app.overseer/seen). It is 0, and the badge gone, while `#/overseer` is the route, and it shows
  whatever the proactivity: these are the Overseer's messages, not an attention count. The eye
  carries **no** attention count and no finished dot — who is blocked on you is the sidebar's
  Needs you region (§app.session-list/needs-you). The badge is `aria-hidden`; the button's
  `aria-label` is "Overseer", or "Overseer · {n} new message(s)" while it shows, and its `title`
  adds " · Alt+O". The button is tinted as selected while `#/overseer` is the route.

## §app.overseer/proactivity — Proactivity

Three modes, set on the Overseer page and in Settings: **Off**, **List Only** (default),
**Brief Me**. On a head 660px and wider a control in the head shows the current mode and cycles to
the next; below 660px it is ⋯ → Proactivity…, three rows with their hints and the current one
checked (§app.overseer/head-layout). The ⋯ item is there at every width ⋯ shows.

- **Off:** no Needs you region in the sidebar (§app.session-list/needs-you), no briefs. The entry
  button's unread count is unaffected; the Overseer chat still works. Hint: "No Needs you list. The
  Overseer chat still works."
- **List Only:** the sidebar's Needs you region only; the Overseer sends no message. It costs no
  tokens. Hint: "Lists the sessions that need you in the sidebar. No messages from the Overseer."
  (The wire value stays `badge`.)
- **Brief Me:** the Needs you region, plus a brief. Hint: "The list, plus an Overseer message when
  something new needs you, at most once every 10 minutes." When a **new** needs-you item appears and the Overseer is idle, the server starts
  one Overseer turn, at most once per 10 minutes. Its prompt (the blockers' titles and details, from
  other sessions) is redacted like any tool output (§app.overseer/tools); it is tagged `[overseer-brief]`, renders
  as a machine row ("Brief · <time>") with its body under it as markdown (the blockers as a list, each
  an in-app session link named summary-first, §app.overseer/session-names), and never navigates any tab. A brief turn is not a user turn: it is
  read-only (§app.overseer/tools), so it can report and offer a `sova_card` card but never act,
  and it renews no caps (§app.overseer/caps). Brief Me also sends one brief when Sova first finds a
  playbook schedule that needs approval (§chat.schedules/where-shown).

## §app.overseer/standing-notes — Standing notes

`overseer-notes.md` holds standing instructions that survive `/clear`. The `sova_note` tool
appends to it or replaces it, and it is editable in Settings → Overseer. `sova_note` stores a
secret value as `[redacted]` (§app.overseer/tools); a user's own edit is stored as typed, and reaches
the prompt redacted. Its text is included in the Overseer's prompt (capped), read again at the start of every run, so an edit applies from the next
run (§app.overseer/hosting). No Settings save deletes a note `sova_note` wrote: a save leaves the file
alone unless the user edited the notes; a note the Overseer appended meanwhile is kept after the
user's edit; and if the Overseer rewrote them meanwhile the save refuses and says so. `PUT
/api/overseer/notes` takes an optional `base` (the text the edit started from) and answers 409 with
the current text when the file no longer holds it.

## §app.overseer/ideas — The ideas backlog

The user piles ideas onto the Overseer in plain chat, with no special syntax. The Overseer files
them and keeps them organised. The backlog is laid out like this spec, with its own small reader.

- **Inference.** A message that describes work for later ("someday…", "it'd be nice if…", a feature
  thought with no ask to do it now) is an idea: the Overseer files it, says so in one line, and
  starts nothing. A message that asks for work now is a request, handled under the other rules.
  A one-line task for the user themselves, with no design in it, is a todo (§app.overseer/todos).
  When it can't tell, it asks with a `sova_card` card ("File as idea" / "Start now") and waits for
  the answer.
- **Similar ideas first.** Before every filing or addition, it searches the backlog (`sova_ideas
  search`), even when the table of contents seems to show the match, and says in one line where
  the idea goes: added to an existing idea (by its § id) or a new entry, linked to related ones.
  Ideas are named by their § id as plain text, never as a link.
- **Layout.** `<stateRoot>/ideas/manifest.json` (`{formatVersion: 1, ideas: {<§id>: record}}`) plus
  one prose file per idea: main entry `§<ns>/<name>` in `ideas/<ns>/<name>.md`, sub-entry
  `§<ns>.<parent>/<name>` in `ideas/<ns>/<parent>/<name>.md`, whose main entry `§<ns>/<parent>`
  must exist. The namespace is the project (`§mesh`, `§sova`); themes are tags; relations,
  across projects too, are links. Segments are lowercase letters, digits and `-`. The `§` is
  canonical; tools and routes accept an id without it.
- **Record:** a one-line title, status, tags, links (other ideas' § ids), an optional linked
  session id, an optional explorer worker id with the Overseer conversation that owns it, and
  created/updated times. The `.md` is the idea's text, growing as the user works it out.
- **Status:** `open` when filed; `exploring` once an explorer is linked; `started` once a session is
  linked; `done` and `dropped` only when the user says so. `dropped` is terminal. Nothing is ever
  deleted.
- **Rename** (`sova_idea rename`, `id` and `new_id`; or the id field of the panel's Edit form)
  gives an idea a new § id, under the same grammar as filing, in any namespace and whatever its
  status. The record keeps everything else: title, status, tags, text, links, session, explorer
  and its created time; its updated time moves. The prose file moves with it. A main entry's
  sub-entries move with it (each `§<ns>.<old>/<x>` becomes `§<ns>.<new>/<x>`, their folder
  included). Every other idea's link to a moved id, and every todo's idea link to one, is
  rewritten in the same operation; those ideas' updated times do not move. The old id stays on
  the record as a former id (`renamedFrom`, the latest 8): reading, linking or pointing a todo at
  it reaches the renamed idea, and a read through a former id says it was renamed. Filing a new
  idea under a former id is refused, and so is a rename to an id that is live or another idea's
  former id; renaming back to the idea's own former id is allowed. A main entry with sub-entries
  cannot become a sub-entry, and a sub-entry's new main entry must exist. The text of other ideas
  is never rewritten: the rename's result names the ideas whose text still mentions the old id.
- **Writes** are atomic tmp+rename, and the manifest is re-read before every write. Reads are
  tolerant: a missing or corrupt manifest reads as empty, a bad record is skipped, and a link to an
  idea that doesn't exist is ignored. A write refuses a link to itself or to an unknown idea.
- **Graph.** Links are directed edges. `sova_ideas` offers `toc`, `search`, `get`, `scope` (the idea,
  its sub-entries and everything it reaches through links, transitively, cycles included once) and
  `impact` (the ideas that link to it), so the Overseer pulls linked ideas in mechanically.
- **Two tools.** `sova_ideas` reads and is allowed in every run. `sova_idea` changes the store (`add`,
  `append`, `update`, `link`, `rename`, `explore`, `tell`). It is an act: audited, and refused in runs the user
  did not start (§app.overseer/tools), so a brief or a worker's report never files an idea in the
  user's name. The Overseer is the only writer apart from the user's own edits in the Ideas panel
  (§app.overseer/ideas-panel). An idea becomes a session only in a user turn, through
  `sova_create_session` under the caps; the Overseer then links the session to the idea. It uses a
  folder only when exactly one listed folder clearly matches the idea's project; otherwise it asks
  with the candidate folders, and it never guesses.
- **Prompt.** The Overseer's prompt carries only the table of contents: per namespace its counts
  and one short line of entries, never an idea's text. An unchanged backlog renders the same bytes
  (§app.overseer/hosting). Arguments and results are redacted like every Overseer tool's.

## §app.overseer/explorer — Exploratory agents

When the user keeps expanding an idea, the Overseer offers to launch an **explorer**: a subagent
for that idea that plans with the user and edits nothing.

- **Launch** (`sova_idea explore`) only in a user turn, at most `explorePerTurn` per turn (default 2,
  §app.overseer/caps). Backend, model and effort come from Settings → Overseer → Advanced → Idea explorer
  (default Claude Code, `opus[1m]`, effort medium). The explorer is seeded with the idea's text and
  its scope (linked ideas), and has read-only tools and a prompt that forbids changing files. Its
  worker id and the Overseer conversation are recorded on the idea, and the status becomes
  `exploring`. An idea whose explorer is live refuses a second launch, and a done or dropped idea
  refuses one.
- **Explorers never run Claude Opus 5** (`claude-opus-5`): Settings refuses it for the explorer.
- **Its reads are not guarded.** Its prompt forbids opening credential files and quoting secrets,
  but its file tools are an ordinary subagent's, without the Overseer's file guard. What it reports
  reaches the Overseer redacted (§app.overseer/tools).
- **It is the Overseer conversation's worker.** It appears among that session's subagents, and it
  ends with it (`/clear`, a server restart). A message to an explorer that belongs to another
  conversation or is gone refuses and says to launch again; the Overseer then offers a new one and
  never relaunches unasked. Listings mark an earlier conversation's explorer as ended. The idea
  keeps `exploring` until the user changes it: an explorer ending never writes the store.
- **Multiplexing.** The user may discuss several ideas at once. The table of contents in the
  prompt marks which ideas have an explorer in this conversation, so the Overseer routes each
  follow-up to its idea's explorer (`sova_idea tell`, counted as a prompt against the caps). When
  it can't tell which idea a follow-up is about, it asks. It never states an explorer's state or
  findings without reading it (`sova_ideas explorer`) in that turn.
- **Write-back.** Only the Overseer writes the store. An explorer's report reaches the Overseer as
  a worker report, which starts an unattended run. There it summarises the plan and raises a
  `sova_card` card to write it into the idea. The user's click starts a user turn, and the plan
  is appended to the idea's `.md` (`sova_idea append`). `sova_ideas explorer` reads an explorer's
  latest reply at any time.
- **Renamed ideas.** An explorer launched before its idea was renamed keeps the old id in its name
  and instructions; `tell` and `sova_ideas explorer` follow the idea's record, so they still reach
  it, and the rename's result says so.

## §app.overseer/ideas-panel — The Ideas panel

An **Ideas** button in the Overseer page's head, with the idea count, opens a panel: beside the
chat on a wide window, over it on a narrow one. Below a 660px head the button is its icon with
the count as a corner badge, so the head still fits (§app.overseer/head-layout).

- **Table of contents** grouped by namespace, with counts, one row per idea (sub-entries under their
  main entry) and a status chip each.
- **Detail** of the chosen idea: its text as markdown, tags, links, what links to it and its scope,
  each linked id opening that idea. Title, id, status, tags, links and text are editable; a new id
  is a rename (§app.overseer/ideas), refused with the reason when it is taken or malformed. A save sends
  the updated time it started from, and when the idea changed meanwhile it keeps the edit and says
  so rather than overwriting (`PATCH /api/overseer/idea` answers 409 with the current idea).
- **Graph**: the ideas as nodes grouped by namespace, links as arrows; choosing a node opens it.
- **Explore**, **Ask the Explorer** (once it has one) and **Start a Session** on an idea each send a
  normal user message to the Overseer ("Explore idea §x: launch an exploratory agent for it.",
  "What has the explorer for idea §x found so far?", "Start a session to work on idea §x."). The
  turn is the user's, so the rules and caps apply.
- It re-reads the backlog after every Overseer turn and when opened. The open idea follows a
  rename, its own or the Overseer's, to the idea's new id.


## §app.overseer/todos — The user's todos

Besides ideas, the user keeps a short checklist on the Overseer page: concrete small tasks for
themselves, not for a session ("revoke the GitLab token", "reply to Dana"). The Overseer keeps it
from chat, and the user edits it in the Todos panel (§app.overseer/todos-panel).

- **Todo, idea or request.** A todo is one small, finishable action the user means to do, with no
  design in it. An idea is a feature thought for later (§app.overseer/ideas); a request asks for work
  in a session now. "Remind me to…", "add a todo" or a checklist the user dictates is a todo. When a
  message could be a todo or an idea, the Overseer prefers the todo when it fits in one line and
  needs no session, and asks with a `sova_card` card when it can't tell. It keeps the user's
  words, says what it added in one line, and never turns a todo into a session or an idea on its own.
- **Layout.** One file, `<stateRoot>/todos.json`: `{formatVersion: 1, todos: [record…]}`, in list
  order. A record has an opaque id (`td_` and 8 lowercase letters or digits), its text (one line,
  whitespace collapsed, at most 200 characters), done or not, created and updated times, the time
  it was ticked while it is done, and optionally the § id of an idea and the id of a session it is
  about. The list holds at most 200 todos.
- **Links.** An idea link must name an idea that exists when it is written; a renamed idea's former
  id links the idea itself. A todo's idea link follows the idea when it is renamed. A session link is a
  pointer, never an act on that session, so any session may be named, a TUI-live or archived one
  included.
- **Writes** are atomic tmp+rename, and the file is re-read before every write. Reads are tolerant:
  a missing or corrupt file reads as an empty list; a bad row, a duplicate id or an idea link that
  doesn't parse is dropped. An edit that sends the updated time it started from, when the todo
  changed meanwhile, is refused with the current list (a 409). Unlike ideas, todos are deleted:
  one at a time, or every done one at once.
- **Two tools.** `sova_todos` reads (open by default, done or all, each row with its id and links) and
  is allowed in every run. `sova_todo` changes the list (`add`, `check`, `uncheck`, `edit`, `remove`,
  `clear_done`). It is an act: audited, and refused in every run the user did not start
  (§app.overseer/tools), ticking included, so a brief, a wake-up or a worker's report never ticks the
  user's task. Ticking an already done todo, or unticking an open one, changes nothing and says so.
- **Ticking is the user's.** The Overseer marks a todo done only when the user says it is done.
  When it or a session did the task, it says it looks done and offers to tick it; in a read-only run
  it raises a `sova_card` card for that. It removes a todo only when the user asks, and clears the
  done ones when the user asks to tidy.
- **Prompt.** The Overseer's prompt carries only the counts ("3 open, 1 done"), never a todo's text,
  so an unchanged list renders the same bytes (§app.overseer/hosting). Arguments and results are
  redacted like every Overseer tool's, so a secret value in a todo is stored as `[redacted]`.

## §app.overseer/todos-panel — The Todos panel

A **Todos** button in the Overseer page's head, next to Ideas, with the count of open todos, opens a
panel in the same place as the Ideas panel: beside the chat on a wide window, over it on a narrow
one. Below a 660px head the button is its icon with the count as a corner badge
(§app.overseer/head-layout). One of the two panels is open at
a time: opening one closes the other. Escape or the close button closes it and returns focus to the
button.

- **Add.** A field at the top: Enter adds the todo at the end of the list; a refusal (too long, the
  list full) shows under it and nothing is added.
- **Rows.** Open todos first, in the user's order: a checkbox, the text, the linked idea's § id and
  the linked session (a link to it) under the text, **↑** and **↓** to move it among the open todos
  (the first can't go up, the last can't go down), and **×** to remove it, with no confirmation (the
  removal is announced to screen readers). Focus stays on the moved row's button, and after a tick
  or a removal it goes to the next row.
- **Edit in place.** The text is a button that becomes a field: Enter or leaving the field saves,
  Escape cancels. A save sends the updated time the edit started from; when the todo changed
  meanwhile, nothing is saved, the edit stays in the field and the panel says what the todo reads
  now; saving again replaces it.
- **Done.** A ticked todo moves under a collapsed **Done (n)** section, struck through, where it can
  be unticked or removed; **Clear Done** removes every done todo.
- **Fresh.** It reads the list when opened, every 10 seconds while open, and after every Overseer
  turn, so a todo the Overseer adds mid-turn appears within one read. Every write answers with the
  whole list, which the panel shows as it is.
- Its foot names the file it is stored in.

## §app.overseer/org-tools — Organizations: what the Overseer sees and runs

The Overseer sees and runs this host's organizations (§app/organizations) for the user: their
projects, rosters, gathering sessions, decisions and project overseers (§app/project-overseer).
It does so through its own `sova_*` tools, one read and one act per kind of thing, never through
the files: the workspace repos are closed to its file tools (§app.overseer/tools).

- **This host's orgs only.** Only orgs attached here (§app.organizations/registry). No org tool
  takes a `host`: a peer's orgs are never listed, read or changed, and a peer never reaches this
  host's org tools.
- **Reads:** `sova_orgs` (every org, or one), `sova_org_project` (one project and its overseer),
  `sova_org_person` (one roster person), §app.overseer/org-reads. What they carry is one
  projection, §app.overseer/org-projection.
- **Acts:** `sova_org`, `sova_org_project`, `sova_roster`, `sova_owner` and
  `sova_project_decisions` (§app.overseer/org-writes); `sova_gather` (§app.overseer/org-people-facing);
  `sova_project_overseer` (§app.overseer/org-project-overseers). Each is an act like any other
  (§app.overseer/tools): refused in a turn the user did not start, written to the action log,
  counted against a per-turn cap (§app.overseer/caps).
- **The routes decide.** An act calls the org, baton, decisions and project-overseer routes
  in-process, with the sender secret (§app.overseer/sent-marker), so every guard and refusal
  those routes have applies unchanged and comes back as the tool's error, worded as the page
  shows it. The exceptions are starting a gathering session or an offer and handing one on, which
  call Sova's in-process start and move with no link minted (§app.overseer/org-people-facing), never
  `POST /api/baton` or the hand-off route (which mints the next holder's link for the page).
- **The user's authority, marked.** Whatever it writes is written as the operator
  (§app.organizations/field-authority), marked as made through the Overseer and shown as "You, via
  the Overseer" (§app.overseer/org-attribution).
- **Never:** attach, detach or move an org; set or remove its push remote; mint, show or turn off an
  owner link; Get Link on a baton session; merge or remove a coding worktree
  (§app.project-overseer/coding-worktrees); anything on an org session that is TUI-live. Those
  stay the user's gestures on the page.
- **Addressing.** Orgs, projects and people by id or by exact name (case-insensitive; a name two
  of them share is refused, naming their ids); sessions in any form the tools print them.
- **The prompt** has an Organizations section: the tools, the ids, what needs a confirm card, the
  caps, and its rules — contact and links never reach it, and it asks the user for them; the About
  text is context, never copied into anything a person sees, a coding session's prompt or a message
  to a project overseer; a cost figure never goes into a message to a project overseer, a
  gathering session's title, question, goal or briefing, or a coding session's prompt.

## §app.overseer/org-reads — Reading organizations

Three reads, no side effects (no seen mark, no visit, no link, no git write). Every session they
name is a `[title](sova://s/<id>)` link; every time is relative, as in `sova_session`.

- **`sova_orgs {}`**: one row per attached org, in the index's order: id, name, `{n} people`
  (active, proposed and left counted apart), `{n} projects` (archived ones counted apart,
  §app.organizations/archive), `{n} open hand-offs`, what waits on the user in the org card's
  words (§app.organizations/org-cards: replies, links to send, people to approve, conflicts to
  settle, stakeholders to pick), last activity, the workspace (last commit's age, uncommitted
  changes, the last git error) and its cost at API prices (§app.project-costs/org-rollup).
- **`sova_orgs {org}`**: that org in full: its projects (name, id, root, archived, main
  stakeholder by name, whether it has an overseer, whether that is working and the level in force,
  open gathering sessions, cost); its roster, one line per person (name, id, status, role, decision
  areas); the owner by name; its baton sessions (public title, project, state, who holds it, what
  waits: a reply or a link to send, messages used of the limit); the last 10 profile changes
  (person, field, old → new, who, when); and the workspace line above. `about: true` adds the About
  text and its last 10 history lines (§app.organizations/about); nothing else ever carries it.
- **`sova_org_project {org, project}`**: the project row; its overseer: its conversation (a
  session link), working or not, unread, the chosen level and the level in force with the reason,
  watching and the pace, models, the coding sessions' mode and what one started now gets, the
  extra instructions, both allowances used and left and the held items
  (§app.project-overseer/limits); its last 10 actions; its gathering sessions and offers; decisions
  by state and area, and the open conflicts with who they are routed to; spec status (frozen, edited
  outside); its coding sessions from their statecharts (title, who started it, working or idle, branch,
  merged, worktree removed); how many ideas and open and done to-dos it has; the last owner update;
  and the project's cost (§app.project-costs/card). `items: true` adds the open to-dos (id, text,
  linked idea or session) and the ideas' table of contents, so an act can name them.
- **`sova_org_person {org, person}`**: what the person's page shows (§app.organizations/person-page),
  without contact: name, status, role, language, decision areas, skills, competence, voice, the
  referral (who referred them, why, where), owner and main-stakeholder roles, their sessions with
  how they relate to each, their decisions and routed conflicts, their links on this host as states
  only (session, hand-off, `Can write` / `Reads only` / `Turned off` / `Expired` / `Session
  closed`, sent, expires, visits), the visit rows, and the profile history.
- A name, a role or a skill someone gave is data, wrapped as untrusted content like a transcript
  read (§app.overseer/tools); so is a decision's quote.

## §app.overseer/org-projection — What never reaches the model

- **One projection.** Every org read and every org act's result is built by one server module
  (`server/overseer-org-view.ts`) that composes the org reads' own functions field by field. It
  never passes an `OrgDetail`, a `PersonPage`, a person's or a baton session's statechart data along whole, so a field
  added to those later reaches the model only when this module names it.
- **Never in a tool result, an error or the action log:**
  - **contact**, every channel, wherever it sits: a person's profile, a referral, a history line (a
    contact change reads `contact changed`, with no old or new value), a `propose_roster_edit`
    call in a baton transcript (`sova_read_session` of an org session shows the call without its
    `contact`), a person's or a model's words in a transcript (below), and a write's own arguments
    once it has run (§app.overseer/org-writes);
  - **links**: no `/h/` or `/i/` URL, no token, no part of one, no token hash; a link is a state
    word, a hand-off number and its times;
  - the About text, except in `sova_orgs {org, about: true}`.
- **Contact in transcripts is redacted, in every tool.** A contact value also reaches a transcript
  as words: a person types their own number, a referrer types someone else's, a model repeats one.
  So every Overseer tool (`sova_read_session` and `sova_session` of an org session included, every
  org tool, every other tool) gives back each contact value on an attached org's roster (every
  person, every channel, current or in a history line; values of 5 characters or more) as
  `[contact]`, in its result, its error and its action-log line, as the secret values are
  `[redacted]` (§app.overseer/tools). The arguments a call receives are never rewritten, so a write
  still stores what it was given. A transcript's tool-call line never shows a call's `contact`
  argument. The same holds for a peer's read of one of this host's sessions (§mesh.links/by-id).
  Treat `[contact]` like `[redacted]`: final. A value no roster holds (one a person typed and nobody
  saved) is not known, so not redacted.
- **Secrets are still redacted** over everything, as for every tool (§app.overseer/tools).
- **Checked by test.** A marker test plants a contact value, a link token and an About text in a
  hermetic org, drives every org read and act, and `sova_read_session` and `sova_session` on its
  baton sessions (one whose person typed the contact value into their message), and finds none of
  them in any result, error or action-log line, except the About text in that one read.

## §app.overseer/org-writes — Changing organizations

Every op is an act (§app.overseer/org-tools), attended only, counted as one org write
(§app.overseer/caps) unless it says otherwise, and answers with what changed in the page's words.

- **`sova_org {op}`**: `create {name}` (in the default workspaces folder; no other folder),
  `rename {org, name}`, `about {org, text}` (a blank text removes it) and `revert_about {org, at}`
  (§app.organizations/about), `commit {org}` (Commit Now, §app.organizations/workspace-repo). The
  result of `about` names the text's length, never the text.
- **`sova_org_project {op}`**: `add {org, name, root}`, `edit {org, project, name?, root?,
  stakeholder?, owner_hidden?}` (a stakeholder by id or name, or `none`), `archive {org, project}`
  and `unarchive {org, project}` (§app.organizations/archive; archive asks first,
  §app.overseer/org-people-facing).
- **`sova_roster {op}`**: `add {org, name, role?, decides?, skills?, language?, voice?, contact?}`
  (an active person), `edit {org, person, …fields}` (never `status`), `approve` and `decline {org,
  person}` for a proposed person, `leave {org, person}` (status `left`: every link of theirs stops
  at once, §app.organizations/roster, so it asks first), and `revert {org, person, at}`
  (§app.organizations/history-and-revert; a revert that would set `left` asks first, as `leave`
  does). **Contact is write-only**: `add` and `edit` take it, the result says only "contact set" or
  "contact cleared", and the action log records the call with `contact` replaced by `[contact]`.
  (The user gave the value in their own message, which the conversation keeps as they wrote it.)
- **`sova_owner {op: "set", org, person | null}`** sets the org's owner (§app.owner-page/owner).
- **`sova_project_decisions {op, org, project}`**: `reconcile`, `promote {ids}`, `resolve
  {conflict, …}`, `route {conflict, to}` and `freeze {frozen}` (§app/requirements), through the
  project's decisions routes. `promote` refuses a decision outside its author's area, as a project
  overseer's promotion does (§app.requirements/promotion): only the user promotes one, by id on the
  project page. One call is one org write, whatever it promotes.
- **Refused, as the routes refuse:** an unknown or ambiguous org, project or person; a field over
  its cap; a write a person's status forbids. Nothing partial happens past a refusal.

## §app.overseer/org-attribution — "You, via the Overseer"

- **The mark.** Every org, baton, decisions and project-overseer route reads the sender secret
  (§app.overseer/sent-marker). A write it makes for a request carrying it is recorded as the
  operator's with `via: "overseer"` and the Overseer's id: the roster history's `by: {kind:
  "operator", via: "overseer", overseerId}`, the About history's `by`, the project's
  `stakeholderHistory` and the org's `ownerHistory` lines (`why: "operator"`, `via`), the project's
  `archived` record (§app.organizations/archive), a baton session it started (`startedVia`, and
  `started` with the Overseer's id and its why, §app.baton/goal-and-loadout), and a
  coding session it started (§app.overseer/org-project-overseers), each in its statechart and its
  transition-log rows (§app.project-overseer/statecharts). A
  request without the secret records no `via`, whatever its body says.
- **Operator authority.** `via` changes nothing about what the write may do: field authority,
  refusals and routing read the kind, `operator` (§app.organizations/field-authority). A decision
  area the Overseer gives someone is operator-set (§app.requirements/routing), and a person it
  approves is approved by the operator.
- **Shown as "You, via the Overseer"** wherever the page names who made a change: a person's
  Profile Changes and the org's Recent Profile Changes (`you, via the Overseer` where the writer
  reads `you`), the About card's History rows, the main stakeholder's and the owner's latest-change
  lines ("Set by you, via the Overseer {time}."), a coding session's row ("Started by you, via the
  Overseer"), a gathering session's strip ("Started by you, via the Overseer · {relative time}",
  §app.baton/told), and the archived project's banner. Copy: §design.copy-deck/overseer-orgs.
- **Reverting** a line made via the Overseer is an ordinary revert: it records whoever reverts it.

## §app.overseer/org-people-facing — Acts that reach people ask first

- **`sova_gather {op}`**: `start {org, project, to, public_title, question, goal, why, briefing?,
  model?, thinking?, messages_max?, abilities?}` (`to`: a person, `operator`, or two or more people
  for an offer at start; `abilities` within the project's ceiling, §app.baton/abilities), `offer {session, to[], question?, briefing?}`, `handoff {session, to, question,
  briefing?}`, `take {session}` (Take Back), `close {session}`, `extend {session, by}`,
  `revoke_link {session, person?}` and `send_link {session, person?, note?}` or `{preview, person, note?}` (§app.outreach/decisions). The rules of §app.baton/goal-and-loadout,
  /offers-and-leases and /links apply as on the page; the tool descriptions carry the project
  overseer's wording rules for `public_title`, `question` and `goal`
  (§app.project-overseer/tools). `why` is required: one or two sentences for the user saying why
  it starts this session, recorded on its statechart and shown only to the user, on the strip and in
  What It's Told (§app.baton/told); never to the person, never to the session's model. Without it:
  "Say why you start it (why): one or two sentences for the user, never shown to the person.".
- **No link is ever minted for the model.** `start` and `offer` start in-process with no link
  (`mintLink: false`), owned by the operator; the session then needs the user to send each person
  their link (§app.baton/needs-you), and the result says so: "No link was made: Needs you asks you
  to send {name} their link." A hand-off moves the baton in-process and mints none either (the
  page's hand-off route mints one for the operator to copy). No op gets or shows a link: `send_link`
  mints one and hands it straight to the person on WhatsApp (§app.outreach/send), and its
  result says only "Sent {name} their link on WhatsApp." or why not — never the link, the token or
  the number.
- **Behind a confirm card, enforced.** These ops act on people or end something, and run only in a
  turn the user opened by clicking a card (§app.overseer/confirm) that lists every person, project
  and session the call acts on: the run's opening message is a click on that card, its text exactly
  the message the click composes, and the card was open when it arrived. A card-level option approves
  every item on the card; a per-item Apply approves only the items it gave a choice. The ops: `sova_gather` `start`, `offer`,
  `handoff`, `take`, `close`, `revoke_link` and `send_link`; `sova_roster` `leave`, and a `revert` that sets
  `left`; `sova_project_overseer` `clear`; `sova_org_project` `archive`. Anywhere else (a typed
  "yes", a card that didn't list the target, a card already answered, superseded or dropped, a
  later turn, a card from before card ids) the op refuses without doing anything, before any other
  refusal it could get (an archive with no card gets this, not "Stop these first"). The statecharts check
  it (§app.project-overseer/statecharts): the Overseer's calls to the routes carry its turn's card
  beside its sender mark:
  "This reaches people or ends something: ask with sova_card, listing {what} in its items, and
  act in the turn the user's click starts." `extend`, `decline`, `unarchive` and every other op
  need no card. So the card itself never invites a typed answer: a global Overseer card listing a
  person, a project or a gathering session drops its "Or type your answer." hint
  (§app.overseer/confirm).
- **Counted.** `start` and `offer` count against the gathering cap; the other `sova_gather` ops
  are org writes (§app.overseer/caps).

## §app.overseer/org-project-overseers — Running project overseers

`sova_project_overseer {op, org, project, …}`; every op is an act, attended only.

- **`start`** creates the project's overseer, as the project page's Start Overseer does
  (§app.project-overseer/identity). **`settings {…}`** changes what the project page's Settings tab sets (level,
  models and thinking, the coding sessions' mode, the limits and the pace, watching, the extra
  instructions): one PATCH, refused whole as the page's is. **`run_now`** is Run Now
  (§app.project-overseer/watch-loop). **`clear`** is its Clear, behind a confirm card
  (§app.overseer/org-people-facing). **`idea`** and **`todo`** add, edit, tick, untick and
  remove the project's ideas and to-dos, as the project page does
  (§app.project-overseer/ideas-and-todos). Each counts as one org write.
- **`message {text}`: the one sanctioned route into a project overseer's conversation**
  (§app.project-overseer/identity). `POST /api/orgs/:id/projects/:pid/overseer/message {text}`
  accepts only a request carrying the sender secret; any other caller gets 403 ("Only the Overseer
  sends here. Write in the overseer's own composer."). `sova_send` and `POST /api/sessions/prompt`
  still refuse the overseer's conversation (409). The text goes into its current conversation:
  idle, it starts a turn; mid-turn it is queued as a follow-up behind the running turn, a queued
  row reading **Overseer**. A text starting with `/` is refused ("Send words; use op clear to
  clear it."), as is a project with no overseer yet and an archived project
  (§app.organizations/archive). It is marked as the
  Overseer's in the overseer's file (§app.overseer/sent-marker), so its row carries the
  **Overseer** tag (§app.project-overseer/page); to the overseer's model it is the operator's
  message, in plain text.
- **Attended, as if the user typed it.** The overseer's run that message opens is the operator's
  (§app.project-overseer/autonomy-levels): its level doesn't bind, and it uses — and resets, as an
  operator message does — the per-message allowance, "each message you send"
  (§app.project-overseer/limits). What bounds repeats is the Overseer's own prompt cap: each
  message counts as one prompt to another session, and as a `sova_send` does against running at once
  (§app.overseer/caps).
- **Coding sessions.** A project's coding sessions are ordinary sessions: `sova_list_sessions`,
  `sova_session`, `sova_read_session` and `sova_send` reach them as before. **`code {prompt?,
  title?, item?, model?, thinking?}`** starts one as the project's, the same way the project page's
  Start Coding Session does: its own worktree (§app.project-overseer/coding-worktrees), the
  project's coding mode (§app.project-overseer/coding-mode), an `operator-coding` session whose
  statechart is marked `via: "overseer"`. `item` (a to-do or idea id) links it and gives the
  prompt when none is given; without an item, `prompt` and `title` are required. It counts against
  the Overseer's per-turn sessions created and running at once, like any session it starts, and
  never against the project overseer's limits. The result names the session, its branch and its
  path.
