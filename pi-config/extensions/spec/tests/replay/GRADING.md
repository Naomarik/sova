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
- **What the arm named:** ids it was shown without their text: `toc` lines, `read` footers' `named`
  and `about`, and packet frontier ids that were not delivered. The agent arm reads both forms: `--json`
  (`lines`, `footer`), and the text form (indented `  §id — ` contents lines; the footer lines
  "named here, not delivered by this call:" and "notes about it, not delivered by this call:"; "… by this read:" since tools' HEAD B). A test renders both through the tree's own `toc` and `read`, so a wording change that breaks the parse fails it.
- **The frame** (`read`'s first page, M5): its items count as read like any `read` item, in `--json`
  (`frame.items`) and in text (the passage text is printed verbatim).

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

## Ground rules reached (g's `groundRules`, x/24)

A comparison reaches the ground rules when its packet delivers (frame included) a `§design/ground-rules`
or `§design.ground-rules/*` passage that **carries a rule**: a body line (the heading line excluded,
list items included) holding one of the words must, never, always, don't or do not
(case-insensitive; `carriesRule` in `fullness.mjs`). Only prose lines count: fenced code, HTML comments,
table rows and blockquotes are skipped, and inline code and quoted strings are removed first, so a copy
string or a code sample never makes a rule. "only" is not a rule word (it is common in plain description).
On b1de66b1's spec 603 of 861 passages carry a rule, and all six ground-rules H2s do. A breadcrumb or a lede with no such line counts
for nothing: the 99-byte `§design/ground-rules` lede at a95768b7 and b1de66b1 carries none. This counts
reach, not usefulness; whether a frame answers needs is `g.pull.frame-answered` and C23's score.

C23:0 "Product-wide principles" follows the same rule. Its probe was the H1 heading alone
(`^# §design/ground-rules`), which the breadcrumb satisfied. It is now `rule: true` in
`data/comparisons.json` with the probe `^# §design/ground-rules|^## §design\.ground-rules/`: a need marked
`rule` is answered only in a delivered passage that carries a rule (`carriesRule`, `fullness.mjs`), and is
located in the first such passage in the index's order (file, then line), which is `/theme`. It counts whole
passages only: an agent's line-range read of a claims file (the read tool with an offset) never answers it,
while a passage delivered whole or arriving verbatim in any output does; this under-counts both arms alike. **No recorded number moved**: both g baselines re-recorded with the same
values and totals (93.5/138, pull floor 106); only C23:0's located passage moved, from the H1 lede to
`§design.ground-rules/theme`. A breadcrumb-only frame leaves C23 at 0.5/6 (replay.test.mjs). Since any
rule-carrying passage of the family answers it, an answer found in another one is no moved answer
(`g.packet.moved-confirmed` skips it), and the pull proxy counts it shown when any rule-carrying passage of
the family is a contents line or in the frame.

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
tokens in a script don't count. `where` and `map` arguments are lookups, not reads (up to a shell
separator, a redirect or the end of the line); a `--root` or `--spec` value is still a path. First run (packet arm, 8 comparisons): 0 outside, 0 directSpec,
33 scratch. The 22 "outside" an earlier grader reported were `/dev/null` and these scratch files.

## The agent arm's guard (reported, not an exit code)

For each need the recorded packet baseline answers (`data/g-baseline.json` `values[i] > 0`): it is
**lost** when the agent's value is lower and the baseline's passage (`passageOf[i]`) appeared in no
`toc` line or `read` footer the agent saw. A need the agent was shown but chose not to open isn't lost.
It counts against "answered", and the pull design accepts that. A `map` (or `where`) line is no
sighting: `map` lists every area on one page, so it would excuse every H1-located answer; `where` lists
every claim whose `code` names a file, by file and not by what the task needs, so a claim listed there was
matched to a path, not shown to the agent as the place an answer lives. Such a loss
is also listed apart (`lostSeenOnlyInMap` in compare.json; the scorecard's `mapShown`).

Every agent scorecard records its grader (`grader`: a hash of the grading code and data, the harness
commit, and whether those files were uncommitted). `compare` refuses two scorecards whose grading-code
hashes differ (or one without a grader): re-grade both with `grade --out`.

## Each arm on its own spec

An arm may read another spec than a95768b7 (`run --pinned <dir> [--spec-label <name>]`; the final comparison's
candidate reads the final head's spec). The run keeps that spec in `<run>/spec/` with its hash in run.json, and
`grade` scores against it (refusing a snapshot whose hash changed); runs made before this are graded on a95768b7 and
labelled so. Every scorecard and `compare` names each arm's spec. Scoring is the same on any spec: an anchored verdict
finds its quoted line wherever it moved, a probe matches in that spec. "Lost unless seen" looks for the recorded
answering passage on the arm's spec: the same id, or, when the id is gone (renamed or merged), the passage there whose
body lines match at least half of the recorded one's (`relocate`); only when neither exists, where the need's probe or
anchor lands in that spec. A need whose verdict is unanchored on an arm's spec (its quoted line is gone) is listed per
arm (`unanchored` in the scorecard and in compare) for a re-verdict, and left out of BOTH arms: never lost, never in
either answered total. `compare` lists,
for needs both arms answered: `moved` (answered in another passage; `movedUnconfirmed` when no anchored verdict names
the new one) and `answerTextChanged` (same passage, different text). Both are hand checks, not scores. On one spec a
move means a probe met in two places (M2: 4 and 6, all probe-only).

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
