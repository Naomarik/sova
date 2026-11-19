# Baseline on master, once (stop)

If `ledger.jsonl` already has a Round 0 for this commit of master and these cases, reuse it and say so: master is measured once per campaign.

Otherwise:

1. One runner per test model: `node scripts/runner.mjs <campaign> --round 0 --models <its model>`, then `node scripts/shoot.mjs <campaign> --round 0 --models <its model>`.
2. `node scripts/score.mjs check <campaign> --round 0`. If cases without a check remain, `score.mjs blind`, the grader grades the blind folder, then `score.mjs unblind`.
3. `node scripts/score.mjs total <campaign> --round 0`, then `node scripts/chart.mjs <campaign> --round 0`.
4. Run the noise check on master now (`references/noise.md`): later rounds are judged against it.
5. Set the baseline beside the record. A test model that fails here and that none of the record's attempts ran is a new test model: its first cycle re-tests the recorded fixes that aren't in master, before any new idea (`phases/fix.md`).

Report: the chart, the failure kinds by count, the noise you measured, and the first change you'd try (for a new test model: which recorded fixes come first). Then stop.
