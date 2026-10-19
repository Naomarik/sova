import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TourJob } from "../../shared/tour";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { tourScriptDigest } from "./checks";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import { TourCaptureFailure } from "./targets";
import type { TourToolCaller } from "./tools";

// Revoke Site and Remove Account (§app.tours/sites): installation-wide, for an exact origin a chat's
// tour uses. A revoked origin is asked for again by the next recording that needs it, and stops a
// running one at its next contact; a removed account sends the next recording that needs one back to
// waiting for a test account. Another chat, an origin the tour doesn't use, or a deleted chat
// changes nothing.
const origin = "https://example.test";
const other = "https://other.example.test";
const state = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);

function setup(root: string) {
  const caller = (sessionId: string): TourToolCaller => ({ sessionId, sessionFile: join(root, `${sessionId}.jsonl`), cwd: root, state });
  /** Holds the next run between its first and second contact while set. */
  let gate: { reached: () => void; release: Promise<void> } | undefined;
  const run: NonNullable<TourRuntimeOptions["run"]> = async input => {
    await input.beforeContact(origin);
    if (gate) { const g = gate; gate = undefined; g.reached(); await g.release; await input.beforeContact(origin); }
    // The site answers 401 without a test account.
    if (!input.account) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store one.", blockedOrigin: origin });
    return { steps: [], assets: new Map(), contactSheets: [], suspicious: [], provenance: { origin, recordedAt: "2026-01-02T03:04:05.000Z", publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script), sovaServer: false };
  };
  const runtime = new TourRuntime({ root, run,
    context: { canonical: p => p, snapshot: async c => ({ sessionId: c.sessionId, sessionFile: c.sessionFile, cwd: root, agentDir: join(root, "agent"), state, held: { on: false, enforcement: "none" } }) },
    target: async source => ({ origin: source.kind === "site" ? source.origin : origin, assertCurrent: async () => {} }),
  });
  const hold = () => { let reached!: () => void, release!: () => void; const at = new Promise<void>(r => { reached = r; }); gate = { reached, release: new Promise<void>(r => { release = r; }) }; return { at, release }; };
  return { runtime, caller, hold };
}
async function settled(runtime: TourRuntime, sessionId: string, id: string): Promise<TourJob> {
  for (let i = 0; i < 500; i++) {
    const job = runtime.queue.get(sessionId, id)!;
    if (["checking", "ready", "failed", "cancelled", "needs-site-approval", "needs-test-account"].includes(job.phase)) return job;
    await new Promise(ok => setTimeout(ok, 2));
  }
  throw new Error("The in-process queue did not settle.");
}
const script = () => { const s = tourScriptFixture(); s.source = { kind: "site", origin }; return s; };
const files = (root: string) => ["tour-approvals/origins.json", "tour-accounts/test-accounts.json"].map(f => { try { return readFileSync(join(root, f), "utf8"); } catch { return null; } });

test("a tour's sites list approval and account state; revoke and remove change what the next recording needs", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-sites-"));
  const { runtime, caller } = setup(root);
  const a = caller("chat-a");
  try {
    // Approve, store an account, and finish a dry run: the site is approved and has an account.
    let job = await settled(runtime, a.sessionId, (await runtime.dryRun(a, script(), "tour-a")).job.id);
    assert.equal(job.phase, "needs-site-approval");
    await runtime.approve(a, job.id, origin);
    job = await settled(runtime, a.sessionId, job.id);
    assert.equal(job.phase, "needs-test-account");
    await runtime.saveAccount(a, job.id, { origin, username: "made-up-tester", password: "fake-pw-17", testAccount: true });
    assert.equal((await settled(runtime, a.sessionId, job.id)).phase, "checking");
    assert.deepEqual(runtime.sites(a.sessionId, "tour-a"), [{ origin, approved: true, account: true }]);
    assert.deepEqual(runtime.latest(a.sessionId, "tour-a").sites, [{ origin, approved: true, account: true }]);

    // Scope: another chat (no tour of that id) and an origin this tour doesn't use change nothing.
    const before = files(root);
    assert.throws(() => runtime.revokeSite(caller("chat-b"), "tour-a", origin), /doesn't use that site/);
    assert.throws(() => runtime.removeAccount(caller("chat-b"), "tour-a", origin), /doesn't use that site/);
    runtime.approvals.approve(other);
    const withOther = files(root);
    assert.throws(() => runtime.revokeSite(a, "tour-a", other), /doesn't use that site/);
    assert.deepEqual(files(root), withOther);
    runtime.approvals.revoke(other);
    assert.deepEqual(files(root), before);

    // Revoke Site: installation-wide; the next recording that needs it asks again.
    assert.deepEqual(runtime.revokeSite(a, "tour-a", origin), [{ origin, approved: false, account: true }]);
    assert.equal(runtime.approvals.isApproved(origin), false);
    assert.equal((await settled(runtime, a.sessionId, (await runtime.dryRun(a, script(), "tour-a")).job.id)).phase, "needs-site-approval");
    // A fresh tour of another chat needs it too (installation-wide).
    const b = caller("chat-b");
    assert.equal((await settled(runtime, b.sessionId, (await runtime.dryRun(b, script(), "tour-b")).job.id)).phase, "needs-site-approval");

    // Remove Account: the next fresh recording of that origin waits for a test account.
    runtime.approvals.approve(origin);
    assert.deepEqual(runtime.removeAccount(a, "tour-a", origin), [{ origin, approved: true, account: false }]);
    assert.equal(runtime.accounts.forOrigin(origin), null);
    assert.equal((await settled(runtime, a.sessionId, (await runtime.dryRun(a, script(), "tour-fresh")).job.id)).phase, "needs-test-account");
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a revoked origin stops a running recording at its next contact", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-sites-running-"));
  const { runtime, caller, hold } = setup(root);
  const a = caller("chat-a");
  try {
    runtime.approvals.approve(origin);
    runtime.accounts.save({ origin, username: "made-up-tester", password: "fake-pw-17", testAccount: true });
    // Control: unrevoked, the held run passes its second contact.
    let gate = hold();
    let id = (await runtime.dryRun(a, script(), "tour-a")).job.id;
    await gate.at; gate.release();
    assert.equal((await settled(runtime, a.sessionId, id)).phase, "checking");
    // Revoked between two contacts: the second one blocks.
    gate = hold();
    id = (await runtime.dryRun(a, script(), "tour-a")).job.id;
    await gate.at;
    runtime.revokeSite(a, "tour-a", origin);
    gate.release();
    const job = await settled(runtime, a.sessionId, id);
    assert.equal(job.phase, "needs-site-approval");
    assert.deepEqual(job.requirements?.origins, [origin]);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a deleted chat can neither list nor revoke nor remove", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-sites-deleted-"));
  const { runtime, caller } = setup(root);
  const a = caller("chat-a");
  try {
    runtime.approvals.approve(origin);
    runtime.accounts.save({ origin, username: "made-up-tester", password: "fake-pw-17", testAccount: true });
    assert.equal((await settled(runtime, a.sessionId, (await runtime.dryRun(a, script(), "tour-a")).job.id)).phase, "checking");
    await runtime.removeSession(a.sessionId);
    const before = files(root);
    assert.throws(() => runtime.sites(a.sessionId, "tour-a"));
    assert.throws(() => runtime.revokeSite(a, "tour-a", origin));
    assert.throws(() => runtime.removeAccount(a, "tour-a", origin));
    assert.deepEqual(files(root), before, "installation-wide state is untouched");
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
