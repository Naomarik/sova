import type { SessionTitleSettings, SessionTitleSettingsInfo } from "../../shared/protocol";
import { putSessionTitleSettings } from "./api";
import { sameTitleSettings, titleDraftProblem, toTitleDraft, toTitleSettings, type SessionTitleDraft } from "./session-title-settings-form";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Summaries → Session titles' unsaved edits (settings-draft.ts: module state, held on
 * close, forgotten once closed). Sova's own file, which nothing else writes, so no rebase: the
 * dialog's Save Changes writes the whole draft.
 */
const store = createDraftStore<SessionTitleDraft, SessionTitleSettings, SessionTitleSettingsInfo>({
  tab: "summaries",
  label: "Session titles",
  toDraft: toTitleDraft,
  same: sameTitleSettings,
  problem: titleDraftProblem,
  write: async (d) => {
    const result = await putSessionTitleSettings(toTitleSettings(d));
    return { saved: result.settings, result };
  },
});

export const titleSettingsDraft = store.draft;
export const setTitleSettingsDraft = store.setDraft;
export const setTitleSettingsSaved = store.setSaved;
export const titleSettingsDirty = store.dirty;
export const titleSettingsSaving = store.saving;
export const titleSettingsSaveError = store.error;
/** The last save's response, with fresh reasons a model can't run. */
export const titleSettingsSaveResult = store.result;
