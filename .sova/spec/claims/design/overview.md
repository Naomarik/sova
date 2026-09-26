# §design/overview — Sova — Design Notes

The UX spec for the Sova MVP. The frontend builds exactly this with plain SolidJS and two
stylesheets — no component library.

- **System.** fold-ai-dev design system v1.8.0 (`.claude/skills/fold-ai-dev-design/`), rebranded
  as Sova. Where these notes don't say otherwise, the skill's rules apply: `SKILL.md` for
  anything that spans components, `reference/components/*.md` for how each component is built.
- **Stylesheets.** `src/design/tokens.css`, then `src/design/base.css`. Import both once, in that
  order, from `src/main.tsx`. Every class named here is defined in `base.css`.
- **Assets.** Vite serves `public/` at the site root: `/fonts/*.woff2`, `/icons/*.svg`,
  `/favicon.svg`.
- **Naming.** The product is **Sova** (Sessions, Orchestration, Viewing & Agents) and the mark is
  `public/icons/sova-mark.svg`. The state directory is `~/.pi/agent/sova/`, the browser keys are
  `sova:*` and the theme schema is `sova-theme/v1`.

## §design.overview/class-index — Class index (all in `src/design/base.css`)

| Need | Classes |
|---|---|
| App shell | `.app[data-view="list\|session"]` `.app-sidebar` `.app-main` `.app-back` `.pane` `.skip-link` `.pane-resizer` (+ `html.is-resizing`) |
| Sidebar | `.sidebar-head` `.brand` `.sidebar-spacer` `.sidebar-spine-toggle` `.sidebar-search` `.sidebar-list` `.sidebar-region` `.sidebar-region-head` `.sidebar-region-count` `.sidebar-region-note` `details.sidebar-archive` · in `src/app.css`: `.archive-date` `.archive-date-label` `.archive-date-name` `.archive-tools` `.cleanup-intro` `.cleanup-choices` `.cleanup-choice` |
| Sidebar, collapsed (the spine, ≥768) | `.app[data-spine="on"]` · `.spine` `.spine-head` `.spine-tiles` (+ `.pane`) `.spine-regions` `.spine-stats` `.spine-foot` · `.spine-item` (on a `.button.button-icon`) `.spine-region` `.spine-stat` `.spine-count` · `.spine-tile` `[aria-current="page"]` `.spine-monogram` (a hook: the tile styles it) `.spine-dot` (+ `.spine-dot-live` \| `.spine-dot-busy` \| `.spine-dot-working`) |
| Search | `.search` (wraps `.icon` + `input.input` + clear `.button.button-icon`) `.search-count` |
| Session rows | `li.session-row-shell` (`.session-row-shell-current` when open) wrapping `.session-rail` + `.list-row.list-row-interactive.session-row` `[aria-current="page"]` `.list-main` `.list-title` `.list-summary` `.list-meta` · lines 2–3 `.list-line` (`.list-summary-row` `.list-meta-row`) carrying `.chip.chip-count.session-topics` and `.context-ring` · group chrome `.session-group` `.list-group-label` `.session-group-path` (+ `<bdi>`) `.list` |
| Session row state (left rail) | `.session-rail` `.session-rail-item` `.session-rail-state` — TUI: + `.session-rail-tui.chip.chip-accent`, the word, no dot · Busy: + `.chip.chip-info.chip-live` holding `.session-rail-dot` — `.session-rail-count` `.session-rail-count-live` · folder head: `.session-group-active` holding Busy's `.session-rail-dot` |
| LIVE badge / status | `.chip` `.chip-dot` `.chip-accent` `.chip-live` `.chip-success` `.chip-error` `.chip-warn` `.chip-info` `.chip-count` |
| Buttons | `.button` `.button-primary` `.button-destructive` `.button-ghost` `.button-sm` `.button-icon` (needs `aria-label`) |
| Icons | `.icon` (20px) `.icon-sm` (16px) `.icon-twist` (rotates in open disclosures). Works on an inline `<svg>` or a mask `<span class="icon" style="--icon:url(/icons/x.svg)">` |
| Modal | `.scrim` `.modal` `.modal-head` `.modal-title` `.modal-body` `.modal-foot` `.modal-spacer` `.folder-list` |
| Folder picker (§app/new-session-dialog) | `.folder-field` `.folder-field-value` `.folder-field-empty` `.folder-picker` `.folder-picker-bar` `.folder-crumbs` `.folder-crumbs-root` `.folder-crumb` `.folder-crumb-current` `.folder-picker-list` `.folder-picker-link` `.folder-picker-note` `.folder-picker-foot` `.folder-picker-hidden` |
| Form fields | `.field` `.field-label` `.field-hint` `.field-error` `.input` `.input-mono` `.textarea` |
| Main head | `.session-head` `.session-head-main` `.session-head-title` `.session-head-meta` `.session-archive` · worker count `a.chip.chip-count.session-head-working` (`{n}` + `worker` icon) |
| Transcript | `.transcript` (+ `.pane`) `.transcript-banner` `.transcript-inner` `.thread` |
| Messages | `.message` `.message-user` `.message-streaming` `.message-head` `.message-author` `.message-time` `.message-body` `.message-text` |
| Thinking / raw JSON | `details.disclosure` `.disclosure-summary` `.disclosure-label` `.disclosure-preview` `.disclosure-body` |
| Tool card | `.toolcard` (a wrapper holding `details.toolcard-details` and, when the result has images, `.toolcard-media`; the wake card is a `details.toolcard` itself) `.toolcard-summary` `.toolcard-name` `.toolcard-arg` `.toolcard-body` `.toolcard-section` `.toolcard-section-label` `.toolcard-output` `.toolcard-output-error` · file content (write, edit, read): `.toolcard-path` `pre.toolcard-code` `.toolcard-code-del` `.toolcard-code-add` with `.hljs-*` roles. The running, done and failed states are chips (§chat/transcript) |
| Info / unknown row | `.info-row` `.info-row-text` |
| Report row (§chat/transcript "report") | `details.disclosure.report` `.report-summary` `.report-from` (+ `.chip`, `.disclosure-preview`) `.report-body` `.report-meta` `.report-error` |
| Banner | `.banner` `.banner-info` `.banner-warn` `.banner-error` `.banner-success` `.banner-icon` `.banner-main` `.banner-title` `.banner-body` `.banner-action` |
| Streaming | `.live-dot` `.run-status` `.run-status-detail` `.jump-latest` · the row also hosts `button.run-status-link` triggers (§app/subagents-pane subagents, §chat/timeline inputs), both `aria-controls="session-pane"` |
| Composer | `.composer` `.composer-inner` `.composer-row` `.composer-input` (with `.input.textarea`) `.composer-actions` `.composer-foot` `.composer-reason` `.composer-hint` `.button-label` `.composer-drop` + `.composer[data-drop="active\|reject"]` |
| Model indicator (§chat/composer) | `button.composer-model` (the flyout's second trigger) `.composer-model-id` `.composer-model-meta` `.composer-model-sep` `.composer-model-level` `.composer-model-caret` (+ `.live-dot`) |
| Composer flyout (§chat/images) | `button.composer-menu-trigger` · `.model-menu.composer-flyout[popover]` `.composer-flyout-list[role=menu]` `.composer-flyout-item` (on `.mode-option`, `[role=menuitem\|menuitemradio]`) `.composer-flyout-icon` `.composer-flyout-label` `.composer-flyout-value` `.composer-flyout-meta` `.composer-flyout-chevron` `.composer-flyout-sep[role=separator]` `.composer-flyout-head` `.composer-flyout-back` (+ `.mode-option-check` `.list-group-label` `.live-dot`) |
| Model menu (§chat/model-menu) | `.model-menu[popover]` (the flyout's shell) `.model-menu-search` `.model-menu-list` `.model-menu-group` `.model-option` `[data-active]` `.model-option-check` `.model-option-id` `.model-option-vision` `.model-option-provider` `.model-menu-empty` `.model-menu-foot` |
| Mode menu (§chat/mode-menu) | `.mode-trigger` `.mode-trigger-label` `.model-menu.mode-menu[popover]` (+ `.model-menu-list[role=menu]` `.model-menu-group`) `.mode-option[role=menuitemradio\|menuitemcheckbox\|menuitem]` `.mode-option-check` `.mode-option-text` `.mode-option-id` `.mode-option-desc` `.mode-option-row` `.mode-option-gear` `.mode-menu-foot` |
| Context window (§chat/context-window) | `.context-gauge` `.context-label` `.context-value` `.context-pct` `.context-meta` · sidebar row ring `.context-ring` `.context-ring-track` `.context-ring-fill` · states `.context-warn` `.context-error` (both also on the ring's wrapper) `.context-compacted` · `.session-head` is the named container `session-head` |
| Markdown (§chat/markdown) | `.md` (on `.message-body`) `.md-table-wrap` `.md-code` `.md-code-head` `.md-code-lang` `.md-code-copy` `.md-image-link` · syntax: `.hljs-*` roles |
| Slash commands (§chat/slash-commands) | `.command-menu` `.command-menu-head` `.command-list` `.command-option` `[data-active]` `.command-option-name` `.command-option-desc` `.command-option-location` `.command-menu-empty` `.command-menu-foot` · source badge: neutral `.chip` |
| Images (§chat/images) | `.message-images` `.message-images-single` `.thumb` · a tool card's returned images: `.toolcard-media` · lightbox: `dialog.lightbox` `.lightbox-bar` `.lightbox-caption` `.lightbox-count` `.lightbox-stage` `.lightbox-img` `.lightbox-prev` `.lightbox-next` · attachments: `.attachments` `.attachment` `.attachment-rejected` `.attachment-thumb` `.attachment-thumb-button` `.attachment-icon` `.attachment-text` `.attachment-name` `.attachment-meta` · path attachments: `details.disclosure.message-attachment` `.message-attachment-missing` `.message-attachment-name` `.message-attachment-meta` `.message-attachment-body` · path chips: `button.path-chip` `.path-chip-missing` `.path-chip-name` `.path-chip-note` |
| Empty / loading | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` · `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| Landing page (§chat/transcript) | `.welcome` `.welcome-head` (wrapping the `.empty` opening) `.explain-section` `.explain-section-head` (+ its `.text-num` count) · the grid itself is `ul.explain-grid` of `.card.explain-tile`, in `src/explain.css` |
| Setup card (§chat/transcript) | `section.setup-card` (its own inline-size container: under 420px the figures fold under the names) `.setup-group` `h2.text-eyebrow.setup-label` `.setup-note` · aggregate line `.setup-sum` `.setup-sum-label` `.setup-sum-facts` · group head `.setup-head` `.setup-total` · rows `ul.setup-list` `li.setup-row` `.setup-name` `.setup-path` `.setup-role` `.setup-facts` · repository `.setup-git` (+ `.icon`) `.setup-git-head` `.setup-sep` `.setup-num` `.setup-add` `.setup-del` `ul.setup-list.setup-commits` (a hook with no rule of its own) `li.setup-git.setup-commit` `.setup-oid` `.setup-subject` `.setup-ago` |
| Toast | `.toast-stack` `.toast` `.toast-body` |
| Insights: entry (§app/insights) | `.sidebar-foot` holding 2 × `.insights-row` (Usage → `#/usage`, Agents → `#/agents`) `.insights-row-text` · usage glance `.usage-glance` `.usage-glance-item` `.usage-glance-item-high` `.usage-glance-item-stale` `.usage-glance-tag` · aggregate chip `.chip.chip-count` (`a.chip` when it links; `.session-head-working` for the head's wordless `{n}` + worker icon) |
| Insights: Usage and Agents pages (§app/insights) | `.insights` (+ `.pane`) `.insights-inner` `.insights-section` `.insights-section-head` `.insights-section-count` `.insights-grid` · `.card` `.card-head` `.card-title` `.card-body` `.card-foot` |
| Usage meter (§app/insights) | `.usage-card` `.usage-note` · `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-of` `.meter-track` `.meter-fill` `.meter-fill-warn` `.meter-fill-error` `.meter-context` `.meter-ghost` · a credit balance (DeepSeek) reuses `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-context` with no track |
| Teams / subagents (§app/insights) | `.team-card` `.team-objective` `.agent-card` `.member-list` `.member-row` `.member-preview` |
| Insight strip (§app/insights) | `details.outline` `.outline-summary` `.outline-label` `.outline-now` `.outline-count` (+ `.outline-explained` for the Explained count) `.outline-body` `.outline-explained-open` `.outline-overall` `.outline-state` `.outline-topics` `li.outline-topic` `.outline-topic-head` `.outline-topic-heading` `.outline-hash` `.outline-topic-time` `.outline-bullets` `.outline-jump` · one row carries the current goal and explanations both; the old `.explain-strip*` classes are gone |
| Compaction row (§app/insights) | `details.disclosure.compaction` `.compaction-summary` `.compaction-files` |
| Subagents pane (§app/subagents-pane) | trigger `button.run-status-link` (in `.run-status`) · `.app-subagents` `.subagents-head` `.subagents-title` `.subagents-usage` `.subagents-close` `.subagents-body` `.subagents-list` `button.subagent-row[aria-current]` `.subagent-row-name` `.subagent-row-status` `.subagent-row-meta` (+ `.meta-line`) `.subagent-row-go` `.subagents-view` `.subagents-view-head` `.subagents-back` `.subagents-view-id` `.subagents-view-title` `.subagents-view-meta` (+ `.meta-line`) `.subagents-transcript` (+ `.pane`) `.subagents-banner` `.subagents-jump` (+ `.jump-latest`) `.subagents-empty` (+ `.empty`) · `.meta-line` `.meta-line-shrink` `.meta-line-sep` (a nowrap meta row whose model id is the one part that shrinks; the subagents view head's row wraps instead, and each `.meta-line-sep` sits inside the fact it introduces) · `.app-subagents` is the named container `subagents` · `.subagents-body[data-view=list|detail]` picks the half under 500px |
| Timeline tab (§chat/timeline) | trigger `button.run-status-link` (right-aligned in `.run-status`) · filter `button.button-sm.button-ghost[aria-pressed]` (`Inputs Only`) · `ol.timeline` `li.timeline-row[data-kind="input\|chapter\|marker\|density\|gap"]` (+ `.timeline-row-flagged`) `.timeline-dot` (the rail is `.timeline-row::before`) `.timeline-time` `.timeline-time-flagged` `button.timeline-body` `.timeline-title` (2-line clamp) `.timeline-chapter` (+ `.outline-hash`) `.timeline-meta` `.timeline-gap` `.timeline-state` · an input row borrows the old Inputs list's `ul.input-list`-era classes: `.input-row-line` `button.input-row-body` `.input-row-title` `.input-row-meta` `.input-row-actions` `.input-row-note` (`.text-error` span inside it for a refusal) `.input-row-boundary` `.input-row-abandoned` · the landing tint in the transcript is `.entry-jumped` (§chat.timeline/rows) |
| Workspace (§workspace/groups) | `.app[data-view="workspace"]` `.workspace` `.workspace-head` `.workspace-head-main` `.workspace-title` `.workspace-meta` `.workspace-count` `.workspace-promoted` `.workspace-align` · tabs `.workspace-tabs[role=tablist]` `button.workspace-tab[role=tab]` `.workspace-tab-title` · panes `.workspace-modes` `.workspace-row` `.workspace-pane` `.workspace-pane-focused` `.workspace-pane-head` `.workspace-pane-name` `.workspace-pane-tools` `.workspace-pane-body` `.workspace-pane-composer` · group composer `.composer.group-composer` `.group-composer-targets` · collapsed pane composer `.composer[data-collapsed]` |
| Fanout (§workspace/fanout) | `.modal.modal-wide.fanout` `.fanout-source` `.fanout-source-note` `ul.fanout-rows` `li.fanout-row` `.fanout-row-model` `.fanout-row-fill` `.fanout-count` `.fanout-add` `.fanout-preview` `.fanout-preview-row` `.fanout-note` · the transcript's fork-point row `.info-row.fork-marker` |
| Utilities | `.stack` `.stack-2` `.cluster` `.spread` `.truncate` `.measure` `.visually-hidden` `.text-mono` `.text-caption` `.text-muted` `.text-error` `.text-eyebrow` `.text-num` |

**All user-facing strings are in §design/copy-deck.**

There is **no spinner**, on purpose. The system allows one loading language per surface:

- Regions that are loading get skeletons, after 300ms.
- Work in progress gets `.live-dot` plus words (for example "Working · running bash").
- Buttons that are pending change their label (for example "Creating…") and carry
  `aria-disabled`.

---

## §design.overview/file-map — File map

One file per document, in reading order.

| Document | What it covers |
|---|---|
| [§design/ground-rules · Ground rules](ground-rules.md) | Theme, icons, voice, color budget, and motion rules every surface follows. |
| [§app/shell · App shell](../app/shell.md) | Two-pane layout, folded and unfolded views, the resizable sessions pane. |
| [§app/session-list · Session list (sidebar)](../app/session-list.md) | Session rows, rails, regions, search, archive, and cleanup. |
| [§chat/transcript · Transcript (main pane)](../chat/transcript.md) | Transcript rows: messages, tool cards, disclosures, banners, streaming, landing page. |
| [§chat/composer · Composer](../chat/composer.md) | The composer: anatomy, behavior, disabled states, the flyout, and accessibility. |
| [§chat/images · Images](../chat/images.md) | Attaching, previewing, and rendering images. |
| [§chat/model-menu · Model menu](../chat/model-menu.md) | The model picker popover. |
| [§chat/slash-commands · Slash commands](../chat/slash-commands.md) | Slash command menu and built-in commands. |
| [§chat/markdown · Markdown and code](../chat/markdown.md) | Markdown rendering and code blocks. |
| [§chat/context-window · Context window](../chat/context-window.md) | The context readout in the session head: plain text, the sidebar ring, steps toward the limit. |
| [§chat/mode-menu · Mode menu](../chat/mode-menu.md) | Per-chat mode switching and the mode menu. |
| [§chat/playbooks · Playbooks](../chat/playbooks.md) | Markdown recipes from the composer flyout: the three provenance groups, the two-step modal, and what gets sent into the chat. |
| [§app/new-session-dialog · New Session dialog](../app/new-session-dialog.md) | Creating a session: the modal, the in-place folder picker, fields, and validation. |
| [§app/extension-dialogs · Extension dialogs (`ui_request`, optional in MVP)](../app/extension-dialogs.md) | Extension-driven `ui_request` dialogs. |
| [§design/deviations · Deviations from, and extensions to, fold-ai-dev](deviations.md) | Where Sova departs from or extends fold-ai-dev. |
| [§design/token-index · Token index](token-index.md) | Every token these notes reference, grouped by kind. |
| [§design/copy-deck · Copy deck](copy-deck.md) | All user-facing strings. |
| [§app/insights · Insights](../app/insights.md) | Sidebar foot, Usage and Agents pages, team and subagent cards, insight strip. |
| [§app/subagents-pane · Subagents pane](../app/subagents-pane.md) | The subagents side pane. |
| [§app/settings-dialog · Settings dialog](../app/settings-dialog.md) | The gear in the sidebar foot, the tabbed modal it opens, the model policy screen (what may be used, and what subagents may be given), and Modes → Delegate (which worker each kind of Delegate work goes to). |
| [§chat/timeline · Timeline tab](../chat/timeline.md) | The session on one time axis: chapters, inputs, density lines, markers, idle gaps — and the Inputs Only filter, whose rows rewind the chat. |
| [§workspace/groups · Group workspaces](../workspace/groups.md) | A group opened as a place: split or tabbed panes, one composer that writes to every member, and what promoting, eliminating and dissolving do. |
| [§workspace/fanout · Fanout](../workspace/fanout.md) | Making a whole workspace in one gesture: fork at a leaf or start fresh, per-model counts, the cost preview, and the fork-point marker. |
