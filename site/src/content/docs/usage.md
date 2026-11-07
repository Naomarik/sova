---
title: Usage and costs
description: What your agents spend, at each provider's API prices, by model, project, session and day, and how close each subscription is to its limit.
group: Features
order: 14.5
---

Sova shows two kinds of figures. **Costs** are what every model call on this computer would cost at
each provider's API prices. **Subscription limits** are each provider's own reading of how much of
your plan you've used. They answer different questions: one is where the tokens went, the other is
when you'll be cut off.

## What gets counted

Every model call made on this computer is recorded once, when it ends: your sessions' replies on
every branch, retries and compaction, the workers they start at any depth (pi or Claude Code), the
Overseer, and the one-shot side calls Sova makes for a session or for itself, such as titles,
decisions and image descriptions.

Each call is priced at its provider's published API rates, from [models.dev](https://models.dev),
at the price in force when the call was made. Input, output, cache reads and cache writes each have
their own rate. A model with no price on record is still counted, marked **unpriced**, and adds
nothing to the dollars. A model running on your own hardware costs nothing.

These figures are not your bill. Most chats run on subscriptions, which bill differently; the
dollars say what the same work would cost at API prices.

## The Costs tab

**Agents → Costs** (`#/agents/costs`) is this computer's spend.

<!-- screen: usage-costs | The Agents page's Costs tab: the total and its split into main sessions, workers and one-shots with their cache hit rates, the cost per day, and the provider and kind tables. -->

- **Range and filters.** `7d`, `30d` (the default) or `All`, and a **Provider** and a **Model**
  picker. They apply to everything below and live in the address, so a reload or a shared link
  keeps them.
- **Total, Main sessions, Workers, One-shots.** Each with its cache hit rate: the share of input
  read from cache ("97% from cache").
- **Cost per day**, one bar per day (per week over a long range). Hover a bar for its figure.
- **By provider**: tokens, hit rate and cost. **By kind**: main sessions, the Overseer, workers and
  one-shots.
- **By model**: new input, cache reads, hit rate, output and cost. Click a model for **where its
  cost went**: one bar split into cache writes, cache reads, output and input, each with its
  dollars, share and tokens.
- **By project**: each project (its worktrees included), each other code checkout on this computer,
  the Overseer, and **Other folders** last. The rows add up to the total.
- **Top sessions**, most expensive first. Click one to open it; a worker opens its parent.

<!-- screen: usage-models | The Costs tab's By model table: one row per model with its new input, cache reads, cache hit rate, output and cost. -->

The tab's foot says when the prices were last pulled and the last change found. Prices are pulled
every 6 hours; **Refresh Prices** pulls them now. Today's spend, since local midnight, also shows in
the Agents page's head on this tab.

The Costs tab counts this computer only. Each computer you use keeps its own.

## A project's cost

A project's **Cost** tab is what that project's sessions would cost: the coding sessions and their
workers, the project overseer's conversations, and the work it started on its own.

<!-- screen: project-cost | A project's Cost tab: the total at API prices and when it was counted, split by who started the sessions, with the breakdown by kind and model behind a disclosure. -->

It shows the total and when it was counted, who started what (the overseer, you, or Sova on its
own), the most expensive sessions, and, behind **Breakdown by kind and model**, a table per kind and
per model with each token kind's dollars and count. Notes under it say what isn't priced or counted.
The total also shows as a chip in the project's summary.

A project's row on the Costs tab can read higher than its Cost tab: the row counts every session in
the project's folders, not only the ones tied to the project.

## A session's spend

A session's **Usage** tab, in the session pane, is that session's spend: tokens in and out, dollars
and cache hit rate, then a row per model and where it was spent (**Main thread**, **Side calls**,
**Subagents**). Click a row for where its cost went. The session's workers are counted in it.

## Time spent in a session

A session's **Time Spent** tab, between Usage and Context in the session pane, says how long you have been with the session and how long its agent has worked. At its top are **You** and **Agent**, and one word: **Counting** while this page counts the session, else **Paused**.

- **When your time counts.** Only while the page is visible and you have been active recently: about a minute, longer when there is a lot of text in view, never more than 3 minutes. Hiding the tab stops it at once, and any touch, click, scroll or key starts it again. Voice input keeps it counting while it records.
- **Where it went.** Rows split your time into Reading, Typing, Dictating, Scrolling, Reviewing Changes, Reviewing Screenshots, Viewing Tours and Other, and add up to You. Reading opens into Main Thread, Alignments and Workers.
- **Alignments.** A line per alignment, with how long it was on screen.
- **Your Messages.** With **Label your messages** on in Settings → Decisions (off by default), each message you type or dictate gets one label: Specifying, Directing, Reworking or Asking. Your time goes to the next message you send, and the rows show where it went; open a row for the messages it counted. Labelling a message sends its start and the end of the reply before it, redacted, to the Decisions providers (Jev, then the fallback model if you set one); nothing is sent while the switch is off, and the agent never sees a label.

## Subscription limits

The **Usage** page (`#/usage`), from the Usage row at the foot of the session list, shows each
provider's own reading of your plan: Claude, OpenAI, Ollama Cloud, Z.ai and DeepSeek, one card each.

<!-- screen: usage-limits | One Claude account on the Usage page: each 7-day window's share used, when it resets, the pace per day and when it runs out at that pace, last week for comparison, and the week's burn chart. -->

- **Each window** (5-hour, 7-day, monthly) shows how much is used, a bar with a tick for how much of
  the window has gone (fill past it means you're going faster than the window), and when it resets.
- **Pace.** Sova keeps each window's readings over time, so it can say how fast you're using it
  ("≈15%/day"), when it runs out at that pace ("used up Fri 3:06 PM, 7h before reset"), and where you
  were at this point last week. A chart draws this week against last.
- **Claude accounts.** Every login of one account is listed under it with its standing, and which
  one new chats start on.
- **DeepSeek** reports a balance instead of windows: the money left.
- **Ollama Cloud** reports its activity and credits: reported dollars, requests and tokens.

The page says when it was updated and when the next refresh is. Sova refreshes these readings every
few minutes on its own; **Refresh Usage** fetches them now.

The foot of the session list keeps a glance of the same bars, so you can see a limit coming without
opening the page.
