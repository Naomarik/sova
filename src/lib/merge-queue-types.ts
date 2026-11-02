// The merge queue's shapes as the screens read them: the queue's own (shared/merge-queue.ts), plus
// the project facts a worktree row needs before it has an entry.
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
} from "../../shared/merge-queue";
import type { ChecksDeclared } from "../../shared/merge-queue";

/** A worktree's project as the queue sees it (SessionWorktreeInfo.mergeProject), entry or not. */
export interface MergeProjectInfo {
  id: string;
  root: string;
  target: string;
  checks: ChecksDeclared;
  review: boolean;
}
