import { AUTOMATIC_ABILITIES, type GatheringAbilities } from "../shared/baton";

/**
 * What a project's gathering sessions can do (§app.baton/abilities): draw, and read links someone
 * wrote in the conversation. Built like the coding mode (project-coding-mode.ts):
 *
 * - The project setting `gatheringAbilities`, or Automatic (null): draw on, read links off.
 * - Every start writes the set on the session's row. The operator may choose anything; an
 *   overseer (the project's or the global one) may turn either off and draw on, and read links
 *   on only when the project's set has it.
 * Pure.
 */

/** The optional `abilities` arg of a gathering start (§app.baton/abilities). */
export const ABILITIES_PARAM = {
  type: "object",
  properties: { draw: { type: "boolean" }, read_links: { type: "boolean" } },
  additionalProperties: false,
  description:
    "Optional: what the session can do, over the project's set (default: the project's). draw: it may draw a chart or layout on the person's page. read_links: it may open links people write in the conversation; you may turn it on only when the project allows it. Either may be turned off.",
};

export const READ_LINKS_REFUSED = "Reading links is off for this project's gathering sessions; the operator can allow it on the project page.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The base every gathering session starts from: the setting, else Automatic. */
export const baseAbilities = (setting: GatheringAbilities | null): GatheringAbilities => ({ ...(setting ?? AUTOMATIC_ABILITIES) });

/** A stored setting, tolerantly: anything unusable reads as null (Automatic). */
export function parseAbilities(raw: unknown): GatheringAbilities | null {
  if (!isObj(raw) || typeof raw.draw !== "boolean" || typeof raw.readLinks !== "boolean") return null;
  return { draw: raw.draw, readLinks: raw.readLinks };
}

/** A PATCH's `gatheringAbilities`, strictly: null (Automatic) or two booleans. */
export function checkAbilitiesPatch(v: unknown): GatheringAbilities | null | { error: string } {
  if (v === null) return null;
  const p = parseAbilities(v);
  return p ?? { error: "gatheringAbilities must be null (Automatic) or { draw, readLinks }, both true or false" };
}

/** The operator's choice on a start or on the strip (`{draw?, readLinks?}`), over `base`: anything
    goes, but each named field must be a boolean. */
export function operatorAbilities(v: unknown, base: GatheringAbilities): GatheringAbilities | { error: string } {
  if (v === undefined || v === null) return { ...base };
  if (!isObj(v)) return { error: "abilities must be { draw?, readLinks? }" };
  for (const k of ["draw", "readLinks"] as const)
    if (v[k] !== undefined && typeof v[k] !== "boolean") return { error: `abilities.${k} must be true or false` };
  return { draw: typeof v.draw === "boolean" ? v.draw : base.draw, readLinks: typeof v.readLinks === "boolean" ? v.readLinks : base.readLinks };
}

/** An overseer's `abilities` arg (`{draw?, read_links?}`) over the project's set, within its
    ceiling; a refusal sentence otherwise. Checked before anything is created or counted. */
export function overseerAbilities(v: unknown, base: GatheringAbilities): GatheringAbilities | { error: string } {
  if (v === undefined || v === null) return { ...base };
  if (!isObj(v)) return { error: "abilities must be { draw?, read_links? }" };
  for (const k of Object.keys(v)) if (k !== "draw" && k !== "read_links") return { error: `Unknown ability ${k}: use draw or read_links.` };
  for (const k of ["draw", "read_links"] as const)
    if (v[k] !== undefined && typeof v[k] !== "boolean") return { error: `abilities.${k} must be true or false` };
  const readLinks = typeof v.read_links === "boolean" ? v.read_links : base.readLinks;
  if (readLinks && !base.readLinks) return { error: READ_LINKS_REFUSED };
  return { draw: typeof v.draw === "boolean" ? v.draw : base.draw, readLinks };
}

/** "draw, read links" · "draw" · "read links" · "nothing extra": the words the project page and
    the overseers' prompts use. */
export const describeAbilities = (a: GatheringAbilities): string =>
  [a.draw ? "draw" : "", a.readLinks ? "read links" : ""].filter(Boolean).join(", ") || "nothing extra";
