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
  - Branch: `feat/spec-agree-step` (master commit filled in when it lands).
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
    (child added).
  - Numbers: agree path 6 → 3 steps (5 → 3 minimal); agreed-kept notes on a 60 → 64 change 0 → 1;
    `agreed` records on master 0 (review 2026-10-24: none means cut `agreed`).

- **Drafts left behind are reported, and only an approved list is pruned (lane E).**
  - Branch: `feat/spec-draft-hygiene` (master commit filled in when it lands).
  - Changed:
    - new read-only `drafts [--days N] [--worktrees]`: each draft's age, one state (`landed`,
      `promoted`, `superseded`, `empty`, `old`, `active`, `unreadable`), reasons, a suggested action
      and a hash over `draft.json` and `spec/`; exit 1 when any draft is not `active`;
    - new `prune --approved FILE [--write]`: deletes only the drafts the file names (`NAME [hash]`);
      a missing name, a changed hash or a pending `.txn/` refuses the whole prune;
    - a promotion preview or write carries `staleDrafts` when other drafts are past the age limit;
      `DRAFTS.md` "Drafts left behind" and `PROMOTE.md` say what to do with it.
  - §: +§tools.spec/draft-hygiene; §tools/spec reworded.
  - Numbers: fixture checks 0/4 → 4/4; the main tree's 48 drafts in one read-only call (~21 s):
    promoted 24, superseded 20, landed 2, old 1, unreadable 1 (before: none reported); every Sova
    work tree (`--worktrees`, 255 drafts, 4 min 19 s): landed 18.

- **Ranked finishing census and the unread line (lane B2).**
  - Branch: `feat/spec-ranked-finish` (master commit filled in when it lands).
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
  - Numbers: trial task (d), a rename: relevant § at ranks 1 and 3 of 25 (unranked before); the read
    first set is 5 § / 28.8 KB, down from 25 § / 116.3 KB. Probe (g), 12 → 16 MB: the § rank 1 of 7,
    flagged stale (before: listed 7th, not flagged). 0 touched § dropped in either.

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
   | `sova-spec-draft.mjs` | Drafts, evidence, promotion, `merge-manifest`, `merge-claims` |
   | `sova-spec-review.mjs` | The review companion |
   | `sova-spec-assess.mjs` | The assessment companion |

   Copying only the entrypoints breaks the core at the first `toc`, `read` or `map`. A project that
   vendors under `.sova/spec/tools/` keeps the copies byte-identical to `core/` and treats them as
   foreign code until hashed.
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
   - **New commands** (once lanes D, E and B2 land): `drafts [--days N] [--worktrees]` and `prune
     --approved FILE [--write]`; `agree NAME --id §x… --by WHO --verification TEXT [--write]`;
     `census --changed --related` gives `census.rank`, `census.readFirst` and `census.named`.
   - **Hooks.** The census hooks count only the session's own calls: changes made between calls,
     a worker's included, are silent. They run the census on their own node, and a Claude Code
     worker's settings register `PostToolUseFailure` and `PermissionDenied`. Once B2 lands, the
     hook's unread line ("Unread § your change landed in: read first …") replaces the finishing
     census run by hand; update your agent instructions to read the § marked read first.
   - **Merge recovery.** A spec conflict a Git merge leaves is resolved one way only: `git checkout
     --no-overlay <default branch> -- .sova/spec/manifest.json .sova/spec/claims`, never `--ours`,
     then promote the branch's drafts again (`PROMOTE.md`).
