# Score and chart the round

1. `node scripts/score.mjs check <campaign> --round <n>`.
2. Replies no check can judge go to the grader blind: `score.mjs blind`, the grader writes its grades in the blind folder, `score.mjs unblind`.
3. `node scripts/score.mjs total <campaign> --round <n>` writes the scores and the ledger row; it names the best arm by pass rate, then cost. Overrule it with `--winner <arm>` only with a reason in `--note`.
4. `node scripts/chart.mjs <campaign> --round <n>` prints the chart (master's Round 0 first, the best so far, this round's arms) and the trend. Show it in your message, every cycle.
5. Carry over: the best arm becomes the next cycle's base if it beats the base by more than the noise; otherwise the base stays. Say which.

Then apply the stop rule (`phases/stop-rule.md`) and the cycle settings in your plan: go round again by yourself, or stop and ask.
