# §app/overseer — The Overseer
> Part of the Sova design spec · [overview](../design/overview.md)

The Overseer is **one special Sova session** that watches every session and acts on them. The
user lives in it, and it steers their attention. It's an ordinary webapp-owned pi session hosted by
this server, and it opens as a full page like any chat. Four things make it special: a marker entry
in its file, a fixed cwd under Sova's state dir, a runtime loadout (its own prompt, an inline
extension with `sova_*` tools, a tool allowlist), and a stable route `#/overseer` that points to
whichever file is current. The name is "Overseer" everywhere in the UI.

Sova-owned state under `<stateRoot>` (`~/.pi/agent/sova/`, or `$PI_CODING_AGENT_DIR/sova/`):
`overseer/` (its cwd, otherwise empty), `overseer.json` (settings), `overseer-state.json`
(`{current, history[≤20]}`), `overseer-notes.md` (standing notes), `overseer-actions.jsonl` (audit
log) and `seen.json` (the seen store). All writes are atomic tmp+rename.

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
- **Hidden everywhere else.** `SessionSummary.overseer` is set by that rule. No Overseer file,
  current or historical, appears in any sidebar region, search, Recent, the spine, the cleanup
  count or a group's candidates. Its folder (`<stateRoot>/overseer/`) is never offered as a recent
  folder (`GET /api/cwds`, the New Session dialog's Recent folders, `sova_list_folders`), even if
  some other session was once started there.
- **`/clear`.** A bare `/clear` is a local command recognised **only** in the Overseer's composer
  (elsewhere it is an ordinary message). It and the head's **Clear** action call
  `POST /api/overseer/clear`, which never refuses: it stops a running turn, disposes the runtime,
  creates a new marked file, pushes the old id onto `history` (≤20; older ids fall off the list)
  and repoints `current`. The requesting tab lands on the new file. Other tabs that showed the
  Overseer re-resolve `#/overseer` when their socket reports the runtime was closed.
- **History.** A **History** menu in the head lists the previous files (≤20), each row its first message (at most two lines, the rest in its tooltip) over how long ago it was active; a list taller than the window scrolls. One opens read-only at
  `#/overseer/h/<id>` (watch view, no composer); the server refuses a chat on any Overseer file
  but the current one. Settings, standing notes and the audit log survive a clear.

## §app.overseer/hosting — Runtime loadout

- **cwd** is `<stateRoot>/overseer/`.
- **Prompt.** A repo-owned prompt file (`server/overseer-prompt.md`) says what the Overseer is,
  every tool, its scope and its rules. It is **appended** through the resource loader's
  append-override, so the user's own `APPEND_SYSTEM.md` is kept. The standing notes and the limits
  ride inside it, and the user's **extra system prompt** from Settings is appended after it. Both the
  notes and the extra prompt are redacted (§app.overseer/tools) as they are put in: a secret value in
  either reaches the model as `[redacted]`.
- **Live.** The notes, the limits and the extra system prompt are read again at the start of every
  run, so a `sova_note`, a notes edit or a Settings save reaches the Overseer from its next run (the
  next message, brief or wake-up), with no `/clear`. A run an extension's message starts (an
  `/explain` result, a worker's report) picks them up from its next request. The rest of the prompt
  (the prompt file, the tool list, the time it opened) is fixed for the runtime, so an unchanged
  prompt adds nothing to the conversation and a change adds one prompt update.
- **Tools.** The session runs with an allowlist: every `sova_*` tool, `read`, `grep`, `find`,
  `ls` and `wake_nudge`. It never has `bash`, `edit`, `write` or subagent tools.
- **Model.** Its model and thinking level come from `overseer.json`, never from the new-session
  defaults. A model or thinking change made in the Overseer's composer writes back to
  `overseer.json` and never becomes the default for new sessions. A model switch writes the
  **effective** thinking level with it (the level re-clamped to the new model's ladder), so the next
  conversation starts on what the composer showed.
- **No topic outline** runs for it: no list shows it.

## §app.overseer/tools — The `sova_*` tools

The tools call the existing REST routes in-process, so every guard those routes have already
(TUI-live refusal, mid-turn refusal, working-subagent refusal) applies unchanged, and their refusal
sentences come back as the tool's error. Sessions are addressed by id. No tool passes `force`.

- **Read** (no side effects): the attention digest; list sessions (compact rows); one session's
  detail; a bounded transcript read (≤40 items, ≤12,000 characters, each item ≤1,000, wrapped as
  untrusted content from another session, read with Sova's own parser so a TUI-live file is never
  opened for writing); list groups, targets, models and folders.
- **Act:** create a session in any folder or remote target, with an optional first prompt, model
  and mode; send a prompt to an **idle** session (never a mid-turn steer); archive and unarchive
  (never permanent delete); rename; groups (create, move a session in, remove it); set a session's
  model or mode; answer a hosted session's pending extension dialog; standing notes; navigate;
  confirm.
- **TUI-live sessions are read-only**: every act on one is refused.
- **Files: anywhere but credentials.** The Overseer's `read`, `grep`, `find` and `ls` reach any
  file on the machine except secret files, which none of them reads, lists or matches:
  - fixed places: `auth.json` and `models.json` in `~/.pi/agent` and in the active agent dir, and
    `models.json` anywhere under `~/.pi` and under the active agent dir (the model registry, whose
    `apiKey` and headers may be a literal key or a `!command`); Claude Code's
    `~/.claude/.credentials.json` and `~/.claude.json`; `~/.netrc`; `~/.config/gh/hosts.yml`;
  - whole directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.claude/backups`, `/proc` (every
    process's environment and command line, the server's own included) and `/sys`;
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
  - **Every Overseer tool** goes through one wrapper, so a tool added later is covered by default:
    its result (text and details, partial updates, an error's message; an image's bytes are left
    alone) is redacted, and so are its arguments before it runs, so what a tool stores or sends
    (notes, a confirm card, a prompt to another session, the action log) never holds a value.
    `read`, `grep`, `find` and `ls` keep their arguments as given (they store nothing, and a
    redacted pattern would be a different search); what they return is redacted.
  - The standing notes and the extra system prompt are redacted when they are put into the prompt
    (§app.overseer/hosting), and a brief's body is too (§app.overseer/proactivity).
  - Only the Overseer is redacted; other sessions and pi-config are unchanged.
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
    part of that message. A user message queued into a run makes the rest of it the user's.
  - **A retry is the same run.** When the SDK re-runs the user's request after a provider error or
    a context overflow, the re-run keeps the attendance it failed with, but only if the model's
    reply is the first thing in it; any input that arrives first decides it instead.

  In an
  unattended turn every acting tool refuses without doing anything: create, send, archive and
  unarchive, rename and set model/thinking/mode (`sova_set_session`), group operations, and
  answering a dialog. Still allowed: every read, `sova_note`, `sova_confirm`, `sova_navigate`
  (which never moves a tab in such a turn), and `read`/`grep`/`find`/`ls`. The refusal tells the
  model to stop and raise a `sova_confirm` card instead; the user's click starts a turn in which it
  may act, within the caps. The Overseer's prompt states the rule. Sessions the Overseer creates
  keep their full tools.
- **Itself:** tools refuse to act on the Overseer's own session.
- **Archived sessions** take no prompt from the Overseer: `sova_send` refuses one and says that
  unarchiving it (`sova_archive`, itself an act, on the caps) comes first, as the UI's "Unarchive it
  to send" does for the user. The route itself is unchanged.

## §app.overseer/confirm — Inline confirmation

`sova_confirm({title, detail?, options[]})` does not block: it returns at once, and the prompt tells
the model to end its turn after calling it. The Overseer decides when a request is ambiguous or
dangerous enough to ask.

- The chat renders that tool call as a **confirm card** in the thread: title, detail, and one button
  per option.
- A click sends the option's reply as the next user message.
- Its title, detail and options never hold a secret value: the arguments are redacted before the
  card is built, so a card shows `[redacted]` in its place (§app.overseer/tools).
- Once any later user message exists, the card shows as answered (the chosen option marked when the
  message matches one) and its buttons are disabled. Because the state is read from the transcript,
  it survives reloads and server restarts.

## §app.overseer/caps — Limits and the audit log

- **Per user turn:** at most 5 sessions created, 10 prompts sent to other sessions, 50 archive
  operations. **At once:** at most 5 Overseer-started sessions running. All four are configurable in
  Settings → Overseer.
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
  Only a user turn (or `/clear`) resets the three per-turn counters. A brief, a fired `wake_nudge`,
  an extension's message that starts a run and any other server-started run are unattended
  (§app.overseer/tools): read-only, on the budget of the user message before them, never a renewed
  one. The
  counters are kept in `<stateRoot>/overseer-turn.json`, so a server restart between a message and
  the wake-ups it scheduled does not renew them.
- **Running at once** counts Overseer-started sessions that are mid-turn or have subagents working,
  plus any the Overseer prompted in the last 15 s that have not yet been seen running, plus slots
  reserved by create/send calls still in flight. A call reserves its slot before it does any work, so
  parallel calls in one message cannot all pass the check.
- Over a cap, the tool refuses with a message telling the model to stop and ask with `sova_confirm`
  or explain, and not to schedule a wake-up to carry on. Nothing partial happens past the cap.
- Every act tool call appends one line to `overseer-actions.jsonl`: time, Overseer id, tool call id,
  tool, arguments, outcome and error. The arguments and the error are redacted before the line is
  written (§app.overseer/tools), so the log never holds a secret value.

## §app.overseer/sent-marker — Prompts the Overseer sent

- To the target session's model, a prompt the Overseer sent is an ordinary user message in plain
  text.
- Beside it the server writes an invisible `custom` entry `customType: "sova-overseer-sent"` that
  names the user message's entry id. It is never LLM context, and the TUI ignores it.
- The transcript renders an **Overseer** tag on that user row, on reload and live.
- **Only the Overseer can tag.** `POST /api/sessions/prompt` marks a prompt as the Overseer's only
  when the request carries the server's sender secret: random, made at server start, held in memory
  only, never written to disk or sent to a client, and carried only by the Overseer's own in-process
  tool calls. Any other caller (a worker with `bash`, a script) gets an ordinary, untagged prompt,
  whatever header it sends.
- **Rewind and Regenerate work exactly as on any user row**: the marker changes nothing about
  the row's actions.

## §app.overseer/dialog-answers — Answering other sessions' dialogs

- The Overseer may answer a hosted session's **live-pending** extension dialog (select, confirm,
  input). Headless dialogs with no browser attached resolve to their fallbacks on their own, so only
  dialogs pending right now can be answered. TUI-live sessions' dialogs are never answered.
- Each answer writes an invisible `custom` entry `customType: "sova-overseer-dialog-answer"`, and the
  transcript renders it as a machine row: **Overseer chose: {answer}**.

## §app.overseer/attention-digest — The attention digest

A server-side digest, built with no LLM from live records, summaries, held-chat state and the seen
store. It is memoised for about 3 seconds and never includes the Overseer itself.

- **Needs you (act):** a dialog open (`activity.state` needs-input, own and foreign, or a hosted
  pending dialog); an errored turn (`activity.state` error); a worker that errored or was killed.
- **Finished (decide):** replied since last seen and now idle; idle with an unsent draft or queued
  input.
- **FYI:** running now; context at or above 85%; idle web sessions older than 3 days that aren't
  archived and have no draft.
- Items are sorted by tier, then age, capped at 30, each with at most 200 characters of detail and
  an in-app link. The `sova_attention` tool and `GET /api/overseer/attention` return it; the entry
  button's badge counts come from it.

## §app.overseer/seen — The seen store and unread dots

- `seen.json` maps a session id to when a Sova chat or watch socket last **attached to or
  detached from** it. A view mounts only while it's on screen, so an open socket is the proxy for
  "the user had it in front of them". This is imperfect for background tabs.
- `SessionSummary.unread` is set when the session has replied since then and is not mid-turn. The
  sidebar row shows an **unread dot**, except for the session this tab is showing.
- The Overseer's own unread assistant messages give the entry button's **chat badge**, which is
  separate from the attention badge.

## §app.overseer/navigation — Navigation

- `sova_navigate({to})` validates the target and returns `{href, label}`. It has no other effect.
  Targets: `#/s/<path>`, `#/g/<id>[/<path>]`, `#/usage`, `#/agents[/<team>]`, `#/overseer`, and
  settings sections as `settings:<tab>[/<section>]`.
- The Overseer's chat view applies it (`location.hash = href`, or opening Settings on that tab)
  **only in the tab that started the running turn**: the tab whose own send went straight to the
  model, or whose queued send was delivered. Other tabs, other devices, reloads, and proactive turns
  never move.
- The tool card always shows a **Go** link to the same target, so history and other tabs can follow
  it by hand.

## §app.overseer/links — Session links

In Overseer messages, `sova://s/<id>` and `sova://g/<groupId>` links render as **in-app** links:
same tab, no new-tab glyph. The client resolves the id to the session's route from the session list.
An unknown id renders as its text, unlinked.

## §app.overseer/quick-actions — Quick actions

- **One floating button** sits just above the Overseer's composer. It opens a flyout listing the
  quick actions, each with its label and a short description. Picking one sends its prompt (queued
  as a follow-up while a turn runs).
- Defaults: **What Needs Me**, **What Finished**, **What's Running**, **Tidy Up**, **Where Was I**.
- They are editable in Settings → Overseer (label, description, prompt; add, remove, reorder,
  reset to defaults).

## §app.overseer/entry-button — Entry button

- An **eye** icon button (aria-label "Overseer") sits in the session-list search row, beside the
  filter. It is **removed** while the filter is focused or has a query, and comes back on blur with
  an empty query.
- The collapsed spine carries the same button.
- **Alt+O** opens the Overseer from anywhere.
- **Badges:** an attention count (needs-you items) and a separate chat-unread dot for Overseer
  messages the user hasn't seen. The button is tinted as selected while `#/overseer` is the route.

## §app.overseer/proactivity — Proactivity

Three modes, cycled with a control on the Overseer page and set in Settings: **Off**, **Badge Only**
(default), **Brief Me**.

- **Off:** no badge polling side effects; the button shows no attention count.
- **Badge Only:** the attention badge only. It costs no tokens.
- **Brief Me:** when a **new** needs-you item appears and the Overseer is idle, the server starts
  one Overseer turn, at most once per 10 minutes. Its prompt (the blockers' titles and details, from
  other sessions) is redacted like any tool output (§app.overseer/tools); it is tagged `[overseer-brief]`, renders
  as a machine row ("Brief · <time>") with its body under it as markdown (the blockers as a list, each
  an in-app session link), and never navigates any tab. A brief turn is not a user turn: it is
  read-only (§app.overseer/tools), so it can report and offer a `sova_confirm` card but never act,
  and it renews no caps (§app.overseer/caps).

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
