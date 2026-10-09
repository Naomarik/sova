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

1. Find the claims the task starts from, with the spec's map and a lookup by file or name.
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

If the change also alters a claim the task didn't start from, the agent asks you in its plan,
in one question: "This also changes {claim}: {what}. OK?"

## With align on too

When you confirm an alignment, that go-ahead is also your agreement to the promises it decides.
Before it builds anything, the agent writes each decision that changes behavior as a promise in a
draft, stamps it with who agreed and when, and promotes the new ones into the spec right away, marked
*agreed, not built*. The build then updates those same promises. If a later change edits the
numbers or names in a promise you agreed to without a new agreement, promotion points it out.

## Finishing

When the work is done, the agent checks each promise it changed against what it built, records
what it checked, and promotes the drafts it verified. The session promotes its own drafts.

A turn with spec on ends when the model stops, as one with spec off does. Nothing re-prompts it,
and replies carry no required spec lines.

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
- it doesn't promote or commit unless its brief says so, because the parent promotes;
- it puts anything it would flag into one question in its final report.

A worker gets the modes its parent has when it starts, so turning spec on later doesn't reach a
worker that's already running. A team's monitor gets no guide. A worker that runs on its worktree's
own agent folder always has spec on.

## Project coding sessions

A project's coding sessions start in the mode set on its project page. **Automatic**, the default,
turns spec on when the project has `.sova/spec/manifest.json` when the session starts. The project
overseer can't turn spec off while the project's setting has it on.

## A spec review

Sova ships a **Spec review** playbook. It answers one question about a project's spec: either how
the code and docs compare with an earlier revision, or how the spec workflow went. It runs only when
you send it, within the limits its brief sets (minutes, report length, model runs and tokens), and
it writes nothing but its report in the chat.
