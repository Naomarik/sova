// Run: pnpm exec tsx --test server/org-hours.test.ts. r7 working hours (§app.organizations/working-hours): a
// person's zone and hours on the person routes, `hoursNow` from the statecharts' next-window rule, and an act that
// reaches them outside their hours waiting for their window (automatic and unattended ones; the operator's own
// goes at once). Throwaway workspace; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { Person } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-hours-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const { registerOrgRoutes } = await import("./org-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { hostOf } = await import("./org-engine");
const { heldAttention, pipelineInfo } = await import("./project-pipeline");
const { fakeLooks } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Hours", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const sam = await orgs.addPerson(org.id, { name: "Sam Okafor", role: "Pricing", decides: ["pricing"] });
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);
const app = new Hono();
registerOrgRoutes(app);
const patch = (body: unknown) => app.request(`/api/orgs/${org.id}/people/${sam.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** "HH:MM" in UTC, `h` hours from now (whole minutes). */
const hm = (h: number) => {
  const d = new Date(Date.now() + h * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const ALL = [0, 1, 2, 3, 4, 5, 6];

describe("a person's zone and hours (the person routes)", () => {
  test("PATCH sets tz and hours; every read says whether they are in their hours now, and when the next window opens", async () => {
    const r = await patch({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    assert.equal(r.status, 200);
    const p = orgs.findPerson(org.id, sam.id)!;
    assert.equal(p.tz, "UTC");
    assert.deepEqual(p.hours, { days: ALL, from: hm(2), to: hm(3) });
    assert.equal(p.hoursNow?.open, false);
    const next = Date.parse(p.hoursNow!.nextOpen!);
    assert.ok(Math.abs(next - (Date.now() + 2 * 3_600_000)) < 61_000, "their window opens in two hours");
    await patch({ hours: { days: ALL, from: hm(-1), to: hm(1) } });
    assert.deepEqual(orgs.findPerson(org.id, sam.id)!.hoursNow, { open: true });
    const page = (await (await app.request(`/api/orgs/${org.id}`)).json()) as { roster: Person[] };
    assert.deepEqual(page.roster.find((x) => x.id === sam.id)?.hoursNow, { open: true }, "the org page's roster carries it too");
  });

  test("a bad zone or window is refused with the person statechart's sentence; nothing changes", async () => {
    const before = orgs.findPerson(org.id, sam.id)!;
    for (const [body, why] of [
      [{ tz: "Mars/Olympus" }, "tz must be an IANA time zone, like Europe/Istanbul"],
      [{ hours: { days: [7], from: "09:00", to: "17:00" } }, "hours.days must list days 0–6 (0 is Sunday), each once"],
      [{ hours: { days: [1], from: "9am", to: "17:00" } }, "hours.from and hours.to must be times like 09:00"],
      [{ hours: { days: [1], from: "09:00", to: "09:00" } }, "hours.from and hours.to must differ"],
    ] as const) {
      const r = await patch(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(((await r.json()) as { error: string }).error, new RegExp(`^${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), JSON.stringify(body));
    }
    assert.deepEqual(orgs.findPerson(org.id, sam.id), before);
  });

  test("tz and hours changes are roster history lines, like contact (not private)", () => {
    const fields = orgs.readHistory(org.id, sam.id).map((h) => h.field);
    assert.ok(fields.includes("tz") && fields.includes("hours"), fields.join(","));
  });
});

test("reverting an hours or zone line works both ways: set from nothing → cleared; a later change → the earlier one", async () => {
  const rev = await orgs.addPerson(org.id, { name: "Rae Voss", role: "Ops" });
  const req = (method: string, path: string, body: unknown) => app.request(`/api/orgs/${org.id}/people/${rev.id}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const line = (field: string) => orgs.readHistory(org.id, rev.id).filter((h) => h.field === field && !h.revertOf).at(-1)!;
  const revert = async (field: string) => {
    const r = await req("POST", "/revert", { at: line(field).at });
    assert.equal(r.status, 200, await r.clone().text());
  };
  const first = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
  assert.equal((await req("PATCH", "", { tz: "Europe/Istanbul", hours: first })).status, 200);
  await revert("hours");
  assert.equal(orgs.findPerson(org.id, rev.id)!.hours, undefined, "hours set from nothing: reverting clears them");
  await revert("tz");
  assert.equal(orgs.findPerson(org.id, rev.id)!.tz, undefined, "the zone likewise");
  assert.equal((await req("PATCH", "", { tz: "Europe/Istanbul", hours: first })).status, 200);
  assert.equal((await req("PATCH", "", { tz: "Asia/Dubai", hours: { days: [0], from: "22:00", to: "06:00" } })).status, 200);
  await revert("hours");
  await revert("tz");
  const p = orgs.findPerson(org.id, rev.id)!;
  assert.deepEqual([p.tz, p.hours], ["Europe/Istanbul", first], "a later change's revert restores the earlier hours and zone");
});

describe("an act that reaches them outside their hours (r7)", () => {
  test("the overseer's unattended gathering waits for their window, in the Pipeline and Needs you; the operator's own goes at once", async () => {
    await patch({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0 });
    const tool = po.toolsForTest(project.id, { attended: false }).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("t1", { gap: "none", person: "Sam Okafor", why: "Nobody has said this yet.", public_title: "Prices", goal: "Which prices apply", question: "Which prices apply?" } as never, undefined, undefined, undefined as never);
    assert.match((out.content[0] as { text: string }).text, /^Held: starting "Prices" with Sam Okafor waits until /);
    const held = pipelineInfo(org.id, project.id).held.find((h) => h.what === "A gathering with Sam Okafor: Prices")!;
    assert.deepEqual([held.wait, held.person], ["hours", "Sam Okafor"]);
    assert.equal(held.goesAt, orgs.findPerson(org.id, sam.id)!.hoursNow!.nextOpen);
    const item = heldAttention().find((i) => i.held?.id === held.id)!;
    assert.equal(item.held?.wait, "hours");
    assert.match(item.detail!, /^A gathering with Sam Okafor: Prices waits for Sam Okafor's working hours: it starts in 1[12]\d min unless you cancel it\.$/);
    assert.ok(!baton.allBatons().some((b) => b.publicTitle === "Prices"), "nothing reached them");
    // The org's card and page count it once, as Needs you lists it.
    const card = ((await (await app.request("/api/orgs")).json()) as { orgs: { id: string; needsYou?: { held?: number } }[] }).orgs.find((o) => o.id === org.id)!;
    assert.equal(card.needsYou?.held, heldAttention().filter((i) => i.org?.orgId === org.id).length);
    assert.equal(((await (await app.request(`/api/orgs/${org.id}`)).json()) as { needsYou: { held?: number } }).needsYou.held, card.needsYou?.held);
    assert.ok(card.needsYou!.held! >= 1);
    // The operator's own start goes at once (q13), its step marked off hours.
    const mine = await baton.createBaton({ orgId: org.id, projectId: project.id, to: sam.id, publicTitle: "Mine", goal: "g" });
    assert.ok(mine.sessionId && !mine.held);
    const row = hostOf(org.id).log.rows({ newestFirst: true }).find((r) => r.event === "baton/start" && !r.held)!;
    assert.ok(typeof row.offHours === "number" && row.offHours > Date.now(), "the operator's act went at once, noted off hours");
  });

  test("an unattended offer waits for the earliest invitee's window; one invitee in hours and it goes now", async () => {
    const ada = await orgs.addPerson(org.id, { name: "Ada Lind", role: "Billing" });
    const setHours = (pid: string, from: number, to: number) => app.request(`/api/orgs/${org.id}/people/${pid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: "UTC", hours: { days: ALL, from: hm(from), to: hm(to) } }) });
    await setHours(sam.id, 3, 4);
    await setHours(ada.id, 2, 3);
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0 });
    const tool = po.toolsForTest(project.id, { attended: false }).find((t) => t.name === "sova_offer")!;
    await tool.execute("t2", { gap: "none", people: ["Sam Okafor", "Ada Lind"], why: "Nobody has said this yet.", public_title: "Invoices", goal: "g", question: "Who sends invoices?" } as never, undefined, undefined, undefined as never);
    const held = pipelineInfo(org.id, project.id).held.find((h) => h.what === "An offer to 2 people: Invoices")!;
    assert.equal(held?.wait, "hours");
    assert.equal(held.goesAt, orgs.findPerson(org.id, ada.id)!.hoursNow!.nextOpen, "the earliest invitee's window (Ada's)");
    assert.ok(!baton.allBatons().some((b) => b.publicTitle === "Invoices"), "nothing reached them");
    // Ada in her hours: the next offer goes now.
    await setHours(ada.id, -1, 1);
    await tool.execute("t3", { gap: "none", people: ["Sam Okafor", "Ada Lind"], why: "Nobody has said this yet.", public_title: "Receipts", goal: "g", question: "Who files receipts?" } as never, undefined, undefined, undefined as never);
    assert.ok(baton.allBatons().some((b) => b.publicTitle === "Receipts"), "an invitee in hours: it went at once");
  });

  test("r13: an hours edit moves every act waiting for them: a later window moves it, their hours now release it (checked against the hours in force)", async () => {
    await patch({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0 });
    const tool = po.toolsForTest(project.id, { attended: false }).find((t) => t.name === "sova_start_gathering")!;
    await tool.execute("t4", { gap: "none", person: "Sam Okafor", why: "Nobody has said this yet.", public_title: "Moves", goal: "g", question: "Does it move?" } as never, undefined, undefined, undefined as never);
    const heldOf = () => pipelineInfo(org.id, project.id).held.find((h) => h.what === "A gathering with Sam Okafor: Moves");
    assert.equal(heldOf()?.goesAt, orgs.findPerson(org.id, sam.id)!.hoursNow!.nextOpen);
    await patch({ hours: { days: ALL, from: hm(5), to: hm(6) } });
    assert.equal(heldOf()?.goesAt, orgs.findPerson(org.id, sam.id)!.hoursNow!.nextOpen, "moved to the new window");
    assert.ok(!baton.allBatons().some((b) => b.publicTitle === "Moves"));
    await patch({ hours: { days: ALL, from: hm(-1), to: hm(1) } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(heldOf(), undefined, "in their hours now: released");
    assert.ok(baton.allBatons().some((b) => b.publicTitle === "Moves"), "it went ahead");
  });

  test("the operator's routes that reach them say so (offHours: when their window opens); the strip's people carry tz and hoursNow", async () => {
    await patch({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    const opens = orgs.findPerson(org.id, sam.id)!.hoursNow!.nextOpen!;
    const post = (path: string, b: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const r = await post("/api/baton", { orgId: org.id, projectId: project.id, to: sam.id, publicTitle: "Route", goal: "g" });
    assert.equal(r.status, 201);
    const started = (await r.json()) as { sessionId: string; path: string; offHours?: string };
    assert.equal(started.offHours, opens);
    const info = (await (await app.request(`/api/baton?path=${encodeURIComponent(started.path)}`)).json()) as { active: { id: string; tz?: string; hoursNow?: { open: boolean } }[] };
    assert.deepEqual(info.active.find((p) => p.id === sam.id), { id: sam.id, name: "Sam Okafor", role: "Pricing", tz: "UTC", hoursNow: { open: false, nextOpen: opens } });
    // Back to the operator, then on to Sam again: the hand-off's answer says it too.
    assert.equal((await post(`/api/baton/${started.sessionId}/take`, {})).status, 200);
    const h = await post(`/api/baton/${started.sessionId}/handoff`, { to: sam.id, question: "Again?" });
    assert.equal(h.status, 200);
    assert.equal(((await h.json()) as { offHours?: string }).offHours, opens);
    // In their hours: no note.
    await patch({ hours: { days: ALL, from: hm(-1), to: hm(1) } });
    const inHours = (await (await post("/api/baton", { orgId: org.id, projectId: project.id, to: sam.id, publicTitle: "Now", goal: "g" })).json()) as { offHours?: string };
    assert.equal(inHours.offHours, undefined);
  });
});

describe("company working hours, the default (r13)", () => {
  const put = (b: unknown) => app.request(`/api/orgs/${org.id}/hours`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  type Detail = { tz?: string; hours?: unknown; hoursHistory?: { at: string; field: string; from: unknown; to: unknown; revertOf?: string }[] };

  test("the operator sets and clears them; each changed field is a history line; a person without hours of their own reads the company's", async () => {
    const cy = await orgs.addPerson(org.id, { name: "Cy Moss", role: "Ops" });
    const hours = { days: ALL, from: hm(2), to: hm(3) };
    const r = await put({ tz: "UTC", hours });
    assert.equal(r.status, 200, await r.clone().text());
    const d = (await r.json()) as Detail;
    assert.deepEqual([d.tz, d.hours], ["UTC", hours]);
    assert.deepEqual(d.hoursHistory!.slice(0, 2).map((h) => [h.field, h.from, h.to]), [["hours", null, hours], ["tz", "", "UTC"]]);
    const p = orgs.findPerson(org.id, cy.id)!;
    assert.equal(p.hoursFrom, "company");
    assert.equal(p.tz, undefined, "their own fields stay empty");
    assert.equal(p.hoursNow?.open, false);
    // Sam's own hours win.
    await patch({ tz: "UTC", hours: { days: ALL, from: hm(-1), to: hm(1) } });
    assert.deepEqual([orgs.findPerson(org.id, sam.id)!.hoursFrom, orgs.findPerson(org.id, sam.id)!.hoursNow?.open], ["own", true]);
    // The person page carries the company's, for "(company hours)".
    const page = (await (await app.request(`/api/orgs/${org.id}/people/${cy.id}`)).json()) as { org: { tz?: string; hours?: unknown } };
    assert.deepEqual([page.org.tz, page.org.hours], ["UTC", hours]);
    // Cleared: neither, always in hours.
    assert.equal((await put({ tz: null, hours: null })).status, 200);
    assert.equal(orgs.findPerson(org.id, cy.id)!.hoursFrom, undefined);
    assert.equal(orgs.findPerson(org.id, cy.id)!.hoursNow, undefined);
  });

  test("the statechart's checks answer with its sentences; nothing is written", async () => {
    const before = (await (await app.request(`/api/orgs/${org.id}`)).json()) as Detail;
    const r = await put({ tz: "Mars/Olympus" });
    assert.equal(r.status, 400);
    const after = (await (await app.request(`/api/orgs/${org.id}`)).json()) as Detail;
    assert.equal(after.hoursHistory?.length, before.hoursHistory?.length);
    assert.equal((await put({})).status, 400);
  });

  test("a history line reverts while its field still holds its value; a later change refuses it (C6)", async () => {
    const h1 = { days: ALL, from: hm(2), to: hm(3) };
    const h2 = { days: ALL, from: hm(4), to: hm(5) };
    await put({ tz: "UTC", hours: h1 });
    const first = ((await (await put({ hours: h2 })).json()) as Detail).hoursHistory![0]!;
    assert.deepEqual([first.field, first.to], ["hours", h2]);
    const older = ((await (await app.request(`/api/orgs/${org.id}`)).json()) as Detail).hoursHistory!.find((h) => h.field === "hours" && JSON.stringify(h.to) === JSON.stringify(h1))!;
    const refused = await app.request(`/api/orgs/${org.id}/hours/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: older.at }) });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /^The company's working hours have changed since then, so reverting this would undo a later change\. Revert the latest change instead\.$/);
    const ok = await app.request(`/api/orgs/${org.id}/hours/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: first.at }) });
    assert.equal(ok.status, 200);
    const d = (await ok.json()) as Detail;
    assert.deepEqual(d.hours, h1);
    assert.deepEqual([d.hoursHistory![0]!.revertOf, d.hoursHistory![0]!.to], [first.at, h1]);
    await put({ tz: null, hours: null });
  });

  test("a company-hours change moves an act waiting for someone who has no hours of their own", async () => {
    const di = await orgs.addPerson(org.id, { name: "Di Park", role: "Legal" });
    await put({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0 });
    const tool = po.toolsForTest(project.id, { attended: false }).find((t) => t.name === "sova_start_gathering")!;
    await tool.execute("t9", { gap: "none", person: "Di Park", why: "Nobody has said this yet.", public_title: "Terms", goal: "g", question: "Which terms?" } as never, undefined, undefined, undefined as never);
    const heldOf = () => pipelineInfo(org.id, project.id).held.find((h) => h.what === "A gathering with Di Park: Terms");
    assert.equal(heldOf()?.goesAt, orgs.findPerson(org.id, di.id)!.hoursNow!.nextOpen, "it waits for the company's window");
    await put({ hours: { days: ALL, from: hm(-1), to: hm(1) } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(heldOf(), undefined, "the company's hours are now: released");
    assert.ok(baton.allBatons().some((b) => b.publicTitle === "Terms"));
    await put({ tz: null, hours: null });
  });
});

describe("an offer reaches each invitee in their own hours (r12)", () => {
  test("in hours now: reached at once; the others wait for their window, then Needs you asks the operator to send their link", async () => {
    const { setOrgClockForTest } = await import("./org-engine");
    const { batonInfo } = await import("./org-routes");
    const eve = await orgs.addPerson(org.id, { name: "Eve Lund", role: "Sales" });
    const fay = await orgs.addPerson(org.id, { name: "Fay Roth", role: "Sales" });
    const setHours = (pid: string, from: number, to: number) => app.request(`/api/orgs/${org.id}/people/${pid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: "UTC", hours: { days: ALL, from: hm(from), to: hm(to) } }) });
    await setHours(eve.id, -1, 1);
    await setHours(fay.id, 2, 3);
    await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0, caps: { gatheringsOpen: 20, gatherPerTurn: null, gatherPerDay: null } });
    const tool = po.toolsForTest(project.id, { attended: false }).find((t) => t.name === "sova_offer")!;
    await tool.execute("r12", { gap: "none", people: ["Eve Lund", "Fay Roth"], why: "Nobody has said this yet.", public_title: "Quotes", goal: "g", question: "Who sends quotes?" } as never, undefined, undefined, undefined as never);
    const row = () => baton.allBatons().find((b) => b.publicTitle === "Quotes")!;
    assert.ok(row(), "someone was in hours: it went now");
    const fayOpens = orgs.findPerson(org.id, fay.id)!.hoursNow!.nextOpen!;
    // The strip: Eve reached, Fay waiting until her window.
    const info = batonInfo(row());
    assert.deepEqual(
      info.offer!.to.map((t) => [t.name, t.reach?.state, t.reach?.state === "waiting" ? t.reach.until : undefined]),
      [["Eve Lund", "reached", undefined], ["Fay Roth", "waiting", fayOpens]],
    );
    // Needs you: a link only for Eve (the overseer's offer mints none), Fay listed as waiting.
    const field = baton.batonSummaryField(baton.sessionPathOf(orgs.orgDir(org.id), row()))!;
    assert.equal(field.sendLink?.to, "Eve Lund");
    assert.deepEqual(field.waiting, [{ name: "Fay Roth", until: fayOpens }]);
    // Fay's link can't be sent yet; the person page says she waits.
    const refused = await app.request(`/api/baton/${row().sessionId}/link?person=${fay.id}`);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "Fay Roth is not reached yet: their link is made when their working hours start.");
    const page = (await (await app.request(`/api/orgs/${org.id}/people/${fay.id}`)).json()) as { sessions: { sessionId: string; offer?: { reach?: { state: string } } }[] };
    assert.equal(page.sessions.find((s) => s.sessionId === row().sessionId)?.offer?.reach?.state, "waiting");
    // The look names her and when.
    assert.match(po.lookAppendix(project.id), new RegExp(`Offers still reaching people[^]*- Offer 1 in "Quotes" · reaches Fay Roth at ${fayOpens.replace(/[.]/g, "\\.")} \\(their working hours\\)`));
    // Her window opens: the statechart's timer reaches her; no link is made by itself (nobody could take its token), so
    // Needs you now asks for hers too, and the operator's send makes it, once.
    setOrgClockForTest(() => Date.parse(fayOpens) + 60_000);
    try {
      hostOf(org.id).fireDue();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      setOrgClockForTest(null);
    }
    assert.equal(batonInfo(row()).offer!.to.find((t) => t.id === fay.id)?.reach?.state, "reached");
    const { linksOfPerson } = await import("./baton-links");
    assert.equal(linksOfPerson(org.id, fay.id).filter((l) => l.sessionId === row().sessionId).length, 0, "no link minted by the timer");
    assert.equal(baton.batonSummaryField(baton.sessionPathOf(orgs.orgDir(org.id), row()))!.sendLink?.to, "Eve Lund, Fay Roth");
    const sent = await app.request(`/api/baton/${row().sessionId}/link?person=${fay.id}`);
    assert.equal(sent.status, 200);
    assert.match(((await sent.json()) as { link: string }).link, /\/h\//);
    assert.equal(baton.batonSummaryField(baton.sessionPathOf(orgs.orgDir(org.id), row()))!.sendLink?.to, "Eve Lund");
  });
});
