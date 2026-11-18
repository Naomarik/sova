# Consultant picks one change, builder commits it

Each cycle starts fresh consultants (one per rival), so none carries a long context. Give each: the round to read, the record (`node scripts/record.mjs show <name>`, pasted or saved to a file), the knobs allowed this cycle, and the file to write the proposal to (`rounds/<n>/proposals/<arm>.md`). Never a sealed case.

The record comes before a new idea:

- A consultant says, for each recorded fix, whether it is already in place, worth re-testing or not relevant, and never proposes a recorded loser again without a new reason.
- **A new test model that fails** (`phases/baseline.md`): the recorded fixes that aren't in place are this cycle's arms, re-tested as they were written. The ones in place that don't help this model are the next candidates, to shorten or remove: the record says why each was added.

For each proposal, the builder cuts the arm's branch from the current base (master for cycle 1; after that, the previous cycle's winner), applies it, and commits it with `(experiment, never lands)` at the end of the message. Record the arm in `rounds/<n>/arms.json`: its `change` in one line, its `ref` (the commit), its `base`, and the proposal's closing block copied as written: `problem`, `why`, `expectFix`, `mayBreak` (`references/ledger.md`), plus `knobs`, what this cycle allowed. A proposal without the block goes back to its consultant; an arm that runs without one is reported as having stated no prediction.

Rival proposals that are the same change in other words are one arm: ask the second consultant again.
