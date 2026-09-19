/**
 * Mode switcher: normal ↔ claude-heavy, plus independently toggleable minor modes.
 *
 * claude-heavy re-instructs the main agent (per turn, in before_agent_start) to
 * act as a pure orchestrator: coding implementation goes to Claude Code workers
 * on opus[1m] (low effort for mechanical work, medium where precision matters),
 * planning goes to claude-fable-5-1[1m] at medium, falling back to opus[1m]/high
 * when the planner model is not offered. See prompt.ts for the full text.
 *
 * Minor modes (minor.ts) are extra prompt biases on top of either major mode;
 * "align" makes the agent agree on what to build before building it.
 *
 * Surface: a "Mode" category in the ctrl+p command palette (palette.ts, registered
 * through command-palette/contracts.ts; bare /mode opens it), scriptable /mode
 * <args>, alt+m shortcut, always-on footer status, `--mode` / `--minor` launch
 * flags, and a transcript marker on every switch. State persists globally in
 * ~/.pi/agent/mode.json.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { registerPaletteCategory, requestPaletteOpen } from "../command-palette/contracts.ts";
import { isMinorMode, MINOR_MODES, parseMinorFlag, type MinorMode } from "./minor.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { PlannerProbe } from "./planner.ts";
import { composePrompt, PLANNER_PRIMARY, statusLabel, type PlannerChoice } from "./prompt.ts";
import {
	DEFAULT_MODE_SHORTCUT,
	hasMinor,
	isMode,
	loadState,
	saveState,
	toggleMode,
	withMinor,
	type Mode,
	type ModeState,
} from "./state.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");

/** Tools removed from the orchestrator while strict claude-heavy is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);

/** Old entries only carry `mode`; minor-mode switches carry `minor` and `on`. */
type ModeMarker = { mode: Mode } | { minor: MinorMode; on: boolean };

export default function modeExtension(pi: ExtensionAPI): void {
	let state: ModeState = loadState(STATE_FILE);
	let planner: PlannerChoice = PLANNER_PRIMARY;
	const probe = new PlannerProbe(pi);
	/** Active-tools list captured before strict mode hid edit/write. */
	let toolsSnapshot: string[] | undefined;
	/** Serializes concurrent probes so a rapid toggle cannot apply a stale result. */
	let probeGeneration = 0;

	pi.registerFlag("mode", { description: "Start in a mode: normal | claude-heavy", type: "string" });
	pi.registerFlag("minor", {
		description: `Start with minor modes on (comma-separated): ${MINOR_MODES.join(" | ")}, or none`,
		type: "string",
	});

	function renderStatus(ctx: ExtensionContext): void {
		const { text, tone } = statusLabel(state.mode, planner, state.strict, state.minorModes);
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

	function setMinor(minor: MinorMode, on: boolean, ctx: ExtensionContext): void {
		if (hasMinor(state, minor) === on) {
			renderStatus(ctx);
			return;
		}
		state = withMinor(state, minor, on);
		saveState(STATE_FILE, state);
		pi.appendEntry<ModeMarker>("mode", { minor, on });
		renderStatus(ctx);
		ctx.ui.notify(`Minor mode: ${minor} ${on ? "on" : "off"}`, "info");
	}

	function statusLines(): string[] {
		return [
			`mode: ${state.mode}`,
			`planner: ${planner.model} at ${planner.effort}${planner.fallback ? " (fallback; fable unavailable)" : ""}`,
			`strict: ${state.strict ? "on" : "off"}`,
			`minor: ${state.minorModes.length > 0 ? state.minorModes.join(", ") : "(none)"}`,
			`shortcut: ${state.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
			`state file: ${STATE_FILE}`,
		];
	}

	const usage = `Usage: /mode [normal|claude-heavy|status|strict on|strict off|${MINOR_MODES.map((minor) => `${minor} [on|off]`).join("|")}]`;

	// The ctrl+p "Mode" category; the palette asks for fresh rows on every open.
	registerPaletteCategory(pi.events, {
		version: 1,
		id: MODE_CATEGORY_ID,
		label: "Mode",
		description: "Major mode and minor-mode toggles",
		items: (ctx) =>
			modeCategoryItems(() => state, {
				setMode: (next) => setMode(next, ctx),
				setMinor: (minor, on) => setMinor(minor, on, ctx),
			}),
	});

	pi.registerCommand("mode", {
		description: "Open the mode selector, or set a mode with an argument",
		getArgumentCompletions: (argumentPrefix) => {
			const minorItems = MINOR_MODES.flatMap((minor) => [minor, `${minor} on`, `${minor} off`]);
			const items = ["normal", "claude-heavy", "status", "strict on", "strict off", ...minorItems]
				.filter((value) => value.startsWith(argumentPrefix.trim()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				if (ctx.mode === "tui") {
					const opened = requestPaletteOpen(pi.events, ctx, [MODE_CATEGORY_ID]);
					if (opened) {
						await opened;
						return;
					}
				}
				// No palette to open (non-TUI, palette not loaded, or already open): never toggle blindly.
				ctx.ui.notify(`${statusLines().join("\n")}\n${usage}`, "warning");
				return;
			}
			if (isMode(arg)) {
				await setMode(arg, ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(statusLines().join("\n"), "info");
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
			const minorToggle = /^([a-z-]+)(?:\s+(on|off))?$/.exec(arg);
			if (minorToggle && isMinorMode(minorToggle[1])) {
				const minor = minorToggle[1];
				const on = minorToggle[2] === undefined ? !hasMinor(state, minor) : minorToggle[2] === "on";
				setMinor(minor, on, ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". ${usage}`, "warning");
		},
	});

	pi.registerShortcut((state.shortcut ?? DEFAULT_MODE_SHORTCUT) as KeyId, {
		description: "Toggle normal / claude-heavy mode",
		handler: async (ctx) => setMode(toggleMode(state.mode), ctx),
	});

	for (const minor of MINOR_MODES) {
		const shortcut = state.minorShortcuts?.[minor];
		if (shortcut === undefined) continue;
		pi.registerShortcut(shortcut as KeyId, {
			description: `Toggle the ${minor} minor mode`,
			handler: async (ctx) => setMinor(minor, !hasMinor(state, minor), ctx),
		});
	}

	// The behaviour change itself: extend this turn's system prompt with the active mode blocks.
	pi.on("before_agent_start", async (event) => {
		const block = composePrompt(state, planner);
		if (block === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// One-shot launch overrides; never written to the global file.
		const flag = pi.getFlag("mode");
		if (typeof flag === "string" && isMode(flag)) state = { ...state, mode: flag };
		const minorFlag = parseMinorFlag(pi.getFlag("minor"));
		if (minorFlag) {
			state = { ...state, minorModes: minorFlag.minorModes };
			if (minorFlag.unknown.length > 0) {
				ctx.ui.notify(
					`Unknown minor mode in --minor: ${minorFlag.unknown.join(", ")} (known: ${MINOR_MODES.join(", ")})`,
					"warning",
				);
			}
		}
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
		const data = entry.data;
		if (data && "minor" in data) return new Text(theme.fg("dim", `── ${data.minor} ${data.on ? "on" : "off"} ──`), 0, 0);
		const mode = data?.mode ?? "normal";
		return new Text(theme.fg("dim", `── mode → ${mode} ──`), 0, 0);
	});
}
