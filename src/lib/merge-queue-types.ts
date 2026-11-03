// The merge queue's shapes as the screens read them: the queue's own (shared/merge-queue.ts).
export type {
  Blame,
  CheckPick,
  CheckSource,
  ChecksDeclared,
  MergeEntry,
  MergeEntryState,
  MergeLanded,
  MergeNote,
  MergeQueueView,
  MergeRun,
  PauseInfo,
  RunStep,
  WorktreeQueueInfo,
  /** A worktree's project as the queue sees it (SessionWorktreeInfo.mergeProject), entry or not. */
  WorktreeMergeProject as MergeProjectInfo,
} from "../../shared/merge-queue";
