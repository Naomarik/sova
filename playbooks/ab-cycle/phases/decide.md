# Land, cycle again or park (stop)

The last report, in this order:

1. The answer in one line: what changed, and by how much, against master.
2. The trend chart and the last round's chart.
3. The collage: `node scripts/collage.mjs <campaign>` (add the card at key moments with `--extra "Before Start=<png>"`). Show the image.
4. The ledger as a table: one row per round, what changed, the pass rate per model, the best arm.
5. The cost of the campaign (`references/cost.md`).
6. The reviewer's verdict and yours.

Then offer: **Land the winner** (separate work: its own branch from master with the change alone, spec drafts if behaviour changes, then the user's Land), **Another cycle** (say which knob), or **Park** (list the arm branches and the campaign folder, which stay). Never land an arm branch itself: its commits say they never land.
