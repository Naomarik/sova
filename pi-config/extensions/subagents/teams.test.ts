import { test } from "node:test";
import assert from "node:assert/strict";
import {
	HISTORY_REASON,
	MAX_HISTORY_TEAMS,
	MAX_SESSION_TEAMS,
	MAX_TEAM_ACTIONS,
	MAX_TEAM_MEMBERS,
	PRUNED_REASON,
	TEAM_ENTRY_TYPE,
	TeamStore,
	composeMemberPrompt,
	decodeTeamEntry,
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
