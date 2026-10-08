// Run: node scripts/run-tests.mjs server/org-history-annotations.test.ts. The operator's notes and corrections
// on the history: their own request only (the Overseer's header refused, no model tool writes), a new event
// about the one named, written through the org host's journal and answered once saved, recorded once per
// request id; the original untouched, and who may read a corrected event decided by its projects now.
// A throwaway agent dir and workspace in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { RELATION_TYPES, type HistoryEvent, type HistoryInput, type HistoryReader } from "../shared/org-history";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-notes-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const engine = await import("./org-engine");
const tools = await import("./org-history-tools");
const { registerOrgHistoryAnnotationRoutes, NOT_OPERATOR } = await import("./org-history-annotations");
const { registerOrgHistoryRoutes } = await import("./org-history-routes");
const { OVERSEER_SENDER_HEADER } = await import("./overseer-sender");
const { settled } = await import("./workspace-git");

const locked: string[] = [];
after(async () => {
  for (const d of locked.splice(0)) chmodSync(d, 0o755);
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const app = new Hono();
registerOrgHistoryRoutes(app);
registerOrgHistoryAnnotationRoutes(app);
const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};
const OP: HistoryReader = { role: "operator" };
const PHONE = "+90 555 987 6543";

describe("the operator's notes and corrections", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  const other = await orgs.createOrg({ name: "Other", dir: join(tmp, "ws2") });
  mkdirSync(join(tmp, "a"));
  mkdirSync(join(tmp, "b"));
  const pa = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "a") });
  const pb = await orgs.addProject(org.id, { name: "Ledger", root: join(tmp, "b") });
  await orgs.addPerson(org.id, { name: "Priya Shah", role: "Finance", contact: { whatsapp: PHONE } });
  const host = engine.hostOf(org.id);
  const h = host.history;
  const ev = (key: string, project: string, more: Partial<HistoryInput> = {}): HistoryInput => ({
    kind: "decision.recorded",
    outcome: "chosen",
    projects: { primary: project },
    actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "person", id: "p_x" }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } },
    source: { adapter: "notes-test", version: 1, key },
    ...more,
  });
  const [target, purgeable] = await host.record([ev("t1", pa.id, { rationale: { what: "Weekly CSV chosen" } }), ev("t2", pa.id, { rationale: { what: "w", reason: { text: "r", author: { kind: "operator" }, contemporaneous: true } } })]);
  const eventsDir = join(orgs.orgDir(org.id), "history", "events");
  const rows = () => readdirSync(eventsDir).map((f) => readFileSync(join(eventsDir, f), "utf8")).join("");
  const rowOf = (id: string): string => rows().split("\n").find((l) => l.includes(`"id":"${id}"`))!;
  const recordOf = (id: string) => JSON.parse(rowOf(id)) as HistoryEvent;
  const url = (eid: string, what: "annotate" | "correct", o = org.id) => `/api/orgs/${o}/history/events/${eid}/${what}`;
  const original = rowOf(target!);

  test("a note: its own event about the target, the operator's, Added later, no cause; the words only in its rationale", async () => {
    const r = await call(url(target!, "annotate"), { requestId: "note-0001", what: "Why weekly", reason: "Finance asked for weekly ZEBRA." });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.replayed, false);
    const e = recordOf(r.json.event);
    assert.equal(e.kind, "annotation.added");
    assert.equal(e.about, target);
    assert.deepEqual(e.triggeredBy, []);
    assert.deepEqual(e.relations, []);
    assert.deepEqual(e.actors, { initiatedBy: { kind: "operator" }, decidedBy: { kind: "operator" }, recordedBy: { kind: "operator" }, executedBy: { kind: "sova" }, authorization: { kind: "operator-act" } });
    assert.deepEqual(e.projects, { primary: pa.id, affected: [] });
    assert.ok(!rows().includes("ZEBRA"), "the words are not in a structural row");
    // it links back to the event it is about: an `about` relation in its detail, the target's and the trace
    const mine = h.event(OP, r.json.event)!;
    assert.ok(mine.related.some((l) => l.type === "about" && l.direction === "out" && l.event.id === target), JSON.stringify(mine.related));
    assert.ok(h.event(OP, target!)!.related.some((l) => l.type === "about" && l.direction === "in" && l.event.id === r.json.event));
    assert.ok(h.trace(OP, r.json.event)!.edges.some((x) => x.from === r.json.event && x.to === target && x.type === "about" && x.link === "relation"));
    assert.ok(RELATION_TYPES.includes("about"));
    const d = h.event(OP, target!)!;
    assert.ok(d.later.some((l) => l.id === e.id));
    assert.equal(d.event.reasonState, "added-later");
    assert.equal(h.event(OP, e.id)!.rationale?.reason?.contemporaneous, false);
    assert.equal(rowOf(target!), original, "the original is untouched");
  });

  test("never the Overseer and never a model: its header is refused, and the models' history tools only read", async () => {
    const before = rows();
    const a = await call(url(target!, "annotate"), { requestId: "note-ovr01", what: "x", reason: "y" }, { [OVERSEER_SENDER_HEADER]: "anything" });
    assert.deepEqual([a.status, a.json.error], [403, NOT_OPERATOR.annotate]);
    const c = await call(url(target!, "correct"), { requestId: "corr-ovr01", what: "x", reason: "y" }, { [OVERSEER_SENDER_HEADER]: "" });
    assert.deepEqual([c.status, c.json.error], [403, NOT_OPERATOR.correct]);
    assert.equal(rows(), before, "nothing written");
    // the tools a model gets: read actions and its own decision only, nothing that annotates or corrects
    const ctx = { engine: org.id, projectId: pa.id, attended: () => true, overseerId: () => "c1", effective: () => ({ autonomy: "L3" }), envelope: () => engine.envelopeFor(org.id, pa.id, { by: "overseer", attended: true }), read: (r: any) => (_: string, p: any) => r(p ?? {}), act: (_n: string, r: any) => (id: string, p: any) => r(p ?? {}, id), heldText: () => "" } as never;
    const specs = [...tools.historyTools(org.id, ctx).map((t) => ({ name: t.name, params: t.parameters as any })), { name: "sova_org_history", params: tools.orgHistoryParams() as any }];
    assert.deepEqual(specs.map((s) => s.name).sort(), ["sova_decide", "sova_history", "sova_org_history"]);
    for (const s of specs) {
      const keys = Object.keys(s.params.properties ?? {});
      assert.ok(!keys.some((k) => /annotat|correct|note|about|purge/i.test(k)), `${s.name}: no field that annotates or corrects (${keys})`);
      const actions: string[] = s.params.properties?.action?.enum ?? [];
      assert.ok(actions.every((a) => ["search", "event", "trace", "packet"].includes(a)), `${s.name}: read actions only (${actions})`);
    }
  });

  test("the target must be an event of this organization", async () => {
    const before = rows();
    const wrong = await call(url(target!, "annotate", other.id), { requestId: "note-wrong1", what: "x", reason: "y" });
    assert.deepEqual([wrong.status, wrong.json.error], [404, "No such event in this organization."]);
    const none = await call(url("he_00000000000000000000000000000000", "correct"), { requestId: "corr-none01", what: "x", reason: "y" });
    assert.equal(none.status, 404);
    assert.equal((await call(url(target!, "annotate", "org_nope"), { requestId: "note-nope01", what: "x", reason: "y" })).status, 404);
    assert.equal(rows(), before);
  });

  test("the same request id records it once; reused for another note it is refused", async () => {
    const body = { requestId: "note-twice1", what: "Twice", reason: "Once only." };
    const one = await call(url(target!, "annotate"), body);
    const two = await call(url(target!, "annotate"), body);
    assert.equal(two.status, 200);
    assert.equal(two.json.event, one.json.event);
    assert.equal(two.json.replayed, true);
    assert.equal(rows().split("\n").filter((l) => l.includes(`"key":"note:note-twice1"`)).length, 1);
    const elsewhere = await call(url(purgeable!, "annotate"), body);
    assert.deepEqual([elsewhere.status, elsewhere.json.error], [409, "That requestId was already used for another note; send a new one."]);
  });

  test("the same correction again replays, though its projects are already the corrected ones", async () => {
    const [moved] = await host.record([ev("t3", pa.id)]);
    const body = { requestId: "corr-twice1", what: "Wrong project", reason: "Ledger's.", projects: { primary: pb.id } };
    const one = await call(url(moved!, "correct"), body);
    assert.equal(one.status, 200, JSON.stringify(one.json));
    const two = await call(url(moved!, "correct"), body);
    assert.deepEqual([two.status, two.json.event, two.json.replayed], [200, one.json.event, true], JSON.stringify(two.json));
  });

  test("the same request id and target with other words is refused, never replayed", async () => {
    const body = { requestId: "note-words1", what: "First words", reason: "Kept." };
    const one = await call(url(target!, "annotate"), body);
    assert.equal(one.status, 200);
    const what = await call(url(target!, "annotate"), { ...body, what: "Other words" });
    assert.deepEqual([what.status, what.json.error], [409, "That requestId was already used for another note; send a new one."]);
    const reason = await call(url(target!, "annotate"), { ...body, reason: "Changed." });
    assert.equal(reason.status, 409);
    const same = await call(url(target!, "annotate"), body);
    assert.deepEqual([same.status, same.json.event, same.json.replayed], [200, one.json.event, true]);
    // its words purged: nothing to compare against, so refused
    await host.record([h.purgeInput(one.json.event, { kind: "operator" })]);
    const purged = await call(url(target!, "annotate"), body);
    assert.equal(purged.status, 409);
  });

  test("refusals: no request id, no what, no reason, an unknown project or field, the projects it already has, a gap or a purge", async () => {
    const bad = async (what: "annotate" | "correct", body: unknown, status: number, error: string, eid = target!) => {
      const r = await call(url(eid, what), body);
      assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
    };
    await bad("annotate", { what: "x", reason: "y" }, 400, "Give a requestId (8–64 letters, digits, - or _).");
    await bad("annotate", { requestId: "short", what: "x", reason: "y" }, 400, "Give a requestId (8–64 letters, digits, - or _).");
    await bad("annotate", { requestId: "note-bad01", reason: "y" }, 400, "Say what the note covers: { what }.");
    await bad("correct", { requestId: "corr-bad01", what: "x" }, 400, "A correction says why: give its reason.");
    await bad("correct", { requestId: "corr-bad02", what: "x", reason: "y", projects: { primary: "prj_nope" } }, 400, "prj_nope is not a project of this organization.");
    await bad("correct", { requestId: "corr-bad03", what: "x", reason: "y", projects: { primary: pa.id } }, 400, "Those are already its projects.");
    await bad("annotate", { requestId: "note-bad02", what: "x", reason: "y", projects: { primary: pa.id } }, 400, "Unknown field projects: give requestId, what, reason.");
    const [purge] = await host.record([h.purgeInput(purgeable!, { kind: "operator" })]);
    await bad("annotate", { requestId: "note-bad03", what: "x", reason: "y" }, 409, "A purge can't be annotated or corrected.", purge!);
  });

  test("a correction corrects the event, applies from when it was recorded, and changes nothing else", async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const snapshot = JSON.stringify(host.data(`placement/${org.id}/${pa.id}`));
    const r = await call(url(target!, "correct"), { requestId: "corr-move01", what: "Wrong project", reason: "It was the ledger's decision.", projects: { primary: pb.id } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = recordOf(r.json.event);
    assert.equal(c.kind, "correction.recorded");
    assert.deepEqual(c.relations, [{ type: "corrects", target: { event: target } }]);
    assert.deepEqual(c.correction, { projects: { primary: pb.id, affected: [] } });
    assert.deepEqual(c.triggeredBy, []);
    assert.equal(rowOf(target!), original, "the corrected event's record is byte-for-byte as recorded");
    assert.equal(h.event(OP, target!)!.event.project?.id, pb.id);
    assert.equal(h.event(OP, target!, { asOf: t0 })!.event.project?.id, pa.id, "as of before it: the original");
    assert.ok(h.search(OP, { projects: [pb.id], kinds: ["decision.recorded"] }).items.some((i) => i.id === target));
    assert.equal(JSON.stringify(host.data(`placement/${org.id}/${pa.id}`)), snapshot, "no statechart touched");
    assert.ok(RELATION_TYPES.includes("corrects"));
  });

  test("who may read a corrected event is decided by its projects now, whatever time the read asks as of", async () => {
    // the target now belongs to pb (the correction above); before it, pa
    const asOf = recordOf(target!).times.recordedAt + 1;
    const pa_: HistoryReader = { role: "project-overseer", project: pa.id };
    const pb_: HistoryReader = { role: "project-overseer", project: pb.id };
    const labels = tools.modelLabels(org.id);
    assert.equal(h.event(pa_, target!, { asOf }, labels), null, "pa's overseer can't read it by asking as of an earlier time");
    assert.ok(!h.search(pa_, { asOf }, labels).items.some((i) => i.id === target));
    assert.equal(h.trace(pa_, target!, { asOf }, labels), null);
    assert.ok(h.event(pb_, target!, {}, labels));
  });

  test("a correction (and a note) is read exactly where the event it is about is read now: search, detail, trace, packet and counts", async () => {
    const corr = h.event(OP, target!)!.later.find((l) => l.kind === "correction.recorded")!.id;
    const pa_: HistoryReader = { role: "project-overseer", project: pa.id };
    const pb_: HistoryReader = { role: "project-overseer", project: pb.id };
    const labels = tools.modelLabels(org.id);
    // the event was corrected into pb: pb's overseer reads what the correction says
    const d = h.event(pb_, corr, {}, labels)!;
    assert.ok(d, "pb reads the correction");
    assert.equal(d.event.project?.id, pb.id, "it reads as the corrected event's project");
    assert.equal(d.rationale?.what, "Wrong project");
    assert.ok(h.search(pb_, {}, labels).items.some((i) => i.id === corr));
    assert.ok(h.search(OP, { projects: [pb.id], kinds: ["correction.recorded"] }).items.some((i) => i.id === corr), "the pb filter lists it");
    const t = h.trace(pb_, target!, {}, labels)!;
    assert.ok(t.nodes.some((n) => n.id === corr && !n.boundary), "in its trace in full, not a boundary card");
    assert.ok(h.packet(pb_, { event: corr }, labels)!.events.includes(corr));
    assert.ok(h.packet(pb_, { event: target! }, labels)!.text.includes("Wrong project"));
    const before = h.search(pb_, { kinds: ["correction.recorded"] }, labels).total;
    assert.ok(before >= 1);
    // pa no longer reads the event, so neither what was added about it
    assert.equal(h.event(pa_, corr, {}, labels), null);
    assert.ok(!h.search(pa_, {}, labels).items.some((i) => i.id === corr));
    assert.equal(h.search(pa_, { kinds: ["correction.recorded"] }, labels).total, 0);
  });

  test("a note's words reach a model reader only where the event may be read, contact scrubbed", async () => {
    const r = await call(url(target!, "annotate"), { requestId: "note-priv01", what: "Called Priya", reason: `Call her on ${PHONE} MARKWORD.` });
    assert.equal(r.status, 200);
    const pb_: HistoryReader = { role: "project-overseer", project: pb.id };
    const pa_: HistoryReader = { role: "project-overseer", project: pa.id };
    const seen = JSON.stringify(h.event(pb_, r.json.event, {}, tools.modelLabels(org.id)));
    assert.ok(seen.includes("MARKWORD") && !seen.includes(PHONE), "readable where its event is, contact scrubbed");
    assert.equal(h.event(pa_, r.json.event, {}, tools.modelLabels(org.id)), null);
    assert.ok(!h.search(pa_, { text: "MARKWORD" }, tools.modelLabels(org.id)).items.length, "another project's overseer can't find it by its words");
    assert.equal(h.search(pa_, { text: "MARKWORD" }, tools.modelLabels(org.id)).total, 0);
  });

  test("history can't be saved (its journal can't be written): no answer of success, nothing recorded; once it can, the same request records once", async () => {
    const before = rows();
    const journal = host.paths.journal;
    mkdirSync(journal, { recursive: true });
    chmodSync(journal, 0o500);
    locked.push(journal);
    const body = { requestId: "note-fail01", what: "x", reason: "y" };
    const r = await call(url(target!, "annotate"), body);
    chmodSync(journal, 0o755);
    locked.splice(locked.indexOf(journal), 1);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.code, "history");
    assert.equal(r.json.event, undefined);
    assert.equal(rows(), before, "nothing recorded");
    const again = await call(url(target!, "annotate"), body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(rows().split("\n").filter((l) => l.includes(`"key":"note:note-fail01"`)).length, 1);
  });

  // last: it leaves the host waiting for a reload
  test("saved in its journal but not applied: the answer an act gets (pending-apply), never an event id", async () => {
    const files = readdirSync(eventsDir).map((f) => join(eventsDir, f));
    for (const f of files) chmodSync(f, 0o400);
    chmodSync(eventsDir, 0o500);
    locked.push(eventsDir, ...files);
    const r = await call(url(target!, "annotate"), { requestId: "note-pend01", what: "x", reason: "y" });
    assert.deepEqual([r.status, r.json.code, r.json.event], [409, "pending-apply", undefined], JSON.stringify(r.json));
  });
});
