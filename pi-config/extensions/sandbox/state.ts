/**
 * Pure sandbox-state handling. No pi imports and node builtins only: unit-testable with
 * node --test, and importable by Sova's server later (like mode/state.ts), so it must stay
 * runtime-free.
 *
 * `SandboxActive` is one session's sandbox state, carried in the session's `sandbox` custom
 * entries. The newest entry on the branch wins (`restoreActive`); a session without one follows
 * the policy file's `defaultOn`.
 *
 * Three states (§chat.sandbox/states): On (`on: true`), Subagents only (`on: false`, the only
 * meaning an entry had before the third state) and Off (`on: false, workers: "off"`). `workers`
 * is optional and additive, so every older entry and reader keeps working, and it is dropped
 * whenever `on` is true: a worker is never looser than its parent.
 */

/** The custom-entry type the extension appends on every change. */
export const SANDBOX_ENTRY_TYPE = "sandbox";

/**
 * Event-bus names (pi.events) other extensions use to learn this session's state without seeing
 * our flag: subagents reads it to start workers sandboxed. `state` is emitted on session_start and
 * on every change, and again whenever someone emits `discover`.
 */
export const SANDBOX_STATE_EVENT = "sandbox:state";
export const SANDBOX_DISCOVER_EVENT = "sandbox:discover";

export type SandboxLevel = "workspace-write" | "read-only";
export const LEVELS: readonly SandboxLevel[] = ["workspace-write", "read-only"];

/**
 * How much of the promise is kept. `full`: every effect the level promises is governed.
 * `partial`: some is not (the reasons say what). `unavailable`: the probe failed, every tool
 * refuses. `none`: the sandbox is off.
 */
export type Enforcement = "full" | "partial" | "unavailable" | "none";
export const ENFORCEMENTS: readonly Enforcement[] = ["full", "partial", "unavailable", "none"];

/** The three states (§chat.sandbox/states), loosest first. */
export type SandboxState = "off" | "subagents" | "on";
export const STATES: readonly SandboxState[] = ["off", "subagents", "on"];

export interface SandboxActive {
	version: 1;
	on: boolean;
	/** `"off"`: no worker is confined either (the Off state). Only ever with `on: false`. */
	workers?: "off";
	level: SandboxLevel;
	/** The backend id that enforces it (`linux-bwrap`, …), or `none` when off. */
	backend: string;
	enforcement: Enforcement;
	reasons?: string[];
}

/** Who asks `workerLaunch`: the worker about to start. */
export interface WorkerLaunchRequest {
	/** The worker's cwd: absolute, or relative to the parent's cwd. */
	cwd: string;
	/** The top level of the tracked worktree the worker starts in, if any: it then writes only there. */
	root?: string;
	/** The worker backend id (`pi`, …). `pi` gets extension flags; every other backend a confinement. */
	backend: string;
	/** A stable id of the worker (its registry id): names its sandbox tmp and proxy. Plain `[A-Za-z0-9._-]`. */
	owner: string;
}

/**
 * How a worker must start, from the one sandbox call both kinds of worker go through.
 * - `pi`: load `extensionPath` with `flags` (`--sandbox on`, `--sandbox-parent <scope>`); the worker's
 *   own extension confines its tools.
 * - `confine`: run the worker's process inside the sandbox. `scope` is opaque, serializable data (it
 *   may cross into a hosting process); pass it to `confineLaunch(scope, needs, launch)` exported by
 *   `module` (the sandbox's `launch.ts`, pi-runtime-free) at every launch of that process.
 * - `refused`: the worker must not start; the spawner throws `reason` as is.
 * - `none`: nothing to apply (the sandbox is off and the worker is not in a tracked worktree).
 */
export type WorkerLaunch =
	| { kind: "pi"; extensionPath: string; flags: Record<string, string> }
	| { kind: "confine"; scope: string; module: string }
	| { kind: "refused"; reason: string }
	| { kind: "none" };

export interface SandboxStateEvent {
	version: 1;
	on: boolean;
	/** `"off"` (Off): `workerLaunch` answers `none` for every worker, a tracked worktree's included. */
	workers?: "off";
	/** Real path of the sandbox extension directory, for a worker's `-e` list. */
	extensionPath: string;
	enforcement: Enforcement;
	/**
	 * The one call every worker start goes through: on, the parent's scope (narrowed to a tracked
	 * worktree's `root` when given) or a refusal (cwd outside the parent's writable roots, the
	 * parent's sandbox unavailable, or partial without `acceptPartial`); Subagents only, a write-only
	 * scope for a worker in a tracked worktree (reads, network and environment untouched), else
	 * `none`; Off, `none` always.
	 * Absent in a remote session.
	 */
	workerLaunch?: (req: WorkerLaunchRequest) => WorkerLaunch;
}

export function isLevel(value: unknown): value is SandboxLevel {
	return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** `on`/`off` as typed in `/sandbox` or passed as `--sandbox`; undefined for anything else. */
export function parseOnOff(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "on":
		case "true":
		case "1":
		case "yes":
			return true;
		case "off":
		case "false":
		case "0":
		case "no":
			return false;
		default:
			return undefined;
	}
}

/** `on`/`subagents`/`off` as typed in `/sandbox` or passed as `--sandbox`; undefined for anything else. */
export function parseState(value: unknown): SandboxState | undefined {
	if (typeof value === "string" && value.trim().toLowerCase() === "subagents") return "subagents";
	const on = parseOnOff(value);
	return on === undefined ? undefined : on ? "on" : "off";
}

/** Which of the three states an entry (or event) is in. */
export function stateOf(active: Pick<SandboxActive, "on" | "workers">): SandboxState {
	return active.on ? "on" : active.workers === "off" ? "off" : "subagents";
}

/** How loose a state is: 0 Off, 1 Subagents only, 2 On. A lower rank loosens. */
export function stateRank(state: SandboxState): number {
	return STATES.indexOf(state);
}

/** A stored entry, or undefined for anything this version does not understand. Never throws. */
export function normalizeActive(value: unknown): SandboxActive | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (r.version !== 1 || typeof r.on !== "boolean" || !isLevel(r.level)) return undefined;
	const enforcement = typeof r.enforcement === "string" && (ENFORCEMENTS as readonly string[]).includes(r.enforcement)
		? (r.enforcement as Enforcement)
		: r.on ? "unavailable" : "none";
	const out: SandboxActive = {
		version: 1,
		on: r.on,
		level: r.level,
		backend: typeof r.backend === "string" && r.backend ? r.backend : "none",
		enforcement,
	};
	if (Array.isArray(r.reasons)) {
		const reasons = r.reasons.filter((x): x is string => typeof x === "string");
		if (reasons.length > 0) out.reasons = reasons;
	}
	// Fail closed: only an off entry can lift its workers; `on` with `workers: "off"` reads as On.
	if (!r.on && r.workers === "off") out.workers = "off";
	return out;
}

/**
 * The newest usable `sandbox` entry on a session branch, or undefined when the session never
 * recorded one (the caller then uses the policy default). Shared with Sova so the server and the
 * extension restore by the same rule. Never throws.
 */
export function restoreActive(entries: readonly { type: string; customType?: string; data?: unknown }[]): SandboxActive | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== SANDBOX_ENTRY_TYPE) continue;
		const active = normalizeActive(entry.data);
		if (active) return active;
	}
	return undefined;
}

/** One status line, the same words in the TUI and Sova: "Sandbox on · workspace-write · full enforcement". */
export function describeActive(active: Pick<SandboxActive, "on" | "level" | "enforcement" | "reasons" | "workers">): string {
	if (!active.on) return active.workers === "off" ? "Sandbox off · workers unconfined" : "Sandbox subagents only · workers in tracked worktrees write only there";
	// On but enforced nowhere (a remote target runs the tools on its host): say why, never "none enforcement".
	if (active.enforcement === "none") return `Sandbox on · ${active.reasons?.length ? active.reasons.join("; ") : "not enforced"}`;
	const tail = active.enforcement === "unavailable"
		? `unavailable${active.reasons?.length ? `: ${active.reasons.join("; ")}` : ""} (tools refuse)`
		: `${active.enforcement} enforcement${active.enforcement === "partial" && active.reasons?.length ? ` (${active.reasons.join("; ")})` : ""}`;
	return `Sandbox on · ${active.level} · ${tail}`;
}

/** The transcript marker for one change (copy deck): "Sandbox → on · workspace-write · full enforcement". */
export function markerText(active: Pick<SandboxActive, "on" | "level" | "enforcement" | "reasons" | "workers">): string {
	if (!active.on) return active.workers === "off" ? "Sandbox → off" : "Sandbox → subagents only";
	if (active.enforcement === "none") return `Sandbox → on · ${active.reasons?.length ? active.reasons.join("; ") : "not enforced"}`;
	const reason = active.reasons?.length && active.enforcement !== "full" ? ` · ${active.reasons.join("; ")}` : "";
	return `Sandbox → on · ${active.level} · ${active.enforcement} enforcement${reason}`;
}
