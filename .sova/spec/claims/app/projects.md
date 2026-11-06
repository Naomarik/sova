# §app/projects — Projects: registered folders, in an organization or not
> Part of the Sova design spec · [overview](../design/overview.md)

A **project** is a folder (a git checkout root, or a plain folder) the operator has explicitly
registered. Every registered project has an icon (§app.projects/icon), a card at the top of the
overview (§app.projects/home-cards), the project page, its overseer, coding sessions with their
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
  attached org, each `{id, name, root, origin, remote?, createdAt, archived?, space, icon?}` where `space`
  is `{kind: "standalone"}` or `{kind: "org", orgId, orgName}`, and `icon` is there only while the
  project shows a picture (§app.projects/icon). It is a union read from the engines,
  never a copy.
- `#/projects` lists them as rows linking to `#/projects/<pid>` (the project's icon at 24px, a
  project on a peer showing its letters, §app.projects/icon; name, folder, and "In {org}" when
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
  arrow that folds and unfolds its sessions, set on its rows' rail axis, and the guide line
  running from it down that rail folds an unfolded project too (§app.session-list/guide-lines): open by default, the choice kept in memory for the
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

## §app.projects/home-cards — Your projects first on the overview

The overview's first section (§chat.transcript/landing-page, part 2) is a grid of project cards,
so the first thing read is which project needs you, what is waiting to land and what is running,
and a chat in any of them is one press away.

- **Which projects.** Every project registered on this host that is not archived
  (`GET /api/projects`, §app.projects/list), standalone and placed alike, in one grid: a placed
  project is never grouped under its organization; its second line names it, and the overview's
  Organizations card still leads to each org. Archived projects and the projects of your other
  computers are not shown; the Projects page lists both.
- **The head.** The `Projects` section eyebrow, with an `All Projects` link to `#/projects` at its
  right.
- **A card** (`.card.overview-project-card`), top to bottom: its head, the Chats group, the Runtime group,
  the progress zone while something moves, and the foot bar. Cards in one row are the same height,
  the foot bar pinned to each card's bottom.
- **The card's head is its Needs you band.** The project's icon at 40px (§app.projects/icon), its
  name on one line (cut with an ellipsis, the whole name as its `title`) and a second line: `In
  {org name}` for a placed project; otherwise its folder, with the home folder shortened to `~` and
  the full root as its `title`. On the right: while something in the project needs you, the count
  in large figures over `Needs you`, the head tinted in the warn tone and the card's border warn,
  as the Sessions card's is; otherwise `Nothing needs you`, muted. The head is the card's link to
  its page, `#/projects/<pid>` (§app.organizations/project-page), with a chevron.
  - `Needs you` counts the Needs-you region's rows among the project's chats
    (§app.session-list/needs-you: the same rows and the same proactivity rule, so every card reads
    `Nothing needs you` while the region would list nothing). A project's chats are the main
    threads listed as its (`SessionSummary.project` naming its id, §app.projects/folder-sessions).
- **Chats**, a caption with `{n} open` at its right, over two rows:
  - **Open chats**: the project's chats still open, neither archived nor done: the same count the
    sidebar's project heading shows (§app.projects/list). While any of them is working it reads
    `{n} · {w} working`; working is a live record saying `working`, or a web session the server
    reports busy, as the Sessions card counts it. It opens the project's page.
  - **Archived chats**: how many of the project's chats are archived. It is not a link (there is no
    list of one project's archived chats): no chevron, no hover, and a press on it opens nothing.
  - A chat that is done but not archived (an ended terminal chat) counts in neither row.
- **Runtime**, a caption with the project's memory in use at its right, `idle` while that is 0, or
  `no project setup` for a project with no project file (`.sova/project.json`), over three rows:
  - **Ready to merge**: how many branches the project's Merge Queue tab lists under `Ready to land,
    not approved` (§app.merge-queue/view), with a success dot while above 0, then `· {k} in line`
    while approved branches wait or are being checked. It opens the Merge Queue tab,
    `#/projects/<pid>/merge-queue`. A muted `…` while the queue serves the project but its first
    view since Sova started is still being read. `—` for a project the merge queue doesn't serve,
    and then the row is not a link.
  - **Running slots**: one pip per slot of the copy limit, one lit per running copy, and `{r} of
    {cap}`: the running copies against the copy limit, as the Branches tab counts them (the main
    checkout's and conformance's copies never count, §app.project-services/instances). `0 of 4`
    while none runs. `—` for a project with no project file. It opens the Branches tab,
    `#/projects/<pid>/branches`.
  - **Memory in use**: a thin bar and the figure (`640 MB`, `2.4 GB`): what the project's chats
    and running copies use now (§app.projects/home-glance). The bar fills by the project's share of
    this machine's total memory. `0 MB idle` while nothing of it runs. A
    project with no project file still shows what its chats use. It opens the Branches tab while
    the project has a project file; otherwise it is not a link.
  - A row that opens something tints on hover and carries a chevron; a row with nothing to open
    has neither.
- **The progress zone**, thin rows just above the foot bar, shown only while something moves; each
  is one link, and the zone is absent when nothing moves:
  - **Landing**, while the project's queue is checking a branch: `Landing {branch} · step {n} of
    {m}` with `~{n} min left`, a segmented meter (the landing bar's segments, §app.merge-queue/landing-bar:
    {m} counts every segment it draws), and `started {when} · takes ~{n} min · {k} in line` (no `in line` part while none
    waits). It opens the Merge Queue tab.
  - **Frozen for a release**, while a release holds the queue, landings wait on it and no run of
    the queue's is checking: `Merge queue` `Frozen for a release`, `{n} waiting` at its right, with
    "{target} is frozen for release {tag}" under it, as the Merge Queue tab says it. While a release's own check runs, the Landing row's last part reads `{n}
    waiting for {tag}` instead. It opens the Merge Queue tab.
  - **Release**, while a release is open, or published or withdrawn with steps still to finish:
    `Release {tag} · Step {i} of {n}` (`New release` until its tag is picked), the Releases tab's
    state chip in its words (`Preparing`, `Checking`, `Ready to publish`, `Publishing`, `Publish
    failed`, `Published, finishing`, `Withdrawn, finishing`; `Held for you` while its step is
    held), a segmented meter (one segment per step), and the step's name (`{label}, held for you`
    while held) with `{k} done` (§app.release/tab). It opens the Releases tab,
    `#/projects/<pid>/releases`.
- **The foot bar**, pinned to the card's bottom on the sunken tone: **New Chat** on the left,
  `Active {relative time}` beside it (the newest activity among its chats, `src/lib/format.ts`, the
  exact stamp as its `title`; `No chats yet` when it has none), the first thing cut (with an
  ellipsis) when the card is too narrow for it, and **⋯** on the right.
  - **New Chat.** One press starts a chat in the project at once, with no dialog: exactly what New
    Session's Project tab starts (§app/new-session-dialog, §app.project-overseer/new-coding-session:
    in the project root, on the project's coding model and thinking, `worktree: "later"`, so it
    cuts its own branch once the work has a name), then opens it with the composer focused. While
    it starts the button is disabled and reads `Starting…`; when the start fails the card says
    `Couldn't start a chat: {reason}`.
  - **The ⋯ menu** (`Project actions · {name}`): `New Chat…` (the New Session dialog with its folder
    set to the project's root, to pick a model, a branch or a subfolder), `Overseer` (the project's
    overseer), `Merge Queue`, `Branches` and `Settings` (those tabs of its page).
- **Nothing on the card lands anything.** Ready to merge and the progress zone only say what the
  queue and the release hold; approving a branch stays with the places that show the commit
  approved (§app.merge-queue/approve), and publishing a release with the Releases tab.
- **What updates when.** The head's count and the Chats group come from the session list and the
  attention digest the page already has: they add no read and update live. Ready to merge, Running
  slots, Memory in use and the progress zone come from one read of every card's figures
  (§app.projects/home-glance), made when the section shows and every 30 seconds while it is shown,
  with the project list's own read (also after Add Project). Until that read first answers, and
  while it fails, those three rows read `—` and the zone is absent; the next poll tries again.
- **Order.** The projects that need you first; then the most recently active (the newest activity
  among its chats, or when it was added for a project with no chats), newest first; then by name.
  The counts update live but the cards don't move while the overview is shown: the order is set
  once, on each visit, when the projects, the session list, the attention digest and the Overseer's
  proactivity have all been read (until then the cards keep the live order, so the ones that need
  you are never buried), and a project added meanwhile joins at the end, so a card never jumps
  under your finger. The next visit sorts afresh.
- **Many projects.** Up to 8 cards show, 6 while the grid is one column; under them `Show all
  {n}` shows the rest in place and `Show fewer` folds them back. With more than 8 cards (an
  archived project has none, so it never counts) a `Filter projects` search field sits above the
  grid: it matches names, ignoring case, and shows every match whatever the limit; with no match
  it reads `No project matches "{text}"`.
- **Add Project.** The grid's last tile is a dashed `Add Project` tile, always but while a filter
  is on. It opens the Add Project dialog (a folder, or Clone from GitHub; §app.projects/registration,
  §app.projects/clone), and the new project is listed once it is added.
- **Empty, loading, failed.** With no project the section holds one card: `No projects yet`, "Add a
  folder or clone a GitHub repository and it shows up here." and an `Add Project` button. Before the
  first read answers it reads `Reading projects…`; a failed read says "Couldn't read projects.
  Trying again shortly." and the next poll tries again.
- **Widths.** The columns follow the overview's own width (the `overview` container), never the
  window's: one column under 560px (a phone, a folded Fold), two from 560px (an open Fold), three
  from 900px (a desktop). The 8-or-6 limit changes at the same 560px. Every card has the same
  layout at every width; there is no compact card. Nothing scrolls sideways, and in one column
  every row and button is at least 44px tall.

## §app.projects/home-glance — What the project cards' runtime figures read, and what they cost

The project cards' Ready to merge, Running slots, Memory in use and progress zone
(§app.projects/home-cards) come from one read of every listed project at once, made by the
overview every 30 seconds while its Projects section shows and never otherwise. The read only
gathers what Sova already keeps (but for a served queue's first view, below); it lands nothing and
changes nothing.

- **Ready to merge, in line, landing and frozen** come only from the merge queue's newest view of
  that project, the one it already keeps for the Merge Queue tab and the landing bar
  (§app.merge-queue/view, §app.merge-queue/landing-bar): its `Ready to land, not approved` list, its
  waiting and checking entries, its Checking now check and estimates, and whether a release holds
  it. A project the queue doesn't serve (not listed, or its merge setup not done, as the queue
  last named its served projects) reads `unserved`: nothing is read for it and no queue is made. A
  served project whose queue has kept no view yet (after Sova starts) reads `reading`, and the
  read starts that queue's view once, in the background, deduped with any read already running;
  once kept, the view is kept up to date as every other kept view is, with no Merge Queue tab
  visit. Past that one first view the read asks the queue for no view and runs no git. So a card
  is never fresher than that view.
- **Release progress** comes from the project's release records (§app.release/record) as Sova
  keeps them in memory: as the releaser last published them to the Releases tab, or as its start
  read them; the read opens no record file. The record shown is the one the Releases tab shows:
  the open one, else a published or withdrawn one while its after-steps still have work.
- **Running slots** come from the copies' records and the copy limit's one rule
  (§app.project-services/instances): the running copies, the main checkout's and conformance's
  never counted, against the limit in force. No service is asked or probed for it. A project with
  no project file has none.
- **A project's memory in use** is two parts, each process counted once, each by its own memory as
  the resource monitor measures it (§app.resource-monitor/sampling-and-history: on Linux resident
  less shared pages; on macOS resident memory):
  - **its chats**: every chat listed as the project's (§app.projects/folder-sessions) that has a
    process, with its workers and the tools and programs they started, as the resource monitor
    charges them to the chat (§app.resource-monitor/attribution), taken from the monitor's newest
    sample (at most 5 seconds old); the read samples nothing itself.
  - **its running copies**: the processes of every copy of the project that runs now, the main
    checkout's included (an adopted main is its adopted unit, §app.project-services/adopt), and of
    its shared services, found from each unit's own process list (its cgroup's `cgroup.procs`) and
    measured as the monitor measures a chat's process (§app.resource-monitor/lightness-budget: no
    `smaps`, no PSS, nothing spawned). On a host without a systemd user manager to read (macOS),
    this part is not read and counts 0: the read never spawns `ps` for it.
- **Cost.** No command is spawned and no service is probed by the read itself; the one background
  view of a served queue that has none kept is the queue's own view read. Its cost is the copies'
  memory reads, bounded by how many copies run, and a few in-memory lookups; several overviews open
  at once share one answer, reused for up to 10 seconds.

## §app.projects/icon — A project's icon: a picture, or its letters

Every project has an icon, a rounded square beside its name: on the overview's project cards
(40px, §app.projects/home-cards), in its page's head (32px, §app.organizations/project-page) and on
the Projects page's rows (24px, §app.projects/list). The sidebar, the session list, New Session's
project picker, the command palette and the browser tab keep their look.

- **Which one shows.** A picture you uploaded; else one found in the project's folder; else its
  letters. `Use Letters` shows the letters whatever is uploaded or found, until `Use Picture`.
- **Found in the folder.** Sova looks, in this order, at: `.sova/icon.png`; the PNG icons declared
  by the first web app manifest that parses, of `public/manifest.webmanifest`,
  `public/site.webmanifest`, `public/manifest.json`, `static/manifest.json`,
  `manifest.webmanifest` and `manifest.json` (an icon whose `src` ends in `.png` or whose `type` is
  `image/png`, whose `purpose` is absent or includes `any`, the largest declared size first, its
  `src` resolved against the manifest's own folder, a leading `/` meaning that folder); then
  `public/apple-touch-icon.png`, `public/icons/apple-touch-icon.png`,
  `static/apple-touch-icon.png`, `apple-touch-icon.png`, `app/icon.png`, `src/app/icon.png`,
  `app/apple-icon.png`, `public/icon.png`, `public/logo.png`, `icon.png`, `logo.png`,
  `assets/icon.png`, `assets/logo.png`, `build/icon.png`, `resources/icon.png`,
  `src-tauri/icons/icon.png` and `src-tauri/icons/128x128@2x.png`. The first that passes every
  check is used: a regular file, never a symlink, whose real path stays inside the project's folder
  (a manifest `src` with `..` out of it, or with a scheme, is skipped), at most 1 MB, a PNG by its bytes (not by its name), at least 64px on its short
  side and nearly square (the long side at most 1.25 times the short), so a wide wordmark or a
  tiny favicon is skipped. A found icon is a PNG only: an SVG in the folder is never used. Sova
  only reads the folder, never writes to it, and notices a new or changed icon file within about
  30 seconds.
- **The Icon card**, first on the project's Settings tab: the 40px icon, where it comes from
  (`Uploaded`, `Found in the project: {path}` or `Letters`), `Upload Image…` (`Replace Image…` once
  one is uploaded), `Remove Image` while one is uploaded (back to the found picture or the
  letters), `Use Letters` while a picture shows, and `Use Picture` while letters are on and a
  picture is uploaded or found, under the line "Shown on Home, on this page and in All Projects.
  PNG, JPEG, WebP, GIF or SVG, up to 5 MB; kept on this computer only." Opening it looks in the
  folder again. After a change every icon of the project on the page shows the new one; a change
  that fails shows "Couldn't change the icon." with the reason. Uploading turns Use Letters off. A
  project on a peer has no Icon card.
- **Uploading.** PNG, JPEG, WebP, GIF or SVG, up to 5 MB ("This image is over 5 MB."). The page
  draws it into a 256×256 square, fitted whole with see-through margins, never cropped, and sends
  that PNG; a file it can't decode or draw says "This image can't be used. Try a PNG." The server
  takes only a square PNG of 64 to 1024px, at most 1 MB: over that 413 "The image is over 1 MB.";
  anything not a PNG 415 "Only a PNG is accepted (the page converts other images)"; not square or
  out of range 400 "The image must be square, 64 to 1024 px."
- **Kept on this computer only.** The upload and the letters choice are this host's state
  (`<stateRoot>/project-icons/<pid>.png` and `<pid>.json`; the folder `0700`, the files `0600`,
  written atomically), never written into the project's repository, kept by project id through
  archive, unarchive, placement and import, and not shared with an organization's people or your
  other computers. A project listed from a peer shows its letters.
- **On the wire.** `ProjectSummary.icon` (`{kind: "image", source: "upload" | "found", v}`) is
  there only while a picture shows, on this host's own projects; `v` changes whenever the picture
  does. `GET /api/projects/:pid/icon` answers the PNG, read fresh, with `Content-Type: image/png`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`,
  cached as immutable for a year when `?v=` is the current `v` and `no-store` otherwise; 404 while
  the letters show or for an unknown project. `GET …/icon/info` answers `{use, letters,
  uploaded?, found?}` (`use` one of `upload`, `found`, `letters`), looking in the folder afresh;
  `PUT …/icon {png}` uploads (base64), `PATCH …/icon {letters}` turns the letters on or off and
  `DELETE …/icon` removes the upload, each answering the same info. The writes are the operator's
  own: one carrying the Overseer's sender mark is refused (403, "Only you can change a project's
  icon.").
- **Letters.** Two letters, like an avatar. The name splits into words on spaces, `-`, `_`, `.`,
  `/` and a lower-to-upper case change; with two or more words, the first letter of each of the
  first two, in capitals (`Landing Site` LS, `acme-api` AA, `LandingSite` LS). One word: its first
  letter in capitals and its second in lower case (`Sova` So, `x` X), or, for a word all in
  capitals, its first two as they are (`API` AP). A name with no letter or digit shows its first
  character (an emoji); an empty one `?`. They are white, semibold, at 40% of the tile, on one of 8
  fixed colours (`#2F6690`, `#1F7A72`, `#5E7A1F`, `#8A6512`, `#A4502A`, `#A63D5C`, `#7A4E9C`,
  `#4F5D75`), each at least 4.5:1 against white and none of them Sova's accent, so a tile never
  reads as a button. The colour comes from the project's id, never its name, so a rename keeps it.
  The letters are hidden from screen readers: the name is always beside them.
- **Drawn.** A picture sits whole on a `--color-sunken` tile with a 1px `--color-border` inset, so
  a transparent logo reads in both themes; one that fails to load shows the letters instead.

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
  operator's own coding sessions also reach Recent (§app.session-list/recent); one the project's
  overseer started doesn't. Either can join a group (§app.session-list/groups), as can the
  project overseer's conversations.
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
