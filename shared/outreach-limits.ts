/**
 * Settings → Outreach's typed boxes, checked by the form (src/lib/outreach.ts) and by the save
 * (server/outreach/settings.ts) with the same rules and words (shared/form-rules.ts).
 */
import type { CustomRule, TextRule } from "./form-rules";

/** A number's label: at most 24 characters ("" is none on the form, refused by the file). */
export const SENDER_LABEL_RULE: TextRule = { kind: "text", label: "Label", max: 24, trim: true };

/** A sender's socket path: absolute; "" is the sender's own. */
export const SOCKET_RULE: CustomRule = { kind: "custom", label: "Socket", issue: (t) => (t && !t.startsWith("/") ? "The socket path must be absolute." : null) };
/** An added number's name. */
export const NUMBER_NAME_RULE: CustomRule = {
  kind: "custom",
  label: "Name",
  issue: (t) => (/^[a-z0-9][a-z0-9-]{0,31}$/.test(t) ? null : "A number's name is lowercase letters, digits and dashes, at most 32."),
};
