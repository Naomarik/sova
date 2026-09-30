// Run: pnpm exec tsx --test server/org-hours.test.ts. r7 working hours (§app.organizations/working-hours): a
// person's zone and hours on the person routes, `hoursNow` from the charts' next-window rule, and an act that
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
await po.ensureProjectOverseer(org.id, project.id);
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

  test("a bad zone or window is refused with the person chart's sentence; nothing changes", async () => {
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

describe("an act that reaches them outside their hours (r7)", () => {
  test("the overseer's unattended gathering waits for their window, in the Pipeline and Needs you; the operator's own goes at once", async () => {
    await patch({ tz: "UTC", hours: { days: ALL, from: hm(2), to: hm(3) } });
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L1", holdMin: 0 });
    const tool = po.toolsForTest(org.id, project.id, { attended: false }).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("t1", { gap: "none", person: "Sam Okafor", public_title: "Prices", goal: "Which prices apply", question: "Which prices apply?" } as never, undefined, undefined, undefined as never);
    assert.match((out.content[0] as { text: string }).text, /^Held: starting "Prices" with Sam Okafor waits until /);
    const held = pipelineInfo(org.id, project.id).held.find((h) => h.what === 'A gathering session "Prices"')!;
    assert.deepEqual([held.wait, held.person], ["hours", "Sam Okafor"]);
    assert.equal(held.goesAt, orgs.findPerson(org.id, sam.id)!.hoursNow!.nextOpen);
    const item = heldAttention().find((i) => i.held?.id === held.id)!;
    assert.equal(item.held?.wait, "hours");
    assert.match(item.detail!, /^A gathering session "Prices" waits for Sam Okafor's working hours: it starts in 1[12]\d min unless you cancel it\.$/);
    assert.ok(!baton.allBatons().some((b) => b.publicTitle === "Prices"), "nothing reached them");
    // The operator's own start goes at once (q13), its step marked off hours.
    const mine = await baton.createBaton({ orgId: org.id, projectId: project.id, to: sam.id, publicTitle: "Mine", goal: "g" });
    assert.ok(mine.sessionId && !mine.held);
    const row = hostOf(org.id).log.rows({ newestFirst: true }).find((r) => r.event === "baton/start" && !r.held)!;
    assert.ok(typeof row.offHours === "number" && row.offHours > Date.now(), "the operator's act went at once, noted off hours");
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
