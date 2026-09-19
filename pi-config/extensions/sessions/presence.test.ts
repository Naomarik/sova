import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresenceChannel, type IntercomExtensionEvent } from "./presence.ts";
import type { SessionMeta } from "./schema.ts";

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
    const session: SessionMeta = { id: "ghost", cwd: "/tmp", model: "m", pid: deadPid, startedAt: 1, lastActivity: 1 };
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

const v1Session = (id: string, status = "Running: bash"): SessionMeta =>
  ({ id, name: "old-peer", cwd: "/tmp/old", model: "m", pid: process.pid, startedAt: 1, lastActivity: Date.now(), status });
const v1Presence = (status: string) => ({ type: "presence", version: 1, status, since: 5, completed: 7, preview: "legacy text", workers: [] });
const messages = (events: IntercomExtensionEvent[], from: string) =>
  events.filter((e): e is Extract<IntercomExtensionEvent, { type: "message" }> => e.type === "message" && e.fromSessionId === from);

test("a hand-written v1 record (no schemaVersion) is discovered with presence intact", async () => {
  const d = dir();
  try {
    writeFileSync(join(d, "legacy.json"), JSON.stringify({ v: 1, session: v1Session("legacy"), presence: v1Presence("Running: bash"), heartbeat: Date.now() }));
    const events: IntercomExtensionEvent[] = [];
    const me = createPresenceChannel({ dir: d, pollMs: 20, info: info("me"), onEvent: e => events.push(e) });
    await sleep(100);
    const joined = events.find(e => e.type === "session_joined");
    assert.ok(joined?.type === "session_joined" && joined.session.id === "legacy" && joined.legacy === true);
    const [msg] = messages(events, "legacy");
    assert.ok(msg, "presence delivered");
    assert.equal(msg.legacy, true);
    assert.equal((msg.payload as { status: string }).status, "Running: bash");
    assert.equal((msg.payload as { preview: string }).preview, "legacy text");
    assert.equal((await me.listSessions()).length, 2);
    me.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("mtime gating: changed payloads are delivered; heartbeat-only rewrites never re-emit presence_update", async () => {
  const d = dir();
  try {
    const file = join(d, "gated.json");
    const write = (status: string, heartbeat: number) =>
      writeFileSync(file, JSON.stringify({ v: 1, schemaVersion: 2, session: v1Session("gated", "Idle"), presence: v1Presence(status), heartbeat }));
    write("Idle", Date.now());
    const events: IntercomExtensionEvent[] = [];
    const me = createPresenceChannel({ dir: d, pollMs: 20, info: info("me"), onEvent: e => events.push(e) });
    await sleep(100);
    assert.equal(messages(events, "gated").length, 1, "unchanged file: presence delivered once, not every poll");
    assert.equal(messages(events, "gated")[0].legacy, false);

    events.length = 0;
    write("Idle", Date.now() + 1); // heartbeat-only rewrite
    await sleep(100);
    assert.ok(!events.some(e => e.type === "presence_update"), "heartbeat-only rewrite: no presence_update");
    assert.equal(messages(events, "gated").length, 1, "…but the sticky presence is redelivered (freshness)");

    events.length = 0;
    write("Running: read", Date.now() + 2);
    await sleep(100);
    assert.equal((messages(events, "gated").at(-1)?.payload as { status: string }).status, "Running: read", "flipped payload delivered");
    me.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("v2 records round-trip to a peer channel and stay within the byte budget", async () => {
  const d = dir();
  try {
    const bEvents: IntercomExtensionEvent[] = [];
    const a = createPresenceChannel({ dir: d, pollMs: 20, heartbeatMs: 40, budgetBytes: 4096, info: info("alpha"), onEvent: () => {} });
    const b = createPresenceChannel({ dir: d, pollMs: 20, heartbeatMs: 40, info: info("beta"), onEvent: e => bEvents.push(e) });
    const rich = { ...presence, preview: "x".repeat(1800),
      activity: { state: "working", since: 3, tools: ["read"], toolDetail: "read · a.ts", turns: 2, buckets: Array(16).fill(1), bucketMs: 15000 },
      workers: Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, name: "n".repeat(60), status: "done", outcome: "success" })) };
    a.publish(rich);
    await sleep(150);
    const files = readdirSync(d).filter(n => n.endsWith(".json"));
    for (const name of files) {
      const raw = readFileSync(join(d, name), "utf8");
      const record = JSON.parse(raw);
      assert.equal(record.schemaVersion, 2);
      if (record.session.name === "alpha") assert.ok(Buffer.byteLength(raw) <= 4096, "file never exceeds budgetBytes");
    }
    assert.equal(rich.workers.length, 30, "fit never mutates the caller's presence");
    const got = bEvents.filter(e => e.type === "message").at(-1);
    const p = got?.type === "message" ? got.payload as { activity?: { state: string; toolDetail?: string }; status: string } : undefined;
    assert.equal(p?.activity?.state, "working");
    assert.equal(p?.activity?.toolDetail, "read · a.ts");
    assert.equal(p?.status, "Running");
    assert.equal(got?.type === "message" ? got.legacy : undefined, false);
    a.close(); b.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
