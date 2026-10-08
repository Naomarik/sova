---
title: Align and alignments
description: With align on, the agent agrees with you on what to build before it builds. Each agreement is an alignment, a card you answer in chat.
group: Modes
order: 4
---

## What align does

Align is a minor mode: turn it on in the chat's mode menu (see [Modes](/docs/modes/)), in either
major mode. While it's on, the agent works out what to build with you first, and records each
agreement as an **alignment** with its `align` tool. A chat can hold several alignments at once,
one per concern.

You never edit an alignment yourself. You answer in chat, and the agent records your answer. It
works the same in Sova and in pi's terminal UI.

## What an alignment holds

Each alignment has an id (`al_1`, `al_2`…), a title and a one-line summary of the concern. Then:

- **Findings** (`f1`, `f2`…): what the agent found while investigating.
- **Approach** (`a1`, `a2`…): the steps it proposes.
- **Rejected** (`x1`, `x2`…): alternatives it turned down, each with why.
- **Questions** (`q1`, `q2`…): what it needs you to decide. A question has a topic, the ask,
  optional context, optional options lettered a, b, c…, each with its trade-off, and a
  **recommendation** with its reason.

Ids are never reused within an alignment, so "q3" keeps meaning the same question.

## Status

An alignment's status follows from its contents:

| Status | When |
|---|---|
| Aligning | A question is still open, or there are no questions yet |
| Confirmed | Every question is decided or dropped |
| Implementing | The agent has started building it |
| Done | The agent has finished it |
| Dropped | The agent dropped it, with a reason |

The agent can't mark an alignment Implementing or Done while a question is still open.

## Answer the questions

Answer in the composer, in your own words. Short forms work:

- **"3a"** answers question 3 with its option a.
- **"q1 yes, your recs for the rest"** decides q1 and takes the recommendations for the others.
- A **go-ahead** with questions still open takes the recommendations for them first. An answer to
  only some questions is not a go-ahead.

The agent records what you answered as your decision, and a recommendation you told it to take as
"accepted recommendation". Questions you didn't answer stay open.

## The card

Each alignment shows as a card in the transcript, where the agent's call is. The newest version of
each alignment is the full card. Earlier versions fold to one line that says what changed, such as
"q3 decided · +q11", and open in place.

The card shows the summary, then the **Approach**, then the questions. Open questions are expanded;
decided and dropped ones fold to one line with their outcome. **Findings** and **Rejected** start
folded at the bottom. Past Aligning, a chip shows the status.

In a chat Sova runs with align on, the newest card of an open alignment can be answered directly:

- **Tick a recommendation** to take it.
- **Pick an option** to answer a question with it. Picking the option the recommendation names is
  the same as ticking it. Each question holds one pick.
- Your picks gather above the composer and go out with your next message, along with anything you
  type. You can send them with no text.
- **Go With Recommendations** sends one message: take every open recommendation, and go ahead. It
  waits while a turn runs, and while the composer holds a draft ("Send or clear your draft
  first.").

None of these change the alignment directly. They write an ordinary message for the agent to
record, exactly as if you had typed it.

## The chip in the composer

While an alignment is open, the composer shows a chip such as **1 align · 5/7 decided**: the open
alignments, and how many of their questions are decided. Press it to list them, each with a
progress bar; choose one to jump to its card.

## When the agent is waiting on you

When the agent's latest alignment change came after your last message and questions are open, the
session is **waiting on your answers**:

- Its row in the session list shows the number of open questions.
- It's listed in **Needs you** at the top of the sidebar, as "3 open questions in al_3 {title}".
- It can send a phone notification, **Open questions**, on by default. See
  [Needs you](/docs/needs-you/).

Once you've replied and the agent moved on without touching an alignment, or you turn align off,
the questions stay on the card and the chip but leave the row, Needs you and notifications. Once
the session's branch is merged, they leave Needs you too.

## What keeps the agent on it

- With each message you send while an alignment is open, the agent gets a hidden note listing the
  open questions with their ids, options and recommendations, so "3a" maps onto the right
  question. After a compaction it gets the same, with the decided questions too.
- If a reply reads like a plan that asks you to decide, but the agent recorded nothing, it gets one
  reminder to record it, once per run.
- **Nothing blocks the agent.** It can still edit, start workers or create worktrees while a
  question is open, so a stuck worker or a parallel concern never leaves the session stuck.

## In the terminal

pi's terminal UI draws each alignment as a compact card, and shows the open alignments above the
editor while align is on.

| Command | What it does |
|---|---|
| `/align` | Open the alignment viewer, one alignment at a time (← and → switch) |
| `/align status` | List the alignments |
| `/align export [path]` | Write them out as Markdown |

## Where align isn't available

- **The Overseer** is always in normal mode with no minor modes.
- **A project's coding sessions** don't take align, because nobody answers a coding session's
  questions. The one exception is a playbook run that you answer yourself.

Workers never get align: aligning is a conversation with you. A planning worker can still write an
alignment for the agent to import.
