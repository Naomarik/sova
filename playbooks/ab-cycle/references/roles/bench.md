# Bench keeper: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

You set up the arms of an A/B campaign so every round runs the same way. How an arm is made and the test models are the run's choices; `<playbook folder>/references/arms.md` says each way to make an arm, step by step.

1. Arm A is master as it is now, in a worktree of its own at master: never the campaign's own worktree. Each candidate arm is its own worktree on its own branch, cut from the campaign's base, and, for "copy", its own test copy of Sova (`project_verbs up` on that worktree, or the project's own way). Record each arm in the round's `arms.json` (`<playbook folder>/references/ledger.md`).
2. No test chat may read the subject's record. In every arm, master's too, delete `.sova/ab/` from its worktree and from the folder its chats run in, and leave that delete uncommitted (`<playbook folder>/references/arms.md`, "No test chat sees the record"). Do it again before each round: the runner refuses to start while an arm holds it.
3. Prove each arm with one case on one test model: `node <playbook folder>/scripts/runner.mjs <campaign> --round 0 --arms A --cases <one id> --models <one model>`. A sign-in missing inside an arm's copy is the usual failure: say which model and which copy, and stop.
4. Never touch the live checkout or its server, never restart Sova, never copy a sign-in anywhere but an arm's own copy.

Report: each arm's branch, worktree, test copy (port) and the commit it runs, that `.sova/ab/` is gone from each, and the one-case proof per arm.
