/**
 * Settings → Mesh's two typed fields, checked the same way by the form (before Save) and by
 * `PUT /api/mesh/settings` (server/mesh/index.ts), so Save never sends what the server refuses
 * and a refusal reads like the form. Pure, no imports.
 */
export const HOST_LABEL_MAX = 80;

/** This host's name as typed: why it can't be saved, or null. */
export function hostLabelIssue(label: string): string | null {
  const t = label.trim();
  if (!t) return "This host needs a name.";
  if (t.length > HOST_LABEL_MAX) return `This host's name can be at most ${HOST_LABEL_MAX} characters.`;
  return null;
}

/** The front door as typed ("" is none): why it can't be saved, or null. The same rule as a peer
    URL (server/mesh/peers.ts checkUrl): http(s), host and port only. */
export function frontDoorIssue(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return "The front door must be a web address, like https://sova.example.ts.net.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The front door must start with http:// or https://.";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return "The front door is a scheme, host and port only, with no path.";
  return null;
}
