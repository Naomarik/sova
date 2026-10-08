---
title: Delegate
description: In Delegate, the agent orchestrates. It sorts the work into 4 kinds and hands each to a worker on the model your subagent profile names for it.
group: Modes
order: 2
---

## What changes

Delegate is a major mode: pick **delegate** in the chat's mode menu (see [Modes](/docs/modes/)).
From the chat's next message, the agent plans and routes the work to subagents (workers) instead of
doing it all itself. Delegate routes 4 kinds of work:

| Work kind | What it covers |
|---|---|
| Planning & specs | Design that edits nothing, including any investigation that feeds it |
| Investigation | Focused, read-only research or diagnosis |
| Routine implementation | Mechanical, low-risk changes |
| Complex implementation | Ambiguous, cross-cutting or high-risk changes |

Each kind has a **route**: a worker described by its backend (`pi` or `Claude Code`), its model and
its effort, plus an optional **fallback**. The routes come from the chat's
[subagent profile](/docs/subagent-profiles/), so two chats can route the same kind of work to
different models.

## When a route can't run

If a route's primary model can't run (for example, your model policy keeps it from subagents),
Delegate uses that route's fallback. **Without a fallback, the agent asks you which model to use.**

## Off: the agent picks

A chat whose subagent profile is **Off** still delegates, and the agent still sorts the work into
the 4 kinds. But no route is set, so the agent chooses each worker's backend, model and effort
itself.

## Set up the routes

The gear on Delegate's row in the mode menu, **Configure Delegate**, opens Settings → **Subagents**,
where this chat's routing is edited. It switches nothing, so you can set Delegate up before turning it on.

In the profile's **Delegate routing** section, each work kind has one row of three choices:
Backend, Model and Effort.

- **Models are choices, not free text.** Each backend lists what it offers: pi lists the models you
  have credentials for, and Claude Code lists Sova's Claude catalog. Effort lists what the chosen
  model takes. Nothing is picked for you: changing the backend clears the model and effort.
- **Add Fallback** on a route's head line adds a second row, and **Remove Fallback** takes it away.
  A fallback can't be the same worker as its primary.
- **Save Changes** saves every route at once. A saved change reaches every chat on that profile
  from its next turn. Workers that are already running keep their models.

A model that's stored but not listed now stays in its row, marked "— not offered" (the backend
answered without it) or "— not verified" (the backend couldn't answer). A model your settings keep
from subagents reads "— off for subagents": it is refused when a worker starts, and Delegate uses
the fallback, or asks.

When you have no earlier Delegate settings, the first profile, **My setup**, starts with these
routes, all on Claude Code:

| Work kind | Model · effort | Fallback |
|---|---|---|
| Planning & specs | Fable 5.1 · medium | Opus 5.5 · high |
| Investigation | Opus 5.5 · low | none |
| Routine implementation | Opus 5.5 · low | none |
| Complex implementation | Opus 5.5 · medium | none |

## Teams

Besides single workers, the agent can start a **team**, in either major mode. From the chat's
subagent profile, a new team can get two standing members:

- a **coordinator**, which does no implementation and is the only member that talks to your chat;
- a **monitor**, which watches the team's context and provider usage on a timer, and reports to the
  coordinator.

The profile's **members default** is the model a team member runs on when nobody named one. Without
it, such a member runs on the chat's own model. Profile **Off** gives teams no standing members and
no members default. All of this is edited in the profile's **Teams** section.

## Watch the workers

While workers run, the composer shows a row such as "2 of 5 subagents working". Press it, or type
`/agents`, to open the **Session detail** pane beside the chat: this chat's workers on one side,
the selected worker's transcript on the other, updating live.

A worker's view is read-only: it has no composer, and nothing you do there sends to the worker. Its
head shows its name and id, its status, its model and effort, the tokens it has spent and how full
its context is. Finished, failed and stopped workers stay readable.

## Where workers may start

A worker may start only in the chat's own folder (or below it), or inside one of the chat's active
worktrees. Any other folder is refused, with a message naming the chat's worktrees. See
[Worktrees and changes](/docs/worktrees-and-changes/).

## Workers after a restart

A worker is a process of the session that started it, so a server restart stops it. Sova keeps a
record of every worker, so after a restart the workers come back **as records**: listed in the
pane with their transcripts and their spend, but not running.

- A worker that had finished keeps its final status: Done, Failed or Stopped.
- A worker that was running reads **Interrupted**, and its unfinished turn stays as it was. Its view
  in the pane says when it stopped: "Not running since a server restart; it was mid-task at…"
- Nothing starts again by itself. The agent resumes a worker with its `agent_resume` tool, or you can
  type `/agent-resume <id>`. The worker keeps its id and its transcript, rejoins its team, and comes
  back idle: it waits for new work rather than finishing the interrupted turn.

## Strict

With the chat's **strict** flag on, Delegate also takes the agent's `edit` and `write` tools away;
`bash` and every other tool stay. Set it in a terminal with `/mode strict on`; the mode menu shows
it read-only. See [strict](/docs/modes/#strict).

## Where Delegate isn't available

- **The Overseer** is always in normal mode.
- **A project's coding sessions** run in normal mode unless you allow Delegate for that project on
  its project page.
