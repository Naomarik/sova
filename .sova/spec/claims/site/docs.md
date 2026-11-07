# §site/docs — The docs pages on Sova's site

The site's `/docs/` section explains Sova to the person running it: how a chat's modes shape what
the agent does, the features the landing page names and their settings, and how to install it. Each page is a
hand-written Markdown file in the site's docs collection, written in the user's words from the
claims its record `requires`, and it promises nothing those claims don't say. The pages carry no §
ids, no source paths and no API routes; this area is where a page's sources are recorded, so a
change to a claim names the pages it reaches (`impact`) and a page names the claims it rests on
(`where`). The docs pages, and the layout, styles and data they are built from, sit inside the spec's code boundary; the rest of the site (the landing, Mesh and Organizations pages, brand, icons, images, screenshots, mock-ups, tooling and generated files) is excluded from it on purpose.

## §site.docs/frame — How a docs page is built

Every `/docs/` page is one Markdown file in the docs collection (`src/content/docs/`); its path is
its URL under `/docs/`, and an `index.md` is its folder's own page. Each file's front matter gives
a title, a description, a group (Start, Modes, Features, Extending or Setup), an optional subgroup (Major or
Minor, under Modes) and an order. Pages are listed by group in that order, then a group's own pages
before each subgroup, then by `order`; the sidebar and Previous/Next follow that sequence. The
Modes group holds only pages about modes, and only a page about a mode sits in a subgroup (Major or
Minor); a page about something else goes in another group. A page
shows the shared header, the page list grouped with subgroups as labelled indented lists (a sticky
sidebar from 1024px wide, a `<details>` menu above the page below that, no script), an eyebrow with
the group or subgroup label, the title, the description as a lead, the body, Previous/Next links,
and a footer with links to Sova home, Sova on GitHub, the licence and pi, and the revision and date the pages
were written from the spec. Nothing on a page widens it: each table sits in its own sideways
scrolling region named after the heading above it, code blocks scroll inside themselves and inline
code breaks anywhere. Code blocks are plain, in the site's own colours, with no syntax highlighting.
A page may place a product screenshot with a `<!-- screen: <shot id> | <words> -->` line: it becomes
a figure the column's width, served as AVIF and WebP at several widths, its words the screens
manifest's (else the line's own). A shot not captured yet leaves nothing on the page, and the build
warns but never fails for it.
The site builds to static HTML and CSS.

## §site.docs/chrome — The header and theme the docs pages share

The docs pages share the site's base page and header. The header shows the Sova mark linking home,
a "← Back to Sova" link, a Docs link marked current, Mesh and Organizations links where the bar has
room, a GitHub link and a theme toggle. The site is dark by default, like the app; the toggle
switches light and dark, sets the browser's theme colour, updates its label and pressed state, and
is remembered in the browser so a later page opens in the saved theme without flashing the other.
Every page has a Skip to Content link, a title and description with matching social-card metadata,
and the site's fonts and colour tokens.

## §site.docs/index — Sova docs (`/docs/`)

The front page: what a mode is, a table with a row per major and minor mode (Create and memory among
them, a project's own modes as one row), and links to the feature, extending and setup pages.

## §site.docs/modes — Modes (`/docs/modes/`)

The major and minor modes side by side, the three major modes in the mode menu's words, switching
them per chat from the composer's mode menu,
the default for new sessions (memory's type with it; never Create, which is chosen per chat),
strict, a short memory section that
links to its own page (§site.docs/memory), the terminal's commands, which offer no Create, what workers get (spec, and each
project mode that says so), and the sessions that choose their own mode, and a project's own minor modes (§site.docs/project-modes).

## §site.docs/normal — Normal (`/docs/modes/normal/`)

The default major mode: the agent you chat with does the work itself and can still start workers
and teams; when to choose it over Delegate (one agent that talks with you and does the work,
keeping the whole conversation, with no hand-off); switching to and from Delegate; the Overseer
always runs in it.

## §site.docs/delegate — Delegate (`/docs/modes/delegate/`)

The orchestrating major mode: the four kinds of work and where each is routed, fallbacks and Off,
teams (linking to their own page, §site.docs/teams), watching workers, and workers after a restart.
Create (§site.docs/create) does all of this and shares these settings.

## §site.docs/teams — Teams (`/docs/teams/`)

The first page of the Features group, linked from the Delegate page, the docs front page and the
landing's Teams section: getting a team (asking for one in Delegate always starts a real team, and
when the agent starts one unasked; any major mode can), what a team starts with (name and shared
objective, one role per member, declared ownership that is a plan, not a lock), all or nothing at
start and the limits of 24 running workers per chat and 24 seats per team; how members talk
(`team_msg`, `team_inbox`, `team_ask`) with examples of members settling things between themselves;
the inbox (idle members woken, busy ones never interrupted, urgent items at the next step, questions
waiting for an answer, a replaced member's messages going to its successor, inbox zero and the
safety net, open items returned to their senders, nothing lost to a restart); the coordinator (from
the subagent profile's Teams section; sees every assignment and the roster, steers by role, answers
members' questions, the one voice back to the user's chat with `team_report` and `team_ask`, its own
result starting a turn only once no member works, successors and handover notes, a team with no live
coordinator reporting to the chat directly, and none under Off); the monitor (context wrap-up, the
usage pause and resume with an early resume refused, no checks while the team is idle); watching a
team (the composer's count, the Session detail pane's member rows, the Inbox tab, read-only, and
the Agents page's team chips).

## §site.docs/subagent-profiles — Subagent profiles (`/docs/subagent-profiles/`)

What a subagent profile holds (its alignment override included), how a chat picks one, editing them in Settings, switching a chat's
profile after a usage limit, and Off. A profile never turns on a project mode. The page sits in
the Features group, not under Modes: a profile is not a mode.

## §site.docs/align — Align and alignments (`/docs/modes/align/`)

The align minor mode: when an alignment opens (Eager, the default, for any request that implies
work; Careful, only when the user wants the product changed or the agent can't tell, questions
answered in chat; on both, nothing built before a confirmed card and a go-ahead to a plan sketched
in chat opens a card first), how each reply opens with a short part for the user and folds its
working notes, what an alignment holds, answering it, Settings → Alignment (eagerness, writing
style, Visuals, review), the card, the composer's badge and session mark, Needs you and notifications, and the terminal
viewer.

## §site.docs/align-review — Adversarial review (`/docs/modes/align/review/`)

The review of an alignment's plan and implementation: turning it on, the Reviewer
route, when it runs, blockers, and what the card shows.

## §site.docs/spec-mode — Spec (`/docs/modes/spec/`)

The spec minor mode: its guide's two parts (finding your way on every turn, the writing procedure
once, before the first behavior-changing edit or with the first census note or an alignment's
go-ahead), working from the project's spec, the read-only `spec` tool every chat you code in and
every worker but a team's monitor has for those look-ups, spec on or off (§app.spec-lookup/spec-tool), the census note and its one unread line before
finishing, updating a claim the task didn't create without asking and listing it in the reply's one
spec line ("Also updates …"), the Agree step when align is on too, drafts and promotion, the spec
writer, what workers get (and the claims a finished worker's changes landed in), and project coding
sessions.

## §site.docs/vis — Vis (`/docs/modes/vis/`)

The page's catalogue includes tool-backed Tours (§app.tours/authoring), distinct from drawing fences: ask in chat, clarify audience and intended understanding, approve sources, dry-run, record desktop and phone, inspect the overview and suspicious captures, and present only a complete checked edition. It explains reviewed expiring edition-pinned links and hand-off availability; ordinary tour tools require vis on, not align's Visuals alone, while hand-off scoped presentation remains baseline context. Opening a message never records.

The vis minor mode: the drawings the agent can put in a reply, where they render, and what is never
trusted from the model. An Examples section at the end, which the kinds section points to, shows
one example of each kind (§site.docs/vis-examples).

## §site.docs/vis-examples — The Vis page's examples

The Vis page shows one example per kind the registry lists (`flow`, `state`, `sequence`, `layers`,
`tree`, `chart`, `timeline`, `steps`, `wireframe`, `matrix`, `code`, `svg`, `html`), each as its
`vis <kind>` block's source followed by its drawing. The drawings are Sova's own figure and Views
rendered to static HTML when the examples are generated (`pnpm run vis-examples` in `site/`), with
a copy of the vis styles scoped to the examples, so the page matches the app, runs no script, and
follows the site's light/dark toggle through the same tokens. Every example parses with no
warnings, or the generator fails, and it writes the same bytes on every run. A kind that lays
out for its pane's width (flow, state, sequence, chart, matrix, steps) is drawn for the docs column and
for a 320px phone, and the page shows the one that fits its figure's width. Interactive parts
show their first state and do nothing: a sequence's **Step Through** button is disabled, and a
flow's or state machine's shapes are not buttons and pick nothing. A `vis
svg` example is drawn in place, as its frame would show it; a `vis html` example shows only its
source, with a line saying that in the chat it runs in a sandboxed frame. A changed kind, View or
style reaches the page only when the generator runs again.

## §site.docs/project-modes — Project modes (`/docs/modes/project-modes/`)

Writing a project's own minor mode: the `.sova/minor-modes/<id>/` folder and its `MODE.md`, which
checkout a chat reads it from, the instructions and reference files, declaring a tool and the
program it runs, declaring a command (run from a checkout with `node scripts/sova.mjs run
mode.<id>.<name>`, never the installed `sova`, §app.commands/cli) and a hook (what runs after a
reply, its event and environment, its bounds), approval and when it is asked again, that only your own click in the mode menu or the Overseer's turn-on approves a tool, who
approves hooks, the copy a chat keeps once a mode is on, what
workers get, the menu's states, turning one on from a terminal, what makes a folder broken, and
one worked example of a mode with a tool, a command and a hook.

## §site.docs/worktrees-and-changes — Worktrees and changes (`/docs/worktrees-and-changes/`)

How a session keeps track of the git worktrees it works in (where workers may start, merging and
cleaning up, and the project modes a chat in a worktree reads), and how you read what changed as
numbered steps.

## §site.docs/needs-you — Needs you (`/docs/needs-you/`)

The sidebar list of sessions waiting on you, the Overseer's attention digest, and the same news as
phone notifications, with their settings. A worktree ready to land is a quiet mark, not a row: it lands
once you press Land or type "land it" in its chat, through the project's merge queue.

## §site.docs/overseer — The Overseer (`/docs/overseer/`)

The session that reads every other session and acts on them through Sova: what it is, what it may
do (organizations and cross-host links included) and when it asks first, the files it writes only in
turns you start, its memory switch, its notes, ideas and to-dos, and its settings. Its news of branches
ready to land points to Land; it never lands a branch itself. When it turns on a project's own mode, that
counts as the approval of the mode's tools and commands, never its hooks.

## §site.docs/playbooks-and-schedules — Playbooks and schedules (`/docs/playbooks-and-schedules/`)

Running a playbook from the composer's Playbooks dialog; a project playbook's schedule: who fires
it, its triggers (times, intervals, `claude-limit-reset`) and their limits, and approving or revoking
it (in the Playbooks dialog, or in the Overseer's Approvals & Schedules). A schedule never turns on a
project mode.

## §site.docs/phone — Check in from your phone (`/docs/phone/`)

Reaching Sova from a phone over the tailnet, pairing it with a one-use code, installing it as an
app, and following sessions that are open in a terminal.

## §site.docs/change-direction — Change direction (`/docs/change-direction/`)

Rewinding to before a message, regenerating a reply, forking from a reply, steering or stopping a
running turn, and switching models mid-session (favorites and the saved default).

## §site.docs/install — Install (`/docs/install/`)

Installing Sova on a Mac or Linux machine with one command and its options, starting it and
opening it unlocked, the app-launcher entry that opens it in its own window (on macOS, an app of its own with its own
Dock icon and no title bar), the access token,
the login service, running the installer again and the self-update from Settings it points to
(§site.docs/updates), removing it (the service, the extension links,
the install, the launcher, the app entry and its browser profile, with on macOS the browser's
launcher for the app, and optionally pnpm's store and
cache), and the Claude Code models.

## §site.docs/memory — Memory (`/docs/modes/memory/`)

The memory minor mode: what it does and that the transcript never changes, turning it on from the
mode menu, the two types (UniiChat, credited to Victor Taelin with a link to his design, and
zoomable compaction), the Memory type panel and Save as default, the `zoom` and `date` tools,
updating, preparing and problems, rewind and fork, the Session pane's Memory outline, Settings →
Memory with each type's summary size and its help, where memory can't be on (the terminal, workers, coding sessions, session
profiles), and the overseers' own switches, on by default.

## §site.docs/updates — Updates (`/docs/updates/`)

Keeping Sova current, in Setup after Install: running the install command again and how the
`stable` tag moves, pinning with `SOVA_REF`, then Settings → General's Updates · this machine: what
runs and the kind of copy, the source (stable, master or a branch), checking and what a check finds,
the dot on Settings, upgrading with the previous version kept until the new one answers and put back
when it doesn't, Upgrade automatically, the banner a page open across an upgrade
shows ("A newer Sova is available.", mesh or not), and that only the operator can update.

## §site.docs/create — Create (`/docs/modes/create/`)

The major mode for configuring and extending Sova, in the Modes group's Major subgroup: that it does
everything Delegate does and shares its settings, strict included; that it never changes Sova's own
code and starts from what you need; the table of contents; where it is offered and what a chat that
can do less says; cards, Land and your OK, and which one a change takes; what Apply means and what
only you can do; choosing it per chat, and why no default holds it; new tools; when a change appears,
and what spreads to your other computers; and the limit of the check that keeps its entries complete.

## §site.docs/extending — Extending Sova (`/docs/extending/`)

The front page of the Extending group: every way to make Sova yours, by what you want to do, in the
order and words of Create's table of contents, each linking to its guide or naming the screen. It
says plainly what has no supported way today, and what is nearest.

## §site.docs/project-definition — The project definition (`/docs/extending/project-definition/`)

`.sova/project.json` as a whole: services, ports, setup, data, tests, share endpoints, deploy recipes
and the `release` and `merge` sections, what each is for, what a change to each needs, and how to check one.

## §site.docs/card-types — Card types (`/docs/extending/card-types/`)

A project's own transcript cards: the `.sova/cards/<name>/` folder, what a view can do, trust, and when
a new or changed card reaches a chat.

## §site.docs/drawing-kinds — Drawing kinds (`/docs/extending/drawing-kinds/`)

A project's or an extension's own drawing kinds: the `.sova/drawings/<name>/` folder, how a chat learns
one, and when it reaches a chat.

## §site.docs/automation-files — Automation files (`/docs/extending/automation-files/`)

`.sova/automations/<id>.json`: what one holds, how it differs from a playbook's schedule, what it can
and can't name (Create among them), approving it, and when it runs.

## §site.docs/scripting — Scripting Sova (`/docs/extending/scripting/`)

Driving Sova from your own program: the commands with `node scripts/sova.mjs` from a checkout, and
that the installed `sova` launcher runs no commands (it starts the server); the token; the event
stream; sending to a chat and raising a card; who ran what; and what no script can do, the
approvals only your click passes among them, and how far that holds.

## §site.docs/add-ons — Add-ons in a Sova chat (`/docs/extending/add-ons/`)

Which features of a pi add-on work in a Sova chat and which don't: tools, commands, events, providers
and dialogs; what reaches workers; when an add-on reaches a chat; and that enabling or disabling one
is done in a terminal.

## §site.docs/mcp-servers — MCP servers (`/docs/mcp-servers/`)

What an MCP server gives a chat; adding one in Settings by address, command or a pasted entry; what
each row's state means, and Check Again and Sign In, from a phone too; why a server you didn't add on
the page waits for you, and that any change asks again; saving a secret; a project's `.mcp.json`, and
that each worktree's copy is approved on its own; what a server costs in tokens and the switches that
trim it; workers and profiles; and what the sandbox and remote chats change. It says a server stays
on its computer, and that chats don't ask before a tool runs.

## §site.docs/merge-queue — Merge queue (`/docs/merge-queue/`)

Which projects have a merge queue and that it is the only way a branch reaches their main branch;
the two ways to land a branch (Land, with its menu, and "land it" typed in the branch's own chat,
your own words only) and what Land refuses; one branch at a time in approval order; the merge in a
copy, the checks, the optional review and landing exactly the tested commit, or a pull or merge
request; the branch's card in its chat; whose failure a red check is and each waiting state (Needs a
fix, Can't tell whose failure, Conflict and Behaviour differs, Review flagged, Drafts changed) with
its actions; the Merge Queue tab; the merge thread and the queue's own chats; setting it up and
Settings → Merge Queue, linking to its own page (§site.docs/merge-queue-settings); each run's page; the freeze while a release is open. Screenshots of the Merge Queue tab, a run's page and the branch's card in its chat, once captured.

## §site.docs/merge-queue-settings — Merge queue settings (`/docs/merge-queue-settings/`)

Settings → Merge Queue, in Features after Merge queue: how it opens (Queue Settings, the picker, the
project's Settings tab row); each row's tag (Project file, This computer, Set by Sova) and that the
project-file values are read from the main branch, not the folder; the groups (Landing, Checks with
reuse of passes, Before the checks, Review, Merge thread, Request, Where it checks) and Open Folder;
what can be changed there (how it lands and where it is kept, the two models, push, review, each
check's time limit, reruns and when it runs, reuse) and that the rest changes in a branch; saving
(a computer value at once; a project-file change gathered, confirmed and saved as one commit on the
main branch, unchecked, pushed with the next landing; waiting for a running branch or an open
release, with Cancel Save; blocked by an uncommitted edit; never dropped silently; a request or
pushed branch on a project that lands on its host); Initialize on a project not served yet.
Two screenshots of the tab: its top (Landing, how it lands) and its Checks rows.

## §site.docs/release-settings — Release settings (`/docs/release-settings/`)

How a project releases, in Features after Releases: that releases have no Settings tab and their
settings live in the project's files, landing through the queue, with the Release Note the one kept
outside them; Set Up Releases writing both; the `release` section's keys with what each says and its
default (playbook, tag, scheme, channels, commit, checks, quietMin), that no key names a remote and
when Publish pushes, a file that doesn't read stopping releases, and a change counting from the next
Start; the playbook's `release.json` steps (id, label, phase prepare/check/after/withdraw, the
`commit` step, `held`) with Sova's own two steps and Sova's method beneath the project's playbook;
that releases need Merge locally and what waits while one is open; the Release Note. It has no
screenshot: no screen shows these settings.

## §site.docs/releases — Releases (`/docs/releases/`)

What a release is and isn't (not a deploy); the release playbook doing the work in a release chat and
Sova holding what can't be undone; Set Up Releases; Start Release and the frozen merge queue; the
steps and their states, Continue on a held step, Retry Step, the quiet warning; the release checks
and that nothing overrides a failed one; Publish, all or nothing, Publish failed and Retry Publish;
Abandon Release; after-publish steps and Plan Deploy of a release; Withdraw and the numbered tag that
never moves; the release power and the Project Assistant's ask; the history on the Releases tab; a
link to its settings page (§site.docs/release-settings). Screenshots of the Releases tab's history and of
a release in progress (a held step, a failed step, Publish waiting).

## §site.docs/usage — Usage and costs (`/docs/usage/`)

What Sova counts, in Features: every model call on this computer recorded once when it ends (main
sessions, workers at any depth, one-shot side calls, the Overseer), priced at each provider's API
prices from models.dev at the price in force at the call's time, a model with no price counted but
unpriced and a local model free; that these figures are not the bill. The Agents page's Costs tab:
range and filters, the four stat cards and the cache hit rate, cost per day, the provider, kind,
model (with where a model's cost went) and project tables, top sessions, the prices line and Refresh
Prices, and that it counts this computer only; today's spend in the Agents page's head. A project's
Cost tab: the total as of its count, who started what, the most expensive sessions, the breakdown by
kind and model, and its notes. A session's Usage tab: its spend, by model and where (main thread,
side calls, subagents). The Usage page: one card per provider, each window's share used, reset, pace,
run-out and last week, a Claude account's logins, a balance for prepaid credit, how it stays fresh
and Refresh Usage; the glance at the foot of the session list. Screenshots, from the live app with
real figures: the Costs tab's top, its By model table, a Claude account's limits and a project's
Cost tab.
