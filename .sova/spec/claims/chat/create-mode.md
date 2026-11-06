# §chat/create-mode — Create
> Part of the Sova design spec · [overview](../design/overview.md)

Create is the third major mode. It does everything Delegate does, and it knows every supported way
to configure or extend Sova, so a person can say what they need and have it made without first
learning where it is kept.

Owns: what a Create chat may change and how, its table of contents and its lookup, where it is
offered, and how a new configurable thing gets into it. Not here: the mode menu and how a switch
reaches a chat (§chat/mode-menu), Delegate's workers, teams and routing (§chat/subagent-profiles,
§chat.mode-menu/delegate-teams), the Settings change card as the project overseer uses it
(§app.project-overseer/settings), and the approvals only a click passes (§app.access/your-click).

## §chat.create-mode/delegate-parity — Everything Delegate does

A chat in Create works as a chat in Delegate does, and adds what it knows about Sova.

- **The same work.** The same four kinds of work and the same routing, the same workers and teams,
  and the same instruction that the chat orchestrates and checks instead of doing the work itself
  (§chat.mode-menu/delegate-teams). Create's own instructions come after Delegate's and change none
  of them.
- **One set of settings.** The Subagents picker and every profile are Delegate's
  (§chat/subagent-profiles). Create adds no Settings tab, no file and no profile field. Moving a chat
  between Delegate and Create keeps its subagent profile.
- **Strict.** The strict flag does in Create what it does in Delegate (§chat.mode-menu/strict): while
  it is on, the chat has no `edit` or `write` tool. `bash` stays, so a chat can still write a file with
  it, and Create's instructions say nothing about that.
- **Every other rule.** What another claim says of Delegate's orchestrator holds in Create unless a
  claim says otherwise, the align bridge included (§chat.mode-menu/minor-toggle-keeps-prompt).
- **Workers.** A worker gets nothing of a major mode (§chat.mode-menu/workers): no table of contents,
  no lookup and no card tool. The chat opens the entry it needs and puts what the worker needs in the
  worker's brief.

## §chat.create-mode/boundary — What it will and won't change

Create never changes Sova's own code, and offers only supported ways of configuring or extending
Sova.

- **A supported way** is one the table of contents lists (§chat.create-mode/contents). Nothing else
  is offered: no edit to Sova's checkout, its bundled extensions or the folder Sova runs from.
- **It starts from the need.** Create asks what the person wants to happen, not which setting they
  want. It offers the ways that fit, recommended first, each with its trade-offs: what it reaches,
  who approves it and when it appears.
- **When nothing supported can do it,** Create says so plainly and offers the nearest ways. It
  suggests no workaround that goes around a supported way ("Sova can't add a major mode. A project
  minor mode is the nearest way.").
- **Links count as Sova's.** A file in the agent dir that is a link into Sova's own folder (on some
  installs `models.json`, `keybindings.json` and `vision-delegate.json`) is Sova's code: Create
  resolves links before it writes, and offers a way that lives in the person's own folder instead.
- **In a chat on Sova's own project** Create changes only the project settings it could change on any
  other project, by the same cards and Land, and refuses everything else, saying so in the words of
  §design.copy-deck/create-mode.
- **Restarting or updating Sova.** A chat never restarts or updates Sova, runs no git or service command on
  Sova's own folder or service, and names the control instead. It never says it did something it didn't.
  The server refuses the ordinary roads (§app.access/your-click); it can't stop raw `systemctl`,
  `launchctl` or `kill`.
- **What holds this.** A card touches settings files only, and refuses anything else
  (§app.project-overseer/settings). Everything else in this claim is the mode's instructions: no tool
  stops a file write a chat chooses to make, so this rule is as strong as the model's following it. A
  chat's release refusal stops a chat using its normal caller key, not one that leaves it out
  (§app.access/your-click).

## §chat.create-mode/contents — The table of contents

The mode's block carries one short line per topic, the way vis lists its drawing kinds
(§chat.markdown/visuals): 20 topics in 6 groups, in this order and these words.

- **Make it yours.**
  - `appearance`: colours, type and how this browser shows Sova
  - `models`: which models you can use, what new chats start on, and the sign-ins behind them
  - `workers`: which models your workers and teams run on, and named worker personas
- **Teach your chats.**
  - `instructions`: standing rules every chat in a folder, or on this computer, follows
  - `skills`: recipes a chat loads when relevant, and reusable slash commands
  - `modes`: what new chats start in, how planning behaves, and modes your project ships
  - `profiles`: named kinds of chat, what each may and may not do
- **Give them new abilities.**
  - `tools`: a new tool for the agent to call, and how it gets approved
  - `extensions`: your own page, buttons and cards inside Sova
  - `pi-extensions`: add-ons that change what a chat can do, from a file or a package
  - `scripts`: drive Sova from your own program, and follow what happens
- **Keep it safe.**
  - `safety`: what agents may touch, and who approves what
- **Run your project.**
  - `project`: how your project runs, tests, shares and ships
  - `landing`: what must pass before a branch reaches your project, and how it lands
  - `releases`: numbered versions of your project, and how they're made and published
  - `automation`: recipes you run by hand, or that run by themselves
  - `cards`: buttons, cards and drawings that are your project's own
  - `overseers`: how the Overseers and the Project Assistant watch, act and hold back
- **Reach you and others.**
  - `attention`: how Sova tells you things, and what it writes for you
  - `computers`: your other computers, public links, and this computer's setup

## §chat.create-mode/entries — Opening a topic

Before it acts on a topic, a Create chat opens that topic's entry with its lookup, `create_guide
{topic}`, the way a chat in vis opens `vis_guide`.

- **What an entry says,** for each thing the topic covers: what can be changed, where it lives, who
  approves it, how it goes live, and how to check it.
- **How each thing changes,** in one of these words: Screen (Create names the screen and control, and
  the person makes the change), Card (§chat.create-mode/settings-cards), Land, OK
  (§chat.create-mode/computer-files), Terminal (the person runs a command), or None (no supported way
  today).
- **It works from any project.** An entry is complete on its own and is carried with the mode. It
  depends on neither the chat's project, nor a Sova checkout, nor Sova's spec; it may name the public
  guide that goes further (§site.docs/create).
- **Only what has landed.** Create offers only what is on Sova's main line in the copy the chat runs.
  Work on a branch joins with its own entry when it lands, in the branch that lands it.
- **A topic that isn't listed** is refused, and the answer lists the topics.

## §chat.create-mode/where-offered — Where it is offered

Create is offered in any of the person's own chats, in any project and in any folder.

| Where the chat is | Topics about this computer | Topics about the project |
|---|---|---|
| A project with a merge queue | Work | Work, by card and Land |
| A project with no merge queue | Work | The chat or a worker works on a branch in a worktree, and the chat merges on the person's word; Create says what is missing and offers Set Up with a Chat |
| A folder that isn't a project | Work | Create says what is missing and offers Add as Project |
| A folder that isn't in Git | Work | Create says project changes are made by hand |

- **Not offered** in a gathering chat (§app/baton), where other people can type: the menu has no
  Create row there, and a switch to Create is refused (409) with the reason that chat has no modes; typed, it is refused
  in the same words and the draft comes back. The
  Overseer, a Project Overseer, the Project Assistant and a merge thread have no mode switch at all. A
  chat on a computer running a Sova older than Create has no Create row either. `GET /api/mode` offers
  `create` only for a chat that can take it, never as a default.
- **A chat that can't take the switch yet,** on older code or open somewhere else, is refused (409) with
  §design.copy-deck/create-mode's sentence, and stays as it was. A chat on older code doesn't know a
  typed `/mode create`: it answers as to any unknown argument, and stays as it was too.
- **A chat with a share link keeps it.** A share link is a read-only transcript
  (§app/session-share), so sharing changes nothing about Create: the menu keeps its row, and a chat
  in Create can be shared like any other.
- **A chat that can do less still offers it, and says so.** A chat with its sandbox On says what it can't do
  before it offers a change: writing files on this computer, reaching Sova's commands and running
  project tools (§chat.sandbox/states). A chat on a remote machine says in its first reply after the
  switch, before it offers anything, that project modes and cards don't work there. The menu's Create
  row always shows the same limits, and so does the setup card while the chat is in Create
  (§design.copy-deck/mode-menu).

## §chat.create-mode/settings-cards — Settings go on a card

Every setting can change by a card Create prepares and the person Applies, but for what no card holds
(below): project settings, merge queue settings and Sova-wide settings, those with no screen today
included.

- **Create prepares, it never applies.** A plain Create chat has `sova_settings`, the project overseer's
  tool (`get`, `reference`, `propose`, `withdraw`, §app.project-overseer/settings), and every change
  it proposes only prepares a card. Even a change that narrows, which the project overseer applies at
  once in the operator's turn, waits for Apply here. Create has no way to apply a card, and none to
  undo one.
- **The card** is the Settings change card: each setting in plain words with its before and after,
  where it lands, each grant marked with what it allows, the exact file changes, and **Apply**,
  **Apply and Approve** or **Dismiss**. It stands under the chat's reply. A project's card also waits
  on the project page's Settings tab; a Sova-wide card has only the chat that prepared it. It counts
  among the 10 cards a project may have waiting; Sova-wide cards have a limit of 10 of their own. A
  card a Create chat prepared keeps its buttons in that chat after it leaves Create; only an archived
  pane drops them.
- **Apply** is the person's click, on Sova's own page, under the rule of
  §app.project-overseer/settings' Apply, whichever kind the card is.
- **A card that commits files waits** while a branch or a release holds the main branch, on the terms of a
  held Apply
  (§app.project-overseer/settings), so Apply never moves the main branch under a run.
- **Sova-wide settings** are every other setting Sova keeps for itself or for this computer, checked by the
  reader that setting already has and written the way its own screen writes it. One with no screen
  takes the same path: a custom provider, the image fallback, a remote target, the machine's sandbox
  policy, worker priority, a summary timeout. Notifications, outreach and favourites go by a card too; subscribing a
  device, Test and pairing stay on their screens.
  A Sova-wide change and a merge queue change each go on a card of their own, never mixed with other
  edits. A link whose real path leaves the agent or state folder is refused, when proposed and at Apply.
- **A Sova-wide Apply is all or nothing, or says what took effect.** Each edit's check runs again before the
  first write, and a failure writes nothing. A write that's refused or throws puts back what the card wrote,
  byte for byte with its file mode, and the card still waits and can be applied again, with no history line.
  What can't be put back, a file that won't restore or an action already taken, settles the card as applied,
  with a Partly applied chip, naming what took effect and what didn't. Only what took effect goes in the history, and it's never
  applied twice. A title sweep already scheduled isn't moved by a put-back: it reads the file at its next run.
- **The mesh** goes by cards, through the checks of the Mesh page's own routes. Create reads it through
  `sova_settings get`, never a key or a pin. Cards hold this computer's name in the mesh, what syncs and
  its front door; the linked computers, or removing one; linking a computer on the tailnet; what a
  computer may do here; browser access; starting a resync; a resync recipe; this computer as a relay on
  the local network; and pairing. A card shows every computer's access after the change, the changed ones marked
  and `sessions` called shell-level.
  - A computer keeps its identity on a card, and a new one must name its access: nothing is assumed.
  - More capabilities, a sync switch on, a computer added or a relay set is a grant
    (§app.access/your-click). Removing or narrowing waits for Apply too, and asks no approval.
  - **A resync recipe** goes on a card for one linked computer, in `mesh-resync.json` only, and the card
    shows it in full: kind, ssh, port, arguments, and that it wins over a deploy script's settings. It is a
    grant unless it removes one. An argument named like a credential is refused. A recipe derived from a
    deploy script's local settings stays as it is: no card reads or shows that file's values.
  - **Pairing's fingerprint** never goes through a chat, and Create never asks for it there. The person
    types it into the card's own field, and it is sent only with Apply and clears after. A fingerprint
    pasted into the chat isn't used: Create says so and points to the field. A card that carries one is
    refused, in any field or grouping, and a refusal doesn't echo what was typed. It is kept only where
    the Mesh page's pairing keeps it.
- **A project's Claude login** goes by a card that picks a login already on this computer, or none, or
  the organization's (§app.claude-logins/project-login). No credential passes, and adding a login or signing in stays out
  of Create.
- **The default mode** goes by a card that offers normal or Delegate, never Create
  (§chat.create-mode/per-chat-only).
- **Merge queue settings.** A card can hold what Save holds (§app.merge-queue/settings-save): `push`,
  `review`, `reuse` (reuse passes from identical code), and each check's limits. Apply is a Save, with its commit, its refusals and its waits: a
  card applied while a branch is checking waits as Save does, saying so on the card, with **Cancel
  Save** in place of Apply and Dismiss. A held Save that then fails says so, with its reason, and keeps
  Cancel Save. A held card settles when the Save is made: Applied, or Dismissed if it is cancelled, on
  the card or the Settings tab. A queue card refuses what goes by Land, and a project with no queue.
  A merge queue change in the settings history has no Undo: it is changed back in Settings → Merge Queue.
  Settings the
  queue keeps on this computer apply when the card does. Check commands, the install step, the target
  and the kits go by Land (§chat.create-mode/card-or-land), once a trial of the branch's head passed
  (§app.project-setup/land-gate). First setup stays the person's own, through the project's Setup
  chat (Set Up with a Chat on the Merge Queue tab or in Settings → Merge Queue, §app/project-setup);
  Create never writes a first setup itself, and points at Change Setup for a later change of how the
  project lands, releases or ships.
- **Credentials never pass through Create.** No card, file or message of Create's carries a key, a
  token or a sign-in. Provider sign-ins stay in a terminal: Create names the command and the person
  runs it. A key pasted into a Create chat isn't used, and Create says to sign in the supported way. A
  change refused for carrying a credential names the screen or file where the person can make it, so
  a refusal that was wrong is never a dead end. An environment variable's name passes as a reference; a
  literal value, or pi's `!command`, doesn't.
  On a Sova-wide card, what the card adds or changes is judged by key names and shapes, and what it only
  keeps by shape alone: a local dummy key already in the file doesn't refuse it, and a kept value shaped
  like a real key does. A project file's card is scanned whole.
- **What no card holds.** Preferences a browser keeps for itself (theme choice, type, text size,
  recent count) are out of Sova's reach, so Create names the screen. Moving a project's folder and
  archiving it stay the person's, on the project page, as they are for the project overseer
  (§app.project-overseer/settings). Public links, voice and updates hold no card, nor do links between
  computers, claiming a login or an internet relay: each has a set refusal naming where the change is
  made.
- **Who changed it.** A change applied from a Create card records the chat in the project's settings
  history (`settings-history.jsonl`) as its own kind, shown as "by a Create chat". A Sova-wide card has
  its own history, `sova-settings-history.jsonl`. A chat withdraws only cards it prepared.

## §chat.create-mode/computer-files — Files on the person's computer

Files on the person's computer that aren't settings (themes, personal skills, add-ons, rules,
personas) are shown first and written only after the person's OK.

- **Shown first.** Create shows the path and the whole change, then waits. Its instructions take only the
  person's own message in that chat as an OK. That is an instruction, not a limit: a chat can't tell
  another chat's message from the person's (§app.access/your-click).
- **Who writes.** The chat itself, or a worker outside any worktree: a worker in a worktree can write only
  there (§chat.worktrees/workers). Under strict the chat has no `edit` or `write` but keeps `bash`
  (§chat.create-mode/delegate-parity). Project files stay with worktree workers.

## §chat.create-mode/card-or-land — Card or Land

A change to a project reaches it by a card when it is one settings file, and by Land otherwise.

- **Card** for a change to one settings file (§app.project-overseer/settings).
- **Land** for everything else: anything spanning several files, and what a card can't carry (a
  mode's helper files, card types, drawing kinds, automation files, skills, rules, add-ons). The chat or a
  worker makes it on a branch in a worktree, which is what protects the main branch, and the branch lands by the person's Land like any other
  (§app/merge-queue). Create offers Land, or either word below, only once the branch exists. "Land it" or "merge it" typed by the person in the chat that owns the branch is
  their word: the chat records the Land the normal way (§chat.worktrees/landing-answers) and never
  touches the main branch itself.
- **What changes how the project runs goes by Land** when the project has checks, even as one file: a
  card lands with no checks, and Land runs them.
- **With no queue** the chat merges the same branch on that word, or on the person's plain agreement to
  its own offer to merge, and with no Git the change is made
  by hand (§chat.create-mode/where-offered).
- **The person's word:** their own newest message in that chat, so in a folder with no queue a plain yes
  to the chat's offer counts. Text from another agent, an Overseer, a
  baton or a tool isn't that word, and without it the chat doesn't merge. In a folder with no queue this
  is an instruction, not a limit: a chat can't tell another chat's message from the person's, and a
  program holding the token may pass as their word for `worktree land` (§app.access/your-click).

## §chat.create-mode/minor-modes — Its minor modes

Switching a chat to Create turns align on, and moves no other minor mode.

- The other minor modes stay as they were, which in a new chat are the person's defaults.
- Align is an ordinary minor mode from then on: the person can turn it off in Create, and leaving
  Create leaves it as it is.

## §chat.create-mode/per-chat-only — Chosen in the chat, and only there

Create is chosen per chat in Sova, from its mode menu or by typing `/mode create` in the chat's composer,
with the menu's refusals (§chat.create-mode/where-offered). A terminal refuses the command
(§chat.mode-menu/terminal), and `/mode create` sent to a chat by `session.send`, `sova_send` or a schedule is refused to the sender
(409), with nothing delivered.
A script can still switch a chat, by `POST /api/mode` or a chat socket of its own. No
default and no other chat's starter can name it.

- **Save as Default** in a Create chat saves the chat's last normal or Delegate choice, with its
  strict flag, minor modes and subagent profile (§chat.mode-menu/menu). A chat that has been in no
  other mode saves normal. `/mode default` does the same.
- **Each of these refuses, and none falls back:** a default naming Create in `POST /api/mode` with no
  `?path=`; a profile whose `mode` is `create` (the file doesn't parse, with the reason); a playbook
  or schedule through such a profile; an automation's `settings.mode`; the Overseer's
  `sova_create_session`, `sova_set_session` and `sova_project_overseer` `code`; a project overseer's
  `sova_create_session` and `sova_send`. The refusal is §design.copy-deck/create-mode's, and nothing
  is created or changed.
- **Other computers** never receive it as a default: no default holds it, so sync has nothing to
  carry. A `mode.json` that names it by hand reads as normal.

## §chat.create-mode/new-tools — A new tool

For a new tool, Create recommends a project tool first, and an add-on for all the person's chats
when they ask for that.

- **Project tool first.** A project mode's tool (§chat.mode-menu/project-modes) asks before it turns
  on and stops if its files change. It goes by Land, and then the person approves it in the mode menu.
- **An add-on for all your chats** is a pi extension in the person's own folder, offered when they ask
  for a tool in every chat. Its entry says it asks nothing and runs with full access.
- **Project-kept add-ons aren't offered:** an add-on kept in a project's `.pi/extensions` runs in every
  chat in that folder with no approval.
- **An MCP server** (§app/mcp) is offered after the project tool: an address the person already has, or a
  command server built as a program of the project. A project's server goes in its checkout's `.mcp.json`
  by Land; this computer's goes in Settings → MCP Servers, or in its `mcp.json` on the person's OK. Only
  the page approves one (§app.mcp/approval): Create can't approve, check or sign in, so it names the
  click. A server reaches new chats once approved, never a chat already open. Its entry is part of
  `tools`.

## §chat.create-mode/sova-extensions — A Sova extension

Before the person agrees to a Sova extension (§app/extensions), its entry says they must keep its
backend running, because Sova never starts it, and that it has full access inside the page.

Create offers a theme, a card or a project tool first when one would do.

## §chat.create-mode/after-a-change — Saying when it shows

After a change, Create says when it appears and how to check it, in the words of its entry: a new
chat, a restart, or Land.

- **Never sooner than it is.** An add-on reaches a new chat, and an add-on's model provider a restart of
  Sova: until then its models aren't listed. A project's offers, profiles and playbooks count once they are on its main branch. Create promises
  nothing sooner, and doesn't claim to show in this chat what only a new chat can show.
- **What spreads says so first.** When a change reaches other computers by sync (§mesh.sync/categories),
  Create says so before the OK, and the card says so before Apply.

## §chat.create-mode/growth-rule — Every new configurable thing gets an entry

Every new configurable thing gets a table of contents entry, in the branch that adds it.

- **The check.** A test fails the build when an item in one of Sova's own lists has no entry: Settings
  tabs, project settings, the project definition's keys, powers, modes and minor modes, screen places,
  commands, the settings files that sync, and environment settings (each `SOVA_*` a user may set; the others are on a not-for-users list beside the test).
- **Its limit.** It holds only where Sova keeps a list. It can't see a new control inside an existing
  tab, or a new file. Those rest on the rule above and on whoever reviews the branch.
