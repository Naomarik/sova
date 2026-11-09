---
title: Align and alignments
description: With align on, the agent agrees with you on what to build before it builds. Each agreement is an alignment, a card you answer in chat.
group: Modes
subgroup: Minor
order: 4
---

## What align does

Align is a minor mode: turn it on in the chat's mode menu (see [Modes](/docs/modes/)), in either
major mode. While it's on, the agent works out what to build with you first, and records each
agreement as an **alignment** with its `align` tool. A chat can hold several alignments at once,
one per concern.

When an alignment opens depends on the **Eagerness** you choose in Settings → Alignment:

- **Eager**, the default: any request that implies work (a feature, a fix it investigated, a
  refactor, new files, any multi-step change) gets an alignment first, even one that already looks
  fully specified, and the agent leans toward asking. Questions and explanations need none.
- **Careful**: the agent asks itself what you want to be different when it's done. If it's the
  product, however you phrase it, it opens an alignment; if you want to know or understand
  something and the product can stay as it is, the answer comes in chat. Looking into something
  broken or missing is the first step of a change, so what it finds goes on a card, not into a plan
  in the reply. When it can't tell, it opens the alignment anyway.

Either way, nothing is built until you confirm an alignment (unless you said to skip alignment),
and a "go", "yes" or "fix it" to anything the agent sketched in chat opens a card first rather than
starting the build.

While align is on, every reply opens with a short part for you: the answer, what changed, what you
must decide, and any warnings or things it didn't check. The agent's working detail, when there
is any, comes after it under **Working notes**, which the chat shows folded closed.

You never edit an alignment yourself. You answer in chat, and the agent records your answer.

## What an alignment holds

Each alignment has an id (`al_1`, `al_2`…), a title and a one-line summary of the concern. Then:

- **Findings** (`f1`, `f2`…): what the agent found while investigating.
- **Approach** (`a1`, `a2`…): the steps it proposes.
- **Rejected** (`x1`, `x2`…): alternatives it turned down, each with why.
- **Questions** (`q1`, `q2`…): what it needs you to decide. A question has a topic, the ask,
  optional context, optional options lettered a, b, c…, each with a one-line consequence of picking it, and a
  **recommendation** with its reason.
- **Technical notes** (`t1`, `t2`…): the files, code and technical detail that a plan written for
  someone who doesn't read code leaves out of the other fields.

Ids are never reused within an alignment, so "q3" keeps meaning the same question.

## Settings → Alignment

How readily alignments open and how the agent writes them is set in **Settings → Alignment**:

- **Eagerness.** **Eager**, the default, opens an alignment card for any request that implies
  work, and leans toward asking first. **Careful** opens one when you want something changed;
  questions get their answer in chat. Either way, nothing is built until you confirm a card. A
  change reaches open chats at their next message.
- **Writing style.** **Project manager**, the default, describes only screens, wording and
  behaviour, with no code; it still asks a technical choice you'd notice (speed, cost, data kept or
  lost) as a product question, and puts the technical detail in the technical notes. **Simplified**
  uses short sentences in everyday words and fewer items. **Technical** keeps files, code and
  technical trade-offs in the plan. A change reaches open chats at their next message.
- **Visuals.** With **Draw when it helps** on, the agent can draw on the card when a picture
  explains faster than words: a wireframe for a simple screen or a flow across screens, a clickable
  prototype for a screen beyond a simple one, or a flow for a change in behaviour, at most 3 per alignment. It applies to sessions
  you start after saving.
- **Review.** **Adversarial review** has a read-only reviewer check the plan and the diff of risky
  work. See [Adversarial review](/docs/modes/align/review/).

A profile can set its own eagerness, writing style and visuals, in its Models part (Settings → Profiles).

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
decided and dropped ones fold to one line with their outcome. **Technical notes** sit folded under
the Approach; **Findings** and **Rejected** start folded at the bottom. Past Aligning, a chip shows
the status. A visual is drawn under its question's context, or the alignment's under the summary,
and each alignment names its writing style in its header ("Project manager style"; an
older one may name none).
When the agent decides a request needs no alignment, it shows one line instead:
"No alignment needed", with why.

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

## The badge in the message box

While an alignment is open, a small badge sits at the left edge of the message box. Its ring fills
as questions are decided, the number in the middle is the questions still open, and the dots under
it are the open alignments. A numeral on top (I, II, III…) counts any option cards waiting too.
Press it to open **Waiting on you**: each alignment with its progress and its next open question,
and **Show in Chat** to jump to its card.

## When the agent is waiting on you

When the agent's latest alignment change came after your last message and questions are open, the
session is **waiting on your answers**:

- Its row in the session list shows the number of open questions.
- It's listed in **Needs you** at the top of the sidebar. Hover the row for the reason, "3 open questions in al_3 {title}".
- It can send a phone notification, **Open questions**, on by default. See
  [Needs you](/docs/needs-you/).

Once you've replied and the agent moved on without touching an alignment, or you turn align off,
the questions stay on the card and the badge but leave the row, Needs you and notifications. Once
the session's branch is merged, they leave Needs you too.

Only your own messages count as a reply. A message from the Overseer or an extension doesn't, and
neither does an answer on a transcript card or an offer: pressing one while the session waits sends
a message marked **From a card**, which starts a turn but leaves the questions open and the session
waiting.

## What keeps the agent on it

- With each message you send while an alignment is open, the agent gets a hidden note listing the
  open questions with their ids, options and recommendations, so "3a" maps onto the right
  question. After a compaction it gets the same, with the decided questions too.
- When you asked for a change and the agent's reply reads like a plan that asks you to decide, but
  it recorded nothing, it gets one reminder to record it, once per run. A reply to a question is
  never reminded.
- **Nothing blocks the agent.** It can still edit, start workers or create worktrees while a
  question is open, so a stuck worker or a parallel concern never leaves the session stuck.

## Typed in a chat

`/align on` and `/align off` typed in a chat turn align on or off; anything else after `/align`
answers with its usage line. A pi terminal session has no align from Sova: no alignment cards, viewer
or commands there.

## Where align isn't available

- **The Overseer** is always in normal mode with no minor modes.
- **A project's coding sessions** start in this computer's default mode, so they have align when
  your default does, and an Overseer can start or switch one with align. Neither Overseer ever
  answers an alignment's questions: they're yours, and while a session waits on your answers an
  Overseer can't turn its align off. A playbook run you answer yourself starts with align on.

Workers never get align: aligning is a conversation with you. A planning worker can still write an
alignment for the agent to import.
