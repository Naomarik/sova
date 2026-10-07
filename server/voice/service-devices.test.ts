// Run: pnpm test -- server/voice/service-devices.test.ts
// Voice through its routes with the speech server in-process (fake-whisper-test-fixtures.ts): per-device
// fields, a calibration run, dictation during a sweep, model switches and a server restart. The same
// host with real stand-in children, Parakeet's self-tested switch and the dictation-during-a-sweep
// timing: service-devices.integration.test.ts.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { fakeWhisper } from "./fake-whisper-test-fixtures";
import { modelFileOf } from "./install";
import { catalogModel, DEFAULT_MODEL, PROMPT_SENTENCE } from "./pins";
import { DEFAULT_DECODE } from "./settings";
import { A, B, closeHosts, dictate, host as realHost, ONE_WINNER, Q8, record, restoreEnv, run, saved, status, stop, waitFor, WINNER } from "./voice-devices-test-fixtures";

after(restoreEnv);
afterEach(closeHosts);

const host = (o: Parameters<typeof realHost>[0] = {}) => realHost({ runtime: fakeWhisper().deps, ...o });

describe("dictation per device", () => {
  it("two devices on one host send their own fields; an unknown or missing id sends the defaults", async () => {
    const { a, paths, requests } = host();
    saved(paths, A, DEFAULT_MODEL.id, { prompt: "sentence", beamSize: 5 });
    saved(paths, B, DEFAULT_MODEL.id, { prompt: "none", vad: true, vadThreshold: 0.5, vadSpeechPadMs: 150, temperatureInc: 0 });
    for (const d of [A, B, "00000000-0000-4000-8000-000000000000", undefined]) assert.equal((await dictate(a, d)).status, 200);
    const [ra, rb, unknown, none] = requests().map((r) => r.fields);
    assert.deepEqual(ra, { temperature: "0", response_format: "json", prompt: PROMPT_SENTENCE, beam_size: "5" });
    assert.deepEqual(rb, { temperature: "0", response_format: "json", temperature_inc: "0", vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" });
    assert.deepEqual(unknown, none);
    assert.equal(none!.prompt!.startsWith("Sova, pi, "), true);
    assert.deepEqual(Object.keys(none!).sort(), ["prompt", "response_format", "temperature"]);
    assert.ok(requests()[0]!.argv.includes("-vm"), "Silero present: launched with -vm");
  });

  it("GET /api/voice?device= reports that device's settings and source; other devices are listed", async () => {
    const { a, paths } = host();
    saved(paths, A, DEFAULT_MODEL.id, { beamSize: 5 });
    const sa = await status(a, A);
    assert.equal(sa.device!.source, "chosen");
    assert.equal(sa.device!.settings.beamSize, 5);
    const sb = await status(a, B);
    assert.equal(sb.device!.known, false);
    assert.equal(sb.device!.source, "default");
    assert.deepEqual(sb.device!.settings, DEFAULT_DECODE);
    assert.deepEqual(sb.devices.map((d) => [d.id, d.calibrated]), [[A, [DEFAULT_MODEL.id]]]);
    assert.equal((await status(a)).device, undefined);
  });

  it("without Silero a VAD setting isn't sent (the server would answer 500)", async () => {
    const { a, paths, requests } = host({ vad: false });
    saved(paths, B, DEFAULT_MODEL.id, { vad: true });
    const out = await dictate(a, B);
    assert.equal(out.status, 200);
    assert.equal("vad" in requests()[0]!.fields, false);
    assert.equal(requests()[0]!.argv.includes("-vm"), false);
  });
});

describe("calibration through the routes", () => {
  it("records, sweeps 12 settings, applies the best to that device only, and its dictation sends it", async () => {
    const { a, requests } = host({ env: ONE_WINNER });
    await record(a, A, [1, 2, 3, 4]);
    const st = await status(a, A);
    assert.deepEqual(st.calibration!.clips.map((c) => c.n), [1, 2, 3, 4]);
    assert.deepEqual((await status(a, B)).calibration!.clips, [], "clips belong to the device that read them");
    const res = await run(a, A);
    assert.equal(res.status, 202);
    const done = await waitFor(async () => {
      const s = await status(a, A);
      return s.calibration!.run && s.calibration!.run.phase !== "running" ? s : undefined;
    });
    const r = done.calibration!.run!;
    assert.equal(r.phase, "done");
    assert.equal(r.grid, "full");
    assert.equal(r.rows.length, 12);
    assert.equal(r.rows.find((x) => x.current)!.key, "p=list b=1 t=0.2 v=0");
    assert.ok(r.rows.every((x) => x.scored === 4));
    assert.equal(r.best, WINNER);
    assert.equal(r.applied, WINNER);
    assert.equal(done.device!.source, "calibrated");
    assert.equal(done.device!.canRevert, true);
    assert.equal(done.device!.calibration!.key, WINNER);
    assert.equal((await status(a, B)).device!.source, "default");
    // Sweep requests went out with sweep settings (beam, VAD, no prompt).
    const sweepFields = requests().map((q) => q.fields);
    assert.ok(sweepFields.some((f) => f.beam_size === "5") && sweepFields.some((f) => f.vad === "true") && sweepFields.some((f) => !f.prompt));
    // A now dictates with the winner; B still with the defaults.
    const n = requests().length;
    await dictate(a, A);
    await dictate(a, B);
    const [sa, sb] = requests().slice(n).map((q) => q.fields);
    assert.deepEqual(sa, { temperature: "0", response_format: "json", prompt: PROMPT_SENTENCE });
    assert.ok(sb!.prompt!.startsWith("Sova, pi, "));
    // Revert to Previous: A is back on the defaults.
    const rev = await a.request("/api/voice/calibration/revert", { method: "POST", body: JSON.stringify({ device: { id: A } }), headers: { "Content-Type": "application/json" } });
    assert.equal(rev.status, 200);
    const back = await status(a, A);
    assert.equal(back.device!.source, "default");
    assert.equal(back.device!.canRevert, false);
  });

  it("dictation during a sweep goes ahead of the sweep's next clip, and the sweep says it paused", async () => {
    // Every inference is held until the test lets it answer: the order is the mechanism, no clock.
    const fake = fakeWhisper({ held: true });
    const { a, requests } = host({ runtime: fake.deps });
    await record(a, A, [1, 2, 3, 4]);
    assert.equal((await run(a, A)).status, 202);
    for (let i = 0; i < 3; i++) {
      await waitFor(() => (fake.held() === 1 ? true : undefined));
      fake.release();
    }
    await waitFor(() => (fake.held() === 1 ? true : undefined)); // the sweep's fourth clip, in flight
    const sweepSizes = new Set(requests().map((q) => q.bytes));
    const n = requests().length;
    const pending = dictate(a, B);
    const paused = await waitFor(async () => ((await status(a, A)).calibration!.run!.progress.pausedForDictation ? true : undefined));
    assert.equal(fake.held(), 1, "the dictation waits for the clip in flight, not beside it");
    fake.release();
    await waitFor(() => (fake.held() === 1 ? true : undefined));
    assert.equal(requests().length, n + 1);
    assert.equal(sweepSizes.has(requests()[n]!.bytes), false, "the next inference is the dictation clip, not the sweep's next one");
    assert.ok(requests()[n]!.fields.prompt!.startsWith("Sova, pi, "), "with B's own (default) fields");
    fake.release();
    const out = await pending;
    assert.equal(out.status, 200);
    assert.equal(paused, true);
    assert.equal((await status(a, A)).calibration!.run!.phase, "running", "the sweep goes on after");
    // Stop answers once the sweep has ended: anything still held is let through meanwhile.
    let answered: Response | undefined;
    const stopping = stop(a, A).then((r) => (answered = r));
    await waitFor(() => (fake.release(), answered));
    assert.equal((await stopping).status, 200);
    const stopped = (await status(a, A)).calibration!.run!;
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.applied, undefined);
  });
  it("a model switch is refused while a sweep runs; the host keeps its model", async () => {
    const { a } = host({ env: { FAKE_WHISPER_DELAY_MS: "50" } });
    await record(a, A, [1, 2, 3, 4]);
    await run(a, A);
    const res = await a.request(`/api/voice/models/${Q8}/use`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "Calibration is running. Stop it or wait for it to finish.");
    const s = await status(a, B);
    assert.equal(s.activeModel, DEFAULT_MODEL.id);
    assert.equal(s.sweep!.device, A);
  });

  it("a server restart keeps the run, the applied settings and the clips", async () => {
    const first = host({ env: ONE_WINNER });
    await record(first.a, A, [1, 2, 3, 4]);
    await run(first.a, A);
    await waitFor(async () => ((await status(first.a, A)).calibration!.run!.phase === "done" ? true : undefined));
    const before = await status(first.a, A);
    await first.service.runtime.stop();
    const second = host({ dir: first.dir });
    const after = await status(second.a, A);
    assert.equal(before.device!.calibration!.key, WINNER);
    assert.deepEqual(after.device!.settings, before.device!.settings);
    assert.deepEqual(after.device!.calibration, before.device!.calibration);
    assert.equal(after.device!.source, before.device!.source);
    assert.equal(after.calibration!.run!.id, before.calibration!.run!.id);
    assert.deepEqual(after.calibration!.clips.map((c) => c.n), [1, 2, 3, 4]);
  });
});

describe("models through the routes", () => {
  it("delete is refused for the active model, allowed for another", async () => {
    const { a, paths } = host();
    const res = await a.request(`/api/voice/models/${DEFAULT_MODEL.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "Switch to another model first.");
    assert.ok(existsSync(modelFileOf(paths, DEFAULT_MODEL)));
    const ok = await a.request(`/api/voice/models/${Q8}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { freed: catalogModel(Q8)!.bytes });
  });
});
