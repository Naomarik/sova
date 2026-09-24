# §chat/playbooks — 04i · Playbooks
> Part of the Sova design spec · [overview](../design/overview.md)

A playbook is a markdown recipe an agent runs against a project: "audit this repo's
accessibility", "write the launch notes". The recipe does not depend on any one project. You
pick one from the composer flyout (§4), add a line of your own if you want, and it goes into the
current chat as your turn, through the chat's ordinary send path.

## §chat.playbooks/where-playbooks-come-from — Where playbooks come from

`GET /api/playbooks?cwd=…` returns a `PlaybookCatalog` (`shared/protocol.ts`), built by
`server/playbooks.ts`. It rescans three folders on every request, with no watch and no cache.
The dialog fetches once each time it opens.

| Group | `source` | Folder | Notes |
|---|---|---|---|
| **Sova** | `sova` | `playbooks/` at the Sova repo root | Shipped with Sova |
| **Yours** | `user` | `~/.pi/agent/sova/playbooks/` | Your own. An id that matches a shipped one **replaces** it: the shipped entry is dropped and yours carries `replacesSova: true`. The interface deliberately **does not render** that flag: the row already sits under the Yours heading, so a marker would only repeat it. The field exists in the data, asserted in `server/playbooks.test.ts` |
| **This project** | `project` | `<cwd>/.sova/marketing/playbooks/` | Generated for one project. It never replaces anything. It is always its own group, even when an id matches one above |

**The grammar is the same in all three folders.** A playbook is a directory `<id>/` holding a
`PLAYBOOK.md`, plus whatever `phases/` or `templates/` its body tells the agent to read.

- `id` is the directory name and must match `^[a-z0-9][a-z0-9-]*$`, so no dot entries and no
  separators. Other names are skipped. So is a child that isn't a directory (symlinks are
  followed) or has no readable `PLAYBOOK.md`. One bad folder never hides the others.
- **Frontmatter** is a leading `---` fence of `key: value` lines. Values are single-line scalars.
  Matching quotes around a value are removed, and lines that aren't `key: value` are ignored. It
  is **not YAML**. Sova reads `title`, `description` and the optional `promptHint`: what you may
  want to say in the first turn.
- If `title` is missing, empty or whitespace-only, the id is used (`fields.title?.trim() || id`).
  If `description` is missing, it is empty (`?? ""`). An empty `description:` also stays empty. A file with no
  opening fence on line 1, or no closing fence, has no frontmatter: its whole text is the body,
  the title is the id and the description is empty.
- `body` is the text after the fence, with leading blank lines removed. `dir` is the playbook's
  **absolute** directory, which the sent turn names (below).

**Order.** Sova, then Yours, then This project. Each group is sorted by title,
case-insensitively, with the id breaking ties, so the order never depends on `readdir`. The
client groups and sorts the same way again (`src/lib/playbooks.ts`).

**An unreadable user folder** doesn't fail the request. The catalog carries `error`, still lists
everything else, and the dialog shows a caption line above the groups (§9). A user folder that
doesn't exist is simply empty.

## §chat.playbooks/the-project-listing — The project listing

`project.state` says whether This project could be listed. `message` gives the real reason when
it couldn't:

| State | When | Dialog shows |
|---|---|---|
| `ok` | The cwd is a local folder and its playbooks folder was read (or doesn't exist) | Its playbooks under This project. With none, no heading |
| `none` | No cwd was sent | Nothing |
| `remote` | The cwd is on a remote target, or is a retired sshfs mount | A caption note below the groups |
| `missing` | The cwd is relative, doesn't exist, isn't a folder, or can't be read. It is also `missing` when `<cwd>/.sova/marketing/playbooks/` exists but can't be read | A caption note below the groups |

The note is the **server's `message`**, which names the target or the folder and the actual
fault. A client fallback is used only when the server sent no message (§9).

**Remote is decided lexically, before `path-map.json`.** This is exactly how `/api/files`
(`server/files.ts`) decides it. A relative cwd is refused as `missing`, then a remote cwd is
refused, all before any filesystem call. Only a cwd that survives both goes through
`movedPath()` and then `stat`. This order matters: a remote placeholder must never be read as a
moved local folder, and a dead mount must never be stat'ed.

## §chat.playbooks/entry-point — Entry point

The composer flyout's menu panel has a **Playbooks** row after Commands (§4 "Composer flyout").
It closes the flyout and opens the dialog on step 1, or on step 2 of the playbook you left text
in (below).

- **Present only where `onPlaybooks` is passed**, which means chat sessions (`ChatView`).
  `WatchView` doesn't pass it, so the row is **absent** there. That covers TUI-live sessions and
  every other watch view.
- **Disabled while the composer is blocked.** The row is `aria-disabled`, with
  `aria-describedby="composer-reason"` pointing at the composer's own reason line. That covers
  connecting, reconnecting, not connected, an archived pane, saving a turn, and a model switch in
  flight (§4 "Disabled states"). It is the same treatment Attach images gets, not `Fan Out…`'s
  absence.

## §chat.playbooks/the-modal — The modal

One `.modal`, ≤520px, opened with `trapFocus` in a portal. It has two steps **inside the same
modal**, and only one renders at a time: step 2 never stacks on step 1. The modal title is
`Playbooks` on step 1 and the playbook's own title on step 2.

```html
<div class="scrim"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="playbooks-title" tabindex="-1">
  <div class="modal-head"><h2 class="modal-title" id="playbooks-title">Playbooks</h2></div>

  <!-- step 1 -->
  <div class="modal-body">
    <!-- user folder unreadable: <p class="text-caption text-muted">…</p> -->
    <div role="group" aria-labelledby="playbooks-group-sova">
      <h3 class="list-group-label" id="playbooks-group-sova">Sova</h3>
      <div class="list">
        <!-- roving tabindex: exactly one row is tabindex="0" -->
        <button type="button" class="list-row list-row-interactive" tabindex="0" title="{description}">
          <span class="list-main">
            <span class="list-line"><span class="list-title">Accessibility audit</span></span>
            <span class="list-line list-meta-row"><span class="list-meta">Walk every screen and file what fails WCAG 2.2 AA.</span></span>
          </span>
          <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    …Yours, This project: only the groups that have rows…
    <!-- project remote / missing: <p class="text-caption text-muted">{message}</p> -->
  </div>
  <div class="modal-foot"><span class="modal-spacer"></span><button type="button" class="button">Close</button></div>

  <!-- step 2, in place of step 1's body and foot; the head's .modal-title now reads the
       playbook's title ("Accessibility audit"), so the body doesn't repeat it -->
  <div class="modal-body">
    <p class="text-caption text-muted">Walk every screen and file what fails WCAG 2.2 AA.</p>
    <div class="field">
      <label class="field-label" for="playbooks-text">Anything to add</label>
      <span class="field-hint" id="playbooks-hint">{promptHint}</span>
      <textarea class="input textarea" id="playbooks-text" aria-describedby="playbooks-hint"></textarea>
    </div>
  </div>
  <div class="modal-foot">
    <button type="button" class="button button-ghost">Back</button>
    <!-- blocked only: <span class="text-caption text-muted" id="playbooks-reason">{icon} {reason}</span> -->
    <span class="modal-spacer"></span>
    <button type="button" class="button button-primary">Send Playbook</button>
  </div>
</div>
```

### Step 1 · The catalog

- Groups appear in the order Sova · Yours · This project. **A group with no rows has no
  heading.** The remote/missing note is a caption after the groups, not a heading of its own.
- **Each row is one whole-row target**: a `button.list-row` at the 44px row convention, with no
  nested controls. The title sits over the description. The description **truncates to one
  line**, and the full text is in the row's `title`. A playbook with no description shows only
  its title. Activating a row goes to step 2.
- **Keyboard** follows the flyout's roving-tabindex pattern (§4 "Keyboard"): exactly one row is in
  the Tab order, `↑`/`↓` move across all groups and wrap, and `Home`/`End` jump to the ends. The
  modal takes focus on open, and when the catalog arrives focus moves to the **first row**. The
  same happens after `Retry`: its button disappears with the banner, and focus would otherwise
  fall to `<body>`. `Tab` goes from the row to `Close`.
- `Esc`, `Close` or a click on the scrim closes the modal. Focus returns to the composer's
  `plus` trigger.

### Step 2 · The playbook

- The modal title is the playbook's title. The body shows its description, without repeating
  the title, then the textarea labelled `Anything to add`. If the playbook has a `promptHint`, it appears as the textarea's
  `.field-hint`; otherwise there is no hint.
- Focus lands in the textarea. **`Enter` inserts a newline. `Ctrl+Enter` / `⌘+Enter` sends**,
  the same as `Send Playbook`. **An empty textarea can send**: the playbook alone is a complete
  turn.
- `Back` or `Esc` returns to step 1 with focus on the row you came from. The catalog is not
  fetched again. What you typed stays **with that playbook** (below). Picking a different one
  shows that playbook's own text, which is empty if you never wrote any.
- **`Send Playbook`** hands the text (below) to the chat's send. If the socket accepts it, the
  dialog closes and **focus goes to the composer's textarea** (`composer-input`, through
  `ChatView`'s `focusComposer()`), as after any send (§4 "Focus"). A close without sending
  (`Close` or `Esc` on step 1, or the scrim on either step) returns focus to the `plus` trigger
  (`composer-menu-trigger`) instead. If the socket refuses it right away, the dialog stays open
  with everything as it was. The label never changes, and there is no
  in-flight state: acceptance is immediate, and the turn after that belongs to the transcript.

### Typed text belongs to its playbook

Unsent text is a `PlaybookDrafts` (`src/lib/playbooks.ts`): one text **per playbook**, keyed by
`playbookKey()` (`source:id`), plus `last`, the playbook opened last. The dialog keeps one of
these **per session for the page's lifetime**, in memory only, so a reload loses it.

- The textarea always shows the **chosen playbook's own text** (`playbookDraft`). A note written
  for A never shows up in B and is never sent with B. Going Back to A restores A's text.
- Typing updates only that playbook's entry and makes it `last` (`setPlaybookDraft`).
  Whitespace-only text removes the entry instead of storing it.
- Closing unsent (`Close`, `Esc` on step 1, the scrim) keeps every entry. Reopening in that
  session lands on step 2 of `last` if that playbook is still in the catalog. The close can be
  forced (the Reconnect button sits under the scrim), and that must not throw the text away.
- **Sending clears only that playbook's entry** (`sentPlaybookDraft`), and `last` too if it
  pointed there. Other playbooks keep their text.
- A session keeps nothing once no playbook has text (`playbookDraftsEmpty`). That includes
  `last`, so a reopening with no text anywhere starts on step 1.
- The composer's own draft is untouched, except in the orphan case below.

## §chat.playbooks/what-gets-sent — What gets sent

`playbookTurnText()` in `src/lib/playbooks.ts`, pinned by `src/lib/playbooks.test.ts`, builds
exactly:

```
Playbook: <title> — <absolute dir>
Read the files in that directory as the playbook directs.

<body>
```

and, when you wrote something, appends:

```

---

<your text, trimmed>
```

(In code, that is `\n---\n\n<text>\n` after the body.) Whitespace-only text adds nothing: no
separator and no filler. The body goes through **verbatim**. The SDK expands prompt templates
and skills on the way in, so anything that looks like one must arrive intact.

The first line is always plain prose, so **the text can never begin with `/`**, which Sova would
dispatch as an extension command (§4d). It names the **absolute** directory because the body
refers to its `phases/` and `templates/` by relative path, and the session's cwd is a different
folder.

The transcript shows the result as your message (§3), with no special styling.

**Mid-turn it is a follow-up, never a steer.** The dialog always sends a `prompt` frame
(`ChatView.send(text, false, [])`), even while a turn is streaming. The server's `acceptPrompt`
queues a streaming-time prompt as `kind: "followUp"`, which shows as a **removable queue row**.
`handOffQueued` then hands it to `session.prompt(text, { streamingBehavior: "followUp" })` while
the turn is still streaming, or starts it as the next turn once that one has ended, so it
**runs after the current turn**. That is the opposite of the composer's own mid-turn Send, which
becomes `Steer` and sends `{type:"steer"}` into the running turn (§4 "While streaming"). The
difference is deliberate: a whole playbook steered into a running turn would derail it. A line
of steering is a correction; a playbook is a new job.

Because it uses the ordinary send path, a playbook turn gets the same model policy, the same
ack, and the same restore on refusal as any other message.

## §chat.playbooks/when-sending-stops-being-possible — When sending stops being possible

| What happens | Result |
|---|---|
| The composer becomes blocked while the modal is open (socket drop, reconnecting, archiving, saving, model switch) | The modal **stays open** with your text and your playbook. On step 2, `Send Playbook` is `aria-disabled`, and the composer's own reason (icon and words) shows beside `Back` as its description. A forced click sends nothing. It re-enables by itself when the reason clears |
| The chat's model is turned off in Settings → Models | Treated as blocked, with the reason "{ref} is turned off in Settings → Models. Pick another model, then send this again." |
| A TUI takes the session, or another program writes to it | `SessionView` swaps `ChatView` for `WatchView`, and **the dialog is removed with it**. The **open playbook's** text (the one on step 2, or `last` on step 1) is moved to the **top of that session's composer draft** (`onOrphan`), above any existing draft with a blank line between, and its entry is removed from the dialog's copy so it exists in one place only. Text kept for other playbooks stays in the dialog's per-session copy |

## §chat.playbooks/states — States

| State | Shows |
|---|---|
| Loading | Nothing for 300ms, then two `.skeleton-row`s. No spinner |
| Load failed | `.banner-error`: title `Couldn't load the playbooks.`, the real reason as its body, and a `Retry` action that fetches again, after which focus goes to the first row. `Close` still closes |
| No rows in any group | The line `No playbooks yet.` The project note, if any, still follows it |
| User folder unreadable | A caption above the groups. Everything else lists as usual |
| `project` `remote` / `missing` | The caption note after the groups (above) |
| Blocked, on step 2 | See "When sending stops being possible" |

## §chat.playbooks/rules — Rules

- **One modal, never stacked.** Step 2 replaces step 1 inside the same `.modal`.
- **Sending is the chat's send.** There is no separate endpoint or queue, and no special bubble.
  The one difference is the frame type: always `prompt`, never `steer`.
- **Overrides are whole, and only Yours can make one.** A user playbook with a shipped id
  replaces the shipped one outright. A project playbook replaces nothing.
- **The header line is not optional.** Without it, a body beginning with `/` would run as a
  command.
- **Typed text is never silently dropped, and never crosses playbooks.** It is kept per
  playbook when the dialog closes, and moved to the draft when the chat view goes away.

## §chat.playbooks/classes — Classes

| Need | Classes |
|---|---|
| Modal | `.scrim` `.modal` `.modal-head` `.modal-title` `.modal-body` `.modal-foot` `.modal-spacer` |
| Groups and rows | `.list-group-label` `.list` `button.list-row.list-row-interactive` `.list-main` `.list-line` `.list-meta-row` `.list-title` `.list-meta` |
| Step 2 | `.field` `.field-label` `.field-hint` `.input.textarea` · reason `.text-caption.text-muted` |
| States | `.skeleton.skeleton-row` `.banner-error` · notes `.text-caption.text-muted` · empty `.text-muted` |

## §chat.playbooks/tokens — Tokens

No new ones. The modal's own set, the list rows' `--row-height` minimum, `--fs-caption` and
`--color-ink-muted` for descriptions and notes.

**All user-facing strings are in §9 · Copy deck.**

---
