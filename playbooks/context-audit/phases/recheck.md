# Check again (stop)

1. Run, with the inventory the run started from and every layout change the fix step recorded:

   ```
   node scripts/context-audit.mjs check --root <worktree> --before <inventory.json> \
     [--moved <old page>=<new page>,<new page>]… --clean
   ```

   It compares at the run's starting HEAD, prints the numbers before and after and, for each layout change, any paragraph that landed on no new page or on several. `--clean` deletes the run's working folder once it has read it: nothing is kept between runs.
2. Exit 1 on a moved page: the layout lost or doubled text. Hand the lines to the fixer, commit the repair, and run `check` again with the same `--before` and `--moved` (the folder stays until a run without failures, or until step 4).
3. The report writer posts the before and after as a short table (the numbers of `references/metrics.md`, one row each), what each commit did, and the branch's name. Then end your turn: the user reviews the branch and lands it the usual way. Edited context files and skills show Changed since you turned it on in Sova until the user accepts the change.
4. When the user is done asking, delete the working files even if the last check failed, then stop the team:

   ```
   node scripts/context-audit.mjs clean --before <inventory.json>
   ```
