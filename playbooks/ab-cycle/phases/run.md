# Run every test model on every arm

One runner per test model, at the same time. Each runs `node scripts/runner.mjs <campaign> --round <n> --models <its model>` and then `scripts/shoot.mjs` the same way.

A runner that stops on an error (a missing sign-in in an arm's copy, a provider out of usage) stops the round: tell the user which model and why at once, and wait. Never finish a round on another model.

Watch usage: at the "warn me at" share on any provider the run uses, stop and say so.
