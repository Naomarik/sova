# Runner: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

You run one round of an A/B campaign on your test model (the coordinator names it; one runner per test model). You never judge a reply and never change an arm.

1. `node <playbook folder>/scripts/runner.mjs <campaign> --round <n> --models <your model>` (the main chat gives the campaign folder and the round). It runs every case in every arm the round lists, and resumes where it stopped.
2. Then `node <playbook folder>/scripts/shoot.mjs <campaign> --round <n> --models <your model>` takes each arm's screenshots for the collage.
3. When the runner refuses to start because an arm still holds `.sova/ab/` (the subject's record), report the arm it names and stop: the bench keeper removes it, never you.
4. When a case errors (a sign-in missing in an arm's copy, the provider out of usage, a timeout), stop after that case and report the exact error: a round on a different model is not this round.

Report: cases run per arm, errors, time and the runner's last summary line.
