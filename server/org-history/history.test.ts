// Run: node scripts/run-tests.mjs server/org-history/history.test.ts. Recording, the index and the reads
// over test-fixture.ts's history.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { HISTORY_BOUNDS, type HistoryInput } from "../../shared/org-history";
import { fixture, MARK, WORD_MARKS, P_A, P_B, type Fixture } from "./test-fixture";
import { OrgHistory } from "./service";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
async function fx(): Promise<Fixture> {
  const f = await fixture();
  open.push(f);
  return f;
}

const operator = { role: "operator" } as const;
const segText = (f: Fixture) =>
  readdirSync(join(f.workspaceDir, "history", "events"))
    .map((n) => readFileSync(join(f.workspaceDir, "history", "events", n), "utf8"))
    .join("");
const plain = (kind: HistoryInput["kind"], key: string, more: Partial<HistoryInput> = {}): HistoryInput => ({ kind, outcome: "done", projects: { primary: P_A }, actors: {}, source: { adapter: "t", version: 1, key }, ...more });

describe("recording", () => {
  test("ids are he_ + 32 hex; one source key records once; structural lines hold no words", async () => {
    const f = await fx();
    for (const id of Object.values(f.ids)) assert.match(id, /^he_[0-9a-f]{32}$/);
    assert.equal(new Set(Object.values(f.ids)).size, Object.keys(f.ids).length);
    assert.deepEqual(await f.host.record([plain("request.made", "e1")]), [f.ids["E1"]]);
    const text = segText(f);
    for (const m of WORD_MARKS) assert.ok(!text.includes(m), `${m} is not in an event line`);
    assert.ok(!text.includes("Weekly approved CSV") && !text.includes("Bank sync deferred"));
    // an actor's extra field (a contact) is never copied
    const e6 = JSON.parse(text.split("\n").find((l) => l.includes(f.ids["E6"]!))!);
    assert.deepEqual(e6.actors.decidedBy, { kind: "person", id: "priya" });
    assert.equal(e6.source.key, "decision:s1:m6");
    assert.deepEqual(e6.triggeredBy, [{ event: f.ids["E2"], via: "spawn" }]);
    assert.ok(existsSync(join(f.workspaceDir, "history", "rationale", `${f.ids["E6"]}.json`)));
  });

  test("links: an unknown trigger or relation is refused and noted; an optional key that resolves to nothing is left out", async () => {
    const f = await fx();
    const [id] = await f.host.record([
      plain("gap.filed", "x1", {
        triggeredBy: [{ event: "he_00000000000000000000000000000000", via: "request" }],
        parentKeys: [{ key: "nope", via: "timer" }, { key: "maybe", via: "timer", optional: true }],
        relations: [{ type: "supports", target: { event: "he_11111111111111111111111111111111" } }],
      }),
    ]);
    const d = f.host.history.event(operator, id!)!;
    assert.deepEqual(d.record?.triggeredBy, []);
    assert.deepEqual(
      d.refusedLinks.map((l) => [l.target, l.as, l.why]),
      [
        ["he_00000000000000000000000000000000", "triggeredBy", "no-such-event"],
        ["nope", "triggeredBy", "no-such-event"],
        ["he_11111111111111111111111111111111", "supports", "no-such-event"],
      ],
    );
    assert.equal(d.triggeredBy.length, 0);
  });

  test("a malformed input is a save failure: nothing is written", async () => {
    const f = await fx();
    const before = segText(f);
    await assert.rejects(f.host.record([{ ...plain("request.made", "bad"), kind: "nope" as never }]), /History can't be saved right now: A history record is malformed/);
    assert.equal(segText(f), before);
  });
});

describe("the index", () => {
  test("rebuilt from the event files, it answers every read the same", async () => {
    const f = await fx();
    const reads = (h: OrgHistory) =>
      JSON.stringify([
        h.search(operator, {}),
        h.search(operator, { projects: [P_A], text: "ledger" }),
        h.event(operator, f.ids["E6"]!),
        h.trace(operator, f.ids["E6"]!),
        h.packet(operator, { event: f.ids["E6"]! }),
      ]).replace(/"rebuiltAt":(null|\d+)/g, "");
    const live = reads(f.host.history);
    await f.host.close();
    rmSync(join(f.stateDir, "org-history", "o1", "index.json"), { force: true });
    const h = new OrgHistory("o1", f.workspaceDir, f.stateDir, () => f.now.t);
    h.open();
    assert.equal(reads(h), live);
    h.close();
    open.splice(0);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("an appended line is read incrementally; an unreadable one is kept and shown in its place; an id conflict is surfaced", async () => {
    const f = await fx();
    const seg = join(f.workspaceDir, "history", "events", readdirSync(join(f.workspaceDir, "history", "events"))[0]!);
    const e1 = readFileSync(seg, "utf8").split("\n").find((l) => l.includes(f.ids["E1"]!))!;
    appendFileSync(seg, `{"v":2,"id":"he_22222222222222222222222222222222","times":{"recordedAt":${f.now.t + 1}}}\n`);
    appendFileSync(seg, `${e1.replace('"outcome":"done"', '"outcome":"failed"')}\n`);
    const page = f.host.history.search(operator, {});
    assert.equal(page.items[0]?.kind, "unsupported");
    assert.equal(page.items[0]?.headline, "This event can't be read by this version.");
    const cov = f.host.history.coverage(operator);
    assert.ok(cov.problems.some((p) => p.kind === "unreadable"));
    assert.ok(cov.problems.some((p) => p.kind === "id-conflict" && p.event === f.ids["E1"]));
    assert.equal(f.host.history.event(operator, f.ids["E1"]!)?.event.outcome, "done", "the first record is shown");
    // the file was never rewritten
    assert.ok(readFileSync(seg, "utf8").includes('"v":2'));
  });
});

describe("reads", () => {
  test("search: newest first, filters, words, Show Details grouping, paging with a cursor and the total", async () => {
    const f = await fx();
    const all = f.host.history.search(operator, {});
    assert.deepEqual(
      all.items.map((i) => i.id),
      ["Z", "E9", "E7", "E6", "E2", "E1", "E0"].map((k) => f.ids[k]),
      "E8 is grouped under E7",
    );
    assert.equal(all.items.find((i) => i.id === f.ids["E7"])?.group?.count, 1);
    assert.deepEqual(f.host.history.search(operator, { groupOf: f.ids["E7"] }).items.map((i) => i.id), [f.ids["E8"]]);
    assert.deepEqual(f.host.history.search(operator, { text: "ledger export" }).items.map((i) => i.id).sort(), [f.ids["E0"], f.ids["E6"]].sort());
    assert.deepEqual(f.host.history.search(operator, { kinds: ["decision.recorded"] }).items.map((i) => i.outcome), ["deferred"]);
    assert.deepEqual(f.host.history.search(operator, { initiation: ["unknown"] }).items.map((i) => i.id).sort(), [f.ids["E0"], f.ids["E9"]].sort());
    const p1 = f.host.history.search(operator, { limit: 3 });
    assert.equal(p1.total, 7);
    const p2 = f.host.history.search(operator, { limit: 3, cursor: p1.cursor! });
    const p3 = f.host.history.search(operator, { limit: 3, cursor: p2.cursor! });
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.id), all.items.map((i) => i.id));
    assert.equal(p3.cursor, null);
    assert.ok(f.host.history.search(operator, { limit: 500 }).items.length <= HISTORY_BOUNDS.searchHits);
    // a project filter keeps what the project owns or affects, and counts what links reach outside it
    const a = f.host.history.search(operator, { projects: [P_A] });
    assert.ok(a.items.every((i) => i.project?.id === P_A || i.affected.some((x) => x.id === P_A)));
    assert.equal(a.linkedOutside, 2, "E0 and E9");
    assert.equal(f.host.history.search(operator, {}).linkedOutside, undefined);
  });

  test("a deferral: its options with labels, its reason recorded at the time, who is five facts, and supersession as of a time", async () => {
    const f = await fx();
    const d = f.host.history.event(operator, f.ids["E6"]!)!;
    assert.equal(d.event.headline, "Bank sync deferred for Q1");
    assert.equal(d.event.reasonState, "recorded");
    assert.equal(d.event.disposition, "defer");
    assert.deepEqual(d.options.map((o) => [o.id, o.outcome, o.label]), [
      ["csv", "selected", "Weekly approved CSV"],
      ["bank", "deferred", "Direct bank API"],
      ["manual", "rejected", `Manual entry ${MARK.aOption}`],
    ]);
    const who = d.event.actors!;
    assert.deepEqual([who.initiatedBy, who.decidedBy, who.recordedBy].map((a) => ("label" in a ? a.label : "unknown")), ["Operator", "A person", "opus-5.5"]);
    assert.deepEqual(d.triggeredBy.map((l) => [l.event.id, l.via]), [[f.ids["E2"], "spawn"]]);
    assert.deepEqual(d.resultedIn.map((l) => l.event.id), [f.ids["E7"]]);
    assert.deepEqual(d.related.map((l) => [l.type, l.event.id]), [["depends-on", f.ids["E0"]]]);
    assert.deepEqual(d.evidence.map((e) => [e.ref.kind, e.availability]), [["transcript", "unchecked"], ["event", "available"]]);
    const before = f.now.t;
    f.now.t += 60_000;
    const [e10] = await f.host.record([
      plain("decision.recorded", "decision:s2:m1", { outcome: "chosen", relations: [{ type: "supersedes", target: { event: f.ids["E6"]! } }], decision: { disposition: "choose", options: [{ id: "bank", outcome: "selected" }], authority: { unknown: true } } }),
    ]);
    assert.equal(f.host.history.event(operator, f.ids["E6"]!)!.event.superseded?.by, e10);
    assert.equal(f.host.history.event(operator, f.ids["E6"]!, { asOf: before })!.event.superseded, undefined, "as of before it, nothing superseded it");
    assert.equal(f.host.history.search(operator, { asOf: before }).total, 7);
  });

  test("an unknown actor is never filled in, and an event with no trigger or reason says so", async () => {
    const f = await fx();
    const s = f.host.history.event(operator, f.ids["E0"]!)!.event;
    assert.deepEqual(s.actors?.initiatedBy, { unknown: true });
    assert.equal(s.initiation, "unknown");
    const e1 = f.host.history.event(operator, f.ids["E1"]!)!;
    assert.equal(e1.event.reasonState, "not-recorded");
    const p = f.host.history.packet(operator, { event: f.ids["E1"]! })!;
    assert.match(p.text, /Trigger not recorded/);
    assert.match(p.text, /Reason not recorded/);
  });

  test("a correction is a later event: reads as of before it see the projects as recorded", async () => {
    const f = await fx();
    const before = f.now.t;
    f.now.t += 60_000;
    await f.host.record([plain("correction.recorded", "c1", { about: f.ids["E2"]!, correction: { projects: { primary: P_B, affected: [] } } })]);
    assert.equal(f.host.history.event(operator, f.ids["E2"]!)!.event.project?.id, P_B);
    assert.equal(f.host.history.event(operator, f.ids["E2"]!, { asOf: before })!.event.project?.id, P_A);
    assert.ok(f.host.history.search(operator, { projects: [P_B] }).items.some((i) => i.id === f.ids["E2"]));
    assert.deepEqual(f.host.history.event(operator, f.ids["E2"]!)!.later.map((l) => l.kind), ["correction.recorded"]);
  });

  test("trace: causes and consequences, every edge labelled, at most 2 hops with what was left out and a cursor", async () => {
    const f = await fx();
    const c = f.host.history.trace(operator, f.ids["E6"]!)!;
    const hop = Object.fromEntries(c.nodes.map((n) => [n.id, n.hop]));
    assert.equal(hop[f.ids["E2"]!], -1);
    assert.equal(hop[f.ids["E1"]!], -2);
    assert.equal(hop[f.ids["E7"]!], 1);
    assert.equal(hop[f.ids["E8"]!], 2);
    assert.equal(hop[f.ids["E0"]!], -1, "the dependency, as a relation");
    assert.ok(!(f.ids["E9"]! in hop), "3 hops away");
    assert.deepEqual(c.omitted, { before: 0, after: 1 });
    assert.ok(c.cursor);
    assert.ok(c.edges.every((e) => (e.via == null) !== (e.type == null)));
    assert.ok(c.edges.some((e) => e.type === "depends-on" && e.to === f.ids["E0"]));
    assert.deepEqual(c.noTrigger.sort(), [f.ids["E0"], f.ids["E1"]].sort());
    const more = f.host.history.trace(operator, f.ids["E6"]!, { cursor: c.cursor! })!;
    assert.ok(more.nodes.some((n) => n.id === f.ids["E9"]));
    assert.ok(f.host.history.trace(operator, f.ids["E6"]!, { limit: 3 })!.nodes.length <= 3);
  });

  test("trace: recorded relations are walked too, within the bounds; each edge and node says cause or relation", async () => {
    const f = await fx();
    const E6 = f.ids["E6"]!;
    const [r1] = await f.host.record([plain("gathering.started", "r1", { relations: [{ type: "named-target", target: { event: E6 } }] })]);
    const [r2] = await f.host.record([plain("decision.recorded", "r2", { relations: [{ type: "recorded-in", target: { event: r1! } }] })]);
    const c = f.host.history.trace(operator, f.ids["E2"]!)!;
    const node = Object.fromEntries(c.nodes.map((n) => [n.id, n]));
    assert.equal(node[E6]?.hop, 1);
    assert.equal(node[E6]?.reached, "cause", "reached by its trigger");
    assert.equal(node[r1!]?.hop, 2, "walked through the relation");
    assert.equal(node[r1!]?.reached, "relation", "reached through a relation: never a cause");
    assert.equal(node[f.ids["E1"]!]?.reached, "cause");
    assert.equal(node[f.ids["E2"]!]?.reached, undefined, "the root");
    assert.ok(!(r2! in node), "3 hops away");
    assert.ok(c.omitted.after >= 1);
    const edge = (from: string, to: string) => c.edges.find((e) => e.from === from && e.to === to);
    assert.deepEqual(edge(r1!, E6), { from: r1, to: E6, type: "named-target", link: "relation" });
    assert.deepEqual(edge(f.ids["E2"]!, E6), { from: f.ids["E2"], to: E6, via: "spawn", link: "cause" });
    assert.ok(c.edges.every((e) => (e.link === "cause") === (e.via != null) && (e.link === "relation") === (e.type != null)));
    // from the decision back: the relations walked to the gap's chain, each a relation
    const back = f.host.history.trace(operator, r2!)!;
    const bn = Object.fromEntries(back.nodes.map((n) => [n.id, n]));
    assert.deepEqual([bn[r1!]?.hop, bn[r1!]?.reached, bn[E6]?.hop, bn[E6]?.reached], [-1, "relation", -2, "relation"]);
  });

  test("packet: deterministic, within 12,000 characters, with what was cut, and no model call", async () => {
    const f = await fx();
    const a = f.host.history.packet(operator, { event: f.ids["E6"]! })!;
    const b = f.host.history.packet(operator, { event: f.ids["E6"]! })!;
    assert.equal(a.text, b.text);
    assert.match(a.text, /Bank sync deferred for Q1 — Deferred/);
    assert.match(a.text, /Direct bank API/);
    assert.match(a.text, /No superseding decision recorded/);
    assert.match(a.text, /not instructions/);
    // many events: the packet stays within its bound and says what it cut
    const many: HistoryInput[] = Array.from({ length: 60 }, (_, i) => plain("request.made", `bulk${i}`, { rationale: { what: `Bulk request ${i}`, reason: { text: "x".repeat(400), author: { unknown: true }, contemporaneous: true } } }));
    await f.host.record(many);
    const p = f.host.history.packet(operator, { query: { kinds: ["request.made"] } })!;
    assert.ok(p.text.length <= HISTORY_BOUNDS.packetChars, `${p.text.length}`);
    assert.ok(p.omitted.events > 0 && p.omitted.chars > 0);
    assert.match(p.text, /Cut: \d+ event\(s\)/);
  });

  test("purge: the rationale file and every index copy of its words go; the purge event holds no words", async () => {
    const f = await fx();
    assert.equal(f.host.history.search(operator, { text: MARK.aReason }).total, 1);
    await f.host.purgeRationale(f.ids["E6"]!, { kind: "operator" });
    assert.ok(!existsSync(join(f.workspaceDir, "history", "rationale", `${f.ids["E6"]}.json`)));
    assert.equal(f.host.history.search(operator, { text: MARK.aReason }).total, 0);
    assert.ok(!readFileSync(join(f.stateDir, "org-history", "o1", "index.json"), "utf8").includes(MARK.aReason));
    assert.equal(f.host.history.event(operator, f.ids["E6"]!)!.event.reasonState, "purged");
    const purge = f.host.history.search(operator, { kinds: ["rationale.purged"] }).items[0]!;
    assert.equal(f.host.history.event(operator, purge.id)!.rationale, null);
    await assert.rejects(f.host.purgeRationale(f.ids["E6"]!, { kind: "operator" }), /already purged/);
  });
});
