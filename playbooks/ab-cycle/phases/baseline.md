# Baseline on master, once (stop)

If `ledger.jsonl` already has a Round 0 for this commit of master and these cases, reuse it and say so: master is measured once per campaign.

Otherwise:

1. One runner per test model: `node scripts/runner.mjs <campaign> --round 0 --models <its model>`, then `node scripts/shoot.mjs <campaign> --round 0 --models <its model>`.
2. `node scripts/score.mjs check <campaign> --round 0`. If cases without a check remain, `score.mjs blind`, the grader grades the blind folder, then `score.mjs unblind`.
3. `node scripts/score.mjs total <campaign> --round 0`, then `node scripts/chart.mjs <campaign> --round 0`.
4. Run the noise check on master now (`references/noise.md`): later rounds are judged against it.

Report: the chart, the failure kinds by count, the noise you measured, and the first change you'd try. Then stop.
