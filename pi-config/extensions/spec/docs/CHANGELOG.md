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
  - **Post-landing agent arm on master 3239c26a: deferred: not re-run after landing.**
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
  - Final comparison of master 3239c26a against a95768b7, computed part (scorecard final-3239c26a):
    - green: 544 tests, 542 pass, 0 fail, 2 allowed skips; 0 guards failed in the primary and control
      scorecards;
    - packet answered 93.5 → 99.5 / 138, packet median 79,737.5 → 91,611.5 B;
    - pull shown 110 / 138; the frame 4,526 B; C23 2.5/6 (41.7%): meets the plan's 2.5/6 benchmark
      (42% was that number rounded);
    - copy-deck needs 4/5 per arm and sections 8 / 17: neither target met.
    - The agent arm and the rubric: deferred: not re-run after landing.

## After the landing

### 2026-10-07

- **Spec noise cut: no closing lines.**
  - Commit: efc64e64 (the promotion), branch `feat/drop-closing-lines`.
  - Changed:
    - replies carry no spec lines: the `Also changes:`, `Plumbing:`, `Deferred:` and `Spec check
      override:` lines, the turn-end check, its re-prompts and toasts, the worker ledger and the spec
      card are gone, in pi sessions, pi workers and Claude Code workers;
    - the guide (`mode/spec-mode.md`) drops the last-line bullet, the one-file-per-tool-call rule and
      the census run by hand while coding; one `census --changed` before finishing stays, and a flag
      is asked as "This also changes §X: <what>. OK?";
    - the `[spec census]` note drops its `Foreign §:` and `Rule:` lines; the merge note keeps
      actionable warnings only;
    - `census.foreignNote` no longer says what a last line names; `promote`'s human output says
      "Foreign § this promotion changes: …" (the JSON keys are unchanged);
    - spec mode no longer relies on a merge round.
  - §: +§tools.spec/no-turn-end-check; −§tools.spec/runtime-accounting; §tools/spec (child added),
    §tools.spec/census-note, §tools.spec/mode-reading, §tools.spec/assessment-observations,
    §chat.merge-round/driver, §chat.merge-round/round, §chat.worktrees/merge-card,
    §chat.sandbox/claude-state, §chat.sandbox/limits reworded.

### 2026-10-08

- **A foreign § is updated, never asked about.**
  - Commit: 529ce1ce (the promotion), branch `feat/spec-auto-foreign`.
  - Changed:
    - the guide (`mode/spec-mode.md`) no longer asks "This also changes §X: <what>. OK?": a change
      that contradicts a foreign § or adds what a user sees there is written into the task's draft
      without asking (the go-ahead covers it, `agreed` records included) and listed as "Also
      updates §X: <what>"; workers list them in their final report;
    - the `touched-foreign`, `child-under-foreign` and `foreign-summary` notes and
      `census.foreignNote` say "update … in your draft without asking, and list it" instead of
      "flag"; the worker brief carries the new sentence;
    - `GOALS.md` says a consequence of the ask is written into the promises it changes without
      asking, and a clash the ask doesn't need is a defect in the code; this serves Goal 1, "a
      settled decision is rarely asked about again";
    - a task's go-ahead is the new agreement for an `agreed` record it changes (`DRAFTS.md`), and
      `PROMOTE.md` asks for each `alsoChanges` § in the reply as "Also updates §X: <what>";
    - align's plan detection skips a trailing "Also updates" line as it does "Also changes:".
  - §: §tools.spec/no-turn-end-check, §tools.spec/agreed-promotion, §chat.mode-menu/workers,
    §app.decisions/asks-user, §chat.worktrees/readiness reworded.

### 2026-10-09

- **Measurement: the agent-arm baseline on master (wave 0).**
  - Commit: none; measured on master bd597e20 (scorecard data in the lane folder `baseline/`).
  - Changed: nothing; this is the baseline the 2026-10-09/10 lanes are compared against.
  - §: none.
  - Numbers: pull arm, all 24 comparisons run twice, `zai/glm-5.3:medium`, prompt `neutral-1`, spec
    pinned a95768b7, the tree's `spec-mode.md`: answered 97.5 / 99.5 of 138; bytes received median
    94,441 / 100,328.5 B (p90 152,032 / 144,899 B); calls median 15 / 15; lost against packet, unshown:
    1 (C01 need 2) in both runs; C23 0 in both runs. Packet (computed, not run): 93.5 / 138.

### 2026-10-10

These came out of a session audit (2026-10-09, three buckets of spec-on sessions) and a tool trial,
split into lanes, each with a builder and a measurer. BEFORE is master bd597e20 unless said otherwise.
The § lists of landed merges are computed by `foreign --base <master before the merge> --head
<merge>`: the merges' first parents are lane branches that had taken master, so the first parent
would list master's changes instead.

- **Quiet hook notes: only the session's own calls count (lane A).**
  - Commit: 1176737d (the promotion), branch `feat/spec-quiet-notes`.
  - Changed:
    - the census hooks (pi and Claude Code) count only changes made during the session's own calls;
      a commit by another process or a worker between calls is silent, and a skipped call no longer
      "reports every change since";
    - the census runs on the hook's own node (`process.execPath`), not the `node` on PATH, so an
      untrusted `mise.toml` no longer breaks it;
    - the incomplete note names the census's stderr error line, "timed out", or the exit code;
    - the write guard (direct writes to `claims/` or `manifest.json`) judges file state: a promote
      through a wrapper script, `git merge` and `git checkout` of committed bytes are silent; `sed -i`
      and an Edit of a current claim are still flagged. The promote receipt gains an optional
      `promotions[].after` hash map; old receipts fall back to the old checks.
  - §: +§tools.spec/write-guard; §tools.spec/census-note reworded; §tools/spec (child added).
  - Numbers (fixture bench, pi | Claude Code): census notes on read-only calls after another
    process commits 1 | 1 → 0 | 0; census failures with an untrusted mise and mise shims first on
    PATH 20/20 | 20/20 → 0/20 | 0/20; direct-write notes for a scripted promote and for a merge
    checkout 1 | 1 → 0 | 0 (guards hold). Audit re-score, zero-edit sessions with notes
    (landing / post1007 / post1008): 6 / 5 / 7 → 1 / 0 / 1.

- **Census: § created in the range are the task's own; the boundary takes in site/ (lane B1).**
  - Merge: 8450314b, branch `feat/spec-census-fixes`.
  - Changed:
    - `census --changed --base` leaves § created in the range out of `census.foreign`, as `foreign
      --base` does; a pre-existing § it touched, or one deleted and re-created, stays foreign;
    - Sova's manifest boundary includes `site/` (excluding `site/pnpm-lock.yaml`);
    - the census timeout was measured, not changed: the "no output" notes were the mise shim
      (fixed in lane A), not timeouts.
  - §: +§tools.spec/census-created; §tools/spec (child added).
  - Numbers: own new claims in `census.foreign` after promote + commit 1 → 0 (this branch, `--base
    bd597e20`: 14 → 13 foreign); changed site files treated as outside 3/3 → 0/3; census p95 at 10 /
    50 / 200 changed files 92–100 → 97–103 ms, 0/120 runs over the 5,000 ms timeout, output
    byte-identical.

- **Honest, short tool output; one merge-conflict recovery (lane C).**
  - Merge: c2211283, branch `feat/spec-tool-output`.
  - Changed:
    - `where --json` names hidden results (`notShown`, a `--token --all` hint, exit 1) and an absent
      path (`file.state: "absent"`, a note, exit 1);
    - `draft check` separates what the draft `introduced` from `preexisting` warnings (counted by
      code); `new` lists files only with `--all` (`fileCount`); `promote` adds
      `warningsIntroduced`;
    - one recovery for a spec conflict a Git merge leaves: `git checkout --no-overlay master --
      .sova/spec/manifest.json .sova/spec/claims`, never `--ours`, then promote the drafts again; the
      `promote` refusal and `PROMOTE.md` say the same words.
  - §: +§tools.spec/draft-output, +§tools.spec/conflict-recovery; §tools.spec/where-lookup,
    §tools/spec reworded.
  - Numbers: `where` results hidden with no signal 2 of 12 → 0; `draft check --json` on the real
    spec with nothing new 43,627 → 1,270 B (text 11,862 → 395 B); `new` 14,295 → 730 B; `promote`
    1,671 → 1,700 B; `check` exit after the documented recovery, branch with its own claims file 2 →
    0.

- **The site's docs boundary (site-docs).**
  - Merge: 5ef88948, branch `feat/spec-site-docs`.
  - Changed: the boundary covers the site's docs only, with 28 excludes, each with a reason; the
    docs frame and chrome get claims.
  - §: +§site.docs/frame, +§site.docs/chrome; §site/docs (child added), §site/landing reworded.
  - Numbers: none measured.

- **Claim files merge per declaration; manifest keys land in claim order (lane F).**
  - Merge: 6f98ff2f (with lane G), branch `feat/spec-claims-merge`; its tool-fake fix f66f1b0e.
  - Changed:
    - new `merge-claims` merge driver for `claims/*.md`, reusing promotion's per-declaration merge;
      the same declaration changed differently on both sides still conflicts, with both sides' prose;
    - new manifest records are placed in claim order, so the manifest is the same whichever draft
      lands first;
    - the hook's conflict note takes the lane C recovery wording, and covers a claims-only conflict.
  - §: +§tools.spec/git-merge; §tools.spec/conflict-recovery, §tools.spec/census-note reworded;
    §tools/spec (child added). Computed together with lane G.
  - Numbers (bench, both merge orders): conflicted claim files 1 / 1 → 0 / 0; merged claims equal
    in-tree promotion no → yes (the hand path took 11 calls); manifest bytes AB vs BA differ →
    identical.

- **Failed calls close their census call; a worker names where it landed (lane G).**
  - Merge: 6f98ff2f, branch `feat/spec-hook-failure`.
  - Changed:
    - Claude Code spec hooks register `PostToolUseFailure` (runs the post-call census) and
      `PermissionDenied` (closes the call); pi closes a call blocked or aborted before running;
    - a finished code-writing worker's completion ends with one line, "Spec: this worker's changes
      landed in §a, §b (+N more)", from its own changes only, and none when it changed nothing.
  - §: +§tools.spec/worker-landed; §tools.spec/census-note, §tools.spec/no-turn-end-check,
    §tools/spec reworded.
  - Numbers (fixture bench): Claude Code failed call then a foreign commit, 1 false note + 1 "No
    draft yet" → 0; pi blocked call 1 → 0; landed line 0 → 1 per code-writing worker, 0 when nothing
    changed (13/13 checks; 8 failed before). Exposure: 71 of 240 Claude Code sessions since 10-08
    had a failed Bash call.

- **The Agree step made real; agreed kept across a meaning change is noted (lane D).**
  - Merge: 2afd0aba ← `feat/spec-agree-step` @ 717dfad7.
  - Changed:
    - new draft command `agree NAME --id §x… --by WHO --verification TEXT [--at ISO] [--write]`:
      creates a missing record from the draft's prose heading, stamps `agreed {by, at}` and
      `authority: accepted`, records doc-only evidence for records with no code, and promotes those
      only when promote's plan is clean (else exit 1 `agree-not-promoted`, nothing written); records
      that map code are stamped only; a second run is a no-op;
    - with align and spec both on, the align call that sets status implementing carries the Agree
      step instruction; `spec-mode.md` gains a one-line pointer to `agree`;
    - `promote` notes `agreed-kept-on-change` (never a refusal) when an agreed record's prose changes
      a number or backticked token while `agreed` stays the same.
  - §: +§tools.spec/agree-command, +§tools.spec/align-agree; §tools.spec/agreed-promotion,
    §tools.spec/mode-reading, §site.docs/spec-mode, §chat.alignment/tool reworded; §tools/spec
    (child added). Base: the previous master tip 6f98ff2f (the first parent is the lane branch).
  - Numbers: agree path 6 → 3 steps (5 → 3 minimal); agreed-kept notes on a 60 → 64 change 0 → 1;
    `agreed` records on master 0 (review 2026-10-24: none means cut `agreed`).

- **Drafts left behind are reported, and only an approved list is pruned (lane E).**
  - Merge: 0134bf2c ← `feat/spec-draft-hygiene` @ 63c03607.
  - Changed:
    - new read-only `drafts [--days N] [--worktrees]`: each draft's age, one state (`landed`,
      `promoted`, `superseded`, `empty`, `old`, `active`, `unreadable`), reasons, a suggested action
      and a hash over `draft.json` and `spec/`; exit 1 when any draft is not `active`;
    - new `prune --approved FILE [--write]`: deletes only the drafts the file names (`NAME [hash]`);
      a missing name, a changed hash or a pending `.txn/` refuses the whole prune;
    - a promotion preview or write carries `staleDrafts` when other drafts are past the age limit;
      `DRAFTS.md` "Drafts left behind" and `PROMOTE.md` say what to do with it.
  - §: +§tools.spec/draft-hygiene; §tools/spec reworded. Base: the previous master tip 2afd0aba
    (the first parent is the lane branch).
  - Numbers: fixture checks 0/4 → 4/4; the main tree's 48 drafts in one read-only call (~21 s):
    promoted 24, superseded 20, landed 2, old 1, unreadable 1 (before: none reported); every Sova
    work tree (`--worktrees`, 255 drafts, 4 min 19 s): landed 18.

- **Ranked finishing census and the unread line (lane B2).**
  - Merge: 52afd0a8 ← `feat/spec-ranked-finish` @ cd8301e7, inside `feat/spec-unread-trim` (869f3141).
  - Changed:
    - `census --changed --related` ranks the foreign § a change touched by its changed lines (names,
      string and number literals from `git diff -U0`, added and removed) and adds `census.rank`,
      `census.readFirst` (≤ 5) and `census.named` (the rest, never dropped); a removed literal a §
      still states is `stale` and ranks that § first;
    - the census hook (pi and Claude Code) adds one line, "Unread § your change landed in: read
      first …; named …", at the first call after the session's last edit, leaving out the § already
      `read`, and says nothing again until an edit changes that set;
    - `spec-mode.md`: the finishing census rule becomes "read each § marked read first; the rest are
      named".
  - §: +§tools.spec/census-rank, +§tools.spec/unread-landed; §tools.spec/census-note,
    §tools.spec/mode-reading, §site.docs/spec-mode reworded; §tools/spec (two children added).
    Base: the previous master tip e4449e4a; computed together with the unread-line trim below.
  - Numbers: trial task (d), a rename: relevant § at ranks 1 and 3 of 25 (unranked before); the read
    first set is 5 § / 28.8 KB, down from 25 § / 116.3 KB. Probe (g), 12 → 16 MB: the § rank 1 of 7,
    flagged stale (before: listed 7th, not flagged). 0 touched § dropped in either.

- **A shorter unread line.**
  - Merge: 52afd0a8 ← `feat/spec-unread-trim`.
  - Changed: the unread line names at most 5 read-first § then "+N more: <the exact census
    command>", and that command lists the rest; `spec-mode.md` says so.
  - §: §tools.spec/unread-landed, §tools.spec/mode-reading reworded. Base: the previous master tip
    e4449e4a; computed together with lane B2 above.
  - Numbers: 25-§ fixture, line 432 → 290 characters; all 25 § still listed by the command.

### 2026-10-11

- **`where` also ranks claims by the words of a topic.**
  - Commit: 1ecd9cf9 (the promotion), branch `feat/spec-search`; master fast-forwarded to 8d26139c.
  - Changed:
    - `where` reads several unquoted words as one query, the same as those words quoted, and beside
      its name and path rows ranks claims and areas by field-weighted BM25 over the heading, the first
      sentence, the backticked names, the prose and the area's heading (`core/topic.mjs`; computed on
      each call, nothing stored); a single argument that is a file keeps the path reading;
    - topic rows are a section of their own: `type: "topic"` lines with `score` and `matched`,
      `counts.topic`, `topicTerms` and a `topicNotice`; name rows keep their top ten and topic rows
      fill only the places left free;
    - a token query with no name match but topic matches exits 0 (was 1);
    - a search bench (`tests/search/`): 52 dev queries from real asks, 48 held-out, a leak check and
      the CLI harness.
  - §: +§tools.spec/where-topic; §tools.spec/where-lookup, §tools/spec reworded. Base: 67d6803b, master
    before the fast-forward.
  - Numbers (search bench, `tests/search/experiments/REPORT.md` and `tests/search/results/REVIEW.md`):
    dev (52 queries) R@3 0% → 59.6%, MRR 0 → 0.532 against the a9b87037 baseline; held-out (48, run
    once at 0b43feb9) R@3 64.6%, MRR 0.552; 110 name and path lookups (80 tokens, 25 `code` paths, 5
    edge cases) identical to a9b87037 on rows, counts and exit, no JSON key lost. Agent A/B with the
    old mode text (GLM 5.3 medium, 24 questions × 2 reps, the same tools in both arms): no measurable
    difference, because agents rarely used it (`map` in every run, `where` nearly always with one
    word): correct 90 of 96 with the old search and 87 with topic search, about 55k tokens per run in both. Hence the mode text change below.

### 2026-10-12

- **Spec mode finds roots with a word search first (M2b).**
  - Commit: 6f33e2ac (the promotion), branch `feat/spec-where-first`; on master since 2026-10-12 11:52
    (fast-forward to a0c9da53).
  - Changed:
    - `mode/spec-mode.md` step 1: find roots with `where` and 3–5 of the task's words, never one, or
      a path or name; if no hit fits, try other words once, then `map` (also for a whole-area task);
      the tools line lists `where <path|name|topic words>` before `map`; the guide's word cap
      834 → 868;
    - the site docs (`modes/spec.md`) and `.sova/spec/USAGE.md` say the same.
  - §: §tools.spec/mode-reading reworded (it now requires §tools.spec/where-topic). Base: 8d26139c.
  - Numbers (agent arm, blind-graded, 36 questions × 2 reps, GLM 5.3 high and DeepSeek Flash 4.1 low,
    the same tools, only the mode text differing): median tokens per run −27% to −37% in all four sets
    (GLM 46.1k → 29.1k and 59.3k → 41.0k; DeepSeek 78.1k → 51.2k and 91.1k → 66.1k); correct 265 / 288
    against 270 / 288 for master's text; wrong answers 2 against 1. The misses cluster on questions
    worded unlike the spec, where a plausible wrong hit replaces the overview the area list gave. A
    titles-only area list (`map --titles`, read once per task beside `where`) was tried and dropped:
    −11 / 288 correct, 3 wrong (ad3a61e3, reverted in 9116abae).
- **The installed extension is the only way to run the spec tools.**
  - Commit: fb07ef5f, branch `feat/spec-single-source`; on master since 2026-10-12 15:18 (fast-forward
    to 41802297).
  - Changed:
    - bundled copies are no longer supported: agents run the tools only from the installed extension
      (`$core`), and a copy inside a project is that project's code, read and never run without asking;
      `README.md`, `docs/MODE.md` and the UPGRADING steps say so;
    - Sova removed its own copy, `.sova/spec/tools/` (it lagged `core/`), with its hash check in
      `.sova/spec/USAGE.md` and the playbook's T-VENDOR and CAN-1 rows.
  - §: none.
  - Upgrade: a project holding a copy of the tools deletes it and runs the installed extension.

### 2026-10-18

- **Whole-tree `census` leaves out what Git ignores (audit #2, P7).**
  - Commit: this entry's, branch `feat/spec-x-census`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - `census` without `--changed`, in a Git work tree, does not count a boundary file Git ignores
      (`git ls-files --others --ignored --exclude-standard --directory`) unless a record's `code` maps
      it; `census.ignored` counts what was left out, with a `census-ignored` note. A tracked file is
      always counted (even one an ignore pattern matches, even inside an ignored directory), and so is
      an untracked file Git does not ignore. Outside Git, when Git cannot answer, or under an
      enclosing repository that ignores the whole project, nothing is left out (`ignored: 0`). No
      project-specific list: the rule is Git's own;
    - `core/README.md` and `.sova/spec/USAGE.md` say so; `tests/census-ignored.test.mjs` is the fixture.
  - §: +§tools.spec/census-ignored (draft `census-ignored`, not yet promoted). Base: 9c3f949b.
  - Numbers: Sova's tree at 9c3f949b (clean, with `site/node_modules`, `site/dist`, `site/.astro`
    present): unclaimed 10,410 → 913, of them 9,497 ignored (9,352 `site/node_modules`, 140
    `site/dist`, 5 `site/.astro`); the 913 are exactly the tracked unclaimed files before (0 untracked
    unignored in that tree); claimed 2,193 and mapped-outside unchanged; ~215 ms either way. Fixture:
    1/5 tests pass on 9c3f949b, 5/5 after.

- **A declaration both sides changed merges block by block (audit #2, P8).**
  - Commit: on branch `feat/spec-x-merge`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - `merge-claims` no longer conflicts on every declaration both sides changed: it merges that
      declaration by blocks (a list item with its wrapped lines, a nested item, a table row, a line of
      a fenced block, a paragraph, a blank line), and conflicts only when both sides changed the same
      block, added blocks at the same place, or one added a block directly before one the other
      changed;
    - such a conflict leaves Git's markers around the whole blocks; before, a declaration changed on
      both sides in lines Git merges cleanly left a conflicted file with no markers at all.
  - §: §tools.spec/git-merge reworded (draft `claims-merge-blocks`, not promoted yet).
  - Numbers (merge replay: the 30 merges since 6f98ff2f whose sides both changed a claim file, 56
    files, each redone in a throwaway clone with each side's own `.gitattributes`; the 5 Claude Code
    sessions with a claims conflict are all among them): conflicted claim files 20 / 56 (11 merges)
    → 7 / 56 (4 merges), against 7 / 56 (5 merges) with Git's line merge alone; conflicts Git's line
    merge doesn't have 13 → 0; files merged cleanly that carry exactly both sides' changes (blank
    lines aside) 36 / 36 → 49 / 49 (Git alone 48 / 49: it drops two of theirs' lines in one). With the
    driver set for every file, 20 / 56 → 6 / 56 (3 merges), each both sides rewriting one bullet or
    paragraph. Tool tests 554 pass, 0 fail.

- **Each area says what it does not own (P4, Goal 3).**
  - Commit: on branch `feat/spec-x-notowned`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - a new optional record field, `notOwned: [§id]` on an area (H1): the claims elsewhere that own
      what a reader might expect the area to own; `[]` says it was looked at. The manifest stays
      relations only: the map prints each owner's own heading. `check` errors on a value that is not
      an array of § ids and warns on `not-owned-not-area`, `not-owned-inside` and a dangling owner;
    - `map` shows a `doesn't own` line under each area's what line (owner ids in the overview, so all
      areas keep fitting one text page; `title (§id)` in `map '§area'`), counts `doesn't own: written
      for k of n area(s)`, and prints `(not written)` for an area without the field once any area in
      view has it; with none, one line says so and nothing else changes;
    - a `notOwned`-only change lands on `--doc-only` evidence like `embeds` and `core`
      (`FIELD_KEYS`), with the same agreed-record and bundling refusals;
    - Sova's spec: all 87 areas carry the field (253 owners), each owner a § the area requires or
      names, whose own code lies outside the area's code list (250 of 253; the other 3 are design
      docs with no code).
  - §: §tools.spec/record-fields, §tools.spec/spec-map, §tools.spec/field-promotion reworded; the
    87 area records gain `notOwned`. Base: 9c3f949b.
  - Numbers: the result is exposure. Areas whose map line says what they don't own 0/87 → 87/87
    (L0, `map` text on master 9c3f949b vs this branch). Question arm (all 87 areas × 2 reps,
    claude-opus-5-5 medium, blind grader on a source-only 9c3f949b), BEFORE / map-only b84d34b9 /
    read-toc c7d9aabe: runs that saw the owners 0 / 2 / 174 of 174; answers citing a listed owner
    149 / 151 / 174. Correctness did not move beyond grader noise: correct (≥1 not-own statement, 0
    wrong) 135 / 132 / 139 of 174 and areas with both reps correct 58 / 59 / 64 of 87, where a
    reordered regrade agreed with the first grading on 45 of 60 verdicts (75%) and shifted the
    correct count by 3-5 of 20 per arm, more than the +4 of 174. 3 of
    c7d9aabe's 41 wrong statements come from a listed owner; 15 areas carry the same wrong statement
    in every arm, from spec prose that contradicts code.
  - Page fit: `map --json` was already 32,374 of its 32,768-byte page on master. With owner ids in
    each overview JSON line it paged (71 of 97 lines on page 1, then a cursor); the overview JSON now
    leaves them out, keeping the count and a `not-owned-per-area` note pointing at `map '§ns/area'`:
    32,497 B, one page. The text map is 29,808 B, one page, 87/87 lines.
    - `read` and `toc` of an area's H1 show the same line, with each owner's title, so it sits where
      agents land (where → read → toc; measure-agent found `map` in 0/174 question-arm runs): one
      line, median 166 B, max 252 B on Sova's spec; an H2 never shows its area's.

- **An agreed stamp says where the go-ahead was given (P2).**
  - Commit: branch `feat/spec-x-agree`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - `agree` stamps `agreed: {by, at, source}`: `source` is `--source <ref>`, else the environment variable
      `SPEC_AGREE_SOURCE`; with neither it refuses (`agree-unsourced`, exit 1) and stamps nothing. A kept
      stamp needs the same `by` and `source`. The text output names the source;
    - `agreed` may carry `source` (an opaque reference, 1-200 characters on one line); promotion refuses a
      new or replaced `agreed` without one (`agreed-unsourced`). An `agreed` current already has, kept,
      needs none;
    - pi side: `mode/spec-agree.ts`. While spec is on, a session that is not a worker sets
      `SPEC_AGREE_SOURCE=pi-session:<session id>#<latest user entry id>` before each tool call, and the
      subagents spawn path passes it to spec-on workers, which relay it and never derive one from their own
      messages;
    - `mode/spec-mode.md`: the agree sentence names the source and says not to stamp without one; the
      guide's word cap goes from 868 to 884. Also updated: `DRAFTS.md`, `PROMOTE.md`, `README.md`, `docs/MODE.md` and the lane-D bench.
  - §: §tools.spec/agree-command, §tools.spec/agreed-promotion reworded; +§tools.spec/agree-source-relay.
    Base: 9c3f949b.
  - Numbers (L0, `.spec-exp/l0.mjs`, 7 fixed fixtures, no model): stamps written by `agree` or landed by
    `promote` that carry a source: 0 / 4 on master 9c3f949b, 4 / 4 after. Unsourced stamps written: 4
    → 0 (the unsourced `agree` and the hand stamp are now refused). A legacy unsourced `agreed` kept on a
    reword still promotes. The L2 agent arm (agree before first code edit, traceable share) is pending.
- **Spec mode agrees at the claim step, before the first code edit (P2, iteration 2).**
  - Commit: 25a98ee7, branch `feat/spec-x-agree`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed: `mode/spec-mode.md` step 4 adds "When the task's go-ahead already agrees to it, run `agree`
    on it then, before that edit, not at the end."; the worker brief carries it (3 sentences of that rule);
    the guide's word cap goes from 884 to 906.
  - §: §tools.spec/mode-reading reworded. Base: 5a0b41c9.
  - Numbers (L2, measure-agent, claude-opus-5-5 medium, 7 tasks × 2 reps, parent-only, outcome grading
    pending): agree before first code edit 0/12 (5a0b41c9) → 4/12 (95% CI 10-65%; 4 more within 2-3 calls
    after it); runs with any `agree --write` 7 → 11 of 14; stamps sourced and resolved to a typed turn
    15/15 → 17/17; upkeep 24.6% → 25.1%. The L2 AFTER for the first entry (5a0b41c9 vs master): sourced
    0/4 → 15/15, agree before code 0/13 → 0/12, upkeep 25.1% → 24.6%.
  - Upgrade: a project that points its agents at `mode/spec-mode.md` gets the new step 4 sentence.

- **The unread line asks for the § the change's lines name, not every § a broad file maps (audit #2 P1).**
  - Commits: f8385574, cc421ef7, 184082c0, 1fcd0871, 9ec90f28 (lane tip), branch `feat/spec-x-unread`;
    landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - `census --changed --related` divides each touched §'s score by its `fanIn` (of its changed files,
      the fewest foreign touched § any one lands in) and ranks by that `relevance`; rank rows and
      foreign `touched` entries carry `fanIn` and `relevance` (score ÷ fanIn ÷ ln(passages + 1), so it
      means the same in any spec size); `readFirst` holds up to 10 at relevance ≥ 0.036 or with a stale
      literal (was: the first 5 with a score or a stale literal, stale first);
    - the hook's line follows it and no longer counts the rest: "read first …; lower-ranked:
      <command>", and "none read first; lower-ranked: <command>" when none qualifies (was "+N more:
      <command>" / "N unread: <command>"), so it asks for the § it names and no others;
    - `README.md`, `core/README.md`, `docs/MODE.md` and the site page say the same. The mode text is
      unchanged.
  - §: §tools.spec/census-rank and §tools.spec/unread-landed reworded (draft `unread-short`). Base: 9c3f949b.
  - Numbers (L1 history replay of the audit's 99 worker sessions, 93 replayed; 62 Claude sessions labelled by
    Opus for which landed § mattered, labels fixed before any rule was compared): § the line asks for, median
    5 → 6.5, at most 10 (it no longer adds "+N more", median 74); mattered § among them 56/148 = 38% →
    84/148 = 57% (held-out 17/35 → 25/35); precision flat at 23%; lines with nothing read first 7 → 10 of 69. `EVOLUTION.md` (the unread line) has the iterations.

- **Spec mode names `notOwned`-only among the doc-only cases (integration fix of `feat/spec-x-notowned`).**
  - Commit: on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0). Base: the merge of the five lane tips.
  - Changed: the notowned lane added `notOwned` to the draft tool's doc-only field keys but not to the
    guide, so `mode/index.test.ts` ("the guide's doc-only cases are the draft tool's") failed on the lane
    tip. `mode/spec-mode.md` now says `` `embeds`/`about`/`core`/`notOwned`-only changes `` (one token,
    word count unchanged at 899 of the 906 cap); the test's rule pattern accepts a mixed-case field name;
    `tests/fixtures/flag-off-master.json` is regenerated (the only difference is that token);
    `pi-config/README.md`'s spec row says the same.
  - §: §tools.spec/mode-reading reworded (draft `notowned-mode`, not promoted yet). Draft `agree-source`
    rewords the same § in another paragraph: whichever promotes second takes the other's text first.
  - Upgrade: a project that points its agents at `mode/spec-mode.md` gets the sentence with this upgrade.

- **A spawn no longer fails when the host's session manager has no branch (integration fix of `feat/spec-x-agree`).**
  - Commit: on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed: `mode/spec-agree.ts`'s `goAheadRef` called `getBranch()` and `getSessionId()` unguarded, so
    `agent_spawn` with spec on threw `session.getBranch is not a function` through a session manager
    without them; two `subagents/tests/run.mjs` tests failed on the lane tip (466/468, master 468/468).
    It now reads them as the rest of `subagents/index.ts` does (`getBranch?.()`), and gives no
    reference when either is missing, so `agree` in that worker is refused (`agree-unsourced`), as
    §tools.spec/agree-source-relay says of a worker given none. `spec-agree.test.ts` pins it.
  - §: none (the draft `agree-source` already covers it).

### 2026-10-19

- **`agree` takes the runtime's reference, and only a reference (fix of the relay defect found in phase 2 of `feat/spec-x-agree`).**
  - Commit: on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed: in phase 2, relay workers held the right go-ahead reference in `SPEC_AGREE_SOURCE` but ran
    `agree --source "<a description>"`, and `agree` took it: 4 of 42 stamps did not trace to a typed user
    turn (2 of 3 relay runs). The mode text offered `--source <ref>` first, and the tool accepted any
    string. Now:
    - while `SPEC_AGREE_SOURCE` is set it is the source; a `--source` that differs is refused
      (`agree-source-mismatch`, exit 1, naming the reference and saying to omit `--source`);
    - a source from either place is a reference, never a description: `scheme:locator` with no spaces
      (`pi-session:<session id>#<entry id>` needs both ids; a URL; `chat:c1#m3`), else
      `agree-source-not-reference`, exit 1; both refusals write nothing;
    - promotion refuses a new or replaced hand-written `agreed` whose `source` is a description
      (`agreed-unsourced`), as it already did one with none;
    - `mode/spec-mode.md`: `` (`$SPEC_AGREE_SOURCE` if set, no `--source`; else `--source <ref>`, never a
      description; else report it ready, never stamp) `` (906 words, the cap); `mode/index.test.ts`'s pin
      and the review-smoke fixture follow; the worker brief quotes no agree source text and is unchanged.
    - DRAFTS.md (two refusal rows), PROMOTE.md, README.md and docs/MODE.md say the same.
  - §: none promoted. Draft `agree-source` rewords §tools.spec/agree-command, §tools.spec/agreed-promotion
    and §tools.spec/agree-source-relay (all already in that draft).
  - Numbers: L0, `tests/agree-command.test.mjs`: 4 new cases fail at 196989b0 (a different `--source`
    with the variable set; descriptions in `--source`; a description in the variable; a hand stamp with a
    description at promotion) and pass after; the accepted cases (variable alone or repeated; a reference
    with no variable) pass on both. Not re-measured on the L2 relay arm.
  - Upgrade: see UPGRADING step 10, "`agree` takes a reference".

- **Tidy-ups after the integration (replay scenario h, stale `agreed` text, the map's placeholder).**
  - Commits: e553d239 and the next commit, on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - replay scenario h's hand stamp carries a reference `source` when the tool's `agree` usage says
      `[--source REF]`, so `h.target.agreed-promoted` covers an agreed, unbuilt record landing again
      (`run.mjs --only h`, master 9c3f949b vs this tree: 1 → 0 before, 1 → 1 after);
    - `agreed: {by, at}` now reads `{by, at, source}` in PROMOTE.md, the draft tool's comment and
      `tests/agreed.test.mjs`; UPGRADING step 3's field table gains `notOwned` and the source;
    - `map`'s help, its `not-owned-per-area` note and core/README write the area argument as
      `'<area §id>'`, a placeholder that can't be read as a spec id (was `§ns/name`, `§ns/area`).
  - §: none promoted. Draft `agree-source` adds `notOwned` to §tools/spec's field list; draft `map-trim`
    quotes the note's new text in §tools.spec/spec-map.

- **`map --json` has room under its one-page cap again.**
  - Commit: on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed: the overview's JSON was 32,497 B of the 32,768 B page on Sova's spec (271 B to spare), so the
    next area or a longer lede would have pushed it to a second page. Its area lines now leave out what is
    derivable or default, and every `labels` count in `map` is flat:
    - `labels` is `{<label value>: n, …}`, authority values then evidence values (they share no name), with
      `unlabelled` only when non-zero (was `{authority: {…}, evidence: {…}, unlabelled: n}`), in the area
      lines, `counts.labels` and the one-area view's counts;
    - an area line has no `namespace` (its id names it; `counts.namespaces` keeps the totals), and
      `whatSource` only when it is not `prose`.
    The text output is byte-identical (29,808 B before and after); the `not-owned-per-area` count and note stay.
  - §: none promoted. Draft `map-trim` rewords §tools.spec/spec-map.
  - Numbers: `map --json --root .` on this branch's spec (87 areas, 1,031 claims): 32,497 B → 25,449 B
    (−7,048 B, −21.7%; headroom 0.8% → 22.3% of 32,768 B). Per field, dropping `namespace` saved about
    1.6 KB, `whatSource: "prose"` 1.7 KB, flat labels with no zero `unlabelled` the rest.
  - Upgrade: see UPGRADING step 10, "`map --json` area lines".

- **A pi-session go-ahead must be a real user message, and only the spawn path makes a worker (review blockers B1, B2 of the agree fix).**
  - Commit: on branch `feat/spec-x-integration`; landed on master at a82af2c8 (fast-forward, base f14dbab0).
  - Changed:
    - B1: `mode/spec-agree.ts` took whatever `SPEC_AGREE_SOURCE` held at module load as a reference it was
      given. The session writes that variable itself before each tool call, and pi re-runs extension modules
      on `/reload` in the same process, so after a reload a top-level session stamped every later `agree`, and
      every worker it spawned, with its old message. The spawn path now also sets `SPEC_AGREE_GIVEN` (the
      reference, or empty for none), which no session writes for itself, and only that makes a process a worker.
    - B2: `agree` checked a reference's shape only. A `pi-session:<session id>#<entry id>` source must now
      resolve: a session file under `$PI_CODING_AGENT_DIR/sessions` (else `~/.pi/agent/sessions`) named
      `…_<session id>.jsonl` or carrying the id in its header, holding that entry as a `message` by the `user`;
      else `agree-source-unresolved` (exit 1), and `agreed-source-unresolved` at the promotion of a
      hand-written stamp. Other schemes stay form-checked, for projects whose go-ahead lives outside pi. A
      worker given no reference (`SPEC_AGREE_GIVEN` empty) refuses any `--source` (`agree-source-not-given`).
    - DRAFTS.md (two refusal rows), PROMOTE.md, README.md and docs/MODE.md say the same. The mode text is unchanged.
  - §: §tools.spec/agree-command, §tools.spec/agreed-promotion and §tools.spec/agree-source-relay reworded (draft `agree-resolve`).
  - Numbers: L0. `mode/spec-agree.test.ts`: 2 new tests fail at 7a5c32d8 (after a cache-busted re-import with
    `SPEC_AGREE_SOURCE=pi-session:s-1#u1` and no `SPEC_AGREE_GIVEN`, `setAgreeSource` over [u1, u2] gave u1, now u2;
    the spawn env helper). `tests/agree-command.test.mjs`: 4 new tests fail at 7a5c32d8 (unresolved
    pi-session refs from `--source` and the variable, among them `pi-session:nope#nope`; resolution by file
    name, header and `PI_CODING_AGENT_DIR`; the worker marker; promotion of an unresolved hand stamp).
    The existing stamps' source on this branch resolves to a user message.
  - Upgrade: see UPGRADING step 10, "`agree` resolves pi-session references".

### 2026-10-22

- **Docs land with the code they describe, with no separate permission.**
  - Commit: on branch `feat/spec-lands-with-code` (folds in the unlanded `feat/promote-before-landing`,
    d202e854); not on master yet: the merge round folds it in.
  - Why: since 42c63467 nobody made a branch's drafts official at landing. Sessions were told their
    go-ahead didn't cover committing and to promote on the default branch after landing; the merge round
    promoted none and removed the worktree, so about 1 in 4 landings since 2026-10-08 left docs
    unpromoted, and sessions asked the user for a second, docs-only merge.
  - Changed:
    - `mode/spec-mode.md`: "A branch isn't done or ready to land until its drafts are promoted on it,
      by you, after its checks pass; nothing at landing promotes for you." The go-ahead paragraph: "A
      go-ahead to build or merge covers committing them with the code, never asked separately; told
      not to commit, leave evidence pending". It names no project's merge process (constraint 1);
      word cap 906 → 944 (942 words). The worker note: the parent promotes on its own branch; a
      worker promotes, commits or records `--commit` evidence only when its brief says to, and then
      only on its brief's branch, never by landing on the default branch;
    - `PROMOTE.md`: the go-ahead covers committing the docs; promote on your own branch before you call
      it ready; a draft whose branch landed without it is promoted on a fresh branch, never on the
      default branch itself; drafts are deleted with `prune --official` or an approved list;
    - `sova-spec-draft.mjs prune --official [--from DIR]`: deletes only drafts the tool confirms are
      already official (own drafts read `promoted`; with `--from`, copies kept outside the project read
      against the current spec alone, every changed record already current); keeps and lists the rest.
      The `git-requires-commit` refusal no longer says "without permission to commit";
    - `worktrees/spec.ts`: a merge into the default branch with the worktree's own drafts unpromoted
      says they didn't land with the code and stay in the worktree's drafts folder until promoted on a
      fresh branch, never on it directly (was "so promote them now"); into another branch, promote
      them on it before it lands;
    - the merge round (Sova's playbook, `round.mjs`): `ask` names drafts not confirmed promoted; a
      `READY` with them left, or a `check` that finds them (`docs not promoted: …`, a need), is handed
      back to the owner with the text to send; a merge of master that conflicts in the spec
      (`claims/*.md`, or a manifest `merge-manifest` refuses) is aborted and handed back to re-promote
      on top of master (was "resolve, commit, then check"); `landed` keeps a copy of drafts not
      confirmed promoted under `<state root>/playbooks/merge-round/drafts/<head>/`, withholds the clean
      up if the copy fails, and prunes earlier copies the draft tool confirms official. The captain
      never promotes; a branch whose owner is gone stays the user's call;
    - GOALS.md gains the rule "Docs land with their code" and a goal-4 measure; the site page says the same.
    - review B1 (c0639814): `drafts` rows list `promotedConflict` (ids the draft promoted before that current
      now says differently; state unchanged). The merge round's hold-back counts them as not promoted, so a
      branch that took master's spec in a conflict without promoting again is handed back, and
      `prune --official` keeps such a draft. §chat.merge-round/driver, §tools.spec/draft-hygiene (draft
      `b1-promoted-conflict`, f8a6f806).
    - A/B B7 (e96c8470): `mode/spec-mode.md` "Before finishing" adds "A draft whose branch already landed is
      promoted on a fresh branch from the default branch, never on the default branch itself." (it was only
      in PROMOTE.md; 1 of 8 runs promoted on master). Word cap 944 → 966 (964 words). §tools.spec/mode-reading
      (draft `landed-draft-fresh-branch`).
  - §: §tools.spec/mode-reading, §tools.spec/no-turn-end-check, §tools.spec/draft-hygiene, §tools/spec,
    §chat.merge-round/round, §chat.merge-round/driver, §chat.worktrees/merge-card,
    §chat.mode-menu/workers reworded (draft `spec-lands-with-code`, promoted on the branch at 005f437f;
    `foreign --base 11459693 --head 005f437f`). Base: 2aa27857.
  - Goal 4 (code and spec agree after building), measured L0: the merge round's tests on master's
    `round.mjs` with this branch's tests: 6 of 38 fail (the hand-back of a READY with drafts left, the
    check need, the spec-conflict hand-back for claims and for a refused manifest, the kept-copy prune,
    the notice wording); 38/38 on this branch. `tests/draft-hygiene.test.mjs`: 3 new tests (the prune
    mode). Constraint 5 (light): the mode text grows 37 words.
  - Upgrade: see UPGRADING step 11.

### 2026-10-26

- **Each area's records may live beside its claim file; every tool reads both layouts** (al_6, landing 1:
  the tools; the conversion of Sova's own spec is a later landing).
  - Commit: on branch `feat/spec-store`; not on master yet.
  - Why: one 787 KB `manifest.json` holds all 1,165 records, so 304 of 678 merges since 2026-09-23 changed
    it on both sides; a merge driver, about 100 re-apply commits and 4 take-master's-whole-spec merges
    followed. With a record list per area, the same replay puts both-sides changes at 98 of 678 (14%) and
    Git conflicts at 30 (from 118). This landing ships the tools only: Sova's spec stays in format 1.
  - Changed:
    - format version 2: `manifest.json` keeps every setting (`grammar`, `boundary`, `_`, …) and
      `"claims": "records live beside each claim file, in claims/**/*.json"` (a string, so an older
      branch's `merge-manifest` driver refuses it and Git reports a conflict instead of merging a format 2
      master quietly); records move to `claims/<path>.json` beside `<path>.md`, placed by id, sorted,
      2-space JSON. Format 1 is unchanged and stays the default (`new` on a project with no spec still
      starts format 1);
    - `core/layout.mjs` (+ `layout.d.mts`) is the one reader and writer of records in both layouts; the
      core, the draft tool, review, assessment, Sova's spec lookup, draft writer and conversation drafts,
      the merge round, the release check (`docs-drift.mjs`) and the simulation's look-up probe go through
      it or through the new read-only `sova-spec.mjs records [--at REV] [--id §x]… --json`; a guard test
      (`tests/layout-guard.test.mjs`, `server/spec-layout-boundary.test.ts`) fails new code that reads the
      records file directly, against an allowlist that only shrinks;
    - a spec holding records both ways is refused by every command (`layout-mixed`, exit 2) with the one
      command that finishes it (`merge-manifest --write` during a merge, else `migrate --write`); new
      format 2 check findings `record-misfiled`, `record-duplicate`, `records-orphaned`,
      `records-unreadable`;
    - `sova-spec-draft.mjs migrate [--reverse] [--drafts | --draft NAME] [--write]`: previews, converts
      under the drafts lock as one journalled write, and refuses unless ids, records, settings and the
      core's check read back the same (it undoes a write that doesn't); drafts keep their old files in
      `.layout-backup/` and `--reverse` restores them while their records match;
    - `merge-manifest`: as a driver, sides in different layouts exit 1 (`layout-mismatch`) and write
      nothing; in index mode a format 2 side, a conflicted record file, or a mixed tree during a merge is
      merged per record from the merge's commits and written in the default branch tip's layout;
    - a spec conflict in a format 2 spec recovers per area (take master's copy of only the clashing areas,
      claim file and record file together, and promote again only those areas), in the draft tool's
      refusals, the census note, the merge round's hand-back and PROMOTE.md; format 1 keeps the whole-spec
      recovery word for word;
    - the census note asks the core whether the spec is mixed each time HEAD moves (once per HEAD); the
      merge round merges master with `--no-commit`, finishes a mixed result with `merge-manifest --write`
      before the merge commit, stages the record files merge-manifest wrote, and aborts the merge (the
      worktree as it was) when the records don't read or the tool gives no answer;
    - `.sova/spec/.gitignore` admits `claims/**/*.json`.
  - §: + §tools.spec/record-layout; §tools.spec/git-merge, §tools.spec/conflict-recovery,
    §tools.spec/census-note, §chat.merge-round/driver reworded, §tools/spec (its new child) (drafts
    `spec-store`, `spec-store-2`, promoted on the branch at 9eca2773, and `spec-store-3` at ede39a14;
    `foreign --base 9b7297f8 --head ede39a14` gives the same list).
  - Numbers: every read command (check, map, map app, graph, where by words and by path, toc out/in/down,
    read, read --whole, scope, impact, impact --near, packet, census, foreign) gives byte-identical JSON on
    Sova's spec at 9b7297f8 in format 1 and converted to format 2 at the same path (17 of 17); `migrate`
    converts it into 101 record files (1,167 records) with every identity check passing, and back.
    Median latency over 15 runs, old core on format 1 → new core on format 1 → new core on format 2:
    check 125 → 132 → 138 ms, map 175 → 180 → 177, where (3 words) 465 → 452 → 474, read 78 → 79 → 86,
    census 131 → 127 → 137. Merge-collision numbers after the conversion: at 1 and 2 weeks after landing 2.
  - Upgrade: see UPGRADING step 12.

- **One rule says whether a draft is official, and Sova and the merge round both call it.**
  - Commit: on branch `feat/landing-dependable`; not on master yet: the merge round folds it in.
  - Why: Sova's readiness called a draft promoted when any promotion wrote its files after its last edit
    (so a catch-up merge that took master's spec read the same as a reword), while `drafts` marked an id in
    conflict whenever any file it sits in had a file-level conflict, so the merge round handed back
    branches whose drafts were official (steer-keys, flow-legibility, owner-page-sova).
  - Changed:
    - `core/official.mjs` (new, Node builtins and `sova-spec.mjs`'s `declarationSpans` only; types in
      `official.d.mts`): `draftOfficial(specDir, draftDir, draftsDir)` compares per claim (a record, a
      declaration's prose, the non-blank lines outside every declaration): official when current says what
      the draft says or what a promotion recorded in the tree wrote, other than what the draft started from,
      or, for prose, its blocks carry the draft's change (as `merge-claims` leaves a claim both sides
      changed). `blocksOf` moved here from `sova-spec-draft.mjs`, which imports it.
    - `promote --write`: each receipt also records `claims` (`{unit: [said, wrote]}`); older receipts count
      what their draft says now, for the ids they name.
    - `drafts`: an id current says differently counts current when the rule calls it official;
      `promotedConflict` keeps only the ones it doesn't. Output shape unchanged.
    - `prune --official --from DIR` reads each copy with the rule (no temp copy of the spec, no `status`);
      `deleted`/`wouldDelete` entries from `--from` no longer carry `draftSha256`.
    - The merge round: `go <branch> [without-specs]` records the user's word as a go-ahead; `landed` tidies
      official drafts out of a worktree whose check passed, after copying them to `tidied/<head>/`.
  - §: §tools.spec/draft-official (+), §tools.spec/draft-hygiene, §chat.worktrees/readiness,
    §chat.worktrees/ready-to-land, §chat.merge-round/round, §chat.merge-round/driver,
    §chat.schedules/merge-ready (draft `landing-dependable`).
  - Goal 4 (code and spec agree after building), measured on the live worktrees: `drafts` on
    `sova-project-page-copies` read 44 ids in `promotedConflict` across 4 drafts (each record and prose
    equal to current, checked by hand on §app.merge-queue/card); with the rule, 0. On `sova-spec-sidebar-scroll`
    (master's spec taken in a catch-up merge, never promoted again) both readings keep its 2 drafts unofficial
    on §app.session-list/content-rules and /search. 62 drafts across Sova's worktrees: about 70 ms each.
  - Upgrade: see UPGRADING step 13.

- **One verdict: `drafts` reports the rule's `official`, and every reader holds on it.**
  - Commit: on branch `feat/landing-dependable`; not on master yet: the merge round folds it in.
  - Why: `drafts` turned the rule into per-id lists and dropped a claim outside any § (a manifest key,
    a claim file's lines outside its declarations), so a draft the rule called not official read with
    nothing pending, and the merge round's check passed what Sova's readiness held (review F1).
  - Changed:
    - `drafts`: each row carries `official` (false for an unreadable draft); its ids sort by the verdict, and
      one made unofficial only outside any § reads `active` with a reason. The default-branch shortcut that
      counted an id current when it was byte-equal on the default branch is gone.
    - `prune --official` reads each folder by the rule directly, in the project as with `--from`: one loop,
      `kept` states `pending`, `empty` or `unreadable`, and no `draftSha256`.
  - §: §tools.spec/draft-official, §tools.spec/draft-hygiene (draft `landing-dependable-2`).
  - Goal 4 (code and spec agree after building): `tests/draft-official.test.mjs` "one verdict" (a draft
    changing only a manifest key, current holding a third value) failed before (`drafts` gave no verdict,
    `pending: []`) and passes after. Tool tests 587 pass, 0 fail.
  - Upgrade: see UPGRADING step 13.

- **Sova's spec keeps each area's records beside its claim file; new specs start that way** (al_6, landing 2:
  the conversion).
  - Commit: on branch `feat/spec-convert`; not on master yet. The conversion is one commit of its own:
    first 516ca52b (`.sova/spec/manifest.json`, 101 new `.sova/spec/claims/**/*.json`, `.gitattributes`).
    Master then moved four times; each merge of master (2bf59cab, 012d7940, 8d463940, then 8d463e94) finished the spec with
    `merge-manifest --write`, which writes the default branch's layout (format 1, with every record master
    had changed: 36, 1, 1, then 9), and each was followed by a fresh conversion; the last, ce9945dd,
    converts the merged spec again: plain `migrate --write` output, `manifest.json` and 102 record files,
    nothing else. ce9945dd is the conversion that lands.
  - Why: landing 1 shipped the tools with Sova's spec still in format 1; this converts it, so two branches
    meet in one record file only when they change the same area.
  - Changed:
    - Sova's spec is format 2 (`migrate --write`): 1,174 records leave `manifest.json` for 102 record files
      beside their claim files; `manifest.json` keeps the settings and the `claims` string;
    - `.gitattributes` drops `.sova/spec/manifest.json merge=sova-spec-manifest` (kept:
      `merge=sova-spec-claims` for `claims/**/*.md`); `manifest.json` and the record files merge with Git's
      line merge. The protection against an older branch's driver stays: its own `.gitattributes` still
      routes `manifest.json` to `merge-manifest`, which refuses format 2's string `claims`, so its merge of
      master stops with a conflict that `merge-manifest --write` finishes, never a quiet merge;
    - `sova-spec-draft.mjs new` in a project with no spec starts format 2 (`{"formatVersion": 2, "claims":
      "records live beside each claim file, in claims/**/*.json"}`), and its first promotion writes format 2;
      an existing spec keeps its format until someone runs `migrate`;
    - `tests/bench/merge-collisions.mjs`: replays a repository's merges (`--since DATE|REV`) and counts, per
      layout period, both-sides changes and Git line-merge conflicts on the record files as they were and
      re-laid one file per area, the same record changed two ways, merges that took one side's whole spec
      (or one area's pair), and re-apply commits per week; it reads history through `layout.mjs`, so it
      spans the cutover;
    - tests that read the real spec's records from `manifest.json` read them through `records` or
      `layout.mjs` (`toc`, `packet-acceptance`, `layout`); `worktrees/spec.test.ts` gains two landings
      across the cutover with nothing to report;
    - docs: `.sova/spec/README.md`, `USAGE.md`, `DRAFTS.md`, `core/README.md`, `spec/README.md`, `MODE.md`,
      the site page.
  - §: §tools.spec/record-layout, §tools.spec/git-merge (both agreed again under the al_6 go-ahead),
    §app.requirements/drafts-with-provenance reworded; §app.requirements/decisions,
    §app.requirements/conversation-drafts, §tools.spec/record-fields: "manifest record" becomes "record"
    (draft `spec-convert`, promoted on the branch at 8c5a9359; `foreign --base 24973451 --head 8c5a9359`
    gives the same list; `foreign` over either conversion alone, 27019745..516ca52b or 8d463e94..ce9945dd,
    gives none).
  - Numbers: the identity check at ce9945dd against its parent, the merge: `records` equal (1,174),
    settings equal but `formatVersion`; `check`, `graph`, `map`, `census`, `where`, `toc`, `read`, `impact`,
    `scope` and `packet` JSON byte-identical before and after; `foreign --base 8d463e94 --head ce9945dd`
    gives `foreign`, `changes` and `created` empty; `git check-ignore` ignores none of the 102 record files
    and `git ls-files` tracks all 102. Every record the merges took from master reads at
    ce9945dd with master's values (`records --at master` against `records`). Size, measured at ce9945dd:
    one `manifest.json` of 802,069 bytes at the merge (793,538 at 27019745, the plan's "787 KB") becomes a
    4,305-byte `manifest.json` and 102 record files (748,352 bytes in all): median 4,967 bytes (between
    `app/server-runtime` 4,908 and `mesh/remote-sessions` 5,025), largest 33,949 bytes (`app/overseer`, 50
    records), then `app/project-overseer` 32,411 and `app/insights` 25,672; an agent editing a draft's
    records edits one of those instead of the whole list. Latency (median of 15 interleaved runs, Node, 27019745's tools on its
    format 1 spec against this branch's tools on the converted spec, both as plain copies, on a loaded
    machine), after `freshOrder` in `layout.mjs` dropped its comparator sort (same order, byte-identical
    output): records +6 ms (+12–17%), all other commands ≤ +7% (check, map, where, read, toc, impact,
    packet, scope, census). This misses the plan's ±10% latency target for `records`; the main thread
    accepted the miss. Merge collisions before the conversion (`merge-collisions.mjs --since 2026-09-23 --until 27019745`,
    688 merges, all format 1): both sides changed the records file in 309 (45%), Git's line merge
    conflicted in 118 (17%); re-laid one file per area, both sides changed one area's file in 100 (15%)
    and Git conflicted in 30 (4%); the same record changed two ways in 29; 27 merges took one side's whole
    spec, dropping the other side's own change, and 7 took one area's pair; 34 re-apply commits in 32.9
    days (7.2 a week). After: at 1 and 2 weeks (`--since <conversion commit>`).
  - Rollback: revert the conversion commit (ce9945dd) to get the format 1 `manifest.json` back byte for
    byte as the merge 8d463e94 left it, and restore the `.gitattributes` line (516ca52b dropped it) in the
    same commit. Once anything has been promoted in format 2, `migrate --reverse --write` on a fresh
    branch rebuilds it instead, with the same records and values and the same identity check, but the ids
    grouped by area rather than in the old file's order; restore the `.gitattributes` line in that commit.
    The tools read both layouts, so neither needs a tool change.
  - Upgrade: see UPGRADING step 14.

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

1. **Install the extension.** Run `pi-config/install.sh`; agents run the tools from `$core`, never
   from a copy inside the project. A project still holding a copy deletes it. The entrypoints load
   sibling modules, all in `core/`:

   | Module | Role |
   |---|---|
   | `sova-spec.mjs` | Read-only core: `check`, `census`, `foreign`, `scope`, `impact`, `packet` |
   | `packet.mjs` | Packet paging |
   | `toc.mjs`, `read.mjs` | The pull path |
   | `map.mjs`, `where.mjs`, `topic.mjs`, `graph.mjs` | The look views and `impact --near`; `topic.mjs` ranks `where`'s topic rows |
   | `fields.mjs` | The optional record fields and the frame |
   | `official.mjs` | The one rule for whether a draft is official (`drafts`, `prune --official`, a host's own readiness) |
   | `sova-spec-draft.mjs` | Drafts, evidence, promotion, `merge-manifest`, `merge-claims` |
   | `sova-spec-review.mjs` | The review companion |
   | `sova-spec-assess.mjs` | The assessment companion |

2. **Set up the merge drivers, once per clone.** Add these two lines to `.gitattributes`:

   ```
   .sova/spec/manifest.json merge=sova-spec-manifest
   .sova/spec/claims/**/*.md merge=sova-spec-claims
   ```

   then:

   ```sh
   git config merge.sova-spec-manifest.driver \
     'node <tools dir>/sova-spec-draft.mjs merge-manifest --root . --base %O --ours %A --theirs %B --write'
   git config merge.sova-spec-claims.driver \
     'node <tools dir>/sova-spec-draft.mjs merge-claims --root . --base %O --ours %A --theirs %B --path %P --write'
   ```

   A format 2 spec (step 14; every spec started since then) adds only the `claims/**/*.md` line and
   the `merge-claims` driver: its `manifest.json` and record files take Git's line merge.
   Two branches that change different records, or different declarations of one claim file, then
   merge without a conflict, and the result doesn't depend on which landed first. One record or one
   declaration changed differently on both sides still stops; a claim file keeps Git's conflict
   markers with both sides' prose. A clone without the drivers gets Git's line merge, as before.
3. **Optional record fields.** A project may add any of these:

   | Field | On | Means |
   |---|---|---|
   | `embeds: [§id]` | any record | surfaces drawn inside it, read whole |
   | `core: true` | any record | part of the always-on frame |
   | `about: [§id]` | notes | the claim a note serves |
   | `notOwned: [§id]` | areas (H1s) | the claims elsewhere that own what a reader might look for in it |
   | `agreed: {by, at, source}` | behaviors and surfaces | who decided, when, and where the go-ahead was given (`source`, a reference; required on a new stamp since the 2026-10-18 round) |

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
7. **No closing lines.** Replies no longer end with an `Also changes:` line and nothing checks one;
   `census.foreignNote` no longer mentions it. Drop the line from your own agent instructions.
8. **The 2026-10-10 round.** Copy every `core/*.mjs` again (step 1), then:
   - **The claims merge driver.** Add the `claims/**/*.md merge=sova-spec-claims` line to
     `.gitattributes` and run its `git config` once per clone (step 2). A clone with only the manifest
     driver still gets Git's line merge for claim files.
   - **New and changed output.** `where --json` gives `notShown` and a `--token --all` hint when it
     hides results, and `file.state: "absent"` for a path that isn't a file; both exit 1 (was 0).
     `draft check` splits `introduced` from `preexisting`; `new` lists files only with `--all`.
     `census --changed --base` leaves out § created in the range.
   - **New commands** (lanes D, E and B2, now on master): `drafts [--days N] [--worktrees]` and `prune
     --approved FILE [--write]`; `agree NAME --id §x… --by WHO --verification TEXT [--write]`;
     `census --changed --related` gives `census.rank`, `census.readFirst` and `census.named`.
   - **Hooks.** The census hooks count only the session's own calls: changes made between calls,
     a worker's included, are silent. They run the census on their own node, and a Claude Code
     worker's settings register `PostToolUseFailure` and `PermissionDenied`. The hook's unread
     line ("Unread § your change landed in: read first …", then "+N more:" and the census command
     that lists the rest) replaces the finishing
     census run by hand; update your agent instructions to read the § marked read first.
   - **Merge recovery.** A spec conflict a Git merge leaves is resolved one way only: `git checkout
     --no-overlay <default branch> -- .sova/spec/manifest.json .sova/spec/claims`, never `--ours`,
     then promote the branch's drafts again (`PROMOTE.md`).
9. **The 2026-10-11/12 round.** Copy every `core/*.mjs` again (step 1), `topic.mjs` included, then:
   - **`where` takes a topic.** Several unquoted words are one query (the same as quoted), and the
     answer adds ranked topic rows in their own section: `type: "topic"` lines (`score`,
     `matched`), `counts.topic`, `topicTerms` and `topicNotice`. Name and path rows, their counts
     and their exits are unchanged, except that a token query with no name match but topic matches
     now exits 0 (was 1).
   - **The mode text.** Step 1 of `mode/spec-mode.md` now finds roots with a multi-word `where`
     first, tries other words once, then `map`. A project that points its agents at
     `mode/spec-mode.md` gets it with this upgrade.
10. **The 2026-10-18 round** (branches `feat/spec-x-census`, `feat/spec-x-merge`,
    `feat/spec-x-notowned`, `feat/spec-x-agree` and `feat/spec-x-unread`, landed on master at a82af2c8, fast-forward, base
    f14dbab0). Copy every `core/*.mjs` again (step 1), then:
    - **Census** (`feat/spec-x-census`). Whole-tree `census` in a Git work tree leaves out what Git
      ignores and reports it as `census.ignored` with a `census-ignored` note; tracked files always
      count. Nothing to configure.
    - **Claims merge** (`feat/spec-x-merge`). The merge driver lines don't change. Two branches that
      changed different bullets, rows or paragraphs of one declaration now merge cleanly. A claim
      file still in conflict has Git's markers around the whole blocks both sides changed.
    - **`notOwned`** (`feat/spec-x-notowned`). Changed output: `map` prints one new line, `doesn't
      own: no area here carries notOwned`, until an area record carries `notOwned: [§id]`; then each
      area gets a `doesn't own` line and the JSON `counts.notOwned`, and `read`/`toc` of that area's
      H1 print the line (`notOwned` in JSON). Nothing else changes. To adopt it, add `notOwned` to
      each area's record in a draft and promote it on `--doc-only` evidence (`--commit` or
      `--snapshot` for an agreed record that maps code). The mode text names `notOwned`-only among the
      doc-only cases.
    - **`agree` needs a source** (`feat/spec-x-agree`). Pass `--source <ref>`, a reference to where the person agreed (a
      message, a review comment, a meeting note), or have the agent's runtime set `SPEC_AGREE_SOURCE`. Without
      either, `agree` exits 1 (`agree-unsourced`) and writes nothing. Scripts that call `agree` must add
      one.
    - **Promotion refuses a new unsourced `agreed`** (`agreed-unsourced`). Stamps already in your current
      spec stay valid as they are; an unpromoted draft holding a hand-written or older `agree` stamp is
      restamped with `agree --source …` before it promotes.
    - **The mode text.** A project that points its agents at `mode/spec-mode.md` gets the changed agree
      sentence with this upgrade.
    - **`agree` takes a reference** (`feat/spec-x-integration`, 2026-10-19). A source is
      `scheme:locator` with no spaces (a URL, `chat:c1#m3`, `pi-session:<session id>#<entry id>`); a
      description is refused (`agree-source-not-reference`), at promotion too for a hand-written stamp. While
      `SPEC_AGREE_SOURCE` is set, omit `--source`: a different one is refused (`agree-source-mismatch`).
      Scripts passing a free-text `--source` change it to a reference.
    - **`agree` resolves pi-session references** (`feat/spec-x-integration`, 2026-10-19). A
      `pi-session:` source must name a user message in a session file under `$PI_CODING_AGENT_DIR/sessions`
      (`agree-source-unresolved`, `agreed-source-unresolved`); other schemes are form-checked only. A runtime
      that spawns workers sets `SPEC_AGREE_GIVEN` beside `SPEC_AGREE_SOURCE` (empty for none); a worker given
      none refuses `--source` (`agree-source-not-given`).
    - **`map --json` area lines** (`feat/spec-x-integration`, 2026-10-19). `labels` counts are flat
      (`{accepted: 6, reviewed: 4, verified: 2}`; `unlabelled` only when non-zero), area lines drop
      `namespace` (take it from the id) and carry `whatSource` only when it isn't `prose`. A script reading
      `labels.authority`/`labels.evidence` or `namespace` from `map` changes; the text is unchanged.
    - **The unread line** (`feat/spec-x-unread`). `census --changed --related` rank rows gain `fanIn`
      and `relevance` and are ordered by relevance; `readFirst` holds up to 10 (was 5) at relevance ≥
      0.036 or stale. A hook of your own that parses the unread line reads "; lower-ranked: <command>"
      (was "; +N more: <command>") and "none read first; lower-ranked: <command>" (was "N unread:
      <command>"): no count.
11. **The 2026-10-22 mode text** (branch `feat/spec-lands-with-code`). Copy `core/sova-spec-draft.mjs` again
    (step 1). A project that points its agents at `mode/spec-mode.md` gets the new rule: a branch isn't
    done or ready to land until its drafts are promoted on it, and the go-ahead to build or merge covers
    committing them. A merge process of your own that promoted drafts at landing stops doing so; one that
    removed worktrees should keep a copy of their unpromoted drafts first. New: `prune --official [--from
    DIR]` deletes only drafts the tool confirms are already official.
12. **Records beside each claim file** (2026-10-26, branch `feat/spec-store`). Copy every `core/*.mjs` again,
    `layout.mjs` (and `layout.d.mts` for TypeScript callers) included. Nothing else is required: format 1
    specs keep working, byte for byte. To move to per-area records, run `sova-spec-draft.mjs migrate
    --root . --json`, then `--write` (and `--drafts` to convert open drafts) in a tree with `.sova/spec`
    committed, add `!/claims/**/*.json` to `.sova/spec/.gitignore`, and commit `.sova/spec` as one commit.
    Scripts that read records from `manifest.json` switch to `sova-spec.mjs records --json` (or import
    `layout.mjs`). A merge process of your own that runs `merge-manifest --write` on a `manifest.json`
    conflict should also run it on a conflicted `claims/**/*.json`, and stage the `files` it lists.
13. **One rule for official drafts** (branch `feat/landing-dependable`). Copy `core/official.mjs` with the
    tools (step 1). Promotions now record `claims` in their receipt; nothing else changes shape. A merge
    process of your own that judged drafts by `promotedConflict` gets fewer false hand-backs; one that reads
    `draftSha256` from `prune --official --from` reads the name instead. A process that holds work until a
    draft is official reads the `drafts` row's `official`, never its state or lists; `prune --official`
    without `--from` now keeps drafts as `pending`, `empty` or `unreadable`, without `draftSha256`.
14. **New specs start in format 2** (2026-10-26, branch `feat/spec-convert`). Copy
    `core/sova-spec-draft.mjs` again (step 1). Nothing is required of an existing spec: it keeps its
    format until you run `migrate`. A project with no spec now gets format 2 from its first `new`: its
    records go in `claims/<path>.json` beside each claim file, so if `.sova/spec/.gitignore` denies
    everything under `claims/` but `*.md`, add `!/claims/**/*.json`; give it only the `merge-claims` line
    of step 2. Converting an existing spec (step 12): in the same commit, drop any
    `.sova/spec/manifest.json merge=sova-spec-manifest` line from `.gitattributes` and keep the
    `merge=sova-spec-claims` one; branches from before the conversion still carry the old line, so their
    next merge of the default branch stops with a conflict that `merge-manifest --write` finishes. With
    the spec mode on, the census note calls the converted files a direct write to the current spec; they
    are `migrate`'s, so commit them as its `next` says. Instructions of your own that tell agents to edit
    records in `manifest.json` now point at the `.json` beside each claim file.
