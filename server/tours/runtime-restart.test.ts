import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TourJob, TourVerification } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { tourScriptDigest } from "./checks";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import type { TourToolCaller } from "./tools";

// F6: a server restart while a finished capture awaits its explicit check. The capture holds no
// browser, so the new runtime keeps it awaiting that check and publishes only through the same
// receipts and verification; nothing is captured again. Work that was still running is interrupted.
const origin = "https://example.test";
const state = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);
const verification: TourVerification = { overviewReviewed: true, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed every overview cell and the suspicious phone picture." };

function host(root: string) {
  const caller: TourToolCaller = { sessionId: "chat-restart", sessionFile: join(root, "chat.jsonl"), cwd: "/forged", state };
  const launches: boolean[] = [];
  let hold: Promise<void> | undefined;
  const run: NonNullable<TourRuntimeOptions["run"]> = async input => {
    launches.push(input.dryRun);
    await input.beforeContact(origin);
    if (hold && !input.dryRun) await hold;
    const manifest = tourManifestFixture();
    return { steps: input.dryRun ? [] : manifest.steps, assets: input.dryRun ? new Map<string, Uint8Array>() : tourEditionAssetsFixture(), contactSheets: input.dryRun ? [] : manifest.check.contactSheets, suspicious: input.dryRun ? [] : ["phone.png"], provenance: { origin, recordedAt: manifest.recordedAt, publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script), sovaServer: false };
  };
  const make = () => new TourRuntime({ root, run,
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state, held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin, assertCurrent: async () => {} }),
  });
  return { caller, launches, make, holdCapture: (p: Promise<void>) => { hold = p; } };
}
async function settled(runtime: TourRuntime, sessionId: string, id: string, phases = ["checking", "ready", "failed", "cancelled", "interrupted"]): Promise<TourJob> {
  for (let i = 0; i < 500; i++) {
    const job = runtime.queue.get(sessionId, id)!;
    if (phases.includes(job.phase)) return job;
    await new Promise(ok => setTimeout(ok, 2));
  }
  throw new Error("The in-process queue did not settle.");
}

test("a finished capture awaiting its check survives a restart and publishes only through the same receipts, with nothing captured again", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-restart-"));
  const h = host(root);
  try {
    const before = h.make();
    let jobId: string;
    try {
      before.approvals.approve(origin);
      const dry = await before.dryRun(h.caller, tourScriptFixture(), "restart-tour");
      assert.equal((await settled(before, h.caller.sessionId, dry.job.id)).phase, "checking");
      jobId = (await before.record(h.caller, dry.job.id)).job.id;
      assert.equal((await settled(before, h.caller.sessionId, jobId)).phase, "checking");
      await before.inspect(h.caller, jobId);
    } finally { before.close(); }
    const launched = h.launches.length;
    const after = h.make();
    try {
      assert.equal(after.queue.get(h.caller.sessionId, jobId)!.phase, "checking", "still awaiting its explicit check");
      // The receipts are the private attempt's own: the missing one is still required after the restart.
      await assert.rejects(after.check(h.caller, jobId, verification), /suspicious|inspect|receipt/i);
      await after.inspect(h.caller, jobId, "phone.png");
      const ready = await after.check(h.caller, jobId, verification);
      assert.equal(ready.job.phase, "ready");
      assert.ok(after.store.latestEdition(h.caller.sessionId, "restart-tour"), "published after the restart");
      assert.equal(h.launches.length, launched, "nothing was captured again");
    } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a capture still running at the restart is interrupted, never replayed and never publishable", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-restart-"));
  const h = host(root);
  let release!: () => void;
  h.holdCapture(new Promise<void>(done => { release = done; }));
  try {
    const before = h.make();
    let jobId: string;
    try {
      before.approvals.approve(origin);
      const dry = await before.dryRun(h.caller, tourScriptFixture(), "running-tour");
      await settled(before, h.caller.sessionId, dry.job.id);
      jobId = (await before.record(h.caller, dry.job.id)).job.id;
      await settled(before, h.caller.sessionId, jobId, ["recording"]);
    } finally { before.close(); }
    const after = h.make();
    try {
      const launched = h.launches.length;
      assert.equal(after.queue.get(h.caller.sessionId, jobId)!.phase, "interrupted");
      await assert.rejects(after.check(h.caller, jobId, verification), /no complete captured edition/);
      assert.equal(after.store.latestEdition(h.caller.sessionId, "running-tour"), null);
      release();
      await new Promise(ok => setTimeout(ok, 20));
      assert.equal(h.launches.length, launched, "nothing replayed");
      assert.equal(after.queue.get(h.caller.sessionId, jobId)!.phase, "interrupted", "a late answer from the old runtime changes nothing");
    } finally { after.close(); }
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});
