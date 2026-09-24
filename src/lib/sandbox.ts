import type { SandboxInfo } from "../../shared/protocol";

/** How the composer's shield reads: `ok` is calm ink, anything short of full enforcement is not. */
export type SandboxTone = "ok" | "warn" | "error";

export interface SandboxBadge {
  tone: SandboxTone;
  /** The word beside the shield when enforcement isn't full, so the state never rests on hue. */
  word: string | null;
  /** The extension's own status line, for the tooltip and the accessible name. */
  label: string;
}

/** The composer's shield (§chat.composer), or null when it hides: off, or no sandbox extension. */
export function sandboxBadge(info: SandboxInfo | null): SandboxBadge | null {
  if (!info?.on) return null;
  switch (info.enforcement) {
    case "full":
      return { tone: "ok", word: null, label: info.status };
    case "partial":
      return { tone: "warn", word: "Partial", label: info.status };
    case "unavailable":
      return { tone: "error", word: "Unavailable", label: info.status };
    default:
      // On but enforced by nothing here (a remote session's tools run on the target).
      return { tone: "warn", word: "Not enforced", label: info.status };
  }
}

/** The "+" menu's Sandbox row title: what a click does, or the state it's in. */
export function sandboxRowTitle(info: SandboxInfo): string {
  return info.on ? `${info.status}. Turning it off applies from the next tool call.` : "Confine this session's tools, from the next tool call.";
}
