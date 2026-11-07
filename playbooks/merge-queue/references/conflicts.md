# Conflicts: judge, then resolve or propose

Sova tells you an entry conflicts with the target and names the files. Nothing has merged; the entry waits. Your job is one judgement per conflict, one of three: **no behaviour change** (you resolve it), **the chat fixes it** (you can't resolve it safely, but it needs no decision of the user's), or **the user decides** (the two sides want different behaviour: `PLAYBOOK.md`, "What is the user's").

## 1. See both sides
1. Sova's Conflict message names the scratch copy it made for this entry: a worktree with no branch, at the target's head. Work there and only there. Never make a worktree yourself (`worktree create`, `git worktree add`) and never make a branch in the copy: Sova keeps it out of every branch list and removes it when the attempt ends.
2. In it: `git merge --no-ff --no-commit <pinned commit>` (the entry's approved commit, never the branch's newer head), as the merge copy does. Git stops on the conflicts.
3. `node <this playbook>/scripts/conflict-hunks.mjs --repo <scratch copy>` prints each conflicted hunk: file, lines, the base, ours (the target) and theirs (the branch), with diff3 context.

When the message says Sova couldn't make a scratch copy, or you can't write in it, judge from `git diff` alone and answer with no commit: `chat-fixes` when it needs no decision of the user's, else `needs-user`.

## 2. Judge each hunk
**No behaviour change** (resolve it yourself) when every hunk is one of these:
- neighbouring edits: both sides changed lines next to each other, neither touches the other's lines;
- internal text: both sides reworded the same code comment, or renamed the same identifier, internal name or test differently: no person using the product sees it; keep the branch's wording;
- imports or exports: both sides added names to the same import list;
- formatting: one side reformatted lines the other edited, the code is the same;
- both sides extend a list, a table, a union or a set of cases with different items, and the order carries no meaning;
- a moved block one side edited in place: the edit applies unchanged at the new place.

**The chat fixes it** when you can't resolve it within the hunks but the outcome is not the user's to choose: a lockfile or a regenerated file, a recorded test output, a compile fix after a rename on the target, both sides' tests needing their expected text merged, anything that needs more than the conflict hunks.

**Behaviour differs** (the user decides) when any hunk is, and the difference is one the user would see or that changes an agreed promise:
- both sides changed the same value, condition, user-facing text or call differently (a code comment, an identifier or a test name both sides reworded is not behaviour: resolve it, keeping the branch's);
- one side deleted or renamed what the other changed or now relies on;
- an ordered list where both inserted at one spot and the order matters (middleware, rules, first match wins);
- anything you can't explain in one sentence as "both changes survive unchanged".

A resolution must also pass Sova's mechanical rule: the result differs from the plain merge only inside the conflict hunks; no file mode, rename, binary or delete changes. If your resolution needs any of those, it isn't "no behaviour change": rule `chat-fixes`, or `needs-user` when the sides want different behaviour.

## 3a. No behaviour change: resolve
1. Edit each conflicted file to keep both sides, inside the hunks only. Remove every marker.
2. `git add` those files and `git commit --no-edit` in the scratch copy. The commit's parents are then the target's commit (first) and the pinned commit (second): exactly what Sova checks (first parent on the target, second the approved commit).
3. Run the cheapest relevant check there if the project has one (typecheck, say): a resolution that doesn't even compile is not "no behaviour change".
4. `merge.resolve {entry, verdict: "no-behaviour-change", files, ours, theirs, proposal, commit: <the scratch copy's commit>}`:
   - `ours`: what the target's side did, in plain words; `theirs`: what the branch's side did;
   - `proposal`: what your resolution does and why it is safe ("keeps both rules in the block; neither changes"). Sova shows it on the landing as "Resolved a conflict in <files>: <proposal>", so pass no `note` here: a second note would repeat it. Add a note later only for something else worth noting.
Sova re-checks the mechanical rule. If it holds, the user's approval carries over and the full checks run on your resolution. If a check then fails, the branch isn't blamed and nothing goes to its chat: Sova tells you ("Your resolution failed") with a fresh scratch copy, and you rule again: another resolution, `chat-fixes`, or `needs-user`. If the rule doesn't hold, Sova makes it the user's decision and shows your words to them.

## 3b. The chat fixes it
`merge.resolve {entry, verdict: "chat-fixes", files, ours, theirs, proposal}`:
- `ours` / `theirs`: both sides in plain words, as below;
- `proposal`: your diagnosis for the chat: what conflicts, what each side needs to keep, what to change ("Merge master, keep master's renamed `loadUser` and move the branch's new call to it; regenerate the lockfile").
Sova sends it to the branch's chat by itself with the conflicting files as they are on the newest target. The user's Land stands; the chat's fix comes back to you to check (Fix). No commit of yours is kept for it. End your turn.

## 3c. Behaviour differs: the user decides
`merge.resolve {entry, verdict: "needs-user", files, ours, theirs, proposal, text, choices, commit?}`:
- `ours`: what the target now does, in plain words, one or two sentences ("Master shows the price without tax and adds a tax line below.");
- `theirs`: what the branch wants ("The branch shows the price with tax.");
- `proposal`: what you would do and what it costs ("Keep master's layout and show the branch's total in the tax line; the branch's test of the total needs its expected text updated.");
- `text`: the question for the user ("Should the price show with tax, as the branch does, or without, as master does?"); `choices`: two to four short answers, each one the user could send as it is;
- `commit`: your proposed resolution in the scratch copy, when you made one (optional): it lets the user Accept it.
The entry waits for the user as one decision on the branch's card: Accept (your commit), their answer in the chat's message box (it goes to the chat with Sova's note, and the chat resolves it their way), or Remove from Queue. You don't wait for the answer: end your turn.

## Afterwards
Leave the scratch copy as it is. Sova keeps your resolution commit until the run uses it, and removes the copy and the commit's hold when the attempt ends (it lands, is sent back, is cancelled or is approved again). Never merge it anywhere.
