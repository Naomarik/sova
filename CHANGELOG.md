# Changelog

What changed in each Sova release, newest first: the highlights, written by hand, not a commit
list. The install command installs the newest release (the `stable` tag); `SOVA_REF=vX.Y.Z` installs
or keeps one release. How a release is cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## v0.16.0 — 2026-11-12

Lookbooks that use your design skills and pasted screenshots, a recall tool for memory chats, one
shared folder per chat for its workers, and approvals that answer at once. 11 commits on the main
line since v0.15.0 (6 merged branches). The highlights:

- **Lookbook: the Creative Director.** The Lookbook's coordinator is now called the **Creative
  Director** everywhere you read it: the Setup dropdown, **Start Creative Director**, its questions
  and **Open Creative Director** in the Gallery tab.
- **Lookbook: design skills.** A Lookbook loads no skill and no project file by itself. Name a design
  skill to your chat ("use the brand skill", or a folder holding a `SKILL.md`) and Setup lists it
  under **Design skills**; one that can't be found becomes a question on the brief. The Creative
  Director reads them (it can also read files you point it to, but writes and runs nothing), picks
  which ones the designers use, and the brief's **Design skills** line shows that choice. A designer
  reading its skill says **Reading the design skill** on its tile, and the estimate counts it.
- **Lookbook: screenshots.** A screenshot you paste joins the Lookbook's images as a **Screenshot**,
  with up to 8 colours measured from its pixels and **words for designers** (its feel and what each
  colour is for), which you can change with **Edit Words**. Before Start, each ticked screenshot needs
  **Rebuild This Screen** (designers that read pictures get it attached, up to 4 reference pictures a
  design) or **Just Its Feel** (words and colours only). Images attached when you ask for a Lookbook
  now join the run and show in Setup's image row.
- **Memory: recall.** Every memory chat has a new **recall** tool that finds earlier messages by their
  words, closest match first, each dated in your local time; zoom and date show the same local dates.
- **One shared folder per chat.** A chat and its workers now share one folder, outside the project,
  for briefs, reports, alignment files and team handover notes. A write-only worker gets its own
  private `/tmp` and private mise and pnpm state, and a confined worker is told what it can reach.
- **Approvals answer at once.** On a new chat's setup card, **Approve** and **Disallow** show their
  answer immediately with no jump, and Send waits only for answers still being saved.
- **Smaller changes.** Test runs no longer write outside their own scratch folders.

**What you may need to do:** Nothing. To give a Lookbook a design skill, name it to your chat when
you ask for the Lookbook.

Going back to `v0.15.0` (`SOVA_REF=v0.15.0`) hasn't been tested on this release. v0.15.0 doesn't know
a run's design skills or screenshot words, so an open Lookbook loses them there; chats' shared
folders stay on disk, unused.

## v0.15.0 — 2026-11-11

Skills and context files you decide on per project, a Context tab that shows which skills a chat and
its workers actually read, and a merge queue that keeps every finished entry. 53 commits since
v0.14.0. The highlights:

- **A project's Skills and Context Files.** The project page's Settings tab has two new cards,
  **Context Files** and **Skills**, listing everything a chat in the project (its folders and its
  worktrees included) could load. **Disallow** keeps one out of new chats; open chats keep what they
  have. A folder that is no project has the same lists, from a new chat's setup card (**Edit Folder
  List**), and so does the Overseer's folder.
- **Ask first, if you want it.** Settings → General has one new switch, **Allow context files and
  skills without asking**, on by default, so nothing changes until you turn it off. Off, anything you
  haven't approved stays off: a new chat lists what waits ("{n} to approve for this project"), with
  **Approve All**, **Disallow All** and a button per row, and holds Send until you decide. A skill or
  file that changes after you approved it is marked **Changed since you approved**. Each chat's list
  is fixed at its first message, and its workers get the same one. Turning the switch back on is your
  own page's click only.
- **Which skills were read.** The Context tab's Whose context has a new **Everyone** view: every
  skill this chat and all of its workers opened over the whole history, most opened first, with a
  sheet per skill naming the chats that opened it, and the skills offered that nobody opened.
- **Merge queue history.** Every finished entry is now kept for good in a per-project history on
  this computer, so `merge.status` and `merge.logs` still find an old entry after it leaves the
  view. Each run's copy of the branch's drafts is deleted when the run ends.
- **Quieter, faster.** Repeated identical timeline markers fold into one row ("coordinator finished
  ×31" with its time range). The session list is built once and kept until something in it changes;
  the session feed is serialized once for every window; chats untouched for 30 days let go of their
  scan memory; refreshing a project page no longer adds "Git was checked" history lines when nothing
  changed.
- **Smaller changes.** A group's pane menu says **Archive** where it said Eliminate.

**What you may need to do:** Nothing for most installs: with the new switch on (the default), every
context file and skill loads as before unless you disallow it. To be asked first, turn **Allow
context files and skills without asking** off in Settings → General.

Going back to `v0.14.0` (`SOVA_REF=v0.14.0`) hasn't been tested on this release. v0.14.0 doesn't know
the approval list or the switch, so every context file and skill loads again, disallowed ones and
chats started in asking mode included; the decisions stay in their files and return if you update
again. The merge queue history stays on disk, unread.

## v0.14.0 — 2026-11-10

Lookbooks, Discard Branch, `!` commands in your own zsh, and a Claude model list that keeps itself
up to date. 266 commits since v0.13.0. The highlights:

- **Lookbook.** With vis on, ask a chat for a Lookbook ("a Lookbook of my pricing page, all Claude
  models") and several hidden design sessions each build a complete prototype of one page, each in
  its own style, on the models you tick. **Lookbook · Setup** picks the models, a coordinator, a
  Style (20, in 5 families) and a Layout, and how each link you paste is used. The coordinator
  writes a Design Brief with its questions; after **Start**, the pages draw live side by side on
  the card and in the session pane's new **Gallery** tab, labelled A, B, C so you can refine, talk
  to and combine them by name. Back, Forward and the address follow the design you have open. An
  ordinary "mock up a login page" still gets a quick drawing.
- **Discard Branch….** The last item of the Land ▾ menu, on Ready rows and in a chat's Worktrees
  list, throws a branch away in one step: its folder, the branch itself, its drafts, and the chats
  idle in its folder, which are archived. It checks first and lists exactly what goes (commits the
  target doesn't have, each kind of file, drafts, folder, chats), says no backup is kept, and asks
  again if anything changed before you confirm. A chat still running there, or a branch checked out
  in two folders, is refused with the reason.
- **Shell mode runs in your zsh.** When your login shell is zsh, a `!` command from the composer
  runs in zsh with your profile and `.zshrc` (or `$ZDOTDIR`'s) loaded first, so your aliases and
  functions work; their output stays hidden. The sandbox loads the same setup. The agent's own
  commands are unchanged, and any other login shell runs as before.
- **Claude models follow Claude Code.** Sova reads Claude Code's own model table at each start and
  remembers it, so a new Claude model appears in every picker (Profiles, the Overseer, Summaries,
  Session titles) with no restart, and a model Claude Code drops leaves the pickers. Settings says
  when it shows the last list it could read. Fable 5.2 is built in; Fable 5.1 becomes previous.
- **Subfolder skills and Claude skill folders.** Skills in a project's subfolders are offered as
  the agent starts working there, for Claude Code chats and workers as well, and skills in Claude's
  own skill folders are found too. The Context tab's **Skills offered** sheet counts partly read
  skills on their own and lists them after the read ones; a skill marked Manual only says so under
  its name.
- **Worktree rows tell the truth.** Rows, the Ready list and Land all use one answer to "is there
  anything of this branch's own left to land?", read against the branch the project actually lands
  on, so a project whose target isn't named master or main reads right: Ready only when truly
  ready, Landed only while nothing is left, Drafts to land when only drafts remain. Finished rows
  offer **Remove**.
- **Smaller changes.** A Setup proposal's chip in Needs you says where the proposal stands, so it
  no longer says Ready while a trial runs. Discard Branch's confirm spans the whole row.

**What you may need to do:** Nothing for most installs. Automatic worktree cleanup ships switched
off ("Automatic cleanup is switched off for now."): finished worktrees stay until you press
**Remove**, and Land never waits for a cleanup rehearsal. Setting `SOVA_RETIRE=on` for the service
opts in; when it does, landed branches are kept unless Settings → Merge Queue → **Delete branches
when cleaning up** is on.

Going back to `v0.13.0` (`SOVA_REF=v0.13.0`) keeps your settings and sessions. Lookbook designs
stay in their chats' files but don't show there, and the remembered Claude model list is ignored,
so the pickers fall back to v0.13.0's built-in list.

## v0.13.0 — 2026-11-09

One Profiles tab for how a chat starts and which models it uses, a merge queue that gets fixes made
by the branch's own chat, and charts you can look at in other ways. 191 commits since v0.12.0.
The highlights:

- **Profiles.** Settings → Profiles replaces the Subagents tab and is the one place profiles are
  listed and edited. A profile now has two parts: **When a Chat Starts** (modes, tools, a first
  message) and **Models** (the chat's own model and effort, and its helpers). A chat can switch its
  whole Models part at any time from the mode menu, or from the usage-limit row when a provider runs
  out. It either all switches or nothing does, and it waits for a running reply to end. Each
  computer has one default profile, set with **Make Default**. It decides everything a new chat
  starts with, and replaces the separate default modes, new-session model and default subagent
  profile.
- **The merge queue fixes more by itself.** After your Land, a failing check, a conflict or a review
  finding that belongs to the branch goes back to the branch's chat as a request. The chat answers
  Fixed, Needs you or Can't, and the branch goes back in line by itself, up to 3 tries. Your one
  Land covers those fixes. You are only stopped for your own decisions, on the branch's card.
- **Review cards and the Merge Queue tab.** A blocking review now shows as a Review found issues card
  in the chat that has to fix it, with the reviewer's whole report, and Landed keeps the review's
  notes. The Merge Queue tab shows Checking now and Waiting on every tab, over tabs for Ready to
  land, Needs you, With its chat, Landed and Queue chats. Each tab has its own address, so reload
  and Back keep it.
- **Charts.** A chart in a chat or a share can be switched to another view (Bar, Line, Parts and
  more, where they fit its data), with Log, Sort and % toggles, kept for the tab. **Copy** on a
  drawing now copies it as a picture while the drawing shows, and the source while Source is open.
- **Teams.** Every team now gets Sova's coordinator and monitor. Team members follow Delegate's four
  work kinds, so a member named with a kind runs on your profile's model for that kind. A team's
  question now reaches its chat at once, and ends the chat's wait for the team.
- **Which branch, which project.** Each branch row in a chat has a line naming its project and where
  it merges; tap it for the exact folders. Land's confirmation, the queue card and request cards name
  the project too.
- **Smaller changes.** A project card's Copies row draws one pip per place (running, stopped, used
  elsewhere or free), so it no longer looks like there's room when there isn't. The Context tab says
  Partly read, with the line count, for a skill that was only skimmed. The Settings dialog is bigger
  on wide windows and no longer slides inside its frame when you click a switch low in a long list.
  Tab strips fade at an edge only while tabs are hidden past it, in Firefox too.

**What you may need to do:** Look for Settings → Subagents under **Settings → Profiles**, in a
profile's Models part. **Make Default** replaces saving a default in each place, and a model you pick
in a new chat's composer no longer becomes the default; until you choose one, your saved defaults
keep working as they are. The Settings switches for a team's coordinator
and monitor are gone. Land, a decision's answers, Cancel and Remove from Queue now pass only from
your own page in Sova or your own words in the branch's chat, so a script or a card's command that
pressed them is refused.

Going back to `v0.12.0` (`SOVA_REF=v0.12.0`) keeps your settings, profiles and sessions. Sova also
writes your chosen default into the older settings, so it carries over. The Models part's own model
for a chat has no effect there, and the Subagents tab comes back in place of Settings → Profiles.

## v0.12.0 — 2026-11-07

Light, Dark and Auto themes, an Extensions tab in Settings, Time Spent for each chat, shell mode
in the composer, and Sova running chat modes itself. 329 commits since v0.11.0.
The highlights:

- **Light, Dark and Auto.** Settings → Themes now has Appearance at the top: Light, Dark or Auto,
  where Auto follows your system and switches with it, no reload. Pick one dark theme and one light
  theme from two lists shown as card grids, Dark first. A pick takes effect at once in the list
  that's showing. Each pick is saved per browser and painted before the first frame, so a reload
  never flashes the other theme. Open tabs follow a change made in another tab, fonts and text size
  included.
- **Settings → Extensions.** A new tab lists this computer's extensions, one state per row
  (Waiting for You, Changed, Running, Stopped and the rest). **Add Extension** picks a folder.
  Nothing runs until you approve it after a Review. Sova starts each extension's program itself and
  offers Start, Restart Program and View Log. When an extension's code changes, its page goes off
  until you approve the new version. A message an extension sends shows its name badge, and an
  extension can never act as you.
- **Time Spent.** The session pane has a Time Spent tab, between Usage and Context. It shows how
  long you've been with the chat and how long its agent has worked, split into Reading, Typing, Dictating, Reviewing
  Changes and more, with a line per alignment. With **Label your messages** turned on in Settings →
  Decisions (off by default), each message you send gets a label (Specifying, Directing, Reworking,
  Asking), and **Your Messages** shows where your time went.
- **Type anywhere, shell mode and Esc.** Typing a character while focus isn't in a text field puts
  it in the composer, at its caret; nothing is sent. Type `!` in an empty composer to switch it to
  shell mode: the line runs as a command in the chat's folder instead of going to the model, and
  Send reads Run. A running command shows in a bar with Show Output. A plain **Esc** in the composer
  now stops the reply, like Stop, and leaves what you've typed alone.
- **Chat modes.** Sova now runs chat modes and minor modes itself. Settings → Experimental has the
  switch, **Sova runs chat modes**, on by default; turn it off to go back to the old way. Spec is now
  an ordinary minor mode you turn on or off in a project chat's mode menu. Mode commands such as
  `/mode delegate` are typed in a chat's composer and Sova answers them; you can keep personal modes
  of your own in `~/.pi/agent/sova/minor-modes/`. Sova no longer supports modes in a pi terminal session.
- **Merge queue.** The merge thread runs read-only in a sandbox. Restarts, live checks, conflict
  fixes and test runs are done by Sova for it. The merge thread's chat has a Run Logs chip with its
  size and Clean Logs… (asks first). Removing a worktree now keeps it when it holds something git
  can't bring back, such as an ignored file or a nested repository, and offers Remove Anyway.
- **Smaller changes.** Home's project cards show memory as one bar: chats and running copies
  together. A message typed before a new chat has connected is sent, not lost. Only chats whose
  project has a running-copy setup are offered the project tools. The Context sheet keeps loaded
  rows when its list is long. Worker reports after a reload or a gap now arrive once and in full.
  The Docs explain that each chat runs in a process of its own, and new Docs pages cover Themes and
  Sova extensions. A contributor guide is in the repo.

**What you may need to do:** Esc in the composer now stops a running reply. Switch modes in a Sova
chat: Sova no longer supports `/mode`, `alt+m` or the mode launch flags in pi's terminal. Extensions you already
had are approved once at the first start. After that, an extension added or edited outside Settings
→ Extensions waits for your Review. Your theme choice carries over as your Dark or Light pick.

Going back to `v0.11.0` (`SOVA_REF=v0.11.0`) keeps your settings and sessions as they are, with
three costs. Each browser goes back to the built-in Dark theme until you pick one again. Extensions
that Sova was starting from their folder no longer have their program started. Time Spent figures
and message labels are kept, but v0.11.0 doesn't show them.

## v0.11.0 — 2026-11-06

A Setup chat for your project's pipeline, reminders and jobs that don't need a tab open, a new Home,
and OpenAI sign-in. 352 commits since v0.10.2. The highlights:

- **Set up with a chat.** A project's merge queue, releases and deploys are now set up by one
  standing Setup chat per project, in its own worktree. It reads the project, asks what it can't
  find, and proposes the checks on a branch. A trial of that exact commit must pass before you can
  Land or Merge Branch it. **Set Up with a Chat** replaces the old form: Initialize, Try It on Main
  and Save Checks are gone. Any other chat's branch that changes the same setup follows the same
  rule.
- **Nothing waits on a tab.** A chat's reminder now fires with no tab open, and Sova brings the chat
  back for it. Background jobs outlive the chat that started them, and a job's end wakes its chat.
- **A new Home.** Projects come first, as a grid of cards with icons, each with what needs you, its
  chats, its running copies and what's in progress.
- **The landing bar.** A branch's progress through the queue sits in one row at the foot of the
  sidebar, with its step count, a hover card and a detail panel. On a phone it's one strip.
- **Merge queue.** Settings → Merge Queue shows every setting for each project. Checks reuse passes
  from identical code, so landings go faster; the Reuse passes from identical code setting turns
  that off for a project, and a release always runs in full. Sova makes each conflict's scratch copy
  itself and removes it. Landed spec drafts stay in their branch's folder and read as landed. After
  landings the merge thread restarts Sova once the queue is idle, so a landed change goes live on
  its own.
- **Needs you.** Every chat's row has a × that dismisses it on all your devices until that chat has
  something new. Guesses from a chat's last reply now sit in their own group, **Maybe waiting on
  you**, and never send a phone notification.
- **Accounts.** Sign in to your ChatGPT subscription from Settings → Accounts, which now has one tab
  per provider. Each API key is checked before it saves, with Show, Test and Remove. Ollama Cloud's
  model list is checked daily (or with Check Now), and its included credit is on the usage glance.
- **The Overseer.** It can pair two chats, which then send each other short notes between turns.
  Chats Sova names itself, such as a merge or release chat, keep a fixed name.
- **The mesh.** A copied or moved `peers.json` now keeps the mesh off, so a copy of Sova can't pose
  as the original. The Mesh page says why, and **Reconnect Here** turns it back on when the move was
  yours. Mixed versions are refused writes in the areas where they don't match.
- **Smaller changes.** The Context tab has one row per item with a drill-in sheet, and shows each
  skill's read state. Settings forms keep focus while you type. On a Mac, dictation gives up on a
  mic that never starts after 10 seconds, and Sova's window starts through macOS's launcher so the
  mic permission is the browser's own. The installer runs on your own tools when a mise shim is on
  your PATH. New Docs pages cover Usage, Teams, Merge queue settings and Release settings.

**What you may need to do:** if the mesh goes off after you moved or restored Sova's state folder,
press Reconnect Here on the Mesh page. A project not set up yet now starts from Set Up with a Chat.

Going back to `v0.10.2` (`SOVA_REF=v0.10.2`) keeps your settings and sessions as they are, with two
costs. A project where you turned Reuse passes from identical code off has `"reuse": false` in
`.sova/project.json`, which v0.10.2 refuses as an unknown key: remove that line first, or the
project's file won't load there. Reminders and jobs need a tab or a running chat again, and rows you
dismissed in Needs you come back.

## v0.10.2 — 2026-11-05

Branch summaries in the merge queue, a Land that asks first, and Tailscale on a Mac with no
setting. 27 commits since v0.10.1. The highlights:

- **Branch summaries.** Once a branch reads Ready to land, its row in the Merge Queue tab and in the
  Worktrees rows (the composer's dialog and the session pane) gets up to five plain bullets saying
  what it does, written in the background by the model Settings → Summaries names. Rows now lead
  with the owning chat's title, then the branch, then the bullets. A summary that failed offers Try
  Again; one from an earlier commit says so.
- **Land asks first.** Land opens a short confirm in the row ("Land <branch>?", how many commits go
  to the queue), with Not Yet and Land <N> Commits. Escape or Not Yet backs out. Land Without Its
  Specs… uses the same confirm. The Worktrees dialog is tighter and fits the Fold, and every row
  action keeps its button's own size.
- **Tailscale on a Mac.** Add Peer by name, Find Hosts and the peer listener now work on macOS with
  no setting: Sova finds the tailscale.com app, the App Store app or Homebrew tailscaled on its own,
  and each problem it hits says what to do (start tailscaled, use an administrator account, Allow
  the firewall prompt). `SOVA_TAILSCALE_SOCKET` still wins when set. The mesh guide covers it.
- **Smaller fixes.** The Overseer's Ideas count leaves out dropped and done ideas. A branch whose
  landing specs are still being checked stays held instead of dropping out of the queue.

Going back to `v0.10.1` (`SOVA_REF=v0.10.1`) keeps your settings and sessions as they are; v0.10.1
ignores the stored branch summaries, and Land goes back to queueing without a confirm.

## v0.10.1 — 2026-11-04

Create mode, Upgrade in Settings working again, and a Release Note for each release. 270 commits
since v0.10.0. The highlights:

- **Upgrade works again.** On v0.9.0 and v0.10.0, Upgrade in Settings fails ("Cannot find module")
  and changes nothing. Run the install command once to reach v0.10.1; from here on, Upgrade in
  Settings works again.
- **Create, a third major mode.** Pick **create** in a chat's mode menu and say what you want Sova to
  do differently. The chat finds the supported way (a setting, a skill, a profile, a tool, an
  extension, the project's checks or releases, your other computers) and offers it, recommended
  first, with what it reaches and who approves it. It works like Delegate, with the same subagent
  profiles, and never changes Sova's own code. Settings changes come as cards you Apply, or go on
  a branch you Land. The new Extending Sova docs list the same topics, each with a guide.
- **Cards you Apply.** A Sova-wide settings card applies all or nothing, or says exactly what took
  effect. Its rows read as words, not raw JSON. A card held by a checking branch or a release says
  which one. Another computer can be paired, and mesh access set, from a card.
- **Your click stays yours.** Restarting and updating Sova, trusting cards to act, and going back
  past a sandbox raise each need your own click in the page. A script or another chat can't stand
  in for it, and neither can a header relayed from another computer.
- **Releases.** A **Release Note** button beside Start Release saves instructions for the next
  release ("Release as 0.10.1", "skip docs"). A started release shows the note it got and who asked
  for it.
- **Merge queue.** A settings read during a landing no longer pauses the queue. On the run page,
  open logs stay open, and actions and checks line up.
- **Smaller changes.** A drawing's frame is no longer white on a dark theme. A re-run of the
  installer on macOS leaves the installed Sova app alone. Every chat Sova starts knows its own
  server's address on any port, so land and merge reach the queue. New Docs pages cover the merge
  queue and Releases.

Going back to `v0.10.0` (`SOVA_REF=v0.10.0`) hasn't been tested on this release. v0.10.0 doesn't
know the create mode, so a settings file or profile that names it is refused there, and a saved
Release Note is ignored. Upgrade in Settings won't bring you forward again from v0.10.0: run the
install command.

## v0.10.0 — 2026-11-04

A merge queue that lands every branch, releases cut from Sova, MCP servers for every chat, and a
Context tab. 262 commits since v0.9.0. The highlights:

- **The merge queue.** Land (the composer's worktrees control, the session pane, the project's new
  Merge Queue tab, or "land it" typed in the branch's own chat) puts a branch in its project's
  queue. The queue merges it onto the newest main branch in a copy beside the project, runs the
  checks the project declares, lands exactly the commit it tested and pushes it. A failure goes back
  to the branch's chat as one card with Land This Commit Again and Remove from Queue; a failure that
  can't be pinned on the branch reads "Can't tell whose failure · waiting for you", with Land
  Anyway. A merge thread chat per project notes each landing and judges conflicts. Set the queue up
  once from the Merge Queue tab (Try It on Main, then Save Checks) and adjust it in Settings → Merge
  Queue; until then Merge Branch merges as before.
- **Releases.** A project's Releases tab starts a release chat that picks the number, writes the
  notes and makes the release commit; the queue runs the release checks, and you Publish (the tag,
  the moved channel and the push in one step) or Withdraw. Set Up Releases proposes a project's
  release setup. A copy following a withdrawn release is told so in Settings → Updates and offered
  the release its channel is back on.
- **MCP servers.** Settings → MCP Servers adds a server by address, command or a paste from another
  tool; Add and Check lists its tools, and every ordinary chat can use them, on pi and Claude Code
  models alike. A project can declare its own.
- **The Context tab.** A chat's detail pane shows what fills its context window and what each part
  costs, with its instruction files opened in a shared reader.
- **Branch status in the session list.** Each row shows its chat's branch status, replacing "N of
  M".
- **macOS.** The installer installs Sova as an app (Chrome, Chromium, Brave, Edge or Vivaldi) with
  its own Dock icon and a title band of its own; `--no-app-entry` leaves it out.
- **Overseers.** The Overseer runs the extension commands marked for it; adding, archiving and
  unarchiving a project happen on your typed word, with no card; a project overseer can read its
  project's git history and its server log. Quick actions no longer raise the phone keyboard.
- **Costs.** The Costs and Usage tabs split New input from Cache reads, and a model's row opens to
  where its cost went.
- **Smaller changes.** Settings → Alignment has an Eagerness choice (Eager by default, or Careful);
  a queued message stays removable until the agent takes it; Delegate starts a team when asked, or
  when parts depend on each other; tapping a flow drawing's shape only highlights it; the sandbox
  cleans its private cache copies on its own (`/sandbox clean` runs it now); the session list does
  far less work per refresh.

### Removed

- **Landing cards and the merge captain.** Land through the merge queue replaces them; Not Yet holds
  saved under v0.9.0 are dropped.
- **The codemode minor mode.** It is gone from the mode menu, profiles, automations and the
  Overseer's coding sessions, and a settings file that still names it is refused as an unknown
  mode. Experiments showed no gain in quality, cost more, and the agent never chose it on its own.
  An old chat's script calls now show as ordinary tool steps.

Going back to `v0.9.0` (`SOVA_REF=v0.9.0`) hasn't been tested on this release: the merge queue's
records, release records and MCP server settings are new stored data that v0.9.0 doesn't read, a
branch waiting in the queue doesn't land there, and a settings file can't name codemode again.

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
