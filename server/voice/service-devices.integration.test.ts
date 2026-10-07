// Run: node scripts/run-tests.mjs server/voice/service-devices.integration.test.ts
// Voice through its routes with real stand-in children (scripts/fake-whisper-server.mjs, and the same
// script in transcribe mode for Parakeet's host): dictation during a sweep, timed; and the switch to
// Parakeet, whose self-test starts its own engine. The routes' rules in-process: service-devices.test.ts.

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { transcribeSupported } from "./install";
import { DEFAULT_MODEL } from "./pins";
import { A, B, closeHosts, dictate, host, PARAKEET, record, restoreEnv, run, saved, status, stop, waitFor } from "./voice-devices-test-fixtures";

after(restoreEnv);
afterEach(closeHosts);

describe("calibration through the routes", () => {
  it("dictation during a sweep answers within about a second, and the sweep says it paused", async () => {
    const { a } = host({ env: { FAKE_WHISPER_DELAY_MS: "120" } });
    await record(a, A, [1, 2, 3, 4]);
    assert.equal((await run(a, A)).status, 202);
    await waitFor(async () => ((await status(a, A)).calibration!.run!.progress.done >= 3 ? true : undefined));
    const t0 = performance.now();
    const pending = dictate(a, B);
    const paused = await waitFor(async () => ((await status(a, A)).calibration!.run!.progress.pausedForDictation ? true : undefined)).catch(() => false);
    const out = await pending;
    const ms = performance.now() - t0;
    assert.equal(out.status, 200);
    // About a second in the product; the bound is generous for a loaded machine. It still tells
    // one 120 ms clip of waiting from the whole sweep (48 clips).
    assert.ok(ms < 3000, `dictation took ${Math.round(ms)} ms during the sweep`);
    assert.equal(paused, true);
    assert.equal((await status(a, A)).calibration!.run!.phase, "running", "the sweep goes on after");
    await stop(a, A);
    const stopped = await waitFor(async () => {
      const s = await status(a, A);
      return s.calibration!.run!.phase !== "running" ? s.calibration!.run! : undefined;
    });
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.applied, undefined);
  });
});

describe("models through the routes", () => {
  // The model list shows Parakeet only where transcribe.cpp builds (Linux x86_64).
  it("switch to Parakeet (self-tested on its host), dictate with no fields, then back to whisper with the device's settings", { skip: !transcribeSupported() && "Parakeet is listed on Linux x86_64 only" }, async () => {
    const { a, service, paths, requests } = host();
    saved(paths, A, DEFAULT_MODEL.id, { beamSize: 5 });
    let res = await a.request(`/api/voice/models/${PARAKEET}/use`, { method: "POST" });
    assert.equal(res.status, 202, await res.text());
    await service.models.whenDone();
    assert.equal(service.models.job!.outcome, "ok", service.models.job!.error);
    let s = await status(a, A);
    assert.equal(s.activeModel, PARAKEET);
    assert.equal(s.models.find((m) => m.id === PARAKEET)!.selftestText, "Open sofa and run the type check in the worktree.");
    // A's whisper settings don't apply to Parakeet: nothing is tunable, so its dictation carries no fields.
    const n = requests().length;
    const out = await dictate(a, A);
    assert.equal(out.status, 200);
    assert.equal(out.body.text, "Open sofa and run the type check in the worktree.");
    const q = requests()[n]!;
    assert.deepEqual([q.contentType, q.fields], ["audio/wav", {}]);
    res = await a.request(`/api/voice/models/${DEFAULT_MODEL.id}/use`, { method: "POST" });
    assert.equal(res.status, 202);
    await service.models.whenDone();
    assert.equal(service.models.job!.outcome, "ok", service.models.job!.error);
    s = await status(a, A);
    assert.equal(s.activeModel, DEFAULT_MODEL.id);
    const m = requests().length;
    await dictate(a, A);
    assert.equal(requests()[m]!.fields.beam_size, "5", "back on whisper, A's saved settings apply again");
  });

  it("delete is refused for Parakeet while it's active", async () => {
    const { a, service } = host();
    await a.request(`/api/voice/models/${PARAKEET}/use`, { method: "POST" });
    await service.models.whenDone();
    const res = await a.request(`/api/voice/models/${PARAKEET}`, { method: "DELETE" });
    assert.equal(res.status, 409);
  });
});
