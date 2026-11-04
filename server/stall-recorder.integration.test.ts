// The stall recorder for real: a child process whose event loop is actually held, a thread that
// watches it, and the log on disk. Each run waits on the log or the child, never on the clock.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { startHermeticServer } from "./testing/hermetic-server";

const root = mkdtempSync(join(tmpdir(), "sova-stall-it-"));
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});
const FIXTURE = join(import.meta.dirname, "stall-recorder.integration.fixture.ts");
let nth = 0;

function host(mode: string, env: Record<string, string> = {}, at = join(root, `h${nth++}`)) {
  mkdirSync(at, { recursive: true });
  const child = spawn(process.execPath, [FIXTURE], { env: { ...process.env, FIXTURE_DIR: at, FIXTURE_MODE: mode, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  kids.push(child);
  const lines: Record<string, any>[] = [];
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += String(d);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { at, child, lines, exited, release: () => writeFileSync(join(at, "release"), "") };
}

async function until<T>(what: string, get: () => T | undefined | null | false, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = get();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const records = (at: string): Record<string, any>[] => {
  try {
    return readFileSync(join(at, "stalls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const record = (at: string, t: string) => until(`a ${t} record`, () => records(at).find((r) => r.t === t));
const linux = process.platform === "linux";

describe("a stall", () => {
  test("is on disk while the loop is still held, and whole once it ends", async () => {
    const h = host("block");
    await until("the block", () => h.lines.find((l) => l.blocking));

    const open = await record(h.at, "stall-open");
    assert.equal(h.child.exitCode, null);
    assert.equal(existsSync(join(h.at, "release")), false, "this record came from the watchdog: the loop is still held");
    assert.equal(open.ops[0].name, "GET /api/fixture/:id");
    assert.equal(open.ops[0].detail, 42);
    assert.ok(open.recent.some((r: any) => r.name === "large read" && r.detail === 4096), "a named size in the recent ring, in KB");
    assert.ok(!open.recent.some((r: any) => r.name === "small read"), "a small one isn't worth a slot");
    assert.equal(open.gauges["fixture rows"], 2706);
    assert.ok(open.heap.heapUsedMb >= 0, "the last heap figures");
    assert.ok(open.rssBytes > 0);
    if (linux) {
      assert.equal(open.main.state, "R", "spinning, not asleep");
      assert.ok(open.memory.anonBytes > 0);
    }

    // Long enough for the watchdog to see the thread spend CPU, then let go.
    await record(h.at, "stall-progress");
    const heldAtLeast = Date.now() - open.sinceAt;
    h.release();
    const s = await record(h.at, "stall");
    assert.equal(s.source, "main");
    assert.equal(s.seenLive, true);
    assert.ok(s.atLeastMs >= 400, `at least ${s.atLeastMs}`);
    assert.ok(s.atMostMs >= heldAtLeast - 200, `at most ${s.atMostMs}, held ${heldAtLeast}`);
    assert.ok(s.samples > 0);
    assert.ok(s.stacks[0].frames.some((f: string) => /^blockTheLoopForTest .*stall-recorder\.integration\.fixture\.ts:\d+$/.test(f)), s.stacks[0].frames.join(" < "));
    if (linux) {
      assert.ok(s.mainCpuMs > 0);
      assert.ok(s.mainRunQueueMs >= 0);
      assert.ok(["spinning", "starved"].includes(s.class), `the loop never slept: ${s.class}`);
    }
    assert.ok(s.memAfter.heapUsedBytes > 0);

    assert.equal(await h.exited, 0);
    const status = h.lines.find((l) => l.status)!.status;
    assert.equal(status.state, "on");
    assert.match(status.recent.at(-1).top, /^blockTheLoopForTest/);
    assert.deepEqual(status.recent.at(-1).ops, ["GET /api/fixture/:id"]);
    assert.ok(!readFileSync(join(h.at, "stalls.jsonl"), "utf8").includes(root), "no record names where it ran");
    assert.equal(records(h.at).at(-1)!.t, "exit");
    assert.equal(records(h.at).at(-1)!.code, 0);
  });

  test("a process killed inside one leaves its record, and the next one calls it unfinished", async () => {
    const at = join(root, "killed");
    const h = host("block", {}, at);
    const open = await record(at, "stall-open");
    h.child.kill("SIGKILL");
    await h.exited;

    const next = host("block", {}, at);
    await until("the second host's block", () => next.lines.find((l) => l.blocking));
    await until("a second open", () => records(at).filter((r) => r.t === "stall-open").length === 2);
    next.release();
    await next.exited;
    const status = next.lines.find((l) => l.status)!.status;
    const unfinished = status.recent.find((r: any) => r.unfinished);
    assert.equal(unfinished.pid, open.pid);
    assert.deepEqual(unfinished.ops, ["GET /api/fixture/:id"]);
    assert.notEqual(open.pid, next.child.pid);
  });
});

describe("a memory rung", () => {
  test("names the climb from the watchdog, and the main thread adds its heap and what it ran", async () => {
    const h = host("memory");
    const m = await record(h.at, "memory");
    assert.ok(m.rssBytes >= m.rungBytes);
    assert.ok(Array.isArray(m.trail));
    if (linux) assert.ok(m.memory.anonBytes > 0 && m.host.memAvailableBytes > 0);
    const detail = await record(h.at, "memory-detail");
    const second = await until("the second rung's answer", () => records(h.at).find((r) => r.t === "memory-detail" && r.rungBytes >= 2 * m.rungBytes));
    assert.equal(second.samplerStopped, true, "past the second rung the sampler is gone");
    assert.equal(detail.samplerStopped, undefined, "at the first it runs on");
    h.release();
    await h.exited;
    assert.ok(detail.mem.external > 0, "external is what Buffer.alloc grows");
    assert.ok(detail.objectCount > 0);
    assert.ok(detail.objectTypes.length > 0);
    assert.ok(detail.samples >= 0);
  });
});

describe("a recorder that fails", () => {
  const faults = [["throw", "failed"], ["late-throw", "failed"], ["exit", "failed"], ["hang", undefined]] as const;
  for (const [fault, want] of faults) {
    test(`a watchdog that ends with "${fault}" leaves the host running, calling every entry point`, async () => {
      const h = host("failing", {
        FIXTURE_WORKER: "./stall-recorder-fault.integration.fixture.ts", FIXTURE_FAULT: fault, ...(want ? { FIXTURE_WANT_STATE: want } : {}),
      });
      assert.equal(await h.exited, 0);
      const [out] = h.lines;
      assert.ok(out!.ticks > 10, `its timer kept running: ${out!.ticks}`);
      assert.ok(existsSync(join(h.at, "finished")));
      if (want) assert.equal(out!.state, want);
    });
  }

  test("a log that can't be written leaves the host running and says failed", async () => {
    const at = join(root, "nofolder");
    mkdirSync(at);
    const blocked = join(at, "a-file");
    writeFileSync(blocked, "");
    const h = host("failing", { FIXTURE_LOG_DIR: join(blocked, "stalls"), FIXTURE_WANT_STATE: "failed" });
    assert.equal(await h.exited, 0);
    assert.equal(h.lines[0]!.state, "failed");
  });

  test("a missing watchdog module leaves the host running", async () => {
    const h = host("failing", { FIXTURE_WORKER: "./no-such-module.ts", FIXTURE_WANT_STATE: "failed" });
    assert.equal(await h.exited, 0);
    assert.equal(h.lines[0]!.state, "failed");
  });
});

describe("in the server", () => {
  test("it starts with the server, reads through /api/monitor, and goes in the state root", async () => {
    const server = await startHermeticServer();
    try {
      const auth = { headers: { "x-sova-token": server.token } };
      const health = (await (await fetch(`${server.base}/api/health`, auth)).json()) as { head: string | null };
      const log = join(server.agentDir, "sova", "stalls");
      await until("the boot record", () => records(log).find((r) => r.t === "boot"));
      if (health.head) assert.equal((await until("the head record", () => records(log).find((r) => r.t === "head"))).head, health.head);
      const deadline = Date.now() + 60_000;
      let res = await fetch(`${server.base}/api/monitor`, auth);
      while (res.status === 503 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        res = await fetch(`${server.base}/api/monitor`, auth);
      }
      assert.equal(((await res.json()) as { stalls?: { state: string } }).stalls?.state, "on");

      const firstPid = server.pid;
      await server.restart();
      const down = await until("the shutdown record", () => records(log).find((r) => r.t === "shutdown"));
      assert.equal(down.pid, firstPid);
      const gone = await until("the exit record", () => records(log).find((r) => r.t === "exit" && r.pid === firstPid));
      assert.ok(gone.at >= down.at, "shutdown's start to the process's end: how long it took");
      await until("the next boot's record", () => records(log).find((r) => r.t === "boot" && r.pid === server.pid));
    } finally {
      await server.stop();
    }
  });
});
