# §chat/schedules — Playbook schedules
> Part of the Sova design spec · [overview](../design/overview.md)

A project's playbook can say when it runs by itself: a `when:` line in its entry file's header,
with the profile it runs as. One keeper in the server (`server/schedules.ts`) fires it, with no
model in the loop, and a fire reaches a session as a tagged wake-up. Nothing fires until you approve
the schedule with a click, and an approval covers exactly the `when:`, `tz:` and profile you saw.
Schedules are not wake nudges (§chat/wake-nudges, §teams.defaults/wake-nudge): a nudge is a chat's own
one-shot reminder, set by its model with no approval, and it fires in that chat. A schedule is
approved by you, repeats with no model to re-arm it, and can start a new session.

## §chat.schedules/header — The `when:` line

- **Where.** Only a project playbook (`<project root>/.sova/playbooks/<id>/`, entry `PLAYBOOK.md` or `SKILL.md`, or the
  marketing folder, §chat.playbooks/where-playbooks-come-from) can have a schedule, because it has a
  project for its sessions to run in. `when:` in a Sova or Yours playbook is ignored and shown as
  "Schedules run only from a project's playbooks."
- **The keys**, in the playbook's frontmatter, one line each: `when:` (the triggers), `profile:`
  (required with `when:`; a profile id looked up in the playbook's project, then Yours, then Built
  in, §chat.profiles/projects), `tz:` (optional, an IANA zone name; without it, the Sova host's own
  zone at fire time) and `task:` (optional, one line: the fired message's reason; default "Run this
  playbook").
- **The grammar**, the whole language: `when := trigger (';' trigger)*`, at most 3 triggers. A
  trigger is one of
  - `daily HH:MM[,HH:MM…]`, `weekdays HH:MM[,…]` (Monday to Friday), `weekends HH:MM[,…]`, or a
    day list `mon,wed,fri HH:MM[,…]` (three-letter English day names): 24-hour times, at most 4
    per trigger;
  - `every 30m`, or `every Nh` with N one of 1, 2, 3, 4, 6, 8, 12. Both are aligned to local
    midnight, so a restart never drifts them: `every 2h` fires at 00:00, 02:00, 04:00 and so on;
  - `claude-limit-reset` (§chat.schedules/limit-reset);
  The event trigger fires at no set time, so it never counts toward the 48 below.
  Keywords are case-insensitive. 30 minutes is the shortest interval: there is no `every 10m`.
- **All or nothing.** A line that doesn't parse, a `when:` without `profile:`, an unknown `tz:`, or a
  line whose triggers could fire more than 48 times on some day of the week makes the whole schedule
  invalid. It is shown with the exact error and never partly run.
- **Daylight saving.** A local time that doesn't exist that day fires at the next minute that does
  (02:30 on a spring-forward night fires at 03:00), and one that happens twice fires once, at its
  first occurrence. Two triggers that land on the same minute fire once.
- The header is read again at every fire, from the file, with no cache and no watch.

## §chat.schedules/approval — Approving a schedule, and when it asks again

- **Nothing fires unapproved.** A schedule found in a project's playbook reads **Needs approval**
  until you approve it. Only your click in Sova approves: `POST /api/schedules/approve {cwd,
  playbook, pin}` from the Playbooks dialog or the Overseer's Approvals & Schedules, or **Apply and
  Approve** on a project overseer's Settings change card that grants it (§app.project-overseer/settings:
  the schedule's lines as the card showed them, refused when the file differs). Anything but your own
  page is refused (§app.access/your-click), so no model, script or extension approves one. A schedule
  on another of your computers can be approved from this page too, with proof of your click carried
  across the link between the computers. Any caller on another computer whose proof fails or is missing
  gets the same refusal (§design.copy-deck/your-click), and a fresh click gets a fresh one-time proof.
- **Pinned to what you saw.** An approval records the schedule's pin: its `when:` and `tz:` lines,
  the linked profile's identity (§chat.profiles/projects), and that profile's powers (what it removes
  and grants, One at a time, and whether the Overseer may start it). `pin` is the one the client was
  shown; the approve is refused (409) when the file's pin differs now, and while the linked project
  profile still needs its own approval (§chat.profiles/trust).
- **When it asks again.** A change to `when:`, `tz:` or the linked profile (another profile, or the
  same one with other powers) pauses the schedule: "Changed since you approved it", until you approve
  it again. Edits to the playbook's instructions and to `task:` never ask again: the profile, which
  is pinned, is what decides what a run may do. A missing playbook, a missing profile, or a project
  profile that needs its own approval (§chat.profiles/trust) pauses it too, and says which.
- **Stored outside every repo**, `<state root>/schedules.json`: each schedule by its project root and
  playbook id, with an id `sN` numbered per host and never reused, its approval (pin and time), its
  pause, its next fire and its recent fires. A branch, a clone or an agent's edit can't approve one.
- **Revoke.** `POST /api/schedules/revoke {id}` (404 for an unknown id, 409 for one not approved)
  removes the approval at once: the next tick fires nothing, and the schedule reads Needs approval
  again for as long as the file still declares it.

## §chat.schedules/automation-file — An automation file

A schedule can be declared in a file of its own, `<project root>/.sova/automations/<id>.json`, instead
of a playbook's `when:` line (§chat.schedules/header). The file holds one automation: its triggers, the
playbook it runs, and its session's own settings and permissions. It names no profile. Sova reads the
files fresh each time. `sova_settings` and its cards don't reach them: an automation file changes as a
file, in the project.

| Key | Holds |
|---|---|
| `id` | Required, and equal to the file's name: lowercase letters, digits and dashes, at most 63 characters |
| `label` | Required, at most 60 characters |
| `when` | Required, in the grammar of the `when:` line |
| `tz` | An IANA zone; optional |
| `task` | What each fire says to do; optional |
| `playbook` | Required: the id of the playbook it runs |
| `session` | Required, and `long-running` is the only kind |
| `settings` | Optional: `model` (`provider/id`), `thinking`, `mode` (`normal` or `delegate`), `minorModes` (align, spec, vis, memory), `memory` (`{type, size?}`) |
| `permissions` | Optional: `remove`, `grant`, `oneAtATime`, `limits` (whole numbers, 1 to 10000), `overseerMayStart`. Left out: nothing removed or granted, not One at a time, the default limits, and the Overseer can't start it |

- **All or nothing.** An unknown key, a wrong type or a bad value makes the whole file invalid: it is
  shown with its exact error and never fires.
- **Approval.** A new file reads Needs approval, and nothing fires until you approve it, by
  `POST /api/schedules/approve` with `{cwd, automation, pin}` (§chat.schedules/approval). The approval
  covers its triggers, zone, playbook id, session kind and every permission. A change to any of those
  pauses it, Changed since you approved it, until you approve again. Its settings, label, task and the
  playbook's text aren't covered, so changing them asks nothing.
- **One session.** The first fire makes a new session in the project's root, with the file's permissions
  and settings, titled `{label} (automation)`. Every later fire wakes that same session, and first sets
  its model, effort, mode and minor modes to the file's where they differ; what the file leaves out stays
  as the session has it. A memory size in the file is ignored (§chat.memory/choice). Settings that can't
  be applied don't stop the fire. If the session was archived or is gone, the next fire makes a new one;
  while it is open in a terminal, a fire is skipped.
- **It wins over `when:`.** A file naming a playbook whose header also has `when:` takes that schedule's
  row: same `sN`, fires and next fire. Its approval carries over only when it still holds and says what
  the file says; otherwise the row waits for your approval. Approving the playbook itself is refused with
  "An automation file runs {playbook}: approve the automation instead."
- **Gone.** With its file removed, an approved automation pauses, saying "The automation file {id}.json
  is gone from {project}.", and an unapproved one is forgotten. With its playbook gone, an approved one
  pauses and an unapproved one is invalid.
- **Shown** like any schedule (§chat.schedules/where-shown), with `{label}'s own settings` where a header
  schedule names its profile, and in the sidebar's Automations region once it has a session.

## §chat.schedules/fire — What a fire does

- **The keeper** ticks every 30 seconds. At each tick it re-reads each approved schedule's header,
  checks its pin, and fires the ones that are due. Its store and its log live under the state root:
  `schedules.json` and one line per fire or skip in `schedule-runs.jsonl` (`{at, id, playbook,
  trigger, outcome, why?, session?}`).
- **One at a time profile**: a fire wakes the profile's live session in the playbook's project
  (§chat.profiles/singleton), queued behind its turn if one is running, or starts one when none runs.
  **Any other profile**: every fire starts a new session. A new session is created in the project's
  root with the profile, exactly as a start from the list (§chat.profiles/applying), and gets the
  automatic title "{playbook title} (scheduled)", which a title of yours replaces. A fire never makes a second One at a time session, and never
  targets a session other than those.
- **The message** is a real user message, tagged so it reads as a wake-up, never as you:
  ```
  [schedule s1] Scheduled run fired (every 30m, playbook release).
  Late by 12m (Sova was not running).          <- only when the fire was late
  Reason: <task, or "Run this playbook"; >
  <instruction>
  ```
  The instruction of a new session is the playbook's turn (§chat.playbooks/what-gets-sent) after a
  blank line. A wake says `Run the playbook "<title>" again: read <dir>/<entry> first, since it
  may have changed.`, where `<entry>` is the file the playbook is read from now, `PLAYBOOK.md` or
  `SKILL.md` (§chat.playbooks/where-playbooks-come-from). The run is not started by the user, so a send in it spends the profile's
  "On its own" allowance (§chat.profiles/limits).
- **Skipped while the last one runs.** A fire is skipped, and logged, while the session this
  schedule last fired into is still running or still holds a queued message.
- **Restarts.** The next fire is kept in the store. At start, a fire missed while Sova was down fires
  once if it is less than an hour late, with its "Late by" line; otherwise it is skipped and logged.
  Missed fires are never caught up one by one: the next is computed from now.
- A fire counts toward the Overseer's running-at-once cap, like a resume (§app.overseer/auto-resume):
  with no slot free it is skipped and logged.

## §chat.schedules/limit-reset — Continuing after a Claude limit resets

- **The trigger.** `claude-limit-reset` fires when a Claude login on this host goes from limited to
  ready (its standing in `claude-accounts-state.json`, §app/claude-logins): its limit's time has
  passed or the standing was cleared. An unreadable standing skips this check for that tick, never
  the time fires. The keeper checks every tick and keeps the standing it last
  saw in its store, so a reset that happened while Sova was down is seen at start (under the same
  one-hour rule, counted from the reset).
- **Only sessions that stopped at that limit.** It sends one continue to each session this schedule
  may target (the sessions its own fires started, and its One at a time profile's live session)
  whose branch ends in a failed turn on that login that failed after the limit began. Each such
  session once per reset. It never starts a session and never messages one that didn't stop there.
- The message: `[schedule s1] Scheduled run fired (claude-limit-reset, playbook release).`,
  `Reason: Claude login <name> is ready again.`, then `Your last turn stopped at that Claude login's
  usage limit, which has now reset. Continue where you left off.`

## §chat.schedules/limits — Limits and the automatic pause

- At most **20 approved schedules** per host: the 21st approve is refused (409).
- At most **one run in flight** per schedule (§chat.schedules/fire).
- At most **48 fires a day** per schedule, counted per local day in its zone: past that it skips and
  logs.
- **Unwatched runs pause it.** After 10 fires in a row that started a session nobody opened since,
  the schedule pauses: "Paused after 10 runs nobody opened." (the row shows that sentence as its
  state). Waking a One at a time session that
  already runs is not counted, and does not break the run of 10 either. Approving it again resumes
  it and starts the count over.

## §chat.schedules/where-shown — Where a schedule shows

- **The Playbooks dialog.** A playbook with a schedule has one more line in its row, under the
  description: the schedule in words and its state, e.g. "Every 30 min · When a Claude limit resets ·
  Needs approval", "When a branch is ready to merge · Every 6 hours · Next 12:00 PM", "… · Next 9:30 AM", "… · Paused: Changed since you approved it", or
  "Schedule not valid: {error}". Its step 2 shows a schedule card above the text box: the schedule,
  "Runs as {profile}" (with its zone when `tz:` is set), the state (an approved schedule with only
  event triggers has no next time and reads "Runs when a Claude limit resets." or "Runs when a
  branch is ready to merge.", its events joined by "or when"), and **Approve Schedule** (Needs
  approval or paused) or **Revoke Schedule** (approved). The card says what approving means:
  "Sova will start or wake {profile} sessions on this schedule without you. It asks again if the
  schedule or the profile changes; edits to the instructions don't."
- **The Overseer's Approvals & Schedules** (§app.overseer/approvals: Schedules ▾ in its head from
  900px up, else ⋯'s first row) lists every schedule Sova knows of, approved or not, and the ⋯ row's
  note counts them, "1 approval · 2 schedules", or says "1 needs approval" while any waits; then
  ⋯ and Schedules ▾ carry a dot. Each row: its `sN`, the playbook and its
  project, the schedule in words, the profile, the state (Needs approval, Next …, Paused and why),
  its last fires as links to their sessions, and **Approve Schedule** or **Revoke Schedule**.
- **The fired message** is a wake card (§chat.transcript/transcript-items), named "Scheduled run
  s1", never "You": it counts as an input, never titles the session, and is never hidden.
- The keeper also finds schedules no one has looked at yet: every few minutes it reads the playbooks
  of each project a listed session runs in, so a new one appears in Approvals & Schedules as Needs approval.
  Under Brief Me (§app.overseer/proactivity) the Overseer gets one brief when Sova first finds a
  schedule, naming the playbook, its project and its schedule, and saying it fires only once you
  approve it. An unapproved schedule whose playbook no longer has a `when:` line is forgotten.
- **For hermetic runs only**, `SOVA_SCHEDULE_TICK_MS` sets the tick and `SOVA_SCHEDULE_SPEED` runs
  the keeper's clock that many times faster from start, so an `every 30m` fires in seconds.
