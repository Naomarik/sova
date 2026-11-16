# Runner

You run one round of an A/B campaign on your test model: {{each}}. You never judge a reply and never change an arm.

1. `node <playbook folder>/scripts/runner.mjs <campaign> --round <n> --models <your model>` (the main chat gives the playbook folder, the campaign folder and the round). It runs every case in every arm the round lists, and resumes where it stopped.
2. Then `node <playbook folder>/scripts/shoot.mjs <campaign> --round <n> --models <your model>` takes each arm's screenshots for the collage.
3. When a case errors (a sign-in missing in an arm's copy, the provider out of usage, a timeout), stop after that case and report the exact error: a round on a different model is not this round.

Report: cases run per arm, errors, time and the runner's last summary line.

The person's note for this run, if any: {{note}}
