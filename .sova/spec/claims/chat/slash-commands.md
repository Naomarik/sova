# §chat/slash-commands — Slash commands
> Part of the Sova design spec · [overview](../design/overview.md)

pi's slash commands, offered while you type. The server sends the list once per connection as
`{type:"commands", commands}`. Names come without the slash (`sessions`, `skill:omarchy`).
Sending `/name args` as a normal prompt runs the command.

## §chat.slash-commands/when-the-menu-opens — When the menu opens

- **Trigger.** A `/` at the very start of the text, or right after whitespace, opens the menu.
  The **token** is everything from that `/` up to the caret, and it can't contain whitespace.
  The menu stays open while the caret is inside a token, and re-filters on every input.
- **Closing.** The menu closes when:
  - the token ends (a space is typed, or the caret leaves it);
  - `Esc` is pressed, which leaves the text alone;
  - an option is inserted;
  - the textarea loses focus.

  A token dismissed with `Esc` doesn't reopen until its text changes.
- **When it never opens.**
  - No `commands` message has arrived yet, or the list is empty.
  - The composer is disabled (read-only, connecting, reconnecting, or a model switch is pending).
    If it becomes disabled while the menu is open, close it.
- **While streaming it works as usual.** Sending `/name args` with **Steer** is fine. pi runs
  extension commands immediately, even mid-turn, and queues `skill:` and prompt templates as a
  steer with expansion. A turn starting or ending doesn't close the menu. The "Ran" row (below)
  applies in both states.

## §chat.slash-commands/markup — Markup

The menu is the **first child of `.composer-inner`** (which is `position: relative`), so it sits
just above the composer at full composer width, at every width including 320.

```html
<div class="command-menu" id="command-menu">
  <p class="command-menu-head" id="command-menu-head" aria-hidden="true">Commands · 3</p>
  <div class="command-list" id="command-listbox" role="listbox" aria-label="Commands">
    <div class="command-option" role="option" id="cmd-sessions" aria-selected="true" data-active>
      <span class="command-option-name">/sessions</span>
      <span class="chip">ext</span>
      <span class="command-option-desc" title="{full description}">Search and focus live pi sessions</span>
      <span class="command-option-location" title="{path}">user</span>
    </div>
    <div class="command-option" role="option" id="cmd-skill-omarchy" aria-selected="false">
      <span class="command-option-name">/skill:omarchy</span>
      <span class="chip">skill</span>
      <span class="command-option-desc">…</span>
      <span class="command-option-location">…</span>
    </div>
  </div>
  <p class="command-menu-foot"><kbd>Enter</kbd> or <kbd>Tab</kbd> to insert · <kbd>Esc</kbd> to close</p>
</div>
```

The textarea gains these attributes, and keeps them only while the menu is open:

```html
<textarea class="input textarea composer-input" id="composer-input" …
          aria-autocomplete="list" aria-controls="command-listbox"
          aria-activedescendant="cmd-sessions"></textarea>
```

- **Pattern.** This is the combobox pattern with a **listbox**, because inserting a name is
  choosing one value. Focus never leaves the textarea, and the active option is
  `aria-activedescendant`.
  - HTML doesn't allow `role="combobox"` on a `<textarea>`, so the textarea keeps its native
    role. It carries `aria-autocomplete="list"`, `aria-controls`, and `aria-activedescendant`,
    which are all valid on a textbox.
  - The active option gets `aria-selected="true"` plus `data-active` (the inset focus ring and
    sunken fill). It's the same treatment as the model menu.
  - Remove the three attributes when the menu closes.
- **Rows.** Each row has two lines and is at least 44px tall.
  - Line 1: the name with its slash, in mono, then the source chip.
  - Line 2: the description (muted, truncated, full text in `title`), then `location` (muted
    mono, up to 16ch, and 8ch when the composer is under 480px wide, with `path` in `title`).
    Leave out whatever is missing.
  - **No description** (`description` is optional, and extension commands may leave it out):
    render only the name, the source chip, and the location if present. Don't render an empty
    `.command-option-desc` or placeholder text. The location stays in the right column under
    the chip, so line 2 is just the right-aligned location. With no location either, the row is
    a single line and still 44px tall. The description tier of filtering skips it.
- **Source chip.** A neutral `.chip` with no dot and no color: `ext` (extension), `prompt`, or
  `skill`. It's a category, not a status, so it carries no hue and no dot.
- **Id.** Option ids are `cmd-` plus the name, with anything outside `[a-z0-9-]` replaced by
  `-`. Add a suffix if two names collide.
- **Head.** "Commands · {n}" is the visible count. It's `aria-hidden` because the announcement
  (below) says the same thing.
- **Size.** Height is capped at `min(320px, 40vh)`, and the list scrolls inside it (keep the
  active option in view with `block: "nearest"`). The foot is hidden under 768px.
- **Motion.** It fades in once.

## §chat.slash-commands/filtering-and-order — Filtering and order

- **Query.** The query is the token without its `/`, matched case-insensitively against `name`
  of the commands the menu offers (§chat.slash-commands/commands-that-need-the-terminal-ui hides some).
- **Order.**
  1. Names that **start with** the query.
  2. Names that **contain** it.
  3. Names whose **description** contains it.

  Within each tier, sort by name. An empty query (just `/`) lists every command the menu offers by name.
- **Active option.** The first row becomes active whenever the results change.
- **Empty result.** Keep the menu open, drop the list, and show
  `<p class="command-menu-empty">0 commands match “/{query}”. Enter sends it as a message.</p>`.
  In touch mode (§chat.composer/behavior) the second sentence is dropped: Enter adds a line there,
  so the copy doesn't promise a send. While it's empty, `Enter` is **not** intercepted: it does
  what `Enter` does in the composer.

## §chat.slash-commands/keyboard-and-mouse — Keyboard and mouse

| Input | Does |
|---|---|
| `↓` / `↑` | Moves the active option, wrapping. It never moves the caret while the menu is open |
| `Enter` / `Tab` | Replaces the token with `/{name} ` (with a trailing space) and closes the menu. The caret lands after the space, so arguments come next. `Enter` doesn't send; the *next* `Enter` does what `Enter` does in the composer (§chat.composer/behavior) |
| `Esc` | Closes the menu and leaves the text unchanged. It doesn't blur the textarea or clear the draft |
| Typing | Keeps filtering. A space or a caret move out of the token closes the menu |
| `Shift+Enter` | Newline as usual. The newline ends the token, so the menu closes |
| Mouse down on a row | Inserts, the same as `Enter`. Use `mousedown` + `preventDefault()` so the textarea keeps focus. Hover makes a row active |

## §chat.slash-commands/commands-row — Commands row

A tap target for the same menu, for phones (where nobody types `/` from habit) and for
discoverability. It's the flyout's **Commands** row, second in the flyout's menu panel, right under Attach
images (§chat.composer/composer-flyout):

```html
<div class="mode-option composer-flyout-item" role="menuitem" id="composer-flyout-commands"
     tabindex="-1" title="Commands">
  <span class="icon icon-sm composer-flyout-icon" style="--icon: url(/icons/command.svg)" aria-hidden="true"></span>
  <span class="composer-flyout-label">Commands</span>
</div>
```

- **Icon.** `/icons/command.svg` is a `/` inside a rounded square, drawn on the system grid
  (24 viewBox, 1.5 stroke, round caps).
- **Tap.** It closes the flyout first, then does what the old button did:
  - It **inserts `/` at the caret**, with a space before it if the character before the caret
    isn't whitespace, and focuses the textarea. The existing trigger rule then opens the menu
    with an **empty query**, so nothing new is needed in the menu logic.
  - If the caret is already inside a `/` token, it just refocuses the textarea and reopens.
  - Focus stays in the textarea, and `aria-activedescendant` works as before.
- **Undo on dismiss.** If the menu closes with `Esc` or blur while the token is **still exactly
  the bare `/` this button inserted**, remove that `/` (and the space it added). Opening and
  dismissing leaves the text as it was. A `/` the user typed is never removed.
- **`aria-expanded`** belongs to the textarea's combobox, not to this row: the menu it opens is
  the textarea's autocomplete, and the flyout is closed by the time it appears.
- **Disabled.** The row takes `aria-disabled="true"` exactly when the menu couldn't open:
  - the composer is disabled (it shares `aria-describedby="composer-reason"`, like Attach);
  - there's no command list yet, or it's empty. Then its `title` becomes "No commands
    available", and there's no composer reason.

  A tap on it does nothing.
- **Unchanged.** Typing `/`, and all the keyboard and touch behavior above, stay as they are.
- **Width budget.** The flyout trigger is 44, and Send collapses to 44 under 480px of composer
  width (§chat/images), with 8px gaps:

  | Composer width | Idle textarea | Streaming (adds Stop 44) |
  |---|---|---|
  | 390 viewport (358 composer) | about 246px | about 194px |
  | 320 viewport (288 composer) | about 176px | 132px, with nothing hidden — one flyout replaced two buttons |

## §chat.slash-commands/announcements — Announcements

In the composer's polite live region, announce "{n} commands available." when the menu opens,
and again when the count changes, at most once a second. When there are none, announce
"0 commands match."

## §chat.slash-commands/in-the-thread — In the thread

- **Sending.** A command goes as a normal `prompt` with the text `/{name} {args}`, or as a
  `steer` while streaming.
- **No optimistic bubble.** When the first token is a known command, don't add the optimistic
  user bubble. The command isn't a message to the model, and a template or skill expands into
  different text.
- **Local row instead.** Append a local `.info-row`:

  ```html
  <div class="info-row" role="note">
    <span class="info-row-text"><span class="icon icon-sm" style="--icon: url(/icons/terminal.svg)" aria-hidden="true"></span>
      <span>Ran <code>/sessions</code></span></span>
  </div>
  ```

  Args go inside the `<code>` too, truncated at 60 characters.
- **What follows.** Everything after that arrives as normal events and items, and renders with
  what already exists:
  - **Prompt templates and skills** expand into a **user** message (the expanded text), then an
    assistant turn.
  - **Extension commands** may add `custom` entries, which render as **info rows** (or
    **unknown** rows with the Raw entry disclosure) — except the mode extension's markers, which
    render nothing (§chat.transcript/transcript-items). They may also send `ui_request`s (§app/extension-dialogs), or
    produce nothing visible.
  - **A persisted running row.** An extension command may also append a `custom` entry at the
    start of its run that the thread renders as a live, self-updating row for the run's
    duration, then append the result under the same id when the run settles; the result row
    replaces the running row in place, live and on reload. `/explain` does this (§chat/transcript report,
    "Explain rows"). Unlike the "Ran" row, it is persisted: a reload mid-run shows it still
    running. A run the restart or `/reload` stopped stays running until the session's next prompt
    or `/explain`, which settles it as Interrupted (§chat.transcript/transcript-items, "Explain rows:
    interrupted").
- **Reload.** The persisted entries render the same way. The local "Ran" row is local only and
  isn't restored.
- **Unknown commands.** A `/word` that isn't in the list is sent and rendered as an ordinary
  message, with the optimistic bubble.
- **Local commands.** A few commands Sova answers itself and never sends: a bare `/new`
  (below), and a bare `/agents` / `/subagents`, which opens the session pane (§app.subagents-pane/trigger).
  Those two are still listed and inserted like any other command — the runtime registers them —
  but Enter runs them here, clears the draft, and adds no row to the thread: the pane opening is
  the result. Once the whole text is a bare local command the menu closes, and Enter runs it
  when Enter would send (in touch mode it adds a line, and Send runs it) rather than inserting a match (`/new` would otherwise pick `btw:new`); a partial token like
  `/ne` still opens it. Anything with arguments belongs to the runtime and goes through
  untouched. **Bare `/tree` and bare `/timeline` (§chat/timeline)** both open the session pane on Timeline
  the same way — draft cleared, no row in the thread — `/tree` with **Inputs Only** on (your own
  messages, each able to rewind) and `/timeline` with it off. The runtime registers neither, so
  neither appears in the menu, and either one with arguments is an ordinary message.
- **`/clear`.** In the Overseer only (§app.overseer/identity-and-clear), bare `/clear` is a local
  command: it starts a fresh Overseer conversation. Anywhere else it's an ordinary message.
- **`/mode`.** In the Overseer only (§app.overseer/hosting), `/mode`, with or without arguments,
  is a local command that switches nothing: it clears the draft's text and says "The Overseer is
  always in normal mode." in a toast and to assistive technology. `mode` is not in its menu.
  Anywhere else it's the mode extension's command, as before.
- **`/new`.** Bare `/new` is a local command too, as in the TUI: it creates an empty session in
  the chat's folder, opens it with the composer focused, and archives the session it left (only
  once the new one exists). A session that isn't web-spawned, or whose subagents are working,
  stays unarchived: archiving closes the runtime. The runtime doesn't register it, so it isn't
  in the menu. With arguments or images it's an ordinary message.

## §chat.slash-commands/compact-handoff — /compact-handoff

`/compact-handoff [focus]` compacts a session after the agent writes down what the summary would
lose, and puts that note back right after the summary. It is an extension command
(`pi-config/extensions/compact-handoff/`), so it is offered in the menu like any other and runs
the same in the TUI and in Sova; `/compact` is unchanged.

- **Refused while busy.** While a turn runs, a compaction runs, messages are queued or an earlier
  `/compact-handoff` is still under way (its note being written, or its compaction waiting), it
  does nothing and says why in a notification. A session with no conversation on disk yet has
  nothing to hand off and is refused the same way.
- **The note is written in a background fork.** Otherwise it starts a background fork of the
  session (§chat.session-fork/background): a hidden child with the whole conversation, on the
  session's warm prompt cache, that may only read (files, search, read-only shell; no writes, no
  web). It is told the session is about to be compacted and to end its reply with a handoff note
  inside `<handoff>…</handoff>`: what must survive the compaction (anything durable goes in the
  note, since it can't write elsewhere), the exact files and ids to re-read, and the focus text,
  if given. Nothing of that turn is written into the session: no instruction, reply or tool call
  appears in the thread or in the model's context, only the run's row
  (§chat.slash-commands/compact-handoff-row). The fork runs this way in every host and on every
  provider; a Claude Code session whose CLI session is live and idle is resumed and forked there,
  otherwise its history is replayed and a notification says the fork starts without the cache. If
  the fork can't be started, the command says so in a notification and does nothing else; it
  never falls back to a turn in the session.
- **Then it compacts.** When the fork settles, the last non-empty `<handoff>` block of its final
  reply is the note. It is saved, then the session compacts with the focus as the summary's
  instructions, plus a line saying a handoff note is saved and comes back after the summary. The
  session ends with the summary and the note after it, and no trace of the handoff turn.
- **Messages during the fork.** The session stays usable while the fork writes. When a prompt,
  a topic delivery or a scheduled run reaches it meanwhile, the note is still saved the moment the
  fork settles, and the compaction waits for the next idle moment (the session settled, nothing
  queued). A prompt that starts in the instant before the compaction begins still wins: the
  compaction waits for the next idle moment again.
- **Cancel.** `/compact-handoff cancel` stops the fork (Esc and Stop don't reach it), or drops a
  compaction still waiting for an idle moment; the note, if already saved, stays saved. With
  nothing under way it says so.
- **No compaction** when the fork fails, is stopped, or its reply carries no block: a notification
  says so and nothing is saved. A compaction that fails says so in a notification, except one the
  user stopped; the note stays saved either way.
- **The fork's own files** (the session copy it forked and its own session) live in a run
  directory under `<agent dir>/compact-handoffs/.runs/`, deleted when the run ends; a failed run's
  is kept for diagnosis and swept after 24 hours.
- **Where the note lives.** `<agent dir>/compact-handoffs/<session id>.md` (directory 0700, file
  0600, replaced atomically, the newest run wins), headed with the session id, folder, time,
  leaf and focus; plus a copy in the session's hidden `compact-handoff` custom entry
  `{v: 1, path, note, at, leafId}`, which follows the branch, a fork and a clone. The extension
  writes both itself, on the machine running pi, so a sandboxed session (its agent dir is
  read-only to tools) and a remote one (its tools run on the far host) save the same way.
- **The note comes back after every compaction**, its own, a plain `/compact`, a threshold or an
  overflow one: the newest `compact-handoff` entry on the branch is added in full as a hidden
  message right after the summary, saying when it was written and where it is saved, to check it
  against the summary and to re-read the files it names before acting on the next request. A note
  from before the fork (written by a reply in the thread) whose reply is still in the kept part of
  the history gets only that preamble and the path. It starts no turn: idle, it is added at once
  and the session waits for the user; a compaction during a run adds it at that run's next turn
  boundary. A branch with no entry adds nothing.

## §chat.slash-commands/compact-handoff-row — The /compact-handoff row

A `/compact-handoff` run is a persisted running row (§chat.slash-commands/in-the-thread): the
extension appends a hidden `compact-handoff-run` custom entry `{v: 1, id, status, at, focus?,
path?, error?}` (never model context) when the fork starts, with `status: "running"`, and again
under the same `id` when it ends, with `saved` (and the note's `path`), `failed` (and the
reason), `cancelled` or `interrupted`. In Sova only the newest per id renders, on reload and
live (the result replaces the running row in place); in the TUI each entry draws its own line
where it was appended, as `/explain`'s do.

- **In Sova** it is an info row: running, "Writing a handoff note" with the focus, if any, and the
  live dot where the info icon sits; saved, "Handoff note saved" with its path; failed, "Handoff
  note failed" with a `.chip-error` "Failed" chip and the reason; cancelled, "Handoff cancelled";
  interrupted, "Handoff interrupted" with a `.chip-warn` "Interrupted" chip. The compaction that
  follows is its own row.
- **Interrupted.** A run its session stopped before it settled (a restart, a `/reload`) leaves its
  running entry as the newest. Opening the session writes nothing, so the row still reads running
  then; the session's next prompt, or its next `/compact-handoff`, appends the `interrupted`
  entry, which replaces it.

## §chat.slash-commands/commands-that-need-the-terminal-ui — Commands that need the terminal UI

Some extension commands open TUI-only interfaces, such as custom overlays and pickers. Sova
can't show those. When a command's `ui_request` has a kind §app/extension-dialogs doesn't support, or the server
reports the command needs the TUI (answer the request with `ui_response` `value: null` so the
command isn't left waiting), replace the "Ran" row with:

```html
<div class="info-row" role="note">
  <span class="info-row-text"><span class="icon icon-sm" style="--icon: url(/icons/attention.svg)" aria-hidden="true"></span>
    <span><code>/sessions</code> needs the terminal UI. Run it in pi in a terminal.</span></span>
</div>
```

Nothing in the contract says ahead of time which commands are TUI-only, so the client keeps
its own table of them: `palette`, `sessions`, `sessions-back`, `codefold`, `usage`,
`usage-refresh`, `working-count`, `extensions`, `websearch` (it opens a browser on the server
machine) and `subagents` (its models picker drops the pick here). These never appear in the
menu. `team`, and every `team:…` or `team-…` form, is hidden from the menu too, though it is
not TUI-only. Hiding is the menu's alone: the full list still decides whether a typed `/word`
is a command. Sending a TUI-only command typed in full with no arguments (`/sessions`) shows
the row above in place of "Ran" right away, without waiting on the server; a bare `/subagents`
still opens the session pane instead (§app.subagents-pane/trigger).

## §chat.slash-commands/tokens — Tokens

- **Menu.** `--color-surface` with a `--color-border` edge, `--r-md`, `--shadow-2`, and
  `max-height: min(320px, 40vh)`. It sits `--space-3 + --space-1` above the composer's content,
  on `z-index: 5` inside the composer's own stacking context.
- **Head.** Eyebrow style (`--font-mono`, `--fs-micro`, `--ls-eyebrow`) in `--color-ink-muted`.
- **Rows.** `--control-md` minimum. Name in `--font-mono` / `--fs-mono` / `--color-ink`.
  Description `--fs-caption` in `--color-ink-muted`; location `--font-mono` in
  `--color-ink-muted`. Hover and active use `--color-sunken`, and active adds the
  `--focus-ring` inset.
- **Chip.** The neutral `.chip`: `--color-ink-2` on `--color-surface`, with a `--color-border`
  edge.

## §chat.slash-commands/contrast — Contrast

| Pair | Dark | Light |
|---|---|---|
| Ink on surface or sunken (name) | 12.34 / 13.43 | 17.86 / 14.78 |
| Muted on surface or sunken (description, location) | 4.96 / 5.40 | 5.74 / 4.75 |
| Ink-2 on surface (chip) | 7.03 | 8.72 |
| Accent ring on sunken | 5.08 | 5.63 |

---

