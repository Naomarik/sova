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

The front page: what a mode is, a card per major and minor mode, and links to the feature and
setup pages.

## §site.docs/modes — Modes (`/docs/modes/`)

The major and minor modes side by side, switching them per chat from the composer's mode menu,
the default for new sessions, strict, the terminal's commands, what workers get, and the sessions
that choose their own mode.

## §site.docs/delegate — Delegate (`/docs/modes/delegate/`)

The orchestrating major mode: the four kinds of work and where each is routed, fallbacks and Off,
teams, watching workers, and workers after a restart.

## §site.docs/subagent-profiles — Subagent profiles (`/docs/subagent-profiles/`)

What a subagent profile holds, how a chat picks one, editing them in Settings, switching a chat's
profile after a usage limit, and Off.

## §site.docs/align — Align and alignments (`/docs/modes/align/`)

The align minor mode: what an alignment holds, answering it, the card, chip and session mark,
Needs you and notifications, and the terminal viewer.

## §site.docs/align-review — Adversarial review (`/docs/modes/align/review/`)

The review of an alignment's plan and implementation: turning it on, the Reviewer
route, when it runs, blockers, and what the card shows.

## §site.docs/spec-mode — Spec (`/docs/modes/spec/`)

The spec minor mode: working from the project's spec, the census note and its one unread line before
finishing, drafts and promotion, the
spec writer, what workers get, and project coding sessions.

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
out for its pane's width (flow, state, sequence, chart, matrix) is drawn for the docs column and
for a 320px phone, and the page shows the one that fits its figure's width. Interactive parts
show their first state and do nothing: a sequence's **Step Through** button is disabled. A `vis
svg` example is drawn in place, as its frame would show it; a `vis html` example shows only its
source, with a line saying that in the chat it runs in a sandboxed frame. A changed kind, View or
style reaches the page only when the generator runs again.

## §site.docs/codemode — Codemode (`/docs/modes/codemode/`)

The codemode minor mode: the script tool it adds, what a script can call, the script's card, when a
switch applies, and where it is available.

## §site.docs/worktrees-and-changes — Worktrees and changes (`/docs/worktrees-and-changes/`)

How a session keeps track of the git worktrees it works in (where workers may start, merging and
cleaning up), and how you read what changed as numbered steps.

## §site.docs/needs-you — Needs you (`/docs/needs-you/`)

The sidebar list of sessions waiting on you, the Overseer's attention digest, and the same news as
phone notifications, with their settings.

## §site.docs/overseer — The Overseer (`/docs/overseer/`)

The session that reads every other session and acts on them through Sova: what it is, what it may
do and when it asks first, its notes, ideas and to-dos, and its settings.

## §site.docs/phone — Check in from your phone (`/docs/phone/`)

Reaching Sova from a phone over the tailnet, pairing it with a one-use code, installing it as an
app, and following sessions that are open in a terminal.

## §site.docs/change-direction — Change direction (`/docs/change-direction/`)

Rewinding to before a message, regenerating a reply, forking from a reply, steering or stopping a
running turn, and switching models mid-session.

## §site.docs/install — Install (`/docs/install/`)

Installing Sova on a Mac or Linux machine with one command and its options, starting it and
opening it unlocked, the access token, the login service, running the installer again, removing
it (the service, the extension links, the install and the launcher, and optionally pnpm's store
and cache), and the Claude Code models.
