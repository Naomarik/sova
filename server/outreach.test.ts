// Run: pnpm test -- server/outreach.test.ts. §app/outreach end to end with the WhatsApp sender
// in-process (outreach/sender-test-fixtures.ts: the sender's real state machine and IPC over a fake
// WhatsApp, reached through an in-memory stream): Send on WhatsApp through the baton statechart's act,
// the send log, receipts, the refusals, a sender that is down, the relay's gate, and the secret
// coverage. A throwaway PI_CODING_AGENT_DIR (outreach-test-fixtures.ts). The sender as a real child on
// its socket, a send's round trip, its going down and its restart: outreach.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { ABSENT, agent, ann, app, bob, cleanup, gathering, gone, json, logOf, org, project, root, senderOpen, sendLink } from "./outreach-test-fixtures";
import { inProcessSender } from "./outreach/sender-test-fixtures";

const { mountOutreachRelay } = await import("./outreach/relay");
const { resetLocalClient, setSenderClientOptionsForTest } = await import("./outreach/whatsapp");
const { liveLinks } = await import("./baton-links");
const { batonById } = await import("./baton");
const { SecretGuard } = await import("./overseer-deny");
const po = await import("./project-overseer");
const { hostOf } = await import("./org-engine");
const { listPreviews, mintPreview } = await import("./preview-links");

const sender = inProcessSender({ env: process.env, absent: [ABSENT] });
setSenderClientOptionsForTest({ connect: sender.connect, retryMs: 0 });
function stopSender(): void {
  sender.stop();
  resetLocalClient();
}

after(async () => {
  stopSender();
  setSenderClientOptionsForTest({});
  await cleanup();
});

test("the operator's browser behind a reverse proxy (X-Forwarded-Host) is served; the peer listener and a peer's relay get 404", async () => {
  assert.equal((await app.request("/api/outreach", { headers: { "X-Forwarded-Host": "host.example.ts.net:8443" } })).status, 200);
  assert.equal((await app.request("/api/outreach", { headers: { "X-Sova-Relayed": "1" } })).status, 404);
  assert.equal((await app.request("/api/outreach", {}, { meshPeer: { id: "p" } })).status, 404);
  const put = { method: "PUT", headers: { "Content-Type": "application/json", "X-Sova-Relayed": "1" }, body: JSON.stringify({ paused: true }) };
  assert.equal((await app.request("/api/outreach", put)).status, 404);
});

describe("§app.outreach/send-link", () => {
  before(() => {
    sender.start();
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
    await senderOpen();
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
    // the fake answers delivered then read, once let through
    sender.flushReceipts();
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
    const startLinks = liveLinks(sidG, ng).map((l) => l.hash);
    const rg = await sendLink(sidG);
    assert.equal(rg.body.outcome, "failed");
    assert.equal(rg.body.code, "not-on-whatsapp");
    assert.deepEqual(liveLinks(sidG, ng).map((l) => l.hash), startLinks, "the minted link was turned off; the older one still works");

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
    stopSender();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const before = liveLinks(sid, n).map((l) => l.hash);
    const r = await sendLink(sid);
    assert.equal(r.body.outcome, "failed");
    assert.equal(r.body.code, "unreachable");
    assert.equal(r.body.retryable, true);
    assert.deepEqual(liveLinks(sid, n).map((l) => l.hash), before, "nothing new stays minted; the older link is untouched");
    const info = await json("GET", "/api/outreach");
    assert.equal(info.body.sender.state, "unreachable");
  });
});

describe("§app.outreach/send: a note, a preview link, the project overseer through the hold", () => {
  before(async () => {
    sender.start();
    await json("PUT", "/api/outreach", { sender: { local: {} }, paused: false });
    await senderOpen();
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
    const { record } = mintPreview({ projectId: project.id, port: 5173, days: 3 }, new Set([4800]));
    const before = listPreviews({ projectId: project.id }).length;
    const r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: record.id }, note: "Here is the prototype." });
    assert.equal(r.body.outcome, "sent", JSON.stringify(r.body));
    const all = listPreviews({ projectId: project.id });
    assert.equal(all.length, before + 1, "a sibling preview was made for her");
    assert.ok(all.every((v) => v.state === "active"), "the original stays on");
    const line = logOf().filter((l) => l.personId === ann.id && l.event === "sent").at(-1)!;
    assert.equal(line.link, "preview");
    assert.ok(line.previewId && line.previewId !== record.id);
    const sib = listPreviews({ projectId: project.id }).find((v) => v.id === line.previewId)!;
    assert.equal(sib.siblingOf, record.id);
    assert.equal(sib.sentTo, ann.id);
    assert.equal(sib.expiresAt, record.expiresAt, "never outlives the original");
    assert.equal(sib.port, record.port);
    const { revokePreview } = await import("./preview-links");
    revokePreview(record.id);
    assert.equal(listPreviews({ projectId: project.id }).find((v) => v.id === sib.id)!.state, "off", "turned off with the original");
    const other = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: "pv_nope" } });
    assert.equal(other.status, 409);
  });

  test("the project overseer: sova_send_to_person waits in the hold, then goes once approved", async () => {
    await po.ensureProjectOverseer(project.id);
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 10 });
    const tool = po.toolsForTest(project.id).find((t) => t.name === "sova_send_to_person")!;
    const sid = await gathering(ann.id);
    const count = () => logOf().filter((l) => l.by === "project-overseer").length;
    const out = await tool.execute("t1", { person: "Ann", session: sid, note: "Your prototype is ready." } as never, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(out.content), /Held: the WhatsApp message to Ann waits until .* so the operator can cancel it/);
    assert.doesNotMatch(JSON.stringify(out.content), /share\.example|5550000100/);
    assert.equal(count(), 0, "nothing sent while held");
    const hold = hostOf(org.id).holds().find((h) => h.event === "outreach/send")!;
    assert.ok(hold, "held on the project statechart");
    await hostOf(org.id).act(`placement/${org.id}/${project.id}`, "hold/approve", { id: hold.id, reason: "test: send it now" }, { by: "operator", attended: true });
    const end = Date.now() + 8000;
    while (count() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const sent = logOf().filter((l) => l.by === "project-overseer");
    assert.equal(sent[0]?.event, "sent", JSON.stringify(sent));
    assert.equal(sent[0]?.sessionId, sid);
  });
});

describe("§app.outreach/links, /log, /send: a preview send's address, its codes, and a send that did not go after the hold", () => {
  const PIN = process.env.SOVA_SHARE_PREVIEW_URL!;
  const preview = (port: number) => mintPreview({ projectId: project.id, port, days: 3 }, new Set([4800])).record;
  const holdOf = () => {
    const h = hostOf(org.id).holds().find((x) => x.event === "outreach/send")!;
    assert.ok(h, "held on the project statechart");
    return `${h.sessionId}:${h.id}`;
  };
  const tool = (name: string) => po.toolsForTest(project.id).find((t) => t.name === name)!;
  const run = (name: string, args: Record<string, unknown>) => tool(name).execute("t", args as never, undefined, undefined, undefined as never);
  const lastBy = (by: string) => logOf().filter((l) => l.by === by).at(-1)!;

  before(async () => {
    sender.start(); // one sender at a time: the previous block's still runs
    await json("PUT", "/api/outreach", { sender: { local: {} }, paused: false });
    await senderOpen();
    await po.ensureProjectOverseer(project.id);
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 10 });
  });

  test("the address is read once, before the mint: it going blank during the mint's wait (a gateway comeback) still sends", async () => {
    const { onShareLinksChanged } = await import("./share/links-events");
    const record = preview(5174);
    // The live failure: a routed host's preview address reads as unset for a moment while its gateway states its
    // kinds again; the sibling's mint waits on the gateway, and a second reading after it found no address.
    const off = onShareLinksChanged((c) => {
      if (c.kind === "p" && c.cause === "mint") delete process.env.SOVA_SHARE_PREVIEW_URL;
    });
    let r: Awaited<ReturnType<typeof json>>;
    try {
      r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: record.id } });
    } finally {
      off();
      process.env.SOVA_SHARE_PREVIEW_URL = PIN;
    }
    assert.equal(r.body.outcome, "sent", JSON.stringify(r.body));
    const line = lastBy("operator");
    assert.equal(line.event, "sent");
    const sib = listPreviews({ projectId: project.id }).find((v) => v.id === line.previewId)!;
    assert.equal(sib.state, "active", "the sibling that went stays on");
    assert.equal(sib.createdBy, "operator", "the operator's own send");
  });

  test("no preview address: refused before anything is minted or held, code preview-address, naming the setting", async () => {
    const record = preview(5175);
    const before = listPreviews({ projectId: project.id }).length;
    delete process.env.SOVA_SHARE_PREVIEW_URL;
    try {
      const r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: record.id } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /Settings → Public links/);
      // The overseer's send is checked before the hold too: nothing waits that could only fail.
      await assert.rejects(run("sova_send_to_person", { person: "Ann", preview: record.id, note: "Have a look." }), /Settings → Public links/);
      assert.equal(hostOf(org.id).holds().filter((h) => h.event === "outreach/send").length, 0, "nothing held");
      // The effect's own re-check (a held send whose address went away) logs the precise code.
      const { send } = await import("./outreach/core");
      const s = await send({ orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "preview", preview: record.id }, by: "project-overseer", key: "k-addr" });
      assert.deepEqual([s.outcome, s.code], ["refused", "preview-address"]);
      assert.equal(lastBy("project-overseer").code, "preview-address");
    } finally {
      process.env.SOVA_SHARE_PREVIEW_URL = PIN;
    }
    assert.equal(listPreviews({ projectId: project.id }).length, before, "no sibling minted");
    const codes = logOf().filter((l) => l.event === "refused").map((l) => l.code);
    assert.ok(!codes.includes("link"), `no bare link code: ${codes.join(", ")}`);
  });

  test("held, then refused when it goes: sova_hold's approval, the feed, sova_pipeline and Needs you all say not sent", async () => {
    const { notSentAttention } = await import("./outreach/log");
    const { revokePreview } = await import("./preview-links");
    const record = preview(5176);
    const held = await run("sova_send_to_person", { person: "Ann", preview: record.id, note: "Here is the new build." });
    assert.match(JSON.stringify(held.content), /Held: the WhatsApp message to Ann/);
    const id = holdOf();
    revokePreview(record.id); // checked again when it goes: now turned off
    await assert.rejects(run("sova_hold", { op: "approve", id, reason: "test: go now" }), (err: Error) => {
      assert.equal(err.message, `Approved ${id}, but the WhatsApp message to Ann was not sent: That preview is turned off.`);
      return true;
    });
    const line = lastBy("project-overseer");
    assert.deepEqual([line.event, line.code, line.link], ["refused", "preview-off", "preview"]);
    const feed = hostOf(org.id).feed(project.id, { newestFirst: true });
    const entry = feed.find((f) => f.event === "outreach/not-sent");
    assert.equal(entry?.refused, "Not sent to Ann: That preview is turned off.", JSON.stringify(feed.slice(0, 3)));
    const pipeline = JSON.stringify((await run("sova_pipeline", {})).content);
    assert.match(pipeline, /outreach\/not-sent by overseer · refused: Not sent to Ann: That preview is turned off\./);
    const items = notSentAttention().filter((i) => i.id === `outreach-not-sent:${line.id}`);
    assert.equal(items.length, 1);
    assert.deepEqual(
      { tier: items[0]!.tier, kind: items[0]!.kind, detail: items[0]!.detail, href: items[0]!.href, org: items[0]!.org?.projectId },
      { tier: "act", kind: "outreach-not-sent", detail: "The WhatsApp message to Ann was not sent: the preview was turned off.", href: `#/orgs/${org.id}/people/${ann.id}`, org: project.id },
    );
    const text = readFileSync(join(root, "ws", "outreach.jsonl"), "utf8");
    assert.doesNotMatch(text, /5550000100|example\.com|https?:/, "no number or URL in the log");
    // A later send to her in this project that went answers it.
    const again = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, note: "Sorry, the link comes later." });
    assert.equal(again.body.outcome, "sent", JSON.stringify(again.body));
    assert.equal(notSentAttention().filter((i) => i.id === `outreach-not-sent:${line.id}`).length, 0);
  });

  test("a sibling an overseer's send makes records that overseer, never the operator", async () => {
    const { id: overseerId } = await po.ensureProjectOverseer(project.id);
    const record = preview(5177);
    await run("sova_send_to_person", { person: "Ann", preview: record.id });
    const out = await run("sova_hold", { op: "approve", id: holdOf(), reason: "test: go now" });
    assert.match(JSON.stringify(out.content), /Approved .*: it goes ahead now\./);
    const line = lastBy("project-overseer");
    assert.equal(line.event, "sent", JSON.stringify(line));
    const sib = listPreviews({ projectId: project.id }).find((v) => v.id === line.previewId)!;
    assert.equal(sib.siblingOf, record.id);
    assert.equal(sib.createdBy, `session:${overseerId}`);
  });

  test("the overseer sees its sends' delivery: sova_send_status on the real log and hold; a look notes each that did not go, once", async () => {
    const { markSendsNoted, sendsToNote } = await import("./outreach/log");
    // One more in the hold, so the status lists it as held.
    await run("sova_send_to_person", { person: "Ann", note: "One more thing soon." });
    const id = holdOf();
    sender.flushReceipts();
    const end = Date.now() + 8000;
    while (!logOf().some((l) => l.by === "project-overseer" && l.previewId && (l.event === "delivered" || l.event === "read")) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const status = JSON.stringify((await run("sova_send_status", { person: "Ann", limit: 50 })).content);
    assert.match(status, new RegExp(`${id.replace(/[/#]/g, (c) => `\\${c}`)} · Ann · a note · by you · held · goes at `));
    assert.match(status, /Ann · a preview link with a note · by you · refused \(preview-off: the preview was turned off\)/);
    assert.match(status, /Ann · a preview link · by you · (delivered|read) · at /, "the approved one arrived");
    assert.match(status, /Ann · a note · by the operator · (sent|delivered|read)/);
    assert.doesNotMatch(status, /5550000100|example\.com|https?:|One more thing|new build/, "never a number, a link or a note");
    // A look names each of its own sends that did not go, with the reason, and the next look doesn't repeat them.
    const look = po.lookAppendix(project.id);
    assert.match(look, /Your WhatsApp message to Ann did not go: the preview was turned off \(preview-off\)\./);
    assert.match(look, /Your WhatsApp message to Ann did not go: no preview address was available \(Settings → Public links\) \(preview-address\)\./);
    markSendsNoted(org.id, project.id, sendsToNote(org.id, project.id)); // what runLook does as it sends the look
    assert.doesNotMatch(po.lookAppendix(project.id), /did not go/);
    await run("sova_hold", { op: "cancel", id, reason: "test: done" });
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
