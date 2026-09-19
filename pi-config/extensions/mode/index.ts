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
 * "align" makes the agent agree on what to build before building it, and its
 * "## Alignment:" blocks are captured (align.ts) into a session custom entry,
 * shown in a one-line widget, and readable in an overlay viewer (align-ui.ts).
 *
 * Surface: a "Mode" category in the ctrl+p command palette (palette.ts, registered
 * through command-palette/contracts.ts; bare /mode opens it), scriptable /mode
 * <args>, alt+m shortcut, always-on footer status, `--mode` / `--minor` launch
 * flags, and a transcript marker on every switch. State persists globally in
 * ~/.pi/agent/mode.json.
 */
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registerPaletteCategory, requestPaletteOpen } from "../command-palette/contracts.ts";
import {
	ALIGN_ENTRY_TYPE,
	ALIGN_WIDGET_KEY,
	nextDoc,
	parseAlignBlock,
	restoreAlignDoc,
	sameBlock,
	statusLabelText,
	summarize,
	type AlignDoc,
	type AlignEntryData,
} from "./align.ts";
import { ALIGN_OVERLAY_OPTIONS, alignWidget, createAlignViewer, type AlignViewer } from "./align-ui.ts";
import { isMinorMode, MINOR_MODES, parseMinorFlag, type MinorMode } from "./minor.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { PlannerProbe } from "./planner.ts";
import { composePrompt, PLANNER_PRIMARY, statusLabel, type PlannerChoice } from "./prompt.ts";
import {
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
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
	/** The accumulated alignment doc of this session (align minor mode); null until the agent emits a block. */
	let alignDoc: AlignDoc | null = null;
	/** The open overlay viewer, refreshed live on capture; undefined when closed. */
	let liveViewer: AlignViewer | undefined;
	let viewerOpen = false;
	const viewerShortcut = state.viewerShortcut ?? DEFAULT_ALIGN_VIEWER_SHORTCUT;
	/** The viewer key is skipped when it would shadow the mode or align toggle; reported once at session start. */
	const viewerShortcutClash = viewerShortcut === (state.shortcut ?? DEFAULT_MODE_SHORTCUT) || viewerShortcut === state.minorShortcuts?.align;
	const viewerKeyHint = viewerShortcutClash ? "/align" : viewerShortcut;

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
		if (minor === "align") syncAlignWidget(ctx);
		ctx.ui.notify(`Minor mode: ${minor} ${on ? "on" : "off"}`, "info");
	}

	// ── Alignment doc (align minor mode) ─────────────────────────────────────────

	/** Widget above the editor while align is on and a doc exists; cleared otherwise. Best-effort. */
	function syncAlignWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			if (!hasMinor(state, "align") || alignDoc === null) {
				ctx.ui.setWidget(ALIGN_WIDGET_KEY, undefined);
				return;
			}
			const doc = alignDoc;
			ctx.ui.setWidget(ALIGN_WIDGET_KEY, (_tui, theme) => alignWidget(theme, () => summarize(doc), viewerKeyHint));
		} catch {
			// Alignment UI is best-effort; never take the session down.
		}
	}

	function persistAlignDoc(): void {
		try {
			pi.appendEntry<AlignEntryData>(ALIGN_ENTRY_TYPE, { version: 1, doc: alignDoc });
		} catch {
			// A failed append loses one revision, nothing else.
		}
	}

	function restoreAlign(ctx: ExtensionContext): void {
		try {
			alignDoc = restoreAlignDoc(ctx.sessionManager.getBranch());
		} catch {
			alignDoc = null;
		}
		liveViewer?.setDoc(alignDoc);
		syncAlignWidget(ctx);
	}

	function alignSummaryLine(): string {
		if (alignDoc === null) return "(none)";
		const summary = summarize(alignDoc);
		const settled = summary.total > 0 ? ` · ${summary.settled}/${summary.total} settled` : "";
		return `v${summary.revision} · ${statusLabelText(summary.status)}${settled} · ${summary.lines} lines`;
	}

	/** Capture the assistant's "## Alignment:" block from a finished turn while align is on. */
	function captureAlign(message: unknown, ctx: ExtensionContext): void {
		if (!hasMinor(state, "align")) return;
		const m = message as { role?: string; content?: unknown; stopReason?: string } | undefined;
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return;
		if (m.stopReason === "error" || m.stopReason === "aborted") return;
		const text = m.content
			.filter((block): block is { type: "text"; text: string } => typeof block?.text === "string" && block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const parsed = parseAlignBlock(text);
		if (parsed === undefined || sameBlock(alignDoc, parsed.markdown)) return;
		alignDoc = nextDoc(alignDoc, parsed, new Date().toISOString());
		persistAlignDoc();
		liveViewer?.setDoc(alignDoc);
		syncAlignWidget(ctx);
	}

	async function openAlignViewer(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (alignDoc === null) {
			ctx.ui.notify("No alignment doc yet (turn align on and ask for work)", "info");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`align doc: ${alignSummaryLine()}\n\n${alignDoc.markdown}`, "info");
			return;
		}
		if (viewerOpen) return;
		viewerOpen = true;
		try {
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					liveViewer = createAlignViewer({
						theme,
						markdownTheme: getMarkdownTheme(),
						getDoc: () => alignDoc,
						height: () => Math.max(5, tui.terminal.rows - 4),
						requestRender: () => tui.requestRender(),
						close: () => done(undefined),
						keyHint: viewerKeyHint,
					});
					return liveViewer;
				},
				{ overlay: true, overlayOptions: ALIGN_OVERLAY_OPTIONS },
			);
		} catch {
			// The overlay must never take the session down.
		} finally {
			liveViewer = undefined;
			viewerOpen = false;
		}
	}

	function exportAlign(arg: string, ctx: ExtensionContext): void {
		if (alignDoc === null) {
			ctx.ui.notify("No alignment doc to export", "warning");
			return;
		}
		const target = resolve(ctx.cwd, arg === "" ? join(CONFIG_DIR_NAME, "align.md") : arg);
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, `${alignDoc.markdown}\n`);
			ctx.ui.notify(`Alignment doc written to ${target}`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	function statusLines(): string[] {
		return [
			`mode: ${state.mode}`,
			`planner: ${planner.model} at ${planner.effort}${planner.fallback ? " (fallback; fable unavailable)" : ""}`,
			`strict: ${state.strict ? "on" : "off"}`,
			`minor: ${state.minorModes.length > 0 ? state.minorModes.join(", ") : "(none)"}`,
			`shortcut: ${state.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
			`align doc: ${alignSummaryLine()}`,
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
				openAlignViewer: () => openAlignViewer(ctx),
			}),
	});

	const ALIGN_ARGS = ["status", "clear", "export", "on", "off"];
	pi.registerCommand("align", {
		description: "Open the alignment-doc viewer; or: status | clear | export [path] | on | off",
		getArgumentCompletions: (argumentPrefix) => {
			const items = ALIGN_ARGS.filter((value) => value.startsWith(argumentPrefix.trim())).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				await openAlignViewer(ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`align doc: ${alignSummaryLine()}`, "info");
				return;
			}
			if (arg === "clear") {
				alignDoc = null;
				persistAlignDoc();
				liveViewer?.setDoc(null);
				syncAlignWidget(ctx);
				ctx.ui.notify("Alignment doc cleared", "info");
				return;
			}
			if (arg === "on" || arg === "off") {
				setMinor("align", arg === "on", ctx);
				return;
			}
			const exportArg = /^export(?:\s+(.+))?$/.exec(arg);
			if (exportArg) {
				exportAlign(exportArg[1]?.trim() ?? "", ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". Usage: /align [status|clear|export [path]|on|off]`, "warning");
		},
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

	if (!viewerShortcutClash) {
		pi.registerShortcut(viewerShortcut as KeyId, {
			description: "Open the alignment-doc viewer",
			handler: async (ctx) => openAlignViewer(ctx),
		});
	}

	// Capture the alignment block from each finished assistant turn while align is on.
	pi.on("turn_end", async (event, ctx) => {
		try {
			captureAlign(event.message, ctx);
		} catch {
			// Capture is best-effort.
		}
	});

	// Branch navigation (/tree, /fork) changes which doc is current.
	pi.on("session_tree", async (_event, ctx) => restoreAlign(ctx));

	pi.on("session_shutdown", async () => {
		alignDoc = null;
		liveViewer = undefined;
		viewerOpen = false;
	});

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
		restoreAlign(ctx);
		if (viewerShortcutClash && ctx.hasUI) {
			ctx.ui.notify(`Align viewer key ${viewerShortcut} clashes with a mode toggle; use /align (set "viewerShortcut" in mode.json)`, "warning");
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

	// One dim marker per captured revision; the doc itself lives in the viewer.
	pi.registerEntryRenderer<AlignEntryData>(ALIGN_ENTRY_TYPE, (entry, _options, theme) => {
		const doc = entry.data?.doc;
		if (!doc) return new Text(theme.fg("dim", "── alignment cleared ──"), 0, 0);
		const summary = summarize(doc);
		const settled = summary.total > 0 ? ` · ${summary.settled}/${summary.total} settled` : "";
		return new Text(theme.fg("dim", `── alignment v${summary.revision} · ${statusLabelText(summary.status)}${settled} ──`), 0, 0);
	});
}
