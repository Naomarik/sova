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

export function abilitiesOfKey(key: AbilitiesKey): GatheringAbilities | null {
  if (key === "auto") return null;
  return { draw: key === "draw" || key === "draw+links", readLinks: key === "links" || key === "draw+links" };
}

/** "draw, read links" · "draw" · "read links" · "nothing extra": the hint's words for a set. */
export const abilitiesWords = (a: GatheringAbilities): string => [a.draw ? "draw" : "", a.readLinks ? "read links" : ""].filter(Boolean).join(", ") || "nothing extra";

/** The strip's toast for one checkbox's change: it applies from the next reply. */
export const abilityToast = (which: keyof GatheringAbilities, on: boolean): string => `${which === "draw" ? "Drawing" : "Reading links"} ${on ? "on" : "off"} from its next reply.`;
