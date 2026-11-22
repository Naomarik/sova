# Land, cycle again, park or keep the baseline (stop)

The last stop comes in three messages. An answer the user gives before the third is held: ask them to confirm or change it once it is out.

1. **The report, at once:**
   1. The answer in one line: what changed, and by how much, against master.
   2. The trend chart and the last round's chart, with its Predicted vs observed table.
   3. The collage: `node scripts/collage.mjs <campaign>` (add the card at key moments with `--extra "Before Start=<png>"`). Show the image.
   4. The ledger as a table: one row per round, what changed, the pass rate per model, the best arm, and its outlook's expected gain.
   5. The cost of the campaign (`references/cost.md`).
2. **The last round's outlook**, when it arrives (`phases/score.md`, step 8).
3. **The landing reviewer's verdict** (`phases/review.md`), and yours. Then close the campaign in the record: `node scripts/record.mjs close <campaign> --verdict land|cycle|park|keep` with the reviewer's verdict (add `--confirm <round>` when a confirm run was made), `node scripts/record.mjs check <name> --campaign <campaign>`, and show what this campaign added: `node scripts/record.mjs show <name> --campaign <campaign name>`, as it prints, outlooks included.

Then keep the record and offer what comes next. Commit the record alone, by explicit path, on the campaign's own branch (`git add .sova/ab/<name>.jsonl`, never `git add -A`); that branch carries nothing else.

- **Land the winner** (separate work: its own branch cut from the campaign's branch, so the record rides with it, with the change alone, spec drafts if behaviour changes, then the user's Land).
- **Another cycle** (say which knob).
- **Park** (list the arm branches and the campaign folder, which stay).
- **Baseline kept** (master stays as it is; list the arm branches and the campaign folder, which stay).

For Park and Baseline kept, the record is still worth one small Land of the campaign's own branch: say so, since what was learned is lost with the worktree otherwise.

Never land an arm branch itself: its commits say they never land.
