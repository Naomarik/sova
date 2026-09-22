# 04g · Mode menu
> Part of the Sova design spec · [overview](overview.md)

pi's mode extension (`pi-config/extensions/mode`) has one **major mode**, `normal` or
`claude-heavy`, and any set of **minor modes** (today `align`). Both are **per session**: each
chat keeps its own, persisted in that session's own `mode` entries. The menu switches them from
the chat's composer, and the switch reaches **that chat only**, **from its next message**. You never
start a new chat or reconnect, and no other chat or terminal session moves.

`~/.pi/agent/mode.json` is the **default for new sessions** (plus the shortcuts). A session that
has never toggled follows it; the first toggle pins that session. `GET /api/mode` reads it and
`POST /api/mode` without `?path=` writes it; neither touches an open chat. From a terminal,
`/mode default` saves the current session's mode as the default. A switch in a session that has
sent no message yet writes the default too — the chat you're still setting up is the one you're
setting up new chats from; once it has messages, switching is that chat's alone.

## Trigger

In chat sessions it sits in the composer foot (§4), at the right end: the foot reads the model
indicator, the disabled reason, then this. It's in reach of the message it affects, next to the
model and thinking level that also shape the next turn. A watched (TUI) session has no composer
foot to show it in, and nothing to show anyway: the TUI keeps its mode in memory, so we can't say
what it's using. The session head's right side keeps the context gauge, the subagents or team
chip and the info button (§4f); it carries no mode.

```html
<button class="button button-ghost mode-trigger" type="button" aria-haspopup="menu"
        aria-expanded="false" aria-controls="mode-menu"
        aria-label="Mode: claude-heavy · align" title="Mode: claude-heavy · align">
  <span class="icon icon-sm" style="--icon: url(/icons/sliders.svg)" aria-hidden="true"></span>
  <span class="mode-trigger-label">claude-heavy</span>
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

## Menu

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
      <div class="mode-option" role="menuitemradio" aria-checked="true" tabindex="0">…claude-heavy…</div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mode-group-minor">
      <div class="list-group-label" id="mode-group-minor">Minor modes</div>
      <div class="mode-option" role="menuitemcheckbox" aria-checked="true" tabindex="-1">…align…</div>
    </div>
  </div>
  <p class="mode-menu-foot"><span class="text-mono">strict: off</span> · Before your first message
    it's also the new default; after, this chat only. <code>/mode default</code> saves it any time.</p>
</div>
```

- **Choosing.** Picking a major mode closes the menu and returns focus to the trigger, like the
  terminal palette. Toggling a minor mode keeps the menu open, so you can set several. While the
  switch is saving, the rows are `aria-disabled`.
- **Checked.** A checked row gets `--color-accent-tint` and the check. The words carry the state
  too, since `aria-checked` is announced.
- **strict** is shown read-only in the foot, for this chat. Change it in a terminal with
  `/mode strict on|off`; that is per session too.
- **Keyboard.** Roving `tabindex`, with real focus on the rows, so the standard focus ring shows.
  - On open, focus goes to the checked major mode.
  - `↑` / `↓` move and wrap. `Home` / `End` jump.
  - `Enter` or `Space` chooses or toggles.
  - `Esc` closes (native) and focus returns to the trigger. `Tab` closes and moves on.
- **Motion.** The same single fade as §4c.

## How a switch reaches the chat

`POST /api/mode?path=<session>` switches exactly the chat that file belongs to; it must be one
this server holds open (404 otherwise), and `mode.json` is not written. The chat then:

- **Calls the extension's own `/mode` handler** directly. That's the same code the terminal runs,
  so it leaves the same **marker** in the transcript: an info row "Mode → claude-heavy" or
  "Minor mode: align on", plus the snapshot the extension restores from. The command text never
  goes to the model. There's no reload, so the chat's subagent workers keep running. A chat that
  was never prompted takes the same path (the marker is a deliberate user write).
- **Mid-turn.** The running turn keeps the old mode, and so do messages queued during it
  (follow-ups and steers join that turn). The chat's menu shows an info banner, "Applies after
  this turn.", until the turn settles.
- **Can't switch.** If the mode extension isn't loaded in that chat, or another program wrote the
  session, the chat isn't touched. Its menu shows a warn banner, "This chat can't switch." Only
  the default applies then.

**Where a chat's mode comes from when it opens.** `bind()` resolves it once, with the extension's
own rule (`resolveChatMode`, `restoreActive` from pi-config `state.ts`): the newest `mode` entry
on the branch that carries a snapshot wins, otherwise the default from `mode.json`. Server and
extension therefore always agree, including after a server restart. Nothing is broadcast to other
chats, and nothing watches `mode.json`.

## States

| State | Shows |
|---|---|
| Idle | Trigger label, and this chat's rows checked |
| No `mode` message yet | Trigger reads "Mode", nothing checked (the default isn't this chat's state) |
| Saving | Rows `aria-disabled` (the cursor is `progress`) |
| Mid-turn switch | Info banner "Applies after this turn." (trigger name adds it too) |
| Chat can't switch | Warn banner "This chat can't switch." |
| Save failed | Error banner "Couldn't switch the mode." with the reason. The mode is unchanged |
| Load failed | Error banner "Couldn't load the modes." |

## Tokens

Trigger: `--font-mono`, `--fs-mono`, `--color-ink-2`, sunken fill while open, icons
`--color-ink-muted`. Rows: `--control-md` min height, `--space-2` / `--space-3`
padding, id in `--font-mono` `--color-ink`, description `--fs-caption` `--color-ink-muted`,
checked `--color-accent-tint`, focus `--focus-ring` inset. Foot: `--fs-caption`
`--color-ink-muted` over a `--color-border` rule.

## Rejected

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
  claude-heavy teams mid-task.
- **Fanning a switch out to every open chat** (what this used to do, through `mode.json` and a
  file watcher). One chat's mode is not another's: it moved terminals and tabs nobody asked to
  move. The file is now only the default.

---

