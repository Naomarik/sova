import { AUTOMATIC_ABILITIES, type GatheringAbilities } from "../shared/baton";

/**
 * What a project's gathering sessions can do (§app.baton/abilities): draw, draw interactive
 * drawings (`vis html`, only with draw), and read links someone wrote in the conversation:
 *
 * - The project setting `gatheringAbilities`, or Automatic (null): draw on, read links and
 *   interactive drawings off.
 * - Every start writes the set on the session's row. The operator may choose anything; an
 *   overseer (the project's or the global one) may turn any off and draw on, and read links or
 *   interactive drawings on only when the project's set has them.
 * Pure.
 */

/** The optional `abilities` arg of a gathering start (§app.baton/abilities). */
export const ABILITIES_PARAM = {
  type: "object",
  properties: { draw: { type: "boolean" }, read_links: { type: "boolean" }, draw_html: { type: "boolean" } },
  additionalProperties: false,
  description:
    "Optional: what the session can do, over the project's set (default: the project's). draw: it may draw a chart or layout on the person's page. draw_html: with draw, it may also draw interactive drawings; you may turn it on only when the project allows it. read_links: it may open links people write in the conversation; you may turn it on only when the project allows it. Any may be turned off.",
};

export const READ_LINKS_REFUSED = "Reading links is off for this project's gathering sessions; the operator can allow it on the project page.";
export const DRAW_HTML_REFUSED = "Interactive drawings are off for this project's gathering sessions; the operator can allow them on the project page.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The base every gathering session starts from: the setting, else Automatic. */
export const baseAbilities = (setting: GatheringAbilities | null): GatheringAbilities => ({ ...(setting ?? AUTOMATIC_ABILITIES) });

/** A stored setting, tolerantly: anything unusable reads as null (Automatic); a missing `drawHtml`
    (a file from before it) reads as false. */
export function parseAbilities(raw: unknown): GatheringAbilities | null {
  if (!isObj(raw) || typeof raw.draw !== "boolean" || typeof raw.readLinks !== "boolean") return null;
  if (raw.drawHtml !== undefined && typeof raw.drawHtml !== "boolean") return null;
  return { draw: raw.draw, readLinks: raw.readLinks, drawHtml: raw.drawHtml === true };
}

/** A PATCH's `gatheringAbilities`, strictly: null (Automatic) or `{draw, readLinks, drawHtml?}`. */
export function checkAbilitiesPatch(v: unknown): GatheringAbilities | null | { error: string } {
  if (v === null) return null;
  const p = parseAbilities(v);
  return p ?? { error: "gatheringAbilities must be null (Automatic) or { draw, readLinks, drawHtml? }, each true or false" };
}

/** The operator's choice on a start or on the strip (`{draw?, readLinks?, drawHtml?, files?}`), over
    `base`: anything goes, but each named field must be a boolean. */
export function operatorAbilities(v: unknown, base: GatheringAbilities): GatheringAbilities | { error: string } {
  if (v === undefined || v === null) return { ...base };
  if (!isObj(v)) return { error: "abilities must be { draw?, readLinks?, drawHtml?, files? }" };
  for (const k of ["draw", "readLinks", "drawHtml", "files"] as const)
    if (v[k] !== undefined && typeof v[k] !== "boolean") return { error: `abilities.${k} must be true or false` };
  const pick = (k: keyof GatheringAbilities): boolean => (typeof v[k] === "boolean" ? (v[k] as boolean) : base[k] === true);
  // File intake (§app.baton/files) is the session's own: on only when asked for, or already on.
  return { draw: pick("draw"), readLinks: pick("readLinks"), drawHtml: pick("drawHtml"), ...(pick("files") ? { files: true } : {}) };
}

/** An overseer's `abilities` arg (`{draw?, read_links?, draw_html?}`) over the project's set,
    within its ceiling; a refusal sentence otherwise. Checked before anything is created or counted. */
export function overseerAbilities(v: unknown, base: GatheringAbilities): GatheringAbilities | { error: string } {
  if (v === undefined || v === null) return { ...base };
  if (!isObj(v)) return { error: "abilities must be { draw?, read_links?, draw_html? }" };
  for (const k of Object.keys(v)) if (k !== "draw" && k !== "read_links" && k !== "draw_html") return { error: `Unknown ability ${k}: use draw, draw_html or read_links.` };
  for (const k of ["draw", "read_links", "draw_html"] as const)
    if (v[k] !== undefined && typeof v[k] !== "boolean") return { error: `abilities.${k} must be true or false` };
  const readLinks = typeof v.read_links === "boolean" ? v.read_links : base.readLinks;
  if (readLinks && !base.readLinks) return { error: READ_LINKS_REFUSED };
  const drawHtml = typeof v.draw_html === "boolean" ? v.draw_html : base.drawHtml;
  if (drawHtml && !base.drawHtml) return { error: DRAW_HTML_REFUSED };
  return { draw: typeof v.draw === "boolean" ? v.draw : base.draw, readLinks, drawHtml };
}

/** "draw, read links" · "draw with interactive drawings" · "read links" · "nothing extra": the
    words the project page and the overseers' prompts use. */
export const describeAbilities = (a: GatheringAbilities): string =>
  [a.draw ? (a.drawHtml ? "draw with interactive drawings" : "draw") : "", a.readLinks ? "read links" : "", a.files ? "receive files" : ""].filter(Boolean).join(", ") || "nothing extra";

/** The overseers' `files` arg (§app.baton/files): file intake on for this one session; no project ceiling. */
export const FILES_PARAM = {
  type: "boolean",
  description:
    "Optional: true lets the person send files (any type, up to the host's largest file) with the paperclip; the session's model examines each with them and confirms it is what's needed. Say in the goal exactly what file you need and what a good one looks like (e.g. a JSON export newer than a date, with given fields). Then list them with sova_files.",
};

/** `abilities` with file intake set from an overseer's `files` arg (true turns it on; anything else leaves it off). */
export const withFiles = (a: GatheringAbilities, files: unknown): GatheringAbilities => (files === true ? { ...a, files: true } : a);
