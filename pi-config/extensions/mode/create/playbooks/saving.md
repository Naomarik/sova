# saving: checking a playbook, and saving it where it belongs

Before you show it:

- Every file `playbook.json` names exists: each member's notes, each step's phase page, a rule page.
- Every team has a one-line goal and every required member a one-line brief; the detail is in notes, plain words.
- `PLAYBOOK.md`'s body is short, with the detail in `phases/` and `references/`.
- The flow stops wherever the person decides something, and before anything that changes their project.

Then save it as the contents page's two entries say: the person's own after their OK on every file; a project's on a branch they Land. Sova's own shipped playbooks are never changed from here.

After it's saved, check it: the Playbooks list (or `node "$SOVA/scripts/sova.mjs" run playbook.list`) shows a `playbook.json` with a fault as its exact error, the file and the key, instead of the card. Fix the file and look again.

After a run, the main chat may propose changes to its own playbook from what the run taught (a better sample size, a step that should stop): as changes to the files, saved the same way, never by itself.
