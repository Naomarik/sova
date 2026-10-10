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
import { ABSENT, agent, ann, app, bob, cleanup, gathering, gone, json, logOf, noSystemd, org, project, root, senderOpen, sendLink } from "./outreach-test-fixtures";
import { inProcessSender } from "./outreach/sender-test-fixtures";
import type { Channel, ChannelSend } from "./outreach/types";

const { mountOutreachRelay } = await import("./outreach/relay");
const { resetLocalClient, setSenderClientOptionsForTest } = await import("./outreach/whatsapp");
const { liveLinks } = await import("./baton-links");
const { dropTokens, tokenFor } = await import("./link-tokens");
const { RESOLVERS } = await import("./outreach/links");
const { batonById, keepLink } = await import("./baton");
const { send } = await import("./outreach/core");
const { SecretGuard } = await import("./overseer-deny");
const po = await import("./project-overseer");
const { hostOf } = await import("./org-engine");
const { listPreviews, mintPreview } = await import("./preview-links");
const { OVERSEER_SENDER_HEADER } = await import("./overseer-sender");

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

  test("sent, with no kept link (one made before tokens were kept): a fresh link replaces the older ones, the log holds no number, token or text; receipts follow", async () => {
    assert.equal((await json("PUT", "/api/outreach", { sender: { local: {} } })).status, 200);
    await senderOpen();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const firstLinks = liveLinks(sid, n).map((l) => l.hash);
    dropTokens(firstLinks);
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

  test("sent, with a kept live link: that link goes, nothing is minted or turned off; a failed send of it turns nothing off", async () => {
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const first = liveLinks(sid, n);
    assert.equal(first.length, 1);
    const token = tokenFor(first[0]!.hash, "h");
    assert.ok(token, "control: the start's link is kept");
    // The resolver itself: the kept link's URL, and nothing made (so neither revoke nor settle touches it).
    const resolved = await RESOLVERS.handoff.resolve({ orgId: org.id, projectId: project.id, personId: ann.id, key: "k-test" }, { kind: "handoff", session: sid });
    assert.ok(resolved.url.endsWith(`/h/${token}`), resolved.url);
    assert.deepEqual(resolved.minted, {});
    const r = await sendLink(sid);
    assert.equal(r.body.outcome, "sent");
    assert.deepEqual(liveLinks(sid, n).map((l) => l.hash), [first[0]!.hash], "the same one link, still live");
    assert.equal(tokenFor(first[0]!.hash, "h"), token, "and still kept");

    const sidG = await gathering(gone.id);
    const ng = batonById(sidG)!.row.handoffs.at(-1)!.n;
    const startG = liveLinks(sidG, ng).map((l) => l.hash);
    assert.equal(startG.length, 1);
    const rg = await sendLink(sidG);
    assert.equal(rg.body.outcome, "failed");
    assert.deepEqual(liveLinks(sidG, ng).map((l) => l.hash), startG, "a failed send of a kept link turns nothing off");
    assert.ok(tokenFor(startG[0]!, "h"), "it stays kept");
  });

  // Send A of a fresh gathering: it mints its link (kept at once, the start's token dropped so nothing
  // is reused) and hangs at the channel until `fail` lets it go.
  async function inFlight(key: string) {
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    dropTokens(liveLinks(sid, n).map((l) => l.hash));
    let let_go: ((r: ChannelSend) => void) | undefined;
    const hanging: Channel = { id: "whatsapp", status: async () => ({ state: "open" }) as never, onReceipt: () => {}, send: () => new Promise<ChannelSend>((res) => (let_go = res)) };
    const input = { orgId: org.id, projectId: project.id, personId: ann.id, link: { kind: "handoff" as const, session: sid }, by: "operator" as const };
    const a = send({ ...input, key }, hanging);
    while (!let_go) await new Promise((r) => setTimeout(r, 5));
    const tokenA = tokenFor(liveLinks(sid, n).find((l) => l.key === key)!.hash, "h");
    assert.ok(tokenA, "control: A's link is kept while A is in flight");
    const fail = async () => {
      let_go!({ ok: false, code: "not-on-whatsapp", retryable: false, why: "no" });
      assert.equal((await a).outcome, "failed");
    };
    const liveTokens = () => liveLinks(sid, n).map((l) => tokenFor(l.hash, "h"));
    return { sid, input, tokenA, fail, liveTokens };
  }

  test("a link minted by a send still in flight is not reused by another send: A failing after B went leaves B's link live", async () => {
    const A = await inFlight("k-flight-a");
    const texts: string[] = [];
    const delivering: Channel = { id: "whatsapp", status: async () => ({ state: "open" }) as never, onReceipt: () => {}, send: async ({ text }) => (texts.push(text), { ok: true, ref: "ref-b", at: new Date().toISOString() }) };
    const b = await send({ ...A.input, key: "k-flight-b" }, delivering);
    assert.equal(b.outcome, "sent");
    const tokenB = /\/h\/([\w-]+)/.exec(texts[0]!)![1]!;
    assert.notEqual(tokenB, A.tokenA, "B made its own link");
    await A.fail();
    assert.ok(A.liveTokens().includes(tokenB), "the link B delivered is still live after A failed");
  });

  test("Get Link kept (keep=1) does not give the link of a send still in flight: A failing leaves the link it gave live", async () => {
    const A = await inFlight("k-flight-c");
    const got = keepLink(A.sid).token;
    assert.notEqual(got, A.tokenA, "keep=1 skips the link of an unsettled send");
    await A.fail();
    assert.ok(A.liveTokens().includes(got), "the link Get Link gave is still live after A failed");
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

  test("the sender is not running: refused at once, WhatsApp is down with why; nothing minted", async () => {
    stopSender();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const before = liveLinks(sid, n).map((l) => l.hash);
    const r = await sendLink(sid);
    assert.equal(r.body.outcome, "refused");
    assert.equal(r.body.code, "sender-down");
    assert.equal(r.body.why, "WhatsApp is down: The sender is not running (no socket answers).");
    assert.deepEqual(liveLinks(sid, n).map((l) => l.hash), before, "nothing new minted; the older link is untouched");
    assert.deepEqual([logOf().at(-1)!.event, logOf().at(-1)!.code], ["refused", "sender-down"]);
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

describe("§app.outreach/sender-controls, /sender-health: the operator's own controls, Needs you, and an honest strip", () => {
  const post = (op: string, body: unknown = {}, headers: Record<string, string> = {}, env?: unknown) =>
    app.request(`/api/outreach/sender/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env as never);
  const strip = async (sid: string) => (await json("GET", `/api/baton/${sid}/outreach`)).body.people as { id: string; ready: boolean; why?: string; code?: string }[];

  before(async () => {
    sender.start();
    await json("PUT", "/api/outreach", { sender: { local: {} }, paused: false, acceptFrom: ["nDESK"] });
    await senderOpen();
  });

  test("only the operator's own browser: 404 relayed or from a peer, 403 for the Overseer's in-process call, which no tool makes", async () => {
    for (const op of ["reconnect", "pause", "start"]) {
      assert.equal((await post(op, { on: true }, { "X-Sova-Relayed": "1" })).status, 404, op);
      assert.equal((await post(op, { on: true }, {}, { meshPeer: { id: "p" } })).status, 404, op);
      const o = await post(op, { on: true }, { [OVERSEER_SENDER_HEADER]: "anything" });
      assert.equal(o.status, 403, op);
      assert.match(((await o.json()) as { error: string }).error, /Only the operator controls the WhatsApp sender/);
    }
    const tools = [...po.toolsForTest(project.id)].map((t) => JSON.stringify(t));
    assert.ok(!tools.some((t) => /outreach\/sender/.test(t)), "no project overseer tool names the controls");
    const { readFileSync } = await import("node:fs");
    for (const f of ["overseer-tools.ts", "overseer-org-tools.ts", "project-overseer-tools.ts"]) assert.doesNotMatch(readFileSync(join(import.meta.dirname, f), "utf8"), /outreach\/sender/, f);
  });

  test("replaced: the strip says WhatsApp is down before any send, a send is refused at once, Needs you says so; Reconnect Now brings it back", async () => {
    const { senderAttention } = await import("./outreach/health");
    const sid = await gathering(ann.id);
    sender.close(440);
    const people = await strip(sid);
    assert.deepEqual(people.map((p) => [p.ready, p.code, p.why]), [[false, "sender-down", "WhatsApp is down: Another process opened these credentials (440)."]]);
    const t0 = Date.now();
    const r = await sendLink(sid);
    assert.deepEqual([r.body.outcome, r.body.code], ["refused", "sender-down"]);
    assert.ok(Date.now() - t0 < 5000, "never the sender's 15 s wait");
    const items = senderAttention();
    assert.deepEqual(items.map((i) => [i.kind, i.tier, i.detail, i.href]), [["whatsapp-down", "act", "WhatsApp sending is down for This host: Another process opened these credentials (440).", "#/settings/outreach"]]);
    const rc = await post("reconnect");
    assert.equal(rc.status, 200, await rc.clone().text());
    await senderOpen();
    assert.deepEqual(senderAttention(), [], "it clears once the sender is open");
    assert.deepEqual((await strip(sid)).map((p) => p.ready), [true]);
    // Already open: the sender's own refusal, as a 409 with its sentence.
    const again = await post("reconnect");
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "Already connected.");
  });

  test("Pause Sender pauses the sender itself (every host's sends), apart from this host's switch; the strip says why; Resume Sender undoes it", async () => {
    assert.equal((await post("pause", {})).status, 400);
    const p = await post("pause", { on: true });
    assert.equal(p.status, 200);
    assert.equal(((await p.json()) as { sender: { paused: boolean }; file: { paused: boolean } }).sender.paused, true);
    assert.equal((await json("GET", "/api/outreach")).body.file.paused, false, "this host's own switch is untouched");
    const sid = await gathering(ann.id);
    assert.deepEqual((await strip(sid)).map((x) => [x.code, x.why]), [["sender-paused", "WhatsApp sending is paused on the sender's host."]]);
    const r = await post("pause", { on: false });
    assert.equal(((await r.json()) as { sender: { paused: boolean } }).sender.paused, false);
    assert.deepEqual((await strip(sid)).map((x) => x.ready), [true]);
  });

  test("a project overseer's held message due while WhatsApp is down waits in the hold for WhatsApp (at most 24 h), and goes when it is back", async () => {
    const { heldActs, heldAttention } = await import("./project-holds");
    const { setOrgClockForTest } = await import("./org-engine");
    await po.ensureProjectOverseer(project.id);
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 10 });
    const tool = (name: string) => po.toolsForTest(project.id).find((t) => t.name === name)!;
    const run = (name: string, args: Record<string, unknown>) => tool(name).execute("t", args as never, undefined, undefined, undefined as never);
    const mine = () => logOf().filter((l) => l.by === "project-overseer");
    const outage = () => hostOf(org.id).holds().filter((h) => h.event === "outreach/send" && h.wait === "outage");
    const ref = () => {
      const h = hostOf(org.id).holds().find((x) => x.event === "outreach/send")!;
      return `${h.sessionId}:${h.id}`;
    };
    const before = mine().length;
    await run("sova_send_to_person", { person: "Ann", note: "Your prototype is ready." });
    sender.close(440);
    await senderSettled("replaced");
    const approved = JSON.stringify((await run("sova_hold", { op: "approve", id: ref(), reason: "test: go now" })).content);
    assert.match(approved, /but WhatsApp is down: the message waits for WhatsApp to come back, at most until /);
    assert.equal(mine().length, before, "nothing sent, nothing refused");
    const [w] = outage();
    assert.ok(w, "it waits in the project's hold");
    assert.ok(Math.abs(w.until - (Date.now() + 24 * 3_600_000)) < 60_000, "a day from its first wait");
    const listed = heldActs(project.id).find((h) => h.wait === "outage");
    assert.equal(listed?.what, "A WhatsApp message to Ann");
    assert.match(heldAttention().find((i) => i.held?.wait === "outage")?.detail ?? "", /^A WhatsApp message to Ann waits for WhatsApp to come back: it goes when WhatsApp is back/);
    // Back up: it goes on its own.
    assert.equal((await post("reconnect")).status, 200);
    await senderOpen();
    const end = Date.now() + 8000;
    while (mine().length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(mine().slice(before).map((l) => l.event), ["sent"]);
    assert.deepEqual(outage(), []);

    // Still down a day after its first wait: it goes ahead, is refused sender-down, and its project's Needs you says so.
    await run("sova_send_to_person", { person: "Ann", note: "Second note." });
    sender.close(440);
    await senderSettled("replaced");
    await run("sova_hold", { op: "approve", id: ref(), reason: "test: go now" });
    const bound = outage()[0]!.until;
    setOrgClockForTest(() => bound + 1);
    try {
      hostOf(org.id).fireDue();
      const end2 = Date.now() + 8000;
      while (mine().length === before + 1 && Date.now() < end2) await new Promise((r) => setTimeout(r, 50));
    } finally {
      setOrgClockForTest(null);
    }
    const last = mine().at(-1)!;
    assert.deepEqual([last.event, last.code], ["refused", "sender-down"]);
    assert.deepEqual(outage(), []);
    const feed = hostOf(org.id).feed(project.id, { newestFirst: true });
    assert.match(feed.find((f) => f.event === "outreach/not-sent")?.refused ?? "", /^Not sent to Ann: WhatsApp is down: /);
    assert.equal((await post("reconnect")).status, 200);
    await senderOpen();
  });

  test("the relay reconnects for a full-control peer, never a blocked account; the sender's own host does, and Resume lifts the block's pause", async () => {
    const relay = new Hono<{ Bindings: { meshPeer?: unknown } }>();
    const peers = [{ id: "desk", label: "Desk", nodeId: "nDESK", dnsName: "desk" }];
    mountOutreachRelay(relay as unknown as Hono, { requestPeer: (c) => ((c.env as { meshPeer?: any })?.meshPeer ?? null), peers: () => peers as any });
    const call = (op: string) => relay.request(`/api/peer/outreach/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, { meshPeer: peers[0] });
    sender.close(440);
    await senderSettled("replaced");
    const ok = await call("reconnect");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
    await senderOpen();
    sender.close(403);
    await senderSettled("blocked");
    const refused = await call("reconnect");
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code: string }).code, "refused");
    assert.equal((await call("pause")).status, 403, "pausing stays the host's own");
    assert.equal((await post("reconnect")).status, 200, "the host's own page may, after its warning");
    await senderOpen();
    const info = (await json("GET", "/api/outreach")).body;
    assert.equal(info.sender.paused, true, "a reconnect leaves the block's pause on");
    await post("pause", { on: false });
  });

  test("Start Sender: offered only while the local sender doesn't answer and its unit serving this socket is stopped; one systemctl start", async () => {
    const { setSystemctlForTest } = await import("./outreach/unit");
    const calls: string[][] = [];
    setSystemctlForTest(async (args) => {
      calls.push(args);
      if (args[0] === "show") return { code: 0, stdout: `LoadState=loaded\nActiveState=inactive\nEnvironment=PI_CODING_AGENT_DIR=${agent}\n` };
      if (args[0] === "start") sender.start();
      return { code: 0, stdout: "" };
    });
    try {
      assert.equal((await json("GET", "/api/outreach")).body.unit, undefined, "running: nothing to start");
      assert.equal((await post("start")).status, 409);
      stopSender();
      await senderSettled("unreachable");
      const info = (await json("GET", "/api/outreach")).body;
      assert.deepEqual(info.unit, { name: "sova-whatsapp.service", active: "inactive" });
      const r = await post("start");
      assert.equal(r.status, 200, await r.clone().text());
      assert.deepEqual(calls.filter((c) => c[0] === "start"), [["start", "sova-whatsapp.service"]]);
      await senderOpen();
    } finally {
      noSystemd();
    }
  });
});

/** Polls the outreach status until the sender reads `state`. */
async function senderSettled(state: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  let s = (await json("GET", "/api/outreach")).body.sender.state;
  while (s !== state && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    s = (await json("GET", "/api/outreach")).body.sender.state;
  }
  assert.equal(s, state);
}
