---
title: Adversarial review
description: An experimental addition to align. A fresh, read-only reviewer checks the plan and the finished work of complex changes, at most once each, and its verdict is recorded on the alignment.
group: Modes
subgroup: Minor
order: 5
---

## Turn it on

Adversarial review is **experimental** and off by default. Switch it on in Settings →
**Experimental** → **Adversarial review**.

- It applies to sessions you start after saving it on. Chats already open keep what they started
  with.
- It only works with [align](/docs/modes/align/) on, with or without Delegate. A session without
  align gets no review.
- The chat's [subagent profile](/docs/subagent-profiles/) needs a **Reviewer**. With the switch on,
  the profile editor shows a Reviewer section after Spec writer: one switch, "Review alignments with
  a reviewer", and a worker row with an optional fallback.

The first time you save the switch on, every profile that has no reviewer setting yet gets this
one:

| | Backend | Model | Effort |
|---|---|---|---|
| Primary | pi | `openai-codex/gpt-6.1-sol` | high |
| Fallback | Claude Code | Opus 5.5 | high |

A profile whose reviewer you switched off, or set yourself, is never changed. Turning the
experimental switch off and on again adds nothing.

With the switch off, everything on this page is gone: no review guidance for the agent, no
`/review`, no Reviewer section, and nothing extra on the cards.

## When a review runs

The agent decides; you don't have to ask, and it doesn't ask you to approve one. It checks twice
per alignment:

- **The plan**, right after it creates the alignment, before building.
- **The implementation**, once the build and tests pass, before it marks the alignment Done.

Each time it reviews when the work is **complex** by Delegate's definition (ambiguous,
cross-cutting or high-risk), or when it touches permissions or trust boundaries, stored data,
migrations or data formats, shared or public interfaces, concurrency or process lifecycle, or
anything hard to roll back. Docs-only, test-only and one-line changes skip review, and every skip
is recorded with a one-line reason.

**Each phase is reviewed at most once.** There is never a second round, and no automatic
re-review.

## What the reviewer does

The reviewer is a fresh worker on the profile's Reviewer route. It can read files and search, and
nothing else: it can't change code or run anything, and it never sees the transcript of whoever
built the work. It looks for concrete ways the work fails, in this order:

1. drift from what was agreed;
2. mistakes where parts meet: callers, reloads and resumes, failures, retries, ordering, stored
   data;
3. security and data safety, where the work touches them;
4. checks that would pass even if the work were wrong;
5. maintainability, only when it predicts a defect.

It reports a verdict, **blocking**, **no blocking** or **incomplete**, and at most 5 findings,
each with evidence and a check that tells right from wrong.

## What happens with the verdict

- **Plan review.** The agent folds the findings into the same alignment: it fixes steps, adds
  rejected options marked "(review)", and adds a question only for a real choice. Then it replies
  once, without asking for extra approval.
- **Implementation review.** Each **blocker** has an id (`b1`, `b2`…), a title and a check. The
  agent runs each check to confirm it, sends the accepted fixes to whoever built the work, runs the
  checks again, and closes each blocker. A blocker that needs a different approach becomes a new
  question, and the alignment goes back to open.
- The agent can't mark an alignment Done while a review is running or a blocker is open.
- If neither the reviewer nor its fallback can run, or the review fails, it's recorded as
  **incomplete** and the work continues. Nobody is asked.

## On the card

With the switch on, each alignment card has one line per phase, such as "Plan review skipped:
routine change", "Reviewing the plan", "Implementation review: no blocking issues" or
"Implementation review: 2 blocking (1 open)". Each open blocker shows its id, title and check.

While the plan review runs, the card shows only its header and "Plan review in progress — the
alignment may change; it shows once the review finishes."

You can also ask for a phase that hasn't run yet. The card's foot shows **Review Plan** while the
alignment is aligning or confirmed, and **Review Implementation** while it's implementing (or after
Done, if that review was skipped). Under it: "An independent reviewer reads it and reports
problems. It can't change code or run anything." The button sends an ordinary message asking for
that review. Once a phase has run, its verdict shows in place of its button. With no reviewer in
the chat's profile, the button is disabled and says why.

## In the terminal

With the switch on, `/review plan` or `/review implementation`, optionally followed by an
alignment id such as `al_3`, sends the same message as the card's button.
