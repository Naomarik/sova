# §app/projects — Projects: registered folders, in an organization or not
> Part of the Sova design spec · [overview](../design/overview.md)

A **project** is a folder (a git checkout root, or a plain folder) the operator has explicitly
registered. Every registered project has the project page, its overseer, coding sessions with their
worktrees, costs, previews and running instances (§app/project-services), whether or not an
organization places it. An organization only **places** a project and adds its own concerns
(stakeholder, people, outreach, owner updates, requirements; §app/organizations). The project
layer never knows organizations exist (§app.projects/seam).

Pages: `#/projects` (the list) and `#/projects/<pid>` (one project, §app.organizations/project-page),
`…/requirements` (only while placed), `…/cost`, `…/settings`, `…/overseer`, each taking `?host=<peer>`
for a project held on a peer (§mesh.remote-sessions/org-pages). API: `/api/projects` and
`/api/projects/:pid/…` for every project-layer read and act; the organization's concerns stay under
`/api/orgs/:id/projects/:pid/…`. There is no other address for a project and no alias.

## §app.projects/registration — A folder becomes a project only when the operator adds it

- Three ways, each the operator's own (main listener only): **Add Project** on the Projects page
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

## §app.projects/standalone — A project in no organization

- A standalone project has an engine of its own, the same as an org's
  (§app.project-overseer/statecharts), whose dir `<stateRoot>/projects/<pid>/` has the workspace
  layout: `statecharts/` (its portable statecharts and log), `sessions/` (its overseer conversations)
  and `projects/<pid>/` (overseer settings and files, costs, usage); its host-local statecharts are
  under `<stateRoot>/statecharts/<pid>/`. It opens at server start and when it is registered, and a
  restart reopens it with nothing lost.
- It is host-local and in no git repo: it can't be cloned or attached elsewhere (an organization
  importing it is a later step).
- Its sessions are listed and opened like an org's project's: its overseer conversations are
  accepted session paths, its coding sessions are ordinary sessions in their worktrees.
- Its overseer runs at the level the operator set (default L1): no roster caps it
  (§app.project-overseer/autonomy-levels).

## §app.projects/list — The Projects page and the sidebar's Projects region

- `GET /api/projects` lists every project known here: the standalone ones and those placed in each
  attached org, each `{id, name, root, origin, remote?, createdAt, archived?, space}` where `space`
  is `{kind: "standalone"}` or `{kind: "org", orgId, orgName}`. It is a union read from the engines,
  never a copy.
- `#/projects` lists them as rows linking to `#/projects/<pid>` (name, folder, and "In {org}" when
  placed), archived ones apart, with **Add Project** opening the Add Project dialog (Folder ·
  Clone from GitHub).
- The sidebar has a **Projects** region for standalone projects, shaped as one organization's
  project blocks in the Organizations region (§app.session-list/organizations): the project heading
  with its overseer's eye, then its Builds. Its head carries **+** (Add Project) and an arrow to
  `#/projects`; each project heading's name opens its page. With no project it says "No projects
  yet. Add a folder or a GitHub repository with +." It is listed once the session list loads, even
  empty, except when a search finds nothing in it. Where Needs you names where an item of a standalone project
  waits, it says Projects.

## §app.projects/seam — The project layer never knows organizations exist

- The project layer is the statecharts `project/<p>`, `watch/<p>` and `build/<p>/<s>` and the
  server's project modules (registry, engines, routes, clone, project root, the project overseer,
  costs, previews, worktrees, coding mode, running instances and the engine plumbing). None of it
  holds an org id, builds an org statechart's id, reads an org key or imports an org module at
  runtime, directly or through another module.
- The org layer may address the project layer: it spawns builds for its gaps, notes reasons for
  the watch loop, and contributes, through registration points the project layer offers, the
  ceiling on its overseer's level and its people, a look hint, overseer tools and prompt sections,
  archive blockers, session kinds and the roots a project may not use.
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

## §app.projects/conversion — The one-time move to org-free project ids (temporary)

- Existing org projects move once, with the server stopped, by a throwaway script
  (`scripts/oneshot-general-projects.mjs`, never part of the server): the project, watch and build
  statecharts' ids and files lose their org segment, their snapshots lose the org id, and preview
  records lose `orgId`. It refuses while the server runs, while a redo journal is not empty, or when
  an old and a new name exist side by side, and a second run changes nothing.
- At the next start the project statechart's version 2 migration drops the org states and keys
  from each project snapshot, and the org-open rule above gives each project its placement. A
  project's stakeholder is picked again by the operator.
- The script and the migration are deleted once the live move is done; a known backup taken
  before it (`scripts/backup-general-projects.mjs`, restored by
  `scripts/restore-general-projects.mjs`) is the only way back.
