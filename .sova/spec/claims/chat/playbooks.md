# §chat/playbooks — Playbooks
> Part of the Sova design spec · [overview](../design/overview.md)

A playbook is a markdown recipe an agent runs against a project: "audit this repo's
accessibility", "write the launch notes". The recipe does not depend on any one project. You
pick one from the composer flyout (§chat/composer), add a line of your own if you want, and it goes into the
current chat as your turn, through the chat's ordinary send path.

## §chat.playbooks/where-playbooks-come-from — Where playbooks come from

`GET /api/playbooks?cwd=…` returns a `PlaybookCatalog` (`shared/protocol.ts`), built by
`server/playbooks.ts`. It rescans its folders on every request, with no watch and no cache.
The dialog fetches once each time it opens.

| Group | `source` | Folder | Notes |
|---|---|---|---|
| **Sova** | `sova` | `playbooks/` at the Sova repo root | Shipped with Sova: the playbooks you start yourself. Sova's own playbooks, the ones only Sova starts, are in `system-playbooks/` beside it and never in this list (§chat.playbooks/system-playbooks) |
| **Yours** | `user` | `~/.pi/agent/sova/playbooks/` | Your own. An id that matches one in `playbooks/` **replaces** it: the shipped entry is dropped and yours carries `replacesSova: true`. The interface deliberately **does not render** that flag: the row already sits under the Yours heading, so a marker would only repeat it. The field exists in the data, asserted in `server/playbooks.test.ts`. An id that matches one of Sova's own playbooks replaces nothing: it is listed here like any other of yours |
| **This project** | `project` | `<project root>/.sova/playbooks/`, then `<project root>/.sova/marketing/playbooks/` | The session's project (§chat.profiles/projects): a worktree or subfolder reads its main checkout's. An id in both folders is listed once, from `.sova/playbooks/`. It never replaces anything. It is always its own group, even when an id matches one above. What a project adds to Sova's own chats is in `.sova/playbook-config/`, never listed (§chat.playbooks/playbook-config) |

No playbook only Sova's own chats run is listed: the catalog, the Playbooks dialog and the `/` rows
leave out everything in `system-playbooks/` (the merge thread's and the release chat's methods,
`project-setup` with its release and deploy halves `release-maker` and `project-deploy`, and
`project-verbs`, §chat.playbooks/system-playbooks) and everything in a project's
`.sova/playbook-config/` (§chat.playbooks/playbook-config). Any other playbook whose description says
`listed: false` is hidden too (§chat.playbooks/unlisted).

**The grammar is the same in every folder.** A playbook is a directory `<id>/` whose
**entry file** is either `PLAYBOOK.md` or `SKILL.md`, plus whatever other files its entry tells
the agent to read (§chat.playbooks/bundles). One file is the whole entry: Sova's keys go in its
frontmatter either way, so a folder written as a pi or Claude Code skill is also a playbook.

- **Which file is the entry.** `PLAYBOOK.md` when the folder has one, otherwise `SKILL.md`. A
  folder with both is read from `PLAYBOOK.md` alone, and its `SKILL.md` is just another file in
  the bundle, so every playbook written before `SKILL.md` was accepted reads exactly as it did.
  The catalog entry's `entry` names the file that was read.
- `id` is the directory name and must match `^[a-z0-9][a-z0-9-]*$`, so no dot entries and no
  separators. Other names are skipped. So is a child that isn't a directory (symlinks are
  followed) or has no readable entry file. One bad folder never hides the others.
- **Frontmatter** is a leading `---` fence of `key: value` lines. Values are single-line scalars.
  Matching quotes around a value are removed, and lines that aren't `key: value` are ignored, as
  are keys Sova doesn't read (a skill's `allowed-tools:`, say). It is **not YAML**: a multi-line
  value isn't read. Sova reads `title`, `name`, `description` and the optional `promptHint`: what
  you may want to say in the first turn. A project playbook may also carry a schedule, `when:`
  with `profile:`, `tz:` and `task:` (§chat/schedules).
- The title is `title`, else `name` (a skill's own key), else the id: each is skipped when it is
  missing, empty or whitespace-only (`fields.title?.trim() || fields.name?.trim() || id`).
  If `description` is missing, it is empty (`?? ""`). An empty `description:` also stays empty. A file with no
  opening fence on line 1, or no closing fence, has no frontmatter: its whole text is the body,
  the title is the id and the description is empty.
- `body` is the entry file's text after the fence, with leading blank lines removed. `dir` is the
  playbook's **absolute** directory, which the sent turn names (below).

**Order.** Sova, then Yours, then This project. Each group is sorted by title,
case-insensitively, with the id breaking ties, so the order never depends on `readdir`. The
client groups and sorts the same way again (`src/lib/playbooks.ts`).

**An unreadable user folder** doesn't fail the request. The catalog carries `error`, still lists
everything else, and the dialog shows a caption line above the groups (§design/copy-deck). A user folder that
doesn't exist is simply empty.

## §chat.playbooks/bundles — A playbook is a bundle

A playbook folder is a bundle, laid out like a skill: the entry file, and beside it whatever the
entry names. **Every relative path in a playbook resolves against its own folder**, never the
session's cwd, and the sent turn says so (§chat.playbooks/what-gets-sent). The entry needs no
placeholder for its own location: `scripts/check.mjs` means the one in the playbook's folder.

The layout is a convention, and every part of it is optional:

| Folder | Holds |
|---|---|
| `scripts/` | Programs the entry tells the agent to run |
| `references/` | Documents the entry tells the agent to read when it needs them |
| `tests/` | The scripts' own tests |

Older playbooks name `phases/` and `templates/`; those keep working, since any relative path does.

**A playbook you start keeps its own tests.** A playbook a user starts in a chat keeps the tests
of its own scripts in its own `tests/` folder:

- They need nothing from Sova: `node --test <playbook>/tests/*.test.mjs` runs them with nothing installed.
- They run on their own whenever the playbook is edited, and the merge queue runs them when a
  branch changes that playbook (§app.merge-queue/checks).
- They stay out of Sova's main test run.
- Sova's own system playbooks (the merge queue, release, release maker, project setup, project
  deploy and project verbs) and the tests of how Sova lists, shows or sends any playbook stay in
  Sova's tests.

**Sova never runs a playbook's scripts.** Listing, sending, a schedule's fire and a wake only
read the entry file. A script runs when the agent, following the entry, calls it with its own
tools, under the session's own sandbox and permissions.

A playbook's driver script, when it has one, follows these conventions:

- **One entry script with subcommands** (`scripts/<name>.mjs status`, `… check`), not a folder of
  loose scripts the entry has to sequence.
- **A compact digest on stdout**: what the agent needs to decide its next step, not a log. Detail
  goes to a file the digest names.
- **Exit 0** when all is well, **1** when it found something to act on, **2** when it couldn't
  check. A 2 fails closed: the agent treats it as "not known to be fine" and says so, never as 0.
- **State under `<state root>/playbooks/<id>/`** (`~/.pi/agent/sova/playbooks/<id>/` by
  default), never in the playbook's folder or the project tree.
- **Never print secrets**: no tokens, keys or credentials on stdout, stderr or in its state.

## §chat.playbooks/the-project-listing — The project listing

`project.state` says whether This project could be listed. `message` gives the real reason when
it couldn't:

| State | When | Dialog shows |
|---|---|---|
| `ok` | The cwd is a local folder and its project's playbooks folders were read (or don't exist) | Its playbooks under This project. With none, no heading |
| `none` | No cwd was sent | Nothing |
| `remote` | The cwd is on a remote target | A caption note below the groups |
| `missing` | The cwd is relative, doesn't exist, isn't a folder, or can't be read. It is also `missing` when one of the project's playbooks folders exists but can't be read | A caption note below the groups |

The note is the **server's `message`**, which names the target or the folder and the actual
fault. A client fallback is used only when the server sent no message (§design/copy-deck).

**Remote is decided lexically.** This is exactly how `/api/files` (`server/files.ts`) decides
it. A relative cwd is refused as `missing`, then a remote cwd is refused, all before any
filesystem call. Only a cwd that survives both is `stat`ed, and then its project is found
(§chat.profiles/projects). This order matters: a remote
placeholder must never be read as a local folder.

## §chat.playbooks/entry-point — Entry point

The Commands palette's This chat group has a **Playbooks** row, after Hide thinking
(§app.command-palette/rows); the composer's `plus` opens the palette. It closes the palette and
opens the dialog on step 1, or on step 2 of the playbook you left text in (below).

- **Only a chat open in Sova sends one** (`ChatView` passes `onPlaybooks`). In a watch view (a
  TUI-live session included) the row is there but `aria-disabled`, with the composer's own reason
  as its description, or "Only a chat open in Sova can send a playbook." where it gives none.
- **Disabled while the composer is blocked.** The row is `aria-disabled`, with the composer's own
  reason as its description (§app.command-palette/disabled). That covers connecting,
  reconnecting, not connected, an archived pane, saving a turn, and a model switch in flight
  (§chat.composer/disabled-states). It is the same treatment Attach images gets.

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
  its title. A playbook with a schedule has one more line under that, its schedule and state, and
  its step 2 a schedule card above the text box (§chat.schedules/where-shown). Activating a row goes
  to step 2, or to the card of one with a description (§chat.playbooks/ways-in).
- **Keyboard** follows the flyout's roving-tabindex pattern (§chat/composer "Keyboard"): exactly one row is in
  the Tab order, `↑`/`↓` move across all groups and wrap, and `Home`/`End` jump to the ends. The
  modal takes focus on open, and when the catalog arrives focus moves to the **first row**, as
  after `Retry` (its button goes with the banner). `Tab` goes from the row to `Close`.
- `Esc`, `Close` or a scrim click closes the modal. Focus returns to the composer's
  `plus` trigger.

### Step 2 · The playbook

- The modal title is the playbook's title. The body shows its description, without repeating
  the title, then the textarea labelled `Anything to add`. If the playbook has a `promptHint`, it appears as the textarea's
  `.field-hint`; otherwise there is no hint.
- Focus lands in the textarea. **`Enter` inserts a newline. `Ctrl+Enter` / `⌘+Enter` sends**,
  the same as `Send Playbook`. **An empty textarea can send**: the playbook alone is a complete
  turn.
- `Back` or `Esc` returns to step 1 with focus on the row you came from. It doesn't refetch the
  catalog. What you typed stays **with that playbook** (below). Picking a different one
  shows that playbook's own text, which is empty if you never wrote any.
- **`Send Playbook`** hands the text (below) to the chat's send. If the socket accepts it, the
  dialog closes and **focus goes to the composer's textarea** (`composer-input`, through
  `ChatView`'s `focusComposer()`), as after any send (§chat/composer "Focus"). A close without sending
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

`playbookTurnText()` in `shared/playbooks.ts` (re-exported by `src/lib/playbooks.ts` and pinned
by `src/lib/playbooks.test.ts`) builds exactly:

```
Playbook: <title> — <absolute dir>
Every relative path in this playbook is relative to that directory; read its files as the playbook directs.

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
dispatch as an extension command (§chat/slash-commands). It names the **absolute** directory, and
the second line makes it the base of every relative path, because the body refers to its
`scripts/`, `references/` (or `phases/`, `templates/`) by relative path (§chat.playbooks/bundles),
and the session's cwd is a different folder.

The transcript shows the result as your message (§chat/transcript), with no special styling.

**Mid-turn it is a follow-up, never a steer.** The dialog always sends a `prompt` frame
(`ChatView.send(text, false, [])`), even while a turn is streaming. The server's `acceptPrompt`
queues a streaming-time prompt as `kind: "followUp"`, which shows as a **queue row**, removable
until it is handed to the agent (§chat.transcript/a-queued-message). `handOffQueued` then hands it to `session.prompt(text, { streamingBehavior: "followUp" })` while
the turn is still streaming, or starts it as the next turn once that one has ended, so it
**runs after the current turn**. That is the opposite of the composer's own mid-turn Send, which
becomes `Steer` and sends `{type:"steer"}` into the running turn (§chat/composer "While streaming"). The
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

## §chat.playbooks/description-file — A playbook may describe its cast, choices and steps

Beside its entry file a playbook may carry `playbook.json`, a description of four things: your
choices, the cast (its teams, their goals and the members they must have), the steps, and how it
runs. A playbook
without one works exactly as before: picking it sends its recipe as your turn.

- **Read strictly.** Every key must be one Sova knows, with the right type. A file with an unknown
  key, a wrong type or a broken reference is refused with the exact path and fault ("roles.grader.models[1].effort: must be one of …"),
  and that playbook can't run: it opens no card and isn't sent as plain text either. Its row in
  the Playbooks dialog shows the exact fault, and picking it shows the fault in a warning with
  Send Playbook off until the file is fixed. One bad description never hides the other playbooks.
- **What it holds.**
  - `version`, and `listed` (§chat.playbooks/unlisted).
  - `run`: where it runs (this chat or a new one), whether it gets a new worktree, its mode and
    minor modes, the powers it asks for, and what it needs.
  - `inputs`: your choices. Each is a text, a number, a switch, a pick from options, several picks,
    a list or a set of models; asked every run, asked once and remembered as your standing answer,
    or optional (under More Options); required or not; and some asked again at each cycle. A
    text or list choice may say `"ask": "chat"`: it is worked out with the main chat in the
    conversation and filled in by it, with an optional default as its starting point; on any
    other type that is a fault.
  - `align`: optional, the questions (1 to 8, one line each) of an alignment the playbook
    requires before its card (§chat.playbooks/align-first); each may name the chat-worked choice
    its decision fills (one that names none only settles context for the chat, and its decision
    fills nothing), and a choice is filled by one question at most.
  - `facts`: things the chat may look up before the card is final (the latest pi release).
  - `teams`: every helper belongs to a team with a one-line `goal`; a lone helper is a team of
    one. A team lists only the members it must have (none is fine) and adds anyone else it needs;
    its coordinator and monitor run on your own team settings. Each required member has a
    one-line `brief` (why it is picked for the team), and may name a `notes` page in the folder
    with its working detail; its kind of work, its models in preferred order (each a model and
    an effort), whether it may use only those models, how many run (a fixed count or one per item
    of a choice), whether you may turn it off, what it is shown, and whether it starts fresh. A
    member has no prompt of its own: the team's coordinator writes its instructions. Goals and
    briefs may name a choice or a fact as `{{id}}`, filled in at Start.
  - The main chat isn't declared: it is the chat you chose, on its own model. A team or member
    named `main` is a fault, and so is the old `roles` key.
  - `steps`: in order; each may be a stop point, always or only when you turn it on, may say what
    it reports, and names the teams that work in it (none: the main chat alone); every team is
    named by some step. One group of steps may repeat as a cycle, with a cap, how many cycles run
    before it asks you, a stop rule in plain words, and what one cycle carries to the next. When
    to ask, when to repeat and how many times are settings on the card, not fixed in the prompt.
  - `machine`: instead of `steps`, a playbook may declare states and the named moves between them.
    It is read and checked (never both `steps` and `machine`); in this release the main chat
    follows it as it follows steps.
  - `commands`: the Sova commands the playbook's run uses, by their ids in Sova's list; an id
    Sova doesn't know is a fault. The card shows the ones that change things.
- **The entry file is the main chat's prompt;** without one the main chat gets Sova's standard
  instructions for conducting a run. Reference material lives in the folder (`references/`). A
  page the description names that isn't there, or a file that isn't JSON, is a fault shown as
  `<path>: <fault>`, and the playbook stays listed.
- **A model without an effort** runs at medium.

## §chat.playbooks/model-order — Which model each role gets

A role gets the first model that can run, in this order: your pick on the card, then the
playbook's list for that role in its order, then your profile's model for that kind of work, then
the chat's own model. A model Settings → Models turns off is skipped.

- **Nothing is swapped silently.** The card names each role's model with its provider ("GLM 5.3 ·
  ZAI") and effort, and whenever it isn't the first choice, the reason: "Opus 5.5 is turned off
  in Settings → Models, so Fable 5.2", or "None of this playbook's models can run, so your
  profile's model".
- **"Only these models".** A role marked so (a blind grader, a test model where the provider is the
  point) never falls to your profile's or the chat's model, and your pick on the card is one of
  its listed models. When none of its models can run, Start is off and the card says why.
- **The whole list goes with the run.** The plan keeps each role's whole ordered list, not just the
  first pick, so the main chat can move to the next one when a model is refused during a run, and
  say so.
- This release does not check sign-ins or usage before Start, and the card doesn't claim to: a
  role may run somewhere other than this computer (a sandbox, a test copy of Sova).
- **Efforts.** An effort the model doesn't offer moves to the nearest one it does.

## §chat.playbooks/unlisted — Recipes only Sova's chats run are not listed

A playbook of yours or a project's whose description says `listed: false` is left out of the
Playbooks dialog and the `/` rows. It is still found where Sova itself looks for it: a project's
merge queue, release, review and request folders still kept in its old place (§chat.playbooks/playbook-config)
say so, and their chats still read them, as the Setup chat still reads the project's setup notes
there. Since the dialog doesn't list it, it isn't offered for
scheduling there either. Sova's own playbooks need no such flag: their folder keeps them out,
whatever their own description says (§chat.playbooks/system-playbooks).

## §chat.playbooks/system-playbooks — Sova's own playbooks are in `system-playbooks/`

The six playbooks only Sova starts ship in `system-playbooks/` at the Sova repo root, beside
`playbooks/`, which keeps only the ones you start (A/B cycle, Brandmaker, Marketing, Spec review):

| Playbook | Folder | Started by |
|---|---|---|
| Merge thread's method | `system-playbooks/merge-queue/` | Sova, when a branch is queued (§chat.merge-queue/thread) |
| Release method | `system-playbooks/release/` | Sova, when a release starts (§app.release/playbook) |
| Project setup | `system-playbooks/project-setup/` | Sova, from Set Up with a Chat or Change Setup (§app.project-setup/context) |
| Release playbook maker | `system-playbooks/release-maker/` | Sova, inside the Setup chat (§app.release/maker) |
| Project deploy | `system-playbooks/project-deploy/` | Sova, inside the Setup chat (§app.project-runtime/deploy-playbook) |
| Project verbs | `system-playbooks/project-verbs/` | Sova, from the project's Running Copies tab (§app.project-runtime/onboard) |

- **Never listed.** Nothing in `system-playbooks/` is in the Playbooks dialog or the `/` rows, nor
  offered for scheduling, whatever its own description says: the folder decides, never a flag.
  Project verbs, listed in the dialog until the move, is no longer there.
- **Started only from what Sova ships.** Sova finds each by its id in its own `system-playbooks/` and
  nowhere else. A playbook of yours or a project's with the same id is just another playbook, listed
  under Yours or This project like any other, and replaces nothing Sova runs. A project adjusts
  Sova's own chats through its config folders (§chat.playbooks/playbook-config).
- **Side by side.** The six read each other's pages and scripts as neighbouring folders
  (`../project-verbs/…`) and Sova's shared code at the same depth as before, so they move together.
- **Chats started before the move keep their instructions and tools.** Wherever Sova reads the
  playbook folder a chat's first message names (whether it may use the project verbs, which
  playbook a run follows, the merge thread's method), an old folder `<Sova repo>/playbooks/<id>/` of
  one of the six is read as `<Sova repo>/system-playbooks/<id>/`. A Setup chat started before the
  move gets a fresh Setup chat on its next Change Setup (§app.project-setup/chat), and the merge
  thread is told the new folder, scripts included, on its next event (§chat.merge-queue/thread).
  The old folders are read this way until a later version (§app.server-runtime/migrations).
- **Their tests stay in Sova's test run**, in Sova's own test folders, pointed at the new folder.

## §chat.playbooks/playbook-config — A project's config for Sova's own chats is in `.sova/playbook-config/`

What a project adds to Sova's own chats lives in its `.sova/playbook-config/`, one folder each,
never among the playbooks you start:

| Folder | Read by |
|---|---|
| `.sova/playbook-config/merge-queue/` | the merge thread, after Sova's method (§chat.merge-queue/thread) |
| `.sova/playbook-config/release/` | the release chat: the usual `release.playbook` (§app.release/settings) |
| `.sova/playbook-config/review/` | the merge queue's review step: the usual review kit (§app.merge-queue/review) |
| `.sova/playbook-config/request/` | requests: the usual request kit (§app.merge-queue/request-kit) |
| `.sova/playbook-config/project-setup/` | the Setup chat: the project's own setup notes (§app.project-setup/context) |

Nothing in `.sova/playbook-config/` is listed in the Playbooks dialog or the `/` rows, so a
project's `.sova/playbooks/` holds only playbooks you start. A new setup writes these folders here,
and the definition's defaults name them: turning review on in Settings → Merge Queue adds
`.sova/playbook-config/review`, and the Setup chat's release half writes the release playbook to
`.sova/playbook-config/release` (§app.release/maker). The Setup chat's references and Sova's
contributor guide teach this place. Sova's own repository keeps its folders here, and its
`.sova/project.json` names them.

**The old place is still read, until a later version.** A project set up before the move keeps
working untouched: where `.sova/playbook-config/<x>/` is absent, Sova reads `.sova/playbooks/<x>/`
for `merge-queue`, `release`, `review`, `request` and `project-setup`, both for what Sova's chats read
there (the merge thread's additions, the Setup chat's setup notes) and for a default the definition
doesn't name (turning review on with only the old folder on the target adds
`.sova/playbooks/review`). A definition that names a folder, old or new, is read as named. This
lasts from 0.16.0 until a later version (0.18.0 proposed), tracked as `playbook-config-old-place`
in Sova's migrations (§app.server-runtime/migrations); by then a project moves its folders, and the
definition's paths, on a setup branch.

## §chat.playbooks/run-card — The playbook card

A playbook with a description has a card, and a chat has at most one. Before Start it is a
setup card inline in the conversation, standing in the transcript the way an alignment card does
(§chat.alignment/card): at the point it was opened, or last filled in by the chat, moving to the
newest point when you reopen it or the chat sets a value on it; it scrolls with the conversation, no strip
floats for it, and Start is pressed there. A new chat showing a card stays in the session list
until the card is closed, so a reload finds it again. After Start the setup card stays where it
is, never moving again, as the read-only record of what was agreed, and the run moves to a strip above the message box
(§chat.playbooks/run-strip).

- **Only when you ask.** A setup card appears only by a `/{name}`, a pick in the Playbooks
  dialog, or reopening it; never by itself. Opening it, or a chat holding only it, takes the view
  to it (a tall card from its top, else whole in view) with focus on it, however late the card is
  drawn, clear of a run's strip and held there for up to 10 seconds while the chat's opening
  lines load, but never once you have scrolled, touched, pressed or typed in the chat since it
  opened (the same for a run's record); in a new chat with no message yet it stands under the chat's opening
  lines. A read-only watch draws no setup card.
- **Its buttons stay in reach.** While the card is in view, its Start row stays pinned to the
  bottom of the conversation, with a shadow only while pinned, as a Lookbook card's bar does
  (§chat.design-mode/card); the connecting note and Focus sit above it.
- **Jump to Latest never covers a playbook's card** in the conversation, a setup card or a run's
  record, folded or open: it isn't shown while it would lie over one, and shows as usual
  otherwise.

- **Before Start it shows:**
  - **Your choices,** each with where its value came from: Default, Same as last time, Your
    standing answer, From your message, From the chat, or From your alignment; an empty required
    choice says Needed. A choice the
    playbook marks as worked out with the chat (the failure to fix, say) is read-only on the
    card, its default shown as a starting point: you settle it with the main chat as you talk,
    and the chat fills it in through the card's commands. Empty, it says it is waiting for the
    chat; filled, it shows the chat's words. While a card is a draft the chat has a note in its own
    context (never shown in the thread): which of these choices are still empty, what it may set
    on the card (§chat.playbooks/card-setters) and the commands that set it.
    Short choices (a pick, a number, a switch, models) stay editable on the card. A
    text choice that may run to several lines gets a two-line box. A
    choice's help sits on its own line under the value. On a started run's record, a text or list
    answer longer than two lines shows its first two with Show All, and Show Less folds it again;
    only the display folds, never what the run got.
  - **Who runs,** folded by default to "Who runs · {n} teams · {m} required members" (or "the
    main chat alone"); it starts open when, as the card is drawn, a member that is on has no model
    that can run (the folded line adds "· {k} can't run"): one block
    per team, headed by its goal, listing only its required members, each with how many, its model
    with provider and effort, the reason when it isn't the first choice, and its one-line brief;
    a line says the team adds anyone else it needs. The main chat and each team's coordinator and
    monitor aren't shown (they run on the chat's and your own settings); the coordinator and
    monitor still count toward the limit of 24 helpers, two for every team, one with no required
    members included.
  - **The steps,** each with the team that works on it, their stop points and the cycle's settings, and **how it runs** (this
    chat or a new one, a new worktree, the powers it asks for, the commands it lists).
  - **Flow,** folded by default: a drawing of the playbook's flow (§chat.playbooks/flow).
- **What you can change:** each choice, each required member's model and effort, optional
  members on or off, optional stops on or off, the cycle's settings, and for this run an
  optional one-line note under each required member's brief and one for each team as a whole. A member's brief is changed only in the playbook itself. Each change is saved as you
  make it; a change made while the card changed in another tab is added on top of that one, and
  the card says so.
- **Buttons:** Start, Save as My Defaults (your current choices, picks and member notes become the
  next card's starting values for this playbook in this project; a team's note is for this run
  only), Repeat…, shown but not yet available, and
  Close Card.
- **Start is off, with the reason,** while a required choice is empty (one the chat fills
  included), an "only these" role has
  no model that can run, the plan needs more helpers than a chat can run at once, or something the
  playbook says it needs is missing. Save as My Defaults is off, with the reason, while the playbook
  can't be read or is gone. A fault already shown in the card's error line (a description that
  can't be read, a refused Start) isn't repeated beside Start.
- **Who else may set it:** the chat, commands and other computers (§chat.playbooks/card-setters).
- **After Start** it is the run's record (§chat.playbooks/run-record).

## §chat.playbooks/card-setters — Who may set a card besides you

- **The chat can set the whole card,** so what you said when you asked for the run lands on it
  and you needn't set it again by hand: through the card's commands the chat that shows the card
  (or conducts its run) may set every value you can (each choice; each member's model and effort, within what the
  page allows, an "only these" member only from its own list; optional members on or off; team
  and member notes; optional stops; the cycle's settings), checked by the same rules as the
  page. Each value it sets reads From the chat until you change it, and the card moves to the
  newest point. That is the chat itself, its commands included; any other caller (a script, or a
  chat the run isn't tied to) may set only the choices. Start, Save as My Defaults and Close Card
  stay your own clicks, so you always see the final card.
- **In Sova's commands** (§app.commands/catalogue): `playbook.run.open`, `.list`, `.get` and
  `.edit` open a card, list a chat's cards, read one and set its values. Closing a card, like
  Start and Save as My Defaults, is your own click on the card in Sova's page: no command, and a
  chat or a script is refused.
- **From another of your computers** a card can be opened, read and set with full access;
  its Start and Save as My Defaults work only on the page of the computer the chat runs on, and a
  click relayed from another computer is refused.

## §chat.playbooks/flow — The playbook's flow, drawn

The card's Flow section, folded by default, draws the playbook's flow from its description each
time, so it can't drift from what runs; nothing about the drawing is stored in `playbook.json`.

- **From steps:** the steps in order with the teams in each (the main chat where there is none),
  the cycle as a framed loop with its cap, when it asks you and its stop rule, and each stop point
  marked as always or optional. It follows the card: an optional stop shows as you set it, and
  the cycle with your settings.
- **From a state machine:** when the playbook declares one, its states and the moves between
  them.
- **After Start** the drawing is frozen with the run's record. Showing where a run is (steps
  done in the success colour, the current one in the accent) needs a record of its steps, which
  this release doesn't keep: a started run's drawing says the run has started and that its
  current step isn't tracked.

## §chat.playbooks/align-first — Aligning before a playbook runs

An alignment (§chat/alignment) may come before the setup card, so the run is the one you meant.
It reuses Sova's alignments as they are, by either of two paths.

- **The chat may align first.** When the chat's align minor mode is on and your request to run a
  playbook leaves room for doubt (`/{name}` with words that could mean more than one thing), the
  main chat may open an ordinary alignment first; once you confirm it, the chat puts your decisions
  on the card through its commands: the choices it works out and anything else they settle
  (§chat.playbooks/run-card). Nothing forces it: a
  clear request, or align off, goes straight to the card.
- **A playbook may require it.** A playbook whose description declares an alignment
  (§chat.playbooks/description-file) always opens it first on `/{name}`, whatever the align mode
  (Sova turns align on for the chat if it is off, and it stays on afterwards): Sova sends the main chat a note of its own
  (drawn as a "Playbook alignment" row, never your message and never the chat's name) asking it
  to open an alignment with the playbook's questions and your words, and the
  setup card isn't drawn yet (Start would read that it waits for the alignment). Once you have
  decided every question, each decision fills the choice it is for, marked From your alignment (a
  list choice takes one item per line or per "; "), and the setup card appears at the chat's
  newest point; whatever else the decisions settle, the chat sets on the card. If you drop the alignment, the card appears with those choices empty, for you
  and the chat to work out, and Start says why. A chat Sova can't write to (open in a terminal,
  archived) gets the card at once, with those choices left to the chat.
- **Without either,** a playbook opens straight to its card, exactly as before.

## §chat.playbooks/run-strip — The started run's strip

Once a run has started, it shows as a compact strip floating over the end of the conversation,
just above the message box, at the message box's width: the playbook's name and its state (a dot
and a word), and under them one line (how the conducting chat stands, else its revision, start
time and chat). The strip has its own surface, border and shadow, with no band or full-width
background behind it, and doesn't scroll with the conversation, so it is in reach wherever the
conversation is scrolled. A card not yet started has no strip (§chat.playbooks/run-card).

- **Room for it.** The conversation's end leaves room for the strip, so at the end the last
  message (an alignment card there included) is never under a closed strip; scrolled up, the
  conversation passes behind it; the gap between the strip and the message box is the page's own
  colour, so nothing shows through under the strip. Jump to Latest, the connecting note and Focus
  sit above it.
- **Answering from the strip.** When the run waits for you, exactly when the open card offers
  Continue and Stop Here, the closed strip offers them too, under the same rule. Where the
  message box is narrower than 520px the strip only opens the card. Focus view hides the strip
  with the message box.
- **Opening it.** Pressing the strip opens the full card upward from the strip's place, at the
  same width, in place of the strip until it is minimized; it never moves or resizes the
  conversation. Its head (name, state, Minimize) and its buttons stay in place while its middle
  scrolls. Minimize or Esc minimizes it again. At phone width it is the same floating card.
- **Only when you ask.** The full card opens only by your click on the strip or Open Card on the
  run's entry in the conversation; never by itself. With two panes on the same run, Open Card
  opens it in the pane you clicked in. A read-only watch of the chat shows the entry without
  Open Card.

## §chat.playbooks/run-record — The card after Start

- **After Start** the setup card stays inline in the conversation as the run's read-only record:
  the frozen choices and each member's model, with no buttons of the run (those are on the strip's
  card). It folds to its head at Start, and is folded when the chat is opened again; Show Card
  opens it in place (Hide Card folds it). At Start a view that had left the conversation's end
  follows it again. In the chat that conducts the run it has no state and says only that it is
  the card as you set it up (the conversation's start row says it started); in a chat that only
  started the run elsewhere it reads Started, with when and where. Its state chip sits beside a long
  name on a wide card and under it on a narrow one, never under Show Card.
  In the chat that conducts the run, the strip says how that chat stands, in the words the
  session list uses: Running, with how many helpers are working; Needs you, with the reason;
  or Idle; in this release it never says Done (a turn's end isn't the run's end). In a chat that
  only started it, it says Started and offers Open the Chat. When
  the conducting chat is waiting on you or idle, the card offers Continue and Stop Here, which send
  that word as your message to the conducting chat, by your click; whatever stops Send stops them
  too, with the same reason. Which step the run is on, its scores and its changes from the plan
  aren't shown in this release: progress comes in the chat's messages.
- **This release's limits.** Sova can't yet tell a playbook's stop from a turn that simply ended,
  or a stop from the run's end. A run waiting at one of its stops reads Needs you only when
  Decisions is on (the session list's own reading); without it only a failed turn reads Needs
  you, and a run at a stop reads Idle. A run you parked or that finished still says the run goes
  on when you answer and offers Continue and Stop Here.
- **Putting a card away.** Close Card on a started run takes its strip away from above the message
  box; it doesn't stop or change the run, and Open Card on its entry in the conversation still
  shows the run's record, marked closed, with no Continue or Stop Here. It isn't offered while the run is still starting. Closing
  a card that was never started discards it. Marks in the conversation for a run that stopped for
  you or finished aren't in this release.
- **Runs from before teams.** A run started before teams had goals still opens as its record.
  Its Who runs folds to "Who runs · {n} groups · {m} roles · started before teams", says so when
  opened, then shows the helpers it ran with, grouped as that run grouped them
  (each group's steps above it), the roles that ran as members (models and notes, no
  brief lines), any others under Other helpers. Those plans listed every helper, so no block says
  the team adds anyone else. It has no Flow drawing.

## §chat.playbooks/start — Start runs exactly the card you saw

Start works only by your own click on the card (§app.access/your-click), never from a chat, a
tool or a script, and it runs exactly the version of the card you were looking at; a card that
changed since it was drawn is refused and drawn again.

- **A run is its own thing.** Each card is a run with an id of its own, not tied to a chat, so a
  card can exist before any chat does. Start freezes it into the run's plan. A playbook that asks
  for powers of its own runs in a new chat set up for it; otherwise it runs in this chat. When the run goes to
  another chat, the first chat's card says it started the run there and can't be started again,
  including after a reload.
- **Pressed on the setup card** in the conversation. Once the run starts the setup card freezes
  in place as its record and the run's strip appears above the message box
  (§chat.playbooks/run-strip). A choice the chat fills must be filled first.
- **Pressed once.** From the press until the server answers, the card says Starting, and the
  strip appears once the run is starting; a refused Start returns them to Ready to start or Can't start yet. A second Start
  while the first is under way starts nothing more.
  A Start in a chat that holds a run, whether it conducts one (even with its card put away)
  or still shows the card that started one in a new chat (until you close it), is refused with nothing changed: one playbook per chat
  (§chat.playbooks/ways-in).
- **A failed Start leaves the chat as it was,** and the card can be started again. A chat that
  can't take the message (a terminal has it open, it's archived, it's an Overseer's or a baton's
  chat) is refused before anything changes. Start never changes the chat's model or effort.
  When the send itself is refused (the model has no sign-in), the mode the playbook switched to
  is put back; a chat that followed the default mode then keeps that mode pinned.
- **What Start writes.** In the run's folder, in the conducting chat's shared folder: the plan,
  with each team's goal and your note for the team, and each required member's brief, notes page,
  your note for it, its whole model list and its "only these" mark; your choices fill the goals'
  and briefs' `{{id}}`s. No role prompt is filled in: each team's coordinator writes the
  instructions.
- **What the main chat gets.** One message carrying the playbook and the run: your choices, each
  team's goal and note with its required members (brief, notes page, your note, model list,
  "only these" mark), which teams work in which step, the steps and their stops, and the playbook contents page (§chat.playbooks/contents-page). The
  main chat conducts the run from it, on its own model: it creates each team when the team's first
  step begins and writes each member's instructions from the goal, brief and notes page. In the conducting
  chat's thread that message is one row marking the start, "Playbook {title} started · revision
  {n} · {time}", whose Show What Was Sent opens the exact text, both while it streams and once
  settled, and whose Open Card opens the run's card.
- **The chat's name.** A chat a run starts in that has no message and no name yet is named
  "{title} (playbook)"; a chat that already has a message keeps its name.

## §chat.playbooks/ways-in — Ways to open a playbook's card

- **Type `/` and its name** in the message box: each listed playbook with a description is a row
  in the `/` menu, and picking it opens its setup card in the conversation at that point, or
  first an alignment: always for a playbook that requires one, and at the chat's judgement for
  an ambiguous request with align on (§chat.playbooks/align-first). Words
  typed after the name go with the card. A
  command of the chat's own with the same name wins once the chat has had its first message;
  before that its own skills and prompts aren't known yet, so `/{name}` opens the playbook's card.
- **Pick it in the Playbooks dialog:** a playbook with a description opens its setup card in
  the conversation instead of the text step.
- **One playbook per chat.** Opening another playbook in a chat whose card isn't started
  replaces that card, with no warning: its choices and edits are gone (your saved defaults
  and last answers stay); opening the same playbook again shows its card as it was. A chat that holds
  a run (it conducts it, even with its card put away, or its card started the run in a new chat
  and is still shown there; Close Card on that card frees the chat) opens no other card, and a Start of another card there is refused
  with nothing changed. There, the `/` rows and the Playbooks dialog say the chat already runs a
  playbook, and picking one opens its card in a new chat in the same folder, with the words typed
  after the name, and takes you there; this chat isn't changed.
- A playbook whose description can't be read has its `/` row too; picking it says what is wrong
  (§chat.playbooks/description-file).
- **Ordinary chats only.** In a baton chat, the Overseer or a project's Overseer no card docks,
  the `/` menu has no playbook rows, and a typed `/{name}` goes as typed. In the Playbooks dialog
  there, a playbook with a description has Send Playbook off ("This chat runs no playbooks.", the
  words Start refuses with); a recipe without one sends as before.

## §chat.playbooks/contents-page — The playbook contents page

Making and running playbooks share one short contents page, a table of contents with a section
opened only when needed: what a playbook is, the cast and models, choices, steps and flows, the
card, repeats, Sova's commands, and how to save one. Create mode carries it as its `playbooks`
topic; a running playbook's main chat gets the same page, so it knows how its own playbook is
built.

- **Sova's commands.** One entry says what Sova itself can do from a script (list chats, read a
  chat, start or stop one, run a project's services and tests, read the merge queue), and how to
  find one and run it with `sova list` and `sova describe`, rather than copying the list.
  Actions only your own click may do (Land, Start on a card, approvals, restarting Sova) stay
  refused to a playbook, as to every chat.

## §chat.playbooks/ab-cycle — The A/B cycle playbook

Sova ships an A/B cycle playbook: measure a change to something a chat reads (a tool's
description, a mode's text, the agent's instructions) against a baseline, improve it in cycles,
and show the result.

- **One way to record every round.** Its folder carries one runner, one scorer and one chart
  script shared by every campaign, brief templates, a cost table against known prices, a noise and
  copy-effect check, and the ways an arm is made (a worktree with its own test copy of Sova, a
  prompt variant file, or a re-score of saved replies). Run output stays in the worktree's
  ignored cache and experiment commits never land; the subject's record (below) is the one thing
  a campaign keeps.
- **Rounds.** Master is the fixed baseline, "Round 0", in every chart; each cycle's winner is the
  next cycle's base. Every cycle shows its chart. Master's arm is always its own copy (master
  plus one commit that only removes the record, so it behaves exactly as master), never the
  campaign's own worktree.
- **Predicted beside observed.** Each round's report shows, per arm, what its fix was expected to
  fix and to risk beside what it did: expected fixes, unexpected fixes, expected breaks and
  unexpected breaks. An arm with no prediction says so. A missed prediction is shown and recorded
  only: the winner is still picked by pass rate, then cost.
- **The consultant's outlook.** After the baseline and after each round is scored, the round's
  report is shown at once and a fresh consultant starts by itself. It reads the results and the
  failing replies and, while you decide, sends a short plain follow-up as its own message: whether
  the subject can still improve (likely, unlikely or futile), why the last change won or lost,
  what the next round should do, the expected gain against the bar, and a recommendation (another
  cycle, keep the baseline, or run the confirm), with one more line when a better fix needs
  something the cycle didn't allow. It names no case numbers, file names or code. On your
  go-ahead the same consultant writes the next round's one change, from its outlook. An answer you
  give before the outlook arrives is held: the outlook is posted, then you're asked to confirm or
  change your answer.
- **What an outlook can stop.** A futile outlook writes no change and pauses to ask you: keep the
  baseline, run a round anyway, or allow more to change; with rivals, it pauses only when all of
  them say futile. An outlook never ends a campaign by itself. Each outlook's expected gain is one
  exact figure, shown beside what happened in the next round's report. At the last stop the report
  comes first, then the outlook, then the landing reviewer's verdict, which reads it; the record is
  closed after that.
- **A record that outlives the campaign.** Each subject (such as "vis") has a record kept in the
  project's repository, at `.sova/ab/<name>.jsonl`, and landed with Land: a winner's landing
  carries it, and a campaign closed as "baseline kept" or parked lands it alone. A campaign
  closes by landing a winner, running another cycle, keeping the baseline (shown as "baseline
  kept", never as parked) or parking. The record holds every attempt, losing ones included: the
  problem in general words, the change and why, the test models with their pass rates before and
  after, expected and observed counts, whether it was carried or dropped, and its campaign and
  round; it also keeps each round's outlook.
- **No private text in the record.** It holds no real-chat text, case wording or case numbers,
  and no machine details such as home folders or addresses; a check refuses such a line before
  it is written. The check also refuses the campaign's own case names, whatever their style.
- **Who reads the record.** A new campaign's first report says which record it continues and
  what it holds. Consultants read it before proposing a change, and the landing reviewer reads
  it and the campaign's outlooks before its verdict, which may be Baseline kept; the grader reads
  neither. When a new test model fails, the recorded fixes are
  re-tested before new ones are proposed.
- **Test chats never see the record.** Each arm's copy removes it in a commit of its own that
  never lands, so it is gone from the copy's files and its current commit; a round refuses to
  start while any arm's copy still holds it, there or in its current commit.
- **Its own tests.** The tests of its scripts sit in its own `tests/` folder
  (§chat.playbooks/bundles), not in Sova's: `node --test playbooks/ab-cycle/tests/*.test.mjs` runs them
  with nothing from Sova, and its entry file says so and that an edit to the playbook runs them.
  Each test file works in a throwaway folder of its own, with a throwaway home and agent dir,
  and refuses to run when that folder sits inside a Git repository.
- **A screenshot collage.** Its report shows screenshots as one collage: each arm's result side
  by side per cycle, and the card at key moments. Its collage script builds that image.
- **It requires an alignment first** (§chat.playbooks/align-first) on what fails today, what
  counts as fixed, how it's measured, and which record the campaign continues (it lists the
  project's existing records); their decisions fill those choices, which the card shows
  read-only. Its run still stops to agree what is measured before the baseline.
- **Choices** include what is under test, the record's name, the test models, how many cycles
  run before it asks you and the cap. Its runs never swap a test model for another, and its grader uses only the models listed for it.

## §chat.playbooks/pi-upgrade — The pi upgrade playbook

Sova's own project carries a pi upgrade playbook for moving Sova to a newer pi release.

- **Research first, changing nothing.** A team goes through every changelog entry between the
  pinned and the chosen release and through Sova's code, comparing what Sova uses today with
  what the release changes.
- **A readable report** with separate sections for wins, tradeoffs and risks, one row per
  changelog entry in each: what Sova uses today, what it gains, what it costs, and how that was
  checked. The rest is summarised per release, and every entry's row is in the run's changelog
  file, which the report names. Then a plan ready to carry out.
- **It always stops and asks** whether to go ahead, on every run, before it changes anything.
  Only on your yes does it upgrade, refactoring where it sees fit so pi stays at the edge, then
  check that the upgrade went smoothly with no regressions.
- Its judge (planning) and its implementer (main implementation) list Fable 5.2 at high effort
  first; the main chat runs on the model you chose for the chat.

## §chat.playbooks/later — Decided, not built yet

Decided with the design and not in this release:

- **Repeats from the card.** Repeat… asks when and where; your click approves the whole card as it
  will run unattended, and a change to the playbook pauses it as "Changed since you approved it".
  Any playbook, Sova's, yours or a project's, can repeat, with more kinds of schedule.
- **The run's flow.** Steps, cycles and a declared state machine run as a flow Sova keeps: it
  shows where the run is, offers the stop buttons, and refuses a move the playbook doesn't allow;
  asking you, repeating and the number of rounds are settings of that flow.
- **The commands gate.** Commands that only look are free; a command that changes things and
  isn't listed in the playbook is refused for its run.
- **Improvements after a run.** The run proposes changes to its playbook on a card; nothing
  changes without your click.

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
- **Overrides are whole, and only Yours can make one.** A user playbook with the id of one in
  `playbooks/` replaces it outright; one with the id of Sova's own playbooks replaces nothing
  (§chat.playbooks/system-playbooks). A project playbook replaces nothing.
- **The header line is not optional.** Without it, a body beginning with `/` would run as a
  command.
- **Typed text is never silently dropped, and never crosses playbooks.** It is kept per
  playbook when the dialog closes, and moved to the draft when the chat view goes away.

## §chat.playbooks/brandmaker-install-needs-no-registration — Brandmaker installs a brand skill where pi finds it

Brandmaker's optional install phase copies the finished brand skill to
`<project>/.agents/skills/<brand>-design-skill/`. pi discovers that folder by itself, so the phase
has no registration step: it adds nothing to the project's `.pi/settings.json` to make the skill
reachable.

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

**All user-facing strings are in §design/copy-deck.**

---
