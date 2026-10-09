// Run: pnpm test -- server/outreach-link.test.ts. §app.outreach/sender-link and /sender-list: linking
// and unlinking a phone from Settings → Outreach on the sender's own host, and the list of senders
// this host can use. The sender in-process (outreach/sender-test-fixtures.ts: its real state machine
// and IPC over a fake WhatsApp), unpaired at the start; a throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { agent, app, cleanup, json, project, root } from "./outreach-test-fixtures";
import { inProcessSender } from "./outreach/sender-test-fixtures";
import type { SenderLinkView, SenderStatus } from "../shared/outreach";

const { mountOutreachRelay } = await import("./outreach/relay");
const { resetLocalClient, setSenderClientOptionsForTest } = await import("./outreach/whatsapp");
const { listSenders } = await import("./outreach/senders");
const { OVERSEER_SENDER_HEADER } = await import("./overseer-sender");
const po = await import("./project-overseer");
const { senderAttention, senderReading } = await import("./outreach/health");

const sender = inProcessSender({ env: process.env, paired: false });
setSenderClientOptionsForTest({ connect: sender.connect, retryMs: 0 });

after(async () => {
  sender.stop();
  resetLocalClient();
  setSenderClientOptionsForTest({});
  await cleanup();
});

const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}, env?: unknown) =>
  app.request(`/api/outreach/sender/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env as never);
const view = async (): Promise<SenderLinkView> => (await json("GET", "/api/outreach/sender/link")).body as SenderLinkView;
/** Polls until `check` holds; the limit is only a hang guard. */
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!check(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
    v = await read();
  }
  assert.ok(check(v), JSON.stringify(v));
  return v;
}
const state = async () => ((await json("GET", "/api/outreach")).body.sender as SenderStatus).state;

/** Every file under a directory, for "the QR never reached the disk". */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile() && statSync(p).size < 4 * 1024 * 1024) out.push(p);
  }
  return out;
}

describe("§app.outreach/sender-link", () => {
  before(async () => {
    await json("PUT", "/api/outreach", { sender: { local: {} }, acceptFrom: ["nDESK"] });
    await until(state, (s) => s === "unpaired");
  });

  test("only the operator's own browser: 404 relayed or from a peer, 403 for the Overseer's call, which no tool makes", async () => {
    const routes: [string, string, unknown][] = [
      ["POST", "link", {}],
      ["GET", "link", undefined],
      ["POST", "link/cancel", {}],
      ["POST", "unlink", { confirm: "UNLINK" }],
    ];
    for (const [method, path, body] of routes) {
      const req = (headers: Record<string, string>, env?: unknown) =>
        app.request(`/api/outreach/sender/${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }, env as never);
      assert.equal((await req({ "X-Sova-Relayed": "1" })).status, 404, path);
      assert.equal((await req({}, { meshPeer: { id: "p" } })).status, 404, path);
      const o = await req({ [OVERSEER_SENDER_HEADER]: "anything" });
      assert.equal(o.status, 403, path);
    }
    assert.equal((await json("GET", "/api/outreach/senders")).status, 200);
    assert.equal((await app.request("/api/outreach/senders", { headers: { [OVERSEER_SENDER_HEADER]: "x" } })).status, 403);
    assert.equal((await app.request("/api/outreach/senders", { headers: { "X-Sova-Relayed": "1" } })).status, 404);
    const tools = [...po.toolsForTest(project.id)].map((t) => JSON.stringify(t));
    assert.ok(!tools.some((t) => /outreach\/sender|sender\/link|unlink/.test(t)), "no project overseer tool names them");
    for (const f of ["overseer-tools.ts", "overseer-org-tools.ts", "project-overseer-tools.ts"]) assert.doesNotMatch(readFileSync(join(import.meta.dirname, f), "utf8"), /outreach\/sender/, f);
    assert.equal((await view()).phase, "idle", "nothing started by any of them");
  });

  test("Link a Phone: each new QR replaces the last, then the phone links: Linked with the number's last digits; no QR is kept", async () => {
    const started = await post("link");
    assert.equal(started.status, 200);
    assert.equal(started.headers.get("cache-control"), "no-store");
    sender.qr("2@first-qr-secret");
    let v = await until(view, (x) => x.qr === "2@first-qr-secret");
    assert.equal(v.phase, "waiting");
    assert.equal(v.mode, "qr");
    sender.qr("2@second-qr-secret");
    v = await until(view, (x) => x.qr === "2@second-qr-secret");
    assert.equal(v.qrCount, 2);
    assert.equal((await post("link")).status, 409, "one link at a time");
    // Nothing else hands the QR out: not the page's info, not the list, not Needs you, not the health.
    for (const p of ["/api/outreach", "/api/outreach/senders"]) {
      const r = await app.request(p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(await r.text(), /qr-secret/, p);
    }
    assert.doesNotMatch(JSON.stringify([senderAttention(), senderReading("local")]), /qr-secret/);
    sender.scan();
    v = await until(view, (x) => x.phase === "linked");
    assert.equal(v.me, "…123");
    assert.equal(v.qr, undefined, "the QR is dropped when the link ends");
    await until(state, (s) => s === "open");
    const onDisk = filesUnder(root).filter((f) => readFileSync(f, "utf8").includes("qr-secret"));
    assert.deepEqual(onDisk, [], "never written to a file");
    assert.equal((await post("link")).status, 409, "a linked sender links nothing");
  });

  test("Unlink This Number needs UNLINK typed; it logs the device out and deletes its keys; a peer's relay never links or unlinks", async () => {
    assert.equal((await post("unlink", {})).status, 400);
    assert.equal((await post("unlink", { confirm: true })).status, 400);
    assert.equal((await post("unlink", { confirm: "unlink" })).status, 400);
    assert.equal(sender.isPaired(), true, "nothing unlinked yet");
    const relay = new Hono<{ Bindings: { meshPeer?: unknown } }>();
    const peers = [{ id: "desk", label: "Desk", nodeId: "nDESK", dnsName: "desk" }];
    mountOutreachRelay(relay as unknown as Hono, { requestPeer: (c) => ((c.env as { meshPeer?: any })?.meshPeer ?? null), peers: () => peers as any });
    for (const op of ["link", "unlink", "link/cancel"]) {
      const r = await relay.request(`/api/peer/outreach/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }, { meshPeer: peers[0] });
      assert.ok(r.status === 403 || r.status === 404, `${op}: ${r.status}`);
    }
    assert.equal(sender.isPaired(), true, "the relay unlinked nothing");
    const r = await post("unlink", { confirm: "UNLINK" });
    assert.equal(r.status, 200);
    const info = (await r.json()) as { sender: SenderStatus };
    assert.equal(info.sender.state, "unpaired");
    assert.match(info.sender.why ?? "", /logged out and its credentials are deleted/);
    assert.equal(sender.isPaired(), false);
    assert.equal((await view()).phase, "idle", "the old link's result is gone");
  });

  test("the QR expires: the sender's sentence ends it; Try Again starts a new one; Cancel ends one", async () => {
    await post("link");
    sender.qr("2@expiring");
    await until(view, (x) => x.qr === "2@expiring");
    sender.close(408);
    const v = await until(view, (x) => x.phase === "ended");
    assert.equal(v.why, "The QR code expired before the phone scanned it.");
    assert.equal(v.qr, undefined);
    assert.equal((await post("link")).status, 200, "Try Again");
    sender.qr("2@again");
    await until(view, (x) => x.qr === "2@again");
    const c = await post("link/cancel");
    assert.equal(c.status, 200);
    assert.equal(((await c.json()) as SenderLinkView).why, "Linking was cancelled.");
    await until(state, (s) => s === "unpaired");
    sender.qr("2@late");
    assert.equal((await view()).qr, undefined, "a QR after the cancel is never shown");
  });

  test("a pairing code: the number is checked first, the code shown, then linked; no QR", async () => {
    for (const phone of ["+15550001234", "123", "1555000123412345", "15550001234 "]) {
      const r = await post("link", { phone });
      assert.equal(r.status, 400, phone);
      assert.match(((await r.json()) as { error: string }).error, /7 to 15 digits/);
    }
    assert.equal((await post("link", { phone: 15550001234 })).status, 400);
    const r = await post("link", { phone: "15550001234" });
    assert.equal(r.status, 200);
    const v = (await r.json()) as SenderLinkView;
    assert.equal(v.mode, "code");
    assert.equal(v.code, "FAKE1234");
    assert.equal(v.phoneTail, "…234");
    assert.ok(!JSON.stringify(v).includes("15550001234"), "the number is never echoed");
    sender.qr("2@not-for-a-code");
    assert.equal((await view()).qr, undefined);
    sender.scan();
    const done = await until(view, (x) => x.phase === "linked");
    assert.equal(done.code, undefined);
    await until(state, (s) => s === "open");
  });

  test("a host sending through a peer, or off, links and unlinks nothing", async () => {
    await json("PUT", "/api/outreach", { sender: { via: { nodeId: "nGATE" } } });
    assert.equal((await post("link")).status, 409);
    assert.equal((await post("unlink", { confirm: "UNLINK" })).status, 409);
    await json("PUT", "/api/outreach", { sender: "off" });
    assert.equal((await post("link")).status, 409);
    assert.equal(sender.isPaired(), true);
    await json("PUT", "/api/outreach", { sender: { local: {} } });
  });
});

describe("§app.outreach/sender-list", () => {
  const open: SenderStatus = { state: "open", me: "…123", limits: { gapS: 3, perHour: 20, perDay: 60 }, usage: { hour: 1, day: 4 } };
  const io = (o: Partial<Parameters<typeof listSenders>[0] & object> = {}) => ({
    peers: () => [
      { nodeId: "nGATE", label: "Gateway" },
      { nodeId: "nDESK", label: "Desk" },
      { nodeId: "nPHONE", label: "Phone" },
    ],
    peerStatus: async (nodeId: string) => (nodeId === "nGATE" ? { status: { state: "open", me: "…777" } as SenderStatus } : { why: nodeId === "nDESK" ? "It doesn't accept sends from this host." : "It has no sender of its own." }),
    localStatus: async () => ({ state: "unreachable", why: "The sender is not running (no socket answers)." }) as SenderStatus,
    usedStatus: async () => open,
    ...o,
  });

  test("this host always, then each peer whose sender answers; each entry has its own id; the chosen one is marked", async () => {
    await json("PUT", "/api/outreach", { sender: { local: {} } });
    const list = await listSenders(io());
    assert.deepEqual(
      list.map((e) => [e.id, e.label, e.status.state, e.chosen]),
      [
        ["local", "This host", "open", true],
        ["peer:nGATE", "Gateway", "open", false],
      ],
    );
    assert.equal(list[0]!.status.usage?.day, 4);
    await json("PUT", "/api/outreach", { sender: "off" });
    const off = await listSenders(io());
    assert.equal(off[0]!.status.state, "unreachable", "this host is listed even with no sender running");
    assert.ok(off.every((e) => !e.chosen));
  });

  test("a chosen peer that no longer accepts this host is still listed, with why; one no longer a peer too", async () => {
    await json("PUT", "/api/outreach", { sender: { via: { nodeId: "nDESK" } } });
    const why: SenderStatus = { state: "unreachable", why: "The sender's host doesn't accept sends from this host (its Accept sends from)." };
    const list = await listSenders(io({ usedStatus: async () => why }));
    assert.deepEqual(list.find((e) => e.id === "peer:nDESK"), { id: "peer:nDESK", where: "peer", nodeId: "nDESK", label: "Desk", status: why, chosen: true });
    assert.equal(list.some((e) => e.id === "peer:nPHONE"), false);
    await json("PUT", "/api/outreach", { sender: { via: { nodeId: "nGONE" } } });
    const gone = await listSenders(io({ usedStatus: async () => why }));
    assert.equal(gone.at(-1)!.id, "peer:nGONE");
    assert.equal(gone.at(-1)!.chosen, true);
  });

  test("numbers added on this host follow This host, each its own id, socket and label; a label never holds a number", async () => {
    const r = await json("PUT", "/api/outreach", { sender: { number: { id: "sales" } }, numbers: [{ id: "sales", socket: "/tmp/sova-wa-sales.sock" }], labels: { local: "Office", "local:sales": "Sales" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await listSenders(io({ usedStatus: async (t) => ({ ...open, me: t.id === "local:sales" ? "…456" : "…123" }) }));
    assert.deepEqual(
      list.map((e) => [e.id, e.label, e.socket ?? null, e.status.me ?? null, e.chosen]),
      [
        ["local", "Office", null, null, false],
        ["local:sales", "Sales", "/tmp/sova-wa-sales.sock", "…456", true],
        ["peer:nGATE", "Gateway", null, "…777", false],
      ],
      "This host isn't in use (not the default, no organization picks it): it is probed, not read as used",
    );
    const bad = await json("PUT", "/api/outreach", { labels: { local: "+1 555 0100" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /phone number/);
    const gone = await json("PUT", "/api/outreach", { numbers: [] });
    assert.equal(gone.status, 400, "the default can't be removed");
    assert.equal((await json("PUT", "/api/outreach", { sender: { local: {} }, numbers: [], labels: {} })).status, 200);
  });

  test("the stored setting is the same shape it always was: an earlier file reads unchanged", async () => {
    await json("PUT", "/api/outreach", { sender: { local: {} } });
    const f = JSON.parse(readFileSync(join(agent, "sova", "outreach.json"), "utf8"));
    assert.deepEqual(f.sender, { local: {} });
    const r = await json("GET", "/api/outreach/senders");
    assert.equal(r.status, 200);
    assert.equal(r.body.senders[0].id, "local");
    assert.equal(r.body.senders[0].chosen, true);
  });
});
