/**
 * Mode switcher: normal ↔ claude-heavy.
 *
 * claude-heavy re-instructs the main agent (per turn, in before_agent_start) to
 * act as a pure orchestrator: coding implementation goes to Claude Code workers
 * on opus[1m] (low effort for mechanical work, medium where precision matters),
 * planning goes to claude-fable-5-1[1m] at medium, falling back to opus[1m]/high
 * when the planner model is not offered. See prompt.ts for the full text.
 *
 * Surface: /mode command, alt+m shortcut, always-on footer status,
 * a `--mode` launch flag, and a transcript marker on every switch.
 * State persists globally in ~/.pi/agent/mode.json.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { PlannerProbe } from "./planner.ts";
import { buildHeavyPrompt, PLANNER_PRIMARY, statusLabel, type PlannerChoice } from "./prompt.ts";
import {
	DEFAULT_MODE_SHORTCUT,
	isMode,
	loadState,
	saveState,
	toggleMode,
	type Mode,
	type ModeState,
} from "./state.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");

/** Tools removed from the orchestrator while strict claude-heavy is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);

interface ModeMarker {
	mode: Mode;
}

export default function modeExtension(pi: ExtensionAPI): void {
	let state: ModeState = loadState(STATE_FILE);
	let planner: PlannerChoice = PLANNER_PRIMARY;
	const probe = new PlannerProbe(pi);
	/** Active-tools list captured before strict mode hid edit/write. */
	let toolsSnapshot: string[] | undefined;
	/** Serializes concurrent probes so a rapid toggle cannot apply a stale result. */
	let probeGeneration = 0;

	pi.registerFlag("mode", { description: "Start in a mode: normal | claude-heavy", type: "string" });

	function renderStatus(ctx: ExtensionContext): void {
		const { text, tone } = statusLabel(state.mode, planner, state.strict);
		ctx.ui.setStatus("mode", ctx.ui.theme.fg(tone, text));
	}

	function applyStrictTools(): void {
		if (toolsSnapshot === undefined) toolsSnapshot = pi.getActiveTools();
		pi.setActiveTools(toolsSnapshot.filter((name) => !STRICT_REMOVED_TOOLS.has(name)));
	}

	function restoreTools(): void {
		if (toolsSnapshot === undefined) return;
		pi.setActiveTools(toolsSnapshot);
		toolsSnapshot = undefined;
	}

	/** Probe asynchronously and refresh the status with the result; resolves the probe promise. */
	function refreshPlanner(ctx: ExtensionContext, notifyOnFallback: boolean): Promise<PlannerChoice> {
		const generation = ++probeGeneration;
		const pending = probe.probe(ctx);
		void pending.then((choice) => {
			if (state.mode !== "claude-heavy") planner = PLANNER_PRIMARY;
			else if (generation === probeGeneration) planner = choice;
			else return; // A newer probe owns the planner choice.
			renderStatus(ctx);
			if (notifyOnFallback && choice.fallback && state.mode === "claude-heavy") {
				ctx.ui.notify(`Planner fallback: ${choice.model} at ${choice.effort} (${PLANNER_PRIMARY.model} not offered)`, "warning");
			}
		});
		return pending;
	}

	async function setMode(next: Mode, ctx: ExtensionContext): Promise<void> {
		if (next === state.mode) {
			renderStatus(ctx);
			return;
		}
		state = { ...state, mode: next };
		saveState(STATE_FILE, state);
		pi.appendEntry<ModeMarker>("mode", { mode: next });
		if (next === "claude-heavy") {
			if (state.strict) applyStrictTools();
			renderStatus(ctx);
			ctx.ui.notify("Mode: claude-heavy", "info");
			await refreshPlanner(ctx, true);
		} else {
			planner = PLANNER_PRIMARY;
			++probeGeneration; // Drop the result of any probe in flight.
			restoreTools();
			renderStatus(ctx);
			ctx.ui.notify("Mode: normal", "info");
		}
	}

	pi.registerCommand("mode", {
		description: "Switch between normal and claude-heavy orchestration modes",
		getArgumentCompletions: (argumentPrefix) => {
			const items = ["normal", "claude-heavy", "status", "strict on", "strict off"]
				.filter((value) => value.startsWith(argumentPrefix.trim()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				await setMode(toggleMode(state.mode), ctx);
				return;
			}
			if (isMode(arg)) {
				await setMode(arg, ctx);
				return;
			}
			if (arg === "status") {
				const lines = [
					`mode: ${state.mode}`,
					`planner: ${planner.model} at ${planner.effort}${planner.fallback ? " (fallback; fable unavailable)" : ""}`,
					`strict: ${state.strict ? "on" : "off"}`,
					`shortcut: ${state.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
					`state file: ${STATE_FILE}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const strictToggle = /^strict\s+(on|off)$/.exec(arg);
			if (strictToggle) {
				const strict = strictToggle[1] === "on";
				const changed = strict !== state.strict;
				if (changed) {
					state = { ...state, strict };
					saveState(STATE_FILE, state);
					if (state.mode === "claude-heavy") {
						if (strict) applyStrictTools();
						else restoreTools();
					}
				}
				const appliedNow = changed && state.mode === "claude-heavy";
				ctx.ui.notify(
					`Strict mode ${strict ? "on" : "off"}${appliedNow ? ` (edit/write ${strict ? "removed from" : "restored to"} the orchestrator)` : ""}`,
					"info",
				);
				renderStatus(ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". Usage: /mode [normal|claude-heavy|status|strict on|strict off]`, "warning");
		},
	});

	pi.registerShortcut((state.shortcut ?? DEFAULT_MODE_SHORTCUT) as KeyId, {
		description: "Toggle normal / claude-heavy mode",
		handler: async (ctx) => setMode(toggleMode(state.mode), ctx),
	});

	// The behaviour change itself: replace this turn's system prompt while heavy.
	pi.on("before_agent_start", async (event) => {
		if (state.mode !== "claude-heavy") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildHeavyPrompt(planner)}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// One-shot launch override; never written to the global file.
		const flag = pi.getFlag("mode");
		if (typeof flag === "string" && isMode(flag)) state = { ...state, mode: flag };
		if (state.mode === "claude-heavy") {
			if (state.strict) applyStrictTools();
			renderStatus(ctx);
			void refreshPlanner(ctx, false);
		} else {
			renderStatus(ctx);
		}
	});

	// The footer can recreate its status line on these events; re-assert ours.
	pi.on("model_select", async (_event, ctx) => renderStatus(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => renderStatus(ctx));

	// A visible marker in the transcript where the behaviour changed.
	pi.registerEntryRenderer<ModeMarker>("mode", (entry, _options, theme) => {
		const mode = entry.data?.mode ?? "normal";
		return new Text(theme.fg("dim", `── mode → ${mode} ──`), 0, 0);
	});
}
