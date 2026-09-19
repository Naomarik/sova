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
| Sidebar | `.sidebar-head` `.brand` `.sidebar-spacer` `.sidebar-search` `.sidebar-list` `.sidebar-region` `.sidebar-region-head` `.sidebar-region-count` `.sidebar-region-note` `details.sidebar-archive` |
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
| Composer | `.composer` `.composer-inner` `.composer-row` `.composer-input` (with `.input.textarea`) `.composer-actions` `.composer-foot` `.composer-reason` `.composer-hint` `.button-label` `.composer-drop` + `.composer[data-drop="active\|reject"]` |
| Model menu (§4c) | `.model-trigger` `.model-trigger-label` `.model-menu[popover]` `.model-menu-search` `.model-menu-list` `.model-menu-group` `.model-option` `[data-active]` `.model-option-check` `.model-option-id` `.model-option-provider` `.model-menu-empty` `.model-menu-foot` |
| Images (§4b) | `.message-images` `.message-images-single` `.thumb` `.toolcard-images` · lightbox: `dialog.lightbox` `.lightbox-bar` `.lightbox-caption` `.lightbox-count` `.lightbox-stage` `.lightbox-img` `.lightbox-prev` `.lightbox-next` · attachments: `.attachments` `.attachment` `.attachment-rejected` `.attachment-thumb` `.attachment-icon` `.attachment-text` `.attachment-name` `.attachment-meta` |
| Empty / loading | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` · `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| Toast | `.toast-stack` `.toast` `.toast-body` |
| Insights: entry (§10) | `.sidebar-foot` holding 2 × `.insights-row` (Usage → `#/usage`, Agents → `#/agents`) `.insights-row-text` · aggregate chip `.chip.chip-count` (`a.chip` when it links) |
| Insights: Usage and Agents pages (§10) | `.insights` (+ `.pane`) `.insights-inner` `.insights-section` `.insights-section-head` `.insights-section-count` `.insights-grid` · `.card` `.card-head` `.card-title` `.card-body` `.card-foot` |
| Usage meter (§10) | `.usage-card` `.usage-note` · `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-of` `.meter-track` `.meter-fill` `.meter-fill-warn` `.meter-fill-error` `.meter-context` `.meter-ghost` |
| Teams / subagents (§10) | `.team-card` `.team-objective` `.agent-card` `.member-list` `.member-row` `.member-preview` |
| Outline strip (§10) | `details.outline` `.outline-summary` `.outline-label` `.outline-now` `.outline-count` `.outline-body` `.outline-overall` `.outline-state` `.outline-topics` `details.outline-topic` `.outline-topic-summary` `.outline-topic-heading` `.outline-hash` `.outline-topic-time` `.outline-bullets` `.outline-jump` |
| Compaction row (§10) | `details.disclosure.compaction` `.compaction-summary` `.compaction-files` |
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
| `chevron-down.svg` | Jump to Latest, the model trigger |
| `terminal.svg` | Live-from-TUI banner, and the tool card for `bash` |
| `file.svg` | Tool card for `read` / `write` / `edit` |
| `more.svg` | Tool card for any other tool |
| `copy.svg` | Copy Session Path, Copy Output |
| `chevron-left.svg` / `chevron-right.svg` | Also: lightbox Previous Image / Next Image |
| `check.svg` | The copy button's icon for 1.5s after a copy; the current-model mark |
| `folder.svg` | Folder picker rows, cwd group label |
| `info.svg` | Info rows, info banners |
| `alert-circle.svg` | Error banners, warn banners |
| `attention.svg` | Composer reason when the session is read only |
| `clock.svg` | "Reconnecting" reason |
| `refresh.svg` | Refresh Sessions: an icon button in `.sidebar-head`, before New Session, with `aria-label="Refresh Sessions"`. While fetching it's `aria-disabled` and the list keeps its rows |
| `arrow-right.svg` | Send |
| `pause.svg` | Stop Turn |
| `chat.svg` | Empty-state mark (no session selected) |
| `attach.svg` | Attach Images (composer). New, drawn on the system grid |
| `image.svg` | Tool-card image count, drop overlay. New, drawn on the system grid |
| `gauge.svg` | Usage: the sidebar foot's Usage row. pi-web's own, drawn on the system grid |
| `worker.svg` | Agents: the sidebar foot's Agents row, plus the Teams and Subagents section heads (from the skill's set) |
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
    <span class="sidebar-spacer"></span>
    <button class="button button-icon button-ghost" type="button" aria-label="Refresh Sessions">…refresh…</button>
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
    <div class="spread">
      <p class="search-count" id="session-count" aria-live="polite">12 of 48 sessions</p>
      <span class="chip chip-accent chip-live chip-count" title="Sessions open in a TUI">
        <i class="chip-dot"></i>2 live</span>          <!-- only when ≥1 live -->
    </div>
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
- **Live count.** `N live` as `.chip-count`, shown only when N ≥ 1. It sits at the right end of
  the count row under search (`.spread`), not in the head: at 320px the head holds exactly brand,
  Refresh, and New Session. It always counts all live sessions, not just the filtered ones.
- **Selection.** The row for the open session gets `aria-current="page"`, which the stylesheet
  tints with `--color-accent-tint`. The tint is never the only signal, because the head of the
  main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

### Regions: top and Archive

`SessionSummary.origin` divides the list into two regions:

- **Top region:** sessions where `live !== null || origin === "web"`, meaning the ones running
  in a TUI right now or started from pi-web.
- **Archive:** every other session.

Both regions use exactly the same folder groups and rows described above. Each region groups by
`cwd` independently, so one folder can appear in both.

```html
<nav class="sidebar-list pane" aria-label="Session list">
  <!-- Top region. With 0 rows and no query, keep the head ("Live & web · 0") and replace the
       groups with <p class="sidebar-region-note">0 sessions open in a TUI or started here. The archive below has the rest.</p>.
       With 0 rows while searching, omit the region. -->
  <section class="sidebar-region" aria-labelledby="r-top">
    <h2 class="sidebar-region-head" id="r-top">
      Live &amp; web <span class="sidebar-region-count">· 5</span>
    </h2>
    <section class="session-group" aria-labelledby="g-1">
      <h3 class="list-group-label" id="g-1" title="/home/user/webapps/pi-web">…same as above…</h3>
      <ul class="list">…session rows…</ul>
    </section>
  </section>

  <!-- Archive: omitted entirely when it has 0 rows -->
  <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={…}>
    <summary class="sidebar-region-head">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span>Archive</span>
      <span class="sidebar-region-count">· 43</span>
    </summary>
    <section class="session-group" aria-labelledby="ga-1">
      <h3 class="list-group-label" id="ga-1" title="/home/user">…</h3>
      <ul class="list">…session rows…</ul>
    </section>
  </details>
</nav>
```

**Separation.** Each region opens with a 44px `.sidebar-region-head` strip on `--color-sunken`.
The label is mono, micro, and uppercase, in `--color-ink-2`, and the count is in
`--color-ink-muted`. Regions are divided by a `--color-border` rule. The strip is a ground change
from the `--color-surface` sidebar, not a color accent, so it stays inside the color budget.
Folder labels keep sticking to the top of the pane as you scroll. Region heads don't stick.

**Labels.** The top region is "Live & web · {n}" and the archive is "Archive · {n}". While a
search is active, each shows "· {hits} of {total}" for that region.

**Empty top region.** With no query, the head stays ("Live & web · 0") and the groups are
replaced by `.sidebar-region-note`: "0 sessions open in
a TUI or started here. The archive below has the rest." The archive is also forced open (case 1
below).

**Archive open/closed state.**

- It's a native `<details>`, **collapsed by default**. The whole 44px summary row toggles it,
  and the chevron rotates 90° when open.
- Remember the user's choice in `sessionStorage["pi-web:archive-open"]` (`"1"`/`"0"`), read on
  load and written on `toggle`. It lasts for the browser session, not across restarts.
- It opens automatically, **without** changing the stored choice, when:
  1. the top region is empty (otherwise the sidebar would show nothing but a closed strip);
  2. the selected session (from the URL) is in the archive, so its `aria-current` row is
     visible;
  3. a search query is non-empty (see Search).

  When the condition ends, it goes back to the stored choice. Case 2 is the exception: it doesn't
  close under the user while they're on that session.

**Ordering.** The top region comes first and the Archive last. Inside each region, groups and
rows are ordered by the rules above. A session moves between regions in place on refresh, for
example when its TUI closes and `live` becomes null. If it's the selected row, it keeps
`aria-current`, and case 2 keeps the archive open.

**Accessibility.**

- The top region is a `section` labelled by its `h2`. Folder labels become `h3`, since they're
  now nested one level deeper.
- For the Archive, `<summary>` is what AT announces ("Archive · 43, collapsed"). Use a plain
  `<span>`, not a heading, inside it, because headings inside `<summary>` are exposed
  inconsistently. `<details>` announces expanded or collapsed on its own.
- Keyboard: Tab reaches the summary, and Enter or Space toggles it. Rows inside a closed archive
  aren't focusable, which is native `<details>` behavior.
- Contrast: ink-2 on sunken is 7.65 (dark) and 7.22 (light). Muted on sunken is 5.40 and 4.75.
- Touch: the summary is `--row-height`, 44px. At 320px the strip holds a 16px twist, the word,
  and the count, well inside the 288px of usable width.

### Search

- **Matching.** Case-insensitive substring match on `title`, `cwd`, and `model`, filtered on the
  client as the user types (no debounce needed for fewer than 2k rows).
- **Empty groups.** A group with no matching rows is hidden, and so is a region with none.
- **Both regions.** The query filters the top region and the Archive alike. While the query is
  non-empty, the Archive is forced open so matches are never hidden in a collapsed region.
  Clearing the query restores the stored open/closed choice. The count row
  (`{visible} of {total} sessions`) covers both regions, and each region head shows its own
  filtered count.
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
- **Model.** In chat sessions the model moves out of `.session-head-meta` into the model
  trigger (§4c), placed before Copy Session Path. Watch sessions keep it in the meta line.
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
<footer class="composer" data-drop="active|reject (only while dragging over it)">
  <!-- drag-over overlay; see §4b -->
  <div class="composer-drop" aria-hidden="true">
    <span class="icon" style="--icon: url(/icons/image.svg)"></span><span>Drop images to attach</span>
  </div>
  <form class="composer-inner" aria-label="Message the agent">
    <!-- while streaming only -->
    <p class="run-status"><span class="live-dot"></span>Working<span class="run-status-detail">· running bash</span></p>

    <!-- pending attachments; omit the <ul> when there are none; see §4b -->
    <ul class="attachments" aria-label="Attachments">…</ul>

    <div class="composer-row">
      <button class="button button-icon button-ghost" type="button" aria-label="Attach Images"
              aria-describedby="composer-reason">
        <span class="icon" style="--icon: url(/icons/attach.svg)" aria-hidden="true"></span>
      </button>
      <input class="visually-hidden" type="file" multiple tabindex="-1" aria-hidden="true"
             accept="image/png,image/jpeg,image/gif,image/webp">
      <label class="visually-hidden" for="composer-input">Message</label>
      <textarea class="input textarea composer-input" id="composer-input" rows="1"
                placeholder="Ask pi to…" aria-describedby="composer-reason"></textarea>
      <div class="composer-actions">
        <!-- streaming only; kept apart from Send by the gap -->
        <button class="button button-destructive" type="button">
          <span class="icon" style="--icon: url(/icons/pause.svg)" aria-hidden="true"></span><span class="button-label">Stop Turn</span>
        </button>
        <button class="button button-primary" type="submit">
          <span class="icon" style="--icon: url(/icons/arrow-right.svg)" aria-hidden="true"></span><span class="button-label">Send</span>
        </button>
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
| Model switch pending (§4c) | enabled | Send `aria-disabled` until `{type:"model"}` or an error | `clock` — "Switching model…" |
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

## 4b · Images

Images show up in three places. A **user row** and a **tool-result row** can each carry images
(`TranscriptItem.images`, as data URLs). The **composer** can attach images to a prompt or a
steer (`OutboundImage[]`).

### Thread thumbnails

On a **user row**, the images go under the head, right-aligned, and *above* the text bubble
(the images are what the text talks about). If the row has no text, leave out
`.message-body` entirely rather than render an empty bubble.

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head"><span class="message-author">You</span><span class="message-time">14:06</span></div>
  <!-- add message-images-single when there is exactly 1 image -->
  <ul class="message-images" aria-label="2 images">
    <li>
      <button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 1 of 2 in your message" loading="lazy" decoding="async">
      </button>
    </li>
    <li>
      <button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 2 of 2 in your message" loading="lazy" decoding="async">
      </button>
    </li>
  </ul>
  <div class="message-body message-text">{text}</div>
</article>
```

- **Sizing.**
  - **1 image** (`.message-images.message-images-single`): it keeps its own shape, fitted
    inside 320 × 240 (`object-fit: contain`) and never wider than the column.
  - **2 or more:** 96 × 96 square tiles (`object-fit: cover`), with an `--space-2` gap. They
    wrap as needed: 2 tiles fit in one row at 320px.
- **Surface.** `--r-md` (one step under the bubble's `--r-lg`), a 1px `--color-border` edge,
  and `--color-sunken` behind transparent pixels. On hover the border turns
  `--color-border-strong`. Focus shows the standard ring. The cursor is `zoom-in`.

On a **tool-result row**, the images go in the tool card, as a section after Output. The
collapsed summary shows a count so the images aren't hidden.

```html
<summary class="toolcard-summary">
  …twist, icon, name, arg…
  <span class="toolcard-images" title="2 images">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>2
    <span class="visually-hidden">images</span>
  </span>
  <span class="chip chip-success"><i class="chip-dot"></i>Done</span>
</summary>
<div class="toolcard-body">
  …Arguments, Output…
  <div class="toolcard-section">
    <div class="toolcard-section-label">Images · 2</div>
    <ul class="message-images" aria-label="2 images">
      <li><button class="thumb" type="button" aria-haspopup="dialog">
        <img src="data:image/png;base64,…" alt="Image 1 of 2 from tool result read" loading="lazy" decoding="async">
      </button></li>
      …
    </ul>
  </div>
</div>
```

**Alt text.** It's built from context, because pi stores no captions.

| Where | 1 image | n images |
|---|---|---|
| User row | Image in your message | Image {i} of {n} in your message |
| Tool result | Image from tool result {toolName} | Image {i} of {n} from tool result {toolName} |
| Pending attachment (composer) | attachment | attachment |

`{toolName}` is the paired tool-call's name (`read`, `bash`, and so on). Without a pairing it's
"result". The thumbnail button needs no `aria-label`, because its name comes from the image's
alt. `aria-haspopup="dialog"` tells AT that it opens something.

### Lightbox

**There is a lightbox.** Clicking or pressing Enter/Space on a `.thumb` opens that image full
size. It's one native `<dialog>`, opened with `showModal()`. That puts it in the top layer (it
isn't trapped by a `.pane`, and it needs no Portal), makes the page behind it inert, and gives
Esc for free. It fades in once with `--dur-base`; nothing loops, so the animation budget is
untouched.

```html
<dialog class="lightbox" aria-labelledby="lightbox-caption">
  <div class="lightbox-bar">
    <p class="lightbox-caption" id="lightbox-caption">Image 1 of 2 in your message</p>
    <span class="lightbox-count" aria-hidden="true">1 / 2</span>   <!-- only when n > 1 -->
    <button class="button button-icon button-ghost" type="button" aria-label="Close Image" autofocus>
      <span class="icon" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </div>
  <div class="lightbox-stage">                       <!-- a click here, outside the img, closes -->
    <img class="lightbox-img" src="data:image/png;base64,…" alt="Image 1 of 2 in your message">
    <!-- only when n > 1 -->
    <button class="button button-icon lightbox-prev" type="button" aria-label="Previous Image">
      <span class="icon" style="--icon: url(/icons/chevron-left.svg)" aria-hidden="true"></span>
    </button>
    <button class="button button-icon lightbox-next" type="button" aria-label="Next Image">
      <span class="icon" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    </button>
  </div>
</dialog>
```

- **Scope.** The lightbox steps through the images of *one row* (one message, or one tool
  result), never the whole transcript.
- **Caption.** The caption is the image's alt, so the label, caption, and alt all say the same
  thing.
- **Keys.**
  - `Esc` closes it (native `cancel`).
  - `ArrowLeft` / `ArrowRight` step through the images, and wrap at the ends.
  - `Tab` cycles between Close, Previous, and Next.
- **Dismissing.** Any of these closes it:
  - `Esc`;
  - the Close Image button;
  - a click on the backdrop or on the empty stage (`event.target === dialog` or
    `event.target.classList.contains("lightbox-stage")`).

  A click *on* the image does nothing.
- **Focus.** On open, focus goes to Close Image (`autofocus`). On close, move focus back to the
  `.thumb` that opened it: store the element before `showModal()` and call `.focus()` on
  `close`. Don't rely on the browser to do this.
- **Layout.**
  - The image is fitted to the viewport under the 56px bar, with `--space-4` around it and
    `--space-8` side room for the arrows.
  - Under 768px the arrows move to the bottom corners, inside the thumb arc, and the image makes
    room above them.
- **Tokens.** The dialog is opaque `--color-bg` (full-bleed), with `::backdrop` `--scrim`
  underneath. Bar `--color-surface` with `--color-border`. Image on
  `--color-surface`, with `--r-sm` and `--shadow-3`. Arrows are `.button-icon` on surface with
  the 3:1 `--color-border-strong` edge, so they read against the scrim.

### Composer attachments

There are three ways in, and all three feed the same pending list.

1. **Paste**, the CLI flow. In the textarea's `paste` handler, take every `File` in
   `clipboardData.files` whose type is an image and attach it. Call `preventDefault()` only if
   the clipboard has no `text/plain`. A paste that carries both text and an image, such as
   copying from a web page, keeps its text and attaches the image. A pasted screenshot has no
   useful name, so it shows as "Pasted image".
2. **Drag and drop** onto the composer. The whole `.composer` is the target.
   - On `dragenter`/`dragover` with `Files`:
     - set `data-drop="active"` if at least one item is an accepted image type;
     - otherwise set `data-drop="reject"`, which shows "Only images can be attached".
   - Call `preventDefault()` in `dragover` so the drop is allowed.
   - Clear `data-drop` on `dragleave` (when leaving the composer itself, not a child) and on
     `drop`.
   - On the **window**, `preventDefault()` for `dragover`/`drop` anywhere else. Otherwise a stray
     drop makes the browser navigate away to the image.
   - While the composer is disabled, never set `data-drop`, and ignore the drop.
3. **File picker.** Attach Images is `.button-icon.button-ghost` with the `attach` icon, labelled
   `aria-label="Attach Images"`. It opens the hidden
   `<input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp">`. Reset the
   input's value after reading it, so the same file can be picked twice.

**Accepted.** `image/png`, `image/jpeg`, `image/gif`, and `image/webp`, up to **5 MB each** and
**8 per message**. These are the formats model providers accept. HEIC, SVG, and anything larger
are rejected on the client before they're sent. If the server enforces a different limit, change
the numbers here and in the copy deck together.

**Placement at 320px** (and anywhere the composer is under 480px wide). The row is Attach (44) +
textarea + actions. Under 480px of composer width, `Send`, `Steer`, and `Stop Turn` drop to
icon-only 44px squares: their word sits in `.button-label`, which becomes visually hidden and
stays the accessible name. That's why every composer button wraps its word in
`<span class="button-label">`. At 320 while streaming, the textarea keeps 288 − 3 × 44 − 3 × 8 =
132px. Attach stays leftmost, away from the primary. The pending list sits above the row and
wraps, so it never squeezes the textarea.

**Pending list** (above the textarea):

```html
<ul class="attachments" aria-label="Attachments">
  <li class="attachment">
    <img class="attachment-thumb" src="blob:…" alt="attachment">
    <span class="attachment-text">
      <span class="attachment-name" title="screenshot-2026-09-19.png">screenshot-2026-09-19.png</span>
      <span class="attachment-meta">240 KB</span>
    </span>
    <button class="button button-icon" type="button" aria-label="Remove screenshot-2026-09-19.png">
      <span class="icon icon-sm" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </li>

  <!-- rejected: stays in the list, is NOT sent -->
  <li class="attachment attachment-rejected">
    <span class="attachment-icon"><span class="icon" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span></span>
    <span class="attachment-text">
      <span class="attachment-name" title="holiday.heic">holiday.heic</span>
      <span class="attachment-meta">Unsupported type</span>
    </span>
    <button class="button button-icon" type="button" aria-label="Dismiss holiday.heic">
      <span class="icon icon-sm" style="--icon: url(/icons/close.svg)" aria-hidden="true"></span>
    </button>
  </li>
</ul>
```

- **Shape.** Each attachment is 44px tall and at most 240px wide, with `--r-md`. It's an object
  you remove, so it takes a control's shape, not a status chip's pill. Contents: a 32px preview
  (`object-fit: cover`, `--r-sm`), then the name (truncated, full name in `title`) over the size
  in mono, then a 44px Remove.
- **Preview source.** Use `URL.createObjectURL(file)` and revoke it on remove and on send. Read
  base64 (`OutboundImage.data`, no `data:` prefix) only when sending.
- **Size format.** `KB` under 1 MB, rounded (`240 KB`). Otherwise one decimal (`2.4 MB`).
- **Rejected.** Rejected files stay in the list with `.attachment-rejected`: `--status-error-bg`
  ground, a `--status-error` edge, and the `alert-circle` icon instead of a preview. The meta
  line gives the reason in words, so the color is never the only signal. They're never sent. The
  button is "Dismiss {name}". All rejected items clear on the next successful send.
- **Announcements.** Adding and rejecting are announced in the polite live region:
  - "{n} images attached."
  - "{name} wasn't attached. {reason}."
- **Removing.** After Remove, focus moves to the next attachment's Remove, or the previous one's,
  or the textarea when the list is empty.
- **Send rules.**
  - Send is enabled when there is text **or** at least 1 accepted attachment. An image-only
    prompt is valid and sends `text: ""`.
  - Send and Steer both carry the images. On a successful send, the list empties together with
    the textarea.
  - The optimistic user bubble shows the images right away.
  - Drafts keep their attachments per session, the same as text.
- **Disabled composer** (TUI-live, connecting, reconnecting). Attach Images takes the same
  `aria-disabled` and shares `aria-describedby="composer-reason"`. Paste and drop don't attach
  anything.

**Tokens.**
- **Attachment.** `--color-sunken` with a `--color-border` edge, `--r-md`, `--control-md`
  tall. Name `--fs-caption` in `--color-ink`; meta `--font-mono` in `--color-ink-muted`.
- **Rejected.** `--status-error-bg` with a `--status-error` edge, and meta in `--color-ink-2`.
- **Drop overlay.** A `--stroke-icon` dashed `--color-accent` edge on `--color-accent-tint`,
  with `--r-lg`, and text in `--color-ink` at `--fw-medium`. It's the one place a drag needs to
  say "here", which is what the accent is for. Reject swaps in `--status-error` /
  `--status-error-bg`.

**Contrast.**

| Pair | Dark | Light |
|---|---|---|
| Ink on accent-tint (drop text) | 12.57 | 14.57 |
| Ink-2 on error-bg (rejected meta) | 6.48 | 7.49 |
| Error on error-bg (rejected icon and edge) | 5.01 | 5.16 |
| Muted on sunken (size meta) | 5.40 | 4.75 |
| Border-strong on surface (lightbox arrows) | 3.47 | 3.61 |

---

## 4c · Model menu

A searchable model picker, like pi's Ctrl+P palette. It's opened from the model button in the
chat header. It exists only for **chat** sessions. A watched (TUI-owned) session keeps the model
as plain mono text in `.session-head-meta`, because it can't be changed from here.

### Trigger

In chat sessions it takes the model's place in the header. Drop the model from
`.session-head-meta` and put the trigger after `.session-head-main`, before Copy Session Path:

```html
<button class="button button-ghost model-trigger" type="button" id="model-trigger"
        aria-haspopup="dialog" aria-expanded="false" aria-controls="model-menu" title="{provider/id}">
  <span class="visually-hidden">Model: </span>
  <span class="model-trigger-label">kimi-k3</span>
  <span class="icon icon-sm" style="--icon: url(/icons/chevron-down.svg)" aria-hidden="true"></span>
</button>
```

- **Label.** The model id without the provider, in mono, with the full `provider/id` in `title`.
  With no model yet, show "Choose model".
- **Width.** It's capped at 200px (128px under 768px), and the label truncates. Its accessible
  name is "Model: kimi-k3", which starts with the visible text.
- **`aria-expanded`** mirrors the menu: set it in the popover's `toggle` event. While open, the
  trigger takes the sunken fill.

### Menu

```html
<div class="model-menu" id="model-menu" popover="auto" role="dialog" aria-label="Choose model"
     style="--menu-top: 60px; --menu-right: 16px">
  <div class="model-menu-search">
    <div class="search">
      <span class="icon" style="--icon: url(/icons/search.svg)" aria-hidden="true"></span>
      <input class="input" type="text" role="combobox" aria-label="Search models"
             placeholder="Search models" autocomplete="off" spellcheck="false"
             aria-expanded="true" aria-controls="model-listbox" aria-autocomplete="list"
             aria-activedescendant="mo-openai-gpt-5">
    </div>
  </div>

  <!-- only when changing is blocked; see Disabled -->
  <div class="banner banner-info" role="status">…</div>

  <div class="model-menu-list" id="model-listbox" role="listbox" aria-label="Models">
    <div class="model-menu-group" role="group" aria-labelledby="mg-fav">
      <div class="list-group-label" id="mg-fav">Favorites</div>
      <div class="model-option" role="option" id="mo-openai-gpt-5" aria-selected="false" data-active>
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">gpt-5</span>
        <span class="model-option-provider">openai</span>
      </div>
      <div class="model-option" role="option" id="mo-ollama-cloud-kimi-k3" aria-selected="true">
        <span class="icon icon-sm model-option-check" style="--icon: url(/icons/check.svg)" aria-hidden="true"></span>
        <span class="model-option-id">kimi-k3</span>
        <span class="model-option-provider">ollama-cloud</span>
      </div>
    </div>
    <div class="model-menu-group" role="group" aria-labelledby="mg-all">
      <div class="list-group-label" id="mg-all">All models</div>
      …options…
    </div>
  </div>

  <p class="model-menu-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close</p>
</div>
```

- **Role.** This is a **listbox**, not a menu. Choosing a model is selecting one value from a
  set, which is exactly what a listbox is for. The popup is a small dialog made of a combobox
  input plus the listbox, so the trigger says `aria-haspopup="dialog"`. Focus stays in the input
  the whole time, and the keyboard position is `aria-activedescendant`. The option it points to
  gets `data-active` and draws the focus ring (inset 2px accent), because focus can't be seen
  anywhere else.
- **Mechanism.** It's a native `[popover="auto"]`, which puts it in the top layer. It isn't
  clipped by a `.pane` and needs no Portal. A click outside or `Esc` closes it for free. Render
  it once, next to the trigger. On open, measure the trigger with `getBoundingClientRect()` and
  set `--menu-top: {rect.bottom + 4}px` and `--menu-right: {innerWidth − rect.right}px`, then
  call `showPopover()`. Close it on window resize.
- **Positioning.**
  - At ≥768 (e.g. 1440) it sits right-aligned under the trigger: 360px wide (or the viewport
    minus 32px), `max-height: min(440px, 70dvh)`, with `--r-md` and `--shadow-2`. The list
    scrolls, and the search field and the foot stay put.
  - Under 768 (e.g. 320) it's a bottom sheet: full width, up to 85dvh tall, with `--r-xl` top
    corners, the scrim backdrop, and the search at the top. The keyboard hint foot is hidden.
- **Motion.** It fades in once (`--dur-base`). Nothing loops.

### Content and order

- **Groups.**
  - **Favorites** (`favorite: true`) come first, sorted by `ref`. They're marked by the group
    label; rows carry no star.
  - A 1px `--color-border` rule separates the favorites from **All models**: every other model,
    sorted by provider, then id.
  - A model appears in only one group. With no favorites there's a single group, and its label
    is still "All models".
- **Rows.** Each row is 44px: a check mark (visible only on the current model), the id in mono,
  and the provider in a muted caption on the right. The current model has `aria-selected="true"`,
  the check, and the accent-tint fill, so the mark isn't color alone. Every other row has
  `aria-selected="false"`.
- **Search.**
  - Matching is case-insensitive. The query is split on whitespace, and every token must appear
    in `provider/id`. So "anth opus" finds `anthropic/claude-opus-5`.
  - It filters both groups and hides a group with no matches. The active option resets to the
    first match whenever the query changes.
  - Because focus stays in the input, typing *is* the typeahead.
- **On open.** The query is empty, the current model is active and scrolled into view
  (`block: "nearest"`), and the input has focus.

### Keyboard

| Key | Where | Does |
|---|---|---|
| `Ctrl+P` / `⌘P` | anywhere while a **chat** session is open | Opens the menu, and closes it if it's open. Call `preventDefault()` so print never fires. In watch sessions and on the list view it isn't bound, and the browser prints as usual |
| `Enter` / `Space` | on the trigger | Opens |
| `↓` / `↑` | in the menu | Moves the active option, wrapping. Normally it skips disabled rows. When *every* row is disabled (Blocked), it moves through all of them, so the list stays browsable, and `Enter` does nothing |
| `PageDown` / `PageUp` | in the menu | Moves 8 options |
| `Enter` | in the menu | Chooses the active option. Choosing the current model just closes the menu |
| `Esc` | in the menu | Closes it (native popover behavior). The query doesn't survive |
| `Tab` | in the menu | Closes it (on `focusout` outside the menu), and focus moves on |
| Mouse | | Hovering a row makes it active, and clicking chooses it |

When the menu closes without a choice, focus returns to the trigger.

### States

| State | Trigger | Menu |
|---|---|---|
| **Loading models** (first open; fetched on every open and cached, so later opens show the cache while it refreshes) | normal | After 300ms, 4 × `<div class="skeleton skeleton-row">` in the list, with `aria-busy="true"` on the listbox |
| **Load failed** | normal | `.banner.banner-error`: **Couldn't load models.** Your current model is unchanged. Action: `<button class="button button-sm">Retry</button>` |
| **0 models** | normal | `<p class="model-menu-empty">` "0 models have credentials. Log in with `pi` in a terminal to add one." |
| **No matches** | normal | `<p class="model-menu-empty">` "0 models match “{query}”." |
| **Blocked: agent running** (`isStreaming`) | enabled, so pressing it shows the reason | `.banner.banner-info`: **Model changes wait until this turn finishes.** Stop Turn or wait, then pick one. Every option gets `aria-disabled="true"`, and the list stays browsable. If a turn starts while the menu is open, the banner appears right away |
| **Blocked: composer disabled** (connecting, reconnecting, a foreign writer, the TUI took over) | enabled | Same banner, with the current `.composer-reason` text as the title, and options disabled |
| **Pending** (after choosing, until `{type:"model"}`) | `aria-busy="true"` and `aria-disabled="true"`. The label shows the *target* id, with `<span class="live-dot"></span>` before it. It isn't faded: `aria-busy` restores full opacity, because pending is work in progress, not an unavailable control | Closed. Focus stays on the trigger |
| **Switched** (`{type:"model"}` arrives) | The label shows the echoed model, and the dot is removed | — |

- **While pending.**
  - The composer's Send takes `aria-disabled` with the reason "Switching model…" (`clock`
    icon), so a prompt can't land on an ambiguous model.
  - If there's no echo after **15s**, treat it as an error (below) with the message "The server
    didn't confirm the switch."
- **On switch.**
  - Announce "Model changed to {id}." in the polite live region.
  - Append an `.info-row` locally: "Model changed to `{provider/id}`". On reload, the persisted
    `model_change` entry renders in the same place, so the two never appear together.
  - The pulse is the sanctioned live indicator, and it's legitimate here because work is
    happening.

### Errors

An `{type:"error"}` that arrives while a switch is pending belongs to that switch. It ends the
pending state, the trigger reverts to the current model, and a `.banner.banner-error` shows in
the chat's `.transcript-banner` slot (sticky at the top of the transcript; chat sessions don't
use it otherwise):

```html
<div class="banner banner-error" role="alert">
  <span class="icon banner-icon" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span>
  <div class="banner-main">
    <p class="banner-title">Couldn't switch to <code>claude-opus-5</code>.</p>
    <p class="banner-body">{body per table} You're still on <code>kimi-k3</code>.</p>
  </div>
  <button class="button button-sm button-ghost banner-action" type="button">Dismiss</button>
</div>
```

The body depends on the server message (the server sends free text, so match on the prefix):

| Server message starts with | Body |
|---|---|
| `No credentials configured for` | {provider} has no credentials set up. Log in with `pi` in a terminal, then try again. |
| `Unknown model` | pi doesn't know this model. It may have been removed from your config. |
| `Cannot switch models while the agent is running` | Model changes wait until this turn finishes. |
| `code: "busy"` / `"recent"` / `"reloaded"` | the same copy the composer uses for that code |
| anything else | {server message verbatim}. |

The banner goes away on Dismiss, after the next successful switch, or when you leave the session.
It never auto-dismisses, because it's the only record of the failure.

### Tokens

- **Trigger.** `.button-ghost` at 44px, `--font-mono` / `--fs-mono` in `--color-ink-2`, and
  `--color-sunken` while open.
- **Menu.** `--color-surface` with a `--color-border` edge, `--r-md`, and `--shadow-2`. At
  folded width it's a sheet with `--r-xl`, `--shadow-3`, and `--scrim`.
- **Rows.** `--control-md` tall. Id in `--font-mono` / `--color-ink`, provider `--fs-caption` in
  `--color-ink-muted`.
  - Hover and active: `--color-sunken`, and the active row also gets the `--focus-ring` inset.
  - Current: `--color-accent-tint`.
  - Disabled: opacity .42.
- **Group rule.** `--color-border`.
- **Foot.** `--fs-caption` in `--color-ink-muted`.

### Contrast

| Pair | Dark | Light |
|---|---|---|
| Ink on surface (ids) | 12.34 | 17.86 |
| Muted on surface (provider) | 4.96 | 5.74 |
| Ink on sunken (active row) | 13.43 | 14.78 |
| Muted on sunken | 5.40 | 4.75 |
| Ink on accent-tint (current row) | 12.57 | 14.57 |
| Muted on accent-tint | 5.06 | 4.68 |
| Accent ring on sunken (active marker) | 5.08 | 5.63 |

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
| New product components: `.app`, `.sidebar-*`, `.search`, `.session-*`, `.transcript*`, `.disclosure*`, `.toolcard*`, `.info-row`, `.run-status`, `.jump-latest`, `.composer*`, `.folder-list`, `.brand`, `.live-dot`, `.chip-live`, `.icon`, `.skip-link`, `.truncate`, `.banner-main/-action`, `.message-time/-text`, `.modal-spacer` | Built only from system tokens and patterns. The tool card is the skill's tool-turn chat style (sunken, mono) turned into a disclosure so arguments and output fit. `.chip-live` applies the skill's run-pulse to a chip |
| Insights components: `.sidebar-foot`, `.insights*`, `.usage-*`, `.team-*`, `.agent-card`, `.member-*`, `.outline*`, `.compaction*`; the skill's `.card-*` and `.meter*` families brought in | Built from system tokens and the skill's card, meter, list, chip, and disclosure patterns (§10) |
| `.meter-fill` is `--color-ink-muted`, not `--color-accent` | pi-web's accent is reserved for primary, live, and focus (§0). At ≥80% the fill turns `--status-warn`, at ≥100% `--status-error`, always under a chip that says the word |
| New tokens: `--sidebar-width`, `--composer-max`, `--tool-output-max`, `--outline-max`, `--scrim`, `--skeleton-sweep` | Layout sizes, plus the two alpha values the skill already hard-codes inline (scrim, skeleton sweep), lifted into tokens so they theme correctly |
| Brand: `pi-web-mark.svg` (a stroked π) and the wordmark "pi-web" set in Inter 640 at −.03em | The Fold symbol is not used. It's a placeholder mark on the system's icon grid, and swappable |
| Composer buttons go icon-only under 480px of composer width (`.button-label` visually hidden) | Keeps the textarea usable at 320px while streaming. Each button keeps its accessible name, and Send stays the filled primary |
| Lightbox is a native `<dialog>` rather than the skill's `.scrim` + `.modal` | Top layer, inert page, and native Esc handling. It's full-bleed because it shows content rather than asking a question |
| Model picker is a `[popover]` + combobox + listbox (the skill's `.popover` is a plain action menu) | Choosing one value from a set is a listbox. The popover gives top layer and light dismiss. Rows keep the 44px target and hover/active never hide an action |
| `Ctrl+P` is taken over in chat sessions | Mirrors pi's TUI palette. It's bound only where a model can change, so print still works everywhere else |
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
  `--control-sm`, `--control-md`, `--sidebar-width`, `--composer-max`, `--tool-output-max`,
  `--outline-max`
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
| Live chip (count row under search) | `{n} live` (only when n ≥ 1). `title`: "Sessions open in a TUI" |
| Row live chip | Live |
| Untitled row | Untitled (muted) |
| Top region head | Live & web · {n} · searching: Live & web · {hits} of {total} |
| Archive head | Archive · {n} · searching: Archive · {hits} of {total} |
| Empty top region note | 0 sessions open in a TUI or started here. The archive below has the rest. |
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

### Images

| Where | Copy |
|---|---|
| Attach button `aria-label` | Attach Images |
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
| Tool card section label | Images · {n} |
| Tool card summary count | {n} (`title`: "{n} images") |
| Lightbox counter | {i} / {n} |
| Lightbox buttons | Close Image · Previous Image · Next Image |

### Model menu

| Where | Copy |
|---|---|
| Trigger | {id} (visually hidden prefix "Model: ") · no model: Choose model · `title`: {provider/id} |
| Menu `aria-label` | Choose model |
| Search placeholder / label | Search models |
| Listbox `aria-label` | Models |
| Group labels | Favorites · All models |
| Foot (≥768) | `↑` `↓` to move · `Enter` to choose · `Esc` to close |
| No matches | 0 models match “{query}”. |
| No models | 0 models have credentials. Log in with `pi` in a terminal to add one. |
| Load failed | **Couldn't load models.** Your current model is unchanged. · `Retry` |
| Blocked, running | **Model changes wait until this turn finishes.** Stop Turn or wait, then pick one. |
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

### New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Recent label | Recent folders |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |

### Insights (§10)

| Where | Copy |
|---|---|
| Foot row 1 (→ `#/usage`) | `{Provider} {window} {pct}%` (highest window) · no data: Usage |
| Foot row 2 (→ `#/agents`) | `{n} teams` · `{w} working`, joined by ` · `, zero segments left out · nothing to report: Agents |
| Provider names | Claude · OpenAI · Ollama Cloud |
| Usage page title / head meta | Usage · Updated {rel} · never read: Not read yet |
| Agents page title / head meta | Agents · `{w} working · {n} pi sessions running` ("{w} working · " dropped at 0; "1 pi session running") · 0 live: No pi sessions running |
| Refresh `aria-label` | Refresh Usage · Refresh Agents |
| Section heads (Agents page) | Teams · {n} active · Subagents · {n} working |
| Agents page, 0 live (whole body) | **No pi sessions running.** Teams and subagents show up here while the pi session that started them runs. |
| Window labels (`5h`, `7d`, `7d opus`, `month`, `pri`) | 5-hour · 7-day · 7-day Opus · Monthly · Primary |
| Meter value | `{pct}%` used |
| Meter context | Resets in {2h 17m} (under 24h) · Resets {Sep 25} · reset already passed: Reset at `{HH:MM}`. New reading at the next refresh. |
| Usage chips | Near limit · Rate-limited · Quota used · Stale |
| Stale usage (banner-warn) | **Usage is {42m} old.** It refreshes while pi runs in a terminal. Open a pi session, or run `/usage-refresh` in one. |
| Usage file missing (`reason:"missing"`) | **No usage data yet.** The usage-status extension writes `~/.pi/agent/cache/usage-status.json` while pi runs, and we haven't found it. |
| Usage file corrupt (`reason:"corrupt"`) | **Couldn't read usage.** `usage-status.json` isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh. · button: `Retry` |
| Request failed | Usage: **Couldn't load usage.** · Agents: **Couldn't load agents.** Then: Nothing was changed. {server message} · button: `Retry` |
| Provider `nologin` | Not signed in. Run `claude /login` and it'll show at the next refresh. (OpenAI: `pi /login`) |
| Provider `expired` | Sign-in expired. Run `claude /login` to renew it. (OpenAI: `pi /login`) |
| Provider `nokey` | No Ollama Cloud key in `~/.pi/agent/auth.json`. |
| Provider `badkey` | Ollama Cloud refused the key in `~/.pi/agent/auth.json`. |
| Provider `na` | This account doesn't report usage. |
| Provider `error`, no windows | Couldn't fetch usage: {error}. We'll try again at the next refresh. |
| Provider `error`, windows kept | Last fetch failed: {error}. Showing the previous reading. |
| Team card | {name} · `{id}` · foot: Started {rel} in {parent title} · ended (parent session only): chip "Ended" |
| Member status chips | Starting · Working · Idle · Stopping · Done · Failed · Stopped · No report yet |
| Member meta | `{workerId}` · `{model}` · reported only: as of `{HH:MM}` · idle after a failure: last task failed |
| Orchestrator badge | Orchestrator |
| Teams empty, some sessions live | **{n} pi sessions running. None of them has a team.** (n = 1: **1 pi session running. It has no team.**) Teams you create in pi show up here while their session runs. |
| Teams empty, none live | not shown: the whole Agents page is the 0-live empty state above |
| Subagents empty | Section omitted |
| Aggregate chips | {n} working · session head, linked: Team · {n} working (→ `#/agents/{teamId}`) or {n} working (→ `#/agents`) |
| Outline summary | Outline · {now} · {n} topics (1 topic) |
| Outline state line | Updated {rel} · stale adds: " · behind the latest messages" · failed-keeping-last adds: " · the last update failed, so this is the previous outline" · updating/drafting: "Updating" + live dot |
| Outline jump | Jump to Message |
| Compaction | Compacted · `{tokens}` tokens summarized (no count: Compacted · earlier messages summarized) · Files read · Files changed |

---

## 10 · Insights

What the user's pi extensions publish, read-only: subscription usage (usage-status), teams and
subagents (subagents + sessions live records), and per-session summaries (topic-outline,
compaction). Data shapes are `UsageInsight`, `AgentsInsight`, and `SessionInsight` in
`shared/protocol.ts`. **Every status says where it came from**: live-sourced states can pulse,
while reported states (read from a session file after the fact) never pulse and carry
"as of `14:06`".

### Placement

- **Global:** two main-pane pages, each about one thing, entered from two pinned `.sidebar-foot`
  rows:
  - **`#/usage`** covers subscription limits.
  - **`#/agents`** covers teams and subagents. Team deep links are `#/agents/{teamId}`.

  The head is full at 320px (§2). A third sidebar region would scroll away and mix non-session
  data into the session list. An overlay would hide the transcript. The foot is always visible,
  sits in the folded thumb arc, and needs no rail. At folded width both pages use
  `data-view="session"` and show `.app-back`.
- **Old URLs:** `#/insights` redirects to `#/usage`, and `#/insights/{teamId}` to
  `#/agents/{teamId}`, via `history.replaceState`, so no extra history entry is added.
- **Per session:** `details.outline` sits directly under `.session-head`, above the live banner.
  Compactions stay in the transcript, at the point where they happened (§3 items).
- **Aggregates:** neutral count chips on session rows and in the session head.
- No toasts, and nothing is announced on a poll.

### Sidebar foot

```html
<!-- after nav.sidebar-list, outside the pane -->
<div class="sidebar-foot">
  <a class="list-row list-row-interactive insights-row" href="#/usage" aria-current="page"><!-- aria-current on #/usage only -->
    <span class="icon" style="--icon: url(/icons/gauge.svg)" aria-hidden="true"></span>
    <span class="insights-row-text">Claude 5-hour <span class="text-num">96%</span></span>
    <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </a>
  <a class="list-row list-row-interactive insights-row" href="#/agents"><!-- aria-current on #/agents and #/agents/* -->
    <span class="icon" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
    <span class="insights-row-text"><span class="text-num">2</span> teams · <span class="text-num">3</span> working</span>
    <span class="icon icon-sm" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
  </a>
</div>
```

The foot holds **two stacked 44px rows, and both are always present**, so the layout never
jumps. `.list-row`'s bottom border divides them. A single row split into two links was
rejected: 288px divided in two truncates "Claude 5-hour 96%".

- **Usage row:** the highest-% window across providers, as `{Provider} {window} {pct}%`. With no
  data it reads "Usage".
- **Agents row:** `{n} teams` (active only) and `AgentsInsight.totals.working` as `{w} working`,
  joined by ` · `. Zero segments are left out. If both are zero, or nothing is live, it reads
  "Agents".

The rows take no color and no chip, because the pages carry the status. Each truncates with an
ellipsis.

### Aggregate chips: "Live" vs "Working"

- **Live** is session-level: a TUI has the file open. It keeps §2's accent chip and pulse,
  unchanged.
- **Working** is worker-level: a subagent is mid-task. On a member row it's
  `.chip-accent.chip-live` "Working", and pulses only when live-sourced (see Team cards).
- **Aggregates are neutral** `.chip.chip-count`, with no dot and no pulse, so each row has only
  one pulsing thing:
  - **Session rows (§2):** `{n} working` when `live?.workers?.working ≥ 1`, placed *before* the
    Live chip. Hidden at 0 or when absent.
  - **Session head:** the same chip before Live, as a link. With a live team it's
    `<a class="chip chip-count" href="#/agents/{teamId}">Team · {n} working</a>`, pointing at
    the busiest live team when there are several. Otherwise it's
    `<a class="chip chip-count" href="#/agents">{n} working</a>`.
  - The chip inside a sidebar session row is **never** a link, because an `<a>` can't nest in
    the row's link. The foot's Agents row is the way to the page from the sidebar.

### Usage page (`#/usage`) and Agents page (`#/agents`)

Both pages share one shell: a `.session-head` and a `.insights.pane` containing
`.insights-inner`.

```html
<!-- #/usage -->
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Usage</h1>
    <p class="session-head-meta">Updated 2m ago</p>            <!-- never read: Not read yet -->
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Usage">…refresh…</button>
</header>
<section class="insights pane" aria-label="Usage">
  <div class="insights-inner">
    <!-- stale banner here; no section head, since the h1 names the page -->
    <div class="insights-grid">…usage cards…</div>
  </div>
</section>

<!-- #/agents and #/agents/{teamId} -->
<header class="session-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title" tabindex="-1">Agents</h1>
    <p class="session-head-meta">3 working · 2 pi sessions running</p>   <!-- 0 live: No pi sessions running -->
  </div>
  <button class="button button-icon button-ghost" aria-label="Refresh Agents">…refresh…</button>
</header>
<section class="insights pane" aria-label="Agents">
  <div class="insights-inner">
    <!-- 0 live sessions: ONE .empty here and nothing else (no section heads) -->
    <section class="insights-section" aria-labelledby="ins-teams">
      <h2 class="insights-section-head" id="ins-teams">…worker icon-sm… Teams <span class="insights-section-count">· 2 active</span></h2>
      <div class="insights-grid">…team cards, or .empty…</div>
    </section>
    <section class="insights-section" aria-labelledby="ins-agents"><!-- only with non-team workers -->
      <h2 class="insights-section-head" id="ins-agents">…worker icon-sm… Subagents <span class="insights-section-count">· 3 working</span></h2>
      <div class="insights-grid">…agent cards…</div>
    </section>
  </div>
</section>
```

- **Split.** Usage and agents never share a page. The Agents page runs Teams first, then
  Subagents, and leaves out Subagents when no session has solo workers. With 0 live sessions,
  the whole Agents body is one `.empty` (§9).
- **Head meta (Agents).** The format is `{w} working · {n} pi sessions running`. Drop
  "{w} working · " when w is 0, and use "1 pi session running" when n is 1.
- **Grid.** `.insights-grid` has 1 column. It becomes 2 columns when the `insights` container is
  at least 640px wide, and 3 at 1000px or more. The container is named, per the skill.
- **Polling** (frontend's call on intervals). Update in place and keep scroll position and
  focus. Don't show a skeleton again after the first load.
- **Loading** (first load, after 300ms). The Usage page shows 3 `.skeleton` blocks at 120px
  tall with `--r-lg`. The Agents page shows 1. Put `aria-busy` on `.insights-inner`.
- **Request error.** Show `.banner-error` at the top of `.insights-inner` with Retry: "Couldn't
  load usage." or "Couldn't load agents." Any data already loaded stays visible below it.
### Usage cards

```html
<article class="card usage-card" aria-labelledby="u-claude">
  <header class="card-head">
    <h3 class="card-title" id="u-claude">Claude</h3>
    <span class="chip chip-warn"><i class="chip-dot"></i>Near limit</span>
  </header>
  <div class="card-body">
    <div class="meter">
      <p class="meter-head"><span class="meter-label">5-hour</span>
        <span class="meter-value">96%<span class="meter-of"> used</span></span></p>
      <div class="meter-track" aria-hidden="true"><span class="meter-fill meter-fill-warn" style="--meter-pct: 96%"></span></div>
      <p class="meter-context" title="2026-09-19T07:50:00Z">Resets in 2h 17m</p>
    </div>
    <!-- or, instead of meters: <p class="usage-note">Not signed in. Run <code>claude /login</code> …</p> -->
  </div>
</article>
```

- **Cards.** There's one card per `providers[]` entry, in the order given: Claude, OpenAI,
  Ollama Cloud.
- **Meters.** Each window gets a `.meter`. The number comes first, the bar second, and there's
  never a bar alone.
  - **Value.** `Math.round(pct)` followed by `%`. No decimals: the sources round, and a decimal
    claims precision we don't have. The fill's width is clamped to 100%.
  - **Context.** Only when `resetsAt` exists (currently Claude only). Under 24h it's
    "Resets in 2h 17m", otherwise "Resets Sep 25", with the ISO time in `title`. Never estimate
    a reset.
  - **Reset already passed** (`resetsAt < now`, which means the file is stale). Use
    `.meter-ghost`, with no fill. The value keeps the old number, and the context says
    "Reset at `11:50`. New reading at the next refresh."
  - **Fill color.** The fill is neutral. It gets `.meter-fill-warn` at ≥80% and
    `.meter-fill-error` at ≥100%. That matches the extension's own footer threshold, and it
    always pairs with the head chip.
- **Head chip.** The worst window decides it. The words follow the skill's model-availability
  severities:

  | Condition | Chip |
  |---|---|
  | All windows < 80% | none |
  | Any window 80–99% | `.chip.chip-warn` "Near limit" |
  | A 5-hour window ≥ 100% | `.chip.chip-warn` "Rate-limited" (it comes back on its own) |
  | A 7-day or monthly window ≥ 100% | `.chip.chip-error` "Quota used" (waits for the reset) |
  | `error` set and `windows` kept | neutral `.chip` "Stale", plus a `.usage-note` under the meters |

  If both a limit chip and Stale apply, show the limit chip.
- **Provider not ok.** The body is a single `.usage-note` (`nologin`, `expired`, `nokey`,
  `badkey`, `na`, or `error` with no windows; see §9), with no chip and no meters. Commands in
  the note go in `<code>`.
- **Whole file.**
  - The Usage page's head meta always shows "Updated {rel}" from `fetchedAt`, or "Not read yet".
  - When `stale` is true (more than 10 minutes old, which means no TUI pi is refreshing it),
    add a `.banner.banner-warn` (`clock`) above the grid. The meters still render.
  - When `available` is false, replace the grid with one `.empty`. `missing` means unavailable,
    not an error. `corrupt` gets the error copy.

### Team cards

Teams come from `AgentsInsight.sessions[].teams`, meaning teams whose parent pi is running now.
Workers die with their parent, so a team is only active while its parent runs. Ended teams
have no global surface. If one is rendered at all, it's in its parent session, from
`SessionInsight.teams` with `live: false`. There it uses the same `.team-card` markup, with a
neutral `.chip` "Ended" in the head. Every member chip then takes the reported form: no pulse,
and "as of `{HH:MM}`" in the meta.

```html
<article class="card team-card" id="team-team_02" aria-labelledby="tt-team_02">
  <header class="card-head">
    <h3 class="card-title" id="tt-team_02">pi-web-insights</h3>
    <span class="text-mono text-caption">team_02</span>
  </header>
  <div class="card-body"><p class="team-objective" title="{full objective}">{objective}</p></div>
  <ul class="list member-list">
    <li class="list-row member-row" title="Owns: server/**">
      <div class="list-main">
        <p class="list-title">lead <span class="chip chip-count">Orchestrator</span></p>
        <p class="list-meta"><span class="text-mono">ag_08</span> · <span class="text-mono">opus[1m]</span></p>
        <p class="member-preview">{worker.preview}</p>   <!-- working only -->
      </div>
      <span class="chip chip-accent chip-live"><i class="chip-dot"></i>Working</span>
    </li>
  </ul>
  <footer class="card-foot"><p class="text-caption">Started 42m ago in <a href="#/s/…">{parent title}</a></p></footer>
</article>
```

- **Rows.** Rows are not targets: they carry no link and no hover. The role is `.list-title`.
  Ids and models are mono in the meta line. Orchestrator is a neutral count-style badge, not a
  status. Owned paths go only in the row's `title`, because they're advisory.
- **Order.** Orchestrator first, then members in roster order.
- **Status.** The word is always shown. The pulse appears only when `member.worker` is present
  **and** its session is `fresh`.

  | Source → status | Chip |
  |---|---|
  | live `running` | `.chip.chip-accent.chip-live` Working |
  | live `starting` | `.chip.chip-accent.chip-live` Starting |
  | `waiting` | `.chip` + dot, Idle. If `outcome` isn't `success`, the meta adds "last task failed" |
  | `stopping` | `.chip` + dot, Stopping |
  | `done` | `.chip.chip-success` Done |
  | `error` | `.chip.chip-error` Failed |
  | `killed` | `.chip` + dot, Stopped |
  | `worker` null, `lastReport` present | that status's chip with **no pulse**, and the meta adds "as of `{HH:MM}`" |
  | neither | neutral `.chip` No report yet |

  A live record with `fresh: false` renders its workers the reported way, with "as of" set to
  the heartbeat time. They're never shown as working.
- **Deep link.** `#/agents/{teamId}` is a route segment, not a fragment, because the whole
  route lives in the hash. The view scrolls `#team-{teamId}` into view and focuses it (the card
  has `tabindex="-1"`). `.team-card:focus` draws the focus ring; `:focus-visible` wouldn't,
  because this focus is programmatic after a click.

### Subagent cards

There's one `.card.agent-card` per live session that has **non-team** workers. The head holds
the session title as a link to `#/s/…` (or `cwd`, mono, when `path` is null) and a
`.chip-count` "{n} working". Its body is a `.member-list` of `.member-row`s: the worker's `name`
as the title, `id` and `model` in the meta, the preview while working, and the status chip from
the table above. When no session has solo workers, the section is omitted.

### Outline strip (topic-outline)

```html
<details class="outline">
  <summary class="outline-summary">
    <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    <span class="outline-label">Outline</span>
    <span class="outline-now">· Audit and intercom removal complete</span>
    <span class="outline-count">12 topics</span>
  </summary>
  <div class="outline-body">
    <p class="outline-overall">{overall}</p>
    <p class="outline-state">Updated 3m ago · behind the latest messages</p>
    <ol class="outline-topics">
      <li>
        <details class="outline-topic">
          <summary class="outline-topic-summary">
            <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
            <span class="outline-topic-heading"><span class="outline-hash">#</span>Model selection and limits</span>
            <span class="outline-topic-time">14:06</span>
          </summary>
          <ul class="outline-bullets"><li>…</li></ul>
          <button class="button button-sm button-ghost outline-jump" type="button">Jump to Message</button>
        </details>
      </li>
    </ol>
  </div>
</details>
```

- **Three steps of disclosure:**
  1. Closed, the strip shows the `now` line.
  2. Open, it shows `overall`, the state line, and the topic headings.
  3. Opening a topic shows its bullets and Jump.
- **Open state.** Both levels are closed by default. Persist the strip's open state per session
  path in `sessionStorage`. Open states survive updates.
- **Missing data.**
  - When `outline` is null, render no strip at all. Most sessions have none, and an empty strip
    on each of them is noise.
  - Leave out an empty `now` (the summary then shows only the label and count), and likewise an
    empty `overall`.
- **Topic details.** `.outline-hash` appears only on `manual` topics. The time is `at` in mono
  24-hour format, with the date prefix when the day isn't today (§3 timestamps).
- **`updating` / `drafting`.** Put a `.live-dot` after `.outline-label` (a summarizer is running
  now), and the state line reads "Updating".
- **Jump to Message.**
  - It scrolls the transcript item whose entry id equals `entryId` into view, then stops
    auto-follow, so Jump to Latest appears (§3).
  - Leave it out when `entryId` is null or the item isn't rendered (it was compacted away).
- **Refetching.** Refetch after a watch `append` or chat `agent_settled`, debounced. Update in
  place.
- **Folded width.** `.outline-body` caps at 50vh instead of `--outline-max` (40vh).

### Compaction row

The compaction `info` row (§3) becomes a disclosure. It's fed by
`SessionInsight.compactions`, matched to the row by id.

```html
<details class="disclosure compaction">
  <summary class="disclosure-summary">
    <span class="icon icon-sm icon-twist" …chevron-right…></span>
    <span class="disclosure-label">Compacted</span>
    <span class="disclosure-preview">· <span class="text-mono">67,401</span> tokens summarized</span>
  </summary>
  <div class="disclosure-body">
    <div class="compaction-summary">{summary}</div>
    <p class="toolcard-section-label">Files read</p>
    <ul class="compaction-files"><li>~/…/extensions.md</li></ul>
    <p class="toolcard-section-label">Files changed</p>   <!-- omit an empty list -->
  </div>
</details>
```

The summary is plain text with `pre-wrap`, the same as `.message-text`. Paths use `~` in place
of `$HOME`.

### Tokens, motion, and accessibility

- **Tokens.** One new token: `--outline-max` (40vh). **No new colors.** Neutrals and the status
  tokens cover everything, and accent appears only on live-sourced Working/Starting chips and
  focus.
- **Motion.** Nothing new animates. The pulse is reused as the skill's live indicator. Meters
  never animate their fill.
- **Accessibility.**
  - The meter's number is its accessible value, and the track is `aria-hidden`.
  - Every section and card is labelled by its heading.
  - Status chips are text.
  - The foot row is a link named by its text.
  - Contrast pairs:
    - The meter fill is muted on sunken: 5.40 (dark) and 4.75 (light), both clearing 3:1 for a
      graphical object.
    - Ink-2 on sunken (card heads) is 7.65 and 7.22.
    - Ink-2 on accent-tint (the current foot row) matches the selected session row.
