---
title: Spec
description: With spec on, the agent works from the project's spec. It reads the claims a task touches before coding, and proposes changes to them in drafts it promotes once the work is done.
group: Modes
subgroup: Minor
order: 6
---

## The project's spec

A project's spec is its documentation of what the product does, kept in the repository under
`.sova/spec/`: a `manifest.json` that records every claim, and Markdown files that state them. A
claim is one promise about the product, listed with the files that implement it and labels saying
how far it has been checked. A project with no spec yet can start one: the agent begins it in a
draft.

Spec is a minor mode: turn it on in the chat's mode menu (see [Modes](/docs/modes/)), in either
major mode. While it's on, the agent gets a guide to the project's spec tools and follows it.

## Before coding

The guide has the agent read before it writes:

1. Find the claims the task starts from with a search by a few words of the task, a file
   or a name, and the spec's map when that finds nothing or the task spans a whole area.
2. Look at each claim's neighbours before reading them, and check what a claim it will change
   reaches.
3. Read each claim it starts from, and each linked claim that could matter, one passage at a time.
4. Treat a link it didn't read as unread, never as absent, and "not investigated" as unknown,
   never as "none".

When the work changes what the product does, the agent proposes the change to the spec in a
**draft**, kept apart from the current spec. A change reaches the spec only when it is
**promoted**.

## While coding

After a tool call that brings new changed files, the agent gets a short **`[spec census]`** note on
that tool result. It says how many changed files the spec covers and how many no claim covers yet,
and names the new ones. Read-only tools don't trigger it.

If the change contradicts a claim that existed before the task, or changes what a user sees beyond
it, the agent updates that claim in the task's draft without asking: your go-ahead for the task
covers it. Its reply lists each one as "Also updates {claim}: {what}".

## With align on too

When you confirm an alignment, that go-ahead is also your agreement to the promises it decides.
Before it builds anything, the agent writes each decision that changes behavior as a promise in a
draft, stamps it with who agreed and when, and promotes the new ones into the spec right away, marked
*agreed, not built*. The build then updates those same promises. If a later change edits the
numbers or names in a promise you agreed to without a new agreement, promotion points it out.

## Finishing

Once the agent stops editing, its next tool call carries one more line, the
**unread** line. It names the claims the agent's own changed files land in that the agent hasn't read
yet, ranked by the names, strings and numbers in the lines it changed, with a claim that only
shares a broad file with many others ranked lower: at most ten are marked read first, and the
rest are left to the one command that lists them, uncounted, so the line asks only for the ones it
names. A claim that still
states a value the change removed (say, "12 MB" after a limit went to 16 MB) says so and is always
marked read first. The agent reads the ones
marked first. The line comes once, and again only when a later edit lands in other claims.

When the work is done, the agent checks each promise it changed against what it built, records
what it checked, and promotes the drafts it verified. The session promotes its own drafts, on its own
branch, after its checks pass and before it calls that branch done or ready to land: nothing that
lands the branch promotes them, so the docs land in the same merge as the code they describe. Your
go-ahead to build or merge covers promoting and committing them; you're never asked for it
separately, and there is no second, docs-only merge. A draft whose branch already landed
is promoted on a fresh branch from the default branch, never on the default branch itself. Only if you say not to commit does the
session leave its evidence pending.

A turn with spec on ends when the model stops, as one with spec off does. Nothing re-prompts it,
and the "Also updates" line is the only spec line a reply carries; nothing checks it.

The tools check structure: that a claim exists, maps to files and is labelled. No check proves a
claim is true. That is still a reading of the code.

## The spec writer

A chat's [subagent profile](/docs/subagent-profiles/) can name a **spec writer**: a worker that
writes the spec drafts while spec is on, so the main model doesn't have to. Set it in the profile's
**Spec writer** section ("Use a spec writer while spec is on"). The gear on spec's row in the mode
menu opens that section for this chat's profile. With none, or with profile Off, the session writes
the spec itself. Without a fallback, if the writer can't run, the session writes it too.

## What workers get

Spec is the one minor mode that reaches workers. While it's on, every worker the chat starts gets
the same guide and a short note:

- its brief is its go-ahead;
- it works in the draft its brief names, or says which one it started;
- it doesn't promote or commit unless its brief says so, and then only on its brief's branch,
  never by landing on the default branch, because the parent promotes on its own branch;
- its final report lists each claim it updated that existed before the task.

When a worker that wrote code finishes, its summary carries one line naming the claims its changes
landed in, and the changed files no claim covers.

A worker gets the modes its parent has when it starts, so turning spec on later doesn't reach a
worker that's already running. A team's monitor gets no guide. A worker that runs on its worktree's
own agent folder always has spec on.

## Project coding sessions

A project has no coding-mode setting of its own: its coding sessions start in this computer's
default mode, the one **Save as default** in a chat's mode menu sets, and the project page names
it. An Overseer can start or switch a coding session with spec on or off, and in a project with a
spec it's told to keep spec on unless you say otherwise.

## A spec review

Sova ships a **Spec review** playbook. It answers one question about a project's spec: either how
the code and docs compare with an earlier revision, or how the spec workflow went. It runs only when
you send it, within the limits its brief sets (minutes, report length, model runs and tokens), and
it writes nothing but its report in the chat.
