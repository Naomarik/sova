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
turns `memory` on (§chat.memory/where). A chat in a project's checkout also offers that project's
own minor modes, from its `.sova/minor-modes/` folder (§chat.mode-menu/project-modes); none is ever on
until someone turns it on in that chat. What Delegate routes where is
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
`POST /api/mode` without `?path=` writes it (one naming `projectModes` is a 400: no default holds
them); neither touches an open chat. From a terminal,
`/mode default` saves the current session's mode as the default.

**A switch never writes the default** — not even in a session that has sent no message yet. The
default moves only when someone asks for exactly that: the menu's **`Save as default`** button
(below), `/mode default` in a terminal, or a `POST /api/mode` with no `?path=`. A new chat is no
longer a side effect of being new: setting one up is not a statement about every chat you start
next, and the state that made it look like one (an empty session) was invisible in the act of
switching.

## §chat.mode-menu/trigger — Trigger

The trigger is a ghost button that shows this chat's modes as icons and opens the menu.

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
        aria-label="Mode: delegate · align · deploy-notes" title="Mode: delegate · align · deploy-notes">
  <span class="icon icon-sm" style="--icon: url(/icons/mode-delegate.svg)" aria-hidden="true"></span>  <!-- the major mode; normal: sliders -->
  <span class="icon icon-sm" style="--icon: url(/icons/mode-align.svg)" aria-hidden="true"></span>     <!-- one per minor mode on -->
  <span class="mode-letter" aria-hidden="true">D</span>                                                 <!-- one per project mode on -->
  <span class="mode-more" aria-hidden="true">+2</span>                                                <!-- the others' count: drawn only while folded -->
  <span class="mode-trigger-label" aria-hidden="true">delegate · align · deploy-notes</span>         <!-- in the foot: only at a composer 620px or wider -->
  <span class="icon icon-sm" style="--icon: url(/icons/chevron-down.svg)" aria-hidden="true"></span> <!-- kept: it opens a menu -->
</button>
```

- **Icons.** One icon for the major mode (normal adds none of its own: the sliders icon stands for
  it), then one icon for each built-in minor mode on (align, spec, vis, codemode, memory), then, for
  each project mode on (§chat.mode-menu/project-modes), its id's first letter or digit, upper
  case, in a rounded square drawn like an icon. The chevron-down stays last, at every width: the
  button opens a menu. Until this chat's mode is known it shows the sliders icon alone. The menu's
  rows carry the same icons beside their names, so the menu is the legend (§chat.mode-menu/menu).
- **Label.** This chat's major mode, then each minor mode on, then each project mode on, joined
  with " · ", in mono. In the composer foot it shows beside the icons only where the composer is
  at least 620px wide; the full text is in `title` and the accessible name either way. The minors ellipsize first and the major mode last, and the
  words go before any icon does.
  Until this chat's mode is known it reads just "Mode" and no row is checked: the default is not
  this chat's state. It is known once the chat's `mode` message arrives, and before that from the
  session list's row for a chat the server holds, or from what this tab last saw of the chat
  (§chat.composer/known-on-switch). The list's row says how a switch applies, as the message
  does; a mode known only from what this tab last saw makes no promise about when a switch applies.
- **Name.** `aria-label` repeats the label with "Mode: " in front, so it survives when the label
  hides. A pending switch adds ", applies after this turn".
- **Every width.** It never hides, and it is icon-first: the icons are the fact, and the words
  are extra where there's room. Under a 620px composer, at 320px too, it is the icons and the
  chevron alone and the row never grows wider than the composer. The icons, the padding, the accessible name and the desktop `title` stay. In the
  foot it takes the model indicator's scale: a `--control-sm` row with a
  `--tap-min` target stretched over it by a `::after`, mirrored to the right edge.
- **Fold.** Where the foot is still too tight once its gaps narrow (§chat.composer/behavior), and
  the trigger draws at least two mode icons, the mode icons fold, before the model's short name
  loses a letter: the first icon (the major mode's) stays, followed by "+{n}", the count of the
  other mode icons (minor and project modes alike, e.g. "+3"), then the chevron. With one icon
  (or before the mode is known) there is nothing to fold, and the name is what gives. Under a
  620px composer the trigger never clips its own icons: it gives way only by folding. Whether it
  folds is decided from the unfolded foot, measured with every icon out before the frame is
  drawn, so it never flickers and the same width always gives the same foot; it unfolds when the
  room comes back (a wider composer, a shorter name, a mode turned off). A fold hides nothing from
  the words: the accessible name and the desktop `title` keep the full wording, and the menu still
  lists every mode.

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
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-project">   <!-- only with project modes -->
      <div class="list-group-label" id="mode-group-project">This project · acme</div>
      <div class="popover-item popover-item-detail popover-item-mono" role="menuitemcheckbox" aria-checked="false" tabindex="-1">…release-notes… Asks before turning on: it runs 1 tool.…</div>
      <div class="popover-item popover-item-detail popover-item-mono" role="menuitemcheckbox" aria-checked="false" aria-disabled="true" tabindex="-1">…old-style… Can't turn on: …</div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-subagents">
      <div class="list-group-label" id="mode-group-subagents">Subagents</div>
      <div class="popover-item" role="menuitem" aria-haspopup="true" tabindex="-1">…subagents… Subagents · My setup …chevron-right…</div>
    </div>
  </div>
  <div class="mode-menu-foot">
    <p class="mode-menu-foot-line"><span class="text-mono">strict: off</span> · A switch here is this
      chat's own. New sessions start from the default.</p>
    <button type="button" class="button button-ghost button-sm mode-menu-save">Save as default</button>
  </div>
</div>
```

- **Row icons.** Each mode row shows, beside its name, the icon the trigger uses for it: the
  major modes theirs (normal the sliders icon), each built-in minor mode its own, and each project
  mode its letter in a rounded square. The menu doubles as the trigger's legend. The Subagents row
  leads with the subagents icon, branching nodes.
- **This project's modes.** A chat whose checkout has project modes (§chat.mode-menu/project-modes)
  shows them after the minor modes and before Subagents, in their own group labelled "This
  project · {name}" (the checkout's name; "This project" when there is none), one
  `menuitemcheckbox` row each with the id (mono) and the mode file's description, in the same
  roving focus, with no gear, except that a mode that is on and whose hooks wait for your approval
  (it was turned on with an approval that isn't yours: the Overseer's, a script's, a chat agent's or an
  extension's, §chat.mode-menu/project-mode-hooks) has an **Approve Hooks** chevron
  beside its row, which opens the approval panel for its hooks only: Back, "Approve {id}'s hooks?",
  why only you can, one card per hook with when it runs and its command line, and **Approve Hooks**
  and **Cancel**; it switches nothing. The trigger names the project modes that are on after the built-in
  ones ("delegate · spec · deploy-notes"). The rows are read from the checkout each time the menu
  opens and after each switch; a menu already open doesn't follow a change to the files until it is
  opened again. Under the description a row says its state in words,
  never by tint alone (copy in §design.copy-deck/mode-menu): broken (off, `aria-disabled`, can't be
  turned on), removed from the project (on; turning it off removes the row), changed since turned
  on, its files broken now while it is on, asks before turning on (it has tools, commands or hooks not approved), or
  its tools changed since approval (on, its tools won't run), its hooks need your approval (on,
  an approval that isn't yours doesn't cover them), or its hooks are paused (on, a hook ran 10 times in 10
  minutes). Turning on a mode that asks opens the
  **approval panel** in the same popover, like the Memory type panel: Back, "Turn on {id}?", what it
  lets the model do (and, for a mode with commands or hooks, what you and scripts can run and what
  runs after things happen in the chat), one card per tool with its name, description and command
  line, one per command with its `mode.{id}.{name}` id, description and command line, and one per
  hook with when it runs and its command line, where it runs
  from, that the approval covers its tools (or what it runs) and every file in the folder, which bare programs (`node`,
  `python3`, `sh`) are the machine's own and not covered, and **Approve and Turn On** and **Cancel**. Turning a mode off never asks. A chat with no
  project modes has no such group.
- **`Save as default`** is the menu's one write of the default. Pressing it makes **this chat's**
  major mode, strict flag, built-in minor modes and effective subagent profile what new sessions start from
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
  profile differ from what new sessions start from (its project modes never count, on or off, since
  no default holds them); `Already the default` with a check,
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

`POST /api/mode?path=<session>` switches exactly the chat that file belongs to, and `mode.json` is
not written. A chat this server doesn't hold open (one closed for being quiet,
§app.chat-processes/idle-stop) is opened for it, as a send opens it; a session that can't open (a
TUI holds it, its remote placeholder folder is gone) is refused with why (409), and a file that isn't there is a 404.
A switch of a project's coding session whose minor modes leave `spec` out is refused before
anything switches (409, "Spec is always on for coding sessions; it can't be turned off.",
§app.project-overseer/coding-mode). The chat then:

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
- **Project modes** (§chat.mode-menu/project-modes) ride the same route as `projectModes`, the
  whole set to have on, with `approve: [{id, hash}]` for the approval the user just gave. Turning
  on a mode whose tools aren't approved, with no `approve` entry carrying its current fingerprint,
  is a 409 carrying the mode's fresh row (`needsApproval`), and nothing switches; an unknown or
  broken id is a 409 too. Turning one off is always allowed, a removed one included, and modes
  that stay on are never checked again. The approval is recorded before the chat's `/mode
  project:<id> on` runs. `GET /api/mode?path=<session>` returns that chat's mode with its project
  rows read now; the chat's `mode` message carries the same rows, an on mode's from the copy it
  runs, never from the files. A remote chat, the Overseer and Sova's special sessions have none.

`Save as default` takes both this chat's mode state and its effective subagent profile. The
server writes the device's profile default first, then `mode.json`; there is no cross-file
transaction. A profile-default failure leaves the mode default untouched; a later mode-write
failure reports that the profile default already changed. An unusable library refuses the save.

It is the same route with `{ saveDefault: true }`, and its refusals are of the
same kind: no `?path=` is a 400 ("saveDefault needs ?path=: it saves that chat's own mode") — the
save takes a chat's own mode, so there has to be a chat, never a write of whatever the file
already says; a body that also names `mode`, `minorModes` or `projectModes` (or a `saveDefault` that isn't `true`)
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

Turning a minor mode (`align`, `spec`, `vis`, `codemode`, `memory`, or a project's own,
§chat.mode-menu/project-modes) on or off mid-session never rewrites the
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
toggle; in the plain TUI, where `vis` used to change no tool, it costs a prompt-cache rebuild. In an ordinary Sova chat, vis also adds or removes `record_tour` and `show_tour` (§app.tours/authoring): these two require vis itself, so align's Visuals alone never keeps them active. A hand-off's baseline scoped presentation is separate from this ordinary-chat loadout.
`codemode` has no block, so no note tells the model about it either: its tool is the whole switch.
A project mode with tools adds or removes them the same way, one tool-set change per toggle, and
its block still reaches the model as a note, never by rewriting the prompt.

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

Not covered: `align`, `vis`, `codemode` and project modes with tools also add or remove their tools, and a tool-set change
breaks the cached prefix on every provider and restarts the claude-code CLI, note or not. A
major-mode switch still changes the section, as before.

Observable: toggling `spec` in a chat on the claude-code provider starts no new CLI (no "restarted"
fold) and the next request's cache read covers the previous context; on any provider the session
records no system entry for a minor toggle (align in Delegate aside), and the provider's system prompt is byte-identical
before and after it. The model draws `vis` fences after turning vis on and none after turning it
off.

## §chat.mode-menu/workers — What a chat's workers get of its modes

Of its parent chat's modes, a worker gets only the minor modes that declare they reach workers
(today `spec`, and each project mode whose file says `workers: yes`), as they are when it starts or
resumes.

A worker is not a chat: it has no mode menu, and its parent's major mode never reaches it
(workers spawn no workers, so Delegate has nothing to route there). Each **minor mode declares
whether it reaches workers** (`MINOR_WORKER` in `pi-config/extensions/mode/minor.ts`, a record
over every minor mode, so a new one cannot be added without deciding): `spec` does; `align`
does not (aligning is a conversation with the user, which a worker doesn't have), nor does `vis`
(its visuals are for the user, and a worker's replies are read by its parent session), nor does
`codemode` (it changes the chat's own tool set, and a worker's tools are its brief's), nor does `memory`
(it is the chat's own memory of its conversation; a worker starts fresh from its brief, and its report
enters the parent's memory like any other message). A project mode declares it in its own file
(§chat.mode-menu/project-modes), `no` unless it says `yes`; one that reaches workers comes after
spec's block, from the parent's saved copy of it, with its tools when the worker can run commands
(a remote worker gets the block, never the tools), and the worker never reads the project's folder. A worker gets at most 8 modes, built-in and project together.

- **What a worker gets.** While the parent chat has spec on, every worker it starts — pi or
  Claude Code, plain, remote, sandboxed, hosted, or a team member — gets the spec block
  (`spec-mode.md`, byte for byte: the guide's short part) at the end of its system prompt, after its agent type, its
  brief and any remote instructions, followed by a short **worker note**: the brief is its
  go-ahead; it works in the draft its brief names (or says which it started); it promotes, commits
  or records `--commit` evidence only when the brief says so, and then only on the brief's branch,
  never by landing on the default branch — the parent promotes, on its own branch before calling it
  ready; and its final
  report lists each foreign § it updated. The writing procedure reaches a worker that writes code once,
  with its first census note, its Workers section first, in the note's own words
  (§tools.spec/writing-on-demand). Nothing else of the parent's mode reaches it: no
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
  a quiet chip on its title row reading the mode names (`spec`, a project mode's id; several
  comma-joined), beside
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
  the script's own result, the one the model reads (§tools.spec/census-note), and so is the writing
  procedure a script's call hands over, whole (§tools.spec/writing-on-demand).

## §chat.mode-menu/project-modes — A project's own minor modes

A project can ship minor modes of its own in `.sova/minor-modes/<id>/`. A chat working in that
project's checkout offers them beside the built-in ones. Only the user in that chat, or the
Overseer, turns one on.

A project mode is files in the project, not code loaded into Sova: instructions, reference files,
and optionally the project's own command-line tools, all kept in the mode's folder. Only those
files configure it: Sova's settings, `mode.json`, profiles and automations never name one.

- **Which checkout.** The modes come from the checkout the chat runs in: the nearest folder at or
  above the chat's folder that holds `.git` (a repository or a worktree), or the chat's folder itself
  when none does. This is not the main
  checkout that profiles and playbooks read (§chat.profiles/projects): a chat in a worktree sees
  the modes on its own branch. A chat with no local folder (a remote target) has no project modes.
- **One folder per mode.** `<checkout>/.sova/minor-modes/<id>/MODE.md`. The id is the folder's
  name: `^[a-z][a-z0-9-]*$`, at most 30 characters. `MODE.md` opens with a `---` fence of
  `key: value` lines like a playbook's (§chat.playbooks/where-playbooks-come-from: not YAML), read
  strictly: only `description` (required, one line, shown in the menu), `workers: yes|no` (default
  `no`), `tools`, `commands` and `hooks` (each a JSON array; indented lines continue a value;
  §chat.mode-menu/project-mode-commands, §chat.mode-menu/project-mode-hooks). Any other key, a
  repeated key, a bad tool, command or hook or an empty body makes the mode broken, so there is no key that turns a mode on. The
  text after the fence is the mode's instructions: the block the model gets while the mode is on,
  under the heading `# Project minor mode: <id>` and a `Folder:` line with the folder's absolute
  path, against which every relative path in the mode resolves, so the instructions can point at the
  reference files beside them. Every other file in the folder is the mode's own to use.
- **Broken folders.** Sova lists a folder as **broken**, with its path and what is wrong, when its
  id is invalid, its `MODE.md` is missing or doesn't parse (its tool declarations included, and a
  `./` file a tool names that is missing, and a mode with tools, commands or hooks whose folder holds more than 1000
  files or 50 MB: such a mode is approved as its whole folder, so it is kept small), or its
  id is a built-in minor mode's (`align`, `spec`, `vis`, `codemode`, `memory`, or any added
  later). A broken mode can't be turned on. A name clash never replaces the built-in: the two live
  in separate namespaces, so a built-in added later never takes over a project's mode either. One
  broken folder never hides the others.
- **Never on by themselves.** A project mode is on only when someone turned it on in that chat:
  the user, from the chat's mode menu or `/mode` (§chat.mode-menu/terminal), the Overseer
  (§app.overseer/tools), or a script, a chat's agent or an extension through the mode request, whose
  approval is kept as theirs (§chat.mode-menu/project-mode-hooks). A mode file has no way to say "on by default". `Save as default` never
  stores one and `mode.json` never holds one. A profile, an automation, a project's coding session
  (§app.project-overseer/coding-mode) and `pi --minor` can't name one. Settings shows none.
- **The chat keeps the version it turned on.** Turning a mode on saves a copy of its `MODE.md`
  (description, `workers`, instructions and its tool, command and hook declarations) and, for a mode with tools,
  commands or hooks, the
  fingerprint of every other file in its folder into that chat's own history. From then on the chat works from that copy and never
  reads `MODE.md` again for it, across a reload, a resume, a server restart and a compaction.
  An edit to `MODE.md` reaches the chat only when the mode is turned off and on again; until then
  its row says it changed since you turned it on (when the menu next opens). The other files are
  not copied: the agent reads them from the folder when it needs them, so an edit to one reaches the
  chat at once. In a mode without tools, commands or hooks that marks nothing changed; in one with them any edit to
  a file in its folder (other than `MODE.md`) changes its fingerprint, so the row says it changed
  and its tools, commands and hooks stop running until it is approved again (below). A mode whose folder is deleted
  stays on, its row saying it was removed from the project, until it is turned off; then its row is
  gone. One whose files turn broken while it is on stays on too, from its copy, and its row says so.
- **Tools.** A mode may declare up to 16 tools, each with a name (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`,
  at most 32 characters), a description, its parameters (a JSON schema of an object; none by
  default), the command that runs it (an argv: the program is a bare name looked up on the `PATH`,
  such as `node`, `python3` or `sh`, which is the machine's own program and not covered by
  approval, or a `./` path; every element containing a `/` must be a `./` path naming a file in the
  mode's folder, passed as its absolute path, so `scripts/check.js`, an absolute path or `../` makes
  the mode broken) and an
  optional time limit (1–600 seconds, 60 by default). The model sees each as
  `<id with - as _>__<name>` (`release-check`'s `status` is `release_check__status`), so no two
  modes' tools collide. While the mode is on, the model has those tools; turning it off takes them
  away from the next run. A call runs the command in the chat's folder with the call's arguments as
  JSON on its standard input, with `SOVA_MODE_ID`, `SOVA_MODE_DIR`, `SOVA_PROJECT_ROOT` and
  `SOVA_TOOL_NAME` set, in a process group of its own that is killed whole at the time limit or
  when the turn is stopped, and gives the model its exit code, its output and its errors, each
  cut at 256 KB with the cut marked. A `./` file that is a symlink leading out of the mode's folder,
  or any argument holding a `/` that isn't a `./` folder path, is refused at the call and runs
  nothing. While the chat's sandbox is On
  (§chat.sandbox/states), a project tool call runs nothing either: it is refused, telling the model
  to ask the user to turn the sandbox off, since the sandbox confines only the chat's own tools. Sova loads no code from the project into the chat itself: a tool is a program it runs.
- **Approval.** A mode with tools, commands or hooks needs the user's approval before it is first
  turned on, and again whenever what it runs or its folder changes: the declared tools, commands and
  hooks, or any file in the mode's
  folder, at any depth, hidden files included (a symlink counts as the path it points to), except
  `MODE.md` itself. So a script that sources a helper beside it, or a program that imports a
  sibling, can't change under an approval. Editing the instructions in `MODE.md` alone never asks
  again, and a mode without tools, commands or hooks never needs approval. A mode that declares
  neither commands nor hooks keeps exactly the fingerprint it had before they existed, so no approval
  given before is asked again. What you approve is what you saw: the
  approval records a fingerprint of the declared tools, commands and hooks and every file in the folder, and it is refused when the folder changed since the menu
  showed them. Approvals are kept per user in Sova's state root, outside every repo, by checkout
  and mode, the last 8 approved fingerprints each, so switching a branch back to a version already
  approved doesn't ask again. Sova can't tell
  who wrote a file, so this includes modes you or your agent wrote.
  - In the menu an unapproved mode says it asks before turning on. Turning it on opens the approval
    panel in the menu (§chat.mode-menu/menu), showing each tool and the command it runs, with
    **Approve and Turn On** and **Cancel**. Nothing is turned on until you approve. If its tools
    changed while the panel was open, the approval is refused and the panel shows the tools as they
    are now, to check again.
  - In a terminal, `/mode` turns a mode with tools on only when that exact version of its tools is
    already approved; it never asks there (§chat.mode-menu/terminal).
  - When the Overseer turns a mode on, that counts as the approval of its tools and commands:
    nothing waits for you, and the approval is recorded as the Overseer's. It never approves the
    mode's hooks: they stay inactive until you approve them yourself
    (§chat.mode-menu/project-mode-hooks).
  - If any file in the folder changes on disk after its approval while the mode is on, the next
    call of any of its tools runs nothing: it is refused, telling the model the mode's files changed
    and need re-approval, and the row says its tools changed since you approved them. Turning the mode off
    and on again asks for approval of what it has now, and then the calls run.
- **Reaching the model.** A project mode's block reaches the model the same way a built-in mode's
  does (§chat.mode-menu/minor-toggle-keeps-prompt). It is in the system prompt when it was on at
  the session's start or last compaction, otherwise in a hidden note at the next run, after the
  built-in modes' blocks. Because the block comes from the chat's saved copy, a reopened chat
  rebuilds the same prompt byte for byte, whatever the folder holds by then.
- **Workers.** A mode with `workers: yes` reaches the chat's workers the way `spec` does
  (§chat.mode-menu/workers): its block from the chat's saved copy, after spec's, and its tools from
  that copy when the worker can run commands (it has `bash`). A worker that can't, and a worker on
  a remote target, gets the block without the tools; a worker on its worktree's own agent dir gets
  neither from the parent (§chat.worktrees/worktree-config). In a worker the tools refuse
  exactly as in the chat: its files changed since its approval, or the worker's sandbox On. A
  worker never reads the folder, and never turns a project mode on itself: it is refused with "a
  worker gets its project modes from the session that started it". A chat hands its workers at most 8 modes, built-in and project
  together.

Not covered: nothing beyond the mode extension's own behavior is added for the plain pi TUI.

## §chat.mode-menu/project-mode-commands — A project mode's commands

A project mode may declare commands: programs of the mode that you, a script and that chat's agent
can run by name while the mode is on in a chat, without asking the model.

- **Declaring one.** `commands` in `MODE.md` is a JSON array of at most 16 commands, each with a
  name (the tool-name rule: `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, at most 32 characters, unique among the
  mode's commands), a description, its parameters (a JSON schema of an object; none by default),
  `run` (an argv under exactly the rules of a tool's command, §chat.mode-menu/project-modes) and an
  optional time limit (1–600 seconds, 60 by default). A bad one makes the mode broken. Its id is
  `mode.<mode id>.<name>` (the `release` mode's `release_check` is `mode.release.release_check`).
- **Running one.** `sova run mode.<id>.<name> --session <chat> [--<param> <value>]…` from a terminal
  or a script, or the chat's agent from its own terminal the same way. It is `POST
  /api/mode/command?path=<chat>` with `{ mode, name, args }` (the catalogue entry `chat.mode-command`).
  It runs exactly as the mode's tools run: in the chat's folder, with the arguments as JSON on its
  standard input (any JSON object, at most 1 MB: unlike a tool call's, they are not checked against
  the declared parameters, so the program checks its own), `SOVA_MODE_ID`, `SOVA_MODE_DIR`, `SOVA_PROJECT_ROOT` and `SOVA_TOOL_NAME` (the
  command's name) set, in a process group of its own killed whole at its time limit, with the
  chat's own environment, which is the reach an approved tool has. The answer is its exit code, its
  output and its errors, each cut at 256 KB with the cut marked; a program that ran answers even
  when it failed. `sova list --session <chat>` lists the commands of that chat's modes that are on,
  and Sova's record of who ran what names each run by its `mode.<id>.<name>` id.
- **When it runs nothing.** It runs from the version of the mode the chat turned on, never from the
  folder's `MODE.md`, and only while all of these hold, each checked at every run: the mode is on in
  that chat; the chat isn't a worker (a worker is refused for being one, "this chat is a worker.",
  whatever its own branch has on); its sandbox isn't On; that version is approved now (by you or
  by the Overseer); and no file in the folder changed since. Otherwise it answers with a sentence
  saying which, and runs nothing. A chat runs at most 4 of its mode commands at once: a fifth is
  refused with a sentence to try again when one finishes. A chat open in a terminal (live) can't
  run one through Sova, as it can't be switched.
- **Who may call.** This machine's own door: a mesh peer needs the `full` grant for it, whatever it
  may do with the chat otherwise (§mesh/peers).

## §chat.mode-menu/project-mode-hooks — A project mode's hooks

A project mode may declare hooks: programs of the mode that run after something happened in a
chat that has the mode on. They report what already happened; they never block, delay, change or
answer anything, and they never send a message into a chat.

- **Declaring one.** `hooks` in `MODE.md` is a JSON array of at most 8 hooks, each `{ "on", "run" }`
  and an optional time limit (1–600 seconds, 30 by default). `on` is `turn.started` (a reply
  started) or `turn.ended` (a reply finished, however it ended: stopped and failed ones too); any
  other value makes the mode broken. `run` is an argv under exactly the rules of a tool's command.
  Events of the whole project (a session created, renamed, tagged or archived in the checkout) and
  a chat's attention are not offered yet.
- **When it runs.** Only on a turn that runs in that chat while Sova hosts it: never when the chat
  opens, is restored, reloads onto new code or is resumed, and never in a worker or in the plain pi
  terminal. It runs after the event, without making anything wait for it. It gets the event as JSON
  on its standard input, `{ "event", "sessionId", "at", "mode" }`, and `SOVA_MODE_ID`,
  `SOVA_MODE_DIR`, `SOVA_PROJECT_ROOT` and `SOVA_HOOK_EVENT`, in the chat's folder, in a process group
  of its own killed whole at its time limit or when the chat closes.
- **No credential in its environment, but not walled off.** A hook's environment holds only the
  basics (`PATH`, `HOME`, `USER`, the locale, `TERM`, `TMPDIR`, …) and those four: none of the
  chat's own variables and no Sova address, key or token, so a hook gets no Sova credential in its
  environment. It is not walled off from Sova: like any program you run outside a sandbox, a hook
  can still read Sova's operator token file from disk under `HOME`, and a program that sends that
  token as Sova's cookie is taken for your own page, so it could approve hooks.
- **Approval.** Hooks are part of what you approve (§chat.mode-menu/project-modes), and they need
  your own approval: when it was turned on with an approval that isn't yours (the Overseer's, a script's, a chat
  agent's or an extension's), its tools and commands work but its hooks
  stay inactive, and the mode's row says "Hooks need your approval" with **Approve Hooks**, which
  approves that exact version (refused, like a stale approval, when it changed since the row was
  drawn). **Apply and Approve** on a project overseer's Settings change card that grants a mode records your
  own approval of the version it lands (§app.project-overseer/settings), under the same page-only rule.
  Only you approve hooks, from Sova's own page on this machine: an approval of hooks sent by
  the Overseer, by a chat's agent with its chat's key, by a script or extension sending Sova's token,
  or through a mesh peer is refused. An approval those callers give when turning a mode on is kept
  as theirs: its tools and commands run, its hooks wait for yours. Telling your page from a script is a heuristic (the
  page sends Sova's token as its cookie, a script as a header): a program holding the token can
  present it as the cookie, which is the token-on-disk limit above. Each run
  checks, as a command does, that the chat isn't a worker (a worker's hook is skipped for being
  one, whatever its own branch has on), that the mode is on with that version, the sandbox
  isn't On, nothing in the folder changed, and that you approved that version.
- **Bounded.** A hook never runs twice at once: an event while it runs leaves at most one more run
  waiting. Each hook runs at most 10 times in any 10 minutes, per hook, in each chat (a mode's 8 hooks may
  each run 10 times): past that its runs are skipped,
  never saved for later, the mode's row says "Hooks paused: a hook ran 10 times in 10 minutes.",
  and it runs again once the 10 minutes allow. A hook that fails, times out or is skipped writes one
  line to the chat's log and nothing else: the chat, its transcript, the model and its queue never
  see it.

## §chat.mode-menu/memory-panel — The memory row and its Memory type panel

The `memory` row is in a chat's minor modes only while that chat's `mode` message carries `memory`
(its type, and the size Settings gives that type, which a chat whose runtime can run memory sends, §chat.memory/where);
a chat whose message has none lists the other minor modes and no memory row. It is the last minor
row, after `codemode`, a checkbox like the others: clicking it turns memory on or off and keeps the
menu open. Its description is the chosen type's row description and, while memory is on, its detail
line names the type ("UniiChat — by Victor Taelin", "Zoomable compaction — Sova").

- **The panel.** A chevron button at the row's right end (a `menuitem` beside the checkbox, never
  inside it, named "Memory type", with a 44px target, next in the roving focus) swaps the menu for
  the **Memory type** panel in the same popover, the Subagents picker's pattern: a Back header
  titled "Memory type", then, under a **Type** label, one `menuitemradio` row per type — its name, its author ("by Victor
  Taelin", "Sova") and its one-line description, the chat's type checked. That is all the panel
  holds: no link and no size (each type's Summary size is Settings → Memory's, §chat.memory/settings;
  the design write-up is linked from its help card, §chat.memory/help). The chevron's description
  reads "Choose this chat's memory type".
- **Scrolling.** The rows scroll between the Back header and the foot, which stay put, as in the
  Subagents picker, so on a short window (or in the phone's sheet) no row is ever cut off.
- **Picking** a type posts `{ memory: { type } }` for this chat (§chat.memory/choice) and keeps the
  panel open; the check moves when the chat's `mode` message says so. The foot line reads "This chat only. Kept while memory is off." While a pick is saving
  the rows are `aria-disabled`; a refused pick shows "Couldn't change memory." with the reason, and
  the choice is unchanged.
- **Save as default** saves the chat's type with its modes (§chat.memory/choice), and reads
  "Already the default" only while it also matches the saved default type (`GET /api/mode`'s
  `memory`).

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
Sova's menu turns on, has no row), then one row per project mode of this checkout
(§chat.mode-menu/project-modes), its description reading "This project · {name} — {description}
— {state}" (needs approval, changed since turned on, removed, broken) and its on/off marker,
**align: open
  viewer**, and **save as default** last. Without a palette to open (outside the TUI, or the palette
  extension not loaded) it shows the status and the usage line instead; it never toggles anything.
- **`/mode normal`**, **`/mode delegate`** switch the major mode. **`/mode <minor>`** toggles that
  minor mode and **`/mode <minor> on|off`** sets it; `/align on|off` does the same for align.
  `/mode memory on` is refused with "memory is turned on from a Sova chat's mode menu"
  (§chat.memory/where); `/mode memory off` works. **`/mode project:<id> on|off`** (or without
  `on|off`, to toggle) does the same for a project mode; the bare id works too when no built-in mode
  has that name. Sova's menu always sends the `project:` form. A broken one is refused with its problem; one
  with tools turns on in a terminal only when that exact version of its tools is already approved
  (for example, earlier in a Sova chat's mode menu); otherwise it is refused with "Minor mode <id>
  not turned on: <id> runs the project's own tools: approve it from a Sova chat's mode menu
  first".
- **`/mode status`** lists this session's mode, the default for new sessions, its subagent profile
  and where that came from, the Delegate routing, the spec writer, strict, the minor modes, the
  project modes as "project modes ({name}): {id} ({state})", the state being on, removed, changed
  since turned on, needs approval, or broken with its path and error, the
  toggle shortcut, the alignments and the state file.
- **`/mode default`** saves this session's mode, strict flag and built-in minor modes (never a
  project mode) as the default, the
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
  `--minor` names only built-in modes: a project mode's id there is an unknown name.
  `minorShortcuts` binds no key to `memory` or to a project mode.
- **The status line** in the TUI's footer reads the mode, then in Delegate `fallback:<profiles>`,
  `ask:<profiles>` and `strict`, then each minor mode on (project modes after the built-in ones), then `writer:fallback` or `writer:ask`
  while spec's writer is off its primary route: dim in normal with no minor mode, accent otherwise,
  warning when a route has fallen back or has none.

## §chat.mode-menu/states — States

What the trigger and the menu show in each state, from a mode not known yet to a failed save.

| State | Shows |
|---|---|
| Idle | Trigger icons and label, and this chat's rows checked |
| Mode not known yet (no `mode` message, nothing in the list's row, nothing this tab saw) | Trigger shows the sliders icon alone and its label reads "Mode", nothing checked (the default isn't this chat's state) |
| Known before the `mode` message (§chat.composer/known-on-switch) | Trigger label and rows checked as Idle; from the list's row, the name and banners follow how it says a switch applies; from what this tab last saw, no "applies after this turn" in the name and neither switch banner until the message says |
| Saving | Rows `aria-disabled` (the cursor is `progress`) |
| Mid-turn switch | Info banner "Applies after this turn." (trigger name adds it too) |
| Chat can't switch | Warn banner "This chat can't switch." |
| Switch failed | Error banner "Couldn't switch the mode." with the reason. The mode is unchanged |
| Saving the default | `Save as default` reads `Saving…`, `aria-disabled` — only the save does this; a switch keeps the label |
| Default save failed | Error banner "Couldn't save the default." with the reason. The mode is unchanged |
| Already the default | `Already the default` with the check, `aria-disabled` |
| Load failed | Error banner "Couldn't load the modes." |
| Project mode asks before turning on (§chat.mode-menu/project-modes) | Row off, its state line "Asks before turning on: it runs {n} tool(s)."; turning it on opens the approval panel; nothing switched until approved |
| Approving | `Approve and Turn On` reads `Turning On…` |
| Tools changed while the approval panel was open | Warn banner in the panel, the fresh tools under it; nothing switched |
| Project mode changed since turned on | Row on, state line "Changed since you turned it on…" (off and on again takes the new version) |
| Project mode's files broken while on | Row on, state line "Its files have a problem now: {problem}…" |
| Project mode removed | Row on, state line "Removed from the project…"; turning it off removes the row |
| Project mode's tools changed since approval | Row on, state line "Its tools changed since you approved them…"; its tool calls are refused |
| Project mode broken | Row off, `aria-disabled`, state line "Can't turn on: {problem}" |
| Project mode switch failed | The same "Couldn't switch the mode." banner |
| Memory type refused (§chat.mode-menu/memory-panel) | Error banner "Couldn't change memory." with the reason, in the panel. The choice is unchanged |

## §chat.mode-menu/tokens — Tokens

The tokens the trigger, the menu's rows and its foot are drawn with.

Trigger: `--font-mono`, `--fs-mono`, `--color-ink-2`, sunken fill while open, icons
`--color-ink-muted`. A project mode's letter square is drawn like an icon: 16px, a `--stroke-icon`
border in its ink, `--r-xs` corners, the letter 10px semibold in the body face, `--color-ink-muted`. The folded count "+N" (and a profile card caption's, §chat.profiles/picker)
is quiet: `--fs-caption` in the body face, tabular figures, `--color-ink-muted`. Rows (`.popover-item`, §design/menu-rows): `--control-md` min height, `--space-3` at the
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
- **A trigger that never goes icon-only.** It used to name the modes in words at every width,
  because the label was the fact. Reversed on purpose (al_1): the foot now shows icons for the
  modes, with the menu's rows as their legend and the full wording kept as the accessible name and
  desktop hover text, and words come back beside the icons at a composer 620px or wider.
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

