import assert from "node:assert/strict";
import { test } from "node:test";
import { createTourProgressSaver } from "./tour-progress-save";
import type { TourPosition } from "./tour-state";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const position = (stepId: string): TourPosition => ({ stepId, viewId: "overview", size: "phone" });
const tick = () => new Promise<void>(r => setTimeout(r, 0));

test("rapid navigation during a slow write sends only the newest place next, and ends there", async () => {
  const replies = [deferred(), deferred(), deferred()], starts = [deferred(), deferred(), deferred()];
  const sent: string[] = []; let persisted = "", inFlight = 0, overlapped = false;
  const saver = createTourProgressSaver(async p => { const n = sent.length; sent.push(p.stepId); if (++inFlight > 1) overlapped = true; starts[n]!.resolve(); await replies[n]!.promise; inFlight--; persisted = p.stepId; return p.stepId; });
  const first = saver.save(position("first"));
  await starts[0]!.promise; assert.deepEqual(sent, ["first"]);
  const mutable = position("middle"), middle = saver.save(mutable), last = saver.save(position("last"));
  mutable.stepId = "mutated-after-navigation";
  let copied = false; const copy = saver.settled().then(() => { copied = true; });
  await tick(); assert.deepEqual(sent, ["first"], "nothing else is sent while the first write is in flight");
  replies[0]!.resolve(); assert.equal(await first, "first");
  await starts[1]!.promise; assert.deepEqual(sent, ["first", "last"], "the superseded middle place is never sent");
  await tick(); assert.equal(copied, false, "resume copy waits for the newest write, not only the first");
  replies[1]!.resolve();
  assert.equal(await middle, "last", "a superseded save settles with the write that replaced it"); assert.equal(await last, "last");
  await copy; assert.equal(copied, true); assert.equal(persisted, "last"); assert.equal(overlapped, false);
  assert.equal(sent.includes("mutated-after-navigation"), false, "a later change to the caller's object is not sent");
});

test("a rejected earlier write does not block later navigation; the newest failure is observable before copying resume", async () => {
  const sent: string[] = [];
  const saver = createTourProgressSaver(async p => { sent.push(p.stepId); if (p.stepId !== "saved") throw new Error("save blocked"); return p; });
  await assert.rejects(saver.save(position("failed")), /save blocked/);
  await saver.save(position("saved")); await saver.settled(); assert.deepEqual(sent, ["failed", "saved"]);
  await assert.rejects(saver.save(position("latest-failed")), /save blocked/); await assert.rejects(saver.settled(), /save blocked/);
  await saver.save(position("saved")); await saver.settled();
});
