import { stripVisComments, VIS_FILES, VIS_KIND_FILES, VIS_KINDS } from "../pi-config/extensions/mode/minor.ts";

/**
 * The drawing guide of a gathering session that can draw (§app.baton/abilities). Not the vis minor
 * mode (an outsider's session loads no mode): Sova's own opening and rules, then the vis guide's
 * mark syntax and the files of the kinds the share page draws, with their owner notes and stub
 * kinds stripped the same way (minor.ts), so the grammar taught is the renderer's.
 */

/** The kinds a share or owner page draws (src/share/vis.ts); frames and technical kinds never. */
export const SHARE_VIS_KINDS = ["flow", "chart", "matrix", "timeline", "tree", "steps", "wireframe", "layers"] as const;

const OPENING = `# Drawings

The person's page draws \`vis\` fences as small figures. When a picture would help the person see their own subject faster than prose (their figures side by side, the steps of their own work, a screen or layout they describe, as a \`wireframe\`), you may put ONE drawing in a reply: a fenced block whose info string is \`vis <kind>\`, with a one-line \`caption:\`, next to a sentence that says what to notice. Most replies need none. In a wireframe, use the person's own words and figures or a placeholder like "AED —"; never invent sample names or numbers.

Never draw people, roles, the roster, who decides what, who you might hand the conversation to, the goal, or how this conversation is run: those stay private, in drawings as in words. Every rule about what you may say applies to everything in a drawing (titles, labels, notes, captions). Only the kinds below are drawn; anything else shows the person "A drawing couldn't be shown here."`;

/** Every kind's `mark` targets in one line, under the mark syntax; each kind's own line is dropped from its section. */
const MARK_TARGETS = `- Targets: flow and state, a node's id or label; sequence, an actor, a message's "label" or its number (1 = the first message; notes and dividers don't count); code, a line or a range \`20-23\` as displayed; matrix, a row's criterion or a column's name; timeline, a row's when or label; wireframe, see its section; else a row's (layer's, item's) label.`;

/** The guide: the opening, the shared rules, the mark syntax, and one `## <kind>` section per share kind, in the vis list's order. */
export function gatheringVisGuide(files: Readonly<Record<string, string>> = VIS_FILES): string {
  const shared = stripVisComments(files.shared ?? "");
  const rules = /^(?:- .*\n?)+/m.exec(shared)?.[0];
  const mark = /^To point at what matters, .*$/m.exec(shared)?.[0];
  if (!rules || !mark) throw new Error("vis/shared.md: no rules list or mark paragraph");
  for (const kind of SHARE_VIS_KINDS) if (files[VIS_KIND_FILES[kind] ?? ""] === undefined) throw new Error(`vis/: no file for the gathering guide's kind ${kind}`);
  const sections = VIS_KINDS.filter((kind) => (SHARE_VIS_KINDS as readonly string[]).includes(kind)).map((kind) =>
    stripVisComments(files[VIS_KIND_FILES[kind]!]!)
      .replace(/^# vis (.*)$/m, "## $1")
      .replace(/^- `mark` targets: .*\n?/m, "")
      .trim(),
  );
  // Here a block that doesn't parse shows the person one quiet line, never its source. The vis mode
  // teaches "never nest" in its overview, which a gathering session doesn't get: so it goes here.
  const own = `Rules for every kind:\n${rules.trim()}\n- Never nest a \`vis\` fence in another fence.`.replace(/^- The parser is strict:.*$/m, "- The parser is strict: use only the syntax below, or the person sees no drawing at all.");
  return `${OPENING}\n\n${own}\n\n## Shared: emphasis\n${mark}\n${MARK_TARGETS}\n\n${sections.join("\n\n")}`;
}

let cached: string | undefined;
/** Built once, on the first session that draws. */
export const GATHERING_VIS_GUIDE = (): string => (cached ??= gatheringVisGuide());
