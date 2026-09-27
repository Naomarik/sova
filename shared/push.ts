// Phone notifications: the rules both sides check (server/push-store.ts on every PUT, the Settings
// form before Save). Imports nothing, so the browser bundle and the server share one copy.

export const CONTACT_MAX = 200;

/** A quiet-hours time: "HH:MM", 24-hour. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The VAPID contact: `mailto:user@host.tld` or an `https://` URL with a host and no credentials. The reason, or null. */
export function contactProblem(raw: string): string | null {
  if (raw.length > CONTACT_MAX) return `The contact address is at most ${CONTACT_MAX} characters.`;
  if (/\s/.test(raw)) return "The contact address can't contain spaces.";
  if (raw.startsWith("mailto:")) {
    return /^mailto:[^@/?#:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw) ? null : "A mailto: contact is one address, like mailto:you@example.com.";
  }
  if (raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      if (u.username || u.password) return "An https: contact can't carry a user name or password.";
      return u.hostname.includes(".") ? null : "An https: contact needs a full host name.";
    } catch {
      return "The contact address isn't a valid URL.";
    }
  }
  return "The contact address starts with mailto: or https://.";
}
