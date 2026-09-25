import assert from "node:assert/strict";
import { mock, test } from "node:test";
import stamp, { LEGACY_TYPE, renderStamp, rightAlign, STAMP_TYPE, stampOf } from "./index.ts";
import { stampAgo } from "./format.ts";

type Handler = (event: any, ctx: any) => unknown;

/** A pi stand-in that records renderers, handlers and appended entries, and persists the way
    agent-session does: extension handlers first, then the message entry. */
function harness(mode = "tui", tuiMode?: "fullscreen" | "regular") {
	const handlers = new Map<string, Handler>();
	const renderers = new Map<string, unknown>();
	const branch: any[] = [];
	const pi = {
		registerEntryRenderer: (type: string, r: unknown) => renderers.set(type, r),
		on: (name: string, h: Handler) => handlers.set(name, h),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	};
	const tui = { mode: tuiMode, renders: 0, requestRender() { this.renders++; } };
	const ui = { setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factory(tui, {}); } };
	const ctx = { mode, sessionManager: { getBranch: () => branch }, ...(tuiMode ? { ui } : {}) };
	stamp(pi as any);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const message = (role: string, timestamp: number, persistedAt: number) => {
		const m = { role, timestamp };
		emit("message_start", { message: m });
		emit("message_end", { message: m });
		branch.push({ type: "message", timestamp: new Date(persistedAt).toISOString(), message: m });
		return m;
	};
	emit("session_start");
	return { renderers, branch, emit, message, tui };
}

const stamps = (branch: any[]) => branch.filter((e) => e.customType === STAMP_TYPE).map((e) => e.data);

test("a user and an assistant message each get one stamp, after the message, at its persisted time", () => {
	const h = harness();
	h.message("user", 1000, 1500);
	const reply = h.message("assistant", 2000, 9000);
	h.emit("turn_end", { message: reply, toolResults: [] });
	h.emit("agent_end");
	assert.deepEqual(stamps(h.branch), [
		{ role: "user", timestamp: 1500 },
		{ role: "assistant", timestamp: 9000 },
	]);
	assert.deepEqual(
		h.branch.map((e) => e.type === "message" ? e.message.role : e.data.role),
		["user", "user", "assistant", "assistant"],
		"each stamp follows its own message",
	);
});

test("an assistant stamp never lands between a tool call and its result", () => {
	const h = harness();
	h.message("user", 1000, 1000);
	const call = h.message("assistant", 2000, 3000);
	h.message("toolResult", 3500, 3500);
	h.emit("turn_end", { message: call, toolResults: [] });
	assert.deepEqual(
		h.branch.map((e) => (e.type === "message" ? e.message.role : `stamp:${e.data.role}`)),
		["user", "stamp:user", "assistant", "toolResult", "stamp:assistant"],
	);
});

test("a user message the run never answers is still stamped at agent_end", () => {
	const h = harness();
	h.message("user", 1000, 1200);
	h.emit("agent_end");
	assert.deepEqual(stamps(h.branch), [{ role: "user", timestamp: 1200 }]);
});

test("outside the TUI nothing is written", () => {
	for (const mode of ["print", "json", "rpc"]) {
		const h = harness(mode);
		const reply = h.message("user", 1000, 1000);
		h.emit("turn_end", { message: { ...reply, role: "assistant" }, toolResults: [] });
		h.emit("agent_end");
		assert.deepEqual(stamps(h.branch), [], mode);
	}
});

test("renderers are registered for our entries and pi-stamp's old ones", () => {
	const h = harness();
	assert.equal(h.renderers.get(STAMP_TYPE), renderStamp);
	assert.equal(h.renderers.get(LEGACY_TYPE), renderStamp);
});

test("stampOf reads message stamps only", () => {
	assert.equal(stampOf({ role: "user", timestamp: 5 }), 5);
	assert.equal(stampOf({ version: 6, role: "assistant", timestamp: 7, costSinceUser: 0 }), 7);
	assert.equal(stampOf({ version: 1, kind: "tool", startedAt: 1, completedAt: 2 }), undefined);
	assert.equal(stampOf({ role: "user", timestamp: Number.NaN }), undefined);
	assert.equal(stampOf(null), undefined);
});

test("the rendered line is the shared stamp, dim and right-aligned to the width", () => {
	const ts = Date.now() - 5 * 60_000;
	const theme = { fg: (_c: string, s: string) => `<${s}>` };
	const c = (renderStamp as any)({ data: { role: "user", timestamp: ts } }, { expanded: false }, theme);
	const label = stampAgo(ts);
	assert.match(label, / · 5m ago$/);
	assert.deepEqual(c.render(40), [`<${" ".repeat(40 - label.length)}${label}>`]);
	assert.deepEqual(c.render(0), []);
	assert.equal((renderStamp as any)({ data: { kind: "tool" } }, { expanded: false }, theme), undefined);
	assert.equal(rightAlign("1:43 PM", 4), "1:43");
});

test("fullscreen repaints once a minute so the age stays current; regular mode never ticks", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const full = harness("tui", "fullscreen");
		const regular = harness("tui", "regular");
		mock.timers.tick(60_000 * 3);
		assert.equal(full.tui.renders, 3);
		assert.equal(regular.tui.renders, 0);
		full.emit("session_start");
		mock.timers.tick(60_000);
		assert.equal(full.tui.renders, 4, "a new session replaces the tick, never adds one");
		full.emit("session_shutdown");
		mock.timers.tick(60_000 * 3);
		assert.equal(full.tui.renders, 4, "shutdown stops it");
	} finally {
		mock.timers.reset();
	}
});
