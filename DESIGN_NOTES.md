# pi-web — Design Notes

The UX spec for the pi-web MVP. The frontend builds exactly this with plain SolidJS and two
stylesheets — no component library.

- **System.** fold-ai-dev design system v1.8.0 (`.claude/skills/fold-ai-dev-design/`), rebranded
  as pi-web. Where these notes don't say otherwise, the skill's rules apply: `SKILL.md` for
  anything that spans components, `reference/components/*.md` for how each component is built.
- **Stylesheets.** `src/design/tokens.css`, then `src/design/base.css`. Import both once, in that
  order, from `src/main.tsx`. Every class named here is defined in `base.css`.
- **Assets.** Vite serves `public/` at the site root: `/fonts/*.woff2`, `/icons/*.svg`,
  `/favicon.svg`.

### Class index (all in `src/design/base.css`)

| Need | Classes |
|---|---|
| App shell | `.app[data-view="list\|session"]` `.app-sidebar` `.app-main` `.app-back` `.pane` `.skip-link` |
| Sidebar | `.sidebar-head` `.brand` `.sidebar-spacer` `.sidebar-search` `.sidebar-list` |
| Search | `.search` (wraps `.icon` + `input.input` + clear `.button.button-icon`) `.search-count` |
| Session rows | `.session-group` `.list-group-label` `.session-group-path` (+ `<bdi>`) `.list` `.list-row.list-row-interactive.session-row` `[aria-current="page"]` `.list-main` `.list-title` `.list-meta` |
| LIVE badge / status | `.chip` `.chip-dot` `.chip-accent` `.chip-live` `.chip-success` `.chip-error` `.chip-warn` `.chip-info` `.chip-count` |
| Buttons | `.button` `.button-primary` `.button-destructive` `.button-ghost` `.button-sm` `.button-icon` (needs `aria-label`) |
| Icons | `.icon` (20px) `.icon-sm` (16px) `.icon-twist` (rotates in open disclosures). Works on an inline `<svg>` or a mask `<span class="icon" style="--icon:url(/icons/x.svg)">` |
| Modal | `.scrim` `.modal` `.modal-head` `.modal-title` `.modal-body` `.modal-foot` `.modal-spacer` `.folder-list` |
| Form fields | `.field` `.field-label` `.field-hint` `.field-error` `.input` `.input-mono` `.textarea` |
| Main head | `.session-head` `.session-head-main` `.session-head-title` `.session-head-meta` |
| Transcript | `.transcript` (+ `.pane`) `.transcript-banner` `.transcript-inner` `.thread` |
| Messages | `.message` `.message-user` `.message-streaming` `.message-head` `.message-author` `.message-time` `.message-body` `.message-text` |
| Thinking / raw JSON | `details.disclosure` `.disclosure-summary` `.disclosure-label` `.disclosure-preview` `.disclosure-body` |
| Tool card | `details.toolcard` `.toolcard-summary` `.toolcard-name` `.toolcard-arg` `.toolcard-body` `.toolcard-section` `.toolcard-section-label` `.toolcard-output` `.toolcard-output-error`. The running, done and failed states are chips (§3) |
| Info / unknown row | `.info-row` `.info-row-text` |
| Banner | `.banner` `.banner-info` `.banner-warn` `.banner-error` `.banner-success` `.banner-icon` `.banner-main` `.banner-title` `.banner-body` `.banner-action` |
| Streaming | `.live-dot` `.run-status` `.run-status-detail` `.jump-latest` |
| Composer | `.composer` `.composer-inner` `.composer-row` `.composer-input` (with `.input.textarea`) `.composer-actions` `.composer-foot` `.composer-reason` `.composer-hint` |
| Empty / loading | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` · `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| Toast | `.toast-stack` `.toast` `.toast-body` |
| Utilities | `.stack` `.stack-2` `.cluster` `.spread` `.truncate` `.measure` `.visually-hidden` `.text-mono` `.text-caption` `.text-muted` `.text-error` `.text-eyebrow` `.text-num` |

**All user-facing strings are in §9 · Copy deck.**

There is **no spinner**, on purpose. The system allows one loading language per surface:

- Regions that are loading get skeletons, after 300ms.
- Work in progress gets `.live-dot` plus words (for example "Working · running bash").
- Buttons that are pending change their label (for example "Creating…") and carry
  `aria-disabled`.

---

## 0 · Ground rules

### Theme

Dark is the default. `<html>` with no attribute renders dark; `<html data-theme="light">` renders
the full light set. MVP ships no theme toggle. If one is added later, persist it in
`localStorage` and set the attribute before first paint.

### Icons

Inline the SVG markup. Don't use `<img>`, because an image can't pick up `currentColor` or the
theme. Add `class="icon"` (20px) or `class="icon icon-sm"` (16px) to the `<svg>`, and add
`aria-hidden="true"` whenever a text label sits next to it. An icon-only button gets its name from
`aria-label`, never from the SVG.

Two supported forms, both inheriting `currentColor`:

- **Mask span (used by the frontend):**
  `<span class="icon" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>`. `base.css`
  turns the file into a mask over `currentColor`. `.icon-sm` and `.icon-twist` work the same way.
- **Inline `<svg class="icon">`**, with the markup copied from the file.

Either way, the icon only reaches the theme through `currentColor`, which is the rule the skill
cares about. Every icon uses a 24-unit viewBox, a 1.5 stroke, round caps and joins,
and `fill="none" stroke="currentColor"`.

| File (`/icons/…`) | Used for |
|---|---|
| `pi-web-mark.svg` | Brand mark in the sidebar head (accent colored). pi-web's own mark, drawn on the system grid |
| `plus.svg` | New Session |
| `search.svg` | Search field glyph; tool card for `grep` / `find` / `ls` |
| `close.svg` | Clear search, close dialog |
| `chevron-left.svg` | Back to list (folded width only) |
| `chevron-right.svg` | Disclosure twist (rotates 90° when open) |
| `chevron-down.svg` | Jump to Latest |
| `terminal.svg` | Live-from-TUI banner, and the tool card for `bash` |
| `file.svg` | Tool card for `read` / `write` / `edit` |
| `more.svg` | Tool card for any other tool |
| `copy.svg` | Copy Session Path, Copy Output |
| `check.svg` | The copy button's icon for 1.5s after a copy |
| `folder.svg` | Folder picker rows, cwd group label |
| `info.svg` | Info rows, info banners |
| `alert-circle.svg` | Error banners, warn banners |
| `attention.svg` | Composer reason when the session is read only |
| `clock.svg` | "Reconnecting" reason |
| `refresh.svg` | Refresh Sessions: an icon button in `.sidebar-head`, before New Session, with `aria-label="Refresh Sessions"`. While fetching it's `aria-disabled` and the list keeps its rows |
| `arrow-right.svg` | Send |
| `pause.svg` | Stop Turn |
| `chat.svg` | Empty-state mark (no session selected) |
| `check-circle.svg`, `x-circle.svg`, `external.svg`, `menu.svg`, `branch.svg` | Reserved. Shipped but unused in the MVP |

`/favicon.svg` is the mark on dark paper. Link it from `index.html`:
`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`.

### Voice (fold-ai-dev, en-US)

Four pillars, all at once: calm, concrete, warm, and candid. The rules that matter most here:

- Buttons use **Title Case** and name their object: `New Session`, `Create Session`, `Stop Turn`,
  `Copy Session Path`. All other text is sentence case.
- Use digits, never spelled-out numbers ("3 sessions"). Relative time in lists ("2h ago",
  "yesterday", then "Mar 4"). A 24-hour clock in mono inside the transcript (`14:06`).
- No exclamation marks, no apologies, no "Oops". An error has three beats: what happened · what it
  means for your work · what to do next.
- "We" means the product. Refer to the agent by its model id (for example `claude-opus-5`), and
  to the user as "you".
- An empty state leads with a live fact and states the absence second.

### Color budget

Spend `--color-accent` on only three things:

1. The one primary button in view (Send, or Create Session inside the dialog).
2. The live indicator (`.chip-live` and `.live-dot`).
3. Focus rings and links.

Selected rows and user bubbles take `--color-accent-tint`. Anything else that "needs color" is a
status (`--status-*`), and always pairs a dot or icon with a word.

### Motion

State changes use `--dur-fast` and `--ease-standard`. The modal, scrim, toast, and Jump to Latest
fade in over `--dur-base`. Only two things loop:

- The `live-pulse` on `.chip-live .chip-dot` and `.live-dot`. It means work is happening now.
- The skeleton sweep.

No typing cursor blinks, and streamed text simply appears. `tokens.css` turns off every animation
under `prefers-reduced-motion`.

---

## 1 · App shell

```
unfolded (≥768)                                  folded (<768)
┌──────────────┬───────────────────────────┐     ┌──────────────────┐
│ sidebar-head │ session-head              │     │ list  OR  session│
│ search       ├───────────────────────────┤     │ (data-view)      │
│ session list │ [live banner, sticky]     │     │                  │
│  (pane)      │ transcript (pane)         │     │                  │
│              ├───────────────────────────┤     │                  │
│              │ composer                  │     │                  │
└──────────────┴───────────────────────────┘     └──────────────────┘
```

```html
<a class="button skip-link" href="#transcript">Skip to Transcript</a>
<div class="app" data-view="list|session">
  <aside class="app-sidebar" aria-label="Sessions">…§2…</aside>
  <main class="app-main">…§3 head, transcript, composer…</main>
</div>
<!-- Portals (render at the body, never inside a .pane): scrim + modal, .toast-stack, live region -->
```

- **Columns.** `.app` is `height: 100dvh`. At 768px and up the grid is `--sidebar-width` (320px)
  plus `1fr`, with a border between the columns. Below 768px it's one column, and `data-view`
  decides which one shows: `list` when no session is selected, `session` when one is. The shell
  is window chrome, so it uses `@media` rather than a container query, the same reasoning the
  skill gives for `.toast-stack`.
- **Scrolling.** The session list and the transcript each carry `.pane`, so each is an
  independent scroll region. The page itself never scrolls.
- **Routing.** Keep the selected session in the URL, e.g. `#/s/<encodeURIComponent(path)>`. That
  way reload and back work, and the folded back button is `history.back()` or a link to `#/`.
- **No rail and no bottom bar.** pi-web has one destination, so there's no nav to place. This is
  a deliberate departure from the skill's three-pane desktop shell: the ≥1120 `desktop` band adds
  nothing here.
- **Dialogs** follow the skill's modal pattern and become a bottom sheet under 768px
  automatically (`.modal` restyles itself).
- **Toasts** go in one `.toast-stack` portal. Use them only for "Copied path." / "Copied output."
  A toast is never the only record of a fact, so errors go in banners.

---

## 2 · Session list (sidebar)

### Anatomy

```html
<aside class="app-sidebar" aria-label="Sessions">
  <div class="sidebar-head">
    <a class="brand" href="#/"><svg class="icon" aria-hidden="true">…pi-web-mark…</svg>pi-web</a>
    <span class="chip chip-accent chip-live chip-count" title="Sessions open in a TUI">
      <i class="chip-dot"></i>2 live</span>            <!-- only when ≥1 live -->
    <span class="sidebar-spacer"></span>
    <button class="button" type="button"><svg class="icon" aria-hidden="true">…plus…</svg>New Session</button>
  </div>

  <div class="sidebar-search" role="search">
    <label class="visually-hidden" for="session-search">Search sessions</label>
    <div class="search">
      <svg class="icon" aria-hidden="true">…search…</svg>
      <input class="input" id="session-search" type="search" placeholder="Title, folder, or model"
             aria-describedby="session-count" autocomplete="off" spellcheck="false">
      <!-- only when the query is non-empty -->
      <button class="button button-icon" type="button" aria-label="Clear Search">…close…</button>
    </div>
    <p class="search-count" id="session-count" aria-live="polite">12 of 48 sessions</p>
  </div>

  <nav class="sidebar-list pane" aria-label="Session list">
    <section class="session-group" aria-labelledby="g-1">
      <h2 class="list-group-label" id="g-1" title="/home/user/webapps/pi-web">
        <svg class="icon icon-sm" aria-hidden="true">…folder…</svg>
        <span class="session-group-path"><bdi>~/webapps/pi-web</bdi></span>
        <span class="text-num">4</span>
      </h2>
      <ul class="list">
        <li>
          <a class="list-row list-row-interactive session-row" href="#/s/…" aria-current="page">
            <div class="list-main">
              <p class="list-title">Add a watch endpoint for TUI sessions</p>
              <p class="list-meta">2h ago · <span class="text-mono">claude-opus-5</span></p>
            </div>
            <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Live</span>
          </a>
        </li>
      </ul>
    </section>
  </nav>
</aside>
```

### Content rules

- **Grouping.** Group by `cwd`. Groups are ordered by their most recent `lastActiveAt`. Rows
  within a group are ordered by `lastActiveAt`, newest first. Each group label shows three
  things:
  - the path with `$HOME` shown as `~` (mono, and case is preserved),
  - the full path in `title`,
  - a count of the rows currently visible.

  Long paths truncate **from the left**, because the leaf folder is what people scan for. The
  `rtl` + `<bdi>` pair in `.session-group-path` handles this. Labels stick to the top while their
  group scrolls.
- **Row line 1.** `SessionSummary.title`, truncated to one line; the full title goes in `title=`.
  `Untitled` renders in `--color-ink-muted`.
- **Row line 2.** Relative `lastActiveAt` ("just now", "4m ago", "2h ago", "yesterday", "Mar 4"),
  then ` · `, then the model in mono. Show only the part after the first `/` and put the full
  `provider/model` in `title`. If `model` is null, omit the separator and the model.
- **LIVE badge.** Shown when `live !== null`: `.chip.chip-accent.chip-live` with the word `Live`.
  The pulse is justified because it means "a TUI is running this right now". Never show the dot
  without the word.
- **Live count** in the sidebar head: `N live` as `.chip-count`, shown only when N ≥ 1.
- **Selection.** The row for the open session gets `aria-current="page"`, which the stylesheet
  tints with `--color-accent-tint`. The tint is never the only signal, because the head of the
  main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

### Search

- **Matching.** Case-insensitive substring match on `title`, `cwd`, and `model`, filtered on the
  client as the user types (no debounce needed for fewer than 2k rows).
- **Empty groups.** A group with no matching rows is hidden.
- **Count.** `.search-count` always shows `{visible} of {total} sessions`, and just
  `{total} sessions` when the query is empty. It lives beside the filter it answers to,
  following the filter-bar rule.
- **Keys.** `/` anywhere, while focus isn't in a text field, focuses search. `Esc` inside search
  clears the query first, then blurs on a second press. Clear Search returns focus to the input.

### States

| State | What renders |
|---|---|
| Loading (first fetch, after 300ms) | 6 × `<div class="skeleton skeleton-row">` inside `.sidebar-list`, separated by `--space-2`. Put `aria-busy="true"` on the `nav`. Nothing appears before 300ms |
| Error | `.banner.banner-error` at `--space-3` inset, with `alert-circle`. Title: "Couldn't read your sessions." Body: "`~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry." `.banner-action`: `<button class="button button-sm">Retry</button>`. If rows loaded earlier, keep them visible below the banner |
| Empty (0 sessions on disk) | `.empty`. Title: "0 sessions in `~/.pi/agent/sessions`." Body: "Start one here, or run `pi` in a terminal. It'll show up in this list." One `.empty-action`: `New Session` (secondary) |
| No matches | `.empty`. Title: "0 of 48 match “{query}”." Body: "We search titles, folders, and models." Action: `<button class="button">Clear Search</button>` |

### Tokens

Sidebar ground `--color-surface`. Row hover `--color-sunken`. Selected `--color-accent-tint`.
Title `--color-ink`, `--fw-medium`, `--fs-body`. Meta `--color-ink-muted`, `--fs-caption`. Group
label `--font-mono`, `--fs-mono`, `--color-ink-muted`. Row padding `--space-2` / `--space-4`,
`min-height: --row-height`. Head `min-height: 56px`, border `--color-border`. Brand is
`--fw-display`, letter-spacing −.03em, and `--fs-heading-s`. The mark takes `--color-accent`; the
word never does.

### Accessibility

- **Landmarks.** `aside[aria-label="Sessions"]` > `nav[aria-label="Session list"]`. Each group is
  a `section` labelled by its `h2`. Rows are plain links in a `ul`, so the browser provides
  Tab/Enter behavior with no roving tabindex.
- **Selected row.** Mark it with `aria-current="page"`.
- **Chips are text.** The LIVE chip reads "Live" in the link's name. Don't hide it from AT.
- **Contrast.** Ink on surface is 12.34 (dark) and 17.86 (light). Muted on surface is 4.96 and
  5.74. Muted on tint is 5.06 and 4.68. Accent on surface is 4.67 and 6.81. Accent on tint is
  4.76 and 5.55. All clear AA 4.5.
- **Folded width.** Opening a row sets `data-view="session"`. Move focus to the session head
  title (`tabindex="-1"`) so screen readers announce the new context.

---

## 3 · Transcript (main pane)

### Anatomy

```html
<main class="app-main">
  <header class="session-head">
    <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…chevron-left…</a>
    <div class="session-head-main">
      <h1 class="session-head-title" tabindex="-1">Add a watch endpoint for TUI sessions</h1>
      <p class="session-head-meta">
        <span class="text-mono" title="/home/user/webapps/pi-web">~/webapps/pi-web</span>
        <span aria-hidden="true">·</span>
        <span class="text-mono">claude-opus-5</span>
      </p>
    </div>
    <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Live</span>   <!-- live only -->
    <button class="button button-icon button-ghost" aria-label="Copy Session Path">…copy…</button>
  </header>

  <section class="transcript pane" id="transcript" aria-label="Transcript">
    <div class="transcript-banner">…live banner, live only…</div>
    <div class="transcript-inner">
      <div class="thread">…items…</div>
    </div>
    <button class="button jump-latest">…chevron-down… Jump to Latest · 3 new</button>  <!-- conditional -->
  </section>

  <footer class="composer">…§4…</footer>
</main>
<div class="visually-hidden" role="status" aria-live="polite"><!-- turn announcements --></div>
```

- **Head title.** Uses `.session-head-title`, a single line with the full text in `title`. The
  `h1` is sized as a heading-s on purpose: the page is dense and the title is chrome, not a
  display headline.
- **Copy Session Path.** Copies `path`. Its icon swaps to `check` for 1.5s and a toast says
  "Copied path." Nothing else changes.

### Transcript items (by `TranscriptItem.kind`)

Render items in array order. The column is `.thread` (gap `--space-4`) inside `.transcript-inner`,
centred at 72ch plus 96px. Messages cap at `--measure`.

**user.** A right-aligned tinted bubble.

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head"><span class="message-author">You</span><span class="message-time">14:06</span></div>
  <div class="message-body message-text">{text}</div>
</article>
```

**assistant-text.** A left-aligned surface bubble. The author is the session's model id (short
form), or `pi` when unknown. Consecutive assistant-text items in one turn share one head: render
the head only on the first.

```html
<article class="message">
  <div class="message-head"><span class="message-author text-mono">claude-opus-5</span><span class="message-time">14:06</span></div>
  <div class="message-body message-text">{text}</div>
</article>
```

MVP renders plain text with `white-space: pre-wrap` (`.message-text`). If markdown is added later,
drop `.message-text`. `.message-body` already styles `p`, `ul`, `ol`, inline `code`, and `pre`.
Don't syntax-highlight in accent colors; the accent means action.

**thinking.** Collapsed by default. A native `<details>`, so it needs no script and AT announces
expanded or collapsed.

```html
<details class="disclosure">
  <summary class="disclosure-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <span class="disclosure-label">Thinking</span>
    <span class="disclosure-preview">· {first line of text, ~80 chars}</span>
  </summary>
  <div class="disclosure-body">{text}</div>
</details>
```

While thinking streams, the summary shows `<span class="live-dot"></span>` after the label. The
preview updates live and the disclosure stays closed unless the user opened it. If the user opens
it, keep it open across updates, because the open state is theirs.

**tool-call and tool-result.** One card per call. Pair them by `toolCallId`, and render the card
at the tool-call's position. A result with no matching call gets its own card with the name
"result".

```html
<details class="toolcard">
  <summary class="toolcard-summary">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    <svg class="icon icon-sm" aria-hidden="true">…terminal|file|search|more…</svg>
    <span class="toolcard-name">bash</span>
    <span class="toolcard-arg">npm run typecheck</span>
    <span class="chip chip-success"><i class="chip-dot"></i>Done</span>
  </summary>
  <div class="toolcard-body">
    <div class="toolcard-section">
      <div class="toolcard-section-label">Arguments</div>
      <pre>{JSON.stringify(args, null, 2)}</pre>
    </div>
    <div class="toolcard-section">
      <div class="toolcard-section-label">Output <button class="button button-sm button-ghost">Copy Output</button></div>
      <pre class="toolcard-output">{result text}</pre>
    </div>
  </div>
</details>
```

- **Arg summary**, one line: `bash` → `command`; `read`/`write`/`edit` → `path` (or `file_path`);
  `grep`/`find` → `pattern`; otherwise the first string value in args. It's mono and truncated,
  with the full value in `title`.
- **Status chip.** The word always accompanies the dot.

  | State | Chip |
  |---|---|
  | No result yet and the session is streaming | `.chip.chip-accent.chip-live` "Running" |
  | Result is OK | `.chip.chip-success` "Done" |
  | Result is an error (`isError` in `raw`) | `.chip.chip-error` "Failed" |
  | No result and the session is not streaming | `.chip` "No result" (neutral) |

- **Errors.** Label the output section "Error" instead of "Output" and add
  `.toolcard-output-error`. The word carries the state, and the red border only reinforces it.
- **Long output.** Caps at `--tool-output-max` (320px) with its own scroll. Past 400 lines,
  render the first 200 and a `button-sm` "Show All 1,240 Lines".
- **Visibility.** Cards stay collapsed, but the summary row is always visible. The skill says tool
  turns are never hidden, since the record of what ran is the trust mechanism.

**info.** Model changes, compaction, labels, and branch summaries.

```html
<div class="info-row" role="note">
  <span class="info-row-text"><svg class="icon icon-sm" aria-hidden="true">…info…</svg>
    Model changed to <code>claude-opus-5</code></span>
</div>
```

Server `text` is used as-is. Put machine facts (ids, model names, counts) in `<code>`.

**unknown.** Render the same as info, with the text `Unrecognized entry <code>{raw.type}</code>`,
followed by a `.disclosure` labelled "Raw entry" that holds `<pre>` JSON. Never drop a row
silently.

**Timestamps.** Take them from `raw.timestamp` when present and format as 24-hour `HH:MM` in mono.
If the date isn't today, prefix `Mar 4 `. Put the full ISO string in `title`.

### Streaming (chat sessions)

Driven by `ChatServerMessage.event`.

- **Start of turn** (`agent_start` / `turn_start`). Append a pending assistant `.message` with the
  class `message-streaming`. Its head is `author` + `<span class="live-dot"></span>`.
  `text_delta` appends into its body; `thinking_delta` feeds a streaming `.disclosure` placed
  before it. `toolcall_start` adds a `.toolcard` with the Running chip.
- **Run status.** Above the textarea, inside `.composer-inner`:
  `<p class="run-status"><span class="live-dot"></span>Working<span class="run-status-detail">· running bash</span></p>`.
  The detail names the current tool, or says "· thinking" or "· writing". This is the loading
  pattern: say what's happening.
- **End of turn** (`agent_settled`, or `agent_end` if that's all you get). Remove the live dots
  and the run status. Replace the optimistic items with the server's canonical ones if it sends
  them. Announce "Reply finished." in the polite live region; announce nothing per delta.
- **Performance.** Batch deltas per animation frame. Never re-render the whole thread on each
  delta.

### Live-watch (TUI-owned sessions, `/ws/watch`)

- **Banner.** A sticky `.transcript-banner` at the top of the transcript pane:

  ```html
  <div class="banner banner-info" role="status">
    <svg class="icon banner-icon" aria-hidden="true">…terminal…</svg>
    <div class="banner-main">
      <p class="banner-title">Live from TUI — read only</p>
      <p class="banner-body">Open in pi (pid <span class="text-mono">889823</span>) · <span class="text-mono">Running: bash</span>. We only read this file.</p>
    </div>
  </div>
  ```

  The banner's status text comes from `live.status`; update it when the session list refreshes.
- **Appends.** `append` items fade in (the rows' `.message` uses no transform, so no animation is
  needed).
- **Auto-follow.**
  - *Following* means the transcript's scroll bottom is within 80px of the end. While following,
    every append or streamed delta scrolls to the bottom (`scrollTop = scrollHeight`, no smooth
    scroll).
  - When the user scrolls up past 80px, following stops and a `.button.jump-latest` appears:
    "Jump to Latest · N new". Clicking it scrolls to the end, resumes following, and removes the
    button.
  - Chat sessions follow the same logic while streaming.
  - Sending a message always resumes following.
- **When the TUI closes** (`live` goes null on refresh). The banner becomes
  `.banner.banner-info` with title "The TUI closed this session." and body "You can chat in it
  here now." Its `.banner-action` is `<button class="button button-sm">Open for Chat</button>`,
  which reconnects with `/ws/chat`.
- **Watch socket drops.** `.banner.banner-warn` with `alert-circle`. Title: "Stopped watching.
  The connection dropped." Body: "What's shown is up to `14:06`. Reconnecting…" When it
  reconnects, go back to the info banner. The snapshot replaces the list, and scroll position is
  kept if the user wasn't following.

### States

| State | What renders |
|---|---|
| No session selected (unfolded) | `.empty` in `.app-main`, with the `chat` icon in `.empty-mark`. Title: "48 sessions across 7 folders." Body: "Pick one to read it, or start a new one." `.empty-action`: `New Session` (secondary). No composer |
| Loading transcript (after 300ms) | Three placeholder messages in `.thread`: a right-aligned `.skeleton` 40% × 44px, then a left `.skeleton-title` plus 3 `.skeleton-line` at 92/78/60%, then a `.skeleton-row` at 60% width. Put `aria-busy="true"` on the `section`. The head renders straight away from the `SessionSummary` |
| Error | `.banner.banner-error` in `.transcript-inner`. Title: "Couldn't load this transcript." Body: "The file at `{path}` wasn't changed. {server message}." Action: `Retry` |
| Empty (new session) | `.empty`. Title: "New session in `~/webapps/pi-web`." Body: "Nothing sent yet. Your first message becomes its title." No action; focus the composer instead |
| Agent/server error (`type:"error"`, not busy) | `.banner.banner-error` placed as the last item of the thread (in flow, so it stays in the record). Title: "The turn stopped with an error." Body: "{message}. Your messages are kept. Send again to retry." |

### Tokens

- **Page and head.** Page `--color-bg`. Head `--color-surface` with bottom border `--color-border`.
- **Messages.**
  - Assistant bubble: `--color-surface` with `--color-border`, and `--r-lg`.
  - User bubble: `--color-accent-tint`, with no border.
  - Text: `--color-ink`.
  - Head: `--fs-caption` in `--color-ink-muted`. Author: `--fw-semibold` in `--color-ink`. Time:
    `--font-mono`.
- **Thinking.** Summary `--fs-caption` in `--color-ink-muted`. Label `--fw-medium` in
  `--color-ink-2`. Body `--color-ink-2`, left rule `--stroke-icon` in `--color-border`.
- **Tool card.** `--color-sunken`, `--r-lg`, and `--font-mono` / `--fs-mono`. Name `--fw-semibold`
  in `--color-ink`; arg `--color-ink-muted`. `pre` sits on `--color-surface` with `--r-sm`.
  Section labels use eyebrow styling (`--fs-micro`, `--ls-eyebrow`).
- **Info row.** `--fs-caption` in `--color-ink-muted`, with rules in `--color-border`.
- **Banners.**
  - Info: `--status-info-bg` with a `--status-info` icon.
  - Warn: `--status-warn-bg` with a `--status-warn` icon.
  - Error: `--status-error-bg` with a `--status-error` icon.
  - Title text is `--color-ink`; body is `--color-ink-2`.
- **Spacing.** Thread gap `--space-4`. Inner padding `--space-4` / `--space-6`.

### Accessibility

- **The transcript isn't `role="log"`.** Streaming deltas would flood the announcements. It's a
  labelled `section`. A single visually-hidden `role="status"` region announces turn boundaries:
  - "Working." at the start of a turn.
  - "Reply finished." at the end.
  - For watched sessions, "{n} new entries." throttled to at most once every 5s.
- **Articles.** Each message is an `article` with an `aria-label` like "You, 14:06" or
  "claude-opus-5, 14:07".
- **Disclosures** are native `<details>`/`<summary>`: Enter and Space toggle them and their state
  is announced. Don't add click handlers that call `preventDefault`.
- **Keyboard.** Tab order runs head → banner action (if any) → transcript disclosures and cards →
  Jump to Latest → composer. The transcript `section` is focusable (`tabindex="0"`) so keyboard
  users can scroll it with the arrow keys and PageUp/PageDown.
- **Contrast.**

  | Pair | Dark | Light |
  |---|---|---|
  | Ink on accent-tint (user bubble) | 12.57 | 14.57 |
  | Ink-2 on sunken (thinking body; tool card sits on sunken) | 7.65 | 7.22 |
  | Muted on sunken | 5.40 | 4.75 |
  | Ink on info-bg | 11.07 | 15.57 |
  | Ink-2 on info-bg | 6.30 | 7.60 |
  | Info icon on info-bg | 5.33 | 5.55 |
  | Ink-2 on error-bg | 6.48 | 7.49 |
  | Error on error-bg | 5.01 | 5.16 |
  | Ink-2 on warn-bg | 6.02 | 7.78 |
  | Success on surface (chips) | 6.61 | 6.09 |
  | Error on surface (chips) | 5.42 | 6.01 |

---

## 4 · Composer

### Anatomy

```html
<footer class="composer">
  <form class="composer-inner" aria-label="Message the agent">
    <!-- while streaming only -->
    <p class="run-status"><span class="live-dot"></span>Working<span class="run-status-detail">· running bash</span></p>

    <div class="composer-row">
      <label class="visually-hidden" for="composer-input">Message</label>
      <textarea class="input textarea composer-input" id="composer-input" rows="1"
                placeholder="Ask pi to…" aria-describedby="composer-reason"></textarea>
      <div class="composer-actions">
        <!-- streaming only; kept apart from Send by the gap -->
        <button class="button button-destructive" type="button">…pause… Stop Turn</button>
        <button class="button button-primary" type="submit">…arrow-right… Send</button>
      </div>
    </div>

    <div class="composer-foot">
      <span class="composer-reason" id="composer-reason"><!-- reason when disabled; else empty --></span>
      <span class="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
    </div>
  </form>
</footer>
```

### Behavior

- **Auto-grow.** The textarea grows from 1 line (44px) up to `--composer-max` (40vh), then
  scrolls. `field-sizing: content` handles it in Chromium. As a fallback, on input set
  `style.height = "auto"` and then `style.height = scrollHeight + "px"`.
- **Keys.**
  - `Enter` sends.
  - `Shift+Enter` inserts a newline.
  - Ignore `Enter` while `event.isComposing` (IME).
  - Empty or whitespace-only text doesn't send, and Send is `aria-disabled` with no reason text,
    because the reason is obvious.
- **Send.** Sends `{type:"prompt"}`. Clear the textarea only after the socket accepts the message.
  Show the user bubble optimistically and resume auto-follow.
- **While streaming.** Send stays available and its label changes to `Steer`, which sends
  `{type:"steer"}`. The placeholder becomes "Steer the current turn…". `Stop Turn`
  (`.button-destructive`, outlined, never filled) sends `{type:"abort"}`. Show it only while
  streaming. `Esc` does **not** abort, to prevent accidental stops.
- **After Stop Turn.** The status reads "Stopping…" until the turn settles. Then the run status
  disappears, and an info row says "Stopped by you at `14:08`."
- **Focus.** Returns to the textarea after Send, Steer, or Stop Turn.
- **Drafts** are never discarded. The draft survives disable/enable, reconnects, and errors. Keep
  a draft per session path in memory, so switching sessions and coming back restores it.

### Disabled states

The reason goes in `.composer-reason` and the control is disabled. The reason is one line, per
the skill's copy ladder.

| Condition | Textarea | Buttons | Reason (with icon) |
|---|---|---|---|
| Session is live in a TUI | `disabled` | Send hidden | `attention` — "Read only while this session is open in the TUI." |
| Chat socket connecting (first connect) | enabled (typing is fine) | Send `aria-disabled` | `clock` — "Connecting…" |
| Chat socket dropped | enabled | Send `aria-disabled` | `clock` — "Reconnecting. Your draft is kept." |
| Server `error` with `code:"busy"` | enabled | Send `aria-disabled` until the next `agent_settled` | `attention` — "pi is busy with another turn. Send when it finishes." |

Use `aria-disabled="true"` rather than `disabled` on buttons whose reason matters. That keeps them
focusable, so the reason (tied to them with `aria-describedby="composer-reason"`) gets read. The
click handler checks the state and does nothing. The textarea takes a real `disabled` only in the
read-only live case.

### Tokens

Composer ground is `--color-surface` with a top border in `--color-border`, and padding
`--space-3` / `--space-4` plus `env(safe-area-inset-bottom)`. The textarea uses `.input`: 44px
min, `--r-md`, `--color-border-strong` border, and an accent focus border. Send is
`.button-primary` (`--color-accent` / `--color-on-accent`). Stop Turn is `.button-destructive`
(`--status-error` border and label, `--status-error-bg` on hover). The reason is `--fs-caption` in
`--color-ink-2`, and the hint is `--color-ink-muted`. The hint is hidden under 768px.

### Accessibility

- **Label.** The textarea has a real (visually hidden) `<label>`. The placeholder is never the
  label.
- **Contrast.** On-accent on accent (Send) is 5.61 (dark) and 6.81 (light). The control border
  (border-strong on surface) is 3.47 and 3.61, clearing 3:1. Error on surface (Stop Turn) is 5.42
  and 6.01.
- **Stop Turn placement.** It sits to the left of Send with an `--space-2` gap, which keeps
  destructive away from the primary as far as a two-button row allows. It's the only time the two
  appear together.

---

## 5 · New Session dialog

Triggered by `New Session` (sidebar head, and the empty states).

```html
<!-- Portal to body -->
<div class="scrim"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title">
  <div class="modal-head"><h2 class="modal-title" id="ns-title">New Session</h2></div>
  <form class="modal-body" id="ns-form">
    <div class="field">
      <label class="field-label" for="ns-cwd">Folder</label>
      <input class="input input-mono" id="ns-cwd" value="/home/user/webapps/pi-web"
             aria-describedby="ns-cwd-hint ns-cwd-error" spellcheck="false" autocomplete="off">
      <span class="field-hint" id="ns-cwd-hint">pi runs in this folder and can read and change files in it.</span>
      <span class="field-error" id="ns-cwd-error"><!-- on error only --></span>
    </div>
    <div class="field">
      <span class="field-label" id="ns-recent">Recent folders</span>
      <ul class="list folder-list" role="listbox" aria-labelledby="ns-recent">
        <li class="list-row list-row-interactive" role="option" aria-selected="true" tabindex="-1">
          …folder… <span class="list-title truncate">~/webapps/pi-web</span>
        </li>
      </ul>
    </div>
  </form>
  <div class="modal-foot">
    <button class="button button-primary" type="submit" form="ns-form">Create Session</button>
    <span class="modal-spacer"></span>
    <button class="button button-ghost" type="button">Cancel</button>
  </div>
</div>
```

- **Prefill.** Use the `cwd` of the open session, else the most recently active session's `cwd`.
  **Recent folders** are the distinct `cwd`s from the list, most recently active first, up to 20
  entries. Show them with `~`; the full path goes in `title`.
- **Picking.** Clicking a recent folder, or pressing Enter/Space on it, fills the input.
  Double-click fills the input and submits. ArrowUp/ArrowDown from the input moves the active
  option, tracked with `aria-activedescendant` on the input. This makes the input plus list a
  combobox-lite, and it isn't required for the MVP; plain click and Tab also work.
- **Submitting.** Enter in the input submits. Create Session posts `{cwd}`. While pending, the
  button shows "Creating…" and is `aria-disabled`.
- **On success.** Close the dialog, navigate to the new session, and focus the composer.
- **On a server 4xx.** Show `.field-error` with the server's message, or "That folder doesn't
  exist. Pick one that does." Set `aria-invalid="true"` on the input and move focus back to it.
  The dialog stays open with the value intact.
- **Other errors.** Show a `.banner.banner-error` inside `.modal-body`: "Couldn't create the
  session. Nothing was written. Try again."
- **Focus.** Trap focus inside the dialog, and put initial focus on the input with its value
  selected. `Esc`, Cancel, and a scrim click all close it. On close, focus returns to the button
  that opened it. Below 768px the same markup renders as a bottom sheet.
- **Tokens.** Modal `--color-surface`, `--r-xl`, `--shadow-3`, border `--color-border`, and
  scrim `--scrim`. Title `--fs-heading-m`. Folder list `--color-bg` with `--r-md`, rows are
  `--row-height` in `--font-mono`, and the selected row is `--color-accent-tint`.

## 6 · Extension dialogs (`ui_request`, optional in MVP)

Use the same `.modal` shell, titled with the request's title.

| Request | Body | Foot |
|---|---|---|
| `confirm` | `.modal-body` shows the message | `.button-primary` with the request's confirm label, then the spacer, then a `Cancel` ghost |
| `select` | Options as a `.list` of `role="option"` rows | `Cancel` ghost only. Picking a row answers |
| `input` | A `.field` with a label | `Submit` primary and `Cancel` ghost |

`Esc` or Cancel sends `ui_response` with `value: null`. Dialogs never stack: a new request while
one is open queues behind it.

---

## 7 · Deviations from, and extensions to, fold-ai-dev

| What | Why |
|---|---|
| Dark by default instead of following `prefers-color-scheme` | Requested for this dev tool. Light is still complete and equal, via `data-theme="light"` |
| App shell uses `@media`, not a container query | The shell is the window. It's the same exception the skill makes for `.toast-stack` |
| No rail and no bottom bar, and no three-pane desktop band | pi-web has one destination. The skill's "sidebar left, main right" at ≥768 is kept |
| `.modal` restyles itself into a sheet under 768 | The skill requires a sheet at folded width. Doing it in CSS means the frontend writes one markup |
| New product components: `.app`, `.sidebar-*`, `.search`, `.session-*`, `.transcript*`, `.disclosure*`, `.toolcard*`, `.info-row`, `.run-status`, `.jump-latest`, `.composer*`, `.folder-list`, `.brand`, `.live-dot`, `.chip-live`, `.icon`, `.skip-link`, `.truncate`, `.banner-main/-action`, `.message-time/-text`, `.modal-spacer` | Built only from system tokens and patterns. The tool card is the skill's `.message-tool` turned into a disclosure so arguments and output fit. `.chip-live` applies the skill's run-pulse to a chip |
| New tokens: `--sidebar-width`, `--composer-max`, `--tool-output-max`, `--scrim`, `--skeleton-sweep` | Layout sizes, plus the two alpha values the skill already hard-codes inline (scrim, skeleton sweep), lifted into tokens so they theme correctly |
| Brand: `pi-web-mark.svg` (a stroked π) and the wordmark "pi-web" set in Inter 640 at −.03em | The Fold symbol is not used. It's a placeholder mark on the system's icon grid, and swappable |
| `.button-sm` used for Retry, Copy Output, and Open for Chat | Always inside an already-reached context (a banner or a card), never the sole action on a surface, which the skill allows |

Everything the skill forbids stays forbidden: no gradients (except the skeleton sweep the skill
documents), no blur, no tinted shadows, no color-only state, no decorative accent, no exclamation
marks, no weights outside 400/530/600/640, no icon library, and no looping animation except the
live pulse and the skeleton.

---

## 8 · Token index

Every token these notes reference, all defined in `src/design/tokens.css`:

- **Color:** `--color-bg`, `--color-surface`, `--color-sunken`, `--color-ink`, `--color-ink-2`,
  `--color-ink-muted`, `--color-border`, `--color-border-strong`, `--color-accent`,
  `--color-accent-hover`, `--color-accent-tint`, `--color-on-accent`, `--scrim`,
  `--skeleton-sweep`
- **Status:** `--status-success`, `--status-warn`, `--status-error`, `--status-info`,
  `--status-success-bg`, `--status-warn-bg`, `--status-error-bg`, `--status-info-bg`
- **Type:** `--font-body`, `--font-display`, `--font-mono`, `--fw-regular`, `--fw-medium`,
  `--fw-semibold`, `--fw-display`, `--fs-heading-m`, `--fs-heading-s`, `--fs-body`,
  `--fs-caption`, `--fs-mono`, `--fs-micro`, `--lh-heading-m`, `--lh-heading-s`, `--lh-body`,
  `--lh-caption`, `--lh-mono`, `--ls-eyebrow`
- **Space:** `--space-1` through `--space-9` (the notes use `--space-2`, `--space-3`, `--space-4`,
  `--space-5`, `--space-6`, and `--space-8`)
- **Radius:** `--r-xs`, `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-full`
- **Stroke and size:** `--stroke-thin`, `--stroke-icon`, `--tap-min`, `--row-height`,
  `--control-sm`, `--control-md`, `--sidebar-width`, `--composer-max`, `--tool-output-max`
- **Elevation:** `--shadow-1`, `--shadow-2`, `--shadow-3`
- **Focus and motion:** `--focus-ring`, `--focus-width`, `--focus-offset`, `--focus-color`,
  `--dur-fast`, `--dur-base`, `--ease-standard`
- **Layout:** `--measure`, `--bp-unfolded`

---

## 9 · Copy deck

These are the exact strings to use. `{…}` is a value. Machine facts (paths, pids, model ids,
times) go in `<code>` or `.text-mono`. `~` stands for `$HOME` in displayed paths.

### Sidebar

| Where | Copy |
|---|---|
| Search label (visually hidden) | Search sessions |
| Search placeholder | Title, folder, or model |
| Count | `{n} sessions` · filtered: `{visible} of {total} sessions` |
| Live chip in head | `{n} live` (only when n ≥ 1). `title`: "Sessions open in a TUI" |
| Row live chip | Live |
| Untitled row | Untitled (muted) |
| Refresh button `aria-label` | Refresh Sessions |
| Loading | skeleton only, no text |
| Error banner | **Couldn't read your sessions.** `~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry. · button: `Retry` |
| Empty (0 on disk) | **0 sessions in `~/.pi/agent/sessions`.** Start one here, or run `pi` in a terminal. It'll show up in this list. · button: `New Session` |
| No matches | **0 of {total} match “{query}”.** We search titles, folders, and models. · button: `Clear Search` |

### Main pane

| Where | Copy |
|---|---|
| No session selected | **{n} sessions across {m} folders.** Pick one to read it, or start a new one. · button: `New Session` |
| Transcript load error | **Couldn't load this transcript.** The file at `{path}` wasn't changed. {server message} · button: `Retry` |
| New empty session | **New session in `{cwd}`.** Nothing sent yet. Your first message becomes its title. |
| Copy path button / toast | `aria-label` "Copy Session Path" · toast "Copied path." |
| Copy output button / toast | `Copy Output` · toast "Copied output." |
| Unknown entry | Unrecognized entry `{raw.type}` · disclosure label "Raw entry" |
| Long tool output | `Show All {n} Lines` |
| Tool chips | Running · Done · Failed · No result |
| Tool output label | Output · on error: Error |
| Stopped turn (info row) | Stopped by you at `{HH:MM}`. |

### Live-watch

| Where | Copy |
|---|---|
| Live banner | **Live from TUI — read only** · Open in pi (pid `{pid}`) · `{live.status}`. We only read this file. |
| TUI closed | **The TUI closed this session.** You can chat in it here now. · button: `Open for Chat` |
| Jump button | Jump to Latest · `{n} new` (the count is omitted when 0) |
| SR announce (throttled 5s) | {n} new entries. |

### Connection (either socket)

| State | Surface | Copy |
|---|---|---|
| Connecting (first time) | composer reason (`clock`) | Connecting… |
| Lost, retrying | chat: composer reason (`clock`) · watch: `.banner-warn` | chat: "Reconnecting. Your draft is kept." · watch: **Stopped watching. The connection dropped.** What's shown is up to `{HH:MM}`. Reconnecting… |
| Gave up (retries exhausted) | `.banner-error` at the top of the transcript; composer reason "Not connected." | **Lost the connection to the pi-web server.** Nothing in the session changed. Check `npm run dev:server` is running, then retry. · button: `Reconnect` |
| Reconnected | nothing. The banner or reason simply disappears; no toast | — |

### Composer

| State | Copy |
|---|---|
| Label (visually hidden) | Message |
| Placeholder, idle | Ask pi to… |
| Placeholder, streaming | Steer the current turn… |
| Buttons | `Send` · streaming: `Steer` + `Stop Turn` · after Stop Turn is pressed: "Stopping…" in run status |
| Hint (≥768 only) | `Enter` to send · `Shift`+`Enter` for a new line |
| Run status | `Working` + detail: `· thinking` / `· writing` / `· running {tool}` · stopping: `Stopping…` |
| Reason: TUI-live | Read only while this session is open in the TUI. |
| Reason: busy (server `code:"busy"`) | pi is busy with another turn. Send when it finishes. |
| Reason: connecting / reconnecting / gave up | see Connection above |
| Busy fallback, when the message was already typed and rejected | the draft stays in the textarea (not cleared), plus the busy reason. No banner |
| Turn error banner (in thread) | **The turn stopped with an error.** {message}. Your messages are kept. Send again to retry. |
| SR announcements | Working. · Reply finished. |

### New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Recent label | Recent folders |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |
