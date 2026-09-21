/** Claude Code CLI backend for the shared subagent manager. */
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKEND_DIALOG_EVENT, registerBackend, type BackendRegistration, type BackendSpec, type BackendModel } from "../subagents/contracts.ts";
import { ClaudeRunner, MAX_CLAUDE_INPUT_CHARS, type ClaudePermissionDecision, type ClaudePermissionRequest, type ClaudeSpawnOptions } from "./runner.ts";
import { parseClaudePolicy, validateClaudeEffort, validateClaudeModel, validateClaudeTools } from "./policy.ts";
import { discoverClaudeModels } from "./models.ts";
import { PermissionQueue } from "./permissions.ts";

function validate(spec: BackendSpec): void {
	// The runner would otherwise fail this asynchronously, after the batch started.
	if (spec.prompt.length > MAX_CLAUDE_INPUT_CHARS) {
		throw new Error(`Claude prompt is ${spec.prompt.length} characters; the limit is ${MAX_CLAUDE_INPUT_CHARS}. Put large context in a file and reference it.`);
	}
	if (spec.fork) throw new Error("Claude cannot fork a Pi conversation. Supply an explicit context handoff in prompt instead.");
	if (spec.extensions !== undefined) throw new Error("Pi extensions cannot be loaded into Claude Code workers.");
	if (spec.agentType !== undefined) throw new Error("Pi agentType definitions are not supported by Claude workers yet; use systemPrompt instead.");
	validateClaudeModel(spec.model);
	validateClaudeEffort(spec.effort);
	validateClaudeTools(spec.tools);
	parseClaudePolicy(spec.backendOptions);
}
const safeText = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");

/** Exported for offline registration/policy tests. No subprocess starts at extension load. */
export function registerClaudeCode(pi: ExtensionAPI): void {
	let stopped = false;
	let modelCache: { at: number; models: BackendModel[] } | undefined;
	const discoveries = new Set<AbortController>();
	/** Discovery processes whose closure is still owed; callers do not wait for it. */
	const discoveryClosures = new Set<Promise<void>>();
	const promptQueue = new PermissionQueue();
	// One handler per spec serves every count>1 instance, so identity comes from
	// the requesting worker, never from the shared spec.
	const permissionHandler = (ctx: ExtensionContext) =>
		(request: ClaudePermissionRequest, signal: AbortSignal): Promise<ClaudePermissionDecision> => {
			if (stopped || signal.aborted || !ctx.hasUI) return Promise.resolve({ behavior: "deny", message: "No interactive permission approval is available." });
			return promptQueue.run(signal, async (dialogSignal): Promise<ClaudePermissionDecision> => {
				if (stopped || dialogSignal.aborted) return { behavior: "deny", message: "Permission request cancelled before it was shown." };
				const input = safeText(JSON.stringify(request.input, null, 2));
				const message = `Worker: ${safeText(request.workerName)} (${safeText(request.workerId)})\nDirectory: ${safeText(request.cwd)}\n${safeText(request.toolName)}\n\n${input.slice(0, 6000)}${input.length > 6000 ? "\n[Input truncated; deny if you cannot verify this operation.]" : ""}\n\nAllow this operation once?`;
				const dialogToken = randomUUID();
				let dialogClosed = false;
				const closeDialog = () => {
					if (dialogClosed) return;
					dialogClosed = true;
					pi.events.emit(BACKEND_DIALOG_EVENT, { version: 1, open: false, token: dialogToken });
				};
				pi.events.emit(BACKEND_DIALOG_EVENT, { version: 1, open: true, token: dialogToken });
				dialogSignal.addEventListener("abort", closeDialog, { once: true });
				try {
					const allowed = await ctx.ui.confirm("Claude worker permission", message, { signal: dialogSignal, timeout: 60000 });
					if (allowed && !stopped && !dialogSignal.aborted) return { behavior: "allow", updatedInput: request.input };
				} catch { /* Closed/replaced UI denies rather than granting permission. */ }
				finally { dialogSignal.removeEventListener("abort", closeDialog); closeDialog(); }
				return { behavior: "deny", message: "Permission was denied, cancelled, or timed out. Do not retry the same operation." };
			});
		};
	const backend: BackendRegistration = {
		version: 1,
		id: "claude-code",
		async listModels(_ctx, signal) {
			signal?.throwIfAborted();
			if (stopped) throw new Error("Claude backend is shutting down.");
			if (modelCache && Date.now() - modelCache.at < 60000) return structuredClone(modelCache.models);
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			discoveries.add(controller);
			try {
				const models = await discoverClaudeModels(controller.signal, {
					trackClosure: (closed) => {
						discoveryClosures.add(closed);
						void closed.then(() => discoveryClosures.delete(closed));
					},
				});
				controller.signal.throwIfAborted();
				modelCache = { at: Date.now(), models };
				return structuredClone(models);
			} finally { discoveries.delete(controller); signal?.removeEventListener("abort", abort); }
		},
		validate,
		prepare(spec, ctx) {
			validate(spec);
			const options: Partial<ClaudeSpawnOptions> = {
				model: validateClaudeModel(spec.model),
				effort: validateClaudeEffort(spec.effort),
				tools: validateClaudeTools(spec.tools),
				systemPrompt: spec.systemPrompt,
				...parseClaudePolicy(spec.backendOptions),
				permissionTimeoutManagedByHost: true,
				onPermission: permissionHandler(ctx),
			};
			return options;
		},
		create(options, handlers) {
			if (stopped) throw new Error("Claude backend is shutting down.");
			return new ClaudeRunner(options as ClaudeSpawnOptions, handlers);
		},
	};
	// Seam: the optional top-level Claude provider (provider/) registers itself
	// here, flag-gated, with one call — the worker backend above is unaffected.
	const unregister = registerBackend(pi.events, backend);
	pi.on("session_shutdown", async () => {
		stopped = true; unregister(); modelCache = undefined;
		promptQueue.dispose();
		for (const controller of discoveries) controller.abort();
		// Like worker shutdown: await confirmed closure of discovery processes.
		await Promise.all(discoveryClosures);
	});
}
export default registerClaudeCode;
