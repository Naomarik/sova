# Failures and pauses: explain them

Sova decides whose failure it is by rerunning: a check that fails with the branch and passes on the target alone, in the same copy, is the branch's; one that also fails on the target is the target's (noted, not blocking); one that passes on a rerun is flaky (noted); setup that fails on the target too is the machine's (retried once, then the queue pauses, nobody blamed). You don't re-decide that. You diagnose it, so the branch's chat (or the user, for a pause) can act at once.

## A failed entry (Failed)
Sova holds the request to the branch's chat for a few minutes for your diagnosis, then sends it without.
1. `merge.logs {run}` for the failed step; read its whole log, not its last line.
2. Find the first real error: the failing test, file and assertion, or the compile error with its file and line.
3. Read the branch's diff for the cause: which change makes that line fail.
4. Rule, in one call:
   - `merge.rule {entry, ruling: "chat-fixes", text}`: two to four sentences for the chat: what failed (test, file, line), what in the branch causes it, the likely fix. No guesses dressed as facts: say "likely" when it is. It goes with the request.
   - `merge.rule {entry, ruling: "needs-user", text, choices}` only when fixing it needs a decision that is the user's (`PLAYBOOK.md`, "What is the user's"): a test asserting old wording the branch changed on purpose is the chat's; which wording the user wants is the user's.
5. `merge.note {entry, note}` (at most 300 characters): what failed, in a line, for the card.

## Can't tell whose failure
A check failed on the merge and on the target alone and names no failure. The user is asked meanwhile (Land Anyway, Try Again, Remove from Queue); nothing went to the chat. Read both logs. Rule only when they settle it: the branch's own errors show (not the target's) → `chat-fixes` with your diagnosis; the machine or a flake (temp files, a timeout, the host) → `try-again` (it counts no try). Otherwise explain it with `merge.note` for the user, and leave it to them.

## Review flagged
The review's whole report comes to you first and waits for you a few minutes, then goes to the branch's chat by itself; Land Anyway isn't offered over a review. Hand it on with `merge.rule {entry, ruling: "chat-fixes"}`: Sova sends the reviewer's summary and every finding exactly as written, so never retype, shorten or soften one. Give `text` only as your note, for what the findings don't say (it shows after them, "Merge thread: …"). A note later, while the branch is back with its chat, is another `chat-fixes` with its text (it counts no try); `merge.note` stays the landing note and never reaches the chat. Rule `needs-user` instead when a finding can't be fixed without a decision of the user's: the report stays on the chat's review card and nothing goes to the chat.

## A pause
Sova paused the queue itself (setup broken on the target, the target moved outside the queue, a push refused, the main checkout has uncommitted edits). Read `merge.status` and the step log it names. When the pause holds an entry (`merge.status` names it), put what you found on it with `merge.note {entry, note}`: the cause and what the user can do. Otherwise there is nothing to write: the pause banner carries Sova's own reason. You never resume the queue.

## Never
Blame a branch for what also fails on the target. Rerun anything yourself outside `try-again` and `merge.retry`. Edit the branch.
