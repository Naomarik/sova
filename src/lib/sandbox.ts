import type { SandboxInfo } from "../../shared/protocol";
import type { IconName } from "../components/ui";

/** The three states (§chat.sandbox/states), loosest first. */
export type SandboxState = NonNullable<SandboxInfo["state"]>;

/** How the composer's shield reads: `ok` is calm ink, `off` the faint ghost, the rest are not calm. */
export type SandboxTone = "ok" | "off" | "warn" | "error";

export interface SandboxBadge {
  /** The glyph: its shape names the state, so the state never rests on hue. */
  icon: IconName;
  tone: SandboxTone;
  /** The word beside the shield when On's enforcement isn't full. */
  word: string | null;
  /** The extension's own status line, for the tooltip and the accessible name. */
  label: string;
}

/** The state a reported sandbox is in; a server that predates the three states sends only `on`. */
export function sandboxStateOf(info: SandboxInfo): SandboxState {
  return info.state ?? (info.on ? "on" : "subagents");
}

/** The composer's shield (§chat.composer/sandbox-shield), or null when the runtime has no sandbox extension. */
export function sandboxBadge(info: SandboxInfo | null): SandboxBadge | null {
  if (!info) return null;
  const label = info.status;
  switch (sandboxStateOf(info)) {
    case "off":
      return { icon: "shield-off", tone: "off", word: null, label };
    case "subagents":
      return { icon: "shield-partial", tone: "ok", word: null, label };
  }
  switch (info.enforcement) {
    case "full":
      return { icon: "shield-on", tone: "ok", word: null, label };
    case "partial":
      return { icon: "shield-on", tone: "warn", word: "Partial", label };
    case "unavailable":
      return { icon: "shield-on", tone: "error", word: "Unavailable", label };
    default:
      // On but enforced by nothing here (a remote session's tools run on the target).
      return { icon: "shield-on", tone: "warn", word: "Not enforced", label };
  }
}

const FROM_NOW = "Applies from the next tool call, and to subagents started or resumed from now.";

/** The Sandbox group's rows, in order (§design.copy-deck/sandbox). */
export const SANDBOX_ROWS: readonly { state: SandboxState; label: string; title: string }[] = [
  { state: "off", label: "Off", title: `Off: nothing is confined, neither this session's tools nor its subagents. ${FROM_NOW}` },
  { state: "subagents", label: "Subagents only", title: `Subagents only: this session's tools run unconfined; subagents in its worktrees write only there. ${FROM_NOW}` },
  { state: "on", label: "On", title: `On: this session and its subagents. ${FROM_NOW}` },
];

/** The web's own toast after a change (the extension's notify toasts its status line itself): only
    when Off was asked of a host whose server predates it, whose answer carries no state. */
export function sandboxOffMissing(asked: SandboxState, after: SandboxInfo): string | null {
  return asked === "off" && after.state === undefined ? `This host's Sova has no Off; its sandbox stays ${after.status}.` : null;
}
