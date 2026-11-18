# Build the bench and freeze the cases

Two helpers, as one team: the case finder writes `cases.jsonl` (the failing, passing and sealed cases, each with a check where a script can judge it) and the bench keeper makes the arms (`references/arms.md`).

Round 0's `rounds/0/arms.json` has one arm, `A`, master as it is now, with `"baseline": true` and the commit it runs. Each later round's `arms.json` lists only that round's candidates, each cut from the current base.

Done when every arm passed the bench keeper's one-case proof, and `cases.jsonl` has the agreed counts. The cases are frozen from here: a case that turns out wrong is reported at the next stop, never quietly edited.
