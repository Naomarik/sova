// Tests: a voice host through its routes with the stand-in engines, for service-devices.test.ts (the
// speech server in-process, fake-whisper-test-fixtures.ts) and service-devices.integration.test.ts
// (scripts/fake-whisper-server.mjs as a real child, and the same script in transcribe mode for
// Parakeet's host). Every model file is placed, and Silero unless told otherwise.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { VoiceDecodeSettings, VoiceStatus } from "../../shared/protocol";
import { SENTENCES } from "./calibration";
import { modelFileOf, voicePaths, type VoicePaths } from "./install";
import { catalogModel, DEFAULT_MODEL, PROMPT_SENTENCE, VAD_MODEL } from "./pins";
import type { Probe } from "./platform";
import { registerVoiceRoutes, VoiceService, type VoiceServiceOptions } from "./service";
import { DEFAULT_DECODE, updateSettings } from "./settings";

export const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));
export const A = "3f1c2d4e-0000-4000-8000-00000000000a";
export const B = "9b8a7c6d-0000-4000-8000-00000000000b";
export const PARAKEET = "parakeet-tdt-0.6b-v2-q8_0";
export const Q8 = "ggml-large-v3-turbo-q8_0";

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
export function clip(n: number): Uint8Array<ArrayBuffer> {
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
export const restoreEnv = () => {
  for (const k of KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
};

const services: VoiceService[] = [];
/** For afterEach: ends every host's sweep, model job and speech server, and restores the environment. */
export async function closeHosts(): Promise<void> {
  for (const s of services.splice(0)) {
    const sweep = s.calibrator.running();
    if (sweep) s.calibrator.stop(sweep.device);
    await s.calibrator.whenDone();
    await s.models.whenDone();
    await s.runtime.stop();
  }
  restoreEnv();
}

/**
 * A host with the whisper stand-in as a GPU install, every model file placed, and Silero. `runtime`
 * puts the speech server in-process (fakeWhisper().deps); without it each server is a real child.
 */
export function host(o: { env?: Record<string, string>; dir?: string; vad?: boolean; runtime?: VoiceServiceOptions["runtime"] } = {}) {
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
  const service = new VoiceService({ paths: () => paths, probe, runtime: o.runtime });
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

export const status = async (a: Hono, device?: string): Promise<VoiceStatus> => (await (await a.request(`/api/voice${device ? `?device=${device}` : ""}`)).json()) as VoiceStatus;
export const dictate = async (a: Hono, device?: string) => {
  const res = await a.request(`/api/voice/transcribe${device ? `?device=${device}` : ""}`, { method: "POST", body: clip(10), headers: { "Content-Type": "audio/wav" } });
  return { status: res.status, body: (await res.json()) as { text?: string; ms?: number; error?: string } };
};
export const saved = (paths: VoicePaths, device: string, model: string, settings: Partial<VoiceDecodeSettings>) =>
  updateSettings(paths.settingsFile, (s) => {
    s.devices[device] ??= { label: device === A ? "Linux · Chrome" : "iPhone · Safari", app: device === B, lastSeenAt: Date.now(), perModel: {} };
    s.devices[device]!.perModel[model] = { settings: { ...DEFAULT_DECODE, ...settings }, source: "chosen", updatedAt: 1 };
  });
/** Polls until fn has a value; the limit is only a hang guard. */
export async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
export async function record(a: Hono, device: string, ns: number[]) {
  for (const n of ns) {
    const res = await a.request(`/api/voice/calibration/clips/${n}?device=${device}&label=${encodeURIComponent("Linux · Chrome")}`, { method: "PUT", body: clip(n), headers: { "Content-Type": "audio/wav" } });
    assert.equal(res.status, 200, await res.text());
  }
}
/**
 * One setting hears sentence 1 exactly (the sentence prompt, greedy, no VAD, fallback on); every
 * other setting hears nothing. So that row is the unique best on clips 1–4, whatever the timings.
 */
export const ONE_WINNER = {
  FAKE_WHISPER_TEXT: "",
  FAKE_WHISPER_TEXT_BY: JSON.stringify({ "vad=true": "", "beam_size=5": "", "temperature_inc=0": "", [`prompt=${PROMPT_SENTENCE}`]: SENTENCES[0]!.text }),
};
export const WINNER = "p=sentence b=1 t=0.2 v=0";
export const run = (a: Hono, device: string) => a.request("/api/voice/calibration/run", { method: "POST", body: JSON.stringify({ device: { id: device, label: "Linux · Chrome", app: false } }), headers: { "Content-Type": "application/json" } });
export const stop = async (a: Hono, device: string) => a.request("/api/voice/calibration/stop", { method: "POST", body: JSON.stringify({ device: { id: device } }), headers: { "Content-Type": "application/json" } });
