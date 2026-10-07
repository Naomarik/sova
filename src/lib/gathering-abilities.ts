import type { GatheringAbilities } from "../../shared/baton";

// What a gathering session can do (§app.baton/abilities), as the project page's select, the Start
// form and the baton strip name it (§design.copy-deck/gathering-abilities).

export type AbilitiesKey = "auto" | "draw" | "draw+links" | "links" | "none";
export const ABILITIES_KEYS: readonly AbilitiesKey[] = ["auto", "draw", "draw+links", "links", "none"];

const LABELS: Record<AbilitiesKey, string> = { auto: "Automatic", draw: "Draw", "draw+links": "Draw and read links", links: "Read links", none: "Neither" };
export const abilitiesLabel = (key: AbilitiesKey): string => LABELS[key];

export function abilitiesKey(a: GatheringAbilities | null): AbilitiesKey {
  if (!a) return "auto";
  return a.draw ? (a.readLinks ? "draw+links" : "draw") : a.readLinks ? "links" : "none";
}

/** The select's set; `drawHtml` is the separate checkbox's current value, carried over so a select
    change never silently clears it (Automatic has none). */
export function abilitiesOfKey(key: AbilitiesKey, drawHtml = false): GatheringAbilities | null {
  if (key === "auto") return null;
  return { draw: key === "draw" || key === "draw+links", readLinks: key === "links" || key === "draw+links", drawHtml };
}

/** Whether the project page's Interactive drawings checkbox can change: only while the select draws. */
export const drawHtmlSettable = (key: AbilitiesKey): boolean => key === "draw" || key === "draw+links";

/** "draw, read links" · "draw with interactive drawings" · "read links" · "nothing extra": the hint's words for a set. */
export const abilitiesWords = (a: GatheringAbilities): string =>
  [a.draw ? (a.drawHtml ? "draw with interactive drawings" : "draw") : "", a.readLinks ? "read links" : ""].filter(Boolean).join(", ") || "nothing extra";

const TOAST_WORD: Record<keyof GatheringAbilities, string> = { draw: "Drawing", drawHtml: "Interactive drawings", readLinks: "Reading links", files: "Receiving files" };
/** The strip's toast for one checkbox's change: it applies from the next reply. */
export const abilityToast = (which: keyof GatheringAbilities, on: boolean): string => `${TOAST_WORD[which]} ${on ? "on" : "off"} from its next reply.`;

/** The project page's toast for its Interactive drawings checkbox. */
export const drawHtmlSavedToast = (on: boolean): string => `Gathering sessions: interactive drawings ${on ? "on" : "off"}.`;
