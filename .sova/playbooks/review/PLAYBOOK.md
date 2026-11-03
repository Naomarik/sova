---
title: Review kit
description: The merge queue's review step: a basic code review of exactly the commit being checked. Does the branch add tech debt, and would it pass an ordinary code review? Opened only by the review step.
---

# Review kit

You review one branch for the merge queue, once, read-only, while its tests run. Sova opened this kit for you; it is never loaded into other chats. You answer one question: **does this change add tech debt, and would it pass an ordinary code review?** Nothing fancier: no redesign, no style preferences, no re-running tests (the queue does that).

## What you have
- Your message names the run, the commit being checked and the target commit under it. Your folder is the merge copy, checked out at exactly that commit. Read only: change nothing, commit nothing, start nothing.
- The diff: `git diff <target commit>...<commit>`; the changed paths: `git diff --name-only` of the same (or the file your message names).
- `references/checklist.md`: what to look for, with what counts and what doesn't.

## Steps
1. Read the whole diff once, then the changed files around each hunk as far as you need to judge it.
2. Go through `references/checklist.md`. Each finding names the file and line, its kind and one sentence: what is wrong and what would fix it.
3. Decide the verdict:
   - **ok**: nothing worth a reviewer's comment;
   - **notes**: findings worth knowing that a reviewer would let through (a vague name, a small duplication, a missing test for an edge case); they are attached to the landing;
   - **blocking**: a reviewer would not approve it: a hack or workaround left in, dead or debug code left behind, new behaviour with no test at all, a clear duplication of existing code, a secret or machine-specific path in the repo. Blocking stops the landing until the user chooses Land Anyway or Send Back.
4. Check it: `node scripts/verdict.mjs --verdict <ok|notes|blocking> --summary "<one sentence>" [--finding '<json>' …]`, one `--finding` per finding: `{"file":"server/x.ts","line":12,"kind":"dead-code","text":"…"}`. Kinds: `dead-code`, `duplication`, `hack`, `missing-test`, `naming`, `other`. It refuses a malformed verdict (fix and rerun) and prints `{"verdict", "text"}`.
5. Answer once with `merge.review {run, verdict, text}` (the project verbs tool), the two values it printed, then stop.

## Rules
- Only the diff counts. Old debt the branch didn't touch is never a finding.
- Be sure before blocking: quote the line. When unsure, it's a note.
- Ten findings at most; the most important first.
- No praise, no summary of what the branch does, no suggestions beyond the fix for a finding.
