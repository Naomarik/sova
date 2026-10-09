// Run: node scripts/run-tests.mjs server/decision-markers.test.ts. A decision marker left without its decision
// (the server stopped between record_decision's entry and its act) gets one as the
// org's engine opens, under the same decision id; the quote is checked against its message
//. A throwaway agent dir and workspace in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_DECISION_ENTRY } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-decision-markers-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const decisions = await import("./decisions");
const reconcile = await import("./reconcile");
const engine = await import("./org-engine");
const { parsePi } = await import("./harness/pi/reader");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const lastId = (file: string): string => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
let seq = 0;
const nid = () => `m${(++seq).toString(16).padStart(7, "0")}`;

/** A person's message (with its sender marker), as a gathering's file holds it. Returns the message's id. */
function message(file: string, by: string, text: string): string {
  const id = nid();
  const ts = new Date().toISOString();
  appendFileSync(file, `${JSON.stringify({ type: "message", id, parentId: lastId(file), timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: id, by }, id: nid(), parentId: id, timestamp: ts })}\n`);
  return id;
}

/** A person's message whose sender marker was never written (the server stopped between the two). Returns its id. */
function unmarkedMessage(file: string, text: string): string {
  const id = nid();
  appendFileSync(file, `${JSON.stringify({ type: "message", id, parentId: lastId(file), timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  return id;
}

/** record_decision's marker, and nothing after it: the server stopped before the act. Returns the marker's id. */
function marker(file: string, d: { area: string; statement: string; quote: string; by: string; ownerArea?: string; disposition?: string }): string {
  const id = nid();
  appendFileSync(file, `${JSON.stringify({ type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, ownerArea: "none", ...d }, id, parentId: lastId(file), timestamp: new Date().toISOString() })}\n`);
  return id;
}

const byIdOf = (file: string): Map<string, HEntry> => new Map(parsePi(readFileSync(file, "utf8")).entries.filter((h) => h.id).map((h) => [h.id!, h]));

describe("decision markers without a decision", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  const client = join(tmp, "client");
  mkdirSync(client);
  const project = await orgs.addProject(org.id, { name: "Portal", root: client });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  const s = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Payroll", goal: "g" });

  test("two decisions stated in one message, both cut off: each gets its own decision at the next open, once", async () => {
    const u = message(s.path, maria.id, "Clients get 30 days. And send reminders weekly.");
    const m1 = marker(s.path, { area: "Invoicing", statement: "Invoices are due in 30 days.", quote: "Clients get 30 days.", by: maria.id });
    const m2 = marker(s.path, { area: "Reminders", statement: "Reminders go weekly.", quote: "send reminders weekly", by: maria.id });
    assert.equal(reconcile.listDecisions(org.id, project.id).decisions.length, 0, "nothing recorded them");

    // a restart: the engine closes and opens again
    await engine.closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    const rows = reconcile.listDecisions(org.id, project.id).decisions;
    assert.deepEqual(new Set(rows.map((d) => d.id)), new Set([`${s.sessionId}:${m1}`, `${s.sessionId}:${m2}`]));
    for (const r of rows) {
      assert.equal(r.entryId, u, "the quote's message");
      assert.equal(r.by, maria.id);
    }
    assert.deepEqual(decisions.decisionMarkerProblems(org.id), []);

    // opening again recovers nothing more: one decision per marker
    assert.deepEqual(decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id), []);
    assert.equal(reconcile.listDecisions(org.id, project.id).decisions.length, 2);

    // the history: one event per decision, under its marker's key, the person deciding (their quote checks)
    const h = engine.hostOf(org.id).history;
    const page = h.search({ role: "operator" }, { kinds: ["decision.recorded"] });
    const records = page.items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    assert.deepEqual(records.map((r) => r.source.key).sort(), [`decision:${s.sessionId}:${m1}`, `decision:${s.sessionId}:${m2}`].sort(), "one event per decision");
    // another restart: no decision, log row or history event again
    const rowsNow = () => engine.hostOf(org.id).log.rows({ session: baton.batonSid(org.id, s.sessionId) }).filter((r) => r.event === "baton/record-decision").length;
    const before = rowsNow();
    await engine.closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    assert.equal(rowsNow(), before);
    assert.equal(engine.hostOf(org.id).history.search({ role: "operator" }, { kinds: ["decision.recorded", "act.refused"] }).items.length, 2);
    assert.equal(reconcile.listDecisions(org.id, project.id).decisions.length, 2);
    for (const r of records) {
      assert.deepEqual(r.actors.decidedBy, { kind: "person", id: maria.id });
      assert.equal(r.actors.recordedBy && (r.actors.recordedBy as { kind: string }).kind, "model");
      assert.ok((r.actors.initiatedBy as { unknown?: boolean }).unknown);
      const ev = r.evidence[0]!;
      assert.equal(ev.kind === "transcript" && ev.check, "checked");
      assert.equal(ev.kind === "transcript" && ev.entry, u);
      // structural: no words in the event line
      assert.ok(!JSON.stringify(r).includes("30 days"));
    }
    const detail = h.event({ role: "operator" }, page.items.find((i) => records.find((r) => r.id === i.id)?.source.key.endsWith(m1))!.id)!;
    assert.equal(detail.rationale?.what, "Invoices are due in 30 days.");
    assert.deepEqual(detail.rationale?.quotes, [{ n: 1, text: "Clients get 30 days." }]);
  });

  test("the quote is checked against its message: words and sender", () => {
    const u = message(s.path, maria.id, "We pay on Fridays.");
    const ok = marker(s.path, { area: "Payday", statement: "Pay runs on Fridays.", quote: "we pay on  FRIDAYS", by: maria.id });
    const byId = byIdOf(s.path);
    assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: u, quote: "we pay on  FRIDAYS", by: maria.id }), "checked");
    assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: u, quote: "We pay on Mondays.", by: maria.id }), "quote-not-found");
    assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: u, quote: "We pay on Fridays.", by: tony.id }), "speaker-mismatch");
    assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: "nope", quote: "x", by: maria.id }), "source-unavailable");
    // a message with no sender marker has no recorded sender: not checked, whoever the decision claims
    const unmarked = unmarkedMessage(s.path, "We close on the 5th.");
    const um = marker(s.path, { area: "Close", statement: "Close on the 5th.", quote: "We close on the 5th.", by: maria.id });
    assert.equal(decisions.quoteCheckOf(byIdOf(s.path), { markerId: um, entryId: unmarked, quote: "We close on the 5th.", by: maria.id }), "unchecked");
    // a quote must be a span of what was said, on word boundaries: punctuation alone, nothing, or a piece of a word establishes nothing
    for (const q of [".", "...", " , ", "!!", "“”", "", "e", "ay o", "pay on Fri", "Fridays and Mondays"])
      assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: u, quote: q, by: maria.id }), "quote-not-found", JSON.stringify(q));
    // whole words in order, whatever the punctuation, case and spacing
    for (const q of ["We pay on Fridays", "pay, on fridays!", "Fridays."])
      assert.equal(decisions.quoteCheckOf(byId, { markerId: ok, entryId: u, quote: q, by: maria.id }), "checked", q);
    // any length, any script: a whole-message Yes, No or A, a CJK span, an emoji
    const said: [string, string, boolean][] = [
      ["Yes", "Yes.", true],
      ["No!", "no", true],
      ["A", "A", true],
      ["Yes", "Yesterday", false],
      ["我们周五付款。", "周五付款", true],
      ["我们周五付款。", "五付", false],
      ["👍", "👍", true],
      ["Sounds good 👍", "good 👍", true],
      ["Café au lait", "cafe", false],
      ["Café au lait", "CAFÉ", true],
    ];
    for (const [text, quote, found] of said) assert.equal(decisions.quoteIn(quote, text), found, `${JSON.stringify(quote)} in ${JSON.stringify(text)}`);
  });

  test("a quote that doesn't check stays the model's: decided by the model, the quote marked not checked", () => {
    const p = decisions.decisionProvenance({ decisionId: "s:m", sessionId: "s", entryId: "u", by: maria.id, statement: "x", quote: "y", check: "quote-not-found" });
    assert.equal(p.sourceKey, "decision:s:m");
    assert.equal(p.actors.decidedBy.kind, "model");
    assert.equal(p.evidence[0]!.kind === "transcript" && p.evidence[0]!.check, "quote-not-found");
    const c = decisions.decisionProvenance({ decisionId: "s:m", sessionId: "s", entryId: "u", by: maria.id, statement: "x", quote: "y", check: "checked" });
    assert.deepEqual(c.actors.decidedBy, { kind: "person", id: maria.id });
  });

  test("a marker the statechart refuses is said as a problem, never dropped silently", async () => {
    message(s.path, maria.id, "Use the old ledger.");
    const bad = marker(s.path, { area: "Ledger", statement: "Keep the old ledger.", quote: "Use the old ledger.", by: maria.id, ownerArea: "No Such Area" });
    // (the earlier test's Friday marker is recovered here too: it had none either)
    assert.ok(!decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id).includes(`${s.sessionId}:${bad}`));
    const problems = decisions.decisionMarkerProblems(org.id);
    assert.deepEqual(problems.map((p) => p.markerId), [bad]);
    assert.match(problems[0]!.why, /not an owner area/);
    assert.ok(!reconcile.listDecisions(org.id, project.id).decisions.some((d) => d.id === `${s.sessionId}:${bad}`));
    // and it is tried again at the next open (still there, still said)
    decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id);
    assert.deepEqual(decisions.decisionMarkerProblems(org.id).map((p) => p.markerId), [bad]);
    // and the Workspace tab says it
    assert.ok((await orgs.orgDetail(org.id)).problems.some((x) => x.startsWith("A decision recorded in Payroll couldn't be recovered:") && /not an owner area/.test(x)));
    // a refused recovery is only said, never stepped: no refusal row in the log or the history, at a restart either
    const bsid = baton.batonSid(org.id, s.sessionId);
    const refusals = () => ({
      log: engine.hostOf(org.id).log.rows({ session: bsid }).filter((r) => r.event === "baton/record-decision" && r.refused).length,
      history: engine.hostOf(org.id).history.search({ role: "operator" }, { kinds: ["act.refused"] }).items.length,
    });
    assert.deepEqual(refusals(), { log: 0, history: 0 });
    for (let restart = 1; restart <= 2; restart++) {
      await engine.closeOrgHost(org.id);
      await orgs.openAttachedOrgs();
      assert.deepEqual(decisions.decisionMarkerProblems(org.id).map((p) => p.markerId), [bad], `restart ${restart}`);
      assert.ok((await orgs.orgDetail(org.id)).problems.some((x) => x.startsWith("A decision recorded in Payroll couldn't be recovered:") && /not an owner area/.test(x)), `restart ${restart}`);
      assert.deepEqual(refusals(), { log: 0, history: 0 }, `restart ${restart}`);
    }
  });

  test("a marker naming someone who never took part: not recorded as theirs, and the Workspace tab says so", async () => {
    const s3 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Rota", goal: "g" });
    message(s3.path, maria.id, "Rota is fine.");
    const m = marker(s3.path, { area: "Rota", statement: "The rota stays.", quote: "Rota is fine.", by: tony.id });
    assert.deepEqual(decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id).filter((d) => d.startsWith(s3.sessionId)), []);
    const p = decisions.decisionMarkerProblems(org.id).find((x) => x.markerId === m)!;
    assert.equal(p.sentence, "A decision recorded in Rota couldn't be recovered: Tony Reyes isn't part of that conversation.");
    assert.ok((await orgs.orgDetail(org.id)).problems.includes(p.sentence));
    // that legacy marker kept no name, and none is written for it: today's label says who
    const kept = (id: string) => (parsePi(readFileSync(s3.path, "utf8")).entries.find((h) => h.id === id) as unknown as { data: { name?: string } }).data;
    assert.equal(kept(m).name, undefined);
    // a marker that kept its decider's name is said under that name
    const named = marker(s3.path, { area: "Rota", statement: "The rota stays.", quote: "Rota is fine.", by: tony.id, name: "Anthony Reyes" } as never);
    decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id);
    assert.equal(decisions.decisionMarkerProblems(org.id).find((x) => x.markerId === named)?.sentence, "A decision recorded in Rota couldn't be recovered: Anthony Reyes isn't part of that conversation.");
    assert.equal(kept(m).name, undefined);
  });

  test("a marker with no author is never taken as the operator's: not recovered, said, and recovered once its author is there", async () => {
    const s5 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Expenses", goal: "g" });
    message(s5.path, maria.id, "Receipts within a week.");
    const m = marker(s5.path, { area: "Expenses", statement: "Receipts are due within a week.", quote: "Receipts within a week.", by: undefined as unknown as string });
    const id = `${s5.sessionId}:${m}`;
    const host = engine.hostOf(org.id);
    for (const restart of [false, true]) {
      if (restart) {
        await engine.closeOrgHost(org.id);
        await orgs.openAttachedOrgs();
      } else assert.ok(!decisions.recoverDecisionMarkers(host, org.id).includes(id));
      assert.ok(!engine.hostOf(org.id).statechartOf(decisions.decisionSid(org.id, project.id, id)), "no decision statechart");
      assert.ok(!reconcile.listDecisions(org.id, project.id).decisions.some((d) => d.id === id), "nothing attributed to the operator");
      const p = decisions.decisionMarkerProblems(org.id).find((x) => x.markerId === m)!;
      assert.equal(p.sentence, "A decision recorded in Expenses couldn't be recovered: its author wasn't recorded.");
      assert.ok((await orgs.orgDetail(org.id)).problems.includes(p.sentence));
      assert.equal(engine.hostOf(org.id).history.search({ role: "operator" }, { kinds: ["decision.recorded", "act.refused"] }).items.filter((i) => engine.hostOf(org.id).history.event({ role: "operator" }, i.id)!.record!.source.key === `decision:${id}`).length, 0);
    }
    // a marker naming no known person is the same
    const ghost = marker(s5.path, { area: "Expenses", statement: "x", quote: "Receipts within a week.", by: "p_nobody" });
    decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id);
    assert.equal(decisions.decisionMarkerProblems(org.id).find((x) => x.markerId === ghost)?.sentence, "A decision recorded in Expenses couldn't be recovered: its author wasn't recorded.");
    // the same marker with its author recovers, as Maria's
    const lines = readFileSync(s5.path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.id !== ghost);
    for (const e of lines) if (e.id === m) e.data.by = maria.id;
    writeFileSync(s5.path, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);
    assert.ok(decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id).includes(id));
    assert.equal(reconcile.listDecisions(org.id, project.id).decisions.find((d) => d.id === id)?.by, maria.id);
  });

  test("a quote that doesn't check at recovery stays the model's: each state labelled, never checked, no recorded name", async () => {
    const s6 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Travel", goal: "g" });
    message(s6.path, maria.id, "Book economy.");
    const notFound = marker(s6.path, { area: "Travel", statement: "Business class is allowed.", quote: "Book business.", by: maria.id });
    message(s6.path, tony.id, "Trains under four hours.");
    const mismatch = marker(s6.path, { area: "Travel", statement: "Trains under four hours.", quote: "Trains under four hours.", by: maria.id });
    // a marker with no message above it: its source can't be read
    const s7 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Per diem", goal: "g" });
    const noSource = marker(s7.path, { area: "Per diem", statement: "Per diem is 40.", quote: "40 a day.", by: maria.id });
    // a stop between Maria's message and its sender marker, then the decision's marker: the sender isn't recorded
    const s8 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Mileage", goal: "g" });
    unmarkedMessage(s8.path, "Mileage is 30 cents.");
    const noSender = marker(s8.path, { area: "Mileage", statement: "Mileage is 30 cents a km.", quote: "Mileage is 30 cents.", by: maria.id });
    const host = engine.hostOf(org.id);
    decisions.recoverDecisionMarkers(host, org.id);
    const records = host.history.search({ role: "operator" }, { kinds: ["decision.recorded"] }).items.map((i) => host.history.event({ role: "operator" }, i.id)!);
    for (const [sid, m, check] of [[s6.sessionId, notFound, "quote-not-found"], [s6.sessionId, mismatch, "speaker-mismatch"], [s7.sessionId, noSource, "source-unavailable"], [s8.sessionId, noSender, "unchecked"]] as const) {
      const d = records.find((x) => x.record!.source.key === `decision:${sid}:${m}`);
      assert.ok(d, `${check}: recovered`);
      const r = d.record!;
      assert.equal(r.actors.decidedBy && (r.actors.decidedBy as { kind: string }).kind, "model", check);
      const ev = r.evidence[0]!;
      assert.equal(ev.kind === "transcript" && ev.check, check);
      assert.ok(!(ev.kind === "transcript" && ev.speaker), `${check}: no speaker`);
      assert.deepEqual(r.actors.authorization, { kind: "none" }, check);
      if (check === "unchecked") assert.equal(ev.kind === "transcript" && ev.why, "The message's sender wasn't recorded.");
      // the decision's own record, reason and sources store no person's name: readers label the ids with today's
      // names (a linked gathering's own headline may name its participant; that is the gathering's, not this)
      const own = JSON.stringify({ record: d.record, rationale: d.rationale, evidence: d.evidence, options: d.options });
      assert.ok(!own.includes("Maria Lopez") && !own.includes("Tony Reyes"), check);
    }
  });

  // The baton statechart's guarded recovery (rules/baton.cljc recovery-by).

  test("guarded: a marker whose author no longer holds the conversation recovers with its original author", async () => {
    const s4 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Leave", goal: "g" });
    message(s4.path, maria.id, "Two weeks notice.");
    const m = marker(s4.path, { area: "Leave", statement: "Leave needs two weeks notice.", quote: "Two weeks notice.", by: maria.id });
    await baton.handoffTo(s4.sessionId, tony.id, "Q", "B").catch(async () => baton.closeBaton(s4.sessionId, { reason: "done" }));
    assert.notEqual(baton.batonById(s4.sessionId)?.row.holder, maria.id, "Maria no longer holds it");
    assert.deepEqual(decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id).filter((d) => d.startsWith(s4.sessionId)), [`${s4.sessionId}:${m}`]);
    const row = reconcile.listDecisions(org.id, project.id).decisions.find((d) => d.id === `${s4.sessionId}:${m}`)!;
    assert.equal(row.by, maria.id, "her decision, not the holder's");
  });

  test("guarded: renamed between marker and recovery: the kept name is the recorded one; a marker that kept none says its name is the label at recovery", async () => {
    const lena = await orgs.addPerson(org.id, { name: "Lena Park", role: "Ops" });
    const s9 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: lena.id, publicTitle: "Shifts", goal: "g" });
    message(s9.path, lena.id, "Shifts start at eight. Breaks are thirty minutes.");
    const kept = marker(s9.path, { area: "Shifts", statement: "Shifts start at 8.", quote: "Shifts start at eight.", by: lena.id, name: "Lena Park" } as never);
    const legacy = marker(s9.path, { area: "Breaks", statement: "Breaks are 30 minutes.", quote: "Breaks are thirty minutes.", by: lena.id });
    await orgs.applyChange(org.id, lena.id, { name: "Lena Kim" }, { kind: "operator" });
    assert.equal(orgs.findPerson(org.id, lena.id)?.name, "Lena Kim");
    const got = decisions.recoverDecisionMarkers(engine.hostOf(org.id), org.id);
    assert.ok(got.includes(`${s9.sessionId}:${kept}`) && got.includes(`${s9.sessionId}:${legacy}`), JSON.stringify(got));
    const rows = reconcile.listDecisions(org.id, project.id).decisions;
    const k = rows.find((d) => d.id === `${s9.sessionId}:${kept}`)!;
    const l = rows.find((d) => d.id === `${s9.sessionId}:${legacy}`)!;
    // the original name, as recorded with the marker; not today's
    assert.deepEqual([k.by, k.name, k.nameAt], [lena.id, "Lena Park", undefined]);
    assert.deepEqual(decisions.provenanceOf(k), { by: lena.id, name: "Lena Park", sessionId: s9.sessionId, entryId: k.entryId, at: k.at, quote: k.quote });
    // no name was kept: today's label, said to be the label at recovery, never presented as recorded
    assert.deepEqual([l.by, l.name, l.nameAt], [lena.id, "Lena Kim", "recovery"]);
    assert.equal(decisions.provenanceOf(l).nameAt, "recovery");
    // and the history holds neither name
    const h = engine.hostOf(org.id).history;
    for (const id of [k.id, l.id]) {
      const ev = h.search({ role: "operator" }, { kinds: ["decision.recorded"] }).items.map((i) => h.event({ role: "operator" }, i.id)!).find((d) => d.record?.source.key === `decision:${id}`)!;
      // the decision's own record, reason and sources (a linked gathering's headline may name Lena: that is the gathering's)
      assert.ok(!/Lena (Park|Kim)/.test(JSON.stringify({ record: ev.record, rationale: ev.rationale, evidence: ev.evidence, options: ev.options })), id);
      assert.deepEqual(ev.record!.actors.decidedBy, { kind: "person", id: lena.id }, "her decision: her quote checks against her marked message");
    }
  });

  test("guarded: a forged recovery (not Sova's own act) is refused by the statechart and records nothing", async () => {
    const host = engine.hostOf(org.id);
    const out = host.actNow(baton.batonSid(org.id, s.sessionId), "baton/record-decision", { decisionId: `${s.sessionId}:forged`, area: "X", areaKey: "x", ownerArea: "none", statement: "s", quote: "q", entryId: "e", markerId: "forged", ownerAreas: [], recovery: true, recoveryBy: maria.id }, engine.envelopeFor(org.id, project.id, { by: "model", attended: false }));
    assert.equal(out.taken, false);
    assert.equal(out.refusal?.sentence, "Only Sova recovers a decision.");
    assert.ok(!host.statechartOf(decisions.decisionSid(org.id, project.id, `${s.sessionId}:forged`)));
  });

  test("only the recovery sends a decision with recovery fields: no route, tool or overseer path does", () => {
    const dir = join(import.meta.dirname, ".");
    const hits = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("vendor"))
      .filter((f) => /recoveryBy|recoveryName|recovery:\s*true/.test(readFileSync(join(dir, f), "utf8")));
    assert.deepEqual(hits, ["decisions.ts"]);
    // and record_decision's own payload is built field by field: a model's extra arguments never reach the act
    const src = readFileSync(join(dir, "baton-loadout.ts"), "utf8");
    assert.match(src, /const payload = \{ area, areaKey: areaKeyOf\(area\), ownerArea: owner\.ownerArea, statement, quote, ownerAreas: ownerAreaChoices\(roster\) \};/);
  });

});
