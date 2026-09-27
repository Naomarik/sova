import { ORG_ABOUT_MAX, type OrgChange } from "../../shared/orgs";

/** The About card's words (§app.organizations/about). Pure. */

/** What a history line did: a revert, the first text, a clearing, or an edit. */
export function aboutChangeWord(c: Pick<OrgChange, "from" | "to" | "revertOf">): "Reverted" | "Written" | "Cleared" | "Changed" {
  if (c.revertOf) return "Reverted";
  if (!c.from) return "Written";
  if (!c.to) return "Cleared";
  return "Changed";
}

/** The start of a text on one line, for a history row. */
export function aboutPreview(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "(empty)";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A version's length, so versions that start alike still differ in the list: "228 characters". */
export const aboutLength = (text: string): string => `${text.length.toLocaleString("en-US")} character${text.length === 1 ? "" : "s"}`;

/** The counter beside the field: "1,234 / 4,000". */
export const aboutCount = (text: string): string => `${text.length.toLocaleString("en-US")} / ${ORG_ABOUT_MAX.toLocaleString("en-US")}`;

/** A hand-edited file past the cap: only its start reaches the prompt. */
export const aboutOverCap = (text: string): boolean => text.length > ORG_ABOUT_MAX;
