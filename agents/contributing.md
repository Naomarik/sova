---
watches: ["CONTRIBUTING.md"]
alsoUpdate: ["agents/contributing.md"]
---
# Contributing to Sova: instructions for the agent

## Who this applies to

Check whether the person you are working for is the owner: `gh api user --jq .login` returns
`Naomarik`, or they tell you they are the owner. If so, this guide doesn't apply: stop reading, carry
on as normal, and don't mention the policy.

Otherwise, including when the check can't run (no `gh`, not logged in), treat them as a contributor
and continue. Everyone other than the owner is a contributor, including people with earlier commits.

## State the policy up front

As soon as they ask for a pull request, tell them:

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

Keep it small and link its issue if there is one. [CONTRIBUTING.md](../CONTRIBUTING.md#checks) explains
how the everyday checks work; what a PR requires is the full run under Tests.

## Tests

Before opening the PR, ask whether the tests were actually run on the final version of the change. If
they weren't, or the contributor isn't sure, run them first.

The full run is required however small the fix:

- `pnpm run typecheck`
- `pnpm test:all`: unit and integration, every slow group, Tours included
- `pnpm run build`
- When the change touches pi-config extensions: `node scripts/merge-checks/ext-suites.mjs`
- When the change touches statecharts: `node scripts/merge-checks/statecharts.mjs` (needs a JVM and the
  Clojure CLI)

Those two scripts take no arguments when a local `master` exists; otherwise pass `--base <rev>`, for
example `--base origin/master`. They read committed changes only, so commit first. If one prints
`skipped:`, it ran nothing.

A partial run doesn't count: `pnpm test`, `pnpm test:int --changed` and `pnpm test:int -- --landing` all
skip tests.

Spec replay is not part of the run. It starts real agent runs and stays with the landing. When the
change touches the spec tools, the report says it wasn't run.

When the run isn't clean, fix the failures the change caused. List anything left in the report with the
reason, whether it fails or can't run (for example, no Chrome for Tours). The PR may then open after one
clear warning to the contributor that it may be declined. Do not refuse.

Report only what you saw run, never what you assume passed.

## PR description

Required for every contributor PR. Keep it small and readable, not a lot of text:

- One short leading sentence.
- A few bullet points.
- At most two short paragraphs on what it does.
- Every LLM model used to produce the change, by name (all of them if there were several).
- If the change touches UI, screenshots, if the contributor is willing to upload them.
- A compact test report: a short list giving each thing that ran with its passed and failed counts, plus
  anything skipped or failing and why. It doesn't count against the limits above.
