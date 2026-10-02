# §app/settings-dialog — Settings dialog
> Part of the Sova design spec · [overview](../design/overview.md)

The sidebar foot's Agents row ends in a gear. It opens the Settings modal: a left tab rail and
one panel, wider than the product's question-asking modals because two panes have to fit beside
each other (§design/ground-rules and §design/deviations record the deviation). There is no route and no URL — Settings is a modal
the session stays behind, closed by the scrim, Esc, or its Close button (Cancel while anything
is unsaved, §app.settings-dialog/save-bar).

The rail is the structure: each settings screen is one tab — General, Models, Accounts, Subagents, Modes, Teams,
Profiles, Overseer, Notifications, Decisions, Summaries, Organizations, Themes, Mesh, Public links, Outreach, Voice, Experimental.
Tabs move with the arrow keys as well as the pointer, and the selected tab has focus on open: the
two have to name the same screen. The gear opens General; the mode menu's **Configure Delegate** gear
(§chat/mode-menu) opens Subagents directly, and nothing else about the chat changes. Which tab is open lives in
`src/lib/settings-nav.ts`, so a control deep in a pane can open it without a callback chain. The
active tab is the only filled thing in the rail — an accent tint, never an accent label, because
§design/ground-rules spends accent on the primary, live, and focus — and the rail carries no fill of its own, so
that tint has something to read against in both themes. Under 768px the same markup arrives as a
sheet: the panel draws the sheet's grip, the rail turns into a horizontal strip above it, and the
active tab keeps its tint.

## §app.settings-dialog/one-height — One height

**The dialog is the same height whichever tab is open.** Its height comes from the viewport —
`min(640px, 100dvh - --space-8)`, and `85dvh` in the folded sheet — not from the panel's content,
and the panel scrolls inside it (`.settings-panel`, `overflow-y: auto`).

This is a correction, and the bug names the rule: while the height followed the content, Themes
filled the viewport and Experimental came in at a few hundred pixels, so switching between them
resized the window under the pointer and moved the rail's own tab buttons out from under the
finger that was aiming at them. A rail you have to re-find after every press is not a rail.

The head, the rail and the foot never scroll or shrink — Close and Save Changes are reachable at
every viewport —
and on a short window the floor under the body gives way rather than the foot: the panel is the
part that already knows how to scroll. Adding a tab is then a content question only; no screen
can change the dialog's size by being long or short.

## §app.settings-dialog/general — General

- **Compress thinking & tool calls** — a default-on browser-local switch, applied immediately to every open transcript and stored in `localStorage["sova:compress-work"]`. Only `"false"` disables it; missing, unreadable, or corrupt values mean on. On selects the compact work timeline; off restores the original cards (§chat.work-chain-setting/preference).

The first tab: how **this browser** draws Sova. Nothing here is written to the machine — no
policy file, no server endpoint — which is the line between this screen and Models, where a
switch is a rule every session obeys. The panel says so in one line, because "settings" in a tool
with a shared config file is otherwise an open question.

- **Sessions in Recent** — how many rows the sidebar's Recent region shows
(§app.session-list/recent). A number field, **3 to 20, 5 by default**. This is the
**only** control for that count: the region itself carries none, because a count settable in two
places is a count that disagrees in one of them.

  3 is the floor and it is enforced in the rule rather than by the input's `min`, since a typed
  value, a pasted one and a hand-edited `localStorage` all arrive past the spinner. Below 3 the
  region is a row with neighbours, which the open session alone can fill.

  It saves as you type: a valid number moves the sidebar on the
  keystroke. An invalid one changes nothing and the field says which way it is wrong — "3 is the
  fewest. Below that Recent is a row, not a list." — rather than silently clamping under the
  caret. Leaving the field is where an unusable draft is repaired to the nearest count that works,
  and the polite region says the new count so the repair isn't silent.

  The value persists in `localStorage["sova:recent-count"]`, like the theme and for the same
  reason: it is this browser's, not the machine's. A stored value that is not a whole number in
  range is the default; a number out of range is clamped.

- **Summary line** — a switch: whether session rows draw their summary line
  (§app.session-list/content-rules, "Row line 2"). **On by default.** Off, every row drops line 2
  and the topic count that rides on it, and is title over meta; a never-sent session's draft
  preview still shows, because it is what keeps that row recognizable, and a Needs you row keeps
  its reason. Nothing else changes: the outline is still written, still sent in the list, and still
  in the session's own Outline — this is how **this browser** draws the list, not whether summaries
  exist. Which model writes them is Summaries, which is the machine's.

  It applies as you flip it, and persists in `localStorage["sova:show-summaries"]` for the same
  reason as the count: it is this browser's, not the machine's. Only the stored value `false` turns
  it off; a missing or unreadable value is on.

## §app.settings-dialog/models — Models

The second tab, and the one that is not about this browser at all. The policy behind this screen
is shared: `~/.pi/agent/model-policy.json`, written here and read by
**every** session, Sova and TUI alike, per model change, per turn and per spawn. It answers two
questions about every provider and every model:

- **Enabled** — may it be used at all. Off is a prohibition, not a filter: the model leaves this
  browser's picker, the TUI's `/model` puts your previous model back and says why, a session
  already sitting on it refuses its next message until you switch — every message, skills and
  prompt templates included, and a turn nobody typed is stopped before the request leaves — and no
  subagent or team member can be given it — hidden from `agent_models` and the `/subagents models` picker, and rejected at
  spawn with a reason the orchestrator can act on, whether the pick was explicit, agentType-defined
  or inherited from the parent.
- **Subagents** — may a worker be given it, out of the models that are still enabled. A model can
  be yours to drive by hand and out of bounds for workers.

Enabled covers Subagents: turning a model off turns it off for workers too, and its Subagents
switch greys out **holding the position you left it in** — turning the model back on returns the
preference rather than a default. Nothing here ever picks another model for you. A session on a
model that was turned off says so and waits; a fallback would spend a turn on a model you didn't
choose, and the transcript wouldn't say so.

The screen is one table with three columns — Model, Enabled, Subagents — over a search field. Rows
are providers, collapsed, with a count that answers the question the group asks (`6 of 9 on`, or
`Off · 9 models`); opening one lists its models behind a single guide rule, one line each, the id
alone and the full `provider/id` ref in `title`. Depth is the rule's job, not the indent's, and the
provider is on the group head, so a model row never repeats it — a list that says `openai/gpt-5.2`
on every row of the `openai` group is a list you read twice to learn nothing. Searching matches
provider names and full refs, and opens what it found: answering a query with a collapsed count is
answering a different question. Every row is at least 44px and every switch carries its own
accessible name (`Enable openai/gpt-5.2`, `Allow subagents to use openai/gpt-5.2`), because the
column header is a word in a grid and not a label a screen reader can reach from the control.
A provider group head also carries the **At once** field after its switches, how many of that
provider's requests may run at once on this device (§app.provider-limits/setting); model rows have none.

A provider is a group head: its switches cover every model under it, and the model rows' own
switches grey out while it is off — the provider already answered. Turning a provider off removes
its models' own entries from that dimension: the provider covers them, and turning it back on
returns every model allowed, which is what the list showed. `claude-code` is a provider of its own
with no model rows: one switch over every Claude Code worker, its default model included, because
its models are the CLI's rather than pi's. A provider named in the policy that this machine has no
credentials for is listed too, with `No models on this machine` where the count goes — a rule you
can't see is a rule you can't undo.

A switch doesn't write on its own. Every move is staged, and the dialog's **Save Changes** writes
the whole policy — one save for every provider and model you moved, never one per switch — while
its **Discard Changes** puts every switch back where the saved policy has it
(§app.settings-dialog/save-bar). The file is read per spawn and per turn, so a staged switch
refuses nothing until it's saved, and this browser's model picker follows the saved policy the
moment the save lands. Save reads the policy again first and applies only the entries you changed
on top of it, so an entry the TUI or a peer's sync wrote while the form was open is kept, never
reverted. A failed save keeps every switch where you put it and says so in an error banner:
**Couldn't save the model policy.** {reason}. "Your saved policy is unchanged."

While the model list or the policy loads, the panel shows skeleton rows. If the policy can't be
read, an error banner offers Retry and touches nothing.

## §app.settings-dialog/modes — Modes

The **Modes** tab explains that Delegate routing and the spec writer now belong to subagent
profiles, and links to **Subagents** with Manage Subagent Profiles. The **Teams** tab explains
the same move for coordinator, monitor and ordinary-member choices and offers the same link.
Neither edits a legacy file. Major and minor modes are still chosen in each chat's mode menu.

The **Subagents** tab edits named setups (§chat.subagent-profiles/settings): Delegate routing,
team roles and thresholds, members default, and spec writer. The worker-row rules below apply
there; the chat's profile resolves the routing, not a global editor (§chat.subagent-profiles/resolution).

Delegate routes four kinds of work, in this order: **Planning & specs** (non-editing design,
including any investigation that feeds one), **Investigation** (focused read-only research or
diagnosis), **Routine implementation** (mechanical, low-risk) and **Complex implementation**
(ambiguous, cross-cutting, high-risk). Each is a `fieldset` with a **Primary** row and an optional
**Fallback** row; a row is three native selects — Backend (`pi`, `Claude Code`), Model, Effort —
side by side when the panel has room and stacked under 640px.

- **Choices, not free text.** Models come from what each backend offers
  (`GET /api/settings/delegate/options`: pi's credentialed models with the thinking levels each
  supports; the Claude Code CLI's own list with the efforts each reports, from an initialize-only
  call cached 60s). Effort lists what the chosen model takes.
- **Nothing is picked for you.** Changing the backend blanks the model and the effort; changing the
  model keeps the effort only when the new model takes it. A blank row can't be saved.
- **A stored pick is always shown.** When discovery doesn't list it, it stays in the select with
  "— not offered" (the backend answered without it; the row says so in error ink) or "— not
  verified" (the backend couldn't answer, or its answer isn't proof; muted). Couldn't-answer is
  never read as gone: its rows say "Not verified: {backend} couldn't list its models.", and
  saves still go through, with one "not verified" note per backend naming every slot on it.
  A failed options request has a warning and Check Again; a successful response that cannot list
  one backend leaves that uncertainty in its rows and save notes.
- **A Claude Code alias the CLI's list omits is not gone.** The `claude` initialize model list is
  remote and account-gated and has changed shape under us: it once carried the `[1m]` aliases
  (`opus[1m]`, `claude-fable-5-1[1m]`) and now does not, while the CLI accepts a valid alias at
  runtime either way. So a shape-valid Claude Code model (an alias: no `/`, no leading
  `-`, no whitespace) missing from a list the CLI did answer reads "— not verified" in the select
  and, under its row, muted: "Not verified: the Claude Code CLI's model list doesn't include
  {model} right now (the list varies). It will still be used." — the same soft state Delegate
  routes it by. Only a shape-invalid Claude id, or a pi model its registry doesn't list, is "not
  offered". The server's save check reads such a row the same way: never refused for absence from
  the list, saved with that note; and its options list offers the known 1M forms itself
  (§app.settings-dialog/claude-long-context-offered).
- **Efforts.** A model's effort list is what its backend reported, cut to what the backend
  accepts; a model reporting none usable (no list, an empty one, or only efforts the backend
  refuses) takes every effort the backend accepts — the same rule Delegate routes by.
- **Claude Code provider models (pi) are per session.** `claude-code-cli/*` models exist only in
  sessions started with that provider on, so the server lists what its own runtime holds and
  reads a missing one as "not verified", never "not offered".
- **The policy is shown, not enforced here.** A model Settings → Models keeps from subagents reads
  "— off for subagents" and warns under its row; spawn enforces the policy, and Delegate uses that
  profile's fallback, or asks.
- **Fallback** is a toggle. Off: "No fallback: if the primary can't run, the agent asks you which
  model to use." On: a second row starting blank on the primary's backend. A fallback identical to
  its primary is refused.
- **Saving** is explicit — the dialog's Save Changes and Discard Changes
  (§app.settings-dialog/save-bar) — because a subagent setup is one coherent choice, not a save
  per worker row. Save waits for every chosen row to have a model and an effort, valid team
  thresholds and names, and for no fallback to be its own primary; the footer names the profile
  and missing section. There is no Delegate or Teams Reset to Defaults button.
- **Unsaved edits are kept, and never dropped silently.** The draft lives outside the tab
  (`src/lib/subagent-profiles-draft.ts`), so switching tabs keeps it. Closing over unsaved edits
  returns to Subagents and holds with **Your Subagents changes aren't saved.** "Save them, or
  discard them and close." [Keep Editing] [Discard and Close]. A closed dialog forgets the draft;
  reopening starts from what's saved. The save replaces the whole library; a changed device
  default is written separately, and a failure after the library save reports the partial write. The server
  refuses a **changed** row its backend answered it can't run (model not offered — for Claude Code,
  only a shape-invalid id — or effort not taken) and names it; a row that can't be checked, or that
  the policy refuses, saves with a warn banner "Saved, with notes." A row left as it was stored
  never blocks a save.

The library is `<agent dir>/subagent-profiles.json`, shared with pi in the terminal. A saved edit
reaches every chat on that profile from its next turn or team action; running workers and the
main model keep their models. `<agent dir>/subagent-profiles-default.json` is this device's own
choice and never syncs. Legacy `mode-delegate.json`, `mode-spec.json` and `team-defaults.json`
remain for seeding and fallback, not as second editors.

Built-in legacy Delegate values, used when seeding: Planning & specs Claude Code `claude-fable-5-1[1m]` medium, fallback
`opus[1m]` high; Investigation `opus[1m]` low; Routine `opus[1m]` low; Complex `opus[1m]` medium;
no fallbacks but Planning's.

## §app.settings-dialog/summaries — Summaries

The seventh tab: which model writes the summary line under each session's title
(§app.session-list/content-rules, "Row line 2"), as the `topic-outline` extension's chain — a
**Primary** and an optional **Fallback**, each a row of two native selects, Backend (`Claude Code`,
`pi`) and Model, laid out like a Delegate row without Effort. The chain is not a list you edit
here: a primary and a fallback are the choices that matter, and timeouts and budgets stay in the
file.

The file is `~/.pi/agent/topic-outline.json` (shown in the footnote), shared with pi in the
terminal. The TUI and every runtime read it once per session, at session start, so **a change
applies to sessions started afterwards, here and in the terminal**, and the panel says so. A
missing file, or one naming no usable summarizer, reads as the extension's built-in chain —
pi `ollama-cloud/deepseek-v4.1-flash`, then Claude Code `sonnet` — and, while nothing is staged,
the section heading says those are the built-in models, beside its Reset to Defaults.

- **Choices, not free text.** Model lists are Delegate's (`GET /api/settings/delegate/options`).
  A stored pick the list omits stays in the select, "— not verified" (the backend couldn't
  answer; a Claude Code alias, whose list varies; a pi provider whose models exist per session) or
  "— not offered" (a pi model the registry doesn't list).
- **The policy is shown.** A summarizer obeys only the model policy's global switch (Settings →
  Models "Enabled"): a model turned off there is skipped at the call and the next in line
  summarizes. Such a model reads "— turned off" in the select and warns under its row. The
  Subagents switch does not apply — a summarizer is not a worker — so a model that is only off
  for subagents is not marked.
- **Picks wait for Save** (§app.settings-dialog/save-bar). Every pick is staged; nothing is
  written until the dialog's **Save Changes**. Changing a backend blanks its model; turning
  Fallback on adds a blank row on the primary's backend; turning it off stages a one-model chain.
  **Reset to Defaults**, a small button in the section heading, fills in the built-in chain and
  saves nothing; it is disabled while the rows already show it.
- **Save waits for a complete chain.** Save Changes stays disabled while a row has no model
  ("Choose a model." under it) or the fallback is the primary ("Same as the primary. Choose
  another model, or no fallback."), and the server refuses the same pair too.
- **Save re-reads the file first.** The staged chain is rebased onto a fresh read: a slot you
  didn't touch takes whatever the file holds now (a change made in the terminal meanwhile), and a
  slot you did keeps your pick. If the result is what the file already holds, nothing is written.
  A kept draft is rebased the same way whenever the tab reloads the file.
- **A failed save keeps the draft.** The staged rows stay, and an error banner — "Couldn't save
  the summary model." — gives the reason and says the saved choice is unchanged.
- **Only the chain is written.** The server re-reads the file and writes it back atomically with
  every other key as it was; a summarizer kept (same backend and model, in either slot) keeps its
  own timeout, budget and any other field. A file listing more than two usable summarizers says
  so in a banner — the extras still run, and a save here keeps only the two shown. A file that
  exists but isn't a JSON object is never overwritten: an error banner quotes why, sessions run
  the built-in chain, and the selects and Save are disabled until it is fixed.

**Session titles**, the tab's second section, below the summary line: whether and with which
model Sova names sessions itself (§app.session-list/auto-titles). It is Sova's own file,
`<state root>/session-titles-settings.json` (`~/.pi/agent/sova/`, shown in the footnote), never
`topic-outline.json`: nothing outside Sova reads it, each host has its own, and a save applies to
the sweep's next run.

- **A switch, "Name sessions automatically", off by default.** Its hint says what it does: each
  session is named once, from its summary line, after it has been quiet for the time below, and a
  title you or the Overseer set is never changed. Off, no background call is made; the section
  heads' Name sessions button works either way.
- **Timing, two whole-minute fields**, Teams' number fields: "Check every (minutes)" (default 5,
  1–1440; hint "How often the sweep looks for sessions to name.") and "After quiet for (minutes)"
  (default 5, 0–1440; hint "A session is named once nothing was written in it for this long.").
  A value outside its range, or not a whole number, replaces the hint with "A whole number of
  minutes, {min} to {max}." and holds Save.
- **Primary and an optional Fallback**, each the Delegate row — Backend, Model, Effort
  (`WorkerSlotRow`), with that row's model lists and its "not offered" and "not verified" notes,
  but without Delegate's "off for subagents" marks (a title model is not a worker) — and the same
  Fallback switch as the summary line's; with it off, "No fallback: when the primary can't run,
  sessions keep their titles until it can." The defaults are pi
  `ollama-cloud/deepseek-v4.1-flash` at effort `off`, then Claude Code `sonnet` at effort `low`.
  **Reset to Defaults** in the section heading fills them in, with the switch and timing, and
  saves nothing; it is disabled while the form already shows them.
- **When neither saved model can run**, a warning banner says so with each row's reason
  ("not in pi's model registry", "no key for {provider}", "the Claude Code CLI isn't installed or
  doesn't answer", "turned off in Settings → Models", from `GET`'s `unusable`): "Neither title
  model can run right now." then "Primary: {reason}." and "Fallback: {reason}.". Saving is still
  allowed.
- **Picks wait for Save** (§app.settings-dialog/save-bar), as "Session titles" in the footer.
  Save waits for a complete form (both minute fields valid, every row has a model and an effort,
  the fallback is not the primary; the footer names the first of these that's missing, e.g.
  "Session titles needs a whole number of minutes between checks."), and the server refuses the
  same (400). A failed save keeps
  the draft under "Couldn't save the session title settings.", with the reason.
- **The file.** Read tolerantly (a missing or broken file, or a field in it that doesn't parse,
  reads as that field's default), written whole and atomically on Save.

## §app.settings-dialog/themes — Themes

The eighth tab. It lists every theme the app can find — the ones shipped with it and the ones
you dropped in yourself — as a radiogroup of **cards in a grid**, one of them checked. The grid
follows the panel's width: 3 cards across at the unfolded panel, 2 in the folded sheet, so 18
themes are 6 rows rather than 18 and the footer is a screen away instead of a page. Arrow keys
move the choice the way they do in the rail, across the grid: Left and Right step one card and
wrap, Up and Down step one row and stop at the top and bottom edges, Home and End go to the
first and last card. The column count is read off the rendered cards, never restated from the
stylesheet, so any panel width agrees with itself.

A card is the preview. It carries the theme's name, a meta line reading its base and where it
came from (`Dark base · Built-in`, `Light base · User`), a strip of 5 swatches painted in the
theme's own `bg`, `surface`, `accent`, `status-error`, and `ink`, and the sample `Aa 0x1F` set
in the faces that theme **would actually render in** — `Aa` in the body face, `0x1F` in the mono
face, each being the Typography pick below if there is one, else the theme's own, else the
default. A sample in a face the page wouldn't show is a preview of nothing. Both the swatches and
the sample render values out of a file the user may never
have chosen, which is why those values are checked when the file is read rather than when a
theme is applied (§design/ground-rules): by the time a card draws, there is nothing left to sanitize. A user file that took a built-in's id says so — `Dark base · User · replaces
the built-in` — because a Dracula that isn't ours is the one surprise this folder can spring, and
the card is where it should be legible rather than in a log. Every user card carries its file's full
path in `title`. The swatches are the only place in the product that paints a color the current
theme doesn't own; each is a 20px dot with a 1.5px `--color-border-strong` ring, so a swatch the
same color as the panel is still a dot.

The checked card is the tint plus a 1.5px accent edge plus a check mark in its corner: the mark
is what says "selected" in shape, because the tint and the edge alone are a color-only state.

**Choosing applies immediately.** There is no Save and no preview mode: the row you check is the
theme the window is wearing before your finger leaves the key, because a theme you have to
commit to is a theme you can't compare. The choice is the id, and it persists in `localStorage`
under `sova:theme`, read and applied before first paint (§design/ground-rules) so a reload never flashes the
default first. A stored id that no longer resolves — the file was deleted or renamed — falls back
to `dark`, and the list shows `dark` checked.

**A theme file we can't use stays in the list.** It renders as a disabled card spanning the
whole row — a reason is a sentence and needs the width — its filename in
mono where the name would be and its reason where the meta line would be. The card can't be
checked, arrow keys step over it, and it never replaces the theme you're wearing. A theme that
vanishes when it breaks is a theme you can't fix.

Two things go wrong, and they read differently. **A file that doesn't parse** carries the
parser's own message — "Expected double-quoted property name in JSON at position 15 (line 3
column 1)" is what tells you which brace to close. We quote it rather than rewrite it: V8 names a
line for most syntax errors and not for all, so copy of our own would be promising a position the
parser sometimes can't give. **A file that parses but holds a value we won't emit** names the key,
the value, and the shapes that would have worked — "a hex value, or one call to `rgb`, `rgba`,
`hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `color-mix`, or `color`". A rejection that only
says *invalid* sends you looking for a typo in a value that hasn't got one; the fix is almost
always a spelling we don't take, so the copy names the ones we do (§design/ground-rules).

### Typography

Under the grid, above the footer: the fonts **this browser** puts over whichever theme is on.
Two closed lists, each a native select so a phone gets its own picker — **Text**, which sets the
body and the display face together (the sidebar, messages, headings; a separate heading face is
not a choice worth a control), and **Code**, which sets the mono face (paths, ids, diffs, fenced
blocks). Every option is a face bundled with the app, so a pick is always a font that exists on
this device, offline: Inter, Source Sans 3, Atkinson Hyperlegible Next, IBM Plex Sans, and Noto
Sans for Text; JetBrains Mono, Fira Code, IBM Plex Mono, and Source Code Pro for Code. There is no
field for a font of your own — a face that isn't bundled is a face the phone hasn't got.

The first option in each list is **Theme default**, and it is the initial state: the theme's own
faces, which for every shipped theme are Inter and JetBrains Mono. Picking Inter or JetBrains
Mono explicitly is a different thing from Theme default — a theme that names some other face in
its file loses to an explicit pick and wins over Theme default. The pick is over the theme, not
part of it: switching themes keeps it, and it persists in `localStorage["sova:typography"]`
as catalogue ids (§design/ground-rules). **Use Theme Fonts** takes both picks off and is disabled while there are
none; `?theme=default` takes them off too.

It applies as you pick, like the theme. The preview under the two lists — a heading, two lines
of prose, and a two-line mono block whose lines are the same length so a column that stopped
aligning is visible — inherits the page's own faces rather than rendering the option, so it can
never show a font the page wouldn't. When a pick is on, one line under the preview names both
faces. IBM Plex Mono is the one static family in the catalogue: its hint says that medium and
display text render one step heavier (the scale's 530 and 640 resolve to its 600 and 700).

The footer names the folder — `~/.pi/agent/sova/themes/` in mono — and carries a Refresh
action. The list is fetched when the dialog opens and re-fetched every 2s while this tab is
visible, so a file you save in another window appears without a click; Refresh is there for the
moment you don't want to wait 2 seconds, and for the case where the watch is the thing that's
broken. Polling stops when the tab loses focus or the dialog closes.

While the list loads, the panel shows skeleton rows. If the folder can't be read, an error banner
offers Retry and the built-in themes list anyway — the app's own themes don't depend on it.

## §app.settings-dialog/profiles — Profiles

The tab after Teams: every profile a session in the open session's folder can use
(§chat.profiles/projects), read-only. It opens with one line: "Profiles are files. Ask an agent to
add or change one, or edit {path}." `{path}` is the project's `.sova/profiles/` folder (else your
`session-profiles.json`), and a **File Format** link opens `docs/profiles.md`.

- **The list**, in the picker's groups: **Built in** (Default first), **This project ({name})** and
  **Yours**. Each row has the profile's icon and label, its source badge, its summary line of what it
  changes ("reads and messages sessions · no edit files · One at a time"; Default "Nothing
  changed"), the playbook it links ("Runs {title}", or "Runs "{id}", not found here"), and its file's
  path. Without a session folder, This project says "Open a session to see its project's profiles."
- **Problems.** A file that couldn't be read is its own row under its group, with a **Can't be
  read** badge, its path and the exact error, so a mistake made by hand or by an agent shows here.
- **Approve** on a project profile that needs approval (§chat.profiles/trust), beside a line naming
  the powers it asks for; once approved the row says "Approved".
- **Hide From Picker** on every profile but Default (**Show In Picker** and a **Hidden** badge once
  hidden). Hiding and approving save at once; nothing here goes through the dialog's footer.

## §app.settings-dialog/overseer — Overseer

The Overseer's settings (§app/overseer), stored in `<stateRoot>/overseer.json`. It's Sova-owned; the
TUI never reads it.

**One page, one Save.** No sub-tabs: the groups below stack in this order and the dialog's Save
Changes writes them all (§app.settings-dialog/save-bar). What a user reaches for often stays open;
the rest folds. A folded group is a disclosure whose head names it and says, in a few words, what is
inside. It opens itself when the reason Save waits points to a field inside it (a limit that isn't
a whole number opens Per-message limits, an action missing its label or prompt opens its row, an
explorer with no model or effort opens Advanced), on the tab's mount as well as on the edit;
folding it again is the user's. Limits, Quick actions and the idea explorer each have a reset, at
the end of the group's head row, beside its name; each reads **Reset to Defaults** and fills only
the draft. Switch labels are in sentence case, like every other Settings switch.

- **Proactivity**: Off / List Only / Brief Me, the same setting the Overseer page cycles.
- **Model and thinking**: **Model** (provider/model) and **Thinking**, clamped to the model's
  ladder. A save applies them at once when the Overseer is idle, otherwise at the end of its turn.
  They never become the default for new sessions.
- **Limits** (§app.overseer/caps), all eight: its lede reads "Before acting, the Overseer checks
  these. When one is reached it stops and asks you instead. "Per message" counts restart each time
  you message it." First, full width, **Running at once**, with its hint: "How many sessions the
  Overseer started or messaged may be working at the same time. Starting a session, or messaging
  one that isn't already counted, needs a free slot; when none is free, the Overseer waits or asks
  you. Sessions you started count only once the Overseer messages them." Under the field a live
  line beside the field, "Now: 3 of 10 running.": the Overseer's running count (§app.overseer/caps), read when the
  tab mounts and every 15 s while it is open, of the number in the field (of the saved limit while
  the field doesn't hold a whole number); no line while the count can't be read. Then the other
  seven, folded as **Per-message limits**, whose head says how many differ from their defaults
  ("All at default", "2 changed from default"): **Sessions created**, **Prompts to other
  sessions**, **Sessions archived**, **Ideas explored**, **Links made**, **Organization changes**
  and **Gathering sessions started**, each hint saying what it counts, "per message you send".
  **Reset to Defaults** puts all eight back. The Overseer composer's "3 of 10 running" opens
  Settings here, the panel scrolled so Limits is at its top (the dialog's title stays in view).
- **Quick actions**: the hint reads "The Quick Actions button in the Overseer's composer foot lists
  these. Picking one sends its prompt." One line per action: its label, its description, and
  **Edit**, which opens that row alone (Label, Description, Prompt; Move Up, Move Down, Remove) and
  becomes **Done**. **Add Quick Action**, under the list, adds a row already open, its label
  focused; **Reset to Defaults** puts back the shipped five.
- **Standing notes**: a textarea over `overseer-notes.md`. Its hint: "The Overseer reads these every
  turn and can add to them. They survive /clear."
- **Advanced**, folded, its head "Idea explorer, extra instructions, resume after a restart":
  - **Idea explorer**: backend, model and effort of the explorers `sova_idea explore` launches
    (§app.overseer/explorer). Default Claude Code, `opus[1m]` (Claude Opus 5.5), effort medium; the
    default is offered even when the Claude Code CLI's model list omits it, and `claude-opus-5` is
    never offered; a save naming it for the explorer is refused, and a stored one reads back as the
    default.
  - **Extra instructions**: a textarea appended after the Overseer's own prompt. Its hint: "Added
    after the Overseer's own prompt. Applies from its next run." It and the standing notes reach the
    Overseer from its next run, with no `/clear` (§app.overseer/hosting).
  - **Resume interrupted sessions**: a switch, on by default, that resumes the runs a server restart
    cut off (§app.overseer/auto-resume).
- Phone notifications are not on this page: they have their own tab, **Notifications**
  (§app.notifications/settings).
- **Fresh, and only what changed.** Both files are read each time the screen mounts (each open of
  the dialog, each return to the tab); an unsaved edit kept across tabs is rebased onto that read:
  every field the user left alone shows the file's value. Save reads both files again and writes
  only the fields the user changed on top of them, so a model the Overseer's composer switched to, or
  a note `sova_note` added, while the form was open is never reverted. A file whose content would not
  change is not written.
- The PUT is strict: an invalid body is refused with its reason, and a model that can't be verified
  or that the policy refuses comes back as a warning sentence.

## §app.settings-dialog/decisions — Decisions

The settings of the opt-in classifier (§app/decisions), stored in `<stateRoot>/decisions.json`
and, for the key, `<stateRoot>/secrets/jev-key`. Sova-owned; the TUI never reads them. The tab
is named **Decisions**: it names what the features do, not a provider.

Saving is explicit, like every server-backed tab: the switches, the fallback and Folders are
staged, and the dialog's **Save Changes** writes them; the Jev key and the actions are
never part of it (§app.settings-dialog/decisions-autosave, §app.settings-dialog/save-bar).

In this order:

- **An intro and what is sent.** The intro says Sova can ask a small classifier about sessions
  and that everything on the tab is off until turned on. Directly under it, above every switch
  that sends anything, one sentence says what one check sends and to whom, and that the
  Overseer's own sessions are never checked (§app.decisions/privacy).
- **Jev.** A **Use Jev** switch, independent of the key, then one status line: a chip (dot and
  word — Working, Not checked, Off, No key, Rejected, Out of credit, Paused) and the fact ("Key
  ending ab12 · checked 2h ago.", "· not checked yet.", "· couldn't check it: …", "No key
  stored.", or why Jev is paused and when it tries again). Then the key: with none stored, a password
  field and **Save Key**; with one stored, **Replace Key** (the field again, with Save Key and
  Cancel) and **Remove Key** (which asks first, with Cancel). The field never shows a stored key — only
  its last 4 characters. A key from `SOVA_JEV_KEY` is shown as such, with no key controls. A key
  Jev rejects is not stored; the field keeps what was typed, with the reason. **Test Decisions**
  always sits in the key row — beside Replace Key and Remove Key, beside Save Key with none stored,
  on its own with a key from `SOVA_JEV_KEY`, and with Jev off — except while Remove Key asks; it is
  disabled while nothing can answer and while a change is being saved, and it tests what is saved,
  never unsaved changes. It runs one canned check with no session data and says, under
  the row, who answered and how long it took ("Answered by haiku in 4.1 s, after Jev was
  rate-limited."), or why nothing could.
  The Jev line reflects the test at once — Working and "checked just now" when Jev answered,
  Rejected when it refused the key — and the tab then re-reads the settings so the server's key
  status stands.
- **Fallback model.** A choice of **None** (the default) or **A model**; A model shows one
  backend/model/effort row (§app.settings-dialog/modes's picker rules: choices, not free text;
  nothing picked for you; a stored pick is always shown). The server's suggestions appear as
  "Suggested:" buttons that apply one only when clicked — only those this machine can run (the
  backend offers the model at that effort and the policy allows it); a backend that couldn't list
  its models keeps its suggestions, a failed check shows them all, and none show while it runs. Its hint says when it answers (Jev off,
  or Jev can't) and that its provider bills it. A model row holds Save Changes until backend, model
  and effort are all chosen (None and a Suggested button are complete at once). A newly chosen
  model the server refuses stays in the row with the server's reason under it and "Your saved
  fallback model is unchanged." The server's notes on a saved fallback (not verified, off by
  policy) show in warn under the row until the next save that changes the fallback. The section ends with the saved chain in words
  ("Asks Jev, then Claude Code · haiku.", a paused provider with when it retries, or the
  unavailable sentence).
- **Features.** **Flag sessions that need you** and **Tag sessions**, both off by default. With a
  feature on while nothing can answer, the switch stays on and its hint is replaced, in warn, by
  the unavailable sentence ("Unavailable: Jev is off and no fallback model is set. Nothing is
  checked.", or Jev can't answer and why). The server's note that a feature on stays unavailable
  shows in warn under the switches, only when the switches aren't already saying so.
- **Never send.** A **Never send TUI sessions** switch (sessions started in the pi terminal) and
  a Folders textarea, one full path per line (`/…`, `~` or `~/…`). A line that isn't a full path,
  or more than 100 lines, shows the reason under the box and holds Save Changes until fixed
  (§app.decisions/privacy); blank and repeated lines are dropped, so they alone are no change.
- **Tag past sessions**, only while Tag sessions is saved on or a backfill runs: **Tag Last 30
  Days** and **Tag All Sessions**, a hint that it runs 2 at a time, skips what's already tagged
  and costs more on a fallback model; **Stop Tagging** while one runs; a progress line ("Tagged 40
  of 147 · 2 failed.", then "Tagged 147 sessions · 2 failed. New sessions are tagged as they
  finish.", or "Stopped at … ." with the reason). Starting waits while a change is being saved,
  and is held with a reason while nothing can answer (§app.decisions/backfill). Like Test
  Decisions, it acts on what is saved.
- A footnote names where the settings are stored, and that the key is stored separately, readable
  only by the user.

## §app.settings-dialog/decisions-autosave — Decisions saves with Save Changes

Settings → Decisions stages every change — Use Jev, the fallback choice and model, the Features
and Never send switches, and Folders — and writes them only with the dialog's **Save Changes**
(§app.settings-dialog/save-bar). Nothing is written as it is made, and leaving the
Folders box or the tab writes nothing.

- **Fresh, and only what changed.** The PUT replaces the whole file, so Save first reads the file
  again and applies only the fields you changed on top of it: a field you left alone is written
  with what the file holds then, never with the form's older copy. A kept draft is rebased the same
  way each time the tab mounts. A save that would change nothing on the file writes nothing.
- **Save waits for a complete form**: a fallback model with backend, model and effort chosen, and
  every Folders line a full path. A feature on while nothing can answer is a warning, not a hold.
- **While a save is in flight** the form's controls are disabled; Test Decisions and the Tag
  buttons wait for it, since they act on what's saved. The footer's status line says what the save
  wrote ("Saved Decisions."), and says it to screen readers too.
- **A refused save.** Nothing is written, and every unsaved change stays on screen, with
  **Couldn't save the decision settings.** {reason}. "Your saved settings are unchanged." When the
  server refused a newly chosen fallback model its backend can't run (400), that choice also shows
  the reason under its row.
- **Notes.** A save with warnings shows each one under what it is about — the fallback row, or
  the Features switches; a note that names neither shows in a "Saved, with notes." banner at the
  end of the form. The fallback's notes stay until the next save that changes the fallback; the
  others are the server's view at each save and are replaced by the next.
- **Unsaved changes are held like every Save-gated tab** (§app.settings-dialog/save-bar):
  switching tabs keeps them, and closing the dialog over them holds and asks.
- The Jev key keeps its own buttons (§app.settings-dialog/decisions), saved and removed at once;
  it is never part of the draft.

## §app.settings-dialog/save-bar — One Save in the footer, one close-hold

Every Settings tab that writes a file on the server is Save-gated: **Models**, **Subagents**
(the library and this device's default), **Overseer**, **Notifications** (the **Phone Notifications** form), **Decisions**, **Summaries**, **Organizations**,
**Mesh** and **Experimental**. A change on them is staged, never written as it is made. No form has a Save or
Discard button of its own: saving is the dialog's.

- **The footer.** Left to right: a status line, then **Discard Changes** (ghost), **Save Changes**
  (primary; **Saving…** while it writes) and **Cancel**, while any gated form on any tab holds
  unsaved changes; with none, only the status line and **Close**. Every tab shows the same footer,
  General, Themes and Typography included. Folded, the status line keeps Cancel beside it and
  Discard Changes · Save Changes take the next line at the trailing edge, every button 44px tall.
- **Save Changes writes every dirty form on every tab** — the one showing, and every other, mounted
  or not. Each form writes its own file, at the same time as the others, and keeps its own rules:
  a form that rebases (Models, Overseer, Decisions, Summaries) reads its file afresh first; Mesh
  sends only what changed. A form never has two saves in flight, even across a close and reopen
  of the dialog. **Discard Changes** puts every form on every tab back to what's saved.
- **Save waits for every dirty form to be valid.** While any is incomplete or invalid, Save
  Changes is disabled and the status line, in error, names the first such form and what it needs
  ("Subagents: My setup's Delegate rows each need a model and an effort.", "Mesh: This host needs a name."). The form's own fields
  still say it inline. A form with no unsaved changes never holds Save.
- **The status line** says, first match wins: **Saving…**; why Save waits; a failed save ("Saved
  Models; Subagents failed.", or "Subagents failed." when nothing else was written); what is unsaved
  ("Unsaved: Models, Decisions", form names in rail order); what the last save wrote ("Saved
  Models and Decisions."); or nothing. The outcome of a save is announced to screen readers in the
  same words.
- **A failed save keeps its draft, and only its own.** Forms that saved stay saved. The dialog goes
  to the first tab, in rail order, whose save failed — unless the one showing did — and that form
  shows its error banner at its end: what failed and that what's saved is unchanged (Overseer:
  "Your other changes were saved." when part of it landed). The failure stays until the form is
  edited, discarded or saved. After a save lands, the form is what the server answered, and it
  reads clean. A form's "Saved, with notes." banner and its "Stored in …" line stay at the form's
  end.
- **Reset to Defaults** (Summaries) is a small button in that section's heading.
  It fills the form's draft with the built-in values and saves nothing.
- **Drafts outlive their tab.** Each form's draft, its save and what its last save said are module
  state, not the panel's, so switching tabs keeps them. A closed dialog forgets every draft;
  reopening starts from what's saved.
- **Closing holds.** Cancel, Close, Esc and the scrim all ask first when any gated form has unsaved
  changes: the dialog goes to the first tab, in rail order, that holds them — unless the one
  showing does — and holds the close with a warn banner above the foot: **Your {forms} changes
  aren't saved.** "Save them, or discard them and close." [Keep Editing] [Discard and Close].
  {forms} names every form with unsaved changes in rail order, joined with commas and "and"
  ("Models and Decisions"). Which forms take part is one registry the drafts join when they are
  created, so a new gated form is saved, discarded and held without the dialog naming it.
- **Mesh** stages this host's name, the sync switches, "Sync subscriptions to this host" and the
  front door; the subscriptions switch shows while the mesh is on and the form's Logins switch is.
  Save sends only the fields you changed, so a field a peer's sync wrote meanwhile stays. The name
  can't be saved blank. A save refreshes the mesh state, so the new name shows everywhere at once.
  Enter in a Mesh field does nothing: Save writes every tab's edits, and a key press in one field
  doesn't.
- **Experimental**'s Claude Code switch is staged too. Its status line reads the saved setting, so
  "Switch on to add its models" describes what the server does now, not the unsaved switch.
- **Not gated.** General, Themes and Typography change only this browser and still apply as you
  pick. Actions run at once and are never part of a draft: Retry, Try Again, Check Again, Themes'
  Refresh, the Jev key's Save Key, Replace Key and Remove Key, Test Decisions, Tag Last 30 Days,
  Tag All Sessions and Stop Tagging, and Phone Notifications' Enable on This Device, Turn Off on
  This Device, Remove and Send Test.

## §app.settings-dialog/organizations — Organizations

The tab after Summaries: **Hand-off sessions**, the defaults for new baton sessions
(§app.baton/goal-and-loadout). First **Message limit** — how many messages a hand-off
session takes in, from everyone, before it comes back to the operator; a whole number from 1 to
1000, default 60. The hint says it applies to new sessions only ("New sessions only; sessions
already started keep theirs."), and while the field holds anything else it says "A whole number
from 1 to 1,000." Save-gated: the dialog's footer saves it (§app.settings-dialog/save-bar), and
while the field is invalid Save Changes is disabled and the status line says "Organizations needs
a message limit from 1 to 1,000." A failed save shows "Couldn't save the message limit." at the
form's end, with the reason and "Your saved limit is unchanged."
Below it, **Photos in gathering chats** (§app.baton/images): **People can send photos** (on by
default), **Per message** 1–8 (default 4), **Largest photo, MB** 1–10 (default 5) and **Per
conversation** 1–200 (default 40), with the hint "Applies to every gathering session on this
host, from its next message." Save-gated like the limit: while a number is outside its range
Save Changes is disabled and the status line says "Organizations needs photo limits within their
ranges."
Host state, not the workspace repo: `<stateRoot>/baton-settings.json`, read and written through
`GET`/`PUT /api/baton/settings {messagesMax, photos?: {enabled, perMessage, maxBytes,
perConversation}}` (400 outside the bounds; a missing or corrupt file reads as 60 and the photo
defaults, each photo field on its own).

## §app.settings-dialog/toggle-target — A left-aligned toggle's target

Every switch, checkbox and radio in Settings is a label row: the native input hidden inside it, so
the label's text and its control are one target, at least 44px tall. A row that leads with its
control and reads left to right (Subagents' **Add a coordinator/monitor to new teams**, **Pause the
team**, members-default and spec-writer switches, and every **Fallback** switch — Subagents and
Summaries — the Decisions switches and radios, Overseer proactivity radios, and the Typography text sizes) is only as
wide as its text and control: a click on the empty row beside it does nothing. A row that spreads
its text and switch across the panel (General's **Summary line**, the Claude Code provider, Mesh's
sync rows, the Models policy switches) keeps the whole row as its target.

## §app.settings-dialog/claude-long-context-listed — A Claude Code `[1m]` alias counts as listed

The Claude Code CLI's model list names an alias such as `opus` but not always its 1M-context form
`opus[1m]`, which the CLI accepts. So wherever a worker or summarizer row checks a Claude Code
pick against that list (Settings → Subagents, Overseer, Summaries), a model
`<alias>[1m]` counts as listed when `<alias>` is: no "not verified" note under the row, no
"— not verified" in the select, and it takes `<alias>`'s efforts and policy marks. When `<alias>`
is not listed either, the pick reads as before (§app.settings-dialog/modes). Only Claude Code: a pi
model ending in `[1m]` is never read as its base.

## §app.settings-dialog/claude-long-context-offered — The known Claude Code 1M forms are offered

The CLI's list names `opus` and `claude-fable-5-1` but no longer their 1M-context forms, which it
accepts. So wherever Sova or its extensions list Claude Code models — every Settings row that picks
a Claude Code model (Subagents, Decisions, Overseer, Summaries), the chat
model picker's `claude-code-cli/*` models, and `agent_models` — `opus[1m]` and
`claude-fable-5-1[1m]` are offered right after `opus` and `claude-fable-5-1` whenever the CLI lists
that base and not already its `[1m]` form: the base's efforts, named "{base name} (1M context)".
Only those two: the list rule is fixed, not learned, so it holds from the first discovery after a
restart and never depends on having seen the CLI list them. Nothing is removed or reordered, and
a base the CLI doesn't list gains nothing. All three surfaces apply one rule (the claude-code
extension's `context-window.ts`).

## §app.settings-dialog/voice — Voice

The Voice tab sets up and looks after this host's dictation engine (§chat/voice): whisper.cpp
`v1.9.4` and the default model `ggml-large-v3-turbo-q5_0` (574,041,195 bytes, pinned sha256
`394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`), which setup installs. Other
models come from a pinned catalog in the Models section (§app.settings-dialog/voice-models). The
install and the active model are the machine's, not this browser's: everything lives under
`<state root>/voice/` (`SOVA_VOICE_DIR` overrides it), so any client — desktop or phone — sees the
same install and the same progress. How this device decodes, and its calibration, are the
device's own (§chat.voice/decoding, §app.settings-dialog/voice-calibration). The composer's mic opens the same setup as a sheet when voice isn't ready; both
render one view.

- **Before setup** the view says what will happen — the GPU backend detected (Vulkan, Metal or
  CUDA, with the device when known, else CPU), a whisper.cpp build of a few minutes (or, for CPU,
  a prebuilt binary), and the 574 MB model download — and offers one primary, `Set Up Voice`.
  Nothing downloads or builds before that press.
- **One press, then automatic.** `POST /api/voice/install` (202; 409 while a job runs) starts a job
  in the server process, one at a time, guarded by a lock file in the voice folder. It survives the
  browser closing. Steps, in order, each shown with its state (pending, running, done, skipped,
  failed) and a progress figure where it has one:
  1. **Detect** — OS, architecture, package manager, build tools, and the GPU backend: Metal on
     Apple silicon; CUDA when `nvcc` and `nvidia-smi` are both present; Vulkan when a loader and an
     ICD are present; otherwise CPU.
  2. **Packages** — what the build needs and is missing. Sova never runs `sudo` or a package
     manager: when something is missing the job stops in **needs packages**, and the view shows
     the exact one-line command for the detected package manager in a mono block with `Copy
     Command` and `Check Again` (which re-runs the job from detection), plus `Use CPU Instead` where
     a prebuilt CPU binary exists for this host.
  3. **Source** — the pinned whisper.cpp tag tarball, or for CPU on Linux x64/arm64 (glibc 2.35 or
     newer) the pinned prebuilt release with its sha256 checked; resumed with HTTP ranges.
  4. **Build** — `cmake` with the backend's flag, static libraries, only the `whisper-server`
     target, at low priority; progress from the build's percentages. The binary is renamed into
     `bin/` atomically and the build tree is removed. Skipped for the prebuilt.
  5. **Model** — first an import: a file of the exact size and sha256 already on this machine in a
     known folder is copied (a reflink where the file system has them) instead of downloaded; then
     a ranged, resumable download with a streaming sha256. A mismatch deletes the file and fails the
     step. Free disk space is checked first.
  6. **Self-test** — starts the server and transcribes a committed 3-second clip; it passes when the
     transcript has the expected words, and records the time and whether the GPU was really used.
  7. **Finish** — writes `install.json`, which is what "ready" means.
  Every step checks its own result first and reports **skipped** when it is already satisfied, so
  the job is idempotent and resumes after a cancel, a failure or a server restart. `Cancel Setup`
  stops it where it is.
- **Failed** shows the step and its error, `Retry` (primary), `Use CPU Instead` where a prebuilt
  CPU binary exists and the job wasn't already CPU, and the log.
- **The log** — the job's recent lines, 24-hour times, in a collapsible block (`Show Log`), read
  with `GET /api/voice?since=<seq>`. The tab and the sheet poll that every second while a job runs
  and every 10 seconds otherwise, only while mounted.
- **Ready**, the tab shows one status line — backend and device, the self-test time, the active
  model and its engine, disk used, and whether the engine is loaded — then `Test Microphone` (records up to 3
  seconds and shows the transcript, inserting nothing), the **Models** section
  (§app.settings-dialog/voice-models), the **This Device** section with calibration
  (§app.settings-dialog/voice-calibration), and last, apart from everything else, `Repair` (runs
  every step again with verification forced: every downloaded model re-hashed — a wrong one is
  deleted, and only the active one fetched again — the binaries probed, a fresh self-test on the
  active model; voice isn't ready until it passes) and `Uninstall Voice`
  (destructive; a confirmation says the voice folder and its size go away — whisper.cpp,
  transcribe.cpp when Parakeet was downloaded, every model, the kept calibration clips and the logs
  — and system packages stay installed).
- **CLI.** `pnpm run voice:install [status|install|repair|uninstall] [--cpu] [--yes] [--dir <path>]`
  runs the same job with a console reporter, for a headless host; it refuses while a server holds
  the lock. `pnpm run voice:install models [list | download <id>|--all | delete <id> | use <id> |
  test <id>|--all]` does the Models section's jobs the same way; `test` self-tests a downloaded model
  without switching to it and reports its time and GPU memory.
- **Knobs** for tests and odd hosts: `SOVA_VOICE_DIR` (the folder), `SOVA_VOICE_PATH` (the PATH
  detection and the build use), `SOVA_VOICE_IMPORT_DIRS` (the folders the import checks, `:`-separated),
  `SOVA_VOICE_IDLE_MS` (the idle unload), `SOVA_VOICE_WHISPER_BIN` (a stand-in server, such as
  `scripts/fake-whisper-server.mjs`, which makes voice ready without an install),
  `SOVA_VOICE_WHISPER_GPU=1` (that stand-in counts as a GPU install, so calibration uses the GPU
  grid), and `SOVA_VOICE_TRANSCRIBE_BIN` (a stand-in for Parakeet's host; the same fake server
  answers as it when its model ends in `.gguf`).

## §app.settings-dialog/voice-models — Voice models

The Models section of the Ready view: a pinned catalog of speech models this host can download,
verify, switch to and delete. One model is active for the whole host (§chat.voice/runtime); every
device follows it, each with its own saved settings for that model or the defaults
(§chat.voice/decoding).

**The catalog** is pinned in code, every size and sha256 checked against its source on the day it
was written, like the rest of the pins. There is no remote list, and no network request happens
until a press.

| Model | Engine | Download | Languages |
|---|---|---|---|
| large-v3-turbo · q5_0 (default, `Recommended`) | whisper.cpp | 574 MB | English and 99 more |
| large-v3-turbo · q8_0 | whisper.cpp | 874 MB | English and 99 more |
| large-v3-turbo · f16 | whisper.cpp | 1.62 GB | English and 99 more |
| large-v3 · q5_0 | whisper.cpp | 1.08 GB | English and 99 more |
| distil-large-v3.5 · f16 | whisper.cpp | 1.52 GB | English only |
| Parakeet TDT 0.6B v2 · q8_0 | transcribe.cpp | 751 MB: the 730 MB model and the 22 MB engine | English only |

Parakeet appears only on a Linux x86_64 host, where transcribe.cpp's prebuilt release runs. It takes
no prompt and no voice detection, so it can't be tuned: calibration scores it but never changes its
settings (§app.settings-dialog/voice-calibration). The Silero voice-detection model is part of the
catalog but not a row (§chat.voice/decoding).

- **Rows.** A `.list`, one row per model, smallest first, each at least 44px, its actions wrapping
  under the name at folded width. A row shows the name and quantization, then a caption: size,
  languages and state. States: not downloaded (`Download`) · downloading (the figure, then a meter,
  then `Cancel Download`) · checking (the streaming hash's percent) · downloaded (`Use This Model`,
  `Delete Model`) · in use (a chip `In Use`, and the self-test time) · failed (the reason, `Retry`).
- **Download** is a job like setup: it survives the browser closing and a server restart resumes
  it. It uses setup's model step — an import first (a file of the exact size and sha256 in a known
  folder is copied, and the row says where from), then a ranged, resumable download with a
  streaming sha256; a mismatch deletes the file and fails. Free disk space is checked first: with
  less than the model's size plus 50 MB free, `Download` is `aria-disabled` and says what it needs.
  Parakeet's first download also fetches the transcribe.cpp release (pinned size and sha256) and
  compiles Sova's small host for it with the host's C compiler, and the disk check counts both.
  Without a C compiler the row stops in **needs packages**, showing the same one-line command and
  `Copy Command` and `Check Again` as setup's Packages step; Sova never runs `sudo`. One
  job at a time, under setup's lock: while one runs, the other rows' `Download` is `aria-disabled`
  with the reason. `POST /api/voice/models/<id>/download` (202; 409 while a job runs or the id is
  unknown); `POST /api/voice/models/cancel` cancels the one running model job.
- **Switch.** `Use This Model` (`POST /api/voice/models/<id>/use`, 202) stops the engine, starts
  the chosen model and runs the self-test on it; the row says `Testing…` meanwhile. Every model,
  Parakeet included, passes on the same rule, which needs no prompt: a non-empty transcript with at
  least 2 of the self-test clip's 4 words, case ignored. Then the model becomes active for the
  whole host. If it
  fails, the old model stays active and the row says so, with what it heard. Refused (409) for a
  model not downloaded, while any job runs, and while a calibration sweep runs.
- **Delete.** `Delete Model` (destructive, outline, never beside the primary) confirms inline in a
  banner-warn; the file and any partial download go. Calibration results for that model stay, in
  case it comes back. The model in use has no Delete; its row's `title` says to switch first.
  `DELETE /api/voice/models/<id>` answers `{freed}`, and 409 for the active model or one
  downloading.
- **Disk line.** One caption under the list: how many models are on disk, their total size, and
  the free space on the voice folder's disk.

## §app.settings-dialog/voice-calibration — Voice calibration

The **This Device** section of the Ready view finds the best decoding settings for the device
you're using, on the active model, from sentences you read aloud with known text, and saves them
for this device (§chat.voice/decoding). Everything happens inside the scrolling panel: the flow
replaces the section's body, and nothing opens over Settings (§app.settings-dialog/one-height).

- **The section, at rest.** "This device: {label}", then whether it is calibrated for the active
  model (when, on how many clips, its word error and time per clip) or uses the defaults, then
  `Calibrate This Device` (or `Calibrate Again`), and `Delete Clips` when clips are kept
  (destructive, inline confirm). Below it,
  the other devices that have saved settings, each with its label, when it was last seen, the
  models it's calibrated for, and `Forget` (inline confirm; its settings and clips go). An
  unsupported browser context (§chat.voice/button) disables `Calibrate This Device` with the same
  reason in its `title`.
- **Sentences.** Six fixed sentences, each with its reference text, five of them using Sova's
  jargon (Sova, worktree, Overseer, statechart, subagent) and one with none, as the control; then an
  optional passage of about 35 seconds. Shown one at a time, large, under "Sentence {i} of {n}",
  with no highlighting. The reference texts avoid digits and times, so normalization can't move a
  score.
- **Recording** is the composer's: tap to start, tap to stop, with the same capture pipeline
  (§chat.voice/capture), `startCapture` called synchronously in the press. While recording, the
  button is accent-filled `Stop Recording` with the stop glyph, and the time and the level (number
  first, then the bar) show under the sentence. A sentence stops itself at 20 s, the passage at
  60 s. On stop the clip uploads at once (`PUT /api/voice/calibration/clips/<n>?device=<id>`, the
  same WAV checks as transcribe plus the clip check, §app.settings-dialog/voice-clip-check,
  replacing any earlier take), then `Next Sentence`, `Record Again`,
  `Skip Sentence`. A clip whose level never rose above the speech threshold isn't uploaded; the
  line says so. If the page goes to the background mid-recording, the take is dropped (a cut
  sentence is worse than none) and the line says to record it again. `Esc` while recording cancels
  the recording only, never Settings. `Cancel Calibration` leaves the flow and keeps the clips
  already uploaded.
- **Kept clips.** A device's clips are kept on this host under `<state root>/voice/calibration/<device id>/`,
  so it can be calibrated again on another model without reading again. They come only from that
  device and are scored only for it. `Delete Clips` (`DELETE /api/voice/calibration/clips?device=<id>`)
  removes this device's clips and runs; `DELETE /api/voice/calibration/clips/<n>?device=<id>` removes one take.
  Forget and Uninstall remove them too.
- **The sweep.** `Find Best Settings` (primary; needs at least 4 clips) starts a server job
  (`POST /api/voice/calibration/run?device=<id>`, 202), after an estimate of how long it takes. On
  a GPU install it tries 12 settings — prompt {none, hotword list, hotword sentence} × beam {1, 5} ×
  voice detection {off, on} — and on a CPU install 4 — prompt {list, sentence} × beam {1, 5}, voice
  detection off — all with the 0.2 fallback (on clips a few seconds long it almost never fires, so
  trying it off doubled the sweep for nothing). The device's current settings are always among them,
  run first and again last; each clip is decoded as dictation would decode it, with the folder
  hint of this device's last dictation on this host (§chat.voice/transcribe), if any; clips go round-robin, and each
  setting's time is its median. It runs through the dictation-first lane (§chat.voice/runtime), so
  dictating on any device keeps working and the progress says "Paused for dictation." meanwhile.
  Progress: which setting of how many, a meter, time left, and the best so far. You can close
  Settings: the job keeps going on this host, and reopening shows it. `Stop Calibration` keeps what
  has been scored. One sweep runs on the host at a time: while another device's runs, `Find Best
  Settings` is `aria-disabled` with the reason (recording still works). A model switch is refused
  while it runs. On Parakeet there is nothing to sweep:
  the job is one scoring run of the clips, giving one results row.
- **Scoring.** What was heard is scored after the jargon post-correction dictation applies
  (§chat.voice/jargon-fixes). Word error is the normalized word error rate against the reference
  (case and punctuation ignored, and a compound split in two — "work tree", "state chart", "sub
  agent", "type script" — counted as the one word it is, so one spelling slip is one error). A
  transcript that repeats a run of 6 or more words of the prompt it was decoded with is the model
  echoing its prompt, not hearing: it scores as nothing heard. Jargon hits count each jargon word
  (Sova, worktree, Overseer, statechart, subagent, TypeScript, Claude) aligned with the same word,
  heard as written, at its place in the word alignment — a jargon word elsewhere in the transcript
  doesn't count; edge punctuation and a possessive 's don't matter ("Sova's" counts), a hyphen or a
  split does ("sub-agent" misses) — and "Sova" counts only capitalized. The best setting has the
  fewest word errors; among settings within 1 word of it, more jargon hits win, then fewer errors,
  then the shorter time per clip. The device's current settings stay first unless the best of the
  others has at least 3 fewer word errors: on about 100 words a smaller gain is noise. A setting
  scored on fewer clips (a stopped run) ranks after every fully scored one.
- **Voice detection unavailable.** If the Silero model can't be fetched, the sweep skips the
  settings with voice detection on and the results say so; it never scores them without it.
- **Results** as `.list` rows, not a table: the top 5 plus the current settings, always shown and
  labelled `Current`. A row reads its settings in words, then word error, jargon hits ("{h} of
  {n}") and time per clip. Opening a row shows each clip's reference and what was heard, missed
  words marked `−`, extra words `+`, and a jargon word heard in the wrong case `~` (a sign, never
  color alone). The caption says the order in
  one sentence.
- **A busy host.** When the host was busy during the sweep, the results carry a banner-warn saying
  the times may be slower than usual and word error isn't affected.
- **Applied automatically.** When the sweep completes, the server saves the best setting at once
  for this device and the active model, and the results say so with `Revert to Previous`
  (`POST /api/voice/calibration/revert?device=<id>`), which puts back what was saved before. Any
  other row has `Use These Settings`, which saves that row
  (`POST /api/voice/calibration/apply?device=<id>` with the chosen row). If the current settings rank first (no setting beat them by 3 words or more), nothing changes and the results say so. A
  stopped or failed sweep applies nothing; its rows still offer `Use These Settings`, which
  saves that row's settings as chosen, with no calibration summary (only a completed run gives one). On Parakeet
  nothing is applied: its score is one row labelled with the model, shown beside the device's
  results for the whisper models, to compare. The scores shown for other models, Parakeet included, come only from
  each model's last completed run; a stopped or failed run never supplies one. A new run replaces the device's results for that
  model; there is no separate discard.
- **No Save.** Applying, reverting, forgetting and model jobs are immediate actions, like
  Uninstall: Voice has no staged form and no part in the footer's Save (§app.settings-dialog/save-bar).

## §app.settings-dialog/voice-clip-check — Calibration clip check

A calibration clip is checked on upload, before it is kept, because a damaged clip makes every
model look bad. It is refused (400) with one plain sentence naming the first cause found, and the
sentence step shows that sentence on its status line; nothing is kept:

- **Clipping** — more than 0.1% of samples at full scale: "This clip is clipping: the mic is too
  loud. Lower its input level and record again."
- **Too quiet** — no 20 ms stretch louder than −40 dBFS: "This clip is too quiet to score. Move
  closer to the mic or raise its input level, and record again."
- **Digital silence** — a run of exactly-zero samples longer than 50 ms between the first and last
  speech (a 20 ms stretch above −40 dBFS), or more than 10% of all samples exactly zero: "This clip
  has digital silence inside speech — a system noise gate (like EasyEffects' RNNoise VAD) is
  cutting your voice. Turn it off and record again." A raw mic always carries some noise, so exact
  zeros only come from processing.
- **Cut off** — the last 100 ms still above −45 dBFS: "This clip ends mid-word. Record it again and
  stop a moment after the last word."

## §app.settings-dialog/outreach — Outreach

Settings → Outreach (§app/outreach) sets how this host reaches the WhatsApp sender, after Public
links in the rail. It is Save-gated (§app.settings-dialog/save-bar): **Sender** and **Accept sends
from** are staged and written by Save Changes, as the form "Outreach".

- **Sender**: **Off** · **This host** (the sender runs here; an optional socket path, placeholder
  the default) · **Via a peer** (a select of this host's peers, §mesh/peers). Under it, the sender's
  state as the server last read it, as a chip and a sentence: Off; "Not reachable: {why}";
  Connected (with the number's last three digits); Connecting; Not paired ("Pair it on the sender's
  host: sova-whatsapp pair."); Logged out ("Pair it again on the sender's host:
  sova-whatsapp pair."); Replaced ("Another copy of the sender took over this number."); Blocked;
  Down ("Reconnect it on the sender's host."). **Check Again** re-reads it at once.
- **Accept sends from** (shown only while Sender is This host): **No other host** · **All peers** ·
  a checkbox per peer; other hosts send through this host's sender only as listed here.
- **Pause all sending**, a switch that applies at once (an action, not part of the draft): while on,
  every send from this host is refused with "Outreach is paused.".
- **Protected paths**: the paths §app.outreach/secrets covers, one per line, under "Hidden from
  the Overseer's file tools:"; a warn banner when the sender reports an auth directory that
  sandboxed agents can still read.
- A closing note: "Links you send stay in your own WhatsApp chat history: anyone with your phone
  can open them." and a pointer to `docs/outreach/whatsapp.md`, the setup guide.
