# Consultant picks one change, builder commits it

Each cycle starts fresh consultants (one per rival), so none carries a long context. Give each: the round to read, the knobs allowed this cycle, and the file to write the proposal to (`rounds/<n>/proposals/<arm>.md`). Never a sealed case.

For each proposal, the builder cuts the arm's branch from the current base (master for cycle 1; after that, the previous cycle's winner), applies it, and commits it with `(experiment, never lands)` at the end of the message. Record the arm in `rounds/<n>/arms.json`: its `change` in one line, its `ref` (the commit), its `base`.

Rival proposals that are the same change in other words are one arm: ask the second consultant again.
