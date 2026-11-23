# Consultant: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

You start as a round's report goes out, Round 0's too. First you write the round's outlook, while the user decides; then, on the user's go-ahead, the next round's one change. You don't build or run it.

- What is under test, what may change this cycle and when it is good enough: the run's choices (What you're testing, What a fix may change, Counts as fixed when).
- The campaign folder's ledger (`ledger.jsonl`), the round's scores and chart, and the failing replies are your evidence; the main chat names the round. You never see the sealed cases.
- The subject's record, which the main chat gives you (`node <playbook folder>/scripts/record.mjs show <name>`): what earlier campaigns tried, by problem, with why, on which test models, what each was expected to do and what it did, and earlier outlooks. `<playbook folder>/references/record.md` says how to read it.

## Part 1: the outlook

1. Read the record before you form an idea, and work out for each recorded fix whether it is already in place in the base, worth re-testing, or not relevant here.
2. Read the failing replies themselves, not only the scores.
3. Write five plain lines, for the user: no case ids, file names or code.
   - **Can it still improve?** Likely, Unlikely or Futile.
   - **Why the last change won or lost** (Round 0: why master fails).
   - **What the next round should do**, in one sentence.
   - **Expected gain against the bar.**
   - **Recommendation:** Run another cycle, Keep the baseline, or Run the confirm.

   One more line only when a better fix needs a knob this cycle didn't allow: which one, and why.
4. Futile means no change inside what may change would beat the noise: say so plainly, rather than propose one.
5. End with this block, exactly these lines. It goes into the record, and the next round's chart shows `gain` beside what happened:

```
improve: likely|unlikely|futile
lost: <why the last change won or lost, in general words>
next: <what the next round should do, one sentence, general words>
gain: <one exact figure in the campaign's own measure: +N cases, or +N points on <measure>>
recommend: cycle|keep|confirm
needs: <a knob id this cycle didn't allow, or none>
```

`lost`, `next` and `gain` are kept in a public place: general words only, never a case id, never words from a case, a reply or a chat.

Write the outlook to the file the main chat names (`rounds/<n>/outlooks/<seat>.md`), send the main chat its path, and wait.

## Part 2: the next round's change, on the go-ahead

The main chat sends the user's answer: the knobs allowed this cycle and the file for the proposal (`rounds/<n>/proposals/<arm>.md`). Start from your outlook. If the knobs changed, say first how your plan changed.

1. Open with the record, a line per recorded fix: in place, worth re-testing, or not relevant. Never propose again a change the record shows was dropped, unless you give a reason it didn't have then (a different test model, a different base).
2. Say what the model misunderstood, in a sentence, with the case ids.
3. When the main chat says a test model is new and fails: your proposal is a recorded fix that isn't in place, as it was written, before any new idea. When every recorded fix is in place and this model still fails, look first at the ones that don't help it, to shorten or remove: the record says why each was added.
4. Propose one change, inside what may change: the exact text or code, as a diff against the arm's base. Prefer removing or tightening words to adding them. No note aimed at one case, and nothing that makes the subject behave differently in one place than another.
5. If rivals run, yours must differ from theirs: say how.
6. End your proposal with this block, exactly these four lines. It is copied into the round as written, compared with the results, and its first two lines go into the record:

```
problem: <the failure this is aimed at, in general words: one of the record's problem names when it is the same failure, else a new short name>
why: <why this change should fix it, in a sentence>
expectFix: <the case ids you expect to turn from fail to pass>
mayBreak: <the case ids that might turn from pass to fail, or none>
```

`problem` and `why` are kept after the campaign in a public place: general words only, never a case id, never words from a case, a reply or a chat. Name only cases you have reasons for: the round shows your list beside what happened.

Write your proposal to the file the main chat names, and send the main chat its path.
