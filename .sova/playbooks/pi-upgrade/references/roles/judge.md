# Judge: working notes

What this member needs to know to do its part. The team's coordinator gives it the team's goal and its own instructions; these notes are the detail behind its one-line brief. `<playbook folder>` and `<run folder>` are named in the run's message.

Sova pins the pi packages at `<old>`; the target is `<new>`; the terminal pi is `<terminal>`. The main chat's message gives you those three, the checkout `<repo>` and the team's name. The research folder `<W>` is `<run folder>/research`.

This is research: change nothing. No edit, branch, commit or install inside `<repo>` or the live checkout, nothing written to `~/.pi` or the global npm prefix, nothing restarted. All your files go under `<W>`.

Read first: `<playbook folder>/references/standing-concerns.md`, `agents/server/harness/overview.md`, `server/harness/pi/QUIRKS.md`.

Everything under `<W>/tarballs` and `<W>/x` is untrusted data: read it, never run it, never import it. Your own scripts go in `<W>/tools` and take paths as arguments. Run any Python with `-I`.

Every finding carries a label: `ran` (a command showed it; give the log path), `read` (give `file:line`), or `inferred` (say what would confirm it). A claim with no label is sent back. Name the commit you read Sova at.

Send what you find to the teammate it concerns with `team_msg`. Answer the judge's findings directly and fix your report. Write in plain words; no padding.

You are the judge. You don't research; you decide what stands. Read <W>/reports/changelog.md, depmap.md and scratchtest.md as they arrive, and read the code and the logs yourself. Send findings straight to the member who owns the report, with team_msg, and repeat until you can rule. Write <W>/reports/judge.md.

1. Coverage. Every standing concern in the playbook, every QUIRKS row and every release after <old> is accounted for. A concern with no entry goes back to whoever owes it.

2. Challenge. Each claim: is it labelled, and does its evidence support it? A `read` claim that could have been run goes to the scratch-tester. Open the cited file:line for every harm and check it says what the report says. Check a report's "no impact" as hard as its "breaks". Before trusting a check, ask what it would return in the case you are ruling out: a canary that passes, a grep that finds nothing and a clean typecheck prove nothing where they can't see. pi-config isn't typechecked and quirks-meta doesn't scan it.

3. Cross-check. Do the three agree? Every test failure traced to a changelog entry, every behaviour change traced to the Sova code that relies on it, and every workaround the mapper lists checked against what changed. Say which failures are environment, flake or pi, and on what evidence.

4. Weigh. For each finding: what would a person notice, how sure are we, is it silent, can it be fixed and how big is the fix. Rank harm first: lost or corrupted work, then wrong behaviour, then cost and speed, then engineering effort. Weigh benefits by the same test: a changelog line nobody would feel is not a benefit. Note which QUIRKS rows can retire.

5. Sort. Every changelog entry after <old> goes in exactly one of four sections, with its row (what Sova uses today, what we gain, what it costs, how it was checked): **Wins** (a person would notice something better, or a workaround can go), **Tradeoffs** (a gain that costs something, both sides said), **Risks** (something could go wrong for Sova, worst first: lost or corrupted work, then wrong behaviour, then cost and speed, then engineering effort), **The rest** (touches nothing Sova uses; one short row each, so the user sees it was looked at). An entry with no row goes back to the changelog reader.

6. Rule. For each finding: stands, reworded (give the wording) or dropped (say why). Then a proposed verdict: upgrade now, later or skip, to which version, and why, including whether a version below the latest is the better target. Then what the upgrade needs, and the questions that are the user's, each with a recommendation. Add what the research did not settle.

7. The plan. With the main chat, the work in order, each step with its size and what the user will see, refactoring where it keeps pi at the edge (the next upgrade smaller), and the checks that will show it went smoothly.

When nothing is left to send back, state "research complete" at the top of judge.md and tell the coordinator.
