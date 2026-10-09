// Run: pnpm test -- server/outreach-numbers.test.ts. §app.outreach/sender-list, /org-sender: two numbers on this
// host (two in-process senders, each its own home and socket), two organizations, one on the default and one on
// its own pick. Each send goes through its organization's number alone; one number down refuses only its own
// organization's sends (never falls over) and raises only its own alert; a removed pick falls back to the default.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ann, app, cleanup, gathering, json, logOf, root, sendLink } from "./outreach-test-fixtures";
import { inProcessSender } from "./outreach/sender-test-fixtures";

const orgs = await import("./orgs");
const { resetLocalClient, setSenderClientOptionsForTest } = await import("./outreach/whatsapp");
const { senderAttention } = await import("./outreach/health");
const { readSendLog, personSends } = await import("./outreach/log");
const { OVERSEER_SENDER_HEADER } = await import("./overseer-sender");
const po = await import("./project-overseer");
const { hostOf } = await import("./org-engine");

const office = inProcessSender({ env: process.env, me: "15550000123" });
const salesHome = join(root, "wa-sales");
mkdirSync(salesHome, { recursive: true, mode: 0o700 });
const sales = inProcessSender({ env: { ...process.env, SOVA_WA_HOME: salesHome }, me: "15550000456" });
setSenderClientOptionsForTest({ connect: (path: string) => (path === sales.socket ? sales.connect(path) : office.connect(path)), retryMs: 0 });

const harbor = await orgs.createOrg({ name: "Harbor", dir: join(root, "ws-harbor") });
mkdirSync(join(root, "proj-harbor"));
const dock = await orgs.addProject(harbor.id, { name: "Dock", root: join(root, "proj-harbor") });
const dee = await orgs.addPerson(harbor.id, { name: "Dee", role: "Staff", contact: { whatsapp: "+1 555 000 0200" } });

async function harborGathering(): Promise<string> {
  const r = await json("POST", "/api/baton", { orgId: harbor.id, projectId: dock.id, to: dee.id, publicTitle: "Dock hours", goal: "g" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.sessionId as string;
}
const until = async (ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};
const stateOf = async (id: string) => (await json("GET", `/api/outreach?sender=${encodeURIComponent(id)}`)).body.sender.state as string;

after(async () => {
  office.stop();
  sales.stop();
  resetLocalClient();
  setSenderClientOptionsForTest({});
  await cleanup();
});

test("two numbers: the default and an organization's own pick; each send goes through its organization's number, and says which", async () => {
  const put = await json("PUT", "/api/outreach", { sender: { local: {} }, numbers: [{ id: "sales", socket: sales.socket }], labels: { local: "Office", "local:sales": "Sales" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await until(async () => (await stateOf("local")) === "open" && (await stateOf("local:sales")) === "open");

  // The organization's pick: operator only, an unknown id refused.
  assert.equal((await app.request(`/api/outreach/orgs/${harbor.id}`, { headers: { "X-Sova-Relayed": "1" } })).status, 404);
  assert.equal((await app.request(`/api/outreach/orgs/${harbor.id}`, { method: "PUT", headers: { "Content-Type": "application/json", [OVERSEER_SENDER_HEADER]: "x" }, body: '{"sender":"local:sales"}' })).status, 403);
  assert.equal((await json("PUT", `/api/outreach/orgs/${harbor.id}`, { sender: "local:nope" })).status, 400);
  const view = await json("PUT", `/api/outreach/orgs/${harbor.id}`, { sender: "local:sales" });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual([view.body.choice, view.body.effective, view.body.default], ["local:sales", { id: "local:sales", label: "Sales", me: "…456" }, { id: "local", label: "Office", me: "…123" }]);
  assert.equal((await json("GET", `/api/outreach/orgs/${orgs.readIndex().orgs[0]!.id}`)).body.choice, null, "the other organization: Default");

  const before = [office.sent(), sales.sent()];
  assert.equal((await sendLink(await gathering(ann.id))).body.outcome, "sent");
  assert.equal((await sendLink(await harborGathering())).body.outcome, "sent");
  assert.deepEqual([office.sent() - before[0]!, sales.sent() - before[1]!], [1, 1], "each through its own number");
  const gateLine = logOf().at(-1)!;
  const harborLine = readSendLog(harbor.id).at(-1)!;
  assert.deepEqual([gateLine.sender, gateLine.senderLabel, gateLine.from], ["local", "Office", "…123"]);
  assert.deepEqual([harborLine.sender, harborLine.senderLabel, harborLine.from], ["local:sales", "Sales", "…456"]);
  assert.doesNotMatch(JSON.stringify(readSendLog(harbor.id)), /5550000456|5550000200/, "never a number in the log");
  assert.deepEqual(personSends(harbor.id, dee.id, () => "Dock hours")[0]!.from, { label: "Sales", me: "…456" });
  // An added number's credentials are as secret as this host's own: the Overseer's file tools are kept out of its home.
  const { secretRules } = await import("./overseer-deny");
  assert.ok(secretRules().dirs.includes(salesHome), "the added number's home is protected");
  assert.ok((await json("GET", "/api/outreach")).body.protected.includes(salesHome));
});

test("one number down refuses only its own organization's sends, at once and never through the other number; only its own alert shows", async () => {
  sales.close(440);
  await until(async () => (await stateOf("local:sales")) === "replaced");
  const before = [office.sent(), sales.sent()];
  const harborSend = await sendLink(await harborGathering());
  assert.deepEqual([harborSend.body.outcome, harborSend.body.code], ["refused", "sender-down"]);
  assert.equal((await sendLink(await gathering(ann.id))).body.outcome, "sent", "the other organization still sends");
  assert.deepEqual([office.sent() - before[0]!, sales.sent() - before[1]!], [1, 0], "nothing fell over to Office");
  assert.deepEqual(
    senderAttention().map((i) => [i.id, i.detail]),
    [["whatsapp-sender:local:sales", "WhatsApp sending is down for Sales: Another process opened these credentials (440)."]],
  );
  // Reconnect names its sender: Office's reconnect leaves Sales down.
  assert.equal((await json("POST", "/api/outreach/sender/reconnect", { sender: "local" })).status, 409, "Office is already connected");
  const rc = await json("POST", "/api/outreach/sender/reconnect", { sender: "local:sales" });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.selected, "local:sales");
  await until(async () => (await stateOf("local:sales")) === "open");
  assert.deepEqual(senderAttention(), []);
});

test("a held overseer message waits for its own organization's number only: Office coming back releases nothing, Sales coming back sends it", async () => {
  await po.ensureProjectOverseer(dock.id);
  await po.patchProjectOverseer(dock.id, { autonomy: "L1", holdMin: 10 });
  const tool = (name: string) => po.toolsForTest(dock.id).find((t) => t.name === name)!;
  const run = (name: string, args: Record<string, unknown>) => tool(name).execute("t", args as never, undefined, undefined, undefined as never);
  const mine = () => readSendLog(harbor.id).filter((l) => l.by === "project-overseer");
  const outage = () => hostOf(harbor.id).holds().filter((h) => h.event === "outreach/send" && h.wait === "outage");
  await run("sova_send_to_person", { person: "Dee", note: "Your slot is ready." });
  const h = hostOf(harbor.id).holds().find((x) => x.event === "outreach/send")!;
  sales.close(440);
  await until(async () => (await stateOf("local:sales")) === "replaced");
  const approved = JSON.stringify((await run("sova_hold", { op: "approve", id: `${h.sessionId}:${h.id}`, reason: "test: go now" })).content);
  assert.match(approved, /but WhatsApp is down/);
  const waiting = outage().map((x) => x.id);
  assert.equal(waiting.length, 1);
  // Office goes down and comes back: Harbor's wait stays.
  office.close(440);
  await until(async () => (await stateOf("local")) === "replaced");
  assert.equal((await json("POST", "/api/outreach/sender/reconnect", { sender: "local" })).status, 200);
  await until(async () => (await stateOf("local")) === "open");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(outage().map((x) => x.id), waiting, "another number coming back releases nothing (a release would hold it again under a new id)");
  const before = mine().length;
  assert.equal((await json("POST", "/api/outreach/sender/reconnect", { sender: "local:sales" })).status, 200);
  await until(() => mine().length > before);
  assert.deepEqual(mine().slice(before).map((l) => [l.event, l.sender]), [["sent", "local:sales"]]);
  assert.deepEqual(outage(), []);
});

test("a pick that is no longer on the list falls back to the default, and the organization's settings say so", async () => {
  assert.equal((await json("PUT", "/api/outreach", { numbers: [] })).status, 200);
  const v = await json("GET", `/api/outreach/orgs/${harbor.id}`);
  assert.deepEqual([v.body.choice, v.body.gone, v.body.effective.id], ["local:sales", "local:sales", "local"]);
  const before = office.sent();
  assert.equal((await sendLink(await harborGathering())).body.outcome, "sent");
  assert.equal(office.sent() - before, 1);
  assert.equal(readSendLog(harbor.id).at(-1)!.sender, "local");
  // Off: nothing goes, whatever the pick.
  assert.equal((await json("PUT", "/api/outreach", { sender: "off" })).status, 200);
  assert.equal((await json("GET", `/api/outreach/orgs/${harbor.id}`)).body.off, true);
  assert.equal((await sendLink(await harborGathering())).body.code, "off");
});
