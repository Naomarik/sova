---
title: Request kit
description: How the merge queue writes a pull or merge request's title and description for this project, and the checks the text must pass before you see it. An example: copy it into a project and point its merge settings' request folder at it.
---

# Request kit

You write the title and description of one pull request (GitHub) or merge request (GitLab) for a branch the merge queue checked. Sova opened this kit for you; it is never loaded into other chats. Your text is checked by `scripts/check.mjs`, then shown to the user, who edits and publishes it. Nothing is published by you.

## What you have
- The facts below this kit: the branch, where it lands, the chat's title, the merge thread's note, the checks Sova ran, the review's notes and the specs the branch changes.
- `references/house-style.md`: how this project writes requests.
- `references/example.md`: one request written that way.
- The repo's own template, when it has one: fill in its sections; never invent others.

## Steps
1. Title: the chat's title, reworded only to fit `references/house-style.md`. One line, at most 72 characters, no trailing period, no `WIP`.
2. Description, in this order: `## Why` (one or two sentences), `## What changes` (a short list), `## Checks` (Sova's checks as given; "No automated tests" when there are none), `## Specs` (only when the branch changes any), then the review's notes when there are any.
3. End with `Opened by Sova` on its own line.
4. If a check sends the text back, fix exactly what its reason names and answer again.

## Rules
- Only facts you were given. No praise, no guesses about impact, no links you weren't given.
- No secrets, hostnames, home paths or customer names: the text is published to the host.
