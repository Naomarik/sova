# §app/settings-dialog — Settings dialog
> Part of the Sova design spec · [overview](../design/overview.md)

The sidebar foot's Agents row ends in a gear. It opens the Settings modal: a left tab rail and
one panel, wider than the product's question-asking modals because two panes have to fit beside
each other (§design/ground-rules and §design/deviations record the deviation). There is no route and no URL — Settings is a modal
the session stays behind, closed by the scrim, Esc, or its Close button.

The rail is the structure: each settings screen is one tab — General, Models, Modes, Overseer,
Decisions, Themes, Experimental.
Tabs move with the arrow keys as well as the pointer, and the selected tab has focus on open: the
two have to name the same screen. The gear opens General; the mode menu's **Configure Delegate** gear
(§chat/mode-menu) opens Modes directly, and nothing else about the chat changes. Which tab is open lives in
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

The head, the rail and the foot never scroll or shrink — Close is reachable at every viewport —
and on a short window the floor under the body gives way rather than the foot: the panel is the
part that already knows how to scroll. Adding a tab is then a content question only; no screen
can change the dialog's size by being long or short.

## §app.settings-dialog/general — General

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

  It saves as you type, like every other setting here: a valid number moves the sidebar on the
  keystroke. An invalid one changes nothing and the field says which way it is wrong — "3 is the
  fewest. Below that Recent is a row, not a list." — rather than silently clamping under the
  caret. Leaving the field is where an unusable draft is repaired to the nearest count that works,
  and the polite region says the new count so the repair isn't silent.

  The value persists in `localStorage["sova:recent-count"]`, like the theme and for the same
  reason: it is this browser's, not the machine's. A stored value that is not a whole number in
  range is the default; a number out of range is clamped.

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

A provider is a group head: its switches cover every model under it, and the model rows' own
switches grey out while it is off — the provider already answered. Turning a provider off removes
its models' own entries from that dimension: the provider covers them, and turning it back on
returns every model allowed, which is what the list showed. `claude-code` is a provider of its own
with no model rows: one switch over every Claude Code worker, its default model included, because
its models are the CLI's rather than pi's. A provider named in the policy that this machine has no
credentials for is listed too, with `No models on this machine` where the count goes — a rule you
can't see is a rule you can't undo.

Every switch saves immediately — a switch that needed a Save button would be lying about when it
takes effect, and the file is read per spawn and per turn — and the save is the whole policy. A
failed save puts the switch back where it was and says so in an error banner; the server's copy is
the truth, never a local maybe.

While the model list or the policy loads, the panel shows skeleton rows. If the policy can't be
read, an error banner offers Retry and touches nothing.

## §app.settings-dialog/modes — Modes

The third tab. Today it holds one section, **Delegate**: which worker each kind of Delegate work
goes to (§chat/mode-menu names the mode; `pi-config/extensions/mode/README.md` owns the behaviour). Normal mode
has nothing to configure, so it has no section.

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
  never read as gone: a backend whose discovery fails gets one warn banner with **Check Again**
  carrying the reason, its rows say only "Not verified: {backend} couldn't list its models.", and
  saves still go through, with one "not verified" note per backend naming every slot on it.
- **A Claude Code alias the CLI's list omits is not gone.** The `claude` initialize model list is
  remote and account-gated and alternates within minutes between a shape that carries the `[1m]`
  aliases (`opus[1m]`, `claude-fable-5-1[1m]`) and one that does not, while the CLI accepts a valid
  alias at runtime either way. So a shape-valid Claude Code model (an alias: no `/`, no leading
  `-`, no whitespace) missing from a list the CLI did answer reads "— not verified" in the select
  and, under its row, muted: "Not verified: the Claude Code CLI's model list doesn't include
  {model} right now (the list varies). It will still be used." — the same soft state Delegate
  routes it by. Only a shape-invalid Claude id, or a pi model its registry doesn't list, is "not
  offered". The server's save check reads such a row the same way: never refused for absence from
  the list, saved with that note; and its options list unions `[1m]` ids seen in recent discoveries
  (30 minutes) so the picker doesn't flicker between the two shapes.
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
- **Saving** is explicit — Save Changes (primary, pinned to the trailing edge even when the row
  wraps), Discard Changes, Reset to Defaults (fills the built-in routing in; it's saved only by
  Save Changes) — because the routing is one coherent choice across eight rows, not eight
  switches. Save waits for every row to have a model and an effort, and for no fallback to be its
  own primary.
- **Unsaved edits are kept, and never dropped silently.** The draft lives outside the tab
  (`src/lib/delegate-draft.ts`), so switching to Models and back keeps it. Closing the dialog —
  Close, Esc, or the scrim — over unsaved Delegate edits brings you back to Modes and holds the
  close with a warn banner above the foot: **Your Delegate changes aren't saved.** "Save them on
  this screen, or discard them and close." [Keep Editing] [Discard and Close]. A closed dialog
  forgets the draft; reopening starts from what's saved. The save replaces the whole file. The server
  refuses a **changed** row its backend answered it can't run (model not offered — for Claude Code,
  only a shape-invalid id — or effort not taken) and names it; a row that can't be checked, or that
  the policy refuses, saves with a warn banner "Saved, with notes." A row left as it was stored
  never blocks a save.

The file is `~/.pi/agent/mode-delegate.json` (shown in the footnote), global and shared with pi in
the terminal. Chats already in Delegate — web and TUI — use a save from their next message; chats
in normal mode never read it, and no chat keeps a copy of it.

Defaults (Reset to Defaults): Planning & specs Claude Code `claude-fable-5-1[1m]` medium, fallback
`opus[1m]` high; Investigation `opus[1m]` low; Routine `opus[1m]` low; Complex `opus[1m]` medium;
no fallbacks but Planning's.

## §app.settings-dialog/themes — Themes

The fourth tab. It lists every theme the app can find — the ones shipped with it and the ones
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

## §app.settings-dialog/overseer — Overseer

The Overseer's settings (§app/overseer), stored in `<stateRoot>/overseer.json`. It's Sova-owned; the
TUI never reads it.

- **Model** (provider/model) and **Thinking**, clamped to the model's ladder. A save applies them
  at once when the Overseer is idle, otherwise at the end of its turn. They never become the
  default for new sessions.
- **Extra System Prompt**: a textarea appended after the Overseer's own prompt. Its hint: "Added
  after the Overseer's own prompt. Applies from its next run." It and the Standing Notes reach the
  Overseer from its next run, with no `/clear` (§app.overseer/hosting).
- **Proactivity**: Off / Badge Only / Brief Me, the same setting the Overseer page cycles.
- **Quick Actions**: an editable list (label, description, prompt; add, remove, reorder, Reset to
  Defaults).
- **Limits**: sessions created per user message, prompts sent per user message, archives per user
  message, explorers launched per user message, and Overseer-started sessions running at once
  (§app.overseer/caps).
- **Exploratory Agent**: backend, model and effort of the explorers `sova_idea explore` launches
  (§app.overseer/explorer). Default Claude Code, `opus[1m]` (Claude Opus 5.5), effort medium; the
  default is offered even when the Claude Code CLI's model list omits it, and `claude-opus-5` is never offered;
  a save naming it for the explorer is refused, and a stored one reads back as the default.
- **Standing Notes**: a textarea over `overseer-notes.md`.
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

Every change is saved as it is made, one write at a time, the way Mesh and Summaries save — no
Save or Discard, and closing the dialog never asks (§app.settings-dialog/decisions-autosave).

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
  disabled while nothing can answer and while a change is being saved. It runs one canned check with no session data and says, under
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
  or Jev can't) and that its provider bills it. A model pick is saved once backend, model and
  effort are all chosen (None and a Suggested button at once); until then it stays in the row
  only. A newly chosen model the server refuses stays in the row with the server's reason under it
  and "Your saved fallback model is unchanged."; it isn't sent again until changed. The server's
  notes on a saved fallback (not verified, off by policy) show in warn under the row until the next
  save that changes the fallback. The section ends with the saved chain in words
  ("Asks Jev, then Claude Code · haiku.", a paused provider with when it retries, or the
  unavailable sentence).
- **Features.** **Flag sessions that need you** and **Tag sessions**, both off by default. With a
  feature on while nothing can answer, the switch stays on and its hint is replaced, in warn, by
  the unavailable sentence ("Unavailable: Jev is off and no fallback model is set. Nothing is
  checked.", or Jev can't answer and why). The server's note that a feature on stays unavailable
  shows in warn under the switches, only when the switches aren't already saying so.
- **Never send.** A **Never send TUI sessions** switch (sessions started in the pi terminal) and
  a Folders textarea, one full path per line (`/…`, `~` or `~/…`). Folders are saved when you
  leave the box, and not when nothing changed; a line that isn't a full path, or more than 100
  lines, shows the reason under the box and isn't saved until fixed (§app.decisions/privacy).
- **Tag past sessions**, only while Tag sessions is saved on or a backfill runs: **Tag Last 30
  Days** and **Tag All Sessions**, a hint that it runs 2 at a time, skips what's already tagged
  and costs more on a fallback model; **Stop Tagging** while one runs; a progress line ("Tagged 40
  of 147 · 2 failed.", then "Tagged 147 sessions · 2 failed. New sessions are tagged as they
  finish.", or "Stopped at … ." with the reason). Starting waits while a change is being saved,
  and is held with a reason while nothing can answer (§app.decisions/backfill).
- A footnote names where the settings are stored, and that the key is stored separately, readable
  only by the user.

## §app.settings-dialog/decisions-autosave — Decisions saves as you go

Settings → Decisions writes each change as it is made: every switch, the fallback choice, a
fully chosen fallback model, and Folders when you leave the box. The PUT replaces the whole file,
so the tab sends one write at a time: a change made while one is in flight waits, a later change
replaces it, and only the newest write's answer is shown — an older answer never puts a control
back. Controls stay usable while a write is in flight; Test Decisions and the Tag buttons wait for
it, since they act on what's saved. A successful write is announced to screen readers ("Decision
settings saved.") with no visible "Saved" text.

- **Parts that can't be written yet don't hold the rest.** A fallback not fully chosen, a refused
  fallback, and Folders with a line that isn't a full path each stay on screen; every other change
  is still saved, carrying the saved fallback and folders in their place.
- **A refused write.** The server refuses a newly chosen fallback model its backend can't run
  (400): it stays in the row with the reason; the rest of that write is sent again without it. Any
  other failure puts back what that write tried to change and shows **Couldn't save the decision
  settings.** {reason}. "Your saved settings are unchanged."
- **Notes.** A write that saves with warnings shows each one under what it is about — the fallback
  row, or the Features switches; a note that names neither shows in a "Saved, with notes." banner
  at the end of the form. The fallback's notes stay until the next write that changes the
  fallback; the others are the server's view at each write and are replaced by the next.
- **The dialog never holds its close for Decisions.** A fallback not fully chosen, or Folders
  with an invalid line, is forgotten when the dialog closes; switching tabs keeps it. Folders
  typed but not yet left are saved when the tab changes.
- The Jev key keeps its own buttons (§app.settings-dialog/decisions); it is never part of this.
