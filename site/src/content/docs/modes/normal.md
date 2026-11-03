---
title: Normal
description: In normal mode, the agent you chat with does the work itself. It's the default major mode.
group: Modes
subgroup: Major
order: 1
---

## What it is

Normal is the default major mode: new chats start in it unless you've saved Delegate as your
default (see [Modes](/docs/modes/)). The agent you chat with does the work itself, and it can still
start workers and teams when it chooses.

## When to pick it

Pick normal when you want one agent that both talks with you and does the work. It already has the
whole conversation and its context, so nothing is handed off to a worker that starts without it.

Pick [Delegate](/docs/modes/delegate/) instead when you want the work routed to workers, on the
models your [subagent profile](/docs/subagent-profiles/) names.

## Switch to it

- Pick **normal** or **delegate** in the chat's mode menu (see [Modes](/docs/modes/)).
- In a terminal, type `/mode normal`. `alt+m` switches between normal and Delegate.

A switch applies from that chat's next message.

The Overseer always runs in normal mode.
