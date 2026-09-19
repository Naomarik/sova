/**
 * Tests for the TeamWidget component (extensions/subagents/team-widget.ts).
 *
 * Run via tests/run.mjs (jiti + pi-tui alias) together with the rest of the
 * offline suite; node:test + node:assert/strict only, no external services.
 *
 * Fixtures are plain literal TeamView objects (the detached snapshots
 * TeamStore.views() produces), so these tests exercise the widget's contract
 * with its caller without touching the manager in index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	TEAM_WIDGET_KEY,
	TEAM_WIDGET_LEGEND,
	TeamWidget,
	attachTeamWidget,
	visibleTeams,
	type TeamWidgetUi,
} from "./team-widget.ts";
import { TeamStore, memberState, type MemberState, type TeamMemberView, type TeamView, type WorkerObservation } from "./teams.ts";

// ── fakes ─────────────────────────────────────────────────────────────────

/** Identity theme: styles pass through, so visibleWidth measures true cells. */
const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Marker theme: fg() wraps text in searchable [color]{…} markers. */
const markTheme = {
	fg: (c: string, s: string) => `[${c}]{${s}}`,
	bold: (s: string) => `**${s}**`,
};

// ── fixtures ────────────────────────────────────────────────────────────────

let workerSeq = 0;
function member(partial: Partial<TeamMemberView> = {}): TeamMemberView {
	workerSeq++;
	return {
		workerId: `ag_${String(workerSeq).padStart(2, "0")}`,
		role: `role ${workerSeq}`,
		ownedPaths: [],
		backend: "pi",
		groupId: "run_01",
		addedAt: workerSeq,
		available: true,
		availability: "retained",
		state: "working",
		status: "running",
		processAlive: true,
		...partial,
	};
}

function team(partial: Partial<TeamView> = {}): TeamView {
	const members = partial.members ?? [];
	const counts = partial.counts ?? {
		working: 0,
		idle: 0,
		failed: 0,
		done: 0,
		stopping: 0,
		stopped: 0,
		unavailable: 0,
	};
	return {
		id: "team_01",
		name: "Ops",
		objective: "Ship the thing",
		createdAt: 1,
		origin: "session",
		members,
		actions: [],
		counts,
		...partial,
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
	return value;
}

/** Dataset-derived junk that must never reach the terminal. \x notation only. */
const LEAKED_JUNK = ["\x1b]", "\x1b[2J", "\x1b[H", "\x1b[K", "\x07", "\x85", "\x9b", "\t", "\r"];
// (pi-tui itself may emit SGR resets like \x1b[0m around its ellipsis — legitimate.)

/** Every rendered line: single, exactly `width` cells, no leaked terminal junk. */
function assertExactRows(lines: string[], width: number): void {
	assert.ok(lines.length > 0, "expected at least one row");
	for (const line of lines) {
		assert.equal(visibleWidth(line), width, `row must be exactly ${width} cells: ${JSON.stringify(line)}`);
		assert.ok(!line.includes("\n"), "rows must be single-line");
		for (const junk of LEAKED_JUNK) assert.ok(!line.includes(junk), `leaked ${JSON.stringify(junk)}: ${JSON.stringify(line)}`);
	}
}

// ── width safety (review: exact-width lines at 30, 60, 120) ─────────────────

test("exact-width rows at 30, 60 and 120 columns with rich content", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			name: "A very long team name that will not fit on one narrow line",
			counts: { working: 1, idle: 1, failed: 1, done: 0, stopping: 0, stopped: 0, unavailable: 0 },
			members: [
				member({ role: "builder", state: "working", model: "claude-opus-5[1m]", ownedPaths: ["src/api", "src/db"] }),
				member({ role: "reviewer", state: "idle", status: "waiting", backend: "claude-code", model: "sonnet" }),
				member({ role: "docs", state: "failed", status: "waiting", taskOutcome: "aborted", error: "x".repeat(500) }),
			],
		}),
	]);
	for (const width of [30, 60, 120]) {
		const lines = widget.render(width);
		assertExactRows(lines, width);
		assert.ok(lines[0].includes("◆"), `header present at width ${width}`);
		assert.ok(lines.at(-1)!.includes("session-scoped"), `legend present at width ${width}`);
	}
	// Truncation keeps content inside the width and marks it with an ellipsis.
	const narrow = widget.render(30);
	assert.ok(narrow[0].includes("…"), "long header is ellipsis-truncated");
	assert.ok(narrow.every((line) => visibleWidth(line) === 30));
});

test("tiny and non-positive widths never throw and never overflow", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([team({ members: [member()] })]);
	assert.deepEqual(widget.render(0), []);
	assert.deepEqual(widget.render(-5), []);
	assert.deepEqual(widget.render(Number.NaN), []);
	for (const width of [1, 2, 8]) assertExactRows(widget.render(width), width);
	assert.deepEqual(new TeamWidget(plainTheme).render(60), [], "no teams → no rows");
});

// ── content: header, member rows, honesty guarantees ────────────────────────

test("header shows name, exact team id and nonzero counts in team_list order", () => {
	const oneOfEach: Record<MemberState, number> = {
		working: 1,
		idle: 1,
		failed: 1,
		done: 1,
		stopping: 1,
		stopped: 1,
		unavailable: 1,
	};
	const widget = new TeamWidget(plainTheme);
	widget.update([team({ name: "Ops", id: "team_03", counts: oneOfEach, members: [] })]);
	const header = widget.render(200)[0];
	assert.equal(
		header.replace(/ +$/g, ""),
		"◆ Ops (team_03) · 1 working · 1 idle · 1 failed · 1 done · 1 stopping · 1 stopped · 1 unavailable",
	);
});

test("team with zero members reports honestly", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([team({ name: "Empty", members: [] })]);
	assert.match(widget.render(120)[0], /no members/);
});

test("member rows carry role, exact worker id, backend, status words, model and advisory owns", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			counts: { working: 1, idle: 1, failed: 1, done: 0, stopping: 0, stopped: 0, unavailable: 0 },
			members: [
				member({ workerId: "ag_07", role: "builder", state: "working", model: "claude-opus-5[1m]", ownedPaths: ["src/api"] }),
				member({ workerId: "ag_08", role: "reviewer", state: "idle", status: "waiting", backend: "claude-code" }),
				member({ workerId: "ag_09", role: "docs", state: "failed", taskOutcome: "aborted", error: "boom" }),
			],
		}),
	]);
	const lines = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	assert.equal(
		lines[1],
		"  ● builder [pi] ag_07 · working · claude-opus-5[1m] · owns: src/api",
	);
	assert.equal(lines[2], "  ◐ reviewer [claude-code] ag_08 · idle");
	assert.equal(lines[3], "  ✗ docs [pi] ag_09 · failed/aborted · error: boom");
	// Honesty: status words only — no durations and no context percentages.
	assert.ok(lines.every((line) => !line.includes("%")), "no percentages anywhere");
	assert.ok(lines.every((line) => !/(?:^|[ ·])\d+[smh](?: |$)/.test(line)), "no durations like 12s/3m/1h");
});

test("state dots match the /agents monitor vocabulary", () => {
	const cases: [MemberState, string][] = [
		["working", "●"],
		["idle", "◐"],
		["failed", "✗"],
		["done", "✓"],
		["stopping", "◌"],
		["unavailable", "○"],
	];
	// `stopped` (⊘) keeps its mark but a torn-down member never gets a row;
	// see the teardown tests below.
	for (const [state, dot] of cases) {
		const widget = new TeamWidget(plainTheme);
		widget.update([team({ members: [member({ state }), ] })]);
		assert.ok(
			widget.render(120).some((line) => line.includes(dot)),
			`state ${state} renders ${dot}`,
		);
	}
});

test("pruned members show availability and last known status, not raw reason text", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			members: [
				member({
					role: "old",
					available: false,
					availability: "pruned",
					reason: "Removed from the manager by finished-worker retention; last known status shown.",
					state: "unavailable",
					status: "done",
					taskOutcome: "success",
				}),
			],
		}),
	]);
	const row = widget.render(200).map((line) => line.replace(/ +$/g, ""))[1];
	assert.match(row, /○ old \[pi\] ag_\d+ · unavailable \(pruned, last done\/success\)/);
	assert.ok(!row.includes("Removed from the manager"), "long reason text stays out of the widget");
});

test("unavailable previous-session members keep the session-scoped note", () => {
	const widget = new TeamWidget(plainTheme);
	// Constructed directly (a session team cannot normally contain these) to
	// prove the widget renders whatever detached view it is given.
	widget.update([
		team({ members: [member({ available: false, availability: "previous-session", state: "unavailable", status: undefined })] }),
	]);
	assert.match(widget.render(200)[1], /unavailable \(previous session\)/);
});

// ── history teams: session scope stays visible ──────────────────────────────

test("history teams collapse to one row and never enumerate dead workers", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			id: "team_02",
			name: "Old",
			origin: "history",
			counts: { working: 0, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 3 },
			members: [
				member({ role: "ghost a", available: false, availability: "previous-session", state: "unavailable" }),
				member({ role: "ghost b", available: false, availability: "previous-session", state: "unavailable" }),
				member({ role: "ghost c", available: false, availability: "previous-session", state: "unavailable" }),
			],
		}),
	]);
	const lines = widget.render(120).map((line) => line.replace(/ +$/g, ""));
	assert.equal(lines.length, 3, "header + collapsed row + legend only");
	assert.match(lines[0], /◆ Old \(team_02\) \[history\] · 3 unavailable/);
	assert.match(lines[1], /3 members — workers stopped with their session \(history only, never live\)/);
	assert.ok(!lines.some((line) => line.includes("ghost")), "history members are not enumerated");
});

// ── teardown: torn-down members and teams leave the widget ──────────────────

const killedView = (partial: Partial<TeamMemberView> = {}) =>
	member({ state: "stopped", status: "killed", taskOutcome: "aborted", processAlive: false, error: "User requested teardown of team", ...partial });
const countsOf = (members: TeamMemberView[]): Record<MemberState, number> => {
	const counts: Record<MemberState, number> = { working: 0, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 0 };
	for (const m of members) counts[m.state]++;
	return counts;
};

test("a fully torn-down team vanishes from the widget: no header, no member rows", () => {
	const members = [
		killedView({ role: "coordinator", backend: "claude-code" }),
		killedView({ role: "sender" }),
		// Killed and then evicted by retention: still torn down, never resurfaces as pruned.
		killedView({ role: "echo", available: false, availability: "pruned", state: "unavailable" }),
	];
	const gone = team({ id: "team_01", name: "claude-comms-e2e", members, counts: countsOf(members) });
	const live = team({ id: "team_02", name: "Other", members: [member({ role: "builder" })], counts: countsOf([member()]) });
	const widget = new TeamWidget(plainTheme);
	widget.update([gone, live]);
	const lines = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	for (const trace of ["claude-comms-e2e", "team_01", "coordinator", "sender", "echo", "stopped", "teardown", "⊘"])
		assert.ok(!lines.some((line) => line.includes(trace)), `no trace of the torn-down team: ${trace}`);
	assert.match(lines[0], /◆ Other \(team_02\) · 1 working/);
	assert.ok(!lines.some((line) => line.includes("more team")), "a hidden team never counts as overflow");

	// Alone, it renders nothing at all.
	widget.update([gone]);
	assert.deepEqual(widget.render(120), []);
});

test("partially torn-down teams keep live rows and drop stopped rows and counts", () => {
	const members = [
		member({ role: "builder", state: "working" }),
		killedView({ role: "sender" }),
		member({ role: "reviewer", state: "idle", status: "waiting", taskOutcome: "success" }),
		member({ role: "stopper", state: "stopping", status: "stopping", taskOutcome: "aborted" }),
	];
	const widget = new TeamWidget(plainTheme);
	widget.update([team({ name: "Ops", members, counts: countsOf(members) })]);
	const lines = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	assert.equal(lines[0], "◆ Ops (team_01) · 1 working · 1 idle · 1 stopping", "header counts exclude the torn-down member");
	assert.deepEqual(
		lines.slice(1, -1).map((line) => /^\s*\S+ (\S+)/.exec(line)![1]),
		["builder", "reviewer", "stopper"],
		"stopping stays visible until the process is really gone",
	);
	assert.ok(!lines.some((line) => line.includes("sender") || line.includes("teardown")));
});

test("idle-success, failed (crashed) and done teams still render in full", () => {
	const members = [
		member({ role: "coder", state: "working" }),
		member({ role: "helper", state: "idle", status: "waiting", taskOutcome: "success" }),
	];
	const crashed = [member({ role: "dead", state: "failed", status: "error", processAlive: false, error: "pi exited with code 1" })];
	const done = [member({ role: "finisher", state: "done", status: "done", taskOutcome: "success", processAlive: false })];
	const pruned = [member({ role: "old", state: "unavailable", available: false, availability: "pruned", status: "done" })];
	const views = [
		team({ id: "team_01", name: "A", members, counts: countsOf(members) }),
		team({ id: "team_02", name: "B", members: crashed, counts: countsOf(crashed) }),
		team({ id: "team_03", name: "C", members: done, counts: countsOf(done) }),
		team({ id: "team_04", name: "D", members: pruned, counts: countsOf(pruned) }),
	];
	assert.deepEqual(visibleTeams(views), views, "nothing torn down: views pass through unchanged");
	const widget = new TeamWidget(plainTheme, { maxTeams: 4 });
	widget.update(views);
	const lines = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	assert.ok(lines.includes("◆ A (team_01) · 1 working · 1 idle"));
	assert.ok(lines.some((line) => /◐ helper .* · idle$/.test(line)));
	assert.ok(lines.some((line) => /✗ dead .*failed · error: pi exited with code 1/.test(line)), "worker death is failure, not teardown");
	assert.ok(lines.some((line) => /✓ finisher /.test(line)));
	assert.ok(lines.some((line) => /○ old .*pruned, last done/.test(line)));
});

test("attachTeamWidget removes the widget key once every team is torn down", () => {
	const ui = new FakeUi();
	const handle = attachTeamWidget(ui);
	const live = [member({ role: "a" }), member({ role: "b" })];
	handle.update([team({ members: live, counts: countsOf(live) })]);
	assert.equal(typeof ui.calls.at(-1)!.content, "function");
	const killed = [killedView({ role: "a" }), killedView({ role: "b" })];
	handle.update([team({ members: killed, counts: countsOf(killed) })]);
	assert.equal(ui.calls.at(-1)!.content, undefined, "torn-down roster clears the widget key");
	assert.equal(handle.component(), undefined);
	const calls = ui.calls.length;
	handle.update([team({ members: killed, counts: countsOf(killed) })]);
	assert.equal(ui.calls.length, calls, "repeated torn-down updates stay invisible");
});

test("store views keep torn-down teams for team_list and /team; only the widget hides them", () => {
	const store = new TeamStore();
	const prepared = store.prepareCreate({ name: "comms", objective: "obj", members: [{ role: "lead", prompt: "t" }, { role: "dev", prompt: "t" }] });
	store.commitCreate(prepared, 1, prepared.members.map((m, i) => ({
		workerId: `ag_0${i + 1}`, role: m.role, ownedPaths: m.ownedPaths, backend: "pi", groupId: "run_01", addedAt: 1,
	})));
	prepared.release();
	const killed: WorkerObservation = { status: "killed", taskOutcome: "aborted", error: "killed by user", processAlive: false, settled: true, finished: true };
	assert.equal(memberState(killed), "stopped");
	// ag_01 still retained as killed; ag_02 killed then evicted by retention.
	store.recordEviction("ag_02", { status: "killed", taskOutcome: "aborted", error: "killed by user" });
	const views = store.views((id) => (id === "ag_01" ? killed : undefined));
	assert.equal(views.length, 1, "the store still reports the torn-down team");
	assert.deepEqual(views[0].members.map((m) => [m.state, m.availability, m.status]), [
		["stopped", "retained", "killed"],
		["unavailable", "pruned", "killed"],
	]);
	assert.equal(views[0].counts.stopped, 1);
	assert.equal(views[0].counts.unavailable, 1);
	assert.deepEqual(visibleTeams(views), [], "the widget hides it");
	assert.equal(views[0].members.length, 2, "filtering never mutates store views");
});

// ── bounds ──────────────────────────────────────────────────────────────────

test("member rows are bounded with an exact overflow note", () => {
	const states = [member(), member(), member(), member(), member(), member()];
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			counts: { working: 6, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 0 },
			members: states,
		}),
	]);
	const lines = widget.render(120).map((line) => line.replace(/ +$/g, ""));
	const memberRows = lines.filter((line) => /^ {2}● /.test(line));
	assert.equal(memberRows.length, 4, "default member-row budget is 4");
	assert.ok(lines.some((line) => line === "  … +2 more members"), "overflow row is exact");

	const custom = new TeamWidget(plainTheme, { maxMemberRows: 2 });
	custom.update([team({ members: states })]);
	const customLines = custom.render(120).map((line) => line.replace(/ +$/g, ""));
	assert.equal(customLines.filter((line) => /^ {2}● /.test(line)).length, 2);
	assert.ok(customLines.some((line) => line === "  … +4 more members"));
});

test("teams are bounded with an overflow row", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({ id: "team_01", name: "One" }),
		team({ id: "team_02", name: "Two" }),
		team({ id: "team_03", name: "Three" }),
	]);
	const lines = widget.render(120).map((line) => line.replace(/ +$/g, ""));
	assert.ok(lines.some((line) => line.includes("One (team_01)")));
	assert.ok(lines.some((line) => line.includes("Two (team_02)")));
	assert.ok(!lines.some((line) => line.includes("Three")), "third team stays out");
	assert.ok(lines.some((line) => line === "… +1 more team"));

	const unlimited = new TeamWidget(plainTheme, { maxTeams: 5 });
	unlimited.update([team({ name: "A" }), team({ id: "team_02", name: "B" }), team({ id: "team_03", name: "C" })]);
	assert.ok(!unlimited.render(120).some((line) => line.includes("more team")));
});

test("member rows rank working/idle/failed ahead of terminal states, stably", () => {
	const widget = new TeamWidget(plainTheme, { maxMemberRows: 10 });
	widget.update([
		team({
			members: [
				member({ role: "done a", state: "done", status: "done" }),
				member({ role: "unav", state: "unavailable", available: false, availability: "pruned" }),
				member({ role: "work", state: "working" }),
				member({ role: "done b", state: "done", status: "done" }),
				member({ role: "fail", state: "failed", status: "waiting", taskOutcome: "error" }),
			],
		}),
	]);
	const rows = widget.render(120).map((line) => line.replace(/ +$/g, "")).filter((line) => /^ {2}[●◐✗✓◌⊘○] /.test(line));
	const order = rows.map((line) => /^\s*\S+ (\S+)/.exec(line)![1]);
	assert.deepEqual(order, ["work", "fail", "done", "done", "unav"], "working → failed → done (stable) → unavailable");
});

// ── legend ──────────────────────────────────────────────────────────────────

test("legend states session scope and advisory ownership; option removes it", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([team({ members: [member()] })]);
	const lines = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	assert.equal(lines.at(-1), TEAM_WIDGET_LEGEND);
	assert.match(TEAM_WIDGET_LEGEND, /session-scoped/);
	assert.match(TEAM_WIDGET_LEGEND, /advisory/);

	const bare = new TeamWidget(plainTheme, { legend: false });
	bare.update([team({ members: [member()] })]);
	assert.ok(!bare.render(200).some((line) => line.includes("advisory")));
});

// ── sanitization against hostile data ───────────────────────────────────────

test("control characters and ANSI from supplied data can never reflow rows", () => {
	const widget = new TeamWidget(plainTheme);
	widget.update([
		team({
			name: "Ev\x1b[2Jil\nname\x07",
			members: [
				member({ role: "a\rb\rc", model: "m\x1b[31model", error: "e\n\nvil", ownedPaths: ["src/\tapi"] }),
			],
		}),
	]);
	for (const width of [24, 60]) {
		const lines = widget.render(width);
		assertExactRows(lines, width);
	}
	const wide = widget.render(200).map((line) => line.replace(/ +$/g, ""));
	assert.ok(wide[0].includes("Evil name"), "name sanitized inline");
	assert.ok(wide[1].includes("a b c"), "role sanitized inline");
	assert.ok(wide[1].includes("model"), "model sanitized inline");
	assert.ok(wide[1].includes("e vil"), "error newlines collapsed");
});

// ── purity: no timers, no mutation, detached data ───────────────────────────

test("widget schedules no timers and registers no listeners", () => {
	const originalTimeout = globalThis.setTimeout;
	const originalInterval = globalThis.setInterval;
	const originalImmediate = globalThis.setImmediate;
	let scheduled = 0;
	const wrap = <T extends (...args: never[]) => unknown>(fn: T) =>
		((...args: unknown[]) => {
			scheduled++;
			return fn(...(args as never[]));
		}) as unknown as T;
	globalThis.setTimeout = wrap(originalTimeout);
	globalThis.setInterval = wrap(originalInterval);
	globalThis.setImmediate = wrap(originalImmediate);
	try {
		const widget = new TeamWidget(plainTheme);
		widget.update([team({ members: [member()] })]);
		for (const width of [1, 30, 60, 120]) widget.render(width);
		widget.invalidate();
		widget.render(60);
		widget.dispose();

		const ui = new FakeUi();
		const handle = attachTeamWidget(ui);
		handle.update([team()]);
		handle.update([]);
		handle.clear();
	} finally {
		globalThis.setTimeout = originalTimeout;
		globalThis.setInterval = originalInterval;
		globalThis.setImmediate = originalImmediate;
	}
	assert.equal(scheduled, 0, "no timer or immediate was ever scheduled");
});

test("render never mutates the supplied views (deep-frozen fixtures)", () => {
	const views = deepFreeze([
		team({
			members: [
				member({ role: "z", state: "done", status: "done" }),
				member({ role: "a", state: "working", ownedPaths: Object.freeze(["src/x"]) as unknown as string[] }),
			],
		}),
	]);
	const widget = new TeamWidget(plainTheme);
	widget.update(views);
	for (const width of [30, 120]) assertExactRows(widget.render(width), width);
});

test("render caches per width until update() or invalidate()", () => {
	const widget = new TeamWidget(plainTheme);
	const views = [team()];
	widget.update(views);
	const first = widget.render(60);
	assert.equal(widget.render(60), first, "same width returns the cached array");
	const wider = widget.render(120);
	assert.notEqual(wider, first);
	assert.deepEqual(wider.map((l) => l.replace(/ +$/g, "")), first.map((l) => l.replace(/ +$/g, "")));
	widget.invalidate();
	assert.notEqual(widget.render(60), first, "invalidate recomputes");
	// update() with the same array reference still re-renders after data changes.
	views[0].name = "Renamed";
	widget.update(views);
	assert.ok(widget.render(60)[0].includes("Renamed"));
});

// ── host attachment (the setWidget component form) ─────────────────────────

class FakeUi implements TeamWidgetUi {
	calls: { key: string; content: unknown; options: unknown }[] = [];
	setWidget(key: string, content: unknown, options?: unknown): void {
		this.calls.push({ key, content, options });
	}
}

test("attachTeamWidget installs lazily, updates in place and clears exactly", () => {
	const ui = new FakeUi();
	const handle = attachTeamWidget(ui);
	assert.equal(ui.calls.length, 0, "nothing is installed before data exists");
	handle.clear();
	assert.equal(ui.calls.length, 0, "clear before install is a no-op");
	handle.update([]);
	assert.equal(ui.calls.length, 0, "empty updates stay invisible");

	handle.update([team({ name: "Ops" })]);
	assert.equal(ui.calls.length, 1);
	assert.equal(ui.calls[0].key, TEAM_WIDGET_KEY);
	assert.equal(typeof ui.calls[0].content, "function", "component factory form");

	// The TUI invokes the factory lazily; it must see the latest pushed views.
	handle.update([team({ name: "Renamed" })]);
	assert.equal(ui.calls.length, 1, "updates flow through the live component, not reinstalls");
	const factory = ui.calls[0].content as (tui: unknown, theme: typeof plainTheme) => TeamWidget;
	const component = factory({}, plainTheme);
	assert.ok(component.render(120).some((line) => line.includes("Renamed")), "lazy factory reads latest views");
	assert.equal(handle.component(), component, "handle exposes the live component");

	// While installed, updates reach the existing component immediately.
	handle.update([team({ name: "Again" })]);
	assert.equal(ui.calls.length, 1);
	assert.ok(component.render(120).some((line) => line.includes("Again")));

	// Clearing removes the widget under the same key; empty updates do the same.
	handle.clear();
	assert.equal(ui.calls.at(-1)!.content, undefined);
	assert.equal(handle.component(), undefined);
	handle.update([team({ name: "Back" }), team()]);
	assert.equal(typeof ui.calls.at(-1)!.content, "function", "widget reinstalls on fresh data");
	handle.update([]);
	assert.equal(ui.calls.at(-1)!.content, undefined, "update([]) clears the widget");
});

test("attachTeamWidget passes placement through and themes the factory component", () => {
	const ui = new FakeUi();
	const handle = attachTeamWidget(ui, { placement: "belowEditor", legend: false });
	handle.update([team({ members: [member({ state: "working" })] })]);
	assert.deepEqual(ui.calls[0].options, { placement: "belowEditor" });
	const factory = ui.calls[0].content as (tui: unknown, theme: typeof markTheme) => TeamWidget;
	const component = factory({}, markTheme);
	const lines = component.render(60);
	assert.ok(lines[0].includes("[accent]{◆}"), "header dot uses the accent color");
	assert.ok(lines.some((line) => line.includes("[success]{●}") && line.includes("**")), "member dot and bold role are themed");
	assert.ok(!lines.some((line) => line.includes("advisory")), "options reach the component");
});
