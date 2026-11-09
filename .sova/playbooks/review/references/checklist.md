# Review checklist

Each item: what counts as a finding, and what doesn't. Kinds in brackets.

## Dead code [dead-code]
Counts: a function, export, branch, parameter or file the change adds or leaves unused; commented-out code; a debug `console.log`/print, a leftover `only`/`skip` in a test; a feature flag that can never be on.
Doesn't: code used by a test or another file you didn't read (look for its uses in the diff and the files it touches before calling it unused); an exported type kept for a documented API.

## Duplication [duplication]
Counts: the change copies a block (roughly ten lines or more, or a non-trivial rule) that already exists in the repo, instead of reusing or extracting it; two new functions doing the same thing.
Doesn't: small, similar-looking code with different purposes; test setup repeated for readability.

## Hacks and workarounds left in [hack]
Counts: a `TODO`/`FIXME`/`HACK` added without a plan; a fixed sleep or retry loop hiding a race; a type cast or `any` to silence the compiler; a disabled check, lint rule or test; a special case for one input that should be a rule; catching and ignoring an error with no reason given.
Doesn't: a workaround with a comment naming the upstream cause and when it can go.

## Missing tests for new behaviour [missing-test]
Counts: the change adds or changes behaviour (a new branch of logic, a new route, a new rule, a bug fix) and no test in the diff exercises it. Blocking when nothing at all tests the new behaviour; a note when only an edge case is missing.
Doesn't: refactors with no behaviour change, copy and styling changes, docs.

## Testing principles [other]
Counts: a test the change adds or changes that breaks the project's testing principles (the testing guide's "Writing tests" section, `agents/testing/overview.md`); read them and judge the diff against them. A clear break is blocking; a judgement call is a note. That is your judgement alone; nothing checks it mechanically.
Doesn't: tests the change neither adds nor touches.

## Unclear names [naming]
Counts: a new name that says the wrong thing or nothing (`data2`, `handle`, `tmp`, a boolean named for the opposite of what it holds); one concept under two names in the change.
Doesn't: taste ("I'd call it…") when the name is accurate.

## Ordinary review [other]
Counts: an obvious bug in the diff (wrong condition, off-by-one, unhandled error path that loses data); a secret, token, real hostname or home path committed; a new dependency nobody asked for; an unrelated change mixed in.
Doesn't: architecture you'd have done differently, formatting the formatter owns.
