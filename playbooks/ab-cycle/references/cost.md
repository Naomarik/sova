# Cost

Every result records what the test copy says it cost (`cost`, from Sova's usage for that chat) and how long it took (`ms`); `score.mjs total` adds them up per arm and model, and the chart's table shows them.

Before the first round, estimate a round: cases × test models × arms × the average cost of one case (run one case per model during the bench proof and read its result's `cost`). Show it at the first stop.

Prices: `node <sova folder>/scripts/sova.mjs run usage.prices` lists what Sova knows; a subscription (ZAI, a Claude plan) costs usage, not money: say how much of its window a round takes (`sova.mjs run settings.provider-limits.get`, or the usage line), and stop at the "warn me at" share.

The last report has one table: per round, the cases run, the cost or usage, and the time; and the campaign's total.
