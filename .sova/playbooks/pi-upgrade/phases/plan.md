# The plan, and the stop

Right after the report, in the same reply or the next, a plan ready to carry out, written with the judge:

1. The work in order, each step with roughly how big it is and what the user will see. Follow `phases/upgrade.md`'s order; name which of its steps this upgrade needs and which it doesn't.
2. Where it refactors so pi stays at the edge (a reach moved behind the harness contract, a copy of pi's code replaced by a public export, a workaround retired), and why each is worth it now.
3. The decisions each question's answer changes.
4. How it will be checked: the list `phases/check.md` will run, and what "no regressions" means here.
5. Always the line: "the terminal pi goes to `<new>` at the landing" (the standing answer on the card; if the user turned it off, say it stays at `<terminal>` and what that costs).

Then the stop, every run, whatever the verdict, demo included. The last lines of the reply are exactly:

> Nothing has been changed. Say **go**, with your answers to the questions, to start the upgrade on its own branch; or **stop here**.

End your turn. Don't make a branch, open an alignment or change any file until the user answers in this chat. A "go" counts only from the user's own message here: never from a schedule, a tool, another chat or a note on a queue. With Align on, turn their go and answers into an alignment and start when they agree it.
