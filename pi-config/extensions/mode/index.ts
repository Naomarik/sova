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
 * flags, and a transcript marker on every switch.
 *
 * The active state (mode, strict, minor modes) is **per session**: it is snapshotted into
 * every "mode" transcript entry, so it restores on /resume, /reload, /fork and /tree and
 * never leaks into another session. ~/.pi/agent/mode.json holds the shortcuts and the
 * default a new session starts from; `/mode default` (and the palette's "save as default")
 * is the only thing here that writes it.
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
	looksLikeAlignBlock,
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
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	hasMinor,
	isMode,
	loadState,
	MODE_ENTRY_TYPE,
	restoreActive,
	saveState,
	toggleMode,
	withMinor,
	type Mode,
	type ModeActive,
	type ModeState,
} from "./state.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");

/** Tools removed from the orchestrator while strict claude-heavy is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);

/** What changed in this switch. Old entries carry only `mode`; `active` is absent before per-session state. */
type ModeMarker = ({ mode: Mode } | { minor: MinorMode; on: boolean } | { strict: boolean }) & { active?: ModeActive };

export default function modeExtension(pi: ExtensionAPI): void {
	/** The file: shortcuts (read once, at registration) and the default a new session starts from. */
	let config: ModeState = loadState(STATE_FILE);
	/** This session's active state. Resolved per session in session_start / session_tree; never global. */
	let active: ModeActive = activeOf(config);
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
	const viewerShortcut = config.viewerShortcut ?? DEFAULT_ALIGN_VIEWER_SHORTCUT;
	/** The viewer key is skipped when it would shadow the mode or align toggle; reported once at session start. */
	const viewerShortcutClash = viewerShortcut === (config.shortcut ?? DEFAULT_MODE_SHORTCUT) || viewerShortcut === config.minorShortcuts?.align;
	const viewerKeyHint = viewerShortcutClash ? "/align" : viewerShortcut;

	pi.registerFlag("mode", { description: "Start in a mode: normal | claude-heavy", type: "string" });
	pi.registerFlag("minor", {
		description: `Start with minor modes on (comma-separated): ${MINOR_MODES.join(" | ")}, or none`,
		type: "string",
	});

	function renderStatus(ctx: ExtensionContext): void {
		const { text, tone } = statusLabel(active.mode, planner, active.strict, active.minorModes);
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
			if (active.mode !== "claude-heavy") planner = PLANNER_PRIMARY;
			else if (generation === probeGeneration) planner = choice;
			else return; // A newer probe owns the planner choice.
			renderStatus(ctx);
			if (notifyOnFallback && choice.fallback && active.mode === "claude-heavy") {
				ctx.ui.notify(`Planner fallback: ${choice.model} at ${choice.effort} (${PLANNER_PRIMARY.model} not offered)`, "warning");
			}
		});
		return pending;
	}

	/**
	 * One transcript entry per switch: the legacy marker the renderers read, plus the full
	 * post-switch snapshot this session restores from. Best-effort: a failed append only costs
	 * the pin (the session then follows the default again), never the turn.
	 */
	function appendSwitch(marker: { mode: Mode } | { minor: MinorMode; on: boolean } | { strict: boolean }): void {
		try {
			pi.appendEntry<ModeMarker>(MODE_ENTRY_TYPE, { ...marker, active: activeOf(active) });
		} catch {
			// Appending is impossible before session_start; nothing else here depends on it.
		}
	}

	async function setMode(next: Mode, ctx: ExtensionContext): Promise<void> {
		if (next === active.mode) {
			renderStatus(ctx);
			return;
		}
		active = { ...active, mode: next };
		appendSwitch({ mode: next });
		if (next === "claude-heavy") {
			if (active.strict) applyStrictTools();
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
		if (hasMinor(active, minor) === on) {
			renderStatus(ctx);
			return;
		}
		active = withMinor(active, minor, on);
		appendSwitch({ minor, on });
		renderStatus(ctx);
		if (minor === "align") syncAlignWidget(ctx);
		ctx.ui.notify(`Minor mode: ${minor} ${on ? "on" : "off"}`, "info");
	}

	/** One-line summary of an active state, for the notifications and the `default:` status line. */
	function activeSummary(a: ModeActive): string {
		return [a.mode, ...(a.strict ? ["strict"] : []), ...a.minorModes].join(" · ");
	}

	/**
	 * The only session-side write of mode.json: make this session's triple what new sessions start
	 * from. The file is re-read first so a concurrent session's shortcuts or default are not clobbered.
	 */
	function saveDefault(ctx: ExtensionContext): void {
		try {
			const next: ModeState = { ...loadState(STATE_FILE), mode: active.mode, strict: active.strict, minorModes: [...active.minorModes] };
			saveState(STATE_FILE, next);
			config = next;
			ctx.ui.notify(`Default mode saved: ${activeSummary(active)} (new sessions start here)`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not write ${STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	/**
	 * Resolve this session's active state: a snapshot on the branch wins, else the launch flags on
	 * top of the default (first start only), else the default as it is now. Adopting the default
	 * appends nothing, so merely opening a session never writes to its transcript.
	 */
	function restoreActiveState(reason: string | undefined, ctx: ExtensionContext): void {
		config = loadState(STATE_FILE);
		let next = activeOf(config);
		let restored: ModeActive | undefined;
		try {
			restored = restoreActive(ctx.sessionManager.getBranch());
		} catch {
			restored = undefined; // An unreadable branch just means "no pin yet".
		}
		if (restored !== undefined) {
			next = restored;
		} else if (reason === undefined || reason === "startup") {
			// One-shot launch overrides on top of the default; never written to the file or the session.
			const flag = pi.getFlag("mode");
			if (typeof flag === "string" && isMode(flag)) next = { ...next, mode: flag };
			const minorFlag = parseMinorFlag(pi.getFlag("minor"));
			if (minorFlag) {
				next = { ...next, minorModes: minorFlag.minorModes };
				if (minorFlag.unknown.length > 0) {
					try {
						ctx.ui.notify(`Unknown minor mode in --minor: ${minorFlag.unknown.join(", ")} (known: ${MINOR_MODES.join(", ")})`, "warning");
					} catch {
						// The warning is best-effort.
					}
				}
			}
		}
		active = next;
		// A restore can land on a different strict flag than the tools currently reflect.
		if (active.mode === "claude-heavy" && active.strict) applyStrictTools();
		else restoreTools();
		renderStatus(ctx);
		if (active.mode === "claude-heavy") void refreshPlanner(ctx, false);
		else {
			planner = PLANNER_PRIMARY;
			++probeGeneration; // Drop the result of any probe in flight.
		}
	}

	// ── Alignment doc (align minor mode) ─────────────────────────────────────────

	/** Widget above the editor while align is on and a doc exists; cleared otherwise. Best-effort. */
	function syncAlignWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			if (!hasMinor(active, "align") || alignDoc === null) {
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

	/**
	 * Capture the assistant's alignment block from a finished turn while align is on.
	 * A message that looks like an alignment doc but does not parse gets a warning
	 * instead of silently leaving the doc unchanged.
	 */
	function captureAlign(message: unknown, ctx: ExtensionContext): void {
		if (!hasMinor(active, "align")) return;
		const m = message as { role?: string; content?: unknown; stopReason?: string } | undefined;
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return;
		if (m.stopReason === "error" || m.stopReason === "aborted") return;
		const text = m.content
			.filter((block): block is { type: "text"; text: string } => typeof block?.text === "string" && block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const parsed = parseAlignBlock(text);
		if (parsed === undefined) {
			if (looksLikeAlignBlock(text)) {
				try {
					ctx.ui.notify("align: block looked like an alignment doc but was not captured — headings must be ##/### or **bold**", "warning");
				} catch {
					// The warning is best-effort.
				}
			}
			return;
		}
		if (sameBlock(alignDoc, parsed.markdown)) return;
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
		const fileDefault = loadState(STATE_FILE);
		return [
			`mode: ${active.mode}`,
			`default: ${activeSummary(activeOf(fileDefault))} (new sessions; /mode default sets it)`,
			`planner: ${planner.model} at ${planner.effort}${planner.fallback ? " (fallback; fable unavailable)" : ""}`,
			`strict: ${active.strict ? "on" : "off"}`,
			`minor: ${active.minorModes.length > 0 ? active.minorModes.join(", ") : "(none)"}`,
			`shortcut: ${fileDefault.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
			`align doc: ${alignSummaryLine()}`,
			`state file: ${STATE_FILE}`,
		];
	}

	const usage = `Usage: /mode [normal|claude-heavy|status|default|strict on|strict off|${MINOR_MODES.map((minor) => `${minor} [on|off]`).join("|")}]`;

	// The ctrl+p "Mode" category; the palette asks for fresh rows on every open.
	registerPaletteCategory(pi.events, {
		version: 1,
		id: MODE_CATEGORY_ID,
		label: "Mode",
		description: "Major mode and minor-mode toggles",
		items: (ctx) =>
			modeCategoryItems(() => active, {
				setMode: (next) => setMode(next, ctx),
				setMinor: (minor, on) => setMinor(minor, on, ctx),
				openAlignViewer: () => openAlignViewer(ctx),
				saveDefault: () => saveDefault(ctx),
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
			const items = ["normal", "claude-heavy", "status", "default", "strict on", "strict off", ...minorItems]
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
			if (arg === "default") {
				saveDefault(ctx);
				return;
			}
			const strictToggle = /^strict\s+(on|off)$/.exec(arg);
			if (strictToggle) {
				const strict = strictToggle[1] === "on";
				const changed = strict !== active.strict;
				if (changed) {
					active = { ...active, strict };
					appendSwitch({ strict });
					if (active.mode === "claude-heavy") {
						if (strict) applyStrictTools();
						else restoreTools();
					}
				}
				const appliedNow = changed && active.mode === "claude-heavy";
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
				const on = minorToggle[2] === undefined ? !hasMinor(active, minor) : minorToggle[2] === "on";
				setMinor(minor, on, ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". ${usage}`, "warning");
		},
	});

	pi.registerShortcut((config.shortcut ?? DEFAULT_MODE_SHORTCUT) as KeyId, {
		description: "Toggle normal / claude-heavy mode",
		handler: async (ctx) => setMode(toggleMode(active.mode), ctx),
	});

	for (const minor of MINOR_MODES) {
		const shortcut = config.minorShortcuts?.[minor];
		if (shortcut === undefined) continue;
		pi.registerShortcut(shortcut as KeyId, {
			description: `Toggle the ${minor} minor mode`,
			handler: async (ctx) => setMinor(minor, !hasMinor(active, minor), ctx),
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

	// Branch navigation (/tree, /fork) changes which mode and which doc are current.
	pi.on("session_tree", async (_event, ctx) => {
		restoreActiveState("tree", ctx);
		restoreAlign(ctx);
	});

	pi.on("session_shutdown", async () => {
		alignDoc = null;
		liveViewer = undefined;
		viewerOpen = false;
	});

	// The behaviour change itself: extend this turn's system prompt with the active mode blocks.
	pi.on("before_agent_start", async (event) => {
		const block = composePrompt(active, planner);
		if (block === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async (event, ctx) => {
		restoreActiveState(event?.reason, ctx);
		restoreAlign(ctx);
		if (viewerShortcutClash && ctx.hasUI) {
			ctx.ui.notify(`Align viewer key ${viewerShortcut} clashes with a mode toggle; use /align (set "viewerShortcut" in mode.json)`, "warning");
		}
	});

	// The footer can recreate its status line on these events; re-assert ours.
	pi.on("model_select", async (_event, ctx) => renderStatus(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => renderStatus(ctx));

	// A visible marker in the transcript where the behaviour changed.
	// `active` rides along on every marker for restore; the renderer shows only what changed.
	pi.registerEntryRenderer<ModeMarker>(MODE_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data && "minor" in data) return new Text(theme.fg("dim", `── ${data.minor} ${data.on ? "on" : "off"} ──`), 0, 0);
		if (data && "strict" in data) return new Text(theme.fg("dim", `── strict ${data.strict ? "on" : "off"} ──`), 0, 0);
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
