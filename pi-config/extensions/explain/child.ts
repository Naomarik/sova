/**
 * The extension the /explain child loads (`-e child.ts`, after every other source; see worker.ts).
 * Inert anywhere else: it acts only when the parent set `EXPLAIN_STORE_ENV`.
 *
 * It keeps the fork on the parent's prompt cache and makes the child read-only, both without
 * changing a byte of the request prefix; the reasoning is in mirror.ts. In short:
 *
 *  - session_start: activate exactly the tools the parent's transcript declares, with the parent's
 *    declarations (own / wrapped built-in / stub), plus `read` and `write` if the parent lacked them;
 *  - before_agent_start: rebuild the system prompt from the parent's replayed sections;
 *  - tool_call: block every call except reading, web lookups, and writes inside the store;
 *  - context: drop the btw notes the parent's btw extension drops from its requests;
 *  - before_provider_request: ask OpenAI-style providers for the parent's cache key.
 */
import { resolve } from "node:path";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	applyMirror,
	declaredState,
	EXPLAIN_PARENT_SESSION_ENV,
	EXPLAIN_STORE_ENV,
	gateToolCall,
	mirrorPrompt,
	planTools,
	withoutBtwNotes,
	withParentCacheKey,
	type MirrorablePromptOptions,
	type PromptMirror,
	type ToolDeclaration,
} from "./mirror.ts";

/** Built-ins the child can re-register under the parent's declaration (its own implementation, the parent's words). */
const BUILTINS: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
	read: (cwd) => createReadToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
};

/**
 * The parent's declaration in full, `constrainedSampling` included: pi-ai compares it too, and
 * the built-in bash sets it, so a stub without it would redeclare the tool (seen live).
 */
function declared(declaration: ToolDeclaration): Pick<ToolDefinition, "description" | "parameters" | "constrainedSampling"> {
	return {
		description: declaration.description,
		parameters: declaration.parameters as ToolDefinition["parameters"],
		constrainedSampling: declaration.constrainedSampling as ToolDefinition["constrainedSampling"],
	};
}

function withDeclaration(base: ToolDefinition<any, any, any>, declaration: ToolDeclaration): ToolDefinition<any, any, any> {
	const tool: ToolDefinition<any, any, any> = { ...base, ...declared(declaration) };
	if (declaration.constrainedSampling === undefined) delete tool.constrainedSampling;
	return tool;
}

/** A declared tool that never runs; tool_call blocks it first, this is the backstop. */
function stub(declaration: ToolDeclaration): ToolDefinition<any, any, any> {
	const tool: ToolDefinition<any, any, any> = {
		name: declaration.name,
		label: declaration.name,
		...declared(declaration),
		async execute() {
			throw new Error(`"${declaration.name}" is not available in the /explain worker.`);
		},
	};
	if (declaration.constrainedSampling === undefined) delete tool.constrainedSampling;
	return tool;
}

export default function explainChildExtension(pi: ExtensionAPI): void {
	const storeDir = process.env[EXPLAIN_STORE_ENV]?.trim();
	if (!storeDir) return;
	const parentSessionId = process.env[EXPLAIN_PARENT_SESSION_ENV]?.trim() || undefined;
	let mirror: PromptMirror | undefined;
	let cwd = process.cwd();
	let sessionId: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		const state = declaredState(ctx.sessionManager.buildSessionProjection().messages);
		const own = new Map<string, ToolDeclaration>(pi.getAllTools().map((tool) => [tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters }]));
		const plan = planTools(state?.tools, own, new Set(Object.keys(BUILTINS)));
		for (const entry of plan) {
			if (entry.action === "wrap") pi.registerTool(withDeclaration(BUILTINS[entry.name]!(cwd), entry.declaration));
			else if (entry.action === "stub") pi.registerTool(stub(entry.declaration));
		}
		pi.setActiveTools(plan.map((entry) => entry.name));
		mirror = state ? mirrorPrompt(state.sections) : undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (mirror) applyMirror(event.systemPromptOptions as unknown as MirrorablePromptOptions, mirror);
	});

	pi.on("tool_call", (event) => {
		const reason = gateToolCall(event.toolName, event.input, storeDir, (...parts) => resolve(cwd, ...parts));
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("context", (event) => {
		const messages = withoutBtwNotes(event.messages as { role: string; customType?: string }[]);
		return messages ? { messages: messages as typeof event.messages } : undefined;
	});

	pi.on("before_provider_request", (event) => withParentCacheKey(event.payload, sessionId, parentSessionId));
}
