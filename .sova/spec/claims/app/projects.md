# §app/projects — Projects: registered folders, in an organization or not
> Part of the Sova design spec · [overview](../design/overview.md)

A **project** is a folder (a git checkout root, or a plain folder) the operator has explicitly
registered. Every registered project has the project page, its overseer, coding sessions with their
worktrees, costs, previews and running instances (§app/project-services), whether or not an
organization places it, and every session run in its folder is listed as its own, however it was started
(§app.projects/folder-sessions). An organization only **places** a project and adds its own concerns
(stakeholder, people, outreach, owner updates, requirements; §app/organizations). The project
layer never knows organizations exist (§app.projects/seam).

Pages: `#/projects` (the list) and `#/projects/<pid>` (one project, §app.organizations/project-page),
`…/requirements` (only while placed), `…/branches`, `…/cost`, `…/settings`, `…/overseer`, each taking `?host=<peer>`
for a project held on a peer (§mesh.remote-sessions/org-pages). API: `/api/projects` and
`/api/projects/:pid/…` for every project-layer read and act; the organization's concerns stay under
`/api/orgs/:id/projects/:pid/…`. There is no other address for a project and no alias.

## §app.projects/registration — A folder becomes a project only when the operator adds it

- Three ways, each the operator's own, or the global Overseer's for them, recorded via the Overseer
  (§app.overseer/org-project-add) (main listener only): **Add Project** on the Projects page
  (a folder), **Add as Project** on a session's Session tab (that session's folder), and **Clone from
  GitHub** (§app.projects/clone). Each is `POST /api/projects {root}` (clone: `{clone:{…}}`) and
  answers the project (201).
- The folder is normalized to its git checkout root, the repository's main checkout (a linked
  worktree and its subfolders belong to it, as for every root-keyed thing); when that differs from the folder given, the
  answer names both (`normalizedFrom`) and the form says "Added {root}, the checkout root of
  {folder}." A folder that is no checkout is registered as it is.
- The Session tab's Identity shows a **Project** row for a session on this host: the registered
  project its folder is in (that project's root or a folder inside it, the deepest root), linked to
  its page, else **Add as Project**. A session on a peer has no such row.
- **One project per checkout root.** A root already registered here, standalone or placed in an org
  attached here, is refused (409, "{root} is already the project {name}.").
- **Reserved roots are refused** (400): a root inside an attached org's workspace or holding one,
  or inside Sova's agent folder, the one holding its state, sessions and settings ("Sova's own state
  can't be a project."). The folder given is checked as well as the checkout root it normalizes to.
- The new id is `prj_` + 8 characters, checked against every project known here. Registering writes
  the index entry `<stateRoot>/projects.json` (`{version:1, projects:[{id, dir, registeredAt}]}`,
  standalone projects only, written atomically), creates its dir and starts its statechart, which
  starts its watch loop.
- **Nothing registers on its own.** Starting a session in a folder registers nothing; an
  unregistered folder keeps everything root-keyed exactly as before (its playbooks list
  "This folder", its profiles, schedules and `project_verbs`; §app/project-services).

## §app.projects/clone — Clone from GitHub

- The Add Project dialog's **Clone from GitHub** takes a repository (URL or `owner/name`), a parent
  folder and an optional folder name, and runs `git clone` with arguments (no shell, `--` before the
  URL) into a new folder under the parent, with a timeout and git's own credentials (never a
  password prompt), then registers
  that folder as Add Project does. `owner/name` means `https://github.com/owner/name.git`; the
  folder name defaults to the repository's name, and the dialog shows the destination path.
- A destination that exists is refused before anything runs (409, "{path} already exists."). A clone
  that fails or times out deletes only the folder it created and answers git's reason; nothing is
  registered. Main listener only.
- **The global Overseer's clone is narrower** (§app.overseer/org-project-add): for a request with its
  sender mark the route takes only `https://` without a user or password, `ssh://`, `user@host:path`
  or `owner/name`, never a host that is this machine; it checks the destination against the
  reserved roots and the Overseer's file guard before git runs, and runs one such clone at a time.

## §app.projects/standalone — A project in no organization

- A standalone project has an engine of its own, the same as an org's
  (§app.project-overseer/statecharts), whose dir `<stateRoot>/projects/<pid>/` has the workspace
  layout: `statecharts/` (its portable statecharts and log), `sessions/` (its overseer conversations)
  and `projects/<pid>/` (overseer settings and files, costs, usage); its host-local statecharts are
  under `<stateRoot>/statecharts/<pid>/`. It opens at server start and when it is registered, and a
  restart reopens it with nothing lost.
- It is host-local and in no git repo: it can't be cloned or attached elsewhere until an
  organization imports it (§app.projects/import).
- Its sessions are listed and opened like an org's project's: its overseer conversations are
  accepted session paths, its coding sessions are ordinary sessions in their worktrees.
- Its overseer runs on the switches the operator set (a new project: the carry-over of L1): no roster brakes it, and it has no Project Assistant column and no acts of people (§app.project-overseer/autonomy-levels).

## §app.projects/list — The Projects page and the sidebar's Projects region

- `GET /api/projects` lists every project known here: the standalone ones and those placed in each
  attached org, each `{id, name, root, origin, remote?, createdAt, archived?, space}` where `space`
  is `{kind: "standalone"}` or `{kind: "org", orgId, orgName}`. It is a union read from the engines,
  never a copy.
- `#/projects` lists them as rows linking to `#/projects/<pid>` (name, folder, and "In {org}" when
  placed), archived ones apart, with **Add Project** opening the Add Project dialog (Folder ·
  Clone from GitHub). Under them, **Running branches** lists what runs on this host now, every
  project's, each with a Stop, a branch's name linking to its app's entry while the project
  declares one and the entry's service is ready (§app.project-services/services-ui).
- The sidebar has a **Projects** region for standalone projects, directly above Folders, shaped as one organization's
  project blocks in the Organizations region (§app.session-list/organizations): the project heading
  with its overseer's eye, then its sessions straight under it, with no group heading: the coding
  sessions it started and the sessions in its folder (§app.projects/folder-sessions), running or
  waiting, then the finished ones (a build merged per git, a folder session that is neither live nor
  an unarchived web session) folded into one quiet "{n} done" line at the end of the list, which
  opens them in place (closed by default, memory only). The project heading starts with a small
  arrow that folds and unfolds its sessions: open by default, the choice kept in memory for the
  page's life (as each Done is), and forced open while a search is on. When you move to a session
  among its rows (a click, a link, a notification, the palette, or loading the page on it) a
  folded project, and its Done if the session is there, opens for that visit without changing the
  choice, then it is yours to close: a fold you make while on that session stays folded through
  every refresh, running agent and new message until you unfold it or move to a session again.
  The region itself is a `<details>`, **open by default**; a collapse is remembered for the tab in
  `sessionStorage["sova:projects-open"]` through `writeKey`, `"0"` collapsed and anything else
  open. It is forced open, without changing the stored choice, while a search is on, and opened
  on the same terms as a project when you move to a session inside it, then yours to close.
  An **archived**
  session of any kind is never in the block nor its counts: it is in the Archive only
  (§app.session-list/ordinary-surfaces); archiving a build says "Archived. Find it under Archive."
  and unarchiving it "Moved back to {project}.". The region head counts **projects**
  ("Projects · {n}"; while searching "Projects · {matching} of {all}"); each project heading counts
  its open rows only (running or waiting, the overseer's eye never); the done line counts its own. A peer's
  folder session is never a row here (it stays in Folders), so it adds no block. Its head carries an arrow to
  `#/projects` and no Add Project (that is the Projects page's); each project heading's name opens its page, and its heading has the
  Organizations region's project level (§app.session-list/organizations "Three levels"). A
  search finds a project by its name or folder and keeps its heading with no row under it when
  none of its sessions match. A placed project is the Organizations region's, listed there under
  its org, with sessions or without, from the same project list. With no project it says "No projects
  yet. Add one on the Projects page.", "Projects page" a link to `#/projects`. It is listed once the session list loads, even
  empty, except when a search finds nothing in it. Where Needs you names where an item of a standalone project
  waits, it says Projects.

## §app.projects/folder-sessions — A session in a project's folder is the project's

A session that runs in a registered project's folder belongs to that project, however it was
started: from the project, from New Session's folder tab, from a TUI or from Claude Code.

- **Started from the folder tab, it is the project's coding session.** When the folder New
  Session's This Computer tab holds is a registered, not archived project's root, a folder inside
  it, or a folder inside one of its worktrees as Sova names them (the deepest root wins), Create
  Session starts it exactly as the Project tab does (§app/new-session-dialog,
  §app.project-overseer/new-coding-session): an `operator-coding` build with `worktree: "later"`,
  on the project's coding model and thinking, in this computer's default mode, pinned, listed in the
  Cost card, its later worktree adopted. It starts in the folder chosen, never moved to the root. This
  holds for a project an organization places too: the start runs in that project's own engine.
  Another Host (§mesh.remote-sessions/host-picker) and the Remote tab start plain sessions, as
  before.
- **`cwd` on the start.** `POST /api/projects/:pid/overseer/coding` takes an optional absolute
  `cwd`: the project root, a folder inside it, or a folder inside one of the project's linked git
  worktrees, compared on canonical (symlink-free) paths. Any other folder, a relative path or one
  that doesn't exist is refused with 400 and nothing starts. With no `cwd` it starts in the root,
  as before; the Project tab sends none.
- **Who started a build.** A coding session the operator started (an `operator-coding` build: the
  folder tab or the project's New Coding Session; or a Project verbs run the operator started — the
  project page's "Started by" rule) is listed as `SessionSummary.project`
  `{kind: "coding", operator: true}`; one the project's overseer started has no `operator`. The
  marker is additive: an older server sends none, which reads as the overseer's. It is how the
  operator's own coding sessions also reach Recent (§app.session-list/recent).
- **Every other session in the folder is listed as the project's.** Reading the list, a session no
  marker or build claims belongs to the project whose folder its `cwd` is in, as
  `SessionSummary.project` `{kind: "folder"}`, never `finished`: an overseer marker, then a build,
  then the folder, in that order (a build keeps `coding` and its merged state). The folder is
  matched once per distinct `cwd` per listing: the deepest non-archived project root the `cwd`
  equals or sits under, by its path as written or its real path (a folder above the root never
  matches); else, walking up to the first `.git`, a `.git` file naming `<checkout>/.git/worktrees/<n>`
  makes it that checkout's (git is not run); else, for a folder that no longer exists, a path
  under `<root's parent>/.worktrees/<root's name>-` makes it that root's. An archived project
  never matches, and a remote session's placeholder folder never does.
- **Listed with its project, not in Folders.** A folder session is listed with its project: in
  the sidebar's Projects region for a standalone project (§app.projects/list), in the
  Organizations region for a placed one (§app.session-list/organizations), among the project's
  sessions (the Organizations region's Sessions group; the Projects region's rows under the project
  heading) — running or waiting while it is live, or a web session not archived; otherwise in Done
  (the Projects region's "{n} done" line) until it is archived. While it is listed there it is not in Folders
  (§app.session-list/regions-top-and-archive). It stays an ordinary session
  (§app.session-list/ordinary-surfaces): the shortcuts — Needs you, Recent, Groups and
  Automations —, the Archive and its cleanup, and the overview list it as before (the overview's
  `{live} live` counts it), and it can be grouped. An archived one is listed in the Archive only,
  never with its project. A session from another computer (a mesh peer's row, which carries that
  peer's own `project`) or a remote target's is never listed under this computer's projects: it
  stays in Folders.
- **A placed project's folder sessions are not organizational.** They carry no
  `SessionSummary.org` (§app.organizations/org-sessions), so nothing an org session is refused
  (forking, a profile, a link, a group) is refused to them. The org layer adds
  `SessionSummary.folderOrg` (the org and project, as an org session's reference names them) so the
  Organizations region can place them; the project layer never names the org
  (§app.projects/seam).

## §app.projects/seam — The project layer never knows organizations exist

- The project layer is the statecharts `project/<p>`, `watch/<p>` and `build/<p>/<s>` and the
  server's project modules (registry, engines, routes, clone, project root, the project overseer,
  costs, previews, worktrees, coding mode, running instances and the engine plumbing). None of it
  holds an org id, builds an org statechart's id, reads an org key or imports an org module at
  runtime, directly or through another module.
- The org layer may address the project layer: it spawns builds for its gaps, notes reasons for
  the watch loop, and contributes, through registration points the project layer offers, the
  ceiling on its overseer's level and its people, a look hint, overseer tools and prompt sections,
  archive blockers, session kinds, the roots a project may not use and the Claude login a placed
  project follows by default (§app.claude-logins/project-login).
- Two tests enforce it: a statecharts test that no project-layer statechart names an org-layer
  statechart id or key, and a server test that no project-layer module reaches an org-layer module
  through its runtime imports, followed through every module in between.

## §app.projects/placement — An organization places a project

- A project is placed in an org when the org's engine holds the project's statecharts and the
  org-layer statechart `placement/<o>/<p>`. The placement holds everything the org adds: the main
  stakeholder and its history (§app.organizations/stakeholder), owner updates with their milestone
  and cooldown (§app.owner-page/updates), WhatsApp sends (§app.outreach/send), gathering sessions
  started for the project, gaps filed, the spec freeze, hidden-from-owner, and the reconciler.
- It learns about the project only from what the project's statechart exports (a merged build
  sets the owner-update milestone through the project's last merge time); the project's statecharts
  never address it.
- The org's **Add project** (`POST /api/orgs/:id/projects {root, name?}`) registers the folder as
  §app.projects/registration does (same refusals) and places it at once.
- Whenever an org opens, every project in its engine has a placement; one that lacks it gets one
  then.

## §app.projects/import — An organization imports a standalone project

- `POST /api/orgs/:id/projects/import {projectId, confirm?}` moves a standalone project of this host
  into an org attached here, with nothing lost. Main listener only, the operator's own (refused
  through a peer, 403), or the global Overseer's for them only in the turn a click on a confirm card
  listing the project opened (403 otherwise, and to any other request carrying its header; the
  placement is recorded via the Overseer, §app.overseer/org-project-add). Without `confirm: true` it
  changes nothing and answers 409 with `code: "confirm"` and the sentence "Importing {project}
  commits its history (overseer conversations, builds, costs) to {org}'s workspace repo. It can't
  be undone."
- **Refused, changing nothing** (409 unless said): an unknown project (404); a project placed in an
  org ("{project} is already in {org}."); one already being imported ("{project id} is already being
  imported."); a project that is not quiet ("{project} isn't quiet: {what}. Try again when it is.",
  `{what}` naming each of, joined by semicolons: its overseer is working, a coding session is
  working ({titles}), a held act waits, an effect is in progress, a run is in progress); and a
  file that already exists in the org with other content ("{project} can't be imported: {path}
  already exists in {org} with other content.", `{path}` relative to the workspace).
- **The move.** The registry entry is marked `importing: {org, at}` (atomic). The project's engine
  closes, and the quiet check runs again on what it left: not quiet, the engine reopens, the mark
  is cleared and the import is refused as above. Every held chat of the project's conversations is
  closed (its viewers are told and reopen it at its new path). Then its files are copied byte for
  byte to the same relative paths: portable statecharts into the workspace's `statecharts/`,
  host-local ones into `<stateRoot>/statecharts/<org>/`, its `projects/<pid>/` and its
  `sessions/`; each log segment `<yyyy-mm>.jsonl` lands beside the org's as
  `<yyyy-mm>.imported-<pid>.jsonl`, so the project's Activity keeps its rows, interleaved by time.
  Nothing is rewritten; a destination already holding the same bytes is fine.
- The org's live engine takes the copied statecharts in without closing (the org's other projects'
  looks, replies and acts go on): an id it already holds refuses the whole set, and one that does
  not load leaves nothing taken in (the files stay; the next start loads them). The project is then
  placed (`placedVia: "import"`, §app.projects/placement), its conversations get their title, web
  origin and write guard again as after an attach (§app.organizations/portability), and the workspace
  commits the files ("Imported project {name}"). Last, its registry entry is dropped and the
  project's dir moves to `<stateRoot>/projects/.imported/<pid>-<at>/` (its host-local statecharts
  dir with it, as `host-local/`). The answer is the org's page (200). A copy or take-in that fails
  after the mark answers 409 "The import of {project} stopped: {why} It finishes at the next server
  start." and is never undone.
- Once placed, everything continues where it was: its builds, Activity, overseer conversation,
  settings, notes, costs and previews. The overseer gains the org's tools, prompt
  and look hint at its next turn, and the org's brake applies (an empty roster: every power acts as Off until someone is active or Resume).
- **Never rolled back after the mark.** A start that finds an entry marked `importing` (a crash or
  kill mid-import) finishes it: the copy again (idempotent), the org's open loads the files and
  places the project, then the re-derivation, commit and clean-up run. Until then the project opens
  nowhere and its standalone sessions are not listed.
- **The picker.** The org's Projects tab has an **Import a Project** row under the Add Project form, both behind its **Add Project** button (§app.organizations/org-page),
  shown while any standalone project is on this host: a select of them (name and folder) and
  **Import Project**. The server's confirm sentence then shows as a warning with **Import** and
  **Cancel**; Import sends `confirm: true` and says "{project} is in {org} now.", and a refusal shows
  as the tab's error. The tab's costs are read again once the list changes.
