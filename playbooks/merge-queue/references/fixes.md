# Fixes, drafts and the chat's answers

The user pressed Land once. Each request Sova sends the branch's chat (a failure, a conflict, review findings, drafts that don't fit) carries your diagnosis, and the chat answers it one of three ways: **Fixed**, **Needs you** or **Can't**. Its fix lands on the user's same Land only once you checked it. A fix you can't check yet waits for you: it never lands unchecked and never goes to the user for that.

## Fix (the chat answered Fixed)
Sova's message names the request, what it asked, and what the chat changed: a commit, its spec drafts, or both.
1. Read what the fix changes: `git diff <the entry's commit>..<the fix's commit>` in the project (`git log` between them for its commits), and for drafts the branch's `.sova/spec/drafts/` against the request.
2. Judge one thing: **does it change only what was asked?** Fixing the failing test, the compile error, the conflict, the finding, making the drafts fit: yes. A new feature, a refactor beyond the fix, a changed promise, wording the user sees that the request didn't need: no.
3. Rule, in one call:
   - only what was asked: `merge.rule {entry, request, ruling: "checked"}`. Sova puts the entry back in line at the fix's commit (or re-pins its drafts) on the user's same Land;
   - more than was asked: `merge.rule {entry, request, ruling: "beyond", text}`, `text` saying what more it changes. The user decides.

## Drafts changed
The branch's spec drafts changed since the user's Land. Made fit only (the same promises, reworded, moved or relinked so they fit the target): `checked`. A new or changed promise, or an edit the user made: `beyond`, saying which promise; the user decides.

## Can't
The chat says it can't do what was asked, and why. It is yours first:
- you see another way: `merge.rule {entry, ruling: "try-again", text}`, `text` the other approach for the chat (for a conflict you may instead resolve it yourself with `merge.resolve`). One other approach only;
- no other way, or it comes back Can't again: `merge.rule {entry, ruling: "needs-user", text, choices}`: it reaches the user as "can't be settled without you".

## Needs you
The chat raised a decision only the user can make. It waits for the user; you can't overrule it. Nothing is needed; a `merge.note` if it helps the user decide.
