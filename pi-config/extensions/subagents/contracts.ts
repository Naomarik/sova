/** Shared, versioned backend contract. No runtime dependency on either runner. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentStatus, AgentUsage, SpawnOptions, SteerResult, TaskOutcome, TranscriptItem } from "./runner.ts";
export type { AgentStatus, AgentUsage, SpawnOptions, SteerResult, TaskOutcome, TranscriptItem } from "./runner.ts";

export type SteerMode = "redirect" | "followUp";
export interface Worker {
	readonly backend?: string;
	readonly id: string;
	readonly groupId: string;
	readonly name: string;
	readonly task: string;
	readonly cwd: string;
	readonly wake: boolean;
	readonly extensions: readonly string[];
	readonly forked: boolean;
	/**
	 * What `usage` covers. "process" (the default): only what this process spent, so a resumed
	 * worker's earlier spend is added on top by the manager. "session": the backend reports its
	 * whole backend session cumulatively, resumed history included (Claude Code's modelUsage and
	 * total_cost_usd under --resume), so nothing may be added on top of it.
	 */
	readonly usageScope?: "process" | "session";
	readonly startedAt: number;
	readonly whenClosed: Promise<void>;
	pid?: number;
	status: AgentStatus;
	taskOutcome?: TaskOutcome;
	processAlive: boolean;
	model?: string;
	effort?: string;
	sessionId?: string;
	sessionFile?: string;
	transcript: TranscriptItem[];
	transcriptRevision: number;
	transcriptOmitted: { items: number; approxBytes: number };
	usage: AgentUsage;
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	endedAt?: number;
	lastActivity: number;
	steerCount: number;
	unreadCount: number;
	isFinished(): boolean;
	isSettled(): boolean;
	/**
	 * Teardown is in flight (kill, dispose, or fatal fail) or the process already
	 * exited, but the worker is not yet finished: steering will be rejected.
	 * Status alone cannot say this — a fatal failure reports "error" while the
	 * process is still being torn down. Optional for older backends.
	 */
	isStopping?(): boolean;
	finalOutput(): string;
	steer(message: string, signal?: AbortSignal, mode?: SteerMode): Promise<SteerResult>;
	/**
	 * Termination contract: whenClosed resolves (and isFinished() becomes true)
	 * only after the owned process is confirmed gone. kill()/dispose() should
	 * resolve at that point too, but the manager does not rely on it: it releases
	 * ownership (live-cap slot, shutdown disposal) only at whenClosed.
	 */
	kill(reason?: string): Promise<void>;
	dispose(): Promise<void>;
}
export interface WorkerHandlers {
	onChange(): void;
	onSettled(worker: Worker): void;
	onExit(worker: Worker): void;
}
export type WorkerFactory = (options: SpawnOptions, handlers: WorkerHandlers) => Worker;
/** Raw backend-specific options. Validation must finish before any batch worker starts. */
export interface BackendSpec {
	prompt: string;
	backend?: string;
	name?: string;
	count?: number;
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	agentType?: string;
	cwd?: string;
	wake?: boolean;
	extensions?: string[];
	fork?: boolean;
	backendOptions?: Record<string, unknown>;
}
export interface BackendModel {
	id: string;
	name: string;
	description?: string;
	efforts?: string[];
	resolvedModel?: string;
	/** Model accepts image input. Absent when the backend cannot report it. */
	vision?: boolean;
}
export interface BackendRegistration {
	version: 1;
	id: string;
	/** Discover backend-native choices without starting a model task. */
	listModels?(ctx: ExtensionContext, signal?: AbortSignal): Promise<BackendModel[]> | BackendModel[];
	/** Synchronous and side-effect free; throw for unsupported options. */
	validate(spec: BackendSpec, ctx: ExtensionContext): void;
	/** Resolve defaults/config without launching a worker. Called after validate. */
	prepare?(spec: BackendSpec, ctx: ExtensionContext): Partial<SpawnOptions>;
	create: WorkerFactory;
}
export const BACKEND_REGISTER_EVENT = "subagents:backend-register";
export const BACKEND_DISCOVER_EVENT = "subagents:backend-discover";
/** Emit around the actual blocking dialog, not while waiting in a permission queue.
 * Tokens must be unique per dialog; always emit open:false in finally.
 */
export const BACKEND_DIALOG_EVENT = "subagents:backend-dialog";
export interface BackendDialogEvent { version: 1; open: boolean; token: string }
export interface BackendDiscovery { version: 1 }
/** Announce now and answer future discovery, making either extension load order safe. */
export function registerBackend(events: ExtensionAPI["events"], backend: BackendRegistration): () => void {
	const off = events.on(BACKEND_DISCOVER_EVENT, (data: unknown) => {
		if ((data as BackendDiscovery | undefined)?.version === 1) events.emit(BACKEND_REGISTER_EVENT, backend);
	});
	events.emit(BACKEND_REGISTER_EVENT, backend);
	return off;
}
