// Run: node scripts/run-tests.mjs server/session-feed.integration.test.ts
// The change-driven session feed on a hermetic server (§app.decisions/push): a TUI session's live
// record changes only its status, and a connected feed hears list_changed within 6 s; the record
// asking for input reaches the feed as a pushed attention digest; nothing is pushed while nothing
// changes.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
let tui: ChildProcess;
before(async () => {
  s = await startHermeticServer();
  // A stand-in TUI: any live process, so its live record counts.
  tui = spawn("sleep", ["300"], { stdio: "ignore" });
});
after(async () => {
  tui?.kill();
  const changed = await s?.stop();
  assert.deepEqual(changed ?? [], [], "the sentinel home is untouched");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a live record's status alone reaches a connected feed as list_changed within 6 s; a dialog as an attention push", async () => {
  const dir = join(s.agentDir, "sessions", "--tui-work--");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, "2026-10-22T00-00-00-000Z_feedtest.jsonl");
  const id = "01234567-89ab-7cde-8f01-00000000fe01";
  writeFileSync(
    sessionFile,
    [
      { type: "session", version: 3, id, timestamp: "2026-10-22T00:00:00.000Z", cwd: s.work },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-10-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const liveDir = join(s.agentDir, "sessions", "live");
  mkdirSync(liveDir, { recursive: true });
  const live = join(liveDir, `${tui.pid}.json`);
  const writeLive = (presence: Record<string, unknown>) => {
    // As writers do: tmp + rename, a new inode per write.
    const tmp = join(liveDir, `.${tui.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ heartbeat: Date.now(), session: { pid: tui.pid, sessionFile, mode: "tui", status: "idle" }, presence }));
    renameSync(tmp, live);
  };
  writeLive({ status: "idle", activity: { state: "idle", since: 1 } });

  const sock = new WebSocket(`${s.base.replace(/^http/, "ws")}/ws/watch?feed=sessions`, { headers: { "x-sova-token": s.token } });
  const got: { m: any; t: number }[] = [];
  sock.on("message", (d) => got.push({ m: JSON.parse(String(d)), t: Date.now() }));
  await new Promise<void>((r, j) => (sock.once("open", () => r()), sock.once("error", j)));
  const until = async (pred: (m: any) => boolean, ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = got.find((x) => pred(x.m));
      if (hit) return hit;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  };
  try {
    assert.ok(await until((m) => m.type === "marks" && m.full, 30_000), `no snapshot; got ${JSON.stringify(got.map((x) => x.m.type))}\n${s.log().slice(-2000)}`);
    // The row is listed with its live record before the test changes anything.
    const listed = await (await fetch(`${s.base}/api/sessions`, { headers: { "x-sova-token": s.token } })).json();
    assert.ok(listed.some((r: any) => r.path === sessionFile && r.live), "the TUI session is listed live");

    // Heartbeats alone (the record rewritten, nothing it says changed) are no change.
    await sleep(1500);
    got.length = 0;
    for (let i = 0; i < 3; i++) {
      writeLive({ status: "idle", activity: { state: "idle", since: 1 } });
      await sleep(700);
    }
    assert.ok(!got.some((x) => x.m.type === "list_changed" || x.m.type === "attention"), `a heartbeat pushed ${JSON.stringify(got.map((x) => x.m.type))}`);

    // Only the status changes.
    const t0 = Date.now();
    writeLive({ status: "busy", activity: { state: "idle", since: 1 } });
    const changed = await until((m) => m.type === "list_changed", 6_000);
    assert.ok(changed, `no list_changed within 6 s; got ${JSON.stringify(got.map((x) => x.m.type))}\n${s.log().slice(-2000)}`);
    assert.ok(changed.t - t0 <= 6_000);

    // A dialog open in the TUI: the digest gains a Needs you item, pushed, no request made.
    got.length = 0;
    writeLive({ status: "busy", activity: { state: "needs-input", since: Date.now() } });
    const pushed = await until((m) => m.type === "attention" && m.digest.items.some((i: any) => i.path === sessionFile), 6_000);
    assert.ok(pushed, `no attention push; got ${JSON.stringify(got.map((x) => x.m.type))}`);
  } finally {
    sock.close();
  }
});
