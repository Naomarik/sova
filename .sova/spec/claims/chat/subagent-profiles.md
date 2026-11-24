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

Profiles are unlimited and named by the user, and Sova ships three of its own, read-only: Claude,
OpenAI and DeepSeek, each listed only where its account is connected (§chat.subagent-profiles/builtins).
There is no Off (§chat.subagent-profiles/off). They are edited in Settings → Profiles, the Models
part of each profile's editor (§app.settings-dialog/profile-editor); this Sova has no Subagents tab
(§chat.subagent-profiles/settings). With the mesh on, the library is shared by every device profile
by profile, and when another device's copy changes it, Settings → Profiles says so for a day and can
put the previous library back (§chat.subagent-profiles/replaced).

## §chat.subagent-profiles/file — The file

- **Where.** Two files, both owned by one module,
  `pi-config/extensions/subagents/subagent-profiles.ts` (node built-ins and the builtins-only
  `mode/delegate.ts`, `mode/spec.ts` and `subagents/team-defaults.ts` only): the **library**
  `<agent dir>/subagent-profiles.json` — the shape, the strict parse, the reader and an atomic
  writer — and the **device default** `<agent dir>/subagent-profiles-default.json`,
  which profile new chats on this device start from, written when this computer's default profile
  is chosen (§chat.profiles/default). Sova's modes, the subagents extension
  and the rest of Sova's server all read both through that module.
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
  file is `{version: 1, default}`: the id of a library profile or of a built-in one
  (§chat.subagent-profiles/builtins). An older build's `"off"` still parses there and reads as no
  choice (§chat.subagent-profiles/off); Sova never writes it.
- **Strict.** An id is lowercase letters, digits and dashes, at most 48 characters, unique, and
  never `off`; a name is one line of at most 48 characters, unique ignoring case, and never "Off"
  (older readers refuse it); an unknown key or an invalid worker is **malformed**, and the reader
  returns every error. A malformed file is never overwritten by a reader; a malformed library sends
  every reader to the legacy files (§chat.subagent-profiles/resolution), and a missing or malformed
  default file, one naming `off`, or one that names no profile here reads as not chosen: the
  built-in profile the connected accounts give, else none (§chat.profiles/derived-default), saying
  so where a default is shown when the file is malformed or names nothing here.
- **No seeding.** No reader writes either file: a missing library is an empty one
  (§chat.subagent-profiles/no-seeding).
- **The legacy files stay.** Nothing deletes or rewrites `mode-delegate.json`,
  `team-defaults.json` or `mode-spec.json`; they are only the last fallback.
- **Mesh.** With the mesh on, the library syncs profile by profile (§mesh.sync/profile-library):
  a device adds or changes only the profiles it has and never erases one it lacks, a deleted
  profile stays deleted, and two edits to one profile resolve newest-wins for that profile only.
  Every merged library is checked with the module's own parser before it is written, and its
  shape stays exactly the file above: the merge's per-profile dates and deletions live in Sova's
  sync state, never in the file. The built-in profiles are in no file, so they never sync. The
  default file never syncs: which profile new chats start from is each device's own, exactly as which profile
  each chat uses stays with that chat (§chat.subagent-profiles/resolution).

## §chat.subagent-profiles/off — No Off

There is no profile named **Off**, and nothing a person sees offers or names one: not the new chat
cards, the mode menu's picker, Settings → Profiles, the Overseer's list of profiles, the project
page's line about coding sessions, nor a Make Default for it. A chat a person works in runs on a
profile: the one it picked, else this computer's default (§chat.profiles/default), else the
built-in one the connected accounts give (§chat.profiles/derived-default). Only where there is none
of those, and in Sova's own chats, does a chat have no helper profile
(§chat.subagent-profiles/no-helper-profile), and then no screen names a profile at all, never "Off".
Nothing replaces "no helper models": a chat that wants no helpers turns Delegate off.

- **Older records are read, never rewritten.** What an older build wrote for Off still parses
  everywhere it was valid and reads as "follow this computer's default": a chat's helper pick
  `off`, a default file naming `off` (`subagent-profiles-default.json` or `default-profile.json`), a
  session profile whose `subagents` is `off`, a chat's profile entry `{profile: null}` and a switch
  record naming Off's key `sova:default`. No file changes for it, and Sova never writes `off` again.
- **Asking for it.** The Overseer's `profile` or `subagent_profile`, and `/mode subagents off`,
  are refused with one sentence naming the profiles there are: "No profile is named "off"; the
  profiles here are Claude, OpenAI and DeepSeek." ("… are none." with none), and nothing changes.
- **The name stays refused.** No profile may be named "Off" (§chat.profiles/profile-name), since
  older readers refuse it.

## §chat.subagent-profiles/builtins — The built-in Claude, OpenAI and DeepSeek profiles

Sova ships three profiles, each a whole setup named after the account it runs on: its chat's own
model and effort and its helpers. They are computed in code, in no saved list, so they never sync and
an older Sova never sees them. They are read-only, and they name fixed models: a newer model never
moves them.

| | Claude | OpenAI | DeepSeek |
|---|---|---|---|
| This chat | Claude Code `claude-opus-5-5` (Opus 5.5) · medium | `openai-codex/gpt-6.2-sol` (GPT-6.2 Sol) · medium | `ollama-cloud/deepseek-v4.1-flash` (DeepSeek V4.1 Flash) · high |
| Planning | Claude Code `claude-fable-5-2` · high | pi `openai-codex/gpt-6.2-sol` · xhigh | pi `ollama-cloud/deepseek-v4.1-flash` · max |
| Investigation | Claude Code `claude-opus-5-5` · medium | the same Sol · low | the same Flash · low |
| Routine | Claude Code `claude-opus-5-5` · medium | the same Sol · medium | the same Flash · high |
| Complex | Claude Code `claude-opus-5-5` · high | the same Sol · high | the same Flash · high |
| Teams | coordinator Claude Code `claude-opus-5-5` · medium, monitor Claude Code `claude-haiku-5-5` · medium | none chosen: both run on the chat's own model | coordinator the same Flash · high, monitor the same Flash · low |

No route has a fallback. Where a built-in profile chooses team models, the monitor wraps up at 60%
context, checks every 10 minutes and pauses at 90% usage, resuming with a 5-minute margin, and the
retire timeout is 10 minutes. None has a spec writer, a reviewer or an alignment override. Their When
a Chat Starts part sets nothing (no mode, add-ons, tool change or power), so each is
capability-neutral and the Overseer may start it. Their ids are `claude`, `openai` and `deepseek`,
their keys `sova:claude`, `sova:openai` and `sova:deepseek`.

- **Listed only where their account is connected.** Claude with a Claude sign-in, OpenAI with pi's
  own OpenAI sign-in (the ChatGPT subscription, `openai-codex` in `auth.json`, §app/openai-login),
  DeepSeek with an Ollama Cloud API key; a local Ollama, a Z.ai key or a direct DeepSeek key gives
  none. A built-in profile whose account isn't connected is shown nowhere: no card, no greyed-out row,
  no note and no link to Settings → Accounts. With no account connected, no built-in profile is
  listed anywhere. Where listed they come in that order, under **Built in** (the joined list,
  §chat.profiles/joined: Settings → Profiles, the new chat's cards, the mode menu's picker, the limit
  row's offers and the Overseer's `sova_list_profiles`), except one a profile of yours takes the
  place of (§chat.subagent-profiles/shadowing).
- **Claude counts as connected** as Settings → Accounts reads it (§app.claude-logins/accounts-tab):
  a non-empty access token in the credentials file of Claude Code's own directory
  (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) or of one of Sova's added logins; a credentials file with
  an empty token is signed out. Only on macOS, with no credentials file there (the token is in the
  keychain), an account in that directory's `.claude.json` stands in. Claude's models being listed
  in the model picker, which they always are (§app.claude-code-provider/always-on), never counts.
  The accounts are read again whenever one of those files changes.
- **A pick of one is kept.** A chat whose helper pick or this computer's default names a built-in
  profile keeps it wherever the helpers are read (§chat.subagent-profiles/resolution), also after its
  account is disconnected.

## §chat.subagent-profiles/shadowing — A profile of yours in a built-in one's place

A profile of yours takes a built-in profile's place, so each is listed once: one with the built-in
one's id (a copy made with Make It Yours, §app.settings-dialog/profile-editor), else one with its
name, ignoring case, else, for Claude only, the starter older builds seeded for everyone (library id
`my-setup`). The built-in row is then not listed anywhere; your row stands in its place, so a chat,
a default or the Overseer naming the built-in one (by id or key) finds yours, and a chat on it runs
your saved models, not the built-in ones.

- **The seeded "My setup" is shown as Claude.** The library profile `my-setup` that takes Claude's
  place is named "Claude" everywhere a name shows: Settings → Profiles, the new chat's cards, the mode
  menu and its picker, a chat's profile label, the Overseer's list and the resolved helpers' name. It
  keeps its own models, and also with no account connected, since it is yours. Nothing rewrites it
  at start; its first Settings save (Save Changes after any edit to it) writes the name "Claude" to
  the library file, keeping its id `my-setup`, its models and a default that names it, so an older
  device still finds it and it still takes Claude's place. "My setup" is never shown. It holds helpers only, so as the default it
  gives a new chat its helpers alone (§chat.profiles/derived-default).
- **Make It Yours, and back.** A copy made with Make It Yours is a profile of yours with both parts
  and the built-in one's name, so once saved it takes the built-in one's place, the Default and This
  chat chips included. Deleting it brings the built-in one back, also when it is the default only
  because it takes the built-in one's place (§chat.profiles/default). Deleting a profile of yours whose
  helpers link a built-in id never deletes the library profile that takes that built-in one's place
  (the seeded starter, say): a library half is deleted only when it is that profile's own.

## §chat.subagent-profiles/no-seeding — A missing library is an empty one

Sova creates no starter profile. A reader that finds no `subagent-profiles.json` reads an empty
library and writes nothing, neither the library nor `subagent-profiles-default.json`, so a new
computer goes straight to the built-in profiles its accounts give (§chat.profiles/derived-default),
never to the legacy files (`mode-delegate.json`, `team-defaults.json`, `mode-spec.json`), which
only a malformed library still falls back to (§chat.subagent-profiles/resolution). A library found
without a default file reads as no default chosen.

A library an older Sova seeded (one profile, "My setup", id `my-setup`, the file dated to the Unix
epoch), on this computer or synced in from an older device (§mesh.sync/profile-library), is a
library like any other: its starter is shown as Claude (§chat.subagent-profiles/shadowing).

## §chat.subagent-profiles/no-helper-profile — A chat with no helper profile

A chat has no helper profile in two cases, and then:

- In Delegate the prompt still asks the agent to delegate and names the four work kinds, but carries
  no worker line for them: the agent chooses each worker's backend, model and effort.
- Teams still get Sova's coordinator and monitor, on the chat's own model with Sova's built-in values
  (§teams.defaults/file). A member's kind is optional: it runs on the model named for it or its
  team, else the chat's own, and its result line says no profile routes it ("this chat has no
  helper profile", §teams.defaults/member-kinds).
- No spec writer (the session writes the spec itself), no reviewer and no alignment override.

The two cases:

- **Sova's own chats**: the merge thread and its reviewers, a release's chat, the Overseer's own
  chat and the other special sessions, and the routing of a playbook card's run
  (§chat.playbooks/run-card). They run with no helper profile unless this computer's default file
  names one, and never fall back to the built-in profile the accounts give, so a merge, a release or
  a run never gains helpers it didn't have. Sova starts them with the launch flag
  `no-helper-profile`, which its modes and the subagents extension's team tools both read.
- **No default and no account connected.** A chat a person works in, on a computer where no default
  was chosen, the saved default helpers name none and no account is connected. It keeps the model
  new chats open on, and no screen names a profile for it: the mode menu's Profile row reads
  "Profile" alone, Delegate's row shows its own description, Save Current as Profile and Make
  Default are not offered (a Make Default sent anyway is refused: "This chat has no profile to make
  the default."), and the new chat screen checks no card and shows no "The default is already
  picked." line (§chat.profiles/picker). A profile of yours is still listed and can be picked.

## §chat.subagent-profiles/resolution — Which profile a chat uses

- **Per chat.** A chat's pick is its own, stored in the session as a hidden custom entry,
  `subagent-profile` `{v: 1, profile}` (a library or built-in profile's id; an older build's `"off"`
  reads as no pick); the newest on the branch wins.
  It is a sibling of the `mode` entry, never part of it. Sova writes it (the mode menu, the
  Overseer, the limit row, a profile switch, §chat.profiles/switch, and a pick on the empty screen
  that sets `subagents` or switches back from one, §chat.profiles/applying), and so does `/mode
  subagents <id|name>` in a terminal. No other chat
  moves.
- **The default.** A chat with no pick follows this device's default file, read again each time, so a
  new default reaches it too. That file holds the helpers of this computer's default profile, and it
  is written only when the user chooses a default (§chat.profiles/default): Make Default in Settings →
  Profiles, or Make {name} the Default in the mode menu. Until then a chat with no pick follows the
  built-in profile the connected accounts give, which moves when they change
  (§chat.profiles/derived-default).
- **Order.** Wherever these settings are read: the chat's pick; then this device's default; then the
  built-in profile the connected accounts give. A pick names a library profile or a built-in one
  (or the profile of yours in its place, §chat.subagent-profiles/shadowing); a pick of `off` reads as
  none, and one naming a profile that no longer exists falls through to the default; one step at a
  time, never a leap: a missing, `off`, malformed or dangling default (it names no profile here)
  reads as the built-in fallback. Malformed or dangling defaults carry a reason where the current
  profile is shown. With no account connected, and in Sova's own chats, there is no fallback: the
  chat has no helper profile (§chat.subagent-profiles/no-helper-profile). A malformed library falls
  through to the legacy files; a missing one is an empty library (§chat.subagent-profiles/no-seeding).
- **Where it is read.** Sova's modes resolve it for Delegate's routing and the spec writer
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
detail line reads "Profile: <name>", with "(edited)" the same way. The name is the profile in
effect: the whole profile the chat started on or switched to, else the one whose helpers it runs
(its own pick, else this computer's default), so it follows when the Overseer or `/mode subagents`
changes the helpers of a chat on helpers alone. A chat with no helper profile at all
(§chat.subagent-profiles/no-helper-profile) reads "Profile" alone, and Delegate's row shows its own
description.

- **The picker**: a Back header, a search field, a radio list of every profile this chat can use,
  as the joined list has them (§chat.profiles/joined): yours, then this project's, then the built-in
  ones listed here (§chat.subagent-profiles/builtins), each with its footprint, the distinct models it
  routes to (the chat's own model first). There is no Off row. The profile in effect is checked (by
  its key, else, for a chat on helpers alone, the row whose helpers they are), and picking it again
  changes nothing. A project profile that needs approval is listed disabled, its line reading "Approve it in
  Settings first" (§chat.profiles/trust). With none to list: "No profiles yet. Save Current as
  Profile makes one.", or, on a chat with no profile, "No profiles yet. Make one in Manage
  Profiles…". Then **Manage Profiles…**, which opens Settings → Profiles
  on the profile in effect, and **Save Current as Profile**, which asks for a name inline and saves
  what this chat uses now (its own model and effort, and a copy of its helpers, a built-in one's
  included) as a new profile of yours with both halves, linked (not offered while the chat has no
  profile).
  Once the chat's first message is sent, picking a row switches this chat's Models part, all at once
  (§chat.profiles/switch), and returns to the main panel, with focus on the Profile row; the menu
  stays open, and a switch that waits for the reply or is refused shows its banner there. Before the
  first message, picking a row is a pick of that profile's card, both parts (§chat.profiles/applying),
  and closes the menu as the runtime reopens; a refused pick shows its banner in the open menu.
  Manage Profiles… closes the menu.
- **The default.** The footer's button no longer saves the chat's modes as a default. It reads
  **Make {name} the Default** while this chat's profile is not this computer's default, and makes
  it the default (§chat.profiles/default); a chat with no profile has no such button; `Already the default` with a check, `aria-disabled`,
  while it is: by the profile alone, where the old button reads "Already the default" only when this
  chat's mode, strict flag, minor modes and subagent profile all match what new sessions start from.
  Beside it, **Update {name}** saves this chat's model and effort, and its mode and
  add-on modes (in Create, its last normal or Delegate choice, §chat.create-mode/per-chat-only), into
  the This chat row and the When a Chat Starts part of its profile, through each half's writer
  (§chat.profiles/joined). It is offered only while one of them differs from the profile and the
  profile is one of yours (never a project's file, a built-in one, which answers "{name} is built
  in, so it can't be updated here. Make It Yours first.", or a profile that can't be read). It saves no
  helper (those are edited in Settings → Profiles) and switches nothing in this chat; other chats on
  the profile follow as after a save in Settings.
- **Configure Delegate**, the gear on Delegate's row, opens Settings → Profiles on the profile in
  effect, the one whose helpers this chat runs (never Off), at its Models part, where its row
  carries the This chat chip (§app.settings-dialog/profiles); so do **Configure Create**, the gear on
  Create's row (Create shares Delegate's settings, §chat.create-mode/delegate-parity), the gear on
  spec's row, which opens it at the spec writer's row, and Manage Profiles….

## §chat.subagent-profiles/settings — Where the helpers are edited

This Sova has no **Subagents** tab. The helpers are edited in Settings → Profiles, in the **Models**
part of a profile's editor (§app.settings-dialog/profile-editor), the only editor for them: there
are no Modes or Teams tabs, and no settings screen edits the legacy files. Every link that opened
Settings → Subagents (the mode menu's gears and Manage Profiles…, the limit row) opens Settings →
Profiles on the profile in question, at its Models part. What the old tab called subagent profiles
are the library halves of these profiles (§chat.profiles/joined).

- **The list** is Settings → Profiles' (§app.settings-dialog/profiles), the built-in profiles
  listed here under Built in, with a Default chip on the one new sessions start from, a This chat
  chip on the one the chat Settings was opened from runs, and no search field at any length (the old
  tab gained one past six rows). There is no Off. In its editor a profile of yours has Duplicate,
  Delete and Make Default; a built-in one has Make Default and Make It Yours.
  The list's head has New Profile alone: Save Current as Profile, which on the old tab's head took
  this chat's setup, otherwise what new sessions get now, saved under a new name, lives in the mode
  menu's picker and on the new chat's screen. Deleting the
  default is refused: make another the default first (§chat.profiles/default). A chat whose pick is deleted follows the
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
    either out of new teams. Under the group's heading one line says "Members run on the Delegate
    model for their kind of work." (§teams.defaults/member-kinds). A profile that never chose models
    for them (`teams: null`) shows "Uses the chat's own model" for both (it read "Uses the default
    model"), which is what they run on (§teams.defaults/file), and **Choose Models**, which gives both roles their worker rows,
    seeded from the profile's last saved roles, else the legacy team defaults. Once chosen, each
    role has its worker row and fallback and an **Instructions** fold holding the role name and the
    role's extra instructions, and **Use Default Model** puts both back on the chat's own model
    (`teams: null`). A built-in profile shows its own Teams rows read-only. A role name is 1 to 64 characters after trimming, never cut ("Name the role.",
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
shows the rows below. At its top, under the editor's tabs, a **Jump to** row (a muted caption, then
one small ghost button each for **Delegate**, **Teams**, **Review** and **Alignment**, wrapping on a
narrow panel) scrolls that group's heading to the top of the Settings panel and moves focus to it;
the heading shows the focus ring only for keyboard focus.

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
  overlap the name or footprint. A line in the list holding a folder path with no break in it (This
  project's) wraps inside the list's column, never past it. The old tab's row actions, on their own line with Delete set apart
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
the error that offers up to two taps, each **Switch This Chat to <profile>**, naming the first
profile whose footprint uses no model of the exhausted provider, then the next such one: yours in
list order first, then the built-in ones listed here (§chat.subagent-profiles/builtins), so a chat
on Claude can be offered OpenAI. The footprint counts the chat's own model as well as the helpers'
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

- `sova_list_profiles` lists every profile this host has (§chat.profiles/joined), the built-in
  ones listed there included, and no Off: id (a pair's is its session profile's id, a library-only
  profile's its library id, a built-in one's `claude`, `openai` or `deepseek`; each is taken
  wherever a call names a `profile`), name,
  footprint, which parts it has, the library id `subagent_profile` takes where it differs from the
  profile's id, whether it is marked "The Overseer may start it" ("needs no mark" for one with only a
  Models part). Under its other name, `sova_list_subagent_profiles` lists the same; from a peer on an
  older build without the joined list, its library is listed, each a profile with only a Models
  part, and the Off that build lists is left out. Each list marks which is the default.
- `sova_create_session` takes one `profile`: the session starts on it, both parts, as a pick on the
  empty screen does. A profile with a When a Chat Starts part needs "The Overseer may start it" and,
  from a project, your approval, as before (§chat.profiles/trust); one with only a Models part needs
  neither, and starts the session as naming its helpers with `subagent_profile` does (below). `sova_set_session` takes `profile` too, and switches that chat's Models part, all at once
  (§chat.profiles/switch); its When a Chat Starts part never changes. Neither ever moves this
  computer's default, and each result says what the session now runs.
- `sova_create_session` and `sova_set_session` take `subagent_profile` too (a library or built-in
  profile's id), as before. `off`, as `profile` or `subagent_profile`, is refused with the sentence
  naming the profiles there are (§chat.subagent-profiles/off). On `sova_set_session` it switches only
  the helpers, and leaves the chat's own model as it is: a chat on a whole profile keeps its name,
  and one on helpers alone is then named by the helpers it runs (§chat.profiles/switch). On
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
