// Run: pnpm test -- server/chat-runtime/own-pids.test.ts. A chat process a previous server left running
// never reads as a terminal holding its file (§app.chat-processes/survives-restart): its recorded pid
// is the server's own from the server's first moments (claimRecordedChats, before it listens), the
// supervisor takes the claim over at adoption, and lets go of it when the process turns out gone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-own-pids-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before live.ts computes its folder

const { LIVE_DIR } = await import("../paths");
const { addOwnPid, readLive } = await import("../live");
const { ChatSupervisor, claimRecordedChats } = await import("./supervisor");
const { FakeDriver } = await import("./fake-driver");

/** Another process that is alive (this test's parent) stands in for a chat process. */
const chatPid = process.ppid;
const sessionFile = join(agentDir, "sessions", "s1.jsonl");
const reg = join(agentDir, "registry");

function setup() {
  mkdirSync(LIVE_DIR, { recursive: true });
  writeFileSync(join(LIVE_DIR, `p${chatPid}-s1.json`), JSON.stringify({ session: { pid: chatPid, sessionFile, status: "idle" }, presence: { status: "idle" } }));
  mkdirSync(reg, { recursive: true });
  const rec = { chatId: "c1", sessionPath: sessionFile, cwd: "/w", unit: "sova-chat-own01-c1", pid: chatPid, sock: "/s/c1.sock", epoch: 1, startedAt: "t" };
  writeFileSync(join(reg, "c1.json"), JSON.stringify(rec));
  return rec;
}

const supervisor = (driver: InstanceType<typeof FakeDriver>) =>
  new ChatSupervisor({
    driver,
    epoch: 2,
    launch: () => ({ argv: [], env: {}, build: "b" }),
    ownPid: addOwnPid,
    registryDir: () => reg,
    deathsFile: () => join(agentDir, "deaths.jsonl"),
    unitPrefix: "sova-chat-own01-",
    log: () => {},
  });

test("a claimed chat whose unit turns out gone is let go at adoption", async () => {
  setup();
  claimRecordedChats(addOwnPid, () => reg, () => true);
  const sup = supervisor(new FakeDriver()); // no unit: the chat is gone
  await sup.adopt();
  assert.ok(readLive().has(sessionFile), "not ours any more: whatever holds the file now is someone else");
});

test("a recorded chat process is the server's own before adoption, and after it while it runs", async () => {
  const rec = setup();
  assert.ok(readLive().has(sessionFile), "before the claim it reads as a terminal");
  claimRecordedChats(addOwnPid, () => reg, (pid) => pid === chatPid);
  assert.ok(!readLive().has(sessionFile), "claimed at start: no terminal");
  const d = new FakeDriver();
  d.table.set(rec.unit, { spec: { unit: rec.unit, argv: [], cwd: "/", env: {} }, status: { state: "active", pid: chatPid }, logs: [] });
  const sup = supervisor(d);
  const { adopted } = await sup.adopt();
  assert.deepEqual(adopted.map((r) => r.chatId), ["c1"]);
  assert.ok(!readLive().has(sessionFile), "adopted: still the server's own");
  sup.detach();
  assert.ok(!readLive().has(sessionFile), "a stopping server keeps it as its own");
});
