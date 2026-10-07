// Run: pnpm exec tsx --test server/stream-guard-runtime.test.ts. A throwaway PI_CODING_AGENT_DIR
// whose models.json registers a stub endpoint (server/stream-stub.ts, in-process: fetch answers its
// URL, no socket) through pi's real openai-completions provider; ~/.pi is never read or written and
// no real model is called. What the guard costs the loop is measured over a real socket in
// stream-guard-runtime.integration.test.ts; here, the mechanism: where it trips, what it stops.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_SENT_ENTRY } from "../shared/baton";
import { inProcessStreamStub, stubModelsJson } from "./stream-stub";
import { piSession } from "./harness/pi/testing/handle";
import { until } from "./test-wait";

// Only the stub may answer: no provider key from the environment makes a real model available.
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-stream-guard-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
// Before the model runtime exists (it is memoised): the stub is the only model there is.
const stub = inProcessStreamStub({ payload: "whitespace", perDelta: 6 });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.baseUrl)));

const orgs = await import("./orgs");
const { replyEnded } = await import("./org-test-fixtures");
const baton = await import("./baton");
const { BATON_TOOLS } = await import("./baton-loadout");
const wrap = await import("./baton-wrapup");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { setStreamCapsForTest } = await import("./stream-guard");
const { registerWrapupRoutes } = await import("./wrapup-routes");
const recovery = await import("./wrapup-recovery");

after(async () => {
  setStreamCapsForTest(null);
  await disposeAllChats();
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function ordinarySession(): string {
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const id = `01a0dd00-0000-7000-8000-00000000000${++n}`;
  const file = join(dir, `2026-09-27T00-00-0${n}-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd })}\n`);
  return canonicalPath(file);
}

const lastAssistant = (chat: Awaited<ReturnType<typeof acquireChat>>) =>
  [...piSession(chat).sessionManager.getBranch()].reverse().find((e: any) => e.type === "message" && e.message?.role === "assistant") as any;

describe("the stream guard against a runaway stream (real provider path, in-process stub)", () => {
  // One ordinary turn first: the provider's modules load lazily on the first request.
  before(async () => {
    stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
    const chat = await acquireChat(ordinarySession(), true);
    await chat.setModelRef("stub/runaway");
    await chat.acceptPrompt("warm up").turn;
    assert.equal(stub.stats.finished, true);
  });

  test("an ordinary chat: endless whitespace in a tool call is stopped at exactly the whitespace cap, and the stub stops sending", async () => {
    stub.reset({ payload: "whitespace", perDelta: 16 });
    const chat = await acquireChat(ordinarySession(), true);
    await chat.setModelRef("stub/runaway");
    const errors: string[] = [];
    chat.clients.add({ send: (m: any) => m.type === "error" && errors.push(m.message) } as never);
    await chat.acceptPrompt("go").turn;
    await stub.closed(); // the abort reached the stub (its body was cancelled)
    assert.equal(lastAssistant(chat)?.message?.stopReason, "aborted");
    assert.equal(chat.lastStreamTrip?.kind, "whitespace");
    assert.equal(chat.lastStreamTrip?.chars, 8192);
    assert.deepEqual(errors, ["Stopped the turn: the model streamed 8,192 whitespace characters in a row into a tool call."]);
    assert.equal(stub.stats.requests, 1, "no automatic retry after the stop");
    assert.equal(stub.stats.finished, false);
    const sent = stub.stats.argChars;
    await new Promise((r) => setImmediate(r));
    assert.equal(stub.stats.argChars, sent, "and the stub stopped sending");
    // The stub makes its body only as the reader pulls it: what was sent is what pi read, so the
    // stall pi's parse can cause is bounded by the cap's work, not by the stream's length.
    assert.ok(sent < 64 * 1024, `bounded: ${sent} characters sent`);
  });

  test("control, with the caps raised: the same stub, finite (16 K), runs to its end untripped", async () => {
    setStreamCapsForTest({ whitespaceRunChars: Infinity, toolArgChars: Infinity, starvedMs: Infinity });
    try {
      stub.reset({ payload: "whitespace", perDelta: 128, limit: 16 * 1024, tool: "no_such_tool" });
      const chat = await acquireChat(ordinarySession(), true);
      await chat.setModelRef("stub/runaway");
      await chat.acceptPrompt("go").turn;
      assert.equal(stub.stats.finished, true, "the stream ran to its end: nothing stopped it");
      assert.ok(stub.stats.argChars >= 16 * 1024, "past the cap that would have tripped");
      assert.equal(chat.lastStreamTrip, null);
    } finally {
      setStreamCapsForTest(null);
    }
  });

  describe("a baton session's wrap-up", async () => {
    const org = await orgs.createOrg({ name: "Guard", dir: join(root, "ws") });
    mkdirSync(join(root, "bproj"), { recursive: true });
    const project = await orgs.addProject(org.id, { name: "P", root: join(root, "bproj") });
    const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server", model: "stub/runaway" });

    before(async () => {
      const entries = readFileSync(c.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const at = new Date().toISOString();
      appendFileSync(
        c.path,
        `${JSON.stringify({ type: "message", id: "tu1", parentId: entries.at(-1).id, timestamp: at, message: { role: "user", content: [{ type: "text", text: "The server is on AWS." }], timestamp: Date.now() } })}\n` +
          `${JSON.stringify({ type: "custom", id: "tm1", parentId: "tu1", timestamp: at, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "tu1", by: tony.id } })}\n`,
      );
      (await import("./write-guard")).markOwned(c.path);
      baton.noteMessage(c.sessionId, tony.id); // the statechart counts Tony's message: a person wrote, so it wraps up
      await replyEnded(c.sessionId); // and the reply to it ended (as the runtime wrote it above)
      const chat = await acquireChat(c.path);
      await chat.setModelRef("stub/runaway");
    });
    /** The statechart's wrap-up row once its run ended. */
    const settled = async () => {
      await until(() => ["failed", "done"].includes(baton.batonById(c.sessionId)!.row.wrapup?.state ?? ""), "the wrap-up's run to end");
      return baton.batonById(c.sessionId)!.row.wrapup;
    };

    test("letters past 64 K in one tool call: the turn is stopped and the wrap-up is recorded failed, naming the stop", async () => {
      stub.reset({ payload: "letters", perDelta: 128 });
      // goal_done: the statechart starts the wrap-up (its :sova/wrapup run) once the reply is idle.
      await baton.markDone(c.sessionId);
      const info = await settled();
      const chat = await acquireChat(c.path);
      assert.equal(chat.lastStreamTrip?.kind, "tool-args");
      assert.equal(info?.state, "failed", "never left running");
      assert.equal(info?.error, "A tool call's arguments passed 65,536 characters, so the stream guard ended the turn.");
      assert.equal(wrap.wantsWrapup(baton.batonById(c.sessionId)!.row), false, "and not retried on its own");
    });

    test("Retry Wrap-Up: runs a failed wrap-up again; refused for any other state", async () => {
      const app = new Hono();
      registerWrapupRoutes(app);
      stub.reset({ payload: "letters", perDelta: 16, limit: 64 });
      const res = await app.request(`/api/baton/${c.sessionId}/wrapup/retry`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { session: { wrapup?: { state: string } } };
      assert.ok(body.session.wrapup && body.session.wrapup.state !== "failed", `answers with the new run (${body.session.wrapup?.state})`);
      await until(() => baton.batonById(c.sessionId)!.row.wrapup?.state !== "running", "the retried run to end");
      const row = baton.batonById(c.sessionId)!.row;
      // The stub's update names no roster person, so it is refused: the run itself ended normally.
      assert.equal(row.wrapup?.state, "done");
      assert.equal(row.wrapup?.refused.length, 1);
      assert.equal(stub.stats.finished, true);
      const again = await app.request(`/api/baton/${c.sessionId}/wrapup/retry`, { method: "POST" });
      assert.equal(again.status, 409, "a wrap-up that didn't fail is not retried");
      assert.match(((await again.json()) as { error: string }).error, /Only a wrap-up that stopped/);
      assert.equal((await app.request(`/api/baton/nope/wrapup/retry`, { method: "POST" })).status, 404);
    });
  });

  describe("a wrap-up cut off by a stop, not the guard", async () => {
    const org = await orgs.createOrg({ name: "Cut", dir: join(root, "ws-cut") });
    mkdirSync(join(root, "cproj"), { recursive: true });
    const project = await orgs.addProject(org.id, { name: "P", root: join(root, "cproj") });
    const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server", model: "stub/runaway" });
    const app = new Hono();
    registerWrapupRoutes(app);
    const row = () => baton.batonById(c.sessionId)!.row;
    /** Resolve once the wrap-up's request reached the stub. */
    const requested = async () => {
      await until(() => stub.stats.requests > 0, "the wrap-up's request");
      assert.equal(stub.stats.requests, 1, "the wrap-up's request reached the model");
    };
    const settledRow = async () => {
      await until(() => row().wrapup?.state !== "running", "the wrap-up's run to end");
      return row().wrapup;
    };

    before(async () => {
      // The session's own last turn ended with goal_done: an earlier assistant message whose stop
      // is an ordinary tool call, which a wrap-up that wrote nothing must not be read as.
      const entries = readFileSync(c.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const at = new Date().toISOString();
      appendFileSync(
        c.path,
        `${JSON.stringify({ type: "message", id: "cu1", parentId: entries.at(-1).id, timestamp: at, message: { role: "user", content: [{ type: "text", text: "The server is on AWS." }], timestamp: Date.now() } })}\n` +
          `${JSON.stringify({ type: "custom", id: "cm1", parentId: "cu1", timestamp: at, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "cu1", by: tony.id } })}\n` +
          `${JSON.stringify({ type: "message", id: "ca1", parentId: "cm1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: "g1", name: "goal_done", arguments: {} }], api: "openai-completions", provider: "stub", model: "runaway", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } })}\n`,
      );
      (await import("./write-guard")).markOwned(c.path);
      baton.noteMessage(c.sessionId, tony.id);
      await replyEnded(c.sessionId);
      const chat = await acquireChat(c.path);
      await chat.setModelRef("stub/runaway");
    });
    after(() => recovery.clearShutdownForTest());

    test("a graceful shutdown during the wrap-up records it failed, saying so; Retry then runs it again", async () => {
      // The model hasn't answered yet: the stop leaves the turn no assistant message at all.
      stub.reset({ payload: "letters", perDelta: 16, holdMs: 5000 });
      await baton.markDone(c.sessionId);
      await requested();
      assert.equal(row().wrapup?.state, "running");
      // What index.ts's shutdown does: mark, abort every streaming turn, dispose every runtime.
      recovery.markShutdown();
      piSession(await acquireChat(c.path)).abort().catch(() => {});
      await disposeAllChats();
      const info = await settledRow();
      recovery.clearShutdownForTest();
      assert.equal(info?.state, "failed");
      assert.equal(info?.error, "The server shut down during the wrap-up.");

      stub.reset({ payload: "letters", perDelta: 16, pauseMs: 20 });
      const res = await app.request(`/api/baton/${c.sessionId}/wrapup/retry`, { method: "POST" });
      assert.equal(res.status, 200);
      await requested();
      const again = await app.request(`/api/baton/${c.sessionId}/wrapup/retry`, { method: "POST" });
      assert.equal(again.status, 409);
      assert.equal(((await again.json()) as { error: string }).error, "The wrap-up is already running.");

      // Stopped with no shutdown (Stop, Take back): failed too, never done.
      await piSession(await acquireChat(c.path)).abort();
      const w = await settledRow();
      assert.equal(w?.state, "failed");
      assert.notEqual(w?.error, "The server shut down during the wrap-up.");
      assert.ok(w?.error, "it names a reason");
    });

    test("a shutdown mid-stream: the partial answer is not an answer either", async () => {
      stub.reset({ payload: "letters", perDelta: 16, pauseMs: 20 });
      const res = await app.request(`/api/baton/${c.sessionId}/wrapup/retry`, { method: "POST" });
      assert.equal(res.status, 200);
      await until(() => stub.stats.startedAt !== null, "the stream's start");
      recovery.markShutdown();
      await piSession(await acquireChat(c.path)).abort();
      const w = await settledRow();
      recovery.clearShutdownForTest();
      assert.equal(w?.state, "failed");
      assert.equal(w?.error, "The server shut down during the wrap-up.");
    });
  });
});
