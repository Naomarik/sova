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
one that became merged in between is recorded with `how: "detected"`. A tool merge's card names
the target's new tip and its numbers are the target's own change. A detected card names the commit
that brought the branch in: the first commit on the target's first-parent history since the run
started that contains the branch tip (the tip itself when the target fast-forwarded through it,
shown as a fast-forward), and its numbers are the branch's own (`git diff --numstat
<before>...<branch>`), so branches that arrived together, say through an integration branch, each
show their own. A merge made outside this session's turns gets no card; Sova's pane still shows it
merged.

Spec report (`spec.ts`): when the project has `.sova/spec/manifest.json` before or after the merge
and the spec tools sit beside this extension (`../spec/core`), every recorded merge's model note
(the card's content and the tool result; never the card's details, so the card looks the same)
gains `Foreign § this merge changes: §a, §b` (or `none`), computed by
`sova-spec.mjs foreign --base <target before> --head <target after> --landing --drafts <worktree>`,
then `Deleted § (still foreign): §x, §y → §z` when the merge deleted or renamed §, `Code changed
under unchanged §: §a (files); …` (advisory), then one `Spec warning: …` line each for: changed
files no claim maps (each needs a claim or a `Plumbing: <path> — <why>` line), a draft with
unpromoted records in the merged worktree or a worktree whose branch the merge brings in (`pending`,
or `conflict` never promoted; promote, or a `Deferred: §… — <why>` line), a merge commit that
resolved § by hand (it differs from both parents; `git show --cc`), an evidence commit a draft names
that the branch doesn't contain (a rebase after evidence), and code commits after the branch's last
spec commit (one touching `.sova/spec/` or named by evidence; merges skipped; none when the branch
has no spec commit). Every recorded merge is also emitted on the bus as `worktrees:merged`
(`{version: 1, path, branch, target, sha, how, spec, foreign, warnings, before, after, top?,
worktree, landing?}`: the target's tip before and after, its checkout, the merged worktree, and the
core's landing lists; `spec` false and the lists empty without a spec); the spec mode checks the
turn's last line against `foreign` and the landing gate against `landing`. The report is best-effort: a failure never fails the merge.

Workers never have this extension: the subagents extension refuses any copy of `worktrees` (and
`subagents`) as a worker extension. It enforces where workers may start itself
(`workerCwdRefusal` in `state.ts`, see `subagents/README.md` "Worktrees").

`state.ts` imports node builtins only: Sova's server (`server/worktrees-state.ts`) and the
subagents extension import it.

## Tests

```sh
node --test state.test.ts git.test.ts spec.test.ts   # the fold, the cwd rule; git and the spec report against throwaway repos
node tests/run.mjs                      # the extension against a fake pi: tool, approval, merge detection
```
