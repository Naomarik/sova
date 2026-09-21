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

## Class index (all in `src/design/base.css`)

| Need | Classes |
|---|---|
| App shell | `.app[data-view="list\|session"]` `.app-sidebar` `.app-main` `.app-back` `.pane` `.skip-link` `.pane-resizer` (+ `html.is-resizing`) |
| Sidebar | `.sidebar-head` `.brand` `.sidebar-spacer` `.sidebar-search` `.sidebar-list` `.sidebar-region` `.sidebar-region-head` `.sidebar-region-count` `.sidebar-region-note` `details.sidebar-archive` · in `src/app.css`: `.archive-date` `.archive-date-label` `.archive-date-name` `.archive-tools` `.cleanup-intro` `.cleanup-choices` `.cleanup-choice` |
| Search | `.search` (wraps `.icon` + `input.input` + clear `.button.button-icon`) `.search-count` |
| Session rows | `li.session-row-shell` (`.session-row-shell-current` when open) wrapping `.session-rail` + `.list-row.list-row-interactive.session-row` `[aria-current="page"]` `.list-main` `.list-title` `.list-summary` `.list-meta` · lines 2–3 `.list-line` (`.list-summary-row` `.list-meta-row`) carrying `.chip.chip-count.session-topics` and `.context-ring` · group chrome `.session-group` `.list-group-label` `.session-group-path` (+ `<bdi>`) `.list` |
| Session row state (left rail) | `.session-rail` `.session-rail-item` `.session-rail-state` (+ `.chip.chip-accent` TUI or `.chip.chip-info.chip-live` Busy) `.session-rail-dot` `.session-rail-count` `.session-rail-count-live` |
| LIVE badge / status | `.chip` `.chip-dot` `.chip-accent` `.chip-live` `.chip-success` `.chip-error` `.chip-warn` `.chip-info` `.chip-count` |
| Buttons | `.button` `.button-primary` `.button-destructive` `.button-ghost` `.button-sm` `.button-icon` (needs `aria-label`) |
| Icons | `.icon` (20px) `.icon-sm` (16px) `.icon-twist` (rotates in open disclosures). Works on an inline `<svg>` or a mask `<span class="icon" style="--icon:url(/icons/x.svg)">` |
| Modal | `.scrim` `.modal` `.modal-head` `.modal-title` `.modal-body` `.modal-foot` `.modal-spacer` `.folder-list` |
| Folder picker (§5) | `.folder-field` `.folder-field-value` `.folder-field-empty` `.folder-picker` `.folder-picker-bar` `.folder-crumbs` `.folder-crumbs-root` `.folder-crumb` `.folder-crumb-current` `.folder-picker-list` `.folder-picker-link` `.folder-picker-note` `.folder-picker-foot` `.folder-picker-hidden` |
| Form fields | `.field` `.field-label` `.field-hint` `.field-error` `.input` `.input-mono` `.textarea` |
| Main head | `.session-head` `.session-head-main` `.session-head-title` `.session-head-meta` `.session-archive` · worker count `a.chip.chip-count.session-head-working` (`{n}` + `worker` icon) |
| Transcript | `.transcript` (+ `.pane`) `.transcript-banner` `.transcript-inner` `.thread` |
| Messages | `.message` `.message-user` `.message-streaming` `.message-head` `.message-author` `.message-time` `.message-body` `.message-text` |
| Thinking / raw JSON | `details.disclosure` `.disclosure-summary` `.disclosure-label` `.disclosure-preview` `.disclosure-body` |
| Tool card | `details.toolcard` `.toolcard-summary` `.toolcard-name` `.toolcard-arg` `.toolcard-body` `.toolcard-section` `.toolcard-section-label` `.toolcard-output` `.toolcard-output-error` · file content (write, edit, read): `.toolcard-path` `pre.toolcard-code` `.toolcard-code-del` `.toolcard-code-add` with `.hljs-*` roles. The running, done and failed states are chips (§3) |
| Info / unknown row | `.info-row` `.info-row-text` |
| Report row (§3 "report") | `details.disclosure.report` `.report-summary` `.report-from` (+ `.chip`, `.disclosure-preview`) `.report-body` `.report-meta` `.report-error` |
| Banner | `.banner` `.banner-info` `.banner-warn` `.banner-error` `.banner-success` `.banner-icon` `.banner-main` `.banner-title` `.banner-body` `.banner-action` |
| Streaming | `.live-dot` `.run-status` `.run-status-detail` `.jump-latest` · the row also hosts `button.run-status-link` triggers (§11 subagents, §12 inputs), both `aria-controls="session-pane"` |
| Composer | `.composer` `.composer-inner` `.composer-row` `.composer-input` (with `.input.textarea`) `.composer-actions` `.composer-foot` `.composer-reason` `.composer-hint` `.button-label` `.composer-drop` + `.composer[data-drop="active\|reject"]` |
| Model indicator (§4) | `button.composer-model` (the flyout's second trigger) `.composer-model-id` `.composer-model-meta` `.composer-model-sep` `.composer-model-level` `.composer-model-caret` (+ `.live-dot`) |
| Composer flyout (§4b) | `button.composer-menu-trigger` · `.model-menu.composer-flyout[popover]` `.composer-flyout-list[role=menu]` `.composer-flyout-item` (on `.mode-option`, `[role=menuitem\|menuitemradio]`) `.composer-flyout-icon` `.composer-flyout-label` `.composer-flyout-value` `.composer-flyout-meta` `.composer-flyout-chevron` `.composer-flyout-sep[role=separator]` `.composer-flyout-head` `.composer-flyout-back` (+ `.mode-option-check` `.list-group-label` `.live-dot`) |
| Model menu (§4c) | `.model-menu[popover]` (the flyout's shell) `.model-menu-search` `.model-menu-list` `.model-menu-group` `.model-option` `[data-active]` `.model-option-check` `.model-option-id` `.model-option-vision` `.model-option-provider` `.model-menu-empty` `.model-menu-foot` |
| Mode menu (§4g) | `.mode-trigger` `.mode-trigger-label` `.model-menu.mode-menu[popover]` (+ `.model-menu-list[role=menu]` `.model-menu-group`) `.mode-option[role=menuitemradio\|menuitemcheckbox]` `.mode-option-check` `.mode-option-text` `.mode-option-id` `.mode-option-desc` `.mode-menu-foot` |
| Context window (§4f) | `.context-gauge` `.context-label` `.context-value` `.context-pct` `.context-meta` · sidebar row ring `.context-ring` `.context-ring-track` `.context-ring-fill` · states `.context-warn` `.context-error` (both also on the ring's wrapper) `.context-compacted` · `.session-head` is the named container `session-head` |
| Markdown (§4e) | `.md` (on `.message-body`) `.md-table-wrap` `.md-code` `.md-code-head` `.md-code-lang` `.md-code-copy` `.md-image-link` · syntax: `.hljs-*` roles |
| Slash commands (§4d) | `.command-menu` `.command-menu-head` `.command-list` `.command-option` `[data-active]` `.command-option-name` `.command-option-desc` `.command-option-location` `.command-menu-empty` `.command-menu-foot` · source badge: neutral `.chip` |
| Images (§4b) | `.message-images` `.message-images-single` `.thumb` `.toolcard-images` · lightbox: `dialog.lightbox` `.lightbox-bar` `.lightbox-caption` `.lightbox-count` `.lightbox-stage` `.lightbox-img` `.lightbox-prev` `.lightbox-next` · attachments: `.attachments` `.attachment` `.attachment-rejected` `.attachment-thumb` `.attachment-thumb-button` `.attachment-icon` `.attachment-text` `.attachment-name` `.attachment-meta` · path attachments: `details.disclosure.message-attachment` `.message-attachment-missing` `.message-attachment-name` `.message-attachment-meta` `.message-attachment-body` · path chips: `button.path-chip` `.path-chip-missing` `.path-chip-name` `.path-chip-note` |
| Empty / loading | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` · `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| Landing page (§3) | `.welcome` `.welcome-head` (wrapping the `.empty` opening) `.explain-section` `.explain-section-head` (+ its `.text-num` count) · the grid itself is `ul.explain-grid` of `.card.explain-tile`, in `src/explain.css` |
| Toast | `.toast-stack` `.toast` `.toast-body` |
| Insights: entry (§10) | `.sidebar-foot` holding 2 × `.insights-row` (Usage → `#/usage`, Agents → `#/agents`) `.insights-row-text` · usage glance `.usage-glance` `.usage-glance-item` `.usage-glance-item-high` `.usage-glance-item-stale` `.usage-glance-tag` · aggregate chip `.chip.chip-count` (`a.chip` when it links; `.session-head-working` for the head's wordless `{n}` + worker icon) |
| Insights: Usage and Agents pages (§10) | `.insights` (+ `.pane`) `.insights-inner` `.insights-section` `.insights-section-head` `.insights-section-count` `.insights-grid` · `.card` `.card-head` `.card-title` `.card-body` `.card-foot` |
| Usage meter (§10) | `.usage-card` `.usage-note` · `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-of` `.meter-track` `.meter-fill` `.meter-fill-warn` `.meter-fill-error` `.meter-context` `.meter-ghost` · a credit balance (DeepSeek) reuses `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-context` with no track |
| Teams / subagents (§10) | `.team-card` `.team-objective` `.agent-card` `.member-list` `.member-row` `.member-preview` |
| Insight strip (§10) | `details.outline` `.outline-summary` `.outline-label` `.outline-now` `.outline-count` (+ `.outline-explained` for the Explained count) `.outline-body` `.outline-explained-open` `.outline-overall` `.outline-state` `.outline-topics` `details.outline-topic` `.outline-topic-summary` `.outline-topic-heading` `.outline-hash` `.outline-topic-time` `.outline-bullets` `.outline-jump` · one row carries outline and explanations both; the old `.explain-strip*` classes are gone |
| Compaction row (§10) | `details.disclosure.compaction` `.compaction-summary` `.compaction-files` |
| Subagents pane (§11) | trigger `button.run-status-link` (in `.run-status`) · `.app-subagents` `.subagents-head` `.subagents-title` `.subagents-usage` `.subagents-close` `.subagents-body` `.subagents-list` `button.subagent-row[aria-current]` `.subagent-row-name` `.subagent-row-status` `.subagent-row-meta` (+ `.meta-line`) `.subagent-row-preview` `.subagents-view` `.subagents-view-head` `.subagents-view-title` `.subagents-view-meta` (+ `.meta-line`) `.subagents-transcript` (+ `.pane`) `.subagents-banner` `.subagents-jump` (+ `.jump-latest`) `.subagents-empty` (+ `.empty`) · `.meta-line` `.meta-line-shrink` `.meta-line-sep` (a nowrap meta row whose model id is the one part that shrinks) · `.app-subagents` is the named container `subagents` |
| Inputs tab (§12) | trigger `button.run-status-link` (right-aligned in `.run-status`) · `ul.list.input-list` `li.input-row[data-input]` `.input-row-line` `button.input-row-body` `.input-row-title` (2-line clamp) `.input-row-meta` `.input-row-actions` `.input-row-note` (`.text-error` span inside it for a refusal) `.input-row-boundary` `.input-row-abandoned` · the landing tint in the transcript is `.entry-jumped` (§12 Rows) |
| Utilities | `.stack` `.stack-2` `.cluster` `.spread` `.truncate` `.measure` `.visually-hidden` `.text-mono` `.text-caption` `.text-muted` `.text-error` `.text-eyebrow` `.text-num` |

**All user-facing strings are in §9 · Copy deck.**

There is **no spinner**, on purpose. The system allows one loading language per surface:

- Regions that are loading get skeletons, after 300ms.
- Work in progress gets `.live-dot` plus words (for example "Working · running bash").
- Buttons that are pending change their label (for example "Creating…") and carry
  `aria-disabled`.

---

## File map

One file per section of the original notes, in reading order. `§N` references in the body
and in the codebase point at the file whose number matches.

| File | Section | What it covers |
|---|---|---|
| [00-ground-rules.md](00-ground-rules.md) | §0 · Ground rules | Theme, icons, voice, color budget, and motion rules every surface follows. |
| [01-app-shell.md](01-app-shell.md) | §1 · App shell | Two-pane layout, folded and unfolded views, the resizable sessions pane. |
| [02-session-list.md](02-session-list.md) | §2 · Session list (sidebar) | Session rows, rails, regions, search, archive, and cleanup. |
| [03-transcript.md](03-transcript.md) | §3 · Transcript (main pane) | Transcript rows: messages, tool cards, disclosures, banners, streaming, landing page. |
| [04-composer.md](04-composer.md) | §4 · Composer | The composer: anatomy, behavior, disabled states, the flyout, and accessibility. |
| [04b-images.md](04b-images.md) | §4b · Images | Attaching, previewing, and rendering images. |
| [04c-model-menu.md](04c-model-menu.md) | §4c · Model menu | The model picker popover. |
| [04d-slash-commands.md](04d-slash-commands.md) | §4d · Slash commands | Slash command menu and built-in commands. |
| [04e-markdown.md](04e-markdown.md) | §4e · Markdown and code | Markdown rendering and code blocks. |
| [04f-context-window.md](04f-context-window.md) | §4f · Context window | The context readout in the session head: plain text, the sidebar ring, steps toward the limit. |
| [04g-mode-menu.md](04g-mode-menu.md) | §4g · Mode menu | Per-chat mode switching and the mode menu. |
| [05-new-session-dialog.md](05-new-session-dialog.md) | §5 · New Session dialog | Creating a session: the modal, the in-place folder picker, fields, and validation. |
| [06-extension-dialogs.md](06-extension-dialogs.md) | §6 · Extension dialogs (`ui_request`, optional in MVP) | Extension-driven `ui_request` dialogs. |
| [07-deviations.md](07-deviations.md) | §7 · Deviations from, and extensions to, fold-ai-dev | Where pi-web departs from or extends fold-ai-dev. |
| [08-token-index.md](08-token-index.md) | §8 · Token index | Every token these notes reference, grouped by kind. |
| [09-copy-deck.md](09-copy-deck.md) | §9 · Copy deck | All user-facing strings. |
| [10-insights.md](10-insights.md) | §10 · Insights | Sidebar foot, Usage and Agents pages, team and subagent cards, insight strip. |
| [11-subagents-pane.md](11-subagents-pane.md) | §11 · Subagents pane | The subagents side pane. |
| [12-inputs-tab.md](12-inputs-tab.md) | §12 · Inputs tab and rewind | The Inputs tab and rewinding to an earlier input. |
