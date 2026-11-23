# List what loads, and when

1. Create the run's worktree (the run block says how) and work there. Note its HEAD.
2. Pick the run's working folder: `<shared folder>/context-audit/<branch>/`, where the shared folder is `$SOVA_SHARED_DIR` when set, else the folder two levels above the run block's Run folder (`<shared folder>/playbook-runs/<run id>`). Save Sova's switches there, so items the user turned off are listed off: run `project.context-files.get` and `project.skills.get` through Sova's commands (the run block names the command line) and write both answers into one file in that folder, `{"files": [...], "skills": [...], "asking": <either answer's asking>}`. If Sova can't answer, go on without it and say the switches weren't read.
3. Run, with the card's choices:

   ```
   node scripts/context-audit.mjs inventory --root <worktree> --run <branch> \
     --out <shared folder>/context-audit/<branch> [--scope <each folder or skill>] [--personal] [--switches <file>]
   ```

   It writes the detail to `inventory.json` in that folder and names it on its last line. Keep that path: the read and recheck steps use it. Without `--out` it uses `$SOVA_SHARED_DIR/context-audit/<branch>/`, and with neither it refuses (exit 2). It deletes nothing.
4. Size the investigation from the digest's `subjects` and `suggested readers`: one investigator per subject, at most the card's **Investigators at most**. Merge the smallest subjects when there are more subjects than investigators; one investigator for a small project.
5. Say in two lines what you found (items, ≈ tokens, always-loaded, the heaviest skill) and who reads what, then go on: this step doesn't stop.

Exit 2 stops the run: say what the script couldn't read.
