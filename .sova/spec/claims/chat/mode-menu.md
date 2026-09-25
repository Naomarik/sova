# §chat/mode-menu — Mode menu
> Part of the Sova design spec · [overview](../design/overview.md)

pi's mode extension (`pi-config/extensions/mode`) has one **major mode**, `normal` or
`delegate`, and any set of **minor modes** (today `align`). What Delegate routes where is
Settings → Modes (§app/settings-dialog), not this menu.

Both are **per session**: each chat keeps its own, persisted in that session's own `mode`
entries. The menu switches them from the chat's composer, and the switch reaches **that chat
only**, **from its next message**. You never start a new chat or reconnect, and no other chat or
terminal session moves.

`~/.pi/agent/mode.json` is the **default for new sessions** (plus the shortcuts). A session that
has never toggled follows it; the first toggle pins that session. `GET /api/mode` reads it and
`POST /api/mode` without `?path=` writes it; neither touches an open chat. From a terminal,
`/mode default` saves the current session's mode as the default.

**A switch never writes the default** — not even in a session that has sent no message yet. The
default moves only when someone asks for exactly that: the menu's **`Save as default`** button
(below), `/mode default` in a terminal, or a `POST /api/mode` with no `?path=`. A new chat is no
longer a side effect of being new: setting one up is not a statement about every chat you start
next, and the state that made it look like one (an empty session) was invisible in the act of
switching.

## §chat.mode-menu/trigger — Trigger

In chat sessions it sits in the composer foot (§chat/composer), at the right end: the foot reads the model
indicator, the disabled reason, then this. It's in reach of the message it affects, next to the
model and thinking level that also shape the next turn. A watched (TUI) session has no composer
foot to show it in, and nothing to show anyway: the TUI keeps its mode in memory, so we can't say
what it's using. The session head's right side keeps the context gauge, the subagents or team
chip and the info button (§chat/context-window); it carries no mode.

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
  Before the chat's first `mode` message arrives it reads just "Mode" and no row is checked: the
  default is not this chat's state.
- **Name.** `aria-label` repeats the label with "Mode: " in front, so it survives when the label
  hides. A pending switch adds ", applies after this turn".
- **Every width.** It never hides and never goes icon-only: the label is the fact. It narrows the
  way the model id beside it does — at 320px the minor modes shrink to an ellipsis first, then the
  major mode, and the row never grows wider than the composer. The icons, the padding and the
  `title` stay. In the foot it takes the model indicator's scale: a `--control-sm` row with a
  `--tap-min` target stretched over it by a `::after`, mirrored to the right edge.

## §chat.mode-menu/menu — Menu

It uses the model menu's popover shell (`.model-menu`): a `[popover="auto"]` right-aligned
**above** the trigger (the composer is pinned to the pane's bottom edge, so it grows upward, like
the composer flyout), and a bottom sheet under 768px. The list inside is an ARIA **menu**. A listbox
doesn't fit here: there's nothing to search, and it mixes one exclusive choice with independent
toggles, which is exactly what `menuitemradio` and `menuitemcheckbox` are for.

```html
<div class="model-menu mode-menu" id="mode-popover" popover="auto">
  <div class="banner banner-info" role="status">…Applies after this turn.…</div>   <!-- only then -->
  <div class="model-menu-list" role="menu" id="mode-menu" aria-label="Mode">
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-major">
      <div class="list-group-label" id="mode-group-major">Major mode</div>
      <div class="mode-option" role="menuitemradio" aria-checked="false" tabindex="-1">
        <span class="icon icon-sm mode-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="mode-option-text"><span class="mode-option-id">normal</span>
          <span class="mode-option-desc">Pi as usual</span></span>
      </div>
      <div class="mode-option-row" role="none">
        <div class="mode-option" role="menuitemradio" aria-checked="true" tabindex="0">…delegate…</div>
        <button type="button" class="button button-ghost button-icon mode-option-gear" role="menuitem"
          tabindex="-1" aria-label="Configure Delegate" title="Configure Delegate">
          <span class="icon icon-sm" style="--icon: url(/icons/settings.svg)" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-minor">
      <div class="list-group-label" id="mode-group-minor">Minor modes</div>
      <div class="mode-option" role="menuitemcheckbox" aria-checked="true" tabindex="-1">…align…</div>
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
  major mode, strict flag and minor modes what new sessions start from (`POST /api/mode?path=…
  { saveDefault: true }`) — the same three fields `/mode default` writes in a terminal. The request
  carries no mode of its own — the server takes the chat's — so a switch that lands between the
  click and the answer can't save something the user never saw. The write re-reads the file first,
  so `mode.json`'s shortcuts and anything else in it are kept, and the mode extension reads it at
  each `session_start`: the next session, TUI or Sova, starts on it.
- **What it moves, and when.** It switches nothing now: this chat keeps what it is on, and no open
  chat hears about it. But the default is read at each start, so it moves new sessions from their
  next start — and, like any write of the default, a session that has never switched (no mode entry
  on its branch) follows it too from its next start or reopen. "Unchanged" is true now, not
  forever. It stays pressable in a chat that can't switch (`This chat can't switch.`): it saves
  the very state the menu is showing.
- **The button states.** `Save as default` when this chat's mode, strict flag or minors differ from
  what new sessions start from; `Already the default` with a check, `aria-disabled`, when all three
  match — a button offering to save what is already saved is the thing this wording exists to rule
  out. What new sessions start from is the FILE's answer (read on every open, or the save's reply),
  never a switch's reply, which is this chat's own mode. The visible label is the accessible name
  (so a voice-control user can say what they see); the `title` adds what the press makes true and
  names the mode: "New sessions will start from delegate · align." While the save is in flight it
  reads `Saving…`, and only then; during a switch it keeps its label and is `aria-disabled`.
  Unknown either side (the file unread, this chat's mode not arrived) is **not** "already the
  default": the button stays pressable. The footer sentence beside it is the same in every state:
  `strict: off|on` — the one flag the menu does not switch — then "A switch here is this chat's
  own. New sessions start from the default."

- **Choosing.** Picking a major mode closes the menu and returns focus to the trigger, like the
  terminal palette. Toggling a minor mode keeps the menu open, so you can set several. While the
  switch is saving, the rows are `aria-disabled`.
- **Configure Delegate** is an icon-only gear at the right end of Delegate's row: a real
  `button` with `role="menuitem"`, a sibling of the `menuitemradio` (never nested in it) inside a
  `role="none"` wrapper, with a `--tap-min` target. It comes right after Delegate in the same
  roving focus. It closes the menu and opens Settings at **Modes** (§app/settings-dialog), where Delegate's routing
  lives. It switches nothing: this chat's mode stays what it was, and it's there in either mode,
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

`Save as default` is the same route with `{ saveDefault: true }`, and its refusals are of the
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
the mode, a minor mode, strict, or the Delegate routing changes.

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
reachable only through a command context (`ctx.getSystemPromptOptions`): the `/mode` and
`/align` handlers adopt the getter — Sova calls `/mode` at every chat open
(§chat.mode-menu/how-a-switch-reaches-the-chat), so every Sova chat has it before its first turn
— and from then on every switch, every `before_agent_start` and every run start (`agent_start`,
after pi may have rebuilt the base on a tool change) writes the current block there, or deletes
it when no mode block applies. A getter whose extension runner was replaced is dropped, never
retried. A terminal session driven only by the shortcut or the palette, with no `/mode` yet,
keeps the old behaviour until one runs.

Observable: in a chat with a mode on, a turn started by a worker settling that calls a tool has
no `mode: null` system entry after its tool result, and the bridge does not restart on it; the
prompt the provider receives is byte-identical to the previous user turn's.

## §chat.mode-menu/states — States

| State | Shows |
|---|---|
| Idle | Trigger label, and this chat's rows checked |
| No `mode` message yet | Trigger reads "Mode", nothing checked (the default isn't this chat's state) |
| Saving | Rows `aria-disabled` (the cursor is `progress`) |
| Mid-turn switch | Info banner "Applies after this turn." (trigger name adds it too) |
| Chat can't switch | Warn banner "This chat can't switch." |
| Switch failed | Error banner "Couldn't switch the mode." with the reason. The mode is unchanged |
| Saving the default | `Save as default` reads `Saving…`, `aria-disabled` — only the save does this; a switch keeps the label |
| Default save failed | Error banner "Couldn't save the default." with the reason. The mode is unchanged |
| Already the default | `Already the default` with the check, `aria-disabled` |
| Load failed | Error banner "Couldn't load the modes." |

## §chat.mode-menu/tokens — Tokens

Trigger: `--font-mono`, `--fs-mono`, `--color-ink-2`, sunken fill while open, icons
`--color-ink-muted`. Rows: `--control-md` min height, `--space-2` / `--space-3`
padding, id in `--font-mono` `--color-ink`, description `--fs-caption` `--color-ink-muted`,
checked `--color-accent-tint`, focus `--focus-ring` inset. Foot: `--fs-caption`
`--color-ink-muted` over a `--color-border` rule.

## §chat.mode-menu/rejected — Rejected

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

