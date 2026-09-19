import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresenceChannel } from "./presence.ts";
import type { IntercomExtensionEvent, SessionInfo } from "./intercom.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dir = () => mkdtempSync(join(tmpdir(), "pi-sessions-bus-"));
const info = (name: string) => () => ({ name, cwd: `/tmp/${name}`, model: "test-model", pid: process.pid, startedAt: 1, lastActivity: 1, status: "Idle" });
const presence = { type: "presence", version: 1, status: "Running", since: 1, completed: 2, preview: "p", workers: [] };

test("two channels discover each other, exchange presence and notes, and part cleanly", async () => {
  const d = dir();
  try {
    const aEvents: IntercomExtensionEvent[] = [];
    const bEvents: IntercomExtensionEvent[] = [];
    const a = createPresenceChannel({ dir: d, pollMs: 20, heartbeatMs: 40, info: info("alpha"), onEvent: e => aEvents.push(e) });
    const b = createPresenceChannel({ dir: d, pollMs: 20, heartbeatMs: 40, info: info("beta"), onEvent: e => bEvents.push(e) });
    await sleep(200);
    assert.ok(aEvents.some(e => e.type === "connection" && e.connected), "alpha reported connected");
    const aSaw = aEvents.find(e => e.type === "session_joined");
    const bSaw = bEvents.find(e => e.type === "session_joined");
    assert.ok(aSaw && bSaw, "mutual discovery without any broker");
    assert.equal(aSaw.type === "session_joined" ? aSaw.session.name : "", "beta");
    assert.equal((await b.listSessions()).length, 2, "roster = self + peer");

    bEvents.length = 0;
    a.publish(presence);
    await sleep(200);
    assert.ok(bEvents.some(e => e.type === "message" && (e.payload as { status?: string }).status === "Running"),
      "presence payload delivered to peer");

    bEvents.length = 0;
    await sleep(300);
    assert.ok(bEvents.some(e => e.type === "message" && (e.payload as { type?: string }).type === "presence"),
      "heartbeat rewrites redeliver sticky presence (keeps the 20s freshness window)");

    bEvents.length = 0;
    a.publish({ type: "visited", to: "x", from: "y" });
    await sleep(250);
    assert.ok(bEvents.some(e => e.type === "message" && (e.payload as { type?: string }).type === "visited"),
      "transient note delivered");
    assert.ok(bEvents.some(e => e.type === "message" && (e.payload as { type?: string }).type === "presence"),
      "note never displaces sticky presence");

    bEvents.length = 0;
    a.close();
    await sleep(300);
    assert.ok(bEvents.some(e => e.type === "session_left"), "clean close removes the file and peers notice");
    assert.equal((await b.listSessions()).length, 1, "only self remains");
    b.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("fresh record with a dead pid never joins and is unlinked", async () => {
  const d = dir();
  try {
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn("true", []);
      child.on("error", reject);
      child.on("exit", () => resolve(child.pid!));
    });
    const session: SessionInfo = { id: "ghost", cwd: "/tmp", model: "m", pid: deadPid, startedAt: 1, lastActivity: 1 };
    writeFileSync(join(d, "ghost.json"), JSON.stringify({ v: 1, session, heartbeat: Date.now() }));
    const events: IntercomExtensionEvent[] = [];
    const me = createPresenceChannel({ dir: d, pollMs: 20, info: info("me"), onEvent: e => events.push(e) });
    await sleep(150);
    assert.ok(!events.some(e => e.type === "session_joined"), "dead pid never joins");
    assert.equal(existsSync(join(d, "ghost.json")), false, "dead pid's file unlinked");
    assert.equal((await me.listSessions()).length, 1);
    me.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("malformed records are ignored without breaking the bus", async () => {
  const d = dir();
  try {
    writeFileSync(join(d, "junk.json"), "{not json");
    writeFileSync(join(d, "wrong.json"), JSON.stringify({ v: 2, heartbeat: Date.now() }));
    const events: IntercomExtensionEvent[] = [];
    const me = createPresenceChannel({ dir: d, pollMs: 20, info: info("me"), onEvent: e => events.push(e) });
    await sleep(150);
    assert.ok(me.snapshot().connected);
    assert.ok(!events.some(e => e.type === "session_joined"));
    me.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
