# §chat/subagent-profiles — Subagent profiles
> Part of the Sova design spec · [overview](../design/overview.md)

Most of the work in a session runs in subagents: Delegate's workers, team members, the spec
writer. A **subagent profile** is one named bundle of every model those subagents are given, so a
usage limit on one provider is answered by switching the whole setup at once instead of editing
four screens. A profile holds:

- **Delegate routing**: a worker (backend · model · effort, plus an optional fallback) for each of
  Delegate's four **work kinds** — Planning & specs, Investigation, Routine implementation and
  Complex implementation — the shape `mode-delegate.json` has (§app.settings-dialog/modes).
- **Teams**: the standing coordinator and monitor every new team gets, with their thresholds and
  handover timeout (the shape of `team-defaults.json`, §teams.defaults/file), or none; and a
  **members default**, the model a team member runs on when nobody named one
  (§chat.subagent-profiles/members-default), or none.
- **Spec writer**: the worker that writes spec drafts while spec is on (the shape of
  `mode-spec.json`), or none, when the session writes the spec itself.

Profiles are unlimited and named by the user. The main thread's own model is not part of a
profile. These are distinct from session profiles (§chat/profiles): the picker and settings tab
identify the setup as "Subagent profiles" or "Subagents".

## §chat.subagent-profiles/file — The file

- **Where.** Two files, both owned by one module,
  `pi-config/extensions/subagents/subagent-profiles.ts` (node built-ins and the builtins-only
  `mode/delegate.ts`, `mode/spec.ts` and `subagents/team-defaults.ts` only): the **library**
  `<agent dir>/subagent-profiles.json` — the shape, the strict parse, the reader, the seeding and
  an atomic writer — and the **device default** `<agent dir>/subagent-profiles-default.json`,
  which profile new chats on this device start from. The mode extension, the subagents extension
  and Sova's server all read both through that module.
- **Shape (version 1).** The library is `{version: 1, profiles: [{id, name, delegate, teams,
  members, specWriter}]}`. `delegate` is the four work kinds' `{primary, fallback}`; `teams` is
  `{coordinator, monitor, handover}` as in `team-defaults.json`, or `null` (no standing members);
  `members` is one worker or `null`; `specWriter` is `{primary, fallback}` or `null`. A profile
  may also carry an optional `reviewer` (`{primary, fallback}` or `null`), the adversarial
  reviewer's route (§chat.alignment-review/route): a profile without the key parses as before, and
  a parse never adds it. The default
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
  makes of that), no members default — and writes the default file naming it. A malformed
  `team-defaults.json`
  postpones seeding until it is fixed, preserving its warning through legacy resolution. A library
  found without a default file (one was removed) is not re-seeded: the default reads as `"off"`
  until the user saves one. The seeded setup preserves the legacy routing until the user changes it. The write never replaces a file another process made first.
- **The legacy files stay.** Nothing deletes or rewrites `mode-delegate.json`,
  `team-defaults.json` or `mode-spec.json`; they are only the last fallback.
- **Mesh.** With the mesh on, the library syncs like the other settings documents (whole file,
  newest edit wins, checked with the module's own parser before it is written). The default file
  never syncs: which profile new chats start from is each device's own, exactly as which profile
  each chat uses stays with that chat (§chat.subagent-profiles/resolution).

## §chat.subagent-profiles/off — Off

**Off** is built in: always first in every list, never stored as a profile, and it can't be
edited, renamed or deleted. It configures nothing, so the agent picks every model:

- In Delegate the prompt still asks the agent to delegate, and still names the four work kinds,
  but carries no worker line for them: the agent chooses each worker's backend, model and effort.
- Teams get no standing coordinator or monitor and no members default, exactly as with no
  `team-defaults.json` today.
- No spec writer: the session writes the spec itself.

## §chat.subagent-profiles/resolution — Which profile a chat uses

- **Per chat.** A chat's pick is its own, stored in the session as a hidden custom entry,
  `subagent-profile` `{v: 1, profile}` (a profile id or `"off"`); the newest on the branch wins.
  It is a sibling of the `mode` entry, never part of it. Sova writes it (the mode menu, the
  Overseer, the limit row), and so does `/mode subagents <id|off>` in a terminal. No other chat
  moves.
- **The default.** A chat with no pick follows this device's default file, read again each time, so a
  new default reaches it too. It moves only when the user asks: the mode menu's save-as-default
  button, or Make Default in Settings → Subagents.
- **Order.** Wherever these settings are read: the chat's pick; then this device's default; then the
  legacy files. A pick naming a profile that no longer exists falls through to the default; one
  step at a time, never a leap: a missing, malformed or dangling default (it names no profile in
  the library) reads as Off. Malformed or dangling defaults carry a reason where the current
  profile is shown; an absent default simply shows Off. A malformed or unreadable library falls
  through to the legacy files.
- **Where it is read.** The mode extension resolves it for Delegate's routing and the spec writer
  at each turn boundary, in either major mode. The subagents extension resolves it, from the
  parent session's branch, at every `team_create` and `team_add`, at `team_succeed` (the retire
  timeout), at every roster answer to a coordinator or monitor (the monitor's thresholds), and for
  `/team defaults` and `/team <objective>` planning. Normal mode reads teams and the spec writer
  through it too; only the Delegate prompt is Delegate's own.
- **Running work.** A switch reaches the chat from its next turn and its next team action: a
  running team adds members and starts successors under the chat's current profile. A worker
  already running keeps the model it was started with. Successors preserve explicit member and
  per-call model choices, recorded separately from resolved models in the team's member records;
  otherwise standing duties use the current profile's configured tuple and ordinary successors
  use its members default. With no applicable current default they retain the predecessor's tuple.

## §chat.subagent-profiles/members-default — Members default

A team member with no model used to run on the parent session's model. A member's model is now,
in order: the member's own `model`; the `team_create` call's `defaults`; the profile's members
default; the parent session's model. The members default applies to a member only when nothing
before it gave a model and any backend the member or the call states is the default's own; its
effort fills in only where neither the member nor the call gave one. An explicit incompatible
backend stays explicit and follows that backend's existing model-default behavior when no model
was given; the profile never crosses it. Synthesized coordinators and monitors keep their own tuples.

- **Never a failed team.** A members default the model policy denies, whose backend isn't loaded,
  or whose pi model the session's registry doesn't list is not used: those members run on the
  parent's model, and the `team_create` or `team_add` result says so in one line with the reason.
- **The planning message** (`/team <objective>`) carries one line while a members default is set:
  "Members you don't give a model run on X; pass a member model to override."

## §chat.subagent-profiles/menu — In the mode menu

The mode menu (§chat/mode-menu) gains one group, **Subagents**, after the minor modes, with one
always-visible row: "Subagents · <profile name>", a `menuitem` with a chevron that opens the
**picker** inside the same popover (the panel pattern of the composer flyout, §chat.composer/composer-flyout).
Delegate's row detail line reads "Profile: <name>".

- **The picker**: a Back header, a search field, a radio list with Off first and then every
  profile, each with its short **footprint** — the distinct models it routes to, shortest form,
  first-seen order, at most 3 and then "+N", a Claude model by its catalog name
  (e.g. `Opus 5.5 · Fable 5.1 · Sonnet 5.5`, §app.claude-code-provider/model-names; Off reads "the agent
  picks") — then **Manage Profiles…**, which opens Settings → Subagents, and **Save Current as
  Profile**, which asks for a name inline and saves what this chat uses now as a new profile (not
  offered while the chat is on Off: it configures nothing). Picking a row switches this chat only,
  closes the menu and returns focus to the trigger.
- **The default.** The footer's save-as-default button also covers the profile: it reads
  "Already the default" only when this chat's mode, strict flag, minor modes **and** subagent
  profile all match what new sessions start from, and pressing it saves both.
- **Configure Delegate**, the gear on Delegate's row, opens Settings → Subagents; so does the
  gear on spec's row.

## §chat.subagent-profiles/settings — Settings → Subagents

Settings has a **Subagents** tab that lists the profiles and edits one at a time. It is the only
editor for these settings: there are no Modes or Teams tabs, and no settings screen edits the
legacy files. The tab's intro is one sentence: "Which models your subagents use. A chat picks a
profile in its mode menu; new chats start on the default."

- **The list.** Off first, then every profile: its name, its footprint, and a "Default" chip on
  the one new sessions start from. With more than six rows, Off included, the list gains a search field; below
  that there is none. Each profile has Edit, Duplicate, Delete and Make Default; Off
  has only Make Default. The list's head has **New Profile** and **Save Current as Profile** (this chat's effective setup when opened from its mode menu;
  otherwise what new sessions get now, saved under a new name). Deleting the default is refused: make another the
  default first. A chat whose pick is deleted follows the default.
- **The editor** (Edit, or a new profile) replaces the list in the tab. Its head is a back
  control, **Subagent profiles**, that returns to the list, then the profile's name field with the
  saved footprint under it ("Not saved yet" for a new one). Below are three collapsible sections,
  four while adversarial review is switched on, each a header that shows, while closed, a one-line
  summary of what is inside:
  - **Delegate routing**, open when the editor opens; its summary is the routes' distinct primary
    models and how many fallbacks are set ("fable · opus · 1 fallback"). The four work kinds
    are compact rows (§app.settings-dialog/modes), each with Add Fallback or Remove Fallback.
  - **Teams**; its summary names the standing roles and the members default ("Coordinator +
    monitor · members on opus"; "No standing roles · members on the lead's model"). **Coordinator**
    and **Monitor** each have one switch and, while on, their worker row and fallback, and an
    **Instructions** fold holding the role name and the role's extra instructions. Turning the
    coordinator off stores no standing roles (`teams: null`); turning it on again restores the
    profile's saved roles, else the legacy team defaults. The monitor reports to the coordinator, so
    its switch waits for one. The monitor's own settings sit under it: wrap-up context %, check
    interval, and the pause near a usage limit with its resume margin. The retire timeout is a
    **Handover** line under both roles. **Members default** is one switch and one worker row.
  - **Spec writer**, one heading and one switch ("Use a spec writer while spec is on"); its summary
    is the writer's model, or "Off · the session writes it".
  - **Reviewer**, only while adversarial review is switched on (§chat.alignment-review/route), last:
    one switch ("Review alignments with a reviewer"); its summary is the reviewer's model, or
    "Off · no review".
  A section holding something Save waits for opens itself, and a role whose fields need fixing
  shows them even while switched off. The mode menu's spec gear opens the chat's profile with Spec
  writer open and in view. Rows, validation and save rules are §app.settings-dialog/modes': choices
  from discovery, a changed worker its backend can't run is refused, one that can't be checked or
  that the policy denies saves with a note. The dialog's Save Changes saves the library; unsaved
  edits hold a close. Going back keeps them: the list then offers only that profile's Edit, so
  another profile can't be opened over them, and Discard Changes or Save Changes frees the rest.
- A save reaches every chat on that profile from its next turn or team action.

## §chat.subagent-profiles/editor-rows — How the editor lays out its rows

The editor is read by scanning, so each route and role is compact:

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
  Coordinator, Monitor, Handover, Members default), and those read above field labels. Switches
  inside the editor read as ordinary text, not as headings, and the team number fields are sized
  for a 2- to 3-digit value.
- **The list.** Each profile shows its name over its footprint, with Edit as the row's outlined
  action. A long name or footprint wraps and is never cut short. The actions take their own line
  under them, with Delete set apart at its end, unless the panel is wide enough to put them beside
  the name. Either way they never overlap the name, chips or footprint.
- **Fold summaries.** The summary of a section or an Instructions fold wraps beside its header
  instead of being cut short, so long model ids and role names stay readable.

## §chat.subagent-profiles/limit-row — After a usage limit

When a chat's turn ends on a usage limit — "Claude usage limit reached" after login failover, or a
provider's limit error after its retries — which provider is exhausted is read, never invented: an
explicit provider name in the error's text, or the failed turn's own model, which the server hands
over with the error. A worker's or tool's failure inside the thread shows no row — that model isn't
this chat's turn, and nothing guesses it from the chat's own model — and neither does an error that
limits nothing (auth, network, policy, a bare 429). Then the thread shows a calm row under the error that offers
one tap: **Switch This Chat to <profile>**, naming the first profile (in list order, never the
chat's current one, excluding Off since it promises no provider choice) whose footprint uses no
model of the exhausted provider. Pressing
it switches this chat only, as a pick in the menu does. With no such profile the row links to
Settings → Subagents instead. Nothing switches automatically, and there is no near-limit hint.

## §chat.subagent-profiles/overseer — The Overseer

- `sova_list_subagent_profiles` lists Off and every profile: id, name, footprint, and which is the
  default.
- `sova_create_session` and `sova_set_session` take `subagent_profile` (an id or `off`): it pins
  that session's pick, never the default, and the result says so. An id this host can't resolve is
  refused before anything changes; with `host`, the peer's own list is asked first, and a peer
  that doesn't know the id (or can't answer) refuses the create before anything is made there.
