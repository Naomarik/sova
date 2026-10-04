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
  first-seen order, at most 3 and then "+N" (e.g. `opus · fable · sonnet`; Off reads "the agent
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

Settings gains a **Subagents** tab whose sections edit one profile. The old Modes and Teams tabs
explain the move and link to Subagents rather than editing legacy files, so there are never two
editors for one setting.

- **The list.** Off first, then every profile: its name, its footprint, and a "Default" chip on
  the one new sessions start from. With more than six rows, Off included, the list gains a search field; below
  that there is none. Each profile has Edit, Duplicate, Delete and Make Default; Off
  has only Make Default. The list's head has **New Profile** and **Save Current as Profile** (this chat's effective setup when opened from its mode menu;
  otherwise what new sessions get now, saved under a new name). Deleting the default is refused: make another the
  default first. A chat whose pick is deleted follows the default.
- **The editor** (Edit, or a new profile): the name, then **Delegate routing** (the four work
  kinds), **Teams** (coordinator, monitor, their thresholds, and **Members default**: off, or one
  worker), and **Spec writer** (and, while adversarial review is switched on, **Reviewer**,
  §chat.alignment-review/route) — the same rows, validation and save rules the old screens had
  (§app.settings-dialog/modes): choices from discovery, a changed worker its backend can't run is
  refused, one that can't be checked or that the policy denies saves with a note. The dialog's
  Save Changes saves the profile being edited; its unsaved edits hold a close, and another profile
  can't be opened over them.
- A save reaches every chat on that profile from its next turn or team action.

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
