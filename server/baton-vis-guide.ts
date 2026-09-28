import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visPrompt } from "../pi-config/extensions/mode/minor.ts";

/**
 * The drawing guide of a gathering session that can draw (§app.baton/abilities). Not the vis minor
 * mode (an outsider's session loads no mode): Sova's own opening and rules, then the sections of
 * the mode's guide for the kinds the share page draws, with its owner notes and stub kinds stripped
 * the same way (`visPrompt`), so the grammar taught is the renderer's.
 */

/** The kinds a share or owner page draws (src/share/vis.ts); frames and technical kinds never. */
export const SHARE_VIS_KINDS = ["flow", "chart", "matrix", "timeline", "tree", "steps", "layers"] as const;

const GUIDE_FILE = join(import.meta.dirname, "..", "pi-config", "extensions", "mode", "vis-mode.md");

const OPENING = `# Drawings

The person's page draws \`vis\` fences as small figures. When a picture would help the person see their own subject faster than prose (their figures side by side, the steps of their own work, a screen or layout they describe), you may put ONE drawing in a reply: a fenced block whose info string is \`vis <kind>\`, with a one-line \`caption:\`, next to a sentence that says what to notice. Most replies need none.

Never draw people, roles, the roster, who decides what, who you might hand the conversation to, the goal, or how this conversation is run: those stay private, in drawings as in words. Every rule about what you may say applies to everything in a drawing (titles, labels, notes, captions). Only the kinds below are drawn; anything else shows the person "A drawing couldn't be shown here."`;

/** The guide for `md` (vis-mode.md's text): the opening, the shared rules, emphasis, and the kinds. */
export function gatheringVisGuide(md: string): string {
  const sections = md.split(/^(?=## )/m);
  const rules = /^Rules for every kind:\n(?:- .*\n?)+/m.exec(sections[0] ?? "")?.[0];
  if (!rules) throw new Error("vis-mode.md: no \"Rules for every kind:\" list in its opening");
  const keep = sections.filter((s) => {
    const heading = /^## (.*)$/m.exec(s)?.[1]?.trim() ?? "";
    return heading === "Shared: emphasis" || (SHARE_VIS_KINDS as readonly string[]).includes(heading);
  });
  if (keep.length !== SHARE_VIS_KINDS.length + 1) throw new Error("vis-mode.md: a section the gathering guide needs is missing");
  // Here a block that doesn't parse shows the person one quiet line, never its source.
  const own = rules.trim().replace(/^- The parser is strict:.*$/m, "- The parser is strict: use only the syntax below, or the person sees no drawing at all.");
  return `${OPENING}\n\n${own}\n\n${visPrompt(keep.join(""))}`;
}

let cached: string | undefined;
/** Read once, on the first session that draws. */
export const GATHERING_VIS_GUIDE = (): string => (cached ??= gatheringVisGuide(readFileSync(GUIDE_FILE, "utf8")));
