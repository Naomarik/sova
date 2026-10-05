# Grading: what counts as answered, named and read

Scenario g and the agent arm grade needs the same way, in code (`fullness.mjs` `scoreNeed`,
`agent-arm.mjs` `grade`). No model judges a need's score. This file states the rules and works them
through, so a run can be checked by hand and a reviewing team member can do the hand-reading jobs at the end
mechanically.

## The inputs

- **A need** (`data/comparisons.json`): its comparison, category, wording, a `probe` regex, and
  sometimes a hand `verdict` `{status, at?, note}`. `at` is a location `file:line`, relative to
  `.sova/spec/claims/` in the pinned spec.
- **What the arm read:** a set of passages whose exact text arrived, plus, in the agent arm only, line
  ranges of claim files read with the file tool.
- **What the arm named:** ids it was shown without their text: `toc` lines, `read` footers' `named`,
  and packet frontier ids that were not delivered.

## What counts as read (delivered)

1. A packet or `read` item counts once its fragments, joined in order, equal the passage's source span
   byte for byte. A passage cut off mid-way is not read.
2. In the agent arm, a passage also counts when its whole text appears verbatim in any tool output,
   for example from `cat`.
3. In the agent arm, a claims file read with the file tool counts for the lines it returned: offset to
   offset + lines − 1.
4. A `toc` line is never a read. It names its id.

## How a need scores (first matching rule wins)

| # | Condition | Status | Value |
|---|---|---|---|
| 1 | verdict `n/a`, or no probe | n/a (not counted in "of") | — |
| 2 | verdict `absent` | absent | 0 |
| 3 | verdict has `at`, and that line falls inside a read passage or read line range | `partial` if the verdict says partial, else `in` | 0.5 / 1 |
| 4 | no verdict `at`, and the probe matches a line inside what was read. A sentence wrapped onto the next line matches when the joined pair matches and the next line alone doesn't | `partial` if the verdict says partial, else `in` | 0.5 / 1 |
| 5 | otherwise, if the spec states it anywhere (the verdict's `at`, else the first probe hit in the whole pinned tree, files in sorted order) | missed; **named** when that passage's id, or its H1's, was named | 0 |
| 6 | otherwise | absent | 0 |

"Answered" = sum of values. "Named" = rule-5 needs whose passage was named. "Answered or named" adds them.

## Worked examples (pinned spec a95768b7)

- **C07:5 "The queued-message record"**. Verdict `missed` at `chat/transcript.md:470`. Line 470 is the
  heading of `§chat.transcript/a-queued-message` (lines 470–507). `packet §chat/composer` doesn't reach
  it, so the need is missed (0). It isn't named either: packet names nothing undelivered there. An agent
  that reads `§chat.transcript/a-queued-message` scores 1, since the verdict status isn't partial. An
  agent that sees it only as a `toc` line scores 0, named.
- **C06:6 "Thinking level: per model, absent when none"**. Verdict `partial` at `chat/model-menu.md:169`
  (`atFrom: "note"`: the location came from the verdict's own note). The packet of
  `§chat/model-menu` includes that line, so the need scores 0.5. It never scores 1, whatever is read:
  the verdict caps it.
- **C05:0 "Where the change view opens from"**. No verdict; probe `^## §chat\.changes\/entry`. The
  packet of `§chat/changes` delivers that heading line, so the need is in (1).
- **C06:2 "Changing the model mid-session clears no context"**. Verdict `absent`, because the probe hit
  was in a baton passage. It scores 0 in every arm, even when the probe would match.
- **C06:5 "The picker's own address"**. Verdict `n/a`. It is excluded from "of".
- **C18:3 "Event / delta names"**. No verdict; probe `message_update|text_delta|delta`. Whatever line
  first matches inside the read set answers it. This is the weak spot: a bare probe can match an
  unrelated line (see "Hand-reading jobs").

## Reaching around the tools (the same rule in every arm)

The score counts content, not route. A passage the agent saw counts as read whichever way it came
back: through the tool directly, piped through `node -e`, or saved to a temp file and printed again.
The route is reported, and it never changes the score. Each call that reaches past the tools is
classed (`accessesOf` in `agent-arm.mjs`):

- **scratch**: the agent's own temp files (`/tmp/…`), where it saved tool output to page through it.
  Allowed. Their bytes count again in "bytes", because the agent read them again.
- **directSpec**: a spec file opened without the tools (`cat .sova/spec/claims/…`, the file tool on a
  claims file, or `.sova/spec/` inside a pipeline). A violation of the prompt, reported per comparison.
  What it returned still counts as read, so both arms are scored on what the agent actually saw.
- **outside**: any other path out of the work directory (`../../src/…`, a home path). A violation,
  reported. Ordinary pipe targets such as `/dev/null` are not reads.

A path is a word of at least two segments starting with `/`, `~/` or `../`. Regex literals and
tokens in a script don't count. First run (packet arm, 8 comparisons): 0 outside, 0 directSpec,
33 scratch. The 22 "outside" an earlier grader reported were `/dev/null` and these scratch files.

## The agent arm's guard (reported, not an exit code)

For each need the recorded packet baseline answers (`data/g-baseline.json` `values[i] > 0`): it is
**lost** when the agent's value is lower and the baseline's passage (`passageOf[i]`) appeared in no
`toc` line or `read` footer the agent saw. A need the agent was shown but chose not to open isn't lost.
It counts against "answered", and the pull design accepts that.

## Hand-reading jobs for a reviewer (rules, then output format)

These are the only judgement calls. A reviewer (a Claude team member, never a model under test in the agent arm) produces data; the code above applies it.

1. **Probe hits that need a verdict.** Input: a need and a location (`file:line`) where its probe
   matched, with the passage text around it. Read the matching line and its paragraph, then decide:
   - `in`: the paragraph states the fact the need asks for, for the surface the comparison is about,
     or a rule that plainly applies to it.
   - `partial`: it states part of the fact. Example: it names the message but none of its fields.
   - `absent`: the match is about something else (another surface's feature, a word used in passing).
     Say what the hit was about.

   Output one JSON line per hit: `{"key": "C13:3", "status": "in|partial|absent", "at": "file:line", "note": "<one sentence>"}`.
   Merging a reviewer's verdicts into `data/comparisons.json` changes the recorded baseline. The
   coordinator approves it, and `node scenario-g.mjs --record <base tree>` regenerates the baseline.
2. **Contents-line "what" quality** (plan §5b.8). Input: a `toc` line's `what` and the passage it
   summarises. Answer `yes` when the sentence says what the promise is, for this promise: its subject,
   and what it does or holds. Answer `no` when it describes a detail, a neighbour or an exception, or is
   empty. Example from the plan: `§chat.composer/anatomy`'s "what" is about the Overseer's Quick Actions
   button, so it gets `no`. Output: `{"id": "§…", "what": "yes|no", "why": "<one sentence>"}`.

A reviewer needs to read only the pinned spec and these inputs. It sits in the replay worktree, reading
`tmp/spec-work/` and writing to `tmp/spec-work/grading/`, and never edits the repo.
