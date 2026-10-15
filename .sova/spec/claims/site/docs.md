# §site/docs — The docs pages on Sova's site

The site's `/docs/` section explains Sova to the person running it: how a chat's modes shape what
the agent does, the features the landing page names, and how to install it. Each page is a
hand-written Markdown file in the site's docs collection, written in the user's words from the
claims its record `requires`, and it promises nothing those claims don't say. The pages carry no §
ids, no source paths and no API routes; this area is where a page's sources are recorded, so a
change to a claim names the pages it reaches (`impact`) and a page names the claims it rests on
(`where`). The docs pages, and the layout, styles and data they are built from, sit inside the spec's code boundary; the rest of the site (the landing, Mesh and Organizations pages, brand, icons, images, screenshots, mock-ups, tooling and generated files) is excluded from it on purpose.

## §site.docs/frame — How a docs page is built

Every `/docs/` page is one Markdown file in the docs collection (`src/content/docs/`); its path is
its URL under `/docs/`, and an `index.md` is its folder's own page. Each file's front matter gives
a title, a description, a group (Start, Modes, Features or Setup), an optional subgroup (Major or
Minor, under Modes) and an order. Pages are listed by group in that order, then a group's own pages
before each subgroup, then by `order`; the sidebar and Previous/Next follow that sequence. A page
shows the shared header, the page list grouped with subgroups as labelled indented lists (a sticky
sidebar from 1024px wide, a `<details>` menu above the page below that, no script), an eyebrow with
the group or subgroup label, the title, the description as a lead, the body, Previous/Next links,
and a footer with links to Sova home, Sova on GitHub, the licence and pi, and the revision and date the pages
were written from the spec. Nothing on a page widens it: each table sits in its own sideways
scrolling region named after the heading above it, code blocks scroll inside themselves and inline
code breaks anywhere. Code blocks are plain, in the site's own colours, with no syntax highlighting.
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

The front page: what a mode is, a table with a row per major and minor mode (memory among them, a
project's own modes as one row), and links to the feature and setup pages.

## §site.docs/modes — Modes (`/docs/modes/`)

The major and minor modes side by side, switching them per chat from the composer's mode menu,
the default for new sessions (memory's type and size with it), strict, a short memory section that
links to its own page (§site.docs/memory), the terminal's commands, what workers get (spec, and each
project mode that says so), and the sessions that choose their own mode, and a project's own minor modes (§site.docs/project-modes).

## §site.docs/delegate — Delegate (`/docs/modes/delegate/`)

The orchestrating major mode: the four kinds of work and where each is routed, fallbacks and Off,
teams, watching workers, and workers after a restart.

## §site.docs/subagent-profiles — Subagent profiles (`/docs/subagent-profiles/`)

What a subagent profile holds (its alignment override included), how a chat picks one, editing them in Settings, switching a chat's
profile after a usage limit, and Off. A profile never turns on a project mode.

## §site.docs/align — Align and alignments (`/docs/modes/align/`)

The align minor mode: what an alignment holds, answering it, Settings → Alignment (writing style,
Visuals, review), the card, chip and session mark, Needs you and notifications, and the terminal
viewer.

## §site.docs/align-review — Adversarial review (`/docs/modes/align/review/`)

The review of an alignment's plan and implementation: turning it on, the Reviewer
route, when it runs, blockers, and what the card shows.

## §site.docs/spec-mode — Spec (`/docs/modes/spec/`)

The spec minor mode: working from the project's spec, the census note and its one unread line before
finishing, updating a claim the task didn't create without asking and listing it in the reply's one
spec line ("Also updates …"), the Agree step when align is on too, drafts and promotion, the spec
writer, what workers get (and the claims a finished worker's changes landed in), and project coding
sessions.

## §site.docs/vis — Vis (`/docs/modes/vis/`)

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
show their first state and do nothing: a sequence's **Step Through** button is disabled. A `vis
svg` example is drawn in place, as its frame would show it; a `vis html` example shows only its
source, with a line saying that in the chat it runs in a sandboxed frame. A changed kind, View or
style reaches the page only when the generator runs again.

## §site.docs/codemode — Codemode (`/docs/modes/codemode/`)

The codemode minor mode: the script tool it adds, what a script can call, the script's card, when a
switch applies, and where it is available.

## §site.docs/project-modes — Project modes (`/docs/modes/project-modes/`)

Writing a project's own minor mode: the `.sova/minor-modes/<id>/` folder and its `MODE.md`, which
checkout a chat reads it from, the instructions and reference files, declaring a tool and the
program it runs, approval and when it is asked again, the copy a chat keeps once a mode is on, what
workers get, the menu's states, turning one on from a terminal, what makes a folder broken, and
one worked example of a mode with a tool.

## §site.docs/worktrees-and-changes — Worktrees and changes (`/docs/worktrees-and-changes/`)

How a session keeps track of the git worktrees it works in (where workers may start, merging and
cleaning up, and the project modes a chat in a worktree reads), and how you read what changed as
numbered steps.

## §site.docs/needs-you — Needs you (`/docs/needs-you/`)

The sidebar list of sessions waiting on you, the Overseer's attention digest, and the same news as
phone notifications, with their settings. A worktree ready to merge is a quiet mark, not a row, and
a scheduled playbook (the Merge round) can act on it: it wakes when one turns ready, asks its owner,
and lands it.

## §site.docs/overseer — The Overseer (`/docs/overseer/`)

The session that reads every other session and acts on them through Sova: what it is, what it may
do (organizations and cross-host links included) and when it asks first, the files it writes only in
turns you start, its memory switch, its notes, ideas and to-dos, and its settings. Its news of branches
ready to merge links to the Merge round, which in Sova's own repository picks those up by itself,
asking each branch's owner first. Turning a project's own mode on for you counts as your approval
of its tools.

## §site.docs/playbooks-and-schedules — Playbooks and schedules (`/docs/playbooks-and-schedules/`)

Running a playbook from the composer's Playbooks dialog; a project playbook's schedule: who fires
it, its triggers (times, intervals, `claude-limit-reset`, `merge-ready`) and their limits, how a
`merge-ready` fire waits and collects branches, and approving or revoking it. Then the Merge round
as the worked example: its schedule, the merge board, asking the owner, what comes to the user
(branches with no live owner, once each) and the one-line quiet round. A schedule never turns on a
project mode.

## §site.docs/phone — Check in from your phone (`/docs/phone/`)

Reaching Sova from a phone over the tailnet, pairing it with a one-use code, installing it as an
app, and following sessions that are open in a terminal.

## §site.docs/change-direction — Change direction (`/docs/change-direction/`)

Rewinding to before a message, regenerating a reply, forking from a reply, steering or stopping a
running turn, and switching models mid-session (favorites and the saved default).

## §site.docs/install — Install (`/docs/install/`)

Installing Sova on a Mac or Linux machine with one command and its options, starting it and
opening it unlocked, the app-launcher entry that opens it in its own window, the access token,
the login service, running the installer again and the self-update from Settings it points to
(§site.docs/updates), removing it (the service, the extension links,
the install, the launcher, the app entry and its browser profile, and optionally pnpm's store and
cache), and the Claude Code models.

## §site.docs/memory — Memory (`/docs/modes/memory/`)

The memory minor mode: what it does and that the transcript never changes, turning it on from the
mode menu, the two types (UniiChat, credited to Victor Taelin with a link to his design, and
zoomable compaction), the Memory type panel and Save as default, the `zoom` and `date` tools,
updating, preparing and problems, rewind and fork, the Session pane's Memory outline, Settings →
Memory and its help, where memory can't be on (the terminal, workers, coding sessions, session
profiles), and the overseers' own switches, on by default.

## §site.docs/updates — Updates (`/docs/updates/`)

Keeping Sova current, in Setup after Install: running the install command again and how the
`stable` tag moves, pinning with `SOVA_REF`, then Settings → General's Updates · this machine: what
runs and the kind of copy, the source (stable, master or a branch), checking and what a check finds,
the dot on Settings, upgrading with the previous version kept until the new one answers and put back
when it doesn't, Upgrade automatically, the reload note, and that only the operator can update.
