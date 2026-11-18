/**
 * The `create_guide` tool: one topic of Create's guide, looked up before the chat acts on that topic
 * (create/guide.ts `createGuide`: create/shared.md, then the topic's file; or one section of the playbooks
 * topic's contents page, create/playbooks/<section>.md). It runs in this process,
 * never on a remote target, so it answers in any project and in any folder. The host (Sova's mode engine) owns
 * when the tool is in the loadout: only while the chat is in Create, so a worker never has it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "../subagents/string-enum.ts";
import { CREATE_GUIDE_NAMES, createGuide, PLAYBOOK_SECTION_NAMES, sandboxNote } from "./create/guide.ts";

export const CREATE_GUIDE_TOOL = "create_guide";

export const CREATE_GUIDE_DESCRIPTION =
	"Open one topic of Create's table of contents before acting on it: returns the rules every topic shares, then what the topic covers, each thing with what can be changed, where it lives, who approves it, how it changes, how it goes live and how to check it. The playbooks topic opens on its contents page; add `section` to open one of its sections.";

export const CREATE_GUIDE_PARAMETERS = Type.Object(
	{
		topic: StringEnum(CREATE_GUIDE_NAMES, { description: "The topic, as Create's table of contents lists it" }),
		// StringEnum is the subagents helper: a TypeBox schema, so Type.Optional() adds no "~optional" marker (P26).
		section: Type.Optional(StringEnum(PLAYBOOK_SECTION_NAMES, { description: "With topic playbooks: one section of its contents page" })),
	},
	{ additionalProperties: false },
);

export function createGuideTool() {
	return {
		name: CREATE_GUIDE_TOOL,
		label: "create guide",
		description: CREATE_GUIDE_DESCRIPTION,
		// No promptSnippet or guidelines: those would put the tool in the system prompt, which a mode switch
		// must not rewrite. The Create block names the tool.
		parameters: CREATE_GUIDE_PARAMETERS,
		async execute(_id: string, params: { topic: unknown; section?: unknown }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
			const topic = String(params.topic);
			const section = params.section === undefined || params.section === null ? undefined : String(params.section);
			const guide = createGuide(topic, section);
			let note: string | undefined;
			try {
				note = ctx ? sandboxNote(ctx.sessionManager.getBranch()) : undefined;
			} catch {
				note = undefined; // The guide still answers.
			}
			return { content: [{ type: "text" as const, text: note ? `${note}\n\n${guide}` : guide }], details: section ? { topic, section } : { topic } };
		},
	};
}

export function registerCreateGuideTool(pi: ExtensionAPI): void {
	pi.registerTool(createGuideTool());
}
