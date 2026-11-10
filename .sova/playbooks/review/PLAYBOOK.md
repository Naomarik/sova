---
title: Review kit
description: The merge queue's review step: a basic code review of exactly the commit being checked. Does the branch add tech debt, and would it pass an ordinary code review? Opened only by the review step.
---

# Review kit

You review one branch for the merge queue, once, read-only, while its tests run. Sova opened this kit for you; it is never loaded into other chats. You answer one question: **does this change add tech debt, and would it pass an ordinary code review?** Nothing fancier: no redesign, no style preferences, no re-running tests (the queue does that).

## What you have
- Your message names the run, the commit being checked and the target commit under it. Your folder is the merge copy, checked out at exactly that commit. Read only: you have no shell and no edit tools; change nothing, run nothing.
- The change, written for you by Sova (your message names both files): the commits and the changed paths, and the whole diff from the target commit. Read the diff in pages if it is long.
- `references/checklist.md`: what to look for, with what counts and what doesn't.

## Steps
1. Read the whole diff once, then the changed files (in your folder, by the paths listed) around each hunk as far as you need to judge it.
2. Go through `references/checklist.md`. Each finding names the file and line, its kind and one sentence: what is wrong and what would fix it.
3. Decide the verdict:
   - **ok**: nothing worth a reviewer's comment;
   - **notes**: findings worth knowing that a reviewer would let through (a vague name, a small duplication, a missing test for an edge case); they are attached to the landing;
   - **blocking**: a reviewer would not approve it: a hack or workaround left in, dead or debug code left behind, new behaviour with no test at all, a clear duplication of existing code, a secret or machine-specific path in the repo. Blocking stops the landing until the user chooses Land Anyway or Send Back.
4. Write the text: a one-sentence summary (at most 300 characters), then one line per finding, `- [kind] file:line: text` (file and line when there is one; text at most 400 characters). Kinds: `dead-code`, `duplication`, `hack`, `missing-test`, `naming`, `other`. ok carries no finding; notes and blocking at least one.
5. Answer once with `merge.review {run, verdict, text}` (the project verbs tool), then stop. Sova checks the verdict's shape and refuses a malformed one, saying what is wrong: fix it and answer again.

## Rules
- Only the diff counts. Old debt the branch didn't touch is never a finding.
- Be sure before blocking: quote the line. When unsure, it's a note.
- Ten findings at most; the most important first.
- No praise, no summary of what the branch does, no suggestions beyond the fix for a finding.
