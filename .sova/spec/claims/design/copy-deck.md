# §design/copy-deck — 09 · Copy deck
> Part of the Sova design spec · [overview](overview.md)

These are the exact strings to use. `{…}` is a value. Machine facts (paths, pids, model ids,
times) go in `<code>` or `.text-mono`. `~` stands for `$HOME` in displayed paths.

## §design.copy-deck/sidebar — Sidebar

| Where | Copy |
|---|---|
| Pane resizer (§1) | `aria-label` "Resize the sessions pane" · `title` "Drag to resize · Double-click to reset" — the title is the only place the two gestures are named, and it is pointer-only copy for a pointer-only control |
| Search label (visually hidden) | Search sessions |
| Search placeholder | Title, folder, or model |
| Count | `{n} sessions` · filtered: `{visible} of {total} sessions` |
| TUI count chip (count row under search) | `{n} TUI` (only when n ≥ 1), static — a count is not work in flight. `title`: "Sessions open in a TUI" |
| Row TUI pill (rail) | wordless, static · `aria-label`: "Open in a TUI. Pid {pid}, status {status}." · `title`: "Open in a TUI · pid {pid} · {status}" |
| Row Busy pill (rail) | wordless, pulsing · `aria-label` and `title`: "pi is replying in this session" |
| Row worker count (rail) | `{n}` + worker icon · `aria-label` and `title`: "{n} subagents working now" |
| Row link hidden suffix | ", open in a TUI" · ", pi is replying in this session" · ", {n} subagents working now" |
| Untitled row | Untitled (muted) |
| Draft row (a never-sent session with a stored draft) | title Untitled (muted) · line 2: `pencil` icon, then the draft's first non-empty line, about 80 characters · image-only: `1 image` / `2 images` · accessible name and `title`: Draft: {preview} |
| Top region head | Live & web · {n} · searching: Live & web · {hits} of {total} |
| Archive head | Archive · {n} · searching: Archive · {hits} of {total} |
| Archive date sections | Today · Yesterday · Last 7 days · Last 30 days · Older (each with its count) |
| Groups region head (§2 "Groups") | Groups · {n} where n = **groups** · searching: Groups · {matching groups} of {all groups} |
| New group row | New group |
| Group name field (New group, Rename) | placeholder Group name · `aria-label` "New group name" / "Rename “{name}”" · button `Save` · Enter saves, blur saves, Escape cancels |
| Group section label | {name} (own case, no eyebrow), then its count · `title`: {name} |
| Empty group | No sessions yet. Drag one here. |
| Groups region, no groups | No groups yet. Make one, then drag a session into it. |
| Open workspace (group tool row, §14) | `Open workspace` · `title`: Open “{name}” as a workspace — every member side by side |
| Group tool row | `Rename` · `Delete group` · asking: with sessions "Delete “{name}”? Its {n} sessions stay in the list." (1 session: "… Its 1 session stays …"), empty "Delete “{name}”? Nothing is in it." — with `Delete group` · `Cancel` |
| Group toasts | "Added to “{name}”." · "Moved to “{name}”." · "Removed from “{name}”." · "Deleted “{name}”. Its {n} sessions are ungrouped." (1: "… Its 1 session is ungrouped.") · "Deleted “{name}”. It had no sessions." · failures: "Couldn't create the group. {server message}" · "Couldn't rename the group. …" · "Couldn't delete the group. …" · "Couldn't move this session. {server message}" |
| Remove-from-group drop row (only while dragging a grouped row) | Remove from “{name}” |
| Move into group (session pane, §3) | trigger `Move into group` · `title`: Move into group / In the group “{name}” · rows: No group, then every group, `New group…` · Identity fact: Group: {name} / None · popover failure: "Couldn't move this session." then "This session's group is unchanged." |
| Archive cleanup toolbar | eyebrow "Delete" · buttons `Older Than 7 Days` · `Older Than 30 Days` · `Empty Sessions` (`aria-label` "Delete Sessions Older Than 7 Days", …) · pending "Checking…" |
| Archive cleanup dialog | **Delete {n} sessions?** {scope} This permanently deletes their transcript files — this can't be undone. · skipped "{n} skipped: {a} open in a TUI, {b} mid-turn, {c} just written. They stay as they are." · buttons `Delete {n} Sessions` ("Deleting…") · `Cancel` · none: **0 sessions to delete.** · `Close` |
| Archive cleanup toasts | "Deleted {n} sessions." (+ " {skipped}.") · "Couldn't check what to delete. Nothing was deleted. {server message}" · "Couldn't delete sessions. Some may be gone; the list is refreshed. {server message}" |
| Empty top region note | 0 sessions open in a TUI, or started here and not archived. The archive below has the rest. |
| Loading | skeleton only, no text |
| Error banner | **Couldn't read your sessions.** `~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry. · button: `Retry` |
| Empty (0 on disk) | **0 sessions in `~/.pi/agent/sessions`.** Start one here, or run `pi` in a terminal. It'll show up in this list. · button: `New Session` |
| No matches | **0 of {total} match “{query}”.** We search titles, folders, and models. · button: `Clear Search` |

## §design.copy-deck/main-pane — Main pane

| Where | Copy |
|---|---|
| No session selected | **{n} sessions across {m} folders.** Pick one to read it, or start a new one. · buttons: `New Session` · `Fan Out…` (§14b's fresh-prompt entry, beside it) |
| No session selected, Explained grid | section head: Explained `{n}` (shown only when {n} ≥ 1; the tiles' own copy is §10) |
| Transcript load error | **Couldn't load this transcript.** The file at `{path}` wasn't changed. {server message} · button: `Retry` |
| New empty session | **New session in `{cwd}`.** Nothing sent yet. Your first message becomes its title. |
| Archive button / toasts | `aria-label` "Archive Session" · "Unarchive Session" (shown at every width) · disabled `title` "Open in a TUI. It stays on top while live." · toasts "Archived. Find it under Archive." · "Moved back to Live & web." · error "Couldn't archive this session. {server message}" |
| Copy output button / toast | `Copy Output` · toast "Copied output." |
| Unknown entry | Unrecognized entry `{raw.type}` · disclosure label "Raw entry" |
| Long tool output | `Show All {n} Lines` |
| Tool chips | Running · Done · Failed · No result |
| Tool output label | Output · on error: Error |
| Stopped turn (info row) | Stopped by you at `{HH:MM}`. |
| Report row, closed | {id} · {name} · chip · {first line} (hidden prefix "Report from ", or "Message: " without an agent) |
| Report chips | Failed · Stopped · Aborted · Success · Done · Starting · Running · Waiting · Stopping |
| Report, open | Error: {message} · Session `{path}` · No output. · Truncated at 4000 characters. Use agent_transcript for the rest. |
| Wake nudge card, closed | `Wake nudge {id}` · {reason, or blank} · `fired {HH:MM}` (· `{late} late`, only when overdue) |
| Wake nudge card, open | the fired message, verbatim, all four lines |
| Wake nudge in Inputs Only / the Timeline | {reason}, or `Wake nudge {id}` when it carries none |

## §design.copy-deck/message-actions — Message actions (§03)

| Where | Copy |
|---|---|
| Strip `aria-label` | Actions for your message · Actions for this reply · Actions for your queued message |
| Button `aria-label` (also the `title` when enabled) | `Copy message` · `Fork the session from here` · `Rewind to before this message` · `Regenerate this reply` · `Remove this queued message` |
| Copy landed | icon flips to the check for 1.5s · toast "Copied message." · clipboard failure keeps the existing "Couldn't reach the clipboard. Nothing was copied." |
| Rewind armed | note "This message and every reply after it leave the branch. The session file keeps them." · buttons `Rewind Here` · `Cancel` |
| Regenerate armed | note "The message that started this reply, and everything after it, leave the branch. The session file keeps them." — "this REPLY", never "this turn": the server rewinds to the nearest user message, and a MID-TURN STEER is one, and the leaf moves to that message's PARENT: in `u1 → a1 → tool → s1 → a2`, regenerating a2 drops s1 and a2 while u1/a1/the tool call stay, and regenerating a1 drops a1, the tool call, s1 and a2 · buttons `Regenerate Here` · `Cancel` |
| Regenerate landed | SR "Regenerating from your message." (the rewound message's own copy stays §13's) |
| Blocked, mutating actions (`title`) | Stop the current turn first. · Wait for the compaction to finish. · This session is open in a terminal, so Sova won't write to it. · Only a chat open in Sova can rewind. / …can regenerate. · A rewind is already in progress. / A regenerate is already in progress. · a message still on its way out (server refusal `queued`, which happens with isStreaming FALSE — the client cannot pre-check it): the server's own sentence, "A message is still on its way out. Wait for it to send, or press Stop, then rewind." / "…then regenerate." · a reply to a wake nudge: "That reply answered a scheduled wake-up, not a message you sent, so there's nothing to send again." (permanent — it outranks every state that clears on its own, and the server refuses it too with `regenerate_refused` reason "wake") · the composer's own reason while the chat can't write (Switching model…, Reconnecting. Your draft is kept., This session is archived. Unarchive it to send.) |
| Blocked Fork (`title`) | This session is open in a terminal, so Sova won't read it out from under that process. · This session is mid-turn. Forking reads the file, and we don't read it while it's being written. This enables itself when the turn finishes. · Wait for the compaction to finish, then fork. · A fork is already being made. |
| Fork landed | toast + SR, counting what actually reached the new composer: "Forked. Your message is in the new session's composer." · "…, with its image." / "…, with its {n} images." · "…, but its image couldn't come along." (plural: "…, but its {n} images couldn't come along.") · "…, with {k} of {n} images. The other {m} couldn't come along." — never a CAUSE: `available:false` covers a deleted file, a path this server won't read and an upload over the 20MB cap alike, so the copy says only that it didn't come · without a staged message "Forked into a new session." + " Nothing was sent." (a message in a composer says that itself; a fork with nothing staged has to say it in words), with the same image clauses |
| Fork refused | Another program wrote to this session a moment ago. Forking waits until it stops. · This session is in an older session format. Open it for chat once to update it, then fork. · That message isn't on the current branch anymore. Reload the transcript and fork from a message you can see. · This session's working directory is gone, so it cannot be opened. · unknown code: "Couldn't fork this session. {server message}" |
| Queued message head | `Sending…` (nothing holds it yet) · `Queued` (the server says it does), each a dot AND the word · the author is `You`, or `Sent by Sova` for a message the session queued for itself (a group send, a remote status probe) |
| Remove blocked (`title`) | Not queued yet. This can be removed once the server has it. · Already sent. It can't be removed now. · Removing… · Only a chat open in Sova can remove a queued message. |
| Remove landed | SR "Removed from the queue." in every tab, including the one that asked. Delete is a DISCARD: the message does NOT come back to the composer (that is Stop's job, §4 "Stop"), so no sentence claims it did |
| A queued message that will never be sent (`queue_item_gone`) | dropped (an extension handled it instead): SR "That message was handled without being sent. It's back in the composer." · failed (the hand-off was refused): SR "That message couldn't be sent. It's back in the composer." — both only in the tab that sent it, which is the only one with a composer to put it in |
| Remove refused | Already sent. It can't be removed now. · That message isn't in the queue anymore. · "pi queued work of its own alongside this message, so it can't be taken back on its own. Press Stop to clear the queue." (NOT transient: that row's Remove stays off from then on, so the copy never invites a retry that cannot succeed) · The session is busy right now. Try again in a moment. · unknown code: "Couldn't remove it from the queue. {server message}" |

## §design.copy-deck/live-watch — Live-watch

| Where | Copy |
|---|---|
| Head TUI chip `title` (static, no pulse) | Open in pi in a terminal · pid {pid} · {live.status} (the persistent "Live from TUI" banner was removed) |
| TUI closed | **The TUI closed this session.** You can chat in it here now. · button: `Open for Chat` |
| Jump button | Jump to Latest · `{n} new` (the count is omitted when 0) |
| SR announce (throttled 5s) | {n} new entries. |

## §design.copy-deck/connection — Connection (either socket)

| State | Surface | Copy |
|---|---|---|
| Connecting (first time) | composer reason (`clock`) | Connecting… |
| Lost, retrying | chat: composer reason (`clock`) · watch: `.banner-warn` | chat: "Reconnecting. Your draft is kept." · watch: **Stopped watching. The connection dropped.** What's shown is up to `{HH:MM}`. Reconnecting… |
| Gave up (retries exhausted) | `.banner-error` at the top of the transcript; composer reason "Not connected." | **Lost the connection to the Sova server.** Nothing in the session changed. Check `npm run dev:server` is running, then retry. · button: `Reconnect` |
| Reconnected | nothing. The banner or reason simply disappears; no toast | — |

## §design.copy-deck/composer — Composer

| State | Copy |
|---|---|
| Label (visually hidden) | Message |
| Placeholder, idle | ≥768: Ask pi to…—Enter sends, Shift+Enter adds a line · <768 and read only: Ask pi to… |
| Placeholder, streaming | ≥768: Steer the current turn…—Enter sends, Shift+Enter adds a line · <768: Steer the current turn… |
| Buttons | `Send` · streaming: `Steer` + `Stop` · after Stop is pressed: "Stopping…" in run status |
| Run status | `Working` + detail: `· thinking` / `· writing` / `· running {tool}` · stopping: `Stopping…` · while ≥ 1 worker runs, the subagents trigger beside it with the counts only: `2 subagents` · `1 subagent · 2 team members` |
| Reason: TUI-live | Read only while this session is open in the TUI. |
| Reason: busy (server `code:"busy"`) | pi is busy with another turn. Send when it finishes. |
| Reason: connecting / reconnecting / gave up | see Connection above |
| Busy fallback, when the message was already typed and rejected | the draft stays in the textarea (not cleared), plus the busy reason. No banner |
| Turn error banner (in thread) | **The turn stopped with an error.** {message}. Your messages are kept. Send again to retry. |
| SR announcements | Working. · Reply finished. · The turn stopped with an error. (once per error, and it replaces that turn's "Reply finished." — an errored turn still settles, and two endings would read as two turns) |

## §design.copy-deck/composer-flyout — Composer flyout

| Where | Copy |
|---|---|
| Trigger | `aria-label` / `title`: More Actions |
| Menu panel `aria-label` | More actions |
| Menu panel rows | Attach images · Commands · Session info |
| Model panel `aria-label` | Model and thinking |
| Model panel rows | Model · the Thinking group |
| Model row | {id} · {provider} (`title`: {provider/id}) · no model: Choose model |
| Thinking group label | Thinking |
| Thinking rows | the model's levels, verbatim and in ladder order: off · minimal · low · medium · high · xhigh · max |
| Thinking disabled `title` | Thinking changes wait until this turn finishes. · else the composer reason for that state |
| Back from the picker (to the model panel) | `Back` |
| Thinking error title | Couldn't set thinking to `{level}`. |
| Thinking error: running | Thinking changes wait until this turn finishes. You're still on `{level}`. |
| Thinking error: unknown level | pi doesn't know this thinking level. You're still on `{level}`. |
| Thinking error: timeout | The server didn't confirm the change. You're still on `{level}`. |
| Thinking error: other | {server message}. You're still on `{level}`. |
| Thinking error action | Dismiss |

## §design.copy-deck/images — Images

| Where | Copy |
|---|---|
| Attach row (composer flyout) | Attach images |
| Pending list `aria-label` | Attachments |
| Pasted image name | Pasted image |
| Remove / Dismiss `aria-label` | Remove {name} · rejected: Dismiss {name} |
| Rejected: wrong type | Unsupported type (the meta line fits about 18 mono characters; the full reason is in the announcement) |
| Rejected: too large | Over 5 MB |
| Rejected: too many | Over 8 images |
| Drop overlay | Drop images to attach · reject: Only images can be attached |
| Announce: added | {n} images attached. (1: "1 image attached.") |
| Announce: rejected | {name} wasn't attached. {reason}. |
| Thumb list `aria-label` | {n} images |
| Alt, user row | Image in your message · Image {i} of {n} in your message |
| Alt, tool result | Image from tool result {toolName} · Image {i} of {n} from tool result {toolName} |
| Alt, pending attachment | attachment |
| Path attachment summary | Attachment {name} · {size} |
| Path attachment, file gone | No longer on disk · over the cap: Too large to show · {size} |
| Alt, path attachment | Attachment {name} in your message |
| Path chip `aria-label` | Open image {name} · gone: Copy path {path}, no longer on disk |
| Path chip, gone | · No longer on disk (`title`: "{path} · No longer on disk. Select to copy the path.") · on copy: Copied path. |
| Tool card section label (paths) | Attachments · {n} |
| Tool card section label | Images · {n} |
| Tool card summary count | {n} (`title`: "{n} images") |
| Lightbox counter | {i} / {n} |
| Lightbox buttons | Close Image · Previous Image · Next Image |

## §design.copy-deck/model-menu — Model menu

| Where | Copy |
|---|---|
| Opened from | the Model row on the composer flyout's model panel (see "Composer flyout" above) and `Ctrl+P` / `⌘P` |
| Menu `aria-label` | Choose model |
| Search placeholder / label | Search models |
| Listbox `aria-label` | Models |
| Group labels | Favorites · All models |
| Foot (≥768) | `↑` `↓` to move · `Enter` to choose · `Esc` to close |
| No matches | 0 models match “{query}”. |
| No models | 0 models have credentials. Log in with `pi` in a terminal to add one. |
| Load failed | **Couldn't load models.** Your current model is unchanged. · `Retry` |
| Blocked, running | **Model changes wait until this turn finishes.** Stop or wait, then pick one. |
| Composer reason while pending | Switching model… |
| Announce on success | Model changed to {id}. |
| Info row on success | Model changed to `{provider/id}` |
| Error title | Couldn't switch to `{id}`. |
| Error: no credentials | {provider} has no credentials set up. Log in with `pi` in a terminal, then try again. You're still on `{current}`. |
| Error: unknown | pi doesn't know this model. It may have been removed from your config. You're still on `{current}`. |
| Error: running | Model changes wait until this turn finishes. You're still on `{current}`. |
| Error: timeout | The server didn't confirm the switch. You're still on `{current}`. |
| Error: other | {server message}. You're still on `{current}`. |
| Error action | Dismiss |

## §design.copy-deck/mode-menu — Mode menu

| Where | Copy |
|---|---|
| Trigger (composer foot, right end) | {mode} · {minor} …, or "Mode" before this chat's state arrives (`aria-label`/`title`: "Mode: {label}", plus ", applies after this turn" when pending) |
| Menu `aria-label` | Mode |
| Group labels | Major mode · Minor modes |
| Descriptions | from pi-config `MODE_DESCRIPTIONS` (state.ts): normal: Pi as usual · delegate: Orchestrate: route planning, investigation and implementation to workers by profile · minors: from pi-config `MINOR_DESCRIPTIONS` |
| Delegate gear | icon only; `aria-label`/`title`: Configure Delegate (opens Settings → Modes; switches nothing) |
| Foot | strict: {on\|off} · Before your first message it's also the new default; after, this chat only. `/mode default` saves it any time. |
| Pending | **Applies after this turn.** This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one. |
| Can't switch | **This chat can't switch.** This chat can't switch: the mode extension isn't loaded here, or another program wrote this session. |
| Save failed | **Couldn't switch the mode.** {reason}. Your mode is unchanged. |
| Load failed | **Couldn't load the modes.** Your mode is unchanged. Close this and try again. |
| Transcript marker | Mode → {mode} · Minor mode: {minor} on\|off (shown as recorded: a pre-rename marker keeps "Mode → claude-heavy") |
| Toast (from the extension) | Mode: {mode} · Minor mode: {minor} on\|off |

## §design.copy-deck/context-window — Context window

| Where | Copy |
|---|---|
| Label (head ≥720px) | Context |
| Value | `{tokens} / {window} · {pct}%` (e.g. `237k / 1M · 24%`) · window unknown: `{tokens}` |
| Narrow (head <720px, and the meta line <520px) | `{pct}%` · window unknown: `{tokens}` |
| Compacted | compacted |
| Title / AT, with a window | Context: {tokens, comma thousands} of {window} tokens ({pct}%), as of the last reply. |
| Title / AT, window unknown | Context: {tokens} tokens, as of the last reply. This model's limit is unknown. |
| Title / AT, compacted | Context was compacted. The next reply reports the new size. |
| No reply yet | (nothing shown) |

## §design.copy-deck/markdown-and-code — Markdown and code

| Where | Copy |
|---|---|
| Code block button | Copy Code |
| After copying (1.5s) | Copied |
| Copy failed (1.5s) | Couldn't copy |
| Announce | Copied code. |
| Language label, no info string | text |
| Link suffix (visually hidden) | (opens in a new tab) |
| Remote image link | Image: {alt} · no alt: Image: untitled |
| Inline data image alt | {alt} · no alt: Image in this reply |

## §design.copy-deck/slash-commands — Slash commands

| Where | Copy |
|---|---|
| Commands row (composer flyout) | Commands · no list: `title` "No commands available" |
| Menu head | Commands · {n} |
| Listbox `aria-label` | Commands |
| Row name | /{name} |
| Source chip | ext · prompt · skill |
| Empty | 0 commands match “/{query}”. Enter sends it as a message. |
| Foot (≥768) | `Enter` or `Tab` to insert · `Esc` to close |
| Announce | {n} commands available. · empty: 0 commands match. |
| Thread row after sending | Ran `/{name} {args}` |
| Needs TUI (thread row) | `/{name}` needs the terminal UI. Run it in pi in a terminal. |
| Needs TUI (menu line 2, if the contract gains a flag) | Needs the terminal UI |

## §design.copy-deck/new-session-dialog — New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Type field | label `What to start` · radios `One session` (the default) / `Fan out…` (§14b's fresh-mode entry at every width and route) · radios disable while Creating… · Enter never submits from them |
| Title, fanout chosen | Fan out — the same title §14b's dialog carries, so the handoff reads as one flow |
| Primary, fanout chosen | `Fan Out…` · `aria-disabled` until a folder is chosen, like Create Session · pressing it creates nothing: §14b's dialog opens on a fresh prompt with the folder carried (§05 "Type") |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Field, nothing chosen | Choose a folder |
| Recent label | Recent folders |
| Picker | group label "Choose a folder" · breadcrumb `aria-label` "Path" · buttons `Home`, `Recent`, `Use This Folder` · checkbox "Show hidden folders" · filter placeholder "Filter", `aria-label` "Filter folders in {name}" / "Filter recent folders" · list `aria-label` "Subfolders of {name}" / "Recent folders" · symlink tag "link" |
| Picker notes | Loading folders… · No subfolders in {name}. You can still start the session here. · 0 of {n} match “{filter}”. · Showing the first 500 folders, A to Z. Filter to narrow them. · Sova can't read this folder. Pick another one. · This folder doesn't exist. Pick another one. · Couldn't list this folder. {server message} · No recent folders yet. Sessions you start add theirs here. |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |

## §design.copy-deck/insights — Insights (§10)

| Where | Copy |
|---|---|
| Foot row 1 (→ `#/usage`) | Glance: `C {pct}%` `O {pct}%` `OL {pct}%` `Z {pct}%` `DS {amount}` (Claude, OpenAI, Ollama Cloud, Z.ai, DeepSeek — which has no quota, so it shows the money left, rounded to whole units: `DS $4` for a $4.29 balance) · no data: Usage · `title`/`aria-label`: Usage: {Provider} {window} {pct}%, …, DeepSeek balance $4.29 (exact amount) |
| Foot row 2 (→ `#/agents`) | `{agents} agents` · `{sessions} sessions` · `{teams} teams`, joined by ` · `, zero segments left out · nothing live: Agents · `title`/`aria-label`: {n} active agents in {m} sessions, {t} teams |
| Provider names | Claude · OpenAI · Ollama Cloud · Z.ai · DeepSeek |
| Usage page title / head meta | Usage · Updated {rel} · never read: Not read yet |
| Agents page title / head meta | Agents · `{w} working · {n} pi sessions running` ("{w} working · " dropped at 0; "1 pi session running") · 0 live: No pi sessions running |
| Refresh `aria-label` | Refresh Usage · Refresh Agents |
| Section heads (Agents page) | Teams · {n} active · Subagents · {n} working |
| Agents page, 0 live (whole body) | **No pi sessions running.** Teams and subagents show up here while the pi session that started them runs. |
| Window labels (`5h`, `7d`, `7d opus`, `month`, `pri`, `mcp`) | 5-hour · 7-day · 7-day Opus · Monthly · Primary · MCP uses. Other Z.ai plan windows: `{n}m` → {n}-minute, `{n}h` → {n}-hour, `{n}d` → {n}-day, `{n}w` → {n}-week |
| Scoped window (`scope` set) | `{window} {scope}`, with any " scoped" suffix dropped: `7d scoped` + `Fable` → 7-day Fable |
| Active window badge (`active:true`) | Active (neutral `.chip-count` in the meter label) · `title`: The window your current model counts against |
| MCP uses context | {used} of {limit} uses, e.g. "0 of 1,000 uses" (comma thousands). Shown when the window carries both `used` and `limit`, otherwise left out |
| Meter value | `{pct}%` used |
| Balance (DeepSeek) | label Balance · value `$4.29` (currency of the balance) · context: the non-zero parts of Granted `$0.00` · Topped up `$4.29`, joined by ` · `, omitted when both are 0 |
| Out of credit note | This balance can't fund calls. They'll fail until it's topped up. |
| Meter context | Resets in {2h 17m} (under 24h) · Resets {Sep 25} · reset already passed: Reset at `{HH:MM}`. New reading at the next refresh. |
| Usage chips | Near limit · Rate-limited · Quota used · Out of credit (DeepSeek, `available:false`) |
| Stale usage (banner-warn; only after a failed Refresh Usage) | **Usage is {42m} old.** Couldn't refresh: {message} · button: `Retry` |
| Usage file missing (`reason:"missing"`) | **No usage data yet.** Nothing has fetched provider usage on this machine. Refresh Usage fetches it now. · button: `Refresh Usage` |
| Usage file corrupt (`reason:"corrupt"`) | **Couldn't read usage.** `usage-status.json` isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh. · button: `Retry` |
| Request failed | Usage: **Couldn't load usage.** (poll) · **Couldn't refresh usage.** (Refresh Usage, data not stale) · Agents: **Couldn't load agents.** Then: Nothing was changed. {server message} · button: `Retry` |
| Provider `nologin` | Not signed in. Run `claude /login` and it'll show at the next refresh. (OpenAI: `pi /login`) |
| Provider `expired` | Sign-in expired. Run `claude /login` to renew it. (OpenAI: `pi /login`) |
| Provider `nokey` | No Ollama Cloud key in `~/.pi/agent/auth.json`. · Z.ai: No Z.ai API key in `~/.pi/agent/auth.json`. |
| Provider `badkey` | Ollama Cloud refused the key in `~/.pi/agent/auth.json`. · Z.ai: Z.ai refused the API key in `~/.pi/agent/auth.json`. |
| Provider `na` | This account doesn't report usage. |
| Provider `error`, no windows | Couldn't fetch usage: {error}. We'll try again at the next refresh. |
| Provider `error`, windows kept | No note: the card shows the kept windows (or balance) as an ordinary reading |
| Provider key dropped by an older pi | No note: the reading we last stored for it (at most 24h old) is shown as an ordinary reading |
| Team card | {name} · `{id}` · foot: Started {rel} in {parent title} · ended (parent session only): chip "Ended" |
| Member status chips | Starting · Working · Idle · Stopping · Done · Failed · Stopped · No report yet |
| Member meta | `{workerId}` · `{model}` · reported only: as of `{HH:MM}` · idle after a failure: last task failed |
| Orchestrator badge | Orchestrator |
| Teams empty, some sessions live | **{n} pi sessions running. None of them has a team.** (n = 1: **1 pi session running. It has no team.**) Teams you create in pi show up here while their session runs. |
| Teams empty, none live | not shown: the whole Agents page is the 0-live empty state above |
| Subagents empty | Section omitted |
| Aggregate chips | sidebar rail: `{n}` + worker icon · session head, linked: Team · {n} working (→ `#/agents/{teamId}`) or `{n}` + worker icon, `.session-head-working` (→ `#/agents`), its words in `title`/`aria-label`: "{n} subagents working now" |
| Current goal summary | Current goal · {now} · {n} topics (1 topic) |
| Current goal state line | Updated {rel} · stale adds: " · behind the latest messages" · failed-keeping-last adds: " · the last update failed, so this is the previous summary" · updating/drafting: "Updating" + live dot |
| Current goal jump | Jump to Message |
| Compaction | Compacted · `{tokens}` tokens summarized (no count: Compacted · earlier messages summarized) · Files read · Files changed |

## §design.copy-deck/subagents-pane — Subagents pane (§11)

| Where | Copy |
|---|---|
| Trigger | `{n} subagents working…` (1: `1 subagent working…`) · while the parent's turn runs: the counts only, `{n} subagents` · accessible name: `{n} subagents working — show subagents` |
| Pane | label and title: Subagents · chip: `{w} working` (omitted at 0) · Close `aria-label`: Close subagents |
| Row meta | `{provider}` · `{model}` · settled: `{model} · as of {HH:MM}` · idle after a failure adds: · last task failed (the provider leads: `claude code`, `zai`, …) |
| Row status chips | Working · Starting · Idle · Stopping · Done · Failed · Stopped |
| View head meta | `{id}` · `{provider}` · `{model}` · Read only (a claude-code worker's provider reads `claude code`) |
| Transcript section `aria-label` | {name} transcript |
| No workers | **0 subagents in this session.** Workers it starts show up here while they run. |
| None selected | **{n} subagents, {w} working.** Pick one to read its transcript. |
| No session yet (Claude Code) | **Its transcript isn't available in Sova.** `{name}` is starting — no Claude session yet. Latest: {preview} |
| No session file (pi) | **Its transcript isn't available in Sova.** `{name}` runs on a pi that doesn't publish its session file yet. Latest: {preview} |
| File gone, first load | **Couldn't find this worker's transcript.** `{path}` is gone. Nothing else changed. |
| File gone after loading (banner-warn) | **This transcript's file is gone.** What's shown is up to `{HH:MM}`. |
| Transcript file empty (just started) | **0 entries in {name}'s session so far.** Entries show up here as it writes them. |
| Pane's session-insight fetch failed (banner-warn) | **Couldn't load this session's subagents.** {message} Your workers keep running. We'll retry on our own. |
| Transcript socket and load errors | the §11 state table: Live-watch and Connection copy above, and Main pane's transcript load error |

## §design.copy-deck/settings-modes-delegate — Settings · Modes → Delegate (§12)

| Where | Copy |
|---|---|
| Tab | Modes |
| Section title | Delegate |
| Intro | In Delegate the agent hands work to background workers and checks what they bring back. Pick the worker for each kind of work. Chats already in Delegate, here and in the terminal, use a change from their next message. |
| Profiles (legend · hint) | Planning & specs · Investigation · Routine implementation · Complex implementation; hints from pi-config `DELEGATE_PROFILE_INFO` (delegate.ts) |
| Row labels | Primary · Backend · Model · Effort · Fallback (toggle) |
| Select placeholders | Choose a model (Checking… while asking) · Choose |
| Model option suffixes | — off for subagents · — not offered · — not verified |
| No fallback | No fallback: if the primary can't run, the agent asks you which model to use. |
| Row notes | Choose a model. · Choose an effort. · {backend} doesn't offer {model}. · {model} doesn't take {effort} effort. · {policy reason}. Delegate uses the fallback, or asks. · Not verified: {backend} couldn't list its models. · Not verified: {provider} models exist only in sessions started with that provider on. · Same as the primary. Choose another worker, or no fallback. |
| Checking | Checking which models each backend offers… |
| Backend can't list (banner-warn) | **{backend} couldn't list its models.** {reason}. Choices on it stay as saved and read "not verified" — it isn't saying they're gone. [Check Again] |
| Options request failed (banner-warn) | **Couldn't check which models are offered.** Your saved choices stay, marked not verified. [Check Again] |
| Load failed (banner-error) | **Couldn't load the Delegate settings.** Nothing was changed. [Try Again] |
| Save failed (banner-error) | **Couldn't save the routing.** {server reason}. Your saved routing is unchanged. |
| Saved with notes (banner-warn) | **Saved, with notes.** {warnings as sentences}: "Not verified, because {backend} couldn't list its models ({reason}): {slot}, {slot}…" once per backend, then one per other slot |
| Close held (banner-warn, above the dialog foot) | **Your Delegate changes aren't saved.** Save them on this screen, or discard them and close. [Keep Editing] [Discard and Close] |
| Buttons | Reset to Defaults · Discard Changes · Save Changes (Saving…) |
| Announcement | Delegate routing saved. Chats in Delegate use it from their next message. |
| Footnote | Stored in `~/.pi/agent/mode-delegate.json`, shared with pi in the terminal. |

## §design.copy-deck/settings-themes — Settings · Themes (§12)

| Where | Copy |
|---|---|
| Tab | Themes |
| List `aria-label` | Theme |
| Panel intro | Applies as you pick. The choice is remembered in this browser. |
| Row accessible name | `{name}, {base} base, {source}` — e.g. "Catppuccin Mocha, dark base, built-in". Field names are `shared/protocol.ts`'s: `base`, `source` (`builtin`\|`user`), `path`, `replacesBuiltin` |
| Row meta | `{Dark\|Light} base · {Built-in\|User}` · a user file holding a built-in's id adds a third clause: `Dark base · User · replaces the built-in` |
| Row `title`, user themes | the file's full path — e.g. `~/.pi/agent/sova/themes/dracula.json` |
| Swatch strip `aria-label` | Page, surface, accent, error, and text colors |
| Font sample | `Aa 0x1F` — `Aa` in the theme's body face, `0x1F` in its mono face |
| Broken row, name slot | `{filename}` in mono — e.g. `sunset.json` |
| Broken row, meta slot | `We couldn't read this theme. {reason}` — `{reason}` is the parser's own message, quoted as it comes: "We couldn't read this theme. Expected double-quoted property name in JSON at position 15 (line 3 column 1)." V8 names a line for most syntax errors and not for all, so the copy never promises one |
| Broken row, meta slot — a value we won't emit | `{key} is {value}. A color is a hex value, or one call to rgb, rgba, hsl, hsla, oklch, oklab, lab, lch, color-mix, or color.` — e.g. "accent is image-set(…). A color is a hex value, or one call to rgb, rgba, hsl, hsla, oklch, oklab, lab, lch, color-mix, or color." The accepted list is the one in §0, and stays in step with it |
| …the same, other key families | shadows: `{key} is {value}. A shadow takes lengths, an optional inset, and a color.` (`scrim` and `skeleton-sweep` use the color message) · font stacks: `{key} is {value}. A font stack takes names, quotes, and commas — no parentheses.` · sizes: `{key} is {value}. That takes a px or em length, or 0.` · `lh-*`: `…takes a plain number.` · `fw-*`: `…takes a number from 100 to 900.` |
| Broken row, hidden suffix | `, can't be used` |
| Typography heading | Typography |
| Typography intro | Fonts for this browser, over whichever theme is on. Theme default is the theme's own fonts. |
| Typography fields | `Text` (hint: Everything you read: the sidebar, messages, and headings.) · `Code` (hint: Paths, ids, diffs, and code blocks.) — first option in each: `Theme default`; then the catalogue's labels (`src/lib/typography.ts`) |
| Typography hint, IBM Plex Mono | Static weights: medium and display text render one step heavier. |
| Typography reset action | `Use Theme Fonts` (disabled on Theme default) |
| Typography preview `aria-label` | Preview of the current fonts |
| Typography preview copy | heading `Changed 7 files in src/api` · body "The run stopped at step 4 and nothing was merged. 3 runs are waiting on you — review them, or discard the one that failed." · mono `+ id: 0x1F  path: src/api/runs.ts  ok` / `- id: 0x2A  path: src/api/jobs.ts  ok` |
| Typography, pick on (line under the preview) | `Text: {label} · Code: {label}` — `theme default` where a kind has no pick |
| Typography announcements (polite region) | `Text is now {label}.` / `Code is now {label}.` / `… is now the theme's font.` / `Back to the theme's fonts.` |
| Footer | Drop a `.json` file in `~/.pi/agent/sova/themes/` and it shows up here. |
| Footer action | `Refresh` (icon `refresh.svg`; `aria-busy` while a refresh it started is in flight) |
| Folder unreadable (banner) | We couldn't read `~/.pi/agent/sova/themes/`. Your own themes aren't listed; the built-in ones still work. Retry or check the folder's permissions. |
| Missing theme fell back (banner) | `{id}` isn't there anymore, so you're back on Dark. |
| Loading | skeleton rows — no copy |


## §design.copy-deck/timeline-tab — Timeline tab (§13)

| Where | Copy |
|---|---|
| Tab | Timeline · list `aria-label`: Session timeline (filter on: `Session timeline, your messages only`) |
| Filter toggle | `Inputs Only` (`aria-pressed`; pressed adds a `check` icon before the words) |
| Current goal strip button | `Open Timeline` |
| Composer trigger | `{n} inputs` (1: `1 input`) · accessible name: `{n} inputs in this chat — show them on the Timeline` (1: `1 input in this chat — show it on the Timeline`) · absent at 0 |
| Row name prefix (visually hidden) | `Jump to this message: ` |
| Images-only row | `1 image` / `{n} images` |
| Row action | Rewind · confirming: `Rewind Here` + `Cancel` · in flight: `Rewinding…` |
| Confirm note | This message and every reply after it leave the branch. The session file keeps them. |
| Another rewind in flight | A rewind is already in progress. |
| After it lands (composer) | Rewound. Your message is back in the composer. (nothing to hand back: `Rewound.`) |
| Boundary note | Rewound to just before this message. Its text is in the composer. |
| Abandoned rows (visually hidden) | Left behind by the rewind. |
| Off: streaming | Stop the current turn first. |
| Off: compacting | Wait for the compaction to finish. |
| Off: TUI-live | This session is open in a terminal, so Sova won't write to it. |
| Off: watching, or no chat open here | Only a chat open in Sova can rewind. |
| Refused: not on the branch | That input is not on this chat's current branch anymore. |
| Flyout row | Undo last turn · armed: `Confirm: undo last turn` · title: Rewind to before your last message; its text comes back to the composer |
| Flyout row, off | Stop the turn first, then undo. · Wait for compaction to finish, then undo. · A rewind is already in progress. · Nothing to undo yet. |
| Density line | `{n} replies · {n} tools · {duration}` — e.g. `3 replies · 14 tools · 6m`; 1: `1 reply` / `1 tool`; a clause at 0 is dropped, and the row with it |
| Idle gap | `idle {duration}` — e.g. `idle 38m` (`duration()` in `src/lib/format.ts`, the one the density line uses) |
| Chapter fallback | `summary time` (after the topic, in the row's meta; the clock dims with it) |
| Marker: compaction | `Compacted · {n} tokens summarized` |
| Marker: rewind | `Rewound to an earlier message` |
| Marker: subagent | `{name} started` · `{name} finished` · `{name} stopped` (errored or killed) |
| Marker: settings | `Model → {model}` · `Thinking → {level}` · `Mode → {mode}` |
| Marker: past summary | `Goal · {now}` (no `now`: the first line of `overall`) · `title`: the snapshot's `overall` · the newest snapshot gets no row |
| State line | Updated {relative} ago · behind the latest messages · (current: `Updated {relative} ago · current`; a summarizer running: `Updating`) — §10's words, unchanged |
| Time `title` | `{absolute} · {relative}` — e.g. `2026-09-19T14:06:11Z · 2d ago` |
| Row foot | Newest first, active branch only. A row jumps to its message; Rewind takes the chat back to just before it. (filter on: starts `Your messages only, newest first,`) |
| Row foot, below 1280 | Newest first, active branch only. A row jumps to its message and closes this pane; Rewind takes the chat back to just before it. |
| Jump with no row on screen (toast) | That message isn't in the transcript on screen. |
| Empty | **0 messages in this session yet.** The timeline draws itself as you and the agent work. |
| Empty, filter on, other rows exist | **0 messages from you in this session yet.** Turn off Inputs Only to see the rest of its timeline. |
| `/timeline` | Timeline open. |
| `/tree` | Timeline open, your messages only. |

## §design.copy-deck/workspace — Workspace (§14)

| Where | Copy |
|---|---|
| Skip link | Skip to Group Composer · before the group composer exists: `Skip to Transcript`, targeting the focused pane |
| Main landmark | `aria-label`: Workspace: {name} |
| Title and meta | {name} · `{n} members` (1: `1 member`) · `·` · the cwd when every member shares one, else `{n} folders` · after a shared send: `{r} of {t} replied` (then `· {w} still working` while any of them runs, and `· {e} errored` whenever a member's turn failed — the failure is always named, so the count can never hide a broken member) |
| Back | `aria-label`: Back to Sessions |
| Head buttons | `Tabs` (`aria-pressed`; pressed reads the same word) · `Fit All` (split only, 2+ members) · `Align to Fork` · `Add Members` · `Dissolve` · collapsed under 640px into `More Actions` |
| Unknown group id (toast) | That group is gone. |
| Promoted chip | Promoted: {title} · button `Add Back` · `title`: You took this session out of “{name}”. Add Back puts it back where it was |
| Tab | {label or title} · `aria-label`: the pane's own name, byte for byte (label/title or the repeat's `{model} #n` — one rule for strip and pane, so they can never disagree about which #2 is which) |
| Pane name | {label} · {model}, or {title} · {model} with no label · repeats of one model: {model} #1, #2, #3 — numbered in member order, shared with the tab rule, and never followed by "· {model}": the suffix already names it, and saying it twice makes the name stutter · `title`: the full string, then the cwd, then the session's whole spend (`{cost} this session`, `SessionUsage.total` — the same field the Session-info dialog tallies) when the server reports one |
| Pane tools | one menu: trigger `aria-label` "Pane actions · {pane name}" · rows `Rename…` · `Open` (link, `title`: Open this session on its own) · `Wider` · `Narrower` · `Move Left` · `Move Right` · `Focus` · `Promote` · `Remove From Group` · `Eliminate` (absent when the session wasn't started in Sova) |
| Pane tool `aria-label`s | Rename {pane name} · Open {pane name} · Make {pane name} wider · Make {pane name} narrower · Move {pane name} left · Move {pane name} right · Focus {pane name} · Promote {pane name} · Eliminate {pane name} — the pane NAME (suffix included), because the menu says which member it acts on and three same-model forks are three menus |
| Promote `title` | Take it out of “{name}” and open it on its own. Nothing is archived and nothing is deleted |
| Eliminate `title` | Take it out of “{name}” and archive it. The transcript stays; unarchiving brings it back |
| Eliminate off | TUI-live: "This session is open in a terminal." · mid-turn: "It's mid-turn. Stop it or wait, then eliminate it." |
| Remove From Group `title` | Take it out of “{name}” and stay here. Nothing is archived and nothing is deleted · when Eliminate is absent: This session wasn't started in Sova, so removing it is all we can do — nothing is archived |
| Member chips | `Working` (live dot, mid-turn — the split row's only at-a-glance sign of who is still running; the tab strip's dot covers tabs mode) · `TUI` (accent, static) · `Archived` (neutral) · `Can't open` (error) · `Busy` (warn) |
| Member composer reasons | "This session is open in a terminal, so Sova won't write to it." · "This session is archived. Unarchive it to send." · "This session can't be opened. The banner above says why." · "Another program is writing to this session." |
| Member file gone | **This session's file is gone.** Its transcript was deleted outside Sova, so there's nothing left to read. Removing it from the group is all that's left. · button `Remove From Group` |
| Group composer label and placeholder | `aria-label` "Message every member" · placeholder "Ask all {n} members…—Enter sends, Shift+Enter adds a line" (below 768: "Ask all {n} members…"; 1 member: "Ask this member…") · **{n} is the group's size, never the available count**: availability belongs in the foot, where it can change without rewriting a placeholder under the caret, and "Ask this member…" in a 3-member group would be false |
| Group composer Send | `Send to All` · in flight `Sending…` · 1 member: `Send` |
| Group composer targets line | `{n} of {m} members` then the excluded reasons, counted: `· 1 mid-turn` · `· 2 open in a terminal` · `· 1 archived` · `· 1 can't be opened` · `· 1 busy` · `· 1 file gone`. All available: `{n} members` alone |
| Group composer off | 0 available: Send is `aria-disabled`, reason "No member can take a message right now." · 0 members: the composer isn't rendered |
| Refusal reason per member | rendered from `code`: `{member} is mid-turn` · `{member} is open in a terminal` · `{member} is archived` · `{member} can't be opened` · `{member} is busy` · `{member}'s file is gone` · `{member} is in an older session format` · `the fork point you picked isn't {member}'s latest message anymore` · `internal`, or a code this build doesn't know: `{member} couldn't be prompted.` then the server's `message` as the detail — Sova keeps the claim in its own voice and hands the server the part only it knows |
| Refusal banner | **Nothing was sent.** {n} of {m} members can't take a message right now: {member} is mid-turn, {member} is open in a terminal. Wait for them, or send to the other {k}. · buttons `Send to the Rest ({k})` · `Cancel` |
| Partial send banner | **Sent to {k} of {n} members.** {member} was taken by another program between the check and the send, so it didn't get this message. The {k} that did are answering now. (several missed out: {members} **were** taken … so **they** didn't get this message — the verb agrees with its own subject) · one button per member that missed out: `Send to {member}` — re-sends to **that member alone**, the message as it was sent, not as the box now reads (a button's label names exactly who its own press reaches; one label over every failed id would promise one thing and do another) · the composer keeps its text here (it clears only on a clean send) |
| Announcing a banner | A banner is `role="status"` and speaks for itself: **never** announce beside one. The clean-200 path announces because it has no banner |
| Sent (live region) | Sent to {n} members. (1: Sent to 1 member.) |
| Promote toast | Took **{title}** out of “{name}”. · failure: "Couldn't take this session out of the group. {server message}" |
| Add Back toast | Put **{title}** back in “{name}”. · failure: "Couldn't put this session back. {server message}" · label restored but the order didn't take: "Put **{title}** back in “{name}”. It's at the end." |
| Eliminate toast | Removed **{title}** and archived it. · remove-only: "Removed **{title}** from “{name}”. It wasn't started in Sova, so nothing was archived." · with the group's last member: "Removed **{title}** and archived it. Dissolved “{name}” — nothing was left in it." · failure: "Couldn't remove this session. {server message}" · archived half failed: "Removed **{title}** from “{name}”, but couldn't archive it. {server message}" |
| Dissolve vs Delete group | The same route (`DELETE /api/session-groups/:id`) under two words: `Delete group` in the sidebar's tool row, `Dissolve` in the workspace head, where it sits above open transcripts and "Delete" would read as deleting them (§14) |
| Dissolve, asking in place | Dissolve “{name}”? Its {n} sessions stay in the list. (1: "… Its 1 session stays …"; 0: "Dissolve “{name}”? Nothing is in it.") · buttons `Dissolve` · `Cancel` |
| Dissolve toast | Dissolved “{name}”. Its {n} sessions are ungrouped. (1: "… Its 1 session is ungrouped.") · "Dissolved “{name}”. It had no sessions." |
| Add Members popover | trigger `Add Members` · `aria-label` "Add a session to “{name}”" · rows: every ungrouped session, then the grouped ones with a muted note `in “{name}”`, then `Fan Out…` · empty: "Every session is already in a group." |
| Add Members toasts | Added **{title}** to “{name}”. · Moved **{title}** from “{other}” to “{name}”. · failure: "Couldn't add this session. {server message}" |
| Empty workspace | **“{name}” has no sessions yet.** Add some here, or drag a row onto the group in the sidebar. · buttons `Add Members` · `Fan Out…` |
| Empty workspace, fanout group | **“{name}” has no sessions left.** They were removed from the group, or their files were deleted outside Sova. Dissolving it takes the name and the fork point, and nothing else. · button `Dissolve` — **the group cannot tell the two causes apart** (it stores `seed` and members, never a reason), so the copy names both rather than picking one; parallel to the hand-made state's "no sessions **yet**" |
| Member announcements (live region) | {pane name} — working. · {pane name} — replied. · {pane name} — stopped with an error. (the turn-error banner's own title, said once; the settle that follows an errored turn announces nothing — two endings would read as two turns) · {pane name} — stopped by you. · {pane name} — can't be opened. · {pane name} — open in a terminal, so it stays read-only. |
| Pane focus keys | no visible copy · the workspace's keyboard help lives in `Move Left` / `Move Right` `title`s: "Swap {pane name} with its left-hand neighbour. Ctrl+Alt+← moves focus, not the pane." |
| Fit All | `Fit All` · `title`: "Make every pane narrow enough to stand in the row side by side. Below 440px a pane trades solo reading for comparison; Wider steps back to the floor." · announce: "Fitted {n} members at {w} pixels each." (below the floor: "… each, below the 440 floor a single pane keeps.") · a fitted width is memory-only, like every width; `Wider` from below the floor lands on 440 and `Narrower` is a no-op there — never a button that says "narrower" while widening |
| Rename member | menu row `Rename…` · `title`: "Give this member your own name — the useful one is only known after reading its output" · the menu's one input: `aria-label` "Name {pane name}", starts from the current label, `maxlength` 40 · empty CLEARS (note under the field: "Empty clears the label — the pane shows the title again.") · Enter saves, Escape cancels and closes · toasts: "Renamed to “{label}”." / "Label cleared — the pane shows the title again." · announce: "{new pane name} — renamed." / "{new pane name} — label cleared." — the NEW name, which is true from that moment |
| Align to Fork, tabs mode | "Aligned {n} members now. {names} will align when you open its/their tab." — a hidden pane cannot be scrolled (`display: none` has no scroll offsets), so it is never counted as aligned; the alignment rides with the pane and lands the moment its tab is opened. A pane with no marker on its branch is named as ever: "{name} has no fork point on its branch." |
| Member gone, removal | the `.empty` pane's button `Remove From Group` removes by session id (`{ id, groupId: null }` — there is no file to resolve a path through) · toast "Removed {pane name} from “{name}”." · with the group's last member: "… Dissolved “{name}” — nothing was left in it." |
| Completion roll-up | the meta line's "{r} of {t} replied" is anchored to the last ACCEPTED shared send (a box send replaces the set; a partial banner's retry unions it, so the straggler is counted with the ones already answering) · errored members are counted "errored", never "replied" · memory-only: a reload genuinely does not know about the last send, and shows nothing rather than a guess |

## §design.copy-deck/fanout — Fanout (§14b)

| Where | Copy |
|---|---|
| Flyout row (§4) | `Fan Out…` · `title`: Fork this session N ways and compare the answers |
| Welcome screen button (§3) | `Fan Out…` beside `New Session` — the fresh-prompt entry, opening the dialog with "A fresh prompt" and no source |
| Dialog title | Fan out |
| Start from | field label `Start from` · radios: "Fork “{title}” at its latest message" · "A fresh prompt" |
| Fork note | Each member gets the whole conversation up to message {n}, then goes its own way. |
| Create off, source mid-turn | “{title}” is mid-turn. We read the file to fork it, and we don't read it while it's being written. This enables itself when the turn finishes. |
| Create off, unidentified writer | Another program wrote to “{title}” a moment ago. Forking waits until it stops. |
| Create off, older session format | “{title}” is in an older session format. Forking reads the file, and reading it rewrites the whole thing — not something to do to a session that's open. Open it for chat here once to update it, then fan out. |
| Fresh fields | the §5 folder picker, unchanged · field label `First message` · placeholder "Ask all of them to…" |
| Members field | label `Members` · empty: "No members yet. Add a model, then set how many of it you want." |
| Member row | the **full ref** in mono (`ModelInfo.ref`, e.g. `zai/glm-5.3`) — **never the bare model id**: two providers ship the same name (`zai/glm-5.3` and `ollama-cloud/glm-5.3` differ only by provider and bill to different subscriptions), so a row showing `glm-5.3` is two rows the user cannot tell apart · the fill (below) · count buttons `aria-label` "One more {ref}" / "One fewer {ref}" (at 1: "Remove the only {ref}" — never the remove button's own "Remove {ref}", which would put two controls of one row under one accessible name) · at 9 the `+` answers "{ref} is already at 9, the most per model." in the toast and the live region — the count cannot move, so the answer is the whole feedback · remove `aria-label` "Remove {ref}" |
| Add a model | `Add a Model` · picking a model already listed: no new row, the count goes up, and the live region says "{ref} ×3." — the **full ref**, and this is the surface that needs it most: the announcement is the *only* channel here, so nothing visible disambiguates two rows that differ by provider (§14b) |
| Member fill | `{tokens} of {window} · {pct}%` (§4f's formats and its 80% / 95% steps) · window unknown: "{tokens}, window unknown" · fresh prompt: "new session" · compacted fork point: "compacted" · source not on screen (the Add-Members entry): "unknown" — a fill that can't be named is words, never 0, which is a measurement we cannot make |
| Doesn't fit | This model's window is smaller than the fork. · `.field-error`: "Remove {ref} to create this fanout." — the **full ref**: it names which row to act on, and with two colliding rows the short form names both (§14b). Never "or lower its count": the fill is per model, not per repeat, so that instruction cannot work |
| Group name | label `Group name` · default `Fanout · {first 6 words of the title or prompt}` · placeholder Group name |
| Cost preview | `{n} members × ~{tokens} tokens re-sent every shared turn.` · fresh: `{n} members, each starting empty. Every shared turn is re-sent {n} times as they grow.` · compacted: `{n} members × unknown tokens re-sent every shared turn — the fork point was compacted.` · source not on screen: `{n} members × unknown tokens re-sent every shared turn.` |
| Rate-limit note | Turns start together, so one provider may answer some members with 429. Sova doesn't stagger them. |
| Create | `Create {n} Members` (1: `Create 1 Member`) · in flight `Creating…` (fields disable; see §14b) · off at 0: reason "Add at least 1 member." · fresh-mode reasons: "Pick a folder for the new sessions." / "Write the first message every member gets." · **treatment:** every reason renders as a hint (`.field-hint`) except the overflow's "Doesn't fit", which stays an error — a reason the user has done nothing wrong to earn (an unfinished form, someone else's turn) is guidance, not a mistake, and an error-styled opening state reads as an accusation |
| Cancel | `Cancel` |
| Partial creation banner | Title **{k} of {n} members were created.** (k=1: **1 of {n} members was created.**) · then **one line per failure**, the refusal banner's shape (§14) · closing line The {k} that exist are running; add another from Add Members. (k=1: It is running; add another from Add Members.) · buttons `Add Members` · `Dismiss` |
| …its failure lines | Two shapes, told apart by `id`: **never created** (empty `id`) `{model} couldn't start: {server message}` · **created but refused its first message** (`id` set, fresh mode's fold) `{model} couldn't take the first message: {server message}` — a session the user can see in its pane must not be told "couldn't start" — the two never collapse together, even at the same ref and reason · a pre-existing `groupId` member (id only, no ref) is "A member", never a guessed ref · `{model}` is the **full ref** (`BatchRefusal.ref`), for the same reason the picker rows are (§14b): two providers ship one name, and two failure lines both reading `glm-5.3 couldn't start` name different models while looking like a duplicate. Never parsed out of the message; the message is the reason alone, unprefixed (162ee20). Entries sharing ref **and** message **and** shape collapse to `{count} × {model} couldn't …`; sharing a ref but not a message gets one line each, because the reasons are the information. **Never a member number** — `failed` carries no index into the plan, so `{model} #2` would be a guess |
| …the three shapes, worked | **one failure:** `4 of 5 members were created.` / `anthropic/claude-opus-5 couldn't start: the provider returned 429.` · **two distinct refs:** `3 of 5 members were created.` / `anthropic/claude-opus-5 couldn't start: the provider returned 429.` / `zai/glm-5.3 couldn't start: no credentials for zai.` · **two sharing a ref, same reason:** `3 of 5 members were created.` / `2 × anthropic/claude-opus-5 couldn't start: the provider returned 429.` · **two sharing a ref, different reasons:** two lines, the model repeated verbatim — the repetition is honest, since what differs is the reason |
| Fanning out into an existing group (success) | No special copy: the members appear in the workspace, and a hand-made target gains fork markers on them and the `Align to Fork` button. Nothing warns, because nothing was taken away — the group keeps its name and survives being emptied exactly as before (§14 `autoDissolve`) |
| Fanout into a group with a different fork point (`400 seed-conflict`) | `.field-error`: “{name}” was forked from a different point, and a group can only mark one. Nothing was created. Fan out into a new group, or add these members to the one they came from. |
| Total failure | `.field-error` in the dialog: "Couldn't create this fanout. No sessions were made. {server message}" |
| Create off, the fork point moved | “{title}” answered while this dialog was open, so the fork point you picked isn't its latest message anymore. Reopen Fan out to fork from where it is now. |
| Create off, source taken by a terminal while open | “{title}” is open in a terminal now. Sova doesn't touch a file a terminal owns; fan out once it closes. |
| Source refusal (after the press) | rendered with the SAME sentence as the matching Create-off state above — recovery advice included, unlike the group composer's refusal clause — and for a code this build has no sentence for: “{title}” couldn't be forked. {server message} |
| Source gone (404) | `.field-error`: "“{title}” isn't on disk anymore. Nothing was created." |
| Fork marker row | Forked from {parent title} here · `{HH:MM}` · parent gone: the title as plain text, `title` "This session is no longer on disk." |
| Align to Fork | `Align to Fork` · live region: "Aligned {n} members to the fork point." · some missing: "Aligned {k} members. {pane name} has no fork point on its branch." |
| Fan out unavailable | the row is absent — no reply yet, a watch view, or a session open in a TUI. Nothing is disabled and nothing explains an absence |

---
