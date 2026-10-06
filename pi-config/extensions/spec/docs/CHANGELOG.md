# Changelog: the spec system, from a95768b7 to master 3239c26a

One entry per change that reached master, oldest first, from the pinned baseline master `a95768b7`.
[EVOLUTION.md](EVOLUTION.md) tells the story; this file is the ledger. Every hash here is a master
commit, except in the "Integration → master" table and in harness data file names. The work reached
master in two parts:
- **Through 96ab3014.** The work branch `feat/spec-integration` up to 96ab3014 merged onto master as
  83dd1240. Its merges and the branch tips they merged are part of master's history, so the entries
  in "Integration history" keep those hashes.
- **After 96ab3014.** Every later integration merge was re-applied on `feat/spec-landing`, one commit
  each, and master fast-forwarded to it (3239c26a). Those entries cite the master commit. The
  integration merges they came from are not on master; "Integration → master" maps them.

Each entry gives:
- **Merge** or **Commit:** the master commit, and the branch it brought in.
- **§:** the § it changed or created, computed by `sova-spec.mjs foreign --base <first parent>
  --head <commit>` ("+" marks a § created).
- **Numbers:** any numbers it moved, with the scorecard that measured them (candidate @ harness). A
  number marked **pre-landing** was measured on the integration branch, with the harness of the time,
  and was not re-measured on master. Where the landing card of record (scorecard landing-3239c26a,
  harness as at 3239c26a) measured the same thing, its figure is the current one.

## Integration history, through 96ab3014

### 2026-10-05

- **M0, the yardstick.**
  - Merge: 0db6e4cc ← `feat/spec-replay` @ 56c93084.
  - Changed:
    - replay scenarios f and g;
    - the agent-arm runner;
    - the baseline scorecard and its data;
    - `GOALS.md`;
    - `.gitattributes` and the `merge-manifest` driver, documented in `.sova/spec/USAGE.md`.
  - §: none.
  - Numbers: the baseline: g 93.5 / 138, packet median 79,738 B, frontier 143, rubric 63 / 120.
- **M4, span-level promotion.**
  - Merge: 1ff217fa ← `feat/spec-span-promotion` @ 165b2187.
  - Changed: promotion merges three-way per declaration (H1 lede, H2 span, gap).
  - §: +§tools.spec/span-promotion; §tools/spec gains a child.
  - Numbers: hand re-applies 1 → 0; same-spot inserts byte-identical in both orders (8d1491f5 @ 56c93084).
- **M1, `toc` and `read`.**
  - Merge: 0dfa4817 ← `feat/spec-toc` @ c67a1ae2.
  - Changed: the one-hop contents view and the single-passage read, each in its own module.
  - §: +§tools.spec/contents-view, +§tools.spec/single-read; §tools/spec text.
  - Numbers:
    - toc median 9,841 B per comparison against packet's 79,738 B (d65042ae @ 56c93084);
    - shown one hop out 106 / 138 (0e7e5f0c @ 60a12ffc).
- **Harness update.**
  - Merge: 945fc963 ← `feat/spec-replay` @ 31ed5a53.
  - Changed:
    - grading rules and a probe-order fix;
    - M3 and M8 rows;
    - the ratchet floor 106 / 138;
    - the agent arm reads the tree's own spec-mode text.
  - §: none.

### 2026-10-06

- **Harness fix.**
  - Merge: a03caa87 ← `feat/spec-replay` @ c8fa9c3e.
  - Changed: the no-toc check runs on the pinned tree; the sabotage patches fit M5's packet.
  - §: none.
- **M3: `map`, `where`, `impact --near`, `graph --json`.**
  - Merge: 5ebdd5e3 ← `feat/spec-map` @ 9756335c.
  - §: +§tools.spec/graph-payload, +§tools.spec/near-impact, +§tools.spec/spec-map,
    +§tools.spec/where-lookup; §tools/spec text.
  - Numbers: composer frontier 143 → 19; `where --all` 74 / 74 (63813d7a @ c8fa9c3e).
- **M8 draft-tool part.**
  - Merge: 70d6696e ← `feat/spec-agreed` @ 4512c4a5.
  - Changed: `agreed: {by, at}`; an agreed record with no code promotes on doc-only evidence.
  - §: +§tools.spec/agreed-promotion.
  - Numbers: agreed promoted 0 → 1 (043524ae @ c8fa9c3e).
- **M5.**
  - Merge: 3d01a8ba ← `feat/spec-frame` @ b4df7d6f.
  - Changed: the optional `embeds`, `core` and `about` fields; the frame stream (cap 12,000 B); `--no-frame`.
  - §: +§tools.spec/frame, +§tools.spec/record-fields; §tools.spec/contents-view,
    §tools.spec/context-packets and §tools.spec/single-read text.
  - Numbers: f frame 89 B; core and about arrive unasked (b4df7d6f @ c8fa9c3e).
- **M8 follow-up.**
  - Merge: 82d53cf5 ← `feat/spec-agreed` @ 04565abf.
  - Changed: `agreed` names who decided and when, not that anyone read the current words.
  - §: §tools.spec/agreed-promotion text.
- **M5 follow-up.**
  - Merge: 86a36d46 ← `feat/spec-frame` @ 868952cd.
  - Changed: claim wording.
  - §: §tools.spec/frame, §tools.spec/record-fields and §tools.spec/single-read text.
- **M1 fix.**
  - Merge: 4f7f4d3f ← `feat/spec-toc` @ e95409f1.
  - Changed:
    - toc's what is the whole first sentence;
    - a why is clipped around its own target;
    - a thematic break is never a what.
  - §: none.
  - Numbers: whats cut 413 / 800 (70d6696e @ 488b4da3) → 0 / 797 (e95409f1 @ 1873fb86).
- **Harness update.**
  - Merge: fe9fd1a1 ← `feat/spec-replay` @ 05c24054.
  - Changed:
    - what-whole guards;
    - agent-arm grading fixes;
    - a neutral pull prompt;
    - an empty what fails.
  - §: none.
- **M3 follow-up D32.**
  - Merge: 207c80b7 ← `feat/spec-map` @ 0986e979.
  - Changed:
    - near, map and graph read `embeds` and `about`;
    - agreed-not-built counts;
    - no duplicate frontier claim.
  - §: §tools.spec/graph-payload, §tools.spec/near-impact and §tools.spec/spec-map text and record.
- **M8 comment follow-up.**
  - Merge: b1843900 ← `feat/spec-agreed` @ 6c663cbe.
  - Changed: code comments say `agreed` names who decided.
  - §: none.
- **toc/read second batch.**
  - Merge: 8b0cb323 ← `feat/spec-toc` @ f5a22d88.
  - Changed:
    - in/out reach through H1s and follow embeds;
    - unknown dependencies stay unknown;
    - read names code files;
    - agreed display.
  - §: §tools.spec/contents-view, §tools.spec/record-fields and §tools.spec/single-read text.
  - Numbers: impact --near lines 99 → 83 (f5a22d88 @ 3927b08a).
- **Harness update.**
  - Merge: e89db37b ← `feat/spec-replay` @ 3927b08a.
  - Changed:
    - a what ending inside brackets is cut;
    - the agent-arm footer accepts call|read;
    - quoted subcommands are graded.
  - §: none.
- **Frame-empty follow-up.**
  - Merge: 96ab3014 ← `feat/spec-toc` @ cc388538.
  - Changed: `read --frame` says the frame is empty when no record is core.
  - §: §tools.spec/frame text.

## Landing on master, 2026-10-06

- **Integration through 96ab3014.**
  - Merge: 83dd1240 ← `feat/spec-integration` @ 96ab3014, onto master d0bee4d3. 96ab3014 is the work
    branch just before it merged pre-scrub master; it carries none of the commits the scrub removed.
  - Changed: everything in "Integration history" above.
  - §: +§tools.spec/agreed-promotion, +§tools.spec/contents-view, +§tools.spec/frame,
    +§tools.spec/graph-payload, +§tools.spec/near-impact, +§tools.spec/record-fields,
    +§tools.spec/single-read, +§tools.spec/span-promotion, +§tools.spec/spec-map,
    +§tools.spec/where-lookup; §tools.spec/context-packets text; §tools/spec text; §tools/spec gains
    a child.
- **Field-only promotion rule.**
  - Commit: 56d0609b ← `feat/spec-span-promotion`.
  - Changed: an `embeds`/`about`/`core`-only record change lands on doc-only evidence.
  - §: +§tools.spec/field-promotion; §tools/spec gains a child.
  - Numbers: field-only doc-only 0 → 1 (pre-landing). Landing card: the h target is 1.
- **Harness update.**
  - Commit: 3facc0b6 ← `feat/spec-replay`.
  - Changed:
    - field-only rule rows;
    - a copy-deck pull row;
    - the M6 rows' baseline recorded on the spec of the time (the harness data file
      `g-baseline-b1de66b1.json`).
  - §: none.
- **Harness update.**
  - Commit: 792b2578 ← `feat/spec-replay`.
  - Changed:
    - the M6 measurement: per-arm specs, anchored needs, a moved-answer guard, frame and copy-deck rows,
      and the what-sheet;
    - named refusal codes.
  - §: none.
- **M2, the spec-mode reading path.**
  - Commit: 604ff3fb ← `feat/spec-mode-text`.
  - Changed:
    - `spec-mode.md` reads by `map`/`where` → `toc` → `impact --near` → `read`, with `--no-frame` after
      the first read;
    - the worker brief, the census note and USAGE.md follow;
    - the docs agree with the tools.
  - §: +§tools.spec/mode-reading; §tools.spec/context-packets text; §tools/spec text; §tools/spec
    gains a child.
  - Numbers, agent arm on all 24, run 1 / run 2 (pre-landing; not re-measured on master):
    - pull answered 96 / 97.5, agent packet 90 / 89.5;
    - bytes median 98,626 / 107,852.5 against 134,459 / 156,301.
  - **Post-landing agent arm on master 3239c26a: pending (referee-5).**
- **DRAFTS.md summary.**
  - Commit: 9b4a7042 ← `feat/spec-span-promotion`.
  - Changed: the three doc-only routes in the summary.
  - §: none.
- **M2 field-only doc batch.**
  - Commit: 28065b1d ← `feat/spec-mode-text`.
  - Changed:
    - spec-mode names the `embeds`/`about`/`core`-only doc-only case;
    - a test checks the guide's doc-only cases against the draft tool.
  - §: §tools.spec/mode-reading text and record.
- **D43 docs batch.**
  - Commit: 14d1aa6e ← `feat/spec-mode-text`.
  - Changed:
    - the acceptance playbook's rows match the tools;
    - the spec review playbook reads with toc, then read;
    - the docs agree with the tools.
  - §: §tools.spec/review-playbook text and record.
- **Field-promotion wording.**
  - Commit: c7b55e1d ← `feat/spec-span-promotion`.
  - Changed: `embeds`/`core`-only takes doc-only; `about` belongs on notes; an agreed record that maps
    code is refused.
  - §: §tools.spec/field-promotion text.
- **TEST-PLAYBOOK CORE-BUD-5.**
  - Commit: adbcb194 ← `feat/spec-mode-text`.
  - Changed: the row checks page bytes and refuses out-of-range budgets.
  - §: none.
- **Map: rule A.**
  - Commit: 558a816a ← `feat/spec-map`.
  - Changed: packet carries the `about` notes of every claim it delivers; toc why fixes; the core's
    usage text lists every command.
  - §: §tools.spec/contents-view text and record, §tools.spec/context-packets text and record,
    §tools.spec/record-fields text.
- **M6 slice 1, spec content.**
  - Commit: f9069bbb ← `feat/spec-content`.
  - Changed: code lists, `about` links, ledes and whats, the frame with voice, and fixes.
  - §: 73 product § changed and +§chat.model-menu/favorites.
  - Note: with rule A, this broke the real-spec check in `packet-acceptance.test.mjs` (428 against
    417 when first merged). That equality was only the old test's assertion: no claim promised it. Rule
    A carried M6's `about` notes into packet. 85f4e788 fixed the test. See EVOLUTION.md, "Lessons".
- **R1 and the seam fix.**
  - Commit: 85f4e788 ← `feat/spec-map`.
  - Changed:
    - `toc --dir down` lists the notes about an H1's H2s;
    - `packet-acceptance.test.mjs` expects scope's passages plus the `about` notes of the claims packet
      delivers.
  - §: §tools.spec/contents-view text, §tools.spec/record-fields text.
- **Harness update.**
  - Commit: 3239c26a ← `feat/spec-replay`.
  - Changed:
    - the about-growth guard;
    - the blind rubric runner;
    - the C23:0 family-rule test;
    - the D49 copy-deck needs;
    - per-arm spec grading;
    - R1 rows.
  - §: none.
  - Numbers: the landing card of record (landing-3239c26a, harness as at 3239c26a), against a95768b7:
    - packet answered 93.5 → 99.5 / 138 on master's own spec, unchanged at 93.5 on the pinned spec;
    - C23 0.5 → 2.5/6: C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark (42% was that number
      rounded);
    - the frame 4,526 B in 5 passages (cap 12,000);
    - pull shown one hop out 110 / 138 (floor 106);
    - copy-deck needs (D49) 4/5 in packet and 4/5 in pull: not met.
  - **Final comparison of master against a95768b7 (rubric and agent arm): pending (referee-5).**

## Integration → master

The integration merges after 96ab3014 and the master commits that re-applied them. The integration
hashes are not on master; they are listed only to map old references.

| Integration merge | Master commit | What |
|---|---|---|
| b1de66b1 | none | pre-scrub master into integration; master already has its own changes |
| 3c41e48b | 56d0609b | field-only promotion rule |
| 51883b8b | 3facc0b6 | harness update |
| a3bb64ab | 792b2578 | harness update |
| 63a00591 | 604ff3fb | M2 |
| afb105f2 | 9b4a7042 | DRAFTS.md summary |
| 0d019e32 | 28065b1d | M2 field-only doc batch |
| 4d239376 | 14d1aa6e | D43 docs batch |
| ded67a56 | c7b55e1d | field-promotion wording |
| e55553cb | adbcb194 | TEST-PLAYBOOK CORE-BUD-5 |
| 31719760 | 558a816a | map rule A |
| 9d74f690 | f9069bbb | M6 slice 1 |
| c8b27686 | 85f4e788 | R1 and the seam fix |
| 30175581 | 3239c26a | harness update |

## UPGRADING another project

The tools are Node standard library only. Nothing is installed.

1. **Copy every `core/*.mjs`.** Vendor them together. The entrypoints load sibling modules:

   | Module | Role |
   |---|---|
   | `sova-spec.mjs` | Read-only core: `check`, `census`, `foreign`, `scope`, `impact`, `packet` |
   | `packet.mjs` | Packet paging |
   | `toc.mjs`, `read.mjs` | The pull path |
   | `map.mjs`, `where.mjs`, `graph.mjs` | The look views and `impact --near` |
   | `fields.mjs` | The optional record fields and the frame |
   | `sova-spec-draft.mjs` | Drafts, evidence, promotion, `merge-manifest` |
   | `sova-spec-review.mjs` | The review companion |
   | `sova-spec-assess.mjs` | The assessment companion |

   Copying only the entrypoints breaks the core at the first `toc`, `read` or `map`. A project that
   vendors under `.sova/spec/tools/` keeps the copies byte-identical to `core/` and treats them as
   foreign code until hashed.
2. **Set up the manifest merge driver, once per clone.** Add `.sova/spec/manifest.json
   merge=sova-spec-manifest` to `.gitattributes`, then:

   ```sh
   git config merge.sova-spec-manifest.driver \
     'node <tools dir>/sova-spec-draft.mjs merge-manifest --root . --base %O --ours %A --theirs %B --write'
   ```

   Two branches that change different records then merge without a conflict. One record changed
   differently on both sides still stops.
3. **Optional record fields.** A project may add any of these:

   | Field | On | Means |
   |---|---|---|
   | `embeds: [§id]` | any record | surfaces drawn inside it, read whole |
   | `core: true` | any record | part of the always-on frame |
   | `about: [§id]` | notes | the claim a note serves |
   | `agreed: {by, at}` | behaviors and surfaces | who decided and when |

   None is a new kind, label value or top-level key, so an older core loads the same manifest and
   ignores them. A spec with none of them gets the same output it got before. Older draft tools don't
   apply the agreed or field-only promotion rules.
4. **The new commands.** These are read-only:
   - `map [namespace | '<§id>']`
   - `where <path|name> [--token] [--all]`
   - `toc '<§id>' --dir out|in|down|up|mentions`
   - `read '<§id>' [--whole] [--no-frame]`, and `read --frame`
   - `impact '<§id>' --near`
   - `graph --json`
   - `packet --part frame`

   `--budget` applies to scope, packet, toc, read, map, where, impact --near and graph only.
5. **Promotion changes behavior.**
   - It merges per declaration: a conflict is the same declaration, or the gap after one, changed
     differently on both sides.
   - Decisions land on doc-only evidence: notes, sections, agreed records not built yet, and field-only
     changes.

   Re-read `DRAFTS.md` and `PROMOTE.md`.
6. **The mode text.** A project that points its agents at `mode/spec-mode.md` gets the pull reading
   path with this upgrade. Its shell line finds the tools at `<agent dir>/extensions/spec/core`.
