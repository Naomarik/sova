// Run: pnpm exec tsx --test server/outreach.test.ts. §app/outreach end to end against the fake
// WhatsApp sender (scripts/fake-whatsapp-sender.mjs, the sender's real state machine over a fake
// WhatsApp): Send on WhatsApp through the baton chart's act, the send log, receipts, the refusals,
// a sender that is down, the relay's gate, and the secret coverage. A throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-outreach-")));
const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.SOVA_WA_SOCKET;
delete process.env.SOVA_WA_HOME;
process.env.SOVA_SHARE_PUBLIC_URL = "https://share.example.com";
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.com";
mkdirSync(join(agent, "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { registerOrgRoutes } = await import("./org-routes");
const { mountOutreach } = await import("./outreach/routes");
const { mountOutreachRelay } = await import("./outreach/relay");
const { readSendLog } = await import("./outreach/log");
const { resetLocalClient } = await import("./outreach/whatsapp");
const { liveLinks } = await import("./baton-links");
const { batonById } = await import("./baton");
const { SecretGuard } = await import("./overseer-deny");
const { disposeAllChats } = await import("./chat-manager");
const po = await import("./project-overseer");
const { hostOf } = await import("./org-engine");
const { listPreviews, mintPreview } = await import("./preview-links");

const socket = join(agent, "sova", "whatsapp", "sender.sock");
let fake: ChildProcess | null = null;
async function startFake(): Promise<void> {
  fake = spawn(process.execPath, [join(import.meta.dirname, "..", "scripts", "fake-whatsapp-sender.mjs")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_WA_FAKE_ABSENT: "15550000999" },
    stdio: "ignore",
  });
  const end = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (Date.now() > end) throw new Error("the fake sender didn't start");
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));
}
async function stopFake(): Promise<void> {
  if (!fake) return;
  const f = fake;
  fake = null;
  if (f.exitCode === null && f.signalCode === null) {
    const gone = new Promise((r) => f.once("exit", r));
    f.kill("SIGTERM");
    const t = setTimeout(() => f.kill("SIGKILL"), 2000);
    await gone;
    clearTimeout(t);
  }
  rmSync(socket, { force: true });
  resetLocalClient();
}

after(async () => {
  await stopFake();
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});
process.on("exit", () => {
  fake?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const ann = await orgs.addPerson(org.id, { name: "Ann", role: "Staff", contact: { whatsapp: "+1 555 000 0100" } });
const bob = await orgs.addPerson(org.id, { name: "Bob", role: "Staff" });
const gone = await orgs.addPerson(org.id, { name: "Gil", role: "Staff", contact: { whatsapp: "+1 555 000 0999" } });

const app = new Hono();
registerOrgRoutes(app);
mountOutreach(app);
const req = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const json = async (method: string, path: string, body?: unknown) => {
  const r = await req(method, path, body);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

async function gathering(to: string): Promise<string> {
  const r = await json("POST", "/api/baton", { orgId: org.id, projectId: project.id, to, publicTitle: "Office hours", goal: "g" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.sessionId as string;
}
const sendLink = (sid: string, person?: string) => json("POST", `/api/baton/${sid}/send-link`, person ? { person } : {});
const logOf = () => readSendLog(org.id);

describe("§app.outreach/send-link", () => {
  before(async () => {
    await startFake();
  });

  test("off: refused with its sentence, nothing minted, nothing sent", async () => {
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const before = liveLinks(sid, n).length;
    const r = await sendLink(sid);
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "refused");
    assert.equal(r.body.code, "off");
    assert.match(r.body.why, /Settings → Outreach/);
    assert.equal(liveLinks(sid, n).length, before, "no link minted");
    assert.equal(logOf().at(-1)!.event, "refused");
  });

  test("sent: a fresh link replaces the older ones, the log holds no number, token or text; receipts follow", async () => {
    assert.equal((await json("PUT", "/api/outreach", { sender: { local: {} } })).status, 200);
    let info = await json("GET", "/api/outreach");
    for (let i = 0; i < 50 && info.body.sender.state !== "open"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      info = await json("GET", "/api/outreach");
    }
    assert.equal(info.body.sender.state, "open", JSON.stringify(info.body.sender));
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const firstLinks = liveLinks(sid, n).map((l) => l.hash);
    const r = await sendLink(sid);
    assert.deepEqual(r.body, { outcome: "sent", channel: "whatsapp", name: "Ann" });
    const now = liveLinks(sid, n);
    assert.equal(now.length, 1, "one live link: the one sent");
    assert.ok(!firstLinks.includes(now[0]!.hash), "the start's link was turned off");
    const log = readFileSync(join(root, "ws", "outreach.jsonl"), "utf8");
    assert.doesNotMatch(log, /5550000100|share\.example\.com|\/h\/|asked you/);
    const sent = logOf().filter((l) => l.sessionId === sid);
    assert.deepEqual(sent.map((l) => l.event), ["sent"]);
    assert.equal(sent[0]!.by, "operator");
    // the fake answers delivered then read
    const end = Date.now() + 8000;
    while (logOf().filter((l) => l.sessionId === sid).length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(logOf().filter((l) => l.sessionId === sid).map((l) => l.event), ["sent", "delivered", "read"]);
    // the person page lists it
    const page = await json("GET", `/api/orgs/${org.id}/people/${ann.id}`);
    assert.equal(page.body.sends?.[0]?.event, "read");
    assert.equal(page.body.sends?.[0]?.what, "Office hours");
  });

  test("no WhatsApp number, not on WhatsApp, paused: refused or failed, and the send-link wait comes back", async () => {
    const sidB = await gathering(bob.id);
    const rb = await sendLink(sidB);
    assert.equal(rb.body.code, "no-number");
    assert.equal(rb.body.why, "Bob has no WhatsApp number on the roster.");

    const sidG = await gathering(gone.id);
    const ng = batonById(sidG)!.row.handoffs.at(-1)!.n;
    const rg = await sendLink(sidG);
    assert.equal(rg.body.outcome, "failed");
    assert.equal(rg.body.code, "not-on-whatsapp");
    assert.equal(liveLinks(sidG, ng).length, 0, "the minted link was turned off: Needs you asks again");

    await json("PUT", "/api/outreach", { paused: true });
    const rp = await sendLink(await gathering(ann.id));
    assert.equal(rp.body.code, "paused");
    await json("PUT", "/api/outreach", { paused: false });
  });

  test("a guard refuses: the operator holds it, a person who isn't the holder", async () => {
    const sid = await gathering("operator");
    const r = await sendLink(sid);
    assert.equal(r.status, 409);
    const sid2 = await gathering(ann.id);
    const r2 = await sendLink(sid2, bob.id);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, "Bob does not hold the baton, so there is no link to send.");
  });

  test("the sender is down: failed, retryable, with why; nothing stays minted", async () => {
    await stopFake();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const r = await sendLink(sid);
    assert.equal(r.body.outcome, "failed");
    assert.equal(r.body.code, "unreachable");
    assert.equal(r.body.retryable, true);
    assert.equal(liveLinks(sid, n).length, 0);
    const info = await json("GET", "/api/outreach");
    assert.equal(info.body.sender.state, "unreachable");
  });
});

describe("§app.outreach/send: a note, a preview link, the project overseer through the hold", () => {
  before(async () => {
    await startFake();
    await json("PUT", "/api/outreach", { sender: { local: {} }, paused: false });
    for (let i = 0; i < 50 && (await json("GET", "/api/outreach")).body.sender.state !== "open"; i++) await new Promise((r) => setTimeout(r, 200));
  });

  test("a note alone; a note that repeats a contact is refused", async () => {
    const r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, note: "The prototype is ready to try." });
    assert.equal(r.body.outcome, "sent", JSON.stringify(r.body));
    const line = logOf().filter((l) => l.personId === ann.id).at(-1)!;
    assert.equal(line.note, true);
    assert.equal(line.link, undefined);
    assert.doesNotMatch(readFileSync(join(root, "ws", "outreach.jsonl"), "utf8"), /prototype is ready/, "the note's text is never logged");
    const leak = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, note: "Call Bob at +1 555 000 0999" });
    assert.equal(leak.status, 409);
    assert.match(leak.body.error, /repeats private text/);
  });

  test("a preview link: the person gets their own link to the same preview; the one named stays", async () => {
    const { record } = mintPreview({ orgId: org.id, projectId: project.id, port: 5173, days: 3 }, new Set([4800]));
    const before = listPreviews({ orgId: org.id }).length;
    const r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: record.id }, note: "Here is the prototype." });
    assert.equal(r.body.outcome, "sent", JSON.stringify(r.body));
    const all = listPreviews({ orgId: org.id });
    assert.equal(all.length, before + 1, "a sibling preview was made for her");
    assert.ok(all.every((v) => v.state === "active"), "the original stays on");
    const line = logOf().filter((l) => l.personId === ann.id && l.event === "sent").at(-1)!;
    assert.equal(line.link, "preview");
    assert.ok(line.previewId && line.previewId !== record.id);
    const sib = listPreviews({ orgId: org.id }).find((v) => v.id === line.previewId)!;
    assert.equal(sib.siblingOf, record.id);
    assert.equal(sib.sentTo, ann.id);
    assert.equal(sib.expiresAt, record.expiresAt, "never outlives the original");
    assert.equal(sib.port, record.port);
    const { revokePreview } = await import("./preview-links");
    revokePreview(record.id);
    assert.equal(listPreviews({ orgId: org.id }).find((v) => v.id === sib.id)!.state, "off", "turned off with the original");
    const other = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: "pv_nope" } });
    assert.equal(other.status, 409);
  });

  test("the project overseer: sova_send_to_person waits in the hold, then goes once approved", async () => {
    await po.ensureProjectOverseer(org.id, project.id);
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L1", holdMin: 10 });
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_send_to_person")!;
    const sid = await gathering(ann.id);
    const count = () => logOf().filter((l) => l.by === "project-overseer").length;
    const out = await tool.execute("t1", { person: "Ann", session: sid, note: "Your prototype is ready." } as never, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(out.content), /Held: the WhatsApp message to Ann waits until .* so the operator can cancel it/);
    assert.doesNotMatch(JSON.stringify(out.content), /share\.example|5550000100/);
    assert.equal(count(), 0, "nothing sent while held");
    const hold = hostOf(org.id).holds().find((h) => h.event === "outreach/send")!;
    assert.ok(hold, "held on the project chart");
    await hostOf(org.id).act(`project/${org.id}/${project.id}`, "hold/approve", { id: hold.id, reason: "test: send it now" }, { by: "operator", attended: true });
    const end = Date.now() + 8000;
    while (count() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const sent = logOf().filter((l) => l.by === "project-overseer");
    assert.equal(sent[0]?.event, "sent", JSON.stringify(sent));
    assert.equal(sent[0]?.sessionId, sid);
  });
});

describe("§app.outreach/sender-route", () => {
  test("outreach.json is strict and 0600", async () => {
    const bad = await json("PUT", "/api/outreach", { sender: { via: {} } });
    assert.equal(bad.status, 400);
    assert.equal((await json("PUT", "/api/outreach", { what: 1 })).status, 400);
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(agent, "sova", "outreach.json")).mode & 0o777, 0o600);
  });

  test("the relay answers only a peer its acceptFrom lists, never the operator ops", async () => {
    const relay = new Hono<{ Bindings: { meshPeer?: unknown } }>();
    const peers = [{ id: "desk", label: "Desk", nodeId: "nDESK", dnsName: "desk" }];
    mountOutreachRelay(relay as unknown as Hono, { requestPeer: (c) => ((c.env as { meshPeer?: any })?.meshPeer ?? null), peers: () => peers as any });
    const call = (op: string, peer: unknown, body: unknown = {}) =>
      relay.request(`/api/peer/outreach/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { meshPeer: peer });
    assert.equal((await call("status", null)).status, 404, "not a peer");
    await json("PUT", "/api/outreach", { sender: { local: {} }, acceptFrom: [] });
    assert.equal((await call("status", peers[0])).status, 403, "not accepted");
    await json("PUT", "/api/outreach", { acceptFrom: ["nDESK"] });
    assert.equal((await call("unlink", peers[0], { confirm: true })).status, 403, "operator ops refused");
    const ev = await call("events", peers[0], { since: 0 });
    assert.equal(ev.status, 200);
    assert.deepEqual((await ev.json()).events, [], "no receipts of another caller's sends");
  });
});

describe("§app.outreach/secrets", () => {
  test("the sender's home, pi's default one, a configured auth dir and outreach.json are denied", async () => {
    const custom = join(root, "elsewhere", "auth");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "creds.json"), "{}");
    await json("PUT", "/api/outreach", { authDir: custom });
    const g = new SecretGuard();
    for (const p of [join(agent, "sova", "whatsapp", "auth", "creds.json"), join(custom, "creds.json"), join(agent, "sova", "outreach.json")]) assert.ok(g.isSecret(p), p);
    const info = await json("GET", "/api/outreach");
    assert.ok(info.body.protected.includes(custom));
  });
});
