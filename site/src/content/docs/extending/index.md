---
title: Extending Sova
description: Every way to make Sova yours, by what you want to do. Each row links to its guide or names the screen.
group: Extending
order: 20
---

Pick what you want to do. Or skip this page: switch a chat to [Create](/docs/modes/create/), say what
you need, and it finds the way. These are its topics, in its order.

## Make it yours

| You want | Where |
|---|---|
| Colours, type and how this browser shows Sova | [Themes](/docs/themes/), in Settings → Themes: Light, Dark or Auto, a dark and a light pick, and a theme of your own as a JSON file in `~/.pi/agent/sova/themes/` |
| Which models you can use, what new chats start on, and the sign-ins behind them | Settings → Models and Settings → Accounts |
| Which models your workers and teams run on, and named worker personas | [Profiles](/docs/subagent-profiles/), in Settings → Profiles |

## Teach your chats

| You want | Where |
|---|---|
| Standing rules every chat in a folder, or on this computer, follows | An `AGENTS.md` file in that folder, or in your agent folder |
| Recipes a chat loads when relevant, and reusable slash commands | Skills and prompt templates in your agent folder or the project's `.pi/` folder. [Playbooks](/docs/playbooks-and-schedules/) are recipes you run on purpose |
| What new chats start in, how planning behaves, and modes your project ships | [How modes work](/docs/modes/), Settings → Alignment and [Project modes](/docs/modes/project-modes/) |
| Named kinds of chat, what each may and may not do | Settings → Profiles, or a project's `.sova/profiles/` folder |

## Give them new abilities

| You want | Where |
|---|---|
| A new tool for the agent to call, and how it gets approved | [Project modes](/docs/modes/project-modes/) first, an [MCP server](/docs/mcp-servers/), or an [add-on](/docs/extending/add-ons/) for all your chats |
| Your own page, buttons and cards inside Sova | A [Sova extension](/docs/extending/extensions/), added and approved in Settings → Extensions |
| Add-ons that change what a chat can do, from a file or a package | [Add-ons in a Sova chat](/docs/extending/add-ons/) |
| Drive Sova from your own program, and follow what happens | [Scripting Sova](/docs/extending/scripting/) |

## Keep it safe

| You want | Where |
|---|---|
| What agents may touch, and who approves what | The Sandbox rows in a chat's composer, Settings → Profiles, and the project page's Settings tab |

## Run your project

| You want | Where |
|---|---|
| How your project runs, tests, shares and ships | [The project definition](/docs/extending/project-definition/) |
| What must pass before a branch reaches your project, and how it lands | The project's Merge Queue tab, Settings → Merge Queue, and the [definition's `merge` section](/docs/extending/project-definition/#merge) |
| Numbered versions of your project, and how they're made and published | The project page's Releases tab, and the [definition's `release` section](/docs/extending/project-definition/#what-each-part-is-for) |
| Recipes you run by hand, or that run by themselves | [Playbooks and schedules](/docs/playbooks-and-schedules/) and [Automation files](/docs/extending/automation-files/) |
| Buttons, cards and drawings that are your project's own | [Card types](/docs/extending/card-types/), [Drawing kinds](/docs/extending/drawing-kinds/), and offers on the project page's Settings tab |
| How the Overseers and the Project Assistant watch, act and hold back | [The Overseer](/docs/overseer/), Settings → Overseer, and the project page's Settings tab |

## Reach you and others

| You want | Where |
|---|---|
| How Sova tells you things, and what it writes for you | [Needs you](/docs/needs-you/) and Settings → Notifications |
| Your other computers, public links, and this computer's setup | [Sova Mesh](/mesh/), [Check in from your phone](/docs/phone/), [Install](/docs/install/) and [Updates](/docs/updates/) |

## What has no supported way today

- **Changing Sova's own code.** Create won't. The nearest ways are everything on this page.
- **A new major mode.** Sova has three. The nearest way is a [project mode](/docs/modes/project-modes/),
  which adds instructions, tools, commands and hooks on top of them.
- **Webhooks.** Sova never calls you. The nearest way is the [event stream](/docs/extending/scripting/#follow-what-happens),
  which a program of yours stays connected to.
- **Changing one of Sova's own screens.** The nearest way is a Sova extension, which has its own page
  and adds to the places Sova opens to extensions.
