/**
 * Working Subagent Count Extension
 *
 * Shows how many subagents are busy:
 * - While pi is streaming, the count is appended to the "Working" message
 *   (e.g. "Working · 2 subagents").
 * - While pi is idle but subagents still run in the background, an animated
 *   spinner widget is shown below the editor (e.g. "⠸ 2 subagents working").
 *
 * Counts come from the subagents extension's "subagents:workers-snapshot"
 * events on the shared bus; without that extension pi's UI is untouched.
 *
 * Usage:
 *   Drop into ~/.pi/agent/extensions/ (auto-loaded), then /reload.
 *
 * Commands:
 *   /working-count        Show the current subagent count and toggle state
 *   /working-count on     Show the count (default)
 *   /working-count off    Restore pi's default working message, hide the widget
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKERS_SNAPSHOT_EVENT = "subagents:workers-snapshot";
const WORKERS_REQUEST_EVENT = "subagents:workers-request";
const WIDGET_KEY = "working-subagent-count";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Mirrors the subagents status line ("◆ N working · M idle"), which counts a
// worker as working unless it is settled: finished, or parked in "waiting".
const IDLE_STATUSES = new Set(["waiting", "done", "error", "killed"]);

function countWorking(data: unknown): number | undefined {
	const snapshot = data as { version?: unknown; workers?: unknown } | null | undefined;
	if (snapshot?.version !== 1 || !Array.isArray(snapshot.workers)) return undefined;
	return snapshot.workers.filter((worker: { status?: unknown } | null) => {
		const status = worker?.status;
		return typeof status === "string" && !IDLE_STATUSES.has(status);
	}).length;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	// undefined until a snapshot arrives (subagents extension may be absent).
	let count: number | undefined;
	let activeCtx: ExtensionContext | undefined;
	// True while the main agent is streaming; false before the first run and
	// after "agent_settled".
	let mainBusy = false;
	// The UI instance holding our widget (unset when the widget is hidden).
	let widgetUi: ExtensionContext["ui"] | undefined;
	// The custom working message we last set; undefined once restored. Used to
	// only touch pi's default message when we previously overrode it.
	let ourMessage: string | undefined;

	const working = () => count ?? 0;
	const suffixText = () => `Working · ${working()} subagent${working() === 1 ? "" : "s"}`;
	const widgetText = () => `${working()} subagent${working() === 1 ? "" : "s"} working`;

	// The suffix is only meaningful while pi is streaming; the widget covers
	// the idle case. Showing both at once would duplicate the count.
	const wantSuffix = () => enabled && mainBusy && working() > 0;
	const wantWidget = () => enabled && !mainBusy && working() > 0;

	const syncMessage = () => {
		if (!activeCtx?.hasUI) return;
		if (wantSuffix()) {
			const message = suffixText();
			if (message === ourMessage) return;
			try {
				activeCtx.ui.setWorkingMessage(message);
				ourMessage = message;
			} catch {
				// Stale ctx after session replacement; the new instance takes over.
				activeCtx = undefined;
				ourMessage = undefined;
			}
		} else if (ourMessage !== undefined) {
			try {
				activeCtx.ui.setWorkingMessage(undefined);
			} catch {
				activeCtx = undefined;
			}
			ourMessage = undefined;
		}
		// Never call setWorkingMessage when we have not overridden it, so another
		// extension's custom working message is left alone.
	};

	// Animated spinner below the editor. The component reads `count` lazily on
	// every render, so its interval alone keeps the label fresh; the widget is
	// only installed while subagents are working (widgetUi is set).
	const installWidget = (ui: ExtensionContext["ui"]) => {
		ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				let frame = 0;
				const timer = setInterval(() => tui.requestRender(), SPINNER_INTERVAL_MS);
				return {
					render(width: number): string[] {
						if (width <= 0) return [];
						frame = (frame + 1) % SPINNER_FRAMES.length;
						const spinner = SPINNER_FRAMES[frame] ?? "";
						const text = widgetText();
						const pad = Math.max(0, width - (spinner.length + 1 + text.length));
						return [
							`${theme.fg("accent", spinner)} ${theme.fg("muted", text)}${" ".repeat(pad)}`,
						];
					},
					// No cached render state; every render reads the live count.
					invalidate() {},
					dispose() {
						clearInterval(timer);
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	const syncWidget = () => {
		const ui = activeCtx?.hasUI ? activeCtx.ui : undefined;
		try {
			if (wantWidget() && ui) {
				if (widgetUi !== ui) {
					widgetUi?.setWidget(WIDGET_KEY, undefined);
					installWidget(ui);
					widgetUi = ui;
				}
			} else if (widgetUi) {
				widgetUi.setWidget(WIDGET_KEY, undefined);
				widgetUi = undefined;
			}
		} catch {
			// Stale ctx; the live instance re-installs on its next apply().
			widgetUi = undefined;
		}
	};

	const apply = () => {
		syncMessage();
		syncWidget();
	};

	const requestSnapshot = () => {
		try {
			pi.events?.emit(WORKERS_REQUEST_EVENT, { version: 1 });
		} catch {
			// Bus unavailable or this instance was invalidated.
		}
	};

	// Pi tracks bus subscriptions per runtime and drops them on reload/replacement.
	pi.events?.on(WORKERS_SNAPSHOT_EVENT, (data) => {
		const next = countWorking(data);
		if (next === undefined) return;
		count = next;
		apply();
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		mainBusy = false;
		apply();
		requestSnapshot();
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeCtx = ctx;
		requestSnapshot();
	});

	pi.on("agent_start", async (_event, ctx) => {
		activeCtx = ctx;
		mainBusy = true;
		apply();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeCtx = ctx;
		mainBusy = false;
		apply();
		requestSnapshot();
	});

	pi.on("session_shutdown", async () => {
		activeCtx = undefined;
		mainBusy = false;
	});

	pi.registerCommand("working-count", {
		description: "Show the subagent count while working/idle: on, off, or no args for status.",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				apply();
				requestSnapshot();
			} else if (arg) {
				ctx.ui.notify("Usage: /working-count [on|off]", "error");
				return;
			}
			const state =
				count === undefined ? "no snapshot yet (subagents extension not detected)" : `${count} working`;
			ctx.ui.notify(`Working subagent count: ${enabled ? "on" : "off"} · ${state}`, "info");
		},
	});
}
