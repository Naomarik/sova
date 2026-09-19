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
| Folder picker (§5) | `.folder-field` `.folder-field-value` `.folder-field-empty` `.folder-picker` `.folder-picker-bar` `.folder-crumbs` `.folder-crumbs-root` `.folder-crumb` `.folder-crumb-current` `.folder-picker-list` `.folder-picker-link` `.folder-picker-note` `.folder-picker-foot` `.folder-picker-hidden` |
| Form fields | `.field` `.field-label` `.field-hint` `.field-error` `.input` `.input-mono` `.textarea` |
| Main head | `.session-head` `.session-head-main` `.session-head-title` `.session-head-meta` `.session-archive` |
| Transcript | `.transcript` (+ `.pane`) `.transcript-banner` `.transcript-inner` `.thread` |
| Messages | `.message` `.message-user` `.message-streaming` `.message-head` `.message-author` `.message-time` `.message-body` `.message-text` |
| Thinking / raw JSON | `details.disclosure` `.disclosure-summary` `.disclosure-label` `.disclosure-preview` `.disclosure-body` |
| Tool card | `details.toolcard` `.toolcard-summary` `.toolcard-name` `.toolcard-arg` `.toolcard-body` `.toolcard-section` `.toolcard-section-label` `.toolcard-output` `.toolcard-output-error` · file content (write, edit, read): `.toolcard-path` `pre.toolcard-code` `.toolcard-code-del` `.toolcard-code-add` with `.hljs-*` roles. The running, done and failed states are chips (§3) |
| Info / unknown row | `.info-row` `.info-row-text` |
| Report row (§3 "report") | `details.disclosure.report` `.report-summary` `.report-from` (+ `.chip`, `.disclosure-preview`) `.report-body` `.report-meta` `.report-error` |
| Banner | `.banner` `.banner-info` `.banner-warn` `.banner-error` `.banner-success` `.banner-icon` `.banner-main` `.banner-title` `.banner-body` `.banner-action` |
| Streaming | `.live-dot` `.run-status` `.run-status-detail` `.jump-latest` |
| Composer | `.composer` `.composer-inner` `.composer-row` `.composer-input` (with `.input.textarea`) `.composer-actions` `.composer-foot` `.composer-reason` `.composer-hint` `.button-label` `.composer-drop` + `.composer[data-drop="active\|reject"]` |
| Model menu (§4c) | `.model-trigger` `.model-trigger-label` `.model-menu[popover]` `.model-menu-search` `.model-menu-list` `.model-menu-group` `.model-option` `[data-active]` `.model-option-check` `.model-option-id` `.model-option-provider` `.model-menu-empty` `.model-menu-foot` |
| Mode menu (§4g) | `.mode-trigger` `.mode-trigger-label` `.model-menu.mode-menu[popover]` (+ `.model-menu-list[role=menu]` `.model-menu-group`) `.mode-option[role=menuitemradio\|menuitemcheckbox]` `.mode-option-check` `.mode-option-text` `.mode-option-id` `.mode-option-desc` `.mode-menu-foot` |
| Context window (§4f) | `.context-gauge` `.context-label` `.context-value` `.context-pct` `.context-meta` · states `.context-warn` `.context-error` `.context-compacted` · `.session-head` is the named container `session-head` |
| Markdown (§4e) | `.md` (on `.message-body`) `.md-table-wrap` `.md-code` `.md-code-head` `.md-code-lang` `.md-code-copy` `.md-image-link` · syntax: `.hljs-*` roles |
| Slash commands (§4d) | `.composer-commands` (button) · `.command-menu` `.command-menu-head` `.command-list` `.command-option` `[data-active]` `.command-option-name` `.command-option-desc` `.command-option-location` `.command-menu-empty` `.command-menu-foot` · source badge: neutral `.chip` |
| Images (§4b) | `.message-images` `.message-images-single` `.thumb` `.toolcard-images` · lightbox: `dialog.lightbox` `.lightbox-bar` `.lightbox-caption` `.lightbox-count` `.lightbox-stage` `.lightbox-img` `.lightbox-prev` `.lightbox-next` · attachments: `.attachments` `.attachment` `.attachment-rejected` `.attachment-thumb` `.attachment-icon` `.attachment-text` `.attachment-name` `.attachment-meta` · path attachments: `details.disclosure.message-attachment` `.message-attachment-missing` `.message-attachment-name` `.message-attachment-meta` `.message-attachment-body` · path chips: `button.path-chip` `.path-chip-missing` `.path-chip-name` `.path-chip-note` |
| Empty / loading | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` · `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| Toast | `.toast-stack` `.toast` `.toast-body` |
| Insights: entry (§10) | `.sidebar-foot` holding 2 × `.insights-row` (Usage → `#/usage`, Agents → `#/agents`) `.insights-row-text` · usage glance `.usage-glance` `.usage-glance-item` `.usage-glance-item-high` `.usage-glance-item-stale` `.usage-glance-tag` · aggregate chip `.chip.chip-count` (`a.chip` when it links) |
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
| `terminal.svg` | The tool card for `bash`, and the "Ran `/cmd`" info row |
| `file.svg` | Tool card for `read` / `write` / `edit` |
| `more.svg` | Tool card for any other tool |
| `copy.svg` | Copy Session Path, Copy Output |
| `archive.svg` | Archive Session / Unarchive Session (session head, web sessions only, §2 "Archiving"): a lidded box. New, drawn on the system grid |
| `chevron-left.svg` / `chevron-right.svg` | Also: lightbox Previous Image / Next Image |
| `check.svg` | The copy button's icon for 1.5s after a copy; the current-model mark |
| `folder.svg` | Folder picker rows, cwd group label |
| `info.svg` | Info rows, info banners |
| `alert-circle.svg` | Error banners, warn banners |
| `attention.svg` | Composer reason when the session is read only |
| `clock.svg` | "Reconnecting" reason |
| `refresh.svg` | Refresh Sessions: an icon button in `.sidebar-head`, before New Session, with `aria-label="Refresh Sessions"`. While fetching it's `aria-disabled` and the list keeps its rows |
| `arrow-right.svg` | Send |
| `stop.svg` | Stop (composer): a rounded square |
| `chat.svg` | Empty-state mark (no session selected) |
| `attach.svg` | Attach Images (composer). New, drawn on the system grid |
| `command.svg` | Commands button (composer, §4d): a `/` in a rounded square. New, drawn on the system grid |
| `image.svg` | Tool-card image count, drop overlay. New, drawn on the system grid |
| `gauge.svg` | Usage: the sidebar foot's Usage row. pi-web's own, drawn on the system grid |
| `worker.svg` | Agents: the sidebar foot's Agents row, plus the Teams and Subagents section heads (from the skill's set) |
| `check-circle.svg`, `x-circle.svg`, `external.svg`, `menu.svg`, `branch.svg` | Reserved. Shipped but unused in the MVP |

`/favicon.svg` is the mark on dark paper. Link it from `index.html`:
`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`.

### Voice (fold-ai-dev, en-US)

Four pillars, all at once: calm, concrete, warm, and candid. The rules that matter most here:

- Buttons use **Title Case** and name their object: `New Session`, `Create Session`, `Stop`,
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
│ session list │ [error banner, sticky]    │     │                  │
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
- **BUSY marker.** Shown when `busy === true`, meaning the server is mid-turn on a session pi-web
  holds.

  ```html
  <span class="chip chip-info" title="pi is replying in this session"><i class="chip-dot"></i>Busy</span>
  ```

  - **No pulse.** It's a plain status chip, with a static info-hue dot and the word. Never add
    `.chip-live`: the pulse belongs to Live alone, so a row never has two moving things.
  - **Hue.** It's info (`--status-info`, 5.94 dark / 6.36 light on the chip's surface), not the
    accent. Busy is our own run, and the accent's live meaning is reserved for "a TUI has this".
  - **Accessible name.** The chip text "Busy" is part of the row link's name. Its `title` gives
    the sentence on hover. For AT, add
    `<span class="visually-hidden">, pi is replying in this session</span>` after the word
    inside the chip, because `title` isn't reliably announced.
  - **Order.** Chips sit at the right end of the row as `[{n} working] [Live]` or `[Busy]`, with
    at most **two** chips per row:
    - `{n} working` (§10) exists only for live sessions, and Busy only for sessions pi-web
      holds, so Working and Busy never meet.
    - Live and Busy shouldn't co-occur either, because pi-web never holds a TUI-owned session.
      If both ever arrive, **Live wins** and Busy is hidden. The TUI owns it, so our view of
      busy is stale.
  - **320px budget.** Row inner width is 288px. The worst case is still today's: `2 working` (~80)
    + `Live` (~64) + 2 × 12px gaps leaves about 120px for the title and meta, which truncate as
    they already do. A Busy row has one chip (~64), so its title gets about 210px. No change to
    row height.
  - **Other placements.** None for v1. The open session already shows its own run state (the
    `.run-status` line and the author's `.live-dot`, §3), so the session head doesn't repeat
    Busy. It doesn't count toward the "N live" chip either.
- **Live count.** `N live` as `.chip-count`, shown only when N ≥ 1. It sits at the right end of
  the count row under search (`.spread`), not in the head: at 320px the head holds exactly brand,
  Refresh, and New Session. It always counts all live sessions, not just the filtered ones.
- **Selection.** The row for the open session gets `aria-current="page"`, which the stylesheet
  tints with `--color-accent-tint`. The tint is never the only signal, because the head of the
  main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

### Regions: top and Archive

`SessionSummary.origin` and `archived` divide the list into two regions (`isTopSession` in
`src/lib/regions.ts`):

- **Top region:** sessions where `live !== null || (origin === "web" && !archived)`, meaning
  the ones running in a TUI right now, or started from pi-web and not archived by the user.
- **Archive:** every other session. A server that sends no `archived` counts as not archived.

Both regions use exactly the same folder groups and rows described above. Each region groups by
`cwd` independently, so one folder can appear in both.

```html
<nav class="sidebar-list pane" aria-label="Session list">
  <!-- Top region. With 0 rows and no query, keep the head ("Live & web · 0") and replace the
       groups with <p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>.
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
a TUI, or started here and not archived. The archive below has the rest." The archive is also
forced open (case 1 below).

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

**Archiving.** Sessions started from pi-web (`origin === "web"`) can be archived by hand, so
the top region doesn't keep every one of them forever.

- **Where.** An Archive Session icon button (`archive.svg`) in the session head, before Copy
  Session Path (§3), only on web sessions. Rows are links, so it can't live in them: a button
  inside `<a>` is invalid and splits the row's single target. It's the only archive control in
  the app, so it stays on a head under 520px and Copy Session Path goes instead (§3, §4f
  "Width budget").
- **What it does.** `POST /api/sessions/archive { path, archived }`, then a list refresh. The id
  goes into `~/.pi/agent/pi-web/archived-sessions.json`; the session file is never written.
  Toast: "Archived. Find it under Archive." The row moves to the Archive, and case 2 keeps it
  visible while it's open.
- **Undo.** On an archived session the same button is Unarchive Session. Toast: "Moved back to
  Live & web."
- **Live.** A live session stays on top whether archived or not, and still shows its Live chip.
  Archiving one is refused: the button is `aria-disabled`, and its `title` says "Open in a TUI.
  It stays on top while live." Unarchiving a live session works.
- **Failure.** Toast: "Couldn't archive this session. {server message}". Nothing moves.
- An archived session opens, chats, and searches exactly like any other row.

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
    <button class="button button-icon button-ghost session-archive" aria-label="Archive Session">…archive…</button>  <!-- web sessions only -->
    <button class="button button-icon button-ghost" aria-label="Copy Session Path">…copy…</button>
  </header>

  <section class="transcript pane" id="transcript" aria-label="Transcript">
    <div class="transcript-banner">…error/notice banner; omitted when there is none…</div>
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
  "Copied path." Nothing else changes. Hidden under 520px of head width on web sessions, to
  make room for Archive (next bullet).
- **Archive Session / Unarchive Session.** Web sessions only, just before Copy Session Path.
  Moves the session between the sidebar regions (§2 "Archiving"). `aria-disabled` while live
  and not archived. **Stays under 520px of head width; Copy Session Path goes instead** on web
  sessions. At a 320px head (292px inside its 16px/12px padding), a chat head holds back 44,
  the model trigger at its 88px cap, and one 44px icon button, with 3 gaps of 12px: 212px,
  leaving the title 80px. A second icon button would take it to 24px, under its 72px floor, so
  one of the two has to go. This button is the app's only archive control, so hiding it
  removes archiving from phones and narrow panes. Copy Session Path is a desk convenience, and
  it's back from 520px up (and always on external sessions).

### Transcript items (by `TranscriptItem.kind`)

Render items in array order. The column is `.thread` (gap `--space-4`) inside `.transcript-inner`,
centred at `--measure` plus 96px (`--space-9`). Messages, tool cards, thinking, and thumbnails
cap at `--measure`.

**Column width.** `--measure` is 72ch (648px in Inter at 14.5px, where 1ch is 9px) at folded
width, and it grows with the pane from unfolded up:
`clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`. That keeps 64px of
margin on each side of the column until the 110ch cap (990px). The formula is under 72ch until
the viewport reaches 1192px, so it grows without a jump. The banner, the composer
(`.composer-inner`), the outline strip, and Jump to Latest follow the same token, so they stay
aligned with the column.

| Viewport | Pane | `.transcript-inner` | Message cap | Composer |
|---|---|---|---|---|
| 390 (folded) | 390 | 390 | 358 (pane minus padding) | 358 |
| 768 | 448 | 448 | 416 (pane minus padding) | 416 |
| 1024 | 704 | 704 | 648 (72ch) | 672 |
| 1280 | 960 | 832 | 736 (~82ch) | 832 |
| 1440 | 1120 | 992 | 896 (~100ch) | 992 |
| 1920 | 1600 | 1086 | 990 (110ch, the cap) | 1086 |

The cap is the reading limit. Prose in Inter runs about 7px a character, so 110ch is about 140
characters, and the extra width mostly goes to code, diffs, and tool output. Everything up to
1191px, folded included, is the same as the old fixed 72ch.

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

**report.** Subagent reports, and every other long extension message. A subagent's final
report (`custom_message`, customType `subagent-complete`) can run to 4000 characters of
markdown. As a centered caption-size info row it filled the whole viewport with literal `###`
and `**`. It's now a collapsed disclosure with the thinking disclosure's grammar: **one line**
closed, and the markdown on the left when open.

```html
<details class="disclosure report">
  <summary class="disclosure-summary report-summary">
    <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
    <span class="visually-hidden">Report from </span>
    <span class="report-from">ag_01 · orchestrator</span>
    <span class="chip chip-success"><i class="chip-dot"></i>Success</span>
    <span class="disclosure-preview">All requested checks pass. Report for items 5 and 6, plus the item 1 flag check.</span>
  </summary>
  <div class="report-body">                                   <!-- rendered only once opened -->
    <p class="report-error">Error: spawn ENOENT</p>                <!-- only with an Error line -->
    <p class="report-meta">Session <span class="text-mono">~/.pi/agent/sessions/…jsonl</span></p>
    <div class="message-body md">…the worker's final output, as markdown…</div>
    <p class="report-meta">Truncated at 4000 characters. Use agent_transcript for the rest.</p>  <!-- only if cut -->
  </div>
</details>
```

- **What's parsed** (server, `TranscriptItem.report`). The subagents extension writes the
  header `### {id} ({name}) — {status}[ · task {outcome}]`, then an optional `Error:` line, an
  optional `Session:` line, then the final output. Older builds wrote `Subagent {id} ({name})
  finished its task.` / `was killed.`, followed by a `Final output:` label, and that parses
  too. The `[Use agent_transcript for more.]` trailer becomes a flag and leaves the body.
  Anything that doesn't parse still renders as a report, with no chip.
- **Closed: exactly one line.** Who (`{id} · {name}` in mono, or the message's customType), the
  status chip, then the body's first non-empty line, with markdown marks stripped (`#`, `**`,
  backticks, list bullets, link syntax). It's truncated with an ellipsis and never wraps.
- **Status chip.** Failure comes first, using the extension's own "failed" rule:

  | Worker | Chip |
  |---|---|
  | An `Error:` line, task `error`, or status `error` | `.chip-error` "Failed" |
  | Status `killed` | `.chip-warn` "Stopped" |
  | Task `aborted` | `.chip-warn` "Aborted" |
  | Task `success` | `.chip-success` "Success" |
  | Status `done` (older reports) | `.chip-success` "Done" |
  | `starting` / `running` / `waiting` / `stopping`, no task outcome | `.chip-info` with the status word |
  | Anything else | neutral `.chip` with the status word |

  "Waiting" with task `success` reads "Success". Waiting is the worker idling after a finished
  task, and the task result is what you're scanning for.
- **Open.** The body goes through the markdown renderer (§4e), capped at `--measure` and
  left-aligned under the disclosure's `--color-border` rule. It's never centered, and never
  caption size. Path chips work in it (§4b). Error is `--status-error` caption text. Session and
  the truncation note are `--color-ink-muted` captions. The body is parsed only when the row is
  first opened, so a transcript with dozens of reports stays cheap.
- **Other long extension messages** (intercom messages, team questions, broker reports): any
  `custom_message` longer than 200 characters or spanning lines gets the same row, with its
  customType in place of the agent and no chip. Markdown, not `<pre>`: these payloads are
  written as markdown (`**From …**`, `_id …_`), and the renderer never runs HTML. Short
  one-liners stay `.info-row` (mode markers, compaction notes, and so on).
- **AT.** The native `<summary>` is the control, and its text is the name: "Report from ag_01 ·
  orchestrator Success All requested checks…". For non-agent messages the hidden prefix is
  "Message: ". Keyboard is native.
- **Tokens.** Summary: the disclosure's (`--fs-caption`, `--color-ink-muted`, `--control-sm`),
  with the sender in `--font-mono` `--color-ink-2`, capped at 40% of the row. Body: the
  `.disclosure-body` spacing (`--space-2` / `--space-4`, `--stroke-icon` rule) as a flex
  column with a `--space-2` gap.

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

- **No persistent banner.** Watch mode has no "Live from TUI — read only" card; it was removed
  by boss directive. Read-only is already obvious from three things that stay:
  1. **The Live chip in the session head** (`.chip.chip-accent.chip-live`, "Live"). It carries
     the process facts in its `title`, updated from `live` whenever the session list refreshes:

     ```html
     <span class="chip chip-accent chip-live" title="Open in pi in a terminal · pid 889823 · Running: bash"><i class="chip-dot"></i>Live</span>
     ```

     The pid and status are shown only here now. They're a detail you look up, not something
     read on every visit.
  2. **The disabled composer**, with its reason: "Read only while this session is open in the
     TUI." (§4 Disabled states). AT gets it through `aria-describedby="composer-reason"`.
  3. **The error banners** below, which still appear in `.transcript-banner` when something
     goes wrong.

  `.transcript-banner` renders only while one of those banners is showing. Otherwise it's
  omitted, so it takes no height.
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
- **When the TUI closes** (`live` goes null on refresh). A `.banner.banner-info` appears in
  `.transcript-banner`, with title "The TUI closed this session." and body "You can chat in it
  here now." It's a one-time transition with an action, not a persistent card. Its `.banner-action` is `<button class="button button-sm">Open for Chat</button>`,
  which reconnects with `/ws/chat`.
- **Watch socket drops.** `.banner.banner-warn` with `alert-circle`. Title: "Stopped watching.
  The connection dropped." Body: "What's shown is up to `14:06`. Reconnecting…" When it
  reconnects, the banner goes away. The snapshot replaces the list, and scroll position is
  kept if the user wasn't following.

### States

| State | What renders |
|---|---|
| No session selected (unfolded) | `.empty` in `.app-main`, with the `chat` icon in `.empty-mark`. Title: "48 sessions across 7 folders." Body: "Pick one to read it, or start a new one." `.empty-action`: `New Session` (secondary). No composer |
| Loading transcript (after 300ms) | Three placeholder messages in `.thread`: a right-aligned `.skeleton` 40% × 44px, then a left `.skeleton-title` plus 3 `.skeleton-line` at 92/78/60%, then a `.skeleton-row` at 60% width. Put `aria-busy="true"` on the `section`. The head renders straight away from the `SessionSummary` |
| Error | `.banner.banner-error` in `.transcript-inner`. Title: "Couldn't load this transcript." Body: "The file at `{path}` wasn't changed. {server message}." Action: `Retry` |
| Empty (new session) | `.empty`. Title: "New session in `~/webapps/pi-web`." Body: "Nothing sent yet. Your first message becomes its title." No action; focus the composer instead. Show it only while the thread has **zero rows**, counting local rows such as "Ran `/cmd`" (§4d) and model-change info rows. Once any row exists, the thread renders normally with no empty state |
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
- **Tool card file content.** `write` content, each `edit` pair ("Replaced" / "With", "· n of
  m" when several), and `read` output are highlighted by file path (never auto-detected) in
  `pre.toolcard-code`: back on `--color-sunken`, where the syntax colors were checked, with
  `--color-ink` and no wrapping. The path shows above in `.toolcard-path` (mono, ink-muted).
  Edit blocks add a 3px left rule: `.toolcard-code-del` in `--diff-del-ink`,
  `.toolcard-code-add` in `--diff-add-ink`; the label carries the meaning. Copy Code on write
  content and on each "With" block. Unknown extensions, errors, and args still streaming stay
  plain.
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

### Open questions

- **Long info rows.** A multi-line custom entry renders as a centered `.info-row` between rules,
  which reads badly. A likely fix is left-aligned and rule-less beyond 1 line, or clamped at 3
  lines behind a disclosure. It's not specced yet and is out of the current brief.

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
      <!-- Commands button; see §4d -->
      <button class="button button-icon button-ghost composer-commands" type="button" aria-label="Commands" …>…</button>
      <label class="visually-hidden" for="composer-input">Message</label>
      <textarea class="input textarea composer-input" id="composer-input" rows="1"
                placeholder="Ask pi to…" aria-describedby="composer-reason"></textarea>
      <div class="composer-actions">
        <button class="button button-primary" type="submit">
          <span class="icon" style="--icon: url(/icons/arrow-right.svg)" aria-hidden="true"></span><span class="button-label">Send</span>
        </button>
        <!-- streaming only; last in the row, after the primary -->
        <button class="button button-destructive" type="button">
          <span class="icon" style="--icon: url(/icons/stop.svg)" aria-hidden="true"></span><span class="button-label">Stop</span>
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
  `{type:"steer"}`. The placeholder becomes "Steer the current turn…". `Stop`
  (`.button-destructive`, outlined, never filled, one word so the button stays narrow) sends
  `{type:"abort"}`. Show it only while streaming, after Steer. `Esc` does **not** abort, to prevent
  accidental stops.
- **After Stop.** The status reads "Stopping…" until the turn settles. Then the run status
  disappears, and an info row says "Stopped by you at `14:08`."
- **Focus.** Returns to the textarea after Send, Steer, or Stop.
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
`.button-primary` (`--color-accent` / `--color-on-accent`). Stop is `.button-destructive`
(`--status-error` border and label, `--status-error-bg` on hover). The reason is `--fs-caption` in
`--color-ink-2`, and the hint is `--color-ink-muted`. The hint is hidden under 768px.
`.composer-inner` is centred at `--measure` plus `--space-9`, the transcript column's width, so it
widens with the column on desktop (§3 "Column width"). The slash menu spans it, and the model
menu keeps its own 360px cap.

### Accessibility

- **Label.** The textarea has a real (visually hidden) `<label>`. The placeholder is never the
  label.
- **Contrast.** On-accent on accent (Send) is 5.61 (dark) and 6.81 (light). The control border
  (border-strong on surface) is 3.47 and 3.61, clearing 3:1. Error on surface (Stop) is 5.42
  and 6.01.
- **Stop placement.** It sits to the right of Steer, last in the row, with an `--space-2` gap. One
  word plus the square glyph makes it narrower than the primary it follows, so the destructive
  action reads as the smaller, secondary one. It's the only time the two appear together.

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
| Path attachment | Attachment {name} in your message | — (one image per unit) |

`{toolName}` is the paired tool-call's name (`read`, `bash`, and so on). Without a pairing it's
"result". The thumbnail button needs no `aria-label`, because its name comes from the image's
alt. `aria-haspopup="dialog"` tells AT that it opens something.

### Path attachments

When you paste an image into pi's terminal UI, pi writes it to `/tmp/pi-clipboard-<uuid>.png`
(`/tmp/pi-wsl-clip-<uuid>.png` under WSL) and puts that **path in the message text**. The
image never reaches the session file. Replies, tool output and subagent reports then quote
the same path. The server finds these paths in user, assistant-text, info (custom messages,
such as subagent reports) and tool-result rows, and sends them as `TranscriptItem.attachments`.
On a user row each path gets a collapsed unit instead of a raw path in the bubble. Everywhere
else it becomes an inline chip or a tool-card section (see **Other rows** below).

```html
<article class="message message-user" aria-label="You, 14:06">
  <div class="message-head">…</div>
  <ul class="message-images">…stored images, if any…</ul>
  <details class="disclosure message-attachment">
    <summary class="disclosure-summary" title="/tmp/pi-clipboard-a587….png">
      <span class="icon icon-sm icon-twist" style="--icon: url(/icons/chevron-right.svg)" aria-hidden="true"></span>
      <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
      <span class="disclosure-label">Attachment</span>
      <span class="message-attachment-name">pi-clipboard-a587….png</span>
      <span class="message-attachment-meta">· 240 KB</span>
    </summary>
    <div class="message-attachment-body">          <!-- rendered only once opened -->
      <ul class="message-images message-images-single" aria-label="1 image">
        <li><button class="thumb" type="button" aria-haspopup="dialog">
          <img src="/api/attachment?path=%2Ftmp%2Fpi-clipboard-a587….png" alt="Attachment pi-clipboard-a587….png in your message" loading="lazy" decoding="async">
        </button></li>
      </ul>
    </div>
  </details>

  <!-- the file is gone from /tmp: a static row, not a disclosure -->
  <div class="message-attachment message-attachment-missing" title="/tmp/pi-clipboard-fc03….png">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
    <span class="disclosure-label">Attachment</span>
    <span class="message-attachment-name">pi-clipboard-fc03….png</span>
    <span class="message-attachment-meta">· No longer in /tmp</span>
  </div>

  <div class="message-body message-text">{text without pi's path}</div>
</article>
```

- **Which paths.** An image file directly in `/tmp` (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`),
  standing alone as a word. Subfolders of `/tmp` and every other folder stay plain text.
- **Only concrete names, never code.** A path counts only when its full file name is written
  out. `/tmp/pi-clipboard-*.png`, `/tmp/pi-clipboard-<uuid>.png` and `…`-shortened names are
  talk *about* the pattern, so they stay text. So does any path inside a markdown code span
  or a fenced block (``` or ~~~, even if the fence is never closed). Our own reports quote the
  pattern all the time, and a chip on a sentence about it would be wrong. A chip for a file
  that no longer exists is fine.
- **Cap.** At most 8 different paths per row get a unit or chip. Later ones stay text. The
  server checks each one once, and never looks at anything but the paths it found.
- **The text.** pi's own clipboard paths come out of the bubble, since the unit stands in for
  them. A `/tmp` image path you typed yourself stays in the text (it's part of your sentence)
  and still gets a unit. If nothing is left, there's no bubble (same rule as thumbnails). The
  session file, and the text the model saw, never change.
- **Order.** Stored images, then path attachments in the order they appear, then the bubble.
  All right-aligned.
- **Collapsed by default.** Pasted screenshots are big, and old ones are usually gone. The
  image is fetched only when you open the unit, from `GET /api/attachment`. The browser never
  reads `/tmp` itself.
- **Open.** It shows the image as a single thumbnail (the `.message-images-single` rules). A
  click opens the lightbox, scoped to that one image.
- **Gone.** `/tmp` gets cleaned, so this is the usual case for older sessions. The unit becomes a
  static row: no twist, no request, and it says "No longer in /tmp". A file over the 20MB
  serving cap says "Too large to show · {size}" instead.
- **Tokens.** The row uses the disclosure summary's metrics (`--control-sm` min height,
  `--fs-caption`, `--color-ink-muted`), with the summary's hover ground hanging off the right
  edge instead of the left. The name is `--font-mono` in `--color-ink-2`, truncated, and the
  full path is in `title`. The size is tabular. The opened body sits `--space-2` below the
  summary.
- **AT.** The native `<summary>` is the control. Its name reads "Attachment {name} · {size}".
  The thumbnail's alt is "Attachment {name} in your message", and that's also the lightbox
  caption.

**Other rows.** The path stays where it was written, so the prose still reads. It shows as a
compact chip, never as the raw long path.

```html
<!-- in a reply (markdown) or an info row (subagent report), in place of the path -->
<p>The screenshot at
  <button type="button" class="path-chip path-chip-missing" data-path-chip="/tmp/pi-clipboard-a587….png"
          aria-label="Copy path /tmp/pi-clipboard-a587….png, no longer in /tmp"
          title="/tmp/pi-clipboard-a587….png · No longer in /tmp. Select to copy the path.">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>
    <span class="path-chip-name">pi-clipboard-a587….png</span>
    <span class="path-chip-note">· No longer in /tmp</span>
  </button>
  shows the minimap.</p>

<!-- the file still exists: no note; opens the lightbox -->
<button type="button" class="path-chip" data-path-chip="…" data-available aria-haspopup="dialog"
        aria-label="Open image pi-clipboard-a587….png" title="/tmp/pi-clipboard-a587….png">…icon, name…</button>
```

- **Chip.** One line, inline with the text. Mono `--fs-mono` in `--color-ink-2` on
  `--color-sunken`, with a 1px `--color-border` edge (`--color-border-strong` on hover) and
  `--r-sm`. pi's clipboard names are shortened to the prefix and 4 characters of the uuid
  (`pi-clipboard-a587….png`). Other names show whole and truncate. The full path is always in
  `title`.
- **Available.** A click opens the lightbox on that one image. The alt and caption are
  "Attachment {name}". The cursor is `zoom-in`.
- **Gone.** The chip adds "· No longer in /tmp" in `--fs-caption`, with the name in
  `--color-ink-muted`. A click copies the full path ("Copied path."), and the cursor is `copy`.
- **Where.**
  - **Replies:** chips are placed while the markdown renders, in text only, never in code.
  - **Info rows** (custom messages, subagent reports): plain text with chips.
  - **Tool cards:** the Output `<pre>` stays verbatim, since it's the record of what ran, and
    the card is collapsed anyway. After Output (and Images), an "Attachments · {n}" section
    lists the same units a user row gets.
- **Streaming.** While a reply streams, its paths are plain text. Chips appear when the finished
  row arrives from the server: the refetch when the turn settles, a hello, or a watch append.
  Nothing jumps mid-stream.

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
textarea + actions. Under 480px of composer width, `Send`, `Steer`, and `Stop` drop to
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
- **Width.** It's capped at 200px (128px under 768px, and 88px when the session head is under
  520px, per §4f), and the label truncates. Its accessible
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

  <div class="model-menu-list" id="model-listbox" role="listbox" aria-label="Models" tabindex="-1"
       aria-activedescendant="mo-anthropic-claude-opus-5">  <!-- focused on open -->
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
  input plus the listbox, so the trigger says `aria-haspopup="dialog"`. **Opening focuses the
  listbox (`tabindex="-1"`), never the input.** On a phone a focused text input raises the
  keyboard over the sheet, and nobody asked to type yet. Focus moves to the input when the user
  taps it or starts typing. The listbox and the input both carry `aria-activedescendant`, which is
  the keyboard position. The option it points to gets `data-active` and draws the focus ring
  (inset 2px accent), because focus can't be seen anywhere else.
- **Mechanism.** It's a native `[popover="auto"]`, which puts it in the top layer. It isn't
  clipped by a `.pane` and needs no Portal. A click outside or `Esc` closes it for free. Render
  it once, next to the trigger. On open, measure the trigger with `getBoundingClientRect()` and
  set `--menu-top: {rect.bottom + 4}px` and `--menu-right: {innerWidth − rect.right}px`, then
  call `showPopover()`. **A resize never closes it.** A window or `visualViewport` resize
  (including a phone's keyboard opening) re-measures the trigger and re-anchors the menu. It
  closes only if the trigger isn't laid out anymore (`offsetParent === null` or a zero-size rect).
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
  - Filtering starts when the user types or taps the input. A printable key on the listbox (or
    Backspace with a query) moves focus into the input and applies that key, so typing is still
    the typeahead on a desktop.
- **On open.** The query is empty, the current model is active and scrolled into view
  (`block: "nearest"`), and the listbox has focus, not the input, so no on-screen keyboard.

### Keyboard

| Key | Where | Does |
|---|---|---|
| `Ctrl+P` / `⌘P` | anywhere while a **chat** session is open | Opens the menu, and closes it if it's open. Call `preventDefault()` so print never fires. In watch sessions and on the list view it isn't bound, and the browser prints as usual |
| `Enter` / `Space` | on the trigger | Opens |
| `↓` / `↑` | in the menu | Moves the active option, wrapping. Normally it skips disabled rows. When *every* row is disabled (Blocked), it moves through all of them, so the list stays browsable, and `Enter` does nothing |
| `PageDown` / `PageUp` | in the menu | Moves 8 options |
| `Home` / `End` | on the listbox | First / last option (in the input they move the caret) |
| Typing, `Backspace` | on the listbox | Moves into the input with that key, which filters |
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
| **Blocked: agent running** (`isStreaming`) | enabled, so pressing it shows the reason | `.banner.banner-info`: **Model changes wait until this turn finishes.** Stop or wait, then pick one. Every option gets `aria-disabled="true"`, and the list stays browsable. If a turn starts while the menu is open, the banner appears right away |
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

## 4d · Slash commands

pi's slash commands, offered while you type. The server sends the list once per connection as
`{type:"commands", commands}`. Names come without the slash (`sessions`, `skill:omarchy`).
Sending `/name args` as a normal prompt runs the command.

### When the menu opens

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

### Markup

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

### Filtering and order

- **Query.** The query is the token without its `/`, matched case-insensitively against `name`.
- **Order.**
  1. Names that **start with** the query.
  2. Names that **contain** it.
  3. Names whose **description** contains it.

  Within each tier, sort by name. An empty query (just `/`) lists every command by name.
- **Active option.** The first row becomes active whenever the results change.
- **Empty result.** Keep the menu open, drop the list, and show
  `<p class="command-menu-empty">0 commands match “/{query}”. Enter sends it as a message.</p>`.
  While it's empty, `Enter` is **not** intercepted: it sends, as the copy says.

### Keyboard and mouse

| Input | Does |
|---|---|
| `↓` / `↑` | Moves the active option, wrapping. It never moves the caret while the menu is open |
| `Enter` / `Tab` | Replaces the token with `/{name} ` (with a trailing space) and closes the menu. The caret lands after the space, so arguments come next. `Enter` doesn't send; the *next* `Enter` does |
| `Esc` | Closes the menu and leaves the text unchanged. It doesn't blur the textarea or clear the draft |
| Typing | Keeps filtering. A space or a caret move out of the token closes the menu |
| `Shift+Enter` | Newline as usual. The newline ends the token, so the menu closes |
| Mouse down on a row | Inserts, the same as `Enter`. Use `mousedown` + `preventDefault()` so the textarea keeps focus. Hover makes a row active |

### Commands button

A tap target for the same menu, for phones (where nobody types `/` from habit) and for
discoverability. It sits in `.composer-row` **immediately right of Attach Images**:

```html
<button class="button button-icon button-ghost composer-commands" type="button"
        aria-label="Commands" title="Commands"
        aria-haspopup="listbox" aria-controls="command-listbox" aria-expanded="false"
        aria-describedby="composer-reason">
  <span class="icon" style="--icon: url(/icons/command.svg)" aria-hidden="true"></span>
</button>
```

- **Icon.** `/icons/command.svg` is a `/` inside a rounded square, drawn on the system grid
  (24 viewBox, 1.5 stroke, round caps).
- **Tap.**
  - It **inserts `/` at the caret**, with a space before it if the character before the caret
    isn't whitespace, and focuses the textarea. The existing trigger rule then opens the menu
    with an **empty query**, so nothing new is needed in the menu logic.
  - If the caret is already inside a `/` token, it just refocuses the textarea and reopens.
  - Focus stays in the textarea, and `aria-activedescendant` works as before.
- **Undo on dismiss.** If the menu closes with `Esc` or blur while the token is **still exactly
  the bare `/` this button inserted**, remove that `/` (and the space it added). Opening and
  dismissing leaves the text as it was. A `/` the user typed is never removed.
- **`aria-expanded`** mirrors the menu, whichever way it opened. `aria-controls` points at
  `#command-listbox`, which exists only while the menu is open. Setting it at all times is
  harmless.
- **Disabled.** The button takes `aria-disabled="true"` exactly when the menu couldn't open:
  - the composer is disabled (it shares `aria-describedby="composer-reason"`, like Attach);
  - there's no command list yet, or it's empty. Then its `title` becomes "No commands
    available", and there's no composer reason.

  A tap on it does nothing.
- **Unchanged.** Typing `/`, and all the keyboard and touch behavior above, stay as they are.
- **Width budget.** Attach 44, Commands 44, and Send collapse to 44 under 480px of composer
  width (§4b), with 8px gaps:

  | Composer width | Idle textarea | Streaming (adds Stop 44) |
  |---|---|---|
  | 390 viewport (358 composer) | about 202px | about 150px |
  | 320 viewport (288 composer) | 132px | **Commands hides** (under 340px of composer width while Stop shows), so the textarea keeps 132px. `/` still opens the menu |

### Announcements

In the composer's polite live region, announce "{n} commands available." when the menu opens,
and again when the count changes, at most once a second. When there are none, announce
"0 commands match."

### In the thread

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
    **unknown** rows with the Raw entry disclosure). They may also send `ui_request`s (§6), or
    produce nothing visible.
- **Reload.** The persisted entries render the same way. The local "Ran" row is local only and
  isn't restored.
- **Unknown commands.** A `/word` that isn't in the list is sent and rendered as an ordinary
  message, with the optimistic bubble.

### Commands that need the terminal UI

Some extension commands open TUI-only interfaces, such as custom overlays and pickers. pi-web
can't show those. When a command's `ui_request` has a kind §6 doesn't support, or the server
reports the command needs the TUI (answer the request with `ui_response` `value: null` so the
command isn't left waiting), replace the "Ran" row with:

```html
<div class="info-row" role="note">
  <span class="info-row-text"><span class="icon icon-sm" style="--icon: url(/icons/attention.svg)" aria-hidden="true"></span>
    <span><code>/sessions</code> needs the terminal UI. Run it in pi in a terminal.</span></span>
</div>
```

Nothing in the contract says ahead of time which commands are TUI-only, so every command is
listed and choosable. If a flag is added later (for example `tui: true`), show "Needs the
terminal UI" in place of the description on line 2, and keep the row choosable.

### Tokens

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

### Contrast

| Pair | Dark | Light |
|---|---|---|
| Ink on surface or sunken (name) | 12.34 / 13.43 | 17.86 / 14.78 |
| Muted on surface or sunken (description, location) | 4.96 / 5.40 | 5.74 / 4.75 |
| Ink-2 on surface (chip) | 7.03 | 8.72 |
| Accent ring on sunken | 5.08 | 5.63 |

---

## 4e · Markdown and code

**Scope.** **assistant-text** rows render markdown. Everything else stays as it is:

- **user** text is plain, keeping `.message-text` and `white-space: pre-wrap`;
- **thinking** is plain inside its disclosure;
- **tool args and results** stay `<pre>` in mono, except file content (`write` content, `edit`
  before/after, `read` output), which is highlighted by its path with the theme below (§4d
  tool card).

The rendered content lives in one scope class on the bubble, and `.message-text` is dropped
there:

```html
<article class="message">
  <div class="message-head">…</div>
  <div class="message-body md">{rendered markdown}</div>
</article>
```

**Renderer rules** (any GFM renderer, e.g. `marked`, plus `highlight.js`; adding either
dependency needs approval under CLAUDE.md):

- **GFM on.** That gives tables, `~~strikethrough~~`, task lists, and autolinks for bare URLs.
- **Raw HTML is never rendered.** Any HTML in the model's output (block or inline) is emitted as
  **escaped text**. `<div onclick="x">hi</div>` shows literally, in the surrounding font, with
  no special styling. Don't sanitize-and-render, and don't strip it.
- **Links.**
  - Only absolute `http:`, `https:`, and `mailto:` URLs become links. Anything else (relative
    paths, `javascript:`, `file:`, `data:`) renders as its link text, unlinked.
  - Every link gets `target="_blank" rel="noreferrer"` and a trailing
    `<span class="visually-hidden"> (opens in a new tab)</span>`. The CSS adds the `external`
    glyph after it.
- **Headings** stay `h1`–`h6` in the DOM, but `.md` restyles them to bubble scale. `h1` and
  `h2` get `--fs-heading-s` at 600, and `h3`–`h6` get `--fs-body` at 600. They're never page
  size, because a message is not a page.

### Element styling (what `.md` gives you)

| Element | Treatment |
|---|---|
| `p` | `--space-3` apart |
| `ul` / `ol` | `--space-5` indent, `--space-1` between items, nested lists tight |
| Task list `- [x]` | `<li><input type="checkbox" checked disabled> …` from the renderer. The bullet is dropped and the box is static (disabled, not clickable, `accent-color: --color-ink-2`). AT reads it as "checkbox, checked, dimmed". No class is needed, because CSS matches `li:has(> input[type=checkbox])` |
| `blockquote` | A 1.5px `--color-border-strong` left rule, `--space-3` inset, `--color-ink-2` text |
| `hr` | A 1px `--color-border` rule with `--space-4` above and below |
| `del` | Strikethrough in `--color-ink-muted` |
| `strong` | 600 |
| `em` | Renderer default, which is synthetic oblique. Only regular faces ship, so it's allowed but not styled further |
| Inline `code` | The base rule: `--color-sunken` chip, `--r-xs`, mono. It wraps anywhere |
| Table | Always wrapped: `<div class="md-table-wrap"><table>…</table></div>`. The wrapper scrolls sideways, so the pane never widens. Header row on `--color-sunken` at 600, `--fs-caption` text, 1px row rules. Words never break mid-word, so the table grows and scrolls. `align` from GFM is honored, and right-aligned cells get tabular numerals |
| Links | `--color-accent`, underlined, with an external glyph (one of the accent's three uses, §0). Long URLs wrap anywhere |

### Code blocks

Wrap every fenced block like this:

```html
<div class="md-code">
  <div class="md-code-head">
    <span class="md-code-lang">ts</span>
    <button class="button button-sm button-ghost md-code-copy" type="button">
      <span class="icon icon-sm" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>Copy Code
    </button>
  </div>
  <pre><code class="hljs language-ts">{highlighted html}</code></pre>
</div>
```

- **Language label.** The first word of the fence's info string, lowercased, and shown in
  uppercase eyebrow type. No info string means "text".
- **Highlighting.**
  - Languages: the `highlight.js/lib/common` set plus clojure, cmake, dart, dockerfile, elixir,
    erlang, haskell, http, latex, nix, powershell, protobuf and scala.
  - The fence word goes through one alias table first (`resolveLanguage` in
    `src/lib/markdown.ts`): `ts`/`tsx` → typescript, `js`/`jsx`/`mjs` → javascript, `c++`/`hpp`
    → cpp, `c#`/`cs` → csharp, `sh`/`zsh`/`shell` → bash, `console` → shell (prompt
    transcripts), `yml` → yaml, `html`/`vue`/`svelte` → xml, `toml` → ini, `jsonc` → json,
    `text`/`txt`/none → plaintext (never highlighted). The label still shows the raw word.
  - Highlight only when `hljs.getLanguage(lang)` exists. Otherwise, escape the text and add no
    `hljs-*` spans.
  - Don't use auto-detect: it guesses wrong on short snippets, and a wrong guess looks worse
    than plain text.
- **Long lines** don't wrap: the `pre` scrolls sideways inside the block (`white-space: pre;
  overflow-x: auto`). Code keeps its shape, and the block never widens the pane, 320 included.
- **Copy Code.**
  - The skill has no code-block copy control, so this reuses our existing copy pattern (Copy
    Session Path, Copy Output): `.button-sm.button-ghost` with the `copy` icon. Size sm is
    allowed because it sits inside an already-reached context.
  - It copies the **raw source text**, never the highlighted HTML.
  - On success the icon turns into `check` and the label becomes "Copied" for 1.5s, then
    reverts. Announce "Copied code." in the polite live region.
  - No toast: the feedback sits where the click happened.
  - On failure the label becomes "Couldn't copy" for 1.5s.
- **Block tokens.** `--color-sunken` ground, a 1px `--color-border` edge, `--r-sm` (monospace
  corners), and code in `--color-ink`. The head is `--control-sm` tall with a 1px rule under it.

### Highlight theme (dark and light, tokens only)

The skill forbids the accent for syntax ("a keyword is not an action"). So the theme uses
weight and ink for structure, plus three status hues as *roles*. Those hues only ever appear
inside `.md-code` and `.toolcard-code`, so they never read as status.

| Role | highlight.js classes | Style | On sunken, dark / light |
|---|---|---|---|
| Keyword | `hljs-keyword` `-literal` `-selector-tag` `-doctag`, `.hljs-meta .hljs-keyword` | `--color-ink`, 600 | 13.43 / 14.78 |
| Type | `hljs-built_in` `-type` `-class` | `--color-ink`, 530 | 13.43 / 14.78 |
| Name | `hljs-title` (`.function_`, `.class_`), `-section` | `--status-info` | 6.47 / 5.27 |
| String | `hljs-string` `-regexp` `-char` `-symbol` `-template-tag` `-link` | `--status-success` | 7.19 / 5.04 |
| Number / attribute | `hljs-number` `-attr` `-attribute` `-variable` `-template-variable` `-selector-attr/-class/-id` | `--status-warn` | 6.98 / 4.90 |
| Comment | `hljs-comment` `-quote` `-meta` | `--color-ink-muted` | 5.40 / 4.75 |
| Punctuation | `hljs-params` `-property` `-punctuation` `-operator` `-subst` | `--color-ink-2` | 7.65 / 7.22 |
| Diff | `hljs-addition` / `-deletion` | `--diff-add-ink` on `--diff-add-bg` / `--diff-del-ink` on `--diff-del-bg`. The `+`/`−` sign carries the meaning too | 4.91 / 5.38 · 5.01 / 5.16 |
| Emphasis | `hljs-strong` / `-emphasis` | 600 / an underline in `--color-border-strong` (no italic face ships) | — |

Don't import a highlight.js stylesheet. These rules are the whole theme, and they follow
`data-theme` automatically.

### Images in markdown

- **`data:image/*` sources** (rare, and already local) render as a single §4b thumbnail. Use
  `<ul class="message-images message-images-single">`, alt "Image in this reply" or the
  markdown alt text if there is one, and the same lightbox.
- **Remote `http(s)` images are never fetched automatically**, because loading them would leak
  that you read this, from a local tool. They render as a link instead:

  ```html
  <a class="md-image-link" href="{url}" target="_blank" rel="noreferrer">
    <span class="icon icon-sm" style="--icon: url(/icons/image.svg)" aria-hidden="true"></span>Image: {alt or "untitled"}<span class="visually-hidden"> (opens in a new tab)</span>
  </a>
  ```

- **Anything else** renders as its alt text.

### Streaming

- **Re-rendering.** Re-parse the whole message's markdown per animation frame, not per delta.
  Swap the body's content in one go.
- **Open fences.** An **unclosed fence** mid-stream renders as an open code block, with its head
  and label as usual. Most GFM renderers already treat the rest of the text as code. Copy Code
  is present but copies what's there so far.
- **Highlighting.** Highlight a block only once its fence closes, or when the turn ends. While
  it's open it shows as plain escaped mono. Highlighting changes only color and weight, never
  line breaks, so it causes no layout jump.
- **Layout jumps.** Partial constructs (a table's header row before its separator, a half-typed
  `**bold`) render as text until they complete. That jump is accepted, and there's no height
  reservation. Auto-follow (§3) keeps the bottom pinned. When you're not following, the browser's
  scroll anchoring (`overflow-anchor`, on by default) holds your place.
- **Author.** The `.live-dot` stays in the author row as in §3, and there's no cursor glyph.

### Accessibility

- **Headings.** They stay real headings, so heading navigation works inside long replies.
  Their level comes from the markdown. Since the page's `h1` is the session title, that
  duplicates levels. That's accepted for model content, and they're never promoted.
- **Code.** A code block is a `pre` that screen readers read verbatim. The Copy Code name
  includes "Code", and the language label is visible text.
- **Tables** keep `th`, which the renderer produces.
- **Contrast.**

  | Pair | Dark | Light |
  |---|---|---|
  | Accent link on surface | 4.67 | 6.81 |
  | Ink-2 blockquote on surface | 7.03 | 8.72 |
  | Syntax colors on sunken | see the theme table | see the theme table |

---

## 4f · Context window

How full the model's context is, as of the last reply. The data is `ContextInfo
{ tokens, window | null }`, or `null` when there's no assistant turn yet. It appears in the
session head in **chat and watch** views.

### Plain text, not a meter

The readout is plain text. The skill's `.meter` puts the number first and the bar second, but in
a 56px head a 6px bar says less than "24%" and costs a line. So it's the number alone.
Closeness to the limit is carried by the number, then by hue, and at the top step by a glyph
too, so it never rests on hue alone.

### Markup

It goes after `.session-head-main`, **before** the model trigger in chat, or before the Live chip
in watch. A second copy leads the meta line for narrow heads, and CSS shows one or the other.

```html
<header class="session-head">
  …back…
  <div class="session-head-main">
    <h1 class="session-head-title" …>…</h1>
    <p class="session-head-meta">
      <span class="context-meta {context-warn|context-error}" aria-hidden="true">24%</span>
      <span class="context-meta" aria-hidden="true">·</span>
      <span class="text-mono" title="{cwd}">~/webapps/pi-web</span>
      …
    </p>
  </div>
  <span class="context-gauge {context-warn|context-error|context-compacted}" title="{exact sentence}">
    <!-- ≥95% only: -->
    <span class="icon icon-sm" style="--icon: url(/icons/alert-circle.svg)" aria-hidden="true"></span>
    <span class="context-label" aria-hidden="true">Context</span>
    <span class="context-value" aria-hidden="true">237k / 1M · 24%</span>
    <span class="context-pct" aria-hidden="true">24%</span>
  </span>
  <span class="visually-hidden" id="context-desc">{exact sentence}</span>
  …model trigger (chat) or Live chip (watch)… copy…
</header>
```

**AT.** All the visible context text is `aria-hidden`, because CSS hides one copy or the other.
The fact reaches AT through **one** sentence, `#context-desc`, which sits outside both copies and
is never hidden. Point the head title at it with
`<h1 class="session-head-title" aria-describedby="context-desc" …>`. When nothing is shown (no
reply yet), omit both the sentence and the `aria-describedby`.

### Format

| Value | Shows | Rule |
|---|---|---|
| Tokens under 1,000 | `812` | exact |
| Under 10k | `8.4k` | 1 decimal, and a trailing `.0` is dropped (`8k`) |
| 10k to under 1M | `237k` | whole thousands, rounded. A value that rounds to `1000k` shows as `1M` |
| 1M and up | `1M`, `1.5M`, `2.1M` | 1 decimal, `.0` dropped. 1,048,576 shows as `1M` |
| Percent | `24%` | `floor(tokens / window × 100)`, so it never shows 100% before the limit is actually reached. `<1%` when above 0 and under 1. Over the window it shows the real value (`103%`) |
| Full | `237k / 1M · 24%` | tokens / window · percent |
| Window unknown | `237k` | tokens only: no percent, no color steps |

The numbers are mono (`--font-mono`, `--fs-mono`) with tabular numerals, in `--color-ink-2`. The
word "Context" is `--fs-caption` in `--color-ink-muted`.

### Steps toward the limit

| Share of window | Class | Color | Extra |
|---|---|---|---|
| under 80% | none | `--color-ink-2` | — |
| 80% and up | `.context-warn` | `--status-warn` (6.42 dark / 5.93 light on the head's surface) | — |
| 95% and up | `.context-error` | `--status-error` (5.42 / 6.01) | The `alert-circle` glyph before "Context" |

Thresholds use the exact ratio, not the rounded percent. The meta-line copy takes the same class.

### Exact numbers (title and AT)

- **With a window:** "Context: 237,412 of 1,048,576 tokens (24%), as of the last reply."
- **Window unknown:** "Context: 237,412 tokens, as of the last reply. This model's limit is
  unknown."
- **Compacted:** "Context was compacted. The next reply reports the new size."

Use `title` on `.context-gauge` for hover, and the same text in `#context-desc` for AT. Use comma
thousands.

### States

| State | Shows |
|---|---|
| No assistant turn yet (`null` and no compaction row) | **Nothing.** No gauge and no meta copy. The empty state (§3) already says "Nothing sent yet", and a "No replies yet" readout would repeat an absence |
| Just compacted (`null` after a compaction row) | `.context-gauge.context-compacted`: "Context" plus "compacted" (in body type, muted). Narrow shows `compacted` in the meta line |
| Streaming | It keeps the last reply's value until the turn ends, then updates. It never animates and never pulses |
| Watch view | Same rules, from the same data |

### Width budget: what collapses first

It collapses by the **head's** width (a named container on `.session-head`, with an `@media`
floor, because these rules contract):

1. **Head ≥ 720px:** full, "Context 237k / 1M · 24%" (about 165px).
2. **520 to 719px:** the percent only, "24%" (or "237k", or "compacted"), still in the head.
3. **Under 520px** (320 included):
   - The gauge leaves the head, and the percent leads the meta line: `24% · ~/webapps/pi-web`.
   - The cwd truncates first.
   - The model trigger caps at 88px (the label truncates; the full id is in its `title`), so the
     title keeps about 75px at 320.

Order of sacrifice: the context label and fraction, then the context's place in the head, then
the cwd, then the model label's length. The title is the last thing to shrink.

Three more head rules cover every head, not just chat:

- **Aggregate chip.** Under 520px of head width, the head's aggregate `Team · {n} working` /
  `{n} working` link chip (§10) is hidden. It repeats the sidebar row's chip and the Agents
  foot row. Before this rule, a watched live session with a team at 320 had back, Team chip,
  Live, and copy, and that left the title block about 0px wide.
- **Archive over copy.** Under 520px of head width, on web sessions, Copy Session Path (the
  icon button right after `.session-archive`) is hidden and Archive stays, since it's the only
  archive control. With both, the title would get 24px at 320; with one, it gets 80px (numbers
  in §3, "Archive Session / Unarchive Session").
- **Floor.** `.session-head-main` has `min-width: 72px`. Whatever else lands in the head later,
  the title and meta line can't collapse to nothing. Extra chips overflow before the title
  disappears, and each new head chip needs its own narrow rule.
- **Mode trigger** (chat, §4g). Under 520px of head width it's icon-only: 44px, with its name in
  `aria-label`. Under 360px it's hidden, since the title can't spare 44px more (at 360 the title
  keeps about 76px). There, `/mode {name}` in the composer still switches.

### Tokens

`--font-mono`, `--fs-mono`, `--fs-caption`, `--color-ink-2`, `--color-ink-muted`,
`--status-warn`, `--status-error`, `--space-1`.

---

## 4g · Mode menu

pi's mode extension (`pi-config/extensions/mode`) has one **major mode**, `normal` or
`claude-heavy`, and any set of **minor modes** (today `align`). Both live in one global file,
`~/.pi/agent/mode.json`. The menu switches them from the chat header. The switch is global:
every chat this server has open follows it **from its next message**. You never start a new
chat or reconnect. New pi sessions, web or terminal, read the file when they start.

### Trigger

In chat sessions it sits right before the model trigger (§4c). A watched (TUI) session shows
nothing: the TUI keeps its mode in memory, so we can't say what it's using.

```html
<button class="button button-ghost mode-trigger" type="button" aria-haspopup="menu"
        aria-expanded="false" aria-controls="mode-menu"
        aria-label="Mode: claude-heavy · align" title="Mode: claude-heavy · align">
  <span class="icon icon-sm" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
  <span class="mode-trigger-label">claude-heavy · align</span>
  <span class="icon icon-sm" style="--icon: url(/icons/chevron-down.svg)" aria-hidden="true"></span>
</button>
```

- **Label.** The major mode, then each minor mode on, joined with " · ", in mono. It caps at
  200px and truncates, with the full text in `title`.
- **Name.** `aria-label` repeats the label with "Mode: " in front, so it survives when the label
  hides. A pending switch adds ", applies after this turn".
- **Narrow head.** Icon-only under 520px, and hidden under 360px (§4f).

### Menu

It uses the model menu's popover shell (`.model-menu`): a `[popover="auto"]` right-aligned under
the trigger, and a bottom sheet under 768px. The list inside is an ARIA **menu**. A listbox
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
  <p class="mode-menu-foot"><span class="text-mono">strict: off</span> · Applies to every web chat and
    new pi sessions. Open terminal sessions keep theirs until <code>/reload</code>.</p>
</div>
```

- **Choosing.** Picking a major mode closes the menu and returns focus to the trigger, like the
  terminal palette. Toggling a minor mode keeps the menu open, so you can set several. While the
  switch is saving, the rows are `aria-disabled`.
- **Checked.** A checked row gets `--color-accent-tint` and the check. The words carry the state
  too, since `aria-checked` is announced.
- **strict** is shown read-only in the foot. Change it in a terminal with `/mode strict on|off`.
- **Keyboard.** Roving `tabindex`, with real focus on the rows, so the standard focus ring shows.
  - On open, focus goes to the checked major mode.
  - `↑` / `↓` move and wrap. `Home` / `End` jump.
  - `Enter` or `Space` chooses or toggles.
  - `Esc` closes (native) and focus returns to the trigger. `Tab` closes and moves on.
- **Motion.** The same single fade as §4c.

### How a switch reaches open chats

The server writes `mode.json` first: it reads the file, changes only `mode` and `minorModes`,
and saves it atomically, so `strict` and the shortcuts are never dropped. Then each open chat
follows it:

- **A chat that has run** calls the extension's own `/mode` handler directly. That's the same
  code the terminal runs, so it leaves the same **marker** in the transcript: an info row
  "Mode → claude-heavy" or "Minor mode: align on". The command text never goes to the model.
  There's no reload, so the chat's subagent workers keep running.
- **A chat that was never prompted** reloads its runtime instead. That writes nothing to its
  file, and no workers can exist yet.
- **Mid-turn.** The running turn keeps the old mode, and so do messages queued during it
  (follow-ups and steers join that turn). The chat's menu shows an info banner, "Applies after
  this turn.", until the turn settles.
- **Can't switch.** If the mode extension isn't loaded in that chat, or another program wrote the
  session, the chat isn't touched. Its menu shows a warn banner, "Applies to new chats only."
- **A terminal switched it.** The server watches `mode.json`, so open web chats follow a switch
  made in a TUI too. Open terminal sessions don't watch the file: they pick up a web switch on
  `/reload`. The last writer wins.

### States

| State | Shows |
|---|---|
| Idle | Trigger label, and the current rows checked |
| Saving | Rows `aria-disabled` (the cursor is `progress`) |
| Mid-turn switch | Info banner "Applies after this turn." (trigger name adds it too) |
| Chat can't switch | Warn banner "Applies to new chats only." |
| Save failed | Error banner "Couldn't switch the mode." with the reason. The mode is unchanged |
| Load failed | Error banner "Couldn't load the modes." |

### Tokens

Trigger: like `.model-trigger` (`--font-mono`, `--fs-mono`, `--color-ink-2`, sunken fill while
open, icons `--color-ink-muted`). Rows: `--control-md` min height, `--space-2` / `--space-3`
padding, id in `--font-mono` `--color-ink`, description `--fs-caption` `--color-ink-muted`,
checked `--color-accent-tint`, focus `--focus-ring` inset. Foot: `--fs-caption`
`--color-ink-muted` over a `--color-border` rule.

### Rejected

- **A segmented control in the composer.** It reads as a per-message option, not a global
  switch, and it costs composer width at 320px.
- **A settings page.** That's not first-class, and it's far from the chat it affects.
- **`/mode` only.** It works today (the slash menu lists it), but nobody finds it, and it can't
  show the current mode.
- **Reloading every open chat.** A runtime reload stops that chat's subagent workers, which
  would end claude-heavy teams mid-task.

---

## 5 · New Session dialog

Triggered by `New Session` (sidebar head, and the empty states).

The folder is **chosen, never typed**. The Folder field is a button showing the chosen path. It
opens a folder picker in place, under the field, inside the same dialog.

```html
<!-- Portal to body -->
<div class="scrim"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title">
  <div class="modal-head"><h2 class="modal-title" id="ns-title">New Session</h2></div>
  <form class="modal-body" id="ns-form">
    <div class="field">
      <label class="field-label" for="ns-cwd">Folder</label>
      <button type="button" class="input input-mono folder-field" id="ns-cwd" title="/home/user/webapps/pi-web"
              aria-expanded="true" aria-controls="ns-picker" aria-describedby="ns-cwd-hint ns-cwd-error">
        <span class="folder-field-value truncate">~/webapps/pi-web</span>  <!-- none yet: .folder-field-empty "Choose a folder" -->
        …chevron-down, class="icon icon-sm icon-twist" (turns 180° while open)…
      </button>
      <span class="field-hint" id="ns-cwd-hint">pi runs in this folder and can read and change files in it.</span>
      <span class="field-error" id="ns-cwd-error"><!-- on error only --></span>
    </div>

    <!-- Open picker (replaces the recent list while open) -->
    <div class="folder-picker" id="ns-picker" role="group" aria-label="Choose a folder" tabindex="-1"
         aria-activedescendant="ns-pf-0">  <!-- focused on open, not the filter -->
      <div class="folder-picker-bar">
        <nav class="folder-crumbs" aria-label="Path">
          <ol>
            <li><button type="button" class="folder-crumb" title="/home/user">~</button></li>
            <li><button type="button" class="folder-crumb" title="/home/user/webapps">webapps</button></li>
            <li><span class="folder-crumb-current" aria-current="location">pi-web</span></li>
          </ol>
        </nav>  <!-- outside $HOME the first crumb is "/" (li.folder-crumbs-root); Recent view: one current crumb "Recent folders" -->
        <button type="button" class="button button-ghost">Home</button>
        <button type="button" class="button button-ghost" aria-pressed="false">Recent</button>
      </div>
      <div class="search">
        …search icon…
        <input class="input" type="text" role="combobox" aria-label="Filter folders in pi-web"
               aria-expanded="true" aria-controls="ns-picker-list" aria-autocomplete="list"
               aria-activedescendant="ns-pf-0" aria-describedby="ns-picker-note" placeholder="Filter">
      </div>
      <ul class="list folder-list folder-picker-list" id="ns-picker-list" role="listbox" aria-label="Subfolders of pi-web">
        <li id="ns-pf-0" class="list-row list-row-interactive" role="option" aria-selected="true" title="/home/user/webapps/pi-web/docs">
          …folder… <span class="list-title truncate">docs</span> …chevron-right…
        </li>
        <li id="ns-pf-1" class="list-row list-row-interactive" role="option" aria-selected="false" title="…">
          …folder… <span class="list-title truncate">shared</span> <span class="folder-picker-link">link</span> …chevron-right…
        </li>
      </ul>
      <p class="folder-picker-note" id="ns-picker-note" aria-live="polite"><!-- state text, or empty (hidden) --></p>
      <div class="folder-picker-foot">
        <label class="folder-picker-hidden"><input type="checkbox"> Show hidden folders</label>
        <span class="modal-spacer"></span>
        <button type="button" class="button">Use This Folder</button>
      </div>
    </div>

    <!-- Closed picker: the recent list, as before -->
    <div class="field">
      <span class="field-label" id="ns-recent">Recent folders</span>
      <ul class="list folder-list" role="listbox" aria-labelledby="ns-recent">
        <li class="list-row list-row-interactive" role="option" aria-selected="true" tabindex="0">
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

**Surface: an in-place panel, not a nested dialog.** The picker opens under the field, inside
the dialog that's already open. The chosen path, the breadcrumb, and Create Session stay in one
view, so there's no second scrim, no second focus root, and no sheet on a sheet at folded width.
We rejected a nested `.modal` (the §5 dialog opening another dialog): it hides the dialog it
belongs to, and on a phone it becomes a bottom sheet over a bottom sheet. A §4c-style popover
doesn't fit either, because the picker needs a filter, a scrolling 44px list, and a breadcrumb,
and a popover inside a sheet would clip them.

**No free typing.** The user asked for it gone, so there is no path input and no paste
affordance. Every folder is reached by clicking or by the keyboard, and the filter only narrows
the current list. A folder with no readable route to it (say, an unreadable parent) can't be
chosen here. Start that session from a TUI.

- **Prefill.** The `cwd` of the open session, else the most recently active session's `cwd`. The
  field shows it with `~`, and the full path goes in `title`. With no prefill it reads "Choose a
  folder" in `--color-ink-muted`, and Create Session is `aria-disabled`.
- **The choice is where you are.** Opening a folder in the picker makes it the chosen folder,
  and the field updates as you go. Create Session creates the session in the folder the field
  shows, with the picker open or closed. "Use This Folder" and Enter on an empty list just close
  the picker.
- **Opening.** Clicking the field, or Enter/Space on it, toggles the picker (`aria-expanded`). It
  opens at the chosen folder, or at `$HOME` when there is none. **Focus goes to the panel
  (`tabindex="-1"`), never the filter**, because a focused text input raises a phone's keyboard.
  Filtering starts when the user taps the filter, or types while the panel has focus. The key
  then moves into the filter.
- **Listing.** `GET /api/folders?path=` (§REST in `shared/protocol.ts`) returns subfolders only,
  never files: dot folders only with "Show hidden folders", symlinks to folders marked "link",
  names A to Z case-insensitively, at most 500. No path means `$HOME`. The first answer for
  `$HOME` also seeds `home()` when the session list couldn't.
- **Navigating.** Click a row, or Enter on the active row, to open it. Go up by clicking a
  breadcrumb segment, or with Backspace or ← while the filter is empty. **Home** opens `$HOME`.
  **Recent** (`aria-pressed`) swaps the list for the folders sessions already use, and opening one
  jumps there. Pressing Recent again goes back to the folder you were in.
- **Filter.** Narrows the current list as you type (case-insensitive substring). It clears on
  every navigation.
- **Recent folders, picker closed.** The distinct session `cwd`s, most recently active first, up
  to 20. Click or Enter/Space picks one, and double-click picks it and submits, as before. The list
  is hidden while the picker is open, since Recent is there.
- **Submitting.** Create Session posts `{cwd}`. While pending, the button shows "Creating…" and
  is `aria-disabled`. Enter inside the picker never submits.
- **On success.** Close the dialog, navigate to the new session, and focus the composer, except
  on a touch-only device (`(hover: none) and (pointer: coarse)`), where that would raise the
  keyboard over the empty session. There the user taps the composer.
- **On a server 4xx.** Show `.field-error` with the server's message, or "That folder doesn't
  exist. Pick one that does." Set `aria-invalid="true"` on the field, close the picker, and move
  focus to the field. The dialog stays open with the choice intact.
- **Other errors.** Show a `.banner.banner-error` inside `.modal-body`: "Couldn't create the
  session. Nothing was written. Try again."
- **Focus.** The dialog traps focus, with initial focus on the Folder field. While the picker is
  open it traps focus inside itself. Esc closes the picker only, and focus returns to the field.
  Esc with the picker closed, Cancel, and a scrim click close the dialog, and focus returns to
  the button that opened it. Below 768px the same markup renders as a bottom sheet. A viewport
  resize, a phone's keyboard opening included, never closes the dialog or the picker. Both are
  in-flow and have no resize handling.

**Picker states** (in `.folder-picker-note`, `aria-live="polite"`; empty when there's nothing to
say):

| State | Note |
|---|---|
| Loading | Loading folders… (the list is `aria-busy`) |
| No subfolders | No subfolders in {name}. You can still start the session here. |
| Filter matches nothing | 0 of {n} match “{filter}”. |
| Over 500 | Showing the first 500 folders, A to Z. Filter to narrow them. |
| 403 | pi-web can't read this folder. Pick another one. |
| 404 (e.g. a deleted prefill) | This folder doesn't exist. Pick another one. |
| Other failure | Couldn't list this folder. {server message} |
| Recent, none yet | No recent folders yet. Sessions you start add theirs here. |

**Keyboard** (on the panel or in the filter; both carry `aria-activedescendant` for the
listbox):

| Key | Does |
|---|---|
| ↓ / ↑ | Next / previous folder (stops at the ends) |
| Home / End | First / last folder (with an empty list they move the caret) |
| Enter | Open the active folder; with no rows, close the picker |
| Backspace, ← | Up one folder, only while the filter is empty |
| Esc | Close the picker (the dialog stays) |
| Typing | On the panel: moves into the filter with that character (Backspace there edits a non-empty filter) |
| Tab / Shift+Tab | Cycle through the crumbs, Home, Recent, the filter, Show hidden folders, and Use This Folder (Shift+Tab from the panel wraps to Use This Folder) |

**Accessibility.**

- The listbox is `role="listbox"` driven from a `role="combobox"` filter, not a `tree`. You see
  one level at a time and move between levels by opening folders, which is a list with
  navigation. A tree would claim expandable nodes and ← / → semantics that this doesn't have.
- The active option is `aria-selected="true"` (selection follows focus) and scrolls into view.
- The breadcrumb is `<nav aria-label="Path">` with the current folder as
  `aria-current="location"` and not a button.
- The field is a `<button>` labelled by the `<label for>` and described by the hint and error.
- Every control is at least 44px: crumbs (`--tap-min` wide and tall), Home, Recent, the rows,
  the checkbox row, and Use This Folder.

**Tokens.** Modal `--color-surface`, `--r-xl`, `--shadow-3`, border `--color-border`, and scrim
`--scrim`. Title `--fs-heading-m`. Field: `.input` with `--font-mono`. Picker `--color-sunken`,
`--r-lg`, `--color-border`, padding `--space-3`, gap `--space-2`. Crumbs `--font-mono` /
`--fs-mono` in `--color-accent` (links), with the current one `--color-ink` `--fw-semibold` and
`/` separators in `--color-ink-muted`. Lists `--color-bg` with `--r-md`, rows `--row-height` in
`--font-mono`, and the active or selected row `--color-accent-tint`. Note `--fs-caption` in
`--color-ink-2`. "link" `--fs-caption` in `--color-ink-muted`.

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
| New product components: `.app`, `.sidebar-*`, `.search`, `.session-*`, `.transcript*`, `.disclosure*`, `.toolcard*`, `.info-row`, `.run-status`, `.jump-latest`, `.composer*`, `.folder-list`, `.folder-field*`, `.folder-picker*`, `.folder-crumb*`, `.brand`, `.live-dot`, `.chip-live`, `.icon`, `.skip-link`, `.truncate`, `.banner-main/-action`, `.message-time/-text`, `.modal-spacer` | Built only from system tokens and patterns. The tool card is the skill's tool-turn chat style (sunken, mono) turned into a disclosure so arguments and output fit. `.chip-live` applies the skill's run-pulse to a chip |
| Insights components: `.sidebar-foot`, `.insights*`, `.usage-*`, `.team-*`, `.agent-card`, `.member-*`, `.outline*`, `.compaction*`; the skill's `.card-*` and `.meter*` families brought in | Built from system tokens and the skill's card, meter, list, chip, and disclosure patterns (§10) |
| `.meter-fill` is `--color-ink-muted`, not `--color-accent` | pi-web's accent is reserved for primary, live, and focus (§0). At ≥80% the fill turns `--status-warn`, at ≥100% `--status-error`, always under a chip that says the word |
| New tokens: `--sidebar-width`, `--composer-max`, `--tool-output-max`, `--outline-max`, `--scrim`, `--skeleton-sweep` | Layout sizes, plus the two alpha values the skill already hard-codes inline (scrim, skeleton sweep), lifted into tokens so they theme correctly |
| Brand: `pi-web-mark.svg` (a stroked π) and the wordmark "pi-web" set in Inter 640 at −.03em | The Fold symbol is not used. It's a placeholder mark on the system's icon grid, and swappable |
| Composer buttons go icon-only under 480px of composer width (`.button-label` visually hidden) | Keeps the textarea usable at 320px while streaming. Each button keeps its accessible name, and Send stays the filled primary |
| Lightbox is a native `<dialog>` rather than the skill's `.scrim` + `.modal` | Top layer, inert page, and native Esc handling. It's full-bleed because it shows content rather than asking a question |
| Model picker is a `[popover]` + combobox + listbox (the skill's `.popover` is a plain action menu) | Choosing one value from a set is a listbox. The popover gives top layer and light dismiss. Rows keep the 44px target and hover/active never hide an action |
| `Ctrl+P` is taken over in chat sessions | Mirrors pi's TUI palette. It's bound only where a model can change, so print still works everywhere else |
| `.button-sm` used for Retry, Copy Output, and Open for Chat | Always inside an already-reached context (a banner or a card), never the sole action on a surface, which the skill allows |
| `--measure` grows from 72ch to a 110ch cap with the pane from unfolded up (the skill fixes it at 72ch) | Requested: the chat column was too narrow on desktop. A transcript is mostly code, diffs, and tool output rather than running prose, and they wrap badly at 72ch. Folded width keeps 72ch exactly (§3 "Column width") |

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
- **Layout:** `--measure` (72ch at folded width; from unfolded up
  `clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`, §3 "Column width"),
  `--bp-unfolded`

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
| Row busy chip | Busy (static, no pulse) · `title`: "pi is replying in this session" · visually hidden suffix: ", pi is replying in this session" |
| Untitled row | Untitled (muted) |
| Top region head | Live & web · {n} · searching: Live & web · {hits} of {total} |
| Archive head | Archive · {n} · searching: Archive · {hits} of {total} |
| Empty top region note | 0 sessions open in a TUI, or started here and not archived. The archive below has the rest. |
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
| Archive button / toasts | `aria-label` "Archive Session" · "Unarchive Session" (shown at every width; under 520px of head it replaces Copy Session Path) · disabled `title` "Open in a TUI. It stays on top while live." · toasts "Archived. Find it under Archive." · "Moved back to Live & web." · error "Couldn't archive this session. {server message}" |
| Copy output button / toast | `Copy Output` · toast "Copied output." |
| Unknown entry | Unrecognized entry `{raw.type}` · disclosure label "Raw entry" |
| Long tool output | `Show All {n} Lines` |
| Tool chips | Running · Done · Failed · No result |
| Tool output label | Output · on error: Error |
| Stopped turn (info row) | Stopped by you at `{HH:MM}`. |
| Report row, closed | {id} · {name} · chip · {first line} (hidden prefix "Report from ", or "Message: " without an agent) |
| Report chips | Failed · Stopped · Aborted · Success · Done · Starting · Running · Waiting · Stopping |
| Report, open | Error: {message} · Session `{path}` · No output. · Truncated at 4000 characters. Use agent_transcript for the rest. |

### Live-watch

| Where | Copy |
|---|---|
| Head Live chip `title` | Open in pi in a terminal · pid {pid} · {live.status} (the persistent "Live from TUI" banner was removed) |
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
| Buttons | `Send` · streaming: `Steer` + `Stop` · after Stop is pressed: "Stopping…" in run status |
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
| Path attachment summary | Attachment {name} · {size} |
| Path attachment, file gone | No longer in /tmp · over the cap: Too large to show · {size} |
| Alt, path attachment | Attachment {name} in your message |
| Path chip `aria-label` | Open image {name} · gone: Copy path {path}, no longer in /tmp |
| Path chip, gone | · No longer in /tmp (`title`: "{path} · No longer in /tmp. Select to copy the path.") · on copy: Copied path. |
| Tool card section label (paths) | Attachments · {n} |
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
| Blocked, running | **Model changes wait until this turn finishes.** Stop or wait, then pick one. |
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

### Mode menu

| Where | Copy |
|---|---|
| Trigger | {mode} · {minor} … (`aria-label`/`title`: "Mode: {label}", plus ", applies after this turn" when pending) |
| Menu `aria-label` | Mode |
| Group labels | Major mode · Minor modes |
| Descriptions | normal: Pi as usual · claude-heavy: Orchestrate: delegate coding and planning to Claude Code workers · minors: from pi-config `MINOR_DESCRIPTIONS` |
| Foot | strict: {on\|off} · Applies to every web chat and new pi sessions. Open terminal sessions keep theirs until `/reload`. |
| Pending | **Applies after this turn.** This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one. |
| Can't switch | **Applies to new chats only.** This chat can't switch: the mode extension isn't loaded here, or another program wrote this session. |
| Save failed | **Couldn't switch the mode.** {reason}. Your mode is unchanged. |
| Load failed | **Couldn't load the modes.** Your mode is unchanged. Close this and try again. |
| Transcript marker | Mode → {mode} · Minor mode: {minor} on\|off |
| Toast (from the extension) | Mode: {mode} · Minor mode: {minor} on\|off |

### Context window

| Where | Copy |
|---|---|
| Label (head ≥720px) | Context |
| Value | `{tokens} / {window} · {pct}%` (e.g. `237k / 1M · 24%`) · window unknown: `{tokens}` |
| Narrow (head <720px, and the meta line <520px) | `{pct}%` · window unknown: `{tokens}` |
| Compacted | compacted |
| Title / AT, with a window | Context: {tokens, comma thousands} of {window} tokens ({pct}%), as of the last reply. |
| Title / AT, window unknown | Context: {tokens} tokens, as of the last reply. This model's limit is unknown. |
| Title / AT, compacted | Context was compacted. The next reply reports the new size. |
| No reply yet | (nothing shown) |

### Markdown and code

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

### Slash commands

| Where | Copy |
|---|---|
| Commands button `aria-label` / `title` | Commands · no list: `title` "No commands available" |
| Menu head | Commands · {n} |
| Listbox `aria-label` | Commands |
| Row name | /{name} |
| Source chip | ext · prompt · skill |
| Empty | 0 commands match “/{query}”. Enter sends it as a message. |
| Foot (≥768) | `Enter` or `Tab` to insert · `Esc` to close |
| Announce | {n} commands available. · empty: 0 commands match. |
| Thread row after sending | Ran `/{name} {args}` |
| Needs TUI (thread row) | `/{name}` needs the terminal UI. Run it in pi in a terminal. |
| Needs TUI (menu line 2, if the contract gains a flag) | Needs the terminal UI |

### New Session dialog

| Where | Copy |
|---|---|
| Title | New Session |
| Field label / hint | Folder · pi runs in this folder and can read and change files in it. |
| Field, nothing chosen | Choose a folder |
| Recent label | Recent folders |
| Picker | group label "Choose a folder" · breadcrumb `aria-label` "Path" · buttons `Home`, `Recent`, `Use This Folder` · checkbox "Show hidden folders" · filter placeholder "Filter", `aria-label` "Filter folders in {name}" / "Filter recent folders" · list `aria-label` "Subfolders of {name}" / "Recent folders" · symlink tag "link" |
| Picker notes | Loading folders… · No subfolders in {name}. You can still start the session here. · 0 of {n} match “{filter}”. · Showing the first 500 folders, A to Z. Filter to narrow them. · pi-web can't read this folder. Pick another one. · This folder doesn't exist. Pick another one. · Couldn't list this folder. {server message} · No recent folders yet. Sessions you start add theirs here. |
| Buttons | `Create Session` (pending: "Creating…") · `Cancel` |
| 4xx error | {server message}, or: That folder doesn't exist. Pick one that does. |
| Other error | **Couldn't create the session.** Nothing was written. Try again. |

### Insights (§10)

| Where | Copy |
|---|---|
| Foot row 1 (→ `#/usage`) | Glance: `C {pct}%` `O {pct}%` `OL {pct}%` `Z {pct}%` (Claude, OpenAI, Ollama Cloud, Z.ai) · no data: Usage · `title`/`aria-label`: Usage: {Provider} {window} {pct}%, … (stale providers add " (stale)") |
| Foot row 2 (→ `#/agents`) | `{n} teams` · `{w} working`, joined by ` · `, zero segments left out · nothing to report: Agents |
| Provider names | Claude · OpenAI · Ollama Cloud · Z.ai |
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
| Meter context | Resets in {2h 17m} (under 24h) · Resets {Sep 25} · reset already passed: Reset at `{HH:MM}`. New reading at the next refresh. |
| Usage chips | Near limit · Rate-limited · Quota used · Stale |
| Stale usage (banner-warn) | **Usage is {42m} old.** It refreshes while pi runs in a terminal. Open a pi session, or run `/usage-refresh` in one. |
| Usage file missing (`reason:"missing"`) | **No usage data yet.** The usage-status extension writes `~/.pi/agent/cache/usage-status.json` while pi runs, and we haven't found it. |
| Usage file corrupt (`reason:"corrupt"`) | **Couldn't read usage.** `usage-status.json` isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh. · button: `Retry` |
| Request failed | Usage: **Couldn't load usage.** · Agents: **Couldn't load agents.** Then: Nothing was changed. {server message} · button: `Retry` |
| Provider `nologin` | Not signed in. Run `claude /login` and it'll show at the next refresh. (OpenAI: `pi /login`) |
| Provider `expired` | Sign-in expired. Run `claude /login` to renew it. (OpenAI: `pi /login`) |
| Provider `nokey` | No Ollama Cloud key in `~/.pi/agent/auth.json`. · Z.ai: No Z.ai API key in `~/.pi/agent/auth.json`. |
| Provider `badkey` | Ollama Cloud refused the key in `~/.pi/agent/auth.json`. · Z.ai: Z.ai refused the API key in `~/.pi/agent/auth.json`. |
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
  <a class="list-row list-row-interactive insights-row" href="#/usage" aria-current="page"
     title="Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80% (stale), Z.ai 5-hour 0%"
     aria-label="Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80% (stale), Z.ai 5-hour 0%">
    <span class="icon" style="--icon: url(/icons/gauge.svg)" aria-hidden="true"></span>
    <span class="insights-row-text usage-glance">
      <span class="usage-glance-item"><span class="usage-glance-tag">C</span><span class="text-num">47%</span></span>
      <span class="usage-glance-item usage-glance-item-high"><span class="usage-glance-tag">O</span><span class="text-num">95%</span></span>
      <span class="usage-glance-item usage-glance-item-stale"><span class="usage-glance-tag">OL</span><span class="text-num">80%</span></span>
      <span class="usage-glance-item"><span class="usage-glance-tag">Z</span><span class="text-num">0%</span></span>
    </span>
  </a>
  <a class="list-row list-row-interactive insights-row" href="#/agents"><!-- aria-current on #/agents and #/agents/* -->
    <span class="icon" style="--icon: url(/icons/worker.svg)" aria-hidden="true"></span>
    <span class="insights-row-text"><span class="text-num">2</span> teams · <span class="text-num">3</span> working</span>
  </a>
</div>
```

The foot holds **two stacked 44px rows, and both are always present**, so the layout never
jumps. `.list-row`'s bottom border divides them. A single row split into two links was
rejected: 288px divided in two truncates "Claude 5-hour 96%". Neither row has a chevron. They're
whole-row links with a hover state and the `aria-current` tint, like session rows, and the Usage
glance needs the room.

- **Usage row, a glance at every provider:**
  - One segment per provider, in the fixed order Claude, OpenAI, Ollama Cloud, Z.ai. The tags
    are exactly `C`, `O`, `OL`, `Z`, followed by a mono `{pct}%`.
  - **Window.** Each provider shows the window flagged `active` (the first one, if several
    are flagged). Otherwise it shows its 7-day window, and failing that, its longest. Ollama
    shows Monthly. Z.ai shows its plan window (5-hour), never MCP uses. An active window gets
    no marker in the glance ("C 55%"); the tooltip names it: "Claude 7-day Fable 55%".
  - **Missing data.** A provider that isn't `ok`, or has no windows, is left out. With nothing
    at all, the row reads "Usage".
  - **High.** At 80% or more, the item takes `.usage-glance-item-high`: semibold ink, and **no
    hue**. The foot has no word to pair with a color, and the Usage page's chip carries the
    status.
  - **Stale.** When a provider has `error` with kept windows, or `usage.stale` is true, the item
    takes `.usage-glance-item-stale`: muted, with no added text.
  - **Full text.** The row's `title` and `aria-label` spell everything out, e.g. "Usage: Claude
    7-day 47%, …", and a stale provider gets " (stale)" appended.
  - **Width.** The worst case, all four at 100%, is about 210px. It fits the 320px sidebar
    without wrapping, and `.usage-glance` still clips rather than wraps as a guard.
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
  Ollama Cloud, Z.ai. Z.ai follows the system like every other provider: no brand color, and
  the title is "Z.ai".
- **Scoped and active windows (any provider).**
  - A window with a `scope` is labeled `{window} {scope}`, e.g. "7-day Fable", the same form as
    "7-day Opus". It stays in source order, so Claude reads 5-hour, 7-day, 7-day Fable.
  - For the head chip, a scoped 7-day counts as a long window.
  - A window with `active: true` carries a neutral badge inside its label: `<span
    class="meter-label">7-day Fable <span class="chip chip-count" title="The window your current
    model counts against">Active</span></span>`. The badge has no dot, no hue, and no pulse,
    the same pattern as the Orchestrator badge.
- **Z.ai windows.**
  - The plan window is labeled like the others (`5h` → "5-hour"), and takes its reset from
    `resetsAt` when one is sent.
  - `mcp` is "MCP uses", the MCP tool-usage quota, shown as a percentage. Its context reads
    "{used} of {limit} uses" (comma thousands) when the window carries both `used` and `limit`
    (optional fields on `UsageWindow`), and is otherwise left out.
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
  | A 7-day, monthly, or MCP-uses window ≥ 100% | `.chip.chip-error` "Quota used" (waits for the reset) |
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
