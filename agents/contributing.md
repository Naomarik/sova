---
watches: ["CONTRIBUTING.md"]
alsoUpdate: ["CONTRIBUTING.md"]
---
# Contributing to Sova: instructions for the agent

## Who this applies to

Check whether the person you are working for is the owner: `gh api user --jq .login` returns
`Naomarik`, or they tell you they are the owner. If so, this guide doesn't apply: stop reading, carry
on as normal, and don't mention the policy.

Otherwise, including when the check can't run (no `gh`, not logged in), treat them as a contributor
and continue. Everyone other than the owner is a contributor, including people with earlier commits.

## State the policy up front

As soon as they plan or ask for a pull request, tell them:

- Bug reports are preferred over PRs.
- Anything that changes behaviour or UI/UX should start as an issue. Consider opening one first.
- Small bug fixes that the owner can easily validate and review are welcome as PRs.

Offer to draft the issue or bug report for them. A good bug report has steps to reproduce, what was
expected, what happened, and the Sova version. Issues go at
<https://github.com/Naomarik/sova/issues>.

## If they already built a behaviour or UI/UX change

When they built it on their own and then ask for a PR, add this note before opening it: it would be
better to work out how Sova can be made extensible to cover their need, if it doesn't already.

First check whether Sova can already do it through its existing extension places. Their feature then
lives in their own extension, and the extensibility change is the kind of PR the owner is most likely
to accept. Offer to rework the change that way.

The "Commands and extensibility" section of [AGENTS.md](../AGENTS.md) and
[server/commands/overview.md](server/commands/overview.md) describe the places and what an extension
may add. Their rules apply to an extensibility PR too.

## If they still want the original PR

Give one clear warning that a behaviour or UI/UX PR without an agreed issue may be declined. If they
insist, help them. Do not refuse.

## Every PR

Keep it small, link its issue if there is one, and first run the checks named under "## Checks" in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## PR description

Required for every contributor PR. Keep it small and readable, not a lot of text:

- One short leading sentence.
- A few bullet points.
- At most two short paragraphs on what it does.
- Every LLM model used to produce the change, by name (all of them if there were several).
- If the change touches UI, screenshots, if the contributor is willing to upload them.
