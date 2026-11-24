# The layout to propose: an entry page that is an index

A chat pays for a skill's entry page each time the skill is used, and for its listing in every message. Detail only some tasks need belongs on pages read only then.

## The pattern

- **Entry page**: one line on what the skill is for and when to use it; a **Where to look** table (doing this, read that page); the few rules that hold for everything; what breaks without an error; and which page wins when two disagree.
- **One shared page** for rules every topic shares.
- **One page per topic**, named in the index with when to read it; a big topic split again into parts read on demand.

## Bands for the entry page (pointers, never a failure)

| Lines | Band | Report |
|---|---|---|
| up to 150 | fine | nothing |
| 150 to 400 | worth a look | the sections that could move out, from the digest's `sections` |
| over 400 | heavy | a proposed split: the new pages, what moves where, the sizes before and after |

An entry page that asks to be read whole (the digest says "deliberate") is marked as the owner's choice: report its size and the split, and say it was deliberate.

## Exemplars in Sova

- `pi-config/extensions/mode/vis/` (in Sova's repository): `overview.md` is 30 lines, one line per kind of drawing; `shared.md` (14) holds the rules every kind shares; each kind has its own page (9 to 56 lines), and `tour.md` (174) is split into four parts read on demand. About 820 lines in all; a chat carries 30 until it draws. Its HTML comments name the owner and how the file loads, and are stripped before the model sees them.
- `.agents/skills/fold-ai-dev-design/` (Sova's design skill): an index-first entry page with a Where to look table into 34 reference pages, a list of what breaks with no error, and a precedence rule. Its entry page is still about 550 lines and asks to be read whole, so the audit calls it heavy and deliberate. Its reference pages are generated (`.build/build.mjs`).
- This playbook: `PLAYBOOK.md` is the index, `phases/` one page per step, `references/` the rest.

## Generated pages

A skill with a `.build/` folder, or an entry page that says to edit a source and not the output, is generated: propose the change to its source and name the generator command; never a hand edit of the output.

## The move rule

A layout change moves text and never rewords it. Every paragraph of the old entry page must land on exactly one new page, or be a repeat removed with the copy that stays named. `check --moved` proves it in the recheck.
