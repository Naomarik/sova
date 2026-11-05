import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, settled, setup, STATE } from "./testing/scenario-kit";
import { git, until } from "./testing/repo";
import type { SessionSummary } from "../../shared/protocol";
import { draftsLeft } from "../spec-drafts-state";
import { realGit } from "./guard";
import { LANDED_DRAFTS_FILE, type LandedDraftsRecord, recordLandedDrafts } from "./landed-drafts";

/**
 * Edges of the landing receipt (§chat.worktrees/readiness) the main scenarios leave out: two drafts of which only one
 * landed as it is, a voided run's docs commit, a branch carried onto the target inside another branch's landing, and
 * the draft tool's lock released within, or held past, its wait. The real queue on the real run, on real git.
 */

const ancestor = async (commit: string, ref: string, cwd: string) => {
  try {
    git(cwd, ["merge-base", "--is-ancestor", commit, ref]);
    return true;
  } catch {
    return false;
  }
};
const LOST = /spec drafts? didn't make it/;
type DraftJson = { promotions: unknown[]; landed?: { commit: string; hash: string; target: string } };
const draftFile = (checkout: string, name: string) => join(checkout, ".sova/spec/drafts", name, "draft.json");
const draftJson = (checkout: string, name: string) => JSON.parse(readFileSync(draftFile(checkout, name), "utf8")) as DraftJson;
/** As a branch landed before receipts left it: the draft's `landed` gone. */
const stripReceipt = (checkout: string, name: string) => {
  const { landed: _gone, ...rest } = draftJson(checkout, name);
  writeFileSync(draftFile(checkout, name), JSON.stringify(rest, null, 2) + "\n");
};

let sessions = 0;
/** The branch's real Worktrees row (as scenarios-landed-drafts reads it): real git, real drafts, only the chat's state stood in. */
async function rowOf(checkout: string, branch: string, base: string, target: string) {
  const r = await import("../merge-readiness");
  const { fileLandingStore } = await import("../ready-to-land");
  const n = ++sessions;
  const id = `01a0eeee-e385-72b1-a203-${String(n).padStart(12, "0")}`;
  const dir = join(STATE, `edge-row-${n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-26T00-00-00-000Z_${id}.jsonl`);
  const at = "2026-10-26T00:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id, timestamp: at, cwd: checkout },
    { type: "custom", customType: "worktrees", id: "a0000001", parentId: null, timestamp: at, data: { version: 1, trees: [{ path: checkout, branch, base, baseBranch: target, status: "active", session: id, how: "created", at: 1 }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  r.configureReadiness({ asksUser: () => undefined, finished: () => "off", nudge: undefined, served: async () => true, processStart: 0, landing: fileLandingStore(() => join(dir, "landing.json")) });
  const row: SessionSummary = { id, path, cwd: checkout, title: "t", createdAt: "", lastActiveAt: at, model: null, live: null, busy: false, origin: "web", archived: false };
  try {
    return await until("the row's reading", async () => {
      r.readinessOverlay(row);
      await r.readinessIdle();
      const t = r.readinessReading(path);
      return t.known ? t.value?.trees[0] : null;
    });
  } finally {
    r.resetReadiness();
  }
}

describe("landing receipts: the edges", () => {
  test("two drafts, one edited while the run checked: only the one that landed as it is gets the receipt; the row still warns", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const base = fx.head();
    const b = fx.branch("pair", { "src/app.txt": APP("line 3 changed"), "tests/g.txt": "gate pair\n" });
    fx.draft(b.checkout, "one");
    fx.draft(b.checkout, "two");
    const e = await h.add({ branch: b.branch });
    assert.deepEqual([...(e.approval.drafts?.names ?? [])].sort(), ["one", "two"]);
    await until("the run at its gate (docs made)", () => fx.atGate("pair"));
    fx.editDraft(b.checkout, "two", "The two feature now does something else.");
    fx.openGate("pair");
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const tip = fx.head();
    assert.match(fx.fileAt(tip, ".sova/spec/claims/b/two.md") ?? "", /The two feature does its one thing/, "two landed as approved");
    assert.equal(draftJson(b.checkout, "one").landed?.commit, tip, "one is as it landed: receipt");
    const two = draftJson(b.checkout, "two");
    assert.equal(two.landed, undefined, "two changed since it landed: no receipt");
    assert.equal(two.promotions.length, 0, "nor the landing's promotion entries");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["two"]);
    const row = await rowOf(b.checkout, b.branch, base, fx.target);
    assert.equal(row?.state, "merged", JSON.stringify(row));
    assert.match(row?.reason ?? "", LOST, "the edited draft is a draft that didn't make it");
  });

  test("a run voided after its docs commit: no receipt; the voided docs commit can't be written or read as the landing", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed"), "tests/g.txt": "gate doc\n" });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    await until("the run at its gate (docs made)", () => fx.atGate("doc"));
    fx.moveTargetOutside();
    await h.waitView((v) => v.state === "paused", "paused: master moved");
    fx.openGate("doc");
    const voided = await until("the voided run", async () => {
      const en = await h.entry(e.id);
      const r = en.runs[0] ? h.run(en.runs[0]) : null;
      return r && r.verdict === "void" ? r : null;
    });
    const rec = JSON.parse(readFileSync(join(h.runDir(voided.id), LANDED_DRAFTS_FILE), "utf8")) as LandedDraftsRecord;
    assert.ok(rec.drafts.doc, "the voided run made its docs commit");
    assert.ok(!fx.isAncestor(rec.commit, fx.head()), "that commit never reached the target");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "a voided run writes no receipt");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    // The writer refuses a record whose commit isn't under the tip it is told landed.
    const wrote = await recordLandedDrafts({ git: realGit, root: fx.project, runDir: h.runDir(voided.id), worktree: b.checkout, docs: "on-target", target: fx.target, tip: fx.head(), run: voided.id, now: new Date().toISOString() });
    assert.deepEqual(wrote, [], "the voided docs commit isn't on the target");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    // The reader: a receipt naming that commit (on its target by name only) speaks for nothing.
    const d = draftJson(b.checkout, "doc");
    const hash = rec.drafts.doc!.hash;
    writeFileSync(draftFile(b.checkout, "doc"), JSON.stringify({ ...d, landed: { commit: rec.commit, target: fx.target, hash, at: "", by: "t" } }, null, 2));
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"], "a receipt whose commit isn't an ancestor of its target");
    writeFileSync(draftFile(b.checkout, "doc"), JSON.stringify(d, null, 2));
    // Resumed: rebuilt on the new target, and the receipt names that landing's spec commit, not the voided one.
    await h.resume();
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const r = draftJson(b.checkout, "doc").landed;
    assert.ok(r && r.commit !== rec.commit && fx.isAncestor(r.commit, fx.head()), `receipt ${JSON.stringify(r)}`);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
  });

  test("a branch carried onto the target inside another branch's landing still warns; the carrier doesn't", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const base = fx.head();
    const carried = fx.branch("summary", { "src/summary.txt": "summary\n" });
    fx.draft(carried.checkout, "summary");
    const carrier = fx.branch("dialog", { "src/app.txt": APP("line 3 changed") }, { from: carried.commit });
    fx.draft(carrier.checkout, "dialog");
    const e = await h.waitEntry((await h.add({ branch: carrier.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const tip = fx.head();
    assert.ok(fx.isAncestor(carried.commit, tip), "the carried branch's code is on the target");
    assert.equal(fx.fileAt(tip, ".sova/spec/claims/b/summary.md"), null, "its spec never landed");
    assert.equal(draftJson(carried.checkout, "summary").landed, undefined);
    assert.deepEqual(await draftsLeft(carried.checkout, ancestor), ["summary"]);
    const row = await rowOf(carried.checkout, carried.branch, base, fx.target);
    assert.equal(row?.state, "merged", JSON.stringify(row));
    assert.match(row?.reason ?? "", LOST, "the one true case: carried in, its drafts didn't make it");
    const own = await rowOf(carrier.checkout, carrier.branch, base, fx.target);
    assert.equal(own?.state, "merged", JSON.stringify(own));
    assert.doesNotMatch(own?.reason ?? "", LOST);
  });

  test("the draft tool's lock: released within the wait, the receipt is written; held past 3 s, nothing is, and the lock stays", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const tip = fx.head();
    stripReceipt(b.checkout, "doc");
    const lock = join(b.checkout, ".sova/spec/drafts/.lock");
    const mark = () => recordLandedDrafts({ git: realGit, root: fx.project, runDir: h.runDir(e.run!), worktree: b.checkout, docs: "on-target", target: fx.target, tip, run: e.run!, now: new Date().toISOString(), log: (s) => logs.push(s) });
    const logs: string[] = [];
    // A chat's writer holds it for a second, then lets go.
    writeFileSync(lock, "4242 a-chat 01 2026-11-05T00:00:00.000Z");
    const t = setTimeout(() => rmSync(lock, { force: true }), 1000);
    const first = await mark();
    clearTimeout(t);
    assert.deepEqual(first, ["doc"], `released within the wait: written (${logs.join("; ")})`);
    assert.equal(draftJson(b.checkout, "doc").landed?.commit, tip);
    assert.ok(!existsSync(lock), "its own lock released");
    // Held past the wait: nothing written, the other writer's lock untouched, and said.
    stripReceipt(b.checkout, "doc");
    const held = "4242 a-chat 02 2026-11-05T00:00:00.000Z";
    writeFileSync(lock, held);
    const started = Date.now();
    const second = await mark();
    const waited = Date.now() - started;
    assert.deepEqual(second, []);
    assert.ok(waited >= 2900, `waited its 3 s first (${waited} ms)`);
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "nothing written under another writer's lock");
    assert.equal(readFileSync(lock, "utf8"), held, "never taken over");
    assert.ok(logs.some((l) => /lock is held/.test(l)), logs.join("; "));
  });
});
