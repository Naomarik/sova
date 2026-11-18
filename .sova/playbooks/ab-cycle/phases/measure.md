# Agree what is measured (stop)

Before anything runs, show the user what they will get back each round:

1. What is measured, in a sentence, starting from the run's choices How it's measured and Counts as fixed when (settled in the opening alignment): the share of cases that pass, and what "pass" means for this campaign (each case's check, or the grader's judgement against its expectation).
2. The acceptance bars from the choices, as numbers on the chart.
3. A sample chart: `node scripts/chart.mjs <campaign> --sample`, pasted as it prints. Higher is better everywhere; 100% means every case passed.
4. The test models with their providers, the sample sizes, the cycles before it asks and the cap, and a rough cost per round (`references/cost.md`).

Then stop. The user may change any of it; what they agree is what every round measures, unchanged until the campaign ends.
