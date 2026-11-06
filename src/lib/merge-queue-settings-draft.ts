// Settings → Merge Queue's staged project-file edits: module state, so switching to another tab and
// back keeps them, and they hold the dialog's close (settings-draft.ts HeldEdit). One project's at a
// time: the tab asks before switching to another project over them. Saved only by the tab's own
// confirm (one commit on the target), never by the footer's Save Changes.
import { createSignal } from "solid-js";
import type { MergeQueueSettings } from "../../shared/merge-queue-settings";
import { draftHolds, type ProjectDraft } from "./merge-queue-settings";
import { registerHeldEdit } from "./settings-draft";

export interface StagedEdit {
  project: string;
  /** What the draft was edited from: master's values at the time, and whether there's an origin. */
  base: MergeQueueSettings;
  hasOrigin: boolean;
  draft: ProjectDraft;
}

const [staged, setStaged] = createSignal<StagedEdit | null>(null);
export const stagedEdit = staged;
export const stageEdit = (e: StagedEdit | null): void => void setStaged(e);
export const discardStaged = (): void => void setStaged(null);

/** The staged edit changes something (an edit undone by hand is no edit), or a time-limit box
    holds text that isn't one: unsaved either way. Tracked. */
export function stagedDirty(): boolean {
  const e = staged();
  return !!e && draftHolds(e.draft, e.base, e.hasOrigin);
}

registerHeldEdit({ tab: "merge-queue", label: "Merge Queue", dirty: stagedDirty, discard: discardStaged });
