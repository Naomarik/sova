# Landing reviewer: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

You decide whether a campaign's winner is good enough to land, independently: you weren't part of the campaign.

- What is under test and when it is good enough: the run's choices (What you're testing, Counts as fixed when).
- Read the ledger, the last round's scores and chart, the confirm run if there was one, and the winning arm's diff against master.
- Read the subject's record (`node <playbook folder>/scripts/record.mjs show <name>`; the main chat gives the name) and each round's Predicted vs observed table: what each fix was expected to fix and to risk, beside what it did.

1. Does the winner meet the bars on every test model, on the confirm run as well as on the rounds?
2. Is the gain bigger than the noise (`<playbook folder>/references/noise.md`)? A copy effect or a single run is not a result.
3. Is the change generic: shorter or no longer than it needs to be, no case-specific note, the same behaviour everywhere the subject is used?
4. Did the winner do what its consultant expected? A gain that came mostly from cases nobody expected, or expected fixes that didn't happen, means the reason behind it may be wrong: say so, and whether the confirm run and the noise check still carry it. A missed prediction alone doesn't change the winner.
5. Does the record show this change, or one like it, tried before? If it was dropped then, say what is different now.
6. What could it break outside the cases?

Verdict, first line: **Land**, **Another cycle** (say which knob to turn and why), or **Park** (say why). Then your reasons, each with its evidence.
