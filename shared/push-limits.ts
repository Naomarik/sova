// Phone notifications: the rules both sides check (server/push-store.ts on every PUT, the Settings
// form before Save), in the same words (shared/form-rules.ts). Imports only types.
import type { CustomRule } from "./form-rules";

/** A quiet-hours time: "HH:MM", 24-hour. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The VAPID contact: `mailto:user@host.tld` or an `https://` URL with a host and no credentials; "" is none. */
export const CONTACT_RULE: CustomRule = {
  kind: "custom",
  label: "Contact address",
  issue(raw) {
    if (!raw) return null;
    if (raw.length > 200) return "The contact address is at most 200 characters.";
    if (/\s/.test(raw)) return "The contact address can't contain spaces.";
    if (raw.startsWith("mailto:")) return /^mailto:[^@/?#:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw) ? null : "A mailto: contact is one address, like mailto:you@example.com.";
    if (!raw.startsWith("https://")) return "The contact address starts with mailto: or https://.";
    try {
      const u = new URL(raw);
      if (u.username || u.password) return "An https: contact can't carry a user name or password.";
      return u.hostname.includes(".") ? null : "An https: contact needs a full host name.";
    } catch {
      return "The contact address isn't a valid URL.";
    }
  },
};
