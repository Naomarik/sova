# How an arm is made

Pick the cheapest way that still measures what the user cares about.

## Its own worktree and test copy of Sova (`copy`)

For anything a chat reads or does inside Sova: a tool's text or code, a mode's text, instructions. Faithful: real chats, real tools.

1. A worktree per arm on its own branch, cut from the base (`worktree create ab-<campaign>-<arm>`; `mise trust` it). Master's arm is always its own worktree and branch cut from master too, never the campaign's own worktree: the record is written there.
2. Its own test copy: `project_verbs up` with that worktree (it picks the ports), or `SOVA_PORT=<port> pnpm run dev:hermetic` in it. Its state is the worktree's own `.agent`: never your real one.
3. Sign-ins: a test copy has none until you copy them in. Copy `auth.json` into the arm's `.agent` by hand, only for the providers the test models need, and say so. A Claude model needs the copy's Claude sign-in too: check one case runs before the round.
4. In `arms.json`: `"how": "sova"`, the copy's `url`, its `agentDir` (the worktree's `.agent`, where its token is), the `cwd` the chats run in (the arm's worktree, or a copy of a project the cases make sense in: never a checkout you can't commit the record's removal in), and the commit.
5. A test chat stays in its copy: never archive or delete them, the user may read them later.

## A prompt variant file (`variant`)

For text alone, judged without tools: each arm is a file with the variant, and a command sends case + variant to a model. Use `"how": "command"` with a command that prints the reply; Sova's own chats are the simplest command: a `sova` arm in one test copy, with the variant applied as the arm's change.

## A re-score of saved replies (`rescore`)

Free. When the change is to how replies are read (a parser, a checker, a grader rule), not to what the model sees: `"how": "rescore", "from": <round>` copies that round's replies, and the new checks judge them.

## No test chat sees the record

A test chat that could read the subject's record (`references/record.md`) would be told the answers. Once a record has landed, every worktree cut from master holds it, in its folder and in its commits. Deleting the folder isn't enough: `git status` shows the delete and `git show HEAD:.sova/ab/<name>.jsonl` prints the file. So:

- **Each arm removes it in a commit on its own branch**, master's arm too, before its first round: `git rm -r .sova/ab`, then a commit of that alone whose message ends with `(experiment, never lands)`. It is separate from the builder's commit of the change. An arm cut from another arm already has it: cut cycle 1's arms from master's arm and later ones from the winner, and there is nothing to do.
- **Master's arm is master plus that one commit.** In `arms.json` its `base` is master's own commit and its `ref` the removal commit. This changes no behaviour: only this playbook's `record.mjs` reads the record, never what is under test, so the baseline is still master.
- `runner.mjs` refuses to start a round (exit 3, naming the arm) while an arm's `cwd`, its worktree (the folder holding its `agentDir`, or `worktree` in `arms.json`) or the repository either sits in still holds `.sova/ab/` or still has it in its HEAD commit, and when an arm runs inside the campaign's own worktree. A `command` arm with no `cwd` runs where the runner does: give it a `cwd` of its own.
- An arm's diff against master shows the removal. Leave it out when you read or show the change: `git diff <base> <arm> -- . ':(exclude).sova/ab'`. `record.mjs` does.
- The removal never lands, like every arm commit: the record is kept on the campaign's own branch.

## Every arm

- Commit messages end with `(experiment, never lands)`.
- The base of cycle 1 is master; after that, the previous cycle's winner. The losing change is reverted, not built on.
- Never touch the live checkout, its server or the user's real state.
