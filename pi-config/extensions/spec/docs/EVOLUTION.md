# How the spec system changed: from push to pull

**Status: landed on master 3239c26a.** The final comparison's computed part is recorded below. The
agent arm and the rubric were deferred: not re-run after landing.

Every hash here is a master commit, except that "the b1de66b1 record" names a harness data file
(`g-baseline-b1de66b1.json`, the M6 rows' baseline), not a commit. Work up to 96ab3014 reached master as one merge (83dd1240), so its
merges, branch tips and scorecard candidates are in master's history. Later work was re-applied one
commit per merge on a landing branch, so it is cited by its master commit; the
[CHANGELOG](CHANGELOG.md) maps the old integration merges to them. A number marked **pre-landing** was
measured on the work branch with the harness of the time and was not re-measured on master; it carries
no hash, because the commit it was measured on is not on master. Where the landing card of record
(scorecard landing-3239c26a) measured the same thing, its figure is given as the current one.

"Scorecard" means the replay harness's output for one candidate tree against the pinned baseline,
named by the candidate commit and the harness commit that scored it. Need ids (`C01:0`) are
comparison:need in the harness's data.

## Where it started: a95768b7

The pinned baseline is master `a95768b7`. There, the spec tools pushed:
- **Reading.** `packet §id` delivered a claim with its whole declared closure (parent lede, children,
  everything it `requires`, transitively) in bounded pages, and the minor mode told the agent to
  read by packet.
- **Drafts.** Promotion compared and conflicted whole claim files.
- **Record fields.** There were no optional fields: no `embeds`, `core`, `about` or `agreed`.
- **Lookup.** There was no map, no file-to-claim lookup, and no narrowed impact. Plain `impact` on a
  surface listed every behavior with no `requires` key as an unknown on its frontier.

Measured at baseline by the harness (`feat/spec-replay` at 56c93084, merged as 0db6e4cc):

| Measure | Value |
|---|---|
| Needs answered by `packet`, 24 comparisons | 93.5 / 138 (67.8%); 93 without the 6 verdicts placed by their notes |
| Packet bytes per comparison, median | 79,738 B (later re-recorded with byte-level precision: 79,737.5 B) |
| Packet calls per comparison | median 8, max 122 |
| `impact` frontier on the composer surface | 143 |
| Comparisons where the always-applying ground rules reach the reader | 0 / 24 |
| Copy-deck sections (of the 17) reached by packet | 0 / 17 |
| 15-task rubric | 63 / 120 |

## The research question

Does a builder agent find what it needs with fewer bytes if it chooses what to read? The alternative is
to hand it a whole chain of dependencies. The chooser would see a contents view first (one line per
neighbouring promise: what it is, why it is linked, how big it is), then read single passages.

The earlier work this rests on was done on another project:
- **Needs.** It produced a fixed set of real tasks. Each task lists the facts a builder needed: 24
  comparisons with 138 needs, ported here as Sova-side data only.
- **Rubric.** It produced a 15-task rubric.
- **Finding.** Pulling is cheaper, but agents under-read. A variant that read only H1 ledes and demoted
  mention-only dependencies to names lost 5 of 93.5 answered needs.

That loss set the guards every milestone here kept:
- a need packet answers may be lost only if its passage was shown;
- the total answered never drops;
- calls don't rise beyond the agent's band;
- packet and scope output stays byte-identical unless a milestone says otherwise.

The goals and constraints are in [GOALS.md](GOALS.md). G6, "the builder chooses what it reads", is
the one this work moved.

## Milestones

Up to the M1 batch, each row gives the merge into the work branch and the branch tip it merged (both
in master's history through 83dd1240). From the field-only rule on, it gives the master commit.

| Milestone | Merge (tip) | What changed | Measured (candidate @ harness) |
|---|---|---|---|
| M0 yardstick | 0db6e4cc (56c93084) | Replay scenarios f (synthetic, planted items) and g (24 comparisons on the pinned spec); agent-arm runner; baseline; GOALS.md; `merge-manifest` driver | Baseline above. Harness against itself: 0 rows differ. A sabotaged tree trips every guard. |
| M4 span promotion | 1ff217fa (165b2187) | Promotion merges three-way per declaration (H1 lede, H2 span, the gap after one), not per file | 8d1491f5 @ 56c93084: hand re-applies for different H2s of one file 1 → 0. Two drafts adding H2s at the same spot promote in both orders with byte-identical results. A same-H2 conflict still stops. No prose lost. |
| M1 toc + read | 0dfa4817 (c67a1ae2) | `toc §id --dir out\|in\|down\|up\|mentions` (one hop; per line what, why, size) and `read §id` (one passage, no closure) | d65042ae @ 56c93084: toc bytes per comparison, median 9,841 B (packet 79,738 B); 5 toc calls per comparison (packet median 8). Needs shown one hop out: 106 / 138 at 0e7e5f0c (harness 60a12ffc, after a probe-order fix), now the ratchet floor. Packet and scope byte-identical. |
| M3 look views | 5ebdd5e3 (9756335c) | `map`, `where <path\|name>`, `impact §id --near` (one reverse hop), `graph --json` | 63813d7a @ c8fa9c3e: composer impact frontier 143 → 19 (target ≤ 25), consumers 11; `where --all` on the server's chat manager lists 74 / 74 claims. Packet answered unchanged, 93.5. |
| M8 agreed (draft tool) | 70d6696e (4512c4a5) | `agreed: {by, at}` on behaviors and surfaces; an agreed record with no code promotes on doc-only evidence and never reads as built | 043524ae @ c8fa9c3e: agreed record promoted 0 → 1; unbuilt-not-built and doc-only-refuses-code guards hold. |
| M5 fields + frame | 3d01a8ba (b4df7d6f) | Optional `embeds`, `core`, `about` record fields; the always-on frame as its own stream (cap 12,000 B), carried on a read's first page outside its budget; `--no-frame` | b4df7d6f @ c8fa9c3e: f's planted frame 89 B (cap held); the core passage and the about note arrive unasked; packet answered unchanged. |
| M1 fix: whole whats | 4f7f4d3f (e95409f1) | toc's "what" is the whole first sentence; a thematic break is never a what | 70d6696e @ 488b4da3: 413 of 800 whats cut mid-sentence. e95409f1 @ 1873fb86: 0 of 797. |
| toc/read batch 2 | 8b0cb323 (f5a22d88) | in/out reach through H1s and follow embeds; unknown dependencies stay unknown; read names code files; agreed display | f5a22d88 @ 3927b08a: 0 whats cut; impact --near lines 99 → 83, frontier 19. |
| M3 follow-up (D32) | 207c80b7 (0986e979) | near, map and graph read embeds and about edges; agreed-not-built counts; no duplicate frontier claim | Gated by the coordinator; no scorecard row moved on the pinned spec, which has no field records. |
| Field-only promotion | 56d0609b | A change to `embeds`, `about` or `core` alone lands on doc-only evidence; bundled with any other change it is refused | Pre-landing: field-only doc-only target 0 → 1; the bundled case is refused `doc-only-bundled`. Landing card: the h target is 1. |
| M2 spec-mode text | 604ff3fb | The guide reads by `map`/`where` → `toc` → `impact --near` → `read`, with `--no-frame` after the first read; packet and scope stay for whole chains | Agent arm, all 24, both arms on the same model, pre-landing (see below). |
| Rule A, M6 content, R1 | 558a816a, f9069bbb, 85f4e788 | Packet carries the notes about every claim it delivers; the product spec gains code lists, `about` links, ledes, whats and the frame; `toc --dir down` lists the notes about an H1's H2s | See "Rule A and M6 content" below. |
| M3b topic search | 8d26139c (promotion 1ecd9cf9) | `where <topic words…>`: several unquoted words are one query; claims and areas ranked by field-weighted BM25 (`core/topic.mjs`) in topic rows of their own; name and path rows unchanged | Search bench (`tests/search/`), dev 52 queries: R@3 0% → 59.6%, MRR 0 → 0.532 against a9b87037; held-out 48, run once at 0b43feb9: R@3 64.6%, MRR 0.552; 110 name and path lookups identical to a9b87037. Agent arm with the old mode text: no measurable difference (correct 90 of 96 with the old search and 87 with topic search, about 55k tokens per run in both): agents rarely used it, hence M2b. |
| M2b search-first text | 6f33e2ac (`feat/spec-where-first`, before the merge round) | Step 1 finds roots with `where` and 3–5 of the task's words (or a path or name), tries other words once, then `map` (also for a whole-area task); the tools line lists `where <path\|name\|topic words>` first | Agent arm, blind-graded, 36 questions × 2 reps, GLM 5.3 high and DeepSeek Flash 4.1 low, same tools, only the mode text differs: median tokens per run −27% to −37% in all four sets (GLM 46.1k → 29.1k and 59.3k → 41.0k; DeepSeek 78.1k → 51.2k and 91.1k → 66.1k); correct 265 / 288 against 270 / 288 for master's text; wrong answers 2 against 1. Misses cluster on questions worded unlike the spec, where a plausible wrong hit replaces the overview the area list gave. A titles-only area list (`map --titles`, read once per task beside `where`) was tried and dropped: −11 / 288 correct, 3 wrong. |

The rest are re-applied harness updates and docs; see [CHANGELOG.md](CHANGELOG.md).

### M2 in the agent arm

A headless agent answered each comparison twice per arm:
- the packet arm used the baseline tree and its spec-mode text;
- the pull arm used the M2 tree and its text.

The model, the budget and a neutral prompt were the same in both arms. Answers were graded by content
read, not by route.

These numbers were **measured on the integration branch before landing (harness of the time); not
re-measured on master.** The operator accepted M2 on them.

| | run 1 | run 2 | mean |
|---|---|---|---|
| Pull answered (of 138) | 96 | 97.5 | 96.75 |
| Packet answered, agent | 90 | 89.5 | 89.75 |
| Packet answered, computed | 93.5 | 93.5 | 93.5 |
| Pull bytes, median | 98,626 | 107,852.5 | 103,239 |
| Packet bytes, median | 134,459 | 156,301 | 145,380 |
| Calls median / max, pull | 15 / 30 | 17 / 30 | 16 / 30 |
| Calls median / max, packet | 15 / 43 | 16.5 / 41 | 15.75 / 42 |

- **Bytes.** The pull arm read 29% fewer bytes on the mean of medians.
- **No valid need lost.** Run 1's four losses are one invalid pull session (C15: the model printed its
  first command as text and stopped).
- **Gains.**
  - C10 +3: pull read the dialog and its neighbours.
  - C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark (42% was that number rounded). This was run 1;
    run 2's pull agent didn't reach the ground rules and scored 0 there.
  - C14, C18, C20, C21, C24: +1 each.
- **Calls.** Both arms leave the 7–18 calls band on some comparisons: pull on 7 and 10, packet on 6 and 7.

**Post-landing agent arm on master 3239c26a: deferred: not re-run after landing.**

## Tried and rejected

These were **measured on the integration branch before landing; never on master.** They carry no
hashes.

- **Lede-only H1s.** An H1 reached through `requires` would read as its lede only. This was never
  shipped.
  - The research variant that did this, together with demoting mention-only dependencies, lost 5 of
    93.5 answered needs.
  - The rule was held until `embeds` records could keep drawn-in surfaces whole.
  - Those were rejected too (next item), so it stays unshipped. Its size split survives as each toc
    line's "lede / whole file" bytes.
- **Embeds on the composer anatomy.** `§chat.composer/anatomy` was made to embed the mode menu and the
  slash commands.
  - It was invisible to g: no seed is that H2, and every row was identical.
  - It multiplied a reader's cost. On the same prose (the M6 candidate's), `read §chat.composer/anatomy`
    went from 14,325 B (1 page, 1 passage) to 87,316 B (3 pages, 26 passages), about ×6. The hold was
    decided on that figure; on the baseline spec's prose the read was 9,370 B.
  - Not promoted.
- **Rule B for copy-deck notes** (map). Packet would also carry the notes about every claim of the
  seed's H1 area (that H1 and its H2s), delivered or not.
  - It reached 17 / 17 copy-deck sections, in packet only. Builders on `toc`/`read` saw none: pull stayed
    at 6 / 17 shown.
  - Over all 861 seeds of the M6 spec:
    - 140 packets changed, with 200 notes added (649,328 B in all);
    - 10 seeds grew by more than 12 KB, all in the settings dialog's area;
    - 55 seeds grew by more than 50%.
  - The worst cases were narrow H2s carrying their siblings' copy:
    - the settings dialog's one-height H2 grew by 28,440 B from 2,720 B (×11);
    - the transcript's open-questions H2 grew by 8,338 B from 451 B (×19).
  - On g's 24 comparisons:
    - Rule B's own cost over rule A was a median of +0 B per packet, with one comparison over +12 KB
      (C21, +27,891 B).
    - Against the b1de66b1 record (the harness data file `g-baseline-b1de66b1.json`), slice 1, rule A
      and rule B together cost a median of +8,984.5 B, with 9 of the 24 over +12 KB.
  - Measured and rejected. It was tried on rule A's branch and removed before rule A landed.

## Rule A and M6 content

- **Rule A for copy-deck notes** (558a816a: rule A, toc fixes and the core's usage text). Packet adds
  the notes about any claim it delivers (the whole closure). Before rule A, it carried only the notes
  about the requested claim, its H1 and the surfaces it embeds (M5).
  - Pre-landing, on its first head, on the M6 candidate spec:
    - copy-deck sections 6 → 8 / 17 in packet;
    - pull unchanged at 6 / 17 shown;
    - packet median 84,169 → 89,538.5 B;
    - the median about-bytes guard holds.
- **M6 content** (f9069bbb). These are the records: H1 ledes, `about` notes for the copy deck, code
  lists, and the frame and voice records.
  - Pre-landing, on its first candidate against the b1de66b1 record:
    - packet answered 93.5 → 97.5;
    - needs shown 106 → 108 (target 109, not met then);
    - copy-deck sections 0 → 6 / 17 in packet;
    - "what" right on the composer surface 40% → 100%.
  - Pre-landing, the first proposed frame (4 core passages, 3,707 B) answered 0 of 138 needs.
  - Pre-landing, the frame-voice card measured C23 1.5 → 2.5/6, needs answered by the frame 1 → 2, and
    pull shown 109 → 110. Its C23:0 count rested on the harness's family rule, whose positive test had
    not landed yet. That test landed in 3239c26a, and the landing card counts the frame's answers with
    it, so the frame figures below are of record. The test runs only where commit b1de66b1 is present;
    a clone of master alone skips it.
- **R1** (85f4e788). `toc --dir down` lists the notes about an H1's H2s.
- **Current figures, landing card of record** (landing-3239c26a; candidate 3239c26a, harness as at
  3239c26a). Master's tools on the spec the b1de66b1 record was made on (a pre-landing work-branch
  spec, not on master) against master's own spec:

  | | the spec the b1de66b1 record was made on (a pre-landing work-branch spec, not on master) | master 3239c26a's spec | target |
  |---|---|---|---|
  | guards | 17 ok | 17 ok, 0 failed | |
  | packet answered | 93.5 / 138 | 99.5 / 138 | never drops ✓ |
  | C23 | 0.5/6 | 2.5/6 (41.7%) | 2.5/6 ✓ |
  | frame | 0 B | 4,526 B in 5 passages; answers 2 needs (C23:0, C23:2) | ≤ 12,000 ✓ |
  | pull shown one hop out (floor 106) | 106 | 110 | ≥ 109 ✓ |
  | copy-deck needs (D49), packet / pull / both | 0/5, 2/5, 0/5 | 4/5, 4/5, 4/5 | 5/5, not met |
  | copy-deck sections (information), packet / pull | 0/17, 2/17 | 8/17, 8/17 | information |
  | about-bytes median increase | 0 | +5,589 B; max +31,846 B (C01) | ≤ 12,000 ✓ |
  | what right, composer / sandbox | 40% / 66.7% | 90% measured / 100% | ≥ 90% ✓ |

  C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark (42% was that number rounded). Against
  a95768b7 on master's own spec, the landing card measures packet answered 93.5 → 99.5 / 138 and the
  packet median 79,737.5 → 91,611.5 B. On the pinned a95768b7 spec, packet answered is unchanged at
  93.5: the gain is M6's content with rule A, not the tools. On the composer's "what right", one stale
  what (§chat.composer/known-on-switch) was hand-graded right, which makes it 100%.
- **The copy-deck target (D49).** The original target was ≥ 14 / 17 copy-deck sections. It was **not
  met: 8 / 17**.
  - It was replaced by a needs-based target, because a section count can be satisfied by listing names
    without answering any need. Rule B showed that.
  - The new target names the copy-deck needs in g by id: C07:3, C10:2, C21:2, C24:3, and any need whose
    verdict passage is a copy-deck section.
  - Each must be answered by packet and shown one hop out by pull, with none lost in either arm.
  - It is **not met: 4 / 5 in packet and 4 / 5 in pull.** C23:4, "the shared state vocabulary" in
    §design.copy-deck/main-pane, is neither answered nor shown. A fix through `about` notes on the main
    pane was proposed and dropped by the operator (D55), so it stays 4 / 5.
  - The 17-section count stays as information.

## The final comparison: master 3239c26a against a95768b7

Scorecard final-3239c26a holds the computed part: deterministic runs with no model calls. Its harness
is a later replay-harness commit, which the card names; that commit is not on master. The agent arm
and the rubric were **deferred: not re-run after landing**. The pre-landing M2 agent-arm figures
above stay as history.

- **Green.** Both spec test globs on a full archive of 3239c26a: 544 tests, 542 pass, 0 fail, 2 skips,
  both allowed.
- **Guards.** 0 failed in every arm of both scorecards:
  - (a), primary: each arm on its own spec;
  - (b), control: the a95768b7 spec in both arms.

| | (b) control: a95768b7 spec in both arms | (a) primary: each arm on its own spec |
|---|---|---|
| packet answered | 93.5 → 93.5 / 138 | 93.5 → 99.5 / 138 (67.8% → 72.1%) |
| packet bytes, median | 79,737.5 → 79,737.5 B | 79,737.5 → 91,611.5 B |
| packet calls, median / total | 8 / 536 → 8 / 536 | 8 / 536 → 9 / 588 |
| frame | 0 B | 4,526 B in 5 passages (cap 12,000 B) |
| ground rules / copy-deck sections in packet | 0/24, 0/17 | 24/24, 8/17 |
| pull shown one hop out | n/a → 106 / 138 | n/a → 110 / 138 |
| pull bytes, median | n/a → 10,860 B | n/a → 11,180 B |
| copy-deck needs (D49), packet / pull / both | 0/5 → 0/5 / 2/5 / 0/5 | 0/5 → 4/5 / 4/5 / 4/5: not met |

- **C23** (in (a)): 0.5 → 2.5/6. C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark (42% was that
  number rounded).
- **Copy deck.** The "≥ 14 / 17 sections" target was not met (8 / 17), and the needs target that
  replaced it was not met either (4 / 5 per arm).
- **Moved needs** (in (a)): C07 3 → 4, C10 4 → 5, C21 2 → 3, C23 0.5 → 2.5, C24 5 → 6 (+6). None was
  lost.
- **About-bytes.** In (a), the median increase is 5,687.5 B against a95768b7, so it includes spec text
  added before M6. The largest jumps are mostly that text: C02 +182,137 B and C08 +121,197 B. What
  M6's notes cost is the landing card's figure: a median of +5,589 B, largest +31,846 B (C01).
- **Agreement with the landing card.** The card's g rows equal the landing card's, apart from one new
  information-only row.

## After the landing: audit, trial, lanes (2026-10-09/10)

A session audit of three buckets of spec-on sessions and a trial of the tools on real tasks found where
the system cost attention without paying for it: census notes in sessions that edited nothing, census
failures from an untrusted mise shim, `where` hiding results with exit 0, 40 KB `draft check` output,
a merge recovery the docs couldn't complete, claim files that conflicted on parallel promotions, and 48
drafts left behind. Wave 0 measured the agent arm on master bd597e20 as the baseline (pull, answered
97.5 / 99.5 of 138). Each fix then ran as a lane with a builder and a measurer: checks written to fail
first, BEFORE taken on a pristine archive of the base, AFTER on the commit. All eight lanes landed
by 2026-10-10 01:44 (52afd0a8, master reflog). CHANGELOG.md has each lane's numbers.

## Lessons

- **A seam only a trial merge shows.** Rule A and M6 each passed their tests alone. Merged together
  on the work branch, `packet-acceptance.test.mjs`'s real-spec check failed: it asserted that packet's
  prose count equals scope's passage count, and it was 428 against 417. That equality was only the old
  test's assertion; no claim promised it. Rule A carried M6's 11 real `about` notes into packet, as
  rule A intends, and neither branch had had both. 85f4e788 fixed the test: it expects scope's
  passages plus the `about` notes of the claims packet delivers.
  - The gate rule since (D51): a ready-to-merge report requires a trial merge of the current
    integration head plus every other head landing in the same batch, in landing order, with both test
    globs run on that tree.
- **Never merge master into a long-lived work branch.** The work branch merged master once, mid-work,
  to take the current product spec. A later scrub rewrote master's history and removed commits that
  merge had carried in. From then on, the work branch and every branch that had merged it held
  commits master no longer had, so none of them could ever merge to master. The fix was to re-apply
  each later merge, one commit each, on a fresh landing branch cut from the scrubbed master, and
  fast-forward master to it. Master goes into the landing branch only, never into a work branch.
- **Run the full suite with TMPDIR outside any git repository.** The server tests run git in
  temporary directories. With TMPDIR inside a git worktree, git found the enclosing repository instead
  of a fresh one, and the tests wrote commits, branches and worktrees into the real repository. The
  spec and replay test globs are not affected; the full Sova suite is.

## Audit #2: did the 10-09 → 10-12 changes work in real use? (2026-10-18)

A read-only audit of real sessions after the lanes landed: 109 pi worker sessions that changed code
after 10-12 (26 from one team, 21 on a non-Claude model), plus Claude Code workers, against a
corrected 10-09 baseline (the 10-09 method had counted every pi worker as spec-off).

- **What worked.** The where-first guide text (M2b) is the one clean real-use effect: 3+ word `where`
  1/43 → 180/204 in pi workers (54/60 in Claude Code), map-first starts 25/111 → 2/142. Topic search
  alone changed nothing until the guide told agents to use it. Lane A (census on the hook's own node):
  incomplete-census notes 50 in 35 sessions → 0 in 176. Lane F's merge driver worked for the manifest
  only (conflicts 30/146 → 2/78); claims-file conflicts did not fall (8/146 → 10/78). Lane G's
  landed-in line reached most code-writing workers. Single-source tools hold.
- **What didn't show.** The unread-line trim (B2) had no measurable effect on reading: Claude workers
  read 17% of the § named (85/397 before their last reply), with a median of about 110 § behind
  "+N more". Draft cleanup (E) emptied the main tree (48 → 0) but left 56 drafts across worktrees. The
  agree step is used (0 → 195 stamps), but workers stamp `--by user` and no session shows the user
  agreeing; agree before the first code edit in 15 of 34 workers; draft before code flat at 72%. The
  benchmark's −17% bytes is real in the agent arm, but `map` was only 1–8% of real spec bytes.
- **Goals.** G1 not met; G2 mostly met (`where <file>` right on 30/30, 95.7% of source covered, but no
  moved-since-check warning can fire: no record carries a hash); G3 partly (question test 134/144, 0
  wrong; 0 of 87 areas say what they don't own); G4 flat (93.3%); G5 not met on one pilot area (0/11,
  6/11 without one missing export; every failure was something the spec doesn't say, none was it being
  wrong); G6 flat once split by model. Constraints: C4 not met and slowly worse (§ ids in 783 source
  files, 16.8% → 17.9%; 28 dangling); C5 slightly over (upkeep 9.6% of change calls, against ~7%).
- **Proposals** (P1–P10): a reachable unread list; agreement stamped only where the user's go-ahead
  is; a moved-since-check hash; a "doesn't own" line per area; a decision on § ids in source and on
  how much "how" the spec holds; ignored files out of the census; claims-file conflicts; upkeep;
  housekeeping. P7 is built on `feat/spec-x-census` (CHANGELOG 2026-10-18): Sova's whole-tree census
  unclaimed 10,410 → 913 at 9c3f949b, the 9,497 dropped all Git-ignored and the tracked unclaimed set
  unchanged.
- **Method lessons.** Split every session metric by model and by team (one team was 24% of the
  sample; a non-Claude model doubled bytes). Claude Code caps tool output at 30k characters and pi at
  about 50 KB, so bytes don't compare across the 10-13 runtime switch. Counters must ignore quoted note
  text (census notes were over-counted once).


### The audit #2 lanes (2026-10-18, branch `feat/spec-x-integration`, landed on master at a82af2c8 (fast-forward, base f14dbab0))

**P4, what an area does not own (2026-10-18, branch `feat/spec-x-notowned`, landed on master at a82af2c8 (fast-forward, base f14dbab0)).** Audit
#2 found 0/87 areas saying what they don't own (Goal 3's first measure). An area record now carries
`notOwned: [§id]` and `map` prints it: 0/87 → 87/87 on Sova's spec (L0, `map` text, master 9c3f949b
against the branch). The first shape, `{what, owner}` with a phrase in the manifest, was dropped
before it was measured: it put prose in a relations-only manifest and said each thing twice; the map
prints the owner's own heading instead. Printing titles in the overview was dropped too: 78 of 87
areas fitted the 32 KB page, against 87 of 87 with ids only (titles stay in `map '§area'`).
Ids in the overview's JSON lines still pushed `map --json` (32,374 B on master, near its 32,768 B
cap) onto a second page, 71 of 97 lines on the first; the overview JSON now leaves the owners out
and adds one note pointing at `map '§area'`: 32,497 B, one page.
The question arm then showed no subject ran `map` (0/174; master 3/174): agents go where → read → toc.
Putting the line on `read`/`toc` of the area H1 took exposure from 2/174 to 174/174 runs, and every
answer then named the listed owners: exposure is the result. Correctness against code did not move
beyond grader noise: correct answers 135 → 139 of 174 and areas with both reps correct 58 → 64 of 87,
where a reordered regrade of 10 areas agreed with the first grading on 45 of 60 verdicts (75%) and
moved each arm's correct count on them by 3-5 of 20. Most wrong not-own statements come from spec
prose that contradicts code, in every arm. Lesson: a view no agent opens measures as nothing, so
put a fact on the path the mode text sends agents down, and count both text and JSON when checking
who saw it.
On 2026-10-19 (branch `feat/spec-x-integration`, landed on master at a82af2c8 (fast-forward, base f14dbab0)) the overview's JSON was 271 B under the page
(32,497 of 32,768 B). Trimming derivable and default fields, not the `notOwned` count or note, took it to 25,449 B
(22.3% headroom): no `namespace` on area lines (the id names it), `whatSource` only when not prose, and flat label
counts with no zero `unlabelled`. The text form is unchanged at 29,808 B.

**P8, claim-file merges (2026-10-18, branch `feat/spec-x-merge`, landed on master at a82af2c8 (fast-forward, base f14dbab0)).** `merge-claims`
merges a declaration both sides changed block by block (CHANGELOG 2026-10-18 has the numbers). Dropped
before commit, a block merge where neighbouring blocks conflict: the first block-by-block `merge-claims`
gave Git's line merge the blocks as lines, so changes to two neighbouring blocks conflicted, as Git does
with neighbouring lines. On the merge replay it left 10 / 56 claim files conflicted (6 merges) against
7 / 56 for the kept version, which puts an unchanged line between blocks. The 3 it added were neighbouring
bullets of one declaration, each a different promise.

**P2, agree traceability (2026-10-18, branch `feat/spec-x-agree`, landed on master at a82af2c8 (fast-forward, base f14dbab0)).** Audit #2 found that 195 agreed stamps had been written by workers as `--by user`, and no session showed the
user agreeing. Two changes, each measured on the L2 agent arm (claude-opus-5-5 medium, 7 tasks × 2 reps, the
parent holding a pre-agreed typed turn):

- `agreed.source`, required by `agree` and set by the runtime (5a0b41c9). Stamps traceable to a typed user
  turn went 0/4 → 15/15. Agree before the first code edit stayed at 0/12: every agree came at wrap-up.
- The mode text's claim step says to agree before the first edit (25a98ee7). Agree before the first code
  edit went 0/12 → 4/12 (95% CI 10-65%), and 4 more runs agreed 2-3 calls after their first edit. Traced
  stamps 17/17; upkeep flat (24.6% → 25.1%). That is below the 80% target: wording alone moves when the
  agent agrees, not whether.

Not measured: the worker relay, and team-injected turns.

Phase 2 measured the relay: workers held the right reference in `SPEC_AGREE_SOURCE` yet typed a description in
`--source`, and 4 of 42 stamps (2 of 3 relay runs) traced to no typed user turn. The lane had dropped refusing a
`--source` that differs from the variable, so a parent could cite an earlier turn; that freedom was what the
workers used. Fixed on 2026-10-19 (branch `feat/spec-x-integration`, landed on master at a82af2c8 (fast-forward, base f14dbab0)): a set variable is the
source, a different `--source` is refused, and a source must be a `scheme:locator` reference, never a
description. L0: 4 new cases fail at 196989b0 and pass after. The L2 relay arm has not been re-run.
An independent review then found two holes, both closed the same day. The relay mistook a session's own
`SPEC_AGREE_SOURCE` for a given reference after an in-process `/reload`; workers are now marked by a variable
only the spawn path writes (`SPEC_AGREE_GIVEN`). The shape check let an invented `pi-session:` reference pass;
such a reference must now resolve to a user message in pi's session files (other schemes stay form-checked
for projects outside pi). L0: 6 new cases fail at 7a5c32d8 and pass after.

**P1, the unread line (2026-10-18, branch `feat/spec-x-unread`, landed on master at a82af2c8 (fast-forward, base f14dbab0)).** Audit #2 found the unread line unreadable: 5 § marked read first, then "+N more" with a median near 100, and
Claude workers read 17% of the marked ones. A lane measured candidate rules on an L1 replay of the audit's 99
worker sessions (93 replayed, census re-run on reconstructed trees; bash-written edits can't be replayed, so
the replayed lists run shorter than the recorded ones) against Opus labels of which landed § mattered (the change
contradicts the passage, or edits the code that carries one of its statements): 62 Claude sessions, 40 dev and 22
held out, labels frozen by hash before any comparison; a second labelling of 14 sessions agreed at Jaccard 0.93.

- **What separates them.** A mattered § lands through a file a median of 3 landed § share; the rest through files
  55 share. The literal score alone caught 39/113 dev mattered § in its 5 read-first; dividing it by that fan-in
  is the one feature that moved the ranking (cap 10: 57 → 63/113 dev).
- **Kept.** Relevance = score ÷ fan-in ÷ ln(passages + 1); up to 10 read first at relevance ≥ 0.036 or a stale
  literal; the rest left to the census command, uncounted (9ec90f28). L1, 62 labelled sessions: mattered caught
  56/148 = 38% → 84/148 = 57% (held-out 17/35 → 25/35); precision flat at 23%; read-first median 5 → 6.5 (max
  10); lines with an empty read-first list 7 → 10 of 69 (3 mattered § on them).
- **Dropped: a cut at 0.1** (184082c0, reverted in 9ec90f28). Precision 24% → 28% on L1 with recall flat (82 vs
  84/146), but it emptied read-first in 7/12 L2 lines (master 3/13) and dropped a § the change contradicted
  (task T1: a 30 s → 40 s timeout, supervision at 0.043).
- **Dropped: lexical variants** (no change committed): dropping plain-word and 2-digit tokens, relative cuts to
  the session's top score, top-3 token weights, per-file sums. None beat score ÷ fan-in by more than 2/113 dev.
- **Dropped: a floor of one** (always mark the top-ranked § when none qualifies): +1/148, empty lines halved,
  but no evidence the extra § mattered.
- **Not met.** ≥90% of mattered § within 10 is out of reach for literal matching: the cap-10 ceiling is 106/113
  dev, and the best rule reaches 57%. A § the change contradicts through a number written `30_000` is never
  `stale`: the number pattern skips digits joined by `_`.

## Records per area (al_6, 2026-10-26: `feat/spec-store` tools, `feat/spec-convert` data)

One `manifest.json` of about 800 KB (793,538 bytes at 27019745, 800,680 when converted) held every record, so most spec branches met in one file. Landing 1
shipped tools that read and write both layouts; landing 2 converted Sova's spec (102 record files beside
their claim files, median 4,967 bytes, largest 33,949) and dropped the manifest merge driver, and new specs
start in format 2. Before, from `tests/bench/merge-collisions.mjs --since 2026-09-23 --until 27019745`
(688 merges): both sides changed the records file in 45%, Git's line merge conflicted in 17%; replayed one
file per area, 15% and 4%, and 29 of the 30 per-area conflicts are one record changed two ways; 27
whole-spec takes; 7.2 re-apply commits a week. Targets (GOALS.md constraint 3): both-sides changes ≤ 15%,
Git conflicts on record files ≤ 5%, re-apply commits halved, whole-spec recoveries 0. Tool latency: about
5 to 10 ms more per call (101 files read instead of one); answers identical.

## Open

- **Records per area, after the conversion.** Run `tests/bench/merge-collisions.mjs --since <conversion
  commit>` at 1 and 2 weeks after landing 2 and record the four numbers above against their targets; if
  both-sides changes or Git conflicts don't move, decide on a revert (`migrate --reverse --write` on a
  fresh branch, restoring the `.gitattributes` line), as GOALS.md requires.

- **Claim-file merges without the driver** (audit #2, P8). Two seams the merge replay found, not
  fixed: Git reads `.gitattributes` from the work tree's side of a merge, so a branch cut before
  lane F's claims line (3 of the 30 replayed merges) gets Git's line merge for its claim files; and
  the drivers run `node` through `PATH`, so an untrusted mise shim fails both drivers and every spec
  file both sides changed conflicts, unmerged and without markers. A per-clone
  `.git/info/attributes` line and a resolved `node` path in the driver lines would close them.

- **The agent arm and the rubric on master.** Deferred: not re-run after landing.
- **Three needs packet answers that toc never shows one hop out.** C01:0 is the frame around the tab,
  and C01:4 is the tab's address; both are in the `§app/shell` lede. C01:2 is "Stop ends the turn", in
  `§chat.composer/behavior`. Neither pre-landing agent arm read them. No agent arm has run on master:
  deferred, not re-run after landing.
- **The frame's cost.** It is paid on every first read: 4,526 B on master's spec.
- **The census-read guard.** Measured in real sessions by audit #2: not met (85/397 named § read,
  Claude workers; parents 0). The agent arm still makes no edits.
