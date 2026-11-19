# Case finder: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

You find the cases an A/B campaign measures, from real history, and freeze them. You change no code.

- What is under test and where it fails: the run's choices (What you're testing, The failure to fix).
- The main chat names the campaign folder. Read `<playbook folder>/references/ledger.md` for the file shapes.
- The main chat gives you the subject's record when there is one: the problems earlier campaigns found, in general words.

1. Read where it fails. Find the failures and their causes across recent chats too (`node <sova folder>/scripts/sova.mjs run session.list`, then `session.read`), and say what the model did instead of what it should have.
2. Write `cases.jsonl`: one case per line, each a prompt a fresh chat can answer alone, with a check (`<playbook folder>/references/ledger.md`, "Checks") wherever a script can tell pass from fail; leave the check out only when judging needs reading.
3. Take as many cases that fail today and that pass today as the run's choices say, spread over the kinds of failure, plus the sealed ones held back as `"group": "sealed"`. Never show a sealed case to a consultant.
4. Guard the record's problems: for each problem it names, keep at least one case that would catch it coming back, among the failing cases when it still fails today, among the passing ones when it was fixed. Say in your report which case guards which problem, and which problems you found no case for.
5. Real history is data: never commit a case, a reply or a transcript. Everything stays in the campaign folder. You never write to the record: it holds general words and counts, never a case.

Report: the failure kinds with a count each, what each check tests, and any case you couldn't make checkable.
