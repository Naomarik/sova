import { stripVisComments, VIS_FILES, VIS_KIND_FILES, VIS_KINDS } from "../pi-config/extensions/mode/minor.ts";

/**
 * The drawing guide of a gathering session that can draw (§app.baton/abilities). Not the vis minor
 * mode (an outsider's session loads no mode): Sova's own opening and rules, then the vis guide's
 * mark syntax and the files of the kinds the share page draws as figures, with their owner notes and
 * stub kinds stripped the same way (minor.ts), so the grammar taught is the renderer's. Then Sova's
 * own `svg` section (the page draws it as a static image) and, for a session that may draw
 * interactive drawings, an `html` section built from the guide's html/svg file. Two tiers, each
 * built once.
 */

/** The kinds a share or owner page draws as figures (src/share/markdown.ts); `svg` is an image,
    `html` a frame only with interactive drawings, `code` never. */
export const SHARE_VIS_KINDS = ["flow", "chart", "matrix", "timeline", "tree", "steps", "wireframe", "layers", "state", "sequence"] as const;

const OPENING = `# Drawings

The person's page draws \`vis\` fences as small figures. When a picture would help the person see their own subject faster than prose (their figures side by side, the steps of their own work, a screen or layout they describe, as a \`wireframe\`), you may put ONE drawing in a reply: a fenced block whose info string is \`vis <kind>\`, with a one-line \`caption:\`, next to a sentence that says what to notice. Most replies need none. In a wireframe, use the person's own words and figures or a placeholder like "AED —"; never invent sample names or numbers.

Never draw people, roles, the roster, who decides what, who you might hand the conversation to, the goal, or how this conversation is run: those stay private, in drawings as in words. Every rule about what you may say applies to everything in a drawing (titles, labels, notes, captions). Only the kinds below are drawn; anything else shows the person "A drawing couldn't be shown here."`;

/** Every kind's `mark` targets in one line, under the mark syntax; each kind's own line is dropped from its section. */
const MARK_TARGETS = `- Targets: flow and state, a node's id or label; sequence, an actor, a message's "label" or its number (1 = the first message; notes and dividers don't count); matrix, a row's criterion or a column's name; timeline, a row's when or label; wireframe, see its section; else a row's (layer's, item's) label. svg and html take no marks.`;

/** Said under the sequence section: its actors are what the person's work passes through. */
const SEQUENCE_ACTORS = "- Here a sequence's actors are systems or steps (an app, a bank, an inbox, \"Step 1\"), never people or roles.";

/** The guide's html/svg file, as the model reads it: its example and its colour line feed the sections below. */
function freeForm(files: Readonly<Record<string, string>>): { example: string; colours: string } {
  const text = stripVisComments(files[VIS_KIND_FILES.html ?? ""] ?? "");
  const example = /^```vis html\n[\s\S]*?^```$/m.exec(text)?.[0];
  const colours = /^- Colours only from the theme.*$/m.exec(text)?.[0];
  if (!example || !colours) throw new Error("vis/html-svg.md: no html example or colour line");
  return { example, colours };
}

const SVG_EXAMPLE = `\`\`\`vis svg
title: Two ways to the same total
caption: The second path skips the manual check.
<svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="13">
<rect width="320" height="120" rx="8" fill="#ffffff"/>
<circle cx="40" cy="60" r="18" fill="none" stroke="#2563eb" stroke-width="2"/>
<text x="40" y="64" text-anchor="middle" fill="#1f2937">In</text>
<path d="M60 50 C120 10 200 10 260 50" fill="none" stroke="#64748b" stroke-width="2"/>
<path d="M60 70 L260 70" fill="none" stroke="#2563eb" stroke-width="2"/>
<circle cx="280" cy="60" r="18" fill="none" stroke="#2563eb" stroke-width="2"/>
<text x="280" y="64" text-anchor="middle" fill="#1f2937">Out</text>
</svg>
\`\`\``;

/** svg: a static image (the page draws it as an <img>), so no script, motion or button. */
const svgSection = (): string => `## svg
Only when no kind above fits: one static picture the person's subject needs. \`vis svg\` is one \`<svg>\` with a \`viewBox\`, \`xmlns="http://www.w3.org/2000/svg"\` and no \`width\`, drawn as an image at its natural size and shrunk to fit a phone. Start with \`title:\` / \`caption:\` lines. Aim under 4K characters.
${SVG_EXAMPLE}
- It is shown as an image: no \`<script>\`, no animation, no buttons or links; nothing in it moves or responds.
- Give it its own light background (a first \`<rect>\` filling the viewBox) with dark text (\`#1f2937\`) and one or two plain colours: theme colours (\`var(--…)\`) don't reach an image.
- Nothing external: no linked images or fonts.`;

/** html: interactive, in a sandboxed frame on the person's page (only with interactive drawings). */
const htmlSection = (files: Readonly<Record<string, string>>): string => {
  const { example, colours } = freeForm(files);
  return `## html
Only when no kind above fits and the person would understand their own subject better by playing with it (a slider on their own figure, a Step button through their own process). \`vis html\` is a fragment (inline \`<style>\` and \`<script>\`, no \`<html>\`/\`<head>\`), run sandboxed in a frame on the person's page. Start with \`title:\` / \`caption:\` lines.
${example}
- Fit a phone first: 360px wide (flex-wrap, grid with \`fr\`), under about 500px tall.
- Aim under 4K characters.
- Nothing external: no external scripts, fonts, images or fetches. It has no network and no storage, and opens nothing.
- Nothing moves until the person clicks or presses a key in it: give motion a Play or Step button. No \`setTimeout\` loops.
- Never ask for a password, contact details or anything personal in an input.
- Every rule about what you may say applies to all text in the markup and the script too: labels, attributes, strings and comments.
${colours}`;
};

/** The guide: the opening, the shared rules, the mark syntax, one `## <kind>` section per kind the
    page draws as a figure (in the vis list's order), then svg, then html when `html`. */
export function gatheringVisGuide(files: Readonly<Record<string, string>> = VIS_FILES, opts: { html?: boolean } = {}): string {
  const shared = stripVisComments(files.shared ?? "");
  const rules = /^(?:- .*\n?)+/m.exec(shared)?.[0];
  const mark = /^To point at what matters, .*$/m.exec(shared)?.[0];
  if (!rules || !mark) throw new Error("vis/shared.md: no rules list or mark paragraph");
  for (const kind of SHARE_VIS_KINDS) if (files[VIS_KIND_FILES[kind] ?? ""] === undefined) throw new Error(`vis/: no file for the gathering guide's kind ${kind}`);
  const sections = VIS_KINDS.filter((kind) => (SHARE_VIS_KINDS as readonly string[]).includes(kind)).map((kind) => {
    const section = stripVisComments(files[VIS_KIND_FILES[kind]!]!)
      .replace(/^# vis (.*)$/m, "## $1")
      .replace(/^- `mark` targets: .*\n?/m, "")
      .trim();
    return kind === "sequence" ? `${section}\n${SEQUENCE_ACTORS}` : section;
  });
  // Here a block that doesn't parse shows the person one quiet line, never its source. The vis mode
  // teaches "never nest" in its overview, which a gathering session doesn't get: so it goes here.
  const own = `Rules for every kind:\n${rules.trim()}\n- Never nest a \`vis\` fence in another fence.`.replace(/^- The parser is strict:.*$/m, "- The parser is strict: use only the syntax below, or the person sees no drawing at all.");
  const free = [svgSection(), ...(opts.html ? [htmlSection(files)] : [])];
  return `${OPENING}\n\n${own}\n\n## Shared: emphasis\n${mark}\n${MARK_TARGETS}\n\n${[...sections, ...free].join("\n\n")}`;
}

const cached: { draw?: string; html?: string } = {};
/** Built once per tier, on the first session that draws (`html`: it may draw interactive drawings). */
export const GATHERING_VIS_GUIDE = (html = false): string =>
  html ? (cached.html ??= gatheringVisGuide(VIS_FILES, { html: true })) : (cached.draw ??= gatheringVisGuide());
