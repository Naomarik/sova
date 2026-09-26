// Run: pnpm exec tsx --test server/stream-guard-runtime.test.ts. A throwaway PI_CODING_AGENT_DIR
// whose models.json registers a local stub endpoint (server/stream-stub.ts) through pi's real
// openai-completions provider; ~/.pi is never read or written and no real model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_SENT_ENTRY } from "../shared/baton";
import { startStreamStub, stubModelsJson } from "./stream-stub";

// Only the stub may answer: no provider key from the environment makes a real model available.
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-stream-guard-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
// Before the model runtime exists (it is memoised): the stub is the only model there is.
const stub = await startStreamStub({ payload: "whitespace", perDelta: 6 });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));

const orgs = await import("./orgs");
const baton = await import("./baton");
const { BATON_TOOLS } = await import("./baton-loadout");
const wrap = await import("./baton-wrapup");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { setStreamCapsForTest } = await import("./stream-guard");
const { registerWrapupRoutes } = await import("./wrapup-routes");

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

/**
 * Loop liveness while `fn` runs: the loop-delay histogram's max, the longest gap of a 10 ms
 * interval, and `worstMs`, the larger of the two. The histogram samples on its own timer and can
 * miss a short window entirely (max 0); the interval's gap can't.
 */
async function liveness<T>(fn: () => Promise<T>): Promise<{ value: T; maxDelayMs: number; maxGapMs: number; worstMs: number; ticks: number; ms: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 10);
  h.enable();
  const t0 = performance.now();
  try {
    const value = await fn();
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    return { value, maxDelayMs: h.max / 1e6, maxGapMs: maxGap, worstMs: Math.max(h.max / 1e6, maxGap), ticks, ms: now - t0 };
  } finally {
    h.disable();
    clearInterval(iv);
  }
}

const lastAssistant = (chat: Awaited<ReturnType<typeof acquireChat>>) =>
  [...chat.session.sessionManager.getBranch()].reverse().find((e: any) => e.type === "message" && e.message?.role === "assistant") as any;

/** Numbers for the report, printed once. */
const evidence: Record<string, unknown> = {};
after(() => console.log(`[stream-guard evidence] ${JSON.stringify(evidence)}`));

describe("the stream guard against a runaway stream (real provider path, local stub)", () => {
  let guarded: { worstMs: number } | null = null;

  // One ordinary turn first: the provider's modules load lazily on the first request, and that
  // one-time stall is not the stream's.
  before(async () => {
    stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
    const chat = await acquireChat(ordinarySession(), true);
    await chat.setModelRef("stub/runaway");
    await chat.acceptPrompt("warm up").turn;
    assert.equal(stub.stats.finished, true);
  });

  test("an ordinary chat: endless whitespace in a tool call is stopped at the whitespace cap, and the loop stays live", async () => {
    // Three runs, each a fresh session. Every run must stop exactly so; the loop's liveness is the
    // best of the three, because a parallel test run only ever adds delay (a guard that didn't
    // trip stalls for seconds in every run). The stall that remains is pi's own parse up to the
    // cap (O(cap²/delta), measured ~50 ms of a ~100 ms block at 16 characters per delta) and the
    // abort itself; the guard's own work is a few ms.
    const runs: Awaited<ReturnType<typeof liveness>>[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      stub.reset({ payload: "whitespace", perDelta: 16 });
      const chat = await acquireChat(ordinarySession(), true);
      await chat.setModelRef("stub/runaway");
      const errors: string[] = [];
      chat.clients.add({ send: (m: any) => m.type === "error" && errors.push(m.message) } as never);
      const r = await liveness(async () => {
        const { turn } = chat.acceptPrompt("go");
        await Promise.race([turn, new Promise((_, rej) => setTimeout(() => rej(new Error("turn did not settle in 5 s")), 5000))]);
      });
      // The socket closes a moment after the turn settles (the SDK's reader cancels on abort).
      for (let i = 0; i < 100 && stub.stats.closedAt === null; i++) await new Promise((res) => setTimeout(res, 20));
      runs.push(r);
      assert.ok(r.ms < 5000, `settled in ${r.ms} ms`);
      assert.equal(lastAssistant(chat)?.message?.stopReason, "aborted");
      assert.equal(chat.lastStreamTrip?.kind, "whitespace");
      assert.equal(chat.lastStreamTrip?.chars, 8192);
      assert.deepEqual(errors, ["Stopped the turn: the model streamed 8,192 whitespace characters in a row into a tool call."]);
      assert.equal(stub.stats.requests, 1, "no automatic retry after the stop");
      assert.notEqual(stub.stats.closedAt, null, "the abort reached the stub's socket");
      assert.equal(stub.stats.finished, false);
      const sent = stub.stats.argChars;
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(stub.stats.argChars, sent, "and the stub stopped sending");
      assert.ok(sent < 4 * 1024 * 1024, `bounded: ${sent} characters sent (socket buffers included)`);
      evidence.guarded ??= [];
      (evidence.guarded as unknown[]).push({ turnMs: Math.round(r.ms), argCharsSent: sent, maxDelayMs: +r.maxDelayMs.toFixed(1), maxGapMs: +r.maxGapMs.toFixed(1), ticks: r.ticks });
    }
    const best = runs.reduce((a, b) => (b.worstMs < a.worstMs ? b : a));
    guarded = best;
    assert.ok(best.worstMs < 250, `loop delay max ${best.maxDelayMs} ms, 10 ms interval's longest gap ${best.maxGapMs} ms (best of 3)`);
  });

  test("control, with the caps raised: the same stub, finite (384 K), makes the loop materially worse", async () => {
    assert.ok(guarded, "runs after the guarded case");
    setStreamCapsForTest({ whitespaceRunChars: Infinity, toolArgChars: Infinity, starvedMs: Infinity });
    try {
      stub.reset({ payload: "whitespace", perDelta: 128, limit: 384 * 1024, tool: "no_such_tool" });
      const chat = await acquireChat(ordinarySession(), true);
      await chat.setModelRef("stub/runaway");
      const r = await liveness(async () => {
        const { turn } = chat.acceptPrompt("go");
        await turn;
      });
      evidence.control = { turnMs: Math.round(r.ms), argCharsSent: stub.stats.argChars, maxDelayMs: +r.maxDelayMs.toFixed(1), maxGapMs: +r.maxGapMs.toFixed(1), ticks: r.ticks };
      assert.equal(stub.stats.finished, true, "the stream ran to its end: nothing stopped it");
      assert.equal(chat.lastStreamTrip, null);
      assert.ok(guarded!.worstMs > 0);
      // Against the guarded runs' worst, not their best: the ratio can't come from picking.
      const guardedWorst = Math.max(...(evidence.guarded as { maxDelayMs: number; maxGapMs: number }[]).map((g) => Math.max(g.maxDelayMs, g.maxGapMs)));
      assert.ok(r.worstMs >= 4 * guardedWorst, `control's worst stall ${r.worstMs} ms vs guarded runs' worst ${guardedWorst} ms`);
      assert.ok(r.worstMs >= 500, `the stub reproduces the harm: ${r.worstMs} ms`);
    } finally {
      setStreamCapsForTest(null);
    }
  });

  describe("a baton session's wrap-up", async () => {
    const org = await orgs.createOrg({ name: "Guard", dir: join(root, "ws") });
    mkdirSync(join(root, "bproj"), { recursive: true });
    const project = orgs.addProject(org.id, { name: "P", root: join(root, "bproj") });
    const tony = orgs.addPerson(org.id, { name: "Tony", role: "IT" });
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server", model: "stub/runaway" });

    before(async () => {
      const entries = readFileSync(c.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const at = new Date().toISOString();
      appendFileSync(
        c.path,
        `${JSON.stringify({ type: "message", id: "tu1", parentId: entries.at(-1).id, timestamp: at, message: { role: "user", content: [{ type: "text", text: "The server is on AWS." }], timestamp: Date.now() } })}\n` +
          `${JSON.stringify({ type: "custom", id: "tm1", parentId: "tu1", timestamp: at, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "tu1", by: tony.id } })}\n`,
      );
      (await import("./write-guard")).markOwned(c.path);
      baton.markDone(c.sessionId, new Date());
      const chat = await acquireChat(c.path);
      await chat.setModelRef("stub/runaway");
    });

    test("letters past 64 K in one tool call: the turn is stopped and the wrap-up is recorded failed, naming the stop", async () => {
      stub.reset({ payload: "letters", perDelta: 128 });
      const info = await wrap.runWrapup(c.sessionId, BATON_TOOLS);
      const chat = await acquireChat(c.path);
      evidence.baton = { argCharsSent: stub.stats.argChars, trip: chat.lastStreamTrip, wrapup: info };
      assert.equal(chat.lastStreamTrip?.kind, "tool-args");
      assert.equal(info?.state, "failed");
      assert.equal(info?.error, "Stopped: a tool call's arguments passed 65,536 characters");
      assert.equal(baton.batonById(c.sessionId)!.row.wrapup?.state, "failed", "never left running");
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
      let row = baton.batonById(c.sessionId)!.row;
      for (let i = 0; i < 200 && row.wrapup?.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        row = baton.batonById(c.sessionId)!.row;
      }
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
});
