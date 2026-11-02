# Conflicts: judge, then resolve or propose

Sova tells you an entry conflicts with the target and names the files. Nothing has merged; the entry waits. Your job is one judgement per conflict: **does resolving it change what either side does?**

## 1. See both sides
1. `worktree create` a side worktree named `resolve-<entry id>` detached at the target's head (`git rev-parse <target>`); never on the target branch itself.
2. In it: `git merge --no-ff --no-commit <pinned commit>` (the entry's approved commit, never the branch's newer head), as the merge copy does. Git stops on the conflicts.
3. `node <this playbook>/scripts/conflict-hunks.mjs --repo <side worktree>` prints each conflicted hunk: file, lines, the base, ours (the target) and theirs (the branch), with diff3 context.

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
1. Edit each conflicted file to keep both sides, inside the hunks only. Remove every marker.
2. `git add` those files and `git commit --no-edit` in the side worktree. The commit's parents are then the target's commit (first) and the pinned commit (second): exactly what Sova checks (first parent on the target, second the approved commit).
3. Run the cheapest relevant check there if the project has one (typecheck, say): a resolution that doesn't even compile is not "no behaviour change".
4. `merge.resolve {entry, verdict: "no-behaviour-change", files, ours, theirs, proposal, commit: <the side commit>, note}`:
   - `ours`: what the target's side did, in plain words; `theirs`: what the branch's side did;
   - `proposal`: what your resolution does ("keeps both rules in the block; neither changes");
   - `note`: the landing's note, "Resolved a conflict in <files>: <what each side did>; kept both, <why it is safe>."
Sova re-checks the mechanical rule. If it holds, the user's approval carries over and the full checks run on your resolution; if a check then fails, it goes back to the user, not to the branch. If the rule doesn't hold, Sova turns it into behaviour differs and shows your words to the user.

## 3b. Behaviour differs: propose and wait
`merge.resolve {entry, verdict: "behaviour-differs", files, ours, theirs, proposal, commit?}`:
- `ours`: what the target now does, in plain words, one or two sentences ("Master shows the price without tax and adds a tax line below.");
- `theirs`: what the branch wants ("The branch shows the price with tax.");
- `proposal`: what you would do and what it costs ("Keep master's layout and show the branch's total in the tax line; the branch's test of the total needs its expected text updated.");
- `commit`: your proposed resolution in the side worktree, when you made one (optional).
The entry shows "Behaviour differs · waiting for you" with Accept and Send Back. You don't wait for the answer: end your turn.

## Afterwards
Leave the side worktree; Sova or the user removes it. Never merge it anywhere.
