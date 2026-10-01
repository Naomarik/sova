<!-- owner: data member. Emphasis target: row label (key = index) or column name (key = c<index>). -->
# vis matrix
Options against criteria; also capabilities by level or role (a matrix, not a flow). `columns: A, B`, then `criterion | cell | cell`; a cell is `yes`, `no`, `partial` (optionally followed by a "note"), or short text that may end with a tone (`72% warn`; quote text ending in a tone word). At most 6 columns.
Quote a column name that has a comma: `columns: Merge, "Rebase, then merge"`.
```vis matrix
columns: Merge, Rebase
Keeps original commits | yes | no "new SHAs"
Linear history | no | yes
Conflicts to resolve | once ok | per commit warn
mark "Keeps original commits" "why rebase needs a force-push"
```
- `mark` targets: a row's criterion or a column's name.
