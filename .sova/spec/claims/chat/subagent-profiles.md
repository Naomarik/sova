# §chat/subagent-profiles — A profile's Models part: the helper library
> Part of the Sova design spec · [overview](../design/overview.md)

Most of the work in a session runs in helpers: Delegate's workers, team members, the spec writer
and the reviewer. A profile's **Models part** (§chat/profiles) names the chat's own model and every
model those helpers are given, so a usage limit on one provider is answered by switching the whole
setup at once (§chat.profiles/switch) instead of editing four screens. The chat's own model and
effort are saved with the profile's session half (§chat.profiles/model); everything else in the
Models part is saved in the **helper library**, one library profile per profile, linked by id
(§chat.profiles/joined). A library profile holds:

- **Delegate routing**: a worker (backend · model · effort, plus an optional fallback) for each of
  Delegate's four **work kinds** — Planning & specs, Investigation, Routine implementation and
  Complex implementation — the shape `mode-delegate.json` has (§app.settings-dialog/modes).
- **Teams**: the models of the coordinator and monitor every new team gets, with their thresholds
  and handover timeout (the shape of `team-defaults.json`, §teams.defaults/file), or none, when both
  run on the chat's own model. There is no model for members alone: a team member runs on its work
  kind's route (§teams.defaults/member-kinds), so nothing reads or shows the retired `members` field, and Sova leaves a value saved there alone.
- **Spec writer**: the worker that writes spec drafts while spec is on (the shape of
  `mode-spec.json`), or none, when the session writes the spec itself.
- **Reviewer** and **alignment settings**, each optional (§chat.subagent-profiles/file).

Profiles are unlimited and named by the user. They are edited in Settings → Profiles, the Models
part of each profile's editor (§app.settings-dialog/profile-editor); this Sova has no Subagents tab
(§chat.subagent-profiles/settings). With the mesh on, the library is shared by every device profile
by profile, and when another device's copy changes it, Settings → Profiles says so for a day and can
put the previous library back (§chat.subagent-profiles/replaced).

## §chat.subagent-profiles/file — The file

- **Where.** Two files, both owned by one module,
  `pi-config/extensions/subagents/subagent-profiles.ts` (node built-ins and the builtins-only
  `mode/delegate.ts`, `mode/spec.ts` and `subagents/team-defaults.ts` only): the **library**
  `<agent dir>/subagent-profiles.json` — the shape, the strict parse, the reader, the seeding and
  an atomic writer — and the **device default** `<agent dir>/subagent-profiles-default.json`,
  which profile new chats on this device start from, written when this computer's default profile
  is chosen (§chat.profiles/default). The mode extension, the subagents extension
  and Sova's server all read both through that module.
- **Shape (version 1).** The library is `{version: 1, profiles: [{id, name, delegate, teams,
  members, specWriter}]}`. `delegate` is the four work kinds' `{primary, fallback}`; `teams` is
  `{coordinator, monitor, handover}` as in `team-defaults.json`, or `null` (no models chosen: both
  standing members run on the chat's own model, §teams.defaults/file);
  `members` is retired: it is read and written back unchanged, except that an old model alias is
  written back as its current name for the same model; absent reads as none, and a new
  profile writes `members: null`, so an older reader that requires the key still parses the file.
  Nothing reads or shows it, and beyond that alias no step converts or clears it. `specWriter` is `{primary, fallback}` or `null`. A profile
  may also carry an optional `reviewer` (`{primary, fallback}` or `null`), the adversarial
  reviewer's route (§chat.alignment-review/route): a profile without the key parses as before, and
  a parse never adds it. Likewise an optional `alignment` `{eagerness?, style?, visuals?}`: the align
  mode's Eagerness (`eager` or `careful`, §chat.alignment/eagerness), writing style (`pm`,
  `simplified` or `default`, the last read as Technical) and Visuals for chats on this profile, each
  field present only when the profile overrides the host's `mode-align.json`
  (§chat.alignment/settings-file); an empty object, an unknown key or a bad value is malformed, and a
  profile without it reads exactly as before. The default
  file is `{version: 1, default}`: a profile's id or `"off"` (§chat.subagent-profiles/off).
- **Strict.** An id is lowercase letters, digits and dashes, at most 48 characters, unique, and
  never `off`; a name is one line of at most 48 characters, unique ignoring case, and never "Off";
  an unknown key or an invalid worker is **malformed**, and the reader returns every error. A
  malformed file is never overwritten by a reader; a malformed library sends every reader to the
  legacy files (§chat.subagent-profiles/resolution), and a missing or malformed default file (or a
  default that names no profile in the library) reads as `"off"`, saying so where a default is
  shown.
- **Seeding.** The first read that finds no library writes one: a single profile, id `my-setup`, named
  "My setup", built from what the legacy files say now (`mode-delegate.json`, `team-defaults.json`,
  `mode-spec.json`; a legacy file that is absent or unreadable contributes what its own reader
  makes of that), `members: null` — and writes the default file naming it. A malformed
  `team-defaults.json`
  postpones seeding until it is fixed, preserving its warning through legacy resolution. A library
  found without a default file (one was removed) is not re-seeded: the default reads as `"off"`
  until the user saves one. The seeded setup preserves the legacy routing until the user changes it. The write never replaces a file another process made first.
  The seeded library is dated as old: its file's modification time is set to the Unix epoch, so
  with the mesh on, a library edited on any other device wins over it, while a device alone keeps
  it (§mesh.sync/profile-library).
- **The legacy files stay.** Nothing deletes or rewrites `mode-delegate.json`,
  `team-defaults.json` or `mode-spec.json`; they are only the last fallback.
- **Mesh.** With the mesh on, the library syncs profile by profile (§mesh.sync/profile-library):
  a device adds or changes only the profiles it has and never erases one it lacks, a deleted
  profile stays deleted, and two edits to one profile resolve newest-wins for that profile only.
  Every merged library is checked with the module's own parser before it is written, and its
  shape stays exactly the file above: the merge's per-profile dates and deletions live in Sova's
  sync state, never in the file. The default file
  never syncs: which profile new chats start from is each device's own, exactly as which profile
  each chat uses stays with that chat (§chat.subagent-profiles/resolution).

## §chat.subagent-profiles/off — Off

**Off** is built in: always first in every list, never stored as a profile, and it can't be
edited, renamed or deleted. It sets nothing in either part and configures nothing for the helpers: a chat on it keeps its own model and
modes, and the agent picks every worker. It replaces the new chat screen's separate **My settings**
card (§chat.profiles/picker): picking Off there is the session with no profile, and its helpers are
pinned to Off. Off can be this computer's default (§chat.profiles/default). For the helpers:

- In Delegate the prompt still asks the agent to delegate, and still names the four work kinds,
  but carries no worker line for them: the agent chooses each worker's backend, model and effort.
- Teams still get Sova's coordinator and monitor, on the chat's own model with Sova's built-in
  values (§teams.defaults/file). A member's kind is optional; it runs on the model named for it or
  its team, else the chat's own, and its result line says no profile routes it
  (§teams.defaults/member-kinds).
- No spec writer: the session writes the spec itself.

Its footprint reads "Keeps the chat's own model". In Settings → Profiles it is the one profile under
**Built in**; its editor holds only its name, Make Default (or the Default chip) and "Built in. A
chat keeps its own model and modes, and the agent picks every worker."

## §chat.subagent-profiles/resolution — Which profile a chat uses

- **Per chat.** A chat's pick is its own, stored in the session as a hidden custom entry,
  `subagent-profile` `{v: 1, profile}` (a profile id or `"off"`); the newest on the branch wins.
  It is a sibling of the `mode` entry, never part of it. Sova writes it (the mode menu, the
  Overseer, the limit row, a profile switch, §chat.profiles/switch, and a pick on the empty screen
  that sets `subagents` or switches back from one, §chat.profiles/applying), and so does `/mode
  subagents <id|off>` in a terminal. No other chat
  moves.
- **The default.** A chat with no pick follows this device's default file, read again each time, so a
  new default reaches it too. That file holds the helpers of this computer's default profile, and it
  moves only when the user chooses a default (§chat.profiles/default): Make Default in Settings →
  Profiles, or Make {name} the Default in the mode menu.
- **Order.** Wherever these settings are read: the chat's pick; then this device's default; then the
  legacy files. A pick naming a profile that no longer exists falls through to the default; one
  step at a time, never a leap: a missing, malformed or dangling default (it names no profile in
  the library) reads as Off. Malformed or dangling defaults carry a reason where the current
  profile is shown; an absent default simply shows Off. A malformed or unreadable library falls
  through to the legacy files.
- **Where it is read.** The mode extension resolves it for Delegate's routing and the spec writer
  at each turn boundary, in every major mode. The subagents extension resolves it, from the
  parent session's branch, at every `team_create` and `team_add`, at `team_succeed` (the retire
  timeout), at every roster answer to a coordinator or monitor (the monitor's thresholds), and for
  `/team defaults` and `/team <objective>` planning. Normal mode reads teams and the spec writer
  through it too; only the Delegate prompt is Delegate's and Create's own (§chat.create-mode/delegate-parity). The align mode's Eagerness, writing
  style and Visuals resolve through it as well: the chat's profile's `alignment` override, field by
  field, else the host's `mode-align.json`. A profile's Eagerness and style reach its open chats at
  their next run like a host change (§chat.alignment/eagerness, §chat.alignment/style); its Visuals count only at a chat's first start
  (§chat.alignment/visuals).
- **Running work.** A switch reaches the chat from its next turn and its next team action: a
  running team adds members and starts successors under the chat's current profile. A worker
  already running keeps the model it was started with. Successors preserve explicit member and
  per-call model choices, recorded separately from resolved models in the team's member records;
  otherwise standing duties use the current profile's configured tuple (the chat's own model where
  it names none) and ordinary successors use their kind's route in it (§teams.defaults/member-kinds).
  A successor whose kind can't run, or that has no kind, retains the predecessor's tuple.

## §chat.subagent-profiles/menu — In the mode menu

The mode menu (§chat/mode-menu) has one group, **Profile**, after the minor modes, with one
always-visible row: "Profile · <name>" (it read "Subagents · <profile name>" before; "<name> (edited)" while the chat's model was changed by
hand, §chat.profiles/edited), a `menuitem` with a chevron that opens the **picker** inside the same
popover (the panel pattern of the composer flyout, §chat.composer/composer-flyout). Delegate's row
detail line reads "Profile: <name>", with "(edited)" the same way.

- **The picker**: a Back header, a search field, a radio list with Off first and then every profile
  this chat can use, as the joined list has them (§chat.profiles/joined): yours, then this
  project's, each with its footprint, the distinct models it routes to (the chat's own model first;
  Off reads "Keeps the chat's own model", where it read "the agent picks"). A project profile that needs approval is listed disabled, its line reading "Approve it in
  Settings first" (§chat.profiles/trust). Then **Manage Profiles…**, which opens Settings → Profiles
  on this chat's profile, and **Save Current as Profile**, which asks for a name inline and saves
  what this chat uses now (its own model and effort, and a copy of its helpers) as a new profile of
  yours with both halves, linked (not offered while the chat is on Off: it configures nothing).
  Once the chat's first message is sent, picking a row switches this chat's Models part, all at once
  (§chat.profiles/switch), and returns to the main panel, with focus on the Profile row; the menu
  stays open, and a switch that waits for the reply or is refused shows its banner there. Before the
  first message, picking a row is a pick of that profile's card, both parts (§chat.profiles/applying),
  and closes the menu as the runtime reopens; a refused pick shows its banner in the open menu.
  Manage Profiles… closes the menu.
- **The default.** The footer's button no longer saves the chat's modes as a default. It reads
  **Make {name} the Default** while this chat's profile is not this computer's default, and makes
  it the default (§chat.profiles/default); `Already the default` with a check, `aria-disabled`,
  while it is: by the profile alone, where the old button reads "Already the default" only when this
  chat's mode, strict flag, minor modes and subagent profile all match what new sessions start from.
  Beside it, **Update {name}** saves this chat's model and effort, and its mode and
  add-on modes (in Create, its last normal or Delegate choice, §chat.create-mode/per-chat-only), into
  the This chat row and the When a Chat Starts part of its profile, through each half's writer
  (§chat.profiles/joined). It is offered only while one of them differs from the profile and the
  profile is one of yours (never Off, a project's file or a profile that can't be read). It saves no
  helper (those are edited in Settings → Profiles) and switches nothing in this chat; other chats on
  the profile follow as after a save in Settings.
- **Configure Delegate**, the gear on Delegate's row, opens Settings → Profiles on this chat's
  profile, at its Models part; so do **Configure Create**, the gear on Create's row (Create shares
  Delegate's settings, §chat.create-mode/delegate-parity), and the gear on spec's row, which opens it
  at the spec writer's row.

## §chat.subagent-profiles/settings — Where the helpers are edited

This Sova has no **Subagents** tab. The helpers are edited in Settings → Profiles, in the **Models**
part of a profile's editor (§app.settings-dialog/profile-editor), the only editor for them: there
are no Modes or Teams tabs, and no settings screen edits the legacy files. Every link that opened
Settings → Subagents (the mode menu's gears and Manage Profiles…, the limit row) opens Settings →
Profiles on the profile in question, at its Models part. What the old tab called subagent profiles
are the library halves of these profiles (§chat.profiles/joined).

- **The list** is Settings → Profiles' (§app.settings-dialog/profiles), Off included, under Built in
  (Off first in the mode menu's picker, last here), with a Default chip on the one new sessions start
  from, and no search field at any length (the old tab gained one past six rows, Off included). In
  its editor a profile of yours has Duplicate, Delete and Make Default; Off has only Make Default.
  The list's head has New Profile alone: Save Current as Profile, which on the old tab's head took
  this chat's setup, otherwise what new sessions get now, saved under a new name, lives in the mode
  menu's picker and on the new chat's screen. Deleting the
  default is refused: make another the default first. A chat whose pick is deleted follows the
  default from its next turn or team action.
- **The Models part** holds what the Subagents editor held, with the same rows, limits, validation
  and save rules. Each role is one compact row (model and effort) that expands, in place, to the
  rest of its controls; there is no back control (the list stays beside the editor), no saved
  footprint under the name ("Not saved yet" was the old tab's, for a new one) and no section summary
  (the old tab's closed Teams section, whose summary names the standing roles' models and, on an
  older Sova, what members run on by default ("Coordinator on opus · monitor on deepseek-v4.1-flash · members on
  opus"; "Coordinator + monitor on the default model · members on the lead's model"), Delegate routing's the routes'
  distinct primary models, Alignment's what it overrides ("Careful · Project manager · visuals on")).
  Edits wait in one draft for the whole tab: another profile opened over them keeps them. Its
  name field is §chat.profiles/profile-name's: a name longer than 48 characters is kept whole, never
  cut, a count "{n} / 48" under the field turns red past it, and while a name holds Save, its field
  is red with the one sentence that says why ("Profile name must be one line, with no spaces at
  either end.", or, on both of two with the same name, "Another profile has this name."), and the
  footer says "Profiles: {that sentence}". Below the name the rows follow. Every box is the form kit's (§design/forms), its limits
  one table the server's save reads too (`shared/subagent-limits.ts`). Expanded:
  - **Delegate routing**: the four work kinds are compact rows, each a worker row
    (§app.settings-dialog/modes) with Add Fallback or Remove Fallback.
  - **Teams** always shows the **Coordinator** and the **Monitor**; there is no switch to leave
    either out of new teams. A profile that never chose models for them (`teams: null`) shows "Uses
    the default model" for both, and **Choose Models**, which gives both roles their worker rows,
    seeded from the profile's last saved roles, else the legacy team defaults. Once chosen, each
    role has its worker row and fallback and an **Instructions** fold holding the role name and the
    role's extra instructions, and **Use Default Model** puts both back on the chat's own model
    (`teams: null`). A role name is 1 to 64 characters after trimming, never cut ("Name the role.",
    "Coordinator role name can be at most 64 characters."), and instructions at most 4,000, with a
    count "{n} / 4,000", kept whole and red past it. The saved model choices are kept; the editor
    never writes `coordinator.enabled` or `monitor.enabled`. Once chosen, the monitor's own settings
    sit under it: wrap-up context %, check interval, and the pause near a usage limit with its resume
    margin. The retire timeout is a **Handover** line under both roles. These five are number boxes,
    each hint under its box, that keep what was typed (§app.settings-dialog/number-boxes): Wrap-up
    context % and Pause usage % are 1 to 100, Check every (minutes) and Retire timeout (minutes) 1 to
    1,440, Resume margin (minutes) 0 to 1,440, each refused as "{label} must be a whole number from
    {min} to {max}.". There is no Members row, switch or save check: a member runs on its work
    kind's route (§teams.defaults/member-kinds), so Set All To and the helper count don't reach one.
  - **Spec writer**: one switch ("Use a spec writer while spec is on").
  - **Reviewer**, only while adversarial review is switched on (§chat.alignment-review/route): one
    switch ("Review alignments with a reviewer").
  - **Alignment**, last: three choices, **Eagerness** (Use host default, Eager, Careful), **Writing
    style** (Use host default, Project manager, Simplified, Technical) and **Visuals** (Use host
    default, On, Off), each starting on "Use host default" for a profile without an override. "Use
    host default" stores no field, and all three on it store no `alignment` at all.
  A row holding something Save waits for opens itself. The mode menu's spec gear opens the chat's
  profile with its spec writer's row open and in view. Rows, validation and save rules are
  §app.settings-dialog/modes': choices from discovery, a changed worker its backend can't run is
  refused, one that can't be checked or that the policy denies saves with a note.
- **Saving** is the dialog's Save Changes (§app.settings-dialog/save-bar). A save reaches every chat
  on that profile from its next turn or team action. The server's save (`PUT /api/settings/subagents`,
  the library half's) refuses a bad name, role name, instructions or team number in the editor's own
  sentence, before the library's own checks; a key the request leaves out is still the file's
  default. While one holds Save, the footer names it (an older Sova's tab says Subagents there). Unsaved edits hold a close; Cancel discards them and closes the dialog.

## §chat.subagent-profiles/replaced — When another device's copy changed the library

When sync changed this device's library with another device's copy (§mesh.sync/kept-copies) in
the last 24 hours, Settings → Profiles' list shows one info notice above its actions, for the
newest such change, until it is restored:

- **Title.** "Replaced by Zen's copy at 2:01 PM." when a profile here was changed or removed;
  "Zen's copy added Fast at 2:01 PM." when it only added profiles. The device is named as this
  device's Mesh page names it (its label), else by its id; the time is a stamp (the 12-hour clock,
  with the date when it isn't today).
- **Body.** What changed, by profile name ("Added Fast; changed Deep; removed Old."), then
  "Your previous library is kept on this device."
- **Restore Previous Library** writes the kept version back as a new edit, through the library's
  own strict parse: it is then this device's newest edit, and syncs like any other, so profiles the
  other copy added are deleted on every device and its changes undone. It waits while the dialog
  holds unsaved Profiles edits. A restore that fails says so in an error banner and leaves the
  library as it is. After a restore, the notice is gone.

## §chat.subagent-profiles/editor-rows — How the editor lays out its rows

The Models part of a profile's editor (§app.settings-dialog/profile-editor) is read by scanning, so
each route and role is compact: folded, a role is one row of label, model and effort; expanded, it
shows the rows below:

- **One line per worker.** Backend, Model and Effort sit side by side while the panel has room.
  On a phone's panel a worker takes two lines: Backend, then Model and Effort, so the model id
  gets most of the width. Their names are the selects' accessible names, not visible labels,
  because each select shows its value. A model id too long for its select ends in an ellipsis and
  shows whole on hover.
- **Primary and Fallback** lead their rows in a narrow column. On a phone's panel they lead the
  Backend line. The fallback's label is quieter than the primary's.
- **Add Fallback and Remove Fallback** sit on the route's head line, beside its name. In Teams that
  is the role's name; in Spec writer and Reviewer it is the switch's line. They never sit on a line
  of their own under the rows.
- **Hierarchy.** A section's header reads a step above the group headings inside it (the work kinds,
  Coordinator, Monitor, Handover), and those read above field labels. Switches
  inside the editor read as ordinary text, not as headings, and the team number fields are sized
  for a 2- to 3-digit value.
- **The list** is Settings → Profiles' (§app.settings-dialog/profiles): each profile shows its name
  over its footprint; a long name or footprint wraps and is never cut short, and the chips never
  overlap the name or footprint. The old tab's row actions, on their own line with Delete set apart
  at its end unless the panel was wide enough to put them beside the name; either way they never
  overlapped it. They are gone: Duplicate and Delete sit in the editor now.
- **Fold summaries.** The summary of a section or an Instructions fold wraps beside its header
  instead of being cut short, so long model ids and role names stay readable.

## §chat.subagent-profiles/limit-row — After a usage limit

When a chat's turn ends on a usage limit — "Claude usage limit reached" after login failover, or a
provider's limit error after its retries — which provider is exhausted is read, never invented: an
explicit provider name in the error's text, or the failed turn's own model, which the server hands
over with the error: the model the chat was actually running, even when it differs from its
profile's (§chat.profiles/edited). A worker's or tool's failure inside the thread shows no row — that
model isn't this chat's turn, and nothing guesses it from the chat's own model — and neither does an
error that limits nothing (auth, network, policy, a bare 429). Then the thread shows a calm row under
the error that offers up to two taps, each **Switch This Chat to <profile>**, naming the first profile
of yours (in list order, never Off, since it promises no provider choice) whose footprint uses no
model of the exhausted provider, then the next such one. The footprint counts the chat's own model as well as the helpers'
(§chat.profiles/joined), so a profile whose This chat row is on the exhausted provider is never
offered. The chat's current profile is offered only while the chat reads "(edited)" and the
profile's own models avoid that provider. Above the buttons the row says "{model} is at its usage
limit." and adds "It resets in {time}." only when Sova knows the reset time from the provider;
it never estimates one. Pressing one switches this chat's whole Models part, as a
pick in the menu does (§chat.profiles/switch): checked first, waiting for a running reply, all or
nothing, and a refusal shows its reason in the row. With no such profile the row links to Settings →
Profiles instead. A failure with no thread row of its own (its error drawn at the thread's end,
§chat.transcript/states) keeps this row when a newer turn starts and its error banner goes. Nothing
switches automatically, and there is no near-limit hint.

## §chat.subagent-profiles/overseer — The Overseer

- `sova_list_profiles` lists Off and every profile this host has (§chat.profiles/joined): id (a
  pair's is its session profile's id, a library-only profile's its library id; both are taken
  wherever a call names a `profile`), name,
  footprint, which parts it has, the library id `subagent_profile` takes where it differs from the
  profile's id, whether it is marked "The Overseer may start it" ("needs no mark" for one with only a
  Models part). Under its other name, `sova_list_subagent_profiles` lists the same; from a peer on an
  older build without the joined list, its library is listed, each a profile with only a Models
  part. Each list marks which is the default.
- `sova_create_session` takes one `profile`: the session starts on it, both parts, as a pick on the
  empty screen does. A profile with a When a Chat Starts part needs "The Overseer may start it" and,
  from a project, your approval, as before (§chat.profiles/trust); one with only a Models part needs
  neither, and starts the session as naming its helpers with `subagent_profile` does (below). `sova_set_session` takes `profile` too, and switches that chat's Models part, all at once
  (§chat.profiles/switch); its When a Chat Starts part never changes. Neither ever moves this
  computer's default, and each result says what the session now runs.
- `sova_create_session` and `sova_set_session` take `subagent_profile` too (an id or `off`), as
  before. On `sova_set_session` it switches only the
  helpers, and leaves the chat's own model and the profile it is on as they are. On
  `sova_create_session` naming only it, the chat's own model, effort and mode follow this computer's
  default profile, its tool changes and grants only as for a start naming no profile
  (§app.overseer/tools), and the named helpers win over the default's helpers. An id this host
  can't resolve is refused before anything changes; with `host`, the peer's own list is asked first,
  and a peer that doesn't know the id (or can't answer) refuses the create before anything is made
  there.
- A project's coding sessions take a profile the same way: the Overseer's `sova_project_overseer`
  `code` and a project overseer's `sova_create_session` and `sova_send` take `profile` (and still
  `subagent_profile`), and a project overseer has `sova_list_profiles` too; with none named, a coding
  session picks no profile and starts on this computer's default profile (§app.project-overseer/coding-mode).
