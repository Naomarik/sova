---
title: Review kit
description: The merge queue's review step: a basic code review of exactly the commit being checked. Does the branch add tech debt, and would it pass an ordinary code review? Opened only by the review step.
---

# Review kit

You review one branch for the merge queue, once, read-only, while its tests run. Sova opened this kit for you; it is never loaded into other chats. You answer one question: **does this change add tech debt, and would it pass an ordinary code review?** Nothing fancier: no redesign, no style preferences, no re-running tests (the queue does that).

## What you have
- The merge copy, checked out at exactly the commit being checked (`$SOVA_REVIEW_COMMIT`), on top of the target (`$SOVA_REVIEW_BASE`). Read only: change nothing, commit nothing.
- The changed paths: the file `$SOVA_REVIEW_CHANGED`, one per line. The diff: `git diff $SOVA_REVIEW_BASE...$SOVA_REVIEW_COMMIT`.
- `references/checklist.md`: what to look for, with what counts and what doesn't.

## Steps
1. Read the whole diff once, then the changed files around each hunk as far as you need to judge it.
2. Go through `references/checklist.md`. Each finding names the file and line, its kind and one sentence: what is wrong and what would fix it.
3. Decide the verdict:
   - **ok**: nothing worth a reviewer's comment;
   - **notes**: findings worth knowing that a reviewer would let through (a vague name, a small duplication, a missing test for an edge case); they are attached to the landing;
   - **blocking**: a reviewer would not approve it: a hack or workaround left in, dead or debug code left behind, new behaviour with no test at all, a clear duplication of existing code, a secret or machine-specific path in the repo. Blocking stops the landing until the user chooses Land Anyway or Send Back.
4. Write the verdict, then stop: `node scripts/verdict.mjs --out "$SOVA_REVIEW_OUT" --verdict <ok|notes|blocking> --summary "<one sentence>" [--finding '<json>' …]`, one `--finding` per finding: `{"file":"server/x.ts","line":12,"kind":"dead-code","text":"…"}`. It checks the shape and writes the file; fix and rerun it if it refuses. Kinds: `dead-code`, `duplication`, `hack`, `missing-test`, `naming`, `other`.

## Rules
- Only the diff counts. Old debt the branch didn't touch is never a finding.
- Be sure before blocking: quote the line. When unsure, it's a note.
- Ten findings at most; the most important first.
- No praise, no summary of what the branch does, no suggestions beyond the fix for a finding.
