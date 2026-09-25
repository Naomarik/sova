/**
 * Tests for the TeamModal component (component section) and its /team wiring in
 * index.ts (integration section).
 *
 * Run via tests/run.mjs (jiti + pi-tui alias). Uses node:test + node:assert/strict
 * only; no external dependencies. Integration fakes mirror index.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TeamModal } from "./team-modal.ts";
import type { TeamHost } from "./team-modal.ts";
import type { MemberState, TeamAction, TeamMemberView, TeamView } from "./teams.ts";
import type { Worker } from "./contracts.ts";
import { registerSubagents } from "./index.ts";
import { BACKEND_DIALOG_EVENT, BACKEND_REGISTER_EVENT } from "./contracts.ts";
import { registerClaudeCode } from "../claude-code/index.ts";

// ── key data (raw terminal bytes, as the TUI would deliver them) ────────────

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const ESC = "\x1b";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

// ── component fakes ─────────────────────────────────────────────────────────

/** Identity theme: styles pass through, so visibleWidth measures true cells. */
const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Marker theme: bg() wraps text in searchable [color]{…} markers. */
const markTheme = {
	fg: (_c: string, s: string) => s,
	bg: (c: string, s: string) => `[${c}]{${s}}`,
	bold: (s: string) => s,
};

function makeWorker(p: Record<string, unknown> = {}) {
	const status = (p.status as string) ?? "running";
	const worker: Record<string, unknown> = {
		id: (p.id as string) ?? "ag_01",
		groupId: (p.groupId as string) ?? "run_01",
		name: (p.name as string) ?? "builder",
		backend: p.backend as string | undefined,
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
		steerCount: (p.steerCount as number) ?? 0,
		sessionId: p.sessionId as string | undefined,
		lastActivity: (p.lastActivity as number) ?? Date.now(),
		isFinished(this: { status: string }) {
			return this.status === "done" || this.status === "error" || this.status === "killed";
		},
		isSettled(this: { status: string }) {
			return this.isFinished() || this.status === "waiting";
		},
	};
	if (p.transcriptRevision !== undefined) worker.transcriptRevision = p.transcriptRevision;
	if (p.isStopping) worker.isStopping = p.isStopping;
	return worker as unknown as Worker;
}

function makeMember(p: Record<string, unknown> = {}): TeamMemberView {
	return {
		workerId: (p.workerId as string) ?? "ag_01",
		role: (p.role as string) ?? "builder",
		ownedPaths: (p.ownedPaths as string[]) ?? [],
		backend: (p.backend as string) ?? "pi",
		model: p.model as string | undefined,
		groupId: (p.groupId as string) ?? "run_01",
		addedAt: (p.addedAt as number) ?? Date.now() - 1000,
		available: (p.available as boolean) ?? true,
		availability: (p.availability as TeamMemberView["availability"]) ?? "retained",
		reason: p.reason as string | undefined,
		state: (p.state as MemberState) ?? "working",
		status: (p.status as TeamMemberView["status"]) ?? "running",
		taskOutcome: p.taskOutcome as TeamMemberView["taskOutcome"],
		error: p.error as string | undefined,
		processAlive: (p.processAlive as boolean) ?? true,
		...(p.ejectedAt === undefined ? {} : { ejectedAt: p.ejectedAt as number }),
	};
}

function makeTeam(
	id: string,
	name: string,
	members: TeamMemberView[],
	p: { origin?: "session" | "history"; objective?: string; createdAt?: number; actions?: TeamAction[] } = {},
): TeamView {
	const counts = { working: 0, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 0 };
	let ejected = 0;
	for (const m of members) if (m.ejectedAt === undefined) counts[m.state]++; else ejected++;
	return {
		id,
		name,
		objective: p.objective ?? "ship it",
		createdAt: p.createdAt ?? Date.now() - 200,
		origin: p.origin ?? "session",
		members,
		actions: p.actions ?? [],
		counts,
		ejected,
	};
}

function makeHost(teams: TeamView[], workers = new Map<string, Worker>()) {
	const host = {
		steers: [] as { workerId: string; mode: "redirect" | "followUp" }[],
		stops: [] as string[],
		renders: 0,
		closed: 0,
		getTeams: () => teams,
		getWorker: (id: string) => workers.get(id),
		steerMember(workerId: string, mode: "redirect" | "followUp") {
			this.steers.push({ workerId, mode });
		},
		stopMember(workerId: string) {
			this.stops.push(workerId);
		},
		requestRender() {
			this.renders++;
		},
		close() {
			this.closed++;
		},
	};
	return host;
}

function makeModal(
	tui: unknown,
	teams: TeamView[],
	workers = new Map<string, Worker>(),
	theme: unknown = plainTheme,
	host: (h: ReturnType<typeof makeHost>) => TeamHost = (h) => h,
) {
	const base = makeHost(teams, workers);
	const modal = new TeamModal(tui, theme, host(base));
	return { modal, host: base, teams, workers };
}

const TUI = (rows: number) => ({ height: rows });
const armed = (modal: TeamModal) => modal.render(100).some((l) => l.includes("press x again"));

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];

/** A standard two-member session team with both members live. */
function standardSetup() {
	const workers = new Map<string, Worker>([
		["ag_01", makeWorker({ id: "ag_01", name: "builder" })],
		["ag_02", makeWorker({ id: "ag_02", name: "reviewer", backend: "claude-code", model: "opus[1m]" })],
	]);
	const teams = [
		makeTeam("team_01", "core", [
			makeMember({ workerId: "ag_01", role: "builder", ownedPaths: ["src/api"] }),
			makeMember({ workerId: "ag_02", role: "reviewer", backend: "claude-code", model: "opus[1m]" }),
		]),
	];
	return makeModal(TUI(24), teams, workers);
}

// ── width & height safety ───────────────────────────────────────────────────

test("render: every line is exactly the requested width, even with long/ANSI content", () => {
	const ansiJunk = `\x1b[31m${"n".repeat(90)}\x1b[0m`;
	const workers = new Map<string, Worker>([
		[
			"ag_01",
			makeWorker({
				id: "ag_01",
				name: ansiJunk,
				unreadCount: 3,
				transcript: [
					{ ts: 1, kind: "task", text: "do things" },
					{ ts: 2, kind: "tool", toolName: "bash", text: "ls -la /" },
					{ ts: 3, kind: "assistant", text: "x".repeat(300) },
				],
				usage: { input: 1234, output: 5678, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2, contextTokens: 0 },
			}),
		],
	]);
	const teams = [
		makeTeam("team_01", "N".repeat(120), [
			makeMember({ workerId: "ag_01", role: "builder\x1b[2J", ownedPaths: ["src/" + "p".repeat(80)] }),
			makeMember({
				workerId: "ag_02",
				role: "gone",
				available: false,
				availability: "pruned",
				reason: "Removed from the manager by finished-worker retention; last known status shown.",
				state: "unavailable",
				status: "error",
				taskOutcome: "error",
				error: "boom\x07",
			}),
		], { objective: "O".repeat(200) }),
		makeTeam("team_02", "old", [makeMember({ workerId: "ag_09", role: "lead", available: false, availability: "previous-session", state: "unavailable", status: undefined })], { origin: "history" }),
	];
	for (const width of [34, 40, 58, 70, 94, 120, 200]) {
		const { modal } = makeModal(TUI(24), teams, workers, plainTheme);
		const lines = modal.render(width);
		assert.ok(lines.length > 0, `width ${width}: no lines`);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width, `width ${width}: got ${visibleWidth(line)} — ${JSON.stringify(line.slice(0, 60))}`);
		}
	}
});

test("render: narrow terminals get a safe fallback that never exceeds width", () => {
	const teams = [makeTeam("team_01", "t", [makeMember()])];
	for (const width of [1, 2, 8, 20, 33]) {
		const { modal } = makeModal(TUI(24), teams);
		const lines = modal.render(width);
		assert.ok(lines.length >= 1, `width ${width}: no lines`);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: got ${visibleWidth(line)}`);
		if (width >= 20) assert.ok(lines[0]!.includes("teams:"), `width ${width}: fallback describes itself`);
	}
});

test("render: line count respects short terminals", () => {
	const teams = [makeTeam("team_01", "t", [makeMember()])];
	assert.equal(makeModal(TUI(24), teams).modal.render(100).length, 21); // floor(24*.9)-4 = 17 body + 4 chrome
	assert.equal(makeModal(TUI(16), teams).modal.render(100).length, 14); // 10 body + 4
	assert.equal(makeModal(TUI(6), teams).modal.render(100).length, 5); // 1 body + 4
	const tiny = makeModal(TUI(4), teams).modal.render(100); // fallback
	assert.ok(tiny.length >= 1 && tiny.length <= 3);
	assert.equal(makeModal({}, teams).modal.render(100).length, 36); // default 40 rows → 32 body + 4
	// terminal.rows spelling also works
	assert.equal(makeModal({ terminal: { rows: 24 } }, teams).modal.render(100).length, 21);
});

test("render: empty state renders without throwing", () => {
	const { modal } = makeModal(TUI(24), []);
	const lines = modal.render(80);
	assert.ok(lines.some((l) => l.includes("Teams (0)")));
	assert.ok(lines.some((l) => l.includes("no teams yet")));
	assert.ok(lines.some((l) => l.includes("no team")));
	assert.ok(lines.some((l) => l.includes("team_create")));
});

// ── list windowing ──────────────────────────────────────────────────────────

test("teams pane keeps the selected team visible (windowing)", () => {
	const teams = WORDS.map((w, i) => makeTeam(`team_${String(i + 1).padStart(2, "0")}`, w, [makeMember({ workerId: `ag_${i + 1}`, role: w })]));
	const { modal } = makeModal(TUI(16), teams); // 5 items visible
	modal.handleInput(TAB); // drive the teams pane, not the members pane
	let lines = modal.render(100);
	// Body rows only: the header echoes the selected team and would mask bugs.
	const body = () => lines.slice(1);
	assert.ok(body().some((l) => l.includes("lima")), "follow mode selects the newest team and it must be visible");
	assert.ok(!body().some((l) => l.includes("alpha")), "oldest team is scrolled out");
	for (let i = 1; i <= 11; i++) {
		modal.handleInput(UP);
		lines = modal.render(100);
		assert.ok(body().some((l) => l.includes(WORDS[11 - i])), `step ${i}: selected ${WORDS[11 - i]} must stay visible`);
	}
	assert.ok(body().some((l) => l.includes("alpha")));
	assert.ok(!body().some((l) => l.includes("lima")));
});

test("members pane keeps the selected member visible (windowing)", () => {
	const members = WORDS.map((w, i) => makeMember({ workerId: `ag_${i + 1}`, role: w }));
	const teams = [makeTeam("team_01", "t", members)];
	const { modal } = makeModal(TUI(16), teams); // 5 items visible
	let lines = modal.render(100);
	const body = () => lines.slice(1); // skip the header, which echoes the selected member
	assert.ok(body().some((l) => l.includes("alpha")));
	assert.ok(!body().some((l) => l.includes("lima")));
	for (let i = 1; i <= 11; i++) {
		modal.handleInput(DOWN);
		lines = modal.render(100);
		assert.ok(body().some((l) => l.includes(WORDS[i])), `step ${i}: selected ${WORDS[i]} must stay visible`);
	}
	assert.ok(body().some((l) => l.includes("lima")));
	assert.ok(!body().some((l) => l.includes("alpha")));
});

// ── roster and activity states ──────────────────────────────────────────────

test("states: member dots are failure-aware and status/availability are spelled out", () => {
	const states: [MemberState, string][] = [
		["working", "●"],
		["idle", "◐"],
		["failed", "✗"],
		["done", "✓"],
		["stopping", "◌"],
		["stopped", "⊘"],
		["unavailable", "○"],
	];
	const members = states.map(([state], i) =>
		makeMember({ workerId: `ag_${String(i + 1).padStart(2, "0")}`, role: `m-${state}`, state, status: state === "unavailable" ? "error" : "running" }),
	);
	// The unavailable one is pruned; a history member joins as previous-session.
	members[6]!.available = false;
	members[6]!.availability = "pruned";
	members[6]!.reason = "Removed from the manager by finished-worker retention; last known status shown.";
	members.push(makeMember({ workerId: "ag_08", role: "m-old", available: false, availability: "previous-session", state: "unavailable", status: undefined }));
	const teams = [makeTeam("team_01", "t", members)];
	const { modal } = makeModal(TUI(30), teams, new Map(states.slice(0, 6).map((_, i) => [`ag_${String(i + 1).padStart(2, "0")}`, makeWorker({ id: `ag_${String(i + 1).padStart(2, "0")}` })])));
	modal.handleInput(TAB); // pane titles echo counts; roster is the body
	const lines = modal.render(160);
	for (const [state, dot] of states) {
		const row = lines.slice(1).find((l) => l.includes(`m-${state}`) && l.includes(dot));
		assert.ok(row, `row for ${state} shows ${dot}`);
	}
	const pruned = lines.slice(1).find((l) => l.includes("unavailable · pruned") && l.includes("error"));
	assert.ok(pruned, "pruned member spells out last known status and availability");
	const previous = lines.slice(1).find((l) => l.includes("m-old") && l.includes("○"));
	assert.ok(previous, "previous-session member row is hollow");
	assert.ok(lines.slice(1).some((l) => l.includes("unavailable · history")), "previous-session availability spelled out");
});

test("roster: an ejected member stays listed with · ejected right after its state; the pane title counts it apart", () => {
	const members = [
		makeMember({ workerId: "ag_01", role: "keeper", state: "working", status: "running" }),
		makeMember({ workerId: "ag_02", role: "leaver", state: "stopped", status: "killed", ejectedAt: 5 }),
	];
	const { modal } = makeModal(TUI(30), [makeTeam("team_01", "t", members)], new Map([["ag_01", makeWorker({ id: "ag_01" })], ["ag_02", makeWorker({ id: "ag_02" })]]));
	modal.handleInput(TAB);
	const lines = modal.render(220);
	assert.ok(lines.some((l) => l.includes("stopped · ejected (killed)")), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("running") && l.includes("ejected")), "only the ejected member is marked");
	// The member pane's title is truncated to its width, so only its head is certain.
	assert.match(lines[0]!, /team_01 · 1 working · 1 ej/, "the roster title counts the ejected member apart, never as stopped");
});

test("activity: pruned member shows its reason and last known state, history member the history reason", () => {
	const pruned = makeMember({
		workerId: "ag_01",
		role: "builder",
		available: false,
		availability: "pruned",
		reason: "Removed from the manager by finished-worker retention; last known status shown.",
		state: "unavailable",
		status: "error",
		taskOutcome: "error",
		error: "provider blew up",
	});
	const old = makeMember({
		workerId: "ag_07",
		role: "lead",
		available: false,
		availability: "previous-session",
		reason: "Recorded in an earlier session or before reload; workers are session-scoped and were stopped. History only, never live.",
		state: "unavailable",
		status: undefined,
	});
	const teams = [makeTeam("team_01", "there", [old], { origin: "history" }), makeTeam("team_02", "here", [pruned])];
	const { modal } = makeModal(TUI(30), teams); // no workers: both members unavailable
	let lines = modal.render(140).map((l) => l.replace(/\s+$/, "")); // strip padding for substring checks
	assert.ok(lines.some((l) => l.includes("builder (ag_01) — unavailable")));
	assert.ok(lines.some((l) => l.includes("Removed from the manager")));
	assert.ok(lines.some((l) => l.includes("Last known: error · task error")));
	assert.ok(lines.some((l) => l.includes("provider blew up")));
	// Newest team is selected by default; pick the history one instead.
	modal.handleInput(TAB);
	modal.handleInput(UP);
	lines = modal.render(140).map((l) => l.replace(/\s+$/, ""));
	assert.ok(lines.some((l) => l.includes("lead (ag_07) — unavailable")));
	assert.ok(lines.some((l) => l.includes("Recorded in an earlier session")));
});

test("activity: a memberless team shows its objective instead of a blank pane", () => {
	const teams = [makeTeam("team_01", "empty", [], { objective: "Wrap and display this objective line across multiple columns so wrapping is exercised." })];
	const { modal } = makeModal(TUI(24), teams);
	const lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("empty (team_01)")));
	assert.ok(lines.some((l) => l.includes("Wrap and display this objective")));
	assert.ok(lines.some((l) => l.includes("no members")));
});

test("activity: live member shows its transcript, usage and latest control action", () => {
	const transcript = [
		{ ts: 1, kind: "task", text: "[Team assignment from the parent Pi session]\nObjective: build" },
		{ ts: 2, kind: "assistant", text: "done so far" },
	];
	const workers = new Map<string, Worker>([
		["ag_01", makeWorker({ id: "ag_01", transcript, sessionId: "sess-9", steerCount: 1, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 3, contextTokens: 0 } })],
	]);
	const action: TeamAction = { seq: 4, at: Date.now(), workerId: "ag_01", role: "builder", kind: "followUp", source: "user", state: "accepted-or-queued", preview: "go" };
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })], { actions: [action] })];
	const { modal } = makeModal(TUI(24), teams, workers);
	const lines = modal.render(120);
	assert.ok(lines.some((l) => l.includes("▸ TASK")));
	assert.ok(lines.some((l) => l.includes("done so far")));
	assert.ok(lines.some((l) => l.includes("3 turns") && l.includes("↑100") && l.includes("↓50") && l.includes("$0.0010") && l.includes("1 steer")));
	assert.ok(lines.some((l) => l.includes("#4 user followUp: accepted-or-queued")));
	assert.ok(lines.some((l) => l.includes("session sess-9")));
});

test("activity: failed and unknown control action states are highlighted, queued never claims execution", () => {
	for (const [state, reason] of [["failed", "busy"], ["unknown", undefined]] as const) {
		const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01" })]]);
		const action: TeamAction = { seq: 1, at: Date.now(), workerId: "ag_01", role: "builder", kind: "redirect", source: "parent", state, ...(reason ? { reason } : {}) };
		const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })], { actions: [action] })];
		const { modal } = makeModal(TUI(24), teams, workers, markTheme);
		const lines = modal.render(120);
		const row = lines.find((l) => l.includes("#1 parent redirect:"));
		assert.ok(row, state);
		assert.ok(row.includes(state));
		if (reason) assert.ok(row.includes(`— ${reason}`));
		assert.ok(!row.includes("executed"), "never claims execution");
		assert.ok(!row.includes("delivered"), "never claims delivery");
	}
});

// ── transcript scrolling ────────────────────────────────────────────────────

test("transcript: home pauses at the top, end resumes following, pageUp/Down step", () => {
	const transcript = Array.from({ length: 40 }, (_, i) => ({ ts: i, kind: "assistant", text: `T${String(i).padStart(2, "0")}` }));
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", transcript })]]);
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })])];
	const { modal } = makeModal(TUI(16), teams, workers);
	let lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T39")), "autoscroll shows the tail");
	assert.ok(!lines.some((l) => l.includes("[paused]")));

	modal.handleInput(HOME);
	lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T00")), "home shows the top");
	assert.ok(!lines.some((l) => l.includes("T39")));
	assert.ok(lines.some((l) => l.includes("[paused]")));

	modal.handleInput(PGDN);
	lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T09")), "pageDown steps forward");
	assert.ok(!lines.some((l) => l.includes("T04")));

	modal.handleInput(PGUP);
	lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T00")));

	modal.handleInput(END);
	lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("T39")), "end resumes following");
	assert.ok(!lines.some((l) => l.includes("[paused]")));
});

// ── selection semantics ─────────────────────────────────────────────────────

test("teams: follows the newest team until pinned, then resumes follow at the newest", () => {
	const teams = WORDS.slice(0, 3).map((w, i) => makeTeam(`team_0${i + 1}`, w, [makeMember({ workerId: `ag_${i + 1}`, role: w })]));
	const { modal } = makeModal(TUI(24), teams, new Map(), markTheme);
	modal.handleInput(TAB); // focus teams so the selection is highlighted
	const selectedLabel = () => modal.render(100).find((l) => l.includes("[selectedBg]{") && /[●✓✗◐○⊘◌]/.test(l) && !l.includes("owns:"));
	assert.ok(selectedLabel()?.includes("charlie"), "newest team selected by default");

	modal.handleInput(UP); // pin on bravo
	assert.ok(selectedLabel()?.includes("bravo"));
	teams.push(makeTeam("team_04", "delta", [makeMember({ workerId: "ag_04", role: "delta" })]));
	assert.ok(selectedLabel()?.includes("bravo"), "pinned selection ignores new teams");

	modal.handleInput(DOWN);
	modal.handleInput(DOWN); // back to the newest → follow mode resumes
	teams.push(makeTeam("team_05", "echo", [makeMember({ workerId: "ag_05", role: "echo" })]));
	assert.ok(selectedLabel()?.includes("echo"), "follow mode picks up the new newest team");
});

test("teams: switching teams resets the member selection to the first member", () => {
	const t1 = makeTeam("team_01", "teamone", [
		makeMember({ workerId: "ag_01", role: "A1" }),
		makeMember({ workerId: "ag_02", role: "A2" }),
	]);
	const t2 = makeTeam("team_02", "teamtwo", [makeMember({ workerId: "ag_03", role: "B1" })]);
	const { modal } = makeModal(TUI(24), [t1, t2]);
	const header = () => modal.render(100)[0]!;
	assert.ok(header().includes("B1"), "newest team selected initially");

	modal.handleInput(TAB); // focus teams
	modal.handleInput(UP); // t1
	assert.ok(header().includes("A1"), "member selection resets when switching teams");
	modal.handleInput(TAB); // focus members
	modal.handleInput(DOWN); // select A2
	assert.ok(header().includes("A2"));
	modal.handleInput(TAB);
	modal.handleInput(DOWN); // t2
	modal.handleInput(UP); // back to t1 — must be A1 again, not stale A2
	assert.ok(header().includes("A1"));
});

test("members: unread badge shows for unselected live members and clears on selection", () => {
	const workers = new Map<string, Worker>([
		["ag_01", makeWorker({ id: "ag_01" })],
		["ag_02", makeWorker({ id: "ag_02", unreadCount: 7 })],
	]);
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" }), makeMember({ workerId: "ag_02", role: "reviewer" })])];
	const { modal } = makeModal(TUI(24), teams, workers);
	let lines = modal.render(100);
	assert.ok(lines.some((l) => l.includes("●7")), "unread count badge visible");
	modal.handleInput(DOWN); // select reviewer
	lines = modal.render(100);
	assert.ok(!lines.some((l) => l.includes("●7")), "badge hidden for the selected (read) member");
	assert.equal((workers.get("ag_02") as { unreadCount: number }).unreadCount, 0, "cleared on the worker");
});

// ── stop confirmation ───────────────────────────────────────────────────────

test("stop confirmation: a stray letter cancels, two x presses stop exactly the selected member", () => {
	const { modal, host } = standardSetup();
	modal.handleInput("x");
	assert.ok(armed(modal), "first x arms");
	assert.ok(modal.render(100).some((l) => l.includes("press x again to stop builder (ag_01)")), "hint names the exact member");
	modal.handleInput("z");
	assert.ok(!armed(modal), "unrecognized key cancels");
	modal.handleInput("x");
	assert.ok(armed(modal), "x re-arms after cancel");
	modal.handleInput(DOWN); // select reviewer; moving cancels
	assert.ok(!armed(modal), "selection move cancels");
	modal.handleInput("x");
	modal.handleInput("x");
	assert.deepEqual(host.stops, ["ag_02"], "exact member ID, not a group");
	assert.ok(!armed(modal), "fired confirmation is cleared");
});

test("stop confirmation: any key cancels, including scroll keys and tab", () => {
	for (const key of [PGUP, HOME, TAB]) {
		const { modal, host } = standardSetup();
		modal.handleInput("x");
		assert.ok(armed(modal), `armed before ${JSON.stringify(key)}`);
		modal.handleInput(key);
		assert.ok(!armed(modal), `${JSON.stringify(key)} cancels`);
		assert.deepEqual(host.stops, []);
		modal.dispose();
	}
});

test("stop confirmation: escape closes the workspace instead of firing", () => {
	const { modal, host } = standardSetup();
	modal.handleInput("x");
	assert.ok(armed(modal));
	modal.handleInput(ESC);
	assert.equal(host.closed, 1);
	assert.deepEqual(host.stops, []);
});

test("stop confirmation: finished, stopped and unavailable members never arm", () => {
	for (const status of ["done", "killed"]) {
		const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", status })]]);
		const { modal, host } = makeModal(TUI(24), [makeTeam("t1", "t", [makeMember({ workerId: "ag_01", state: status === "done" ? "done" : "stopped", status: status as never })])], workers);
		modal.handleInput("x");
		modal.handleInput("x");
		assert.ok(!armed(modal), status);
		assert.deepEqual(host.stops, [], status);
	}
	// Unavailable (pruned/history) members have no live worker at all.
	const { modal, host } = makeModal(TUI(24), [makeTeam("t1", "t", [makeMember({ workerId: "ag_01", available: false, availability: "pruned", state: "unavailable" })])]);
	modal.handleInput("x");
	modal.handleInput("x");
	assert.ok(!armed(modal));
	assert.deepEqual(host.stops, []);
});

test("stop confirmation: a member pruned while armed is dropped before any fire", () => {
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01" })]]);
	const member = makeMember({ workerId: "ag_01" });
	const teams = [makeTeam("team_01", "t", [member])];
	const { modal, host } = makeModal(TUI(24), teams, workers);
	modal.handleInput("x");
	assert.ok(armed(modal));
	// Retention evicts the worker: the view flips to unavailable, the manager drops it.
	member.available = false;
	member.availability = "pruned";
	member.state = "unavailable";
	workers.delete("ag_01");
	modal.handleInput("x");
	assert.ok(!armed(modal), "stale confirmation cleared when nothing is stoppable");
	assert.deepEqual(host.stops, []);
});

test("stop confirmation: the teams pane never arms a team-wide stop", () => {
	const { modal, host } = standardSetup();
	modal.handleInput(TAB); // focus teams
	modal.handleInput("x");
	modal.handleInput("x");
	assert.ok(!armed(modal), "no team-wide stop in this milestone");
	assert.deepEqual(host.stops, []);
	// An armed member stop is also cancelled by moving to the teams pane and back.
	modal.handleInput(TAB);
	modal.handleInput("x");
	assert.ok(armed(modal));
	modal.handleInput(TAB);
	assert.ok(!armed(modal), "pane switch cancels");
	modal.handleInput("x");
	assert.ok(!armed(modal), "teams pane still does not arm");
	assert.deepEqual(host.stops, []);
});

// ── steering ────────────────────────────────────────────────────────────────

test("steer: r/f delegate the selected live member to the host with exact ID and mode", () => {
	const { modal, host } = standardSetup();
	modal.handleInput("r");
	modal.handleInput(DOWN);
	modal.handleInput("f");
	assert.deepEqual(host.steers, [
		{ workerId: "ag_01", mode: "redirect" },
		{ workerId: "ag_02", mode: "followUp" },
	]);
	assert.ok(modal.render(200).some((line) => line.includes("r redirect · f follow-up")));
	modal.handleInput(TAB); // teams focus never steers a member
	modal.handleInput("r");
	modal.handleInput("f");
	assert.equal(host.steers.length, 2);
	assert.ok(!modal.render(200).some((line) => line.includes("r redirect")));
});

test("steer: stopping, finished and unavailable members have no controls", () => {
	for (const status of ["done", "error", "killed", "stopping"]) {
		const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", status })]]);
		const { modal, host } = makeModal(TUI(24), [makeTeam("t1", "t", [makeMember({ workerId: "ag_01" })])], workers);
		modal.handleInput("r");
		modal.handleInput("f");
		assert.deepEqual(host.steers, [], status);
		assert.ok(!modal.render(200).some((line) => line.includes("r redirect")), status);
	}
	// Live "error" worker still tearing down per the runner: no controls.
	const tearingDown = new Map<string, Worker>([
		["ag_01", Object.assign(makeWorker({ id: "ag_01", status: "error" }), { isFinished: () => false, isStopping: () => true }) as unknown as Worker],
	]);
	const { modal: m2, host: h2 } = makeModal(TUI(24), [makeTeam("t1", "t", [makeMember({ workerId: "ag_01" })])], tearingDown);
	m2.handleInput("r");
	m2.handleInput("f");
	assert.deepEqual(h2.steers, []);
	// Pruned/previous-session members have no live worker: no controls.
	const { modal: m3, host: h3 } = makeModal(TUI(24), [
		makeTeam("t1", "t", [makeMember({ workerId: "ag_01", available: false, availability: "pruned", state: "unavailable" })]),
	]);
	m3.handleInput("r");
	m3.handleInput("f");
	assert.deepEqual(h3.steers, []);
	// Host without steer support: keys are inert but still cancel confirmations.
	const { modal: m4, host: h4 } = makeModal(
		TUI(24),
		[makeTeam("t1", "t", [makeMember({ workerId: "ag_01" })])],
		new Map([["ag_01", makeWorker({ id: "ag_01" })]]),
		plainTheme,
		(base) => ({ ...base, steerMember: undefined }) as unknown as TeamHost,
	);
	m4.handleInput("x");
	assert.ok(armed(m4));
	m4.handleInput("r");
	assert.deepEqual(h4.steers, []);
	assert.ok(!armed(m4), "unsupported steer key still cancels stop confirmation");
});

test("steer: both keys cancel an armed stop confirmation before calling the host", () => {
	for (const key of ["r", "f"]) {
		const teams = [makeTeam("t1", "t", [makeMember({ workerId: "ag_01" })])];
		const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01" })]]);
		const base = makeHost(teams, workers);
		let calls = 0;
		const modal = new TeamModal(TUI(24), plainTheme, {
			...base,
			steerMember() {
				calls++;
				assert.ok(!armed(modal), "confirmation cleared before callback");
			},
		});
		modal.handleInput("x");
		assert.ok(armed(modal));
		modal.handleInput(key);
		assert.equal(calls, 1);
		assert.deepEqual(base.stops, []);
		modal.dispose();
	}
});

// ── retention / roster mutation ─────────────────────────────────────────────

test("retention: roster rebuilds preserve member selection and steer targets", () => {
	for (const renderAfterPrune of [false, true]) {
		const workers = new Map<string, Worker>([
			["old", makeWorker({ id: "old", status: "done" })],
			["original", makeWorker({ id: "original", name: "original" })],
			["other", makeWorker({ id: "other", name: "other" })],
		]);
		const teams = [
			makeTeam("team_01", "t", [
				makeMember({ workerId: "old", role: "old", state: "done", status: "done" }),
				makeMember({ workerId: "original", role: "original" }),
				makeMember({ workerId: "other", role: "other" }),
			]),
		];
		const { modal, host } = makeModal(TUI(24), teams, workers);
		modal.render(120);
		modal.handleInput(DOWN);
		// Detached views are rebuilt by the host every read; simulate one rebuild
		// where the oldest member was dropped from the roster entirely.
		teams[0]!.members.splice(0, 1);
		if (renderAfterPrune) assert.ok(modal.render(120)[0]!.includes("original"));
		modal.handleInput("r");
		modal.handleInput("f");
		assert.deepEqual(host.steers, [
			{ workerId: "original", mode: "redirect" },
			{ workerId: "original", mode: "followUp" },
		]);
		assert.ok(modal.render(120)[0]!.includes("original"));
		modal.handleInput(DOWN);
		modal.handleInput("r");
		assert.deepEqual(host.steers.at(-1), { workerId: "other", mode: "redirect" });
		modal.dispose();
	}
});

test("retention: availability flip withdraws steer/stop and redraws honestly", () => {
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01" })]]);
	const member = makeMember({ workerId: "ag_01" });
	const teams = [makeTeam("team_01", "t", [member])];
	const { modal, host } = makeModal(TUI(24), teams, workers);
	assert.ok(modal.render(200).some((line) => line.includes("r redirect")));
	member.available = false;
	member.availability = "pruned";
	member.reason = "Removed from the manager by finished-worker retention; last known status shown.";
	member.state = "unavailable";
	workers.delete("ag_01");
	modal.handleInput("r");
	modal.handleInput("f");
	modal.handleInput("x");
	modal.handleInput("x");
	assert.deepEqual(host.steers, []);
	assert.deepEqual(host.stops, []);
	const lines = modal.render(200);
	assert.ok(!lines.some((line) => line.includes("r redirect")), "hint cache refreshes");
	assert.ok(lines.some((line) => line.includes("— unavailable")), "activity pane flips to unavailable");
});

// ── cache correctness ───────────────────────────────────────────────────────

test("cache: identical state returns the same lines; roster and transcript changes bust", () => {
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", transcript: [{ ts: 1, kind: "assistant", text: "one" }] })]]);
	const member = makeMember({ workerId: "ag_01" });
	const teams = [makeTeam("team_01", "t", [member])];
	const { modal } = makeModal(TUI(24), teams, workers);
	const r1 = modal.render(100);
	const r2 = modal.render(100);
	assert.equal(r2, r1, "same state must be served from cache");

	member.state = "failed";
	const r3 = modal.render(100);
	assert.notEqual(r3, r1, "roster state change must bust the cache");
	member.state = "working";
	(workers.get("ag_01")!.transcript as unknown[]).push({ ts: 2, kind: "assistant", text: "two" });
	const r4 = modal.render(100);
	assert.notEqual(r4, r3, "transcript growth must bust the cache");
	assert.ok(r4.some((l) => l.includes("two")));
});

test("wrap cache: re-renders hit, transcript/width changes miss, revision is preferred", () => {
	const worker = makeWorker({ id: "ag_01", transcript: [{ ts: 1, kind: "assistant", text: "one" }], transcriptRevision: 7 });
	const workers = new Map<string, Worker>([["ag_01", worker]]);
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })])];
	const { modal } = makeModal(TUI(24), teams, workers);
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 0, misses: 1 });
	modal.handleInput(TAB); // frame-cache bust, same transcript → wrap cache hit
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 1 });
	(worker.transcript as unknown[]).push({ ts: 2, kind: "assistant", text: "two" });
	(worker as unknown as { transcriptRevision: number }).transcriptRevision = 8;
	const lines = modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 2 });
	assert.ok(lines.some((l) => l.includes("two")));
	modal.handleInput(TAB);
	modal.render(100);
	assert.deepEqual(modal.wrapStats(), { hits: 2, misses: 2 });
	modal.render(120); // width change → re-wrap
	assert.deepEqual(modal.wrapStats(), { hits: 2, misses: 3 });
});

test("wrap cache: theme changes recolor labels and bodies without re-wrapping", () => {
	const colors: Record<string, number> = { accent: 31, warning: 32, muted: 33, error: 34, dim: 35 };
	const fg = (offset: number) => (color: string, text: string) => `\x1b[${(colors[color] ?? 37) + offset}m${text}\x1b[39m`;
	const theme = { ...plainTheme, fg: fg(0) };
	const transcript = [
		{ ts: 1, kind: "task", text: "task body" },
		{ ts: 2, kind: "steer", text: "steer body" },
		{ ts: 3, kind: "tool-result", text: "result body" },
		{ ts: 4, kind: "assistant", text: "assistant body" },
	];
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", transcript })]]);
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })])];
	const { modal } = makeModal(TUI(40), teams, workers, theme);
	const before = modal.render(120);
	assert.deepEqual(modal.wrapStats(), { hits: 0, misses: 1 });
	theme.fg = fg(60);
	modal.invalidate();
	const after = modal.render(120);
	assert.notEqual(after, before);
	assert.deepEqual(modal.wrapStats(), { hits: 1, misses: 1 });
	for (const [text, color] of [
		["▸ TASK", "accent"],
		["▸ NEW INSTRUCTIONS", "warning"],
		["↳ failed", "error"],
	]) {
		assert.ok(before.some((line) => line.includes(`\x1b[${colors[color]}m`) && line.includes(text)));
		assert.ok(after.some((line) => line.includes(`\x1b[${colors[color]! + 60}m`) && line.includes(text)));
	}
	for (const line of after) assert.equal(visibleWidth(line), 120);
});

// ── sanitization ─────────────────────────────────────────────────────────────

/** Dataset-derived junk that must never reach the terminal. \x notation only. */
const LEAKED_JUNK = ["\x1b]", "\x1b[2J", "\x1b[H", "\x1b[K", "\x07", "\x85", "\x9b", "\t", "\r", "http://"];

test("sanitize: labels, roles, paths and transcripts never leak control bytes", () => {
	const transcript = [
		{ ts: 1, kind: "task", text: "clean task" },
		{ ts: 2, kind: "tool", toolName: "ba\x1b[2Jsh", text: "rm -rf\x07 ~/x" },
		{ ts: 3, kind: "assistant", text: "line1\r\nline2\tend\x1b]8;;http://evil\x1b\\hidden" },
		{ ts: 4, kind: "system", text: "\x85 NEL \x9b C1" },
	];
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", transcript, sessionId: "s\tes" })]]);
	const teams = [
		makeTeam("team_01", "team\x1b]8;;http://x\x1b\\evil\nsecond\tend", [
			makeMember({ workerId: "ag_01", role: "b\x1b[2Juilder\rc", ownedPaths: ["src/a\x07b", "s\tc"] }),
		], { objective: "obj\t with \x1b[2J junk" }),
	];
	const { modal } = makeModal(TUI(24), teams, workers);
	const lines = modal.render(120);
	for (const line of lines) {
		for (const junk of LEAKED_JUNK) {
			assert.ok(!line.includes(junk), `leaked ${JSON.stringify(junk)}: ${JSON.stringify(line)}`);
		}
	}
	assert.ok(lines.some((l) => l.includes("teamevil second")), "team name is inlined");
	assert.ok(lines.some((l) => l.includes("builder c")), "role is inlined");
});

// ── misc ────────────────────────────────────────────────────────────────────

test("q closes the workspace", () => {
	const { modal, host } = standardSetup();
	modal.handleInput("q");
	assert.equal(host.closed, 1);
});

test("dispose is safe and render still works afterwards", () => {
	const { modal } = standardSetup();
	modal.handleInput("x");
	modal.dispose();
	assert.ok(!armed(modal));
	const lines = modal.render(100);
	assert.ok(lines.length > 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Integration: /team wiring in index.ts through the shared openWorkspace slot.
// ════════════════════════════════════════════════════════════════════════════

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(handler);
			return () => { listeners.get(name)?.delete(handler); };
		},
		emit(name: string, data: unknown) { for (const handler of listeners.get(name) ?? []) handler(data); },
	};
}

function harness(bus = eventBus()) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const workers: any[] = [];
	const notices: any[] = [];
	const messages: any[] = [];
	const appended: any[] = [];
	const ctx: any = {
		cwd: path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
		mode: "tui",
		hasUI: true,
		thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined as string | undefined },
		modelRegistry: {
			find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined),
		},
		ui: { setStatus() {}, notify: (...a: any[]) => notices.push(a) },
	};
	registerSubagents(
		{
			events: bus,
			registerTool: (t: any) => tools.set(t.name, t),
			on: (e: string, f: any) => events.set(e, f),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerShortcut() {},
			appendEntry: (customType: unknown, data: unknown) => appended.push({ customType, data }),
			getActiveTools: () => ["read", "bash", "agent_spawn"],
			sendMessage: (...m: any[]) => messages.push(m),
		} as any,
		(options, handlers) => {
			const worker: any = {
				...options,
				wake: options.wake ?? true,
				extensions: options.extensions ?? [],
				forked: Boolean(options.forkSession),
				processAlive: true,
				status: "running",
				error: undefined,
				transcript: [],
				transcriptRevision: 1,
				usage: { input: 0, output: 0, turns: 0 },
				steerCount: 0,
				unreadCount: 0,
				isFinished() {
					return ["killed", "done", "error"].includes(this.status);
				},
				isSettled() {
					return this.isFinished() || this.status === "waiting";
				},
				finalOutput() {
					return this.output ?? "";
				},
				change() { handlers.onChange(); },
				async steer(message: string, signal?: AbortSignal, mode?: string) {
					this.lastSteer = { message, mode };
					this.steerCount++;
					this.status = "running";
					return { ok: true };
				},
				async kill() {
					await new Promise((r) => setTimeout(r, 5));
					this.status = "killed";
					this.processAlive = false;
				},
				async dispose() {
					await this.kill();
					this.disposed = true;
				},
				exit(status = "done") {
					this.status = status;
					this.processAlive = false;
					handlers.onExit(this);
				},
			};
			workers.push(worker);
			return worker;
		},
	);
	return {
		bus,
		workers,
		ctx,
		notices,
		messages,
		appended,
		tools,
		commands,
		call: (name: string, params: any = {}, signal?: AbortSignal) =>
			tools.get(name).execute("test", params, signal, () => {}, ctx),
		event: (name: string, data: any) => events.get(name)?.(data, ctx),
		start: () => events.get("session_start")({}, ctx),
		close: () => events.get("session_shutdown")({}, ctx),
	};
}

type CapturedOverlay = {
	view: TeamModal;
	done: (value: null) => void;
	visibility: boolean[];
	focusCount: () => number;
	calls: () => number;
};

/** ui.custom mock capturing factory output, overlay handle visibility and focus. */
function captureOverlay(ctx: any, opts: { onFactory?: () => void } = {}): (factory: any, options: any) => Promise<null> {
	const state = { focusCount: 0, calls: 0 };
	const capture: CapturedOverlay = {
		view: undefined as unknown as TeamModal,
		done: () => {},
		visibility: [],
		focusCount: () => state.focusCount,
		calls: () => state.calls,
	};
	ctx.ui.custom = (factory: any, options: any) =>
		new Promise<null>((resolve) => {
			state.calls++;
			capture.done = resolve;
			options?.onHandle?.({
				setHidden: (hidden: boolean) => capture.visibility.push(hidden),
				focus: () => state.focusCount++,
			});
			capture.view = factory({ requestRender() {} }, { fg: (_: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve);
			opts.onFactory?.();
		});
	ctx.__overlay = capture;
	return ctx.ui.custom;
}

const overlayOf = (ctx: any): CapturedOverlay => ctx.__overlay;

test("integration: /team opens TeamModal through the shared workspace slot; exclusivity in both directions", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		// Bare /team opens the team workspace.
		const opened = h.commands.get("team").handler("", h.ctx);
		const overlay = overlayOf(h.ctx);
		assert.ok(overlay.view instanceof TeamModal, "the /team workspace is a TeamModal");
		assert.equal(overlay.calls(), 1);
		const lines = overlay.view.render(120);
		assert.ok(lines.some((l) => l.includes("Teams (0)")), "team workspace chrome renders");
		// /agents while /team is open is refused with a notice; no second overlay.
		await h.commands.get("agents").handler("", h.ctx);
		assert.equal(overlay.calls(), 1, "no second overlay");
		assert.ok(h.notices.some((n) => /Close the \/team workspace before opening \/agents/.test(n[0])));
		// Same-kind reopen is a quiet no-op.
		await h.commands.get("team").handler("", h.ctx);
		assert.equal(overlay.calls(), 1);
		// Close /team, open /agents, then /team is refused instead.
		overlay.done(null);
		await opened;
		const agentsOpened = h.commands.get("agents").handler("", h.ctx);
		assert.equal(overlay.calls(), 2);
		assert.ok(!(overlay.view instanceof TeamModal), "the /agents workspace is the monitor");
		await h.commands.get("team").handler("", h.ctx);
		assert.equal(overlay.calls(), 2, "still one overlay");
		assert.ok(h.notices.some((n) => /Close the \/agents workspace before opening \/team/.test(n[0])));
		overlay.done(null);
		await agentsOpened;
		// Never a message, never a worker.
		assert.equal(h.messages.length, 0);
		assert.equal(h.workers.length, 0);
	} finally { await h.close(); }
});

test("integration: backend dialog tokens hide the team workspace until all close, without stale restoration", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		const dialog = (token: string, open: boolean) => h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token, open });
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 2, token: "bad", open: true });
		h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "", open: true });
		assert.deepEqual(overlay.visibility, []);
		dialog("one", true); dialog("one", true); dialog("two", true);
		assert.deepEqual(overlay.visibility, [true]);
		dialog("unknown", false); dialog("one", false);
		assert.deepEqual(overlay.visibility, [true]);
		dialog("two", false); dialog("two", false);
		assert.deepEqual(overlay.visibility, [true, false]);
		assert.equal(overlay.focusCount(), 1);
		dialog("shutdown", true);
		await h.close(); await opened;
		dialog("shutdown", false); dialog("late", true); dialog("late", false);
		assert.deepEqual(overlay.visibility, [true, false, true], "no restoration after shutdown");
	} finally { await h.close(); }
});

for (const handleFirst of [true, false]) {
	test(`integration: team workspace opened during backend dialog synchronizes visibility (handle first: ${handleFirst})`, async () => {
		const h = harness();
		const state = { focusCount: 0 };
		const visibility: boolean[] = [];
		const handle = { setHidden: (hidden: boolean) => visibility.push(hidden), focus: () => state.focusCount++ };
		h.ctx.ui.custom = (factory: any, options: any) =>
			new Promise((resolve) => {
				if (handleFirst) options.onHandle(handle);
				factory({ requestRender() {} }, { fg: (_: string, t: string) => t }, {}, resolve);
				if (!handleFirst) options.onHandle(handle);
			});
		try {
			h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "already-open", open: true });
			const opened = h.commands.get("team").handler("", h.ctx);
			assert.deepEqual(visibility, [true], "workspace opens hidden while a dialog is active");
			assert.equal(state.focusCount, 0);
			h.bus.emit(BACKEND_DIALOG_EVENT, { version: 1, token: "already-open", open: false });
			assert.deepEqual(visibility, [true, false]);
			assert.equal(state.focusCount, 1);
			await h.close(); await opened;
		} finally { await h.close(); }
	});
}

test("integration: the real Claude permission emitter hides and restores the team workspace", async () => {
	const bus = eventBus();
	// Subagents owns the workspace; Claude registration is real up to the
	// permission queue/dialog events (its create() is never exercised here).
	const h = harness(bus);
	let backend: any;
	bus.on(BACKEND_REGISTER_EVENT, (b: any) => { backend = b; });
	registerClaudeCode({ events: bus, on: () => {}, registerFlag: () => {}, getFlag: () => undefined } as any);
	assert.ok(backend, "backend registered with the manager");
	captureOverlay(h.ctx);
	const overlay = overlayOf(h.ctx);
	const opened = h.commands.get("team").handler("", h.ctx);
	try {
		const permission = backend.prepare({ prompt: "task" }, h.ctx).onPermission;
		h.ctx.ui.confirm = async () => {
			assert.equal(overlay.visibility.at(-1), true, "permission dialog must not be covered by the team workspace");
			return true;
		};
		const decision = await permission({ requestId: "p", toolName: "Bash", input: { command: "echo test" }, workerId: "ag_01", workerName: "reviewer", cwd: h.ctx.cwd }, new AbortController().signal);
		assert.equal(decision.behavior, "allow");
		assert.deepEqual(overlay.visibility.slice(-2), [true, false], "hidden during the dialog, restored after");
	} finally {
		overlay.done(null);
		await opened;
		await h.close();
	}
});

test("integration: follow-up and redirect editors reach the exact member, record the action, and hide the workspace", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		await h.call("team_create", {
			name: "core",
			objective: "obj",
			members: [
				{ role: "builder", prompt: "build", wake: false },
				{ role: "reviewer", prompt: "review", wake: false },
			],
		});
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		const titles: string[] = [];
		h.ctx.ui.editor = async (title: string) => {
			titles.push(title);
			return "keep going";
		};
		// Focus starts on the members pane; the first member (builder) is selected.
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(titles, ["Follow up: builder (ag_01)"]);
		assert.deepEqual(h.workers[0].lastSteer, { message: "keep going", mode: "followUp" });
		assert.deepEqual(overlay.visibility, [true, false], "workspace hidden while composing, restored after");
		assert.equal(overlay.focusCount(), 1);
		// The action is recorded honestly: accepted-or-queued, never "executed".
		let list = await h.call("team_list");
		assert.equal(list.details.teams[0].actions.length, 1);
		assert.deepEqual(
			list.details.teams[0].actions[0].state,
			"accepted-or-queued",
		);
		assert.equal(list.details.teams[0].actions[0].kind, "followUp");
		assert.equal(list.details.teams[0].actions[0].source, "user");
		assert.equal(list.details.teams[0].actions[0].preview, "keep going");
		// Redirect names the member and carries the interrupt warning; kind is recorded.
		overlay.view.handleInput("j"); // reviewer
		await new Promise((r) => setTimeout(r, 0));
		overlay.view.handleInput("r");
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(titles[1], "Redirect: reviewer (ag_02) — interrupts current task");
		assert.deepEqual(h.workers[1].lastSteer, { message: "keep going", mode: "redirect" });
		list = await h.call("team_list");
		assert.equal(list.details.teams[0].actions[1].kind, "redirect");
		// Cancelled editor: nothing is delivered or recorded.
		h.ctx.ui.editor = async () => undefined;
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.workers[1].steerCount, 1, "cancel reached nothing");
		assert.equal((await h.call("team_list")).details.teams[0].actions.length, 2, "cancelled editors record no action");
		overlay.done(null);
		await opened;
		assert.equal(h.messages.length, 0, "workspace actions never message the parent model");
	} finally { await h.close(); }
});

test("integration: rejected steers notify without claiming failure to the model; errors notify too", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		await h.call("team_create", { name: "core", objective: "obj", members: [{ role: "builder", prompt: "build", wake: false }] });
		h.workers[0].steer = async () => ({ ok: false, reason: "shutting down" });
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		h.ctx.ui.editor = async () => "again";
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(h.notices.some((n) => /Cannot steer ag_01: shutting down/.test(n[0]) && n[1] === "warning"));
		const list = await h.call("team_list");
		assert.equal(list.details.teams[0].actions[0].state, "failed");
		h.workers[0].steer = async () => { throw new Error("transport exploded"); };
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(h.notices.some((n) => /transport exploded/.test(n[0]) && n[1] === "error"));
		assert.equal((await h.call("team_list")).details.teams[0].actions[1].state, "failed");
		overlay.done(null);
		await opened;
	} finally { await h.close(); }
});

test("integration: double-x stops exactly the selected member through the shared kill path", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		await h.call("team_create", {
			name: "core",
			objective: "obj",
			members: [
				{ role: "builder", prompt: "build", wake: false },
				{ role: "reviewer", prompt: "review", wake: false },
			],
		});
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		overlay.view.handleInput("x");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.workers[0].status, "running", "single x only arms");
		overlay.view.handleInput("x");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(h.workers[0].status, "killed");
		assert.equal(h.workers[1].status, "running", "the other member is untouched");
		const list = await h.call("team_list");
		const actions = list.details.teams[0].actions;
		assert.equal(actions.length, 1);
		assert.equal(actions[0].kind, "stop");
		assert.equal(actions[0].source, "user");
		assert.equal(actions[0].state, "accepted-or-queued");
		// The stopped member is no longer steerable/stoppable in the workspace.
		overlay.view.handleInput("k"); // builder still selected (only moved if user moves)
		overlay.view.handleInput("j");
		assert.ok(overlay.view.render(120)[0]!.includes("reviewer"), "selection still works after the stop");
		overlay.done(null);
		await opened;
	} finally { await h.close(); }
});

test("integration: shutdown with a team editor open never restores a stale overlay or delivers late input", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		await h.call("team_create", { name: "core", objective: "obj", members: [{ role: "builder", prompt: "build", wake: false }] });
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		let finishEditor!: (text: string) => void;
		h.ctx.ui.editor = () => new Promise<string>((resolve) => { finishEditor = resolve; });
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(overlay.visibility, [true], "hidden while composing");
		await h.close();
		finishEditor("late instructions");
		await opened;
		assert.deepEqual(overlay.visibility, [true], "no stale restoration");
		assert.equal(h.workers[0].steerCount, 0, "late editor input is never delivered after shutdown");
	} finally { await h.close(); }
});

test("integration: pruned members render with last known status through live team views", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	try {
		await h.call("team_create", { name: "ops", objective: "obj", members: [{ role: "worker", prompt: "p", wake: false }] });
		const member = h.workers[0];
		member.error = "boom";
		member.exit("error");
		for (let i = 0; i < 55; i++) {
			await h.call("agent_spawn", { prompt: `filler ${i}`, wake: false });
			h.workers.at(-1).exit();
		}
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		const text = overlay.view.render(140).map((l: string) => l.replace(/\s+$/, "")).join("\n");
		assert.ok(text.includes("worker ag_01"), "exact worker ID still shown");
		assert.ok(text.includes("— unavailable"), "member is unavailable");
		assert.ok(text.includes("Removed from the manager by finished-worker retention"), "pruned reason shown");
		assert.ok(text.includes("Last known: error"), "last known status shown");
		// Steering a pruned member from the workspace is impossible; tools agree.
		overlay.view.handleInput("r");
		overlay.view.handleInput("f");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.notices.filter((n) => n[1] === "error").length, 0, "no steer attempted for a pruned member");
		overlay.done(null);
		await opened;
		await assert.rejects(h.call("agent_steer", { id: "ag_01", message: "late" }), /unavailable/);
	} finally { await h.close(); }
});

test("integration: history teams render read-only in the workspace; counters and branch rules hold", async () => {
	const h = harness();
	captureOverlay(h.ctx);
	const teamEntry = (data: unknown) => ({ type: "custom", customType: "subagents-team-v1", data });
	const old = teamEntry({
		version: 1,
		op: "create",
		team: { id: "team_04", name: "Old", objective: "past", createdAt: 1 },
		members: [{ workerId: "ag_03", role: "lead", ownedPaths: ["src"], backend: "claude-code", model: "opus", groupId: "run_02", addedAt: 1 }],
	});
	try {
		h.ctx.sessionManager.getEntries = () => [old];
		h.ctx.sessionManager.getBranch = () => [old];
		await h.start();
		const overlay = overlayOf(h.ctx);
		const opened = h.commands.get("team").handler("", h.ctx);
		const text = overlay.view.render(140).map((l: string) => l.replace(/\s+$/, "")).join("\n");
		assert.ok(text.includes("Old"), "history team listed by name");
		assert.ok(text.includes("history"), "marked as history");
		assert.ok(text.includes("lead ag_03"), "history member listed with exact ID");
		assert.ok(text.includes("unavailable · history"), "member availability spelled out");
		assert.ok(text.includes("Recorded in an earlier session"), "history reason in the activity pane");
		// History members cannot be steered or stopped from the workspace.
		overlay.view.handleInput("r");
		overlay.view.handleInput("f");
		overlay.view.handleInput("x");
		overlay.view.handleInput("x");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.workers.length, 0, "restored members are never adopted");
		assert.equal(h.messages.length, 0);
		overlay.done(null);
		await opened;
	} finally { await h.close(); }
});

// ── accordion code folding ──────────────────────────────────────────────────

test("code folding: member transcripts fold by default and o toggles them", () => {
	const content = Array.from({ length: 30 }, (_, i) => `\t\tconst line${i} = ${i};`).join("\n");
	const transcript = [
		{ ts: 1, kind: "tool", toolName: "Edit", text: JSON.stringify({ file_path: "/r/a.ts", old_string: "x", new_string: content }) },
		{ ts: 2, kind: "assistant", text: `Done:\n\`\`\`ts\n${content}\n\`\`\`\nAll good.` },
	];
	const workers = new Map<string, Worker>([["ag_01", makeWorker({ id: "ag_01", transcript, transcriptRevision: 3 })]]);
	const teams = [makeTeam("team_01", "t", [makeMember({ workerId: "ag_01" })])];
	const { modal } = makeModal(TUI(40), teams, workers);
	let lines = modal.render(160);
	assert.ok(lines.some((l) => l.includes("✎ edit /r/a.ts  +30 −1")));
	assert.ok(lines.some((l) => /▕ ts ▕ const line0 = 0; +▕ 30 lines ▕ o ▕/.test(l)));
	assert.ok(lines.some((l) => l.includes("All good.")), "prose around a folded block stays visible");
	assert.ok(!lines.some((l) => l.includes("const line29")));
	assert.ok(lines.some((l) => l.includes("o expand code")));
	const misses = modal.wrapStats().misses;

	modal.handleInput("o");
	lines = modal.render(160);
	assert.ok(lines.some((l) => l.includes("const line29")));
	assert.ok(lines.some((l) => l.includes("o collapse code")));
	assert.equal(modal.wrapStats().misses, misses + 1, "toggle re-wraps despite an unchanged revision");
});
