/**
 * The extension every background fork's child loads (`-e child.ts`, after every other source; see
 * background.ts). Inert anywhere else: it acts only when the parent set `FORK_POLICY_ENV`.
 *
 * It keeps the fork on the parent's prompt cache and holds the child to its policy, both without
 * changing a byte of the request prefix; the reasoning is in mirror.ts and cache.ts. In short:
 *
 *  - session_start: activate exactly the tools the parent's transcript declares, with the parent's
 *    declarations (own / wrapped built-in / stub), plus the tools the policy requires if the
 *    parent lacked them;
 *  - before_agent_start: rebuild the system prompt from the parent's replayed sections;
 *  - tool_call: block every call the policy does not allow (`gateToolCall`);
 *  - context: drop the btw notes the parent's btw extension drops from its requests;
 *  - before_provider_request and the process's Codex transport: ask for the cache key the fork
 *    copy inherited from the parent (cache.ts), exactly as a UI-created fork does.
 */
import { resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { forkCacheExtension, routeProcessForkCache, type ForkProcessState } from "./cache.ts";
import {
	applyMirror,
	declaredState,
	decodePolicy,
	FORK_POLICY_ENV,
	gateToolCall,
	mirrorPrompt,
	planTools,
	withoutBtwNotes,
	type ForkPolicy,
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
	bash: (cwd) => createBashToolDefinition(cwd),
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
function stub(declaration: ToolDeclaration, policy: ForkPolicy): ToolDefinition<any, any, any> {
	const tool: ToolDefinition<any, any, any> = {
		name: declaration.name,
		label: declaration.name,
		...declared(declaration),
		async execute() {
			throw new Error(`${policy.label} cannot run "${declaration.name}".`);
		},
	};
	if (declaration.constrainedSampling === undefined) delete tool.constrainedSampling;
	return tool;
}

export default function forkChildExtension(pi: ExtensionAPI): void {
	const policy = decodePolicy(process.env[FORK_POLICY_ENV]);
	if (!policy) return;
	let mirror: PromptMirror | undefined;
	let cwd = process.cwd();
	let session: { getSessionId(): string; getEntries(): ForkProcessState["entries"] } | undefined;

	forkCacheExtension(pi);
	// This process runs this one fork, so its own fetch and WebSocket carry only the fork's requests.
	routeProcessForkCache(() => (session ? { ownId: session.getSessionId(), entries: session.getEntries() } : undefined));

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		session = ctx.sessionManager;
		const state = declaredState(ctx.sessionManager.buildSessionProjection().messages);
		const own = new Map<string, ToolDeclaration>(pi.getAllTools().map((tool) => [tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters }]));
		const plan = planTools(state?.tools, own, new Set(Object.keys(BUILTINS)), policy);
		for (const entry of plan) {
			if (entry.action === "wrap") pi.registerTool(withDeclaration(BUILTINS[entry.name]!(cwd), entry.declaration));
			else if (entry.action === "stub") pi.registerTool(stub(entry.declaration, policy));
		}
		pi.setActiveTools(plan.map((entry) => entry.name));
		mirror = state ? mirrorPrompt(state.sections) : undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (mirror) applyMirror(event.systemPromptOptions as unknown as MirrorablePromptOptions, mirror);
	});

	pi.on("tool_call", (event) => {
		const reason = gateToolCall(event.toolName, event.input, policy, (...parts) => resolve(cwd, ...parts));
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("context", (event) => {
		const messages = withoutBtwNotes(event.messages as { role: string; customType?: string }[]);
		return messages ? { messages: messages as typeof event.messages } : undefined;
	});
}
