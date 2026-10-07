// Run: npx tsx --test server/llm-inflight.integration.test.ts
// Two hubs over real WebSockets on 127.0.0.1; the rest of the hub's tests (fake peer sockets,
// virtual time) are in llm-inflight.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { SessionFeedMessage } from "../shared/protocol";
import { LlmInflightHub, type LlmProcessSnapshot, type OwnCounter } from "./llm-inflight";

const snap = (over: Partial<LlmProcessSnapshot> = {}): LlmProcessSnapshot => ({ v: 1, producer: "own", pid: 100, active: 0, approximate: 0, claudeTurns: 0, degraded: false, ...over });

class FakeOwn implements OwnCounter {
  value = snap();
  private fns = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  };
  set(over: Partial<LlmProcessSnapshot>): void {
    this.value = snap({ ...this.value, ...over });
    for (const fn of this.fns) fn();
  }
}

const inflights = (msgs: SessionFeedMessage[]) => msgs.flatMap((m) => (m.type === "llm_inflight" ? [m.inflight] : []));
/** Poll until `ok` holds; the guard only stops a hang. */
async function until(ok: () => boolean, what: string, guardMs = 30_000): Promise<void> {
  const end = Date.now() + guardMs;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`still waiting after ${guardMs} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("two hosts over real sockets", () => {
  test("each counts the other once, both ways, and neither passes the other's count back", async () => {
    const { WebSocket, WebSocketServer } = await import("ws");
    const dirs = [mkdtempSync(join(tmpdir(), "llm-a-")), mkdtempSync(join(tmpdir(), "llm-b-"))];
    const owns = [new FakeOwn(), new FakeOwn()];
    owns[0]!.value = snap({ producer: "a", active: 1 });
    owns[1]!.value = snap({ producer: "b", active: 2 });
    const servers: InstanceType<typeof WebSocketServer>[] = [];
    const urls: string[] = [];
    const hubs: LlmInflightHub[] = [];
    for (let i = 0; i < 2; i++) {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise((r) => wss.once("listening", r));
      servers.push(wss);
      urls.push(`http://127.0.0.1:${(wss.address() as { port: number }).port}`);
    }
    for (let i = 0; i < 2; i++) {
      const other = urls[1 - i]!;
      hubs.push(
        new LlmInflightHub({
          own: owns[i]!,
          liveDir: dirs[i]!,
          sweepMs: 1000,
          mesh: { peers: () => [{ id: `h${1 - i}`, url: other }], selfId: () => `h${i}`, connect: (url) => new WebSocket(`${url.replace(/^http/, "ws")}/ws/watch?feed=llm`) },
        }),
      );
      servers[i]!.on("connection", (ws) => ws.on("close", hubs[i]!.addLocal((m) => ws.send(JSON.stringify(m)))));
    }
    try {
      const seen: SessionFeedMessage[][] = [[], []];
      hubs.forEach((h, i) => h.addBrowser((m) => seen[i]!.push(m)));
      const total = (i: number) => inflights(seen[i]!).at(-1);
      await until(() => !total(0)?.partial && !total(1)?.partial, "both peers answered");
      assert.deepEqual(total(0), { count: 3, approximate: 0, partial: false, gaps: [] });
      assert.deepEqual(total(1), { count: 3, approximate: 0, partial: false, gaps: [] });
      owns[1]!.set({ active: 4 });
      await until(() => total(0)!.count !== 3 && total(1)!.count !== 3, "b's change reached both");
      assert.equal(total(0)!.count, 5);
      assert.equal(total(1)!.count, 5, "b's own browser: a's 1 + b's 4, a never echoes b's");
    } finally {
      hubs.forEach((h) => h.stop());
      servers.forEach((s) => s.close());
      dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});
