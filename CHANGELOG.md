# Changelog

What changed in each Sova release, newest first: the highlights, written by hand, not a commit
list. The install command installs the newest release (the `stable` tag); `SOVA_REF=vX.Y.Z` installs
or keeps one release. How a release is cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## v0.9.0 — 2026-10-26

A new owner page, dependable landings, a waiting badge in the composer, and git that cleans up
after itself. 149 commits since v0.8.0. The highlights:

- **The owner page, redone.** Sova's mark with a light/dark toggle, the org as its title, instant
  send, paged chats, and Conversations on Home. Owners can close and reopen their own requests, and
  the Project Assistant does it on their yes, says what's new, and labels each version plainly.
- **Landing you can rely on.** Land It lands the exact commit it showed; a newer commit replaces
  the card ("Replaced by a newer commit"), and offer cards appear in Needs you. Typing "land it" in
  a branch's own chat is your go-ahead too. Merge-ready schedules wake as soon as a branch turns
  Ready to land.
- **One waiting badge.** Messages waiting for a busy chat show as one badge in the message box,
  with a Waiting on you dialog; every typed message is a steer, and messages sent while a chat is
  busy land together.
- **Git looks after itself.** Projects get git's scheduled maintenance, a killed cleanup's locks
  are recovered, and the new session card shows the git folder's size and when cleanup is stuck.
- **Memory size moves to Settings.** Summary size is set in Settings → Memory, no longer in the
  mode menus.
- **Drawings and tours.** Flow drawings draw questions as hexagons, never cut words, and a shape
  can be tapped to follow it; a tour shows one card per chat, and Next and Back never freeze it.
- **Sidebar.** A group's guide line collapses it, and the list keeps its scroll position.
- **Smaller fixes.** Review Changes reads a removed worktree's commit from another folder; the
  site deploy refuses to run without its hero video.

Going back to `v0.8.0` (`SOVA_REF=v0.8.0`) hasn't been tested on this release: a summary size set
in Settings → Memory is new stored data that v0.8.0 doesn't read.

## v0.8.0 — 2026-10-24

Feature request chats, a team inbox, Landing cards for the merge captain, and a quieter Sova when
idle. 212 commits since v0.7.0. The highlights:

- **Feature request chats.** The Project Assistant can open a planning chat with an owner about
  what they asked for; Needs you lists the agreed plan as its own item and names who opened the
  chat. The Project Assistant has one host-wide default model, which an org can override.
- **The Project Overseer sets up the whole project.** It proposes changes on a Settings change
  card; you apply them, and All settings keeps a history with Undo.
- **Landing cards.** When a branch is Ready to land, Sova shows its session a Landing card: Land It
  is your go-ahead for that exact commit, Not Yet holds it. An owner's READY alone never lands a
  branch.
- **Team inbox.** Each team member has an inbox on the Session detail pane; Sova's notices and
  handovers arrive as items, and fewer team starts fail. Members keep their inbox at zero: a reply
  closes an item, the team screen shows what closed automatically, and reports list what was left
  open.
- **Teams keep running when a model runs out.** A coordinator or monitor that fails at runtime moves
  to its fallback model; only real out-of-usage marks a model out, short-window quotas count as rate
  limits.
- **Clearer decisions.** One turn card per finished turn, alignment questions carry a stakes chip,
  Needs you names the kind of wait, and worker rows show Untested when a report ran no checks.
  Alignments default to the Project manager writing style.
- **Markdown in place.** Markdown blocks render in the chat, with a View Rendered viewer, and a
  context file's or skill's name on the Setup card opens it.
- **Costs.** The Costs tab and a session's Usage tab show the cache hit rate, and By project groups
  folders into projects.
- **Composer +** opens the Commands palette, led by this chat's own actions.
- **Quieter when idle.** The session list, attention and Overseer state are pushed on change
  instead of polled every few seconds, so an idle Sova uses far less CPU.
- **Project copies.** The copy limit counts running copies and is set per machine on the Branches
  tab; port numbering comes from the main checkout's saved definition, and workers can run their
  own copies.
- **Smaller fixes.** The Project Assistant offers only what would happen now; switching back to a
  short chat keeps following instead of showing Jump to Latest. A session whose folder is gone opens in the home folder instead of failing;
  stuck memory recovers on its own; the Focus button lines up with the composer; the README is a
  new front door.

Going back to `v0.7.0` (`SOVA_REF=v0.7.0`) hasn't been tested on this release: team inbox items,
per-turn outcomes and the Project Overseer's settings history are new stored data that v0.7.0
doesn't read.

## v0.7.0 — 2026-10-22

The Project Assistant grows up, owner requests get a home, and a focus view for reading a chat.
38 commits since v0.6.0. The highlights:

- **A real Project Assistant on the owner page.** It fills the phone with the composer pinned at
  the bottom, takes photos (when photos are on and the reply model sees images), draws, and can
  start a version for the owner to try when you allow it; with that off, it files a request
  instead. A started version shows Starting… until it answers.
- **"What it can do for you".** The owner page has Home, Assistant and Requests tabs, and a card
  that says what the assistant can do from the switches you set, with tappable suggestions.
- **Owner requests on the org page.** A Requests tab lists what owners asked for (Open, Done,
  Declined), and Start Chat opens a chat in the request's project with the request as a note.
- **Public links, share protocol 2.** Your computer decides which pages of its links open, so new
  pages need no gateway update. **If you run a gateway, update it once:** Settings → Public links
  warns when it is behind and offers Resync.
- **Focus view.** A corner button in a chat hides everything but its title and the conversation;
  your draft is kept, and the choice stays across chats and reloads.
- **The Overseer can round up the work**: what is still open in each session over a window, and a
  search of what sessions said.
- **Smaller fixes.** The Timeline names who sent a message, and Inputs Only counts what you typed;
  the sidebar keeps its scroll position through refreshes and a collapse sticks; a chat that
  finished starting early says it is ready at once; the mode menu says when someone other than you
  turned a mode's hooks on.

Going back to `v0.6.0` (`SOVA_REF=v0.6.0`) hasn't been tested on this release: the owner page's
tabs, requests and assistant versions are gone there, and a gateway already updated to share
protocol 2 hasn't been tried with it.

## v0.6.0 — 2026-10-19

Guided tours, everything as a command, and the Overseer's approvals in its head. 63 commits since
v0.5.0. The highlights:

- **Guided tours.** Ask a chat for a tour of a real feature: with vis on, it records checked
  step-by-step views at desktop and phone size, and you read it with Back and Next, share it by an
  expiring link that shows exactly the edition you reviewed, or attach it to a hand-off. A recording
  that needs a sign-in waits for you on the tour card and in Needs you.
- **Everything is a command.** Sova's actions are one catalogue: the command palette, the `sova`
  command line (`sova list`, `sova run`), extensions' own keys and places, and remote commands
  across the mesh all reach the same actions. A project mode can now ship **commands** you and
  scripts run by name, and **hooks** that run after a reply; only you approve a mode's hooks, never
  the Overseer.
- **Approvals & Schedules move to the Overseer's head.** They left the composer for a Schedules
  menu in the head (the first item of ⋯ on a narrower window), with a dot while a schedule waits for
  your approval.
- **Overseer card clicks never get lost.** A click that doesn't reach the Overseer brings its
  buttons back with "Your click didn't reach the Overseer. Click again." instead of becoming typed
  text, and an approved act runs before the card records its answer.
- **The Overseer can send an owner their page link** on WhatsApp, as your act only.
- **Steadier chat starts.** A failed start retries once quietly before it says "This chat didn't
  start.", and old failure banners leave once a newer turn starts.
- **Spec tools.** Agreed stamps say where the go-ahead was given, every area says what it doesn't
  own, merges of a spec go block by block, and the list of sections to read is shorter and ranked.

Going back to `v0.5.0` (`SOVA_REF=v0.5.0`) hasn't been tested on this release: a project mode that
declares commands or hooks shows as broken there, and the Overseer's approvals return to its
composer chip.

## v0.5.0 — 2026-10-19

Chat powers, a Folders sidebar and steadier chat starts. 53 commits since v0.4.0. The highlights:

- **Switches replace overseer levels.** A project overseer's powers are On/Off switches in two
  columns, what it may do on its own and what the client's Project Assistant may set off, instead
  of levels L0–L3. Your old level carries over (what it allowed is On, the rest Off). While a brake
  holds, every switch acts as Off and draws held; what you set is kept.
- **Every chat can read the project's spec.** Chats look up the product documentation on their own,
  and each conversation that gathers requirements writes its own spec draft, locked in only by an
  explicit yes.
- **The owner page gets the Project Assistant.** Versions to try behind the owner link, models per
  kind of work, outage alerts, and an owner link that turns off after 7 days unused.
- **Folders replaces Live & web.** The sidebar's top region is called Folders, sits under Projects
  and folds like it; a session a project already lists isn't repeated there.
- **Chats start more reliably.** A slow start names the step it is stuck in, a late hello no longer
  gives up early, and a reader who scrolls up while a chat streams stays where they are.
- **One update banner.** Every tab learns that Sova changed through the same banner, mesh on or off;
  the bottom-right "Sova was updated" note is gone.
- **Smaller fixes.** Less idle CPU, no Review Changes on a branch without commits of its own, and
  the changes viewer refuses an empty comparison instead of showing a different change.

Going back to `v0.4.0` (`SOVA_REF=v0.4.0`) hasn't been tested on this release: each project overseer
runs at a level Sova saved beside its switches, never looser than they were, so it may be allowed
less than here; the switches stay stored and return when you upgrade again.

## v0.4.0 — 2026-10-16

Memory for the Overseers, side-by-side steps drawings and a faster project page. 45 commits since
v0.3.3. The highlights:

- **Overseers remember.** The Overseer and project overseers run with memory on by default, and a
  project overseer has its own switch. Memory's view shows session ids whole, and the model is told
  to look a thing up in its memory before searching for it.
- **Steps drawings put paths side by side.** A steps drawing shows its paths in columns, with steps
  they share merged into one.
- **The project page opens at once.** It shows its sessions and the last cost count straight away
  and fills in branch details behind them. In the sidebar, each project folds on its own, New
  Session opens on its project, and Add Project is gone.
- **Messages sent while a chat starts arrive.** A message sent while its chat is waking, or left
  unsent when a page closes, is delivered by the server instead of being dropped.
- **Smaller fixes.** The Subagents row counts only live workers and names the ended ones in its
  tooltip; the changes viewer refuses a folder it can't open instead of showing nothing.
- **Docs.** Every Docs page was checked against the product documentation, and there are new
  Memory and Updates pages.

Going back to `v0.3.3` (`SOVA_REF=v0.3.3`) hasn't been tested on this release: overseers there run
with memory off, and a project overseer's own memory switch stays stored but unused.

## v0.3.3 — 2026-10-15

Updates from inside Sova, project modes, reply timings and a faster chat open. 198 commits since
v0.3.2. The highlights:

- **Sova updates itself.** Settings → General has an Updates section: it says what runs, checks
  Sova's repository daily (or now, with **Check Now**), and upgrades in a job of its own; a dot on
  Settings says when an update is waiting. Upgrade automatically never reinstalls a version that was
  put back.
- **Project minor modes.** A project can ship its own minor modes; they show in the chat's mode
  menu and turn on after you approve the mode's folder. Workers get their parent's project mode
  tools.
- **Reply timings.** A measured reply shows a timing card on its head, and the Agents page has a
  Performance tab.
- **Chats open at once.** A chat opens on its saved rows while it starts, and opening a sleeping
  chat (or selecting its workspace tab) starts it. A quiet chat closes after its idle time even with
  a tab open.
- **The changes viewer** shows each step's commits, keeps empty steps greyed with their reason, and
  orders commits by history.
- **Sidebar and Settings.** The sidebar's search is always on, the Overseer button lists project
  overseers with their unread replies, and multi-select and the Profiles section are gone. In
  Settings, **Cancel** discards unsaved edits and closes; Discard Changes is gone.
- **Resource monitor** says clearly how much memory Sova uses, and the server holds less of it.

Going back to `v0.3.2` (`SOVA_REF=v0.3.2`) hasn't been tested on this release: project mode
approvals, update settings and reply timings stay stored but unused.

## v0.3.2 — 2026-10-13

A macOS fix on top of v0.3.1.

- **Sova.app runs natively on Apple silicon.** macOS started the app, and the browser window it
  opens, under Rosetta: the first launch took about 25 seconds, macOS warned that the app "will not
  open in a future release of macOS", and the window was slower. Both now run natively. Re-run the
  install command to get the fixed app entry. Intel Macs are not supported.

Going back to `v0.3.1` (`SOVA_REF=v0.3.1`) changes no stored settings or sessions.

## v0.3.1 — 2026-10-13

A fix on top of v0.3.0.

- **Delegate finds Claude Code workers again.** Since v0.3.0 the Delegate mode reported every
  Claude Code profile as having no available worker, because it looked for Claude Code where it no
  longer registers. It now reads the same Claude model list the model picker uses, so the Planning,
  Investigation and Implementation profiles start their Claude Code workers as before.

Going back to `v0.3.0` (`SOVA_REF=v0.3.0`) changes no stored settings or sessions.

## v0.3.0 — 2026-10-13

Every chat now runs in a process of its own. 353 commits since v0.2.0. The highlights:

- **A server restart cuts nothing off.** Each chat, worker, team member and hidden chat keeps
  running through a restart or an update of the server, a reply in flight included; open browsers
  reconnect by themselves. A server-hosted tool that was running when the server stopped reports
  "outcome unknown" to its chat and is never retried.
- **New code reaches a chat at its next quiet moment.** A chat keeps the code it started with and
  shows **On older code** until it reloads on its own, or until you press **Reload Now**.
- **Chats outlive the server.** With no server, a chat exits by itself once it has been idle for
  its idle time; `bun scripts/stop-chats.ts` stops every recorded chat at once.
- **A chat cut off mid-reply picks up again.** A chat whose process died mid-run is resumed once
  by the next server, even across a restart, and never twice.
- **Steadier workers.** A worker start interrupted by a restart is finished when its parent asks
  again, and a finished worker's wake reaches its parent even when the first try fails.

### What you must do differently

- **Chats need Bun.** A server started on Node (`sova --node`) runs no chats or workers: opening
  one is refused. The default `sova` runs on Bun.
- After updating, open chats show **On older code** until they reload; nothing is lost.

To go back, install `v0.2.0` with `SOVA_REF=v0.2.0`, after stopping every chat
(`bun scripts/stop-chats.ts`); going back hasn't been tested on this release.

## v0.2.0 — 2026-10-13

The first stable release. The install command now installs the newest release instead of
`master`:

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash
```

Re-running it updates to the newest stable release; an install of `v0.1.0` moves to `v0.2.0` the
next time it runs this command. About 3,400 commits since v0.1.0 (2026-09-22). The highlights:

### Install and run

- **Runs on Bun.** The server runs on the Bun version Sova is tested on, which the installer
  downloads into the install directory and checks against a recorded checksum. `sova --node` runs
  it on Node instead.
- **Sova in your app launcher.** The installer adds a **Sova** entry that opens the app already
  signed in, in a window of its own (`sova open` does the same from a terminal), and offers a login
  service on macOS (launchd) and Linux (systemd).
- **One access token per install.** Every browser signs in once; `sova open` passes the token for
  you, and a phone pairs with a one-use QR code.

### Working with agents

- **Memory**, a minor mode that lets a long chat outgrow its context: a cheap model folds older
  messages into summaries the model can open back up, and the transcript you read never changes.
- **Settings → Alignment**: align's writing style, its Visuals, and an adversarial review that has
  a fresh, read-only reviewer check the plan and the diff of risky work.
- **Subagent profiles** keep Delegate's routes under one name; workers come back as idle entries
  after a server restart.
- **Worktrees and the changes viewer**: a session tracks the git worktrees it works in, and what it
  changed reads as numbered steps, each with the agent's why.
- **The Overseer**, a session that reads all the others: it says what needs you, starts and prompts
  sessions, and confirms first when a request is risky.
- **Claude Code models** in chat and in workers, across several Claude logins with failover on a
  usage limit (logins read from the macOS keychain too).
- **A sandbox per session**, playbooks and schedules, and inline diagrams and charts (vis).

### Away from the desk

- **Your phone**: add Sova to the Home Screen, pair once, and get a push notification when a
  session needs you.
- **Share links**: read-only links to a session or part of it, as a snapshot or live, on an address
  you set up.
- **Mesh (preview)**: list and drive the sessions of every Sova host on your tailnet from one page.
- **Organizations (preview)**: hand one conversation from person to person, each through their own
  link, and keep every decision.

### Also

- A usage page, a resource monitor that charges load to the session that caused it, model rules,
  and local voice input.
- A website with docs for every mode and feature.

If you go back to v0.1.0 (`SOVA_REF=v0.1.0`), settings and sessions this release wrote may not read
the same there.
