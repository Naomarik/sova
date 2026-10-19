// Run: node scripts/run-tests.mjs server/overseer-owner-send.test.ts. §app.owner-page/send end to end, in-process:
// the global Overseer's sova_owner send_link through the org statechart's owner/send-link act, the
// organization's own outreach send, the owner resolver and the WhatsApp sender's real state machine over a
// fake WhatsApp (outreach/sender-test-fixtures.ts, an in-memory stream, no socket). A stand-in channel
// (setSendChannelForTest) gives a definite failure, no answer, or a send held open. A throwaway
// PI_CODING_AGENT_DIR and workspaces in the OS temp dir, deleted after; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SovaConfirmItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";
import type { Channel, ChannelSend } from "./outreach/types";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-oos-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.SOVA_WA_SOCKET;
delete process.env.SOVA_WA_HOME;
const PUBLIC = "https://share.example.com";
process.env.SOVA_SHARE_PUBLIC_URL = PUBLIC;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { Hono } = await import("hono");
const orgs = await import("./orgs");
const overseer = await import("./overseer");
const tools = await import("./overseer-tools");
const { DEFAULT_CAPS, overseerActionsFile, writeOverseerState } = await import("./overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { mountOutreach } = await import("./outreach/routes");
const { setSystemctlForTest } = await import("./outreach/unit");
const { resetLocalClient, setSenderClientOptionsForTest } = await import("./outreach/whatsapp");
const { inProcessSender } = await import("./outreach/sender-test-fixtures");
const { readSendLog } = await import("./outreach/log");
const { send, setSendChannelForTest } = await import("./outreach/core");
const owner = await import("./owner");
const { ownerAttention } = await import("./owner-attention");
const { ownerLinksOf, mintOwnerLink, recordAsk } = await import("./person-links");
const { dropTokens, tokenFor } = await import("./link-tokens");
const { hostOf } = await import("./org-engine");
const { historyOf } = await import("./harness/pi/reader");
const { applyCardCall } = await import("../shared/overseer-card");
const { orgTools } = await import("./overseer-org-tools");
const { personPage } = await import("./person-page");

setSystemctlForTest(async () => ({ code: 1, stdout: "" }));
const ABSENT = "15550000999";
const sender = inProcessSender({ env: process.env, absent: [ABSENT] });
setSenderClientOptionsForTest({ connect: sender.connect, retryMs: 0 });

const app = new Hono();
registerOrgRoutes(app);
mountOutreach(app);
overseer.setOverseerDispatch((path, init) => app.request(path, init));
const OVERSEER_ID = "ov-owner-send-1";
writeOverseerState({ version: 1, current: OVERSEER_ID, history: [] });
const json = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

after(() => {
  sender.stop();
  resetLocalClient();
  setSenderClientOptionsForTest({});
  setSendChannelForTest(null);
});

// ---- the Overseer's tools on a host whose turn and card the test sets -------------------------------------------

let attended = true;
let card: SovaConfirmItem[] | null = null;
let confirmedNow: (() => SovaConfirmItem[] | null) | null = null;
let permit: ((tool: string, sessions: string[]) => { id: string; label: string } | null) | undefined;
const limits = new tools.TurnLimits();
const host = {
  request: (path: string, init?: RequestInit) => overseer.requestAsOverseerForTest(path, init),
  overseerId: () => OVERSEER_ID,
  caps: () => DEFAULT_CAPS,
  sessions: async () => [],
  session: async () => null,
  digest: async () => ({ items: [], counts: { act: 0, decide: 0, fyi: 0 } }),
  attended: () => attended,
  confirmed: () => (confirmedNow ? confirmedNow() : card),
  permit: (tool: string, sessions: string[]) => permit?.(tool, sessions) ?? null,
  started: () => {},
  runningStarted: () => 0,
  counted: () => false,
  peerIds: () => [],
  links: {} as never,
} as unknown as OverseerToolHost;
const all = tools.overseerTools(host, limits);
const tool = (name: string) => all.find((t) => t.name === name)!;
let seq = 0;
type Ran = { ok: boolean; text: string; details?: unknown };
/** Every output, for the marker check (§app.overseer/org-projection). */
const outputs: string[] = [];
async function call(name: string, params: Record<string, unknown>): Promise<Ran> {
  try {
    const out = await tool(name).execute(`tc${++seq}`, params, undefined, undefined, undefined as never);
    const text = (out.content as { text: string }[]).map((c) => c.text).join("\n");
    outputs.push(`${text}\n${JSON.stringify(out.details ?? null)}`);
    return { ok: true, text, details: out.details };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    outputs.push(text);
    return { ok: false, text };
  }
}
const personItem = (orgId: string, id: string): SovaConfirmItem => ({ kind: "person", id, orgId, name: "", orgName: "", status: "active" });

// ---- the world: Halden Works (owner Omar), a second org with its own Omar Hughes ----------------------------------

const OMAR_WA = "+1 555 000 0100";
const org = await orgs.createOrg({ name: "Halden Works", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const omar = await orgs.addPerson(org.id, { name: "Omar Hughes", role: "Owner", contact: { whatsapp: OMAR_WA } });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll", contact: { whatsapp: "+1 555 000 0101" } });
const gil = await orgs.addPerson(org.id, { name: "Gil Moss", role: "Staff", contact: { whatsapp: "+1 555 000 0999" } });
const bob = await orgs.addPerson(org.id, { name: "Bob Hale", role: "Staff" });
const other = await orgs.createOrg({ name: "Other Co", dir: join(root, "ws2") });
const omar2 = await orgs.addPerson(other.id, { name: "Omar Hughes", role: "Owner", contact: { whatsapp: "+1 555 000 0102" } });
await orgs.setOrgOwner(other.id, omar2.id);

const setOwner = (orgId: string, personId: string | null) => orgs.setOrgOwner(orgId, personId);
const sendOwner = (person: string, extra: Record<string, unknown> = {}, orgRef: string = org.id) => call("sova_owner", { op: "send_link", org: orgRef, person, ...extra });
const ownerLinks = () => ownerLinksOf(org.id);
const live = () => ownerLinks().filter((l) => owner.ownerPageInfo(org.id) && !l.revokedAt && Date.parse(l.expiresAt) > Date.now());
const logOf = () => readSendLog(org.id);
const tokens = () => ownerLinks().map((l) => tokenFor(l.hash, "i")).filter((t): t is string => !!t);
/** What a link, a token or a number would look like in any output. */
function leaks(s: string): string | null {
  for (const t of [...tokens(), ...seenTokens]) if (s.includes(t)) return "a token";
  for (const m of [PUBLIC, "/i/", "share.example", "5550000100", "555 000 0100", "5550000101", ABSENT]) if (s.includes(m)) return m;
  return null;
}
const seenTokens = new Set<string>();
const remember = () => tokens().forEach((t) => seenTokens.add(t));
/** A channel that answers each send as told (and counts them), the sender's status still the real one. */
function standIn(answer: () => Promise<ChannelSend> | ChannelSend) {
  const texts: string[] = [];
  const ch: Channel = { id: "whatsapp", status: async () => ({ state: "open" }) as never, onReceipt: () => {}, send: async ({ text }) => (texts.push(text), answer()) };
  return { ch, texts };
}

describe("§app.owner-page/send: the Overseer sends the owner their page link", () => {
  before(async () => {
    sender.start();
  });

  test("outreach off: refused before anything is made or sent, with the People tab fallback", async () => {
    await setOwner(org.id, omar.id);
    card = [personItem(org.id, omar.id)];
    const r = await sendOwner("Omar Hughes");
    assert.equal(r.ok, false);
    assert.equal(r.text, "Not sent to Omar Hughes: Outreach is off: set it up in Settings → Outreach. You can send it yourself from the People tab.");
    assert.equal(ownerLinks().length, 0, "no link made");
    assert.deepEqual([logOf().at(-1)!.event, logOf().at(-1)!.code, logOf().at(-1)!.link], ["refused", "off", "owner"]);
  });

  test("the card clicked: sent, one new link (none was held), nothing in the result, action log, send log or history holds a link, token or number", async () => {
    assert.equal((await json("PUT", "/api/outreach", { sender: { local: {} } })).status, 200);
    const end = Date.now() + 30_000;
    while ((await json("GET", "/api/outreach")).body.sender.state !== "open" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    // The org's read says a new link will be made (none held), before the card.
    const read = await call("sova_orgs", { org: org.id });
    assert.match(read.text, /Owner: Omar Hughes · owner page link: none Sova holds \(send_link makes a new one; their current link stops working\)/);
    limits.reset();
    card = [personItem(org.id, omar.id)];
    const before = sender.sent();
    const r = await sendOwner("Omar Hughes");
    assert.equal(r.ok, true, r.text);
    assert.equal(r.text, "Sent Omar Hughes their owner page link on WhatsApp.");
    assert.equal(sender.sent(), before + 1, "one message");
    assert.equal(limits.count("org"), 1, "one organization write");
    const links = ownerLinks();
    assert.equal(links.length, 1, "exactly one link made");
    assert.equal(links[0]!.personId, omar.id);
    assert.equal(links[0]!.undelivered, undefined, "delivered");
    remember();
    const line = logOf().at(-1)!;
    assert.deepEqual([line.event, line.link, line.by, line.projectId], ["sent", "owner", "operator-via-overseer", undefined]);
    // The read now says the held link goes.
    assert.match((await call("sova_orgs", { org: org.id })).text, /owner page link: works and Sova holds it \(send_link sends that one\)/);
    // The person page: Sent on WhatsApp, "Their owner page".
    assert.equal(personPage(org.id, omar.id).sends?.[0]?.what, "Their owner page");
    // The org's history: a message sent to the owner, by the operator via the Overseer; no link or number.
    const h = hostOf(org.id).history;
    const records = h.search({ role: "operator" }, { kinds: ["outreach.sent"] }).items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    const started = records.find((x) => x.outcome === "started");
    assert.ok(started, JSON.stringify(records.map((x) => x.outcome)));
    assert.deepEqual(started!.entities.filter((x) => x.type === "person"), [{ type: "person", id: omar.id }]);
    assert.ok(records.some((x) => x.outcome === "done"), "and its answer: sent");
    assert.match(JSON.stringify(started!.actors), /overseer/i);
    for (const s of [JSON.stringify(records), readFileSync(join(root, "ws", "outreach.jsonl"), "utf8"), readFileSync(overseerActionsFile(), "utf8"), ...outputs]) assert.equal(leaks(s), null, s.slice(0, 300));
  });

  test("a held working link is sent again: nothing made, nothing turned off", async () => {
    const was = ownerLinks().map((l) => ({ hash: l.hash, revokedAt: l.revokedAt }));
    card = [personItem(org.id, omar.id)];
    const r = await sendOwner(omar.id);
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(ownerLinks().map((l) => ({ hash: l.hash, revokedAt: l.revokedAt })), was, "the same link, still live");
  });

  test("no held link: exactly one new link, and every older one of the org stops at once (one live link per org)", async () => {
    dropTokens(ownerLinks().map((l) => l.hash));
    const older = ownerLinks().map((l) => l.hash);
    card = [personItem(org.id, omar.id)];
    const r = await sendOwner("Omar Hughes");
    assert.equal(r.ok, true, r.text);
    remember();
    const now = ownerLinks();
    assert.equal(now.length, older.length + 1);
    assert.ok(older.every((h) => now.find((l) => l.hash === h)!.revokedWhy === "rotated"), "the older ones stopped");
    assert.equal(now.filter((l) => !l.revokedAt).length, 1, "one live link");
  });

  test("b1: an unheld live link and a failing send: the old link stopped, the new one stays, and the result says both", async () => {
    await setOwner(org.id, gil.id);
    const { token } = mintOwnerLink(org.id, gil.id);
    seenTokens.add(token);
    const oldHash = ownerLinks().at(-1)!.hash;
    dropTokens([oldHash]); // live, but Sova doesn't hold it
    card = [personItem(org.id, gil.id)];
    const r = await sendOwner("Gil Moss");
    assert.equal(r.ok, false);
    assert.match(r.text, /^Not sent to Gil Moss: .+\. A new owner link was made but not delivered, and their old link no longer works: copy the new one from the People tab\.$/);
    remember();
    const old = ownerLinks().find((l) => l.hash === oldHash)!;
    assert.ok(old.revokedAt, "the old link stopped");
    const made = ownerLinks().at(-1)!;
    assert.notEqual(made.hash, oldHash);
    assert.equal(made.personId, gil.id);
    assert.equal(made.revokedAt, undefined, "the new link stays: the org's one live link");
    assert.equal(made.undelivered, true);
    assert.ok(tokenFor(made.hash, "i"), "held, so the People tab can copy it");
    assert.deepEqual([logOf().at(-1)!.event, logOf().at(-1)!.code], ["failed", "not-on-whatsapp"]);
    assert.equal(leaks(r.text), null);
  });

  test("b2: the owner's ask stays in Needs you after a failed or unknown send; a delivered send clears it", async () => {
    await setOwner(org.id, omar.id);
    // Omar's newest link turned off unused, and he asked for a new one.
    const { record } = mintOwnerLink(org.id, omar.id, Date.now() - 8 * 86_400_000);
    assert.ok(recordAsk(record.hash));
    assert.equal(owner.ownerLinkNeeds(org.id), 1, "control: the ask shows");
    const failing = standIn(() => ({ ok: false, code: "not-on-whatsapp", retryable: false, why: "That number has no WhatsApp account." }));
    setSendChannelForTest(failing.ch);
    try {
      card = [personItem(org.id, omar.id)];
      const r = await sendOwner("Omar Hughes");
      assert.equal(r.ok, false);
      assert.match(r.text, /A new owner link was made but not delivered/);
      remember();
      // The message: the fixed owner line, a blank line, the link (§app.outreach/channels); never model-written.
      const made = ownerLinks().at(-1)!;
      assert.equal(failing.texts[0], `${orgs.operatorName()} sent you your page for Halden Works.\n\n${PUBLIC}/i/${tokenFor(made.hash, "i")}`);
      assert.equal(made.askedAt, ownerLinks().find((l) => l.hash === record.hash)!.askedAt, "the new link carries the ask");
      assert.equal(owner.ownerLinkNeeds(org.id), 1, "a failed send leaves the ask");
      assert.ok(ownerAttention().some((i) => i.id === `owner-link-request:${org.id}`), "and Needs you shows it");
      const silent = standIn(() => ({ ok: false, code: "unknown", retryable: false, why: "The sender didn't answer." }));
      setSendChannelForTest(silent.ch);
      const u = await sendOwner("Omar Hughes");
      assert.equal(u.ok, true, u.text);
      assert.equal(u.text, "It isn't known whether the message to Omar Hughes went. It won't be sent again: check Omar Hughes's page under Sent on WhatsApp before sending another.");
      assert.equal(silent.texts.length, 1, "asked once, never again");
      assert.equal(owner.ownerLinkNeeds(org.id), 1, "an unknown send leaves the ask");
      assert.equal(logOf().at(-1)!.event, "unknown");
    } finally {
      setSendChannelForTest(null);
    }
    const ok = await sendOwner("Omar Hughes", { note: "Here is your page again." });
    assert.equal(ok.ok, true, ok.text);
    assert.equal(owner.ownerLinkNeeds(org.id), 0, "a delivered send answers the ask");
    assert.equal(ownerLinks().at(-1)!.undelivered, undefined);
    assert.equal(logOf().at(-1)!.note, true, "the note went, its text never logged");
    assert.ok(!readFileSync(join(root, "ws", "outreach.jsonl"), "utf8").includes("Here is your page"));
    assert.ok(!ownerAttention().some((i) => i.id === `owner-link-request:${org.id}`));
  });

  test("the card: a typed yes, no card, a Retry, a card answered, superseded or dropped, another card, a later message: refused before anything", async () => {
    const row = { kind: "person", id: omar.id, orgId: org.id, name: "Omar Hughes", orgName: "Halden Works", status: "active" } as const;
    const create = (id: string) =>
      applyCardCall([], { ops: [{ op: "create", title: "Send Omar his page?", options: [{ label: "Send", reply: "Send Omar his owner page link." }, { label: "Cancel" }] }] }, { now: "2026-10-19T10:00:00.000Z", prepared: { items: [row], hrefs: [], clickOnly: true } }).details;
    const created = create("c_1");
    const result = (details: unknown, id = "k1") => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "sova_card", details } });
    const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    const branch = (...more: unknown[]) => historyOf([user("send Omar his link"), result(created), ...more] as never);
    const click = user("c_1 a: Send Omar his owner page link.");
    const dropped = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "drop", reason: "Not now." }] }, { now: "2026-10-19T10:01:00.000Z" }).details;
    const answered = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "answer", text: "send", option: "a" }] }, { now: "2026-10-19T10:01:00.000Z" }).details;
    const superseded = applyCardCall([created.card!], { ops: [{ op: "create", title: "Another", options: [{ label: "Go" }], replaces: "c_1" }] }, { now: "2026-10-19T10:01:00.000Z" }).details;
    assert.ok(overseer.confirmedItems("c_1", branch(click)), "control: the click itself approves");
    const cases: [string, string | null, unknown[]][] = [
      ["no card", null, []],
      ["a typed yes", "c_1", [user("yes")]],
      ["a Retry (no card mark)", null, [click]],
      ["a card answered before the click", "c_1", [result(answered, "k2"), click]],
      ["a card superseded", "c_1", [result(superseded, "k2"), click]],
      ["a card dropped", "c_1", [result(dropped, "k2"), click]],
      ["another card", "c_2", [click]],
      ["a later message", "c_1", [click, user("and now")]],
    ];
    const was = { links: ownerLinks().length, sent: sender.sent(), log: logOf().length };
    for (const [label, id, more] of cases) {
      confirmedNow = () => overseer.confirmedItems(id, branch(...more));
      try {
        const r = await sendOwner("Omar Hughes");
        assert.equal(r.ok, false, label);
        assert.match(r.text, /^This reaches people or ends something: ask with sova_card, listing Omar Hughes \(p_[a-z0-9]+\) in its items, and act in the turn the user's click starts\.$/, label);
      } finally {
        confirmedNow = null;
      }
    }
    assert.deepEqual({ links: ownerLinks().length, sent: sender.sent(), log: logOf().length }, was, "nothing made, sent or logged");
  });

  test("the owner only: someone else (either way round), a same-named person of another org, a stale card, no owner, the owner left", async () => {
    const was = { links: ownerLinks().length, sent: sender.sent() };
    // The card lists Omar; the call names Maria (active, not the owner): her name is not on the card.
    card = [personItem(org.id, omar.id)];
    assert.match((await sendOwner("Maria Lopez")).text, /^This reaches people or ends something: .*Maria Lopez/);
    // The card lists Maria and the call names her: she isn't the owner.
    card = [personItem(org.id, maria.id)];
    assert.equal((await sendOwner("Maria Lopez")).text, "Maria Lopez isn't Halden Works's owner. Nothing was sent.");
    // The card lists Maria; the call names Omar, the owner: not on the card.
    assert.match((await sendOwner("Omar Hughes")).text, /^This reaches people or ends something: .*Omar Hughes/);
    // The card lists Other Co's Omar Hughes; the call names Halden's: the row's org differs.
    card = [personItem(other.id, omar2.id)];
    assert.match((await sendOwner("Omar Hughes")).text, /^This reaches people or ends something: .*Omar Hughes/);
    // And the other way: Halden's Omar on the card, the call in Other Co.
    card = [personItem(org.id, omar.id)];
    assert.match((await sendOwner("Omar Hughes", {}, other.id)).text, /^This reaches people or ends something/);
    // A card raised for Omar; then the owner changed to Maria: the card's Omar isn't the owner now.
    await setOwner(org.id, maria.id);
    assert.equal((await sendOwner("Omar Hughes")).text, "Omar Hughes isn't Halden Works's owner. Nothing was sent.");
    // The statechart's own backstop, past the tool: the act refuses a non-owner, with the card.
    const { sendOwnerLinkAct } = await import("./outreach/core");
    await assert.rejects(
      () => sendOwnerLinkAct({ orgId: org.id, personId: omar.id, sentBy: "operator-via-overseer" }, orgs.operatorEnvelope(org.id, null, { kind: "operator", via: "overseer", overseerId: OVERSEER_ID, card: { people: [omar.id], projects: [], sessions: [] } })),
      /Omar Hughes isn't Halden Works's owner\. Nothing was sent\./,
    );
    // No owner.
    await setOwner(org.id, null);
    assert.equal((await sendOwner("Omar Hughes")).text, "Halden Works has no owner, so there is no owner page to send. Nothing was sent.");
    // The owner left: cleared, so no owner.
    await setOwner(org.id, bob.id);
    await orgs.leavePerson(org.id, bob.id);
    card = [personItem(org.id, bob.id)];
    assert.equal((await sendOwner("Bob Hale")).text, "Halden Works has no owner, so there is no owner page to send. Nothing was sent.");
    assert.deepEqual({ links: ownerLinks().length, sent: sender.sent() }, was, "nothing made or sent");
  });

  test("checked as it runs: no WhatsApp number, outreach paused, the sender paused or down, links unreachable: nothing made or sent", async () => {
    const bea = await orgs.addPerson(org.id, { name: "Bea Ruiz", role: "Owner" });
    await setOwner(org.id, bea.id);
    card = [personItem(org.id, bea.id)];
    const n0 = { links: ownerLinks().length, sent: sender.sent() };
    assert.equal((await sendOwner("Bea Ruiz")).text, "Not sent to Bea Ruiz: Bea Ruiz has no WhatsApp number on the roster. You can send it yourself from the People tab.");
    await setOwner(org.id, omar.id);
    card = [personItem(org.id, omar.id)];
    const n = { links: ownerLinks().length, sent: sender.sent() };
    assert.deepEqual(n, { links: n0.links, sent: n0.sent });
    dropTokens(ownerLinks().map((l) => l.hash)); // so any send would have to make one
    const nothing = () => assert.deepEqual({ links: ownerLinks().length, sent: sender.sent() }, n, "nothing made or sent");
    await json("PUT", "/api/outreach", { paused: true });
    assert.equal((await sendOwner("Omar Hughes")).text, "Not sent to Omar Hughes: Outreach is paused. You can send it yourself from the People tab.");
    nothing();
    await json("PUT", "/api/outreach", { paused: false });
    assert.equal((await json("POST", "/api/outreach/sender/pause", { on: true })).status, 200);
    assert.equal((await sendOwner("Omar Hughes")).text, "Not sent to Omar Hughes: WhatsApp sending is paused on the sender's host. You can send it yourself from the People tab.");
    nothing();
    assert.equal((await json("POST", "/api/outreach/sender/pause", { on: false })).status, 200);
    delete process.env.SOVA_SHARE_PUBLIC_URL;
    try {
      const r = await sendOwner("Omar Hughes");
      assert.match(r.text, /^Not sent to Omar Hughes: This link can't be opened from outside yet\. Turn on public links in Settings → Public links\. You can send it yourself from the People tab\.$/);
      assert.equal(logOf().at(-1)!.code, "address-off");
      nothing();
    } finally {
      process.env.SOVA_SHARE_PUBLIC_URL = PUBLIC;
    }
    sender.stop();
    resetLocalClient();
    try {
      const r = await sendOwner("Omar Hughes");
      assert.match(r.text, /^Not sent to Omar Hughes: WhatsApp is down: /);
      assert.equal(logOf().at(-1)!.code, "sender-down");
      nothing();
    } finally {
      sender.start();
      const end = Date.now() + 30_000;
      while ((await json("GET", "/api/outreach")).body.sender.state !== "open" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    }
  });

  test("the owner changes during the send: the new owner's link is untouched, whatever the outcome", async () => {
    await setOwner(org.id, omar.id);
    dropTokens(ownerLinks().map((l) => l.hash));
    for (const answer of [{ ok: true, ref: "ref-x", at: new Date().toISOString() } as ChannelSend, { ok: false, code: "not-on-whatsapp", retryable: false, why: "no" } as ChannelSend]) {
      await setOwner(org.id, omar.id);
      let letGo: ((r: ChannelSend) => void) | undefined;
      const hanging = standIn(() => new Promise<ChannelSend>((res) => (letGo = res)));
      setSendChannelForTest(hanging.ch);
      try {
        card = [personItem(org.id, omar.id)];
        const pending = sendOwner("Omar Hughes");
        while (!letGo) await new Promise((r) => setTimeout(r, 5));
        remember();
        // Meanwhile: the owner becomes Maria (her change applies at once; its answer waits for the org's
        // session to go quiet), and the operator gets her a link (Get New Owner Link).
        const changing = setOwner(org.id, maria.id);
        while (orgs.readOrg(org.id).owner !== maria.id) await new Promise((r) => setTimeout(r, 5));
        const hers = owner.ownerLinkFor(org.id);
        seenTokens.add(hers.token);
        const herLink = () => ownerLinks().find((l) => tokenFor(l.hash, "i") === hers.token)!;
        const before = JSON.stringify(herLink());
        letGo!(answer);
        await pending;
        await changing;
        assert.equal(JSON.stringify(herLink()), before, `Maria's link untouched (${answer.ok ? "sent" : "failed"})`);
        assert.equal(herLink().revokedAt, undefined);
      } finally {
        setSendChannelForTest(null);
      }
    }
  });

  test("a step run again (a restart mid-send) sends nothing and says unknown; the same send twice delivers once", async () => {
    await setOwner(org.id, omar.id);
    let letGo: ((r: ChannelSend) => void) | undefined;
    const hanging = standIn(() => new Promise<ChannelSend>((res) => (letGo = res)));
    const input = { orgId: org.id, personId: omar.id, link: { kind: "owner" as const }, by: "operator-via-overseer" as const, key: "k-restart" };
    const first = send(input, hanging.ch);
    while (!letGo) await new Promise((r) => setTimeout(r, 5));
    const again = await send(input, hanging.ch);
    assert.deepEqual([again.outcome, again.code], ["failed", "unknown-after-restart"]);
    assert.equal(hanging.texts.length, 1, "never sent a second time");
    letGo!({ ok: true, ref: "ref-r", at: new Date().toISOString() });
    await first;
    remember();
    // The same step twice through the real sender: one message (its idempotency key is the org's own).
    const n = sender.sent();
    const dup = { ...input, key: "k-dup" };
    assert.equal((await send(dup)).outcome, "sent");
    assert.equal((await send(dup)).outcome, "sent");
    assert.equal(sender.sent(), n + 1, "delivered once");
  });

  test("runs the user didn't start, and approvals for later or standing rules, never send", async () => {
    attended = false;
    permit = () => ({ id: "ap_1", label: "any act until 6:00 PM" });
    card = [personItem(org.id, omar.id)];
    const was = { links: ownerLinks().length, sent: sender.sent() };
    try {
      const r = await sendOwner("Omar Hughes");
      assert.equal(r.ok, false);
      assert.match(r.text, /sova_card/);
    } finally {
      attended = true;
      permit = undefined;
    }
    assert.deepEqual({ links: ownerLinks().length, sent: sender.sent() }, was);
  });

  test("project overseers and the Project Assistant have no way to it", async () => {
    // The op exists only on the global Overseer's sova_owner: no project overseer tool, no Project Assistant tool.
    const { TOOL_POWER } = await import("./project-overseer-tools");
    assert.ok(!Object.keys(TOOL_POWER).some((n) => n === "sova_owner" || /owner_link|send_link/.test(n)), Object.keys(TOOL_POWER).join(","));
    const assistant = readFileSync(join(import.meta.dirname, "project-assistant-tools.ts"), "utf8");
    assert.doesNotMatch(assistant, /owner\/send-link|sendOwnerLinkAct|ownerLinkToSend/);
    // And the statechart act is the operator's: a project overseer's own run is refused.
    const out = await hostOf(org.id).act(orgs.orgSid(org.id), "owner/send-link", { target: { id: omar.id, name: "Omar Hughes", status: "active" }, sentBy: "project-overseer" }, { ...orgs.operatorEnvelope(org.id, null), by: "overseer", attended: false } as never, { settle: true });
    assert.equal(out.taken, false);
  });

  test("every output of this file: no link, token or number (§app.overseer/org-projection)", () => {
    remember();
    for (const s of [...outputs, readFileSync(overseerActionsFile(), "utf8")]) assert.equal(leaks(s), null, s.slice(0, 300));
  });
});

// The tool set: the op is the global Overseer's only.
test("sova_owner send_link is in the global Overseer's org tools", () => {
  const t = orgTools({ act: () => (async () => ({})) as never, read: () => (async () => ({})) as never, refusal: (m) => new Error(m), call: async () => ({ status: 200, json: {} }), take: () => null, give: () => {}, slot: () => ({ release() {} }), started: () => {}, confirmed: () => null, sessionRef: (r) => String(r), obj: (p) => p, str: (d) => d, int: (d) => d, bool: (d) => d }).find((x) => x.name === "sova_owner")!;
  assert.match(String(t.description), /send_link/);
});
void live;
