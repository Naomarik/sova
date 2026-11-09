/** A profile's limits, read by Save Current As Profile, Settings → Profiles' editor and by the profile parse (shared/profiles.ts), in the same words (§chat.profiles/profile-name). */
import { problemOf, type TextRule } from "./form-rules";

/** A profile's name: one name for both its halves, so the library's limit (48) holds for both. */
export const PROFILE_LABEL_RULE: TextRule = { kind: "text", label: "Profile name", min: 1, max: 48, trim: true };
/** What a profile file's read accepts: a session profile an older Sova saved with a longer name (up to 60) still reads. */
export const PROFILE_READ_RULE: TextRule = { ...PROFILE_LABEL_RULE, max: 60 };

export const PROFILE_NAME_OFF = `Profile name can't be "Off", the built-in profile's.`;
export const PROFILE_NAME_TAKEN = "Another profile has this name.";

/** The name rule of a save or rename: `taken` holds the other profiles' names (any case). */
export function profileNameProblem(name: unknown, taken: readonly string[]): string | null {
  const bad = problemOf(PROFILE_LABEL_RULE, name);
  if (bad) return bad;
  const n = String(name).trim().toLowerCase();
  if (n === "off") return PROFILE_NAME_OFF;
  if (taken.some((t) => t.trim().toLowerCase() === n)) return PROFILE_NAME_TAKEN;
  return null;
}
