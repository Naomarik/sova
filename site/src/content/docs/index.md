---
title: Sova docs
description: Sova is where you run the pi coding agent. These pages explain how a chat's modes shape what the agent does, and how to use the features around them.
group: Start
order: 0
---

## Modes, in one paragraph

Every chat has one **major mode** and any set of **minor modes**. The major mode decides how the
agent works: **normal** is pi as usual, and **delegate** has the agent route its work to subagents
(workers) instead of doing it all itself. Minor modes add one thing each on top of that, such as
agreeing on a plan before building (**align**) or working from the project's spec (**spec**). You
switch them per chat from the mode menu in the composer, and a switch applies from that chat's next
message. [How modes work](/docs/modes/) covers the menu, the default for new chats, and the terminal
commands.

## The modes

| Mode | Kind | What it does |
|---|---|---|
| normal | Major | Pi as usual. The agent does the work itself, and can still start workers and teams. |
| [delegate](/docs/modes/delegate/) | Major | The agent plans and routes 4 kinds of work to workers, each on the model your subagent profile names. |
| [align](/docs/modes/align/) | Minor | The agent agrees with you on what to build first, and records each agreement as an alignment you answer in chat. |
| [spec](/docs/modes/spec/) | Minor | The agent reads the project's spec before coding, and proposes changes to it in drafts before promoting them. |
| [vis](/docs/modes/vis/) | Minor | The agent can draw small diagrams and charts in its replies, which Sova renders itself. |
| [codemode](/docs/modes/codemode/) | Minor | The agent can run a short script that calls its other tools, several at once, and filters their output. |

[Subagent profiles](/docs/subagent-profiles/) hold the models every subagent uses: Delegate's
workers, team members, the spec writer and the reviewer. Each chat picks one in its mode menu.

## Around the modes

- [Worktrees and changes](/docs/worktrees-and-changes/): work in a separate worktree, and read
  every change as steps before it lands.
- [Needs you and phone notifications](/docs/needs-you/): the sessions waiting on you, in the sidebar
  and on your lock screen.
- [The Overseer](/docs/overseer/): one chat that watches every session and acts for you.
- [Check in from your phone](/docs/phone/): pair a phone, and pick up a terminal session in the browser.
- [Change direction](/docs/change-direction/): rewind, regenerate, fork from a reply, steer and switch models.

## Set up

- [Install Sova](/docs/install/): what it needs, and how to start it.
