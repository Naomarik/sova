# The report

One reply in the chat, written for a project manager: what a person would notice, not what the code does ("a chat can lose its mode note when an extension sends it a message", not "`before_agent_start` fires on custom runs"). Save the same text as `<W>/reports/final.md`.

In this order:

1. **The answer in one line**, then the facts: Sova pins `<old>`; the target is `<new>` (released when, how many releases between); the terminal pi on this computer is `<terminal>`. Always state that last one.
2. **Wins.** Things a person would notice getting better, then workarounds Sova can drop.
3. **Tradeoffs.** Gains that cost something: both sides, plainly.
4. **Risks.** What could go wrong for Sova, worst first: lost or corrupted work, then chats behaving wrongly, then cost and speed, then engineering effort. Say what would happen, to whom, and whether it would be silent. Each risk is numbered and ends with its main `file:line`; one with none isn't a finding yet and goes back to the team.
5. **The rest.** Entries that touch nothing Sova uses, summarised per release: how many, and what kinds, in a line each. Every one of them has its row in the changelog reader's file, `<W>/reports/changelog.md`; name that file here, so the user can see each was looked at.
6. **Verdict**: **Upgrade now, to `<v>`** (the risks are fixed by known, bounded work and the wins are real), **Upgrade later** (name what it waits for), or **Skip `<v>`** (net harm; say what would change your mind). It may name a version below the latest.
7. **Questions**, numbered, each with your recommendation: only what is the user's. Each in four parts: what it is, what could happen, what yes does, what happens if we don't.

Sections 2 to 4 are tables, one row per changelog entry; with section 5's file, every entry after `<old>` is in exactly one place:

| Entry | What Sova uses today | What we gain | What it costs | How we know |
|---|---|---|---|---|
| 1.2.0 · "`before_agent_start` also fires on …" (quoted, short) | the mode note and the Overseer's note, `server/harness/pi/modes.ts:201` | nothing | a fix in 3 places and a decision (question 1) | ran: typecheck, 3 errors |

"How we know" is `ran`, `read` or `inferred`, with what. Above the fold, the only code is each risk's one citation and the "uses today" cells.

The technical detail goes last, under a line reading exactly `### Working notes` (it folds everything after it): the risks again by number with every site and its evidence, the version table, the test results against `<old>`, the environment failures set aside and why, what was not run, and the paths in `<W>`.

Then go straight on to the plan (`phases/plan.md`): the stop comes after it.
