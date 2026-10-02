// Run: pnpm exec tsx --test server/overseer-org-part.test.ts. The organization's part of a placed project's
// overseer (server/overseer-org-part.ts): its tools against a real org engine, as the project layer's runtime
// builds them (toolsForTest). A throwaway PI_CODING_AGENT_DIR, workspace and project roots; synthetic people;
// no model is called (the reconciler's decide seam is a fake).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_SENT_ENTRY } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-part-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
process.env.SOVA_SHARE_PUBLIC_URL = "https://share.example.invalid";

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const decisions = await import("./decisions");
const reconcile = await import("./reconcile");
const { appendSendLog } = await import("./outreach/log");
const { hostOf } = await import("./org-engine");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { recordDecision, seedConflicts } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  reconcile.setReconcileDeps(null);
});

// No contradictions; each decision is filed under the area it names.
reconcile.setReconcileDeps({
  provider: () =>
    ({
      id: "chain",
      label: "fake",
      async decide(req: any) {
        const answers: Record<string, any> = {};
        for (const [qid, q] of Object.entries<any>(req.questions)) {
          if (q.type === "boolean") answers[qid] = { type: "boolean", p: 0.05 };
          else if (qid.startsWith("pair")) answers[qid] = { type: "choice", choice: "different", probabilities: { conflict: 0.05, same: 0, different: 0.95 }, confidence: 1 };
          else {
            const choice = decisions.areaKeyOf(req.state?.new?.[qid]?.name ?? "invoicing");
            answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
          }
        }
        return { answers, provider: "jev", model: "fake", latencyMs: 1 };
      },
    }) as never,
  excluded: () => false,
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT", decides: ["invoicing"], contact: { email: "tony@example.invalid", phone: "15550000101" } });
const ana = await orgs.addPerson(org.id, { name: "Ana", role: "Finance", decides: ["payroll"], contact: { email: "ana@example.invalid", phone: "15550000102" } });
await orgs.addPerson(org.id, { name: "Bob", status: "proposed", role: "Ops", contact: { email: "bob@example.invalid" }, referral: { why: "Runs the warehouse.", referredBy: tony.id } });
await orgs.addPerson(org.id, { name: "Bea", status: "proposed", role: "Ops", contact: { email: "bea@example.invalid" }, referral: { why: "Keeps the books.", referredBy: tony.id } });

async function placed(name: string) {
  mkdirSync(join(root, name));
  const project = await orgs.addProject(org.id, { name, root: join(root, name) });
  await po.ensureProjectOverseer(project.id);
  return project;
}

const portal = await placed("portal");
// Room for every gathering these tests start (the allowances are the watch statechart's; its own tests).
await po.patchProjectOverseer(portal.id, { caps: { gatherPerTurn: 20, gatherPerDay: 20, gatheringsOpen: 20 } });

type Out = { content: { text: string }[] };
const textOf = (r: unknown): string => (r as Out).content[0]!.text;
const tools = (projectId: string, attended: boolean) => po.toolsForTest(projectId, { attended });
const tool = (name: string, projectId = portal.id, attended = true) => {
  const t = tools(projectId, attended).find((x) => x.name === name);
  assert.ok(t, name);
  return t;
};
const run = (name: string, params: Record<string, unknown> = {}, opts: { project?: string; attended?: boolean } = {}) =>
  tool(name, opts.project, opts.attended).execute("call-1", params as never, undefined, undefined, undefined as never);
const settings = (projectId: string, patch: Record<string, unknown>) => po.patchProjectOverseer(projectId, patch as never);
const actions = (projectId = portal.id) => {
  const file = store.projectOverseerPaths(projectId).actions;
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const ownBatons = (projectId = portal.id) => baton.allBatons().filter((b) => b.projectId === projectId);
const gather = { gap: "none", person: "Tony", why: "Nobody has said this yet.", public_title: "Invoicing", goal: "Who approves invoices", question: "Who approves invoices?" };

describe("the org part reaches a placed project's overseer only", () => {
  test("a standalone project's overseer has none of the org tools", async () => {
    mkdirSync(join(root, "alone"));
    const { registerProjectIn } = await import("./projects/spaces");
    const alone = (await registerProjectIn("standalone", join(root, "alone"), { name: "Alone", origin: "folder" })).project;
    await po.ensureProjectOverseer(alone.id);
    const names = po.toolsForTest(alone.id).map((t) => t.name);
    for (const n of ["sova_roster", "sova_decisions", "sova_start_gathering", "sova_offer", "sova_send_status", "sova_promote"]) assert.ok(!names.includes(n), n);
    assert.ok(tool("sova_roster"), "a placed project's overseer has them");
  });
});

describe("its levels (§app.project-overseer/autonomy-levels)", () => {
  test("sova_roster: read at any level, never contact details; approving needs L2 outside the operator's turns", async () => {
    await settings(portal.id, { autonomy: "L0" });
    const out = await run("sova_roster", { op: "read" }, { attended: false });
    assert.match(textOf(out), /Tony/);
    assert.doesNotMatch(JSON.stringify(out), /example\.invalid|1555000010/, "contact details never reach the model");
    await assert.rejects(() => run("sova_roster", { op: "approve", person: "Bea" }, { attended: false }), /sova_roster needs L2/);
    await settings(portal.id, { autonomy: "L2", holdMin: 0 });
    const ok = await run("sova_roster", { op: "approve", person: "Bea" }, { attended: false });
    assert.equal(textOf(ok), "Bea is now active.");
    await settings(portal.id, { autonomy: "L1" });
  });

  test("sova_send_status is a read at every level", async () => {
    await settings(portal.id, { autonomy: "L0" });
    assert.match(textOf(await run("sova_send_status", {}, { attended: false })), /no WhatsApp sends match/);
    await settings(portal.id, { autonomy: "L1" });
  });
});

describe("gathering abilities (§app.baton/abilities)", () => {
  const abilitiesOf = (r: unknown) => baton.batonById((r as { details: { id: string } }).details.id)!.row.abilities;
  test("a start with no abilities gets the project's set: Automatic is draw on, read links off", async () => {
    assert.deepEqual(abilitiesOf(await run("sova_start_gathering", gather)), { draw: true, readLinks: false });
  });
  test("it may turn draw off or on, and read links only when the project allows it", async () => {
    await settings(portal.id, { gatheringAbilities: { draw: false, readLinks: false } });
    assert.deepEqual(abilitiesOf(await run("sova_start_gathering", { ...gather, abilities: { draw: true } })), { draw: true, readLinks: false });
    const before = ownBatons().length;
    await assert.rejects(
      () => run("sova_offer", { gap: "none", people: ["Tony", "Ana"], why: "Nobody has said this yet.", public_title: "x", goal: "g", question: "q?", abilities: { read_links: true } }),
      /Reading links is off for this project's gathering sessions; the operator can allow it on the project page\./,
    );
    assert.equal(ownBatons().length, before, "the refusal reached no statechart, so it started nothing");
    await settings(portal.id, { gatheringAbilities: { draw: true, readLinks: true } });
    assert.deepEqual(abilitiesOf(await run("sova_start_gathering", { ...gather, abilities: { draw: false } })), { draw: false, readLinks: true });
    assert.deepEqual(abilitiesOf(await run("sova_start_gathering", { ...gather, abilities: { read_links: false } })), { draw: true, readLinks: false });
    await settings(portal.id, { gatheringAbilities: null });
  });
  test("an unknown ability or a non-boolean is refused before anything starts", async () => {
    const before = ownBatons().length;
    await assert.rejects(() => run("sova_start_gathering", { ...gather, abilities: { search: true } }), /Unknown ability search/);
    await assert.rejects(() => run("sova_start_gathering", { ...gather, abilities: { draw: "yes" } }), /abilities\.draw must be true or false/);
    assert.equal(ownBatons().length, before);
  });
});

describe("who a gathering goes to", () => {
  test("gathering refuses people not on the roster, proposed people, and a one-person offer", async () => {
    const before = ownBatons().length;
    await assert.rejects(() => run("sova_start_gathering", { gap: "none", person: "Zed", why: "Nobody has said this yet.", public_title: "x", goal: "y", question: "q" }), /not on the roster/);
    await assert.rejects(() => run("sova_start_gathering", { gap: "none", person: "Bob", why: "Nobody has said this yet.", public_title: "x", goal: "y", question: "q" }), /proposed but not approved/);
    await assert.rejects(() => run("sova_offer", { gap: "none", people: ["Tony"], why: "Nobody has said this yet.", public_title: "x", goal: "y", question: "q" }), /at least two/);
    await assert.rejects(() => run("sova_start_gathering", { gap: "none", person: "Tony", why: "Nobody has said this yet.", public_title: "x", goal: "y" }), /question \(both shown to the person as written/, "no question: no fallback to internal text");
    await assert.rejects(() => run("sova_offer", { gap: "none", people: ["Tony", "Ana"], goal: "y", question: "q" }), /Give public_title and question/);
    assert.equal(ownBatons().length, before);
  });

  test("the goal and the done summary ask for people by name only (the session's model may repeat them)", () => {
    for (const name of ["sova_start_gathering", "sova_offer"]) {
      const goal = (tool(name).parameters as any).properties.goal.description;
      assert.match(goal, /by name only, never by role or job title/, name);
      assert.match(goal, /never say how the answers will be recorded or under which area \("as finance decisions"\)/, name);
    }
  });
});

describe("closing its own gatherings (NEW-MS2-2)", () => {
  const start = async (title: string) => (await run("sova_start_gathering", { ...gather, public_title: title }) as unknown as { details: { id: string } }).details.id;
  const close = (session: string, reason = "old") => run("sova_close_gathering", { session, reason });

  test("closes only one it started that nobody has written in, with its reason as the note", async () => {
    const unsent = await start("Invoices");
    const out = await close(`sova://s/${unsent}`, "covered by the newer invoicing session");
    assert.match(textOf(out), /Closed/);
    assert.equal(baton.batonById(unsent)!.row.state, "closed");
    assert.equal(actions().at(-1).note, "Closed: covered by the newer invoicing session");
  });

  test("never a settle session, the operator's, one already over or one someone answered; a reason is required", async () => {
    const answered = await start("Answered");
    baton.noteMessage(answered, tony.id);
    const over = await start("Over");
    await baton.markDone(over);
    const unsent = await start("Unsent");
    const theirs = (await baton.createBaton({ orgId: org.id, projectId: portal.id, to: tony.id, publicTitle: "Theirs", goal: "g", question: "q?" })).sessionId;
    const conflict = { id: "cf_aaaa0001", orgId: org.id, projectId: portal.id, areaKey: "invoicing", a: "x:1", b: "x:2", p: 0.9, routedTo: tony.id, routeReason: "Tony decides invoicing.", batonSessionId: "settle-1", state: "open", createdAt: new Date().toISOString() };
    const settle = (await seedConflicts(org.id, portal.id, [conflict as never], { owner: { overseerOf: portal.id } }))[conflict.id]!;
    const before = ownBatons().filter((b) => b.state === "closed").length;
    await assert.rejects(close(settle), /settle session: the conflict ends when it is settled/);
    await assert.rejects(close(theirs), /Not one of your gathering sessions/);
    await assert.rejects(close("nope"), /Not one of your gathering sessions/);
    await assert.rejects(close(over), /It is already done/);
    await assert.rejects(close(answered), /already written in it/);
    await assert.rejects(close(unsent, " "), /Say why/);
    assert.equal(ownBatons().filter((b) => b.state === "closed").length, before, "nothing closed");
  });

  test("its description says when: a newer gathering covers an unanswered one", () => {
    assert.match(tool("sova_close_gathering").description, /nobody has written in yet: when a newer one covers it/);
  });
});

/** A gathering session with `person` where they said `statement` (recorded as a decision). Its id. */
async function decided(projectId: string, person: { id: string }, area: string, statement: string, ownerArea?: string): Promise<string> {
  const b = await baton.createBaton({ orgId: org.id, projectId, to: person.id, publicTitle: "Rules", goal: "g", question: "q?" });
  const last = JSON.parse(readFileSync(b.path, "utf8").trim().split("\n").at(-1)!).id;
  const ts = new Date().toISOString();
  const msg = { type: "message", id: `u${b.sessionId.slice(0, 7)}`, parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: statement }] } };
  const sent = { type: "custom", customType: BATON_SENT_ENTRY, id: `s${b.sessionId.slice(0, 7)}`, parentId: msg.id, timestamp: ts, data: { v: 1, targetId: msg.id, by: person.id } };
  appendFileSync(b.path, `${JSON.stringify(msg)}\n${JSON.stringify(sent)}\n`);
  return recordDecision(b.path, { area, ownerArea: ownerArea ?? area, statement, quote: statement });
}

describe("decisions and promotion", async () => {
  const ledger = await placed("ledger");
  const inArea = await decided(ledger.id, tony, "invoicing", "Invoices are due in thirty days.");
  const second = await decided(ledger.id, tony, "invoicing", "Invoices carry the order number.");
  const contested = await decided(ledger.id, tony, "invoicing", "Invoices go out on Fridays.");
  const outArea = await decided(ledger.id, ana, "invoicing", "Invoices use the blue letterhead.", "invoicing");
  await settings(ledger.id, { autonomy: "L2" });
  await run("sova_reconcile", {}, { project: ledger.id });
  await seedConflicts(org.id, ledger.id, [{ id: "cf_bbbb0001", orgId: org.id, projectId: ledger.id, areaKey: "invoicing", a: contested, b: second, p: 0.9, routedTo: tony.id, routeReason: "Tony decides invoicing.", state: "open", createdAt: new Date().toISOString() } as never]);

  test("owner areas reach the promotion check (NEW-MS-5): sova_decisions shows each decision's owner area and whether its author decides it", async () => {
    const out = textOf(await run("sova_decisions", {}, { project: ledger.id }));
    assert.match(out, new RegExp(`${inArea} · invoicing · drafted · Tony: Invoices are due in thirty days\\.\\n  owner area: invoicing · the author decides it`));
    assert.match(out, new RegExp(`${outArea} · invoicing · drafted · Ana: .*\\n  owner area: invoicing · outside the author's decision area`));
    assert.match(tool("sova_promote", ledger.id).description, /check its owner area fits what it is about/);
  });

  test("sova_promote accounts for every id: promoted, refused with the reconciler's reason, or refused as unknown", async () => {
    const out = textOf(await run("sova_promote", { ids: [inArea, contested, "nope"] }, { project: ledger.id }));
    assert.match(out, new RegExp(`^Promoted 1, refused 2: ${contested} \\(it is conflict; only a reconciled \\(drafted\\) decision can be promoted\\); nope \\(not a drafted decision of this project \\(sova_decisions state drafted lists them; run sova_reconcile first\\)\\)\\.`));
    await assert.rejects(() => run("sova_promote", { ids: ["nope", contested] }, { project: ledger.id }), /^Error: Promoted 0, refused 2/);
    // An out-of-area decision: refused even in the operator's own turn, the reconciler's reason relayed as is.
    await assert.rejects(() => run("sova_promote", { ids: [outArea] }, { project: ledger.id }), new RegExp(`${outArea} \\(outside Ana's decision area: promote it explicitly by id\\)`));
    const log = actions(ledger.id).filter((a) => a.tool === "sova_promote");
    assert.equal(log.at(-1).outcome, "refused", "nothing promoted is a refusal, not an ok");
    // Each case's own log line: some refused is partial (with what), all promoted is ok.
    assert.deepEqual([log[0].outcome, log[0].error], ["partial", `2 refused: ${contested} (it is conflict; only a reconciled (drafted) decision can be promoted); nope (not a drafted decision of this project (sova_decisions state drafted lists them; run sova_reconcile first))`]);
    assert.doesNotMatch(out, /"partial"/, "the model never sees the log's field");
  });

  test("all promoted is ok", async () => {
    const books = await placed("books");
    const one = await decided(books.id, tony, "invoicing", "Invoices are numbered per year.");
    await settings(books.id, { autonomy: "L2" });
    await run("sova_reconcile", {}, { project: books.id });
    assert.match(textOf(await run("sova_promote", { ids: [one] }, { project: books.id })), /^Promoted 1, refused 0\./);
    const last = actions(books.id).filter((a) => a.tool === "sova_promote").at(-1);
    assert.deepEqual([last.outcome, last.error], ["ok", undefined]);
  });
});

describe("what is built reaches the overseer (§app.requirements/decisions)", async () => {
  const shop = await placed("shop");
  const a = await decided(shop.id, tony, "invoicing", "Invoices are due after thirty days.");
  const b = await decided(shop.id, tony, "invoicing", "Invoices show the shop's logo.");
  await settings(shop.id, { autonomy: "L2" });

  test("sova_decisions and sova_project say built or not built yet, and edited in the spec", async () => {
    await run("sova_reconcile", {}, { project: shop.id });
    await run("sova_promote", { ids: [a, b] }, { project: shop.id });
    // The builder records evidence and code on A; B's prose is edited in the spec.
    const manifestFile = join(root, "shop", ".sova", "spec", "manifest.json");
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    const rows = reconcile.listDecisions(org.id, shop.id).decisions;
    const ra = (rows.find((d) => d.id === a) as any).recordId;
    Object.assign(m.claims[ra], { evidence: "verified", code: ["src/due.js"] });
    writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
    const md = join(root, "shop", ".sova", "spec", "claims", "requirements", "invoicing.md");
    writeFileSync(md, readFileSync(md, "utf8").replace("Invoices show the shop's logo.\n", "Invoices show the shop's logo, top left.\n"));
    await run("sova_reconcile", {}, { project: shop.id });
    const out = textOf(await run("sova_decisions", {}, { project: shop.id }));
    assert.match(out, new RegExp(`${a} · invoicing · promoted · built \\(as the build recorded it\\)`));
    assert.match(out, new RegExp(`${b} · invoicing · promoted · not built yet · edited in the spec since it was promoted`));
    assert.match(textOf(await run("sova_project", {}, { project: shop.id })), /exists · 2 promoted · 1 built, 1 not built yet · 0 drafted, not promoted/);
  });
});

describe("sova_send_status (§app.project-overseer/tools): whether a message arrived", () => {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const line = (x: Record<string, unknown>) => appendSendLog(org.id, { channel: "whatsapp", intent: "send", projectId: portal.id, ...x } as never);

  test("its description says it checks whether a message arrived, never the number, the link or the note", () => {
    const t = tool("sova_send_status");
    assert.match(t.description, /Check whether a WhatsApp message arrived/);
    assert.match(t.description, /never see their number, the link or the note's text/);
  });

  test("each send's id, person, what went, who, latest state with its reason, and time; held first; filters by person, limit and hours", async () => {
    line({ id: "o_read0001", personId: tony.id, note: true, by: "project-overseer", event: "read", at: ago(1) });
    line({ id: "o_refu0001", personId: ana.id, link: "preview", by: "project-overseer", event: "refused", code: "preview-address", at: ago(2) });
    line({ id: "o_fail0001", personId: tony.id, link: "handoff", by: "operator", event: "failed", code: "not-on-whatsapp", at: ago(30) });
    // One waiting in the hold: the overseer's own, unattended.
    await settings(portal.id, { autonomy: "L1", holdMin: 10 });
    const session = (await baton.createBaton({ orgId: org.id, projectId: portal.id, to: tony.id, publicTitle: "Hours", goal: "g", question: "q?" })).sessionId;
    assert.match(textOf(await run("sova_send_to_person", { person: "Tony", session, note: "Your link." }, { attended: false })), /^Held: /);
    const held = hostOf(org.id).holds().find((h) => h.event === "outreach/send")!;
    assert.ok(held);

    await settings(portal.id, { autonomy: "L0" });
    const all = textOf(await run("sova_send_status", {}, { attended: false })).split("\n");
    assert.equal(all.length, 4);
    assert.match(all[0]!, new RegExp(`^- ${held.sessionId}:${held.id} · Tony · a gathering link with a note · by you · held · goes at `));
    assert.match(all[1]!, /^- o_read0001 · Tony · a note · by you · read · at /);
    assert.match(all[2]!, /^- o_refu0001 · Ana · a preview link · by you · refused \(preview-address: no preview address was available \(Settings → Public links\)\) · at /);
    assert.match(all[3]!, /by the operator · failed \(not-on-whatsapp: the number has no WhatsApp account\)/);
    const anas = textOf(await run("sova_send_status", { person: "ana" }));
    assert.deepEqual(anas.split("\n").map((l) => l.split(" · ")[0]), ["- o_refu0001"]);
    const recent = textOf(await run("sova_send_status", { hours: 24 }));
    assert.doesNotMatch(recent, /o_fail0001/, "older than 24 h");
    assert.match(recent, new RegExp(held.id), "a held one is always current");
    assert.equal(textOf(await run("sova_send_status", { limit: 1 })).split("\n").length, 1);
    await assert.rejects(() => run("sova_send_status", { person: "Zed" }), /Zed is not on the roster/);
  });
});
