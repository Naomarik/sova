# Land, cycle again or park (stop)

Close the campaign in the record first: `node scripts/record.mjs close <campaign> --verdict land|cycle|park` with the reviewer's verdict (add `--confirm <round>` when a confirm run was made), then `node scripts/record.mjs check <name> --campaign <campaign>`.

The last report, in this order:

1. The answer in one line: what changed, and by how much, against master.
2. The trend chart and the last round's chart, with its Predicted vs observed table.
3. The collage: `node scripts/collage.mjs <campaign>` (add the card at key moments with `--extra "Before Start=<png>"`). Show the image.
4. The ledger as a table: one row per round, what changed, the pass rate per model, the best arm.
5. The cost of the campaign (`references/cost.md`).
6. The reviewer's verdict and yours.
7. What this campaign added to the record: `node scripts/record.mjs show <name> --campaign <campaign name>`, as it prints.

Then keep the record and offer what comes next. Commit the record alone, by explicit path, on the campaign's own branch (`git add .sova/ab/<name>.jsonl`, never `git add -A`); that branch carries nothing else.

- **Land the winner** (separate work: its own branch cut from the campaign's branch, so the record rides with it, with the change alone, spec drafts if behaviour changes, then the user's Land).
- **Another cycle** (say which knob).
- **Park** (list the arm branches and the campaign folder, which stay). The record is still worth one small Land of the campaign's own branch: say so, since what was learned is lost with the worktree otherwise.

Never land an arm branch itself: its commits say they never land.
