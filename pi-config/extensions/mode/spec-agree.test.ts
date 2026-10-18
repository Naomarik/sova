import { test } from "node:test";
import assert from "node:assert/strict";
import { AGREE_SOURCE_ENV, goAheadRef, latestUserEntry, setAgreeSource } from "./spec-agree.ts";

const user = (id: string) => ({ type: "message", id, message: { role: "user" } });
const assistant = (id: string) => ({ type: "message", id, message: { role: "assistant" } });
const session = (branch: unknown[], id = "s-1") => ({ getSessionId: () => id, getBranch: () => branch });

test("the go-ahead is the latest user message on the branch, as pi-session:<session>#<entry>", () => {
	const branch = [user("u1"), assistant("a1"), { type: "custom", id: "c1" }, user("u2"), assistant("a2"), { type: "message", id: "t1", message: { role: "toolResult" } }];
	assert.equal(latestUserEntry(branch), "u2");
	assert.equal(goAheadRef(session(branch), undefined), "pi-session:s-1#u2");
	assert.equal(goAheadRef(session([assistant("a1")]), undefined), undefined, "no user message: no reference");
});

test("a process given a reference relays it and never derives one from its own messages (a worker's are its brief)", () => {
	assert.equal(goAheadRef(session([user("brief")], "worker"), "pi-session:parent#u9"), "pi-session:parent#u9");
});

test("bash sees the reference while spec is on, and what the process was given while it is off", () => {
	const env: NodeJS.ProcessEnv = {};
	const s = session([user("u1")]);
	setAgreeSource(s, true, env, undefined);
	assert.equal(env[AGREE_SOURCE_ENV], "pi-session:s-1#u1");
	setAgreeSource(session([user("u1"), user("u3")]), true, env, undefined);
	assert.equal(env[AGREE_SOURCE_ENV], "pi-session:s-1#u3", "follows the latest user message");
	setAgreeSource(s, false, env, undefined);
	assert.equal(AGREE_SOURCE_ENV in env, false, "spec off: nothing set");
	setAgreeSource(s, false, env, "given");
	assert.equal(env[AGREE_SOURCE_ENV], "given");
});
