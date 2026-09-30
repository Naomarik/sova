// Run: pnpm exec tsx --test server/owner-page-privacy.test.ts. §app.owner-page/never: a unique
// marker is planted in every private field the org holds (the About text, roles, voices, skills,
// contacts, referrals, decision areas, goals, briefings to others, the wrap-up, thinking and tool
// calls, the project overseer's notes, ideas, to-dos, actions, instructions and conversation,
// coding branches, worktree paths, commits and token counts, routing reasons, a proposed person, a
// hidden conversation and a switched-off project, every id kind, links and hashes, someone else's
// visit), each first shown to be really there (the positive control), then asserted absent from
// every answer the owner can get: the shell and every /api/i/ route, following every handle, plus
// the hidden ones, and the operator's preview (the same function). A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_DECISION_ENTRY, BATON_HANDOFF_ENTRY, BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY } from "../shared/baton";
import type { OwnerHome, OwnerLinkResult, OwnerProject } from "../shared/owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-leak-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { seedBuild } = await import("./org-test-fixtures");
const baton = await import("./baton");
const links = await import("./baton-links");
const plinks = await import("./person-links");
const visits = await import("./visits");
const store = await import("./project-overseer-store");
const { addIdea } = await import("./overseer-ideas");
const { addTodo } = await import("./overseer-todos");
const { logAction, writeNotes } = await import("./overseer-store");
const { recordDecision, seedConflicts } = await import("./org-test-fixtures");
const { listDecisions } = await import("./reconcile");
const { appendUpdate } = await import("./project-updates");
const { registerOrgRoutes } = await import("./org-routes");
const { createShareServer } = await import("./share/listener");
const { stateRoot } = await import("./state-root");

const server = createShareServer();
after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

/** Every marker, by the field it sits in. Each is unique and in no ordinary word. */
const M = {
  about: "MK-ABOUT-q7x",
  role: "MK-ROLE-q7x",
  ownerRole: "MK-OWNROLE-q7x",
  voice: "MK-VOICE-q7x speaks slowly with care",
  skill: "MK-SKILL-q7x advanced ledgers",
  email: "mk-email-q7x@example.test",
  phone: "+90 555 017 3377",
  whatsapp: "+90 555 017 4488",
  other: "Slack: @mk-other-q7x",
  ownerEmail: "mk-ownmail-q7x@example.test",
  language: "tr-TR",
  referralWhy: "MK-REFWHY-q7x",
  referralQuote: "MK-REFQUOTE-q7x",
  decides: "mkdecidesq",
  competence: "MK-COMP-q7x",
  goal: "MK-GOAL-q7x",
  briefingOther: "MK-BRIEF-q7x",
  wrapup: "MK-WRAPUP-q7x",
  thinking: "MK-THINK-q7x",
  toolArg: "MK-TOOLARG-q7x",
  notes: "MK-NOTES-q7x",
  idea: "MK-IDEA-q7x",
  todo: "MK-TODO-q7x",
  action: "MK-ACTION-q7x",
  extra: "MK-EXTRA-q7x",
  overseerChat: "MK-POCHAT-q7x",
  branch: "sova/mk-branch-q7x",
  worktree: "/tmp/mk-worktree-q7x",
  commit: "mkcommitq7x0000000000000000000000000000",
  tokens: "987654321",
  routeReason: "MK-ROUTE-q7x self-asserted",
  proposed: "MK-PROPOSED-q7x",
  hiddenTitle: "MK-HIDDENTITLE-q7x",
  hiddenText: "MK-HIDDENTEXT-q7x",
  offProject: "MK-OFFPROJECT-q7x",
  offTitle: "MK-OFFTITLE-q7x",
  model: "mkprov/mk-model-q7x",
  // Who started a gathering and why (§app.baton/told), and its prompt as pi 0.86+ records it.
  why: "MK-WHY-q7x",
  overseerId: "mk-overseer-q7x",
  systemPreamble: "MK-PREAMBLE-q7x",
  systemTool: "MK-SYSTOOL-q7x",
} as const;

const org = await orgs.createOrg({ name: "Gate Archery", dir: join(root, "ws") });
const ws = orgs.orgDir(org.id);
for (const d of ["a", "b"]) mkdirSync(join(root, d));
const pa = await orgs.addProject(org.id, { name: "Booking site", root: join(root, "a") });
const pb = await orgs.addProject(org.id, { name: M.offProject, root: join(root, "b") });
const alp = await orgs.addPerson(org.id, {
  name: "Alperen Kaya",
  role: M.ownerRole,
  contact: { email: M.ownerEmail },
  voice: "Formal, short sentences, owner voice",
});
const kim = await orgs.addPerson(org.id, {
  name: "Kim Lee",
  role: M.role,
  decides: [M.decides],
  skills: [M.skill],
  voice: M.voice,
  language: M.language,
  contact: { email: M.email, phone: M.phone, whatsapp: M.whatsapp, other: M.other },
});
await orgs.applyChange(org.id, kim.id, { competence: { [M.competence]: { level: 4, n: 2 } } }, { kind: "operator" });
const pat = await orgs.addPerson(
  org.id,
  { name: M.proposed, role: "Finance", status: "proposed", contact: { email: "pat@example.test" }, referral: { why: M.referralWhy, referredBy: kim.id, quote: M.referralQuote } },
  { kind: "referral" },
);
await orgs.patchOrg(org.id, { about: `${M.about}. They pay late.` });
await orgs.setOrgOwner(org.id, alp.id);

let seq = 0;
const line = (path: string, entry: Record<string, unknown>) => {
  const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id;
  const id = `e${++seq}`;
  appendFileSync(path, `${JSON.stringify({ id, parentId: last, timestamp: new Date().toISOString(), ...entry })}\n`);
  return id;
};
const said = (path: string, by: string, text: string) => {
  const id = line(path, { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
  line(path, { type: "custom", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: id, by } });
};
const reply = (path: string, content: unknown[]) => line(path, { type: "message", message: { role: "assistant", content, timestamp: Date.now() } });

// A shown conversation with Kim: her words, the model's reply echoing her profile, thinking, a
// tool call, a decision whose statement echoes her skill, a hand-off to Bob-less Alperen with a
// briefing to someone else first, and a wrap-up.
const s1 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Opening hours", goal: M.goal, briefing: M.briefingOther, model: M.model });
said(s1.path, kim.id, "We open at nine.");
reply(s1.path, [
  { type: "thinking", thinking: M.thinking },
  { type: "text", text: `Thanks. Noted: ${M.voice}. Also ${M.skill}.` },
  { type: "toolCall", id: "t1", name: "record_decision", arguments: { area: "Hours", statement: M.toolArg, quote: "We open at nine." } },
]);
await recordDecision(s1.path, { area: "Hours", statement: `The range opens at 9 (${M.skill}).`, quote: "We open at nine." });
await recordDecision(s1.path, { area: "Hours", statement: "Closed Mondays.", quote: "Mondays off" });
line(s1.path, { type: "message", message: { role: "system", content: "", sections: { preamble: M.systemPreamble, cwd: "<cwd>(none)</cwd>" }, toolsAdded: [{ name: "record_decision", description: M.systemTool, parameters: { type: "object" } }], timestamp: Date.now() } });
await baton.markDone(s1.sessionId);
line(s1.path, { type: "custom", customType: BATON_WRAPUP_ENTRY, data: { v: 1, phase: "start" } });
reply(s1.path, [{ type: "text", text: M.wrapup }]);
// A conversation waiting on Alperen, handed on from Kim with a briefing addressed to Kim only.
const s2 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Budget", goal: M.goal, briefing: M.briefingOther });
const kimToken = baton.rotateLink(s2.sessionId).token;
await baton.handTo(s2.sessionId, alp.id, "What is the budget?", "For Alperen: the budget question.");
// As hand_to leaves it in the transcript: the first hand-off's briefing is Kim's, the second Alperen's.
line(s2.path, { type: "custom", customType: BATON_HANDOFF_ENTRY, data: { v: 1, n: 1, from: "operator", to: kim.id, question: "Budget?", briefing: M.briefingOther } });
line(s2.path, { type: "custom", customType: BATON_HANDOFF_ENTRY, data: { v: 1, n: 2, from: kim.id, to: alp.id, question: "What is the budget?", briefing: "For Alperen: the budget question." } });
// Hidden from the owner.
const s3 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: M.hiddenTitle, goal: "g" });
said(s3.path, kim.id, M.hiddenText);
await baton.setHiddenFromOwner(s3.sessionId, true);
// On a switched-off project.
const s4 = await baton.createBaton({ orgId: org.id, projectId: pb.id, to: kim.id, publicTitle: M.offTitle, goal: "g" });
await orgs.patchProject(org.id, pb.id, { ownerHidden: true });
// Started by the global Overseer, with its conversation and its why on the statechart; shown to the owner.
const s5 = await baton.createBaton(
  { orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hours again", goal: "g" },
  { by: { kind: "operator", via: "overseer", overseerId: M.overseerId, card: { people: [kim.id], projects: [pa.id], sessions: [] } }, mintLink: false, startedVia: "overseer", why: M.why },
);
said(s5.path, kim.id, "Still nine.");
// A conflict with a candid routing reason.
const ds = listDecisions(org.id, pa.id).decisions;
await seedConflicts(org.id, pa.id, [
  { id: "cf_mkmkmkmk", orgId: org.id, projectId: pa.id, areaKey: "hours", a: ds[0]!.id, b: ds[1]!.id, p: 0.9, routedTo: "operator", routeReason: M.routeReason, selfAsserted: true, state: "open", createdAt: new Date().toISOString() },
]);
// The project overseer's files.
const paths = store.projectOverseerPaths(org.id, pa.id);
mkdirSync(paths.dir, { recursive: true });
writeNotes(`${M.notes}\n`, paths.notes);
addIdea({ id: "§gap/mk", title: M.idea, text: M.idea, tags: [] }, paths.ideas);
addTodo({ text: M.todo }, paths.todos, paths.ideas);
logAction({ at: new Date().toISOString(), overseerId: "po", toolCallId: "t", tool: "sova_note", args: { text: M.action }, outcome: "ok" }, paths.actions);
writeFileSync(paths.settings, JSON.stringify({ version: 1, extraSystemPrompt: M.extra }));
writeFileSync(join(ws, "sessions", "2026-09-27T00-00-00-000Z_po-mk.jsonl"), `${JSON.stringify({ type: "session", id: "po-mk", cwd: "/", timestamp: "" })}\n${JSON.stringify({ type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: M.overseerChat }] } })}\n`);
// A build in its worktree, merged (the legacy token count is gone with started.json: nothing carries M.tokens).
await seedBuild(org.id, pa.id, { sessionId: "code-mk-1", kind: "coding", path: `${M.worktree}/s.jsonl`, worktree: { path: M.worktree, branch: M.branch, base: M.commit, target: "main" }, merged: { commit: M.commit } });
// A milestone update whose text (as a model might) echoes a profile phrase: the page's filter blanks it.
appendUpdate(org.id, pa.id, { text: `Opening hours are agreed. ${M.voice}.`, run: "auto" });
// Kim opened her own link: her visit is hers alone.
visits.recordOpen(links.findLink(kimToken)!, { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0" });

const app = new Hono();
registerOrgRoutes(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ownerLink = (await (await app.request(`/api/orgs/${org.id}/owner/link`)).json()) as OwnerLinkResult;
const token = ownerLink.link.slice(ownerLink.link.indexOf("/i/") + 3);

/** Every identifier and capability the owner must never learn. */
const ids = (): string[] => [
  org.id,
  pa.id,
  pb.id,
  alp.id,
  kim.id,
  pat.id,
  ...[s1, s2, s3, s4, s5].map((s) => s.sessionId),
  ...ds.map((d) => d.id),
  "cf_mkmkmkmk",
  kimToken,
  links.findLink(kimToken)!.hash,
  plinks.findPersonLink(token)!.hash,
  ws,
  root,
  "Firefox",
];

/** Everything the owner can fetch, and the operator's preview of it: [label, body]. */
async function everyAnswer(): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const get = async (p: string) => {
    const res = await fetch(base + p, { headers: { "user-agent": "Mozilla/5.0 (iPhone) Version/17.0 Safari/604.1" } });
    const text = await res.text();
    out.push([`${res.status} GET ${p}`, text]);
    return { status: res.status, text };
  };
  await get(`/i/${token}`);
  const home = await get(`/api/i/${token}`);
  assert.equal(home.status, 200, home.text);
  const h = JSON.parse(home.text) as OwnerHome;
  const projects = new Set([...h.projects.map((p) => p.id), plinks.handleOf("q", pa.id), plinks.handleOf("q", pb.id)]);
  const conversations = new Set([...h.waiting.map((w) => w.conversation), ...[s1, s2, s3, s4, s5].map((s) => plinks.handleOf("k", s.sessionId))]);
  for (const q of projects) {
    const r = await get(`/api/i/${token}/p/${q}`);
    if (r.status === 200) for (const c of (JSON.parse(r.text) as OwnerProject).conversations) conversations.add(c.id);
  }
  for (const k of conversations) await get(`/api/i/${token}/c/${k}`);
  for (const p of [`/api/orgs/${org.id}/owner/preview`, ...[...projects].map((q) => `/api/orgs/${org.id}/owner/preview?project=${q}`), ...[...conversations].map((k) => `/api/orgs/${org.id}/owner/preview?c=${k}`)]) {
    const res = await app.request(p);
    out.push([`${res.status} preview ${p}`, await res.text()]);
  }
  return out;
}

/** Every file of the org's workspace and Sova's state, as text: where a planted marker must be. */
function everyFile(): string {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === ".git" ? [] : e.isDirectory() ? files(join(dir, e.name)) : statSync(join(dir, e.name)).size < 5_000_000 ? [join(dir, e.name)] : []));
  return [...files(ws), ...files(stateRoot())].map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("nothing private reaches the owner (§app.owner-page/never)", async () => {
  const answers = await everyAnswer();

  test("positive control: every marker is really in the org's records, and the pages did answer", async () => {
    const all = everyFile() + JSON.stringify(await (await app.request(`/api/orgs/${org.id}`)).json());
    // Recorded nowhere any more (q1): a build's worktree folder is this host's, found by its branch; the
    // legacy token count went with started.json. Both stay in the leak checks below.
    const unrecorded = new Set(["worktree", "tokens"]);
    for (const [field, mark] of Object.entries(M)) if (!unrecorded.has(field)) assert.ok(all.includes(mark), `${field} was planted`);
    for (const field of unrecorded) assert.ok(!all.includes(M[field as keyof typeof M]), `${field} is recorded nowhere (q1: no started.json)`);
    const ok = answers.filter(([label]) => label.startsWith("200"));
    assert.ok(ok.some(([l]) => l.includes("/p/")) && ok.some(([l]) => l.includes("/c/")) && ok.some(([l]) => l.includes("preview")), answers.map(([l]) => l).join("\n"));
    const home = JSON.parse(answers.find(([l]) => l === `200 GET /api/i/${token}`)![1]) as OwnerHome;
    assert.equal(home.projects.length, 1);
    assert.equal(home.waiting.length, 1, "the owner's own question shows");
    assert.equal(home.projects[0]!.latestNews?.text.includes("Opening hours are agreed."), true, "the update shows");
    assert.ok(
      answers.some(([, t]) => t.includes("We open at nine.")),
      "control: a person's own words in a shown conversation do reach the owner",
    );
    assert.ok(answers.some(([, t]) => t.includes("For Alperen: the budget question.")), "control: a briefing addressed to the owner shows");
  });

  test("no marker, id, token, hash or path in any answer", () => {
    for (const [label, body] of answers) {
      for (const [field, mark] of Object.entries(M)) assert.ok(!body.includes(mark), `${field} leaked in ${label}`);
      for (const id of ids()) assert.ok(!body.includes(id), `${id} leaked in ${label}`);
      assert.ok(!body.includes(token), `the owner's own token echoed in ${label}`);
      if (label.includes(" GET /i/")) continue; // the static shell: markers and ids only
      // Keys that would carry a cost, a model, a visit or a profile field.
      const keys = [...body.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]!);
      for (const bad of ["cost", "tokens", "model", "thinking", "device", "lastSeenAt", "language", "role", "voice", "contact", "skills", "decides", "competence", "goal", "sessionId", "personId", "path", "file", "branch", "routeReason"])
        assert.ok(!keys.includes(bad), `key ${bad} in ${label}`);
    }
  });

  test("who started it and why stay on the operator's strip: never the session list's baton field or the org page's rows (§app.baton/told)", async () => {
    const strip = await (await app.request(`/api/baton?path=${encodeURIComponent(s5.path)}`)).text();
    assert.ok(strip.includes(M.why) && strip.includes(M.overseerId), "control: the operator's strip carries them");
    const told = await (await app.request(`/api/baton/${s5.sessionId}/told`)).text();
    assert.ok(told.includes(M.why), "control: What It's Told carries the why");
    const toldS1 = await (await app.request(`/api/baton/${s1.sessionId}/told`)).text();
    assert.ok(toldS1.includes(M.systemPreamble) && toldS1.includes(M.systemTool), "control: What It's Told carries the recorded prompt and tools");
    const page = await (await app.request(`/api/orgs/${org.id}`)).text();
    const summaries = JSON.stringify([s1, s2, s3, s4, s5].map((x) => baton.batonSummaryField(x.path)));
    for (const [label, body] of [["the org page", page], ["the session list's baton field", summaries]] as const)
      for (const mark of [M.why, M.overseerId, M.systemPreamble, M.systemTool]) assert.ok(!body.includes(mark), `${mark} in ${label}`);
  });

  test("hidden conversations and switched-off projects answer 404, the same as a random handle", () => {
    const by = (p: string) => answers.find(([l]) => l.endsWith(`GET ${p}`))!;
    const random = answers.find(([l]) => l.includes(`/c/${plinks.handleOf("k", s3.sessionId)}`) && l.includes("GET"))!;
    assert.match(random[0], /^404/);
    assert.match(by(`/api/i/${token}/c/${plinks.handleOf("k", s4.sessionId)}`)[0], /^404/);
    assert.match(by(`/api/i/${token}/p/${plinks.handleOf("q", pb.id)}`)[0], /^404/);
    assert.equal(random[1], by(`/api/i/${token}/p/${plinks.handleOf("q", pb.id)}`)[1]);
  });
});

// ---- the structure: what the Owner page's code may read ------------------------------------------------

describe("the Owner page's code never reads private stores", () => {
  const serverDir = resolve(import.meta.dirname);
  const read = (f: string) => readFileSync(join(serverDir, f), "utf8");
  const files = ["owner-page.ts", "owner.ts", "person-links.ts", "project-updates.ts", ...readdirSync(join(serverDir, "share")).map((f) => `share/${f}`)];

  test("no About text, overseer notes, ideas, to-dos, actions, settings or instructions reader; no coding titles, usage or costs", () => {
    const forbidden = /\b(readOrgAbout|readOrgHistory|readNotes|readManifest|readProse|promptToc|readTodos|readPoSettings|readPoState|logAction|getSessionSummary|getSessionInsight|piUsageTally|projectCost|orgCosts|readCostLedger|readUsageLedger|appendUsage|priceMessage|readActions)\b|"\.\.?\/(overseer-(store|ideas|todos)|project-costs|model-prices)"|"\.\.\/shared\/(costs|model-prices)"|about\.md|notes\.md|actions\.jsonl|costs\.json|usage\.jsonl/;
    for (const f of files) assert.doesNotMatch(read(f), forbidden, relative(serverDir, join(serverDir, f)));
  });

  test("the page never spreads a record into an answer", () => {
    const text = read("owner-page.ts");
    // A spread of a record itself (`...row`), not of a list drawn from one (`...row.handoffs.map(…)`).
    assert.doesNotMatch(text, /\.\.\.(row|person|owner|project|org|d|c|p|u|l|r|link|view|hit)\b(?![.(\[])/);
  });
});
