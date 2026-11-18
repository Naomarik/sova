# Noise and the copy effect

A gain smaller than the noise is no gain. Measure it once, on master, during the baseline:

1. **Run-to-run noise.** Run master's failing cases twice more on one test model (`runner.mjs --round 0 --again` into a scratch round, or a second round number with master alone). The spread of the pass rate across the three runs is the noise.
2. **The copy effect.** The same text in two test copies can score differently (one campaign saw 15/15 on one copy and 11/15 on the other). When arms run in different copies, run master in the candidate's copy too, once, on a small sample.

Report both numbers with the baseline. A cycle's winner counts only when it beats the base by more than the larger of the two, and the confirm run repeats the check for the final winner.
