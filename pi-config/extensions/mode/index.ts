/**
 * Mode switcher: normal ↔ delegate, plus independently toggleable minor modes.
 *
 * delegate (called claude-heavy until 2026-09; that name is still read everywhere) re-instructs
 * the main agent (per turn, in before_agent_start) to act as a pure orchestrator that routes work
 * to background workers by four profiles — Planning & specs, Investigation, Routine and Complex
 * implementation — each a configurable backend · model · effort with an optional fallback
 * (delegate.ts, ~/.pi/agent/mode-delegate.json, re-read at every turn boundary). routing.ts
 * decides which tuple each profile uses from discovery and the model policy; prompt.ts holds the
 * text.
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
 * is the only thing here that writes it. The Delegate routing is global and never snapshotted:
 * nothing here writes mode-delegate.json (Sova's Settings → Modes → Delegate does).
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
import { policyDenial, readPolicy } from "../subagents/policy.ts";
import { DELEGATE_FILE_NAME, DELEGATE_PROFILE_INFO, DELEGATE_PROFILES, delegateKey, delegateReader, type DelegateBackend } from "./delegate.ts";
import { WorkerProbe } from "./discovery.ts";
import { isMinorMode, MINOR_MODES, parseMinorFlag, type MinorMode } from "./minor.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { applyModeSection, composePrompt, DEFAULT_ROUTES, statusLabel } from "./prompt.ts";
import { backendsOf, describeChoice, routeAll, routeNotice, type Discovery, type ProfileRoute } from "./routing.ts";
import {
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	hasMinor,
	loadState,
	MODE_ENTRY_TYPE,
	MODES,
	parseMode,
	restoreActive,
	saveState,
	toggleMode,
	withMinor,
	type Mode,
	type ModeActive,
	type ModeState,
} from "./state.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");
const DELEGATE_FILE = join(getAgentDir(), DELEGATE_FILE_NAME);

/**
 * How long one backend's discovery stands before a Delegate turn refreshes it in the background:
 * a model list for 10 minutes; a failed discovery (CLI missing, timed out) for 1 minute, so a fix
 * shows up soon without spawning the CLI every turn; a backend that wasn't loaded is asked again
 * at the very next turn — asking costs one event, no process.
 */
const DISCOVERY_TTL_MS = { models: 10 * 60 * 1000, error: 60 * 1000, missing: 0 } as const;

const discoveryTtl = (discovery: Discovery): number =>
	"models" in discovery ? DISCOVERY_TTL_MS.models : discovery.missing ? DISCOVERY_TTL_MS.missing : DISCOVERY_TTL_MS.error;

/** Tools removed from the orchestrator while strict delegate is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);

/** What changed in this switch. Old entries carry only `mode`; `active` is absent before per-session state. */
type ModeMarker = ({ mode: Mode } | { minor: MinorMode; on: boolean } | { strict: boolean }) & { active?: ModeActive };

export default function modeExtension(pi: ExtensionAPI): void {
	/** The file: shortcuts (read once, at registration) and the default a new session starts from. */
	let config: ModeState = loadState(STATE_FILE);
	/** This session's active state. Resolved per session in session_start / session_tree; never global. */
	let active: ModeActive = activeOf(config);
	/** The global Delegate routing, re-read (one stat) whenever it is consulted. */
	const readDelegate = delegateReader(DELEGATE_FILE);
	/** Which worker each profile uses now: the routing, assessed against discovery and the policy. */
	let routes: readonly ProfileRoute[] = DEFAULT_ROUTES;
	/** Last discovery per backend; absent = never probed (its tuples read as unverified). */
	let discoveries: Partial<Record<DelegateBackend, Discovery>> = {};
	/** When each backend's discovery landed. */
	const discoveredAt: Partial<Record<DelegateBackend, number>> = {};
	/** The routing the last applied probe ran for; a turn with a different one probes again. */
	let probedKey: string | undefined;
	/**
	 * The probe in flight, by the routing it runs for. A second request for the same routing joins it
	 * (keeping the strongest notify ask) instead of restarting it: restarting dropped the first
	 * probe's result, and with it the fallback notice a switch into delegate had asked for.
	 */
	let inflight: { key: string; notify: boolean; done: Promise<void> } | undefined;
	const probe = new WorkerProbe(pi);
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

	pi.registerFlag("major", { description: "Start in a mode: normal | delegate (claude-heavy is read as delegate)", type: "string" });
	pi.registerFlag("minor", {
		description: `Start with minor modes on (comma-separated): ${MINOR_MODES.join(" | ")}, or none`,
		type: "string",
	});

	function renderStatus(ctx: ExtensionContext): void {
		const { text, tone } = statusLabel(active.mode, routes, active.strict, active.minorModes);
		ctx.ui.setStatus("mode", ctx.ui.theme.fg(tone, text));
	}

	/**
	 * Route every profile of the routing as it is NOW (file and policy re-read) against the last
	 * discovery. Synchronous and cheap: what a turn boundary runs.
	 */
	function recomputeRoutes(): void {
		const settings = readDelegate();
		const policy = readPolicy();
		routes = routeAll(settings, discoveries, (choice) => policyDenial(policy, choice.backend, choice.model));
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

	/**
	 * Discover every backend the current routing names, then re-route and refresh the status.
	 * Resolves once the probe is applied (or dropped as stale); never rejects.
	 */
	function refreshRouting(ctx: ExtensionContext, notifyDegraded: boolean): Promise<void> {
		const settings = readDelegate();
		const key = delegateKey(settings);
		if (inflight && inflight.key === key) {
			inflight.notify ||= notifyDegraded;
			return inflight.done;
		}
		const generation = ++probeGeneration;
		// A changed routing supersedes the probe in flight; a notice that one was owed is carried over.
		const run: { key: string; notify: boolean; done: Promise<void> } = { key, notify: notifyDegraded || !!inflight?.notify, done: Promise.resolve() };
		run.done = (async () => {
			const found = await Promise.all(backendsOf(settings).map(async (backend) => [backend, await probe.discover(ctx, backend)] as const));
			if (inflight === run) inflight = undefined;
			// A newer probe, or leaving delegate, owns the result.
			if (generation !== probeGeneration || active.mode !== "delegate") return;
			const now = Date.now();
			for (const [backend, discovery] of found) {
				discoveries = { ...discoveries, [backend]: discovery };
				discoveredAt[backend] = now;
			}
			probedKey = key;
			recomputeRoutes();
			renderStatus(ctx);
			if (!run.notify) return;
			const notices = routes.map(routeNotice).filter((line): line is string => line !== undefined);
			if (notices.length > 0) ctx.ui.notify(`Delegate routing:\n${notices.join("\n")}`, "warning");
		})();
		inflight = run;
		return run.done;
	}

	/** Does this turn need a fresh probe: a routing not probed yet, or a backend whose discovery has aged out? */
	function routingStale(): boolean {
		const settings = readDelegate();
		if (delegateKey(settings) !== probedKey) return true;
		const now = Date.now();
		return backendsOf(settings).some((backend) => {
			const discovery = discoveries[backend];
			return discovery === undefined || now - (discoveredAt[backend] ?? 0) >= discoveryTtl(discovery);
		});
	}

	/** Leaving delegate: forget the probe in flight so its result is dropped and the next entry starts fresh. */
	function dropProbe(): void {
		++probeGeneration;
		inflight = undefined;
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
		if (next === "delegate") {
			if (active.strict) applyStrictTools();
			recomputeRoutes();
			renderStatus(ctx);
			ctx.ui.notify("Mode: delegate", "info");
			await refreshRouting(ctx, true);
		} else {
			dropProbe();
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
			const flag = parseMode(pi.getFlag("major"));
			if (flag !== undefined) next = { ...next, mode: flag };
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
		if (active.mode === "delegate" && active.strict) applyStrictTools();
		else restoreTools();
		if (active.mode === "delegate") {
			recomputeRoutes();
			renderStatus(ctx);
			void refreshRouting(ctx, false);
		} else {
			renderStatus(ctx);
			dropProbe();
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

	/** One line per profile: the configured tuple(s) and, in delegate, what is actually in use. */
	function routingLines(): string[] {
		const settings = readDelegate();
		if (active.mode === "delegate") recomputeRoutes();
		return DELEGATE_PROFILES.map((profile) => {
			const { primary, fallback } = settings.profiles[profile];
			const configured = `${describeChoice(primary)}${fallback ? `, fallback ${describeChoice(fallback)}` : ", no fallback"}`;
			const route = routes.find((r) => r.profile === profile);
			const using =
				active.mode !== "delegate" || !route
					? ""
					: route.via === "primary"
						? route.primary.availability === "unverified" ? " — using primary (not verified)" : " — using primary"
						: route.via === "fallback"
							? ` — using FALLBACK (${route.primary.reason})`
							: " — none available: will ask";
			return `  ${DELEGATE_PROFILE_INFO[profile].label}: ${configured}${using}`;
		});
	}

	function statusLines(): string[] {
		const fileDefault = loadState(STATE_FILE);
		return [
			`mode: ${active.mode}`,
			`default: ${activeSummary(activeOf(fileDefault))} (new sessions; /mode default sets it)`,
			`delegate routing (${DELEGATE_FILE}):`,
			...routingLines(),
			`strict: ${active.strict ? "on" : "off"}`,
			`minor: ${active.minorModes.length > 0 ? active.minorModes.join(", ") : "(none)"}`,
			`shortcut: ${fileDefault.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
			`align doc: ${alignSummaryLine()}`,
			`state file: ${STATE_FILE}`,
		];
	}

	const usage = `Usage: /mode [${MODES.join("|")}|status|default|strict on|strict off|${MINOR_MODES.map((minor) => `${minor} [on|off]`).join("|")}]`;

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
			const items = [...MODES, "status", "default", "strict on", "strict off", ...minorItems]
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
			const mode = parseMode(arg); // "claude-heavy" still selects delegate
			if (mode !== undefined) {
				await setMode(mode, ctx);
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
					if (active.mode === "delegate") {
						if (strict) applyStrictTools();
						else restoreTools();
					}
				}
				const appliedNow = changed && active.mode === "delegate";
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
		description: "Toggle normal / delegate mode",
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

	// The behaviour change itself: put the active mode blocks into this turn's system prompt.
	// pi >= 0.86 exposes mutable prompt sections and diffs them against what the model already
	// has, so a toggle costs one small patch and keeps the cached prefix; older hosts without
	// them (pi < 0.86) still take the whole-prompt append.
	//
	// Delegate's routing is re-read here, at every turn boundary: a routing or policy change reaches
	// a session already in delegate from its next prompt. A changed routing (or stale discovery)
	// re-probes in the background; until that lands, tuples of undiscovered backends are unverified
	// and stay in use — spawn is the final check, and the prompt's retry rule covers a miss.
	pi.on("before_agent_start", async (event, ctx) => {
		if (active.mode === "delegate") {
			const key = delegateKey(readDelegate());
			recomputeRoutes();
			// Announce only a routing the user changed; a timed refresh or the start-up probe joined
			// here stays quiet unless whoever started it asked (a switch into delegate does).
			if (routingStale()) void refreshRouting(ctx, probedKey !== undefined && key !== probedKey);
			try {
				renderStatus(ctx);
			} catch {
				// Status is best-effort here.
			}
		}
		const block = composePrompt(active, routes);
		const sections = (event.systemPromptOptions as { sections?: Record<string, string> } | undefined)?.sections;
		if (sections) {
			applyModeSection(sections, block);
			return;
		}
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
		// Shown as recorded: a pre-rename marker keeps its "claude-heavy" (history is not relabelled).
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
