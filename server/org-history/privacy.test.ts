// Run: node scripts/run-tests.mjs server/org-history/privacy.test.ts. The marker test of
// the history readers: each reader runs every read, and a private marker is found only where that
// reader may see it. A project overseer reads its own project in full and another project's linked
// event as a boundary card only (kind, outcome, time, project); a withheld event is neither counted nor
// hinted at; contact never reaches a model reader.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { HistoryReader } from "../../shared/org-history";
import { contactRedactor } from "../overseer-org-view";
import type { HistoryLabels } from "./query";
import { fixture, MARK, WORD_MARKS, P_A, P_B, type Fixture } from "./test-fixture";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

const labels: HistoryLabels = {
  project: (id) => ({ name: id === P_A ? "Investor portal" : id === P_B ? "Finance ledger" : id }),
  person: (id) => (id === "priya" ? "Priya" : null),
  scrub: (t) => t.split(MARK.contact).join("[contact]"),
  sessionProject: (session) => (session === "s1" ? P_A : session === MARK.otherSession ? P_B : null),
};

/** Every read a reader can make, as one string. */
function everything(f: Fixture, reader: HistoryReader): string {
  const h = f.host.history;
  const ids = Object.values(f.ids);
  return JSON.stringify([
    h.search(reader, {}, labels),
    h.search(reader, { projects: [P_A] }, labels),
    h.search(reader, { projects: [P_B] }, labels),
    h.search(reader, { text: "ledger" }, labels),
    h.search(reader, { groupOf: f.ids["E7"]! }, labels),
    ...ids.map((id) => h.event(reader, id, {}, labels)),
    ...ids.map((id) => h.trace(reader, id, {}, labels)),
    ...ids.map((id) => h.packet(reader, { event: id }, labels)),
    h.packet(reader, { query: {} }, labels),
    ...ids.flatMap((id) => [1, 2].map((n) => h.evidence(reader, id, n, undefined, labels))),
    h.coverage(reader),
  ]);
}

test("the operator reads every event and its words; contact stays in its own reads only", async () => {
  const f = await fixture();
  open.push(f);
  const all = everything(f, { role: "operator" });
  for (const m of [MARK.aReason, MARK.aQuote, MARK.aOption, MARK.bReason, MARK.bWhat, MARK.orgWhat, MARK.bChild]) assert.ok(all.includes(m), m);
});

test("the global Overseer reads the whole org, with contact scrubbed from every text", async () => {
  const f = await fixture();
  open.push(f);
  const all = everything(f, { role: "global-overseer" });
  for (const m of [MARK.aReason, MARK.aQuote, MARK.bReason, MARK.orgWhat]) assert.ok(all.includes(m), m);
  assert.ok(!all.includes(MARK.contact), "contact never enters a model reader's result");
});

test("a project overseer: its own project in full, another's linked event as a card, nothing else, nothing counted", async () => {
  const f = await fixture();
  open.push(f);
  const reader = { role: "project-overseer", project: P_A } as const;
  const all = everything(f, reader);
  for (const m of [MARK.aReason, MARK.aQuote, MARK.aOption]) assert.ok(all.includes(m), `${m}: its own project's words`);
  for (const m of [MARK.bReason, MARK.bWhat, MARK.bChild, MARK.orgWhat, MARK.contact]) assert.ok(!all.includes(m), `${m} never reaches it`);
  const h = f.host.history;
  // counts: only its own events (E1 affects it, E2, E6, E7, E8 under E7)
  const page = h.search(reader, {}, labels);
  assert.deepEqual(page.items.map((i) => i.id).sort(), ["E7", "E6", "E2", "E1"].map((k) => f.ids[k]).sort());
  assert.equal(page.total, 4);
  assert.equal(h.search(reader, { projects: [P_B] }, labels).total, 0);
  // a withheld event can't be opened, traced or packed
  for (const k of ["E0", "E9", "Z"]) {
    assert.equal(h.event(reader, f.ids[k]!, {}, labels), null, k);
    assert.equal(h.trace(reader, f.ids[k]!, {}, labels), null, k);
    assert.equal(h.packet(reader, { event: f.ids[k]! }, labels), null, k);
  }
  // E0 reached from E6 is a card: kind, outcome, time and project, no actors, no reason
  const d = h.event(reader, f.ids["E6"]!, {}, labels)!;
  const card = d.related.find((l) => l.event.id === f.ids["E0"])!.event;
  assert.equal(card.boundary, true);
  assert.equal(card.actors, undefined);
  assert.equal(card.reasonState, "withheld");
  assert.equal(card.headline, "Validation result observed");
  assert.deepEqual(card.project, { id: P_B, name: "Finance ledger" });
  // E1's record names no other project for this reader
  assert.deepEqual(h.event(reader, f.ids["E1"]!, {}, labels)!.record?.projects.affected, []);
  // linked outside its filter: only cards it may see (E0, E9), never the org-level event
  assert.equal(h.search(reader, { projects: [P_A] }, labels).linkedOutside, 2);
  // a trace walks no further than a card
  const c = h.trace(reader, f.ids["E7"]!, {}, labels)!;
  const e9 = c.nodes.find((n) => n.id === f.ids["E9"]);
  assert.equal(e9?.boundary, true);
  assert.equal(c.omitted.after, 0, "nothing past a card is counted");
  // coverage: no problems, no org-wide saving state
  assert.deepEqual(h.coverage(reader).problems, []);
});

test("a project overseer's trace walks relations as far as a boundary card, never past it", async () => {
  const f = await fixture();
  open.push(f);
  const reader = { role: "project-overseer", project: P_A } as const;
  const base = (key: string, primary: string, target: string) => ({ kind: "gathering.started" as const, outcome: "started" as const, projects: { primary }, actors: {}, source: { adapter: "t", version: 1, key }, relations: [{ type: "related" as const, target: { event: target } }] });
  // B1, another project's, relates to E6; A2, its own, is reachable from E6 only through B1
  const [b1] = await f.host.record([base("b1", P_B, f.ids["E6"]!)]);
  const [a2] = await f.host.record([base("a2", P_A, b1!)]);
  const h = f.host.history;
  const c = h.trace(reader, f.ids["E6"]!, {}, labels)!;
  const card = c.nodes.find((n) => n.id === b1);
  assert.equal(card?.boundary, true, "the other project's relation is a card");
  assert.equal(card?.reached, "relation");
  assert.ok(!c.nodes.some((n) => n.id === a2), "nothing past a card, even its own project's");
  assert.equal(c.edges.filter((e) => e.from === a2 || e.to === a2).length, 0);
  // the operator walks on through it
  const op = h.trace({ role: "operator" }, f.ids["E6"]!, {}, labels)!;
  assert.ok(op.nodes.some((n) => n.id === a2 && n.hop === 2 && n.reached === "relation"));
});

test("Show Details counts only what the reader may see", async () => {
  const f = await fixture();
  open.push(f);
  // one step: a promotion, its build in the same project and one in the other, both grouped under it
  f.now.t += 60_000;
  const [p, own, other] = await f.host.record([
    { kind: "promotion.made", outcome: "done", projects: { primary: P_A }, actors: {}, source: { adapter: "t", version: 1, key: "p2" } },
    { kind: "build.started", outcome: "started", projects: { primary: P_A }, actors: {}, source: { adapter: "t", version: 1, key: "b2" }, parentKeys: [{ key: "p2", via: "effect" }] },
    { kind: "build.started", outcome: "started", projects: { primary: P_B }, actors: {}, source: { adapter: "t", version: 1, key: "b3" }, parentKeys: [{ key: "p2", via: "effect" }], rationale: { what: MARK.bChild } },
  ]);
  const pa = { role: "project-overseer", project: P_A } as const;
  const row = f.host.history.search(pa, {}, labels).items.find((i) => i.id === p)!;
  assert.equal(row.group?.count, 1);
  assert.deepEqual(f.host.history.search(pa, { groupOf: p! }, labels).items.map((i) => i.id), [own]);
  assert.equal(f.host.history.search({ role: "operator" }, {}).items.find((i) => i.id === p)!.group?.count, 2);
  assert.ok(!JSON.stringify(f.host.history.search(pa, { groupOf: p! }, labels)).includes(other!));
});

test("the files: structural lines carry no words; the index is host-local", async () => {
  const f = await fixture();
  open.push(f);
  const dir = join(f.workspaceDir, "history", "events");
  const text = readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("");
  for (const m of WORD_MARKS) assert.ok(!text.includes(m), m);
  assert.ok(!readdirSync(join(f.workspaceDir, "history")).includes("index.json"));
});

test("a project overseer's reads name no withheld event, other project's session, person or key, and count only its own", async () => {
  const f = await fixture();
  open.push(f);
  const reader = { role: "project-overseer", project: P_A } as const;
  const all = everything(f, reader);
  assert.ok(!all.includes(f.ids["Z"]!), "the org-level event's id");
  // ids recorded on its own events that name another project's session, a person on a card, a key
  for (const m of [MARK.otherSession, MARK.otherPerson, MARK.otherKey, MARK.otherCommit]) assert.ok(!all.includes(m), m);
  // its own project's citation stays; another project's session and commit don't
  assert.deepEqual(f.host.history.event(reader, f.ids["E2"]!, {}, labels)!.evidence.map((e) => e.ref.n), [3]);
  assert.equal(f.host.history.evidence(reader, f.ids["E2"]!, 1, undefined, labels), null);
  assert.equal(f.host.history.evidence(reader, f.ids["E2"]!, 2, undefined, labels), null);
  assert.equal(f.host.history.event({ role: "operator" }, f.ids["E2"]!)!.evidence.length, 3, "the operator sees every citation");
  // no actor carries another project's overseer id or a session
  const e6 = f.host.history.event(reader, f.ids["E6"]!, {}, labels)!;
  assert.deepEqual(e6.record?.actors.recordedBy, { kind: "model", model: "opus-5.5" }, "no actor session");
  assert.ok(!/"kind":"project-overseer","id":"(?!pA")/.test(all), "no other project's overseer id");
  // freshness and coverage: its own events only, never the org's count or a newer hidden time
  const h = f.host.history;
  const fresh = h.search(reader, {}, labels).freshness;
  assert.equal(fresh.events, 5, "E1, E2, E6, E7, E8");
  assert.equal(fresh.through, h.event(reader, f.ids["E8"]!, {}, labels)!.event.recordedAt);
  assert.ok(fresh.through! < h.event({ role: "operator" }, f.ids["Z"]!)!.event.recordedAt);
  assert.equal(h.search({ role: "operator" }, {}).freshness.events, 8);
  assert.match(h.packet(reader, { event: f.ids["E6"]! }, labels)!.text, /5 events readable here/);
  // the operator still sees what was recorded
  assert.match(JSON.stringify(h.event({ role: "operator" }, f.ids["E2"]!)), new RegExp(MARK.otherSession));
});

test("a model reader's read without scrub fails closed", async () => {
  const f = await fixture();
  open.push(f);
  assert.throws(() => f.host.history.event({ role: "global-overseer" }, f.ids["E6"]!), /needs labels.scrub/);
  assert.throws(() => f.host.history.packet({ role: "project-overseer", project: P_A }, { event: f.ids["E6"]! }), /needs labels.scrub/);
  assert.ok(f.host.history.event({ role: "operator" }, f.ids["E6"]!), "the operator is not a model reader");
});

test("a cited message opened through the reader's sources: its words reach only a reader of the event, scrubbed for a model", async () => {
  const f = await fixture();
  open.push(f);
  // the source's own text is only checked against the stored digest, never returned: only the stored quote is
  const SOURCE_ONLY = "MARKSOURCEONLYTEXT";
  const sources = { transcript: () => ({ state: "available" as const, text: `the whole message ${SOURCE_ONLY}` }) };
  const h = f.host.history;
  for (const reader of [{ role: "operator" }, { role: "global-overseer" }, { role: "project-overseer", project: P_A }, { role: "project-overseer", project: P_B }] as const) {
    const reads = JSON.stringify(
      Object.values(f.ids).flatMap((id) => [h.event(reader, id, {}, labels, sources), h.packet(reader, { event: id }, labels, sources), ...[1, 2, 3].map((n) => h.evidence(reader, id, n, sources, labels))]),
    );
    assert.ok(!reads.includes(SOURCE_ONLY), `${reader.role}: the source text never appears`);
  }
  const op = h.evidence({ role: "operator" }, f.ids["E6"]!, 1, sources)!;
  assert.equal(op.availability, "available");
  assert.ok(op.quote?.includes(MARK.aQuote));
  const po = h.evidence({ role: "project-overseer", project: P_A }, f.ids["E6"]!, 1, sources, labels)!;
  assert.ok(po.quote?.includes(MARK.aQuote) && !po.quote.includes(MARK.contact));
  assert.equal(h.evidence({ role: "project-overseer", project: P_B }, f.ids["E6"]!, 1, sources, labels), null, "another project's overseer gets nothing");
  // an event citation to a withheld event is dropped for that reader
  assert.equal(h.evidence({ role: "project-overseer", project: P_A }, f.ids["E6"]!, 2, sources, labels)?.availability, "available", "E0 is a card it may see");
});


// ---- search matches only what a model reader may read ----------------------------------------------------

const PHONE = "+90 555 123 4567";
const EMAIL = "Lena.Park@acme.example";
const DESK = "contact.desk@acme.example";

/** Labels whose scrub is the product's contact redactor over `values` as they are at each read. */
function contactLabels(values: { now: string[] }): HistoryLabels {
  return { ...labels, scrub: (t) => contactRedactor([MARK.contact, ...values.now].sort((a, b) => b.length - a.length)).text(t) };
}

/** A person's decision in P_A whose quote and reason carry contact values, one glued to a word. */
async function plantContact(f: Fixture): Promise<string> {
  f.now.t += 60_000;
  const [id] = await f.host.record([
    {
      kind: "decision.recorded",
      outcome: "chosen",
      projects: { primary: P_A },
      actors: { decidedBy: { kind: "person", id: "priya" }, recordedBy: { kind: "model", model: "opus-5.5", session: "s1" } },
      source: { adapter: "t", version: 1, key: "decision:s1:contact" },
      decision: { disposition: "choose", options: [], authority: { kind: "person", id: "priya" } },
      evidence: [{ n: 1, kind: "transcript", session: "s1", entry: "u9", speaker: { kind: "person", id: "priya" }, check: "checked" }],
      rationale: {
        what: "Invoices are due net 30 for 555 widgets",
        reason: { text: `Ask the team at ${DESK} or mail:${EMAIL} first`, author: { kind: "person", id: "priya" }, contemporaneous: true },
        quotes: [{ n: 1, text: `Invoices net 30, call me on ${PHONE} or tel905551234567, ref INV905551234567` }],
      },
    },
  ]);
  return id!;
}

const CONTACT_FRAGMENTS = ["4567", "123", "555 123", "lena.park", "905551234567", "Lena", "lena park", "PARK", "acme", "example", "desk", "contact", "mail lena"];

test("a model reader's search matches only its scrubbed words: a contact fragment is no hit, count, packet or linked count", async () => {
  const f = await fixture();
  open.push(f);
  const id = await plantContact(f);
  const values = { now: [PHONE, "905551234567", EMAIL, DESK] };
  const l = contactLabels(values);
  const h = f.host.history;
  const readers = [{ role: "global-overseer" }, { role: "project-overseer", project: P_A }] as const;
  for (const reader of readers) {
    // the event is readable, and its scrubbed words still find it
    // "555" also stands outside the phone, "tel" and "inv" are glued to a digits-only phone
    for (const q of ["invoices net", "due", "ref inv", "tel", "first ask", "555", "555 widgets"]) {
      const page = h.search(reader, { text: q }, l);
      assert.deepEqual(page.items.map((i) => i.id), [id], `${reader.role} "${q}": a word it reads`);
      assert.equal(page.total, 1);
    }
    for (const q of CONTACT_FRAGMENTS) {
      const why = `${reader.role} "${q}"`;
      const page = h.search(reader, { text: q }, l);
      assert.ok(!page.items.some((i) => i.id === id), `${why}: no hit`);
      assert.equal(page.total, page.items.length, `${why}: counted as shown`);
      assert.equal(h.search(reader, { text: q, kinds: ["decision.recorded"] }, l).total, 0, `${why}: no count`);
      assert.equal(h.search(reader, { text: q, projects: [P_A] }, l).linkedOutside, 0, `${why}: nothing linked from a hit`);
      const pk = h.packet(reader, { query: { text: q, kinds: ["decision.recorded"] } }, l)!;
      assert.deepEqual(pk.events, [], `${why}: an empty packet`);
    }
    // what it does read carries no contact
    const read = JSON.stringify([h.search(reader, { text: "invoices" }, l), h.event(reader, id, {}, l), h.packet(reader, { query: { text: "invoices" } }, l)]);
    for (const v of [PHONE, "905551234567", EMAIL, DESK, "Lena", "acme"]) assert.ok(!read.includes(v), `${reader.role}: ${v}`);
  }
  // the operator searches what was recorded
  const op = { role: "operator" } as const;
  for (const q of ["4567", "lena park", "tel905551234567", "desk", "invoices net"]) assert.ok(h.search(op, { text: q }).items.some((i) => i.id === id), `operator "${q}"`);
  assert.equal(h.packet(op, { query: { text: "4567" } })!.events.includes(id), true);
});

test("a model reader's search follows the contacts as they are now, without a rebuild; without a scrub it fails closed", async () => {
  const f = await fixture();
  open.push(f);
  const id = await plantContact(f);
  const values: { now: string[] } = { now: [] };
  const l = contactLabels(values);
  const reader = { role: "global-overseer" } as const;
  const hits = () => f.host.history.search(reader, { text: "4567" }, l).items.map((i) => i.id);
  // not a contact value of anyone: plain recorded words
  assert.deepEqual(hits(), [id]);
  values.now = [PHONE];
  assert.deepEqual(hits(), [], "a phone added to the roster is never matched from then on");
  values.now = [];
  assert.deepEqual(hits(), [id]);
  assert.throws(() => f.host.history.search(reader, { text: "invoices" }), /needs labels.scrub/);
  assert.throws(() => f.host.history.search({ role: "project-overseer", project: P_A }, { text: "invoices" }, {}), /needs labels.scrub/);
  assert.throws(() => f.host.history.packet(reader, { query: { text: "invoices" } }), /needs labels.scrub/);
});

test("a project's or person's name that holds a contact value reaches a model reader scrubbed, the operator as named", async () => {
  const f = await fixture();
  open.push(f);
  const named: HistoryLabels = {
    ...labels,
    project: (id) => ({ name: id === P_A ? `Investor portal ${MARK.contact}` : id === P_B ? `Finance ledger ${MARK.contact}` : id }),
    person: (id) => (id === "priya" ? `Priya ${MARK.contact}` : null),
  };
  const h = f.host.history;
  const e6 = f.ids["E6"]!;
  const reads = (reader: HistoryReader, l?: HistoryLabels) => {
    const d = h.event(reader, e6, {}, l)!;
    // the boundary card of the other project's E0, reached from E6
    const card = d.related.find((x) => x.event.id === f.ids["E0"])!.event;
    return { card, all: JSON.stringify([h.search(reader, {}, l), d, h.trace(reader, e6, {}, l), h.packet(reader, { event: e6 }, l), h.packet(reader, { query: {} }, l)]) };
  };
  for (const reader of [{ role: "project-overseer", project: P_A }, { role: "global-overseer" }] as const) {
    const { card, all } = reads(reader, named);
    assert.ok(!all.includes(MARK.contact), `${reader.role}: no contact in a name`);
    assert.ok(all.includes("Investor portal [contact]") && all.includes("Priya [contact]"), `${reader.role}: the names, scrubbed`);
    assert.equal(card.project?.name, "Finance ledger [contact]");
  }
  assert.match(h.packet({ role: "project-overseer", project: P_A }, { event: e6 }, named)!.text, /project: Investor portal \[contact\]/);
  const op = reads({ role: "operator" }, named);
  assert.ok(op.all.includes(`Investor portal ${MARK.contact}`) && op.all.includes(`Priya ${MARK.contact}`), "the operator reads the names as given");
  assert.equal(op.card.project?.name, `Finance ledger ${MARK.contact}`);
});

test("a roster email written in another case is no hit and no word for a model reader; the operator still finds it", async () => {
  const f = await fixture();
  open.push(f);
  f.now.t += 60_000;
  const [id] = await f.host.record([
    {
      kind: "decision.recorded",
      outcome: "chosen",
      projects: { primary: P_A },
      actors: { decidedBy: { kind: "person", id: "priya" } },
      source: { adapter: "t", version: 1, key: "decision:s1:case" },
      decision: { disposition: "choose", options: [], authority: { kind: "person", id: "priya" } },
      rationale: { what: "Payroll moves to Fridays", quotes: [{ n: 1, text: "Payroll on Fridays, write maria@gatecapital.com or MARIA@GATECAPITAL.COM" }] },
    },
  ]);
  // the roster holds "Maria@GateCapital.com"; the product redactor over it
  const l: HistoryLabels = { ...labels, scrub: (t) => contactRedactor([MARK.contact, "Maria@GateCapital.com"]).text(t) };
  const h = f.host.history;
  for (const reader of [{ role: "global-overseer" }, { role: "project-overseer", project: P_A }] as const) {
    for (const q of ["gatecapital", "maria", "GateCapital.com", "maria@gatecapital.com", "com"]) {
      assert.equal(h.search(reader, { text: q }, l).total, 0, `${reader.role} "${q}"`);
      assert.deepEqual(h.packet(reader, { query: { text: q } }, l)!.events, [], `${reader.role} "${q}": packet`);
    }
    assert.deepEqual(h.search(reader, { text: "payroll fridays" }, l).items.map((i) => i.id), [id]);
    const read = JSON.stringify([h.search(reader, { text: "payroll" }, l), h.event(reader, id!, {}, l), h.packet(reader, { event: id! }, l)]).toLowerCase();
    assert.ok(!read.includes("gatecapital"), `${reader.role}: the email in no case`);
  }
  assert.deepEqual(h.search({ role: "operator" }, { text: "gatecapital" }).items.map((i) => i.id), [id]);
});

test("an import's headline comes from its capture fields only, in its row and on a boundary card", async () => {
  const f = await fixture();
  open.push(f);
  const imp = (key: string, capture: unknown, primary = P_B) =>
    ({ kind: "history.imported", outcome: "recorded", projects: { primary }, actors: {}, source: { adapter: "import", version: 1, key }, rationale: { what: "MARKIMPORTWHAT" }, ...(capture ? { capture } : {}) }) as never;
  f.now.t += 60_000;
  const cases: [string, unknown, string][] = [
    ["none", null, "Nothing to import: the organization started with its history."],
    ["baseline", "baseline", "Existing records imported; earlier acts, holds, sends and reasons are not recorded"],
    ["org", "org", "Organization found at import (recorded before history began)"],
    ["project", "project", "Project found at import (recorded before history began)"],
    ["gap", "gap", "Gap found at import (recorded before history began)"],
    ["gathering", "gathering", "Gathering found at import (recorded before history began)"],
    ["decision", "decision", "Decision found at import (recorded before history began)"],
    ["build", "build", "Coding session found at import (recorded before history began)"],
    ["constructor", "constructor", "History imported"],
    ["other", "person", "History imported"],
    ["bare", undefined, "History imported"],
  ];
  const ids = await f.host.record(cases.map(([key, kind]) => imp(`import:${key}`, kind === null ? null : { origin: "imported", ...(kind ? { importOf: { kind, id: key } } : {}) })));
  const want = cases.map((c) => c[2]);
  // a P_A event linked to each, so a project overseer of P_A gets each as a boundary card
  f.now.t += 60_000;
  const [link] = await f.host.record([
    { kind: "gap.filed", outcome: "recorded", projects: { primary: P_A }, actors: {}, source: { adapter: "t", version: 1, key: "link-imports" }, relations: ids.map((id) => ({ type: "depends-on" as const, target: { event: id! } })) },
  ]);
  const h = f.host.history;
  const op = h.search({ role: "operator" }, { kinds: ["history.imported"] });
  ids.forEach((id, i) => assert.equal(op.items.find((x) => x.id === id)?.headline, want[i], `row ${i}`));
  const go = h.search({ role: "global-overseer" }, { kinds: ["history.imported"] }, labels);
  ids.forEach((id, i) => assert.equal(go.items.find((x) => x.id === id)?.headline, want[i], `model row ${i}`));
  const cards = h.event({ role: "project-overseer", project: P_A }, link!, {}, labels)!.related;
  ids.forEach((id, i) => {
    const c = cards.find((l) => l.event.id === id)!.event;
    assert.equal(c.boundary, true);
    assert.equal(c.headline, want[i], `card ${i}`);
  });
  assert.ok(!JSON.stringify([op, go, cards]).includes("MARKIMPORTWHAT"), "no recorded words make an import's headline");
});

test("who may read is decided now: a read as of before a correction never restores the earlier scope, for a full read or a card", async () => {
  const f = await fixture();
  open.push(f);
  const ev = (key: string, primary: string | null, more: object = {}) =>
    ({ kind: "gap.filed", outcome: "recorded", projects: { primary }, actors: {}, source: { adapter: "t", version: 1, key }, ...more }) as never;
  f.now.t += 60_000;
  // E: P_A's, moved to P_B; C1: org-level, moved into P_B; C2: P_B's, moved to org-level; L: P_A's, linked to both
  const [e, c1, c2] = await f.host.record([ev("moved", P_A, { rationale: { what: "MARKMOVED" } }), ev("c1", null, { rationale: { what: "MARKC1" } }), ev("c2", P_B, { rationale: { what: "MARKC2" } })]);
  const [l] = await f.host.record([ev("l", P_A, { relations: [c1, c2].map((id) => ({ type: "depends-on", target: { event: id! } })) })]);
  const before = f.now.t;
  f.now.t += 60_000;
  const fix = (key: string, about: string, primary: string | null) => ({ kind: "correction.recorded", outcome: "recorded", projects: { primary: null }, actors: { recordedBy: { kind: "operator" } }, source: { adapter: "t", version: 1, key }, about, correction: { projects: { primary, affected: [] } } }) as never;
  await f.host.record([fix("fix-e", e!, P_B), fix("fix-c1", c1!, P_B), fix("fix-c2", c2!, null)]);
  const h = f.host.history;
  const pa = { role: "project-overseer", project: P_A } as const;
  const pb = { role: "project-overseer", project: P_B } as const;
  for (const asOf of [before, undefined]) {
    const at = `asOf ${asOf ?? "now"}`;
    // P_A's overseer: E is no longer its own, read at any time
    assert.ok(!h.search(pa, { asOf }, labels).items.some((i) => i.id === e), `${at}: no row`);
    assert.equal(h.event(pa, e!, { asOf }, labels), null, at);
    assert.equal(h.trace(pa, e!, { asOf }, labels), null, at);
    assert.equal(h.packet(pa, { event: e!, asOf }, labels), null, at);
    assert.ok(!h.packet(pa, { query: { asOf } }, labels)!.events.includes(e!), at);
    // P_B's overseer reads it, as of either time
    assert.ok(h.event(pb, e!, { asOf }, labels), at);
    assert.ok(h.search(pb, { asOf }, labels).items.some((i) => i.id === e), at);
    // cards from P_A's own L: C1 (now P_B's) is a card, C2 (now org-level) is nothing
    const d = h.event(pa, l!, { asOf }, labels)!;
    const card = d.related.find((x) => x.event.id === c1)?.event;
    assert.equal(card?.boundary, true, `${at}: C1 a card`);
    assert.equal(card?.project?.id ?? null, asOf ? null : P_B, `${at}: the card shows its projects as of the read`);
    assert.ok(!d.related.some((x) => x.event.id === c2), `${at}: C2 no card`);
    const chain = h.trace(pa, l!, { asOf }, labels)!;
    assert.ok(chain.nodes.some((n) => n.id === c1 && n.boundary) && !chain.nodes.some((n) => n.id === c2), at);
    const reads = JSON.stringify([h.search(pa, { asOf }, labels), d, chain, h.packet(pa, { event: l!, asOf }, labels), h.packet(pa, { query: { asOf } }, labels)]);
    for (const m of ["MARKMOVED", "MARKC1", "MARKC2", c2!]) assert.ok(!reads.includes(m), `${at}: ${m}`);
  }
  // display and filters stay as of the read: P_B's row as of before shows P_A, and a P_B filter then leaves it out
  assert.equal(h.search(pb, { asOf: before }, labels).items.find((i) => i.id === e)?.project?.id, P_A);
  assert.ok(!h.search(pb, { asOf: before, projects: [P_B] }, labels).items.some((i) => i.id === e));
  assert.ok(h.search(pb, { projects: [P_B] }, labels).items.some((i) => i.id === e));
  // the operator reads E at either time, with its projects as of the read
  assert.equal(h.event({ role: "operator" }, e!, { asOf: before })!.event.project?.id, P_A);
  assert.equal(h.event({ role: "operator" }, e!)!.event.project?.id, P_B);
});
