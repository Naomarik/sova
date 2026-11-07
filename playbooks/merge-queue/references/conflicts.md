# Conflicts: judge, then resolve or propose

Sova tells you an entry conflicts with the target and names the files. Nothing has merged; the entry waits. Your job is one judgement per conflict: **does resolving it change what either side does?**

## 1. See both sides
Your sandbox writes nowhere but your temp folder, so you never commit in Sova's scratch copy; you read it, try the merge in a scratch clone of your own, and send the merged files back.
1. Sova's Conflict message names the scratch copy it made for this entry: a worktree with no branch, at the target's head. Read it; never make a worktree yourself (`worktree create`, `git worktree add`).
2. Make your own scratch clone in your temp folder and merge there, as the merge copy does: `git clone --quiet --shared --no-checkout <project root> "$TMPDIR/try-<entry>" && cd "$TMPDIR/try-<entry>" && git checkout --quiet --detach <target's head> && git merge --no-ff --no-commit <pinned commit>` (the entry's approved commit, never the branch's newer head). Git stops on the conflicts.
3. `node <this playbook>/scripts/conflict-hunks.mjs --repo "$TMPDIR/try-<entry>"` prints each conflicted hunk: file, lines, the base, ours (the target) and theirs (the branch), with diff3 context.
4. When you are done with the entry (resolved or proposed), delete the clone: `rm -rf "$TMPDIR/try-<entry>"`. The temp folder is in memory; a clone left there takes it from everything else.

When the message says Sova couldn't make a scratch copy, judge from `git diff` alone and answer `behaviour-differs` with no contents: the user decides.

## 2. Judge each hunk
**No behaviour change** (resolve it yourself) when every hunk is one of these:
- neighbouring edits: both sides changed lines next to each other, neither touches the other's lines;
- imports or exports: both sides added names to the same import list;
- formatting: one side reformatted lines the other edited, the code is the same;
- both sides extend a list, a table, a union or a set of cases with different items, and the order carries no meaning;
- a moved block one side edited in place: the edit applies unchanged at the new place.

**Behaviour differs** (the user decides) when any hunk is:
- both sides changed the same value, condition, text or call differently;
- one side deleted or renamed what the other changed or now relies on;
- an ordered list where both inserted at one spot and the order matters (middleware, rules, first match wins);
- anything you can't explain in one sentence as "both changes survive unchanged".

A resolution must also pass Sova's mechanical rule: the result differs from the plain merge only inside the conflict hunks; no file mode, rename, binary or delete changes. If your resolution needs any of those, it is "behaviour differs".

## 3a. No behaviour change: resolve
1. In your clone, edit each conflicted file to keep both sides, inside the hunks only. Remove every marker.
2. Optional: when the resolution's correctness turns on a test, `merge.test {entry, select}` after resolving runs the project's install and tests in Sova's scratch copy (it holds your resolution once merge.resolve committed it; before that, the target's head). A cheap check in your clone needs its packages, which a clone in the temp folder doesn't have: prefer reading.
3. `merge.resolve {entry, verdict: "no-behaviour-change", files, ours, theirs, proposal, contents: {"<path>": "<the whole merged file>", …}}`, one key per conflicted file, the whole file's text:
   - Sova merges the pinned commit into the scratch copy, writes your files, refuses when a conflicted file is missing or still has markers, and commits the merge there (first parent the target's commit, second the pinned commit). No branch moves;
   - `ours`: what the target's side did, in plain words; `theirs`: what the branch's side did;
   - `proposal`: what your resolution does and why it is safe ("keeps both rules in the block; neither changes"). Sova shows it on the landing as "Resolved a conflict in <files>: <proposal>", so pass no `note` here: a second note would repeat it. Add a note later only for something else worth noting.
Sova re-checks the mechanical rule. If it holds, the user's approval carries over and the full checks run on your resolution; if a check then fails, it goes back to the user, not to the branch. If the rule doesn't hold, Sova turns it into behaviour differs and shows your words to the user. A refusal (a file missing, markers left) says which file: send it again with every conflicted file.

## 3b. Behaviour differs: propose and wait
`merge.resolve {entry, verdict: "behaviour-differs", files, ours, theirs, proposal, commit?}`:
- `ours`: what the target now does, in plain words, one or two sentences ("Master shows the price without tax and adds a tax line below.");
- `theirs`: what the branch wants ("The branch shows the price with tax.");
- `proposal`: what you would do and what it costs ("Keep master's layout and show the branch's total in the tax line; the branch's test of the total needs its expected text updated.");
- `contents`: your proposed resolution's merged files, when you made one (optional); Sova commits it in the scratch copy for the user's Accept.
The entry shows "Behaviour differs · waiting for you" with Accept and Send Back. You don't wait for the answer: end your turn.

## Afterwards
Delete your own clone (`rm -rf "$TMPDIR/try-<entry>"`). Leave Sova's scratch copy as it is: Sova keeps the resolution commit until the run uses it, and removes the copy and the commit's hold when the attempt ends (it lands, is sent back, is cancelled or is approved again). Never merge it anywhere.
