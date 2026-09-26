# worktrees

The git worktrees a session works in, kept in the session itself. Spec: `§chat/worktrees`.

## Contract

| Surface | Shape |
|---|---|
| Entry | `custom` entry `worktrees`: `{version: 1, trees: TrackedWorktree[]}` (`state.ts`), the **whole** set, appended on every change; `restoreActive(branch)` reads the newest usable one, so tree navigation, forks and rewinds move the set with the branch. A tree: `path` (canonical top level), `branch`, `base` (the commit it was created from, or its fork point from the default branch when attached), `baseBranch?`, `status` (`active` \| `dropped` \| `merged`), `merge?` (`{target, sha, at, how: "tool" \| "detected"}`), `session` (the id that created or attached it; another id means it was inherited, i.e. shared), `how` (`created` \| `attached`), `at`. Opening a session writes nothing. |
| Tool | `worktree {action, name?, base?, path?, target?}`, the parent agent's only: `create` (`git worktree add -b feat/<name>` at `<parent of the main checkout>/.worktrees/<repo>-<name>` unless `path`), `attach` (a worktree's top level; another session's is fine), `detach` (status `dropped`, nothing deleted), `merge` (into `target`, default `master`, else `main`), `list`. git runs by argument list (`git.ts`, `execFile`), never a shell. Local sessions only. No command, no pane control. |
| Sandbox | While the session's sandbox is on (`sandbox:state`), `create`, `attach` and `merge` ask the user (`ctx.ui.confirm`); declined or no UI changes nothing. The sandbox makes every active worktree writable and its `.agent` read-only. |
| Event bus | `worktrees:state` (`{version: 1, active: string[]}`) on `session_start`, `session_tree`, every change, and in answer to `worktrees:discover`. The sandbox listens. |
| Merge card | `custom_message` `worktree-merge`, `display: true`, content the one line the model reads (`mergeNote`: "Merged feat/x into master at abc1234, 5 commits, +120 −30"), details `WorktreeMergeDetails` (`path`, `branch`, `target`, `sha`, `commits`, `added`, `removed`, `fastForward`, `how`). Sent with `triggerTurn: false`: pi holds it to the end of the running turn. The TUI draws it with `registerMessageRenderer`; Sova renders it as a merge card. |

Merges: `worktree merge` records one directly. Where the target is checked out, that checkout must
have no tracked changes and the merge runs there (fast-forward when possible, else a merge commit;
a conflict is aborted). Where it is not checked out, only a fast-forward (`update-ref`, guarded by
the old value). A merge made with plain git during a turn is detected when the run settles: each
active worktree's branch is probed at `agent_start` and at `agent_settled`
(`git merge-base --is-ancestor <branch> <target>`, and the branch has commits beyond its base), and
one that became merged in between is recorded with `how: "detected"`. A merge made outside this
session's turns gets no card; Sova's pane still shows it merged.

Workers never have this extension: the subagents extension refuses any copy of `worktrees` (and
`subagents`) as a worker extension. It enforces where workers may start itself
(`workerCwdRefusal` in `state.ts`, see `subagents/README.md` "Worktrees").

`state.ts` imports node builtins only: Sova's server (`server/worktrees-state.ts`) and the
subagents extension import it.

## Tests

```sh
node --test state.test.ts git.test.ts   # the fold, the cwd rule; git against throwaway repos
node tests/run.mjs                      # the extension against a fake pi: tool, approval, merge detection
```
