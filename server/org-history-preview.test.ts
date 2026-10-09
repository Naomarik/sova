// Run: node scripts/run-tests.mjs server/org-history-preview.test.ts. A preview link made and shared, through the
// real engine: the project statechart's preview/start (an attended overseer turn, an unattended one held then
// released by its timer, the operator) and services/share, each answered by its effect as the host's own handlers
// answer it (`{ id }`), so the history reads the request and, triggered by it, the preview made by id; then a
// WhatsApp send carrying that preview names it. A link, a token or a hash the minting saw is planted and asserted
// absent from every history file and every read. The effects' handlers are fakes (no listener, no preview address);
// a throwaway agent dir and workspace.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HistoryEvent, HistoryReader } from "../shared/org-history";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-preview-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const { envelopeFor, hostOf } = await import("./org-engine");
const { fakeLooks } = await import("./org-test-fixtures");
const { targetOfPerson } = await import("./baton");
const { projectSid } = await import("./projects/sids");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { mintPreview } = await import("./preview-links");

after(async () => {
  await disposeAllChats();
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
});

const OPERATOR: HistoryReader = { role: "operator" };
/** What a minting saw and kept host-local: never in the history. */
const LINK = "https://tok3nplanted.preview.example.invalid/";
const TOKEN = "tok3nplanted";
const HASH = "f00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dfacef00dface";
const PLANTED = [LINK, TOKEN, HASH, "preview.example.invalid"];

const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
mkdirSync(join(tmp, "client"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "client") });
const ann = await orgs.addPerson(org.id, { name: "Ann", role: "Staff", contact: { whatsapp: "+1 555 000 0100" } });
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);
await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 1 });

const host = () => hostOf(org.id);
let n = 0;
const minted: string[] = [];
// The host's preview handler answers `{ id: made.record.id }`; this one also carries what a mint saw (the link,
// the token, its hash) and one failure says the address, so a capture that read more than the id would leak it.
const answer = (e: Record<string, unknown>) => {
  if (e.purpose === "fail") throw new Error(`No preview: ${LINK} did not answer`);
  // a real record (the gathering's tool checks the preview is this project's), its id answered as the host's handler does
  ++n;
  const id = mintPreview({ projectId: project.id, port: 5173 }, new Set()).record.id;
  minted.push(id);
  return { id, url: LINK, token: TOKEN, hash: HASH };
};
host().effects.register("preview", async (e) => answer(e));
host().effects.register("services-share", async (e) => answer(e));
host().effects.register("outreach-send", async () => ({ outcome: "sent", channel: "whatsapp" }));

/** Every event of these kinds, those listed under their group's row (a held act released by a review) too. */
const records = (kinds: HistoryEvent["kind"][]): HistoryEvent[] => {
  const h = host().history;
  const rows = h.search(OPERATOR, { limit: 200 }).items;
  const all = [...rows, ...rows.flatMap((i) => h.search(OPERATOR, { groupOf: i.id, limit: 200 }).items)];
  return [...new Map(all.map((i) => [i.id, i])).values()].filter((i) => (kinds as string[]).includes(i.kind)).map((i) => h.event(OPERATOR, i.id)!.record!);
};
const newest = (kind: HistoryEvent["kind"], before: Set<string>) => records([kind]).filter((r) => !before.has(r.id));
const ids = () => new Set(records(["preview.started", "preview.made", "hold.created", "hold.released", "outreach.sent"]).map((r) => r.id));
const start = (by: "operator" | "overseer", attended: boolean, data: Record<string, unknown> = {}) =>
  host().act(projectSid(project.id), "preview/start", { codingSession: "s-shop", port: 5173, purpose: "The shop for Ana", overseerId: "po-1", ...data }, envelopeFor(org.id, project.id, { by, attended }), { settle: true });

/** The request, then the answer it triggered through its effect. */
function pair(before: Set<string>) {
  const req = newest("preview.started", before);
  const made = newest("preview.made", before);
  assert.equal(req.length, 1, JSON.stringify(req));
  assert.equal(made.length, 1, JSON.stringify(made));
  assert.deepEqual(made[0]!.triggeredBy, [{ event: req[0]!.id, via: "effect" }]);
  return { req: req[0]!, made: made[0]! };
}

describe("a preview link made, captured through the engine", () => {
  test("an attended overseer turn: preview.started decided by the project overseer, initiated by the operator; preview.made names the preview by id", async () => {
    const before = ids();
    const out = await start("overseer", true);
    assert.ok(out.taken && !out.held, JSON.stringify(out));
    const { req, made } = pair(before);
    assert.equal(req.outcome, "started");
    assert.deepEqual(req.actors.initiatedBy, { kind: "operator" });
    assert.equal((req.actors.decidedBy as { kind: string }).kind, "project-overseer");
    assert.equal((req.actors.authorization as { kind: string }).kind, "attended-turn");
    assert.ok(req.entities.some((x) => x.type === "session" && x.id === "s-shop"), JSON.stringify(req.entities));
    assert.equal(made.outcome, "done");
    assert.deepEqual(made.entities.filter((x) => x.type === "preview"), [{ type: "preview", id: minted.at(-1)! }]);
    assert.equal((made.actors.decidedBy as { unknown?: boolean }).unknown, true, "an outside result decides nothing");
    assert.equal(host().history.event(OPERATOR, made.id)!.rationale?.what, `Preview link made: ${minted.at(-1)}`);
  });

  test("an unattended overseer: held, then released by its review; preview.started under the release, and its answer", async () => {
    const before = ids();
    const out = await start("overseer", false);
    assert.ok(out.held, JSON.stringify(out));
    const held = newest("hold.created", before);
    assert.equal(held.length, 1);
    assert.equal(newest("preview.started", before).length, 0, "nothing asked for while it waits");
    // a confirm-required hold waits past its end for a review: the overseer's own, in a later unattended look
    const ref = out.held!.id;
    const approved = await host().act(projectSid(project.id), "hold/approve", { id: ref, reason: "The shop is ready" }, envelopeFor(org.id, project.id, { by: "overseer", attended: false }), { settle: true });
    assert.ok(approved.taken, JSON.stringify(approved.refusal));
    await host().idle();
    const { req } = pair(before);
    const approval = newest("hold.released", before).find((r) => r.source.key.startsWith("step:"));
    assert.ok(approval, "the review is recorded");
    assert.equal((req.actors.decidedBy as { kind: string }).kind, "project-overseer");
    assert.equal((req.actors.initiatedBy as { unknown?: boolean }).unknown, true, "an unattended act's start is its trigger");
    assert.equal((req.actors.authorization as { kind: string }).kind, "hold-release");
    assert.deepEqual((req.actors.authorization as { by?: unknown }).by, approval!.actors.decidedBy);
    assert.deepEqual(req.triggeredBy, [{ event: approval!.id, via: "operator-act" }]);
  });

  test("the operator: all the operator's, never held", async () => {
    const before = ids();
    const out = await start("operator", true);
    assert.ok(out.taken && !out.held, JSON.stringify(out));
    const { req } = pair(before);
    assert.deepEqual(req.actors.decidedBy, { kind: "operator" });
    assert.deepEqual(req.actors.authorization, { kind: "operator-act", attended: true });
  });

  test("a failed mint: preview.made Failed, without the failure's text", async () => {
    const before = ids();
    await start("operator", true, { purpose: "fail" });
    const { made } = pair(before);
    assert.equal(made.outcome, "failed");
    assert.equal(made.entities.some((x) => x.type === "preview"), false);
    assert.equal(host().history.event(OPERATOR, made.id)!.rationale?.what, "Preview link not made");
  });

  test("a running copy shared: preview.started names the instance, and its answer the preview", async () => {
    const before = ids();
    const out = await host().act(projectSid(project.id), "services/share", { verb: "share", instance: "inst-1", endpoint: "site.http", branch: "feat/shop", overseerId: "po-1" }, envelopeFor(org.id, project.id, { by: "overseer", attended: true }), { settle: true });
    assert.ok(out.taken && !out.held, JSON.stringify(out));
    const { req, made } = pair(before);
    assert.ok(req.entities.some((x) => x.type === "instance" && x.id === "inst-1"), JSON.stringify(req.entities));
    assert.deepEqual(made.entities.filter((x) => x.type === "preview"), [{ type: "preview", id: minted.at(-1)! }]);
  });

  test("a WhatsApp send carrying a preview names it, and relates to the preview made", async () => {
    const pv = minted[0]!;
    const made = records(["preview.made"]).find((r) => r.entities.some((x) => x.type === "preview" && x.id === pv))!;
    const before = ids();
    const out = await host().act(`placement/${org.id}/${project.id}`, "outreach/send", { target: targetOfPerson({ ...ann, orgId: org.id }), link: { kind: "preview", preview: pv }, sentBy: "operator" }, envelopeFor(org.id, project.id, { by: "operator", attended: true }), { settle: true });
    assert.ok(out.taken && !out.held, JSON.stringify(out));
    const send = newest("outreach.sent", before).find((r) => r.outcome === "started")!;
    assert.ok(send, "the send is recorded");
    assert.deepEqual(send.entities.filter((x) => x.type === "preview"), [{ type: "preview", id: pv }]);
    assert.ok(send.relations?.some((r) => r.type === "named-target" && "event" in r.target && r.target.event === made.id), JSON.stringify(send.relations));
  });

  test("a gathering started about a preview names it by id (named-target its preview.made), never a cause; an unknown one is refused", async () => {
    await start("operator", true);
    const pv = minted.at(-1)!;
    const made = records(["preview.made"]).find((r) => r.entities.some((x) => x.type === "preview" && x.id === pv))!;
    assert.ok(made, "the preview made");
    const tool = po.toolsForTest(project.id, { attended: true }).find((t) => t.name === "sova_start_gathering")!;
    const params = { gap: "none", person: "Ann", why: "Ann should see the shop.", public_title: "The shop", goal: "Whether the shop works for Ann", question: "Does the shop work for you?" };
    await assert.rejects(tool.execute("g0", { ...params, preview: "pv_nosuchpreview00000" } as never, undefined, undefined, undefined as never), /No such preview in this project/);
    const out = await tool.execute("g1", { ...params, preview: pv } as never, undefined, undefined, undefined as never);
    const sid = (out.details as { id: string }).id;
    const started = records(["gathering.started"]).find((r) => r.entities.some((x) => x.type === "session" && x.id === sid))!;
    assert.ok(started, "the gathering's start");
    assert.ok(started.relations.some((r) => r.type === "named-target" && "event" in r.target && r.target.event === made.id), JSON.stringify(started.relations));
    assert.ok(!started.triggeredBy.some((t) => t.event === made.id), "naming a preview is no cause");
  });

  test("no link, token or hash anywhere: every history file and every read", async () => {
    const files: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d)) (statSync(join(d, f)).isDirectory() ? walk : (p: string) => files.push(p))(join(d, f));
    };
    walk(join(tmp, "ws", "history"));
    walk(join(tmp, "agent", "sova", "org-history"));
    assert.ok(files.some((f) => f.endsWith(".jsonl")), files.join(","));
    const h = host().history;
    const all = records(["preview.started", "preview.made", "outreach.sent", "hold.created", "hold.released"]);
    assert.ok(all.length >= 10, String(all.length));
    const reads = [
      JSON.stringify(h.search(OPERATOR, {})),
      ...all.map((r) => JSON.stringify(h.event(OPERATOR, r.id))),
      ...all.map((r) => JSON.stringify(h.trace(OPERATOR, r.id))),
      ...all.map((r) => JSON.stringify(h.packet(OPERATOR, { event: r.id }))),
    ];
    for (const text of [...files.map((f) => readFileSync(f, "utf8")), ...reads]) for (const p of PLANTED) assert.ok(!text.includes(p), `planted ${p} found`);
  });
});
