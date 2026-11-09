# §chat/profiles — Profiles
> Part of the Sova design spec · [overview](../design/overview.md)

A profile is one named setup for a chat, in two parts:

- **When a Chat Starts**: the mode and add-on modes a chat starts in, which of the default tools it
  loses, which session powers it gains, One at a time, the limits on its sends, a first message, and
  whether the Overseer may start it. This part is fixed once the chat's first message is sent, and the
  chat keeps its own copy (§chat.profiles/enforcement).
- **Models**: the chat's own model and effort, and its helpers' models: Delegate's four work kinds,
  which team members also run on by their kind, the team coordinator and monitor, the spec writer and the reviewer, with the
  alignment settings (§chat/subagent-profiles). A chat can switch this part at any time
  (§chat.profiles/switch).

There is one list of profiles (§chat.profiles/joined), one Settings tab that edits them
(§app.settings-dialog/profiles), and one default per computer that decides what a new chat starts
with (§chat.profiles/default). Profiles are Sova's, yours, and each project's own
(§chat.profiles/projects). A profile is picked on the new chat's empty screen (or started from the
list or by the Overseer). The UI says "profile"; "abilities" is the baton's word
(§app.baton/abilities) and is not used here.

## §chat.profiles/model — Capabilities, sources and the session's copy

- **Capabilities, not tool names.** A profile names groups (`shared/profiles.ts`, one map for server
  and client). Removable: **Shell** (`bash`, `background_job`), **Edit files** (`edit`, `write`), **Workers & teams**
  (`agent_*`, `team_*`), **Web** (`web_search`, `fetch_content`, `get_search_content`,
  `source_check`), **Worktrees** (`worktree`), **Timers** (`wake_nudge`), **MCP Servers** (every
  tool of the chat's MCP servers, §app.mcp/who-gets). The link tools are no
  capability: a session has them only as a link member, born or joined (§mesh.links/tools), so
  no profile or board lists, keeps or removes them. A profile file that still names the old
  `links` removal reads as if it didn't, and the rest of it is kept.
  Grantable: **Read other sessions** (`sessions.read`), **Message other sessions**
  (`sessions.message`), **See all Sova sessions** (`sessions.all`). Messaging and See all each turn
  reading on; turning reading off turns both off.
- **A profile** is `{id, label, icon, description, remove[], grant[], singleton, limits, mode?,
  minorModes?, model?, thinking?, subagents?, firstMessage?, overseerMayStart}`. `singleton` is
  labelled **One at a time** in the UI (§chat.profiles/singleton). `limits` are
  §chat.profiles/limits's five numbers. A `playbook` key, which older Sova wrote, still parses and
  is ignored (§chat.profiles/playbook).
  `model` is the main thread's model ref (`provider/id`); `thinking` its effort, one of pi's levels
  (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `subagents` links the profile's
  helpers, by the id of a profile in the helper library (§chat.subagent-profiles/file), or `"off"`:
  that link is what joins the two parts (§chat.profiles/joined). Each is optional: absent, the
  session keeps the model and effort it would open on (the default profile's, else the new-session
  default model and effort), and takes its helpers from this computer's default (its default
  subagent profile, §chat.profiles/default). `minorModes` is the whole set of minor modes the session starts with (`align`,
  `spec`, `vis`), in any order; `[]` starts with none; absent, the session starts with
  mode.json's default. A file whose `thinking` is no level, whose `subagents` isn't `off` or a
  subagent profile id (lowercase letters, digits and dashes, at most 48), whose `minorModes`
  isn't a list of those names, or whose `mode` isn't `normal` or `delegate`, doesn't parse. Naming
  `create` says why: it is chosen in a chat (§chat.create-mode/per-chat-only).
- **Capability-neutral.** A profile that removes and grants nothing, isn't One at a time, and has
  no first message (so it sets only model, effort, subagents, mode or minor modes) is
  capability-neutral.
- **Where profiles come from** is §chat.profiles/projects: **Default** in code (no profile, nothing
  changed: the built-in **Off**, once the picker's My settings, §chat.subagent-profiles/off), the **Built in** files Sova ships (none a person can pick today), **Yours**,
  and **This project**'s files. Sova also ships two **system** profiles that only Sova itself
  starts: **Merge thread** (§chat.merge-queue/thread) and **Merge reviewer**
  (§app.merge-queue/review). Sova writes only Yours, and only when
  you save one (Settings → Profiles' editor, §app.settings-dialog/profile-editor, or
  §chat.profiles/picker's Save Current As Profile).
- **The session keeps its own copy.** A session's profile is its invisible `custom` entry
  `customType: "sova-profile"`, data `{v: 1, profile: {…the whole profile…, source, project?,
  projectName?}}` or `{v: 1, profile: null}` (Default, the UI's Off), newest on the branch wins. `source` is
  `sova`, `user` or `project`, and a project profile keeps its project's root and name. An entry
  with a profile may carry `mine: {mode, minorModes, model?, thinking?, subagents?}`, what the
  session had before its first profile pick (§chat.profiles/applying). An older
  entry's `builtin: true` reads as `sova`. It is never LLM context, the TUI ignores it, and it draws
  no transcript row of its own. Changing, hiding or deleting a profile's file never changes a session
  that already has one. No entry means Default, exactly as before profiles existed.
- `SessionSummary.profile` carries `{id, label, icon, singleton, source, project?, projectName?,
  neutral?}` of the branch's newest entry (absent for Default; `neutral: true` for a
  capability-neutral profile), read by Sova's own file reader, so a TUI-live file is never opened.

## §chat.profiles/joined — One list, saved as two halves

Settings → Profiles, the new chat's cards and the mode menu's picker list one set of profiles. The
server builds that list from the two saved lists, which stay exactly as they are: the session
profiles (Yours in `session-profiles.json`, each project's `.sova/profiles/`, §chat.profiles/projects)
hold the When a Chat Starts part and the chat's own model and effort, and the helper library
(`subagent-profiles.json`, §chat.subagent-profiles/file) holds the helpers and the alignment
settings. The link between them is the session profile's `subagents` id. No new file holds the
joined list, nothing writes a second copy in another format, and nothing is rewritten when this Sova
first starts.

- **A pair is one profile.** A session profile whose `subagents` names a library profile is one row
  with both parts, under the session profile's name. Profiles you already have that link this way
  are one profile each, as they are.
- **A library profile no session profile links to** is still a row, under Yours, with only its
  Models part: its This chat row reads "Keeps the chat's own model", and a chat started on it starts
  as Off does (§chat.subagent-profiles/off) except that its helpers are this profile's.
- **A session profile with no link** is still a row, with its When a Chat Starts part and its This
  chat row; its helper rows are empty, and a chat on it takes its helpers from this computer's
  default (§chat.profiles/default).
- **Its id.** A pair's id is its session profile's id; a library profile no session profile links
  to goes by its library id. Both are what the Overseer takes (§chat.subagent-profiles/overseer).
- **A library profile linked by more than one profile** is shared: each of them shows it as its
  Models part, the editor says "Also used by {name}" there (§app.settings-dialog/profile-editor), and
  an edit through any of them changes it for each. Deleting one of those profiles keeps the library
  half the others still link; deleting the last one deletes it.
- **The footprint**, the line under a profile's name in Settings, on the new chat's cards and in the
  mode menu's picker, is the distinct models of its Models part, the chat's own model first, joined
  with " + " ("Opus 5.5 + GPT-6.1 Sol"), at most 3 and then "+N", a Claude model by its catalog name
  (§app.claude-code-provider/model-names). Off reads "Keeps the chat's own model".
- **Each half is written by its own writer.** Saving a profile writes its session profile through
  Yours' writer (§chat.profiles/projects) and its helpers through the library's
  (§chat.subagent-profiles/file), each only when that half changed. A save re-reads the saved list
  just before writing and applies only the profile being saved, so a profile that arrived from
  another computer during the save is kept and never counted as deleted. A new profile creates both
  halves, linked. Renaming one renames both, so the two names stay in step. Setting anything in the
  When a Chat Starts part or the This chat row of a library profile no session profile links to
  creates its session profile, linked, under the same name.
- **A project's profile** links the same way: its file's `subagents` names a profile in this
  computer's library, and its row shows that library profile's Models part, read-only, as the rest
  of the file is (§app.settings-dialog/profiles).

## §chat.profiles/picker — Picking a profile on the empty screen

On an ordinary session's empty screen (§chat.transcript/setup-card's empty state), right under the
title and above the setup card, sits a **grid of profile cards**: one click picks a profile. The
Overseer, project overseers, baton, organization and TUI-live sessions show no picker.

- **The grid** is a radio group labelled "Profile", each card a radio checked while its profile is
  the session's; one card is in the tab order. Arrow keys move focus between cards, Home and End to
  the first and last, and Enter, Space or a click picks (moving focus never picks: every pick
  reopens the runtime). The focused card shows the focus ring, and focus is back on the picked card
  once the runtime has reopened. A One at a time profile live in another session is no radio but a
  link to that session (§chat.profiles/singleton): it keeps its place among the cards, Tab reaches
  it there like any link, and the arrow keys skip it. Cards fill the session column (at most `--measure`, the message cap of
  §chat.transcript/transcript-items) in as many columns as fit at 220px or wider. Where the picker is narrower than 480px (a phone), the cards are one column of single-line
  cards: icon, label, caption and chips on one 44px line (chips that don't fit take a second), the
  caption giving way first (its mode icons folding, then its model name cut, as **A card** says),
  the label keeping up to about two thirds of the card before it is cut. A card that can't be used keeps its whole reason, on its own line below. **Off** comes
  first, a card under no label; then **Yours** (every profile of §chat.profiles/joined that is yours:
  pairs, library profiles no session profile links to, and session profiles with no link), then
  **This project ({name})**, each under its own
  label (a profile file Sova itself ships for people to pick, of which there are none today, would
  follow under **Built in**); the system profiles are never listed, and hidden profiles are left out, and Off can't be hidden. A last card, **Custom…**, opens the capability
  board. With more than 9 cards, a **Find a profile** field above the grid filters them by name.
  While a profile file here can't be read, a muted line under the grid says "{n} profile files have
  mistakes. See Manage Profiles." ("1 profile file has mistakes.") **Manage Profiles** opens
  Settings → Profiles (§app.settings-dialog/profiles). A new chat opens with this computer's default
  picked, its card carrying a **Default** chip (§chat.profiles/default).
- **A card** shows the profile's icon, its label and one caption line. When the profile sets any
  settings, the caption is icons, and only for what that profile sets, in this order: the model
  and effort as the composer foot draws them (§chat.composer/behavior: the effort ring, then the
  model's short name; a profile that sets only the effort shows just the ring, only the model just
  the name; "off" is the empty ring), the subagents icon with the count of the subagent profile's
  distinct primary models, or "off", then the mode icons (§chat.mode-menu/trigger: its major
  mode's, then one per minor mode it starts with, a project mode as its letter square); a profile
  that starts with no minor modes (`[]`) ends with the words "no minor modes". The count comes with
  the listing: each of its `subagents` entries carries `models`, the distinct primary models the
  server counts from that library profile's workers (0 for Off); from an older server that omits
  it, the card shows the subagent profile's id instead. The whole caption in words ("{model} ·
  {effort} · subagents: {footprint} · {mode} · {minor modes}", the minor modes as "align, spec,
  vis", or "no minor modes" for `[]`) is the caption's accessible text and the card's `title`;
  each icon item's own hover text is its part in words ("{model} · effort {level}", "subagents:
  {footprint}", "mode: {mode}", "minor mode: {id}"). **The model name is the last thing to
  shrink.** When the caption runs out of room and draws at least two mode icons, its mode icons
  fold first: the first mode icon stays, followed by a quiet count of the rest ("+3", minor and
  project modes alike, after where the last mode icon was), and the caption's gaps narrow to
  `--space-1`, the icons' own spacing; only if the caption still doesn't fit does the model's
  short name end in an ellipsis (with one mode icon or none there is nothing to fold, so the name
  is what gives). Whether it folds is decided from the unfolded caption, measured with every icon
  out before the frame is drawn, so it never flickers and the same width always gives the same
  caption; it unfolds when the room comes back (a wider window, a shorter name). A fold hides nothing
  from the words: the caption's accessible text and the card's `title` keep the full wording, and
  the picked profile's details line (below) still names every mode. Where the caption is at least 340px wide,
  words come back beside the icons: the level, "subagents" and each mode's id. Captions that aren't settings stay words: the
  description of a profile that sets none of them, a disabled reason (below), and "Opens the
  running session: {title}" (§chat.profiles/singleton). Chips say **Live**, with Sova's usual live
  dot (a One at a time profile live in another session, in place of One at a time), **Needs
  approval** (an unapproved project profile, §chat.profiles/trust) and **One at a time** (one live
  nowhere else).
- **A card that can't be used here** is disabled (`aria-disabled`, still focusable so its reason is
  read), with the reason as its caption, in the warn tone, and as its title, and a click on it does
  nothing. It looks off by shape as well as tone: no fill and a dashed edge, a muted label and
  dimmed icon, a not-allowed pointer, and no change on hover. It is off because its model is turned off in Settings → Models (that page's sentence),
  has no credentials on this host ("No credentials here for {model}."), or its subagent profile
  isn't in this device's library ("Its subagent profile "{id}" isn't in this device's library.").
- **Off** (§chat.subagent-profiles/off) is the session with no profile (`profile: null`; Default,
  whose id stays `default`), in place of the old **My settings** card. Its caption reads "Keeps the
  chat's own model"; its accessible name and desktop hover text add what it keeps, "{mode} · {minor modes}
  · {model} · {effort}" ("Delegate · Align · Opus 5.5 · high"): the session now, or once a profile
  is picked what Off would put back (§chat.profiles/applying), else "Your own settings". Picked, it
  shows one muted line: "No profile: the settings you chose, {n} tools, no session powers."
- **Save Current As Profile**, beside Manage Profiles, asks for a name and saves this session's
  model and effort, with a copy of the helpers its subagent pick gives it now (from its own pick when
  it has one; with none, otherwise, from this computer's default; Off when they are Off), as a new
  capability-neutral profile in Yours with both halves, linked (§chat.profiles/joined), with the
  wrench icon. It changes nothing about this session; the new
  card shows at once. A name you already use in Yours is refused ("You already have a profile named
  "{name}". Pick another name."), and a Yours file that can't be read refuses with its error and is
  never overwritten. A refusal stays under the name field ("Couldn't save {name}. {reason}"), the
  field marked invalid and the form open, until the name changes or the form closes.
- **The picked profile's details**, under the cards, start with one line that spells its settings
  out in full words, so nothing the card's icons say is only an icon: "Model: {model} · Effort:
  {level} · Subagents: {name} ({its footprint's models, joined with commas}) · Main mode: {mode}
  · Add-on modes: {ids, joined with commas}" ("Subagents: off"; "Add-on modes: none" for `[]`),
  what it leaves unset left out, and no line when it sets none of them.
- **Any other profile** shows its one-line description, then **What changes** (vs Off): a row per
  grant, `+` and tinted, with its limits under Message other sessions ("Up to {hops} hops · {n} sends
  per message you send · {n} a day on its own · {n} to one session per 10 min"), then a row per
  removal, `−`, naming its tools. A folded line follows: "Same as Off: {n} tools. Show All",
  which lists them. A One at a time profile adds that badge.
- **Guardrail note.** While anything is removed and the shell is kept, an info note says "The shell
  is on, so removals are guardrails, not a boundary. Bash can still change files and call Sova's
  API." With the shell removed: "The shell is off, so these removals hold."
- Under it, muted: "Fixed once you send your first message."
- **Custom…** opens the capability board: one toggle per removable capability ("on" = kept) and per
  grant, starting from the profile picked before. A toggle it can't change right now is disabled
  with its reason in its title (§chat.profiles/enforcement's workers rule). Its head names where it
  started ("Off" with no profile) and reads "{label}, edited" ("Off, edited") once it
  differs from there, with **Reset**. Every flip applies at once, like a
  pick. The board changes this session only and never makes a profile: profiles are files
  (§chat.profiles/projects).
- **A session the Overseer started from a profile** shows the same screen with it preselected and
  one muted line: "Started by the Overseer with {label}." It stays changeable until a message is sent.

## §chat.profiles/profile-name — A profile's name

Save Current As Profile's name box (§chat.profiles/picker) and the name field of Settings →
Profiles' editor (§app.settings-dialog/profile-editor) are the form kit's (§design/forms). A profile
is one name for both its halves (§chat.profiles/joined), so it takes both halves' rules: a name past
48 characters is kept whole, its count "{n} / 48" red with "Profile name can be at most 48
characters." under it, and Save waits; a blank one is "Profile name can't be empty."; "Off" is
"Profile name can't be "Off", the built-in profile's."; one you already use, ignoring case, is
"Another profile has this name.". The server's save, and its read of a profile file, refuse in the
same words, from one rule (`shared/profile-limits.ts`). A session profile with no helpers that an
older Sova saved with a longer name (up to 60 characters) still reads, and keeps it until it is
renamed.

## §chat.profiles/applying — A pick writes the entry and reopens the runtime

- `POST /api/sessions/profile {path, profile}` (`profile`: `{source, id}` or a bare id, resolved
  against the session's own project (§chat.profiles/projects), or a custom `{remove, grant}`; `null`
  is Off) writes the new `sova-profile` entry at once, after the
  open-time model and thinking entries, then disposes the held runtime, the move the Overseer's model
  change makes: open tabs get `reloaded` and reconnect, keeping the draft. The reopened runtime reads
  the entry. A profile's `mode` and `minorModes` are applied and pinned together (one mode
  extension `mode` entry, so the session keeps them on every reopen whatever mode.json says later;
  a profile that sets only one of them keeps the session's other), its `model` becomes
  the opening model, its `thinking` the opening effort, and its `subagents` is written as the
  session's subagent pick (the `subagent-profile` entry, §chat.subagent-profiles/resolution), in the
  same step; its `firstMessage` fills an empty composer. None of these moves this computer's default
  (§chat.profiles/default) or any file it keeps written, the new-session model and effort
  (`defaults.json`) included. A library profile no session profile links to (§chat.profiles/joined)
  is picked as Off with its helpers: the entry is `{v: 1, profile: null}` and its id is written as
  the subagent pick.
- **Checked before anything is written.** A pick whose model is turned off in Settings → Models,
  has no credentials on this host or isn't a model here, whose effort isn't one of the levels, or
  whose subagent profile isn't in this device's library is refused (400) with a sentence that says
  which, and nothing is written.
- **Off brings back what you set**, as My settings did. The first pick of a profile on a session with none
  remembers what the session has then, in that entry's `mine` (§chat.profiles/model): its mode and
  minor modes, model, effort, and its own subagent pick (none when it follows the device's
  default). A pick of another profile, or a Custom… flip, carries the same `mine` forward. A pick of
  Off (`null`) replays it, each part only where it differs from now: the mode and minor
  modes (pinned together), the model and the effort; and it pins the subagent pick to `off`, since
  Off has the agent pick every worker (§chat.subagent-profiles/off). A remembered
  model that can't be used now (turned off, no credentials, gone) falls to the new-session one, as
  below. Back on Off the entry is `{v: 1, profile: null}` with no `mine`, so the next first
  pick remembers afresh. Like every pick, only before the first message.
- **Switching back.** Without a `mine` to replay (an entry an older build wrote), and for a pick of
  another profile that doesn't set a field, these hold. A pick made while the session's current
  profile sets `subagents`, of a profile that sets none (Default included: there, Off pins `off`, above), pins this computer's
  default subagent profile (the helpers of its default profile, §chat.profiles/default; `off` when
  the default is Off or links none) as the session's pick, since a pick is newest-wins and can't
  be cleared; a session with no pick entry gets none. Likewise a pick of a profile without `model`
  or `thinking`, made while the current profile sets it, puts back the model or effort a new
  session would open on: the new-session default's (`defaults.json`) when it names a usable one,
  else pi's own default, the same fallback a new session takes. That file is never written. And a
  pick of a profile without `mode` or `minorModes`, made while the current profile sets it, puts
  that field back to mode.json's default and pins it with the other, so the session doesn't keep the
  previous profile's mode or minor modes; mode.json is never written either.
- **Refused** (409, nothing written) once a user message is on the branch ("The profile is fixed
  once a message is sent."), mid-turn, TUI-live, for a foreign writer, for the special sessions
  above, and for a project profile that needs approval (§chat.profiles/trust). A rewind to before the first message leaves a branch with no user message, so the picker
  is back, with the profile that branch holds. After the first message a chat still switches its
  Models part, with the When a Chat Starts part kept (§chat.profiles/switch).
- The chat socket sends a `profile` message after `hello`, whenever there is something to show (a
  profile, or a session still before its first message): the branch's profile (or null), who
  picked it, whether it is `locked`, the runtime's active tool names, the tools its removals took
  away and the tools its grants added, and, with a profile, the entry's `mine` (what Off
  would put back). The client never keeps its own tool list. A Default session
  with a message on its branch gets none, so its socket frames are as before.

## §chat.profiles/enforcement — What a profile changes in the runtime

- **Removals** are the SDK's `excludeTools`, given when the runtime is built. They filter the tool
  registry itself, so no extension's `setActiveTools` (mode strict's restore, align, vis_check,
  vision-delegate) and no re-registration (the sandbox's bash) brings a removed tool back.
  **MCP Servers** has no fixed tool names, so it applies where a chat's list is made: a chat on
  that profile lists no server (§app.mcp/tool-list).
- **Workers never exceed their session.** A profile that removes a tool also removes Workers &
  teams, since a worker would start with every default tool. MCP Servers is no such removal: a
  worker's servers are capped to its chat's, so a chat with none gives a worker none, and removing
  MCP Servers alone leaves Workers & teams as they were, neither taking them nor bringing them back.
- **Removing the shell adds the search tools.** A general rule, for every profile, not one setting
  of the merge reviewer's: removing the shell adds pi's read-only read, grep, find and ls to the
  session and changes nothing else. Bash stays off, and edit and write follow the profile's own
  edit setting as before. A session without such a profile keeps pi's own default set.
  The board shows that toggle off and disabled while a removal that takes it is on: "Workers would
  get every tool back, so removing anything removes them too."
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
  its folder and below. With it: every session this host's list shows (Folders, the
  projects' folder sessions and the Archive, TUI-live ones included). Never, either way: itself, the Overseer's conversations,
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
- **On its own, 40 a day.** Sends in runs the user didn't start (a timer's wake-up, a background job's
  end card, another session's message), counted per local day. A wake-up turn may send; it spends this allowance.
- **Targets per run, 5.** Distinct sessions one run sends to.
- **To one session per 10 minutes, 6.** Sends from this session to one target in any 10 minutes.
- A refused send takes nothing from any allowance. The per-message and per-day counts outlive a
  server restart; the per-run and per-pair counts are in the memory of the chat's process: they
  outlive a server restart in a chat process of its own (§app/chat-processes) and start over when the
  chat's process restarts. Chat processes share the per-message and per-day counts through one file,
  written under a lock, so none loses another's.
- **Audit.** Every `session_send` and `session_read`, refused or not, is one line in
  `<state root>/session-actions.jsonl`: `{at, sessionId, profile, tool, target?, hop?, outcome,
  error?}`. The message text is never logged.

## §chat.profiles/delivery — A message from another session

- **The model sees who sent it.** The text the target receives begins with one line,
  `[from session "{title}" ({id}), hop {n}]`, then the sender's text.
- **The transcript knows it for sure.** Once the message enters the context, the server writes an
  invisible `custom` entry `customType: "sova-session-sent"`, data `{v: 1, targetId, from: {sessionId,
  title}, hop}` (§app.overseer/sent-marker's mechanism, its third sender). Only the in-process tool
  can set it, and, for an extension's message or a card's press, what the server itself knows of the sender
  (§app.extensions/name-badge, §chat.alignment/session-mark), which has its own sender line: no link and no
  hop. The target's transcript then draws a sender header, "From {title}" linking to the
  sender and "hop {n}", above a neutral message row whose author reads "From a session", never
  "You", and hides the header line from the row's text. On reload and live alike. The Timeline
  tab's row for it carries the same sender line and shows the text without the header line
  (§chat/timeline "Who sent it"); it is not something the user typed, so Inputs Only and the
  composer's input count leave it out.
- While queued in the target, its row carries the same sender header, **From {title}** (the queue
  snapshot's `fromSession`).
- **The merge queue is not a session.** Its requests never arrive this way: they come as batches on
  the chat queue Sova opens for it (§chat.merge-queue/requests), drawn as "Merge queue · {branch} in {place}
  · {n} requests", never as "From a session" and never with a hop. A `[merge-queue]` message written
  before that still reads with the author "Merge queue", never "From a session".
- **The sender's transcript** shows each `session_send` as a card naming the target (a link) and
  how it went: "Sent to {title}", "Queued in {title}" or the refusal.

## §chat.profiles/after-first-message — The chip, the row and the badge

- **Head chip.** A session with a profile shows a chip in the session head: its icon and label
  (icon only in a narrow head). It opens a popover: one sentence ("A {label} session. It {powers}
  and keeps {n} of {m} tools{ with Web off}."), what is added and removed, "Fixed when the first
  message was sent.", and, while the profile it came from still exists, **Run Again** (below) and
  **Manage Profiles** (Settings → Profiles), "Changes to When a Chat Starts reach new
  sessions only." (where it read "Changes reach new sessions only." before), and for a live One at a time session **Stop {Label}**, which archives it. A
  project profile's chip title and the popover's name read "{label} · {project}". Off (Default) shows no chip, and neither does a session before its first
  message (the picker is there instead). The chip and the info row name the profile the chat
  started on, whose tools and powers it keeps; a later switch of its Models part
  (§chat.profiles/switch) is named in the mode menu (§chat.subagent-profiles/menu), not here.
- **Info row.** A muted row where the entry sits, "Profile: {label}" (with "· One at a time"), once
  a message is on the branch. Before that, the entry draws nothing and doesn't count as a row,
  so the empty state stays.
- **List badge.** The session's row in the list carries the profile's icon, its label as the title.
  The list has no region of its own for profile sessions: each row stays where the session lives
  (Folders, its groups, its project's block, the Archive) and, like any session, can be a Recent
  row (§app.session-list/recent).
- **Run Again** makes a new session in this session's folder with this profile picked and opens it
  on its empty screen, where the picker shows it
  (§chat.profiles/picker). Nothing is sent. It is `POST /api/sessions` with `cwd` and `profile`. On a
  One at a time profile that is live it answers with the picker's alert (§chat.profiles/singleton)
  as a toast with **Open the Running {Label}**.

## §chat.profiles/singleton — One at a time

- At most **one live (non-archived) session per One at a time profile**, on this host, where a
  profile is its identity (§chat.profiles/projects): a project's profile allows one per project, so
  the same id in two projects runs twice, and one of yours or a built-in one per host. A session
  counts from the moment the profile is picked for it, so a session that carries a profile is
  listed even before its first message (an empty session is otherwise never listed), where it can
  be opened or archived.
- **A running one opens instead.** While a One at a time profile is live in another session (the
  listing's `running`), its picker card is a link that opens that session (`#/sid/{id}`) in one
  click, with a **Live** chip (Sova's usual live dot and the word "Live") in place of One at a time and the caption "Opens the running
  session: {title}". It never picks, so it is no radio (§chat.profiles/picker). The picker reads the
  listing again whenever the window regains focus, so a profile stopped elsewhere turns back into a
  card that picks, with its One at a time chip.
- **Picking a running one** never makes a second. The server refuses the pick (409, with the
  session that has it); when that refusal reaches the picker (it started elsewhere after the
  listing was read), the pick stays as it was and a warn alert says "{label} is already running.
  It's set to One at a time, so only 1 session can use it.", with **Open the Running {Label}** and
  **Pick Another Profile**.
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
- **Four sources.** **Default** is in code and changes nothing (the picker's Off, once My settings). **Built
  in**: one JSON file per profile in `profiles/` at the Sova repo root; Sova ships none today, and a
  missing folder lists none. **System** profiles sit apart, in `profiles/system/`:
  `merge-thread` and `merge-reviewer`. They are never listed: not in a profile picker, not in
  Settings → Profiles, and not among the profiles a chat, the Overseer or a team may start a
  session on. A bare id never finds them; only Sova's own explicit pick (`{source: "sova", id}`)
  does, when it starts the merge queue's thread or reviewer. The listed built-ins stay exactly
  Default. The merge thread has no web, workers or timers and grants no session powers. The
  reviewer also has no edit tools, no shell and no worktrees, so it reads and searches only (read,
  grep, find and ls, as every profile without the shell, §chat.profiles/enforcement). Both name their modes outright, mode normal
  with no minor modes, so a chat started on them is pinned to exactly that and the default modes
  saved on this computer never reach it; Sova then turns memory on for the merge thread alone
  (§chat.merge-queue/thread). Chats started on them are the queue's own and are left out of every
  session list; picking another profile for one is refused (409), so it keeps that mark and its
  modes (§app.merge-queue/chats). **Yours**:
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
- **Profiles are files.** An agent or you edit them; a change to the When a Chat Starts part
  reaches new picks only, and one to the Models part reaches chats on that profile from their next
  turn or team action. Sova writes one session profile file, Yours, and only when you ask: Save
  Current As Profile (§chat.profiles/picker), and Settings → Profiles' editor saving, renaming,
  adding, duplicating or deleting one of yours (§app.settings-dialog/profile-editor). Each write
  re-reads the file, refuses when it doesn't parse, changes only the profiles asked and replaces the
  file atomically (a temporary file renamed over it). Built-in and project files are never written.
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
  since you looked), so what you approve is what you saw, and from anything but your own page
  (§app.access/your-click), so no chat or script approves one. **Apply and Approve** on a project overseer's
  Settings change card (§app.project-overseer/settings) records the same approval, of the powers the card
  showed, for each profile the card grants; the overseer itself never approves one.
- **Where.** In the picker, an unapproved project profile reads **Needs approval**. Picking it
  changes nothing and shows a warn alert, "{label} comes from {project}'s files and can {powers}.
  Approve it to use it.", with **Approve** and **Pick Another Profile**. Settings → Profiles shows
  **Approve Profile** in its editor (§app.settings-dialog/profile-editor).
- **Refused until approved**, with nothing written or created: a pick, `POST /api/sessions` with it,
  and the Overseer's `sova_create_session` (no cap taken). The sentence: "{label} is a profile from
  {project}'s files that can {powers}. Approve it in Settings → Profiles or on the picker first."
- A session that already has the profile keeps its copy; approval gates new picks only.

## §chat.profiles/playbook — A profile no longer runs a playbook

A profile used to name a playbook (`playbook: "<id>"`) that its session ran from a card on the empty
screen. That link is retired: a profile carries no playbook, and a playbook runs when you pick it
from the composer (§chat/playbooks) or on a schedule (§chat/schedules).

- **Old files still parse.** Profiles sync between devices, so a file that still has a `playbook`
  key, written by an older Sova, parses as if the key weren't there; it isn't listed as an unknown
  field, and the session's copy of the profile carries no playbook.
- **Nothing runs it.** The empty screen shows no playbook card for any profile, and the Overseer's
  `sova_create_session` with a profile sends only its own `prompt`, if any, as the first message.

## §chat.profiles/live-commit — What the live server runs

- `GET /api/health` answers `{ok: true, startedAt, head, runtime, unknownEntries}`: when this server process started (ISO
  time) and the commit its own checkout had then (`git rev-parse HEAD` in the server's folder, read
  once at start; `null` when that fails), the runtime it runs on (§app.server-runtime/health), and
  how many session entries its pi can't read the server has met since it started, a number only
  (§app.harness/unknown-entries). So one request tells whether the live server runs
  master's commit.
## §chat.profiles/switch — Switching a chat's profile, all at once

Once its first message is sent, a chat can switch to another profile at any time: from the mode
menu's picker (§chat.subagent-profiles/menu), the usage-limit row (§chat.subagent-profiles/limit-row)
or the Overseer (§chat.subagent-profiles/overseer). A switch moves the whole Models part and nothing
else. Before the first message, a pick in the mode menu's picker is no switch: it is exactly a pick
of that profile's card on the empty screen (§chat.profiles/applying), both parts, with a card pick's
rules (a project profile that needs approval can't be picked until it is approved, a One at a time
profile live elsewhere is refused, its first message fills an empty composer), so the checked card,
the picked profile's details and the menu all name one profile. The runtime reopens, so the menu
closes.

- **What moves.** The chat's own model and effort, where the profile sets them; its helpers (the
  chat's helper pick, §chat.subagent-profiles/resolution); and the alignment settings they carry.
  Tools, session powers and modes stay as the chat has them. A profile that sets no model for the
  chat leaves the chat's model as it is; a profile with no helpers gives the chat this computer's
  default helpers (§chat.profiles/default).
- **Checked first, all or nothing.** Before anything is written, the new model is checked as a
  composer pick is: it is a model here, Settings → Models allows it, and this computer has
  credentials for it; its effort is a level, and its helpers are in this computer's library. If any
  check fails, nothing switches: the chat keeps its model and its helpers, and the menu (or the limit
  row) says why in an error banner, "Couldn't switch to {name}." with the reason ("No credentials
  here for {model}.", or Settings → Models' sentence). A chat is never left with its helpers on the
  new profile and its own model on the old one.
- **While a reply runs**, the switch waits for the reply to end, then applies both together, checked
  again then; if a check fails then, nothing switches and the chat says why the same way. Until it
  applies, a line in the thread, just above the composer, says "Switching to {name} when this chat is free. Moves this chat's model, its {n}
  helpers, and alignment settings. Tools and modes stay." ({n}: the helper roles the profile sets;
  without a model of its own it doesn't say "this chat's model"), with **Cancel Switch**, which drops
  the waiting switch and changes nothing. Messages queued during the reply join it on the old model,
  as with a mode switch (§chat.mode-menu/how-a-switch-reaches-the-chat).
- **While the chat compacts** (its own /compact, or pi's automatic compaction after a turn), the switch
  waits the same way, with the same line and Cancel Switch, and applies when the compaction ends,
  checked again then, with no reply needed; a reply or compaction that starts first keeps it waiting
  for that one's end.
- **The profile it is on, again.** Picking the chat's own profile while it isn't "(edited)" changes
  nothing and shows no line, busy or idle; while another switch waits, it drops that one (the chat
  stays as it is).
- **Once it applies**, the same place in the thread, above the composer, says "This chat and its
  helpers are on {name}." Its next turn, its
  next team action and every worker started from then on use the new profile; workers already
  running keep the model they started with.
- **The chat remembers which profile it is on.** A hidden session entry records the profile, written
  with every switch, never LLM context, drawing no row. A chat with none goes by the profile it started
  on, else its helper pick (a library profile), else Off; a helpers-only switch (the Overseer's
  `subagent_profile`, `/mode subagents`) first records the profile the chat is on, so its name stays.
- **Across backends.** A switch between a Claude Code model and another backend's (an OpenAI Codex
  model, a pi model) continues the same conversation on the new model, either way.
- **The same profile again.** Picking the chat's own profile while it reads "(edited)"
  (§chat.profiles/edited) puts back the profile's model and effort; otherwise it changes nothing.
- **Refused** as a mode switch is: a TUI-live session, a session another program wrote, the
  Overseer's own chat and Sova's special sessions. A refusal changes nothing.

## §chat.profiles/edited — A chat whose model was changed by hand

A chat is on a profile once it started on one or switched to one. Choosing another model for it in
the composer (§chat/model-menu), or the Overseer setting one, keeps that profile picked and marks it
edited: wherever the chat's profile is named (the mode menu's Profile row and Delegate's detail line,
§chat.subagent-profiles/menu) it reads "{name} (edited)", for example "Claude (edited)".

- **When it reads so.** While the model the chat runs is not the one its profile sets. Choosing the
  profile's model again, or picking the profile again (§chat.profiles/switch), clears it.
- **Only the chat's own model.** A composer pick changes no helper: they stay the profile's.
- **The limit row judges what runs.** After a usage limit, the row reads the model the chat is
  actually running, never the profile's (§chat.subagent-profiles/limit-row).
- **The chat's own.** An edit never changes the profile, another chat or this computer's default
  (§chat.profiles/default).

## §chat.profiles/default — One default per computer

Each computer has one default profile, and it decides everything a new chat starts with: its When a
Chat Starts part and its Models part. It replaces the three separate defaults: the saved default
modes, the new-session model and effort, and the default subagent profile.

- **Choosing it.** **Make Default** in Settings → Profiles (§app.settings-dialog/profile-editor), or
  **Make {name} the Default** in a chat's mode menu (§chat.subagent-profiles/menu). Off can be the
  default. The default carries a **Default** chip wherever profiles are listed.
- **New chats start on it.** A new chat's empty screen opens with it picked and its card checked
  (§chat.profiles/picker), under a muted line "New chat in {project}. The default is already
  picked." ("New chat. The default is already picked." outside a project); picking another card
  never changes the default. So does every chat Sova starts with no profile named: New Session, a
  project's coding sessions (§app.project-overseer/coding-mode), a start on a target (by the same
  rule as one in a folder) and an Overseer's start that names none, or names only `subagent_profile`, whose helpers then win over the default's.
- **It keeps the older defaults written.** Choosing a default also writes what the older files hold,
  for what the profile sets: its starting mode and add-on modes into `mode.json`'s default, its
  model and effort into `defaults.json`, and its helpers' id into `subagent-profiles-default.json`
  (Off writes `off` there and leaves the other two as they are). So pi-config's extensions and an
  older Sova keep reading the default they always did.
- **Nothing else moves it.** A pick, a switch or a model change in a chat, a new chat's composer
  pick included (§chat.model-menu/saved-default), a profile's save and every Overseer call change
  only that chat or that profile.
- **Where it is kept.** `<state root>/default-profile.json`, `{"version": 1, "profile": <id or
  "off">}`, a profile's id as §chat.profiles/joined forms it. It is this computer's own and never
  syncs, as `subagent-profiles-default.json` never did. A missing file is "not chosen yet" (below);
  one naming no profile here reads as Off, saying so where the default is shown.
- **Until you choose one**, the default is the profile the saved default subagent profile names (the
  pair that links it, where one does; Off when it names none), and what that profile doesn't set
  comes from the saved default modes and new-session model, as now. Nothing is rewritten for it.
- **Deleting the default** is refused: make another the default first.

## §chat.profiles/older-devices — Older devices, and going back

- **A device on an older Sova keeps working as it did.** It keeps its Subagents tab and its session
  profiles, reading the same two files, which keep their shapes. A profile saved here shows there as
  a session profile and a subagent profile with one name, linked as before, and what it saves there
  shows here as the joined profile (§chat.profiles/joined).
- **Its defaults.** It reads the older default files, which choosing a default here keeps written
  (§chat.profiles/default).
- **Nothing is deleted or converted.** No profile file is removed, moved or rewritten in a new
  shape, so going back to an older build brings back the Subagents tab and both lists as they are.
- **A saved Members value is kept.** An older device and this Sova both read a profile's retired
  `members` value and write it back unchanged (§chat.subagent-profiles/file), so neither refuses the
  other's list.
