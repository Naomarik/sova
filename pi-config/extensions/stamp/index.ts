/**
 * stamp — a dim, right-aligned "1:43 PM · 5m ago" under each user and assistant message in the
 * TUI transcript. The text comes from ./format.ts, the formatter Sova's web UI uses too.
 *
 * pi renders its own user and assistant messages with no extension hook that sees their time
 * (the markdown transformer gets text only, and pi keeps one), so the stamp is a `custom` entry
 * of its own, drawn by an entry renderer. The entry holds only the role and the message's time
 * in ms, read back from the message entry pi persisted, so it is the same time Sova shows.
 * Custom entries never reach the model. Written in TUI mode only; Sova's runtimes and print
 * mode write none. The "ago" is computed at render, so it is current whenever pi repaints; in
 * fullscreen pi is also asked to repaint once a minute. Not in regular mode: there a changed line
 * above the viewport makes pi clear and redraw the whole scrollback, so an idle tick would do that
 * every minute. The age catches up on the next repaint instead.
 */

import type { EntryRenderer, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stampAgo } from "./format.ts";

export const STAMP_TYPE = "stamp";
/** The entries @narumitw/pi-stamp wrote while it was installed: same `role` and ms `timestamp`. */
export const LEGACY_TYPE = "pi-stamp";

type Role = "user" | "assistant";
export interface StampData {
	role: Role;
	timestamp: number;
}

/** The time a stamp entry (ours or pi-stamp's message stamps) carries; undefined otherwise. */
export function stampOf(data: unknown): number | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { role, timestamp } = data as Record<string, unknown>;
	if (role !== "user" && role !== "assistant") return undefined;
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

/** `label` right-aligned in `width` columns (ASCII only, so length is width); cut when too wide. */
export function rightAlign(label: string, width: number): string {
	if (width < 1) return "";
	return label.length >= width ? label.slice(0, width) : " ".repeat(width - label.length) + label;
}

export const renderStamp: EntryRenderer = (entry, _options, theme) => {
	const ts = stampOf(entry.data);
	if (ts === undefined) return undefined;
	return {
		render: (width: number) => (width < 1 ? [] : [theme.fg("dim", rightAlign(stampAgo(ts), width))]),
		invalidate() {},
	};
};

/** The persisted time of the newest `role` message entry whose message carries `messageTs`
    (what Sova shows); the message's own time when that entry isn't on the branch. */
export function persistedTime(ctx: Pick<ExtensionContext, "sessionManager">, role: Role, messageTs: number): number {
	const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, any>>;
	for (let i = branch.length - 1, seen = 0; i >= 0 && seen < 200; i--, seen++) {
		const e = branch[i];
		if (e?.type !== "message" || e.message?.role !== role || e.message.timestamp !== messageTs) continue;
		const t = Date.parse(e.timestamp);
		return Number.isFinite(t) ? t : messageTs;
	}
	return messageTs;
}

const TICK_MS = 60_000;
const PROBE_WIDGET = "stamp-tui-probe";

export default function stamp(pi: ExtensionAPI) {
	pi.registerEntryRenderer(STAMP_TYPE, renderStamp);
	pi.registerEntryRenderer(LEGACY_TYPE, renderStamp);

	let tui = false;
	let tick: ReturnType<typeof setInterval> | undefined;
	const stopTick = () => {
		clearInterval(tick);
		tick = undefined;
	};
	/** User messages end before pi persists them; stamp them once the next message starts. */
	const users: number[] = [];

	const write = (ctx: ExtensionContext, role: Role, messageTs: number) =>
		pi.appendEntry<StampData>(STAMP_TYPE, { role, timestamp: persistedTime(ctx, role, messageTs) });
	const flushUsers = (ctx: ExtensionContext) => {
		while (users.length) write(ctx, "user", users.shift()!);
	};

	pi.on("session_start", (_event, ctx) => {
		users.length = 0;
		tui = ctx.mode === "tui";
		stopTick();
		if (!tui) return;
		try {
			// Interactive mode hands widget factories its TUI (as codefold does); keep it, drop the widget.
			ctx.ui.setWidget(PROBE_WIDGET, (t) => {
				if (t.mode === "fullscreen" && !tick) {
					tick = setInterval(() => t.requestRender(), TICK_MS);
					tick.unref?.();
				}
				return { render: () => [], invalidate() {} };
			});
			ctx.ui.setWidget(PROBE_WIDGET, undefined);
		} catch {
			stopTick();
		}
	});
	pi.on("message_end", (event) => {
		if (tui && event.message.role === "user" && Number.isFinite(event.message.timestamp)) users.push(event.message.timestamp);
	});
	pi.on("message_start", (_event, ctx) => {
		if (tui) flushUsers(ctx);
	});
	// After the reply and its tool results are persisted: never between a tool call and its result.
	pi.on("turn_end", (event, ctx) => {
		if (!tui) return;
		flushUsers(ctx);
		if (event.message.role === "assistant" && Number.isFinite(event.message.timestamp)) write(ctx, "assistant", event.message.timestamp);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (tui) flushUsers(ctx);
	});
	pi.on("session_shutdown", () => {
		users.length = 0;
		tui = false;
		stopTick();
	});
}
