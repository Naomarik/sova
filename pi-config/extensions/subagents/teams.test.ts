import { test } from "node:test";
import assert from "node:assert/strict";
import {
	HISTORY_REASON,
	MAX_HISTORY_TEAMS,
	MAX_SESSION_TEAMS,
	MAX_TEAM_ACTIONS,
	MAX_TEAM_MEMBERS,
	ASSIGNMENT_ENTRY_TYPE,
	MAX_OPERATOR_STEERS,
	PRUNED_REASON,
	STEER_KEEP_CHARS,
	TEAM_ENTRY_TYPE,
	TEAM_EVENT_ENTRY_TYPE,
	TeamStore,
	assignmentText,
	composeMemberPrompt,
	decodeAssignmentEntry,
	decodeTeamEntry,
	inheritedSteersText,
	pausedTeamsFrom,
	workerSuccessorTask,
	memberState,
	memberTooling,
	resolveMemberSpec,
	type PersistedMember,
	type WorkerObservation,
} from "./teams.ts";

const member = (i: number, extra: Partial<PersistedMember> = {}): PersistedMember => ({
	workerId: `ag_${String(i).padStart(2, "0")}`, role: `role ${i}`, ownedPaths: [], backend: "pi", groupId: "run_01", addedAt: 1, ...extra,
});
const entry = (data: unknown) => ({ type: "custom", customType: TEAM_ENTRY_TYPE, data });
const create = (id: string, name: string, members: PersistedMember[]) =>
	entry({ version: 1, op: "create", team: { id, name, objective: `objective of ${name}`, createdAt: 1 }, members });
/** Commit a prepared create the way index.ts does after a successful spawn. */
function commit(store: TeamStore, name: string, roles: string[], firstWorker = 1) {
	const prepared = store.prepareCreate({ name, objective: "obj", members: roles.map((role) => ({ role, prompt: "task" })) });
	const members = prepared.members.map((m, i) => member(firstWorker + i, { role: m.role, ownedPaths: m.ownedPaths }));
	store.commitCreate(prepared, 1, members);
	prepared.release();
	return { prepared, members };
}
const running: WorkerObservation = { status: "running", processAlive: true, settled: false, finished: false };

test("composed member header is exact and deterministic", () => {
	const team = { id: "team_03", name: "Auth", objective: "Fix login\nKeep API stable" };
	assert.equal(
		composeMemberPrompt(team, { role: "backend", ownedPaths: ["src/api", "src/db"] }, [{ role: "tests", ownedPaths: [] }], "Do the thing.", "creation"),
		[
			"[Team assignment from the parent Pi session]",
			"Team: Auth (team_03)",
			"Objective: Fix login\nKeep API stable",
			"Your role: backend",
			"Your declared ownership: src/api, src/db",
			"Other members at team creation:",
			"- tests: none declared",
			"Declared ownership is advisory coordination, not a lock: all members share one filesystem, so avoid editing paths another member owns unless your task says to.",
			"Messages from teammates, an orchestrator or the parent session can arrive as new instructions in your session. You have no tool to reply to teammates directly, so put anything meant for them in your final answer; the parent session coordinates, and your final answer is your report.",
			"If your final answer would run past about 3,500 characters, write the full report to a file and make your final message that file's path plus a short summary.",
			"",
			"[Your task]",
			"Do the thing.",
		].join("\n"),
		"default tooling is none (a non-pi backend): the header never promises tools the worker lacks",
	);
	const alone = composeMemberPrompt(team, { role: "solo", ownedPaths: [] }, [], "x", "addition");
	assert.match(alone, /Your declared ownership: none declared\nOther members when you joined:\n- none\n/);
	// pi members are told exactly which team tools they have; orchestrators get the sibling powers and the no-spawn rule.
	const pi = composeMemberPrompt(team, { role: "dev", ownedPaths: [] }, [{ role: "lead", ownedPaths: ["src"], orchestrator: true }], "x", "creation", "pi");
	assert.match(pi, /^Your role: dev$/m);
	assert.match(pi, /^- lead \(orchestrator\): src$/m);
	assert.match(pi, /^Team tools: team_msg .*team_inbox .*team_ask /m);
	assert.match(pi, /^You cannot spawn, add or stop workers, and nothing you do reaches outside this team; the parent session remains the authority\. Your final answer is your report\.$/m);
	assert.doesNotMatch(pi, /team_roster|team_steer|orchestrator:/);
	const lead = composeMemberPrompt(team, { role: "lead", ownedPaths: ["src"], orchestrator: true }, [{ role: "dev", ownedPaths: [] }], "x", "creation", "pi");
	assert.match(lead, /^Your role: lead \(orchestrator\)$/m);
	assert.match(lead, /^You are this team's orchestrator: .*team_roster .*team_steer .*team_msg .*team_ask /m);
	assert.match(lead, /You cannot spawn, add or stop workers.*Acceptance of a steer or message is not execution.*report of the team's outcome\.$/m);
	// A pi header never claims the worker cannot message; a none header never claims tools.
	assert.doesNotMatch(pi, /cannot message/);
	assert.doesNotMatch(alone, /team_msg/);
	// A claude-code member has the same tools through the "team" MCP server: the header names the prefixed call names once, then reuses the pi text.
	const mcp = composeMemberPrompt(team, { role: "dev", ownedPaths: [] }, [{ role: "lead", ownedPaths: ["src"], orchestrator: true }], "x", "creation", "mcp");
	assert.equal(mcp.replace(/^Your team tools come from the "team" MCP server, so call them as mcp__team__team_msg, mcp__team__team_inbox, mcp__team__team_ask; below they are named without the mcp__team__ prefix\.\n/m, ""), pi, "identical apart from the naming line");
	assert.doesNotMatch(mcp, /mcp__team__team_roster|mcp__team__team_steer/);
	const mcpLead = composeMemberPrompt(team, { role: "lead", ownedPaths: ["src"], orchestrator: true }, [{ role: "dev", ownedPaths: [] }], "x", "creation", "mcp");
	assert.match(mcpLead, /^Your team tools come from the "team" MCP server, so call them as mcp__team__team_roster, mcp__team__team_steer, mcp__team__team_msg, mcp__team__team_inbox, mcp__team__team_ask; .*\nYou are this team's orchestrator: /m);
	assert.equal(mcpLead.replace(/^Your team tools come from .*\n/m, ""), lead);
	assert.equal(memberTooling("pi"), "pi");
	assert.equal(memberTooling("claude-code"), "mcp");
	assert.equal(memberTooling("codex"), "none");
});

test("orchestrator flag: pi or claude-code only, carried through prepare, persisted entries, views and sibling lookup", () => {
	const store = new TeamStore();
	const base = { name: "Crew", objective: "obj" };
	assert.throws(
		() => store.prepareCreate({ ...base, members: [{ role: "lead", prompt: "t", orchestrator: true, backend: "codex" }] }),
		/Orchestrator lead must use the pi or claude-code backend.*codex worker cannot load/,
	);
	assert.throws(
		() => store.prepareCreate({ ...base, defaults: { backend: "codex" }, members: [{ role: "lead", prompt: "t", orchestrator: true }] }),
		/must use the pi or claude-code backend/,
	);
	assert.throws(() => store.prepareCreate({ ...base, members: [{ role: "lead", prompt: "t", orchestrator: "yes" as any }] }), /must be a boolean/);
	assert.equal(store.teamCounter, 0);
	// A claude-code orchestrator is accepted (it gets the tools through the MCP server) and its header uses the prefixed names.
	const claude = new TeamStore().prepareCreate({ ...base, defaults: { backend: "claude-code" }, members: [{ role: "lead", prompt: "t", orchestrator: true }, { role: "dev", prompt: "t" }] });
	assert.deepEqual(claude.members.map((m) => [m.orchestrator, m.spec.backend]), [[true, "claude-code"], [false, "claude-code"]]);
	assert.match(claude.members[0].spec.prompt, /mcp__team__team_roster.*\nYou are this team's orchestrator/);
	assert.match(claude.members[1].spec.prompt, /mcp__team__team_msg.*\nTeam tools: team_msg/);
	claude.release();
	// An explicit pi member under Claude defaults is fine; the flag survives into the prepared member and its header.
	const prepared = store.prepareCreate({
		...base, defaults: { backend: "claude-code", model: "opus" },
		members: [{ role: "lead", prompt: "t", orchestrator: true, backend: "pi" }, { role: "dev", prompt: "t" }, { role: "qa", prompt: "t", orchestrator: false, backend: "pi" }],
	});
	assert.deepEqual(prepared.members.map((m) => [m.role, m.orchestrator, m.spec.backend]), [["lead", true, "pi"], ["dev", false, "claude-code"], ["qa", false, "pi"]]);
	assert.match(prepared.members[0].spec.prompt, /Your role: lead \(orchestrator\)/);
	assert.match(prepared.members[1].spec.prompt, /- lead \(orchestrator\): none declared/);
	assert.match(prepared.members[1].spec.prompt, /mcp__team__team_msg.*\nTeam tools: team_msg/, "Claude member header names its MCP tools");
	assert.doesNotMatch(prepared.members[1].spec.prompt, /no tool to reply/);
	assert.match(prepared.members[2].spec.prompt, /Team tools: team_msg/);
	const members = prepared.members.map((m, i) => member(i + 1, { role: m.role, backend: m.spec.backend, ...(m.orchestrator ? { orchestrator: true } : {}) }));
	store.commitCreate(prepared, 1, members);
	prepared.release();
	// Persisted entries keep the flag strictly optional/boolean.
	const entry = store.createEntry(prepared, 1, members);
	assert.equal(decodeTeamEntry(entry)!.members[0].orchestrator, true);
	assert.equal("orchestrator" in decodeTeamEntry(entry)!.members[1], false);
	assert.equal(decodeTeamEntry({ ...entry, members: [{ ...members[0], orchestrator: 1 }] }), undefined);
	const views = store.views((id) => (id === "ag_01" ? running : undefined));
	assert.deepEqual(views[0].members.map((m) => m.orchestrator), [true, false, false]);
	// Sibling lookup: role (normalized) or exact ID within the same team; never self, never outsiders.
	const info = store.memberInfo("ag_01")!;
	assert.deepEqual([info.team.id, info.member.role, info.member.orchestrator, info.siblings.map((m) => m.workerId)], ["team_01", "lead", true, ["ag_02", "ag_03"]]);
	assert.equal(store.memberInfo("ag_09"), undefined);
	assert.equal(store.resolveSibling("ag_01", " DEV ").workerId, "ag_02");
	assert.equal(store.resolveSibling("ag_01", "ag_03").role, "qa");
	assert.throws(() => store.resolveSibling("ag_01", "lead"), /cannot address yourself/);
	assert.throws(() => store.resolveSibling("ag_01", "ag_01"), /cannot address yourself/);
	assert.throws(() => store.resolveSibling("ag_01", "ag_42"), /not a member of team_01/);
	assert.throws(() => store.resolveSibling("ag_01", "ghost"), /No member with role ghost in team_01\. Known roles: dev, qa\./);
	assert.throws(() => store.resolveSibling("ag_42", "dev"), /not a member of a session team/);
	// team_add applies the same rule with the team's defaults and marks existing orchestrators in the newcomer's header.
	const add = store.prepareAdd("Crew", [{ role: "docs", prompt: "t", backend: "pi" }]);
	assert.match(add.members[0].spec.prompt, /- lead \(orchestrator\): none declared\n- dev: none declared\n- qa: none declared/);
	add.release();
	assert.throws(() => store.prepareAdd("Crew", [{ role: "boss", prompt: "t", orchestrator: true, backend: "codex" }]), /must use the pi or claude-code backend/);
	const boss = store.prepareAdd("Crew", [{ role: "boss", prompt: "t", orchestrator: true }]);
	assert.deepEqual([boss.members[0].orchestrator, boss.members[0].spec.backend], [true, "claude-code"], "team defaults (claude-code) now admit an orchestrator");
	boss.release();
	// Actions from members and orchestrators are recorded with their own sources and kinds.
	const action = store.recordAction("ag_02", "message", "member", "hello")!;
	assert.deepEqual([action.kind, action.source, action.role], ["message", "member", "dev"]);
	assert.equal(store.recordAction("ag_02", "question", "orchestrator")!.kind, "question");
});

test("defaults apply only to the same backend; member fields win; pi is the default backend", () => {
	const defaults = { backend: "claude-code", model: "opus[1m]", effort: "high", backendOptions: { permissionMode: "manual", maxBudgetUsd: 1 } };
	assert.deepEqual(resolveMemberSpec({ role: "r", prompt: "p" }, "r", "P", defaults), {
		name: "r", prompt: "P", backend: "claude-code", model: "opus[1m]", effort: "high", backendOptions: { permissionMode: "manual", maxBudgetUsd: 1 },
	});
	assert.deepEqual(
		resolveMemberSpec({ role: "r", prompt: "p", model: "sonnet", backendOptions: { permissionMode: "plan" } }, "r", "P", defaults).backendOptions,
		{ permissionMode: "plan", maxBudgetUsd: 1 },
	);
	// A pi member never inherits Claude-native model/effort/options.
	assert.deepEqual(resolveMemberSpec({ role: "r", prompt: "p", backend: "pi" }, "r", "P", defaults), { name: "r", prompt: "P", backend: "pi" });
	assert.deepEqual(resolveMemberSpec({ role: "r", prompt: "p", wake: false, tools: [], cwd: "x" }, "r", "P", undefined), {
		name: "r", prompt: "P", backend: "pi", wake: false, tools: [], cwd: "x",
	});
	assert.equal(resolveMemberSpec({ role: "r", prompt: "p" }, "r", "P", { model: "test/model" }).model, "test/model");
});

test("create validation: labels, roles, paths, objective, uniqueness and limits", () => {
	const store = new TeamStore();
	const ok = { name: "Auth", objective: "obj", members: [{ role: "a", prompt: "t" }] };
	for (const [input, pattern] of [
		[{ ...ok, name: "  " }, /name must not be blank/],
		[{ ...ok, name: "a\u0007b" }, /control/],
		[{ ...ok, name: "x".repeat(65) }, /exceeds 64/],
		[{ ...ok, name: "team_07" }, /looks like a team ID/],
		[{ ...ok, objective: " " }, /objective must not be blank/],
		[{ ...ok, objective: "x".repeat(4001) }, /exceeds 4000/],
		[{ ...ok, objective: "a\u0000" }, /control/],
		[{ ...ok, members: [] }, /at least one/],
		[{ ...ok, members: [{ role: "Dev", prompt: "t" }, { role: " dev ", prompt: "t" }] }, /Duplicate role/],
		[{ ...ok, members: [{ role: "ag_01", prompt: "t" }] }, /looks like a worker ID/],
		[{ ...ok, members: [{ role: "a", prompt: "  " }] }, /Task for a must not be blank/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: [" "] }] }, /blank entries/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: ["a\nb"] }] }, /one line/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: Array.from({ length: 33 }, (_, i) => `p${i}`) }] }, /exceeds 32/],
	] as const) assert.throws(() => store.prepareCreate(input as any), pattern);
	assert.equal(store.teamCounter, 0, "rejected input never consumes a team ID");
	const prepared = store.prepareCreate({ ...ok, name: "  Auth   Team ", members: [{ role: " lead  dev ", prompt: "t", ownedPaths: [" src ", "src"] }] });
	assert.equal(prepared.teamId, "team_01");
	assert.equal(prepared.name, "Auth Team");
	assert.deepEqual(prepared.members.map((m) => [m.role, m.ownedPaths]), [["lead dev", ["src"]]]);
	// Pending reservation blocks a concurrent duplicate; release frees it.
	assert.throws(() => store.prepareCreate({ ...ok, name: "auth team" }), /already exists .* being created/);
	prepared.release(); prepared.release();
	const again = store.prepareCreate({ ...ok, name: "AUTH TEAM" });
	assert.equal(again.teamId, "team_02", "IDs are never reused within a session");
	store.commitCreate(again, 1, [member(1, { role: "a" })]);
	again.release();
	assert.throws(() => store.prepareCreate({ ...ok, name: "auth team" }), /already exists/);
	const limited = new TeamStore();
	for (let i = 0; i < MAX_SESSION_TEAMS; i++) commit(limited, `t${i}`, ["a"], i + 1);
	assert.throws(() => limited.prepareCreate({ ...ok, name: "one more" }), /Team limit reached/);
});

test("add validation: history is read-only, roles unique across committed and pending members, bounded size", () => {
	const store = new TeamStore();
	const branch = [create("team_01", "Old", [member(1, { role: "lead" })])];
	// Production order in session_start: reserve IDs from all entries, then restore the branch.
	// Without this a new session team could collide with a historical ID and shadow it.
	store.reserveCounter(branch);
	store.restoreHistory(branch);
	const { prepared } = commit(store, "Live", ["Lead"], 5);
	assert.equal(prepared.teamId, "team_02", "session teams never reuse an ID reserved from history");
	assert.throws(() => store.prepareAdd("team_01", [{ role: "x", prompt: "t" }]), /history from an earlier session/);
	assert.throws(() => store.prepareAdd("old", [{ role: "x", prompt: "t" }]), /history/);
	assert.throws(() => store.prepareAdd("team_09", [{ role: "x", prompt: "t" }]), /No such team: team_09/);
	assert.throws(() => store.prepareAdd("missing", [{ role: "x", prompt: "t" }]), /No such team: missing/);
	assert.throws(() => store.prepareAdd(prepared.teamId, [{ role: " lead ", prompt: "t" }]), /already exists in this team/);
	const pending = store.prepareAdd("live", [{ role: "tests", prompt: "t" }]);
	assert.equal(pending.teamId, prepared.teamId);
	assert.equal(pending.name, "Live");
	assert.throws(() => store.prepareAdd(prepared.teamId, [{ role: "Tests", prompt: "t" }]), /being added concurrently/);
	// The new member's header lists the current roster plus fellow new members.
	assert.match(pending.members[0].spec.prompt, /Other members when you joined:\n- Lead: none declared\n\n?Declared/);
	pending.release();
	const retry = store.prepareAdd(prepared.teamId, [{ role: "tests", prompt: "t" }, { role: "docs", prompt: "t" }]);
	assert.match(retry.members[0].spec.prompt, /- Lead: none declared\n- docs: none declared\n/);
	retry.release();
	const big = new TeamStore();
	const created = commit(big, "Big", ["r0"]);
	const members = Array.from({ length: MAX_TEAM_MEMBERS - 1 }, (_, i) => member(i + 10, { role: `m${i}` }));
	big.commitAdd({ ...created.prepared, members: [] } as any, members);
	assert.throws(() => big.prepareAdd("Big", [{ role: "extra", prompt: "t" }, { role: "extra2", prompt: "t" }]), /exceed 24 members/);
});

test("entries decode strictly; branch restore folds create/add and never exceeds bounds", () => {
	const good = { version: 1, op: "create", team: { id: "team_02", name: "T", objective: "o", createdAt: 1 }, members: [member(1)] };
	assert.deepEqual(decodeTeamEntry(good), good);
	for (const bad of [
		null, { ...good, version: 2 }, { ...good, op: "delete" }, { ...good, team: { ...good.team, id: "02" } },
		{ ...good, team: { ...good.team, name: "" } }, { ...good, members: [member(1, { workerId: "x" })] },
		{ ...good, members: [member(1, { groupId: "g" })] }, { ...good, members: [member(1), member(2, { role: "ROLE 1" })] },
		{ ...good, members: [member(1, { ownedPaths: "src" as any })] },
		{ version: 1, op: "add", teamId: "bad", members: [] },
	]) assert.equal(decodeTeamEntry(bad), undefined, JSON.stringify(bad));

	const store = new TeamStore();
	const branch = [
		{ type: "message" },
		create("team_02", "Alpha", [member(1)]),
		entry({ version: 1, op: "add", teamId: "team_02", members: [member(2), member(3, { role: "role 1" })] }),
		entry({ version: 1, op: "add", teamId: "team_08", members: [member(4)] }), // unknown team on this branch
		create("team_02", "Duplicate", [member(5)]),
		entry({ ...good, version: 9 }),
	];
	store.restoreHistory(branch);
	const views = store.views(() => { throw new Error("history must never consult live workers"); });
	assert.equal(views.length, 1);
	assert.equal(views[0].name, "Alpha");
	assert.deepEqual(views[0].members.map((m) => m.workerId), ["ag_01", "ag_02"]);
	assert.ok(views[0].members.every((m) => !m.available && m.availability === "previous-session" && m.reason === HISTORY_REASON && m.state === "unavailable" && m.status === undefined));
	assert.equal(views[0].counts.unavailable, 2);
	// IDs from other branches are reserved, but those teams are not displayed.
	store.reserveCounter([...branch, create("team_11", "Elsewhere", [])]);
	assert.equal(store.teamCounter, 11);
	assert.equal(store.prepareCreate({ name: "New", objective: "o", members: [{ role: "a", prompt: "t" }] }).teamId, "team_12");
	const many = new TeamStore();
	many.restoreHistory(Array.from({ length: MAX_HISTORY_TEAMS + 3 }, (_, i) => create(`team_${i + 1}`, `T${i}`, [])));
	assert.equal(many.views(() => undefined).length, MAX_HISTORY_TEAMS);
	assert.equal(many.views(() => undefined)[0].name, "T3", "keeps the most recent");
});

test("restoring history keeps session teams and skips entries for live team IDs", () => {
	const store = new TeamStore();
	const { prepared } = commit(store, "Live", ["a"]);
	store.restoreHistory([create(prepared.teamId, "Live", [member(1, { role: "a" })]), create("team_09", "Other", [])]);
	const views = store.views((id) => (id === "ag_01" ? running : undefined));
	assert.deepEqual(views.map((v) => [v.id, v.origin]), [["team_09", "history"], [prepared.teamId, "session"]]);
	store.restoreHistory([]);
	assert.deepEqual(store.views(() => undefined).map((v) => v.id), [prepared.teamId]);
});

test("views: retained members show live state; pruned members keep last known status", () => {
	const store = new TeamStore();
	commit(store, "T", ["a", "b", "c"]);
	store.recordEviction("ag_02", { status: "done", taskOutcome: "error", error: "e".repeat(900) });
	store.recordEviction("ag_99", { status: "done" }); // not a member: ignored
	const views = store.views((id) => id === "ag_01" ? { ...running, model: "m" } : undefined);
	const [a, b, c] = views[0].members;
	assert.deepEqual([a.available, a.availability, a.state, a.status, a.model], [true, "retained", "working", "running", "m"]);
	assert.deepEqual([b.available, b.availability, b.state, b.status, b.taskOutcome, b.reason], [false, "pruned", "unavailable", "done", "error", PRUNED_REASON]);
	assert.equal(b.error!.length, 500);
	assert.deepEqual([c.availability, c.status], ["pruned", undefined]);
	assert.deepEqual(views[0].counts, { working: 1, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 2 });
	// Views are detached copies.
	(views[0].members[0].ownedPaths as string[]).push("mutated");
	views[0].actions.push({} as any);
	assert.deepEqual(store.views(() => undefined)[0].members[0].ownedPaths, []);
	assert.equal(store.views(() => undefined)[0].actions.length, 0);
});

test("member state separates idle success from idle failure", () => {
	const base = { processAlive: true, settled: true, finished: false };
	assert.equal(memberState(undefined), "unavailable");
	assert.equal(memberState(running), "working");
	assert.equal(memberState({ ...base, status: "waiting", taskOutcome: "success" }), "idle");
	assert.equal(memberState({ ...base, status: "waiting", taskOutcome: "error" }), "failed");
	assert.equal(memberState({ ...base, status: "waiting", taskOutcome: "aborted" }), "failed");
	assert.equal(memberState({ ...base, status: "error", processAlive: false, finished: true }), "failed");
	assert.equal(memberState({ ...base, status: "stopping", settled: false }), "stopping");
	assert.equal(memberState({ ...base, status: "killed", finished: true }), "stopped");
	assert.equal(memberState({ ...base, status: "done", finished: true, processAlive: false }), "done");
});

test("action history is bounded, member-only, previewed and settles once", () => {
	const store = new TeamStore();
	commit(store, "T", ["a"]);
	assert.equal(store.recordAction("ag_42", "followUp", "user", "x"), undefined);
	assert.equal(store.teamOf("ag_01"), "team_01");
	assert.equal(store.teamOf("ag_42"), undefined);
	const first = store.recordAction("ag_01", "redirect", "user", "m".repeat(300))!;
	assert.equal(first.state, "requested");
	assert.equal(first.preview, `${"m".repeat(200)}…`);
	store.settleAction(first, "failed", "busy");
	store.settleAction(first, "accepted-or-queued");
	assert.deepEqual([first.state, first.reason], ["failed", "busy"]);
	for (let i = 0; i < MAX_TEAM_ACTIONS + 5; i++) store.recordAction("ag_01", "stop", "parent");
	const actions = store.views(() => undefined)[0].actions;
	assert.equal(actions.length, MAX_TEAM_ACTIONS);
	assert.equal(actions[0].seq, 7);
	assert.ok(actions.every((a) => a.role === "a" && a.workerId === "ag_01"));
	store.clear();
	assert.deepEqual(store.views(() => undefined), []);
});

/** A full session team: r0 (ag_01) plus m0..m22 (ag_10..ag_32), all 24 seats taken. */
function fullTeam() {
	const store = new TeamStore();
	const created = commit(store, "Big", ["r0"]);
	const members = Array.from({ length: MAX_TEAM_MEMBERS - 1 }, (_, i) => member(i + 10, { role: `m${i}` }));
	store.commitAdd({ ...created.prepared, members: [] } as any, members);
	return { store, teamId: created.prepared.teamId };
}
const ended: WorkerObservation = { status: "done", processAlive: false, settled: true, finished: true };
const idle: WorkerObservation = { status: "waiting", taskOutcome: "success", processAlive: true, settled: true, finished: false };

test("eject frees a seat at the cap; the cap error names ejectable members; roles stay reserved", () => {
	const { store, teamId } = fullTeam();
	// ag_10 has ended, ag_11 is idle, the rest are gone from the manager (unavailable).
	const observe = (id: string) => (id === "ag_10" ? ended : id === "ag_11" ? idle : id === "ag_01" ? running : undefined);
	const full = (() => { try { store.prepareAdd("Big", [{ role: "extra", prompt: "t" }], observe); } catch (e) { return String(e); } return ""; })();
	assert.match(full, /would exceed 24 members/);
	assert.match(full, /team_eject: ag_10 \(m0\), ag_12 \(m2\)/, "ended and unavailable members are named");
	assert.doesNotMatch(full, /ag_01|ag_11 /, "working and idle members are not ejectable");

	const target = store.checkEject("Big", "m0", observe);
	assert.deepEqual(target, { teamId, workerId: "ag_10", role: "m0" });
	assert.deepEqual(store.ejectEntry(teamId, "ag_10", 5000), { version: 1, op: "eject", teamId, workerId: "ag_10", at: 5000 });
	const action = store.commitEject(teamId, "ag_10", 5000, "parent")!;
	assert.deepEqual([action.kind, action.source, action.state, action.role], ["eject", "parent", "accepted-or-queued", "m0"]);
	assert.equal(store.commitEject(teamId, "ag_10", 6000, "parent"), undefined, "a second commit changes nothing");
	assert.equal(store.views(observe)[0].actions.filter((a) => a.kind === "eject").length, 1, "exactly one action row");
	assert.equal(store.ejectedAt("ag_10"), 5000);

	// The seat is free: one addition fits, two do not.
	const added = store.prepareAdd("Big", [{ role: "extra", prompt: "t" }], observe);
	assert.doesNotMatch(added.members[0].spec.prompt, /- m0:/, "an ejected member is not among Other members");
	assert.match(added.members[0].spec.prompt, /- m1:/);
	added.release();
	assert.throws(() => store.prepareAdd("Big", [{ role: "x1", prompt: "t" }, { role: "x2", prompt: "t" }], observe), /exceed 24 members/);
	// Its role stays taken, in any case or spacing.
	assert.throws(() => store.prepareAdd("Big", [{ role: " M0 ", prompt: "t" }], observe), /Role M0 already exists/);
});

test("eject refusals: history, unknown team or member, already ejected, still occupied", () => {
	const { store, teamId } = fullTeam();
	const observe = (id: string) => (id === "ag_10" ? running : id === "ag_11" ? idle : id === "ag_12" ? { ...running, status: "stopping" as const, settled: true } : id === "ag_13" ? { ...running, status: "starting" as const } : undefined);
	assert.throws(() => store.checkEject("team_99", "m0", observe), /No such team: team_99/);
	assert.throws(() => store.checkEject("Big", "ag_77", observe), /No member ag_77 in team_01/);
	assert.throws(() => store.checkEject("Big", "nobody", observe), /No member nobody in team_01/);
	assert.throws(() => store.checkEject("Big", "m0", observe), /m0 \(ag_10\) is still working; stop it with agent_kill first/);
	assert.throws(() => store.checkEject("Big", "ag_11", observe), /is still idle; stop it with agent_kill first/);
	assert.throws(() => store.checkEject("Big", "m2", observe), /is still stopping/);
	assert.throws(() => store.checkEject("Big", "m3", observe), /is still working/, "starting counts as working");
	store.commitEject(teamId, "ag_14", 1_700_000_000_000, "parent");
	assert.throws(() => store.checkEject("Big", "m4", observe), /m4 \(ag_14\) was already ejected from team_01 at 2023-11-14T22:13:20Z/);
	// A history team is read-only, with team_add's wording.
	const history = new TeamStore();
	history.restoreHistory([create("team_05", "Old", [member(1)])]);
	const addRefusal = (() => { try { history.prepareAdd("Old", [{ role: "x", prompt: "t" }]); } catch (e) { return (e as Error).message; } return ""; })();
	assert.throws(() => history.checkEject("Old", "ag_01", () => undefined), (e: Error) => e.message === addRefusal && /history from an earlier session/.test(e.message));
});

test("eject entries decode strictly and fold on restore: eject then add past 24 keeps the 25th", () => {
	const good = { version: 1, op: "eject", teamId: "team_02", workerId: "ag_03", at: 12 };
	assert.deepEqual(decodeTeamEntry(good), good);
	assert.deepEqual(decodeTeamEntry({ ...good, members: "ignored" }), good);
	for (const bad of [
		{ ...good, teamId: "02" }, { ...good, workerId: "3" }, { ...good, workerId: undefined }, { ...good, at: "12" },
		{ ...good, at: Number.NaN }, { ...good, version: 2 }, { version: 1, op: "eject" },
	]) assert.equal(decodeTeamEntry(bad), undefined, JSON.stringify(bad));

	const seats = Array.from({ length: MAX_TEAM_MEMBERS }, (_, i) => member(i + 1, { role: `s${i}` }));
	const branch = [
		create("team_02", "Full", seats.slice(0, 12)),
		entry({ version: 1, op: "add", teamId: "team_02", members: seats.slice(12) }),
		entry({ version: 1, op: "eject", teamId: "team_02", workerId: "ag_05", at: 40 }),
		entry({ version: 1, op: "eject", teamId: "team_02", workerId: "ag_05", at: 99 }), // repeat: the first stands
		entry({ version: 1, op: "eject", teamId: "team_02", workerId: "ag_88", at: 41 }), // not a member: ignored
		entry({ version: 1, op: "eject", teamId: "team_07", workerId: "ag_01", at: 42 }), // unknown team: ignored
		entry({ version: 1, op: "add", teamId: "team_02", members: [member(30, { role: "late" })] }),
		entry({ version: 1, op: "add", teamId: "team_02", members: [member(31, { role: "later" })] }), // over the cap again: dropped
	];
	const store = new TeamStore();
	store.restoreHistory(branch);
	store.reserveCounter(branch);
	assert.equal(store.teamCounter, 7, "eject entries reserve their team IDs too");
	const [view] = store.views(() => undefined);
	assert.equal(view.members.length, 25);
	assert.equal(view.members.at(-1)!.workerId, "ag_30", "the member added after the eject survives restore");
	assert.deepEqual(view.members.filter((m) => m.ejectedAt !== undefined).map((m) => [m.workerId, m.ejectedAt]), [["ag_05", 40]]);
	assert.equal(view.ejected, 1);
	assert.equal(view.counts.unavailable, 24, "counts cover seated members only");
	// Adopting the history team keeps its released seats.
	assert.ok(store.adoptHistoryTeam("team_02"));
	assert.equal(store.ejectedAt("ag_05"), 40);
	assert.throws(() => store.prepareAdd("Full", [{ role: "more", prompt: "t" }]), /exceed 24 members/);
	assert.throws(() => store.prepareAdd("Full", [{ role: "s4", prompt: "t" }]), /Role s4 already exists/);
});

test("views carry ejectedAt and leave ejected members out of the state counts", () => {
	const store = new TeamStore();
	const { prepared } = commit(store, "T", ["a", "b", "c"]);
	store.commitEject(prepared.teamId, "ag_02", 77, "user");
	const [view] = store.views((id) => (id === "ag_01" ? running : ended));
	assert.deepEqual(view.members.map((m) => m.ejectedAt), [undefined, 77, undefined]);
	assert.deepEqual(view.counts, { working: 1, idle: 0, failed: 0, done: 1, stopping: 0, stopped: 0, unavailable: 0 });
	assert.equal(view.ejected, 1);
	assert.equal(view.members[1].state, "done", "an ejected member keeps its observed state");
	assert.deepEqual([view.actions[0].kind, view.actions[0].source], ["eject", "user"]);
	// Siblings: an ejected member is out of broadcasts, and addressing it says why.
	assert.deepEqual(store.memberInfo("ag_01")!.siblings.map((m) => m.role), ["c"]);
	assert.throws(() => store.resolveSibling("ag_01", "B"), /b \(ag_02\) was ejected from team_01 at 1970-01-01T00:00:00Z; it no longer receives team messages/);
	assert.throws(() => store.resolveSibling("ag_01", "ag_02"), /was ejected/);
	assert.throws(() => store.resolveSibling("ag_01", "zzz"), /Known roles: c\./);
	assert.equal(store.resolveSibling("ag_01", "c").workerId, "ag_03");
});

test("assignments: cut with a marker, kept per member in memory, the main thread's steers bounded; duty members have none", () => {
	assert.equal(assignmentText("  short task \n", "dev"), "short task");
	assert.equal(assignmentText("abcdefghij", "dev", 4), "abcd\n[… 6 more chars; ask dev with team_msg for the rest]");
	const store = new TeamStore();
	const { members } = commit(store, "Crew", ["dev", "qa"]);
	assert.deepEqual(store.assignments("team_01").map((a) => [a.role, a.task, a.steers]), [["dev", "task", []], ["qa", "task", []]]);
	for (let i = 1; i <= 5; i++) store.recordOperatorSteer(members[0].workerId, `step ${i}`);
	assert.equal(store.recordOperatorSteer(members[0].workerId, "   "), undefined, "a blank steer is not kept");
	store.recordOperatorSteer(members[1].workerId, "x".repeat(STEER_KEEP_CHARS + 100));
	const [dev, qa] = store.assignments("team_01");
	assert.deepEqual(dev.steers, ["step 1", "step 2", "step 3", "step 4", "step 5"], "N2: every steer, not just the newest three");
	assert.equal(qa.steers[0], `${"x".repeat(STEER_KEEP_CHARS)} […100 more chars]`);
	assert.equal(store.taskOf(members[0].workerId), "task");
	// A successor-style add carries an explicit assignment instead of its prompt.
	const added = store.prepareAdd("team_01", [{ role: "dev-2", prompt: "Continue the work of dev", assignment: "task" }]);
	assert.equal(added.members[0].task, "task");
	added.release();
	assert.deepEqual(store.assignments("team_99"), []);
});

test("N2: steers past the cap drop the oldest and count them; a successor inherits task and steers; its task quotes them within a budget", () => {
	const store = new TeamStore();
	const { members } = commit(store, "Crew", ["dev"]);
	for (let i = 1; i <= MAX_OPERATOR_STEERS + 2; i++) store.recordOperatorSteer(members[0].workerId, `step ${i}`);
	let [dev] = store.assignments("team_01");
	assert.equal(dev.steers.length, MAX_OPERATOR_STEERS);
	assert.deepEqual([dev.steers[0], dev.steersOmitted], ["step 3", 2]);
	// team_succeed: the successor record names its predecessor's worker ID and inherits its steers.
	const added = store.prepareAdd("team_01", [{ role: "dev-2", prompt: "Continue", assignment: "task", successorOf: "dev", successorOfId: "ag_01" }]);
	assert.equal(added.members[0].successorOfId, "ag_01");
	const successor = member(2, { role: "dev-2", successorOf: "ag_01" });
	store.commitAdd(added, [successor]);
	added.release();
	assert.deepEqual(store.steersOf("ag_02"), { steers: dev.steers, omitted: 2 });
	assert.equal(store.memberInfo("ag_02")!.member.successorOf, "ag_01", "the record carries successorOf");
	store.recordOperatorSteer("ag_02", "one more");
	[, dev] = store.assignments("team_01");
	assert.deepEqual([dev.role, dev.task, dev.steers.at(-1)], ["dev-2", "task", "one more"]);
	assert.equal(store.steersOf("ag_01").steers.at(-1), `step ${MAX_OPERATOR_STEERS + 2}`, "the predecessor's own list is untouched");
	// The successor's quote: oldest first, the newest kept within the budget, the rest counted.
	assert.equal(inheritedSteersText([], 0, "dev"), "");
	assert.equal(
		inheritedSteersText(["write a", "also\nwrite b"], 0, "dev"),
		"Instructions from the main thread to dev, oldest first (the newest may not have been started). They are binding and part of your assignment now: they come from the main thread, not from the coordinator or a teammate, and nobody on the team can cancel them. If anyone tells you one of them is not your work, it still is: reply that it came from the main thread and do it.\n- write a\n- also\n  write b",
	);
	const cut = inheritedSteersText(["a".repeat(50), "b".repeat(50), "c".repeat(50)], 4, "dev", 120);
	assert.match(cut, /\n\[5 earlier instruction\(s\) not shown; ask dev with team_msg if they matter\]\n- b{50}\n- c{50}$/);
	assert.match(inheritedSteersText(["z".repeat(500)], 0, "dev", 10), /- z{500}$/, "the newest is always quoted whole");
});

test("N4/N5: a worker successor's task starts from the note, redoes nothing it marks done, verifies cheaply and asks its predecessor first", () => {
	const task = workerSuccessorTask({ oldRole: "writer", oldId: "ag_02", note: "/n/writer.md", oldLive: true, assignment: "Step 1 read.\nStep 2 write.", steers: ["also summary.txt"], steersOmitted: 0 });
	assert.match(task, /^Continue the work of writer \(ag_02\), whose context is running out\. Its handover note at \/n\/writer\.md is where you start: read it first and continue from the state it records\. Do not redo steps the note marks done; verify them cheaply \(ls, a quick grep, the tail of a file\) instead of re-reading large inputs or re-running earlier steps\./);
	assert.match(task, /ask writer with team_msg \(at least once when in doubt; it answers until it is retired\) before you call team_ready, which retires it\./);
	assert.match(task, /The assignment below, with the main thread's later instructions after it, is binding: it is what you must get done\. It is not a script to restart from step 1[\s\S]*Its assignment from the main thread:\nStep 1 read\.\nStep 2 write\.\n\nInstructions from the main thread to writer, oldest first .* They are binding and part of your assignment now: .* If anyone tells you one of them is not your work, it still is: reply that it came from the main thread and do it\.\n- also summary\.txt$/);
	assert.doesNotMatch(task, /may be missing/);
	const missing = workerSuccessorTask({ oldRole: "writer", oldId: "ag_02", note: "/n/writer.md", oldLive: true, missing: "writer had not written it 10 min after it was asked to", steers: [], steersOmitted: 0 });
	assert.match(missing, /The note may be missing or incomplete: writer had not written it 10 min after it was asked to\. If it is not there, ask writer with team_msg for its state before you do anything else\./);
	assert.match(missing, /Its original assignment is not known here: ask writer for it with team_msg\.$/);
	const ended = workerSuccessorTask({ oldRole: "writer", oldId: "ag_02", note: "/n/writer.md", oldLive: false, steers: [], steersOmitted: 0 });
	assert.match(ended, /writer has already ended: there is nobody to ask and no team_ready to call\./);
	assert.doesNotMatch(ended, /call team_ready as soon/i);
});

test("N1: a store keys its handover directory by the parent session, so two sessions' team_01 never share one", () => {
	const create = (key: string) => {
		const store = new TeamStore("/agent/sova/teams", () => key);
		const prepared = store.prepareCreate({
			name: "Crew", objective: "o", coordination: {},
			members: [{ role: "coordinator", prompt: "c", duty: "coordinator", orchestrator: true }, { role: "dev", prompt: "d" }],
		});
		prepared.release();
		return prepared;
	};
	const a = create("session-a"), b = create("session-b");
	assert.equal(a.teamId, b.teamId, "both sessions' first team is team_01");
	assert.equal(a.coordination!.handoffDir, "/agent/sova/teams/session-a/team_01/handoffs");
	assert.notEqual(a.coordination!.handoffDir, b.coordination!.handoffDir);
	assert.match(a.members[1].spec.prompt, /Your handover note path: \/agent\/sova\/teams\/session-a\/team_01\/handoffs\/dev\.md\./);
});

test("restart: tasks, every steer and a successor's inheritance rebuild from session entries; a pause is read back from the team events", () => {
	const assignment = (data: unknown) => ({ type: "custom", customType: ASSIGNMENT_ENTRY_TYPE, data });
	const event = (teamId: string, kind: string) => ({ type: "custom", customType: TEAM_EVENT_ENTRY_TYPE, data: { version: 1, teamId, kind, workerId: "ag_03", role: "monitor", at: 1 } });
	// What a live store writes is exactly what a reloaded one reads.
	const live = new TeamStore();
	const prepared = live.prepareCreate({
		name: "Crew", objective: "o", coordination: {},
		members: [{ role: "coordinator", prompt: "c", duty: "coordinator", orchestrator: true }, { role: "dev", prompt: "Write f01-f10." }, { role: "monitor", prompt: "m", duty: "monitor", tools: [] }],
	});
	const recs = prepared.members.map((m, i) => member(i + 1, { role: m.role, ...(m.duty ? { duty: m.duty } : {}) }));
	live.commitCreate(prepared, 1, recs);
	prepared.release();
	const written: unknown[] = [create("team_01", "Crew", recs), ...live.assignmentEntries("team_01", recs).map(assignment)];
	assert.equal(written.length, 2, "one task entry: duty members have none");
	written.push(assignment(live.recordOperatorSteer("ag_02", "after f10, also write summary.txt")));
	assert.equal(live.recordOperatorSteer("ag_03", "monitor steer"), undefined, "never for a duty member");
	const add = live.prepareAdd("team_01", [{ role: "dev-2", prompt: "Continue", assignment: "Write f01-f10.", successorOf: "dev", successorOfId: "ag_02" }]);
	const successor = [member(4, { role: "dev-2", successorOf: "ag_02" })];
	live.commitAdd(add, successor);
	add.release();
	written.push({ type: "custom", customType: TEAM_ENTRY_TYPE, data: { version: 1, op: "add", teamId: "team_01", members: successor } }, ...live.assignmentEntries("team_01", successor).map(assignment));
	written.push(assignment({ version: 1, teamId: "team_01", workerId: "ag_04", op: "steer", steer: "then stop" }));
	written.push(assignment({ version: 1, teamId: "team_01", workerId: "ag_04", op: "bogus" }), assignment({ version: 1, teamId: "team_01", workerId: "nope", op: "steer", steer: "x" }));
	written.push(event("team_01", "pause"), event("team_02", "pause"), event("team_02", "resume"));
	const restored = new TeamStore();
	restored.restoreHistory(written);
	assert.equal(restored.adoptHistoryTeam("team_01"), true, "a re-adopted or resumed member makes the team live");
	assert.deepEqual(restored.assignments("team_01").map((a) => [a.workerId, a.role, a.task, a.steers]), [
		["ag_02", "dev", "Write f01-f10.", ["after f10, also write summary.txt"]],
		["ag_04", "dev-2", "Write f01-f10.", ["after f10, also write summary.txt", "then stop"]],
	]);
	assert.equal(restored.memberInfo("ag_04")!.member.successorOf, "ag_02");
	assert.deepEqual([...pausedTeamsFrom(written)], ["team_01"], "team_02 resumed; team_01 is still paused");
	assert.equal(decodeAssignmentEntry({ version: 1, teamId: "team_01", workerId: "ag_01", op: "task", task: "   " }), undefined);
	assert.equal(decodeAssignmentEntry({ version: 1, teamId: "team_01", workerId: "ag_01", op: "inherit", from: "dev" }), undefined);
});

test("contract: subagents-team-v1 members keep an optional successorOf worker ID; anything else there rejects the member", () => {
	const ok = decodeTeamEntry({ version: 1, op: "add", teamId: "team_01", members: [member(4, { role: "dev-2", successorOf: "ag_02" })] });
	assert.equal(ok?.members[0].successorOf, "ag_02");
	assert.equal(decodeTeamEntry({ version: 1, op: "add", teamId: "team_01", members: [member(4, { role: "dev-2" })] })?.members[0].successorOf, undefined);
	assert.equal(decodeTeamEntry({ version: 1, op: "add", teamId: "team_01", members: [{ ...member(4), successorOf: "dev" }] }), undefined);
});
