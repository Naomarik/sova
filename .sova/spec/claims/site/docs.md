# §site/docs — The docs pages on Sova's site

The site's `/docs/` section explains Sova to the person running it: how a chat's modes shape what
the agent does, the features the landing page names, and how to install it. Each page is a
hand-written Markdown file in the site's docs collection, written in the user's words from the
claims its record `requires`, and it promises nothing those claims don't say. The pages carry no §
ids, no source paths and no API routes; this area is where a page's sources are recorded, so a
change to a claim names the pages it reaches (`impact`) and a page names the claims it rests on
(`where`). The site sits outside the spec's code boundary.

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

The experimental review of an alignment's plan and implementation: turning it on, the Reviewer
route, when it runs, blockers, and what the card shows.

## §site.docs/spec-mode — Spec (`/docs/modes/spec/`)

The spec minor mode: working from the project's spec, the census note, drafts and promotion, the
spec writer, what workers get, and project coding sessions.

## §site.docs/vis — Vis (`/docs/modes/vis/`)

The vis minor mode: the drawings the agent can put in a reply, where they render, and what is never
trusted from the model.

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
opening it unlocked, the access token, the login service, running the installer again, and the
Claude Code models.
