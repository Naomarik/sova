// Run: pnpm exec tsx --test server/stream-guard-runtime.integration.test.ts. The stream guard's
// cost, measured: a local stub endpoint on 127.0.0.1 (server/stream-stub.ts) through pi's real
// openai-completions provider, in a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written and
// no real model is called. The mechanism (the trip at exactly the cap, the abort, no retry, the stub
// stopped) is checked in-process by stream-guard-runtime.test.ts; this file checks only what takes a
// clock: the guarded turn costs the main thread little, and the same stream unguarded costs it
// several times more. Main-thread CPU time is the measure (the harm is pi's parse on that thread),
// so other load on the machine barely moves it; the loop's stalls are printed as evidence only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { startStreamStub, stubModelsJson } from "./stream-stub";
import { piSession } from "./harness/pi/testing/handle";

// Only the stub may answer: no provider key from the environment makes a real model available.
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-stream-guard-int-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
// Before the model runtime exists (it is memoised): the stub is the only model there is.
const stub = await startStreamStub({ payload: "whitespace", perDelta: 6 });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { setStreamCapsForTest } = await import("./stream-guard");

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
  const id = `01a0dd00-0000-7000-8000-00000000010${++n}`;
  const file = join(dir, `2026-09-27T00-00-0${n}-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd })}\n`);
  return canonicalPath(file);
}

/** Main-thread CPU (ms) while `fn` runs, and, as evidence, the loop's longest stall (the
    loop-delay histogram's max or a 10 ms interval's longest gap, whichever is larger). */
async function cost(fn: () => Promise<unknown>): Promise<{ cpuMs: number; stallMs: number; ms: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let maxGap = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  h.enable();
  const t0 = performance.now();
  const c0 = process.threadCpuUsage();
  try {
    await fn();
    const c = process.threadCpuUsage(c0);
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    return { cpuMs: (c.user + c.system) / 1000, stallMs: Math.max(h.max / 1e6, maxGap), ms: now - t0 };
  } finally {
    h.disable();
    clearInterval(iv);
  }
}

const lastAssistant = (chat: Awaited<ReturnType<typeof acquireChat>>) =>
  [...piSession(chat).sessionManager.getBranch()].reverse().find((e: any) => e.type === "message" && e.message?.role === "assistant") as any;

/** Numbers for the report, printed once. */
const evidence: Record<string, unknown> = {};
after(() => console.log(`[stream-guard evidence] ${JSON.stringify(evidence)}`));

describe("the stream guard's cost against a runaway stream (real provider path, local stub over HTTP)", () => {
  const guarded: { cpuMs: number; stallMs: number; ms: number }[] = [];

  // One ordinary turn first: the provider's modules load lazily on the first request, and that
  // one-time stall is not the stream's.
  before(async () => {
    stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
    const chat = await acquireChat(ordinarySession(), true);
    await chat.setModelRef("stub/runaway");
    await chat.acceptPrompt("warm up").turn;
    assert.equal(stub.stats.finished, true);
  });

  test("an ordinary chat: endless whitespace stopped at the cap costs the main thread little (best of 3)", async () => {
    // Three runs, each a fresh session, each stopped exactly so. The cost that remains is pi's own
    // parse up to the cap (O(cap²/delta)) and the abort itself; the guard's own work is a few ms.
    for (let attempt = 0; attempt < 3; attempt++) {
      stub.reset({ payload: "whitespace", perDelta: 16 });
      const chat = await acquireChat(ordinarySession(), true);
      await chat.setModelRef("stub/runaway");
      const r = await cost(() => chat.acceptPrompt("go").turn);
      await stub.closed();
      assert.equal(lastAssistant(chat)?.message?.stopReason, "aborted");
      assert.equal(chat.lastStreamTrip?.chars, 8192);
      guarded.push(r);
    }
    evidence.guarded = guarded.map((r) => ({ cpuMs: Math.round(r.cpuMs), stallMs: Math.round(r.stallMs), turnMs: Math.round(r.ms) }));
    const best = Math.min(...guarded.map((r) => r.cpuMs));
    assert.ok(best < 250, `the guarded turn's main-thread CPU: ${best} ms (best of 3)`);
  });

  test("control, with the caps raised: the same stub, finite (192 K), costs the main thread materially more", async () => {
    assert.equal(guarded.length, 3, "runs after the guarded case");
    setStreamCapsForTest({ whitespaceRunChars: Infinity, toolArgChars: Infinity, starvedMs: Infinity });
    try {
      stub.reset({ payload: "whitespace", perDelta: 128, limit: 192 * 1024, tool: "no_such_tool" });
      const chat = await acquireChat(ordinarySession(), true);
      await chat.setModelRef("stub/runaway");
      const r = await cost(() => chat.acceptPrompt("go").turn);
      evidence.control = { cpuMs: Math.round(r.cpuMs), stallMs: Math.round(r.stallMs), turnMs: Math.round(r.ms), argCharsSent: stub.stats.argChars };
      assert.equal(stub.stats.finished, true, "the stream ran to its end: nothing stopped it");
      assert.equal(chat.lastStreamTrip, null);
      // Against the guarded runs' worst, not their best: the ratio can't come from picking.
      const guardedWorst = Math.max(...guarded.map((g) => g.cpuMs));
      assert.ok(r.cpuMs >= 4 * guardedWorst, `control's main-thread CPU ${r.cpuMs} ms vs the guarded runs' worst ${guardedWorst} ms`);
    } finally {
      setStreamCapsForTest(null);
    }
  });
});
