/**
 * This process's Claude CLI children, as a Sova chat process reports them to its server, which keeps
 * the idle ones bounded across all its chat processes (the bridge's own `maxIdleSessions`, held
 * across processes). Builtins only, no import of the bridge: read through the process-global
 * registry (fork-point.ts BRIDGE_REGISTRY), so nothing loads the provider to ask.
 */
import { BRIDGE_REGISTRY } from "./fork-point";

interface ChildrenSource {
	childState?(): "none" | "idle" | "busy";
	releaseIdleSessions?(reason?: string): "released" | "busy" | "none";
}

const bridgeHere = (): ChildrenSource | undefined =>
	(globalThis as unknown as Record<symbol, { bridge?: ChildrenSource } | undefined>)[BRIDGE_REGISTRY]?.bridge;

/** Busy when a child is mid-turn, idle when one is kept for a next turn, none when the provider never ran here. */
export function claudeChildState(): "none" | "idle" | "busy" {
	try {
		return bridgeHere()?.childState?.() ?? "none";
	} catch {
		return "none";
	}
}

/** Let this process's idle children go (a busy one never): their sessions resume from their records. */
export function releaseIdleClaudeChildren(reason = "idle session released"): "released" | "busy" | "none" {
	try {
		return bridgeHere()?.releaseIdleSessions?.(reason) ?? "none";
	} catch {
		return "none";
	}
}
