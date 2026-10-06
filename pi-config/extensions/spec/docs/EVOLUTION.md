# How the spec system changed: from push to pull

**Status: draft.** It is finished after the final comparison of the whole integration branch against
the baseline. Until then, the "Open" section is live and the last milestones are marked unmerged.

Every hash here is a commit on the integration branch (`feat/spec-integration`) or on the branch a
milestone was built on. "Scorecard" means the replay harness's output for one candidate tree against
the pinned baseline, named by the candidate commit and the harness commit that scored it. Need ids
(`C01:0`) are comparison:need in the harness's data.

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

Each row gives the merge into integration, the branch tip it merged, and what its scorecard measured.

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
| Field-only promotion | 3c41e48b (0a36b781) | A change to `embeds`, `about` or `core` alone lands on doc-only evidence; bundled with any other change it is refused | 368f408a @ 49f66d1a: field-only doc-only target 0 → 1; the bundled case is refused `doc-only-bundled`. |
| M2 spec-mode text | 63a00591 (1d574a1b) | The guide reads by `map`/`where` → `toc` → `impact --near` → `read`, with `--no-frame` after the first read; packet and scope stay for whole chains | Agent arm, all 24, both arms on the same model, text 091a5eb7, regraded at 2be5d3ab (see below). |

The rest are merges of harness updates, follow-ups and docs; see [CHANGELOG.md](CHANGELOG.md).

### M2 in the agent arm

A headless agent answered each comparison twice per arm:
- the packet arm used the baseline tree and its spec-mode text;
- the pull arm used the M2 tree and its text.

The model, the budget and a neutral prompt were the same in both arms. Answers were graded by content
read, not by route.

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

## Tried and rejected

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
- **Rule B for copy-deck notes** (map, ef671fe0). Packet would also carry the notes about every claim of
  the seed's H1 area (that H1 and its H2s), delivered or not.
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
    - Against the b1de66b1 record, slice 1, rule A and rule B together cost a median of +8,984.5 B, with
      9 of the 24 over +12 KB.
  - Measured and rejected. It was tried on rule A's branch and removed before rule A's landing head.

## Rule A and M6 content (merged late, numbers still being recorded)

This section moves until the final comparison. Rule A and M6 merged after this draft began, and their
numbers on the merged tree are recorded with it.

- **Rule A for copy-deck notes** (merged as 31719760 from map @ 2414e554: rule A, toc fixes and the
  core's usage text). Packet adds the notes about any claim it delivers (the whole closure). Before rule A, it
  carried only the notes about the requested claim, its H1 and the surfaces it embeds (M5).
  - Scored on its first head (fb460779) on the M6 candidate spec:
    - copy-deck sections 6 → 8 / 17 in packet;
    - pull unchanged at 6 / 17 shown;
    - packet median 84,169 → 89,538.5 B;
    - the median about-bytes guard holds.
- **M6 content** (merged as 9d74f690 from the content branch @ 888e9a2a). It was first promoted at
  6e858a97; the merged head adds the frame and voice records and follow-ups.
  - These are the records: H1 ledes, `about` notes for the copy deck, code lists.
  - Measured on its first candidate against b1de66b1:
    - packet answered 93.5 → 97.5;
    - needs shown 106 → 108 (target 109, not met);
    - copy-deck sections 0 → 6 / 17 in packet;
    - "what" right on the composer surface 40% → 100%.
  - The first proposed frame (4 core passages, 3,707 B) answered 0 of 138 needs on the slice-1 card's
    harness (e2b64e6b).
  - The frame-voice card (core f6dd02b4 plus voice 79adf90c, harness 0031aea8) measures:
    - C23 1.5 → 2.5/6. C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark (42% was that number
      rounded).
    - Needs answered by the frame 1 → 2.
    - Pull shown 109 → 110.
  - **Not yet of record.** C23:0's frame count rests on the harness's family rule (11a0d180), and that
    rule's positive test is still pending.
- **The copy-deck target (D49).** The original target was ≥ 14 / 17 copy-deck sections. It was **not
  met: 8 / 17**.
  - It was replaced by a needs-based target, because a section count can be satisfied by listing names
    without answering any need. Rule B showed that.
  - The new target names the copy-deck needs in g by id: C07:3, C10:2, C21:2, C24:3, and any need whose
    verdict passage is a copy-deck section.
  - Each must be answered by packet and shown one hop out by pull, with none lost in either arm.
  - The 17-section count stays as information.

## Lessons

- **A seam only a trial merge shows.** Rule A (2414e554) and M6 (888e9a2a) each passed their tests
  alone. Merged into integration (9d74f690), `packet-acceptance.test.mjs`'s real-spec check failed:
  packet's prose count must equal scope's passage count, and it was 428 against 417. Rule A carried
  M6's 11 real `about` notes, which neither branch had alongside the other.
  - The gate rule since (D51): a ready-to-merge report requires a trial merge of the current
    integration head plus every other head landing in the same batch, in landing order, with both test
    globs run on that tree.

## Open

- **Copy deck.** The original ≥ 14 / 17 sections target was not met (8 / 17) and was replaced by the
  needs-based target above (D49). Whether that one is met is recorded on the merged tree.
- **Three needs packet answers that toc never shows one hop out.** C01:0 is the frame around the tab,
  and C01:4 is the tab's address; both are in the `§app/shell` lede. C01:2 is "Stop ends the turn", in
  `§chat.composer/behavior`. Neither agent arm read them.
- **The frame.** The frame-voice card's gain (above) is not of record until the family rule's positive
  test lands. Its cost is paid on every first read.
- **The field-only doc-only wording.** The two exceptions, an agreed record that maps code and `about`
  on a behavior, are stated in DRAFTS.md and §tools.spec/field-promotion (merged as ded67a56
  from addc9796) and mirrored in USAGE.md, the spec READMEs and the acceptance playbook on
  feat/spec-mode-text, not yet merged.
- **The census-read guard.** "Every `census --changed` claim read" is not measured: the agent arm makes
  no edits.
- **The final comparison.** The whole integration branch against a95768b7 is still to run.
