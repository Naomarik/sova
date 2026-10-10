# §chat/mode-menu — Mode menu
> Part of the Sova design spec · [overview](../design/overview.md)

The mode menu is the control in a chat's composer foot that switches that chat's major and minor
modes, picks its subagent profile, and saves them as the default for new sessions.

Owns: the trigger and the menu, how a switch reaches one chat, the mode prompt holding across turn
starters and minor toggles, and which minor modes reach workers. Not here: the profiles and their
routing (§chat/subagent-profiles, §app/settings-dialog), what align does (§chat/alignment), and the
Overseer's Quick Actions in this slot (§app.overseer/quick-actions).

pi's mode extension (`pi-config/extensions/mode`) has one **major mode**, `normal` or
`delegate`, and any set of **minor modes** (today `align`, `spec`, `vis`, which teaches the inline
visuals of §chat.markdown/visuals, `codemode`, §chat.mode-menu/codemode, and `memory`, §chat/memory).
Every chat with the extension offers all of them, in that order, except that only Sova's own mode menu
turns `memory` on (§chat.memory/where). What Delegate routes where is
Settings → Subagents (§app/settings-dialog), through this chat's subagent profile
(§chat/subagent-profiles). The menu always offers its Subagents picker, in either major mode.

Both are **per session**: each chat keeps its own, persisted in that session's own `mode`
entries. The menu switches them from the chat's composer, and the switch reaches **that chat
only**, **from its next message**. You never start a new chat or reconnect, and no other chat or
terminal session moves.

`~/.pi/agent/mode.json` is the **default for new sessions** (plus the shortcuts). A session that
has never toggled follows it; the first toggle pins that session. A session Sova starts with a
mode of its own (a project's coding session, §app.project-overseer/coding-mode, or one the
Overseer creates with a mode, §app.overseer/tools) is pinned from its start: Sova writes its
`mode` entry before the first prompt, even when it equals the default. `GET /api/mode` reads it and
`POST /api/mode` without `?path=` writes it; neither touches an open chat. From a terminal,
`/mode default` saves the current session's mode as the default.

**A switch never writes the default** — not even in a session that has sent no message yet. The
default moves only when someone asks for exactly that: the menu's **`Save as default`** button
(below), `/mode default` in a terminal, or a `POST /api/mode` with no `?path=`. A new chat is no
longer a side effect of being new: setting one up is not a statement about every chat you start
next, and the state that made it look like one (an empty session) was invisible in the act of
switching.

## §chat.mode-menu/trigger — Trigger

The trigger is a ghost button that names this chat's modes and opens the menu.

In chat sessions it sits in the composer foot (§chat/composer), at the right end: the foot reads the model
indicator, the disabled reason, then this. It's in reach of the message it affects, next to the
model and thinking level that also shape the next turn. A watched (TUI) session has no composer
foot to show it in, and nothing to show anyway: the TUI keeps its mode in memory, so we can't say
what it's using. The session head's right side keeps the context readout, the remote and `TUI`
chips and the info button (§chat/context-window); it carries no mode.

The Overseer is the one chat without it: it is always in the normal mode with no minor modes
(§app.overseer/hosting), so there is nothing to switch, and its **Quick Actions** button takes
this slot (§app.overseer/quick-actions).

```html
<button class="button button-ghost mode-trigger" type="button" aria-haspopup="menu"
        aria-expanded="false" aria-controls="mode-menu"
        aria-label="Mode: delegate · align" title="Mode: delegate · align">
  <span class="icon icon-sm" style="--icon: url(/icons/sliders.svg)" aria-hidden="true"></span>
  <span class="mode-trigger-label">delegate</span>
  <span class="mode-trigger-label mode-trigger-minor">· align</span>   <!-- only with a minor on -->
  <span class="icon icon-sm" style="--icon: url(/icons/chevron-down.svg)" aria-hidden="true"></span>
</button>
```

- **Label.** This chat's major mode, then each minor mode on, joined with " · ", in mono. It has
  no fixed cap: whatever fits reads in full, with the full text in `title` either way. Only real
  pressure in the foot shrinks it, and it shares that squeeze with the model indicator's 24ch cap
  beside it. The minors are their own span, so they ellipsize first and the major mode last.
  Until this chat's mode is known it reads just "Mode" and no row is checked: the default is not
  this chat's state. It is known once the chat's `mode` message arrives, and before that from the
  session list's row for a chat the server holds, or from what this tab last saw of the chat
  (§chat.composer/known-on-switch). The list's row says how a switch applies, as the message
  does; a mode known only from what this tab last saw makes no promise about when a switch applies.
- **Name.** `aria-label` repeats the label with "Mode: " in front, so it survives when the label
  hides. A pending switch adds ", applies after this turn".
- **Every width.** It never hides and never goes icon-only: the label is the fact. It narrows the
  way the model id beside it does — at 320px the minor modes shrink to an ellipsis first, then the
  major mode, and the row never grows wider than the composer. The icons, the padding and the
  `title` stay. In the foot it takes the model indicator's scale: a `--control-sm` row with a
  `--tap-min` target stretched over it by a `::after`, mirrored to the right edge.

## §chat.mode-menu/menu — Menu

The menu is a popover above the trigger with the major modes, the minor modes and the Subagents
picker, and a foot whose button saves this chat's modes as the default.

It uses the model menu's popover shell (`.model-menu`): a `[popover="auto"]` right-aligned
**above** the trigger (the composer is pinned to the pane's bottom edge, so it grows upward, like
the composer flyout), and a bottom sheet under 768px. The list inside is an ARIA **menu**. A listbox
doesn't fit the main panel: it mixes one exclusive choice with independent toggles and a
Subagents action. The Subagents action opens a searchable profile-picker panel in the same
popover (§chat.subagent-profiles/menu), with Off first and the current profile checked.

```html
<div class="model-menu mode-menu" id="mode-popover" popover="auto">
  <div class="banner banner-info" role="status">…Applies after this turn.…</div>   <!-- only then -->
  <div class="model-menu-list" role="menu" id="mode-menu" aria-label="Mode">
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-major">
      <div class="list-group-label" id="mode-group-major">Major mode</div>
      <div class="popover-item popover-item-detail popover-item-mono" role="menuitemradio" aria-checked="false" tabindex="-1">
        <span class="icon icon-sm popover-item-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="popover-item-text"><span class="popover-item-label">normal</span>
          <span class="popover-item-desc">Pi as usual</span></span>
      </div>
      <div class="mode-menu-row" role="none">
        <div class="popover-item popover-item-detail popover-item-mono" role="menuitemradio" aria-checked="true" tabindex="0">…delegate…</div>
        <button type="button" class="button button-ghost button-icon mode-menu-gear" role="menuitem"
          tabindex="-1" aria-label="Configure Delegate" title="Configure Delegate">
          <span class="icon icon-sm" style="--icon: url(/icons/settings.svg)" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-minor">
      <div class="list-group-label" id="mode-group-minor">Minor modes</div>
      <div class="popover-item popover-item-detail popover-item-mono" role="menuitemcheckbox" aria-checked="true" tabindex="-1">…align…</div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-subagents">
      <div class="list-group-label" id="mode-group-subagents">Subagents</div>
      <div class="popover-item" role="menuitem" aria-haspopup="true" tabindex="-1">…worker… Subagents · My setup …chevron-right…</div>
    </div>
  </div>
  <div class="mode-menu-foot">
    <p class="mode-menu-foot-line"><span class="text-mono">strict: off</span> · A switch here is this
      chat's own. New sessions start from the default.</p>
    <button type="button" class="button button-ghost button-sm mode-menu-save">Save as default</button>
  </div>
</div>
```

- **`Save as default`** is the menu's one write of the default. Pressing it makes **this chat's**
  major mode, strict flag, minor modes and effective subagent profile what new sessions start from
  (`POST /api/mode?path=… { saveDefault: true }`). `/mode default` in a terminal still saves only
  the three mode fields; the web button also writes this device's subagent profile default. The request
  carries no mode or profile of its own — the server takes this chat's current state. The write re-reads the file first,
  so `mode.json`'s shortcuts and anything else in it are kept, and the mode extension reads it at
  each `session_start`: the next session, TUI or Sova, starts on it.
- **What it moves, and when.** This chat keeps what it is on; pinned chats keep their own picks.
  Chats without a subagent pick follow the new device default from their next turn or team action. But the default is read at each start, so it moves new sessions from their
  next start — and, like any write of the default, a session that has never switched (no mode entry
  on its branch) follows it too from its next start or reopen. "Unchanged" is true now, not
  forever. It stays pressable in a chat that can't switch (`This chat can't switch.`): it saves
  the very state the menu is showing.
- **The button states.** `Save as default` when this chat's mode, strict flag, minors or subagent
  profile differ from what new sessions start from; `Already the default` with a check,
  `aria-disabled`, when all four match — a button offering to save what is already saved is the thing this wording exists to rule
  out. What new sessions start from is the FILE's answer (read on every open, or the save's reply),
  never a switch's reply, which is this chat's own mode. The visible label is the accessible name
  (so a voice-control user can say what they see); the `title` adds what the press makes true and
  names the mode: "New sessions will start from delegate · align." While the save is in flight it
  reads `Saving…`, and only then; during a switch it keeps its label and is `aria-disabled`.
  Unknown either side (the file unread, this chat's mode not arrived) is **not** "already the
  default": the button stays pressable. The footer sentence beside it is the same in every state:
  `strict: off|on` — the one flag the menu does not switch — then "A switch here is this chat's
  own. New sessions start from the default."

- **Choosing.** Picking a major mode switches this chat and keeps the menu open: the check moves
  and focus stays on the picked row. Picking the mode already checked does nothing. Toggling a
  minor mode keeps the menu open too, with focus on the toggled row, so you can set several. Once
  a pick or toggle settles, saved or failed, focus is on that row even if the rows re-rendered. While the switch is saving, the rows
  are `aria-disabled`. A switch that fails shows its error banner in place, in the open menu, and
  the mode is unchanged. The menu closes on Configure Delegate or the spec gear, an outside click,
  `Esc`, or `Tab` out of it.
- **Configure Delegate** is an icon-only gear at the right end of Delegate's row: a real
  `button` with `role="menuitem"`, a sibling of the `menuitemradio` (never nested in it) inside a
  `role="none"` wrapper, with a `--tap-min` target. It comes right after Delegate in the same
  roving focus. It closes the menu and opens Settings at **Subagents** (§app/settings-dialog),
  where this chat's routing is edited. The spec gear opens the same tab at its spec-writer section.
  Delegate's detail line reads "Profile: <name>". It switches nothing: this chat's mode stays what it was, and it's there in either mode,
  so you can set Delegate up before turning it on. Clicking the rest of the row still picks
  Delegate.
- **Checked.** A checked row gets `--color-accent-tint` and the check. The words carry the state
  too, since `aria-checked` is announced.
- **strict** is shown read-only in the foot, for this chat. Change it in a terminal with
  `/mode strict on|off`; that is per session too.
- **Keyboard.** Roving `tabindex`, with real focus on the rows, so the standard focus ring shows.
  - On open, focus goes to the checked major mode.
  - `↑` / `↓` move and wrap. `Home` / `End` jump.
  - `Enter` or `Space` chooses or toggles.
  - `Esc` closes (native) and focus returns to the trigger.
  - `Tab` from a row goes to the footer's `Save as default`, a real button and a tab stop inside
    the menu (still reachable when `aria-disabled`); `Tab` from there leaves the menu, which closes
    it and moves on. Keys pressed on the button are the button's own: `Enter` or `Space` presses
    it, never whichever row was last focused, and the arrows do not move the rows from there.
- **Motion.** The same single fade as §chat/model-menu.

## §chat.mode-menu/how-a-switch-reaches-the-chat — How a switch reaches the chat

`POST /api/mode?path=<session>` switches exactly the chat that file belongs to; it must be one
this server holds open (404 otherwise), and `mode.json` is not written. The chat then:

- **Calls the extension's own `/mode` handler** directly. That's the same code the terminal runs,
  so it leaves the same **marker** ("Mode → delegate", "Minor mode: align on", "Strict mode
  on/off") plus the snapshot the extension restores from. The marker renders nothing in the
  thread (§chat.transcript/transcript-items); its history is visible on the Session pane's
  Changes disclosure and the Timeline's change markers (§chat.timeline/rows). The command text
  never goes to the model. There's no reload, so the chat's subagent workers keep running. A chat
  that was never prompted takes the same path (the marker is a deliberate user write).
- **Mid-turn.** The running turn keeps the old mode, and so do messages queued during it
  (follow-ups and steers join that turn). The chat's menu shows an info banner, "Applies after
  this turn.", until the turn settles.
- **Can't switch.** If the mode extension isn't loaded in that chat, or another program wrote the
  session, the chat isn't touched. Its menu shows a warn banner, "This chat can't switch." Only
  the default applies then.

`Save as default` takes both this chat's mode state and its effective subagent profile. The
server writes the device's profile default first, then `mode.json`; there is no cross-file
transaction. A profile-default failure leaves the mode default untouched; a later mode-write
failure reports that the profile default already changed. An unusable library refuses the save.

It is the same route with `{ saveDefault: true }`, and its refusals are of the
same kind: no `?path=` is a 400 ("saveDefault needs ?path=: it saves that chat's own mode") — the
save takes a chat's own mode, so there has to be a chat, never a write of whatever the file
already says; a body that also names `mode` or `minorModes` (or a `saveDefault` that isn't `true`)
is a 400, because the save takes the chat's state, never the body's fields; and a session this
server doesn't hold open is a 404.

**Where a chat's mode comes from when it opens.** `bind()` resolves it once, with the extension's
own rule (`resolveChatMode`, `restoreActive` from pi-config `state.ts`): the newest `mode` entry
on the branch that carries a snapshot wins, otherwise the default from `mode.json`. Server and
extension therefore always agree, including after a server restart. Nothing is broadcast to other
chats, and nothing watches `mode.json`.

## §chat.mode-menu/prompt-holds-across-turn-starters — The mode prompt holds whoever starts the turn

A chat's system prompt is the same whether its turn was started by the user's message or by an
extension's message: a subagent settling (`subagent-complete`), a team question, an Overseer
wake-up. In particular the mode extension's `<mode>` section (delegate instructions, minor-mode
biases) is neither dropped nor re-added because of *who* started the turn; it changes only when
the major mode, Delegate routing, a spec-writer route already present in the prompt head, or align
while in delegate changes, and at the first run after a compaction. Spec-writer routing introduced
by a mode note is refreshed by another note instead of rewriting that head. Any other minor-mode
toggle leaves it alone
(§chat.mode-menu/minor-toggle-keeps-prompt).

Why this needs saying: pi builds a user turn's prompt in `before_agent_start`, where the mode
extension writes its block into that turn's prompt sections. A turn an extension's message starts
(`sendMessage(…, {triggerTurn: true})`) skips that hook, and pi's own refresh before the turn's
second request rebuilds the prompt from the session's **base** prompt options, which know nothing
of extension sections. Left alone, that patched the section out mid-turn (`mode: null` in the
transcript) and back in at the next user prompt — two prompt versions about 3.5K tokens apart —
and the claude-code bridge, which restarts its CLI on any prompt change
(§app.worker-restore/claude-bridge-restart), re-sent the whole conversation at every switch: in
one team session, 22 restarts of up to 220K tokens each.

The rule is kept by the mode extension, not the bridge (the bridge cannot change a running CLI's
prompt, and must not guess which prompt changes are benign): it also keeps its block in pi's base
options, so a turn built without `before_agent_start` reads the same prompt. Those options are
reachable only through a command context (`ctx.getSystemPromptOptions`): every `/mode` and
`/align` call adopts the getter. Every time Sova opens a chat (`bind()`, a first open and every
reopen, including after a server restart) it runs the extension's own handler with
**`/mode sync`**, an argument that switches nothing, writes no entry, shows no notice and leaves
the status alone: it only adopts the getter and puts the session's already-restored mode block
into the base. So every Sova chat has it before its first turn, whether or not it is ever
switched — a chat whose mode is pinned and never touched in this runtime included — and from then
on every switch, every `before_agent_start` and every run start (`agent_start`, after pi may have
rebuilt the base on a tool change) writes the current block there, or deletes it when no mode
block applies. Nothing is written, so it runs on a terminal-live or foreign-written session too.
A getter whose extension runner was replaced is dropped, never retried. A terminal session driven
only by the shortcut or the palette, with no `/mode` or `/align` yet, keeps the old behaviour
until one runs (`/mode sync` there fixes it too).

Observable: in a chat with a mode on, a turn started by a worker settling that calls a tool has
no `mode: null` system entry after its tool result, and the bridge does not restart on it; the
prompt the provider receives is byte-identical to the previous user turn's. With the mode
unchanged, the session carries one `mode` section for its whole life: no system entry patches it,
on the first turn, on later turns, or after the chat is reopened.

## §chat.mode-menu/minor-toggle-keeps-prompt — A minor toggle keeps the cached prompt

Turning a minor mode (`align`, `spec`, `vis`, `codemode`, `memory`) on or off mid-session never rewrites the
prompt the model already has, on any provider; the one exception is align while in Delegate, whose
bridge paragraph in the Delegate block follows the active align. The `<mode>` section's minor blocks stay those of the **head**:
the minor modes the first run after the session's start, or after its last compaction, was built
with. Only models that take mid-conversation system messages could absorb a changed section as a
cheap tail patch; everywhere else (every model without pi's `supportsMidConvoSystemMessages`) pi
folds it into a new head, and the claude-code bridge restarts its CLI
(§app.worker-restore/claude-bridge-restart), so one toggle re-sent the whole conversation uncached
(measured: 53K–180K tokens per toggle).

The tool list is another matter: turning `vis`, `align` or `codemode` on or off does change the
active tools (`vis` adds or removes `vis_guide`, and in Sova's hosted sessions `vis_check` with it,
unless align with the chat's Visuals still wants them, §chat.alignment/visuals; `align` its `align`
tool, and with Visuals on the vis tools too; `codemode` its `codemode` tool, §chat.mode-menu/codemode), while the
system prompt stays as it was (none of them adds a line to it). That is one tool-set change per
toggle; in the plain TUI, where `vis` used to change no tool, it costs a prompt-cache rebuild.
`codemode` has no block, so no note tells the model about it either: its tool is the whole switch.

Instead the switch reaches the model as a **hidden note**, one path for every provider: a
`mode-note` custom message (`display: false`, so neither the TUI nor Sova's transcript shows it)
at the switch's next run — beside the user's prompt, or, in a run an extension's message starts (a
worker's report), steered in ahead of its first request. A run already under way keeps its mode to
its end (§chat.mode-menu/how-a-switch-reaches-the-chat). Switches made between two runs are told
once, as their net change.

- **Turning a mode on** carries that mode's whole block, the text the head would have had (for
  `spec`, with its writer paragraph), unless the block is already in context — in the head, or in an
  earlier note since the last compaction — when the note points back to it instead.
- **Turning a mode off** says the mode is off and its earlier instructions no longer apply.
- **Align writing style.** A change of the align writing style while align is on reaches the next
  run in one hidden note of its own, the same way, even though no minor mode switched
  (§chat.alignment/style); the align block in the head is never rewritten for it.
- **Spec-writer routing.** If spec was enabled by a note rather than included in the head, a later
  change to its configured writer reaches the next run in a new hidden note, even though the set
  of active minor modes did not change. It supersedes the earlier route without resending the
  whole spec guide. A worker-wake run refreshes it too. Clearing the writer explicitly returns
  drafting to the session; the status and the model's instructions must not silently disagree.
- **Reopen.** The head is persisted additively in the session's `mode` entries (`head`, recorded
  while it differs from that entry's `active.minorModes`; entries Sova writes with `pinEntryFor`
  never carry it) and each note's details record what the model was told. A reopened session, after
  a server restart included, rebuilds the head it started with, replays its notes from history, and
  tells the model any switch it had not heard of yet.
- **Compaction.** The cached prefix is gone anyway: the next run rebuilds the head from the modes
  active then, sends no note for them, and drops from its requests any older note the compaction
  kept in its recent tail, so no guide reaches the model twice.

`memory` has no block and no note either: its guide rides its own view message, and what its switch
changes is the history every request sends from the next turn on (§chat.memory/turn), plus its `zoom`
and `date` tools.

Not covered: `align`, `vis` and `codemode` also add or remove their tools, and a tool-set change
breaks the cached prefix on every provider and restarts the claude-code CLI, note or not. A
major-mode switch still changes the section, as before.

Observable: toggling `spec` in a chat on the claude-code provider starts no new CLI (no "restarted"
fold) and the next request's cache read covers the previous context; on any provider the session
records no system entry for a minor toggle (align in Delegate aside), and the provider's system prompt is byte-identical
before and after it. The model draws `vis` fences after turning vis on and none after turning it
off.

## §chat.mode-menu/workers — What a chat's workers get of its modes

Of its parent chat's modes, a worker gets only the minor modes that declare they reach workers
(today `spec`), as they are when it starts or resumes.

A worker is not a chat: it has no mode menu, and its parent's major mode never reaches it
(workers spawn no workers, so Delegate has nothing to route there). Each **minor mode declares
whether it reaches workers** (`MINOR_WORKER` in `pi-config/extensions/mode/minor.ts`, a record
over every minor mode, so a new one cannot be added without deciding): `spec` does; `align`
does not (aligning is a conversation with the user, which a worker doesn't have), nor does `vis`
(its visuals are for the user, and a worker's replies are read by its parent session), nor does
`codemode` (it changes the chat's own tool set, and a worker's tools are its brief's), nor does `memory`
(it is the chat's own memory of its conversation; a worker starts fresh from its brief, and its report
enters the parent's memory like any other message).

- **What a worker gets.** While the parent chat has spec on, every worker it starts — pi or
  Claude Code, plain, remote, sandboxed, hosted, or a team member — gets the spec block
  (`spec-mode.md`, byte for byte) at the end of its system prompt, after its agent type, its
  brief and any remote instructions, followed by a short **worker note**: the brief is its
  go-ahead; it works in the draft its brief names (or says which it started); it doesn't promote,
  commit or record `--commit` evidence unless the brief says so — the parent promotes; and its final
  report lists each foreign § it updated. Nothing else of the parent's mode reaches it: no
  Delegate block, no align block, no Delegate+align bridge, and never the spec-writer paragraph
  (a worker can't spawn one). With spec off the worker's prompt carries nothing from the mode.
- **Not everyone.** A team's monitor (it has no tools) gets no spec block. A worker on its
  worktree's own agent dir (§chat.worktrees/worktree-config) gets none from the parent either: its
  tree's own mode extension gives it spec, always on, in its worker form (the same block and note,
  no writer paragraph).
- **A snapshot, taken at spawn.** The worker gets the modes the parent has when it starts; a
  later switch in the chat doesn't reach a running worker (§chat.mode-menu/how-a-switch-reaches-the-chat:
  there is no reload). A resumed worker takes the parent's **current** worker modes, exactly as at
  spawn (§app.worker-restore/resume), not the ones it first started with.
- **The card says so.** What a worker was given is recorded with it (its live record and its
  durable record) and shown on its view head (§app.subagents-pane/transcript-view) as
  a quiet chip on its title row reading the mode names (`spec`; several comma-joined), beside
  its status chip. A worker given none, and one recorded by an
  older pi-config, shows nothing.

The parent learns nothing new: the mode extension publishes the parent's worker modes and the
worker prompt on the extension bus (`mode:worker`), the way the sandbox publishes its state
(§chat.sandbox/workers), and the subagents extension appends that text at spawn without
interpreting it. A parent without the mode extension publishes nothing, and its workers get
nothing.

## §chat.mode-menu/codemode — codemode: scripts that call the chat's tools

The `codemode` minor mode gives the model pi's `codemode` tool: a JavaScript script that calls the
chat's other tools, several at once, and filters their output before the model reads it.

- **The tool is the whole mode.** On, `codemode` is in the chat's tool set; off, it is nowhere in
  it, even when something else had turned it on (the default tools, a restored transcript's tool
  set). The one exception: while a tool only scripts can reach is registered (an MCP tool with
  `codemode` or `deferred` exposure), turning the mode off leaves `codemode` in, since that tool has
  no other way in. The mode has no prompt block and no hidden mode note, on or off: the tool's own
  description is its guide (`MINOR_PROMPTLESS` in `pi-config/extensions/mode/minor.ts`).
- **When it applies.** A switch made between runs puts the tool in or takes it out at once; a switch
  during a run applies when that run settles, and the run under way keeps its tools
  (§chat.mode-menu/how-a-switch-reaches-the-chat). A reopened chat comes back with the tool as its
  `mode` entry says. A toggle is a tool-set change, so, like align's tool, it costs the cached prompt
  prefix and restarts a Claude Code chat's CLI (§chat.mode-menu/minor-toggle-keeps-prompt).
- **Where.** pi's built-in extensions load only in its CLI, so a terminal session has pi's own
  tool, while Sova adds it to every ordinary chat it runs, registered inactive
  (`server/harness/pi/codemode.ts`, in the chat manager's default extension factories). A Claude
  Code chat is like any other: off, no tool and no prompt line mentions it; on, it is declared from
  the next run. The special loadouts (the Overseer, organizations, baton) don't load it, and where
  the tool isn't registered the mode changes nothing.
- **Workers never get it** (`MINOR_WORKER`): a worker's tools are its brief's
  (§chat.mode-menu/workers).
- **What a script can call.** The chat's tools, except the ones declared **model-only**: a tool
  whose state Sova reads back from its own recorded result (the `align` tool, spawning a worker,
  creating a team, sending to another session, the Overseer's cards) is offered to the model but is
  never callable from a script. A script's model calls (`models.classify`,
  `models.generateImages`) go through this device's model policy, which refuses a turned-off model
  ("<provider/id> is turned off in this device's model policy (Settings → Models).") without
  calling it; each call that runs holds one of the provider's request slots and is recorded as the
  chat's own usage.
- **What the chat shows.** The calls a script makes write no transcript entries of their own: the
  script's result keeps them, and its tool card shows the script (with **Copy Script**) and each
  call it made with its status (Running, Done, Failed, Cancelled), live while it runs, then its
  output.
- **With spec on**, a `[spec census]` or spec-guard note about a call the script made is repeated on
  the script's own result, the one the model reads (§tools.spec/census-note).

## §chat.mode-menu/strict — strict: Delegate without edit and write

`strict` is a per-session flag that, while the chat is in Delegate, takes the `edit` and `write`
tools away from the orchestrator.

- **Only those two.** `bash` and every other tool stay, and the Delegate instructions read the same
  with strict on or off: the prompt never mentions it. The tools the chat had before are kept and
  come back when strict goes off or the chat leaves Delegate.
- **In the normal mode** the flag is kept and does nothing; switching to Delegate applies it, and a
  session restored in Delegate with strict on applies it on open.
- **Setting it.** `/mode strict on|off`, per session like the rest of the mode, with a transcript
  marker ("Strict mode on" / "Strict mode off") and a notice that adds "(edit/write removed from the
  orchestrator)" or "(edit/write restored to the orchestrator)" when it applied at once. It is off
  by default; `mode.json`'s `strict` sets what new sessions start with, and `/mode default` or the
  menu's `Save as default` saves this chat's flag there. There is no launch flag for it.
- **Shown.** The terminal's status line adds `strict` after `delegate` (only in Delegate). The web
  mode menu shows it read-only in its foot (`strict: off|on`, §chat.mode-menu/menu); the trigger's
  label never names it.
- **Sova never sets it.** A switch from the menu can't carry it, the Overseer leaves it as it is
  (§app.overseer/hosting), and a project's coding sessions never set or offer it
  (§app.project-overseer/coding-mode). A worker is never strict.

## §chat.mode-menu/terminal — From a terminal

In a pi terminal session the same per-session mode is switched with `/mode`, a palette category,
shortcuts and launch flags. Sova's menu runs the same `/mode` handler
(§chat.mode-menu/how-a-switch-reaches-the-chat), so a switch either way leaves the same marker.

- **Bare `/mode`** opens the command palette (`ctrl+p`) at its **Mode** category: `normal` and
  `delegate` (the current one checked; Enter switches and closes), one row per minor mode with its
  description and an on/off marker (Enter toggles it and the palette stays open; `memory`, which only
Sova's menu turns on, has no row), **align: open
  viewer**, and **save as default** last. Without a palette to open (outside the TUI, or the palette
  extension not loaded) it shows the status and the usage line instead; it never toggles anything.
- **`/mode normal`**, **`/mode delegate`** switch the major mode. **`/mode <minor>`** toggles that
  minor mode and **`/mode <minor> on|off`** sets it; `/align on|off` does the same for align.
  `/mode memory on` is refused with "memory is turned on from a Sova chat's mode menu"
  (§chat.memory/where); `/mode memory off` works.
- **`/mode status`** lists this session's mode, the default for new sessions, its subagent profile
  and where that came from, the Delegate routing, the spec writer, strict, the minor modes, the
  toggle shortcut, the alignments and the state file.
- **`/mode default`** saves this session's mode, strict flag and minor modes as the default, the
  only command that writes `mode.json`; **`/mode strict on|off`** (§chat.mode-menu/strict);
  **`/mode subagents <id|off>`** pins this chat's subagent profile, by id or name; `/mode sync`
  changes nothing visible (§chat.mode-menu/prompt-holds-across-turn-starters). Any other argument
  is answered with the usage line.
- **Shortcuts.** `alt+m` toggles normal and Delegate (`mode.json` `shortcut` changes the key, from
  the next reload); `minorShortcuts` binds a key per minor mode (none by default); `alt+a`
  (`viewerShortcut`) opens the alignments viewer.
- **Launch flags.** `pi --major delegate` and `pi --minor align,spec` (`none` for no minor modes)
  start a new session in that mode on top of the default and are written nowhere; a session's own
  saved mode wins over them, and an unknown minor name is warned about, as is `memory` (dropped: web only).
  `minorShortcuts` binds no key to `memory`.
- **The status line** in the TUI's footer reads the mode, then in Delegate `fallback:<profiles>`,
  `ask:<profiles>` and `strict`, then each minor mode on, then `writer:fallback` or `writer:ask`
  while spec's writer is off its primary route: dim in normal with no minor mode, accent otherwise,
  warning when a route has fallen back or has none.

## §chat.mode-menu/states — States

What the trigger and the menu show in each state, from a mode not known yet to a failed save.

| State | Shows |
|---|---|
| Idle | Trigger label, and this chat's rows checked |
| Mode not known yet (no `mode` message, nothing in the list's row, nothing this tab saw) | Trigger reads "Mode", nothing checked (the default isn't this chat's state) |
| Known before the `mode` message (§chat.composer/known-on-switch) | Trigger label and rows checked as Idle; from the list's row, the name and banners follow how it says a switch applies; from what this tab last saw, no "applies after this turn" in the name and neither switch banner until the message says |
| Saving | Rows `aria-disabled` (the cursor is `progress`) |
| Mid-turn switch | Info banner "Applies after this turn." (trigger name adds it too) |
| Chat can't switch | Warn banner "This chat can't switch." |
| Switch failed | Error banner "Couldn't switch the mode." with the reason. The mode is unchanged |
| Saving the default | `Save as default` reads `Saving…`, `aria-disabled` — only the save does this; a switch keeps the label |
| Default save failed | Error banner "Couldn't save the default." with the reason. The mode is unchanged |
| Already the default | `Already the default` with the check, `aria-disabled` |
| Load failed | Error banner "Couldn't load the modes." |

## §chat.mode-menu/tokens — Tokens

The tokens the trigger, the menu's rows and its foot are drawn with.

Trigger: `--font-mono`, `--fs-mono`, `--color-ink-2`, sunken fill while open, icons
`--color-ink-muted`. Rows (`.popover-item`, §design/menu-rows): `--control-md` min height, `--space-3` at the
sides and `--space-2` above and below a mode row, id in `--font-mono` `--color-ink`, description `--fs-caption` `--color-ink-muted`,
checked `--color-accent-tint`, focus `--focus-ring` inset. A mode row's check sits on its id's line, the
first of its two; the one-line Subagents row's icon, label and chevron sit on the row's centre line. Foot: `--fs-caption`
`--color-ink-muted` over a `--color-border` rule.

## §chat.mode-menu/rejected — Rejected

Other places for the switch, and other ways for it to reach a chat, that were turned down, each with
why.

- **A segmented control in the composer.** It reads as a per-message option, not a per-chat
  one, and every mode as a segment costs composer width at 320px. The menu trigger that sits in
  the foot now is one control whose label shrinks, so it fits.
- **The session head.** Where the trigger used to sit, after the context gauge. It was the head's
  one menu trigger, went icon-only under 520px and vanished under 360px, and it was a screen away
  from the composer whose next message it changes.
- **A settings page.** That's not first-class, and it's far from the chat it affects.
- **`/mode` only.** It works today (the slash menu lists it), but nobody finds it, and it can't
  show the current mode.
- **Reloading the chat.** A runtime reload stops that chat's subagent workers, which would end
  delegate teams mid-task.
- **Fanning a switch out to every open chat** (what this used to do, through `mode.json` and a
  file watcher). One chat's mode is not another's: it moved terminals and tabs nobody asked to
  move. The file is now only the default.

---

