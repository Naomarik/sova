// Voice through its routes with the stand-in engines (scripts/fake-whisper-server.mjs, and the same
// script in transcribe mode for Parakeet's host): per-device fields, a calibration run, dictation
// during a sweep, model switches and a server restart.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, describe, it } from "node:test";
import { Hono } from "hono";
import type { VoiceDecodeSettings, VoiceStatus } from "../../shared/protocol";
import { SENTENCES } from "./calibration";
import { modelFileOf, transcribeSupported, voicePaths, type VoicePaths } from "./install";
import { catalogModel, DEFAULT_MODEL, PROMPT_SENTENCE, VAD_MODEL } from "./pins";
import type { Probe } from "./platform";
import { registerVoiceRoutes, VoiceService } from "./service";
import { DEFAULT_DECODE, updateSettings } from "./settings";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));
const A = "3f1c2d4e-0000-4000-8000-00000000000a";
const B = "9b8a7c6d-0000-4000-8000-00000000000b";
const PARAKEET = "parakeet-tdt-0.6b-v2-q8_0";
const Q8 = "ggml-large-v3-turbo-q8_0";

const probe = (): Probe => ({
  platform: "linux",
  arch: "x64",
  exists: () => false,
  readFile: () => "ID=arch\n",
  list: () => [],
  which: (c) => (c === "cc" ? "/usr/bin/cc" : null),
  glibc: () => "2.41",
  run: () => null,
  cores: () => 4,
});

/** A 16 kHz mono clip of n × 0.1 s. */
function clip(n: number): Uint8Array<ArrayBuffer> {
  const samples = (n + 1) * 1600;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples * 2, 40);
  // Tone, then 0.1 s of near silence: a calibration clip must pass the clip check.
  for (let i = 0; i < samples; i++) b.writeInt16LE(i < samples - 1600 ? Math.round(3000 * Math.sin(i / 3)) : i % 2 ? 1 : -1, 44 + 2 * i);
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const place = (paths: VoicePaths, m: { file: string; bytes: number }) => {
  mkdirSync(paths.models, { recursive: true });
  writeFileSync(modelFileOf(paths, m), "");
  truncateSync(modelFileOf(paths, m), m.bytes);
};

const KEYS = ["SOVA_VOICE_WHISPER_BIN", "SOVA_VOICE_WHISPER_GPU", "SOVA_VOICE_TRANSCRIBE_BIN", "FAKE_WHISPER_LOG", "FAKE_WHISPER_TEXT", "FAKE_WHISPER_TEXT_BY", "FAKE_WHISPER_DELAY_MS", "FAKE_TRANSCRIBE_TEXT"];
const envBefore = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => {
  for (const k of KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
};
after(restoreEnv);

const services: VoiceService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    const sweep = s.calibrator.running();
    if (sweep) s.calibrator.stop(sweep.device);
    await s.calibrator.whenDone();
    await s.models.whenDone();
    await s.runtime.stop();
  }
  restoreEnv();
});

/** A host with the whisper stand-in as a GPU install, every model file placed, and Silero. */
function host(o: { env?: Record<string, string>; dir?: string; vad?: boolean } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "voice-dev-"));
  const paths = voicePaths(join(dir, "voice"));
  const log = join(dir, "requests.jsonl");
  // Parakeet's host stand-in: the same script in transcribe mode.
  const transcribeBin = join(dir, "fake-transcribe-host");
  writeFileSync(transcribeBin, `#!/bin/sh\nFAKE_WHISPER_ENGINE=transcribe exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(transcribeBin, 0o755);
  Object.assign(process.env, { SOVA_VOICE_WHISPER_BIN: FAKE, SOVA_VOICE_WHISPER_GPU: "1", SOVA_VOICE_TRANSCRIBE_BIN: transcribeBin, FAKE_WHISPER_LOG: log }, o.env ?? {});
  if (!o.dir) {
    for (const id of [DEFAULT_MODEL.id, Q8, PARAKEET]) place(paths, catalogModel(id)!);
    if (o.vad !== false) place(paths, VAD_MODEL);
  }
  const service = new VoiceService({ paths: () => paths, probe });
  services.push(service);
  const a = new Hono();
  registerVoiceRoutes(a, () => service);
  const requests = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { fields: Record<string, string>; argv: string[]; contentType: string; bytes: number })
      : [];
  return { a, service, paths, dir, requests };
}

const status = async (a: Hono, device?: string): Promise<VoiceStatus> => (await (await a.request(`/api/voice${device ? `?device=${device}` : ""}`)).json()) as VoiceStatus;
const dictate = async (a: Hono, device?: string) => {
  const res = await a.request(`/api/voice/transcribe${device ? `?device=${device}` : ""}`, { method: "POST", body: clip(10), headers: { "Content-Type": "audio/wav" } });
  return { status: res.status, body: (await res.json()) as { text?: string; ms?: number; error?: string } };
};
const saved = (paths: VoicePaths, device: string, model: string, settings: Partial<VoiceDecodeSettings>) =>
  updateSettings(paths.settingsFile, (s) => {
    s.devices[device] ??= { label: device === A ? "Linux · Chrome" : "iPhone · Safari", app: device === B, lastSeenAt: Date.now(), perModel: {} };
    s.devices[device]!.perModel[model] = { settings: { ...DEFAULT_DECODE, ...settings }, source: "chosen", updatedAt: 1 };
  });
async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function record(a: Hono, device: string, ns: number[]) {
  for (const n of ns) {
    const res = await a.request(`/api/voice/calibration/clips/${n}?device=${device}&label=${encodeURIComponent("Linux · Chrome")}`, { method: "PUT", body: clip(n), headers: { "Content-Type": "audio/wav" } });
    assert.equal(res.status, 200, await res.text());
  }
}
/**
 * One setting hears sentence 1 exactly (the sentence prompt, greedy, no VAD, fallback on); every
 * other setting hears nothing. So that row is the unique best on clips 1–4, whatever the timings.
 */
const ONE_WINNER = {
  FAKE_WHISPER_TEXT: "",
  FAKE_WHISPER_TEXT_BY: JSON.stringify({ "vad=true": "", "beam_size=5": "", "temperature_inc=0": "", [`prompt=${PROMPT_SENTENCE}`]: SENTENCES[0]!.text }),
};
const WINNER = "p=sentence b=1 t=0.2 v=0";
const run = (a: Hono, device: string) => a.request("/api/voice/calibration/run", { method: "POST", body: JSON.stringify({ device: { id: device, label: "Linux · Chrome", app: false } }), headers: { "Content-Type": "application/json" } });

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

  it("dictation during a sweep answers within about a second, and the sweep says it paused", async () => {
    const { a } = host({ env: { FAKE_WHISPER_DELAY_MS: "120" } });
    await record(a, A, [1, 2, 3, 4]);
    assert.equal((await run(a, A)).status, 202);
    await waitFor(async () => ((await status(a, A)).calibration!.run!.progress.done >= 3 ? true : undefined));
    const t0 = performance.now();
    const pending = dictate(a, B);
    const paused = await waitFor(async () => ((await status(a, A)).calibration!.run!.progress.pausedForDictation ? true : undefined), 2000).catch(() => false);
    const out = await pending;
    const ms = performance.now() - t0;
    assert.equal(out.status, 200);
    assert.ok(ms < 1000, `dictation took ${Math.round(ms)} ms during the sweep`);
    assert.equal(paused, true);
    assert.equal((await status(a, A)).calibration!.run!.phase, "running", "the sweep goes on after");
    await a.request("/api/voice/calibration/stop", { method: "POST", body: JSON.stringify({ device: { id: A } }), headers: { "Content-Type": "application/json" } });
    const stopped = await waitFor(async () => {
      const s = await status(a, A);
      return s.calibration!.run!.phase !== "running" ? s.calibration!.run! : undefined;
    });
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
