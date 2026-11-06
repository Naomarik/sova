/**
 * Settings → Mesh's two typed fields, checked by the form (before Save) and by
 * `PUT /api/mesh/settings` (server/mesh/index.ts) with the same rules and words (shared/form-rules.ts).
 */
import type { CustomRule, TextRule } from "./form-rules";

export const HOST_LABEL_RULE: TextRule = { kind: "text", label: "This host's name", min: 1, max: 80, trim: true, empty: "This host needs a name." };

/** The same rule as a peer URL (server/mesh/peers.ts checkUrl): http(s), host and port only; "" is none. */
export const FRONT_DOOR_RULE: CustomRule = {
  kind: "custom",
  label: "Front door",
  issue(t) {
    let url: URL;
    try {
      if (!t) return null;
      url = new URL(t);
    } catch {
      return "The front door must be a web address, like https://sova.example.ts.net.";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "The front door must start with http:// or https://.";
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return "The front door is a scheme, host and port only, with no path.";
    return null;
  },
};
