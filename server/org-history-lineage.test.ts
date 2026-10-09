// Run: node scripts/run-tests.mjs server/org-history-lineage.test.ts. The history's lineage through the real
// engine, tools and fixtures (no hand-built step): a gap filed, a gathering started on it, a person's decision
// recorded in that gathering, the gathering closed, the decision reconciled and promoted, and a build started
// on the gap; then two people's decisions in conflict, settled by the operator, and the statechart's
// supersessions mirrored. Each relation is read back from the recorded events, oriented, and never a cause.
// The decide seam and the spec draft tool are fakes; a throwaway agent dir, workspace and project.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { HistoryEvent, HistoryReader } from "../shared/org-history";
import type { DecisionProvider } from "./decide";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-lineage-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const reconcile = await import("./reconcile");
const decisions = await import("./decisions");
const historyTools = await import("./org-history-tools");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { envelopeFor, hostOf, onOrgChange } = await import("./org-engine");
const { fakeLooks, recordDecision } = await import("./org-test-fixtures");
const { seedBuildEffectsForTest } = await import("./build-loadout");
const writer = await import("./spec-draft-writer");
writer.setDraftToolForTest((await import("./spec-tool-fake")).fakeDraftTool());

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

/** A pair conflicts when their statements name different day counts; anything else is another subject. */
const days = (s: string) => /(\d+) days/.exec(s)?.[1];
const fake: DecisionProvider = {
  id: "chain",
  label: "fake",
  async decide(req) {
    const state = req.state as { decisions: Record<string, { statement: string }>; new: Record<string, { name: string }> };
    const answers: Record<string, any> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      const pair = [...JSON.stringify(q.instructions).matchAll(/D\d+/g)].map((m) => m[0]);
      const clash = () => {
        const [x, y] = pair.map((id) => days(state.decisions[id!]?.statement ?? ""));
        return x && y && x !== y ? 0.93 : 0.05;
      };
      if (q.type === "choice" && qid.startsWith("pair")) {
        const p = clash();
        answers[qid] = { type: "choice", choice: p > 0.5 ? "conflict" : "different", probabilities: { conflict: p, same: 0, different: 1 - p }, confidence: 1 };
      } else if (q.type === "boolean") answers[qid] = { type: "boolean", p: qid === "restates" ? 0 : clash() };
      else if (q.type === "choice" && qid === "outcome") answers[qid] = { type: "choice", choice: "neither", probabilities: { neither: 1 }, confidence: 1 };
      else if (q.type === "choice") {
        const keys = Object.keys(q.options);
        const name = state.new[qid]!.name;
        const choice = keys.includes(decisions.areaKeyOf(name)) ? decisions.areaKeyOf(name) : decisions.areaKeyOf(name);
        answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
      }
    }
    return { answers, provider: "jev", model: "fake", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
reconcile.setReconcileDeps({ provider: () => fake, excluded: () => false });

const OPERATOR: HistoryReader = { role: "operator" };
const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"], contact: { whatsapp: "+90 555 MARK 01" } });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Ops" });
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);
await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0, caps: { gatherPerDay: null, gatherPerTurn: null, gatheringsOpen: 20 } });
const run = (name: string, params: Record<string, unknown>, attended = true) =>
  po.toolsForTest(project.id, { attended }).find((x) => x.name === name)!.execute("c", params as never, undefined, undefined, undefined as never);
const operatorAct = (sid: string, event: string, data: Record<string, unknown> = {}) => hostOf(org.id).act(sid, event, data, envelopeFor(org.id, project.id, { by: "operator", attended: true }), { settle: true });

const h = () => hostOf(org.id).history;
const eventsDir = () => join(orgs.orgDir(org.id), "history", "events");
/** The structural rows as written. */
const rowsText = () => (existsSync(eventsDir()) ? readdirSync(eventsDir()).map((f) => readFileSync(join(eventsDir(), f), "utf8")).join("") : "");
const all = (): HistoryEvent[] => rowsText().split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryEvent);
const byKey = (key: string): HistoryEvent => {
  const hit = all().find((e) => e.source.key === key || e.aliases?.includes(key));
  assert.ok(hit, `an event under ${key}`);
  return hit!;
};
const ofKind = (kind: string) => all().filter((e) => e.kind === kind);
/** The event's relations to events: [type, target event id]. */
const rels = (e: HistoryEvent) => e.relations.flatMap((r) => ("event" in r.target ? [[r.type, r.target.event]] : []));
/** The event's headline as the operator reads it (its private `what`). */
const headline = (e: HistoryEvent) => h().event(OPERATOR, e.id)!.rationale?.what;

/** A person's message in the gathering (sender-marked), then their decision recorded from it. */
async function decide(sessionId: string, by: string, words: string, area = "hosting"): Promise<string> {
  const row = baton.batonById(sessionId)!.row;
  const file = baton.sessionPathOf(orgs.orgDir(org.id), row);
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
  const uid = `u${Math.random().toString(16).slice(2, 10)}`;
  const ts = new Date().toISOString();
  appendFileSync(
    file,
    `${JSON.stringify({ type: "message", id: uid, parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: words }] } })}\n` +
      `${JSON.stringify({ type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: uid, by }, id: `${uid}s`, parentId: uid, timestamp: ts })}\n`,
  );
  return recordDecision(file, { area, ownerArea: area === "hosting" ? "hosting" : "none", statement: words, quote: words });
}

async function gathering(title: string, person: string, gap = "none"): Promise<string> {
  await run("sova_start_gathering", { gap, person, why: "Nobody has said this yet.", public_title: title, goal: "Who hosts the portal", question: "Who hosts the portal?" });
  return baton.allBatons().find((b) => b.publicTitle === title)!.sessionId;
}

describe("lineage through the real engine", () => {
  let gapId = "";
  let gatheringId = "";

  test("gap → gathering → decision → promotion → build: each relation from the ids its step carried, none a cause", async () => {
    await run("sova_idea", { op: "add", id: "§gap/hosting", title: "Nobody decided hosting" });
    gapId = String(hostOf(org.id).sessions("item").find((s) => s.data["ideaId"] === "§gap/hosting")!.data["id"]);
    gatheringId = await gathering("Hosting", "Tony Reyes", "§gap/hosting");
    const decisionId = await decide(gatheringId, tony.id, "We host on Hetzner.");
    assert.ok((await operatorAct(`baton/${org.id}/${gatheringId}`, "baton/close")).taken);
    await reconcile.reconcileProject(org.id, project.id);
    const promoted = await reconcile.promoteDecisions(org.id, project.id, [decisionId]);
    assert.deepEqual(promoted.promoted, [decisionId]);
    seedBuildEffectsForTest(`${gapId}-b9`, { made: { inRoot: "it isn't a Git repository." } });
    const built = await operatorAct(`item/${org.id}/${project.id}/${gapId}`, "build/start", { sessionId: `${gapId}-b9`, title: "Build hosting" });
    assert.ok(built.taken, built.refusal?.sentence);

    const gap = byKey(`gap:${gapId}`);
    const gath = byKey(`sc:baton/${org.id}/${gatheringId}`);
    const dec = byKey(`decision:${decisionId}`);
    const build = byKey(`sc:build/${project.id}/${gapId}-b9`);
    assert.deepEqual([gap.kind, gath.kind, dec.kind, build.kind], ["gap.filed", "gathering.started", "decision.recorded", "build.started"]);
    assert.equal(headline(gap), "Gap filed: Nobody decided hosting", "the gap's title, carried by its act");
    // oriented: the later event holds the relation, its target is the earlier one
    assert.deepEqual(rels(gath), [["named-target", gap.id]], "the gathering names its gap");
    assert.deepEqual(rels(dec), [["recorded-in", gath.id]], "the decision was recorded in the gathering");
    const closed = ofKind("gathering.closed").filter((e) => rels(e).some(([, t]) => t === gath.id));
    assert.equal(closed.length, 1);
    assert.deepEqual(rels(closed[0]!), [["named-target", gath.id]]);
    const asked = ofKind("promotion.made").filter((e) => e.outcome === "started" && rels(e).some(([, t]) => t === dec.id));
    assert.ok(asked.length >= 1, "a promotion asked for it");
    for (const a of asked) assert.deepEqual(rels(a), [["named-target", dec.id]]);
    const adopted = ofKind("promotion.made").filter((e) => e.outcome === "observed" && rels(e).some(([ty, t]) => ty === "adopts" && t === dec.id));
    assert.ok(adopted.length >= 1, "a promotion's result adopts it");
    for (const a of adopted) {
      assert.equal(a.triggeredBy.length, 1);
      assert.equal(a.triggeredBy[0]!.via, "effect", "its only cause is its own request's effect");
      assert.ok(asked.some((x) => x.id === a.triggeredBy[0]!.event));
    }
    assert.deepEqual(rels(build), [["named-target", gap.id], ["named-target", dec.id]], "the build names its gap and the decision its statechart was started with");
    // no relation was turned into a cause
    for (const e of [gath, dec, build]) assert.deepEqual(e.triggeredBy, [], `${e.kind}: Trigger not recorded, never inferred`);
    // the coding session's own start (make-worktree's answer) names the build it belongs to
    assert.ok(ofKind("build.started").some((e) => e.source.key.startsWith("answer:") && rels(e).some(([ty, t]) => ty === "named-target" && t === build.id)));

    // the trace from the decision shows the relations, labelled, at one hop, never as triggers
    const chain = h().trace(OPERATOR, dec.id)!;
    const edge = (from: string, to: string) => chain.edges.find((x) => x.from === from && x.to === to);
    assert.equal(edge(dec.id, gath.id)?.type, "recorded-in");
    assert.equal(edge(build.id, dec.id)?.type, "named-target");
    assert.ok(adopted.some((a) => edge(a.id, dec.id)?.type === "adopts"));
    assert.ok(chain.edges.filter((x) => x.to === dec.id || x.from === dec.id).every((x) => !x.via), "none of them causal");
    const detail = h().event(OPERATOR, gath.id)!;
    assert.ok(detail.related.some((l) => l.type === "named-target" && l.direction === "out" && l.event.id === gap.id));
    assert.ok(detail.related.some((l) => l.type === "recorded-in" && l.direction === "in" && l.event.id === dec.id));
    // the packet a reader is given cites the same events
    const packet = h().packet(OPERATOR, { event: dec.id })!;
    assert.ok(packet.events.includes(dec.id));

    // structural rows hold ids only: no words of the message, the decision, the question, a name or a contact
    for (const words of ["Hetzner", "Who hosts", "MARK", "Tony Reyes"]) assert.ok(!rowsText().includes(words), `no "${words}" in the event rows`);
  });

  test("a later gathering on the same gap names the gap, never the earlier gathering; the earlier one's relation is as it was", async () => {
    const before = byKey(`sc:baton/${org.id}/${gatheringId}`);
    const later = await gathering("Hosting again", "Maria Lopez", "§gap/hosting");
    const g2 = byKey(`sc:baton/${org.id}/${later}`);
    assert.deepEqual(rels(g2), [["named-target", byKey(`gap:${gapId}`).id]]);
    assert.ok(!rels(g2).some(([, t]) => t === before.id));
    assert.deepEqual(byKey(`sc:baton/${org.id}/${gatheringId}`), before, "recorded once, never edited");
  });

  test("the operator keeps one side of a conflict: the loser's supersession mirrored from its statechart, as of when it happened", async () => {
    const g1 = await gathering("Backups A", "Tony Reyes");
    const g2 = await gathering("Backups B", "Maria Lopez");
    const a = await decide(g1, tony.id, "Backups are kept 10 days.");
    const b = await decide(g2, maria.id, "Backups are kept 90 days.");
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => [k.a, k.b].sort().join() === [a, b].sort().join())!;
    assert.ok(c, JSON.stringify(info.conflicts));
    await new Promise((r) => setTimeout(r, 5));
    const beforeSettle = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    // what the decision statechart's verdict step carries (the probe the contract asks for)
    let listening = true;
    const verdicts: { data: unknown; by?: string | null; via?: string | null; invokeId?: string | null }[] = [];
    onOrgChange((_o, ch) => {
      if (listening) for (const s of ch.steps) if (s.event === "reconcile/result" && s.sessionId.startsWith("decision/")) verdicts.push({ data: s.data, by: s.by, via: s.via, invokeId: s.invokeId });
    });
    const settles = new Set(ofKind("conflict.settled").map((e) => e.id));
    await reconcile.resolveConflict(org.id, project.id, c.id, { keep: "b" });
    listening = false;
    const lost = c.a;
    const kept = c.b;
    const mirror = byKey(`superseded:${lost}:${kept}`);
    assert.equal(mirror.kind, "decision.superseded");
    // the headlines name the decision kept, from the statement its acts carried (already public in history)
    assert.equal(headline(mirror), "Decision superseded: Backups are kept 90 days.");
    const settledNow = ofKind("conflict.settled").filter((e) => !settles.has(e.id));
    assert.equal(settledNow.length, 1);
    assert.equal(headline(settledNow[0]!), "Conflict settled: Backups are kept 90 days.");
    const lostEv = byKey(`decision:${lost}`);
    const keptEv = byKey(`decision:${kept}`);
    assert.deepEqual(rels(mirror), [["supersedes", lostEv.id], ["related", keptEv.id]]);
    // the verdict's step names no act and no actor: no cause and no decider is claimed
    assert.ok(verdicts.length > 0);
    for (const v of verdicts) assert.ok(!v.by && !v.via && !v.invokeId && !(v.data as Record<string, unknown>).by, JSON.stringify(v));
    assert.deepEqual(mirror.triggeredBy, []);
    assert.equal((mirror.actors.decidedBy as { unknown?: boolean }).unknown, true);
    // read: the loser is superseded by the mirror; the keeper isn't; as of before the settle, neither
    assert.equal(h().event(OPERATOR, lostEv.id)!.event.superseded?.by, mirror.id);
    assert.equal(h().event(OPERATOR, keptEv.id)!.event.superseded, undefined);
    assert.equal(h().event(OPERATOR, lostEv.id, { asOf: beforeSettle })!.event.superseded, undefined);
    // the superseded decision keeps its own decider and reasons
    assert.deepEqual(h().event(OPERATOR, lostEv.id)!.record!.actors, lostEv.actors);

    // an overseer can't supersede a person's decision by naming it, nor by naming the mirror
    const sovaDecide = historyTools
      .historyTools(org.id, {
        engine: org.id,
        projectId: project.id,
        attended: () => false,
        overseerId: () => "conv1",
        effective: () => ({ autonomy: "L1" as const }),
        envelope: () => envelopeFor(org.id, project.id, { by: "overseer", attended: false }),
        read: (r: (p: any) => Promise<any>) => (_id: string, p: any) => r(p ?? {}),
        act: (_n: string, r: (p: any, id: string) => Promise<any>) => (id: string, p: any) => r(p ?? {}, id),
        heldText: () => "",
      } as never)
      .find((t) => t.name === "sova_decide")!;
    const tryDecide = (supersedes: string) => (sovaDecide.execute as any)("tc1", { disposition: "choose", what: "Keep 30 days.", reason: "Mine.", supersedes });
    await assert.rejects(tryDecide(keptEv.id), (e: Error) => e.message === historyTools.SUPERSEDE_REFUSAL);
    await assert.rejects(tryDecide(mirror.id), /No such decision/);
    assert.equal(h().event(OPERATOR, keptEv.id)!.event.superseded, undefined, "still not superseded");
  });

  test("the operator states the resolution: their decision, caused by their settle through the id it declared, supersedes both", async () => {
    const g1 = await gathering("Retention A", "Tony Reyes");
    const g2 = await gathering("Retention B", "Maria Lopez");
    const a = await decide(g1, tony.id, "Logs are kept 7 days.", "logs");
    const b = await decide(g2, maria.id, "Logs are kept 60 days.", "logs");
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => [k.a, k.b].sort().join() === [a, b].sort().join())!;
    assert.ok(c, JSON.stringify(info.conflicts));
    const after = await reconcile.resolveConflict(org.id, project.id, c.id, { statement: "Logs are kept 30 days." });
    const mine = after.decisions.find((d) => d.resolves === c.id && d.by === "operator")!;
    assert.ok(mine, "the operator's decision");
    const ev = byKey(`decision:${mine.id}`);
    assert.equal(ev.kind, "decision.recorded");
    assert.deepEqual(ev.actors.decidedBy, { kind: "operator" });
    assert.deepEqual(ev.actors.recordedBy, { kind: "operator" }, "the operator worded it: no \"Worded by\" (the recorder is the decider)");
    assert.deepEqual(ev.actors.authorization, { kind: "operator-act" });
    const settle = ofKind("conflict.settled").find((e) => e.aliases?.includes(`settle-decision:${mine.id}`))!;
    assert.ok(settle, "the settle that declared it");
    assert.deepEqual(ev.triggeredBy, [{ event: settle.id, via: "effect" }]);
    for (const side of [a, b]) assert.deepEqual(rels(byKey(`superseded:${side}:${mine.id}`)), [["supersedes", byKey(`decision:${side}`).id], ["related", ev.id]]);
    assert.equal(headline(settle), "Conflict settled: Logs are kept 30 days.");
    for (const side of [a, b]) assert.equal(headline(byKey(`superseded:${side}:${mine.id}`)), "Decision superseded: Logs are kept 30 days.");
    assert.ok(!rowsText().includes("30 days"), "the operator's words stay in the rationale");
    assert.equal(h().event(OPERATOR, ev.id)!.rationale?.what, "Logs are kept 30 days.");
  });

  test("a verdict that names no superseding decision records nothing", async () => {
    const n = ofKind("decision.superseded").length;
    const g = await gathering("Quiet", "Tony Reyes");
    const d = await decide(g, tony.id, "Status page stays on.", "status");
    await hostOf(org.id).act(decisions.decisionSid(org.id, project.id, d), "reconcile/result", { state: "superseded" }, envelopeFor(org.id, project.id, { by: "system", attended: false }), { settle: true });
    assert.equal(ofKind("decision.superseded").length, n);
  });

  test("a conflict names its two decisions; its settle gathering's start is recorded, spawned by it, and its close names that start", async () => {
    const g1 = await gathering("Uptime A", "Tony Reyes");
    const g2 = await gathering("Uptime B", "Maria Lopez");
    const a = await decide(g1, tony.id, "Alerts wait 5 days.", "alerts");
    const b = await decide(g2, maria.id, "Alerts wait 50 days.", "alerts");
    const info = await reconcile.reconcileProject(org.id, project.id);
    const c = info.conflicts.find((k) => [k.a, k.b].sort().join() === [a, b].sort().join())!;
    assert.ok(c?.batonSessionId, JSON.stringify(info.conflicts));
    const opened = byKey(`conflict:${decisions.conflictSid(org.id, project.id, c.id)}`);
    assert.equal(opened.kind, "conflict.opened");
    assert.deepEqual(rels(opened).sort(), [["named-target", byKey(`decision:${a}`).id], ["named-target", byKey(`decision:${b}`).id]].sort(), "the sides its start data names");
    assert.deepEqual(opened.triggeredBy, [], "naming its sides is no cause");
    const settleStart = byKey(`sc:baton/${org.id}/${c.batonSessionId}`);
    assert.equal(settleStart.kind, "gathering.started");
    assert.deepEqual(settleStart.triggeredBy, [{ event: opened.id, via: "spawn" }], "spawned by the conflict that declared it");
    await reconcile.resolveConflict(org.id, project.id, c.id, { keep: "a" });
    const closed = ofKind("gathering.closed").filter((e) => rels(e).some(([, t]) => t === settleStart.id));
    assert.equal(closed.length, 1, "the settle's close names the gathering's recorded start");
  });

  test("a conflict opened says who called the reconcile that found it: the operator's call, an overseer's tool; an automatic run stays unknown", async () => {
    const pair = async (area: string, n: number) => {
      const a = await decide(await gathering(`${area} A`, "Tony Reyes"), tony.id, `${area} wait ${n} days.`, area);
      const b = await decide(await gathering(`${area} B`, "Maria Lopez"), maria.id, `${area} wait ${n * 10} days.`, area);
      return [a, b].sort().join();
    };
    const openedFor = (info: { conflicts: { id: string; a: string; b: string }[] }, ids: string) => {
      const c = info.conflicts.find((k) => [k.a, k.b].sort().join() === ids)!;
      assert.ok(c, JSON.stringify(info.conflicts));
      return byKey(`conflict:${decisions.conflictSid(org.id, project.id, c.id)}`);
    };
    // the operator's own call (the route's): the operator initiated it, the reconciler (the system) decided it
    const p1 = await pair("backups", 3);
    const op = openedFor(await reconcile.reconcileProject(org.id, project.id), p1);
    assert.deepEqual(op.actors.initiatedBy, { kind: "operator" });
    assert.deepEqual(op.actors.decidedBy, { kind: "system" });
    assert.deepEqual(op.actors.recordedBy, { kind: "sova" });
    assert.deepEqual(op.actors.authorization, { kind: "operator-act", attended: true });
    // the global Overseer's call through the route: it initiated it, in the operator's turn
    const p2 = await pair("exports", 4);
    const go = openedFor(await reconcile.reconcileProject(org.id, project.id, { operator: { kind: "operator", via: "overseer", overseerId: "ovr-1" } }), p2);
    assert.deepEqual(go.actors.initiatedBy, { kind: "global-overseer", id: "ovr-1" });
    assert.deepEqual(go.actors.decidedBy, { kind: "system" });
    assert.deepEqual(go.actors.authorization, { kind: "attended-turn", attended: true });
    // the project overseer's sova_reconcile, in an attended turn: the overseer initiated it
    const ids = await pair("archives", 2);
    await run("sova_reconcile", {});
    const po = openedFor(reconcile.listDecisions(org.id, project.id), ids);
    assert.equal((po.actors.initiatedBy as { kind: string }).kind, "project-overseer");
    assert.deepEqual(po.actors.decidedBy, { kind: "system" });
    assert.equal((po.actors.authorization as { kind: string }).kind, "attended-turn");
    // Sova's own run: nothing carried, so nothing filled in
    const p4 = await pair("mirrors", 5);
    const auto = openedFor(await reconcile.reconcileProject(org.id, project.id, { auto: true }), p4);
    assert.equal((auto.actors.initiatedBy as { unknown?: boolean }).unknown, true, JSON.stringify(auto.actors));
  });

  test("the operator's Take Back is recorded: a hand-off back to the operator, named as such", async () => {
    const g = await gathering("Monitoring", "Tony Reyes");
    const before = new Set(ofKind("gathering.handed-off").map((e) => e.id));
    await baton.takeBack(g);
    const back = ofKind("gathering.handed-off").filter((e) => !before.has(e.id));
    assert.equal(back.length, 1, "one event for the take back");
    assert.deepEqual(back[0]!.actors.decidedBy, { kind: "operator" });
    assert.deepEqual(rels(back[0]!), [["named-target", byKey(`sc:baton/${org.id}/${g}`).id]]);
    assert.equal(h().event(OPERATOR, back[0]!.id)!.rationale?.what, "Gathering taken back by the operator");
  });

  test("membership and authority: placed, added by id only, a status that moved, a level set", async () => {
    assert.ok(ofKind("project.placed").some((e) => e.projects.primary === project.id));
    const added = ofKind("person.added").find((e) => e.entities.some((x) => x.type === "person" && x.id === tony.id))!;
    assert.ok(added, "the person added");
    const detail = JSON.stringify(h().event(OPERATOR, added.id));
    assert.ok(!detail.includes("MARK") && !detail.includes("Tony Reyes"), "no contact or name in the event or its rationale");
    await operatorAct(`watch/${project.id}`, "operator/level-set", { resumeAt: "L2" });
    assert.ok(ofKind("setting.changed").some((e) => h().event(OPERATOR, e.id)!.rationale?.what === "Autonomy level set: L2"));
    await operatorAct(`person/${org.id}/${maria.id}`, "person/leave");
    const left = ofKind("person.status-changed").find((e) => e.entities.some((x) => x.id === maria.id))!;
    assert.equal(h().event(OPERATOR, left.id)!.rationale?.what, "Status: left");
  });
});
