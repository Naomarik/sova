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
	type TeamMemberInput,
	type WorkerObservation,
} from "./teams.ts";
import { defaultTeamDefaults, type TeamDefaultsFile } from "./team-defaults.ts";

/** Sova's coordinator, which every team has (index.ts adds it first; here it goes last, so the named members keep ag_01, ag_02…). */
const COORDINATOR: TeamMemberInput = { role: "coordinator", prompt: "coordinate", duty: "coordinator", orchestrator: true };
/** prepareCreate as index.ts calls it: with the coordinator and the team defaults, unless the input brings its own. */
const createIn = (store: TeamStore, input: Omit<Parameters<TeamStore["prepareCreate"]>[0], "coordination"> & { coordination?: { defaults?: TeamDefaultsFile } }) =>
	store.prepareCreate({
		...input,
		members: input.members.some((m) => m.duty === "coordinator") ? input.members : [...input.members, COORDINATOR],
		coordination: { defaults: input.coordination?.defaults ?? defaultTeamDefaults() },
	});
/** prepareAdd as index.ts calls it, with the team defaults read now. */
const addTo = (store: TeamStore, ref: string, members: TeamMemberInput[], observe?: (workerId: string) => WorkerObservation | undefined) =>
	store.prepareAdd(ref, members, observe, defaultTeamDefaults());
const member = (i: number, extra: Partial<PersistedMember> = {}): PersistedMember => ({
	workerId: `ag_${String(i).padStart(2, "0")}`, role: `role ${i}`, ownedPaths: [], backend: "pi", groupId: "run_01", addedAt: 1, ...extra,
});
const entry = (data: unknown) => ({ type: "custom", customType: TEAM_ENTRY_TYPE, data });
const create = (id: string, name: string, members: PersistedMember[]) =>
	entry({ version: 1, op: "create", team: { id, name, objective: `objective of ${name}`, createdAt: 1 }, members });
/** Commit a prepared create the way index.ts does after a successful spawn. */
function commit(store: TeamStore, name: string, roles: string[], firstWorker = 1) {
	const prepared = createIn(store, { name, objective: "obj", members: roles.map((role) => ({ role, prompt: "task" })) });
	const members = prepared.members.map((m, i) => member(firstWorker + i, { role: m.role, ownedPaths: m.ownedPaths, ...(m.duty ? { duty: m.duty, orchestrator: true } : {}) }));
	store.commitCreate(prepared, 1, members);
	prepared.release();
	return { prepared, members };
}
const running: WorkerObservation = { status: "running", processAlive: true, settled: false, finished: false };

test("composed member header is exact and deterministic", () => {
	const team = { id: "team_03", name: "Auth", objective: "Fix login\nKeep API stable" };
	const coordination = { coordinatorRole: "coordinator", handoff: (role: string) => `/notes/${role}.md`, defaults: defaultTeamDefaults() };
	const others = [{ role: "coordinator", ownedPaths: [], duty: "coordinator" as const }, { role: "tests", ownedPaths: [] }, { role: "monitor", ownedPaths: [], duty: "monitor" as const }];
	assert.equal(
		composeMemberPrompt(team, { role: "backend", ownedPaths: ["src/api", "src/db"] }, others, "Do the thing.", "creation", "none", coordination),
		[
			"[Team assignment from the parent Pi session]",
			"Team: Auth (team_03)",
			"Objective: Fix login\nKeep API stable",
			"Your role: backend",
			"Your declared ownership: src/api, src/db",
			"Other members at team creation:",
			"- coordinator (coordinator): none declared",
			"- tests: none declared",
			"- monitor (monitor): none declared",
			"Declared ownership is advisory coordination, not a lock: all members share one filesystem, so avoid editing paths another member owns unless your task says to.",
			"Messages from teammates or the coordinator coordinator can arrive as new instructions in your session. You have no tool to reply directly, so put anything meant for them in your final answer; it is delivered to the coordinator.",
			"If your final answer would run past about 3,500 characters, write the full report to a file and make your final message that file's path plus a short summary.",
			"",
			"[Your task]",
			"Do the thing.",
		].join("\n"),
		"tooling none (a non-pi backend): the header never promises tools the worker lacks",
	);
	const alone = composeMemberPrompt(team, { role: "solo", ownedPaths: [] }, [], "x", "addition", "none", coordination);
	assert.match(alone, /Your declared ownership: none declared\nOther members when you joined:\n- none\n/);
	// pi members are told exactly which team tools they have, and that the coordinator is who they report to; no lead mark.
	const pi = composeMemberPrompt(team, { role: "dev", ownedPaths: [] }, [{ role: "lead", ownedPaths: ["src"] }, ...others], "x", "creation", "pi", coordination);
	assert.match(pi, /^Your role: dev$/m);
	assert.match(pi, /^- lead: src$/m);
	assert.match(pi, /^Team tools: team_msg .*team_inbox .*team_ask sends a question to your team's coordinator/m);
	assert.match(pi, /^This team has a coordinator, coordinator: report to it, not to the operator\. .*Your handover note path: \/notes\/dev\.md\./m);
	assert.match(pi, /^You cannot spawn, add or stop workers, and nothing you do reaches outside this team; the parent session remains the authority\. Your final answer is your report\.$/m);
	assert.doesNotMatch(pi, /team_roster|team_steer|orchestrator/);
	// A pi header never claims the worker cannot message; a none header never claims tools.
	assert.doesNotMatch(pi, /cannot message/);
	assert.doesNotMatch(alone, /team_msg/);
	// A claude-code member is a pi worker on the Claude Code provider: the same member extension, the same header.
	assert.equal(memberTooling("pi"), "pi");
	assert.equal(memberTooling("claude-code"), "pi");
	assert.equal(memberTooling("codex"), "none");
});

test("Sova's coordinator's orchestrator field is carried through prepare, persisted entries, views and sibling lookup", () => {
	const store = new TeamStore();
	const base = { name: "Crew", objective: "obj" };
	// Only the manager sets it (on the coordinator it adds); a codex member is never given it.
	const prepared = createIn(store, {
		...base, defaults: { backend: "claude-code", model: "opus" },
		members: [{ role: "lead", prompt: "t", orchestrator: true, duty: "coordinator", backend: "pi" }, { role: "dev", prompt: "t" }, { role: "qa", prompt: "t", backend: "pi" }],
	});
	assert.deepEqual(prepared.members.map((m) => [m.role, m.orchestrator, m.spec.backend]), [["lead", true, "pi"], ["dev", false, "claude-code"], ["qa", false, "pi"]]);
	assert.doesNotMatch(prepared.members.map((m) => m.spec.prompt).join("\n"), /\(orchestrator\)|You are this team's orchestrator/, "no header marks or addresses an orchestrator");
	assert.match(prepared.members[1].spec.prompt, /\nTeam tools: team_msg/, "a Claude member's header is a pi member's");
	assert.doesNotMatch(prepared.members[1].spec.prompt, /no tool to reply|mcp__team__/);
	const members = prepared.members.map((m, i) => member(i + 1, { role: m.role, backend: m.spec.backend, ...(m.orchestrator ? { orchestrator: true } : {}), ...(m.duty ? { duty: m.duty } : {}) }));
	store.commitCreate(prepared, 1, members);
	prepared.release();
	// Persisted entries keep the field strictly optional/boolean (restored teams decode through it).
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
	// A newcomer's header lists the members unmarked.
	const add = addTo(store, "Crew", [{ role: "docs", prompt: "t", backend: "pi" }]);
	assert.match(add.members[0].spec.prompt, /- lead \(coordinator\): none declared\n- dev: none declared\n- qa: none declared/);
	add.release();
	// Actions from members and the coordinator are recorded with their own sources and kinds.
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
		[{ ...ok, members: [{ role: "Dev", prompt: "t" }, { role: " dev ", prompt: "t" }] }, /Duplicate role/],
		[{ ...ok, members: [{ role: "ag_01", prompt: "t" }] }, /looks like a worker ID/],
		[{ ...ok, members: [{ role: "a", prompt: "  " }] }, /Task for a must not be blank/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: [" "] }] }, /blank entries/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: ["a\nb"] }] }, /one line/],
		[{ ...ok, members: [{ role: "a", prompt: "t", ownedPaths: Array.from({ length: 33 }, (_, i) => `p${i}`) }] }, /exceeds 32/],
	] as const) assert.throws(() => createIn(store, input as any), pattern);
	const coordination = { defaults: defaultTeamDefaults() };
	assert.throws(() => store.prepareCreate({ ...ok, members: [], coordination }), /at least one/);
	assert.throws(() => store.prepareCreate({ ...ok, coordination }), /^Error: A team needs exactly one coordinator\.$/, "a team without Sova's coordinator is never prepared");
	assert.throws(() => store.prepareCreate({ ...ok, members: [COORDINATOR, { ...COORDINATOR, role: "second" }], coordination }), /^Error: A team needs exactly one coordinator\.$/);
	assert.equal(store.teamCounter, 0, "rejected input never consumes a team ID");
	const prepared = createIn(store, { ...ok, name: "  Auth   Team ", members: [{ role: " lead  dev ", prompt: "t", ownedPaths: [" src ", "src"] }] });
	assert.equal(prepared.teamId, "team_01");
	assert.equal(prepared.name, "Auth Team");
	assert.deepEqual(prepared.members.map((m) => [m.role, m.ownedPaths]), [["lead dev", ["src"]], ["coordinator", []]]);
	// Pending reservation blocks a concurrent duplicate; release frees it.
	assert.throws(() => createIn(store, { ...ok, name: "auth team" }), /already exists .* being created/);
	prepared.release(); prepared.release();
	const again = createIn(store, { ...ok, name: "AUTH TEAM" });
	assert.equal(again.teamId, "team_02", "IDs are never reused within a session");
	store.commitCreate(again, 1, [member(1, { role: "a" })]);
	again.release();
	assert.throws(() => createIn(store, { ...ok, name: "auth team" }), /already exists/);
	const limited = new TeamStore();
	for (let i = 0; i < MAX_SESSION_TEAMS; i++) commit(limited, `t${i}`, ["a"], i + 1);
	assert.throws(() => createIn(limited, { ...ok, name: "one more" }), /Team limit reached/);
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
	assert.throws(() => addTo(store, "team_01", [{ role: "x", prompt: "t" }]), /history from an earlier session/);
	assert.throws(() => addTo(store, "old", [{ role: "x", prompt: "t" }]), /history/);
	assert.throws(() => addTo(store, "team_09", [{ role: "x", prompt: "t" }]), /No such team: team_09/);
	assert.throws(() => addTo(store, "missing", [{ role: "x", prompt: "t" }]), /No such team: missing/);
	assert.throws(() => addTo(store, prepared.teamId, [{ role: " lead ", prompt: "t" }]), /already exists in this team/);
	const pending = addTo(store, "live", [{ role: "tests", prompt: "t" }]);
	assert.equal(pending.teamId, prepared.teamId);
	assert.equal(pending.name, "Live");
	assert.throws(() => addTo(store, prepared.teamId, [{ role: "Tests", prompt: "t" }]), /being added concurrently/);
	// The new member's header lists the current roster plus fellow new members.
	assert.match(pending.members[0].spec.prompt, /Other members when you joined:\n- Lead: none declared\n- coordinator \(coordinator\): none declared\nDeclared/);
	pending.release();
	const retry = addTo(store, prepared.teamId, [{ role: "tests", prompt: "t" }, { role: "docs", prompt: "t" }]);
	assert.match(retry.members[0].spec.prompt, /- Lead: none declared\n- coordinator \(coordinator\): none declared\n- docs: none declared\n/);
	retry.release();
	const big = new TeamStore();
	const created = commit(big, "Big", ["r0"]);
	const members = Array.from({ length: MAX_TEAM_MEMBERS - 2 }, (_, i) => member(i + 10, { role: `m${i}` })); // r0 and the coordinator hold 2
	big.commitAdd({ ...created.prepared, members: [] } as any, members);
	assert.throws(() => addTo(big, "Big", [{ role: "extra", prompt: "t" }, { role: "extra2", prompt: "t" }]), /exceed 24 members/);
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
	assert.equal(createIn(store, { name: "New", objective: "o", members: [{ role: "a", prompt: "t" }] }).teamId, "team_12");
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
	const [a, b, c, coordinator] = views[0].members;
	assert.deepEqual([a.available, a.availability, a.state, a.status, a.model], [true, "retained", "working", "running", "m"]);
	assert.deepEqual([b.available, b.availability, b.state, b.status, b.taskOutcome, b.reason], [false, "pruned", "unavailable", "done", "error", PRUNED_REASON]);
	assert.equal(b.error!.length, 500);
	assert.deepEqual([c.availability, c.status], ["pruned", undefined]);
	assert.equal(coordinator.role, "coordinator");
	assert.deepEqual(views[0].counts, { working: 1, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 3 }, "c and the unobserved coordinator count too");
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
	const created = commit(store, "Big", ["r0"]); // r0 ag_01, the coordinator ag_02
	const members = Array.from({ length: MAX_TEAM_MEMBERS - 2 }, (_, i) => member(i + 10, { role: `m${i}` }));
	store.commitAdd({ ...created.prepared, members: [] } as any, members);
	return { store, teamId: created.prepared.teamId };
}
const ended: WorkerObservation = { status: "done", processAlive: false, settled: true, finished: true };
const idle: WorkerObservation = { status: "waiting", taskOutcome: "success", processAlive: true, settled: true, finished: false };

test("eject frees a seat at the cap; the cap error names ejectable members; roles stay reserved", () => {
	const { store, teamId } = fullTeam();
	// ag_10 has ended, ag_11 is idle, r0 and the coordinator work, the rest are gone from the manager (unavailable).
	const observe = (id: string) => (id === "ag_10" ? ended : id === "ag_11" ? idle : id === "ag_01" || id === "ag_02" ? running : undefined);
	const full = (() => { try { addTo(store, "Big", [{ role: "extra", prompt: "t" }], observe); } catch (e) { return String(e); } return ""; })();
	assert.match(full, /would exceed 24 members/);
	assert.match(full, /team_eject: ag_10 \(m0\), ag_12 \(m2\)/, "ended and unavailable members are named");
	assert.doesNotMatch(full, /ag_01|ag_02|ag_11 /, "working and idle members are not ejectable");

	const target = store.checkEject("Big", "m0", observe);
	assert.deepEqual(target, { teamId, workerId: "ag_10", role: "m0" });
	assert.deepEqual(store.ejectEntry(teamId, "ag_10", 5000), { version: 1, op: "eject", teamId, workerId: "ag_10", at: 5000 });
	const action = store.commitEject(teamId, "ag_10", 5000, "parent")!;
	assert.deepEqual([action.kind, action.source, action.state, action.role], ["eject", "parent", "accepted-or-queued", "m0"]);
	assert.equal(store.commitEject(teamId, "ag_10", 6000, "parent"), undefined, "a second commit changes nothing");
	assert.equal(store.views(observe)[0].actions.filter((a) => a.kind === "eject").length, 1, "exactly one action row");
	assert.equal(store.ejectedAt("ag_10"), 5000);

	// The seat is free: one addition fits, two do not.
	const added = addTo(store, "Big", [{ role: "extra", prompt: "t" }], observe);
	assert.doesNotMatch(added.members[0].spec.prompt, /- m0:/, "an ejected member is not among Other members");
	assert.match(added.members[0].spec.prompt, /- m1:/);
	added.release();
	assert.throws(() => addTo(store, "Big", [{ role: "x1", prompt: "t" }, { role: "x2", prompt: "t" }], observe), /exceed 24 members/);
	// Its role stays taken, in any case or spacing.
	assert.throws(() => addTo(store, "Big", [{ role: " M0 ", prompt: "t" }], observe), /Role M0 already exists/);
});

test("eject refusals: unknown team or member, already ejected, still occupied; a history team ejects too", () => {
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
	// A history team (this session's branch after a reload): team_add refuses it, but an ended or
	// unavailable member's seat can be released, and the eject folds back from the branch.
	const history = new TeamStore();
	history.restoreHistory([create("team_05", "Old", [member(1), member(2)])]);
	assert.throws(() => addTo(history, "Old", [{ role: "x", prompt: "t" }]), /history from an earlier session/);
	assert.throws(() => history.checkEject("Old", "ag_02", () => running), /is still working/, "a history member whose worker was resumed and works is refused like any other");
	const target = history.checkEject("Old", "ag_01", () => undefined);
	assert.deepEqual(target, { teamId: "team_05", workerId: "ag_01", role: "role 1" });
	const ejectOp = history.ejectEntry(target.teamId, target.workerId, 99);
	assert.deepEqual([history.commitEject(target.teamId, target.workerId, 99, "parent")?.kind, history.ejectedAt("ag_01")], ["eject", 99]);
	assert.deepEqual(history.views(() => undefined)[0].actions.map((a) => [a.kind, a.source, a.state]), [["eject", "parent", "accepted-or-queued"]]);
	assert.throws(() => history.checkEject("Old", "role 1", () => undefined), /already ejected/);
	const reloaded = new TeamStore();
	reloaded.restoreHistory([create("team_05", "Old", [member(1), member(2)]), entry(ejectOp)]);
	assert.equal(reloaded.ejectedAt("ag_01"), 99);
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
	assert.throws(() => addTo(store, "Full", [{ role: "more", prompt: "t" }]), /exceed 24 members/);
	assert.throws(() => addTo(store, "Full", [{ role: "s4", prompt: "t" }]), /Role s4 already exists/);
});

test("views carry ejectedAt and leave ejected members out of the state counts", () => {
	const store = new TeamStore();
	const { prepared } = commit(store, "T", ["a", "b", "c"]);
	store.commitEject(prepared.teamId, "ag_02", 77, "system");
	const [view] = store.views((id) => (id === "ag_01" ? running : ended));
	assert.deepEqual(view.members.map((m) => m.ejectedAt), [undefined, 77, undefined, undefined]);
	assert.deepEqual(view.counts, { working: 1, idle: 0, failed: 0, done: 2, stopping: 0, stopped: 0, unavailable: 0 }, "c and the coordinator are done");
	assert.equal(view.ejected, 1);
	assert.equal(view.members[1].state, "done", "an ejected member keeps its observed state");
	assert.deepEqual([view.actions[0].kind, view.actions[0].source], ["eject", "system"]);
	// Siblings: an ejected member is out of broadcasts, and addressing it says why.
	assert.deepEqual(store.memberInfo("ag_01")!.siblings.map((m) => m.role), ["c", "coordinator"]);
	assert.throws(() => store.resolveSibling("ag_01", "B"), /b \(ag_02\) was ejected from team_01 at 1970-01-01T00:00:00Z; it no longer receives team messages/);
	assert.throws(() => store.resolveSibling("ag_01", "ag_02"), /was ejected/);
	assert.throws(() => store.resolveSibling("ag_01", "zzz"), /Known roles: c, coordinator\./);
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
	const added = addTo(store, "team_01", [{ role: "dev-2", prompt: "Continue the work of dev", assignment: "task" }]);
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
	const added = addTo(store, "team_01", [{ role: "dev-2", prompt: "Continue", assignment: "task", successorOf: "dev", successorOfId: "ag_01" }]);
	assert.equal(added.members[0].successorOfId, "ag_01");
	const successor = member(3, { role: "dev-2", successorOf: "ag_01" }); // ag_02 is the coordinator
	store.commitAdd(added, [successor]);
	added.release();
	assert.deepEqual(store.steersOf("ag_03"), { steers: dev.steers, omitted: 2 });
	assert.equal(store.memberInfo("ag_03")!.member.successorOf, "ag_01", "the record carries successorOf");
	store.recordOperatorSteer("ag_03", "one more");
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
		const store = new TeamStore(() => "/shared/teams", () => key);
		const prepared = createIn(store, {
			name: "Crew", objective: "o", coordination: {},
			members: [{ role: "coordinator", prompt: "c", duty: "coordinator", orchestrator: true }, { role: "dev", prompt: "d" }],
		});
		prepared.release();
		return prepared;
	};
	const a = create("session-a"), b = create("session-b");
	assert.equal(a.teamId, b.teamId, "both sessions' first team is team_01");
	assert.equal(a.coordination!.handoffDir, "/shared/teams/session-a/team_01");
	assert.notEqual(a.coordination!.handoffDir, b.coordination!.handoffDir);
	assert.match(a.members[1].spec.prompt, /Your handover note path: \/shared\/teams\/session-a\/team_01\/dev\/handover\.md\./);
});

test("restart: tasks, every steer and a successor's inheritance rebuild from session entries; a pause is read back from the team events", () => {
	const assignment = (data: unknown) => ({ type: "custom", customType: ASSIGNMENT_ENTRY_TYPE, data });
	const event = (teamId: string, kind: string) => ({ type: "custom", customType: TEAM_EVENT_ENTRY_TYPE, data: { version: 1, teamId, kind, workerId: "ag_03", role: "monitor", at: 1 } });
	// What a live store writes is exactly what a reloaded one reads.
	const live = new TeamStore();
	const prepared = createIn(live, {
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
	const add = addTo(live, "team_01", [{ role: "dev-2", prompt: "Continue", assignment: "Write f01-f10.", successorOf: "dev", successorOfId: "ag_02" }]);
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

test("checkStandingRoles: a member the chat names on the coordinator's or monitor's role is refused, saying the role is Sova's", async () => {
	const { checkStandingRoles } = await import("./teams.ts");
	const { defaultTeamDefaults } = await import("./team-defaults.ts");
	const d = { ...defaultTeamDefaults(), coordinator: { ...defaultTeamDefaults().coordinator, role: "lead" }, monitor: { ...defaultTeamDefaults().monitor, role: "watch" } };
	assert.doesNotThrow(() => checkStandingRoles(d, [{ role: "dev", prompt: "p" }]));
	assert.throws(() => checkStandingRoles(d, [{ role: " LEAD ", prompt: "p" }]), /^Error: Role LEAD is the role of the coordinator Sova adds to every team \(lead\); give that member another role\.$/);
	assert.throws(() => checkStandingRoles(d, [{ role: "watch", prompt: "p" }]), /the role of the monitor Sova adds to every team \(watch\)/);
	for (const role of ["lead", "watch"])
		try { checkStandingRoles(d, [{ role, prompt: "p" }]); } catch (e) { assert.doesNotMatch((e as Error).message, /defaults\.|: false|orchestrator/, "no way out is offered"); }
});

test("checkReplacement: only the newest coordinator or monitor, only while none with that duty is live", () => {
	const store = new TeamStore("/tmp/teams", () => "s");
	const prepared = createIn(store, {
		name: "Crew", objective: "o", coordination: {},
		members: [{ role: "lead", prompt: "c", orchestrator: true, duty: "coordinator" }, { role: "dev", prompt: "d" }, { role: "watch", prompt: "m", duty: "monitor", tools: [] }],
	});
	store.commitCreate(prepared, 1, [
		member(1, { role: "lead", orchestrator: true, duty: "coordinator" }), member(2, { role: "dev" }), member(3, { role: "watch", duty: "monitor" }),
	]);
	const live = new Set(["ag_01", "ag_02", "ag_03"]);
	const isLive = (id: string) => live.has(id);
	assert.throws(() => store.checkReplacement("Crew", "lead", isLive), /lead \(ag_01\) is team_01's live coordinator/);
	assert.throws(() => store.checkReplacement("Crew", "dev", isLive), /dev is not team_01's coordinator or monitor/);
	assert.throws(() => store.checkReplacement("Crew", "nobody", isLive), /No member nobody in team_01\. Members: ag_01 \(lead, coordinator\), ag_02 \(dev\), ag_03 \(watch, monitor\)\./);
	live.delete("ag_01");
	assert.deepEqual(store.checkReplacement("team_01", "ag_01", isLive).target.role, "lead");
	assert.throws(() => store.checkReplacement("Crew", "dev", isLive), /No coordinator is live: replace the coordinator first, and it can then succeed dev\./);
	assert.throws(() => store.checkReplacement("Crew", "watch", isLive), /watch \(ag_03\) is team_01's live monitor/);
	// A newer coordinator (a successor) that has ended too: only it may be replaced.
	const add = addTo(store, "Crew", [{ role: "lead-2", prompt: "c", orchestrator: true, duty: "coordinator", successorOf: "lead", successorOfId: "ag_01" }]);
	store.commitAdd(add, [member(4, { role: "lead-2", orchestrator: true, duty: "coordinator", successorOf: "ag_01", addedAt: 2 })]);
	add.release();
	assert.throws(() => store.checkReplacement("Crew", "lead", isLive), /lead \(ag_01\) is not team_01's newest coordinator; replace lead-2 \(ag_04\) instead\./);
	assert.equal(store.checkReplacement("Crew", "lead-2", isLive).target.workerId, "ag_04");
	live.add("ag_04");
	assert.throws(() => store.checkReplacement("Crew", "lead", isLive), /lead-2 \(ag_04\) is team_01's live coordinator/);
});

test("contract: a member's work kind goes from the prepared member to its record and back through the entry; a record without one stays without", () => {
	const store = new TeamStore();
	const prepared = createIn(store, { name: "Crew", objective: "obj", members: [{ role: "scout", prompt: "look", kind: "investigation" }, { role: "dev", prompt: "build" }] });
	assert.deepEqual(prepared.members.map((m) => [m.role, m.kind]), [["scout", "investigation"], ["dev", undefined], ["coordinator", undefined]]);
	const members = prepared.members.map((m, i) => member(i + 1, { role: m.role, ...(m.kind ? { kind: m.kind } : {}), ...(m.duty ? { duty: m.duty, orchestrator: true } : {}) }));
	const data = { version: 1, op: "create", team: { id: prepared.teamId, name: "Crew", objective: "obj", createdAt: 1 }, members };
	const decoded = decodeTeamEntry(JSON.parse(JSON.stringify(data)));
	assert.deepEqual(decoded?.members.map((m) => m.kind), ["investigation", undefined, undefined]);
	assert.equal("kind" in decoded!.members[1], false, "no kind is no key, as a record written before kinds");
	const restored = new TeamStore();
	restored.restoreHistory([entry(data)]);
	assert.equal(restored.adoptHistoryTeam(prepared.teamId), true);
	assert.equal(restored.memberInfo("ag_01")?.member.kind, "investigation", "the kind survives a reload");
	assert.equal(decodeTeamEntry({ ...data, members: [member(1, { kind: "quick" as never })] }), undefined, "an unknown kind rejects the member");
	prepared.release();
});

test("a Planning & specs or Investigation successor's task says not to edit; an implementation one's does not", () => {
	const base = { oldRole: "scout", oldId: "ag_02", note: "/n.md", oldLive: false, steers: [], steersOmitted: 0 };
	assert.match(workerSuccessorTask({ ...base, kind: "investigation" }), /\n\nYour work kind is Investigation: do not edit, create or delete project files\./);
	assert.match(workerSuccessorTask({ ...base, kind: "planning" }), /Your work kind is Planning & specs: do not edit/);
	assert.doesNotMatch(workerSuccessorTask({ ...base, kind: "complex" }), /do not edit/);
	assert.doesNotMatch(workerSuccessorTask(base), /do not edit/);
});
