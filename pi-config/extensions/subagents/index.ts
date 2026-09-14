/** Background RPC workers. Tools retain their names across extension upgrades. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type AgentGroup, AgentsModal } from "./modal.ts";
import { BUILTIN_TOOLS as BUILTIN_TOOL_NAMES, SubagentRunner, type SpawnOptions, type RunnerHandlers } from "./runner.ts";

const MAX_LIVE = 12;
const MAX_BATCH = 8;
const BUILTIN_TOOLS = new Set(BUILTIN_TOOL_NAMES);
const Effort = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const Count = Type.Integer({ minimum: 1, maximum: MAX_BATCH, default: 1 });
const Nonempty = Type.String({ minLength: 1 });
const AgentSpec = Type.Object(
	{
		prompt: Type.String({ minLength: 1, description: "Self-contained task; parent conversation is not copied." }),
		name: Type.Optional(Nonempty),
		count: Type.Optional(Count),
		model: Type.Optional(
			Type.String({ description: "Exact provider/model ID. Defaults to the parent's current model." }),
		),
		effort: Type.Optional(Effort),
		tools: Type.Optional(
			Type.Array(Nonempty, {
				description:
					"Built-in tool allowlist. [] disables all tools; omitted inherits the parent's active built-in tool names.",
			}),
		),
		systemPrompt: Type.Optional(Type.String()),
		agentType: Type.Optional(Type.String({ description: "Definition in ~/.pi/agent/agents/<name>.md. Must exist." })),
		cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to the parent cwd." })),
		wake: Type.Optional(
			Type.Boolean({
				description:
					"When the worker settles and you are idle, start a turn so you can act on the result. Default true; false only queues the result for your next turn.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Nonempty, {
				description:
					"Extension sources the child loads (path, npm:name, git:host/repo), e.g. [\"npm:pi-web-access\"] for web tools. Children load no extensions otherwise; this extension itself is refused.",
			}),
		),
		fork: Type.Optional(
			Type.Boolean({
				description:
					"Start the child from a copy of this conversation's full history instead of a fresh context. Requires a persisted parent session.",
			}),
		),
	},
	{ additionalProperties: false },
);
/** This extension's own directory; a child must never load it, or it could spawn recursively. */
const SELF_DIR = realpathOr(path.dirname(fileURLToPath(import.meta.url)));

function realpathOr(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Map an `npm:` or `git:` source to Pi's already-installed user-scope copy, if
 * there is one. Passing the remote form to `-e` makes Pi install it again into a
 * temporary scope on every child start (measured: ~6s and a network round-trip);
 * the installed directory loads the same package manifest instantly.
 */
export function installedPackageDir(source: string, agentDir: string): string | undefined {
	let candidate: string | undefined;
	if (source.startsWith("npm:")) {
		// npm:name, npm:name@1.2.3, npm:@scope/name, npm:@scope/name@1.2.3
		const spec = source.slice(4).trim();
		const at = spec.indexOf("@", 1);
		const name = at === -1 ? spec : spec.slice(0, at);
		if (name && !name.includes("..")) candidate = path.join(agentDir, "npm", "node_modules", name);
	} else if (source.startsWith("git:")) {
		// git:host/owner/repo → <agentDir>/git/host/owner/repo
		const spec = source.slice(4).trim().replace(/\.git$/, "");
		if (spec && !spec.split("/").some((part) => !part || part === "..")) candidate = path.join(agentDir, "git", spec);
	}
	return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

/** Validate one child extension source: remote sources pass through (installed copy preferred); local paths must exist and must not be this extension. */
function resolveExtensionSource(source: string, cwd: string): string {
	if (/^(npm|git):/.test(source)) return installedPackageDir(source, getAgentDir()) ?? source;
	const resolved = resolvePath(source, cwd);
	if (!fs.existsSync(resolved)) throw new Error(`Extension source not found: ${resolved}`);
	const real = realpathOr(resolved);
	if (real === SELF_DIR || real.startsWith(SELF_DIR + path.sep))
		throw new Error(`Refusing to load the subagents extension into a child (${source}); children do not nest.`);
	return resolved;
}
type Spec = Static<typeof AgentSpec>;
type RunnerFactory = (options: SpawnOptions, handlers: RunnerHandlers) => SubagentRunner;

function resolvePath(value: string, cwd: string): string {
	const raw = value.startsWith("@") ? value.slice(1) : value;
	return path.resolve(
		cwd,
		raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw,
	);
}

function loadDefinition(name: string): { systemPrompt: string; model?: string } {
	if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Invalid agentType name.");
	const file = path.join(getAgentDir(), "agents", `${name}.md`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`Cannot read agent definition ${file}: ${(error as Error).message}`);
	}
	const { frontmatter, body } = parseFrontmatter<{ model?: unknown }>(raw);
	if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
		throw new Error(`Agent definition ${file}: model must be a string.`);
	}
	return { systemPrompt: body, model: frontmatter.model as string | undefined };
}

/** All tool text is capped; the caller can read the complete snapshot using read. */
export function boundedText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: 50 * 1024, maxLines: 2000 });
	if (!truncated.truncated) return text;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-"));
	const file = path.join(dir, "output.txt");
	fs.writeFileSync(file, text, { mode: 0o600 });
	return `${truncated.content}\n\n[Output truncated at 50KB/2000 lines. Full snapshot: ${file}]`;
}

const result = (text: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: boundedText(text) }],
	details,
});

/** Factory injection is for offline lifecycle/tool tests; normal Pi loading uses the default export. */
export function registerSubagents(
	pi: ExtensionAPI,
	createRunner: RunnerFactory = (o, h) => new SubagentRunner(o, h),
): void {
	const agents: SubagentRunner[] = [];
	const groups: AgentGroup[] = [];
	let counter = 0;
	let groupCounter = 0;
	let activeCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	let modal: AgentsModal | undefined;
	let renderModal: (() => void) | undefined;
	let closeModal: (() => void) | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;

	const live = () => agents.filter((a) => !a.isFinished());
	const findAgent = (id: string) => {
		const exact = agents.find((a) => a.id === id);
		if (exact) return exact;
		const named = agents.filter((a) => a.name === id);
		if (named.length > 1)
			throw new Error(`Ambiguous name ${id}; use an agent ID: ${named.map((a) => a.id).join(", ")}`);
		if (!named.length) throw new Error(`No such subagent: ${id}`);
		return named[0];
	};
	const findGroup = (id: string) => {
		const exact = groups.find((g) => g.id === id);
		if (exact) return exact;
		const named = groups.filter((g) => g.label === id);
		if (named.length !== 1) throw new Error(`${named.length ? "Ambiguous" : "No such"} run: ${id}; use its run ID.`);
		return named[0];
	};
	const context = (ctx: ExtensionContext) => {
		if (shuttingDown) throw new Error("Subagent extension is shutting down.");
		activeCtx = ctx;
	};
	const refresh = () => {
		if (shuttingDown) return;
		try {
			if (activeCtx?.hasUI) {
				const working = agents.filter((a) => !a.isSettled()).length;
				const idle = live().length - working;
				activeCtx.ui.setStatus(
					"subagents",
					live().length ? `◆ ${working} working · ${Math.max(0, idle)} idle` : undefined,
				);
			}
			modal?.invalidate();
			renderModal?.();
		} catch {
			/* The old session may have been invalidated during replacement. */
		}
	};
	// A streamed child can emit many events per token; never render every event.
	const scheduleRefresh = () => {
		if (shuttingDown || refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			refresh();
		}, 100);
		refreshTimer.unref?.();
	};
	const summary = (a: SubagentRunner) =>
		[
			`### ${a.id} (${a.name}) — ${a.status}${a.taskOutcome ? ` · task ${a.taskOutcome}` : ""}`,
			a.error ? `Error: ${a.error}` : "",
			a.sessionFile ? `Session: ${a.sessionFile}` : "",
			a.finalOutput() || "(no output for this task)",
		]
			.filter(Boolean)
			.join("\n");
	const onSettled = (a: SubagentRunner) => {
		scheduleRefresh();
		if (shuttingDown || !activeCtx) return;
		const failed =
			Boolean(a.error) ||
			a.taskOutcome === "error" ||
			a.taskOutcome === "aborted" ||
			a.status === "error" ||
			a.status === "killed";
		const verb = a.status === "killed" ? "stopped" : failed ? "failed" : "finished";
		try {
			if (!["tui", "rpc"].includes(activeCtx.mode)) return;
			activeCtx.ui.notify(`Subagent ${a.name} (${a.id}) ${verb}.`, failed ? "warning" : "info");
			const text = summary(a);
			// A worker the parent stopped itself does not need to wake the parent.
			const wake = a.wake && a.status !== "killed";
			pi.sendMessage(
				{
					customType: "subagent-complete",
					display: true,
					content: text.length > 4000 ? `${text.slice(0, 4000)}\n[Use agent_transcript for more.]` : text,
				},
				{ deliverAs: "followUp", triggerTurn: wake },
			);
		} catch {
			/* Session replacement can invalidate both APIs. */
		}
	};

	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Subagents",
		description:
			"Start independent background Pi agents; returns IDs without waiting for their tasks. Use agent_list/agent_transcript to inspect, agent_steer to redirect, agent_kill to stop, agent_wait only when results are needed. A settled worker wakes you when you are idle (wake=true, default). Children share the filesystem; fork=true copies this conversation's history into the child, otherwise it starts fresh. Children load no extensions unless listed in extensions.",
		promptSnippet: "Spawn background subagents (non-blocking) and manage them by id",
		promptGuidelines: [
			"Use agent_spawn to parallelise independent work; it returns immediately and does not block you.",
			"Use agent_wait only when you genuinely need a subagent's result before continuing; by default a finished subagent wakes you with its result when you are idle.",
			"Pass extensions: [\"npm:pi-web-access\"] when a subagent needs web tools; pass fork: true when it needs this conversation's context.",
		],
		parameters: Type.Object(
			{
				...AgentSpec.properties,
				prompt: Type.Optional(Nonempty),
				agents: Type.Optional(Type.Array(AgentSpec, { minItems: 1, maxItems: MAX_BATCH })),
				groupLabel: Type.Optional(Nonempty),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			if (Boolean(params.agents) === Boolean(params.prompt))
				throw new Error("Provide exactly one of agents or prompt.");
			if (
				params.agents &&
				[
					params.name,
					params.count,
					params.model,
					params.effort,
					params.tools,
					params.systemPrompt,
					params.agentType,
					params.cwd,
					params.wake,
					params.extensions,
					params.fork,
				].some((x) => x !== undefined)
			) {
				throw new Error("Shorthand options cannot be combined with agents; put them inside each agent spec.");
			}
			const specs: Spec[] = params.agents ?? [{ ...params, prompt: params.prompt! }];
			const total = specs.reduce((sum, s) => sum + (s.count ?? 1), 0);
			if (
				!Number.isInteger(total) ||
				total < 1 ||
				total > MAX_BATCH ||
				specs.some((s) => !Number.isInteger(s.count ?? 1) || (s.count ?? 1) < 1)
			) {
				throw new Error(`Counts must be positive integers; at most ${MAX_BATCH} agents per call.`);
			}
			if (live().length + total > MAX_LIVE)
				throw new Error(
					`Live-agent cap is ${MAX_LIVE} (${live().length} alive, including idle workers). Kill some first.`,
				);
			// Validate the whole batch before starting any child.
			const prepared = specs.map((spec) => {
				if (!spec.prompt.trim()) throw new Error("Task must not be blank.");
				const definition = spec.agentType !== undefined ? loadDefinition(spec.agentType) : undefined;
				const cwd = resolvePath(spec.cwd ?? ctx.cwd, ctx.cwd);
				if (!fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
				const model =
					spec.model ?? definition?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
				if (model !== undefined) {
					const slash = model.indexOf("/");
					if (slash < 1 || !ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) {
						throw new Error(`Unknown model ${model}; use an exact provider/model ID.`);
					}
				}
				if (spec.tools?.some((t) => !BUILTIN_TOOLS.has(t)))
					throw new Error(`Only built-in child tools are supported: ${[...BUILTIN_TOOLS].join(", ")}`);
				const tools = spec.tools ?? pi.getActiveTools().filter((name) => BUILTIN_TOOLS.has(name));
				const extensions = spec.extensions?.map((source) => resolveExtensionSource(source, ctx.cwd));
				let forkSession: string | undefined;
				if (spec.fork) {
					forkSession = ctx.sessionManager.getSessionFile();
					if (!forkSession || !fs.existsSync(forkSession))
						throw new Error("fork requires a persisted parent session; this session has no session file yet.");
				}
				return {
					spec,
					cwd,
					model,
					tools,
					extensions,
					forkSession,
					systemPrompt: [definition?.systemPrompt, spec.systemPrompt].filter(Boolean).join("\n\n") || undefined,
				};
			});
			const groupId = `run_${String(++groupCounter).padStart(2, "0")}`;
			// Reserve IDs durably before starting processes. Reload must never reuse an
			// ID still present in the conversation for an unrelated new worker.
			pi.appendEntry("subagents-counters-v2", { agentCounter: counter + total, groupCounter });
			const label = params.groupLabel ?? `run ${groupCounter} · ${specs[0].name ?? specs[0].agentType ?? "agents"}`;
			const group: AgentGroup = { id: groupId, label, createdAt: Date.now(), agents: [] };
			groups.push(group);
			for (const { spec, cwd, model, tools, systemPrompt, extensions, forkSession } of prepared) {
				for (let i = 0; i < (spec.count ?? 1); i++) {
					const base = spec.name ?? spec.agentType ?? "agent";
					const runner = createRunner(
						{
							id: `ag_${String(++counter).padStart(2, "0")}`,
							groupId,
							name: (spec.count ?? 1) > 1 ? `${base}-${i + 1}` : base,
							task: spec.prompt,
							model,
							effort: spec.effort ?? ctx.thinkingLevel,
							tools,
							systemPrompt,
							cwd,
							wake: spec.wake ?? true,
							extensions,
							forkSession,
						},
						{ onChange: scheduleRefresh, onSettled, onExit: scheduleRefresh },
					);
					agents.push(runner);
					group.agents.push(runner);
				}
			}
			refresh();
			return result(
				[
					`Started ${group.agents.length} background subagent(s) in ${groupId} (${label}). Task acceptance is asynchronous; inspect status for startup failures.`,
					...group.agents.map(
						(a) =>
							`${a.id}  ${a.name}  ${a.status}  model=${a.model ?? "child default"}  effort=${a.effort ?? "default"}${a.forked ? "  forked" : ""}${a.extensions.length ? `  extensions=${a.extensions.join(",")}` : ""}${a.wake ? "" : "  wake=false"}`,
					),
					"You are not blocked. Inspect with agent_list/agent_transcript; /agents opens the monitor.",
					group.agents.some((a) => a.wake)
						? "Workers with wake (the default) start a turn for you when they settle while you are idle, so you can simply end this turn."
						: "wake=false: results arrive with your next turn; use agent_wait if you need them sooner.",
				].join("\n"),
				{ groupId, label, spawned: group.agents.map((a) => ({ id: a.id, name: a.name, model: a.model })) },
			);
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "List Subagents",
		description:
			"List subagents grouped by run, with status, model and usage. Output capped at 50KB/2000 lines with full snapshot path.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			context(ctx);
			return result(
				groups.length
					? groups
							.map((g) =>
								[
									`${g.id} — ${g.label}`,
									...g.agents.map(
										(a) =>
											`  ${a.id} ${a.name} ${a.status}${a.taskOutcome ? `/${a.taskOutcome}` : ""} ${a.model ?? "child default"} · ${a.usage.turns} turns · ↑${a.usage.input} ↓${a.usage.output}${a.error ? ` · error: ${a.error}` : ""}`,
									),
								].join("\n"),
							)
							.join("\n\n") +
							"\n\nwaiting = idle and steerable (check task outcome); stopping = terminating; done/killed = process ended; error = failure (cleanup may still be in progress)."
					: "No subagents have been spawned.",
				{
					agents: agents.map((a) => ({
						id: a.id,
						groupId: a.groupId,
						name: a.name,
						status: a.status,
						taskOutcome: a.taskOutcome,
						processAlive: a.processAlive,
						settled: a.isSettled(),
						model: a.model,
						sessionFile: a.sessionFile,
						sessionId: a.sessionId,
						error: a.error,
						usage: { ...a.usage },
					})),
				},
			);
		},
	});
	pi.registerTool({
		name: "agent_transcript",
		label: "Read Subagent",
		description:
			"Read current-task output, or retained transcript with full=true. Output capped at 50KB/2000 lines with snapshot path; sessionFile holds canonical history.",
		parameters: Type.Object({ id: Nonempty, full: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			const a = findAgent(params.id);
			return result(
				params.full
					? `${a.id} (${a.name}) — ${a.status}\nSession: ${a.sessionFile ?? "not yet available"}\n\n${a.transcript.map((t) => `[${t.kind}${t.toolName ? `:${t.toolName}` : ""}] ${t.text}`).join("\n")}`
					: summary(a),
				{
					id: a.id,
					status: a.status,
					taskOutcome: a.taskOutcome,
					error: a.error,
					sessionFile: a.sessionFile,
					usage: { ...a.usage },
				},
			);
		},
	});
	pi.registerTool({
		name: "agent_steer",
		label: "Steer Subagent",
		description:
			"Send new instructions to a live subagent. Waits for RPC acceptance, not task completion; idle workers start a fresh task.",
		parameters: Type.Object({ id: Nonempty, message: Nonempty }),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			if (!params.message.trim()) throw new Error("Instructions must not be blank.");
			const a = findAgent(params.id);
			const accepted = await a.steer(params.message);
			if (!accepted.ok) throw new Error(`Cannot steer ${a.id}: ${accepted.reason}`);
			return result(`Accepted new instructions for ${a.id} (${a.name}).`, { id: a.id, steerCount: a.steerCount });
		},
	});
	pi.registerTool({
		name: "agent_kill",
		label: "Kill Subagent",
		description: "Stop one subagent, one run, or all live subagents. Waits for child termination.",
		parameters: Type.Object({
			id: Type.Optional(Nonempty),
			group: Type.Optional(Nonempty),
			all: Type.Optional(Type.Boolean()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			if ([Boolean(params.id), Boolean(params.group), params.all === true].filter(Boolean).length !== 1)
				throw new Error("Provide exactly one of id, group, or all:true.");
			const targets = params.id ? [findAgent(params.id)] : params.group ? findGroup(params.group).agents : live();
			await Promise.all(targets.map((a) => a.kill(params.reason ?? "stopped by the main agent")));
			refresh();
			return result(targets.map((a) => `${a.id} (${a.name}) — ${a.status}`).join("\n") || "No live subagents.", {
				killed: targets.map((a) => a.id),
			});
		},
	});
	pi.registerTool({
		name: "agent_wait",
		label: "Wait For Subagents",
		description:
			"Wait for current tasks, not child process exits. Failed tasks also settle; inspect each error. Timeout/cancellation does not stop workers. Output capped at 50KB/2000 lines with full snapshot path.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Nonempty, { minItems: 1 })),
			group: Type.Optional(Nonempty),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600, default: 600 })),
		}),
		async execute(_id, params, signal, update, ctx) {
			context(ctx);
			if (params.ids && params.group) throw new Error("Provide ids or group, not both.");
			const targets = params.ids
				? [...new Set(params.ids.map(findAgent))]
				: params.group
					? [...findGroup(params.group).agents]
					: agents.filter((a) => !a.isSettled());
			if (!targets.length) return result("Nothing to wait for — all current tasks have settled.");
			const timeout = params.timeoutSeconds ?? 600;
			if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600)
				throw new Error("timeoutSeconds must be between 0 and 3600.");
			const deadline = Date.now() + timeout * 1000;
			while (!signal?.aborted && Date.now() < deadline && targets.some((a) => !a.isSettled())) {
				update?.(
					result(
						`Waiting: ${targets
							.filter((a) => !a.isSettled())
							.map((a) => a.id)
							.join(", ")}`,
					),
				);
				await new Promise<void>((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", finish);
						resolve();
					};
					const timer = setTimeout(finish, Math.min(500, Math.max(0, deadline - Date.now())));
					signal?.addEventListener("abort", finish, { once: true });
					if (signal?.aborted) finish();
				});
			}
			const outstanding = targets.filter((a) => !a.isSettled());
			const headline = signal?.aborted
				? "Cancelled wait; workers were not stopped."
				: outstanding.length
					? `Timed out; still working: ${outstanding.map((a) => a.id).join(", ")}`
					: "All requested tasks settled (not necessarily successfully).";
			return result([headline, ...targets.map(summary)].join("\n\n"), {
				cancelled: Boolean(signal?.aborted),
				timedOut: !signal?.aborted && outstanding.length > 0,
				waited: targets.map((a) => ({ id: a.id, status: a.status, taskOutcome: a.taskOutcome, error: a.error })),
			});
		},
	});

	async function openModal(ctx: ExtensionContext) {
		context(ctx);
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("The monitor requires Pi's interactive TUI.", "warning");
			return;
		}
		if (modal) return;
		try {
			await ctx.ui.custom<null>(
				(tui, theme, _keys, done) => {
					closeModal = () => done(null);
					renderModal = () => tui.requestRender();
					const view = new AgentsModal(tui, theme, {
						getGroups: () => groups,
						requestRender: renderModal,
						close: closeModal,
						killAgent: (id) => {
							void Promise.resolve(findAgent(id).kill("stopped from monitor")).catch(() => scheduleRefresh());
						},
						killGroup: (id) => {
							void Promise.all(findGroup(id).agents.map((a) => a.kill("run stopped from monitor"))).catch(() =>
								scheduleRefresh(),
							);
						},
					});
					modal = view;
					return view;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" } },
			);
		} finally {
			(modal as AgentsModal | undefined)?.dispose();
			modal = undefined;
			renderModal = undefined;
			closeModal = undefined;
		}
	}
	pi.registerCommand("agents", {
		description: "Open the background subagent monitor",
		handler: async (_args, ctx) => openModal(ctx),
	});
	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "subagents-counters-v2") {
				const data = entry.data as { agentCounter?: number; groupCounter?: number } | undefined;
				if (Number.isSafeInteger(data?.agentCounter)) counter = Math.max(counter, data!.agentCounter!);
				if (Number.isSafeInteger(data?.groupCounter)) groupCounter = Math.max(groupCounter, data!.groupCounter!);
			}
			// Migrate IDs from the previous extension's persisted spawn results too.
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "agent_spawn") {
				const data = entry.message.details as { groupId?: string; spawned?: { id?: string }[] } | undefined;
				const groupMatch = typeof data?.groupId === "string" ? /^run_(\d+)$/.exec(data.groupId) : null;
				if (groupMatch) groupCounter = Math.max(groupCounter, Number(groupMatch[1]));
				if (Array.isArray(data?.spawned))
					for (const item of data.spawned) {
						const match = typeof item?.id === "string" ? /^ag_(\d+)$/.exec(item.id) : null;
						if (match) counter = Math.max(counter, Number(match[1]));
					}
			}
		}
		refresh();
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		activeCtx = undefined;
		if (refreshTimer) clearTimeout(refreshTimer);
		try {
			closeModal?.();
		} catch {
			/* Already closed. */
		}
		modal?.dispose();
		modal = undefined;
		renderModal = undefined;
		closeModal = undefined;
		await Promise.all(agents.map((a) => a.dispose()));
		agents.length = 0;
		groups.length = 0;
	});
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	registerSubagents(pi);
}
