import { test } from "node:test";
import assert from "node:assert/strict";
// The module reads the spawn path's marker at load: load it as a session that is not a worker, whatever runs the tests.
delete process.env.SPEC_AGREE_GIVEN;
const { AGREE_SOURCE_ENV, goAheadRef, latestUserEntry, setAgreeSource } = await import(`./spec-agree.ts?session=${Date.now()}`);

const user = (id: string) => ({ type: "message", id, message: { role: "user" } });
const assistant = (id: string) => ({ type: "message", id, message: { role: "assistant" } });
const session = (branch: unknown[], id = "s-1") => ({ getSessionId: () => id, getBranch: () => branch });

test("the go-ahead is the latest user message on the branch, as pi-session:<session>#<entry>", () => {
	const branch = [user("u1"), assistant("a1"), { type: "custom", id: "c1" }, user("u2"), assistant("a2"), { type: "message", id: "t1", message: { role: "toolResult" } }];
	assert.equal(latestUserEntry(branch), "u2");
	assert.equal(goAheadRef(session(branch), undefined, false), "pi-session:s-1#u2");
	assert.equal(goAheadRef(session([assistant("a1")]), undefined, false), undefined, "no user message: no reference");
});

test("a process given a reference relays it and never derives one from its own messages (a worker's are its brief)", () => {
	assert.equal(goAheadRef(session([user("brief")], "worker"), "pi-session:parent#u9"), "pi-session:parent#u9");
});

test("bash sees the reference while spec is on, and what the process was given while it is off", () => {
	const env: NodeJS.ProcessEnv = {};
	const s = session([user("u1")]);
	setAgreeSource(s, true, env, undefined, false);
	assert.equal(env[AGREE_SOURCE_ENV], "pi-session:s-1#u1");
	setAgreeSource(session([user("u1"), user("u3")]), true, env, undefined, false);
	assert.equal(env[AGREE_SOURCE_ENV], "pi-session:s-1#u3", "follows the latest user message");
	setAgreeSource(s, false, env, undefined, false);
	assert.equal(AGREE_SOURCE_ENV in env, false, "spec off: nothing set");
	setAgreeSource(s, false, env, "given");
	assert.equal(env[AGREE_SOURCE_ENV], "given");
});

test("a session manager without a branch or an id gives no reference and never throws (a host's may lack them)", () => {
	assert.equal(goAheadRef({}, undefined, false), undefined);
	assert.equal(goAheadRef({ getBranch: () => [user("u1")] }, undefined, false), undefined, "no session id: no reference");
	const env: NodeJS.ProcessEnv = { [AGREE_SOURCE_ENV]: "stale" };
	setAgreeSource({}, true, env, undefined, false);
	assert.equal(AGREE_SOURCE_ENV in env, false, "nothing to point at: nothing set");
});

// After an in-process reload pi re-runs this module: the session's own earlier write to SPEC_AGREE_SOURCE must never
// read as a reference it was given. Only the spawn path's SPEC_AGREE_GIVEN makes a process a worker.
test("after a reload, a session's own SPEC_AGREE_SOURCE is not a given reference: it follows its latest user message", async () => {
	const saved = { source: process.env.SPEC_AGREE_SOURCE, given: process.env.SPEC_AGREE_GIVEN };
	try {
		process.env.SPEC_AGREE_SOURCE = "pi-session:s-1#u1";
		delete process.env.SPEC_AGREE_GIVEN;
		const fresh = await import(`./spec-agree.ts?reload=${Date.now()}`);
		const env: NodeJS.ProcessEnv = { SPEC_AGREE_SOURCE: "pi-session:s-1#u1" };
		fresh.setAgreeSource(session([user("u1"), user("u2")]), true, env);
		assert.equal(env.SPEC_AGREE_SOURCE, "pi-session:s-1#u2");
		fresh.setAgreeSource(session([user("u1"), user("u2")]), true);
		assert.equal(process.env.SPEC_AGREE_SOURCE, "pi-session:s-1#u2", "the module's own default env too");
		// A worker is what the spawn path marks: it relays the reference it was given.
		process.env.SPEC_AGREE_GIVEN = "pi-session:parent#u9";
		const worker = await import(`./spec-agree.ts?worker=${Date.now()}`);
		assert.equal(worker.goAheadRef(session([user("brief")], "w")), "pi-session:parent#u9");
		// Marked with none: no reference, never its own brief.
		process.env.SPEC_AGREE_GIVEN = "";
		const none = await import(`./spec-agree.ts?none=${Date.now()}`);
		assert.equal(none.goAheadRef(session([user("brief")], "w")), undefined);
	} finally {
		for (const [k, v] of [["SPEC_AGREE_SOURCE", saved.source], ["SPEC_AGREE_GIVEN", saved.given]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
});

test("the spawn path's worker env: the reference in both variables, or the worker marker alone when there is none", async () => {
	const { workerAgreeEnv, AGREE_GIVEN_ENV } = await import("./spec-agree.ts");
	assert.equal(AGREE_GIVEN_ENV, "SPEC_AGREE_GIVEN");
	assert.deepEqual(workerAgreeEnv("pi-session:s-1#u2"), { SPEC_AGREE_SOURCE: "pi-session:s-1#u2", SPEC_AGREE_GIVEN: "pi-session:s-1#u2" });
	assert.deepEqual(workerAgreeEnv(undefined), { SPEC_AGREE_GIVEN: "" });
});
