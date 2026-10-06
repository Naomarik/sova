# How the spec system changed: from push to pull

**Status: landed on master 3239c26a; the final comparison is still to run.** Its results go where
this file says **pending (referee-5)**. Until then, those places hold no numbers.

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

**Post-landing agent arm on master 3239c26a: pending (referee-5).**

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
    pull shown 109 → 110. Its C23:0 count rested on the harness's family rule, whose positive test was
    then pending. That test landed in 3239c26a, and the landing card counts the frame's answers with
    it, so the frame figures below are of record.
- **R1** (85f4e788). `toc --dir down` lists the notes about an H1's H2s.
- **Current figures, landing card of record** (landing-3239c26a; candidate 3239c26a, harness as at
  3239c26a). Master's tools on the b1de66b1 record's spec against master's own spec:

  | | b1de66b1 record's spec | master 3239c26a's spec | target |
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
- **Run the full suite with TMPDIR outside any git repository.** Tests that create their own git
  repositories under TMPDIR, run with TMPDIR inside a git worktree, wrote commits and branches into
  the real repository. The spec and replay test globs are not affected; the full Sova suite is.

## Open

- **The final comparison.** Master against a95768b7, with the rubric and the agent arm: **pending
  (referee-5).**
- **Three needs packet answers that toc never shows one hop out.** C01:0 is the frame around the tab,
  and C01:4 is the tab's address; both are in the `§app/shell` lede. C01:2 is "Stop ends the turn", in
  `§chat.composer/behavior`. Neither pre-landing agent arm read them. Their state on master: **pending
  (referee-5).**
- **The frame's cost.** It is paid on every first read: 4,526 B on master's spec.
- **The census-read guard.** "Every `census --changed` claim read" is not measured: the agent arm makes
  no edits.
