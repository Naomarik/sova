// Run: pnpm test -- server/outreach-unit.test.ts. §app.outreach/sender-controls: Start Sender asks systemd
// about the sender's user unit, only offers it for the unit that serves Sova's socket while it is stopped,
// and starts it once. `systemctl --user` is a stand-in here: nothing is spawned.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseEnvironment, senderUnit, setSystemctlForTest, startSenderUnit, unitSocket } from "./outreach/unit";

const home = mkdtempSync(join(tmpdir(), "sova-unit-"));
after(() => {
  setSystemctlForTest(null);
  rmSync(home, { recursive: true, force: true });
});

test("the unit's environment is read as systemd prints it, quoted values included", () => {
  assert.deepEqual(parseEnvironment('SOVA_WA_HOME=/a/b PATH=/usr/bin X="two words" Y='), { SOVA_WA_HOME: "/a/b", PATH: "/usr/bin", X: "two words", Y: "" });
});

test("the unit's socket resolves as the sender resolves its own: env, then config.json, then the home's", () => {
  assert.equal(unitSocket({}, home), join(home, ".pi/agent/sova/whatsapp/sender.sock"));
  assert.equal(unitSocket({ PI_CODING_AGENT_DIR: "~/agent" }, home), join(home, "agent/sova/whatsapp/sender.sock"));
  assert.equal(unitSocket({ SOVA_WA_HOME: join(home, "wa") }, home), join(home, "wa/sender.sock"));
  assert.equal(unitSocket({ SOVA_WA_SOCKET: "/run/x.sock", SOVA_WA_HOME: join(home, "wa") }, home), "/run/x.sock");
  mkdirSync(join(home, "wa2"));
  writeFileSync(join(home, "wa2", "config.json"), JSON.stringify({ SOVA_WA_SOCKET: "/run/y.sock" }));
  assert.equal(unitSocket({ SOVA_WA_HOME: join(home, "wa2") }, home), "/run/y.sock");
});

test("Start is offered for the unit serving this socket while stopped, and runs systemctl start once; never for another socket or a running unit", async () => {
  const sock = join(home, "wa", "sender.sock");
  let active = "inactive";
  const calls: string[][] = [];
  setSystemctlForTest(async (args) => {
    calls.push(args);
    if (args[0] === "show") return { code: 0, stdout: `LoadState=loaded\nActiveState=${active}\nEnvironment=SOVA_WA_HOME=${join(home, "wa")}\n` };
    if (args[0] === "start") return (active = "active"), { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  });
  assert.deepEqual(await senderUnit(sock, undefined, 1), { name: "sova-whatsapp.service", active: "inactive" });
  assert.equal(await senderUnit(join(home, "other.sock"), undefined, 2), null, "a unit for another socket is not this sender's");
  assert.deepEqual(await startSenderUnit(sock), { ok: true });
  assert.deepEqual(calls.filter((c) => c[0] === "start"), [["start", "sova-whatsapp.service"]]);
  const again = await startSenderUnit(sock);
  assert.equal(again.ok, false, "running: never started again");
  assert.match((again as { why: string }).why, /is active/);
  assert.equal(calls.filter((c) => c[0] === "start").length, 1);
});

test("no systemd, no unit, or not loaded: nothing to offer", async () => {
  setSystemctlForTest(async () => ({ code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n" }));
  assert.equal(await senderUnit("/x.sock", undefined, 10), null);
  setSystemctlForTest(async () => ({ code: 1, stdout: "" }));
  assert.equal(await senderUnit("/x.sock", undefined, 20), null);
  setSystemctlForTest(async () => ({ code: 0, stdout: "LoadState=loaded\nActiveState=inactive\n" }), "darwin");
  assert.equal(await senderUnit("/x.sock", undefined, 30), null);
});

test("an added number's sender is its own template instance, sova-whatsapp@<name>.service, and Start starts that one", async () => {
  const sock = join(home, "wa-sales", "sender.sock");
  const calls: string[][] = [];
  setSystemctlForTest(async (args) => {
    calls.push(args);
    if (args[0] === "show" && args[1] === "sova-whatsapp@sales.service") return { code: 0, stdout: `LoadState=loaded\nActiveState=failed\nEnvironment=SOVA_WA_HOME=${join(home, "wa-sales")}\n` };
    if (args[0] === "show") return { code: 0, stdout: `LoadState=loaded\nActiveState=inactive\nEnvironment=SOVA_WA_HOME=${join(home, "wa")}\n` };
    if (args[0] === "start") return { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  });
  assert.deepEqual(await senderUnit(sock, "sales", 100), { name: "sova-whatsapp@sales.service", active: "failed" });
  assert.equal(await senderUnit(sock, undefined, 200), null, "this host's own unit serves another socket");
  assert.deepEqual(await startSenderUnit(sock, "sales"), { ok: true });
  assert.deepEqual(calls.filter((c) => c[0] === "start"), [["start", "sova-whatsapp@sales.service"]]);
});
