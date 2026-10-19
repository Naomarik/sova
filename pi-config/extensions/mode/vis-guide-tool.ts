/**
 * The `vis_guide` tool: the drawing rules for one `vis` kind, looked up when the model is about to draw
 * it (minor.ts `visGuide`: vis/shared.md, then that kind's file). It runs in this process, never on a
 * remote target, so it answers in every session the vis minor mode reaches. The host (index.ts) owns
 * when the tool is in the loadout (only while vis is on).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VIS_GUIDE_NAMES, visGuide } from "./minor.ts";

export const VIS_GUIDE_TOOL = "vis_guide";

export const VIS_GUIDE_DESCRIPTION =
	"Look up one vis catalogue entry before using it: a drawing kind returns shared rules then its syntax/examples; tour returns the core of the tool-backed tour workflow (not a fence); tour-signin, tour-sites, tour-sova and tour-sharing return the parts it names. html and svg share one guide.";

export const VIS_GUIDE_PARAMETERS = Type.Object(
	{ kind: StringEnum(VIS_GUIDE_NAMES, { description: "The drawing kind or tool-backed tour entry, as the vis minor mode lists it, or a part the tour guide names" }) },
	{ additionalProperties: false },
);

export function registerVisGuideTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: VIS_GUIDE_TOOL,
		label: "vis guide",
		description: VIS_GUIDE_DESCRIPTION,
		// No promptSnippet or guidelines: those would put the tool in the system prompt, and turning vis on
		// or off would rewrite it, which a minor toggle must never do. The vis block names the tool.
		parameters: VIS_GUIDE_PARAMETERS,
		async execute(_id, params) {
			const kind = String(params.kind);
			return { content: [{ type: "text" as const, text: visGuide(kind) }], details: { kind } };
		},
	});
}
