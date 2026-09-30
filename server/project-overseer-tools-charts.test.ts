// Run: pnpm exec tsx --test server/project-overseer-tools-charts.test.ts. The project overseer's tools and the
// Pipeline/held-act routes against the real engine host: the level, the allowances and the holds are the
// charts' (§app.project-overseer/autonomy-levels, /limits, /holds, /pipeline, /corrections). Throwaway
// workspace and PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { PipelineInfo, PipelineTimeline } from "../shared/pipeline";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-charts-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { envelopeFor, hostOf, setOrgClockForTest } = await import("./org-engine");
const { heldAttention } = await import("./project-pipeline");
const { fakeLooks } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] });
const toni = await orgs.addPerson(org.id, { name: "Toni Diaz", role: "Payroll", decides: ["payroll"] });
await po.ensureProjectOverseer(org.id, project.id);
fakeLooks(org.id);
const app = new Hono();
registerOrgRoutes(app);

const projectSid = `project/${org.id}/${project.id}`;
const tools = (attended: boolean) => po.toolsForTest(org.id, project.id, { attended });
const run = (name: string, params: Record<string, unknown>, attended = false) => {
  const t = tools(attended).find((x) => x.name === name);
  assert.ok(t, name);
  return t.execute("call-1", params as never, undefined, undefined, undefined as never);
};
const textOf = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text;
const actions = () =>
  existsSync(store.projectOverseerPaths(org.id, project.id).actions)
    ? readFileSync(store.projectOverseerPaths(org.id, project.id).actions, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
const gather = (title: string, person = "Tony Reyes") => ({ person, public_title: title, goal: "Who hosts the portal", question: "Who hosts the portal?" });
const settings = (patch: Parameters<typeof po.patchProjectOverseer>[2]) => po.patchProjectOverseer(org.id, project.id, patch);
const holdsOf = () => hostOf(org.id).holds().filter((h) => (h.projectId ?? h.sessionId.split("/")[2]) === project.id);
/** Cancel every held act of the project (a test's leftovers), as the operator. */
const clearHolds = async () => {
  for (const h of holdsOf()) {
    const r = await app.request(`/api/orgs/${org.id}/held/${encodeURIComponent(h.id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, await r.text());
  }
};

describe("the level is the charts' (§app.project-overseer/autonomy-levels)", () => {
  test("unattended below a tool's level: the chart's refusal, logged as refused; nothing starts", async () => {
    await settings({ autonomy: "L0", holdMin: 10 });
    const before = baton.allBatons().length;
    await assert.rejects(() => run("sova_start_gathering", gather("Hosting")), /^Error: This run was not started by the operator, and your autonomy here is L0; sova_start_gathering needs L1\. Do not retry it\./);
    await assert.rejects(() => run("sova_reconcile", {}), /sova_reconcile needs L1/);
    assert.equal(baton.allBatons().length, before, "no gathering started");
    assert.deepEqual(actions().slice(-2).map((a) => [a.tool, a.outcome]), [["sova_start_gathering", "refused"], ["sova_reconcile", "refused"]]);
  });

  test("at the level: it goes ahead, unattended into a hold the operator may cancel (q10/r4)", async () => {
    await settings({ autonomy: "L1", holdMin: 10 });
    const out = textOf(await run("sova_start_gathering", gather("Hosting")));
    assert.match(out, /^Held: starting "Hosting" with Tony Reyes waits until .* so the operator can cancel it; it goes ahead then unless cancelled\.$/);
    assert.equal(holdsOf().length, 1);
    await clearHolds();
  });

  test("an autonomy change applies at the next tool call", async () => {
    await settings({ autonomy: "L0" });
    await assert.rejects(() => run("sova_offer", { people: ["Tony Reyes", "Toni Diaz"], public_title: "Pay day", goal: "g", question: "q?" }), /sova_offer needs L1|sova_start_gathering needs L1/);
    await settings({ autonomy: "L1" });
    assert.match(textOf(await run("sova_offer", { people: ["Tony Reyes", "Toni Diaz"], public_title: "Pay day", goal: "g", question: "q?" })), /^Held: starting "Pay day" as an offer to Tony Reyes, Toni Diaz/);
    await clearHolds();
  });

  test("attended (the operator's own message): it runs at once, even at L0", async () => {
    await settings({ autonomy: "L0", holdMin: 10 });
    const out = textOf(await run("sova_start_gathering", gather("Invoices"), true));
    assert.match(out, /^Started \[Invoices\]\(sova:\/\/s\/[^)]+\) with Tony Reyes/);
    assert.equal(holdsOf().length, 0, "the operator's turn is never held");
  });

  test("sova_roster: approve needs L2 unattended (the person chart's person/approve), then it is held (r6)", async () => {
    await settings({ autonomy: "L1", holdMin: 10 });
    await orgs.addPerson(org.id, { name: "Bob Smith", role: "IT lead", contact: { email: "bob@example.test" }, status: "proposed", referral: { referredBy: tony.id, why: "runs the bank portal", quote: "ask Bob" } }, { kind: "referral", sessionId: "s-ref" } as never);
    assert.equal(orgs.readRoster(org.id).find((p) => p.name === "Bob Smith")?.status, "proposed");
    await assert.rejects(() => run("sova_roster", { op: "approve", person: "Bob Smith" }), /sova_roster needs L2/);
    await settings({ autonomy: "L2" });
    assert.match(textOf(await run("sova_roster", { op: "approve", person: "Bob Smith" })), /^Held: approving Bob Smith waits until /);
    assert.equal(orgs.readRoster(org.id).find((p) => p.name === "Bob Smith")?.status, "proposed", "not before the hold ends");
    await clearHolds();
  });
});

describe("the allowances are the watch chart's ledgers (§app.project-overseer/limits, r5: one ledger)", () => {
  test("the operator's turns take the message allowance, runs on its own the day's; neither refills the other", async () => {
    await settings({ autonomy: "L1", holdMin: 0, caps: { gatherPerTurn: 1, gatherPerDay: 1, gatheringsOpen: 20 } });
    const t0 = Date.now() + 5 * 86_400_000;
    setOrgClockForTest(() => t0);
    hostOf(org.id).fireDue();
    try {
      const r0 = await hostOf(org.id).act(`watch/${org.id}/${project.id}`, "turn/user-entered", {}, { by: "system" });
      assert.equal(r0.taken, true);
      await run("sova_start_gathering", gather("A1"), true);
      await assert.rejects(() => run("sova_start_gathering", gather("A2"), true), /^Error: This message's allowance is used: 1 of 1 gathering sessions started per message you send\. Stop here and tell the operator what is done and what is left, or ask with sova_confirm\.$/);
      await run("sova_start_gathering", gather("D1"));
      await assert.rejects(() => run("sova_start_gathering", gather("D2")), /^Error: Today's allowance is used: 1 of 1 gathering sessions started on its own\. It looks again at midnight\. Nothing starts before then\. Tell the operator what is waiting; don't promise an earlier look\.$/);
      // The activity log has the operator's sentence only.
      assert.equal(actions().at(-1).error, "Today's allowance is used: 1 of 1 gathering sessions started on its own. It looks again at midnight.");
      // The watch holds it until midnight, one item per limit.
      const midnight = store.nextMidnight(new Date(t0));
      assert.deepEqual(store.readMemo(store.projectOverseerPaths(org.id, project.id)).held.map((h) => [h.key, h.retryAt]), [["day:gather", midnight.toISOString()]]);
      // The operator's next message resets only its own allowance.
      await hostOf(org.id).act(`watch/${org.id}/${project.id}`, "turn/user-entered", {}, { by: "system" });
      await assert.rejects(() => run("sova_start_gathering", gather("D3")), /Today's allowance is used/);
      await run("sova_start_gathering", gather("A3"), true);
      const use = (await po.projectOverseerInfo(org.id, project.id)).usage.allowance;
      assert.deepEqual([use.message.gather, use.today.gather], [{ used: 1, max: 1 }, { used: 1, max: 1 }]);
      // The day's allowance comes back at local midnight.
      setOrgClockForTest(() => midnight.getTime());
      hostOf(org.id).fireDue();
      await run("sova_start_gathering", gather("D4"));
    } finally {
      setOrgClockForTest(null);
    }
  });

  test("no turn.json: the counts live only in the watch chart", () => {
    assert.equal(existsSync(join(root, "agent", "project-overseers", `${org.id}-${project.id}`, "turn.json")), false);
    assert.equal("turn" in store.projectOverseerPaths(org.id, project.id), false);
    assert.ok(hostOf(org.id).data(`watch/${org.id}/${project.id}`)?.["ledgers"]);
  });

  test("Unlimited (null) never refuses; the at-once limit still does, and holds nothing", async () => {
    await settings({ autonomy: "L1", holdMin: 0, caps: { gatherPerDay: null, gatheringsOpen: 1 } });
    const open = envelopeFor(org.id, project.id, { by: "overseer", attended: false }).atOnce.gatheringsOpen;
    await settings({ caps: { gatheringsOpen: open } });
    await assert.rejects(() => run("sova_start_gathering", gather("Over")), new RegExp(`^Error: ${open} of its gathering sessions are open, and the limit is ${open} at once\\. One reaching its goal or being closed is a reason to look again; don't promise when\\.$`));
    assert.ok(!store.readMemo(store.projectOverseerPaths(org.id, project.id)).held.some((h) => h.key === "day:gather" && h.why.includes("open")));
    await settings({ caps: { gatheringsOpen: open + 1 } });
    await run("sova_start_gathering", gather("Unlimited"));
  });

  test("sova_project reports both allowances from the ledgers, the looks, and no cost or tokens", async () => {
    const out = textOf(await run("sova_project", {}));
    assert.match(out, /Today on your own: \d+ gathering sessions started \(no limit\)/);
    assert.match(out, /This operator message: \d+ of 1 gathering sessions started/);
    assert.doesNotMatch(out, /Coding tokens|token budget|\$\d|cost/i);
  });
});

describe("the Pipeline and held acts (§app.project-overseer/pipeline, /holds)", async () => {
  await hostOf(org.id).act(projectSid, "gap/file", { gapId: "g_hosting1", ideaId: "§gap/hosting" }, envelopeFor(org.id, project.id, { by: "overseer", attended: true }), { settle: true });
  const itemSid = `item/${org.id}/${project.id}/g_hosting1`;
  const pipeline = async () => (await (await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline`)).json()) as PipelineInfo;

  test("GET …/pipeline: one row per gap, its phase and since; unknown project 404", async () => {
    await settings({ autonomy: "L1", holdMin: 10, caps: { gatherPerDay: null, gatheringsOpen: 20 } });
    const info = await pipeline();
    const row = info.rows.find((r) => r.itemId === "g_hosting1")!;
    assert.equal(row.gap, "§gap/hosting");
    assert.equal(row.phase, "open");
    assert.ok(Date.parse(row.since) > 0);
    assert.deepEqual([row.gatherings, row.decisions, row.builds], [[], [], []]);
    assert.deepEqual([row.canHold, row.canResume], [true, false]);
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/prj_nope0000/pipeline`)).status, 404);
  });

  test("Hold and Resume are the operator's item acts; Resume returns to where it was", async () => {
    const held = (await (await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline/g_hosting1/hold`, { method: "POST" })).json()) as PipelineInfo;
    const row = held.rows.find((r) => r.itemId === "g_hosting1")!;
    assert.equal(row.phase, "on-hold");
    assert.deepEqual([row.held?.from, row.canHold, row.canResume], ["open", false, true]);
    const again = await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline/g_hosting1/hold`, { method: "POST" });
    assert.equal(again.status, 409);
    const resumed = (await (await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline/g_hosting1/resume`, { method: "POST" })).json()) as PipelineInfo;
    assert.equal(resumed.rows.find((r) => r.itemId === "g_hosting1")!.phase, "open");
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline/g_nope0000/hold`, { method: "POST" })).status, 404);
  });

  test("GET …/timeline: the item's rows from the log, with who and the lane move", async () => {
    const tl = (await (await app.request(`/api/orgs/${org.id}/projects/${project.id}/pipeline/g_hosting1/timeline`)).json()) as PipelineTimeline;
    const hold = tl.rows.find((r) => r.event === "item/hold")!;
    assert.deepEqual([hold.by, hold.from, hold.to, hold.line], ["operator", "open", "on-hold", "The operator put it on hold."]);
    assert.ok(tl.rows.some((r) => r.event === "item/resume" && r.to === "open"));
  });

  test("a held act: in the Pipeline, in Needs you (act tier, held-act, never a session), cancelled by the operator's route", async () => {
    await clearHolds();
    await run("sova_start_gathering", gather("Held one"));
    const h = (await pipeline()).held.at(-1)!;
    assert.equal(h.what, 'A gathering session "Held one"');
    assert.ok(Date.parse(h.goesAt) - Date.parse(h.since) === 10 * 60_000, "the project's 10-minute hold");
    const item = heldAttention().find((i) => i.held?.id === h.id)!;
    assert.deepEqual([item.tier, item.kind, item.path, item.detail], ["act", "held-act", "", 'A gathering session "Held one" starts in 10 min unless you cancel it.']);
    assert.equal(item.href, `#/orgs/${org.id}/projects/${project.id}`);
    const r = await app.request(`/api/orgs/${org.id}/held/${encodeURIComponent(h.id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "not now" }) });
    assert.deepEqual([r.status, await r.json()], [200, { ok: true }]);
    assert.equal((await pipeline()).held.length, 0);
    assert.equal(heldAttention().length, 0);
    assert.equal((await app.request(`/api/orgs/${org.id}/held/${encodeURIComponent(h.id)}/cancel`, { method: "POST" })).status, 404, "an unknown or finished hold");
  });

  test("the overseer's sova_pipeline lists the gap, the held act and the feed; sova_hold cancels or approves early, with a reason", async () => {
    await run("sova_start_gathering", gather("Review me"));
    const listed = textOf(await run("sova_pipeline", {}));
    assert.match(listed, new RegExp(`- ${itemSid} · §gap/hosting .* · open since `));
    const id = holdsOf()[0]!.id;
    assert.match(listed, new RegExp(`- ${id} · A gathering session "Review me" · goes ahead at `));
    assert.match(listed, /## Feed \(newest first\)\n- .* · item\/hold by operator|## Feed \(newest first\)\n- /);
    const one = textOf(await run("sova_pipeline", { session: itemSid }));
    assert.match(one, /Corrections it declares: .*correct\/reopen/);
    await assert.rejects(() => run("sova_hold", { op: "cancel", id: "h_nope", reason: "x" }), /No held act h_nope in this project/);
    await run("sova_hold", { op: "approve", id, reason: "Tony is waiting for it" });
    assert.equal(holdsOf().length, 0, "approved: it went ahead now");
    assert.ok(baton.allBatons().some((b) => b.publicTitle === "Review me"));
    await run("sova_start_gathering", gather("Cancel me"));
    const id2 = holdsOf()[0]!.id;
    await run("sova_hold", { op: "cancel", id: id2, reason: "covered by Review me" });
    assert.equal(holdsOf().length, 0);
    assert.ok(!baton.allBatons().some((b) => b.publicTitle === "Cancel me"), "cancelled: it never started");
    const rows = hostOf(org.id).log.rows({ newestFirst: true }).filter((r) => r.event === "hold/cancel" || r.event === "hold/approve");
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.event, r.reason]), [["hold/cancel", "covered by Review me"], ["hold/approve", "Tony is waiting for it"]]);
  });

  test("sova_correct: only a correction the session declares, only this project's sessions", async () => {
    await assert.rejects(() => run("sova_correct", { session: itemSid, correction: "correct/merged", reason: "r" }), /declares no correct\/merged/);
    await assert.rejects(() => run("sova_correct", { session: `item/${org.id}/prj_other000/g_x`, correction: "correct/reopen", reason: "r" }), /No chart session .* in this project/);
    await assert.rejects(() => run("sova_correct", { session: itemSid, correction: "correct/reopen", reason: "r" }), (e: Error) => !/No chart session|declares no/.test(e.message), "the chart's own guard (it is not done)");
  });

  test("sova_set_state: only in a turn the operator started, with its reason in the log", async () => {
    await assert.rejects(() => run("sova_set_state", { session: itemSid, states: ["needs-operator"], reason: "stuck" }));
    const log = actions().at(-1);
    assert.deepEqual([log.tool, log.outcome], ["sova_set_state", "refused"]);
    const out = textOf(await run("sova_set_state", { session: itemSid, states: ["needs-operator"], reason: "the operator asked: Tony answered by phone" }, true));
    assert.match(out, /is now in .*needs-operator/);
    const row = hostOf(org.id).log.rows({ session: itemSid, newestFirst: true })[0]!;
    assert.deepEqual([row.event, row.reason], ["sova/set-state", "the operator asked: Tony answered by phone"]);
  });
});
