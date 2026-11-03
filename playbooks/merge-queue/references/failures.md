# Failures and pauses: explain them

Sova decides whose failure it is by rerunning: a check that fails with the branch and passes on the target alone, in the same copy, is the branch's; one that also fails on the target is the target's (noted, not blocking); one that passes on a rerun is flaky (noted); setup that fails on the target too is the machine's (retried once, then the queue pauses, nobody blamed). You don't re-decide that. You explain it so the branch's chat (or the user, for a pause) can act at once.

## A failed entry
1. `merge.logs {run}` for the failed step; read its whole log, not its last line.
2. Find the first real error: the failing test, file and assertion, or the compile error with its file and line.
3. Read the branch's diff for the cause: which change makes that line fail.
4. `merge.note {entry, note}` (at most 300 characters): two or three sentences: what failed (test, file, line), what in the branch causes it, the likely fix. No guesses dressed as facts: say "likely" when it is.

## A pause
Sova paused the queue itself (setup broken on the target, the target moved outside the queue, a push refused, the main checkout has uncommitted edits). Read `merge.status` and the step log it names. When the pause holds an entry (`merge.status` names it), put what you found on it with `merge.note {entry, note}`: the cause and what the user can do. Otherwise there is nothing to write: the pause banner carries Sova's own reason. You never resume the queue.

## Never
Blame a branch for what also fails on the target. Retry or rerun anything yourself. Edit the branch.
