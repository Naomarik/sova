import { createSignal } from "solid-js";
import type { ProfileSaveRequest, ProfilesListing, ProfileWriteAnswer } from "../../shared/profiles";
import { OFF_KEY } from "../../shared/profiles";
import { deleteMyProfile, putDefaultProfile, saveMyProfile } from "./api";
import { createDraftStore, SaveFailed } from "./settings-draft";
import { canonical, draftOf, isNewKey, profilesDraftFields, typedDraft, type ProfilesDraft } from "./profiles-settings";

/**
 * Settings → Profiles' draft (§app.settings-dialog/profiles): your profiles, both halves, and this
 * computer's default, staged until Save Changes (§app.settings-dialog/save-bar). Each half is
 * written by its own writer (§chat.profiles/joined): Save sends each removed profile's delete, each
 * changed profile's halves (a shared library half once), then the default, last, so a new profile
 * made the default has its key. Approve and Hide save at once, outside the draft.
 */

/** The last listing the server answered (a load, a save, an Approve or a Hide): the list's project and built-in rows. */
const [listing, setListingSignal] = createSignal<ProfilesListing | null>(null);
export const profilesListing = listing;
/** Each new profile's saved key, by the draft key it had, from the last save (the editor keeps it open). */
const [savedKeys, setSavedKeys] = createSignal<ReadonlyMap<string, string>>(new Map());
export const lastSavedKeys = savedKeys;
/** The open session's folder, whose project's profiles are listed: every write names it, so the answer lists them too. */
let cwd: string | null = null;
export const setProfilesCwd = (next: string | null): void => {
  cwd = next;
};

export const defaultKeyOf = (l: ProfilesListing): string => l.defaultProfile?.key ?? OFF_KEY;
export const savedOfListing = (l: ProfilesListing): ProfilesDraft => draftOf(l.joined ?? [], defaultKeyOf(l));

/** A fresh listing from outside a Save (a load, Approve, Hide): what's saved follows it, the draft stays. */
export function takeListing(l: ProfilesListing, first = false): void {
  setListingSignal(l);
  if (first) profilesDraft.setSaved(savedOfListing(l));
  else profilesDraft.refreshSaved(savedOfListing(l));
}

/** The halves of `row` that changed since `base`, as the save request says them; null when nothing did. */
export function saveRequestOf(d: ProfilesDraft, base: ProfilesDraft, key: string, sentLibs: Set<string>): ProfileSaveRequest | null {
  const row = d.rows.find((r) => r.key === key)!;
  const before = base.rows.find((r) => r.key === key);
  const body: ProfileSaveRequest = { name: row.name, ...(cwd ? { cwd } : {}) };
  let changed = !before || before.name !== row.name;
  if (!isNewKey(key)) body.key = key;
  if (row.starts && (!before || canonical(row.starts) !== canonical(before.starts))) {
    body.starts = row.starts;
    changed = true;
  }
  if (before ? row.model !== before.model : row.model !== null) {
    body.model = row.model;
    changed = true;
  }
  if (before ? row.thinking !== before.thinking : row.thinking !== null) {
    body.thinking = row.thinking;
    changed = true;
  }
  const h = row.lib ? d.library[row.lib] : undefined;
  if (h && row.lib && !sentLibs.has(row.lib) && (!before || before.lib !== row.lib || canonical(h) !== canonical(base.library[row.lib] ?? null))) {
    body.helpers = h;
    sentLibs.add(row.lib);
    changed = true;
  }
  return changed ? body : null;
}

/** `d` with each written new profile under its saved key, and its library half under the saved one's id. */
export function remapped(d: ProfilesDraft, keys: ReadonlyMap<string, string>, saved: ProfilesDraft): ProfilesDraft {
  const next: ProfilesDraft = JSON.parse(JSON.stringify(d));
  for (const row of next.rows) {
    const to = keys.get(row.key);
    if (!to) continue;
    const lib = saved.rows.find((r) => r.key === to)?.lib ?? null;
    if (row.lib && lib && row.lib !== lib) {
      next.library[lib] = next.library[row.lib]!;
      delete next.library[row.lib];
    }
    if (next.default === row.key) next.default = to;
    row.key = to;
    row.lib = lib ?? row.lib;
  }
  return next;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");

export const profilesDraft = createDraftStore<ProfilesDraft, ProfilesDraft, ProfilesListing>({
  tab: "profiles",
  label: "Profiles",
  toDraft: (s) => JSON.parse(JSON.stringify(s)),
  same: (a, b) => canonical(typedDraft(a)) === canonical(b),
  fields: (d, saved) => profilesDraftFields(d, saved),
  write: async (draft, base) => {
    const d = typedDraft(draft);
    let last: ProfileWriteAnswer | null = null;
    let wrote = false;
    const keys = new Map<string, string>();
    const step = async (fn: () => Promise<ProfileWriteAnswer>) => {
      try {
        last = await fn();
        wrote = true;
        return last;
      } catch (err) {
        if (!wrote || !last) throw err;
        // Part of it landed: what's saved is the last answer, and the draft's new profiles that were
        // written take their saved keys, so Save again writes only what is still unsaved.
        const saved = savedOfListing(last);
        profilesDraft.setDraft(remapped(draft, keys, saved));
        profilesDraft.refreshSaved(saved);
        setListingSignal(last);
        setSavedKeys(new Map(keys));
        throw new SaveFailed(`Some profiles were saved, then this failed: ${message(err)}`, true);
      }
    };
    // Deletes first, so a new profile may take a removed one's name; the old default's last, after
    // the default moved off it (the server refuses to delete the default).
    const gone = base.rows.filter((r) => !d.rows.some((x) => x.key === r.key)).map((r) => r.key);
    for (const key of gone) if (key !== base.default) await step(() => deleteMyProfile(key, cwd));
    const sent = new Set<string>();
    for (const r of d.rows) {
      const body = saveRequestOf(d, base, r.key, sent);
      if (!body) continue;
      const answer = await step(() => saveMyProfile(body));
      if (isNewKey(r.key) && answer.savedKey) keys.set(r.key, answer.savedKey);
    }
    if (d.default !== base.default) {
      const key = keys.get(d.default) ?? d.default;
      await step(() => putDefaultProfile({ key, cwd }));
    }
    if (gone.includes(base.default)) await step(() => deleteMyProfile(base.default, cwd));
    if (!last) throw new Error("Nothing to save"); // unreachable: same() gates the write
    const answer: ProfilesListing = last;
    setListingSignal(answer);
    setSavedKeys(keys);
    return { saved: savedOfListing(answer), warnings: (answer as ProfileWriteAnswer & { warnings?: string[] }).warnings ?? [], result: answer };
  },
  onReset: () => setListingSignal(null),
});
