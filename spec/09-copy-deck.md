# 09 · Copy deck
> Part of the pi-web design spec · [overview](overview.md)

These are the exact strings to use. `{…}` is a value. Machine facts (paths, pids, model ids,
times) go in `<code>` or `.text-mono`. `~` stands for `$HOME` in displayed paths.

## Sidebar

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
| New fanout row (§14b) | New fanout |
| Group tool row | `Rename` · `Delete group` · asking: with sessions "Delete “{name}”? Its {n} sessions stay in the list." (1 session: "… Its 1 session stays …"), empty "Delete “{name}”? Nothing is in it." — with `Delete group` · `Cancel` |
| Group toasts | "Added to “{name}”." · "Moved to “{name}”." · "Removed from “{name}”." · "Deleted “{name}”. Its {n} sessions are ungrouped." (1: "… Its 1 session is ungrouped.") · "Deleted “{name}”. It had no sessions." · failures: "Couldn't create the group. {server message}" · "Couldn't rename the group. …" · "Couldn't delete the group. …" · "Couldn't move this session. {server message}" |
| Remove-from-group drop row (only while dragging a grouped row) | Remove from “{name}” |
| Move into group (session pane, §3) | trigger `Move into group` · `title`: Move into group / In the group “{name}” · rows: No group, then every group, `New group…` · Identity fact: Group: {name} / None · popover failure: "Couldn't move this session." then "This session's group is unchanged." |
| Archive cleanup toolbar | eyebrow "Delete" · buttons `Older Than 7 Days` · `Older Than 30 Days` · `Empty Sessions` (`aria-label` "Delete Sessions Older Than 7 Days", …) · pending "Checking…" |
| Archive cleanup dialog | **Delete {n} sessions?** {scope} This permanently deletes their transcript files — this can't be undone. · skipped "{n} skipped: {a} open in a TUI, {b} mid-turn, {c} just written. They stay as they are." · buttons `Delete {n} Sessions` ("Deleting…") · `Cancel` · none: **0 sessions to delete.** · `Close` |
| Archive cleanup toasts | "Deleted {n} sessions." (+ " {skipped}.") · "Couldn't check what to delete. Nothing was deleted. {server message}" · "Couldn't delete sessions. Some may be gone; the list is refreshed. {server message}" |
| Empty top region note | 0 sessions open in a TUI, or started here and not archived. The archive below has the rest. |
| Refresh button `aria-label` | Refresh Sessions |
| Loading | skeleton only, no text |
| Error banner | **Couldn't read your sessions.** `~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry. · button: `Retry` |
| Empty (0 on disk) | **0 sessions in `~/.pi/agent/sessions`.** Start one here, or run `pi` in a terminal. It'll show up in this list. · button: `New Session` |
| No matches | **0 of {total} match “{query}”.** We search titles, folders, and models. · button: `Clear Search` |

## Main pane

| Where | Copy |
|---|---|
| No session selected | **{n} sessions across {m} folders.** Pick one to read it, or start a new one. · button: `New Session` |
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

## Live-watch

| Where | Copy |
|---|---|
| Head TUI chip `title` (static, no pulse) | Open in pi in a terminal · pid {pid} · {live.status} (the persistent "Live from TUI" banner was removed) |
| TUI closed | **The TUI closed this session.** You can chat in it here now. · button: `Open for Chat` |
| Jump button | Jump to Latest · `{n} new` (the count is omitted when 0) |
| SR announce (throttled 5s) | {n} new entries. |

## Connection (either socket)

| State | Surface | Copy |
|---|---|---|
| Connecting (first time) | composer reason (`clock`) | Connecting… |
| Lost, retrying | chat: composer reason (`clock`) · watch: `.banner-warn` | chat: "Reconnecting. Your draft is kept." · watch: **Stopped watching. The connection dropped.** What's shown is up to `{HH:MM}`. Reconnecting… |
| Gave up (retries exhausted) | `.banner-error` at the top of the transcript; composer reason "Not connected." | **Lost the connection to the pi-web server.** Nothing in the session changed. Check `npm run dev:server` is running, then retry. · button: `Reconnect` |
| Reconnected | nothing. The banner or reason simply disappears; no toast | — |

## Composer

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
| SR announcements | Working. · Reply finished. |

## Composer flyout

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

## Images

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

## Model menu

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

## Mode menu

| Where | Copy |
|---|---|
| Trigger (composer foot, right end) | {mode} · {minor} …, or "Mode" before this chat's state arrives (`aria-label`/`title`: "Mode: {label}", plus ", applies after this turn" when pending) |
| Menu `aria-label` | Mode |
| Group labels | Major mode · Minor modes |
| Descriptions | normal: Pi as usual · claude-heavy: Orchestrate: delegate coding and planning to Claude Code workers · minors: from pi-config `MINOR_DESCRIPTIONS` |
| Foot | strict: {on\|off} · This chat only. New sessions start from the default; `/mode default` saves this chat's as it. |
| Pending | **Applies after this turn.** This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one. |
| Can't switch | **This chat can't switch.** This chat can't switch: the mode extension isn't loaded here, or another program wrote this session. |
| Save failed | **Couldn't switch the mode.** {reason}. Your mode is unchanged. |
| Load failed | **Couldn't load the modes.** Your mode is unchanged. Close this and try again. |
| Transcript marker | Mode → {mode} · Minor mode: {minor} on\|off |
| Toast (from the extension) | Mode: {mode} · Minor mode: {minor} on\|off |

## Context window

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

## Markdown and code

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

## Slash commands

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

## New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Field, nothing chosen | Choose a folder |
| Recent label | Recent folders |
| Picker | group label "Choose a folder" · breadcrumb `aria-label` "Path" · buttons `Home`, `Recent`, `Use This Folder` · checkbox "Show hidden folders" · filter placeholder "Filter", `aria-label` "Filter folders in {name}" / "Filter recent folders" · list `aria-label` "Subfolders of {name}" / "Recent folders" · symlink tag "link" |
| Picker notes | Loading folders… · No subfolders in {name}. You can still start the session here. · 0 of {n} match “{filter}”. · Showing the first 500 folders, A to Z. Filter to narrow them. · pi-web can't read this folder. Pick another one. · This folder doesn't exist. Pick another one. · Couldn't list this folder. {server message} · No recent folders yet. Sessions you start add theirs here. |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |

## Insights (§10)

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
| Stale usage (banner-warn) | **Usage is {42m} old.** It refreshes while pi runs in a terminal. Open a pi session, or run `/usage-refresh` in one. |
| Usage file missing (`reason:"missing"`) | **No usage data yet.** The usage-status extension writes `~/.pi/agent/cache/usage-status.json` while pi runs, and we haven't found it. |
| Usage file corrupt (`reason:"corrupt"`) | **Couldn't read usage.** `usage-status.json` isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh. · button: `Retry` |
| Request failed | Usage: **Couldn't load usage.** · Agents: **Couldn't load agents.** Then: Nothing was changed. {server message} · button: `Retry` |
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

## Subagents pane (§11)

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
| No session yet (Claude Code) | **Its transcript isn't available in pi-web.** `{name}` is starting — no Claude session yet. Latest: {preview} |
| No session file (pi) | **Its transcript isn't available in pi-web.** `{name}` runs on a pi that doesn't publish its session file yet. Latest: {preview} |
| File gone, first load | **Couldn't find this worker's transcript.** `{path}` is gone. Nothing else changed. |
| File gone after loading (banner-warn) | **This transcript's file is gone.** What's shown is up to `{HH:MM}`. |
| Transcript file empty (just started) | **0 entries in {name}'s session so far.** Entries show up here as it writes them. |
| Pane's session-insight fetch failed (banner-warn) | **Couldn't load this session's subagents.** {message} Your workers keep running. We'll retry on our own. |
| Transcript socket and load errors | the §11 state table: Live-watch and Connection copy above, and Main pane's transcript load error |

## Timeline tab (§13)

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
| Off: TUI-live | This session is open in a terminal, so pi-web won't write to it. |
| Off: watching, or no chat open here | Only a chat open in pi-web can rewind. |
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

## Workspace (§14)

| Where | Copy |
|---|---|
| Skip link | Skip to Group Composer |
| Main landmark | `aria-label`: Workspace: {name} |
| Title and meta | {name} · `{n} members` (1: `1 member`) · `·` · the cwd when every member shares one, else `{n} folders` |
| Back | `aria-label`: Back to Sessions |
| Head buttons | `Tabs` (`aria-pressed`; pressed reads the same word) · `Align to Fork` · `Add Members` · `Dissolve` · collapsed under 640px into `More Actions` |
| Unknown group id (toast) | That group is gone. |
| Promoted chip | Promoted: {title} · button `Add Back` · `title`: You took this session out of “{name}”. Add Back puts it back where it was |
| Tab | {label or title} · `aria-label`: {label or title}, {model} (mid-turn: "…, working") |
| Pane name | {label} · {model}, or {title} · {model} with no label · repeats of one model: {model} #1, #2, #3 · `title`: the full string, then the cwd |
| Pane tools | `Open` (link, `title`: Open this session on its own) · `Wider` · `Narrower` · `Move Left` · `Move Right` · `Promote` · `Eliminate` (no archive available: `Remove From Group`) |
| Pane tool `aria-label`s | Open {label or title} · Make {label or title} wider · Make {label or title} narrower · Move {label or title} left · Move {label or title} right · Promote {label or title} · Eliminate {label or title} |
| Promote `title` | Take it out of “{name}” and open it on its own. Nothing is archived and nothing is deleted |
| Eliminate `title` | Take it out of “{name}” and archive it. The transcript stays; unarchiving brings it back |
| Eliminate off | TUI-live: "This session is open in a terminal." · mid-turn: "It's mid-turn. Stop it or wait, then eliminate it." |
| Remove From Group `title` | This session wasn't started in pi-web, so removing it is all we can do — nothing is archived |
| Member chips | `TUI` (accent, static) · `Archived` (neutral) · `Can't open` (error) · `Busy` (warn) |
| Member composer reasons | "This session is open in a terminal, so pi-web won't write to it." · "This session is archived. Unarchive it to send." · "This session can't be opened. The banner above says why." · "Another program is writing to this session." |
| Member file gone | **This session's file is gone.** Its transcript was deleted outside pi-web, so there's nothing left to read. Removing it from the group is all that's left. · button `Remove From Group` |
| Group composer label and placeholder | `aria-label` "Message every member" · placeholder "Ask all {n} members…—Enter sends, Shift+Enter adds a line" (below 768: "Ask all {n} members…"; 1 member: "Ask this member…") |
| Group composer Send | `Send to All` · in flight `Sending…` · 1 member: `Send` |
| Group composer targets line | `{n} of {m} members` then the excluded reasons, counted: `· 1 mid-turn` · `· 2 open in a terminal` · `· 1 archived` · `· 1 can't be opened` · `· 1 busy` · `· 1 file gone`. All available: `{n} members` alone |
| Group composer off | 0 available: Send is `aria-disabled`, reason "No member can take a message right now." · 0 members: the composer isn't rendered |
| Refusal banner | **Nothing was sent.** {n} of {m} members can't take a message right now: {member} is mid-turn, {member} is open in a terminal. Wait for them, or send to the other {k}. · buttons `Send to the Rest ({k})` · `Cancel` |
| Partial send banner | **Sent to {k} of {n} members.** {member} was taken by another program between the check and the send, so it didn't get this message. The {k} that did are answering now. · button `Send to {member}` |
| Sent (live region) | Sent to {n} members. (1: Sent to 1 member.) |
| Promote toast | Took **{title}** out of “{name}”. · failure: "Couldn't take this session out of the group. {server message}" |
| Add Back toast | Put **{title}** back in “{name}”. · failure: "Couldn't put this session back. {server message}" · label restored but the order didn't take: "Put **{title}** back in “{name}”. It's at the end." |
| Eliminate toast | Removed **{title}** and archived it. · remove-only: "Removed **{title}** from “{name}”. It wasn't started in pi-web, so nothing was archived." · with the group's last member: "Removed **{title}** and archived it. Dissolved “{name}” — nothing was left in it." · failure: "Couldn't remove this session. {server message}" · archived half failed: "Removed **{title}** from “{name}”, but couldn't archive it. {server message}" |
| Dissolve vs Delete group | The same route (`DELETE /api/session-groups/:id`) under two words: `Delete group` in the sidebar's tool row, `Dissolve` in the workspace head, where it sits above open transcripts and "Delete" would read as deleting them (§14) |
| Dissolve, asking in place | Dissolve “{name}”? Its {n} sessions stay in the list. (1: "… Its 1 session stays …"; 0: "Dissolve “{name}”? Nothing is in it.") · buttons `Dissolve` · `Cancel` |
| Dissolve toast | Dissolved “{name}”. Its {n} sessions are ungrouped. (1: "… Its 1 session is ungrouped.") · "Dissolved “{name}”. It had no sessions." |
| Add Members popover | trigger `Add Members` · `aria-label` "Add a session to “{name}”" · rows: every ungrouped session, then the grouped ones with a muted note `in “{name}”`, then `Fan Out…` · empty: "Every session is already in a group." |
| Add Members toasts | Added **{title}** to “{name}”. · Moved **{title}** from “{other}” to “{name}”. · failure: "Couldn't add this session. {server message}" |
| Empty workspace | **“{name}” has no sessions yet.** Add some here, or drag a row onto the group in the sidebar. · buttons `Add Members` · `Fan Out…` |
| Member announcements (live region) | {pane name} — working. · {pane name} — replied. · {pane name} — stopped by you. · {pane name} — can't be opened. · {pane name} — open in a terminal, so it stays read-only. |
| Pane focus keys | no visible copy · the workspace's keyboard help lives in `Move Left` / `Move Right` `title`s: "Move Left · Ctrl+Alt+Left moves focus, not the pane" |

## Fanout (§14b)

| Where | Copy |
|---|---|
| Flyout row (§4) | `Fan Out…` · `title`: Fork this session N ways and compare the answers |
| Dialog title | Fan out |
| Start from | field label `Start from` · radios: "Fork “{title}” at its latest message" · "A fresh prompt" |
| Fork note | Each member gets the whole conversation up to message {n}, then goes its own way. |
| Create off, source mid-turn | “{title}” is mid-turn. We read the file to fork it, and we don't read it while it's being written. This enables itself when the turn finishes. |
| Create off, unidentified writer | Another program wrote to “{title}” a moment ago. Forking waits until it stops. |
| Fresh fields | the §5 folder picker, unchanged · field label `First message` · placeholder "Ask all of them to…" |
| Members field | label `Members` · empty: "No members yet. Add a model, then set how many of it you want." |
| Member row | the model id in mono · the fill (below) · count buttons `aria-label` "One more {model}" / "One fewer {model}" (at 1: "Remove {model}") · remove `aria-label` "Remove {model}" |
| Add a model | `Add a Model` · picking a model already listed: no new row, the count goes up, and the live region says "{model} ×3." |
| Member fill | `{tokens} of {window} · {pct}%` (§4f's formats and its 80% / 95% steps) · window unknown: "{tokens}, window unknown" · fresh prompt: "new session" |
| Doesn't fit | This model's window is smaller than the fork. · `.field-error`: "Remove {model}, or lower its count, to create this fanout." |
| Group name | label `Group name` · default `Fanout · {first 6 words of the title or prompt}` · placeholder Group name |
| Cost preview | `{n} members × ~{tokens} tokens re-sent every shared turn.` · fresh: `{n} members, each starting empty. Every shared turn is re-sent {n} times as they grow.` |
| Rate-limit note | Turns start together, so one provider may answer some members with 429. pi-web doesn't stagger them. |
| Create | `Create {n} Members` (1: `Create 1 Member`) · in flight `Creating…` · off at 0: reason "Add at least 1 member." |
| Cancel | `Cancel` |
| Partial creation banner | **{k} of {n} members were created.** {model} couldn't start: {server message}. The {k} that exist are running; add another from Add Members. · buttons `Add Members` · `Dismiss` |
| Total failure | `.field-error` in the dialog: "Couldn't create this fanout. No sessions were made. {server message}" |
| Fork marker row | Forked from {parent title} here · `{HH:MM}` · parent gone: the title as plain text, `title` "This session is no longer on disk." |
| Align to Fork | `Align to Fork` · live region: "Aligned {n} members to the fork point." · some missing: "Aligned {k} members. {pane name} has no fork point on its branch." |
| Fan out unavailable | the row is absent — no reply yet, a watch view, or a session open in a TUI. Nothing is disabled and nothing explains an absence |

---
