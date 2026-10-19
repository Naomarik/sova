import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TourJob, TourVerification } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { tourScriptDigest } from "./checks";
import { TOUR_SOVA_REFUSAL } from "./runner-header";
import { TourRuntime, type TourRuntimeOptions } from "./runtime";
import type { TourToolCaller } from "./tools";

// Publication of a recording that saw a Sova answer: only when the attempt's own record names a
// verified managed Sova copy AND that copy resolves as one again at checking. The flag lives in the
// private attempt, so a restart (a new runtime on the same root) cannot drop it.
const origin = "https://example.test";
const state = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);

function setup(root: string, seen: { sovaServer: boolean; sovaCopy?: true }, copyNow: () => boolean) {
  const caller: TourToolCaller = { sessionId: "chat-sova", sessionFile: join(root, "chat.jsonl"), cwd: "/forged", state };
  const run: NonNullable<TourRuntimeOptions["run"]> = async input => {
    await input.beforeContact(origin);
    const manifest = tourManifestFixture();
    return { steps: input.dryRun ? [] : manifest.steps, assets: input.dryRun ? new Map<string, Uint8Array>() : tourEditionAssetsFixture(), contactSheets: input.dryRun ? [] : manifest.check.contactSheets, suspicious: input.dryRun ? [] : ["phone.png"], provenance: { origin, recordedAt: manifest.recordedAt, publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script), sovaServer: seen.sovaServer, ...(seen.sovaCopy ? { sovaCopy: true as const } : {}) };
  };
  const make = () => new TourRuntime({ root, run,
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: join(root, "agent"), state, held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin, assertCurrent: async () => {}, ...(copyNow() ? { sova: { agentDir: join(root, "copy", ".agent") } } : {}) }),
  });
  return { caller, make };
}
async function settled(runtime: TourRuntime, sessionId: string, id: string): Promise<TourJob> {
  for (let i = 0; i < 500; i++) {
    const job = runtime.queue.get(sessionId, id)!;
    if (["checking", "ready", "failed", "cancelled", "needs-site-approval", "needs-test-account"].includes(job.phase)) return job;
    await new Promise(ok => setTimeout(ok, 2));
  }
  throw new Error("The in-process queue did not settle.");
}
/** Record to checking with every receipt, then return the job id. */
async function recorded(runtime: TourRuntime, caller: TourToolCaller): Promise<string> {
  runtime.approvals.approve(origin);
  const dry = await runtime.dryRun(caller, tourScriptFixture(), "sova-tour");
  assert.equal((await settled(runtime, caller.sessionId, dry.job.id)).phase, "checking");
  const capture = await runtime.record(caller, dry.job.id);
  assert.equal((await settled(runtime, caller.sessionId, capture.job.id)).phase, "checking");
  await runtime.inspect(caller, capture.job.id);
  await runtime.inspect(caller, capture.job.id, "phone.png");
  return capture.job.id;
}
const verification: TourVerification = { overviewReviewed: true, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed every overview cell and the suspicious phone picture." };

test("a recording that saw a Sova answer is never published without a verified managed copy, even after a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-sova-publish-"));
  try {
    const { caller, make } = setup(root, { sovaServer: true }, () => false);
    const runtime = make();
    let jobId: string;
    try {
      jobId = await recorded(runtime, caller);
      await assert.rejects(runtime.check(caller, jobId, verification), new RegExp(TOUR_SOVA_REFUSAL.replace(/[.;]/g, "\\$&")));
      assert.equal(runtime.artifacts.read(caller.sessionId, jobId)?.sovaServer, true, "the flag is in the private attempt");
    } finally { runtime.close(); }
    // A restart reads the same private record: still refused, nothing published.
    const again = make();
    try {
      await assert.rejects(again.check(caller, jobId, verification), /Tours of Sova use a test copy/);
      assert.equal(again.store.latestEdition(caller.sessionId, "sova-tour"), null);
    } finally { again.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication: no Sova answer publishes (control); a verified copy publishes only while it still resolves as one", async () => {
  for (const [name, seen, copyNow, publishes] of [
    ["no Sova answer", { sovaServer: false }, false, true],
    ["verified copy, still a copy at checking", { sovaServer: true, sovaCopy: true as const }, true, true],
    ["verified copy at recording, no longer one at checking", { sovaServer: true, sovaCopy: true as const }, false, false],
    ["copy now, but the attempt never recorded one", { sovaServer: true }, true, false],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "tour-sova-publish-"));
    // The source resolves as a verified copy at checking only when `copyNow`.
    const { caller, make } = setup(root, seen, () => copyNow);
    const runtime = make();
    try {
      const jobId = await recorded(runtime, caller);
      const result = await runtime.check(caller, jobId, verification).then(r => r.job.phase, (e: Error) => e.message);
      if (publishes) assert.equal(result, "ready", name);
      else assert.equal(result, TOUR_SOVA_REFUSAL, name);
    } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
