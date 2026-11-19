# The record

What a subject has learned, kept after the campaign folder is gone. One file per subject in the project's repository: `<project>/.sova/ab/<name>.jsonl` (`<name>`: lowercase letters, digits and dashes, such as `vis`; it is `record` in `campaign.json`). One line per attempt, losing ones too, and one closing line per campaign. `scripts/record.mjs` writes and reads it; nobody edits a line by hand except to rename or merge a problem.

## Rules

- **Every attempt is kept.** Each candidate arm of each round gets a line, whether it was carried forward or dropped. A dropped attempt that scored below its base "made it worse", and says so when the record is shown.
- **General words and counts only.** No text from a case, a reply or a real chat, no case id, no home folder, URL, IP address or email. A problem is named in the consultant's own general words ("skips the guide before drawing"), with how many cases it covered. `record.mjs add` builds a line from named fields only and refuses one the check catches.
- **One name per problem.** A consultant picks one of the record's problem names when its change is aimed at the same failure, and writes a new one only when none fits. The record is shown grouped by problem.
- **Who reads it.** The main chat at the first step, the case finder, every consultant before it proposes, and the landing reviewer. The grader never reads it.
- **No test chat sees it.** Every arm's branch, master's arm too, removes `.sova/ab/` in a commit of its own that never lands, and a round refuses to start while an arm still holds the record in its folder or its HEAD commit (`references/arms.md`).
- **How it is kept.** `record.mjs add` writes it in the campaign's own worktree after each round is scored, so nothing is lost while the worktree exists. At the last stop it is committed by explicit path on the campaign's own branch, which carries nothing else, and it lands with Land: a winner's branch is cut from that branch, so the record rides with it; a parked campaign lands the record alone. Never `git add -A`.

## A prediction

A consultant's proposal ends with this block, and the builder copies it into the arm in `rounds/<n>/arms.json` (`references/ledger.md`):

```
problem: skips the guide before drawing
why: The rule sits below the examples, and a cheap model stops reading at the first example
expectFix: f01, f02, f04
mayBreak: p03
```

`problem` and `why` are general words: they go into the record as written. `expectFix` are the cases expected to turn from fail to pass, `mayBreak` the ones that might turn from pass to fail, by case id; in `arms.json` each is a list, and `none` an empty one. The ids stay in the campaign folder; the record keeps their counts. An id that isn't a case, or is a sealed case, is refused.

## An attempt's line

```json
{"v": 1, "kind": "attempt", "date": "2026-11-18", "campaign": "vis-dsl", "round": 2, "arm": "B",
 "problem": "skips the guide before drawing",
 "change": "Moves the guide rule to the first line of the tool's description",
 "why": "The rule sits below the examples, and a cheap model stops reading at the first example",
 "text": "<file>\n- <a removed line>\n+ <an added line>",
 "knobs": ["tool-description"],
 "models": [{"model": "zai/glm-5.3", "effort": "low", "cases": 20, "base": 40, "arm": 70},
            {"model": "claude-code/claude-haiku-5-5", "effort": "low", "cases": 20, "base": 50, "arm": 75}],
 "all": {"base": 45, "arm": 72.5},
 "predicted": {"fix": 3, "risk": 1},
 "observed": {"fixedExpected": 4, "notFixed": 2, "fixedUnexpected": 3, "brokeExpected": 0, "brokeUnexpected": 1},
 "outcome": "carried", "note": "..."}
```

(One line in the file; wrapped here.)

- `problem`, `change`, `why`, `knobs`: from the arm in `arms.json`. An arm without `problem`, `change` or `why` is refused: the reason is what the record is for.
- `text`: the lines the change removed and added, from the arm's `base` to its `ref`, under each file's path in the repository. Kept when it is short (1500 characters at most) and passes the check; otherwise the line has `files` (the paths touched) and `lines` (`{"added", "removed"}`) instead.
- `models`: per test model, the cases graded on both the arm and its base, and the pass rate (%) of each on those cases. `all`: the same over every test model. The base is the arm of an earlier round whose `ref` is this arm's `base`, else Round 0's master.
- `predicted`: how many cases the prediction named (`fix`: `expectFix`, `risk`: `mayBreak`); `null` when the arm stated none.
- `observed`: what the round did, counting each case once per test model (above: 3 cases on 2 models, so 4 fixed and 2 not). `fixedExpected` and `notFixed` are the `expectFix` cases that turned to pass and that still fail; `fixedUnexpected` every other case that turned to pass; `brokeExpected` the `mayBreak` cases that turned to fail; `brokeUnexpected` every other case that did.
- `outcome`: `carried` (it became the next cycle's base) or `dropped`.
- Never in a line: an arm's `url`, `agentDir` or `cwd`, a case's prompt or expectation, a reply, a case id.

## A campaign's closing line

```json
{"v": 1, "kind": "close", "date": "2026-11-20", "campaign": "vis-dsl", "verdict": "land", "master": "3c9e1f7a", "rounds": 3,
 "confirm": [{"model": "zai/glm-5.3", "effort": "low", "cases": 10, "master": 40, "winner": 80}], "note": "..."}
```

`verdict` is `land`, `cycle` or `park`; `master` master's commit, the one Round 0's arm was cut from (its `base`; its `ref` when it has none); `rounds` how many rounds had candidates; `confirm` the confirm run's pass rates on the sealed cases, when there was one.

## The commands

| Command | Does |
|---|---|
| `record.mjs show [<name>] [--project <root>] [--campaign <name>]` | the record as markdown, grouped by problem, with its one-line summary ("vis: 6 attempts, 2 carried, 1 made it worse"); with no name, every record the project has; `--campaign` shows one campaign's lines only |
| `record.mjs add <campaign> --round <n> --outcome carried\|dropped [--note "..."]` | one line per candidate arm of that round, after `score.mjs total`. `carried`: the round's best arm was carried forward and the others dropped; `dropped`: none was. `--note` goes on each of the round's lines. A round already in the record is refused; `--replace` rewrites its lines |
| `record.mjs close <campaign> --verdict land\|cycle\|park [--confirm <round>] [--note "..."]` | the campaign's closing line |
| `record.mjs check [<name>] [--project <root>] [--campaign <campaign>]` | the check below over a record (every record with no name); with `--campaign`, also against that campaign's cases and replies |

`<campaign>` is the campaign folder; the project is the worktree it sits in (`<project>/.cache/ab/<campaign>/`), or `--project`.

## The check

A line is refused, naming its field, when a piece of its free text (`problem`, `change`, `why`, `note`, `text`, `files`) holds:

- a home folder or absolute path (`/home/`, `/Users/`, `~/`, a drive letter), a URL, an IP address or an email address;
- one of the campaign's case ids, standing as a word (case `arrow-labels`: "like arrow-labels" is refused), in `add`, `close` and `check --campaign`;
- a token shaped like a case id (`f01`, `p12`, `s03`), with or without a campaign;
- 8 or more words in a row that appear in one of the campaign's cases or saved replies.

Its other fields must have their own shape (a date, a round number, a model name, a commit). `add` and `close` run the check before they write; a `text` it refuses is left out for `files` and `lines`, and the command says so.
