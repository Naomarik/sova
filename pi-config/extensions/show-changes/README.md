# show-changes

The `show_changes` tool: the agent calls it when the user asks to see or review changes, and Sova
renders the result as a card that opens its changes viewer (file tree, numbered steps, one file or
step at a time). Spec: `§chat.changes/show-changes-tool`.

The tool is read-only. It checks the call, resolves which changes with git plumbing (`rev-parse`,
`merge-base`, `diff --name-only`, `ls-files`, and `diff-index`/`diff-tree -p` for the hunks;
argument lists through `execFile`, never a shell, with `-c core.fsmonitor=false
--no-optional-locks`, a 5 s timeout and an 8 MB output cap; the whole patch gets 15 s and 64 MB,
and past either every file is one whole-file unit), refuses a change of more than 3,000 files
counted within `paths` (the viewer's limit; the refusal says to narrow it with `paths`), checks the
steps against the diff's hunks, and returns a short text for the model plus `details` for Sova.
The base of a `worktree` scope, the timeout, the file limit and the patch caps are
`../worktrees/git.ts` `reviewBase` and `REVIEW_LIMITS`, the one rule Sova's diff endpoint uses too.

## Contract

| Surface | Shape |
|---|---|
| Tool | `show_changes {scope, commit?, worktree?, title?, paths?, steps?}`. `scope`: `dirty` (index + working tree, untracked included, vs HEAD), `worktree` (a branch vs its base by `../worktrees/git.ts` `reviewBase`: the merge-base with the tracked worktree's `baseBranch`, else `master`, else `main` (each skipped when it is the branch itself or shares no history), else `origin/HEAD`'s target; once the branch is merged, what its merge brought in, `baseRef` then "master before <sha>" or after a fast-forward "<sha> (created from)"; with no base branch sharing history, the tracked base commit, `baseRef` "<sha> (created from)"; else refused), `commit` (`commit` vs its first parent). `worktree`: a tracked worktree's branch or path, or a directory; default the tracked worktree holding the cwd, else (worktree scope) the only tracked one, else the cwd. The folder must be one Sova's viewer opens (`server/git-diff.ts` `knownFoldersOf`): inside the session's cwd, a worktree any `worktrees` entry names, or a merge card's folder (`git.ts` `knownFolders`); any other is refused, telling the agent to put the changes in a worktree. `steps[]`: `{title, why?, hunks: {path, oldStart?, newStart?}[]}` (no `buildsOn`: the schema refuses it). |
| Details | `ShowChangesDetails` (`details.ts`): `{v: 1, scope, title?, paths?, steps?}`, scope `{kind: "dirty", cwd, root, head}` \| `{kind: "worktree", worktreePath, root, branch, head, base, baseRef}` \| `{kind: "commit", repoPath, root, sha, parent?}`. `cwd`/`worktreePath`/`repoPath` is the folder read, the names of Sova's `DiffScope` (`shared/protocol.ts`) minus `sessionPath`; `root` its canonical top level; shas full. `normalizeShowChangesDetails` is the strict check every reader runs; it still accepts a step's old `buildsOn` (1-based earlier steps) so cards saved before it was dropped keep opening, and no reader shows it. Sova opens a worktree card pinned to its saved `base`..`head`. |
| Steps | A hunk ref is repo-relative; with no `oldStart`/`newStart` it means every hunk of the file, else the hunk whose range on that side holds the number. The tool rejects the same ref twice, then matches the refs to the hunks Sova's viewer shows (`hunks.ts`: the viewer's plumbing and options, untracked files as one added hunk, a binary file, a file with no line changes (rename, mode change, empty file: no hunks) or a patch past 1 MB as one whole-file unit, a stat-only section with no hunks and no header dropped; `coverage.ts`: Sova's `refMatches`/`stepsFromAgent`, each hunk to the first step naming it). With more than one hunk it refuses a call without steps, or with a hunk no step places, a ref naming no hunk, or a step naming only hunks earlier steps hold; the error lists the hunks to place (`path`, `@@ +newStart,newLines: first changed line`), or past 150 hunks the files with counts, under 12 KB. One hunk or none needs no steps. |

`details.ts` imports nothing: Sova imports it (see Sova's `AGENTS.md` and its pi-config extensions guide), and Vite may
bundle it for the browser. `coverage.ts` imports nothing either: Sova's
`src/lib/show-changes-coverage.test.ts` imports it to pin it to the viewer's matching. `index.ts` imports `../worktrees/state.ts` for the tracked set and `git.ts` imports `../worktrees/git.ts` (builtins only) for the review-base rule and limits, so it
loads only while the `worktrees` extension is linked too (`install.sh` links both). A session
whose tools run on a remote target (`remote:session`) refuses the tool.

## Tests

```sh
node --test details.test.ts git.test.ts coverage.test.ts   # the contract, the input check, git and hunks against throwaway repos, the refusals
node tests/run.mjs                        # the extension against a fake pi: tool, text, refusals
```
