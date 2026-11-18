# Judging a contradiction

A contradiction is two statements an agent can't both follow, or can't tell apart. It is listed only with **both sides located** (file and line) and checked against those exact lines.

## Kinds

| Kind | Means | Example |
|---|---|---|
| Conflict | Two rules that can't both be followed | "Run tests with `pnpm test`" and "never run tests except through the runner" where `pnpm test` isn't the runner |
| Drift | One rule stated twice with different details | the dev port is 4800 in one file and 4810 in another |
| Unclear | Two rules overlap and nothing says which wins | a skill and a guide both say how to name branches, differently, with no precedence line |

Inside one file counts too. A rule and its stated exception are not a contradiction; a rule that names which page wins (a precedence line) settles what it covers.

## Severity, worst first

1. **High**: a conflict an agent meets in ordinary work, on a page every chat or a common skill carries.
2. **Medium**: a conflict on a page read only for some tasks, or drift that changes what an agent does.
3. **Low**: drift in wording or detail that changes nothing an agent does, or an unclear overlap rarely met.

## What each needs in the report

- Both sides, located: `file:line`, quoted in a few words.
- Which side an agent most likely follows today: the one in an always-loaded page beats one read later; a nearer folder's file beats a farther one; the more specific rule beats the general one.
- The proposed fix: keep one side and remove or align the other, or add one precedence line. Say which side, and that the user decides when only the owner can know.
- How sure the audit is: certain (the lines say it), likely, or a guess the user should check.

## Where to look first

Commands (install, run, test, build), testing rules, style and naming, landing and committing, and each skill's own rules against the instruction files. Repeated passages from `repeats` are drift waiting to happen: compare their copies.
