# Fixes, drafts and the chat's answers

The user pressed Land once. Each request Sova sends the branch's chat (a failure, a conflict, review findings, drafts that don't fit) carries your diagnosis. Drafts the chat changed on its own, unasked, are never yours to check: they wait for the user, and the chat answers it one of three ways: **Fixed**, **Needs you** or **Can't**. Its fix lands on the user's same Land only once you checked it. A fix you can't check yet waits for you: it never lands unchecked and never goes to the user for that.

## Fix (the chat answered Fixed)
Sova's message names the request, what it asked, and what the chat changed: a commit, its spec drafts, or both.
1. Read what the fix changes: `git range-diff <base> <the entry's commit> <the fix's commit>` in the project, with the base Sova's message names (a rebased branch then shows only what the fix changed), and `git diff <base>...<the fix's commit>` for the whole branch; for drafts, the branch's `.sova/spec/drafts/` against the request.
2. Judge two things:
   - **Does it change only what was asked?** Fixing the failing test, the compile error, the conflict, the finding, making the drafts fit: yes. A new feature, a refactor beyond the fix, a changed promise: no.
   - **Does it decide something that is the user's?** (`PLAYBOOK.md`, "What is the user's".) A fix that is exactly what was asked can still settle a choice that is theirs: wording a person sees in the product (UI copy, messages, docs they read), layout, controls, defaults, notifications, noticeable timing, data kept or deleted, permissions. A test expecting "Save changes" made to pass by renaming the button "Store" decides the button's wording: that is the user's, even when it was the simplest way to pass. A reworded code comment, a renamed identifier or test is not.
3. Rule, in one call:
   - only what was asked, and nothing of the user's decided: `merge.rule {entry, request, ruling: "checked"}`. Sova puts the entry back in line at the fix's commit (or re-pins its drafts) on the user's same Land;
   - it decides something that is the user's: `merge.rule {entry, ruling: "needs-user", text, choices}`, the question in plain words and the fix's way and the other way as choices. Never `checked` for it;
   - more than was asked: `merge.rule {entry, request, ruling: "beyond", text}`, `text` saying what more it changes. The user decides.

## Can't
The chat says it can't do what was asked, and why. It is yours first:
- you see another way: `merge.rule {entry, ruling: "try-again", text}`, `text` the other approach for the chat (for a conflict you may instead resolve it yourself with `merge.resolve`). One other approach only;
- no other way, or it comes back Can't again: `merge.rule {entry, ruling: "needs-user", text, choices}`: it reaches the user as "can't be settled without you".

## Needs you
The chat raised a decision only the user can make. It waits for the user; you can't overrule it. Nothing is needed; a `merge.note` if it helps the user decide.
