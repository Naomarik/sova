# Agree what is measured (stop)

Before anything runs, show the user what they will get back each round:

1. The record this campaign continues and what it holds, in a line (`record.mjs show <name>`), or that it starts a new one.
2. What is measured, in a sentence, starting from the run's choices How it's measured and Counts as fixed when (settled in the opening alignment): the share of cases that pass, and what "pass" means for this campaign (each case's check, or the grader's judgement against its expectation).
3. The acceptance bars from the choices, as numbers on the chart.
4. A sample chart: `node scripts/chart.mjs <campaign> --sample`, pasted as it prints. Higher is better everywhere; 100% means every case passed. Its last table, Predicted vs observed, is made up too: each round shows what a fix was expected to fix and to risk beside what it did.
5. The test models with their providers, the sample sizes, the cycles before it asks and the cap, and a rough cost per round (`references/cost.md`).

Then stop. The user may change any of it; what they agree is what every round measures, unchanged until the campaign ends.
