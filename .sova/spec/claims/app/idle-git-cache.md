# §app/idle-git-cache — Shared Git observations without slower updates

Worktree insights and background merge readiness share bounded, in-memory Git observations at
the underlying directory, worktree and repository level, so unchanged polling and concurrent
readers do not repeat the same validated metadata reads. This changes neither the public
response shapes nor the polling cadence or readiness rules of §app.insights/worktrees-endpoint
and §chat.worktrees/readiness; the Merge facts consumed by §app.overseer/session-truth retain
their check-versus-newest-commit meaning, with the archived-idle cached-first inspection
exception described below. No numerical CPU reduction or
absence of all Git processes is promised: periodic dirty reads remain necessary.

**Validate before reuse.** Git remains authoritative for discovery, HEAD, branch and base
selection. Successful metadata observations may be reused while checked filesystem dependencies
demonstrate that the directory/worktree/repository identity and relevant Git inputs are unchanged.
Validation accounts for discovery boundaries and symlink retargeting, HEAD and symbolic refs,
base preference and ref creation/deletion, loose and packed refs, and remote-tracking ref motion.
A deleted/recreated path or a newly nested repository cannot inherit the old discovery answer.
Unsupported or unverifiable storage/layouts and unreadable dependencies fall back to requested
Git revalidation at intervals no longer than twenty seconds; failed validation never certifies
an old answer as fresh. Gone, non-Git and error answers are not permanent.

**Share facts, not sessions.** Canonical internal identities keep distinct repositories separate,
even when their commit OIDs match, and separate the HEAD and dirty observations of linked
worktrees while sharing their repository facts. Caller-visible paths, source attribution and
first-source-wins ordering remain unchanged. Successful commit metadata is keyed by repository
and observed HEAD OID; commit subjects and comparisons use observed base/HEAD OIDs rather than
moving ref names. Push ancestry reuse includes the repository, merge OID and current
remote-tracking OID: remote movement invalidates it, a missing ref remains unknown, and nothing
fetches. Changes to mutable Git history semantics invalidate reuse or take the conservative
fallback rather than treating OIDs alone as proof of unchanged meaning.

**Independent dirty lifetime.** Dirty status still stands for only ten seconds per worktree,
including unstaged and untracked changes that leave HEAD and index unchanged. Longer-lived
metadata or commit facts never extend that lifetime. The read-only execution protections,
five-second Git limit, four-at-a-time bound, scratch merge object store and successful partial
fields on Git errors are preserved.

**Concurrent reads and bounds.** Readers of the same validated resource generation share one
in-flight read, including dirty and comparison misses. Unverifiable inputs do not establish a
shared generation and may receive separate conservative revalidation reads. Flights clear on
success or failure; failed reads
are retried, not retained as successful facts. A generation changed during a read cannot install
an obsolete result over a newer observation; genuinely newer inputs receive a new read.
Settled caches have explicit size bounds and drop resources unseen for an hour; pruning does
not strand active readers or their cleanup. Caches require no persistent files, source-tree
watchers, background Git timers, model calls or network requests.

**Background readiness.** An unchanged session-list overlay cannot enqueue another copy of its
active readiness refresh. Genuinely newer row or session-file inputs coalesce into one necessary
trailing refresh without losing newer working/open-question state. Listings still return without
waiting on Git, ordinary unchanged-session refreshes retain their twenty-second cadence except
for archived-idle sessions below, and only files that ever wrote a `worktrees` entry receive Git
readiness reads. Ownership, checks,
questions, follow-up judgments and derived readiness remain per session, never shared merely
because sessions name the same tree. Routine refreshes still never query spec assessment status
or recapture its inputs.

**Archived-idle exception.** An archived session that is not open in a TUI and has nothing
running (no turn and no working subagents) keeps its last readiness answer without the
twenty-second refresh. It is read on first sight and again whenever its file or relevant row
state changes, including archiving, unarchiving, TUI presence and running state. Unarchiving
makes it eligible for a fresh background read at once. A live or running archived session
retains ordinary refreshing; being archived alone never suppresses that work.

Explicit inspection of an archived-idle session's worktrees in the Session tab or its Merge
facts through the Overseer's `sova_session` returns the last cached answer at once. When that
answer is at least twenty seconds old, `treeReadinessOf` and `readinessChecksOf` queue one fresh
background read, coalescing repeated inspections with already queued or active work. The first
inspection may therefore show an older answer; a later inspection shows the completed refresh.
File changes still update the Worktrees section, without a new control. The worktrees board's
own Git reads are unchanged; routine list traffic alone does not count as explicit inspection.
