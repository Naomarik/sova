// Voice copy and figures (§design.copy-deck/composer, §design.copy-deck/settings-voice), pure.

import type { VoiceBackend, VoiceCatalogModel, VoiceDecodeSettings, VoiceEngine, VoiceStatus, VoiceStep, VoiceStepId, VoiceStepState } from "../../../shared/protocol";

/** Seconds as m:ss. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const BACKEND_LABEL: Record<VoiceBackend, string> = { vulkan: "Vulkan", metal: "Metal", cuda: "CUDA", cpu: "CPU" };

export const STEP_LABEL: Record<VoiceStepId, string> = {
  detect: "Detect this host",
  packages: "Check packages",
  source: "Get whisper.cpp",
  build: "Build whisper.cpp",
  model: "Get the model",
  selftest: "Self-test",
  finish: "Finish",
};

export const STEP_STATE_WORD: Record<VoiceStepState, string> = { pending: "Waiting", running: "Running", done: "Done", skipped: "Skipped", failed: "Failed" };

export const megabytes = (n: number): string => `${Math.round(n / 1e6).toLocaleString("en-US")} MB`;

/** A disk size: MB under a GB, else one decimal GB. */
export const diskSize = (n: number): string => (n < 1e9 ? megabytes(n) : `${(n / 1e9).toFixed(1)} GB`);

/** A step's figure while it runs: "212 of 574 MB", "43%". */
export function stepFigure(step: VoiceStep): string | null {
  const p = step.progress;
  if (!p) return null;
  if (p.unit === "percent") return `${Math.round(p.done)}%`;
  return p.total > 0 ? `${Math.round(p.done / 1e6)} of ${megabytes(p.total)}` : megabytes(p.done);
}

/** The whole job as one percent, for the mic's ring: finished steps plus the running one's share. */
export function jobPercent(steps: VoiceStep[]): number {
  if (!steps.length) return 0;
  let done = 0;
  for (const s of steps) {
    if (s.state === "done" || s.state === "skipped") done += 1;
    else if (s.state === "running" && s.progress && s.progress.total > 0) done += Math.min(1, s.progress.done / s.progress.total);
  }
  return Math.round((done / steps.length) * 100);
}

/** "Vulkan · AMD Radeon 8060S Graphics", or "CPU". */
export const backendWithDevice = (backend: VoiceBackend, device?: string): string =>
  backend !== "cpu" && device ? `${BACKEND_LABEL[backend]} · ${device}` : BACKEND_LABEL[backend];

/** Ready status line (§design.copy-deck/settings-voice). */
export function readyLine(s: VoiceStatus): string {
  const inst = s.installed;
  if (!inst) return "";
  const parts = ["Ready", backendWithDevice(inst.backend, inst.device)];
  if (inst.selftestMs > 0) parts.push(`self-test ${(inst.selftestMs / 1000).toFixed(1)} s`);
  const active = s.models?.find((m) => m.id === s.activeModel);
  // "whisper.cpp large-v3-turbo q5_0"; "transcribe.cpp Parakeet TDT 0.6B v2 · q8_0" (§design.copy-deck/settings-voice).
  if (!active) parts.push("whisper.cpp large-v3-turbo q5_0");
  else parts.push(`${ENGINE_LABEL[active.engine]} ${active.engine === "transcribe" ? modelName(active) : `${active.label} ${active.quant}`}`);
  if (s.diskBytes !== undefined) parts.push(`${diskSize(s.diskBytes)} on disk`);
  parts.push(s.runtime.running ? "Loaded" : s.runtime.starting ? "Loading" : "Not loaded");
  return parts.join(" · ");
}

/** Why this browser can't record, or null. */
export function unsupportedReason(env: { secure: boolean; getUserMedia: boolean; audioContext: boolean }): string | null {
  if (!env.secure) return "Voice needs HTTPS or localhost.";
  if (!env.getUserMedia || !env.audioContext) return "This browser can't record audio.";
  return null;
}

/** getUserMedia's failure as the strip's sentence. */
export function micErrorSentence(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The browser blocked the microphone. Allow it for this site, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "No microphone found.";
  return `Couldn't start the microphone. ${(err as Error)?.message || "Unknown error"}.`.replace(/\.\.$/, ".");
}

export const insertedSentence = (n: number): string => `Inserted ${n} ${n === 1 ? "word" : "words"}.`;

export const backgroundSentence = (sec: number): string => `Recording stopped when the app went to the background. Transcribed ${clock(sec)}.`;

/** The recording strip's words. `capSec` is the 5-minute cap. */
export function recordingText(sec: number, capSec: number): string {
  const left = Math.ceil(capSec - sec);
  return left <= 30 ? `Recording ${clock(sec)} · ${Math.max(0, left)} s left` : `Recording ${clock(sec)}`;
}

export const MAX_RECORD_SEC = 300;

// ---- models and calibration (§app.settings-dialog/voice-models, §app.settings-dialog/voice-calibration) ----

export const ENGINE_LABEL: Record<VoiceEngine, string> = { whisper: "whisper.cpp", transcribe: "transcribe.cpp" };

/** "large-v3-turbo · q5_0", "Parakeet TDT 0.6B v2 · q8_0". */
export const modelName = (m: Pick<VoiceCatalogModel, "label" | "quant">): string => `${m.label} · ${m.quant}`;

/** "English only" or "English and 99 more". */
export const languagesWord = (l: VoiceCatalogModel["languages"]): string => (l === "en" ? "English only" : "English and 99 more");

/** A 0–1 word error as "1.8%". */
export const percentWer = (wer: number): string => `${(Math.round(wer * 1000) / 10).toFixed(1)}%`;

/** Milliseconds per clip as "0.42 s". */
export const perClip = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

/** Time left, rounded the way a person says it: "About 40 s left.", "About 3 min left." */
export function etaSentence(sec: number): string {
  if (sec < 60) return `About ${Math.max(5, Math.round(sec / 5) * 5)} s left.`;
  return `About ${Math.round(sec / 60)} min left.`;
}

const PROMPT_WORD: Record<VoiceDecodeSettings["prompt"], string> = { none: "no prompt", list: "hotword list", sentence: "hotword sentence" };

/** A setting in words: "beam 5 · hotword sentence · voice detection on · no fallback". */
export function settingsWords(s: VoiceDecodeSettings): string {
  return [`beam ${s.beamSize}`, PROMPT_WORD[s.prompt], s.vad ? "voice detection on" : "voice detection off", s.temperatureInc > 0 ? "fallback" : "no fallback"].join(" · ");
}

/** "40 s", "2 min": a sweep estimate. */
export const roughTime = (sec: number): string => (sec < 60 ? `${Math.max(10, Math.round(sec / 10) * 10)} s` : `${Math.round(sec / 60)} min`);

const bare = (w: string) => w.replace(/[^\p{L}\p{N}']+/gu, "");
const norm = (w: string) => bare(w).toLowerCase();

/** The one jargon word scored case-sensitively (as the jargon count does): only "Sova" needs its capital. */
const CASED = "Sova";

export interface DiffWord {
  word: string;
  /** same: heard as read; missed: in the reference, not heard (−); extra: heard, not in the reference (+);
      case: "Sova" heard in the wrong case (~), a jargon miss that word error ignores. */
  op: "same" | "missed" | "extra" | "case";
}

/** The reference and what was heard, word by word (case and punctuation ignored for the match). */
export function wordDiff(reference: string, heard: string): DiffWord[] {
  const a = reference.split(/\s+/).filter((w) => norm(w));
  const b = heard.split(/\s+/).filter((w) => norm(w));
  const na = a.map(norm);
  const nb = b.map(norm);
  // Longest common subsequence, then walk it.
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = na[i] === nb[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffWord[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (na[i] === nb[j]) {
      out.push({ word: b[j]!, op: bare(a[i]!) === CASED && bare(b[j]!) !== CASED ? "case" : "same" });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ word: a[i++]!, op: "missed" });
    else out.push({ word: b[j++]!, op: "extra" });
  }
  while (i < a.length) out.push({ word: a[i++]!, op: "missed" });
  while (j < b.length) out.push({ word: b[j++]!, op: "extra" });
  return out;
}

