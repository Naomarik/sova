# §design/copy-deck — Copy deck
> Part of the Sova design spec · [overview](overview.md)

These are the exact strings to use. `{…}` is a value. Machine facts (paths, pids, model ids,
times) go in `<code>` or `.text-mono`. `~` stands for `$HOME` in displayed paths.

## §design.copy-deck/sidebar — Sidebar

| Where | Copy |
|---|---|
| Pane resizer (§app/shell) | `aria-label` "Resize the sessions pane" · `title` "Drag to resize · Double-click to reset" — the title is the only place the two gestures are named, and it is pointer-only copy for a pointer-only control |
| Search label (visually hidden) | Search sessions |
| Search placeholder | Title, folder, or tag (model still matches; the placeholder must fit the 320px field) |
| Count | `{n} sessions` · filtered: `{visible} of {total} sessions` |
| Search icon button (folded toolbar line, §app.session-list/search) | wordless `search` · `aria-label` "Search sessions" · `title` "Search sessions · /" |
| Close Search (folded toolbar line, while the search is open) | wordless `close` · `aria-label` and `title`: Close Search |
| Row TUI chip (rail) | `TUI`, static, no dot · `aria-label` (replaces the visible word in the accessible name): "Open in a TUI. Pid {pid}, status {status}." · `title`: "Open in a TUI · pid {pid} · {status}" · tap: the `title` as a toast |
| Row Busy dot (rail) | wordless, pulsing · `aria-label` and `title`: "pi is replying in this session", or while its request waits on a provider's limit the waiting sentence, "Waiting for zai · 5 of 5 in use" (§app.provider-limits/waiting-shown) · tap: the same as a toast |
| Row worker count (rail) | `{n}` + worker icon · `aria-label` and `title`: "{n} subagents working now" |
| Row link hidden suffix | ", open in a TUI" · ", pi is replying in this session" (waiting: ", Waiting for zai · 5 of 5 in use") · ", {n} subagents working now" |
| Folder head, an agent at work in it | Busy's dot, wordless, pulsing · `title`: "An agent is working in this folder" · hidden clause in the heading: ", an agent is working here" |
| Row unread dot (line 1) | wordless accent dot · hidden: "New activity. " |
| Row turn-error mark (line 1, in the unread dot's place; §app.overseer/seen) | wordless alert circle in error · hidden: "Turn failed. " · `title`: "The last turn stopped with an error: {message}" · without a message: "The last turn stopped with an error." |
| Row needs-you mark (line 1, after the unread dot or turn-error mark; one per row, §chat.alignment/session-mark, §app.decisions/attention-signals) | open questions: the accent count `{n}` alone, no glyph (the count is aria-hidden) · hidden "{n} open questions. " (1: "1 open question. ") · `title` "{n} open questions in {m} alignments" (1 alignment: "{n} open questions in {al_N} {title}") · otherwise a wordless glyph · hidden: a reply that asks "Asks you something. " · looping "May be looping. " · a stuck subagent "A subagent may be stuck. " · a team gone quiet "Waiting on a quiet team. " · `title`: "The last reply asks you something." · "The last turn looks like it went in circles." · "A subagent looks stuck." · "Waiting on subagents that have gone quiet." · an ask and a quiet team are muted ink, never the accent: neither is a Needs you item |
| Row meta title, when tagged | Topic: {topic word} (tagged automatically) |
| Row readiness chip (leads line 3, before the time; §chat.worktrees/readiness) | a toned chip, dot and word, sentence case: ● Ready to merge (success) · ● Waiting for your OK (info) · `title`: one line per worktree, "{branch}: {state word}, {why}" ("feat/cc-sandbox: ready to merge, checks passed"), then the routine follow-ups: "A merge changed the server since it started: restart it to run the new code." · "The merge isn't pushed yet." · "{n} merged worktree(s) is/are still tracked active." · "Open work ({weight}): {cue}" |
| Row readiness badge (line 3, between time and model, muted text, no tone) | restart pending · merged · {n} follow-up(s) · merged (lowercase), where {n} counts only the follow-up check's named work, never a leftover worktree · `title`: the chip's |
| Topic words (search; §app.decisions/session-tags) | feature · bug fix · refactor · tests · docs · infra · research · planning · review · data · config · experiment · chore · other |
| Untitled row | Untitled (muted) |
| Draft row (a never-sent session with a stored draft) | title Untitled (muted) · line 2: `pencil` icon, then the draft's first non-empty line, about 80 characters · image-only: `1 image` / `2 images` · accessible name and `title`: Draft: {preview} |
| Needs you region head (§app.session-list/needs-you) | Needs you · {n} where n = its rows · `title`: "The {n} sessions waiting on you, newest first." (1: "The 1 session waiting on you.") |
| Needs you row, line 2 | the digest's sentence for the session's newest act item, verbatim ("2 open questions in al_3 Autonomy settings", "Waiting on a dialog.", "1 subagent ended in an error.") · `title`: every act sentence, newest first |
| Needs you cut note | Some sessions may not be listed: this list stops at the 30 most urgent items. |
| Needs you spine door | wordless `alert-circle` over {n} · `aria-label` and `title`: Needs you · {n} sessions (1: "1 session") |
| Overseer entry button (eye) | wordless · badge: {unread}, "99+" past 99 · `aria-label`: Overseer / Overseer · {n} new messages (1: "1 new message") · `title`: the same + " · Alt+O" |
| Top region head | Live & web · {n} · searching: Live & web · {hits} of {total} |
| Archive head | Archive · {n} · searching: Archive · {hits} of {total} |
| Organizations region head (§app.session-list/organizations) | Organizations · {n} · searching: Organizations · {hits} of {total} · `title`: "Hand-offs, project overseers, and the coding sessions they started, by organization and project." |
| Organizations waiting chip (region head, warn, dot and word, while k ≥ 1) | {k} waiting · `title`: "{k} sessions waiting on you." (1: "1 session waiting on you.") |
| Organizations working dot (collapsed region head or org) | Busy's dot, wordless, pulsing · `title`: "An agent is working in one of these sessions" · hidden: ", an agent is working here" |
| Organizations Needs you label | Needs you, then its count · `title`: "The {k} organization sessions waiting on you, newest first." (1: "The 1 organization session waiting on you.") |
| Organizations Needs you row | line 2: the digest's sentence, else "{from} → you: {question}" · "Send {to} their link: {question}" · "Approve {name} ({role}) proposed by {by}?" · `title`: every sentence, newest first · line 3: {time} · {org} · {project} (no project: {time} · {org}) |
| Org section head | {org}, wordless warn dot with hidden ", {k} waiting on you", then its count · `title`: "{n} sessions in {org}." + " {k} waiting on you." when k ≥ 1 |
| Org page link (org head) | wordless `arrow-right` · `aria-label` and `title`: Open the {org} page |
| Project label | {project}, then its count · `title`: the project root (from its overseer's folder), else {project} · Unknown project · Other |
| Project overseer eye (project heading, §app.session-list/organizations) | wordless `eye`, one mark at most: Busy's pulsing dot · the turn-error mark · the unread dot · `aria-label` and `title`: Open the {project} overseer, + " · working" / " · last turn failed" / " · new reply" |
| Project groups (in order, each only with rows) | `Conversations` {n} · `title`: "Gathering sessions and offers sent to people." · `Conflicts to settle` {n} · `title`: "Sessions asking someone to settle two decisions that disagree." · `Builds` {n} · `title`: "Coding sessions this project started." |
| States (Conversations, Conflicts to settle) | `Not started` {n} · `In progress` {n} · `Done` {n} (collapsed) |
| Done (every group) | Done {n} · `title`: Conversations and Conflicts: "Done or closed, and the ones you archived." · Builds: "Merged, and the ones you archived." |
| Not started row, line 2 | "Link not sent yet" · "Not opened yet" · "Opened, no reply yet" · none while you hold it |
| Settle row, line 2 | "In conflict: {area}" · not started: "In conflict: {area} · {hint}" |
| Organizations spine door | wordless `building` over {n} · `aria-label` and `title`: Organizations · {n} sessions (1: "1 session"), + " · {k} waiting on you" while k ≥ 1 |
| Org archive toasts | "Archived. Find it in {project}, under Done." · "Moved back to {project}." · no project: "Archived. Find it in {org}, under Done." · "Moved back to {org}." · a project with no name left: {project} = "its project" |
| Org group refusal (drop, Move into group reason, server 400) | Organization sessions stay with their project. |
| Select mode, org rows | Move to group: "Skipped 1: an organization session stays with its project." · "Skipped {n}: organization sessions stay with their project." · Archive: "{n} went to its project's Done list." (n > 1: "{n} went to their projects' Done lists.") |
| Archive date sections | Today · Yesterday · Last 7 days · Last 30 days · Older (each with its count) |
| Groups region head (§app.session-list/groups) | Groups · {n} where n = **groups** · searching: Groups · {matching groups} of {all groups} |
| Open Groups button (on the Groups region head) | wordless `external` · `aria-label` and `title`: Open Groups · no groups: `title` "No groups yet. Drag a session to start one." |
| Group picker (§app.session-list/group-picker) | title **Groups** · hint "Open one as a workspace." · `Close` · a group: {name}, then "{n} sessions" (1: "1 session") · empty: {name} with an `Empty` chip, then "Nothing is in it yet. Drag a session into it first." (wrapped, never truncated) · no groups: "No groups yet. Drag a session to start one." |
| Group name field (Rename, and New group in the session pane's Move into group) | placeholder Group name · `aria-label` "New group name" / "Rename “{name}”" · button `Save` · Enter saves, blur saves, Escape cancels |
| Group section label | {name} (own case, no eyebrow), then its count · `title`: {name} |
| Empty group | No sessions yet. Drag a session to file it here. |
| Groups region, no groups | No groups yet. Drag a session to start one. |
| Open workspace (group tool row, §workspace/groups) | `Open workspace` · `title`: Open “{name}” as a workspace — every member side by side |
| Group tool row | `Rename` · `Delete group` · asking: with sessions "Delete “{name}”? Its {n} sessions stay in the list." (1 session: "… Its 1 session stays …"), empty "Delete “{name}”? Nothing is in it." — with `Delete group` · `Cancel` |
| Group toasts | "Added to “{name}”." · "Moved to “{name}”." · "Removed from “{name}”." · "Deleted “{name}”. Its {n} sessions are ungrouped." (1: "… Its 1 session is ungrouped.") · "Deleted “{name}”. It had no sessions." · failures: "Couldn't create the group. {server message}" · "Couldn't rename the group. …" · "Couldn't delete the group. …" · "Couldn't move this session. {server message}" |
| Drop overlay (§app.session-list/drop-overlay) | head "Move “{title}”" · hint "Drop it on a group or on Archive. Let go anywhere else to cancel." · announced on open: "Moving “{title}”. Drop it on a group, Archive, New group, or Cancel." |
| Drop overlay tiles | `New group` · `Remove from “{name}”` (grouped rows only) · a group: {name}, then "{n} sessions" (1: "1 session"; 0: "Empty") · the row's own group: {name}, then `Current` · `Archive` · `Cancel` · under the pointer, the second line becomes: "Drop to name a new group" · "Drop to remove" · "Drop to move here" (a grouped row) / "Drop to add here" · "Drop to archive" · "Drop to cancel" |
| Drop overlay, no groups yet | `New group`'s second line: "No groups yet. Drop here to start one." |
| Drop overlay floating card (under the dragged row's copy) | "Move to “{name}”" (a grouped row) / "Add to “{name}”" · "Remove from “{name}”" · "Into a new group" · "Archive" · "Cancel" · refused or inert: "Already in “{name}”" · "Can't drop here" · "Can't archive" · over nothing: "Let go to cancel" |
| Drop overlay, unavailable | groups (head note, once): "Organization sessions stay with their project." · "Groups hold this host's sessions only. That one lives on {host}." · Archive, under its label: "Can't archive: {reason}" (archiveBlockReason's words) · "Already archived." · "Already in the Archive." · dropped on anyway: the same words as a toast (Archive: "Can't archive this session: {reason}.") |
| New group dialog (a drop on New group) | title **New group** · "“{title}” moves into it." · field placeholder Group name, `aria-label` "New group name" · buttons `Cancel` · `Create and Move` (disabled while empty, `title` "Type a name first.") |
| Move into group (session pane, §chat/transcript) | trigger `Move into group` · `title`: Move into group / In the group “{name}” · rows: No group, then every group, `New group…` · Identity fact: Group: {name} / None · popover failure: "Couldn't move this session." then "This session's group is unchanged." |
| Archive cleanup toolbar | eyebrow "Delete" · buttons `Older Than 7 Days` · `Older Than 30 Days` · `Empty Sessions` (`aria-label` "Delete Sessions Older Than 7 Days", …) · pending "Checking…" |
| Archive cleanup dialog | **Delete {n} sessions?** {scope} This permanently deletes their transcript files — this can't be undone. · skipped "{n} skipped: {a} open in a TUI, {b} mid-turn, {c} just written. They stay as they are." · buttons `Delete {n} Sessions` ("Deleting…") · `Cancel` · none: **0 sessions to delete.** · `Close` |
| Archive cleanup toasts | "Deleted {n} sessions." (+ " {skipped}.") · "Couldn't check what to delete. Nothing was deleted. {server message}" · "Couldn't delete sessions. Some may be gone; the list is refreshed. {server message}" |
| Empty top region note | 0 sessions open in a TUI, or started here and not archived. The archive below has the rest. |
| Loading | skeleton only, no text |
| Error banner | **Couldn't read your sessions.** `~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry. · button: `Retry` |
| Empty (0 on disk) | **0 sessions in `{the server's sessions folder}`.** (`~/.pi/agent/sessions` on a default host; before the server says: **0 sessions yet.**) Start one here, or run `pi` in a terminal. It'll show up in this list. · button: `New Session` |
| No matches | **0 of {total} match “{query}”.** We search titles, folders, models, and tags. · button: `Clear Search` |

## §design.copy-deck/main-pane — Main pane

| Where | Copy |
|---|---|
| No session selected (the overview) | Title: **Overview** (no count and no body line; the Sessions card has the count) · eyebrow `Start`, then action cards, title and line: `New Session` "Start a chat with pi in any folder or on any host." · last, eyebrow `Organizations`, a card titled `Organizations` "Keep each client's people, projects, and hand-off sessions together.", totals `Organizations` · `People` · `Projects` · `Open hand-offs` · `Needs you`, rows `{n} people · {n} projects · {n} open hand-offs` · `Needs you · {n}` · `Active {relative time}`, `View all {N}`; with no org, `Create Your First Organization` · a phone's list-head button to it: icon-only, `aria-label` and `title` "Overview" (§app.shell/overview) |
| No session selected, Explanations card | section head: `Explanations` · card title `Explanations`, chip `{n}` · line `Latest · {topic} · {relative time}`, or "No explanations yet. Run `/explain` in a session to write one." (the page's own copy is §app.insights/explanations-page) |
| Transcript load error (a watched TUI session) | **Couldn't load this transcript.** The file at `{path}` wasn't changed. {server message} · button: `Retry` · a chat that can't open says §app.shell's open-failure words instead |
| New empty session | **New session in `{cwd}`.** · the setup card (the rows below) · then the footnote: Your first message becomes its title. |
| New empty session, setup card figures | a file row or a section total: `{size} · {n} lines · ≈{tokens} tokens` (the token figure only when the server sent one) · under Context: "Loaded into the prompt." then, with token figures, "Token counts are estimates: 4 characters per token." · under Skills, with token figures: the same sentence after its note · commits: `{short oid} {subject} {age}` per row, or "The last commits couldn't be read." |
| New empty session, setup card | `aria-label` "Session setup" · aggregate line `System context` with its figures, `title` "Everything pi loads into the prompt, plus the skills it offers." · in place of Context and Skills, a remote session: "Skills and context files are read on {target}, so they aren't listed here."; an unreadable folder: the server's sentence, e.g. "This session's folder no longer exists: {cwd}." · a failed request: "Couldn't read what pi loads here. {message}" · "Couldn't read this session's repository. {message}" |
| New empty session, setup card Context | heading `Context · {n}` · roles "replaces the system prompt" · "appended to the system prompt" · none: "No context files. pi loads AGENTS.md or CLAUDE.md when a folder has one." (its note is in the figures row above) |
| New empty session, setup card Skills | heading `Skills · {n}` · note "Offered to this session. A skill loads when it is used.", then "Skills an extension adds aren't listed." when Sova's own loader built the list, then the token sentence · none: "No skills offered to this session." (+ the same caveat, on the same condition) |
| New empty session, setup card Repository | heading `Repository` · head `{branch}` · `{branch} · no commits yet` · `Detached at {oid}` · `Detached` · upstream `Level with {upstream}` · `{a} ahead, {b} behind {upstream}` · `{upstream} is gone`, `title` "Counted against the upstream as this repository last fetched it. Sova never fetches." · changes `Clean` · `{n} conflicted · {n} staged · {n} unstaged · {n} untracked` (non-zero only) · `At least {tallies}` · `Not fully read` · `+{added} −{removed}` · notes "Line counts stopped at the size limit. Paths past it say "not counted"." · "Counting lines took too long in this repository. Rows say "not counted"." · "Git couldn't count lines here. Rows say "not counted"." · "Git status was cut short, so these counts are lower bounds." · no repository: "{folder} isn't inside a git repository." · unavailable: the server's sentence |
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
| Alignment card, answerable (§chat.alignment/card) | button `Go With Recommendations` · hint "Or pick some answers and type the rest below." · its reasons: the composer's blocked reason · "Wait for the turn to end." · "Send or clear your draft first." · checkbox name "Take the recommendation for {qN}." · sends `{al_N}: go with your recommendations for every open question, and go ahead.` · ticks send `{al_N}: take your recommendation on {q1}, {q2} and {q3}.` · option picks send `{al_N}: my answers: 1b — {label}; 3b — {label}.`, after ticks `… {q3}. My answers: 2b — {label}.` (one line per alignment) · option radio name "Answer {qN} with {letter}: {label}" · staged row above the composer (group "Staged answers") `Answering: {al_N} q1 b, q2 rec; {al_M} q2 rec` · `Clear Picks` |
| Alignment card (§chat.alignment/card) | eyebrow `{al_N} · Alignment · v{rev}` · status chips (none while aligning) Confirmed · Implementing · Done · Dropped · meta `{k} of {n} open` (none: `No questions yet`; none left open: `All {n} decided`) · `· {change line}` · question chips Open · Decided · Dropped · option letters `a` `b` `c`… · `Recommended` (small caps, no colon) `{letter} — {label}`, `{why}` on the next line (names an option) / `Recommended` `{choice}`, `{why}` on the next line · `Decided: {text} · you` / `· accepted recommendation` · `Dropped: {why}` · sections `Findings · {n}` · `Approach · {n}` · `Rejected · {n}` |
| Alignment revision row | `{al_N} v{rev} {title} · {change line}` · change words (the extension's `changeLine`, joined by " · "): created · created from file · +q11 +f4 · q3, title edited · −f2 −a1 · q1, q3 decided · q1, q2 accepted · q3 reopened · q3 dropped · → implementing · → done · → open · dropped |
| Alignment exempt row | No alignment needed: {why} |

## §design.copy-deck/message-actions — Message actions (§chat.transcript/message-actions)

| Where | Copy |
|---|---|
| Strip `aria-label` | Actions for your message · Actions for this reply · Actions for your queued message |
| Button `aria-label` (also the `title` when enabled) | `Copy message` · `Share from here` · `Rewind to before this message` · `Regenerate this reply` · `Remove this queued message` |
| Copy landed | icon flips to the check for 1.5s · toast "Copied message." · clipboard failure keeps the existing "Couldn't reach the clipboard. Nothing was copied." |
| Rewind armed | note "This message and every reply after it leave the branch. The session file keeps them." · buttons `Rewind Here` · `Cancel` |
| Regenerate armed | note "The message that started this reply, and everything after it, leave the branch. The session file keeps them." — "this REPLY", never "this turn": the server rewinds to the nearest user message, and a MID-TURN STEER is one, and the leaf moves to that message's PARENT: in `u1 → a1 → tool → s1 → a2`, regenerating a2 drops s1 and a2 while u1/a1/the tool call stay, and regenerating a1 drops a1, the tool call, s1 and a2 · buttons `Regenerate Here` · `Cancel` |
| Regenerate landed | SR "Regenerating from your message." (the rewound message's own copy stays §chat/timeline's) |
| Blocked, mutating actions (`title`) | Stop the current turn first. · Wait for the compaction to finish. · This session is open in a terminal, so Sova won't write to it. · Only a chat open in Sova can rewind. / …can regenerate. · A rewind is already in progress. / A regenerate is already in progress. · a message still on its way out (server refusal `queued`, which happens with isStreaming FALSE — the client cannot pre-check it): the server's own sentence, "A message is still on its way out. Wait for it to send, or press Stop, then rewind." / "…then regenerate." · a reply to a wake nudge: "That reply answered a scheduled wake-up, not a message you sent, so there's nothing to send again." (permanent — it outranks every state that clears on its own, and the server refuses it too with `regenerate_refused` reason "wake") · the composer's own reason while the chat can't write (Switching model…, Reconnecting. Your draft is kept., This session is archived. Unarchive it to send.) |
| Blocked Share (`title`) | Sova is still reading this session's details. Share enables itself once they load. |
| Queued message head | `Sending…` (nothing holds it yet) · `Queued` (the server says it does), each a dot AND the word · the author is `You`, `Overseer` (eye icon) for a message the Overseer sent (`sova_send`), or `Sent by Sova` for a message the session queued for itself (a group send, a remote status probe) |
| Remove blocked (`title`) | Not queued yet. This can be removed once the server has it. · Already sent. It can't be removed now. · Removing… · Only a chat open in Sova can remove a queued message. |
| Remove landed | SR "Removed from the queue." in every tab, including the one that asked. Delete is a DISCARD: the message does NOT come back to the composer (that is Stop's job, §chat/composer "Stop"), so no sentence claims it did |
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
| Gave up (retries exhausted) | `.banner-error` at the top of the transcript; composer reason "Not connected." | **Lost the connection to the Sova server.** Nothing in the session changed. Check `pnpm run dev:server` is running, then retry. · button: `Reconnect` |
| Reconnected | nothing. The banner or reason simply disappears; no toast | — |

## §design.copy-deck/composer — Composer

| State | Copy |
|---|---|
| Label (visually hidden) | Message |
| Placeholder, idle | Enter sends: Enter sends · touch mode (§chat.composer/behavior) and read only: none |
| Placeholder, streaming | Enter sends: Steer the current turn… Enter sends · touch mode: Steer the current turn… |
| Buttons | `Send` · streaming: `Steer` + `Stop` · after Stop is pressed: "Stopping…" in run status |
| Run status | Wide composer (≥ 620px): `Working` + detail: `· thinking` / `· writing` / `· running {tool}`, and beside it the subagents trigger: `2 of 5 subagents working` (team members among them: `2 of 5 team members working` · `3 of 5 workers working`, the split `1 subagent · 2 team members` in the tooltip), `5 subagents` once all have settled. Narrow: no visible words, the dot and the step's icon, and the trigger as its ring and a count (`2/5`, settled `5`); the same words are the tooltip and accessible name · in both: `Stopping…` · `Compacting context` · `Retrying after a provider error` · `Waiting for zai · 5 of 5 in use` (+ ` (lowered after a rate limit)`, §app.provider-limits/waiting-shown) · trigger name: `2 of 5 subagents working — show subagents` · settled: `5 subagents — show subagents` |
| Alignment chip (§chat.alignment/chip) | `{n} aligns · {decided}/{total} decided` (1: `1 align · …`) · `aria-label` "{n} open alignments, {decided} of {total} questions decided — show alignments" · menu rows: {id} {title}, then "{decided}/{live}" (no live questions: the status word) · row `aria-label` "{id} {title}: {decided} of {live} questions decided — jump to its card" (no live questions: "{id} {title}: {status}, no questions — jump to its card") · off-screen toast: "That alignment isn't in the transcript on screen." |
| Staged answers (§chat.alignment/card) | `Answering: {al_N} q1 b, q3 rec` (alignments joined by "; ") · group label "Staged answers" · `Clear Picks` |
| Reason: TUI-live | Read only while this session is open in the TUI. |
| Reason: busy (server `code:"busy"`) | the session reopens read only: Read only while this session is open in the TUI. |
| Reason: connecting / reconnecting / gave up | see Connection above |
| Busy fallback, when the message was already typed and rejected | the draft stays in the textarea (not cleared), plus the busy reason. No banner |
| Turn error banner (in thread) | **The turn stopped with an error.** {message}. Your messages are kept. Send again to retry. |
| Mic (§chat/voice) | `aria-label`/`title`: Dictate · recording: Stop Recording · transcribing: Transcribing · setting up: `Dictate — setting up voice, {n}%` · not set up: `title` "Dictate · Voice isn't set up on this host yet" · unsupported: `title` "Voice needs HTTPS or localhost." (no microphone API: "This browser can't record audio.") |
| Dictation strip | Starting the mic… · `Recording {m:ss}` · `Recording {m:ss} · {s} s left` · `Transcribing {m:ss}…` · Cancel Recording · group label "Dictation" |
| Dictation errors (strip; `Try Again` where the clip is kept, then Dismiss) | Mic blocked: "The browser blocked the microphone. Allow it for this site, then try again." · no mic: "No microphone found." · other: "Couldn't start the microphone. {message}." · nothing heard: "Didn't catch any speech. Nothing was inserted." · empty transcript: "Heard audio but no words. Nothing was inserted." · failed: "Couldn't transcribe the clip. {reason}. Your recording is kept." · voice removed meanwhile: "Voice isn't set up on this host anymore." |
| Dictation, backgrounded (toast and announcement) | Recording stopped when the app went to the background. Transcribed {m:ss}. |
| Dictation announcements | Recording. · Recording cancelled. · Transcribing. · `Inserted {n} words.` (1: `Inserted 1 word.`) · `{s} seconds left.` at 0:30 |
| SR announcements | Working. · Reply finished. · The turn stopped with an error. (once per error, and it replaces that turn's "Reply finished." — an errored turn still settles, and two endings would read as two turns) |

## §design.copy-deck/composer-flyout — Composer flyout

| Where | Copy |
|---|---|
| Trigger | `aria-label` / `title`: More Actions |
| Menu panel `aria-label` | More actions |
| Menu panel rows | Attach images · Commands · Playbooks · Hide tool calls · Hide thinking · Sandbox · Undo last turn (in this order, each only where it applies: Playbooks in chat sessions, §chat/playbooks; Sandbox where the runtime has a `sandbox` command, §chat/sandbox; Undo last turn per §chat/timeline) |
| Model panel `aria-label` | Model and thinking |
| Model panel rows | Model · the Thinking group |
| Model row | {id} · {provider} (`title`: {provider/id}) · no model: Choose model |
| Thinking group label | Thinking |
| Thinking rows | the model's levels, verbatim and in ladder order: off · minimal · low · medium · high · xhigh · max |
| Thinking disabled `title` | Thinking changes wait until this turn finishes. · else the composer reason for that state |
| Back from the picker (to the model panel) | `Back` |
| Login panel `aria-label` | Claude login |
| Login panel rows | a group per account (its email · Unknown account), then This device; each login's name, and "Borrow" · "After this reply" · or the disabled reason; the waiting line, Cancel switch, and the resend note, per §app.claude-logins/switch-login, /switch-queue and /switch-cost |
| Thinking error title | Couldn't set thinking to `{level}`. |
| Thinking error: running | Thinking changes wait until this turn finishes. You're still on `{level}`. |
| Thinking error: unknown level | pi doesn't know this thinking level. You're still on `{level}`. |
| Thinking error: timeout | The server didn't confirm the change. You're still on `{level}`. |
| Thinking error: other | {server message}. You're still on `{level}`. |
| Thinking error action | Dismiss |

## §design.copy-deck/sandbox — Sandbox (§chat/sandbox)

| Where | Copy |
|---|---|
| Flyout row | Sandbox (checked while on) |
| Flyout row `title`, off | Confine this session's tools, from the next tool call. |
| Flyout row `title`, on | {status}. Turning it off applies from the next tool call. |
| Composer shield word | (full: none) · Partial · Unavailable · Not enforced |
| Composer shield `title` / accessible name | {status}: the extension's status line (below, TUI `/sandbox`) |
| Toast and announcement on a flip | {status} (the extension's own line) |
| Flip refused: another writer | Sandbox unchanged: another writer has this session. Nothing was written. |
| Flip refused: other | Sandbox unchanged: {server error} |
| Flip refused: server errors ({server error}) | Invalid or missing ?path= (must be a .jsonl under the pi sessions dir) · Expected JSON body { on: boolean } · That session isn't open on this server; open the chat first |
| Unavailable refusal (tool error) | Sandbox unavailable: {reason}. Nothing ran. Turn the sandbox off to run tools unconfined. |
| Denial note (end of a tool result) | [sandbox: a write or connection outside the policy was refused] |
| Hidden results omitted (end of find/grep output) | [sandbox: {n} result line(s) under hidden paths were omitted] |
| Worker `/sandbox off` refused | Sandbox: this session was started with --sandbox on (a worker inherits it from its parent); it cannot be turned off here |
| Proxy refusal (403 body) | sova sandbox: {host} is not in the sandbox proxy allowlist |
| Proxy refusal, port (403 body) | sova sandbox: port {port} is not in the sandbox proxy allowlist |
| Proxy refusal, local address (403 body) | sova sandbox: {host} resolves to {address}, a local address, which is not in the sandbox proxy allowlist |
| Per-project loosening ignored | Sandbox: `.sova/sandbox.json` can only tighten; ignored `{key}`. |
| TUI `/sandbox` (describeActive) | Sandbox off · Sandbox on · {level} · full enforcement · Sandbox on · {level} · partial enforcement ({reasons}) · Sandbox on · {level} · unavailable: {reasons} (tools refuse) · not enforced (a remote session): Sandbox on · {reasons}, e.g. Sandbox on · not enforced on remote; with no reasons, Sandbox on · not enforced |
| TUI transcript marker (terminal only; Sova's transcript shows none) | Sandbox → on · {level} · {enforcement} enforcement (not full adds: · {reasons}) · not enforced: Sandbox → on · {reasons} (no reasons: not enforced) · Sandbox → off |

## §design.copy-deck/playbooks — Playbooks (§chat/playbooks)

| Where | Copy |
|---|---|
| Flyout row (§chat/composer) | Playbooks · chat sessions only, absent in a watch view · while the composer is blocked: `aria-disabled`, described by the composer's reason |
| Modal title | step 1: Playbooks · step 2: {title}, the playbook's own |
| Group headings | Sova · Yours · This project (a group with no rows has no heading) |
| Row | {title} · under it {description}, one line, truncated, the full text in the row's `title` · no description: the title alone · frontmatter `title`, else `name`, else the id (each skipped when missing, empty or whitespace-only) |
| Step 1 foot | `Close` |
| Loading | skeleton rows after 300ms, no words |
| Load failed | `.banner-error` **Couldn't load the playbooks.** {error} · action `Retry` |
| Empty (no rows in any group) | No playbooks yet. |
| User folder unreadable | We couldn't read your playbooks folder, so yours aren't listed. {error} |
| This project, remote | the server's message: This session's files live on {target}. Project playbooks are read from local folders only · client fallback, no message sent: This session's files live on its target, so project playbooks aren't listed. |
| This project, missing | the server's message: cwd must be an absolute path · {path} doesn't exist · {path} is not a folder · Sova can't read {path} ({code}) · Sova couldn't read {path}/.sova/marketing/playbooks: {error} · client fallback, no message sent: We couldn't read this session's folder, so project playbooks aren't listed. |
| Step 2 body | {description} (the title is in the modal head, not repeated) · textarea label: Anything to add · hint: {promptHint} verbatim, or no hint |
| Buttons, step 2 | `Back` · `Send Playbook` (the label never changes; there is no in-flight label) |
| Send blocked | the composer's reason for that state, with its icon, beside `Back` (§design.copy-deck/composer, §design.copy-deck/connection) · model turned off: {ref} is turned off in Settings → Models. Pick another model, then send this again. |
| The sent turn (verbatim, §chat/playbooks) | Playbook: {title} — {absolute dir} / Every relative path in this playbook is relative to that directory; read its files as the playbook directs. / blank line / {body} · with your text: then a line `---`, a blank line, {your text, trimmed} |

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
| Lightbox counter | {i} / {n} |
| Lightbox buttons | Close Image · Previous Image · Next Image |

## §design.copy-deck/model-menu — Model menu

| Where | Copy |
|---|---|
| Opened from | the Model row on the composer flyout's model panel (see "Composer flyout" above) and `Ctrl+P` / `⌘P` |
| Menu `aria-label` | Choose model |
| Search placeholder / label | Search models · on one provider's step: Search {provider} |
| Listbox `aria-label` | Models · on one provider's step: {provider} models |
| Group labels | Favorites · Providers · while searching on Providers: each provider's name |
| Provider row caption | {n} models · 1 model |
| One provider's head | {provider} |
| Foot (≥768) | `↑` `↓` to move · `Enter` to choose · `Esc` to close |
| No matches | 0 models match “{query}”. |
| No models | 0 models have credentials. Log in with `pi` in a terminal to add one. |
| Load failed | **Couldn't load models.** Your current model is unchanged. · `Retry` |
| Blocked, running | **Model changes wait until this turn finishes.** Stop or wait, then pick one. |
| Composer reason while pending | Switching model… |
| Announce on success | Model changed to {id}. |
| Toast on success | Model changed to {id}. |
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
| Foot | strict: {on\|off} · A switch here is this chat's own. New sessions start from the default. |
| Save button | `Save as default` · while the save is in flight: `Saving…` · when this chat's mode, strict flag and minors are the file's: ✓ `Already the default` (`aria-disabled`). The visible label is the accessible name |
| Save button `title` | New sessions will start from {mode · strict · minors}. · already: New sessions already start from {mode · strict · minors}. · this chat's mode not arrived: Make this chat's mode the default for new sessions. (already: New sessions already start from the default mode.) — `strict` named only when on |
| Save failed | **Couldn't save the default.** {reason}. Your mode is unchanged. |
| Saved (announcement) | Default mode saved: {mode · strict · minors}. New sessions start here. · this chat's mode not arrived: Default mode saved. New sessions start here. |
| Pending | **Applies after this turn.** This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one. |
| Can't switch | **This chat can't switch.** This chat can't switch: the mode extension isn't loaded here, or another program wrote this session. |
| Switch failed | **Couldn't switch the mode.** {reason}. Your mode is unchanged. |
| Load failed | **Couldn't load the modes.** Your mode is unchanged. Close this and try again. |
| Transcript marker | Mode → {mode} · Minor mode: {minor} on\|off (shown as recorded) |
| Toast (from the extension) | Mode: {mode} · Minor mode: {minor} on\|off |

## §design.copy-deck/context-window — Context window

| Where | Copy |
|---|---|
| Head ≥720px, beside the ring | `{tokens} / {window}` (e.g. `222k / 1M`) · window unknown: `{tokens}`, no ring |
| Head <720px, beside the ring | `{tokens}` (e.g. `222k`) · window unknown: `{tokens}`, no ring |
| Percent | never shown in the head; only in the Title / AT sentence below |
| Compacted | compacted (no ring) |
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
| Empty | 0 commands match “/{query}”. Enter sends it as a message. · touch mode (§chat.composer/behavior): 0 commands match “/{query}”. |
| Foot (≥768) | `Enter` or `Tab` to insert · `Esc` to close |
| Announce | {n} commands available. · empty: 0 commands match. |
| Thread row after sending | Ran `/{name} {args}` |
| Needs TUI (thread row) | `/{name}` needs the terminal UI. Run it in pi in a terminal. |
| Needs TUI (menu line 2, if the contract gains a flag) | Needs the terminal UI |

## §design.copy-deck/new-session-dialog — New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Field, nothing chosen | Choose a folder |
| Recent label | Recent folders |
| Picker | group label "Choose a folder" · breadcrumb `aria-label` "Path" · buttons `Home`, `Recent`, `Use This Folder` · checkbox "Show hidden folders" · filter placeholder "Filter", `aria-label` "Filter folders in {name}" / "Filter recent folders" · list `aria-label` "Subfolders of {name}" / "Recent folders" · symlink tag "link" |
| Picker notes | Loading folders… · No subfolders in {name}. You can still start the session here. · 0 of {n} match “{filter}”. · Showing the first 500 folders, A to Z. Filter to narrow them. · Sova can't read this folder. Pick another one. · This folder doesn't exist. Pick another one. · Couldn't list this folder. {server message} · No recent folders yet. Sessions you start add theirs here. |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |

## §design.copy-deck/insights — Insights (§app/insights)

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
| Provider `expired`, token timed out (refresh token not known expired) | Sign-in token expired {2h ago}. It renews the next time Claude Code runs; usage updates after that. (OpenAI through pi: … the next time pi uses OpenAI; …) |
| Provider `expired`, otherwise (refresh token expired, no sign-in data, or revoked early) | Sign-in expired. Run `claude /login` to renew it. (OpenAI: `pi /login`) |
| Sign-in caption (OAuth cards, `.usage-card-caption`) | Sign-in renews by `{11:09 PM}` · last renewed {3h ago} (second part only when known; `Sep 27 11:09 PM` on another day) · Codex CLI only: Sign-in last renewed {Jul 29} · token expired, card still showing a reading: the timed-out sentence above · refresh token expired: Sign-in can't renew. Run `claude /login` to sign in again. (OpenAI: `pi /login`) · API keys: none |
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
| Aggregate chips | sidebar rail: `{n}` + worker icon · session head: none |
| Current goal summary | Current goal · {now} · {n} topics (1 topic) |
| Current goal state line | Updated {rel} · stale adds: " · behind the latest messages" · failed-keeping-last adds: " · the last update failed, so this is the previous summary" · updating/drafting: "Updating" + live dot |
| Current goal jump | Jump to Message |
| Compaction | Compacted · `{tokens}` tokens summarized (no count: Compacted · earlier messages summarized) · Files read · Files changed |

## §design.copy-deck/subagents-pane — Session detail pane (§app/subagents-pane)

| Where | Copy |
|---|---|
| Trigger | `{w} of {n} subagents working` (1 of 1: `1 of 1 subagent working`), the same while the parent's turn runs · narrow: `{w}/{n}` · all settled: `{n} subagents`, narrow `{n}` · accessible name: `{w} of {n} subagents working — show subagents` · settled: `{n} subagents — show subagents` |
| Pane | label and title: Session detail · tab strip `aria-label`: Session detail tabs · chip: `{w} working` (omitted at 0) · Close `aria-label`: Close session detail |
| Row meta | `{provider}` · `{model}` · settled: `{model} · as of {HH:MM}` · idle after a failure adds: · last task failed (the provider leads: `claude code`, `zai`, …) |
| Row status chips | Working · Starting · Queued (its `title` the waiting sentence) · Idle · Stopping · Done · Failed · Stopped · Restored · Interrupted · beside any of them, for a team member whose seat was released: Ejected |
| Restored workers (§app.worker-restore/restore) | note: Not running since a server restart. · interrupted: Not running since a server restart; it was mid-task at `{HH:MM}`, and that turn never finished. · meta without usage: usage unavailable · snapshot cost: `$0.41 as of {HH:MM}` |
| Usage tab | tab: Usage · headline: `{n}` tokens in and out · `$x` · Where: Main thread · Subagents · Team · footer: Main thread Σ · note: Main thread counts the active branch only. · workers: `{n}` subagents · `{w}` working (1: `1 subagent`) · nothing spent: Nothing spent in this session yet. · head chip: `{n} tokens`, accessible name `{n} tokens — show usage` |
| Usage tab, after a restart | Cost cell: `$x*` (muted `*`, `title` "As of {HH:MM}") · note under the table: * Cost as of `{HH:MM}` (`{HH:MM} and {HH:MM}`), the last report before the restart. · Usage unavailable for `{ids}`: we couldn't read its transcript (their transcripts), so the totals above leave it (them) out. · Subagent lifetime: {n} tokens · `$x as of {HH:MM}` across {N} workers, then only as far as it applies: (includes evicted) · (includes restored) · (includes evicted and restored). |
| View head modes chip | on the title row, right before the status chip: `{a}` / `{a}, {b}` — the mode names, comma-joined (only when it was given one; hover: "The modes this worker was given when it started.") |
| View head id | beside the title, muted mono: `{id}` (e.g. `ag_02`) |
| View head meta | `{model}` (hover: `{provider} · {model id}` — a claude-code worker's provider reads `claude code`) · `{level}` (only when the worker has an effort; hover: "effort {level}") · `{tokens} tok` (hover: the usage breakdown) · usage unavailable (when it has none) · `{context fill}` — compact, last, at the line's right edge with no `·` before it: the context ring + "`{pct}%`", hover: the §chat/context-window sentence; "Context `{tokens}`" when the window is unknown, "Context compacted" after a compaction, nothing before a reply has measured one |
| Transcript section `aria-label` | {name} transcript |
| Workers the live record doesn't list (§app.subagents-pane/hidden-workers) | line: `{shown} of {total} shown` · button: Show `{n}` More (`{n}`: every hidden worker, all added at once) · while loading: Loading… · failure: the reason, in the button's `title` |
| No workers | **0 subagents in this session.** Workers it starts show up here while they run. |
| None selected | **{n} subagents, {w} working.** Pick one to read its transcript. |
| No session yet (Claude Code) | **Its transcript isn't available in Sova.** `{name}` is starting — no Claude session yet. Latest: {preview} |
| No session file (pi) | **Its transcript isn't available in Sova.** `{name}` runs on a pi that doesn't publish its session file yet. Latest: {preview} |
| File gone, first load | **Couldn't find this worker's transcript.** `{path}` is gone. Nothing else changed. |
| File gone after loading (banner-warn) | **This transcript's file is gone.** What's shown is up to `{HH:MM}`. |
| Transcript file empty (just started) | **0 entries in {name}'s session so far.** Entries show up here as it writes them. |
| Pane's session-insight fetch failed (banner-warn) | **Couldn't load this session's subagents.** {message} Your workers keep running. We'll retry on our own. |
| Transcript socket and load errors | the §app/subagents-pane state table: Live-watch and Connection copy above, and Main pane's transcript load error |

## §design.copy-deck/settings-modes-delegate — Settings · Modes → Delegate (§app/settings-dialog)

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
| Close held (banner-warn, above the dialog foot) | **Your Delegate changes aren't saved.** Save them, or discard them and close. [Keep Editing] [Discard and Close] — every Save-gated tab shares it, naming each form with unsaved changes ("Your Models and Decisions changes aren't saved.", §app.settings-dialog/save-bar) |
| Section heading button (small, ghost) | Reset to Defaults — Delegate, Teams and Summaries each have one; it fills the draft and saves nothing |
| Dialog footer (every tab) | {status line} · Discard Changes · Save Changes (Saving…) · Cancel — with nothing unsaved: {status line} · Close. The one Save and Discard for every Save-gated form on every tab (§app.settings-dialog/save-bar) |
| Footer status line (first match; the outcome of a save is also announced in the same words) | Saving… · {why Save waits} · Saved {forms}; {forms} failed. · {forms} failed. · Unsaved: {Form}, {Form} · Saved {forms}. · (nothing) — {forms} joined with commas and "and", "Unsaved:" with commas only |
| Why Save waits (footer status, error; Save Changes disabled) | Delegate needs a primary model. · Delegate needs an effort for a primary model. · Delegate needs a fallback model. · Delegate needs an effort for a fallback model. · Delegate has a fallback that's the same worker as its primary. · Spec needs a model for its writer. · Spec needs an effort for its writer's model. · Spec needs a fallback model. · Spec needs an effort for its fallback model. · Spec has a fallback that's the same worker as its writer. · Teams needs a role name for the {coordinator/monitor}. · Teams needs a model and an effort for the {role}. · Teams needs a model and an effort for the {role}'s fallback. · Teams needs a number for the {field}. · Teams needs a whole number from {min} to {max} for the {field}. · Teams: {conflict}. · Overseer: {issue}. · Decisions needs a fallback model. · Decisions needs an effort for its fallback model. · Decisions: {Folders issue}. · Summaries needs a primary model. · Summaries needs a fallback model. · Summaries has a fallback that's the same model as its primary. · Summaries can't be saved: its file can't be read. · Mesh: This host needs a name. |
| Discarded (announced only) | Discarded your {forms} changes. |
| Footnote | Stored in `~/.pi/agent/mode-delegate.json`, shared with pi in the terminal. |

## §design.copy-deck/settings-decisions — Settings · Decisions (§app.settings-dialog/decisions)

| Where | Copy |
|---|---|
| Tab | Decisions (icon `shield`) |
| Intro | Sova can ask a small classifier about your sessions — whether a finished turn is waiting on you, and what a session is about. Everything here is off until you turn it on. |
| What is sent (above the switches) | Each check sends a short, redacted excerpt of one session — its title, the last exchange, and recent tool names — to Jev (TypeSafe) or your fallback model; never whole transcripts, images, or files. The Overseer's own sessions are never checked. |
| Load failed (banner-error) | **Couldn't load the decision settings.** Nothing was changed. [Try Again] |
| Jev (legend · hint) | Jev · TypeSafe's classifier. Fast and cheap — about $0.0001 a check. |
| Jev switch | Use Jev |
| Jev chip (dot and word) | Working · Not checked · Checking · Off · No key · Rejected · Out of credit · Paused |
| Jev fact | No key stored. · Key ending {last4} · checked {2h ago}. · Key ending {last4} · not checked yet. · Key ending {last4} · couldn't check it: {reason}. · Jev rejected this key. Replace it, or turn Jev off. · Jev says this account is out of credit. · Checking the key… · env: "Key ending {last4} (from SOVA_JEV_KEY) …" |
| Key field | label Jev key · placeholder Paste a key · `Save Key` · stored: `Replace Key` · `Remove Key` · issues: Paste a key. · A key has no spaces. · That doesn't look like a Jev key. |
| Key from the environment | The key comes from SOVA_JEV_KEY in the server's environment, so it can't be changed here. |
| Remove Key, asking | The stored key is deleted from this machine. Jev stays switched on but can't answer until you save another. · `Remove Key` (Removing…) · `Cancel` |
| Rejected key | Jev didn't accept that key, so it wasn't saved. {server reason} |
| Fallback model (legend · hint) | Fallback model · Answers when Jev is off or can't. Its provider bills it — a local model keeps every check on this machine. |
| Fallback choice | None · A model · then the row labelled Fallback model · Suggested: `{model} ({backend})` buttons |
| Refused fallback (under the row, error) | {server reason}. Your saved fallback model is unchanged. |
| Fallback notes (under the row, warn) | {server note, without its "Fallback model:" label}. · Not verified, because {backend} couldn't list its models ({why}): Fallback model. |
| Options failed (banner-warn) | **Couldn't check which models are offered.** Your saved choice stays, marked not verified. [Check Again] |
| Features (legend) | Features · Flag sessions that need you — After a turn, checks whether the reply asks you something or a long turn went in circles, notices a team gone quiet and whether a merge left work open, and marks the row. The Overseer lists them too. · Tag sessions — Gives each session a topic you can search. |
| Unavailable (replaces a switched-on feature's hint, warn) | Unavailable: Jev is off and no fallback model is set. Nothing is checked. · Unavailable: Jev can't answer ({reason}) and no fallback model is set. Nothing is checked until one of them can. |
| Features note (under the switches, warn, when they don't already say it) | {server reason} The features stay unavailable and send nothing until one is. |
| Never send (legend) | Never send · switch Never send TUI sessions — Sessions started in the pi terminal stay on this machine. · Folders — One per line. Sessions in these folders, and their subfolders, are never checked. · issue: "{line}" isn't a full path. Start it with / or ~/. · That's {n} folders. Use at most 100. |
| Chain sentence (ends Fallback model) · Test (Jev key row) | Asks Jev, then {model}. · a paused provider: Jev (paused, retrying in {n} s) · `Test Decisions` (Asking…) |
| Test result | Answered by Jev in 0.4 s. · Answered by {model} in 4.1 s, after Jev {was rate-limited / rejected the key / was out of credit / was overloaded / timed out / was unreachable / was sent too much to read / gave an unusable answer / had a server error / couldn't be used}. · a model without auth: {model} had no auth · No answer. {why} |
| Tag past sessions (legend · hint) | Tag past sessions · New sessions are tagged as they finish. This tags the ones from before, 2 at a time, and skips any already tagged. On a fallback model it costs more and takes longer. |
| Backfill buttons | `Tag Last 30 Days` · `Tag All Sessions` · running: `Stop Tagging` · held: Nothing can answer yet, so nothing can be tagged. |
| Backfill progress | counting: Finding sessions to tag… · Tagged {done} of {total}{ · n failed}. · Tagged {total} sessions{ · n failed}. New sessions are tagged as they finish. · Stopped at {done} of {total}{ · n failed}. {reason} (cancelled: no reason). · Every session from the last 30 days is tagged. · Every session is tagged. |
| Saved with notes (banner-warn, notes that name neither the fallback nor the features; replaced at the next save) | **Saved, with notes.** {server warnings as sentences} |
| Buttons | none in the form — the dialog footer's Discard Changes · Save Changes (§design.copy-deck/settings-modes-delegate) |
| Save failed (banner-error at the end of the form; the unsaved changes stay) | **Couldn't save the decision settings.** {reason}. Your saved settings are unchanged. |
| Footnote | Stored in `~/.pi/agent/sova/decisions.json`. The key is stored separately, readable by you only. |

## §design.copy-deck/settings-overseer — Settings · Overseer and Notifications (§app.settings-dialog/overseer, §app.notifications/settings)

| Where | Copy |
|---|---|
| Tab | Overseer (icon `eye`) · Notifications (icon `bell`), the next tab, holding Phone Notifications |
| Intro | The Overseer watches every session and acts on them for you. Open it with the eye beside the session search, or Alt+O. |
| Group order (legends) | Proactivity · Model and thinking · Limits · Quick actions · Standing notes · Advanced (folded) |
| Model and thinking | labels Model · Thinking · options pi's default · Model default · {ref} (not available) · hint: Applies when the Overseer is idle. It never changes the model new sessions start with. |
| Limits lede | Before acting, the Overseer checks these. When one is reached it stops and asks you instead. "Per message" counts restart each time you message it. |
| Running at once (full width) | label Running at once · live line beside the field Now: {n} of {limit} running. · hint: How many sessions the Overseer started or messaged may be working at the same time. Starting a session, or messaging one that isn't already counted, needs a free slot; when none is free, the Overseer waits or asks you. Sessions you started count only once the Overseer messages them. |
| Per-message limits (folded head · state) | Per-message limits · All at default · {n} changed from default |
| Per-message fields (label · hint) | Sessions created · New sessions it may create, per message you send. — Prompts to other sessions · Messages it may send to other sessions, per message you send. — Sessions archived · Sessions it may archive, per message you send. — Ideas explored · Idea explorers it may launch, per message you send. — Links made · Sessions it may link across hosts, per message you send. — Organization changes · Changes it may make to organizations, projects, rosters and project overseers, per message you send. — Gathering sessions started · Gathering sessions and offers it may start, per message you send. |
| Quick actions hint | The Quick Actions button in the Overseer's composer foot lists these. Picking one sends its prompt. |
| Quick action line | {label} · {description} (none: No description) · `Edit` / `Done` · opened: Label · Description · Prompt · `Move Up` · `Move Down` · `Remove` · a blank label reads Untitled action |
| Quick actions buttons | `Add Quick Action` (under the list) · `Reset to Defaults` (head row) |
| Standing notes hint | The Overseer reads these every turn and can add to them. They survive /clear. |
| Advanced (folded head · summary) | Advanced · Idea explorer, extra instructions, resume after a restart |
| Idea explorer (legend · hint) | Idea explorer · When you keep working on an idea, the Overseer can launch an agent to plan it with you. It reads, never edits a repository, and reports back to the Overseer. |
| Extra instructions (label · hint) | Extra instructions · Added after the Overseer's own prompt. Applies from its next run. |
| After a restart (switch · hint) | Resume interrupted sessions · A session whose turn the server's restart cut off gets one message to continue. Sessions a usage limit or you stopped stay stopped. |
| Reset buttons (Limits, Quick actions, Idea explorer; small ghost, at the end of the group's head row) | `Reset to Defaults` — fills the draft, saves nothing |
| Why Save waits (footer, "Overseer: {issue}") | {limit} must be a whole number from 0 to 1000. · Quick action {n} needs a label and a prompt. · The idea explorer needs a model and an effort. |
| Footnote | Stored in `~/.pi/agent/sova/overseer.json`. |

## §design.copy-deck/settings-models — Settings · Models (§app.settings-dialog/models)

| Where | Copy |
|---|---|
| Load failed (banner-error) | **Couldn't read the model policy** The list below may not match the server. Nothing was changed. [Retry] |
| Buttons | none in the tab — the dialog footer's Discard Changes · Save Changes (§design.copy-deck/settings-modes-delegate) |
| Save failed (banner-error at the end of the tab; the unsaved switches stay) | **Couldn't save the model policy.** {reason}. Your saved policy is unchanged. |

## §design.copy-deck/settings-mesh — Settings · Mesh (§mesh.ui/settings)

| Where | Copy |
|---|---|
| Load failed (banner-error) | **Couldn't read the mesh settings.** Nothing was changed. {message} |
| Host name hint · issue (replaces the hint, blocks Save; the footer: "Mesh: This host needs a name.") | Shown beside its sessions on every host, and in New Session's Host field. · This host needs a name. |
| Buttons | none in the tab — the dialog footer's Discard Changes · Save Changes (§design.copy-deck/settings-modes-delegate); Enter in a field does nothing |
| Save failed (banner-error at the end of the tab; the unsaved changes stay) | **Couldn't save the mesh settings.** {reason}. Your saved settings are unchanged. |

## §design.copy-deck/settings-experimental — Settings · Experimental (§app.settings-dialog/save-bar)

| Where | Copy |
|---|---|
| Load failed (banner-error) | **Couldn't read the experimental settings.** Nothing was changed. |
| Buttons | none in the tab — the dialog footer's Discard Changes · Save Changes (§design.copy-deck/settings-modes-delegate) |
| Save failed (banner-error under the switch; the unsaved switch stays) | **Couldn't save the change.** {reason}. Your saved setting is unchanged. |

## §design.copy-deck/settings-themes — Settings · Themes (§app/settings-dialog)

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
| Broken row, meta slot — a value we won't emit | `{key} is {value}. A color is a hex value, or one call to rgb, rgba, hsl, hsla, oklch, oklab, lab, lch, color-mix, or color.` — e.g. "accent is image-set(…). A color is a hex value, or one call to rgb, rgba, hsl, hsla, oklch, oklab, lab, lch, color-mix, or color." The accepted list is the one in §design/ground-rules, and stays in step with it |
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


## §design.copy-deck/settings-voice — Settings · Voice (§app.settings-dialog/voice)

| Where | Copy |
|---|---|
| Tab | Voice |
| Sheet title (from the mic) · tab heading | Set up voice · Voice |
| Before setup | "Dictation runs on this Sova host, not in the browser. Setup builds whisper.cpp for {Vulkan · device} (a few minutes), downloads the 574 MB speech model, and tests it. Audio never leaves this host." · no GPU backend: "Dictation runs on this Sova host, not in the browser. Setup uses a prebuilt whisper.cpp for the CPU (no prebuilt: builds whisper.cpp for the CPU (a few minutes)), downloads the 574 MB speech model, and tests it. No GPU backend was found, so each clip takes longer; the self-test shows how long. Audio never leaves this host." · primary `Set Up Voice` |
| Unsupported host | Voice setup supports Linux and macOS hosts. This host runs {os}. |
| Steps | Detect this host · Check packages · Get whisper.cpp · Build whisper.cpp · Get the model · Self-test · Finish · state words: Waiting · Running · Done · Skipped · Failed |
| Step notes | `{done} of {total} MB` · `{n}%` · Copied from {folder} · Already done · Prebuilt CPU binary |
| Installing | `Setting up voice · step {i} of 7` · `Cancel Setup` |
| Needs packages | **This host needs {n} packages to build whisper.cpp.** Run this on the Sova host, then check again. Sova never runs sudo. · `Copy Command` (after: "Copied.") · `Check Again` (primary) · `Use CPU Instead` · no known package manager: "Install these, then check again: {list}." |
| Failed | **Setup stopped at {step, lowercase}.** {error}. Everything before it is kept. · `Retry` · `Use CPU Instead` · `Show Log` / `Hide Log` |
| Cancelled | Setup cancelled. Everything done so far is kept; Set Up Voice picks up where it stopped. |
| Ready status line | a success chip `Ready`, then `{Vulkan · device} · self-test {s} s · {engine} {active model}, e.g. whisper.cpp large-v3-turbo q5_0 · {size} on disk · {Loaded \| Loading \| Not loaded}` |
| Ready (sheet) | Voice is ready. Tap the mic to dictate. · `Close` |
| Test Microphone | `Test Microphone` · recording: `Stop ({s} s)` · then `Transcribing…` · result: "Heard: “{text}” ({s} s)" · nothing: "Heard nothing." |
| Repair | `Repair` — "Checks every file again, every model included, and reruns the self-test." |
| Uninstall | `Uninstall Voice` · confirm (banner-warn): **Uninstall voice?** "The voice folder ({size}) goes away: whisper.cpp, {transcribe.cpp, }{n} models, the calibration clips, and the logs. System packages stay installed." (1 model: `the model`) · `Cancel` · `Uninstall` (destructive) |
| Models heading · caption | Models · "One model runs for the whole host. Each device keeps its own settings for each model." |
| Model row | `{name} · {quant}` · caption `{size} · {English only \| English and 99 more} · {state}` · default row chip `Recommended` |
| Model row states | Not downloaded · `{done} of {total} MB` · Checking the file… {n}% · Copied from {folder} · Downloaded · chip `In Use` with `self-test {s} s` · `Testing…` |
| Model row actions | `Download` · `Cancel Download` · `Use This Model` · `Delete Model` · `Retry` |
| Parakeet row | name as any row, `Parakeet TDT 0.6B v2 · q8_0` · caption `730 MB · English only · transcribe.cpp · No prompt or voice detection · {state}` · needs packages: **Parakeet needs {n} packages to build its engine.** Run this on the Sova host, then check again. · `Copy Command` · `Check Again` · no known package manager: "Install these, then check again: {list}." |
| Download disabled | Another download is running. · Needs {size}; this disk has {free} free. |
| Download meter label | Downloading |
| Use This Model disabled during a sweep | Stop Calibration first. |
| Download failed | The download didn't match its checksum and was deleted. Download it again. · other errors: **Couldn't download {name}.** {error}. Nothing else changed. |
| Switch failed | {name} didn't pass the self-test (heard "{text}"). Still using {old name}. |
| No Delete on the model in use (`title`) | Switch to another model first. |
| Delete confirm (banner-warn) | **Delete {name}?** "Its {size} file goes away. Its calibration results stay, in case you download it again." · `Cancel` · `Delete` (destructive) |
| Disk line | `{n} models · {size} on disk · {free} free on this disk` (1: `1 model`) |
| This Device heading | This Device · "This device: {label}" (installed app: `{label} (app)`) |
| This device, not calibrated | {model} uses the defaults on this device. Calibrating takes a few minutes: you read 6 sentences, then we try {12 \| 4} settings on them. · `Calibrate This Device` |
| This device, calibrated | Calibrated {date} on {n} clips · {p}% word error · {s} s per clip. · `Calibrate Again` · `Delete Clips` · confirm (banner-warn): **Delete this device's clips?** "Its {n} recorded sentences and their results go. Its saved settings stay." · `Cancel` · `Delete Clips` (destructive) |
| This device, Parakeet active | Parakeet has no settings to tune. Calibrating scores it on your clips, to compare with the whisper models. · scored: "Scored {date} on {n} clips · {p}% word error · {s} s per clip." · `Calibrate This Device` (or `Calibrate Again`) |
| Other devices | Other devices · row `{label}` · caption `seen {relative time} · calibrated for {models}` · `Forget` · confirm: **Forget {label}?** "Its settings and calibration clips go. It dictates with the defaults until it's calibrated again." · `Cancel` · `Forget` (destructive) |
| Sentence step | eyebrow `Sentence {i} of {n}` (the passage: `Passage`, "Optional. About 35 seconds.") · `Record Sentence` · recording: `Stop Recording`, `Recording {m:ss}` · after: "Got {s} s." · `Next Sentence` · `Record Again` · `Skip Sentence` · top right `Cancel Calibration` |
| Sentence problems | Didn't catch any speech. Record it again. · the clip check's sentence (§app.settings-dialog/voice-clip-check) · Recording stopped when the app went to the background. Record this sentence again. · At least 4 clips are needed. |
| Find Best Settings | `Find Best Settings` · estimate: "{n} settings × {c} clips ≈ {time} on {backend}" |
| Sweep progress | Trying setting {i} of {n} · clip {j} of {c} · `{p}%` · About {time} left. · Best so far: {p}% word error · {s} s per clip. · Paused for dictation. · "You can close Settings; the run keeps going on this host." · `Stop Calibration` |
| Sweep on Parakeet | the run button reads `Score This Model` (not `Find Best Settings`) · Parakeet has no settings to try. Scoring it on your {c} clips. · progress `Clip {j} of {c}` · its results show no sort caption |
| Another device sweeping (`Find Best Settings` disabled) | Calibration is running for {label}. |
| Host busy (banner-warn on the results) | **The host was busy during calibration.** Timings may be slower than usual; word error isn't affected. Run it again when the host is quiet for truer times. |
| Results caption | Sorted by word error, then jargon, then time. |
| Voice detection skipped (results, caption) | Couldn't get the voice-detection model, so the {n} settings that use it were skipped. |
| Results row | `{settings in words, e.g. beam 5 · hotword sentence · voice detection on · no fallback}` · `{p}% word error` · `{h} of {n} jargon` · `{s} s per clip` · labels `Best` · `Current` · open: "Read: {reference}" / "Heard: {text}", missed words `−`, extra words `+`, a jargon word heard in the wrong case `~` (`title`: Heard in the wrong case) |
| Applied | Saved the best settings for this device on {model}. · `Revert to Previous` · other rows: `Use These Settings` · after a revert: "Back to the previous settings." |
| Current won | No setting beat your current ones by 3 words or more. Nothing changed. · `Done` (returns the section to rest) |
| Stopped | Stopped after {i} of {n} settings. Nothing was saved; pick a row to use it. |
| Parakeet score | a results row labelled with the row name, `Parakeet TDT 0.6B v2 · q8_0` · `{p}% word error` · `{h} of {n} jargon` · `{s} s per clip` · "Parakeet has no settings, so nothing is saved." |
| Sweep failed | **Calibration stopped at setting {i} of {n}.** {error}. Your clips are kept; Find Best Settings tries again. (on Parakeet: **Scoring stopped at clip {j} of {c}.** {error}. Your clips are kept; Score This Model tries again.) |
| Crashed too often | whisper-server stopped 3 times in a minute. Repair to try again. |
| Load failed (banner-error) | **Couldn't read the voice status.** {message} |
| A press refused (banner-error) | **That didn't work.** {server message} — e.g. "Setup is already running." |

## §design.copy-deck/timeline-tab — Timeline tab (§chat/timeline)

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
| State line | Updated {relative} ago · behind the latest messages · (current: `Updated {relative} ago · current`; a summarizer running: `Updating`) — §app/insights's words, unchanged |
| Time `title` | `{absolute} · {relative}` — e.g. `2026-09-19T14:06:11Z · 2d ago` |
| Row foot | Newest first, active branch only. A row jumps to its message; Rewind takes the chat back to just before it. (filter on: starts `Your messages only, newest first,`) |
| Row foot, below 1280 | Newest first, active branch only. A row jumps to its message and closes this pane; Rewind takes the chat back to just before it. |
| Jump with no row on screen (toast) | That message isn't in the transcript on screen. |
| Empty | **0 messages in this session yet.** The timeline draws itself as you and the agent work. |
| Empty, filter on, other rows exist | **0 messages from you in this session yet.** Turn off Inputs Only to see the rest of its timeline. |
| `/timeline` | Timeline open. |
| `/tree` | Timeline open, your messages only. |

## §design.copy-deck/workspace — Workspace (§workspace/groups)

| Where | Copy |
|---|---|
| Skip link | Skip to Group Composer while Send to All is on · otherwise (off, or no members): `Skip to Transcript`, targeting the focused pane |
| Main landmark | `aria-label`: Workspace: {name} |
| Title and meta | {name} · `{n} members` (1: `1 member`) · `·` · the cwd when every member shares one, else `{n} folders` · after a shared send: `{r} of {t} replied` (then `· {w} still working` while any of them runs, and `· {e} errored` whenever a member's turn failed — the failure is always named, so the count can never hide a broken member) |
| Back | `aria-label`: Back to Sessions |
| Head buttons | `Tabs` (`aria-pressed`; pressed reads the same word) · `Fit All` (split only, 2+ members) · `Send to All` (`aria-pressed`; pressed reads the same word; `title`: "Write one message to every member, in place of each pane's own composer.") · `Dissolve` · collapsed under 640px into `More Actions`, whose first row is `Send to All` (checked while on) |
| Send to All, in the group composer | chip `All {n} members` (1 member: `1 member`; {n} is the group's size) · the `×` before it: `aria-label` and `title` "Back to One Member" · announce on: "Send to All on. One message goes to all {n} members." (1: "… goes to 1 member.") · off: "Send to All off. Each member has its own composer again." |
| Unknown group id (toast) | That group is gone. |
| Tab | {label or title} · `aria-label`: the pane's own name, byte for byte (label/title or the repeat's `{model} #n` — one rule for strip and pane, so they can never disagree about which #2 is which) |
| Pane name | {label} · {model}, or {title} · {model} with no label · repeats of one model: {model} #1, #2, #3 — numbered in member order, shared with the tab rule, and never followed by "· {model}": the suffix already names it, and saying it twice makes the name stutter · `title`: the full string, then the cwd, then the session's whole spend (`{cost} this session`, `SessionUsage.total` — the same field the session pane's Usage tab headlines) when the server reports one |
| Pane tools | one menu: trigger `aria-label` "Pane actions · {pane name}" · rows `Rename…` · `Open` (link, `title`: Open this session on its own) · `Wider` · `Narrower` · `Move Left` · `Move Right` · `Focus` · `Promote` · `Remove From Group` · `Eliminate` (absent when the session wasn't started in Sova) |
| Pane tool `aria-label`s | Rename {pane name} · Open {pane name} · Make {pane name} wider · Make {pane name} narrower · Move {pane name} left · Move {pane name} right · Focus {pane name} · Promote {pane name} · Eliminate {pane name} — the pane NAME (suffix included), because the menu says which member it acts on and three same-model members are three menus |
| Promote `title` | Take it out of “{name}” and open it on its own. Nothing is archived and nothing is deleted |
| Eliminate `title` | Take it out of “{name}” and archive it. The transcript stays; unarchiving brings it back |
| Eliminate off | TUI-live: "This session is open in a terminal." · mid-turn: "It's mid-turn. Stop it or wait, then eliminate it." |
| Remove From Group `title` | Take it out of “{name}” and stay here. Nothing is archived and nothing is deleted · when Eliminate is absent: This session wasn't started in Sova, so removing it is all we can do — nothing is archived |
| Member chips | `Working` (live dot, mid-turn — the split row's only at-a-glance sign of who is still running; the tab strip's dot covers tabs mode) · `TUI` (accent, static) · `Archived` (neutral) · `Can't open` (error) · `Busy` (warn) |
| Member composer reasons | "This session is open in a terminal, so Sova won't write to it." · "This session is archived. Unarchive it to send." · "This session can't be opened. The banner above says why." · "Another program is writing to this session." |
| Member file gone | **This session's file is gone.** Its transcript was deleted outside Sova, so there's nothing left to read. Removing it from the group is all that's left. · button `Remove From Group` |
| Group composer label and placeholder | `aria-label` "Message every member" · placeholder "Ask all {n} members…—Enter sends, Shift+Enter adds a line" (in touch mode, where Enter adds a line: "Ask all {n} members…"; 1 member: "Ask this member…") · **{n} is the group's size, never the available count**: availability belongs in the foot, where it can change without rewriting a placeholder under the caret, and "Ask this member…" in a 3-member group would be false |
| Group composer Send | `Send to All` · in flight `Sending…` · 1 member: `Send` |
| Group composer targets line | `{n} of {m} members` then the excluded reasons, counted: `· 1 mid-turn` · `· 2 open in a terminal` · `· 1 archived` · `· 1 can't be opened` · `· 1 busy` · `· 1 file gone`. All available: `{n} members` alone |
| Group composer off | 0 available: Send is `aria-disabled`, reason "No member can take a message right now." · 0 members: the composer isn't rendered |
| Refusal reason per member | rendered from `code`: `{member} is mid-turn` · `{member} is open in a terminal` · `{member} is archived` · `{member} can't be opened` · `{member} is busy` · `{member}'s file is gone` · `internal`, or a code this build doesn't know: `{member} couldn't be prompted.` then the server's `message` as the detail — Sova keeps the claim in its own voice and hands the server the part only it knows |
| Refusal banner | **Nothing was sent.** {n} of {m} members can't take a message right now: {member} is mid-turn, {member} is open in a terminal. Wait for them, or send to the other {k}. · buttons `Send to the Rest ({k})` · `Cancel` |
| Partial send banner | **Sent to {k} of {n} members.** {member} was taken by another program between the check and the send, so it didn't get this message. The {k} that did are answering now. (several missed out: {members} **were** taken … so **they** didn't get this message — the verb agrees with its own subject) · one button per member that missed out: `Send to {member}` — re-sends to **that member alone**, the message as it was sent, not as the box now reads (a button's label names exactly who its own press reaches; one label over every failed id would promise one thing and do another) · the composer keeps its text here (it clears only on a clean send) |
| Announcing a banner | A banner is `role="status"` and speaks for itself: **never** announce beside one. The clean-200 path announces because it has no banner |
| Sent (live region) | Sent to {n} members. (1: Sent to 1 member.) |
| Promote toast | Took **{title}** out of “{name}”. · failure: "Couldn't take this session out of the group. {server message}" |
| Eliminate toast | Removed **{title}** and archived it. · remove-only: "Removed **{title}** from “{name}”. It wasn't started in Sova, so nothing was archived." · failure: "Couldn't remove this session. {server message}" · archived half failed: "Removed **{title}** from “{name}”, but couldn't archive it. {server message}" |
| Dissolve vs Delete group | The same route (`DELETE /api/session-groups/:id`) under two words: `Delete group` in the sidebar's tool row, `Dissolve` in the workspace head, where it sits above open transcripts and "Delete" would read as deleting them (§workspace/groups) |
| Dissolve, asking in place | Dissolve “{name}”? Its {n} sessions stay in the list. (1: "… Its 1 session stays …"; 0: "Dissolve “{name}”? Nothing is in it.") · buttons `Dissolve` · `Cancel` |
| Dissolve toast | Dissolved “{name}”. Its {n} sessions are ungrouped. (1: "… Its 1 session is ungrouped.") · "Dissolved “{name}”. It had no sessions." |
| Empty workspace | **“{name}” has no sessions yet.** Drag a session from the sidebar onto this group, or use Move into group in its details. · no button |
| Member announcements (live region) | {pane name} — working. · {pane name} — replied. · {pane name} — stopped with an error. (the turn-error banner's own title, said once; the settle that follows an errored turn announces nothing — two endings would read as two turns) · {pane name} — stopped by you. · {pane name} — can't be opened. · {pane name} — open in a terminal, so it stays read-only. |
| Pane focus keys | no visible copy · the workspace's keyboard help lives in `Move Left` / `Move Right` `title`s: "Swap {pane name} with its left-hand neighbour. Ctrl+Alt+← moves focus, not the pane." |
| Fit All | `Fit All` · `title`: "Make every pane narrow enough to stand in the row side by side. Below 440px a pane trades solo reading for comparison; Wider steps back to the floor." · announce: "Fitted {n} members at {w} pixels each." (below the floor: "… each, below the 440 floor a single pane keeps.") · a fitted width is memory-only, like every width; `Wider` from below the floor lands on 440 and `Narrower` is a no-op there — never a button that says "narrower" while widening |
| Rename member | menu row `Rename…` · `title`: "Give this member your own name — the useful one is only known after reading its output" · the menu's one input: `aria-label` "Name {pane name}", starts from the current label, `maxlength` 40 · empty CLEARS (note under the field: "Empty clears the label — the pane shows the title again.") · Enter saves, Escape cancels and closes · toasts: "Renamed to “{label}”." / "Label cleared — the pane shows the title again." · announce: "{new pane name} — renamed." / "{new pane name} — label cleared." — the NEW name, which is true from that moment |
| Member gone, removal | the `.empty` pane's button `Remove From Group` removes by session id (`{ id, groupId: null }` — there is no file to resolve a path through) · toast "Removed {pane name} from “{name}”." |
| Completion roll-up | the meta line's "{r} of {t} replied" is anchored to the last ACCEPTED shared send (a box send replaces the set; a partial banner's retry unions it, so the straggler is counted with the ones already answering) · errored members are counted "errored", never "replied" · memory-only: a reload genuinely does not know about the last send, and shows nothing rather than a guess |

---

## §design.copy-deck/project-coding — Project page · coding sessions (§app.project-overseer/coding-mode, §app.project-overseer/coding-worktrees)

| Where | Copy |
|---|---|
| Mode select (beside the coding sessions' model and thinking) | label `Coding sessions' mode` · options `Automatic` · `normal` · `normal · spec` · `delegate` · `delegate · spec` — the mode ids in lower case, as the mode menu shows them (§chat/mode-menu) |
| …its hint (`.field-hint`) | "Every coding session this project starts runs in it, yours included. One started now: {codingModeNow}." — `{codingModeNow}` in mono, `normal` or `normal · spec` |
| …saved (toast) | "Coding sessions run {mode}." · Automatic: "Coding sessions' mode: Automatic." |
| List heading | `Coding sessions` — replaces "Sessions it started" for coding rows; gathering sessions and offers keep their own list |
| Row | the title (a link on this host) · meta: "Started by the overseer", "Started by you" or "Started by you, via the Overseer" · `working` / `idle` · {relative time} · then the branch in mono: `sova/{name}` · not on this host: `sova/{name}` · "on another host" |
| Above the list, when the project can't have worktrees | "Coding sessions run in the project root: {reason}" — `{reason}` one of "it isn't a Git repository." · "the repository has no commits yet." · "its checkout is on a detached HEAD." |
| …a row in the root | "In the project root: {reason}" — no branch, no buttons |
| …after | "Merged into `{target}` {relative time}" · "Worktree removed" · "Worktree folder missing" · merged before, with commits since: "{n} new commits since the last merge into `{target}` {relative time}" (1: "1 new commit since…"), and Merge Branch again |
| Merge | `Merge Branch` (secondary) · disabled reasons: "Session working" · "Workers running" · "On another host" · done (toast): "Merged sova/{name} into {target}." |
| …refused (`.field-error` under the row) | "The project root has {branch} checked out, not {target}. Check out {target} there, then merge." · "The project root has uncommitted changes to tracked files. Commit or stash them, then merge." · "The project root is in the middle of a {merge/rebase/cherry-pick}. Finish it, then merge." · detached root: "The project root's checkout is on a detached HEAD, not {target}. Check out {target} there, then merge." · uncommitted in the worktree: "The worktree has uncommitted changes in {n} files ({first file}). Commit them in the session first, then merge." · nothing to merge: "sova/{name} has nothing to merge into {target}." · conflict: "sova/{name} conflicts with {target} in {n} files. Nothing was merged. Resolve it in the worktree, then merge again." · busy (server): "The session is working." · "Its workers are running." · another host: "On another host: its worktree is there." |
| Remove | `Remove Worktree` (destructive, outlined) · disabled reasons as Merge's · confirm, merged: "The folder `{path}` and the merged branch `sova/{name}` go away. The session and its transcript stay." · unmerged: "The folder `{path}` goes away. The branch `sova/{name}` keeps its commits, and the session and its transcript stay." · buttons `Remove Worktree` · `Cancel` · done: "Worktree removed." · refused: "The worktree has uncommitted changes in {n} files ({first file}). Nothing was removed. Commit or discard them first." · twice: "Its worktree was already removed." |
| List heading, empty | `Coding sessions` is always shown · "None yet. Yours and the overseer's are listed here." · a row with no title yet: "Untitled coding session" |
| New Coding Session | `New Coding Session` (secondary, terminal icon) on the `Coding sessions` heading · toast as Start Coding Session's, then the session opens · mode not set (`.field-error` under the heading): "Started, but its mode could not be set. Set it from the chat's mode menu before you send." · refused (`.field-error`): "{reason} No session was started." |
| Start Coding Session (toast) | "Coding session started on sova/{name}." · in the root: "Coding session started in the project root." · mode not set (`.field-error`): "Started, but not prompted: its mode could not be set. Open it and send the message yourself." · no worktree (`.field-error`): "No session was started: its worktree could not be made ({git's first line})." |
| Promote (Decisions tab, after a promotion) | "Promoted {n}. Committed {short sha} on {branch}." · skipped: the reason as §app.requirements/promotion-commit words it ("Not committed: …") · no Git: no second sentence |
| Overseer tool refusals (the model reads them; the activity list shows them) | "Delegate is off for this project's coding sessions; the operator can allow it on the project page." · "Align needs someone to answer its questions, and nobody answers a coding session's." · "Spec is on for this project's coding sessions; only the operator can turn it off on the project page." · "Unknown mode {x}: use normal or delegate." · "Unknown minor mode {x}: only spec is allowed." · "Its worktree was removed, so it has no folder to work in." |

## §design.copy-deck/gathering-abilities — What a gathering session can do (§app.baton/abilities, §app.baton/read-link)

| Where | Copy |
|---|---|
| Project page, under the gathering sessions' model | label `Gathering sessions can` · options `Automatic` · `Draw` · `Draw and read links` · `Read links` · `Neither` |
| …its hint (`.field-hint`) | "Every gathering session this project starts gets this, unless its start says otherwise. One started now: {now}." — `{now}` one of "draw", "draw, read links", "read links", "nothing extra" |
| …saved (toast) | "Gathering sessions: {option}." — e.g. "Gathering sessions: Draw and read links." |
| Start a Session form | `It can:` · checkboxes `Draw` · `Read links`, checked as the project's set |
| Baton strip | `It can:` · checkboxes `Draw` · `Read links` · saved (toast): "Drawing on from its next reply." · "Drawing off from its next reply." · "Reading links on from its next reply." · "Reading links off from its next reply." · refused: the server's words |
| Share and owner pages, a drawing that can't be drawn there | "A drawing couldn't be shown here." (muted, one line, never the source) |
| Overseer tool refusal (the model reads it) | "Reading links is off for this project's gathering sessions; the operator can allow it on the project page." |
| `read_link` refusals (the model reads them) | "Only a link someone wrote in this conversation can be opened." · "That address can't be opened from here." · "Not a text page: {content type}." · "This conversation has already read 10 links." · "The page didn't answer in time." · "The page answered {status}." |

## §design.copy-deck/gathering-images — Photos in gathering chats (§app.baton/images)

| Where | Copy |
|---|---|
| Share page, paperclip button `aria-label` and `title` | Attach Photos |
| Pending strip `aria-label` | Photos to send |
| Pending photo, being processed on the device | Preparing |
| Pending photo, uploading (the size shows once it's up) | Uploading {p}% |
| Pending photo, failed (meta; the button) | Upload failed · `Retry` (`aria-label` "Retry {name}") |
| Pending photo, Remove `aria-label` | Remove {name} |
| Pasted photo name | Pasted photo |
| Send while an upload runs (hint under the composer) | Waiting for photos to finish. |
| Refused on the device | This photo's format can't be sent. · Over {n} MB. · Up to {n} photos per message. |
| Refused by the host | This conversation has reached its photo limit. · Photos can't be taken right now. · This conversation can't take photos right now. · Too many photos. Wait a minute. |
| Announce: added | {n} photos attached. (1: "1 photo attached.") |
| Announce: refused | {name} wasn't attached. {reason} |
| Thread, photo `alt` | Photo from {name} · Photo {i} of {n} from {name} (the viewer's own: "you") |
| Thread, photo list `aria-label` | {n} photos (1: "1 photo") |
| Lightbox buttons | Close Photo · Previous Photo · Next Photo · counter {i} / {n} |
| Owner page, Preview as, overseer reads (count instead of pixels) | 1 photo · {n} photos |
| Operator's strip and the project page's gathering-model picker, a model without vision | This model can't see photos: people won't get an attach button. |
| Settings → Organizations, section | Photos in gathering chats · `People can send photos` · `Per message` (1–8) · `Largest photo, MB` (1–10) · `Per conversation` (1–200) · hint "Applies to every gathering session on this host, from its next message." · invalid: "Organizations needs photo limits within their ranges." |

## §design.copy-deck/project-limits — Project page · limits and pace (§app.project-overseer/limits)

| Where | Copy |
|---|---|
| Section | legend `Limits` · hint "Past a limit it stops and tells you. Your own coding sessions and Send to Person aren't counted." |
| Table columns and hint | `Limit` · `Per message` · `Per day` · `At once` · under the table: "Per day resets at midnight on {host}. At once never goes Unlimited: it's what stops a burst." · editing, the pace group's legend `Pace` |
| Table (read-only) | columns `Per message` · `Per day` · `At once` · a limit that doesn't exist: `—` · Unlimited: `∞` (`title` and hidden text "Unlimited") · pace line: "Looks at most every {gap} · Within {soon} after a session finishes · Hold: {hold}" (Off: "No sooner look after a session finishes") · button `Edit Limits` (secondary) |
| Allowance fields (editing) | `Gathering sessions started` · `Decisions promoted` · `Coding sessions started` · `Prompts to coding sessions` · per day also `Looks` · each with an `∞` toggle, `aria-label` "Unlimited: {label}, {column}" |
| At-once fields | `Gathering sessions open` (0–20) · `Coding sessions running` (0–10) · no Unlimited |
| Pace | `Looks at most every` [`2 min` · `5 min` · `10 min` · `30 min` · `1 hour`] · `After a session finishes, it looks within` [`30 s` · `1 min` · `2 min` · `5 min` · `Off`] |
| Buttons | `Save Limits` (secondary, like the other saves on the card) · `Reset Limits` (ghost: the defaults into the form, not saved) · `Cancel` (ghost: the saved values back, read-only) · saved (toast): "Limits saved." |
| Problems (`.field-error`, before sending; the server's 400 says the same) | "{Label} must be a whole number from 0 to 1000, or Unlimited." · "Gathering sessions open must be a whole number from 0 to 20." · "Coding sessions running must be a whole number from 0 to 10." · server only: "Coding sessions running can't be Unlimited: it's what stops a burst." |
| Watch hint (built from the pace) | "When a session finishes, a conflict appears, or you promote, it looks on its own: within {soon} for the important ones, otherwise at most every {gap}." · soon Off: "When a session finishes, a conflict appears, or you promote, it looks on its own at most every {gap}." |
| Readout (under the status line; only kinds used) | "Today on its own: {n} of {max} gathering sessions, {n} coding sessions (no limit)." · "Your last message: {n} of {max} prompts to coding sessions." |
| Waiting (one line each) | "Waiting until midnight: today's {max} {what} are used." · looks: "Waiting until midnight: today's {max} looks are used." |
| Refusals (activity list; the operator's sentence only) | "Today's allowance is used: {n} of {max} {what} on its own. It looks again at midnight." · "This message's allowance is used: {n} of {max} {what} per message you send." · "{n} of its gathering sessions are open, and the limit is {max} at once." · "{n} of its coding sessions are running, and the limit is {max} at once." |
| Reasons it gets back (the model reads them; "Waiting to look at:" shows them) | "Today's allowance is back: it may start {what} again (refused {time})." · "Today's looks are back (refused {time})." · "The operator's last message reached its limit on {what}; it may go on within today's allowance." · "You raised the limit on {what}." |

## §design.copy-deck/project-costs — Project page · Cost card, org page · totals (§app/project-costs)

| Where | Copy |
|---|---|
| Card | heading `Cost` · total `$12.48` (mono) then "at API prices" · under it: "What these sessions would cost at each provider's API prices. Your subscriptions bill differently." |
| Money | two decimals with thousands commas, mono: `$1,240.00` · `$0.56` · above 0 and under a cent: `<$0.01` · nothing: `$0.00` · the project total when part of it is an estimate: `≈$4.10` (`title` "Partly an estimate: see the note below.") |
| Tokens | the short figure used elsewhere: `940` · `12.3k` · `2.8M` |
| By who started it (one line, only starters with a cost) | "Started by the overseer {usd} · by you {usd} · by Sova on its own {usd}" |
| By kind (table) | heads `Kind` · `Cost` · rows `Overseer conversations` · `Gathering and offers` · `Settling` · `Wrap-ups` · `Coding sessions` · `Their workers` · `Reconciler` |
| By model (table) | heads `Model` · `Input` · `Output` · `Cache read` · `Cache write` · `Cost` · a token cell: `{usd}` over `{tokens}` (muted) · last row `All models` (only with 2 or more models) · the tables sit in a disclosure `Breakdown by kind and model`, closed · a local model's cost cell: `local` · an unpriced model's cost cells: `unpriced` (muted) |
| Top sessions | heading `Most expensive sessions` · row: `{title}` (link when on this host, else plain with "(not on this host)") · `{kind} · {started by}` with `started by` one of "started by the overseer", "started by you", "run by Sova" · `{usd}` |
| Notes (one line each, only when true) | unpriced: "{tokens} tokens on {model} have no API price, so they aren't in the total." (one line per model; the reason as its `title`) · legacy: "{tokens} tokens counted before costs have no model recorded, so they aren't in the total." · estimate: "≈ Older Claude Code messages didn't record how long their cache was kept, so their cache writes are priced at the 1-hour rate." · not on this host: "{n} sessions aren't on this host: their cost is as last counted, {date}." · always: "Not counted: topic summaries, image descriptions, and Sova's own side calls." · always: "Prices from models.dev, as of {Mon D}." |
| Empty | "{n} sessions in this project. Nothing spent yet." · one: "1 session in this project. Nothing spent yet." · with no session: "Nothing spent yet." |
| Loading · error | "Counting…" · "Couldn't count this project's cost. {reason}" (the API error's message) |
| Org page, Projects tab | above the list: "All projects: {usd} at API prices." · each project row: `{usd}` (mono, muted) before the chevron · no projects: no line |

## §design.copy-deck/project-stakeholder — Project page · main stakeholder, thinking, activity (§app.organizations/stakeholder, §app.project-overseer/identity)

| Where | Copy |
|---|---|
| Stakeholder select (the project page's decisions area, above the decisions) | label `Main stakeholder` · options `None`, then the org's active people by name · hint (`.field-hint`): "Decides every area of this project that no one on the roster decides by name." |
| …saved (toast) | "{name} is this project's main stakeholder." · None: "This project has no main stakeholder." |
| …latest change (under the hint) | "Set by you {relative time}." · "Set by you, via the Overseer {relative time}." · "Cleared {relative time}: {name} left the organization." |
| …refused (`.field-error`) | "Only an active person on the roster can be a project's main stakeholder." |
| Cleared banner (warn, while nobody is picked) | "{name} was this project's main stakeholder until they left the organization {relative time}. Pick someone else, or choose None." |
| Suggestion (info line, no stakeholder, exactly 1 active person) | "{name} is the only person on the roster. Make them this project's main stakeholder?" · button `Make Main Stakeholder` (secondary) |
| Needs you item | "Pick a main stakeholder for {project}: {name} left the organization." · org card kind: `{n} stakeholder to pick` / `{n} stakeholders to pick` |
| Person page fact | "Main stakeholder of {project}, {project}" — each a link to its project page |
| Conflict's reason (conflicts card) | "{name} is this project's main stakeholder." |
| Decides refused (roster form, `.field-error`) | "“{entry}” names no decision area: use words, like “website”." |
| Thinking refused (project page, `.field-error` under the select) | "{model} offers thinking {levels}." — levels comma-separated, as the model lists them |
| Thinking moved after a model change (toast, after the model's own) | "Thinking is now {level}: {model} doesn't offer {old}." |
| Activity chip for a partial act | `Partly` (warn: dot and word) beside `Refused` · `Failed` (a done act has no chip) · line: "{tool words}: partly ({n} refused: {id} ({reason}); …)" |

## §design.copy-deck/project-overseer-head — Project overseer · chat head (§app.project-overseer/page)

| Where | Copy |
|---|---|
| Title | `Overseer` · an earlier conversation: `Earlier Overseer Conversation`, meta "{title} · {age}", back link `aria-label` "Back to the overseer" |
| Meta line | {project} (a link to its page) · {org} · `Watching` / `Not watching` · "{n} started" (a menu; `aria-label` "{n} sessions it started, show list"; rows "{kind} · {state}") |
| State chip | `Working` (accent, live dot) · `L0 in force` (warn, dot and word; `title`: the server's reason) |
| Level button | the chosen level, `L1` · `aria-label` "Level {level}, {meaning}" + " In force now: L0." while forced + " Change level." · rows `L0`–`L3`, each with its meaning (the project page's), the chosen one checked · done (toast): "Level: {level}." |
| Project page's Open Overseer / Start Overseer | the `eye` icon (was `chat`) |
| Run Now | `Run Now` (ghost) · disabled reason: "Working now" · done (toast): "The overseer is looking now." |
| ⋯ menu | `aria-label` "Overseer actions · {project}" · `Stop Watching` / `Start Watching` (toasts "Not watching." / "Watching.") · `History…`, note "{n} earlier" while any (`aria-label` "History, {n} earlier conversations", 1: "conversation") · `Clear`, note "Start a new conversation. This one moves to History." · `Project Page` · below 480px also `Run Now` and `Level…` (note: the chosen level) |
| Meta line, below 480px | {project} only: the org and the watch word go |
| History screen | its earlier conversations, each "{title}" ("No messages" when untitled) with its age · none: "No earlier conversations yet." |
| Clear / `/clear` | done (announced): "Cleared. The previous conversation is in History." · failed (toast): "Couldn't clear the overseer. {why}" |
| Status strip, line 1 | "Last looked on its own {time}{tail}." or "It hasn't looked on its own yet." + " Waiting to look at {n} things." (1: "1 thing"; `title`: the reasons) · paused by an attach: the reason, then `Resume at {level}` · empty roster: the reason |
| Status strip, lines 2–3 | the project page's readout ("Today on its own: …") and waiting sentences (§design.copy-deck/project-limits) · below 480px: `Details` toggles them |
| Read-only line (earlier conversation) | "An earlier conversation. Read only." |

## §design.copy-deck/overseer-head — The Overseer · page head (§app.overseer/head-layout)

| Where | Copy |
|---|---|
| Meta line | "{n} sessions · {w} working · {a} need you" (1: "1 session", "1 needs you"; a part at 0 is left out) · no menus in it |
| ⋯ menu | `aria-label` "Overseer actions" · `title` "Overseer actions" · `Proactivity…`, note the current mode (`Off` / `List Only` / `Brief Me`; `aria-label` "Proactivity: {mode}. Change it.") · `History…`, note "{n} earlier" while any (`aria-label` "History, {n} earlier conversations", 1: "conversation") · `Clear`, note "Start a new conversation. This one moves to History." (`aria-label` "Clear: start a new conversation") · an earlier conversation: `History…` only |
| Proactivity screen | `Off` · `List Only` · `Brief Me`, each with its hint (§app.overseer/proactivity) as its note, the current one checked (`aria-label` "{mode}, {hint}" + " Chosen.") · done (announced): "Proactivity: {mode}. {hint}" · failed (toast): "Proactivity unchanged. {why}" |
| History screen | its earlier conversations, each "{title}" ("No messages" when untitled) with its age · none: "No earlier conversations yet." |
| Clear | done (announced): "Cleared. The previous conversation is in History." · failed (toast): "Couldn't clear the Overseer. {why}" |

## §design.copy-deck/overseer-orgs — The Overseer in organizations (§app.overseer/org-tools, §app.organizations/archive)

| Where | Copy |
|---|---|
| Writer, wherever a change names who made it | `you, via the Overseer` (Profile Changes, Recent Profile Changes) · About History row: "by you, via the Overseer" · latest-change lines: "Set by you, via the Overseer {relative time}." · coding row: "Started by you, via the Overseer" · gathering strip: "Started by you, via the Overseer · {relative time}" |
| Row tag and queued row, in a project overseer's thread | `Overseer` — the tag and word of §app.overseer/sent-marker |
| Confirm card rows | project: `{project}` then `{org}` (muted) · person: `{name}` then `{org}` (muted) and, unless active, the status chip (`Proposed`, `Left`) |
| Extra instructions (the project page's Settings tab) | label `Extra instructions` · hint "Added last to this overseer's prompt, after the organization's About text, and they win over it. It reads them at its next run." · counter `{n} / 8,000` · `Save` (secondary) · `Cancel` (ghost) · saved (toast): "Extra instructions saved." · blank: "Extra instructions removed." · refused (`.field-error`): "Extra instructions can be at most 8,000 characters." |
| Archive (project page: the head's ⋯ and Settings' Danger zone) | ⋯ item `Archive Project…` (`Unarchive Project` while archived) · danger zone `Archive Project` (destructive, outlined) · confirm: "{project} leaves the Projects list and its overseer stops looking. Nothing is deleted; Unarchive brings it back." · buttons `Archive Project` · `Cancel` · done (toast): "{project} archived." |
| …refused (`.field-error`, the server's words) | "Stop these first: {list}." — items joined with "; ": "{n} gathering session open ({titles})" / "{n} gathering sessions open (…)" · "{n} coding session running (…)" / "{n} coding sessions running (…)" · "its overseer is working" |
| Archived banner (info) | "{project} was archived {relative time}. Its overseer is paused and nothing new starts here. Nothing was deleted." · via: "{project} was archived by you, via the Overseer {relative time}. …" · button `Unarchive` (secondary) · done (toast): "{project} is back." |
| Archived, disabled reason | "Archived" (Start Overseer, Run Now, Start Coding Session, Send to Person…) |
| Archived, refused (server) | "{project} is archived. Unarchive it first." · the overseer: "{project} is archived. Unarchive it to use its overseer." |
| Projects tab | disclosure `Archived Projects ({n})` (collapsed; absent with none) · row: the project link · "archived {relative time}" · `Unarchive` (ghost) · every project archived, in place of "No projects yet…": "The 1 project here is archived. Unarchive one below, or add a project." / "All {n} projects here are archived. Unarchive one below, or add a project." |
| Overseer tool refusals and notes (the model reads them; the action log keeps the refusals) | "This reaches people or ends something: ask with sova_card, listing {what} in its items, and act in the turn the user's click starts." · "Only the Overseer sends here. Write in the overseer's own composer." (403) · "Send words; use op clear to clear it." · "That folder is an organization's workspace; read it with sova_orgs and sova_read_session." · "No link was made: Needs you asks you to send {name} their link." |

## §design.copy-deck/public-links — Public links (§mesh/public)

`{gateway}` is the gateway peer's name, `{host}` a host's name, `{url}` a public address, `{port}`
a port, `{var}` an environment variable's name, `{reason}` the answer's own sentence. The public
page never names a host or a person.

**Settings → Public links (§mesh.public/panel)**

| Where | Copy |
|---|---|
| Title · line | Public links · People you send a link to open it at this address. |
| State chip | `Off` · `Not verified` (warn) · `Verified` (success) · `Unreachable` (error) · `Not listening` (error, §mesh.public/listener-failure) |
| Share port won't open (error banner under the Address row) | **The share port isn't open.** {reason} Links from this host can't be opened from outside until it is. Fix it, then save a different port or restart Sova. · {reason} (server): Another program is already using {host}:{port}. · This host doesn't let Sova use port {port}. · {host} isn't an address of this host. · SOVA_SHARE_PORT isn't a port number. · Couldn't open {host}:{port} ({code}). |
| Address row | Address · {url}, or `None` · source `Set by environment ({var})` / `From this setting` / `From {gateway}` / `Bound address` |
| Route legend and choices | Where links open · `Off` "Links work only on your own devices." · `This host is the gateway` "This host serves every public link, including those from hosts that go through it." · `Through {gateway}` "Links from this host open at {gateway}'s address. {gateway} must be on for them to open." |
| Gateway fields | Public address · Front (`Your web server` · `Caddy on this host` · `Tailscale Funnel` · `Cloudflare Tunnel`) · Local port · Accept links from (`All hosts` · `These hosts`) |
| Pinned field hint | Set by environment ({var}). Change it there, then restart Sova. |
| Front steps | heading "Set up the front once" · "Anything that serves {url} and forwards to 127.0.0.1:{port} works. Sova doesn't run this step for you." · chip `Needs root` · `Copy Step`, toast "Copied the step." · before a save: "Save Changes to see the step for this setting." |
| Verify | `Verify Address` (`Verifying…`) · blocked: "Save the gateway setting first." / "Save the new address first." · passed: "Verified {time}. {url} reaches this gateway." · failed (error banner): **Couldn't reach {url}.** {reason} Links still open on your devices. Check the front, then verify again. ({reason} else "It answered {status}", else "No answer") |
| Verify reasons (server) | Timed out · Couldn't connect · It redirects; the front must forward, not redirect · Got {status}, not Sova's answer · Something else answered, not Sova · The public address must start with https:// · The public address must have no path, query or login · No public address is set. |
| Routed hosts | heading "Hosts sending links here" · row `{n} links` (`1 link`) · `Last push {time}` / `Never pushed` · `Up` / `Down` / `Not accepted` · none: "No other host sends its links here yet." |
| Through | "Links open only while {gateway} is on. Keep a client's organization on an always-on host." · Ingress port |
| Field errors | Enter the public address. · The public address must start with https://. · Enter the public address as https://share.example.com. · The public address is a host only, with no path. · The local port is a whole number from 1 to 65535. · Pick the gateway. · The ingress port is a whole number from 1 to 65535. (the save bar: "Public links: {error}") |
| Read and save failures (error banner) | **Couldn't read the public links setting.** Nothing was changed. {reason} · **Couldn't save the public links setting.** {reason} Your saved setting is unchanged. |
| Mesh card chip (§mesh.ui/card) | `Public links: gateway` · `Public links: through {gateway}` |

**`linkWarning` (§app.baton/links; `linkWarningCode` names it; the server's text, shown verbatim, with `Open Settings`)**

| Code | Copy |
|---|---|
| (verified) | none |
| `off` | This link can't be opened from outside yet. Turn on public links in Settings → Public links. |
| `unverified` | This link may not open from outside yet. Verify the address in Settings → Public links. |
| `unreachable` | {gateway} can't be reached, so this link won't open until it's back. |
| `not-accepted` | {gateway} doesn't accept links from this host yet. Add this host in {gateway}'s Settings → Public links. |
| `unconfirmed` | This link isn't public yet. We'll keep sending it to {gateway}, and it opens once {gateway} confirms. |
| `sleeps` (defined; no server path sets it yet) | This link opens only while this host is awake. |

{gateway} is "the gateway" when the peer isn't known; a sentence that starts with it starts with a
capital. The baton strip's standing notice, while a person or an offer holds the session and no
address is set, is the `off` text.

**Elsewhere**

| Where | Copy |
|---|---|
| Org page, its host down (warn banner, §app.organizations/host-offline) | {host} is offline, so its links can't be opened. |
| Offline page shell (§mesh.public/offline) | title "Not available right now" · heading "This page can't be opened right now." · "The computer it lives on is offline. Try again in a minute." |
| Offline API body | `{error: "offline", retryAfter: 60}` |
| Share page, offline | Reconnecting. Your draft is kept. · a send refused: "Not sent. The page is offline; your message is still here." |

## §design.copy-deck/owner-page — Owner page (§app/owner-page)

The owner is not technical: short sentences, everyday words, full words for time. `{first}` is a
person's first name, `{op}` the operator's first name, `{org}` the org's name, `{project}` a
project's name. Times on the owner page: "just now", "{n} minutes ago", "{n} hours ago",
"yesterday", "{n} days ago", then "Mar 4" (and "Mar 4, 2025" in another year); singular "1 minute
ago", "1 hour ago"; the exact date and time as the element's title. Every count has its singular.

**Owner page (what the owner reads)**

| Where | Copy |
|---|---|
| Browser tab title | `{org}` |
| Greeting | "Hi {first}. Here's how your projects are going." |
| Read-only line | "You can read everything here. Nothing you do on this page changes anything." |
| Freshness | "Updated just now" · "Updated {time}" |
| Waiting on you, heading | "Waiting on you" |
| …line | "1 question is waiting for your answer." / "{n} questions are waiting for your answer." |
| …row | "{conversation title}" · "{project} · asked {time}" |
| …hint | "Answer it using the link {op} sent you for it." |
| Projects, heading | "Your projects" |
| Project card, counts | "Talked to {n} people · {n} decisions · {n} pieces of work finished" — singulars "1 person", "1 decision", "1 piece of work" |
| …no updates yet | "No updates yet." |
| Projects, none | "There are no projects on this page yet. When {op} starts one, it will show up here." |
| Project status chips | `Waiting on you` (warn) · `Asking questions` (info) · `Building` (info) · `Quiet` (neutral) |
| Back links | "← All projects" · "← {project}" |
| Updates, heading | "Updates" |
| …none | "{n} conversations so far. No updates yet." |
| …show all | `Show All {n} Updates` |
| Who we've talked to, heading | "Who we've talked to" |
| …row | "{name}" · "{n} conversations · last wrote {time}" / "{n} conversations · hasn't replied yet" |
| …none | "Nobody has been asked anything yet." |
| What's been decided, heading | "What's been decided" |
| …row meta | "{name}, {date}" · disclosure "In {first}'s words" |
| …status chips | `Agreed` (success) · `Noted` (neutral) · `Needs a choice` (warn) |
| …none | "{n} conversations so far. Nothing has been decided yet." |
| …show all | `Show All {n} Decisions` |
| Different answers | "{A} and {B} gave different answers about {topic}. We've asked {C} to choose." · to the owner: "…We've asked you to choose." · to the operator: "…{op} will choose." |
| What's been built, heading | "What's been built" |
| …counts | "{n} pieces of work finished · {n} in progress" |
| …none | "Nothing has been built yet." |
| Conversations, heading | "Conversations" |
| …row | "{conversation title}" · "Started {time} · {n} messages" |
| …status chips | `Waiting on you` (warn) · `Waiting on {first}` (info) · `With {op}` (info) · `Asked {n} people` (info) · `Finished` (success) · `Ended` (neutral) |
| …none | "No conversations yet." |
| …show all | `Show All {n} Conversations` |
| Conversation, line | "You can read this conversation. You can't write here." |
| …when it's the owner's turn | "It's your turn in this conversation. Answer it using the link {op} sent you." |
| Footer | "Only people with this link can open this page. If someone else gets it, tell {op} and they'll turn it off." |
| Link expired (410) | "This link has expired." / "These links last 90 days. Ask the person who sent it for a new one." |
| Link no longer active (410) | "This link is no longer active." / "Ask the person who sent it for a new one." |
| Unknown link (404) | "This link doesn't open anything." / "Check that you copied all of it." |
| A project or conversation not on the page (404) | "This isn't on your page." / "Go back to all your projects to see what is." · "← All projects" |
| Couldn't load | "We couldn't load this page. Your link still works. Try again in a minute." · `Try Again` |
| Too many requests | "Too many requests from this network. Wait a minute, then reload." |

Never on the owner page, in any form: baton, hand-off, holder, offer, lease, overseer, agent,
model, AI, promote, promoted, draft, drafted, reconcile, conflict, stakeholder, worktree, branch,
merge, commit, repo, session, token, spec, L0–L3, workspace, roster.

**Operator side**

| Where | Copy |
|---|---|
| People tab, card title | "Owner" |
| …hint | "The owner follows every project on one page: the overseer's updates, who was asked, what was decided, and each conversation. They can read it, not change it." |
| …select | label `Owner` · options `None`, then active people by name |
| …saved (toast) | "{name} is the owner now." · None: "This organization has no owner now." |
| …refused (`.field-error`) | "Only an active person on the roster can be the owner." |
| …latest change | "Set by you {relative time}." |
| …cleared (warn banner) | "{name} left the organization, so it has no owner now. Their owner link stopped working." |
| …link line | "Owner link made {relative time} · expires {relative time} · opened {n} times" · none: "No owner link yet." · newest turned off or replaced: "The owner link is turned off." · under 14 days (warn): "Owner link expires {relative time}." · expired: "The owner link expired {relative time}." |
| …buttons | `Get Owner Link` (secondary) · `Preview Owner Page` (secondary) · `Turn Off Owner Link` (destructive, outlined, apart) |
| Get Owner Link, while one is live (confirm) | "{first}'s current link stops working at once. The new one works from now." · `Get Owner Link` · `Cancel` |
| Get Owner Link, no owner | "Pick an owner first." |
| Turn Off, confirm | "{first}'s owner page stops opening at once. The conversations and updates stay." · `Turn Off Owner Link` · `Cancel` |
| Link shown once | the baton strip's Copy Link pattern; `linkWarning` when no share address is known |
| Preview modal title | "{org}, as {first} sees it" |
| …line | "Read only. Nothing you do here reaches {first}, and no visit is recorded." |
| Project page card title | "Owner Page" |
| …switch | "Show this project on {first}'s page" |
| …updates log heading | "Updates for {first}" |
| …log row meta | "Posted by the overseer {relative time}" · "Posted when you asked {relative time}" · taken down: "Taken down {relative time}" |
| …none | "The overseer hasn't posted an update yet. It posts when a conversation finishes, something is agreed, or a piece of work is finished, at most once a day." |
| …Take Down | `Take Down` (destructive, outlined) · confirm: "{first} stops seeing this update. It stays in this list and in the workspace history." · `Take Down` · `Cancel` |
| …switch saved (toast) | "{project} shows on {first}'s page." · "{project} is off {first}'s page." |
| Baton strip | `Hide From {first}` / `Show To {first}` · while hidden: "Hidden from {first}'s owner page." · toasts "Hidden from {first}'s owner page." / "Shown on {first}'s owner page." |
| Person page | chip `Owner` beside the status · link row title "The owner page", state `Can read` / `Turned off` / `Expired` · visit row "Opened the owner page · {device} · {relative time}" |
| Overseer tool refusals (the model reads them; the activity list shows them) | "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged." · "An update was posted {relative time}: at most one a day." · "This update repeats text from About this organization or your notes. Updates are for the client: write it again in your own words." · "This update repeats private text (a conversation's goal or briefing, the operator's instructions, or a person's profile or contact). Updates are for the client: write it again in your own words." · "An update is at most 2,000 characters." · "This organization has no owner, so there is no page to post to." |

## §design.copy-deck/session-share — Session share links (§app/session-share)

`{title}` is the share's public title, `{label}` a recipient's label, `{n}` a count, `{time}` a
relative time, `{date}` a short date ("Sep 29"), `{host}` a host's name. The share page names no
host, person or recipient.

**Share page (what a recipient reads)**

| Where | Copy |
|---|---|
| Head | `{title}` · "Shared {date} · read only"; a snapshot: "Shared {date} · up to {date, time} · read only"; Follow live: chip `Live` |
| Thread | `Show Earlier` (`Loading Earlier Messages`) · failed: "Couldn't load earlier messages. Try again." |
| No messages | "Nothing to read yet." · snapshot "This session had no messages when it was shared." · live "This session has no messages yet. New ones show up here as they're written." |
| Drawings | a caption over a source: "An interactive drawing, shown as its source." (html) · "Code" (code, untitled) · a broken or other kind: "A drawing couldn't be shown here." |
| Dead link | **This link is no longer active.** It was turned off, or the session isn't shared anymore. Ask the person who sent it for a new one. |
| Expired | **This link has expired.** Ask the person who sent it for a new one. |
| Unknown | **This link doesn't open a shared session.** Check that you copied the whole link, or ask the person who sent it for a new one. |
| Busy (429 on the first read) | **This link is being read a lot right now.** Nothing is wrong with it. Try again in a minute. |
| Offline | "Offline. We'll keep trying, and the page stays as it is." |
| A slice that starts partway | "Earlier messages aren't part of this share." (no count) |

**Share sheet**

| Where | Copy |
|---|---|
| Titles | "Share Session" · "Manage Share" · Preview: "As they see it", line "{title} · Read only. No visit is recorded." |
| Intro | "People you send a link to can read this conversation: your messages and the replies, with their drawings and images. Never tool steps, thinking, paths or costs." |
| Title field | "Title they see" · hint "The session's own title may say more than you mean to." |
| People | "People" · placeholder "A name only you see, like Ana" · `Add` · hint "Each person gets their own link, so you see who opened it and can turn one off alone." · remove "Remove {label}" |
| Anyone | "Anyone with the link" · "One more link anyone can open. Its visits show the device type only." |
| Follow live | "Follow live" · off "Off: they see the conversation as it is now. You can update it to now later." · on "They see new messages as the session goes on, including ones you haven't read yet." · managing, off: "Off: turning it on shows them new messages as the session goes on." · on: "They see new messages as the session goes on." |
| Expiry | "Links expire after" · `1 day` / `7 days` / `30 days` / `90 days` |
| What goes out | "{n} messages will be shared, up to {date time}." (Follow live: ", and every one after."; "{n}+" when earlier pages exist; "1 message"; none: "No messages yet.") · `Preview Again` (title "Read the conversation again, as it is now.") · reading: "Reading the conversation…" |
| Images | eyebrow "{n} images" ("1 image") · "Images are shared as they are: nothing in them is hidden." · "Loading images · {n} of {total}" · "{n} of {total} images didn't load, so nothing can be shared until they do." ("…until it does.") · `Retry Images` |
| Blocked Create (its title) | "Give the share a title." · "Add a person, or turn on Anyone with the link." · "At most 20 links per share." · "Reading the conversation first." · "The conversation couldn't be read, so nothing can be shared yet." · "Loading the images first: every image is shown before anything is shared." · "An image didn't load. Retry it first: every image is shown before anything is shared." |
| Slice | the slice line "Messages {a}–{b} of {total}" · "Message {a} of {total}" · "From message {a} · follows live" · unsliced, in Manage: "The whole session." · `Change Slice` · a start no longer on the branch (Update to now): "The start of this share is no longer in the session." · an end on a live share (server refusal): "A share that follows live has no end. Turn Follow live off to end it." · a change raced by another: "This share changed meanwhile. Try again." |
| Stale preview (warn banner) | **The session changed. Preview it again.** Nothing was shared. We read it again: check it, then create the links. · confirming an update: **The session changed. Preview it again.** Nothing changed for them. We read it again: check it, then confirm. |
| Update and stop following | titles "Update to Now" · "Stop Following Live" · "Their pages will show the conversation as it is here, images included." · "Follow live stops here: their pages keep the conversation as it is here, images included." · `Back to Share` · `Update to This` / `Stop Following Here` (`Saving…`) · failed: **Couldn't read the conversation.** Nothing changed. {reason} `Try Again` |
| Foot | `Cancel` · `Preview` · `Create Link` / `Create Links` (`Creating…`) · Preview: `Back to Sharing` / `Back to Share` · managing: `Stop Sharing` (armed `Stop Every Link?`), `Preview`, `Done` |
| New links | eyebrow "New link · shown once" / "{n} new links · shown once" · `Copy Link` (toast "Link copied.") · "We keep only a fingerprint of each link. If one is lost, Get New Link makes another." · the `linkWarning` text with `Open Settings` |
| Managing | "Snapshot up to {date time}." · `Update to Now` (title "Their pages show the conversation as it is now.") · eyebrows "People", "Expiry" · `Get New Link` (title "A new link for them. This one stops working.") · `Turn Off` (armed "Turn Off {label}'s Link?", the anyone row "Turn Off This Link?") · placeholder "Add a person, like Ben" · `Add Person` · `Add Anyone Link` · "{n} days from now" · `Extend` · "Every live link then expires {n} days from now." · `Save Title` |
| Stopped / gone | **Stopped {time}.** Every link is off. The session itself didn't change. · **The session file is gone.** Every link answers that it's no longer active. |
| Errors | **Couldn't read the conversation to preview it.** Nothing was shared. {reason} `Try Again` · **Couldn't create the links.** Nothing was shared. {reason} · **That didn't go through.** Nothing changed. {reason} · "Couldn't read the preview. {reason}" |

**Share page (`#/share/<session>`, the operator's)**

| Where | Copy |
|---|---|
| Page | title "Share Session" / changing a share "Change Slice" · `Back to Session` · failed read: "Couldn't read the conversation." `Read Messages Again` · a share not on this session: "This share isn't on this session anymore." |
| List | "Tap where the share starts, then where it ends." · rows `You` / `Reply`, chips `Start` / `End` / `Start and end`, "Image only.", `aria-label` "1 image" / "{n} images" · none: **No messages yet.** There's nothing to share until the session has a message. |
| Bar | the range: "Messages {a}–{b} of {total}" · "Message {a} of {total}" · "All {total} messages" · "No messages yet" · "From message {a} · follows live" · "All messages · follows live"; the ends: "From the first message · To the latest" / "From message {a} · To message {b}" · `Back` · `Preview` · `Next` · changing a share: `Save Slice` (`Saving…`) |
| Hints | "Starts with a reply." `Include the question?` · "Ends with your question." `Include the reply?` · picking an end turns Follow live off: "Follow live is off: a share with an end stays as it is at that message." |
| Review | "{range}. People you send a link to can read these messages and the replies, with their drawings and images. Never tool steps, thinking, paths or costs." · changing a share: "{range}. Open pages start over with the new slice." · Follow live off: "Off: they see these messages as they are now. You can update it to now later." · Save blocked: "The conversation couldn't be read, so nothing can be saved yet." · `Create Link` / `Create Links` (`Creating…`) · `Done` |
| Stale and errors | **The session changed. Preview it again.** Nothing was shared. / Nothing changed. We read it again: check the slice, then go on. · **Couldn't create the links.** / **Couldn't save the slice.** Nothing was shared. / Nothing changed. {reason} |
| Changed meanwhile (Save Slice, 409 `share-changed`) | **This share changed meanwhile.** Nothing was changed. We read it again: save again to apply this slice. |
| Done | "{range}. The link shows only once, here." / "Each link shows only once, here." · toast "Slice saved." |
| Old host | **This host needs an update to share part of a session.** Nothing was shared. Once it runs the current Sova, open this page again. |
| Head | Session head's icon link `aria-label` "Share session" |

**Recipient rows (sheet, Sharing section, Shares page)**

| Where | Copy |
|---|---|
| Presence chips | `Viewing now` (success) · `Open in a tab` (neutral) · `Expired` (warn) · `Turned off` (neutral) |
| Opened line | "Opened {n}× · last {time}" · "Not opened yet" · "Expires in {n} days" / "Expires tomorrow" / "Expires in {n} hours" / "Expires within the hour" / "Expired" |
| Visits | disclosure "Visits · {n}" · "Opened · {device} · {time} · {n} min" · "Link preview · {device} · {time}" · "Refused · {device} · {time}" · "More opens that day, not listed" · a bot "(automated)" |
| Mode line | "Snapshot up to {date time}" · "Follows live" · "Stopped {time}"; a sliced share shows its slice line instead of the first two |

**Session detail · Sharing, and #/shares**

| Where | Copy |
|---|---|
| Tab | "Sharing" · a count chip while someone is viewing; accessible name "Sharing, {n} viewing now" |
| Section | eyebrow "Sharing" · `All Shares` · none: "Not shared with anyone." · `Share Session` · `Manage` · an older host: "This host can't share sessions yet. It needs an update." · failed: "Couldn't read this session's shares. {reason}" |
| Sidebar foot | row "Shares" · spine "Shares" |
| Page | title "Shares" · meta "{n} session shares · {n} organization links" (+ " · {n} viewing now") · `Refresh Shares` |
| Cards | "Session shares" (row meta adds "session “{session title}”" when it differs) · "No session share has a live link." · disclosure "Ended · {n}" · "Organization links" (row "{hand-off title} · hand-off {n}" or "Owner page" · "{org} · {state} · Expires in {n} days") |
| Actions | `Manage` · `Stop Sharing` (armed `Stop Every Link?`) · `Turn Off Link` (armed "Turn Off {person}'s Link?") |
| Empty and hosts | **No public links are open.** Share a session from its Sharing tab: Session details, then Sharing. · "{host} can't be reached, so its links aren't listed." · failed action: **That didn't go through.** Nothing was changed. {reason} |
