// Run: node scripts/run-tests.mjs server/org-history/bootstrap.test.ts. The one-time import of what an org
// already has (§app.org-history/portability): an org whose records predate its history (made through the real
// engine and tools with no history capture, then its history/ removed, as an old workspace) is imported once
// as its engine boots on the host that holds it: each fact one event, its source's time apart from the import
// time, only the links its statecharts declare, who and why unknown, no words; a restart imports nothing; a
// commit, clone and attach keeps every id and imports nothing. A new org records only that it had nothing to
// import. A host that doesn't hold the org imports nothing. A throwaway agent dir (this tree's pi-config
// extensions linked in) and workspaces in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { HistoryEvent, HistoryInput, HistoryReader } from "../../shared/org-history";
import type { DecisionProvider } from "../decide";
import { scratchRoot } from "../test-scratch";

const root = scratchRoot("sova-org-history-bootstrap-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("../orgs");
const baton = await import("../baton");
const po = await import("../project-overseer");
const reconcile = await import("../reconcile");
const decisions = await import("../decisions");
const historyTools = await import("../org-history-tools");
const { disposeAllChats } = await import("../chat-manager");
const { commitAll, settled } = await import("../workspace-git");
const { closeOrgHost, envelopeFor, hostOf } = await import("../org-engine");
const { fakeLooks, recordDecision } = await import("../org-test-fixtures");
const { seedBuildEffectsForTest } = await import("../build-loadout");
const { stateRoot } = await import("../state-root");
const { BATON_DECISION_ENTRY } = await import("../../shared/baton");
const writer = await import("../spec-draft-writer");
writer.setDraftToolForTest((await import("../spec-tool-fake")).fakeDraftTool());
const { importBaseline, receiptKey, setBaselineFaultForTest } = await import("./bootstrap");
const { fixture } = await import("./test-fixture");

after(async () => {
  await disposeAllChats();
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
});

const OPERATOR: HistoryReader = { role: "operator" };
/** Words that exist only in the org's sources: never in its history. */
const WORDS = "LEGACYWORDS9f2";
const ABOUT = "LEGACYABOUT51c";
/** A contact value, as written and as digits only (an id or a time never holds 12 such digits). */
const CONTACT = "+90 553 718 4926";
const CONTACT_DIGITS = "905537184926";

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
      else if (q.type === "choice" && qid === "outcome") answers[qid] = { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 };
      else if (q.type === "choice") {
        const choice = decisions.areaKeyOf(state.new[qid]!.name);
        answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
      }
    }
    return { answers, provider: "jev", model: "fake", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
reconcile.setReconcileDeps({ provider: () => fake, excluded: () => false });

const eventsOf = (dir: string): HistoryEvent[] => {
  const d = join(dir, "history", "events");
  return existsSync(d) ? readdirSync(d).flatMap((f) => readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryEvent)) : [];
};
const filesText = (dir: string): string => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("\n") : "");
const unknown = (v: unknown) => (v as { unknown?: boolean }).unknown === true;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
/** The files the last commit touched. */
const lastCommitFiles = (dir: string, ref = "HEAD") => git(dir, "show", "--name-only", "--format=", ref).split("\n");

describe("a new org: nothing to import", () => {
  test("only its receipt, recorded live: no imported fact, not partial coverage, and a true headline", async () => {
    const org = await orgs.createOrg({ name: "Fresh", dir: join(root, "fresh") });
    const all = eventsOf(orgs.orgDir(org.id));
    assert.equal(all.length, 1, JSON.stringify(all));
    const [r] = all;
    assert.equal(r!.kind, "history.imported");
    assert.equal(r!.source.key, receiptKey(org.id));
    assert.deepEqual(r!.capture, { origin: "live" });
    assert.equal(r!.rationale, undefined, "no words, so nothing to purge");
    const h = hostOf(org.id).history;
    assert.equal(h.coverage(OPERATOR).importedSince, null, "not 'Earlier history partial'");
    const row = h.search(OPERATOR, {}).items.find((i) => i.id === r!.id)!;
    assert.equal(row.headline, "Nothing to import: the organization started with its history.");
    assert.equal(h.event(OPERATOR, r!.id)!.event.headline, "Nothing to import: the organization started with its history.");
    // recorded in the step the residence came to hold it: in the create's own (first) commit, nothing left over
    const dir = orgs.orgDir(org.id);
    await settled(dir);
    assert.deepEqual(git(dir, "log", "--format=%s").split("\n"), ["Create organization Fresh"]);
    assert.ok(lastCommitFiles(dir).some((f) => f.startsWith("history/events/")), "the receipt is in that commit");
    assert.equal(git(dir, "status", "--porcelain"), "", "committed at once");
    // a restart finds the receipt: nothing more
    await closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    assert.deepEqual(eventsOf(orgs.orgDir(org.id)).map((e) => e.id), [r!.id]);
  });
});

describe("an org whose records predate its history", async () => {
  const ws = join(root, "ws");
  const org = await orgs.createOrg({ name: "Legacy", dir: ws });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"], contact: { whatsapp: CONTACT } });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Ops" });
  await orgs.patchOrg(org.id, { about: `${ABOUT} closes its books on the 5th.` });
  await po.ensureProjectOverseer(project.id);
  fakeLooks(org.id);
  await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 0, caps: { gatherPerDay: null, gatherPerTurn: null, gatheringsOpen: 20 } });
  // Before history: its engine captured nothing.
  hostOf(org.id).setHistoryComposer(null);
  const run = (name: string, params: Record<string, unknown>) => po.toolsForTest(project.id, { attended: true }).find((x) => x.name === name)!.execute("c", params as never, undefined, undefined, undefined as never);
  const operatorAct = (sid: string, event: string, data: Record<string, unknown> = {}) => hostOf(org.id).act(sid, event, data, envelopeFor(org.id, project.id, { by: "operator", attended: true }), { settle: true });
  const fileOf = (sessionId: string) => baton.sessionPathOf(orgs.orgDir(org.id), baton.batonById(sessionId)!.row);
  const says = (sessionId: string, by: string, words: string): string => {
    const file = fileOf(sessionId);
    const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
    const uid = `u${Math.random().toString(16).slice(2, 10)}`;
    const ts = new Date().toISOString();
    appendFileSync(
      file,
      `${JSON.stringify({ type: "message", id: uid, parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: words }] } })}\n` +
        `${JSON.stringify({ type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: uid, by }, id: `${uid}s`, parentId: uid, timestamp: ts })}\n`,
    );
    return uid;
  };
  const decide = (sessionId: string, by: string, words: string, area = "hosting") => {
    says(sessionId, by, words);
    return recordDecision(fileOf(sessionId), { area, ownerArea: area === "hosting" ? "hosting" : "none", statement: words, quote: words });
  };
  const gathering = async (title: string, person: string, gap = "none") => {
    await run("sova_start_gathering", { gap, person, why: "Nobody has said this yet.", public_title: title, goal: `Who hosts ${WORDS}`, question: "Who hosts it?" });
    return baton.allBatons().find((b) => b.publicTitle === title)!.sessionId;
  };

  // A gap, a gathering on it, a person's decision in it, a build of the gap; two conflicting decisions, one
  // superseded when the operator kept the other; and a decision marker the server never acted on.
  await run("sova_idea", { op: "add", id: "§gap/hosting", title: `Nobody decided hosting ${WORDS}` });
  const gapId = String(hostOf(org.id).sessions("item").find((s) => s.data.ideaId === "§gap/hosting")!.data.id);
  const g1 = await gathering("Hosting", "Tony Reyes", "§gap/hosting");
  const d1 = await decide(g1, tony.id, `We host on Hetzner ${WORDS}.`);
  assert.ok((await operatorAct(`baton/${org.id}/${g1}`, "baton/close")).taken);
  await reconcile.reconcileProject(org.id, project.id);
  assert.deepEqual((await reconcile.promoteDecisions(org.id, project.id, [d1])).promoted, [d1]);
  const ga = await gathering("Backups A", "Tony Reyes");
  const gb = await gathering("Backups B", "Maria Lopez");
  const da = await decide(ga, tony.id, `Backups are kept 10 days ${WORDS}.`, "backups");
  const db = await decide(gb, maria.id, `Backups are kept 90 days ${WORDS}.`, "backups");
  const info = await reconcile.reconcileProject(org.id, project.id);
  const conflict = info.conflicts.find((k) => [k.a, k.b].sort().join() === [da, db].sort().join())!;
  await reconcile.resolveConflict(org.id, project.id, conflict.id, { keep: "b" });
  const [lost, kept] = [conflict.a, conflict.b];
  const buildSid = `${gapId}-b1`;
  seedBuildEffectsForTest(buildSid, { made: { inRoot: "it isn't a Git repository." } });
  const built = await operatorAct(`item/${org.id}/${project.id}/${gapId}`, "build/start", { sessionId: buildSid, title: `Build hosting ${WORDS}` });
  assert.ok(built.taken, built.refusal?.sentence);
  const buildData = hostOf(org.id).data(`build/${project.id}/${buildSid}`)!;
  // a gathering where record_decision's marker will be left with no decision (below)
  const gm = await gathering("Snapshots", "Tony Reyes");
  const u = says(gm, tony.id, `Use daily snapshots ${WORDS}.`);
  const gmFile = fileOf(gm);

  const before = Object.fromEntries(hostOf(org.id).sessions().filter((s) => /^(org|placement|item|baton|decision|build)$/.test(s.statechart)).map((s) => [s.id, s.data]));
  const orgCreated = before[`org/${org.id}`]!.createdAt as number;
  const placedAt = before[`placement/${org.id}/${project.id}`]!.placedAt as number;

  // The old workspace: no history/, and nothing host-local of one.
  await closeOrgHost(org.id);
  rmSync(join(ws, "history"), { recursive: true, force: true });
  rmSync(join(stateRoot(), "org-history", org.id), { recursive: true, force: true });
  // The same old workspace, committed and kept on a remote, for an attach elsewhere (the last test).
  assert.equal((await commitAll(ws, "the old workspace")).error, undefined);
  const oldRemote = join(root, "old.git");
  const oldRemote2 = join(root, "old2.git");
  for (const r of [oldRemote, oldRemote2]) execFileSync("git", ["clone", "-q", "--bare", ws, r]);
  // record_decision's marker, then the server stopped: no decision yet (here only, not on those remotes:
  // marker recovery acts after an attach's commit, which is ag_19's, not the import's)
  const markerId = `mk${Math.random().toString(16).slice(2, 9)}`;
  appendFileSync(gmFile, `${JSON.stringify({ type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, ownerArea: "none", area: "snapshots", statement: `Daily snapshots ${WORDS}.`, quote: `Use daily snapshots ${WORDS}.`, by: tony.id }, id: markerId, parentId: u, timestamp: new Date().toISOString() })}\n`);
  const recovered = `${gm}:${markerId}`;
  const transcriptsBefore = filesText(join(ws, "sessions"));
  const bootAt = Date.now();
  await orgs.openAttachedOrgs();
  const h = () => hostOf(org.id).history;
  const all = () => eventsOf(ws);
  const byKey = (k: string) => {
    const hit = all().find((e) => e.source.key === k || e.aliases?.includes(k));
    assert.ok(hit, `an event under ${k}`);
    return hit!;
  };
  const imported = () => all().filter((e) => e.capture.origin === "imported");
  const rels = (e: HistoryEvent) => e.relations.map((r) => [r.type, "event" in r.target ? r.target.event : `${r.target.entity.type}:${r.target.entity.id}`]);

  test("the boot imports each fact once, as observed at import, with its source's time apart", () => {
    const facts = imported().filter((e) => e.capture.importOf?.kind !== "baseline");
    const kinds = facts.map((e) => `${e.capture.importOf!.kind}:${e.capture.importOf!.id}`).sort();
    const want = [
      `org:${org.id}`,
      `project:${project.id}`,
      `gap:${gapId}`,
      ...[g1, ga, gb, gm].map((s) => `gathering:${s}`),
      ...[d1, da, db].map((d) => `decision:${d}`),
      `build:${buildSid}`,
    ];
    // a settle session the reconciler started is a gathering too: imported as one
    for (const w of want) assert.ok(kinds.includes(w), `imported ${w} (${kinds.join(", ")})`);
    assert.ok(!kinds.includes(`decision:${recovered}`), "a marker with no decision was not a fact to import");
    assert.equal(new Set(kinds).size, kinds.length, "each once");
    for (const e of facts) {
      assert.equal(e.kind, "history.imported");
      assert.equal(e.outcome, "observed");
      assert.equal(e.source.adapter, "import");
      assert.equal(e.source.key, `import:${e.capture.importOf!.kind}:${e.capture.importOf!.id}`);
      assert.ok(e.capture.importedAt! >= bootAt && e.times.recordedAt >= bootAt, "the import time is now");
      assert.deepEqual(e.triggeredBy, [], "no cause reconstructed");
      for (const f of ["initiatedBy", "decidedBy", "authorization"] as const) assert.ok(unknown(e.actors[f]), `${e.source.key}: ${f} not recorded`);
      assert.deepEqual(e.actors.recordedBy, { kind: "sova" });
      assert.equal(e.rationale, undefined, "no words, no reason");
      assert.equal(e.decision, undefined, "no disposition reconstructed");
    }
    assert.equal(byKey(`import:org:${org.id}`).times.occurredAt, orgCreated, "the org's own creation time");
    assert.equal(byKey(`import:project:${project.id}`).times.occurredAt, placedAt);
    assert.equal(byKey(`import:gap:${gapId}`).times.occurredAt, undefined, "a gap's item records no time: none");
    assert.equal(byKey(`import:gathering:${g1}`).times.occurredAt, before[`baton/${org.id}/${g1}`]!.createdAt);
    assert.equal(byKey(`import:build:${buildSid}`).times.occurredAt, buildData.createdAt);
    const dec = byKey(`import:decision:${d1}`);
    assert.equal(dec.times.occurredAt, before[`decision/${org.id}/${project.id}/${d1}`]!.recordedAt);
    assert.ok(dec.times.occurredAt! < dec.times.recordedAt);
    const ev = dec.evidence[0]!;
    assert.ok(ev.kind === "transcript" && ev.session === g1 && ev.check === "unchecked", JSON.stringify(ev));
  });

  test("only the links the statecharts declare, by the live handles", () => {
    const gap = byKey(`gap:${gapId}`);
    const gath = byKey(`sc:baton/${org.id}/${g1}`);
    assert.equal(gath.source.key, `import:gathering:${g1}`);
    assert.deepEqual(rels(gath), [["named-target", gap.id]], "the gathering names its gap");
    assert.deepEqual(rels(byKey(`sc:baton/${org.id}/${ga}`)), [], "a gathering on no gap names none");
    const dec = byKey(`decision:${d1}`);
    assert.equal(dec.source.key, `import:decision:${d1}`);
    assert.deepEqual(rels(dec), [["recorded-in", gath.id]], "recorded in its gathering; not linked to the gap directly");
    const build = byKey(`sc:build/${project.id}/${buildSid}`);
    const declared = (buildData.decisions as string[]).map((d) => ["named-target", byKey(`decision:${d}`).id]);
    assert.deepEqual(rels(build), [["named-target", gap.id], ...declared], "the build names its gap and the decisions it was started with");
    // the operator kept one side: the kept decision supersedes the other, from the statechart's supersededBy
    assert.equal(before[`decision/${org.id}/${project.id}/${lost}`]!.supersededBy, kept);
    assert.ok(rels(byKey(`decision:${kept}`)).some(([t, id]) => t === "supersedes" && id === byKey(`decision:${lost}`).id));
    assert.equal(h().event(OPERATOR, byKey(`decision:${lost}`).id)!.event.superseded?.by, byKey(`decision:${kept}`).id);
    // nothing else: no project or org membership edge, no relation to anything by its words or time
    assert.deepEqual(rels(byKey(`import:project:${project.id}`)), []);
    assert.deepEqual(rels(byKey(`import:org:${org.id}`)), []);
  });

  test("its receipt says what isn't recorded; its reads count it as partial coverage; the headlines are true", () => {
    const receipt = byKey(receiptKey(org.id));
    assert.deepEqual(receipt.capture.importOf, { kind: "baseline", id: org.id });
    assert.equal(receipt.capture.origin, "imported");
    const txns = new Set(imported().map((e) => e.source.txn));
    assert.equal(txns.size, 1, "every fact and the receipt in one journal step");
    const cov = h().coverage(OPERATOR);
    assert.equal(cov.importedSince, Math.min(...imported().map((e) => e.times.occurredAt ?? e.times.recordedAt)), "Earlier history partial, back to the oldest source time");
    const headline = (id: string) => h().event(OPERATOR, id)!.event.headline;
    assert.equal(headline(receipt.id), "Existing records imported; earlier acts, holds, sends and reasons are not recorded");
    assert.equal(headline(byKey(`decision:${d1}`).id), "Decision found at import (recorded before history began)");
    assert.equal(headline(byKey(`sc:build/${project.id}/${buildSid}`).id), "Coding session found at import (recorded before history began)");
    assert.equal(h().event(OPERATOR, byKey(`decision:${d1}`).id)!.event.reasonState, "not-recorded");
  });

  test("no words, About text, contact value or name is in its event lines; no source file changed", () => {
    const lines = imported().map((e) => JSON.stringify(e)).join("\n");
    assert.ok(JSON.stringify(orgs.readRoster(org.id)).replace(/\D/g, "").includes(CONTACT_DIGITS), "control: the roster holds the contact");
    for (const w of [WORDS, ABOUT, CONTACT, CONTACT_DIGITS, "Tony Reyes", "Maria Lopez", "Hetzner", "hosting", "Backups"]) assert.ok(!lines.includes(w), `no "${w}"`);
    for (const e of imported()) assert.ok(!existsSync(join(h().paths.rationale, `${e.id}.json`)), "no rationale file");
    assert.equal(filesText(join(ws, "sessions")).startsWith(transcriptsBefore), true, "the transcripts as they were (only appended to after)");
    // the import's own journal step changed no statechart: no transition-log row was written in it (a step's
    // rows carry its journal id); whatever the engine's timers did after its boot is theirs
    const txn = byKey(receiptKey(org.id)).source.txn!;
    const logDir = join(ws, "statecharts", "log");
    const rows = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { j?: string }));
    assert.ok(rows.length > 0);
    assert.equal(rows.filter((r) => r.j === txn).length, 0, "no statechart row in the import's step");
    const liveTxn = all().find((e) => e.source.key === `decision:${recovered}`)!.source.txn;
    assert.ok(rows.some((r) => r.j === liveTxn), "control: a live act's step has its rows under the same id");
    assert.equal(imported().every((e) => e.source.txn === txn), true);
  });

  test("the marker recovered after the import is recorded live, once, and recorded in the imported gathering", () => {
    const live = all().filter((e) => e.source.key === `decision:${recovered}`);
    assert.equal(live.length, 1, "recovered once");
    assert.equal(live[0]!.kind, "decision.recorded");
    assert.equal(live[0]!.capture.origin, "live");
    assert.deepEqual(rels(live[0]!), [["recorded-in", byKey(`import:gathering:${gm}`).id]]);
    assert.equal(all().filter((e) => e.source.key === `import:decision:${recovered}`).length, 0, "never imported as well");
  });

  test("a restart imports nothing new and keeps every id", async () => {
    const ids = all().map((e) => e.id);
    await closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    assert.deepEqual(all().map((e) => e.id), ids);
    assert.equal((await importBaseline(hostOf(org.id), org.id)).ran, false, "asked again: done before");
  });

  test("the project overseer reads an imported fact of its project with who and why unknown", async () => {
    const tools = historyTools.historyTools(org.id, {
      engine: org.id,
      projectId: project.id,
      attended: () => false,
      overseerId: () => "conv1",
      effective: () => ({ autonomy: "L1" as const }),
      envelope: () => envelopeFor(org.id, project.id, { by: "overseer", attended: false }),
      read: (r: (p: any) => Promise<any>) => (_id: string, p: any) => r(p ?? {}),
      act: (_n: string, r: (p: any, id: string) => Promise<any>) => (id: string, p: any) => r(p ?? {}, id),
      heldText: () => "",
    } as never);
    const out = (await (tools.find((t) => t.name === "sova_history")!.execute as any)("t", { action: "event", event: byKey(`decision:${d1}`).id })) as { content: { text: string }[] };
    const text = out.content[0]!.text;
    assert.match(text, /Decision found at import \(recorded before history began\)/);
    assert.ok(!text.includes(WORDS) && !text.includes(CONTACT) && !text.includes(CONTACT_DIGITS));
  });

  test("committed, cloned and attached elsewhere: the same ids and links, nothing imported again", async () => {
    const ids = all().map((e) => e.id).sort();
    const linked = all().map((e) => [e.id, rels(e)]);
    assert.equal((await commitAll(ws, "test")).committed, true);
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", ws, clone]);
    await orgs.detachOrg(org.id);
    rmSync(join(stateRoot(), "org-history", org.id), { recursive: true, force: true });
    await orgs.attachOrg({ dir: clone, confirm: true });
    const after = eventsOf(clone);
    assert.deepEqual(after.map((e) => e.id).sort(), ids, "every id, and no new event");
    assert.deepEqual(after.map((e) => [e.id, rels(e)]), linked);
    assert.equal(hostOf(org.id).history.coverage(OPERATOR).importedSince, Math.min(...imported().map((e) => e.times.occurredAt ?? e.times.recordedAt)));
  });

  test("the old workspace attached plainly on this host: imported in the step that holds it, inside the attach commit, pushed", async () => {
    await orgs.detachOrg(org.id);
    const dir = join(root, "old-clone2");
    execFileSync("git", ["clone", "-q", oldRemote2, dir]);
    assert.ok(!existsSync(join(dir, "history")));
    await orgs.attachOrg({ dir });
    await settled(dir);
    const facts = eventsOf(dir).filter((e) => e.capture.origin === "imported" && e.capture.importOf?.kind !== "baseline");
    for (const k of [`org:${org.id}`, `project:${project.id}`, `decision:${d1}`, `build:${buildSid}`]) assert.ok(facts.some((e) => `${e.capture.importOf!.kind}:${e.capture.importOf!.id}` === k), k);
    // nothing of the history is left out of the attach commit (an org with projects still has its watches'
    // start after that commit, the pause-overseers effect's, with or without the import: the project's
    // snapshot and a log row)
    assert.deepEqual(git(dir, "status", "--porcelain").split("\n").filter((l) => l.includes("history/")), [], "the history committed at once");
    assert.match(git(dir, "log", "-1", "--format=%s"), /^Attached on /);
    assert.ok(lastCommitFiles(dir).some((f) => f.startsWith("history/events/")), "the import is in the attach commit");
    assert.ok(git(oldRemote2, "log", "-1", "--format=%s", "main").startsWith("Attached on "), "and pushed");
  });

  test("the old workspace attached by another host: refused unconfirmed with nothing written; confirmed, imported in the step that holds it, inside the attach commit, pushed", async () => {
    await orgs.detachOrg(org.id);
    const dir = join(root, "old-clone");
    execFileSync("git", ["clone", "-q", oldRemote, dir]);
    // this host is now another host: the old clone's holder record names the first one, never released
    writeFileSync(join(stateRoot(), "host.json"), `${JSON.stringify({ version: 1, id: "h_zz000001" })}\n`);
    const err = await orgs.attachOrg({ dir }).then(
      () => null,
      (e: { code?: string }) => e,
    );
    assert.equal(err?.code, "held");
    assert.ok(!existsSync(join(dir, "history")), "nothing imported while not held");
    await orgs.attachOrg({ dir, confirm: true });
    await settled(dir);
    const events = eventsOf(dir);
    const facts = events.filter((e) => e.capture.origin === "imported" && e.capture.importOf?.kind !== "baseline");
    // read from the engine as of that very step: the org, its project and decisions are there
    for (const k of [`org:${org.id}`, `project:${project.id}`, `decision:${d1}`, `gathering:${g1}`]) assert.ok(facts.some((e) => `${e.capture.importOf!.kind}:${e.capture.importOf!.id}` === k), k);
    assert.ok(events.some((e) => e.source.key === receiptKey(org.id)));
    assert.equal(new Set(facts.map((e) => e.source.txn)).size, 1, "one journal step");
    // nothing of the history is left out of the attach commit (an org with projects still has its watches'
    // start after that commit, the pause-overseers effect's, with or without the import: the project's
    // snapshot and a log row)
    assert.deepEqual(git(dir, "status", "--porcelain").split("\n").filter((l) => l.includes("history/")), [], "the history committed at once");
    assert.match(git(dir, "log", "-1", "--format=%s"), /^Attached on /);
    assert.ok(lastCommitFiles(dir).some((f) => f.startsWith("history/events/")), "the import is in the attach commit");
    assert.equal(git(oldRemote, "log", "-1", "--format=%s", "main").startsWith("Attached on "), true, "and pushed");
  });

});

describe("an attach of an org with a placed project is committed at once", () => {
  test("plain and confirmed: a clean tree, 'Attached on …' last, each project's watch paused and told it was attached here", async () => {
    const { onOrgChange } = await import("../org-engine");
    const { watchSid } = await import("../projects/sids");
    const org = await orgs.createOrg({ name: "Placed", dir: join(root, "placed") });
    mkdirSync(join(root, "placed-proj"));
    const p = await orgs.addProject(org.id, { name: "Site", root: join(root, "placed-proj") });
    const ws0 = orgs.orgDir(org.id);
    await settled(ws0);
    await commitAll(ws0, "placed");
    const remotes = ["placed-a.git", "placed-b.git"].map((n) => join(root, n));
    for (const r of remotes) execFileSync("git", ["clone", "-q", "--bare", ws0, r]);
    await orgs.detachOrg(org.id);
    const told: string[] = [];
    onOrgChange((o, ch) => {
      if (o === org.id) for (const s of ch.steps) if (s.event === "org/attached-here") told.push(s.sessionId);
    });
    for (const [i, confirm] of [false, true].entries()) {
      // the confirmed one: this host is another host now, so the clone's (unreleased) record holds it elsewhere
      if (confirm) writeFileSync(join(stateRoot(), "host.json"), `${JSON.stringify({ version: 1, id: "h_zz000004" })}\n`);
      const dir = join(root, `placed-clone-${i}`);
      execFileSync("git", ["clone", "-q", remotes[i]!, dir]);
      if (confirm) assert.equal(((await orgs.attachOrg({ dir }).catch((e: { code?: string }) => e)) as { code?: string }).code, "held");
      told.length = 0;
      await orgs.attachOrg({ dir, confirm });
      await settled(dir);
      await new Promise((r) => setTimeout(r, 300));
      await settled(dir);
      assert.equal(git(dir, "status", "--porcelain"), "", `${confirm ? "confirmed" : "plain"}: committed at once`);
      assert.match(git(dir, "log", "-1", "--format=%s"), /^Attached on /);
      assert.ok(git(remotes[i]!, "log", "-1", "--format=%s", "main").startsWith("Attached on "), "and pushed");
      assert.ok(hostOf(org.id).configuration(watchSid(p.id))?.includes("paused"), "its watch is paused");
      assert.equal(hostOf(org.id).data(watchSid(p.id))?.paused, true);
      assert.deepEqual(told, [watchSid(p.id)], "the residence's pause-overseers told the watch it was attached here");
      await orgs.detachOrg(org.id);
    }
  });
});

describe("an import that can't be made never stops a create", () => {
  test("a throw in it: a workspace problem, nothing recorded, the org created (and attached) and committed", async () => {
    setBaselineFaultForTest(() => {
      throw new Error("injected");
    });
    try {
      const org = await orgs.createOrg({ name: "Faulty", dir: join(root, "faulty") });
      const dir = orgs.orgDir(org.id);
      await settled(dir);
      assert.equal(eventsOf(dir).filter((e) => e.kind === "history.imported").length, 0);
      assert.ok(hostOf(org.id).problems().some((p) => p.kind === "history" && /import of existing records waits for the next start: injected/.test(p.why)), JSON.stringify(hostOf(org.id).problems()));
      assert.match(git(dir, "log", "-1", "--format=%s"), /^Create organization Faulty/);
      assert.equal(git(dir, "status", "--porcelain"), "");
      // and an attach of it (detached; its create recorded nothing, so nothing is there yet) with the same throw
      await orgs.detachOrg(org.id);
      await settled(dir);
      assert.ok(!existsSync(join(dir, "history")));
      const again = await orgs.attachOrg({ dir });
      assert.equal(again.id, org.id, "the attach went on");
      await settled(dir);
      assert.equal(eventsOf(dir).filter((e) => e.kind === "history.imported").length, 0);
      assert.ok(hostOf(org.id).problems().some((p) => p.kind === "history" && /injected/.test(p.why)));
      assert.match(git(dir, "log", "-1", "--format=%s"), /^Attached on /);
      assert.equal(git(dir, "status", "--porcelain"), "", "an org with no projects: the whole tree committed");
    } finally {
      setBaselineFaultForTest(null);
    }
  });
});

describe("a host that doesn't hold the org imports nothing", () => {
  test("no residence held here: nothing written", async () => {
    const f = await fixture();
    try {
      const n = f.host.history.search(OPERATOR, {}).total;
      assert.deepEqual(await importBaseline(f.host, "o1"), { ran: false, why: "not-held" });
      assert.equal(f.host.history.search(OPERATOR, {}).total, n);
    } finally {
      await f.close();
    }
  });

  test("held elsewhere (an attach not yet confirmed): no read of its facts, no record", async () => {
    let recorded = 0;
    let listed = 0;
    const host = {
      configuration: (sid: string) => (sid === "residence/o9" ? ["residence", "regions", "tenure", "held-elsewhere"] : null),
      sessions: () => (listed++, []),
      record: async () => (recorded++, []),
      history: { index: { refresh: () => true, byKey: new Map() } },
    };
    assert.deepEqual(await importBaseline(host as never, "o9"), { ran: false, why: "not-held" });
    assert.equal(recorded + listed, 0);
  });
});

describe("the inputs, from a host's statecharts as given", () => {
  const held = (sessions: { id: string; statechart: string; data: Record<string, unknown> }[], keys: string[] = []) => {
    const got: HistoryInput[][] = [];
    return {
      got,
      host: {
        configuration: (sid: string) => (sid === "residence/o1" ? ["held-here"] : null),
        sessions: (kind?: string) => sessions.filter((s) => !kind || s.statechart === kind).map((s) => ({ ...s, configuration: [], running: false })),
        record: async (inputs: HistoryInput[]) => (got.push(inputs), inputs.map((_, i) => `he_${i}`)),
        history: { index: { refresh: () => true, byKey: new Map(keys.map((k) => [k, "he_x"])) } },
      },
    };
  };

  test("an operator's decision (no gathering) names none; a supersession names the older decision whatever their order", async () => {
    const { got, host } = held([
      { id: "decision/o1/p/new", statechart: "decision", data: { id: "new", projectId: "p", sessionId: "", by: "operator", recordedAt: 5 } },
      { id: "decision/o1/p/old", statechart: "decision", data: { id: "old", projectId: "p", sessionId: "s1", entryId: "e1", recordedAt: 9, supersededBy: "new", resolves: "c1", by: "p_x", name: "Somebody", statement: "words", quote: "words" } },
    ]);
    await importBaseline(host as never, "o1");
    const [inputs] = got;
    const of = (id: string) => inputs!.find((i) => i.capture?.importOf?.id === id)!;
    assert.deepEqual(of("new").relationKeys, [{ key: "decision:old", type: "supersedes", entity: { type: "decision", id: "old" } }]);
    assert.deepEqual(of("old").relationKeys, [{ key: "sc:baton/o1/s1", type: "recorded-in", entity: { type: "gathering", id: "s1" } }]);
    assert.deepEqual(of("old").relations, [{ type: "related", target: { entity: { type: "conflict", id: "c1" } } }]);
    assert.ok(unknown(of("old").actors.decidedBy), "the chart's `by` is not a checked author");
    assert.ok(!JSON.stringify(inputs).includes("words") && !JSON.stringify(inputs).includes("Somebody"));
    assert.equal(inputs!.at(-1)!.source.key, receiptKey("o1"), "the receipt last, in the same call");
  });

  test("a fact already in the history (by its key or a live handle) is not imported again", async () => {
    const { got, host } = held(
      [
        { id: "baton/o1/s1", statechart: "baton", data: { sessionId: "s1", projectId: "p" } },
        { id: "baton/o1/s2", statechart: "baton", data: { sessionId: "s2", projectId: "p" } },
        { id: "decision/o1/p/d1", statechart: "decision", data: { id: "d1", projectId: "p" } },
        { id: "item/o1/p/g_1", statechart: "item", data: { id: "g_1", projectId: "p" } },
      ],
      ["session:s1", "decision:d1", "gap:g_1"],
    );
    await importBaseline(host as never, "o1");
    assert.deepEqual(got[0]!.map((i) => i.source.key), ["import:gathering:s2", receiptKey("o1")]);
  });
});
