# Score and chart the round

1. `node scripts/score.mjs check <campaign> --round <n>`.
2. Replies no check can judge go to the grader blind: `score.mjs blind`, the grader writes its grades in the blind folder, `score.mjs unblind`.
3. `node scripts/score.mjs total <campaign> --round <n>` writes the scores and the ledger row, with each arm's prediction beside what it did against its base. It names the best arm by pass rate, then cost: a prediction never changes that. Overrule it with `--winner <arm>` only with a reason in `--note`.
4. `node scripts/chart.mjs <campaign> --round <n>` prints the chart (master's Round 0 first, the best so far, this round's arms), the trend and the table Predicted vs observed. Show it in your message, every cycle, and say in plain words what the table shows: a gain that came mostly from cases nobody expected, an expected fix that didn't happen, a break nobody expected, an arm that stated no prediction. Read the counts against the noise; one case is rarely a finding.
5. Carry over: the best arm becomes the next cycle's base if it beats the base by more than the noise; otherwise the base stays. Say which.
6. Add the round to the record: `node scripts/record.mjs add <campaign> --round <n> --outcome carried` when the best arm was carried over (the other arms are recorded as dropped), `--outcome dropped` when none was. Every arm gets a line, the losing ones too. If it refuses a line, reword that arm's `problem`, `why` or `change` in general words in `arms.json` and add again: never quote a case or a reply.

Then apply the stop rule (`phases/stop-rule.md`) and the cycle settings in your plan: go round again by yourself, or stop and ask. Either way the outlook follows:

7. As the report goes out, start fresh consultants, one per rival, each with this round to read, the record (`node scripts/record.mjs show <name>`), this cycle's knobs and its outlook file (`rounds/<n>/outlooks/<seat>.md`); `references/roles/consultant.md`. It only reads: nothing past a stop runs without the user's answer.
8. When the outlooks arrive, save their closing blocks to `rounds/<n>/outlook.json`, run `node scripts/record.mjs outlook <campaign> --round <n>`, and post their plain lines as a second message. The outlook arriving is never the user's answer: at a stop, end your turn again. An answer the user gave before it arrived is held: post the outlook, then ask the user to confirm or change it.
9. Going round by yourself, the outlooks are the go-ahead, knobs unchanged (`phases/fix.md`).
