/**
 * The `create_guide` tool: one topic of Create's guide, looked up before the chat acts on that topic
 * (create/guide.ts `createGuide`: create/shared.md, then the topic's file). It runs in this process,
 * never on a remote target, so it answers in any project and in any folder. The host (index.ts) owns
 * when the tool is in the loadout: only while the chat is in Create, so a worker never has it.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CREATE_GUIDE_NAMES, createGuide } from "./create/guide.ts";

export const CREATE_GUIDE_TOOL = "create_guide";

export const CREATE_GUIDE_DESCRIPTION =
	"Open one topic of Create's table of contents before acting on it: returns the rules every topic shares, then what the topic covers, each thing with what can be changed, where it lives, who approves it, how it changes, how it goes live and how to check it.";

export const CREATE_GUIDE_PARAMETERS = Type.Object(
	{ topic: StringEnum(CREATE_GUIDE_NAMES, { description: "The topic, as Create's table of contents lists it" }) },
	{ additionalProperties: false },
);

export function registerCreateGuideTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: CREATE_GUIDE_TOOL,
		label: "create guide",
		description: CREATE_GUIDE_DESCRIPTION,
		// No promptSnippet or guidelines: those would put the tool in the system prompt, which a mode switch
		// must not rewrite. The Create block names the tool.
		parameters: CREATE_GUIDE_PARAMETERS,
		async execute(_id: string, params: { topic: unknown }) {
			const topic = String(params.topic);
			return { content: [{ type: "text" as const, text: createGuide(topic) }], details: { topic } };
		},
	});
}
