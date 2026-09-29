// `<voice dir>/settings.json` (§chat.voice/decoding, §app.settings-dialog/voice-models): the one
// model this host dictates with, what each downloaded model's self-test last said, and each
// client device's decoding settings per model. Written whole, tmp + rename, re-read before every
// write. A missing or unreadable file is the defaults: the default model, and every device
// dictating as an uncalibrated one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VoiceCalibrationSummary, VoiceDecodeSettings } from "../../shared/protocol";
import { catalogModel, DEFAULT_MODEL, HOTWORDS, PROMPT_SENTENCE } from "./pins";

/** What an uncalibrated device sends: greedy, temperature 0 with whisper's 0.2 fallback, the
    hotword list, no voice detection — the requests voice made before calibration existed. */
export const DEFAULT_DECODE: Readonly<VoiceDecodeSettings> = Object.freeze({
  beamSize: 1,
  temperatureInc: 0.2,
  prompt: "list",
  vad: false,
  vadThreshold: 0.5,
  vadSpeechPadMs: 30,
});

export interface ModelRecord {
  selftestMs?: number;
  selftestText?: string;
  selftestAt?: number;
  importedFrom?: string;
}

export interface DeviceModelRecord {
  settings: VoiceDecodeSettings;
  /** A completed sweep's best row, or a results row the user chose. */
  source: "calibrated" | "chosen";
  /** The record before the last apply (null: none, so the defaults), for Revert to Previous. */
  previous?: Omit<DeviceModelRecord, "previous"> | null;
  calibration?: VoiceCalibrationSummary;
  updatedAt: number;
}

export interface DeviceRecord {
  label: string;
  app: boolean;
  lastSeenAt: number;
  perModel: Record<string, DeviceModelRecord>;
}

export interface VoiceSettingsFile {
  version: 1;
  activeModel?: string;
  models: Record<string, ModelRecord>;
  devices: Record<string, DeviceRecord>;
}

const empty = (): VoiceSettingsFile => ({ version: 1, models: {}, devices: {} });

/** A device id the client made (crypto.randomUUID): also a folder name, so nothing else passes. */
export const validDeviceId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);

const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);

/** Settings from disk or a request, every field checked and defaulted. */
export function normalizeDecode(raw: unknown): VoiceDecodeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof VoiceDecodeSettings, unknown>>;
  return {
    beamSize: Math.round(num(r.beamSize, 1, 16, DEFAULT_DECODE.beamSize)),
    temperatureInc: num(r.temperatureInc, 0, 1, DEFAULT_DECODE.temperatureInc),
    prompt: r.prompt === "none" || r.prompt === "sentence" || r.prompt === "list" ? r.prompt : DEFAULT_DECODE.prompt,
    vad: r.vad === true,
    vadThreshold: num(r.vadThreshold, 0.05, 0.95, DEFAULT_DECODE.vadThreshold),
    vadSpeechPadMs: Math.round(num(r.vadSpeechPadMs, 0, 1000, DEFAULT_DECODE.vadSpeechPadMs)),
  };
}

export function readSettings(file: string): VoiceSettingsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return empty();
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<VoiceSettingsFile>;
  if (r.version !== 1) return empty();
  const out = empty();
  if (typeof r.activeModel === "string" && catalogModel(r.activeModel)) out.activeModel = r.activeModel;
  for (const [id, m] of Object.entries(r.models ?? {})) if (catalogModel(id) && m && typeof m === "object") out.models[id] = m;
  for (const [id, d] of Object.entries(r.devices ?? {})) {
    if (!validDeviceId(id) || !d || typeof d !== "object") continue;
    const perModel: Record<string, DeviceModelRecord> = {};
    for (const [mid, e] of Object.entries(d.perModel ?? {})) {
      if (!e || typeof e !== "object") continue;
      const rec: DeviceModelRecord = modelRecord(e);
      if (e.previous === null) rec.previous = null;
      else if (e.previous && typeof e.previous === "object") rec.previous = modelRecord(e.previous);
      perModel[mid] = rec;
    }
    out.devices[id] = {
      label: typeof d.label === "string" ? d.label.slice(0, 80) : "",
      app: d.app === true,
      lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : 0,
      perModel,
    };
  }
  return out;
}

function modelRecord(e: Partial<DeviceModelRecord>): DeviceModelRecord {
  const rec: DeviceModelRecord = { settings: normalizeDecode(e.settings), source: e.source === "chosen" ? "chosen" : "calibrated", updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0 };
  if (e.calibration && typeof e.calibration === "object") rec.calibration = e.calibration;
  return rec;
}

export function writeSettings(file: string, s: VoiceSettingsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Read, change, write: the change sees the file as it is now, not as some earlier read had it. */
export function updateSettings<T>(file: string, fn: (s: VoiceSettingsFile) => T): T {
  const s = readSettings(file);
  const out = fn(s);
  writeSettings(file, s);
  return out;
}

export const hasSettingsFile = (file: string) => existsSync(file);

/** The model the host dictates with: settings.json's, or the default. */
export function activeModelId(file: string): string {
  return readSettings(file).activeModel ?? DEFAULT_MODEL.id;
}

/** A device's settings for a model, or the defaults (unknown device, or not calibrated on it). */
export function decodeFor(s: VoiceSettingsFile, device: string | null | undefined, model: string): { settings: VoiceDecodeSettings; record?: DeviceModelRecord } {
  const rec = device ? s.devices[device]?.perModel[model] : undefined;
  return rec ? { settings: rec.settings, record: rec } : { settings: { ...DEFAULT_DECODE } };
}

/**
 * whisper-server's /inference fields for these settings. Only fields that differ from the
 * server's own defaults are sent, so the defaults make exactly the request voice made before
 * calibration. `vad` is dropped when the host has no Silero model: the server would answer 500.
 */
export function decodeFields(s: VoiceDecodeSettings, o: { hint?: string | null; vadModel?: boolean } = {}): Record<string, string> {
  const f: Record<string, string> = {};
  if (s.prompt === "list") f.prompt = `${[...HOTWORDS, ...(o.hint ? [o.hint] : [])].join(", ")}.`;
  else if (s.prompt === "sentence") f.prompt = o.hint ? `${PROMPT_SENTENCE} The folder is ${o.hint}.` : PROMPT_SENTENCE;
  if (s.beamSize > 1) f.beam_size = String(s.beamSize);
  if (s.temperatureInc !== 0.2) f.temperature_inc = String(s.temperatureInc);
  if (s.vad && o.vadModel) {
    f.vad = "true";
    f.vad_threshold = String(s.vadThreshold);
    f.vad_speech_pad_ms = String(s.vadSpeechPadMs);
  }
  return f;
}

/** A stable short id for settings ("p=list b=1 t=0.2 v=0"), one per calibration row. */
export function decodeKey(s: VoiceDecodeSettings): string {
  const v = s.vad ? `v=${s.vadThreshold}/${s.vadSpeechPadMs}` : "v=0";
  return `p=${s.prompt} b=${s.beamSize} t=${s.temperatureInc} ${v}`;
}

export const sameDecode = (a: VoiceDecodeSettings, b: VoiceDecodeSettings) => decodeKey(a) === decodeKey(b);
