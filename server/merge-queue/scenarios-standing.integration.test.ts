import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { settled, setup } from "./testing/scenario-kit";
import { until } from "./testing/repo";
import type { MergeEntry } from "../../shared/merge-queue";
import type { Caller } from "../project-services/engine";
import { previewDocs } from "../docs-preview";
import { merger } from "./routes";
import type { QueueHarness } from "./testing/harness";

/**
 * The user's one Land carries the chat's fix (al_3, §app.merge-queue/standing-approval): the real queue on the real run
 * (testing/harness.ts), real spec drafts and the spec tool's own landing. The chat answers through the merge.respond
 * verb as its own tool does (a session caller); the merge thread's check is a stand-in that rules "checked".
 */

const lastRequest = (e: MergeEntry) => e.requests![e.requests!.length - 1]!;
/** Out of the chat's hands: landed, or anything that isn't back with it. */
const done = (e: MergeEntry) => settled(e) && e.state !== "with-chat";
const callOf = (h: QueueHarness) =>
  merger({
    queues: h.queues,
    served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
    rootOf: async () => h.fx.project,
  });
const chat = (h: QueueHarness, id: string): Caller => ({ kind: "session", id, root: h.fx.project, own: [] });
/** The merge thread's stand-in: every fix it is handed only does what was asked. */
const checksFixes = { fix: async (h: QueueHarness, e: MergeEntry, ev: { request?: string }) => void (await h.queue().fixRuling(e.id, ev.request, true, "")) };

describe("one Land carries a drafts-only fix", () => {
  test("Land, sent back for its drafts, only .sova/spec/drafts/<name> edited (no commit), answered Fixed: back in line by itself and landed, never drafts-changed, with no second Land", async () => {
    // The docs check before the run is still working at the Land (as it often is): the run's own Docs step catches it.
    const { fx, h } = await setup({}, { thread: checksFixes, deps: { docsCheck: () => "pending" } });
    await fx.withSpec();
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    // A draft whose note is older than its prose: the spec tool refuses to make it official.
    fx.draft(b.checkout, "doc", "First words.");
    fx.editDraft(b.checkout, "doc", "Second words.");
    const call = callOf(h);
    const first = await h.add({ branch: b.branch, session: "chat-doc" });
    // From here on, any Land (merge.add) is counted: the user's one Land must be enough.
    const adds: unknown[] = [];
    const q = h.queue();
    const add = q.add.bind(q);
    q.add = (r) => (adds.push(r), add(r));
    assert.equal(first.approval.standing, true);
    const back = await h.waitEntry(first.id, settled);
    assert.equal(back.state, "with-chat", `${back.state}: ${back.reason}`);
    assert.equal(back.sentBackFor, "drafts");
    const rq = lastRequest(back);
    assert.equal(rq.kind, "fix");
    assert.match(rq.text, /needs no commit|no commit/i, "the request says fixing drafts needs no commit");

    // The chat fixes the draft in place: drafts are gitignored, nothing to commit.
    fx.noteDraft(b.checkout, "doc");
    const r = await call("merge.respond", { request: rq.id, answer: "fixed", drafts: true, text: "recorded the verification note" }, chat(h, "chat-doc"));
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.merge?.request?.answer?.kind === "fixed" && r.merge.request.answer.changed, "drafts");

    const landed = await h.waitEntry(first.id, done);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(landed.commit, b.commit, "the same commit: a drafts-only fix makes none");
    assert.match(fx.fileAt(landed.landed!.sha, ".sova/spec/claims/b/doc.md") ?? "", /Second words/, "the fixed drafts landed");
    assert.equal(landed.approval.fixes?.length, 1);
    assert.equal(landed.approval.fixes?.[0]?.commit, undefined);
    assert.equal(adds.length, 0, "no second Land");
    assert.ok(!h.notices.some((n) => n.kind === "drafts-changed" || n.kind === "decision"), "never drafts-changed, never a decision for the user");
    assert.equal(landed.runs.length, 2, "every check ran again");
  });
});

describe("Approved · waiting for a fix", () => {
  test("Land on a finished branch whose drafts don't fit: it waits with its chat (no run), the chat is told; fixed in its drafts and answered Fixed, it joins the line by itself and lands", async () => {
    const { fx, h } = await setup({}, { thread: checksFixes });
    await fx.withSpec();
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    fx.draft(b.checkout, "doc", "First words.");
    fx.editDraft(b.checkout, "doc", "Second words.");
    // Sova's try of the drafts has answered (readiness ran it): they wouldn't land.
    const hash = (await import("../spec-drafts-state")).draftsHash(b.checkout)!.hash;
    await until("the docs check", () => {
      const p = previewDocs(b.checkout, b.commit, hash, () => {});
      return p !== "pending" && p.problems.length > 0;
    });
    const e = await h.add({ branch: b.branch, session: "chat-doc" });
    assert.equal(e.state, "with-chat", `${e.state}: ${e.reason}`);
    assert.equal(e.standing?.phase, "waiting-fix");
    assert.match(e.reason ?? "", /spec drafts don't fit/);
    assert.equal(e.runs.length, 0, "not in line");
    const rq = lastRequest(e);
    assert.equal(rq.kind, "blocked");
    assert.ok(h.notices.some((n) => n.kind === "request" && n.text.includes("can't join the line yet")), "the chat is told what blocks it");

    fx.noteDraft(b.checkout, "doc");
    const r = await callOf(h)("merge.respond", { request: rq.id, answer: "fixed", drafts: true, text: "noted" }, chat(h, "chat-doc"));
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const landed = await h.waitEntry(e.id, done);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.match(fx.fileAt(landed.landed!.sha, ".sova/spec/claims/b/doc.md") ?? "", /Second words/);
  });
});
