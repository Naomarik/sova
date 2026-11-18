# Stop rule

Stop going round, and report, when any of these holds:

- Every test model meets the acceptance bars, two rounds in a row.
- Two rounds in a row with no win: no arm beat the base by more than the noise.
- The cap on cycles is reached.
- A provider reaches the "warn me at" share, or a test model can't run.

Otherwise go round again, asking first when the plan's "cycles without asking" is used up.
