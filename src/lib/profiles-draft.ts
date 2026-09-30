import type { ProfilesFile } from "../../shared/profiles";
import { BUILTIN_PROFILES } from "../../shared/profiles";
import { saveProfiles } from "./api";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Profiles' unsaved edits (§app.settings-dialog/profiles): the whole saved-profiles file,
 * written in one PUT by the dialog's footer.
 */
export function profilesProblem(d: ProfilesFile): string | null {
  const seen = new Set<string>();
  for (const p of d.profiles) {
    const name = p.label.trim().toLowerCase();
    if (!name) return "Profiles: every profile needs a name.";
    if (seen.has(name) || BUILTIN_PROFILES.some((b) => b.label.toLowerCase() === name)) return `Profiles: the name "${p.label.trim()}" is taken.`;
    seen.add(name);
  }
  return null;
}

const store = createDraftStore<ProfilesFile, ProfilesFile>({
  tab: "profiles",
  label: "Profiles",
  toDraft: (f) => structuredClone(f),
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  problem: (d) => profilesProblem(d),
  write: async (d) => {
    const r = await saveProfiles(d);
    const saved: ProfilesFile = { version: 1, profiles: r.profiles, hiddenBuiltins: r.hiddenBuiltins };
    return { saved, result: saved };
  },
});

export const profilesDraft = store.draft;
export const setProfilesDraft = store.setDraft;
export const setProfilesSaved = store.setSaved;
export const profilesSaveError = store.error;
export const profilesSaving = store.saving;
