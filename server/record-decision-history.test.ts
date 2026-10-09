// Run: node scripts/run-tests.mjs server/record-decision-history.test.ts. record_decision in the org's history
//: its event under the marker's key, the quote checked against the
// sender-marked message, a disposition with its options, words only in the private rationale. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { HistoryEvent } from "../shared/org-history";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-record-decision-history-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const engine = await import("./org-engine");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

describe("record_decision's history", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const priya = await orgs.addPerson(org.id, { name: "Priya Shah", role: "Finance", decides: ["reporting"] });
  const omar = await orgs.addPerson(org.id, { name: "Omar Ali", role: "IT" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: priya.id, publicTitle: "Q1 reporting", goal: "g" });

  // The session as the tool sees it: a person's message, its sender marker, then what the tool writes.
  let seq = 0;
  const branch: HEntry[] = [];
  const add = (h: Omit<HEntry, "id" | "parentId"> & Record<string, unknown>): string => {
    const id = `e${++seq}`;
    branch.push({ ...h, id, parentId: branch.at(-1)?.id ?? null } as HEntry);
    return id;
  };
  const says = (by: string, text: string): string => {
    const id = add({ kind: "user", blocks: [{ type: "text", text }] } as never);
    add({ kind: "state", key: "sova-baton-sent", data: { v: 1, targetId: id, by } } as never);
    return id;
  };
  const writer = { append: (kind: { type: string }, data: unknown) => add({ kind: "state", key: kind.type, data } as never) };
  const ctx = { leafId: () => branch.at(-1)!.id, branch: () => branch.slice() } as never;
  const tool = () => loadout.batonTools(c.sessionId, writer as never).find((t) => t.name === "record_decision")!;
  const run = (args: Record<string, unknown>) => tool().execute("tc", { ownerArea: "none", ...args }, undefined, undefined, ctx) as Promise<{ content: { text: string }[] }>;
  const lastMarker = (): HEntry => [...branch].reverse().find((h) => h.kind === "state" && h.key === "sova-baton-decision")!;
  const history = () => engine.hostOf(org.id).history;
  const recordOf = (key: string): HistoryEvent => {
    const page = history().search({ role: "operator" }, { kinds: ["decision.recorded"] });
    const hit = page.items.map((i) => history().event({ role: "operator" }, i.id)!).find((d) => d.record?.source.key === key);
    assert.ok(hit, `an event under ${key}`);
    return hit.record!;
  };

  test("two decisions in one message: two markers, two events, each the person's (their words check)", async () => {
    const u = says(priya.id, "Use the weekly approved CSV. And keep the old portal live until April.");
    await run({ area: "reporting", statement: "Q1 reporting uses the weekly approved CSV.", quote: "Use the weekly approved CSV." });
    const m1 = lastMarker().id!;
    await run({ area: "portal", statement: "The old portal stays live until April.", quote: "keep the old portal live until April" });
    const m2 = lastMarker().id!;
    assert.notEqual(m1, m2);
    // each marker keeps the decider's name as the conversation called them then
    assert.equal((lastMarker() as unknown as { data: { name?: string } }).data.name, "Priya Shah");
    for (const m of [m1, m2]) {
      const r = recordOf(`decision:${c.sessionId}:${m}`);
      assert.deepEqual(r.actors.decidedBy, { kind: "person", id: priya.id });
      assert.equal((r.actors.recordedBy as { kind: string }).kind, "model");
      const ev = r.evidence[0]!;
      assert.equal(ev.kind === "transcript" && ev.entry, u);
      assert.equal(ev.kind === "transcript" && ev.check, "checked");
      assert.ok(!JSON.stringify(r).includes("CSV") && !JSON.stringify(r).includes("portal live"), "no words in the event line");
    }
  });

  test("words not in the message: recorded, not checked, the model's", async () => {
    says(priya.id, "Let me think about the bank feed.");
    const out = await run({ area: "bank", statement: "Bank sync is approved.", quote: "Bank sync is fine" });
    assert.equal(out.content[0]!.text, "Recorded as your reading, not checked: their exact words weren't found in that message.");
    const m = lastMarker().id!;
    const r = recordOf(`decision:${c.sessionId}:${m}`);
    assert.equal(r.evidence[0]!.kind === "transcript" && r.evidence[0]!.check, "quote-not-found");
    assert.equal((r.actors.decidedBy as { kind: string }).kind, "model");
  });

  test("a message whose sender marker was never written: the quote is not checked, never the holder's or the claimed author's", async () => {
    // a stop between the message and its sender marker: the message is there, who sent it is not recorded
    const u = add({ kind: "user", blocks: [{ type: "text", text: "Close the books on the 5th." }] } as never);
    const said = await run({ area: "close", statement: "Books close on the 5th.", quote: "Close the books on the 5th." });
    assert.equal(said.content[0]!.text, "Recorded as your reading, not checked: who sent that message wasn't recorded.");
    const r = recordOf(`decision:${c.sessionId}:${lastMarker().id!}`);
    const ev = r.evidence[0]!;
    assert.equal(ev.kind === "transcript" && ev.entry, u);
    assert.equal(ev.kind === "transcript" && ev.check, "unchecked");
    assert.equal(ev.kind === "transcript" && ev.why, "The message's sender wasn't recorded.");
    assert.ok(!(ev.kind === "transcript" && ev.speaker));
    assert.equal((r.actors.decidedBy as { kind: string }).kind, "model");
    assert.deepEqual(r.actors.authorization, { kind: "none" });
    // the same words, sender-marked: checked, hers
    says(priya.id, "Close the books on the 6th.");
    await run({ area: "close", statement: "Books close on the 6th.", quote: "Close the books on the 6th." });
    const marked = recordOf(`decision:${c.sessionId}:${lastMarker().id!}`);
    assert.equal(marked.evidence[0]!.kind === "transcript" && marked.evidence[0]!.check, "checked");
    assert.deepEqual(marked.actors.decidedBy, { kind: "person", id: priya.id });
  });

  test("a message someone else sent: speaker mismatch, never the holder's", async () => {
    says(omar.id, "Ship it on Friday.");
    const said = await run({ area: "release", statement: "Release on Friday.", quote: "Ship it on Friday." });
    assert.equal(said.content[0]!.text, "Recorded as your reading, not checked: that message was sent by someone else.");
    const m = lastMarker().id!;
    const r = recordOf(`decision:${c.sessionId}:${m}`);
    assert.equal(r.evidence[0]!.kind === "transcript" && r.evidence[0]!.check, "speaker-mismatch");
    assert.notDeepEqual(r.actors.decidedBy, { kind: "person", id: priya.id });
  });

  test("a deferral with its options: outcome Deferred, option ids in the event, labels and reasons only in the rationale", async () => {
    says(priya.id, "Not bank sync this quarter, the ledger export isn't approved. Weekly CSV for now, manual entry is too much.");
    await run({
      area: "bank sync",
      statement: "Direct bank sync is deferred for Q1.",
      quote: "Not bank sync this quarter",
      disposition: "defer",
      reason: "The ledger export isn't approved.",
      review: "2026-04-01",
      options: [
        { label: "Weekly approved CSV", outcome: "selected" },
        { label: "Direct bank API", outcome: "deferred", reason: "ledger export not approved" },
        { label: "Manual per-investor entry", outcome: "rejected", reason: "too much repeated entry" },
      ],
    });
    const marker = lastMarker();
    assert.equal((marker as { data: { disposition?: string } }).data.disposition, "defer", "the marker keeps it, so a recovery does too");
    const r = recordOf(`decision:${c.sessionId}:${marker.id}`);
    assert.equal(r.outcome, "deferred");
    assert.equal(r.decision?.disposition, "defer");
    assert.deepEqual(r.decision?.options, [
      { id: "o1", outcome: "selected" },
      { id: "o2", outcome: "deferred" },
      { id: "o3", outcome: "rejected" },
    ]);
    assert.equal(r.decision?.reviewAt, Date.parse("2026-04-01"));
    assert.ok(!/ledger|CSV|manual/i.test(JSON.stringify(r)), "no words in the event line");
    const d = history().event({ role: "operator" }, r.id)!;
    assert.equal(d.rationale?.reason?.text, "The ledger export isn't approved.");
    assert.equal(d.rationale?.options?.find((o) => o.id === "o3")?.reason, "too much repeated entry");
  });

  test("a disposition that isn't one is refused before anything is written", async () => {
    const before = branch.length;
    await assert.rejects(run({ area: "x", statement: "s", quote: "q", disposition: "maybe" }), /disposition must be/);
    await assert.rejects(run({ area: "x", statement: "s", quote: "q", options: [{ label: "a", outcome: "won" }] }), /outcome must be/);
    assert.equal(branch.length, before);
  });
});
