// Run: pnpm exec tsx --test server/reconcile.test.ts. A throwaway PI_CODING_AGENT_DIR, workspace and
// client project in the OS temp dir, deleted after; ~/.pi is never read or written. The decide seam
// is a fake; the spec tools are the real ones this tree ships (run as child processes).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BATON_DECISION_ENTRY, OPERATOR } from "../shared/baton";
import type { DecisionProvider, DecisionRequest } from "./decide";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-reconcile-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const decisions = await import("./decisions");
const reconcile = await import("./reconcile");
const writer = await import("./spec-draft-writer");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- fakes -------------------------------------------------------------------------------------------

/** Contradiction = the two statements name different day counts ("30 days" vs "60 days"). */
const days = (s: string) => /(\d+) days/.exec(s)?.[1];
const requests: DecisionRequest[] = [];
let outcome = "a";
let failNext = false;
const fake: DecisionProvider = {
  id: "chain",
  label: "fake",
  async decide(req) {
    requests.push(req);
    if (failNext) {
      failNext = false;
      const { DecisionError } = await import("./decide");
      throw new DecisionError("unavailable", "fake provider down");
    }
    assert.equal(req.purpose, "reconcile");
    const state = req.state as any;
    const answers: Record<string, any> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      if (q.type === "boolean") {
        const [x, y] = [...String(q.instructions).matchAll(/D\d+/g)].map((m) => m[0]);
        const ps = [...(state.decisions[x!].statement + state.decisions[y!].statement).matchAll(/\[p=([\d.]+)\]/g)].map((m) => Number(m[1]));
        const forced = ps.length ? Math.max(...ps) : undefined;
        const dx = days(state.decisions[x!].statement);
        const dy = days(state.decisions[y!].statement);
        answers[qid] = { type: "boolean", p: forced !== undefined ? forced : dx && dy && dx !== dy ? 0.93 : 0.08 };
      } else if (q.type === "choice" && qid === "outcome") {
        answers[qid] = { type: "choice", choice: outcome, probabilities: { [outcome]: 1 }, confidence: 1 };
      } else if (q.type === "choice") {
        // Area filing: "Billing" belongs with invoicing; everything else stays a subject of its own.
        const d = state.new[qid];
        const keys = Object.keys(q.options);
        const choice = /billing/i.test(d.name) && keys.includes("invoicing") ? "invoicing" : decisions.areaKeyOf(d.name);
        answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
      }
    }
    return { answers, provider: "jev", model: "fake", latencyMs: 1 };
  },
};

let excluded = false;
const ended: string[] = [];
reconcile.setReconcileDeps({
  provider: () => fake,
  excluded: () => excluded,
  endBaton: async (sid) => {
    baton.closeBaton(sid);
    ended.push(sid);
  },
});

// ---- helpers ----------------------------------------------------------------------------------------------

const lastId = (file: string): string => {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!).id;
};
let seq = 0;
const nid = () => (++seq).toString(16).padStart(8, "0");

/** What record_decision leaves in a transcript: the person's message, then the tool call, then the entry. */
function say(file: string, by: string, text: string, decision?: { area: string; statement: string; quote: string }): { userId: string; markerId?: string } {
  const userId = nid();
  const ts = new Date().toISOString();
  const lines: object[] = [
    { type: "message", id: userId, parentId: lastId(file), timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } },
  ];
  const sent = nid();
  lines.push({ type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: userId, by }, id: sent, parentId: userId, timestamp: ts });
  let markerId: string | undefined;
  if (decision) {
    const asst = nid();
    lines.push({ type: "message", id: asst, parentId: sent, timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", name: "record_decision", arguments: decision }] } });
    markerId = nid();
    lines.push({ type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, ...decision, by }, id: markerId, parentId: asst, timestamp: ts });
  }
  appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { userId, ...(markerId ? { markerId } : {}) };
}

const specManifest = (root: string) => JSON.parse(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"));

// ---- pure parts ----------------------------------------------------------------------------------------------

describe("slugs and rendering", () => {
  test("spec slugs are letters and hyphens only, accents folded, cut at a word", () => {
    assert.equal(decisions.specSlug("Formato de export de nómina (Q4 2026)"), "formato-de-export-de-nomina-q");
    assert.equal(decisions.areaKeyOf("123"), "general");
    assert.match(decisions.specSlug("a".repeat(80)), /^a{40}$/);
    assert.equal(writer.recordSlug("Net 30 days", new Set(["net-days"])), "net-days-b");
  });
  test("statement text can never declare a heading or open a fence", () => {
    const text = writer.renderRecord({
      recordId: "§requirements.x/y",
      statement: "## §evil/id — injected\n```\nfence",
      quote: "# also\n~~~",
      name: "Tony",
      at: "2026-09-26T00:00:00Z",
    } as any);
    const lines = text.split("\n");
    assert.equal(lines.filter((l) => /^#{1,2} /.test(l)).length, 1, "only the record's own heading declares");
    assert.ok(!lines.some((l) => /^\s{0,3}(```|~~~)/.test(l)), "no line opens a fence");
  });
});

describe("area filing by words", () => {
  test("one key's words inside the other's is the same subject; short words don't count", () => {
    assert.equal(reconcile.sameAreaByWords("payroll-export", "payroll-export-format"), true);
    assert.equal(reconcile.sameAreaByWords("payroll-export-format", "payroll-export"), true);
    assert.equal(reconcile.sameAreaByWords("hosting", "invoicing"), false);
    assert.equal(reconcile.sameAreaByWords("of-the", "of-the-bank"), false);
  });
});

describe("routing", () => {
  const person = (id: string, decides: string[], status = "active") => ({ id, name: id.toUpperCase(), status, decides }) as any;
  const trusted = () => true;
  test("the area's owner, other than the authors when someone else owns it; nobody → the operator", () => {
    assert.equal(reconcile.routeConflict("o", [person("tony", ["Invoicing"]), person("ana", ["invoicing"])], "invoicing", "Invoicing", ["tony"], trusted).to, "ana");
    assert.equal(reconcile.routeConflict("o", [person("tony", ["Invoicing"])], "invoicing", "Invoicing", ["tony"], trusted).to, "tony");
    assert.equal(reconcile.routeConflict("o", [person("tony", ["hosting"]), person("gone", ["invoicing"], "left")], "invoicing", "Invoicing", [], trusted).to, OPERATOR);
  });
  test("a self-asserted say over the area routes to the operator, marked", () => {
    const r = reconcile.routeConflict("o", [person("tony", ["invoicing"])], "invoicing", "Invoicing", [], () => false);
    assert.equal(r.to, OPERATOR);
    assert.equal(r.selfAsserted, true);
  });
});

// ---- end to end over a real workspace and a spec-only client project ---------------------------------------------------

describe("decisions → conflicts → draft → promotion", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  const client = join(tmp, "client");
  mkdirSync(client);
  const project = orgs.addProject(org.id, { name: "Portal", root: client });
  const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] });
  const maria = orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
  const carlos = orgs.addPerson(org.id, { name: "Carlos Gate", role: "CEO", decides: ["invoicing"] });
  // A say over "bank access" that only a referral asserted, approved by a project overseer (not the operator): self-asserted.
  const bob = orgs.addPerson(org.id, { name: "Bob", status: "proposed", role: "Bank liaison", decides: ["bank access"], contact: { email: "bob@example.com" }, referral: { why: "bank", referredBy: tony.id } }, { kind: "referral" });
  orgs.approvePerson(org.id, bob.id, { kind: "overseer" });
  // The same kind of referral, approved by the operator: the say counts.
  const eve = orgs.addPerson(org.id, { name: "Eve", status: "proposed", role: "Office manager", decides: ["parking"], contact: { email: "eve@example.com" }, referral: { why: "office", referredBy: maria.id } }, { kind: "referral" });
  const s1 = baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Payroll", goal: "g" });
  const s2 = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "g" });
  const f1 = s1.path;
  const f2 = s2.path;
  let d30 = "";
  let d60 = "";
  let host = "";

  before(() => {
    d30 = `${s1.sessionId}:${say(f1, maria.id, "Clients get 30 days.", { area: "Invoicing", statement: "Invoices are due 30 days after issue.", quote: "Clients get 30 days." }).markerId}`;
    host = `${s2.sessionId}:${say(f2, tony.id, "Run it on srv-01.", { area: "hosting", statement: "The portal runs on the office server srv-01.", quote: "Run it on srv-01." }).markerId}`;
  });

  test("the index: one row per decision entry, the quote's user message as provenance, pending; syncing twice adds nothing", () => {
    const { store, added } = decisions.syncDecisions(org.id, project.id);
    assert.deepEqual(new Set(added), new Set([d30, host]));
    const r = store.decisions.find((d) => d.id === d30)!;
    assert.equal(r.by, maria.id);
    assert.equal(r.name, "Maria Lopez");
    assert.equal(r.areaKey, "invoicing");
    assert.equal(r.state, "pending");
    const userLine = readFileSync(f1, "utf8").split("\n").map((l) => (l ? JSON.parse(l) : null)).find((e) => e?.id === r.entryId);
    assert.equal(userLine.message.role, "user", "entryId names the user message holding the quote");
    assert.equal(decisions.syncDecisions(org.id, project.id).added.length, 0);
    assert.ok(reconcile.listDecisions(org.id, project.id).decisions.every((d) => d.state === "pending"), "alone in its area is still not reconciled");
    assert.ok(existsSync(join(orgs.orgDir(org.id), "projects", project.id, "decisions.json")), "the index lives in the workspace repo");
  });

  test("clean decisions are drafted into the project's own draft with provenance; claims/ is never written", async () => {
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(info.lastRun?.error, undefined);
    assert.deepEqual(info.decisions.map((d) => d.state).sort(), ["drafted", "drafted"]);
    assert.equal(info.spec.exists, false, "no current spec yet");
    assert.equal(info.spec.draft, "sova-decisions");
    const dm = JSON.parse(readFileSync(join(client, ".sova", "spec", "drafts", "sova-decisions", "spec", "manifest.json"), "utf8"));
    const rid = info.decisions.find((d) => d.id === d30)!.recordId!;
    assert.match(rid, /^§requirements\.invoicing\/[a-z-]+$/);
    assert.deepEqual(dm.claims["§requirements/invoicing"], { kind: "note", authority: "accepted" });
    assert.equal(dm.claims[rid].kind, "note");
    assert.equal(dm.claims[rid].authority, "accepted");
    assert.deepEqual(Object.keys(dm.claims[rid].provenance[0]).sort(), ["at", "by", "entryId", "name", "quote", "sessionId"]);
    assert.equal(dm.claims[rid].provenance[0].quote, "Clients get 30 days.");
    assert.ok(!existsSync(join(client, ".sova", "spec", "claims")), "current claims untouched");
    const check = await writer.runDraftTool(client, ["check", "sova-decisions"]);
    assert.equal(check.exit, 0, JSON.stringify(check.json.findings));
    assert.match(readFileSync(join(client, ".sova", "spec", ".gitignore"), "utf8"), /^drafts\/$/m);
  });

  test("piecemeal promotion: one decision becomes current with --doc-only evidence; the other stays drafted", async () => {
    const r = await reconcile.promoteDecisions(org.id, project.id, [d30]);
    assert.deepEqual(r.refused, []);
    assert.deepEqual(r.promoted, [d30]);
    const m = specManifest(client);
    const rid = r.info.decisions.find((d) => d.id === d30)!.recordId!;
    assert.deepEqual(Object.keys(m.claims).sort(), ["§requirements/invoicing", rid].sort(), "only the selected record and its area");
    assert.equal(m.claims[rid].provenance[0].by, maria.id);
    const md = readFileSync(join(client, ".sova", "spec", "claims", "requirements", "invoicing.md"), "utf8");
    assert.match(md, /^# §requirements\/invoicing — Invoicing/);
    assert.match(md, /> Clients get 30 days\./);
    assert.match(md, /— Maria Lopez, \d{4}-\d{2}-\d{2}/);
    assert.equal(r.info.decisions.find((d) => d.id === host)!.state, "drafted");
    assert.equal(r.info.decisions.find((d) => d.id === d30)!.state, "promoted");
    // The batch draft stays: its draft.json holds the --doc-only evidence and the promotion.
    const batches = readdirSync(join(client, ".sova", "spec", "drafts")).filter((n) => n.startsWith("sova-promote-"));
    assert.deepEqual(batches, [r.draft]);
    const dj = JSON.parse(readFileSync(join(client, ".sova", "spec", "drafts", r.draft!, "draft.json"), "utf8"));
    const evidenced = dj.evidence.flatMap((e: any) => e.ids.map((x: any) => [x.id, e.by, e.mode, e.verification]));
    assert.deepEqual(evidenced.map((e: any[]) => e[0]).sort(), ["§requirements/invoicing", rid].sort());
    assert.ok(evidenced.every((e: any[]) => e[1] === "reconciler" && e[2] === "doc-only"));
    const mine = evidenced.find((e: any[]) => e[0] === rid)!;
    assert.match(mine[3], /Decision by Maria Lopez .* in baton session .*entry .*"Clients get 30 days\."/);
    assert.deepEqual(dj.promotions[0].ids.sort(), ["§requirements/invoicing", rid].sort());
    const core = await writer.runDraftTool(client, ["status", "sova-decisions"]);
    assert.notEqual(core.exit, 2);
  });

  test("promotion refuses what is not reconciled", async () => {
    const r = await reconcile.promoteDecisions(org.id, project.id, ["nope", d30]);
    assert.deepEqual(r.refused.map((x) => x.id), ["nope", d30]);
    assert.deepEqual(r.promoted, []);
  });

  test("a contradiction is a conflict routed to the area's owner as a baton session; neither side is drafted", async () => {
    d60 = `${s2.sessionId}:${say(f2, tony.id, "No, billing is 60 days.", { area: "Billing", statement: "Invoices are due 60 days after issue.", quote: "No, billing is 60 days." }).markerId}`;
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(info.lastRun?.found, 1, JSON.stringify({ run: info.lastRun, d: info.decisions.map((d) => [d.area, d.areaKey, d.state]) }));
    const c = info.conflicts[0]!;
    assert.equal(c.areaKey, "invoicing", "Billing was filed under invoicing");
    assert.deepEqual([c.a, c.b].sort(), [d30, d60].sort());
    assert.ok(c.p >= 0.7);
    assert.equal(c.routedTo, carlos.id, "Carlos decides invoicing and wrote neither side");
    assert.ok(c.batonSessionId);
    const row = baton.batonById(c.batonSessionId!)!.row;
    assert.equal(row.holder, carlos.id);
    assert.equal(baton.batonSummaryField(c.batonPath!)?.sendLink?.to, "Carlos Gate", "Needs-you: send Carlos his link");
    assert.match(row.goal, /Clients get 30 days\./);
    assert.match(row.goal, /No, billing is 60 days\./);
    assert.equal(info.decisions.find((d) => d.id === d60)!.state, "conflict");
    assert.equal(info.decisions.find((d) => d.id === d30)!.state, "conflict", "a promoted decision can be in conflict");
  });

  test("the resolution recorded in the conflict's session supersedes the losing side", async () => {
    const c = reconcile.listDecisions(org.id, project.id).conflicts[0]!;
    const file = baton.sessionPathOf(orgs.orgDir(org.id), baton.batonById(c.batonSessionId!)!.row);
    outcome = "neither";
    const res = `${c.batonSessionId}:${say(file, carlos.id, "Make it 45 days for everyone.", { area: "invoicing", statement: "Invoices are due 45 days after issue.", quote: "Make it 45 days for everyone." }).markerId}`;
    const info = await reconcile.reconcileProject(org.id, project.id);
    const done = info.conflicts.find((x) => x.id === c.id)!;
    assert.equal(done.state, "resolved");
    assert.equal(done.outcome, "neither");
    assert.equal(done.resolvedBy, res);
    const byId = new Map(info.decisions.map((d) => [d.id, d]));
    assert.equal(byId.get(d30)!.state, "superseded");
    assert.equal(byId.get(d30)!.supersededBy, res);
    assert.equal(byId.get(d60)!.supersededBy, res);
    assert.equal(byId.get(res)!.state, "drafted");
    assert.equal(byId.get(res)!.resolves, c.id);
    // Promoting the resolution also marks the promoted 30-day record superseded, in the same file.
    const r = await reconcile.promoteDecisions(org.id, project.id, [res]);
    assert.deepEqual(r.refused, []);
    const m = specManifest(client);
    const old = byId.get(d30)!.recordId!;
    assert.equal(m.claims[old].supersededBy, byId.get(res)!.recordId);
    assert.match(readFileSync(join(client, ".sova", "spec", "claims", "requirements", "invoicing.md"), "utf8"), /Superseded by §requirements\.invoicing\//);
  });

  test("the operator resolves by hand: keep a side, or state the decision", async () => {
    const x = `${s1.sessionId}:${say(f1, maria.id, "Payroll closes on the 25th, 10 days early.", { area: "hosting", statement: "Backups are kept 10 days.", quote: "10 days" }).markerId}`;
    const y = `${s2.sessionId}:${say(f2, tony.id, "Backups: 90 days.", { area: "hosting", statement: "Backups are kept 90 days.", quote: "90 days" }).markerId}`;
    let info = await reconcile.reconcileProject(org.id, project.id, { route: false });
    const c = info.conflicts.find((k) => k.state === "open")!;
    assert.ok(c && !c.batonSessionId, "route:false leaves it unrouted");
    assert.equal(c.routedTo, tony.id, "Tony decides hosting; Tony wrote one side, nobody else owns it");
    info = await reconcile.resolveConflict(org.id, project.id, c.id, { keep: "b" });
    const byId = new Map(info.decisions.map((d) => [d.id, d]));
    assert.deepEqual([c.a, c.b].sort(), [x, y].sort());
    assert.equal(byId.get(c.a)!.state, "superseded");
    assert.equal(byId.get(c.a)!.supersededBy, c.b, "keeping b supersedes a by b");
    assert.equal(byId.get(c.b)!.state, "drafted");
    await assert.rejects(reconcile.resolveConflict(org.id, project.id, c.id, { keep: "a" }), /resolved/);
  });

  test("a self-asserted owner routes to the operator: a baton the operator holds (Needs-you)", async () => {
    say(f2, tony.id, "Bank access: 2 days.", { area: "bank access", statement: "Bank access requests are answered in 2 days.", quote: "2 days" });
    say(f1, maria.id, "Bank access: 5 days.", { area: "bank access", statement: "Bank access requests are answered in 5 days.", quote: "5 days" });
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "bank-access")!;
    assert.equal(c.routedTo, OPERATOR);
    assert.equal(c.selfAsserted, true);
    const row = baton.batonById(c.batonSessionId!)!.row;
    assert.equal(row.holder, OPERATOR);
    assert.equal(row.state, "needs-you");
  });

  test("a fresh baton the operator holds is listed before anyone writes in it, and needs them", async () => {
    const { listSessions } = await import("./sessions-index");
    const { sessionItems } = await import("./attention");
    const c = reconcile.listDecisions(org.id, project.id).conflicts.find((k) => k.state === "open" && k.areaKey === "bank-access")!;
    const row = (await listSessions()).find((x) => x.id === c.batonSessionId);
    assert.ok(row, "not dropped as an empty husk");
    assert.ok(row!.baton?.needsYou);
    const items = sessionItems({ summary: row!, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0 }, Date.now());
    assert.deepEqual(items.map((i) => [i.kind, i.tier]), [["baton-needs-you", "act"]]);
    assert.match(items[0]!.detail!, /Two decisions about bank access disagree/);
  });

  test("a decision recorded in a conflict's session settles it without a Reconcile click", async () => {
    const { emitBatonEvent } = await import("./baton-events");
    const stop = reconcile.watchResolutions(10);
    try {
      const c = reconcile.listDecisions(org.id, project.id).conflicts.find((k) => k.state === "open" && k.areaKey === "bank-access")!;
      const file = baton.sessionPathOf(orgs.orgDir(org.id), baton.batonById(c.batonSessionId!)!.row);
      outcome = "a";
      const m = say(file, OPERATOR, "Two days.", { area: "bank access", statement: "Bank access requests are answered in 2 days.", quote: "Two days." }).markerId!;
      emitBatonEvent({ type: "decision", orgId: org.id, projectId: project.id, sessionId: "unrelated", entryId: "x" });
      emitBatonEvent({ type: "decision", orgId: org.id, projectId: project.id, sessionId: c.batonSessionId!, entryId: m });
      let done;
      for (let i = 0; i < 100 && !done; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = reconcile.listDecisions(org.id, project.id);
        // Resolved is written before the same run rewrites the draft: wait for the run to end.
        done = now.running ? undefined : now.conflicts.find((k) => k.id === c.id && k.state === "resolved");
      }
      assert.ok(done, "resolved by the watcher");
      assert.equal(done!.outcome, "a");
      const res = `${c.batonSessionId}:${m}`;
      assert.equal(done!.resolvedBy, res);
      // The resolution only restates A: it joins A's record instead of becoming a second one.
      const byId = new Map(reconcile.listDecisions(org.id, project.id).decisions.map((d) => [d.id, d]));
      const kept = byId.get(done!.a)!;
      assert.deepEqual(kept.folded, [res]);
      assert.equal(byId.get(res)!.supersededBy, kept.id);
      assert.equal(byId.get(done!.b)!.supersededBy, kept.id);
      assert.equal(kept.state, "drafted", JSON.stringify(kept));
      const dm = JSON.parse(readFileSync(join(client, ".sova", "spec", "drafts", "sova-decisions", "spec", "manifest.json"), "utf8"));
      assert.ok(dm.claims[kept.recordId!], JSON.stringify({ kept, run: reconcile.listDecisions(org.id, project.id).lastRun, keys: Object.keys(dm.claims) }));
      assert.deepEqual(dm.claims[kept.recordId!].provenance.map((p: any) => p.quote), [kept.quote, "Two days."]);
      assert.equal(dm.claims[byId.get(res)!.recordId ?? "none"], undefined, "no second record");
    } finally {
      stop();
    }
  });

  test("re-routing a conflict by hand asks the new person and closes the earlier session", async () => {
    say(f1, maria.id, "Export: 3 days.", { area: "payroll export", statement: "The payroll export is sent 3 days before payday.", quote: "3 days" });
    say(f2, tony.id, "Export: 5 days.", { area: "payroll export", statement: "The payroll export is sent 5 days before payday.", quote: "5 days" });
    let info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "payroll-export")!;
    assert.equal(c.routedTo, OPERATOR, "nobody decides payroll export");
    const first = c.batonSessionId!;
    info = await reconcile.routeConflictNow(org.id, project.id, c.id, carlos.id);
    const again = info.conflicts.find((k) => k.id === c.id)!;
    assert.equal(again.routedTo, carlos.id);
    assert.notEqual(again.batonSessionId, first);
    assert.equal(baton.batonById(again.batonSessionId!)!.row.holder, carlos.id);
    assert.equal(baton.batonById(first)!.row.state, "closed");
    assert.deepEqual(ended, [first]);
    await assert.rejects(reconcile.routeConflictNow(org.id, project.id, c.id, "p_nobody"), /active person/);
  });

  test("the contradiction threshold is 0.7: 0.69 is compared-clean, 0.7 is a conflict", async () => {
    say(f1, maria.id, "x", { area: "parking", statement: "Staff park in lot A. [p=0.69]", quote: "lot A" });
    say(f2, tony.id, "y", { area: "parking", statement: "Staff park in lot B.", quote: "lot B" });
    let info = await reconcile.reconcileProject(org.id, project.id, { route: false });
    assert.equal(info.conflicts.filter((k) => k.areaKey === "parking").length, 0);
    assert.deepEqual(info.decisions.filter((d) => d.areaKey === "parking").map((d) => d.state), ["drafted", "drafted"]);
    say(f2, tony.id, "z", { area: "parking", statement: "Visitors park in lot C. [p=0.7]", quote: "lot C" });
    info = await reconcile.reconcileProject(org.id, project.id, { route: false });
    const parking = info.conflicts.filter((k) => k.areaKey === "parking");
    assert.equal(parking.length, 1, "0.7 is a conflict; the other pair waits while it is open");
    const lotC = info.decisions.find((d) => d.statement.startsWith("Visitors"))!;
    assert.ok(parking[0]!.a === lotC.id || parking[0]!.b === lotC.id);
    assert.ok(parking[0]!.p >= 0.7);
  });

  test("reconciling again asks nothing new, finds no second conflict and starts no second session", async () => {
    await reconcile.reconcileProject(org.id, project.id);
    const conflicts = reconcile.listDecisions(org.id, project.id).conflicts.length;
    const batons = baton.allBatons().length;
    const asked = requests.length;
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(info.conflicts.length, conflicts);
    assert.equal(baton.allBatons().length, batons);
    assert.equal(info.lastRun?.compared, 0, JSON.stringify(requests.slice(asked).map((r) => r.state)));
    assert.equal(requests.length, asked, "no pair, area or outcome asked twice");
  });

  test("the decide seam sees decision text only: statement, quote, name, date, area", () => {
    const text = JSON.stringify(requests.map((r) => r.state));
    for (const leak of ["bob@example.com", "Bank liaison", "Payroll\"", tony.id, maria.id, s1.sessionId, client]) assert.ok(!text.includes(leak), `sent ${leak}`);
    for (const r of requests) {
      const st = r.state as any;
      for (const d of Object.values<any>(st.decisions ?? {})) assert.ok(Object.keys(d).every((k) => ["statement", "quote", "by", "at", "filedUnder"].includes(k)), Object.keys(d).join());
    }
  });

  test("the switch off: a manual run is refused, the automatic one records why and sends nothing", async () => {
    reconcile.setReconcileDeps({ provider: () => fake, excluded: () => false, enabled: () => false, endBaton: async (sid) => void baton.closeBaton(sid) });
    try {
      const asked = requests.length;
      await assert.rejects(reconcile.reconcileProject(org.id, project.id), (e: any) => e.status === 409 && /Turn on Reconcile decisions/.test(e.message));
      const info = await reconcile.reconcileProject(org.id, project.id, { auto: true });
      assert.match(info.lastRun?.error ?? "", /Turn on Reconcile decisions/);
      assert.equal(requests.length, asked);
    } finally {
      reconcile.setReconcileDeps({ provider: () => fake, excluded: () => excluded, endBaton: async (sid) => { baton.closeBaton(sid); ended.push(sid); } });
    }
  });

  test("frozen: a direct edit of claims/ is reported; not frozen, nothing is reported", async () => {
    const md = join(client, ".sova", "spec", "claims", "requirements", "invoicing.md");
    let st = reconcile.specStatusOf(org.id, project.id);
    assert.equal(st.frozen, false);
    assert.equal(st.editedOutside, undefined);
    st = reconcile.setFrozen(org.id, project.id, true);
    assert.equal(st.frozen, true);
    assert.equal(st.editedOutside, false);
    assert.equal(orgs.readProjects(org.id).find((p) => p.id === project.id)!.spec?.frozen, true, "stored on the project");
    const bytes = readFileSync(md, "utf8");
    writeFileSync(md, `${bytes}\nA hand edit.\n`);
    assert.equal(reconcile.specStatusOf(org.id, project.id).editedOutside, true);
    writeFileSync(md, bytes);
    assert.equal(reconcile.specStatusOf(org.id, project.id).editedOutside, false);
    reconcile.setFrozen(org.id, project.id, false);
    writeFileSync(md, `${bytes}\nA hand edit.\n`);
    assert.equal(reconcile.specStatusOf(org.id, project.id).editedOutside, undefined);
    writeFileSync(md, bytes);
  });

  test("a promoted decision that gains a restatement is promotable again, and carries both quotes", async () => {
    const a = `${s1.sessionId}:${say(f1, maria.id, "q", { area: "dress code", statement: "Friday is 5 days casual.", quote: "casual Fridays" }).markerId}`;
    await reconcile.reconcileProject(org.id, project.id);
    assert.deepEqual((await reconcile.promoteDecisions(org.id, project.id, [a])).promoted, [a]);
    say(f2, tony.id, "q", { area: "dress code", statement: "Friday is 4 days formal.", quote: "formal Fridays" });
    let info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "dress-code")!;
    assert.equal(info.decisions.find((d) => d.id === a)!.state, "conflict", "pending × promoted is compared");
    outcome = "a";
    const file = baton.sessionPathOf(orgs.orgDir(org.id), baton.batonById(c.batonSessionId!)!.row);
    say(file, OPERATOR, "casual it is", { area: "dress code", statement: "Friday is 5 days casual.", quote: "casual it is" });
    info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(info.decisions.find((d) => d.id === a)!.state, "drafted", "its record changed: promotable again");
    const r = await reconcile.promoteDecisions(org.id, project.id, [a]);
    assert.deepEqual(r.promoted, [a]);
    const rec = specManifest(client).claims[r.info.decisions.find((d) => d.id === a)!.recordId!];
    assert.deepEqual(rec.provenance.map((p: any) => p.quote), ["casual Fridays", "casual it is"]);
    assert.equal(r.info.decisions.find((d) => d.id === a)!.state, "promoted");
  });

  test("a referred person's say counts only once the operator approved them", () => {
    const person = (id: string) => orgs.readRoster(org.id).find((p) => p.id === id)!;
    assert.equal(reconcile.decidesTrusted(org.id, person(bob.id), "bank-access"), false, "approved by an overseer: self-asserted");
    assert.equal(reconcile.decidesTrusted(org.id, person(eve.id), "parking"), false, "not approved yet");
    orgs.approvePerson(org.id, eve.id, { kind: "operator" });
    assert.equal(reconcile.decidesTrusted(org.id, person(eve.id), "parking"), true, "approved by the operator");
    assert.equal(reconcile.decidesTrusted(org.id, person(carlos.id), "invoicing"), true, "set by the operator");
    const roster = orgs.readRoster(org.id);
    assert.equal(reconcile.authorOwnsArea(org.id, roster, { by: bob.id, areaKey: "bank-access" }), false);
    assert.equal(reconcile.authorOwnsArea(org.id, roster, { by: eve.id, areaKey: "parking" }), true);
    assert.equal(reconcile.authorOwnsArea(org.id, roster, { by: OPERATOR, areaKey: "anything" }), true);
    assert.equal(reconcile.authorOwnsArea(org.id, roster, { by: maria.id, areaKey: "hosting" }), false);
  });

  test("out-of-area decisions are promoted only when the operator names them; in-area ones any way", async () => {
    const inArea = `${s2.sessionId}:${say(f2, tony.id, "w", { area: "hosting", statement: "Backups run every night.", quote: "nightly backups" }).markerId}`;
    const outArea = `${s1.sessionId}:${say(f1, maria.id, "w", { area: "hosting", statement: "Monitoring alerts go to the IT inbox.", quote: "IT inbox" }).markerId}`;
    const info = await reconcile.reconcileProject(org.id, project.id, { route: false });
    const row = (id: string) => info.decisions.find((d) => d.id === id)!;
    assert.equal(row(inArea).authorOwnsArea, true, "Tony decides hosting");
    assert.equal(row(outArea).authorOwnsArea, false, "Maria does not");
    assert.equal(row(inArea).state, "drafted");
    assert.equal(row(outArea).state, "drafted");
    for (const by of ["bulk", "overseer"] as const) {
      const r = await reconcile.promoteDecisions(org.id, project.id, [outArea], { by });
      assert.deepEqual(r.promoted, [], by);
      assert.deepEqual(r.refused, [{ id: outArea, reason: "outside Maria Lopez's decision area: promote it explicitly by id" }], by);
    }
    const bulk = await reconcile.promoteDecisions(org.id, project.id, [inArea, outArea], { by: "bulk" });
    assert.deepEqual(bulk.promoted, [inArea], "bulk promotes the in-area one and refuses the other");
    assert.deepEqual(bulk.refused.map((x) => x.id), [outArea]);
    const explicit = await reconcile.promoteDecisions(org.id, project.id, [outArea]);
    assert.deepEqual(explicit.promoted, [outArea], "the operator naming it promotes it");
  });

  test("settling a routed conflict by hand closes its session, so its Needs-you item goes", async () => {
    say(f1, maria.id, "k", { area: "coffee", statement: "Coffee is free for 3 days a week.", quote: "3 days" });
    say(f2, tony.id, "k", { area: "coffee", statement: "Coffee is free for 5 days a week.", quote: "5 days" });
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "coffee")!;
    assert.equal(c.routedTo, OPERATOR);
    assert.ok(baton.batonSummaryField(c.batonPath!)?.needsYou, "needs the operator while open");
    ended.length = 0;
    await reconcile.resolveConflict(org.id, project.id, c.id, { keep: "a" });
    assert.deepEqual(ended, [c.batonSessionId]);
    assert.equal(baton.batonById(c.batonSessionId!)!.row.state, "closed");
    assert.equal(baton.batonSummaryField(c.batonPath!)?.needsYou, undefined);
  });

  test("a provider failure leaves new decisions pending and says why", async () => {
    say(f1, maria.id, "Hosting: 7 days notice.", { area: "hosting", statement: "Server moves need 7 days notice.", quote: "7 days notice" });
    failNext = true;
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.match(info.lastRun?.error ?? "", /fake provider down/);
    assert.ok(info.decisions.some((d) => d.state === "pending"));
  });

  test("an excluded project folder is never sent", async () => {
    excluded = true;
    const before = requests.length;
    const info = await reconcile.reconcileProject(org.id, project.id);
    excluded = false;
    assert.equal(requests.length, before);
    assert.match(info.lastRun?.error ?? "", /excluded/);
  });

  test("the workspace repo holds the index and conflicts, never tokens", () => {
    const dir = join(orgs.orgDir(org.id), "projects", project.id);
    const text = readFileSync(join(dir, "decisions.json"), "utf8") + readFileSync(join(dir, "conflicts.json"), "utf8");
    assert.ok(!/token|hash/i.test(text));
  });
});

// The spec tool itself, against a project whose spec someone else already wrote: our records join it.
describe("an existing spec", () => {
  test("appends an area file without touching other claims", async () => {
    const root = join(tmp, "existing");
    mkdirSync(join(root, ".sova", "spec", "claims", "app"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), JSON.stringify({ formatVersion: 1, claims: { "§app/thing": { kind: "note", authority: "accepted" } } }));
    writeFileSync(join(root, ".sova", "spec", "claims", "app", "thing.md"), "# §app/thing — Thing\n\nPre-existing.\n");
    const row = { id: "s:m", areaKey: "hosting", area: "Hosting", statement: "Runs on srv-01.", quote: "srv-01", name: "Tony", at: "2026-09-26T00:00:00Z", by: "p_t", sessionId: "s", entryId: "e", recordId: "§requirements.hosting/runs-on-srv" } as any;
    const out = await writer.promoteEdit(root, { rows: [row], supersededBy: new Map() }, () => "test");
    assert.deepEqual(out.promoted.sort(), ["§requirements.hosting/runs-on-srv", "§requirements/hosting"]);
    const m = JSON.parse(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"));
    assert.deepEqual(m.claims["§app/thing"], { kind: "note", authority: "accepted" });
    assert.equal(readFileSync(join(root, ".sova", "spec", "claims", "app", "thing.md"), "utf8"), "# §app/thing — Thing\n\nPre-existing.\n");
  });
});
