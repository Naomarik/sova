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
let restates = 1;
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
      if (q.type === "choice" && qid.startsWith("pair")) {
        // Contradiction as above; "[same]" in a statement marks a restatement; anything else is another subject.
        const [x, y] = [...JSON.stringify(q.instructions).matchAll(/D\d+/g)].map((m) => m[0]);
        const sx = state.decisions[x!].statement;
        const sy = state.decisions[y!].statement;
        const ps = [...(sx + sy).matchAll(/\[p=([\d.]+)\]/g)].map((m) => Number(m[1]));
        const dx = days(sx);
        const dy = days(sy);
        const conflict = ps.length ? Math.max(...ps) : dx && dy && dx !== dy ? 0.93 : 0.08;
        const same = /\[same\]/.test(sx + sy) ? 0.9 : 0;
        const probabilities = { conflict, same, different: Math.max(0, 1 - conflict - same) };
        const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
        answers[qid] = { type: "choice", choice, probabilities, confidence: 1 };
      } else if (qid === "restates") {
        answers[qid] = { type: "boolean", p: restates };
      } else if (q.type === "boolean") {
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
    return { answers, provider: "jev", model: "fake", latencyMs: 1, usage: { inputTokens: 10, outputTokens: 2 } };
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
function say(file: string, by: string, text: string, decision?: { area: string; ownerArea?: string; statement: string; quote: string }): { userId: string; markerId?: string } {
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

describe("usage refs of decide answers", () => {
  test("pi splits its ref (the answering model wins), Claude Code prices by the resolved id, else its alias; Jev as itself", () => {
    assert.deepEqual(reconcile.usageRefOf({ provider: "pi", model: "zai/glm-5.3" }), { provider: "zai", model: "glm-5.3" });
    assert.deepEqual(reconcile.usageRefOf({ provider: "claude-code", model: "haiku", usage: { inputTokens: 1, outputTokens: 1, model: "claude-haiku-4-5-20251001" } }), { provider: "claude", model: "claude-haiku-4-5-20251001" });
    assert.deepEqual(reconcile.usageRefOf({ provider: "claude-code", model: "haiku" }), { provider: "claude-code-cli", model: "haiku" });
    assert.deepEqual(reconcile.usageRefOf({ provider: "jev", model: "jev-1.13.0" }), { provider: "jev", model: "jev-1.13.0" });
  });
});

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
  test("the main stakeholder: every area no one on the roster decides, even their own contradiction; never over an explicit owner", () => {
    const roster = [person("alp", ["website"]), person("bob", ["invoicing"])];
    const r = reconcile.routeConflict("o", roster, "page-copy", "page copy", ["alp", "alp"], trusted, "alp");
    assert.deepEqual(r, { to: "alp", reason: "ALP is this project's main stakeholder." });
    assert.equal(reconcile.routeConflict("o", roster, "invoicing", "Invoicing", ["alp"], trusted, "alp").to, "bob", "Bob decides invoicing by name");
    // A self-asserted explicit owner still goes to the operator, never quietly to the stakeholder.
    assert.equal(reconcile.routeConflict("o", roster, "invoicing", "Invoicing", [], () => false, "alp").to, OPERATOR);
    // A stakeholder who left is none.
    assert.equal(reconcile.routeConflict("o", [person("alp", [], "left")], "page-copy", "page copy", [], trusted, "alp").to, OPERATOR);
    assert.equal(reconcile.routeConflict("o", roster, "page-copy", "page copy", [], trusted, null).reason, "Nobody on the roster decides page copy.");
  });
  test("authorOwnsArea: the operator always; an explicit owner with an operator-set say; the stakeholder only where no one decides by name", () => {
    const roster = [person("alp", ["website"]), person("bob", ["invoicing"])];
    const owns = (by: string, areaKey: string, stakeholder: string | null, t = trusted) => reconcile.authorOwnsArea("o", roster, { by, areaKey }, t, stakeholder);
    assert.equal(owns("alp", "page-copy", "alp"), true);
    assert.equal(owns("alp", "page-copy", null), false, "without the stakeholder it is out of area");
    assert.equal(owns("alp", "invoicing", "alp"), false, "Bob's area stays Bob's");
    assert.equal(owns("bob", "page-copy", "alp"), false);
    assert.equal(owns("bob", "invoicing", "alp", () => false), false, "self-asserted");
    assert.equal(owns(OPERATOR, "anything", null), true);
    assert.equal(reconcile.authorOwnsArea("o", [person("alp", [], "left")], { by: "alp", areaKey: "page-copy" }, trusted, "alp"), false, "left: none");
  });
});

describe("owner areas (§app.requirements/owner-area)", () => {
  const person = (id: string, decides: string[], status = "active") => ({ id, name: id.toUpperCase(), status, decides }) as any;
  const trusted = () => true;
  const roster = [person("alp", ["Website", "branding"]), person("bob", ["invoicing", "website "]), person("gone", ["payroll"], "left")];
  test("the choices: every active person's decision areas, once each as first spelled, then none", () => {
    assert.deepEqual(decisions.ownerAreaChoices(roster), ["Website", "branding", "invoicing"]);
    assert.deepEqual(decisions.ownerAreaChoices([]), []);
  });
  test("a pick is a roster area (any case or spacing, stored as the roster spells it) or none; anything else is refused naming the choices", () => {
    assert.deepEqual(decisions.pickOwnerArea(roster, " website"), { ok: true, ownerArea: "Website" });
    assert.deepEqual(decisions.pickOwnerArea(roster, "NONE"), { ok: true, ownerArea: "none" });
    assert.deepEqual(decisions.pickOwnerArea(roster, "site"), { ok: false, error: '"site" is not an owner area. Use one of: "Website", "branding", "invoicing" or "none".' });
    assert.deepEqual(decisions.pickOwnerArea(roster, "payroll"), { ok: false, error: '"payroll" is not an owner area. Use one of: "Website", "branding", "invoicing" or "none".' }, "a left person's area is no choice");
    assert.deepEqual(decisions.pickOwnerArea([], ""), { ok: false, error: 'Give the owner area: "none" (no one on the roster has a decision area yet).' });
  });
  test("authorOwnsArea reads the owner area, not the topic; none is the stakeholder's; an older decision keeps the topic match", () => {
    const owns = (d: { by: string; areaKey: string; ownerArea?: string }, stakeholder: string | null = null, t = trusted) => reconcile.authorOwnsArea("o", roster, d, t, stakeholder);
    assert.equal(owns({ by: "alp", areaKey: "site-structure-pages", ownerArea: "Website" }), true, "the topic never matched a roster word; the owner area does");
    assert.equal(owns({ by: "bob", areaKey: "site-structure-pages", ownerArea: "invoicing" }), true);
    assert.equal(owns({ by: "alp", areaKey: "invoicing", ownerArea: "branding" }), true, "a topic that happens to be Bob's area is not what counts");
    assert.equal(owns({ by: "alp", areaKey: "branding", ownerArea: "invoicing" }), false);
    assert.equal(owns({ by: "alp", areaKey: "x", ownerArea: "none" }, "alp"), true, "none: the main stakeholder");
    assert.equal(owns({ by: "bob", areaKey: "x", ownerArea: "none" }, "alp"), false);
    assert.equal(owns({ by: "alp", areaKey: "x", ownerArea: "none" }, null), false, "none and no stakeholder: nobody");
    assert.equal(owns({ by: "alp", areaKey: "x", ownerArea: "Website" }, null, () => false), false, "a self-asserted say still doesn't count");
    assert.equal(owns({ by: "alp", areaKey: "x", ownerArea: "payroll" }, "alp"), true, "an area no active person decides falls to the stakeholder");
    assert.equal(owns({ by: "alp", areaKey: "site-structure-pages" }), false, "recorded before owner areas: the topic is matched, as before");
    assert.equal(owns({ by: "alp", areaKey: "website" }), true);
    assert.equal(owns({ by: OPERATOR, areaKey: "x", ownerArea: "invoicing" }), true);
  });
  test("a conflict's owner area: the one its sides name; one side's when the other is older; two different ones go to the operator", () => {
    assert.deepEqual(reconcile.ownerAreaOfPair({ ownerArea: "Website" }, { ownerArea: "website" }), { ownerArea: "Website" });
    assert.deepEqual(reconcile.ownerAreaOfPair({}, { ownerArea: "none" }), { ownerArea: "none" });
    assert.deepEqual(reconcile.ownerAreaOfPair({}, {}), {});
    assert.deepEqual(reconcile.ownerAreaOfPair({ ownerArea: "Website" }, { ownerArea: "invoicing" }), { differ: ["Website", "invoicing"] });
    const route = (owner: { ownerArea?: string; differ?: [string, string] }, authors: string[], stakeholder: string | null = null) =>
      reconcile.routeConflict("o", roster, "site-structure-pages", "site structure / pages", authors, trusted, stakeholder, owner);
    assert.deepEqual(route({ ownerArea: "invoicing" }, ["alp", "alp"]), { to: "bob", reason: "BOB decides invoicing." });
    assert.deepEqual(route({ ownerArea: "Website" }, ["alp"]), { to: "bob", reason: "BOB decides Website." }, "an owner who wrote neither side");
    assert.deepEqual(route({ ownerArea: "none" }, ["bob"], "alp"), { to: "alp", reason: "ALP is this project's main stakeholder." });
    assert.deepEqual(route({ ownerArea: "none" }, ["bob"], null), { to: OPERATOR, reason: "Nobody on the roster decides site structure / pages." });
    assert.deepEqual(route({ differ: ["Website", "invoicing"] }, ["alp", "bob"], "alp"), { to: OPERATOR, reason: "The two decisions name different owner areas: Website and invoicing." });
    assert.equal(route({}, ["alp"], null).to, OPERATOR, "no owner area: the topic, which no one decides");
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
    // A settle session: its row names the conflict, and the list says what is in conflict.
    assert.deepEqual(row.conflict, { id: c.id, area: "Invoicing" });
    assert.deepEqual(baton.batonSummaryField(c.batonPath!)?.settle, { area: "Invoicing" });
    assert.equal(baton.batonSummaryField(f1)?.settle, undefined, "an ordinary gathering session is none");
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
    // Both are settle sessions of the same conflict: the closed one keeps its mark (a Done row, still a conflict's).
    assert.deepEqual(baton.batonById(first)!.row.conflict, { id: c.id, area: "payroll export" });
    assert.deepEqual(baton.batonById(again.batonSessionId!)!.row.conflict, { id: c.id, area: "payroll export" });
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
    // A builder recording evidence writes the spec too: frozen means only promotion does.
    const mf = join(client, ".sova", "spec", "manifest.json");
    const mbytes = readFileSync(mf, "utf8");
    const m = JSON.parse(mbytes);
    const rid = Object.keys(m.claims).find((k) => k.startsWith("§requirements.invoicing/"))!;
    m.claims[rid].evidence = "verified";
    writeFileSync(mf, JSON.stringify(m));
    assert.equal(reconcile.specStatusOf(org.id, project.id).editedOutside, true);
    writeFileSync(mf, mbytes);
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

  test("the main stakeholder: the overseer promotes their free-form areas; their own contradiction routes to them, on the project's gathering model", async () => {
    const pos = await import("./project-overseer-store");
    const p = pos.projectOverseerPaths(org.id, project.id);
    pos.writePoSettings(p, { ...pos.readPoSettings(p), gatheringModel: "prov/gather", gatheringThinking: "low" });
    try {
      const lunch = `${s1.sessionId}:${say(f1, maria.id, "l", { area: "lunch breaks", statement: "Lunch is an hour.", quote: "an hour" }).markerId}`;
      let info = await reconcile.reconcileProject(org.id, project.id, { route: false });
      assert.equal(info.decisions.find((d) => d.id === lunch)!.authorOwnsArea, false, "no stakeholder yet: out of area");
      orgs.patchProject(org.id, project.id, { stakeholder: maria.id });
      info = reconcile.listDecisions(org.id, project.id);
      assert.equal(info.decisions.find((d) => d.id === lunch)!.authorOwnsArea, true, "nobody decides lunch breaks by name: Maria does");
      assert.deepEqual((await reconcile.promoteDecisions(org.id, project.id, [lunch], { by: "overseer" })).promoted, [lunch], "the overseer promotes it");
      // Tony's hosting stays Tony's.
      const hostingByMaria = `${s1.sessionId}:${say(f1, maria.id, "h", { area: "hosting", statement: "Logs are kept 9 days.", quote: "nine days" }).markerId}`;
      info = await reconcile.reconcileProject(org.id, project.id, { route: false });
      assert.equal(info.decisions.find((d) => d.id === hostingByMaria)!.authorOwnsArea, false);
      // Maria contradicts herself in an area nobody decides by name: routed to her, as the stakeholder.
      say(f1, maria.id, "a", { area: "visitor badges", statement: "Badges last 2 days.", quote: "2 days" });
      say(f1, maria.id, "b", { area: "visitor badges", statement: "Badges last 7 days.", quote: "7 days" });
      info = await reconcile.reconcileProject(org.id, project.id);
      const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "visitor-badges")!;
      assert.ok(c, JSON.stringify(info.conflicts.map((k) => k.areaKey)));
      assert.deepEqual([c.routedTo, c.routeReason], [maria.id, "Maria Lopez is this project's main stakeholder."]);
      const row = baton.batonById(c.batonSessionId!)!.row;
      assert.deepEqual([row.model, row.thinking], ["prov/gather", "low"], "the settle session opens on the gathering model");
      // Re-routed by the operator: the same model.
      info = await reconcile.routeConflictNow(org.id, project.id, c.id, tony.id);
      const again = baton.batonById(info.conflicts.find((k) => k.id === c.id)!.batonSessionId!)!.row;
      assert.deepEqual([again.model, again.thinking], ["prov/gather", "low"]);
    } finally {
      orgs.patchProject(org.id, project.id, { stakeholder: null });
    }
  });

  test("the run a resolution starts by itself opens its settle sessions on the project's gathering model too", async () => {
    const pos = await import("./project-overseer-store");
    const { emitBatonEvent } = await import("./baton-events");
    const p = pos.projectOverseerPaths(org.id, project.id);
    pos.writePoSettings(p, { ...pos.readPoSettings(p), gatheringModel: "prov/gather", gatheringThinking: "low" });
    const stop = reconcile.watchResolutions(10);
    try {
      const settle = reconcile.listDecisions(org.id, project.id).conflicts.find((k) => k.batonSessionId)!;
      say(f1, maria.id, "w", { area: "window cleaning", statement: "Windows are cleaned every 14 days.", quote: "14 days" });
      say(f2, tony.id, "w", { area: "window cleaning", statement: "Windows are cleaned every 40 days.", quote: "40 days" });
      emitBatonEvent({ type: "decision", orgId: org.id, projectId: project.id, sessionId: settle.batonSessionId!, entryId: "x" });
      let c;
      for (let i = 0; i < 100 && !c; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = reconcile.listDecisions(org.id, project.id);
        c = now.running ? undefined : now.conflicts.find((k) => k.areaKey === "window-cleaning" && k.batonSessionId);
      }
      assert.ok(c, "the watcher's run found and routed it");
      const row = baton.batonById(c!.batonSessionId!)!.row;
      assert.deepEqual([row.model, row.thinking], ["prov/gather", "low"]);
    } finally {
      stop();
    }
  });

  test("the run a resolution starts by itself gives its settle sessions the owner of the session that started it", async () => {
    const { emitBatonEvent } = await import("./baton-events");
    const overseer = { overseerOf: project.id };
    say(f1, maria.id, "s", { area: "snow clearing", statement: "Snow is cleared within 2 days.", quote: "2 days" });
    say(f2, tony.id, "s", { area: "snow clearing", statement: "Snow is cleared within 6 days.", quote: "6 days" });
    const ledger = await import("./project-costs-ledger");
    const lp = ledger.ledgerPaths(org.id, project.id);
    const rowsBefore = ledger.readUsageLedger(lp);
    assert.ok(rowsBefore.length > 0 && rowsBefore.every((r) => r.by !== "overseer" && r.provider === "jev" && r.input === 10), "every answer so far is in usage.jsonl");
    assert.ok(rowsBefore.some((r) => r.by === "operator"), "Reconcile Now is the operator's");
    const info = await reconcile.reconcileProject(org.id, project.id, { owner: overseer });
    const added = ledger.readUsageLedger(lp).slice(rowsBefore.length);
    assert.ok(added.length > 0 && added.every((r) => r.by === "overseer"), "the overseer's run is its own");
    const trigger = info.conflicts.find((k) => k.state === "open" && k.areaKey === "snow-clearing")!;
    assert.deepEqual(baton.batonById(trigger.batonSessionId!)!.row.owner, overseer, "the overseer's reconcile opened it");
    const stop = reconcile.watchResolutions(10);
    try {
      say(f1, maria.id, "g", { area: "gritting", statement: "Paths are gritted every 3 days.", quote: "3 days" });
      say(f2, tony.id, "g", { area: "gritting", statement: "Paths are gritted every 8 days.", quote: "8 days" });
      emitBatonEvent({ type: "decision", orgId: org.id, projectId: project.id, sessionId: trigger.batonSessionId!, entryId: "x" });
      let c;
      for (let i = 0; i < 100 && !c; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = reconcile.listDecisions(org.id, project.id);
        c = now.running ? undefined : now.conflicts.find((k) => k.areaKey === "gritting" && k.batonSessionId);
      }
      assert.ok(c, "the watcher's run found and routed it");
      assert.deepEqual(baton.batonById(c!.batonSessionId!)!.row.owner, overseer, "still the overseer's, not the operator's");
      // The automatic post-resolution session is a settle session like any other.
      assert.deepEqual(baton.batonById(c!.batonSessionId!)!.row.conflict, { id: c!.id, area: "gritting" });
      assert.equal(ledger.readUsageLedger(lp).at(-1)?.by, "sova", "an automatic run is Sova's own, whoever owns what it opens");
    } finally {
      stop();
    }
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

// Restatements and confirmations: one rule said again is one record, and never a second conflict.
describe("restatements, confirmations and resolutions that say something else", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws-restate") });
  const client = join(tmp, "client-restate");
  mkdirSync(client);
  const project = orgs.addProject(org.id, { name: "Invoices", root: client });
  const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "CFO" });
  const bob = orgs.addPerson(org.id, { name: "Bob Chen", role: "IT" });
  const owner = orgs.addPerson(org.id, { name: "Carla Diaz", role: "CEO", decides: ["terms"] });
  const st = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Terms", goal: "g" });
  const sb = baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Terms", goal: "g" });
  const byId = () => new Map(reconcile.listDecisions(org.id, project.id).decisions.map((d) => [d.id, d]));
  const settleFile = (c: { batonSessionId?: string }) => baton.sessionPathOf(orgs.orgDir(org.id), baton.batonById(c.batonSessionId!)!.row);
  let t30 = "";
  let b60 = "";
  let cid = "";

  test("the pair question offers 'a different subject' as an answer of its own, not a low yes", async () => {
    t30 = `${st.sessionId}:${say(st.path, tony.id, "30 days.", { area: "terms", statement: "Suppliers are paid within 30 days.", quote: "30 days." }).markerId}`;
    b60 = `${sb.sessionId}:${say(sb.path, bob.id, "60 days.", { area: "terms", statement: "Suppliers are paid within 60 days.", quote: "60 days." }).markerId}`;
    const asked = requests.length;
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open")!;
    cid = c.id;
    assert.equal(c.routedTo, owner.id);
    const q = Object.values(requests[asked]!.questions)[0]!;
    assert.equal(q.type, "choice");
    assert.deepEqual(Object.keys((q as any).options).sort(), ["conflict", "different", "same"]);
  });

  test("a resolution that says something other than the side it keeps is not folded into it", async () => {
    const c = reconcile.listDecisions(org.id, project.id).conflicts.find((k) => k.id === cid)!;
    outcome = c.a === t30 ? "a" : "b";
    restates = 0;
    try {
      const r = `${c.batonSessionId}:${say(settleFile(c), owner.id, "Pay on Fridays.", { area: "terms", statement: "Supplier payments run on Fridays.", quote: "Pay on Fridays." }).markerId}`;
      await reconcile.reconcileProject(org.id, project.id);
      const d = byId();
      assert.equal(d.get(b60)!.supersededBy, t30, "the losing side is superseded by the kept one");
      assert.deepEqual(d.get(t30)!.folded ?? [], [], "the Friday quote is not evidence for the 30-day rule");
      assert.equal(d.get(r)!.supersededBy, undefined, "it stays a decision of its own");
      assert.equal(d.get(r)!.resolves, cid);
    } finally {
      restates = 1;
    }
  });

  test("the losing author restating their rule opens no second conflict: the restatement is superseded with the first", async () => {
    const conflicts = reconcile.listDecisions(org.id, project.id).conflicts.length;
    const batons = baton.allBatons().length;
    const again = `${sb.sessionId}:${say(sb.path, bob.id, "Like I said, 60 days.", { area: "terms", statement: "Suppliers get paid in 60 days. [same]", quote: "Like I said, 60 days." }).markerId}`;
    const verbatim = `${sb.sessionId}:${say(sb.path, bob.id, "60 days!", { area: "terms", statement: "Suppliers are paid within 60 days.", quote: "60 days!" }).markerId}`;
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(info.conflicts.length, conflicts, JSON.stringify(info.conflicts.map((k) => [k.a, k.b, k.state])));
    assert.equal(baton.allBatons().length, batons, "nobody is asked again");
    const d = byId();
    assert.equal(d.get(again)!.supersededBy, t30);
    assert.equal(d.get(verbatim)!.supersededBy, t30, "the same words need no model to tell");
    assert.deepEqual(new Set(d.get(b60)!.folded), new Set([again, verbatim]));
  });

  test("a second confirmation in a settled conflict's session joins the kept record, on its own", async () => {
    const stop = reconcile.watchResolutions(10);
    try {
      const { emitBatonEvent } = await import("./baton-events");
      const c = reconcile.listDecisions(org.id, project.id).conflicts.find((k) => k.id === cid)!;
      assert.equal(c.state, "resolved");
      const m = say(settleFile(c), owner.id, "Confirmed, 30 days.", { area: "terms", statement: "Suppliers are paid within 30 days, confirmed. [same]", quote: "Confirmed, 30 days." }).markerId!;
      emitBatonEvent({ type: "decision", orgId: org.id, projectId: project.id, sessionId: c.batonSessionId!, entryId: m });
      const id = `${c.batonSessionId}:${m}`;
      let row;
      for (let i = 0; i < 100 && !row?.supersededBy; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = reconcile.listDecisions(org.id, project.id);
        row = now.running ? undefined : now.decisions.find((x) => x.id === id);
      }
      assert.equal(row?.supersededBy, t30, "folded by the watcher, no Reconcile click");
      const d = byId();
      assert.ok(d.get(t30)!.folded?.includes(id));
      assert.equal(d.get(t30)!.state, "drafted", "the kept rule stays promotable");
      const dm = JSON.parse(readFileSync(join(client, ".sova", "spec", "drafts", "sova-decisions", "spec", "manifest.json"), "utf8"));
      const records = Object.entries(dm.claims).filter(([k, v]: [string, any]) => k.startsWith("§requirements.terms/") && !v.supersededBy);
      assert.equal(records.length, 2, `the 30-day rule and the Friday rule, no duplicate: ${records.map(([k]) => k)}`);
    } finally {
      stop();
    }
  });
});

describe("a fold of a fold", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws-fold2") });
  const client = join(tmp, "client-fold2");
  mkdirSync(client);
  const project = orgs.addProject(org.id, { name: "Lunch", root: client });
  const kim = orgs.addPerson(org.id, { name: "Kim Park", role: "Office", decides: ["lunch"] });
  const s = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Lunch", goal: "g" });

  test("promoting the kept decision carries the quotes of what was folded into what was folded into it, once each", async () => {
    const a = `${s.sessionId}:${say(s.path, kim.id, "Lunch at noon.", { area: "lunch", statement: "Lunch is at noon.", quote: "Lunch at noon." }).markerId}`;
    const b = `${s.sessionId}:${say(s.path, kim.id, "Noon, as decided.", { area: "lunch hour", statement: "The lunch hour starts at noon.", quote: "Noon, as decided." }).markerId}`;
    const c = `${s.sessionId}:${say(s.path, kim.id, "Yes, noon.", { area: "lunch time", statement: "Lunch starts at 12.", quote: "Yes, noon." }).markerId}`;
    await reconcile.reconcileProject(org.id, project.id);
    // B was folded into A (a resolution restating it), and C into B (a confirmation of that),
    // with a cycle back from C to B that must not repeat anything.
    const store = decisions.readDecisionStore(org.id, project.id);
    const row = (id: string) => store.decisions.find((d) => d.id === id)!;
    row(a).folded = [b];
    Object.assign(row(b), { state: "superseded", supersededBy: a, folded: [c] });
    Object.assign(row(c), { state: "superseded", supersededBy: b, folded: [b] });
    decisions.writeDecisionStore(org.id, project.id, store);
    await reconcile.draftProject(org.id, project.id);
    const r = await reconcile.promoteDecisions(org.id, project.id, [a]);
    assert.deepEqual(r.promoted, [a]);
    const rec = specManifest(client).claims[r.info.decisions.find((d) => d.id === a)!.recordId!];
    assert.deepEqual(rec.provenance.map((p: any) => p.quote), ["Lunch at noon.", "Noon, as decided.", "Yes, noon."]);
    assert.equal(r.info.decisions.find((d) => d.id === a)!.state, "promoted", "and it reads as up to date");
    assert.equal((await reconcile.reconcileProject(org.id, project.id)).decisions.find((d) => d.id === a)!.state, "promoted", "not promotable again on the next run");
  });
});

// The spec tool itself, against a project whose spec someone else already wrote: our records join it.
// ---- owner areas end to end: a project with several owners ------------------------------------------------------------

describe("a multi-owner project routes by owner area", async () => {
  const org = await orgs.createOrg({ name: "Studio", dir: join(tmp, "ws-owner") });
  const client = join(tmp, "client-owner");
  mkdirSync(client);
  const project = orgs.addProject(org.id, { name: "Site", root: client });
  const alp = orgs.addPerson(org.id, { name: "Alperen", role: "Founder", decides: ["website", "branding"] });
  const bob = orgs.addPerson(org.id, { name: "Bob Tan", role: "Accountant", decides: ["invoicing"] });
  const s1 = baton.createBaton({ orgId: org.id, projectId: project.id, to: alp.id, publicTitle: "Site", goal: "g" });
  const s2 = baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Billing", goal: "g" });
  const id = (sid: string, m: { markerId?: string }) => `${sid}:${m.markerId}`;
  const row = (info: { decisions: { id: string }[] }, x: string) => info.decisions.find((d) => d.id === x) as any;

  test("free topics, roster owner areas: the owner's decisions are theirs, the overseer promotes them, and an older decision keeps the topic match", async () => {
    const pages = id(s1.sessionId, say(s1.path, alp.id, "Two pages.", { area: "site structure / pages", ownerArea: "website", statement: "The site has two pages.", quote: "Two pages." }));
    const old = id(s1.sessionId, say(s1.path, alp.id, "Blue.", { area: "page colours", statement: "Pages are blue.", quote: "Blue." }));
    const byBob = id(s2.sessionId, say(s2.path, bob.id, "Footer.", { area: "site structure / pages", ownerArea: "website", statement: "The footer lists the office address.", quote: "Footer." }));
    const info = await reconcile.reconcileProject(org.id, project.id, { route: false });
    assert.equal(row(info, pages).ownerArea, "website");
    assert.equal(row(info, pages).areaKey, "site-structure-pages", "the topic still files the spec");
    assert.equal(row(info, pages).authorOwnsArea, true);
    assert.equal(row(info, old).ownerArea, undefined, "nothing is backfilled");
    assert.equal(row(info, old).authorOwnsArea, false, "an older decision: page-colours is no one's area");
    assert.equal(row(info, byBob).authorOwnsArea, false, "Bob doesn't decide website");
    const r = await reconcile.promoteDecisions(org.id, project.id, [pages, byBob], { by: "overseer" });
    assert.deepEqual(r.promoted, [pages]);
    assert.deepEqual(r.refused.map((x) => x.id), [byBob]);
    assert.ok(specManifest(client).claims["§requirements/site-structure-pages"], "filed under its topic");
  });

  test("a contradiction goes to the owner area's owner, and the settle session names the owner area", async () => {
    say(s1.path, alp.id, "a", { area: "payment terms", ownerArea: "invoicing", statement: "Invoices are due 30 days after issue.", quote: "30 days" });
    say(s1.path, alp.id, "b", { area: "payment terms", ownerArea: "invoicing", statement: "Invoices are due 60 days after issue.", quote: "60 days" });
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "payment-terms")!;
    assert.ok(c, JSON.stringify(info.conflicts));
    assert.deepEqual([c.routedTo, c.routeReason, c.ownerArea], [bob.id, "Bob Tan decides invoicing.", "invoicing"]);
    assert.match(baton.batonById(c.batonSessionId!)!.row.goal, /owner area "invoicing"/);
  });

  test("the operator changes a decision's owner area: kept with who and when, authority recomputed, its open conflict re-routed", async () => {
    let info = reconcile.listDecisions(org.id, project.id);
    const old = info.decisions.find((d) => d.area === "page colours")!;
    await assert.rejects(reconcile.setOwnerArea(org.id, project.id, old.id, "site"), /"site" is not an owner area\. Use one of: "website", "branding", "invoicing" or "none"\./);
    info = await reconcile.setOwnerArea(org.id, project.id, old.id, "Branding");
    const changed = row(info, old.id);
    assert.equal(changed.ownerArea, "branding");
    assert.equal(changed.authorOwnsArea, true);
    assert.equal(changed.ownerAreaHistory.length, 1);
    assert.deepEqual({ ...changed.ownerAreaHistory[0], at: "" }, { at: "", by: OPERATOR, name: orgs.operatorName(), from: null, to: "branding" });
    // Survives a sync from the transcripts.
    assert.equal(row(reconcile.listDecisions(org.id, project.id), old.id).ownerArea, "branding");
    // A side of an open conflict: re-routed by its new owner area.
    const c = info.conflicts.find((k) => k.state === "open" && k.areaKey === "payment-terms")!;
    const first = c.batonSessionId!;
    info = await reconcile.setOwnerArea(org.id, project.id, c.a, "website");
    let again = info.conflicts.find((k) => k.id === c.id)!;
    assert.deepEqual([again.routedTo, again.routeReason], [OPERATOR, "The two decisions name different owner areas: website and invoicing."]);
    assert.equal(baton.batonById(first)!.row.state, "closed", "the session asking Bob is over");
    const second = again.batonSessionId!;
    assert.notEqual(second, first);
    info = await reconcile.setOwnerArea(org.id, project.id, c.b, "website");
    again = info.conflicts.find((k) => k.id === c.id)!;
    assert.deepEqual([again.routedTo, again.routeReason, again.ownerArea], [alp.id, "Alperen decides website.", "website"], "Alperen wrote both sides and is the only owner");
    assert.equal(baton.batonById(again.batonSessionId!)!.row.holder, alp.id);
    assert.equal(baton.batonById(second)!.row.state, "closed");
    // The same route again changes nothing: no new session.
    const third = again.batonSessionId;
    info = await reconcile.setOwnerArea(org.id, project.id, c.b, "Website");
    assert.equal(info.conflicts.find((k) => k.id === c.id)!.batonSessionId, third);
  });

  test("an unknown decision is refused", async () => {
    await assert.rejects(reconcile.setOwnerArea(org.id, project.id, "nope", "none"), /Unknown decision/);
  });
});

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

// ---- NEW-MS2-1: the decisions layer owns only its fields (§app.requirements/decisions, /promotion) ----------------

describe("the decisions layer owns only its fields", async () => {
  const org = await orgs.createOrg({ name: "Garage", dir: join(tmp, "ws-layers") });
  const client = join(tmp, "client-layers");
  mkdirSync(client);
  const project = orgs.addProject(org.id, { name: "Invoices", root: client });
  const kim = orgs.addPerson(org.id, { name: "Kim Park", role: "Finance", decides: ["invoicing"] });
  const s = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Invoices", goal: "g" });
  const md = join(client, ".sova", "spec", "claims", "requirements", "invoicing.md");
  const manifestFile = join(client, ".sova", "spec", "manifest.json");
  let a = "";
  let b = "";
  const row = (info: { decisions: { id: string }[] }, id: string) => info.decisions.find((d) => d.id === id) as any;

  test("a builder's evidence and code leave a promoted decision promoted, and it reads as built", async () => {
    a = `${s.sessionId}:${say(s.path, kim.id, "Net 30 for all.", { area: "invoicing", statement: "Invoices are due after thirty days.", quote: "Net 30 for all." }).markerId}`;
    b = `${s.sessionId}:${say(s.path, kim.id, "Blue letterhead.", { area: "invoicing", statement: "Invoices use the blue letterhead.", quote: "Blue letterhead." }).markerId}`;
    await reconcile.reconcileProject(org.id, project.id);
    const r = await reconcile.promoteDecisions(org.id, project.id, [a, b]);
    assert.deepEqual(r.promoted.sort(), [a, b].sort());
    assert.match(row(r.info, a).promotedText, /^[0-9a-f]{64}$/, "the prose as promoted is kept");
    assert.equal(row(r.info, a).build, "not-built");
    assert.deepEqual([r.info.spec.built, r.info.spec.notBuilt], [0, 2]);
    // The builder, in spec mode on its branch, records evidence and code, relabels, and the file's layout differs.
    const m = specManifest(client);
    const ra = row(r.info, a).recordId;
    const rb = row(r.info, b).recordId;
    Object.assign(m.claims[ra], { evidence: "verified", code: ["src/due.js"] });
    Object.assign(m.claims[rb], { authority: "migrated", requires: [] });
    writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
    writeFileSync(md, `${readFileSync(md, "utf8")}\n\n`);
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.equal(row(info, a).state, "promoted", "evidence and code are the spec layer's");
    assert.equal(row(info, b).state, "promoted", "so is a relabel");
    assert.equal(row(info, a).build, "built");
    assert.equal(row(info, b).build, "not-built");
    assert.equal(row(info, a).editedInSpec, undefined, "a layout change is not an edit");
    assert.deepEqual([info.spec.built, info.spec.notBuilt, info.spec.drafted, info.spec.draft], [1, 1, 0, null], "and no draft would take the evidence away");
  });

  test("a re-promotion keeps the builder's fields and every byte it didn't mean to change", async () => {
    const c = `${s.sessionId}:${say(s.path, kim.id, "Thirty, yes.", { area: "invoicing", statement: "Thirty days, confirmed.", quote: "Thirty, yes." }).markerId}`;
    await reconcile.reconcileProject(org.id, project.id);
    // Fold C into A, as a confirmation would be.
    const store = decisions.readDecisionStore(org.id, project.id);
    const r = (id: string) => store.decisions.find((d) => d.id === id)!;
    r(a).folded = [c];
    Object.assign(r(c), { state: "superseded", supersededBy: a });
    decisions.writeDecisionStore(org.id, project.id, store);
    const drafted = await reconcile.draftProject(org.id, project.id);
    assert.equal(row(drafted, a).state, "drafted", "a folded quote is the decisions layer's: promotable again");
    const ra = row(drafted, a).recordId;
    const rb = row(drafted, b).recordId;
    const draftRec = JSON.parse(readFileSync(join(client, ".sova", "spec", "drafts", "sova-decisions", "spec", "manifest.json"), "utf8")).claims[ra];
    assert.equal(draftRec.evidence, "verified", "the draft keeps the builder's evidence");
    assert.deepEqual(draftRec.code, ["src/due.js"]);
    const before = readFileSync(md, "utf8");
    const bBlock = before.slice(before.indexOf(`## ${rb}`));
    const out = await reconcile.promoteDecisions(org.id, project.id, [a]);
    assert.deepEqual(out.refused, [], "B's record, in the same file, is not pulled into the selection");
    assert.deepEqual(out.promoted, [a]);
    const m = specManifest(client);
    assert.equal(m.claims[ra].evidence, "verified");
    assert.deepEqual(m.claims[ra].code, ["src/due.js"]);
    assert.deepEqual(m.claims[ra].provenance.map((p: any) => p.quote), ["Net 30 for all.", "Thirty, yes."]);
    assert.deepEqual([m.claims[rb].authority, m.claims[rb].requires], ["migrated", []]);
    assert.ok(readFileSync(md, "utf8").endsWith(bBlock), "B's block and the file's trailing layout are byte for byte as they were");
  });

  test("prose edited in the spec is flagged, stays promoted, and the operator keeps or restores it", async () => {
    const info0 = reconcile.listDecisions(org.id, project.id);
    const rb = row(info0, b).recordId;
    const original = readFileSync(md, "utf8");
    writeFileSync(md, original.replace("Invoices use the blue letterhead.\n", "Invoices use the blue letterhead, 12 pt.\n"));
    let info = reconcile.listDecisions(org.id, project.id);
    assert.equal(row(info, b).state, "promoted");
    assert.equal(row(info, b).editedInSpec, true);
    await assert.rejects(reconcile.settleSpecText(org.id, project.id, a, "keep"), /as they were promoted/);
    info = await reconcile.settleSpecText(org.id, project.id, b, "keep");
    assert.equal(row(info, b).editedInSpec, undefined);
    assert.equal(row(info, b).textKept.by, OPERATOR);
    // Edited again, then restored: the person's words come back, the record's other fields stay.
    writeFileSync(md, readFileSync(md, "utf8").replace("12 pt.", "14 pt."));
    assert.equal(row(reconcile.listDecisions(org.id, project.id), b).editedInSpec, true);
    info = await reconcile.settleSpecText(org.id, project.id, b, "restore");
    assert.equal(row(info, b).editedInSpec, undefined);
    assert.equal(row(info, b).state, "promoted");
    assert.equal(readFileSync(md, "utf8"), original, "their words, and the file as it was");
    assert.deepEqual([specManifest(client).claims[rb].authority, specManifest(client).claims[rb].requires], ["migrated", []]);
  });
});

describe("the writer changes only what it means to", () => {
  const row = (slug: string, statement: string) =>
    ({ id: `s:${slug}`, areaKey: "hosting", area: "Hosting", statement, quote: statement, name: "Tony", at: "2026-09-26T00:00:00Z", by: "p_t", sessionId: "s", entryId: "e", recordId: `§requirements.hosting/${slug}` }) as any;
  const setup = (name: string, text: string, claims: Record<string, unknown>) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, "claims", "requirements"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ formatVersion: 1, claims }, null, 2)}\n`);
    writeFileSync(join(dir, "claims", "requirements", "hosting.md"), text);
    return dir;
  };
  const x = row("x", "Runs on srv-01.");
  const y = row("y", "Backups nightly.");
  const lede = writer.renderLede("hosting", "Hosting");
  const odd = `${lede}\n${writer.renderRecord(x)}\n\n\n${writer.renderRecord(y)}\n\n`;
  const recs = { "§requirements/hosting": { kind: "note", authority: "accepted" }, [x.recordId]: { ...writer.manifestRecord(x), evidence: "verified", code: ["a.js"] }, [y.recordId]: writer.manifestRecord(y) };

  test("nothing to change: no file is written", () => {
    const dir = setup("w-same", odd, recs);
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    assert.deepEqual(writer.applyToSpecDir(dir, { rows: [x, y], supersededBy: new Map() }), []);
    assert.equal(readFileSync(join(dir, "claims", "requirements", "hosting.md"), "utf8"), odd);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);
  });
  test("a manifest-only change leaves the claim file's bytes alone and keeps the spec layer's fields", () => {
    const dir = setup("w-manifest", odd, recs);
    const x2 = { ...x, entryId: "e2" };
    assert.deepEqual(writer.applyToSpecDir(dir, { rows: [x2], supersededBy: new Map() }), [x.recordId]);
    assert.equal(readFileSync(join(dir, "claims", "requirements", "hosting.md"), "utf8"), odd);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.claims[x.recordId].provenance[0].entryId, "e2");
    assert.deepEqual([m.claims[x.recordId].evidence, m.claims[x.recordId].code], ["verified", ["a.js"]]);
  });
  test("a changed block keeps its layout; the other blocks keep their bytes; an appended one follows a blank line", () => {
    const dir = setup("w-block", odd, recs);
    const z = row("z", "Logs kept 90 days.");
    const out = writer.applyToSpecDir(dir, { rows: [z, x], supersededBy: new Map([[x.recordId, z.recordId]]) });
    assert.deepEqual(out, [x.recordId, z.recordId].sort());
    const text = readFileSync(join(dir, "claims", "requirements", "hosting.md"), "utf8");
    assert.equal(text, `${lede}\n${writer.renderRecord(x, z.recordId)}\n\n\n${writer.renderRecord(y)}\n\n\n${writer.renderRecord(z)}`, "the old bytes, then the new block");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.claims[x.recordId].supersededBy, z.recordId);
    assert.equal(m.claims[x.recordId].evidence, "verified");
    assert.deepEqual(m.claims[z.recordId], writer.manifestRecord(z), "a new record gets kind and authority");
  });
});
