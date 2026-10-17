import type { UpdatesSettings, UpdatesState } from "../../shared/protocol";
import { putUpdatesSettings } from "./api";
import { createDraftStore } from "./settings-draft";
import { setUpdatesState } from "./updates";

/**
 * Settings → General's Updates form: Update
 * from, Check for updates automatically and Upgrade automatically, staged and written by the
 * dialog's Save Changes. A branch source keeps its typed name in the draft; the server looks it up
 * in Sova's repository when it saves, and a refusal is the form's failed save.
 */
export interface UpdatesDraft {
  source: "stable" | "master" | "branch";
  branch: string;
  autoCheck: boolean;
  autoUpgrade: boolean;
}

export const toUpdatesDraft = (s: UpdatesSettings): UpdatesDraft => ({
  source: s.source.kind,
  branch: s.source.kind === "branch" ? s.source.branch : "",
  autoCheck: s.autoCheck,
  autoUpgrade: s.autoUpgrade,
});

export const fromUpdatesDraft = (d: UpdatesDraft): UpdatesSettings => ({
  source: d.source === "branch" ? { kind: "branch", branch: d.branch.trim() } : { kind: d.source },
  autoCheck: d.autoCheck,
  autoUpgrade: d.autoUpgrade,
});

export function sameUpdates(d: UpdatesDraft, s: UpdatesSettings): boolean {
  const x = fromUpdatesDraft(d);
  const sameSource = x.source.kind === s.source.kind && (x.source.kind !== "branch" || (s.source.kind === "branch" && x.source.branch === s.source.branch));
  return sameSource && x.autoCheck === s.autoCheck && x.autoUpgrade === s.autoUpgrade;
}

/** Why the draft can't be saved, naming the form, or null. Pure. */
export function updatesProblem(d: UpdatesDraft): string | null {
  return d.source === "branch" && !d.branch.trim() ? "Updates: Name the branch." : null;
}

/**
 * The server's settings moved under a kept draft (another tab saved, a poll read them): every field
 * the user left alone follows the server, every field they changed stays theirs. Pure.
 */
export function rebaseUpdates(draft: UpdatesDraft, base: UpdatesSettings, fresh: UpdatesSettings): UpdatesDraft {
  const was = toUpdatesDraft(base);
  const now = toUpdatesDraft(fresh);
  const sourceTouched = draft.source !== was.source || (draft.source === "branch" && draft.branch.trim() !== was.branch);
  return {
    source: sourceTouched ? draft.source : now.source,
    branch: sourceTouched ? draft.branch : now.branch,
    autoCheck: draft.autoCheck !== was.autoCheck ? draft.autoCheck : now.autoCheck,
    autoUpgrade: draft.autoUpgrade !== was.autoUpgrade ? draft.autoUpgrade : now.autoUpgrade,
  };
}

const store = createDraftStore<UpdatesDraft, UpdatesSettings, UpdatesState>({
  tab: "general",
  label: "Updates",
  toDraft: toUpdatesDraft,
  same: sameUpdates,
  rebase: rebaseUpdates,
  problem: updatesProblem,
  write: async (draft) => {
    const result = await putUpdatesSettings(fromUpdatesDraft(draft));
    setUpdatesState(result);
    return { saved: result.settings, result };
  },
});

export const updatesDraft = store.draft;
export const setUpdatesDraft = store.setDraft;
export const setUpdatesSaved = store.setSaved;
export const updatesSaving = store.saving;
export const updatesSaveError = store.error;
