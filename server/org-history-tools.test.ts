// Run: node scripts/run-tests.mjs server/org-history-tools.test.ts. The overseers' history tools
//: sova_history reads its own project's events and citations only, a
// contact value never reaches it, sova_decide records the overseer's own decision (a decision not to act
// included) and never supersedes a person's, and sova_org_history reads only in a turn the operator started.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HistoryInput } from "../shared/org-history";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-tools-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const engine = await import("./org-engine");
const tools = await import("./org-history-tools");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const PHONE = "+90 555 123 4567";

describe("the overseers' history tools", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  mkdirSync(join(tmp, "a"));
  mkdirSync(join(tmp, "b"));
  const pa = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "a") });
  const pb = await orgs.addProject(org.id, { name: "Ledger", root: join(tmp, "b") });
  const priya = await orgs.addPerson(org.id, { name: "Priya Shah", role: "Finance", contact: { whatsapp: PHONE } });
  const ga = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: priya.id, publicTitle: "Q1", goal: "g" });
  const gb = await baton.createBaton({ orgId: org.id, projectId: pb.id, to: priya.id, publicTitle: "Books", goal: "g" });
  const host = engine.hostOf(org.id);
  const ev = (key: string, project: string, more: Partial<HistoryInput>): HistoryInput => ({
    kind: "decision.recorded",
    outcome: "chosen",
    projects: { primary: project },
    actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "person", id: priya.id }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } },
    source: { adapter: "tools-test", version: 1, key },
    ...more,
  });
  const [aPerson, bPerson] = await host.record([
    ev("a1", pa.id, {
      evidence: [
        { n: 1, kind: "transcript", session: ga.sessionId, entry: "nope", check: "checked" },
        { n: 2, kind: "log-row", session: `baton/${org.id}/${ga.sessionId}`, at: 1 } as never,
      ],
      rationale: { what: "Weekly CSV chosen", reason: { text: `Priya asked to be called on ${PHONE}`, author: { kind: "person", id: priya.id }, contemporaneous: true } },
    }),
    ev("b1", pb.id, { evidence: [{ n: 1, kind: "transcript", session: gb.sessionId, entry: "nope", check: "checked" }], rationale: { what: "MARKB ledger choice" } }),
  ]);

  const ctxFor = (projectId: string, attended = false) => {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        engine: org.id,
        projectId,
        attended: () => attended,
        overseerId: () => "conv1",
        effective: () => ({ autonomy: "L1" as const }),
        envelope: () => engine.envelopeFor(org.id, projectId, { by: "overseer", attended }),
        read: (run: (p: any) => Promise<any>) => (_id: string, p: any) => run(p ?? {}),
        act: (name: string, run: (p: any, id: string) => Promise<any>) => (id: string, p: any) => (calls.push(name), run(p ?? {}, id)),
        heldText: () => "",
      } as never,
    };
  };
  const toolsOf = (projectId: string, attended = false) => {
    const { ctx, calls } = ctxFor(projectId, attended);
    const list = tools.historyTools(org.id, ctx);
    const run = async (name: string, params: Record<string, unknown>) => {
      const out = (await (list.find((t) => t.name === name)!.execute as any)(`tc${Math.random()}`, params)) as { content: { text: string }[] };
      return out.content[0]!.text;
    };
    return { run, calls };
  };

  test("sova_history: its own project's events only, the other project's never named; a contact value never reaches it", async () => {
    const { run } = toolsOf(pa.id);
    const list = await run("sova_history", { action: "search" });
    assert.match(list, new RegExp(aPerson!));
    assert.doesNotMatch(list, new RegExp(bPerson!));
    assert.doesNotMatch(list, /MARKB/);
    assert.match(list, /untrusted organization data/);
    const one = await run("sova_history", { action: "event", event: aPerson });
    assert.doesNotMatch(one, /555 123 4567|905551234567/, "contact scrubbed");
    assert.match(one, /\[contact\]/);
    await assert.rejects(run("sova_history", { action: "event", event: bPerson }), /No such event/);
    const other = toolsOf(pb.id);
    assert.match(await other.run("sova_history", { action: "event", event: bPerson }), /MARKB/);
  });

  test("a trace's boundary card says who is withheld, never that it wasn't recorded", async () => {
    const [own] = await host.record([ev("a-from-b", pa.id, { triggeredBy: [{ event: bPerson!, via: "operator-act" }] })]);
    const { run } = toolsOf(pa.id);
    const chain = await run("sova_history", { action: "trace", event: own });
    const card = chain.split("\n").find((l) => l.includes(bPerson!) && l.includes("outside this project"));
    assert.ok(card, chain);
    assert.match(card, /who: withheld/);
    assert.doesNotMatch(card, /not recorded/);
  });

  test("a trace calls a relation a relation, never a cause: by its position and its type", async () => {
    const [gath] = await host.record([ev("rel-g", pa.id, { kind: "gathering.started", outcome: "started" })]);
    const [dec] = await host.record([ev("rel-d", pa.id, { relations: [{ type: "recorded-in", target: { event: gath! } }] })]);
    const { run } = toolsOf(pa.id);
    const chain = await run("sova_history", { action: "trace", event: dec });
    const line = chain.split("\n").find((l) => l.includes(gath!) && !l.includes("→"))!;
    assert.ok(line, chain);
    assert.match(line, /^before 1 \(relation: recorded-in\)/);
    assert.doesNotMatch(chain, /\bcause 1\b/);
    assert.match(chain, new RegExp(`${dec} → ${gath}: relation, recorded-in \\(not a cause\\)`));
  });

  test("an actor not recorded says the why recorded for it", async () => {
    const [x] = await host.record([ev("why-1", pa.id, { kind: "merge.observed", outcome: "observed", actors: { initiatedBy: { unknown: true, why: "Started by its trigger." }, decidedBy: { unknown: true, why: "An outside result." }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" } } })]);
    const { run } = toolsOf(pa.id);
    assert.match(await run("sova_history", { action: "event", event: x }), /Initiated by not recorded \(Started by its trigger\.\); decided by not recorded \(An outside result\.\)/);
  });

  test("its own transcript and log-row citations are placed and shown; another project's are not", async () => {
    const a = host.history.event({ role: "project-overseer", project: pa.id }, aPerson!, {}, tools.modelLabels(org.id))!;
    assert.deepEqual(a.evidence.map((e) => e.availability === "withheld"), [false, false], JSON.stringify(a.evidence));
    // Without sessionProject a project overseer can't place them: withheld (the history's own rule).
    const bare = host.history.event({ role: "project-overseer", project: pa.id }, aPerson!, {}, { scrub: (t: string) => t })!;
    assert.ok(bare.evidence.every((e) => e.availability === "withheld"));
    assert.equal(tools.sessionProjectOf(host, org.id)(gb.sessionId), pb.id);
    assert.equal(tools.sessionProjectOf(host, org.id)(`baton/${org.id}/${gb.sessionId}`), pb.id);
    assert.equal(tools.sessionProjectOf(host, org.id)(`watch/${pa.id}`), pa.id);
    assert.equal(tools.sessionProjectOf(host, org.id)("nobody"), null);
  });

  test("a cited quote says only what it shows: found in its speaker's message, or the recorder's reading, not checked, and why", async () => {
    const [unchecked, mismatch] = await host.record([
      ev("q-unchecked", pa.id, { actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "model" }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } }, evidence: [{ n: 1, kind: "transcript", session: ga.sessionId, entry: "e1", check: "unchecked", why: "The message's sender wasn't recorded." }], rationale: { what: "QU" } }),
      ev("q-mismatch", pa.id, { actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "model" }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } }, evidence: [{ n: 1, kind: "transcript", session: ga.sessionId, entry: "e2", check: "speaker-mismatch" }], rationale: { what: "QM" } }),
    ]);
    const { run } = toolsOf(pa.id);
    assert.match(await run("sova_history", { action: "event", event: aPerson }), /Source \[1\] transcript · \w+ · quote found in the speaker's message \(the statement is the recorder's wording\)/);
    assert.match(await run("sova_history", { action: "event", event: unchecked }), /quote not checked, the recorder's reading of what was said: The message's sender wasn't recorded\./);
    assert.match(await run("sova_history", { action: "event", event: mismatch }), /quote not checked, the recorder's reading of what was said: Someone else sent that message\./);
  });

  test("the project overseer's tools hand back no contact value: in a result's text, its details or an error", async () => {
    const { ctx } = ctxFor(pa.id);
    const decide = tools.historyTools(org.id, ctx).find((t) => t.name === "sova_decide")!;
    const out = (await (decide.execute as any)("tc-contact", { disposition: "choose", what: `Call Priya on ${PHONE} first.`, reason: "She asked." })) as { content: { text: string }[]; details: { note: string } };
    assert.doesNotMatch(JSON.stringify(out), /555 123 4567/);
    assert.match(out.details.note, /\[contact\]/);
    await assert.rejects((decide.execute as any)("tc-contact2", { disposition: "choose", what: "x", reason: "y", supersedes: PHONE }), (e: Error) => !/555 123 4567/.test(e.message));
  });

  test("sova_decide: a decision not to act, with its reason and options; outcome Won't do; words only in the rationale", async () => {
    const { run, calls } = toolsOf(pa.id);
    const out = await run("sova_decide", {
      disposition: "do-not-do",
      what: "Not starting a bank-sync build this quarter.",
      reason: "The ledger export is unapproved.",
      options: [
        { label: "Build bank sync now", outcome: "do-not-do" },
        { label: "Keep weekly CSV", outcome: "selected" },
      ],
    });
    assert.deepEqual(calls, ["sova_decide"], "logged as the overseer's act");
    const id = /he_[0-9a-f]{32}/.exec(out)![0];
    const d = host.history.event({ role: "operator" }, id)!;
    assert.equal(d.record!.outcome, "do-not-do");
    assert.equal(d.record!.decision!.disposition, "do-not-do");
    assert.deepEqual(d.record!.actors.decidedBy, { kind: "project-overseer", id: pa.id, session: "conv1" });
    assert.ok((d.record!.actors.initiatedBy as { unknown?: boolean }).unknown, "unattended: never the operator's");
    assert.deepEqual(d.record!.actors.authorization, { kind: "autonomy-level", attended: false, level: "L1" });
    assert.ok(!/bank|ledger|CSV/i.test(JSON.stringify(d.record)));
    assert.equal(d.rationale!.reason!.text, "The ledger export is unapproved.");
    assert.equal(d.options.find((o) => o.id === "o1")!.label, "Build bank sync now");
    await assert.rejects(run("sova_decide", { disposition: "maybe", what: "x", reason: "y" }), /disposition/);
    await assert.rejects(run("sova_decide", { disposition: "defer", what: "x", reason: "y" }), /review/);
    await assert.rejects(run("sova_decide", { disposition: "choose", what: "x" }), /why/);
  });

  test("sova_decide supersedes only an overseer's own decision; the superseded one keeps its decider and reasons", async () => {
    const { run } = toolsOf(pa.id);
    await assert.rejects(run("sova_decide", { disposition: "choose", what: "Daily CSV instead.", reason: "Faster.", supersedes: aPerson }), new RegExp(tools.SUPERSEDE_REFUSAL.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(run("sova_decide", { disposition: "choose", what: "x", reason: "y", supersedes: bPerson }), /No such decision/);
    const first = /he_[0-9a-f]{32}/.exec(await run("sova_decide", { disposition: "defer", what: "Defer the portal redesign.", reason: "Q1 first.", review: "2026-04-01" }))![0];
    const second = /he_[0-9a-f]{32}/.exec(await run("sova_decide", { disposition: "choose", what: "Start the redesign.", reason: "Q1 closed.", supersedes: first }))![0];
    // the superseded one reads so, with its own reason intact
    const said = await run("sova_history", { action: "event", event: first });
    assert.match(said, /Superseded \S+ — Open New Decision: he_/);
    assert.match(said, /Recorded reason \(at the time\): Q1 first\./);
    const old = host.history.event({ role: "operator" }, first)!;
    assert.equal(old.event.superseded?.by, second);
    assert.deepEqual(old.record!.actors.decidedBy, { kind: "project-overseer", id: pa.id, session: "conv1" });
    assert.equal(old.rationale!.reason!.text, "Q1 first.");
    assert.equal(old.record!.decision!.reviewAt, Date.parse("2026-04-01"));
  });

  test("a gathering's decision whose quote didn't check (decided-by reads the model) is still a person's: never superseded", async () => {
    const [unchecked] = await host.record([
      ev("a-unchecked", pa.id, {
        actors: { initiatedBy: { unknown: true }, decidedBy: { kind: "model", session: ga.sessionId }, recordedBy: { kind: "model", session: ga.sessionId }, executedBy: { kind: "sova" } },
        source: { adapter: "org-steps", version: 1, key: "decision:unchecked" },
        evidence: [{ n: 1, kind: "transcript", session: ga.sessionId, entry: "u", check: "quote-not-found" }],
      }),
    ]);
    const { run } = toolsOf(pa.id);
    await assert.rejects(run("sova_decide", { disposition: "reject", what: "Not the CSV.", reason: "Mine.", supersedes: unchecked }), (e: Error) => e.message === tools.SUPERSEDE_REFUSAL);
    // nor one an overseer's decidedBy claims, unless sova_decide recorded it
    const [forged] = await host.record([
      ev("a-forged", pa.id, { actors: { decidedBy: { kind: "project-overseer", id: pa.id }, recordedBy: { kind: "model" } }, source: { adapter: "org-steps", version: 1, key: "decision:forged" } }),
    ]);
    await assert.rejects(run("sova_decide", { disposition: "reject", what: "x", reason: "y", supersedes: forged }), (e: Error) => e.message === tools.SUPERSEDE_REFUSAL);
  });

  test("sova_org_history: refused outside the operator's turn; the whole org in it, scrubbed", () => {
    assert.throws(() => tools.orgHistoryRead({ org: org.id, action: "search" }, false), new RegExp(tools.ORG_HISTORY_UNATTENDED.slice(0, 30)));
    const all = tools.orgHistoryRead({ org: "Gate", action: "search" }, true);
    assert.match(all, new RegExp(aPerson!));
    assert.match(all, new RegExp(bPerson!));
    const onlyB = tools.orgHistoryRead({ org: org.id, project: "Ledger", action: "search" }, true);
    assert.doesNotMatch(onlyB, new RegExp(aPerson!));
    assert.doesNotMatch(tools.orgHistoryRead({ org: org.id, action: "event", event: aPerson }, true), /555 123 4567/);
    assert.throws(() => tools.orgHistoryRead({ org: "Nope", action: "search" }, true));
  });
});
