import type { TeamDefaults } from "../../shared/team-defaults";
import { createDraftStore } from "./settings-draft";
import { cloneTeam, sameTeam, type TeamDraft } from "./team-form";

/** Settings → Teams' unsaved edits (settings-draft.ts: module state, held on close, forgotten once closed). */
const store = createDraftStore<TeamDraft, TeamDefaults>({ tab: "teams", label: "Teams", toDraft: cloneTeam, same: sameTeam });

export const teamDraft = store.draft;
export const teamSaved = store.saved;
export const setTeamDraft = store.setDraft;
/** What the server has now. The first load also seeds the draft; a kept draft is never overwritten. */
export const setTeamSaved = store.setSaved;
export const acceptTeamSave = store.acceptSave;
export const teamDirty = store.dirty;
export const discardTeamDraft = store.discard;
export const resetTeamDraft = store.reset;
