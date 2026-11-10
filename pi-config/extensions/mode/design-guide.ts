/**
 * The Lookbook's text Sova itself reads, once at load: the 20 directions (vis/lookbook-directions.md,
 * also a `vis_guide` part), a design session's system prompt and the coordinator's (design/ beside this
 * module). The main chat's guide is vis's: `vis_guide {kind:"lookbook"}` and its parts (minor.ts
 * VIS_TOOL_ENTRIES / VIS_TOOL_PARTS). Node builtins only: the server imports it. HTML comments (owner
 * notes) never reach a model. A missing file or a malformed direction line fails at load.
 */

import { readFileSync } from "node:fs";

const DIR = new URL("./design/", import.meta.url);
const VIS_DIR = new URL("./vis/", import.meta.url);

/** Owner notes out, ends trimmed: the text a model reads. */
function modelText(name: string, dir: URL = DIR): string {
	return readFileSync(new URL(name, dir), "utf8").replace(/<!--[\s\S]*?-->\n?/g, "").trim();
}

export interface DesignDirection {
	name: string;
	definition: string;
}

function parseDirections(md: string): DesignDirection[] {
	const directions = md
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.map((line) => {
			const parts = /^- ([^:]+): (.+)$/.exec(line);
			if (!parts) throw new Error(`vis/lookbook-directions.md: malformed line: ${line}`);
			return { name: parts[1]!, definition: parts[2]! };
		});
	if (directions.length !== 20) throw new Error(`vis/lookbook-directions.md: expected 20 directions, found ${directions.length}`);
	return directions;
}

/** The 20 directions, in the Setup card's order. */
export const DESIGN_DIRECTIONS: readonly DesignDirection[] = parseDirections(modelText("lookbook-directions.md", VIS_DIR));

/** The sets of 3 directions Setup starts from, one chosen at random. */
export const DESIGN_DEFAULT_DIRECTION_SETS: readonly (readonly string[])[] = [
	["Minimalist", "Bold & Vibrant", "Balanced"],
	["Clean & Modern", "Rich & Detailed", "Playful"],
	["Professional", "Creative", "Elegant"],
	["Dark & Moody", "Light & Airy", "High Contrast"],
	["Subtle & Refined", "Dynamic & Energetic", "Warm & Inviting"],
	["Technical", "Artistic", "Corporate"],
	["Heritage", "Immersive", "Minimalist"],
];

/**
 * The reply-route markers (a model marked no-tool-stream writes its page between them), each alone on
 * its line. Sova's decoder reads the same pair from shared/design.ts; a test keeps the two equal.
 */
export const DESIGN_PAGE_START = "<<<design-page>>>";
export const DESIGN_PAGE_END = "<<<end-design-page>>>";

const SESSION_BRIEF = modelText("session/brief.md");
const SESSION_TASK = {
	none: modelText("session/task-create.md"),
	screenshot: modelText("session/task-screenshot.md"),
	description: modelText("session/task-description.md"),
};
const SESSION_DELIVERY = {
	tool: modelText("session/delivery-tool.md"),
	reply: modelText("session/delivery-reply.md"),
};

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export interface DesignSessionPromptOptions {
	label: string;
	/** A name from DESIGN_DIRECTIONS. */
	direction: string;
	/** What the first message carries as the page to rebuild: nothing, screenshots, or a text outline (no vision). */
	reference: keyof typeof SESSION_TASK;
	/** `reply` for a model marked no-tool-stream. */
	delivery: keyof typeof SESSION_DELIVERY;
}

/** The direction of a design made from others: never offered on Setup; the message names the pages it draws on. */
export const DESIGN_MIXED_DIRECTION = { name: "Mixed", definition: "Draw on the designs in your first message, as it asks. Their strongest ideas, made into one coherent page, are your direction." };

/** A design session's system prompt. */
export function designSessionPrompt(options: DesignSessionPromptOptions): string {
	const direction = [...DESIGN_DIRECTIONS, DESIGN_MIXED_DIRECTION].find((d) => d.name === options.direction);
	if (!direction) throw new Error(`Unknown design direction "${options.direction}"`);
	const delivery = fill(SESSION_DELIVERY[options.delivery], { label: options.label, pageStart: DESIGN_PAGE_START, pageEnd: DESIGN_PAGE_END });
	return fill(SESSION_BRIEF, {
		task: SESSION_TASK[options.reference],
		delivery,
		direction: direction.name,
		definition: direction.definition,
	});
}

/** The coordinator session's system prompt. */
export const DESIGN_COORDINATOR_PROMPT = modelText("coordinator.md");
