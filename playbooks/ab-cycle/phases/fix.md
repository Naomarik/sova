# Consultant picks one change, builder commits it

The consultants started at the last report and wrote their outlooks (`phases/score.md`, `phases/baseline.md`); each cycle has its own, so none carries a long context. On the user's go-ahead, give each the knobs as answered and the file to write the proposal to (`rounds/<n>/proposals/<arm>.md`). A consultant that is gone is started fresh with the round to read, the record (`node scripts/record.mjs show <name>`), its saved outlook (`rounds/<n-1>/outlooks/<seat>.md`) and the same go-ahead. Never a sealed case.

Only consultants whose outlook isn't futile propose: their `next` lines are this round's rival changes (`phases/stop-rule.md` when all are futile).

The record comes before a new idea:

- A consultant says, for each recorded fix, whether it is already in place, worth re-testing or not relevant, and never proposes a recorded loser again without a new reason.
- **A new test model that fails** (`phases/baseline.md`): the recorded fixes that aren't in place are this cycle's arms, re-tested as they were written. The ones in place that don't help this model are the next candidates, to shorten or remove: the record says why each was added.

For each proposal, the builder cuts the arm's branch from the current base (master's arm for cycle 1, which is master without the record; after that, the previous cycle's winner), applies it, and commits it with `(experiment, never lands)` at the end of the message. Record the arm in `rounds/<n>/arms.json`: its `change` in one line, its `ref` (the commit), its `base`, and the proposal's closing block copied as written: `problem`, `why`, `expectFix`, `mayBreak` (`references/ledger.md`), plus `knobs`, what this cycle allowed. A proposal without the block goes back to its consultant; an arm that runs without one is reported as having stated no prediction.

Rival proposals that are the same change in other words are one arm: ask the second consultant again.
