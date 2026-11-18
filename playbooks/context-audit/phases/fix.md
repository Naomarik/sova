# Fix on the branch

1. Give the fixer the picked fixes, one group at a time, in the run's worktree, with `references/roles/fixer.md`.
2. One commit per group, by explicit paths, so any one can be dropped: `Context audit: <group>` (a resolved contradiction is its own group, named by its number in the report).
3. A layout change: the fixer moves text from the old entry page to the new pages and changes nothing else; record each as `<old page>=<new page>,<new page>` for the recheck.
4. A generated skill: change its source and run its generator, never the output pages.
5. Never touch a file outside the worktree, never turn a context file or skill on or off, never land, merge or push.
