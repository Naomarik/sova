/** A profile's limits, read by Save Current As Profile and by the profile parse (shared/profiles.ts), in the same words. */
import type { TextRule } from "./form-rules";

export const PROFILE_LABEL_RULE: TextRule = { kind: "text", label: "Profile name", min: 1, max: 60, trim: true };
