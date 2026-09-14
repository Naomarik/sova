/**
 * Tests for the AgentsModal component.
 *
 * Run via tests/run.mjs (jiti + pi-tui alias) or directly with node --test
 * when @earendil-works/pi-tui is resolvable, e.g.:
 *
 *   node --test --import <pi-tui-resolution-hook> extensions/subagents/modal.test.ts
 *
 * Uses node:test + node:assert/strict only; no external dependencies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentsModal } from "./modal.ts";
import type { AgentGroup } from "./modal.ts";

// ── key data (raw terminal bytes, as the TUI would deliver them) ────────────

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const ESC = "\x1b";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

// ── fakes ───────────────────────────────────────────────────────────────────

/** Identity theme: styles pass through, so visibleWidth measures true cells. */
const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Marker theme: bg() wraps text in searchable [color]{…} markers. */
const markTheme = {
	fg: (_c: string, s: string) => s,
	bg: (c: string, s: string) => `[${c}]{${s}}`,
	bold: (s: string) => s,
};

function makeAgent(p: Record<string, unknown> = {}) {
	const status = (p.status as string) ?? "running";
	return {
		id: (p.id as string) ?? "ag_01",
		groupId: (p.groupId as string) ?? "run_01",
		name: (p.name as string) ?? "bot",
		status,
		taskOutcome: p.taskOutcome as "success" | "error" | "aborted" | undefined,
		model: p.model as string | undefined,
		transcript: (p.transcript as unknown[]) ?? [],
		usage: (p.usage as Record<string, number>) ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
			contextTokens: 0,
		},
		unreadCount: (p.unreadCount as number) ?? 0,
		lastActivity: (p.lastActivity as number) ?? Date.now(),
		steerCount: (p.steerCount as number) ?? 0,
		sessionId: p.sessionId as string | undefined,
		isFinished(this: { status: string }) {
			return this.status === "done" || this.status === "error" || this.status === "killed";
		},
	};
}

function makeGroup(id: string, label: string, agents: unknown[]): AgentGroup {
	return { id, label, createdAt: Date.now() - 200, agents: agents as AgentGroup["agents"] };
}

function makeHost(groups: AgentGroup[]) {
	return {
		kills: [] as string[],
		killedGroups: [] as string[],
		renders: 0,
		closed: 0,
		getGroups: () => groups,
		killAgent(id: string) {
			this.kills.push(id);
		},
		killGroup(id: string) {
			this.killedGroups.push(id);
		},
		requestRender() {
			this.renders++;
		},
		close() {
			this.closed++;
		},
	};
}

function makeModal(tui: unknown, groups: AgentGroup[], theme: unknown = plainTheme) {
	const host = makeHost(groups);
	const modal = new AgentsModal(tui, theme, host);
	return { modal, host, groups };
}

const TUI = (rows: number) => ({ height: rows });
const armed = (modal: AgentsModal) => modal.render(100).some((l) => l.includes("press x again"));

const WORDS = [
	"alpha",
	"bravo",
	"charlie",
	"delta",
	"echo",
	"foxtrot",
	"golf",
	"hotel",
	"india",
	"juliet",
	"kilo",
	"lima",
];

// ── width & height safety ───────────────────────────────────────────────────

test("render: every line is exactly the requested width, even with long/ANSI content", () => {
	const ansiName = `\x1b[31m${"n".repeat(90)}\x1b[0m`;
	const agents = [
		makeAgent({
			id: "ag_01",
			name: ansiName,
			unreadCount: 3,
			transcript: [
				{ ts: 1, kind: "task", text: "do things" },
				{ ts: 2, kind: "tool", toolName: "bash", text: "ls -la /" },
				{ ts: 3, kind: "tool-result", text: "boom" },
				{ ts: 4, kind: "assistant", text: "x".repeat(300) },
			],
			usage: { input: 1234, output: 5678, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2, contextTokens: 0 },
		}),
		makeAgent({
			id: "ag_02",
			name: "failed-waiter",
			status: "waiting",
			taskOutcome: "error",
			steerCount: 2,
			sessionId: "sess-1",
		}),
		makeAgent({ id: "ag_03", name: "stopping-agent", status: "stopping" }),
	];
	const groups = [makeGroup("run_01", "L".repeat(120), agents)];
	for (const width of [34, 40, 58, 70, 94, 120, 200]) {
		const { modal } = makeModal(TUI(24), groups);
		const lines = modal.render(width);
		assert.ok(lines.length > 0, `width ${width}: no lines`);
		for (const line of lines) {
			assert.equal(
				visibleWidth(line),
				width,
				`width ${width}: got ${visibleWidth(line)} — ${JSON.stringify(line.slice(0, 60))}`,
			);
		}
	}
});

test("render: narrow terminals get a safe fallback that never exceeds width", () => {
	const groups = [makeGroup("run_01", "g", [makeAgent()])];
	for (const width of [1, 2, 8, 20, 33]) {
		const { modal } = makeModal(TUI(24), groups);
		const lines = modal.render(width);
		assert.ok(lines.length >= 1, `width ${width}: no lines`);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: got ${visibleWidth(line)}`);
	}
});

test("render: line count respects short terminals", () => {
	const groups = [makeGroup("run_01", "g", [makeAgent()])];
	assert.equal(makeModal(TUI(24), groups).modal.render(100).length, 21); // floor(24*.9)-4 = 17 body + 4 chrome
	assert.equal(makeModal(TUI(16), groups).modal.render(100).length, 14); // 10 body + 4
	assert.equal(makeModal(TUI(6), groups).modal.render(100).length, 5); // 1 body + 4
	const tiny = makeModal(TUI(4), groups).modal.render(100); // fallback
	assert.ok(tiny.length >= 1 && tiny.length <= 3);
	assert.equal(makeModal({}, groups).modal.render(100).length, 36); // default 40 rows → 32 body + 4
	// terminal.rows spelling also works
	assert.equal(makeModal({ terminal: { rows: 24 } }, groups).modal.render(100).length, 21);
});

test("render: empty state renders without throwing", () => {
	const { modal } = makeModal(TUI(24), []);
	const lines = modal.render(80);
	assert.ok(lines.some((l) => l.includes("no runs yet")));
	assert.ok(lines.some((l) => l.includes("no subagents")));
	assert.ok(lines.some((l) => l.includes("agent_spawn")));
});

// ── list windowing ──────────────────────────────────────────────────────────

test("runs pane keeps the selected run visible (windowing)", () => {
	const groups = WORDS.map((w, i) =>
		makeGroup(`run_${i + 1}`, w, [makeAgent({ id: `ag_${i + 1}`, name: `bot-${i}` })]),
	);
	const { modal } = makeModal(TUI(16), groups); // 5 items visible
	modal.handleInput(TAB); // drive the runs pane, not the agents pane
	let lines = modal.render(100);
	// Body rows only: line 0 is the header, which echoes the selected agent's
	// name and would otherwise mask windowing bugs.
	const body = () => lines.slice(1);
	assert.ok(
		body().some((l) => l.includes("lima")),
		"follow mode selects the newest run and it must be visible",
	);
	assert.ok(!body().some((l) => l.includes("alpha")), "oldest run is scrolled out");
	for (let i = 1; i <= 11; i++) {
		modal.handleInput(UP);
		lines = modal.render(100);
		assert.ok(
			body().some((l) => l.includes(WORDS[11 - i])),
			`step ${i}: selected ${WORDS[11 - i]} must stay visible`,
		);
	}
	assert.ok(body().some((l) => l.includes("alpha")));
	assert.ok(!body().some((l) => l.includes("lima")));
});

test("agents pane keeps the selected subagent visible (windowing)", () => {
	const agents = WORDS.map((w, i) => makeAgent({ id: `ag_${i + 1}`, name: w }));
	const groups = [makeGroup("run_01", "g", agents)];
	const { modal } = makeModal(TUI(16), groups); // 5 items visible
	let lines = modal.render(100);
	const body = () => lines.slice(1); // skip the header line, which echoes the selected agent's name
	assert.ok(body().some((l) => l.includes("alpha")));
	assert.ok(!body().some((l) => l.includes("lima")));
	for (let i = 1; i <= 11; i++) {
		modal.handleInput(DOWN);
		lines = modal.render(100);
		assert.ok(
			body().some((l) => l.includes(WORDS[i])),
			`step ${i}: selected ${WORDS[i]} must stay visible`,
		);
	}
	assert.ok(body().some((l) => l.includes("lima")));
	assert.ok(!body().some((l) => l.includes("alpha")));
});

// ── task outcome ───────────────────────────────────────────────────────────────

test("outcome: a failed waiting subagent shows a red dot, not a healthy one", () => {
	const agents = [
		makeAgent({ id: "ag_01", name: "ok-wait", status: "waiting" }),
		makeAgent({ id: "ag_02", name: "fail-wait", status: "waiting", taskOutcome: "error" }),
		makeAgent({ id: "ag_03", name: "abort-wait", status: "waiting", taskOutcome: "aborted" }),
		makeAgent({ id: "ag_04", name: "done-fail", status: "done", taskOutcome: "error" }),
		makeAgent({ id: "ag_05", name: "done-ok", status: "done", taskOutcome: "success" }),
		makeAgent({ id: "ag_06", name: "stopping-one", status: "stopping" }),
	];
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	const lines = modal.render(120);
	const row = (name: string) => {
		// Body rows only: line 0 is the header, which echoes the selected
		// agent's name without its status dot.
		const line = lines.slice(1).find((l) => l.includes(name));
		assert.ok(line, `row for ${name} should be rendered`);
		return line;
	};
	assert.ok(row("ok-wait").includes("◐"), "waiting without failure keeps the half dot");
	assert.ok(row("fail-wait").includes("✗"), "waiting + error outcome is red");
	assert.ok(row("abort-wait").includes("✗"), "waiting + aborted outcome is red");
	assert.ok(row("done-fail").includes("✗"), "clean exit with failed task is red");
	assert.ok(row("done-ok").includes("✓"), "successful completion stays green");
	assert.ok(row("stopping-one").includes("◌"), "stopping gets its own transitional dot");
	// The outcome is spelled out on the detail row: id · status (outcome) · time
	const detail = lines.slice(1).find((l) => l.includes("ag_02"));
	assert.ok(detail?.includes("waiting (error)"), "failure reason is spelled out");
});

test("outcome: a dead run with failed subagents shows a red dot", () => {
	const groups = [
		makeGroup("run_01", "live-run", [makeAgent({ id: "ag_01" })]),
		makeGroup("run_02", "failed-run", [makeAgent({ id: "ag_02", status: "done", taskOutcome: "error" })]),
		makeGroup("run_03", "clean-run", [makeAgent({ id: "ag_03", status: "done", taskOutcome: "success" })]),
	];
	const { modal } = makeModal(TUI(24), groups);
	const lines = modal.render(120);
	assert.ok(
		lines.some((l) => l.includes("● live-run")),
		"live run pulses",
	);
	assert.ok(
		lines.some((l) => l.includes("✗ failed-run")),
		"failed run is red even though nothing is live",
	);
	assert.ok(
		lines.some((l) => l.includes("○ clean-run")),
		"cleanly finished run hollows out",
	);
});

// ── kill confirmation ───────────────────────────────────────────────────────

test("kill confirmation: a stray letter cancels, two more x presses are required", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01", name: "bot" })])]);
	modal.handleInput("x");
	assert.ok(armed(modal), "first x arms");
	modal.handleInput("z");
	assert.ok(!armed(modal), "unrecognized key cancels");
	modal.handleInput("x");
	assert.ok(armed(modal), "x re-arms after cancel");
	modal.handleInput("x");
	assert.deepEqual(host.kills, ["ag_01"]);
	assert.ok(!armed(modal), "fired confirmation is cleared");
});

test("kill confirmation: pageUp cancels (promise kept for scroll keys too)", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01" })])]);
	modal.handleInput("x");
	assert.ok(armed(modal));
	modal.handleInput(PGUP);
	assert.ok(!armed(modal), "pageUp cancels an armed confirmation");
	modal.handleInput("x");
	modal.handleInput("x");
	assert.deepEqual(host.kills, ["ag_01"]);
});

test("kill confirmation: tab cancels and switches scope to the whole run", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01" })])]);
	modal.handleInput(TAB); // focus runs pane
	modal.handleInput("x");
	assert.ok(modal.render(100).some((l) => l.includes("EVERY live subagent")));
	modal.handleInput("z");
	assert.ok(!armed(modal));
	modal.handleInput("x");
	modal.handleInput("x");
	assert.deepEqual(host.killedGroups, ["run_01"]);
	assert.deepEqual(host.kills, []);
});

test("kill confirmation: escape closes the modal instead of firing", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01" })])]);
	modal.handleInput("x");
	assert.ok(armed(modal));
	modal.handleInput(ESC);
	assert.equal(host.closed, 1);
	assert.deepEqual(host.kills, []);
});

test("kill confirmation: finished subagents never arm or fire", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01", status: "done" })])]);
	modal.handleInput("x");
	modal.handleInput("x");
	assert.ok(!armed(modal));
	assert.deepEqual(host.kills, []);
});

test("kill confirmation: a target that finishes while armed is dropped cleanly", () => {
	const agents = [makeAgent({ id: "ag_01" })];
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	modal.handleInput("x");
	assert.ok(armed(modal));
	(agents[0] as { status: string }).status = "done";
	modal.handleInput("x");
	assert.ok(!armed(modal), "stale confirmation cleared when nothing is killable");
	assert.deepEqual(host.kills, []);
});

test("kill confirmation: moving the selection cancels", () => {
	const agents = [makeAgent({ id: "ag_01" }), makeAgent({ id: "ag_02" })];
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	modal.handleInput("x");
	assert.ok(armed(modal));
	modal.handleInput(UP); // selection change in agents pane
	assert.ok(!armed(modal));
	assert.deepEqual(host.kills, []);
});

// ── transcript scrolling ────────────────────────────────────────────────────

test("transcript: home pauses at the top, end resumes following, pageUp/Down step", () => {
	const transcript = Array.from({ length: 40 }, (_, i) => ({
		ts: i,
		kind: "assistant",
		text: `T${String(i).padStart(2, "0")}`,
	}));
	const { modal } = makeModal(TUI(16), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01", transcript })])]);
	let lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("T39")),
		"autoscroll shows the tail",
	);
	assert.ok(!lines.some((l) => l.includes("[paused]")));

	modal.handleInput(HOME);
	lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("T00")),
		"home shows the top",
	);
	assert.ok(!lines.some((l) => l.includes("T39")));
	assert.ok(lines.some((l) => l.includes("[paused]")));

	modal.handleInput(PGDN);
	lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("T09")),
		"pageDown steps forward",
	);
	assert.ok(!lines.some((l) => l.includes("T04")));

	modal.handleInput(PGUP);
	lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T00")));

	modal.handleInput(END);
	lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("T39")),
		"end resumes following",
	);
	assert.ok(!lines.some((l) => l.includes("[paused]")));
});

// ── selection semantics ─────────────────────────────────────────────────────

test("runs: follows the newest run until pinned, then resumes follow at the newest", () => {
	const groups = WORDS.slice(0, 3).map((w, i) =>
		makeGroup(`run_${i + 1}`, w, [makeAgent({ id: `ag_${i + 1}`, name: w })]),
	);
	const { modal } = makeModal(TUI(24), groups, markTheme);
	modal.handleInput(TAB); // focus runs pane so the selection is highlighted
	const selectedLabel = () => {
		const lines = modal.render(100);
		return lines.find((l) => l.includes("[selectedBg]{") && l.includes("●"));
	};
	assert.ok(selectedLabel()?.includes("charlie"), "newest run selected by default");

	modal.handleInput(UP); // pin on bravo
	assert.ok(selectedLabel()?.includes("bravo"));
	groups.push(makeGroup("run_04", "delta", [makeAgent({ id: "ag_04", name: "delta" })]));
	assert.ok(selectedLabel()?.includes("bravo"), "pinned selection ignores new runs");

	modal.handleInput(DOWN);
	modal.handleInput(DOWN); // back to the newest → follow mode resumes
	groups.push(makeGroup("run_05", "echo", [makeAgent({ id: "ag_05", name: "echo" })]));
	assert.ok(selectedLabel()?.includes("echo"), "follow mode picks up the new newest run");
});

test("runs: switching runs resets the subagent selection to the first agent", () => {
	const g1 = makeGroup("run_01", "runone", [
		makeAgent({ id: "ag_01", name: "A1" }),
		makeAgent({ id: "ag_02", name: "A2" }),
	]);
	const g2 = makeGroup("run_02", "runtwo", [makeAgent({ id: "ag_03", name: "B1" })]);
	const { modal } = makeModal(TUI(24), [g1, g2]);
	const header = () => modal.render(100)[0]!;
	assert.ok(header().includes("B1"), "newest run selected initially");

	modal.handleInput(TAB); // focus runs
	modal.handleInput(UP); // g1
	assert.ok(header().includes("A1"), "agent selection resets when switching runs");
	modal.handleInput(TAB); // focus agents
	modal.handleInput(DOWN); // select A2
	assert.ok(header().includes("A2"));
	modal.handleInput(TAB);
	modal.handleInput(DOWN); // g2
	modal.handleInput(UP); // back to g1 — must be A1 again, not stale A2
	assert.ok(header().includes("A1"));
});

test("agents: unread badge shows for unselected subagents and clears on selection", () => {
	const agents = [makeAgent({ id: "ag_01", name: "bot-a" }), makeAgent({ id: "ag_02", name: "bot-b", unreadCount: 7 })];
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	let lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("●7")),
		"unread count badge visible",
	);
	modal.handleInput(DOWN); // select bot-b
	lines = modal.render(100);
	assert.ok(!lines.some((l) => l.includes("●7")), "badge hidden for the selected (read) subagent");
});

// ── cache correctness ───────────────────────────────────────────────────────

test("cache: identical state returns the same lines; data changes refresh without invalidate", () => {
	const agents = [makeAgent({ id: "ag_01" })];
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	const r1 = modal.render(100);
	const r2 = modal.render(100);
	assert.equal(r2, r1, "same state must be served from cache");

	(agents[0].transcript as unknown[]).push({ ts: Date.now(), kind: "assistant", text: "fresh output" });
	const r3 = modal.render(100);
	assert.notEqual(r3, r1, "transcript growth must bust the cache");
	assert.ok(r3.some((l) => l.includes("fresh output")));
});

test("cache: another run's agent finishing refreshes the runs pane live dot", () => {
	const a = makeAgent({ id: "ag_01", name: "one-agent" });
	const b = makeAgent({ id: "ag_02", name: "two-agent" });
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "one", [a]), makeGroup("run_02", "two", [b])]);
	const r1 = modal.render(100);
	assert.ok(
		r1.some((l) => l.includes("● two")),
		"live run shows a filled dot",
	);
	b.status = "done";
	b.taskOutcome = "error";
	const r2 = modal.render(100);
	assert.notEqual(r2, r1, "live-count change must bust the cache");
	assert.ok(
		r2.some((l) => l.includes("✗ two")),
		"failed run shows a red dot after outcome lands",
	);
});

test("cache: relative timestamps refresh after a second without invalidate", async () => {
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent()])]);
	const r1 = modal.render(100);
	assert.ok(r1.some((l) => l.includes("0s")));
	await new Promise((resolve) => setTimeout(resolve, 1100));
	const r2 = modal.render(100);
	assert.notEqual(r2, r1, "time bucket change must bust the cache");
	assert.ok(r2.some((l) => l.includes("1s")));
});

// ── sanitization ─────────────────────────────────────────────────────────────

/** Dataset-derived junk that must never reach the terminal. \x notation only. */
const LEAKED_JUNK = ["\x1b]", "\x1b[2J", "\x1b[H", "\x1b[K", "\x07", "\x85", "\x9b", "\t", "\r", "http://"];
// (pi-tui itself may emit SGR resets like \x1b[0m around its ellipsis — legitimate.)

function nastyDataset() {
	const transcript = [
		{ ts: 1, kind: "task", text: "clean task" },
		{ ts: 2, kind: "tool", toolName: "ba\x1b[2Jsh", text: "rm -rf\x07 ~/x" },
		{ ts: 3, kind: "assistant", text: "line1\r\nline2\tend\x1b]8;;http://evil\x1b\\hidden" },
		{ ts: 4, kind: "system", text: "\x85 NEL \x9b C1" },
	];
	return [
		makeGroup("run_01", "run\x1b]8;;http://x\x1b\\evil\nsecond\tend", [
			makeAgent({
				id: "ag_01",
				name: "a\x1b[2J\x1b[Hb\rc",
				model: "m\x1b[K\nod",
				status: "waiting",
				taskOutcome: "error",
				sessionId: "s\tes",
				transcript,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3, contextTokens: 0 },
			}),
		]),
	];
}

test("sanitize: labels and names are single-line with no escape or control bytes", () => {
	const { modal } = makeModal(TUI(24), nastyDataset());
	const lines = modal.render(120);
	for (const line of lines) {
		for (const junk of LEAKED_JUNK) {
			assert.ok(!line.includes(junk), `leaked ${JSON.stringify(junk)}: ${JSON.stringify(line)}`);
		}
	}
	// OSC-8 URL and terminator stripped (link text “evil” survives, the URL does not);
	// newline collapsed, tab expanded — all on one row.
	assert.ok(
		lines.some((l) => l.includes("runevil second")),
		"run label is inlined",
	);
	assert.ok(
		lines.some((l) => l.includes("ab c")),
		"agent name is inlined (cursor-erase and CR gone)",
	);
	assert.ok(lines[0]!.includes("m od"), "model is sanitized in the header");
});

test("sanitize: transcript bodies keep newlines, expand tabs, strip sequences", () => {
	const { modal } = makeModal(TUI(40), nastyDataset());
	const lines = modal.render(120).slice(1); // skip header
	// node's OSC-8 stripping removes the URL+ST but keeps the trailing link text.
	assert.ok(
		lines.some((l) => l.includes("line1")),
		"first body line preserved",
	);
	assert.ok(
		lines.some((l) => l.includes("line2    endhidden")),
		"CRLF→newline, tab expanded, OSC stripped",
	);
	assert.ok(
		lines.some((l) => l.includes("→ bash")),
		"tool name sanitized in label (CSI-erase sequence gone)",
	);
	assert.ok(
		lines.some((l) => l.includes("NEL") && l.includes("C1")),
		"C1 controls replaced by spaces",
	);
});

// ── transcript wrap cache ─────────────────────────────────────────────────

test("wrap cache: re-renders hit, content/width changes miss", () => {
	const agents = [makeAgent({ id: "ag_01", transcript: [{ ts: 1, kind: "assistant", text: "one" }] })];
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 0, misses: 1 });
	modal.handleInput(TAB); // frame-cache bust, same transcript → wrap cache hit
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 1 });
	(agents[0].transcript as unknown[]).push({ ts: 2, kind: "assistant", text: "two" });
	const lines = modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 2 });
	assert.ok(lines.some((l) => l.includes("two")));
	// A same-state re-render is served by the FRAME cache (no wrap call at all);
	// bust the frame to prove the wrap cache now hits.
	modal.handleInput(TAB);
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 2, misses: 2 });
	modal.render(120); // width change → re-wrap
	assert.deepEqual(modal.wrapStats(), { hits: 2, misses: 3 });
});

test("wrap cache: in-place trim-marker rewrites and head splices invalidate", () => {
	const agents = [
		makeAgent({
			id: "ag_01",
			transcript: [1, 2, 3, 4].map((n) => ({ ts: n, kind: "assistant", text: `T${n}` })),
		}),
	];
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	modal.render(100);
	// Simulate the runner's trim: splice items out and insert/mutate a marker.
	const marker = { ts: 99, kind: "system", text: "… 1 earlier item(s) trimmed …" };
	(agents[0].transcript as unknown[]).splice(0, 1, marker);
	let lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("earlier item(s) trimmed")),
		"marker rendered",
	);
	assert.ok(!lines.some((l) => l.includes(" T1")), "trimmed head content dropped");
	// Marker text is updated IN PLACE with another splice: cache must still catch it.
	marker.text = "… 2 earlier item(s) trimmed …";
	(agents[0].transcript as unknown[]).splice(1, 1);
	lines = modal.render(100);
	assert.ok(
		lines.some((l) => l.includes("2 earlier item(s) trimmed")),
		"in-place marker rewrite re-wraps",
	);
});

test("wrap cache: a runner-provided transcriptRevision is preferred", () => {
	const agents = [makeAgent({ id: "ag_01", transcript: [{ ts: 1, kind: "assistant", text: "one" }] })];
	(agents[0] as { transcriptRevision?: number }).transcriptRevision = 7;
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", agents)]);
	modal.render(100);
	modal.handleInput(TAB);
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 1 }, "revision key is stable across frames");
	(agents[0].transcript as unknown[]).push({ ts: 2, kind: "assistant", text: "two" });
	(agents[0] as { transcriptRevision?: number }).transcriptRevision = 8;
	const lines = modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 2 });
	assert.ok(lines.some((l) => l.includes("two")));
});

// ── misc ────────────────────────────────────────────────────────────────────

test("q closes the modal", () => {
	const { modal, host } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent()])]);
	modal.handleInput("q");
	assert.equal(host.closed, 1);
});

test("dispose is safe and render still works afterwards", () => {
	const { modal } = makeModal(TUI(24), [makeGroup("run_01", "g", [makeAgent({ id: "ag_01" })])]);
	modal.handleInput("x");
	modal.dispose();
	assert.ok(!armed(modal));
	const lines = modal.render(100);
	assert.ok(lines.length > 0);
});
