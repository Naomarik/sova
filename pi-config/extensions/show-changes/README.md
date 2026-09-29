# show-changes

The `show_changes` tool: the agent calls it when the user asks to see or review changes, and Sova
renders the result as a card that opens its changes viewer (file tree, numbered steps, one file or
step at a time). Spec: `§chat.changes/show-changes-tool`.

The tool is read-only. It checks the call, resolves which changes with git plumbing (`rev-parse`,
`merge-base`, `diff --name-only`, `ls-files`, and `diff-index`/`diff-tree -p` for the hunks;
argument lists through `execFile`, never a shell, with `-c core.fsmonitor=false
--no-optional-locks`, a 15 s timeout and an 8 MB output cap, 64 MB for the patch), checks the
steps against the diff's hunks, and returns a short text for the model plus `details` for Sova.

## Contract

| Surface | Shape |
|---|---|
| Tool | `show_changes {scope, commit?, worktree?, title?, paths?, steps?}`. `scope`: `dirty` (index + working tree, untracked included, vs HEAD), `worktree` (a branch vs its merge-base with its base: the tracked worktree's `baseBranch`, else `master`, else `main`, else `origin/HEAD`'s target, else the tracked base commit), `commit` (`commit` vs its first parent). `worktree`: a tracked worktree's branch or path, or a directory; default the tracked worktree holding the cwd, else (worktree scope) the only tracked one, else the cwd. `steps[]`: `{title, why?, buildsOn?: number[] (1-based, earlier steps), hunks: {path, oldStart?, newStart?}[]}`. |
| Details | `ShowChangesDetails` (`details.ts`): `{v: 1, scope, title?, paths?, steps?}`, scope `{kind: "dirty", cwd, root, head}` \| `{kind: "worktree", worktreePath, root, branch, head, base, baseRef}` \| `{kind: "commit", repoPath, root, sha, parent?}`. `cwd`/`worktreePath`/`repoPath` is the folder read, the names of Sova's `DiffScope` (`shared/protocol.ts`) minus `sessionPath`; `root` its canonical top level; shas full. `normalizeShowChangesDetails` is the strict check every reader runs. |
| Steps | A hunk ref is repo-relative; with no `oldStart`/`newStart` it means every hunk of the file, else the hunk whose range on that side holds the number. The tool rejects the same ref twice, then matches the refs to the hunks Sova's viewer shows (`hunks.ts`: the viewer's plumbing and options, untracked files as one added hunk, a binary file or a patch past 1 MB as one whole-file unit; `coverage.ts`: Sova's `refMatches`/`stepsFromAgent`, each hunk to the first step naming it). With more than one hunk it refuses a call without steps, or with a hunk no step places or a ref naming no hunk; the error lists the hunks to place (`path`, `@@ +newStart,newLines: first changed line`), or past 150 hunks the files with counts, under 12 KB. One hunk or none needs no steps. |

`details.ts` imports nothing: Sova imports it (see `CLAUDE.md`'s pi-config list), and Vite may
bundle it for the browser. `coverage.ts` imports nothing either: Sova's
`src/lib/show-changes-coverage.test.ts` imports it to pin it to the viewer's matching. `index.ts` imports `../worktrees/state.ts` for the tracked set, so it
loads only while the `worktrees` extension is linked too (`install.sh` links both). A session
whose tools run on a remote target (`remote:session`) refuses the tool.

## Tests

```sh
node --test details.test.ts git.test.ts coverage.test.ts   # the contract, the input check, git and hunks against throwaway repos, the refusals
node tests/run.mjs                        # the extension against a fake pi: tool, text, refusals
```
