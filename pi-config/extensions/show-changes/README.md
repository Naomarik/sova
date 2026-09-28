# show-changes

The `show_changes` tool: the agent calls it when the user asks to see or review changes, and Sova
renders the result as a card that opens its changes viewer (file tree, numbered steps, one file or
step at a time). Spec: `§chat.changes/show-changes-tool`.

The tool is read-only and computes no diff. It checks the call, resolves which changes with git
plumbing (`rev-parse`, `merge-base`, `diff --name-only`, `ls-files`; argument lists through
`execFile`, never a shell, with `-c core.fsmonitor=false --no-optional-locks`, a 15 s timeout and
an 8 MB output cap), and returns a short text for the model plus `details` for Sova.

## Contract

| Surface | Shape |
|---|---|
| Tool | `show_changes {scope, commit?, worktree?, title?, paths?, steps?}`. `scope`: `dirty` (index + working tree, untracked included, vs HEAD), `worktree` (a branch vs its merge-base with its base: the tracked worktree's `baseBranch`, else `master`, else `main`, else `origin/HEAD`'s target, else the tracked base commit), `commit` (`commit` vs its first parent). `worktree`: a tracked worktree's branch or path, or a directory; default the tracked worktree holding the cwd, else (worktree scope) the only tracked one, else the cwd. `steps[]`: `{title, why?, buildsOn?: number[] (1-based, earlier steps), hunks: {path, oldStart?, newStart?}[]}`. |
| Details | `ShowChangesDetails` (`details.ts`): `{v: 1, scope, title?, paths?, steps?}`, scope `{kind: "dirty", cwd, root, head}` \| `{kind: "worktree", worktreePath, root, branch, head, base, baseRef}` \| `{kind: "commit", repoPath, root, sha, parent?}`. `cwd`/`worktreePath`/`repoPath` is the folder read, the names of Sova's `DiffScope` (`shared/protocol.ts`) minus `sessionPath`; `root` its canonical top level; shas full. `normalizeShowChangesDetails` is the strict check every reader runs. |
| Steps | A hunk ref is repo-relative; with no `oldStart`/`newStart` it means every hunk of the file. The tool rejects the same ref twice; it does not match refs to the real diff. Sova does: each hunk to the first step naming it, leftovers under "Other changes", refs matching nothing shown unmatched. |

`details.ts` imports nothing: Sova imports it (see `CLAUDE.md`'s pi-config list), and Vite may
bundle it for the browser. `index.ts` imports `../worktrees/state.ts` for the tracked set, so it
loads only while the `worktrees` extension is linked too (`install.sh` links both). A session
whose tools run on a remote target (`remote:session`) refuses the tool.

## Tests

```sh
node --test details.test.ts git.test.ts   # the contract, the input check, git against throwaway repos
node tests/run.mjs                        # the extension against a fake pi: tool, text, refusals
```
