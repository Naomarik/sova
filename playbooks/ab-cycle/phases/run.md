# Run every test model on every arm

Before the round, in every arm: remove `.sova/ab/` from its worktree and from the folder its chats run in (`references/arms.md`). The runner refuses to start, naming the arm, while one still holds it.

One runner per test model, at the same time. Each runs `node scripts/runner.mjs <campaign> --round <n> --models <its model>` and then `scripts/shoot.mjs` the same way.

A runner that stops on an error (a missing sign-in in an arm's copy, a provider out of usage) stops the round: tell the user which model and why at once, and wait. Never finish a round on another model.

Watch usage: at the "warn me at" share on any provider the run uses, stop and say so.
