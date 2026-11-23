# List what loads, and when

1. Create the run's worktree (the run block says how) and work there. Note its HEAD.
2. Save Sova's switches, so items the user turned off are listed off: run `project.context-files.get` and `project.skills.get` through Sova's commands (the run block names the command line) and write both answers into one file in the run's state folder, `{"files": [...], "skills": [...], "asking": <either answer's asking>}`. If Sova can't answer, go on without it and say the switches weren't read.
3. Run, with the card's choices:

   ```
   node scripts/context-audit.mjs inventory --root <worktree> --run <branch> \
     [--scope <each folder or skill>] [--personal] [--switches <file>]
   ```

   It writes the detail to `<state root>/playbooks/context-audit/<branch>/inventory.json` and names it on its last line. Keep that path: the read and recheck steps use it. It first deletes any other run's folder there, left by a run stopped before its cleanup.
4. Size the investigation from the digest's `subjects` and `suggested readers`: one investigator per subject, at most the card's **Investigators at most**. Merge the smallest subjects when there are more subjects than investigators; one investigator for a small project.
5. Say in two lines what you found (items, ≈ tokens, always-loaded, the heaviest skill) and who reads what, then go on: this step doesn't stop.

Exit 2 stops the run: say what the script couldn't read.
