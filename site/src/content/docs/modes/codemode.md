---
title: Codemode
description: With codemode on, the agent can run a short JavaScript script that calls the chat's other tools, several at once, and filters their output before it reads it.
group: Modes
subgroup: Minor
order: 8
---

## What codemode does

Codemode is a minor mode: turn it on in the chat's mode menu (see
[How modes work](/docs/modes/)), in either major mode. It gives the agent pi's `codemode` tool. With
it, the agent can write one script that runs several tool calls at once and keeps only the part of
their output it needs, instead of making each call and reading each result in turn.

The tool is the whole mode. There are no extra instructions: turning codemode on adds the tool, and
turning it off removes it.

## What a script can call

A script can call the chat's other tools, with a few exceptions that only the agent may call
directly, because Sova reads their results back: the `align` tool, starting a worker or a team, and
sending to another session.

A script can also call a model. Those calls go through this device's model policy, which refuses a
model you've turned off in Settings → Models, and they count as the chat's own usage.

## What you see

The calls a script makes don't appear as separate rows in the transcript. The script's own card
shows the script, with **Copy Script**, and each call it made with its status: Running, Done, Failed
or Cancelled. It updates live while the script runs, then shows the output.

## When a switch applies

A switch made between turns adds or removes the tool at once. A switch made during a turn applies
when that turn ends. Like turning align or vis on or off, it changes the agent's tools, so the
model provider's prompt cache starts again.

## Where codemode is available

- **In Sova**, in every ordinary chat, whether its model runs on pi or Claude Code. The Overseer
  doesn't load it.
- **In a terminal**, pi has its own `codemode` tool, and the mode switches it the same way.
- **Workers never get it.** A worker's tools come from its brief.

With [spec](/docs/modes/spec/) on, a spec note about a call the script made is repeated on the
script's result, where the agent reads it.
