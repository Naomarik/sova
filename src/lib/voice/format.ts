// Voice copy and figures (§design.copy-deck/composer, §design.copy-deck/settings-voice), pure.

import type { VoiceBackend, VoiceStatus, VoiceStep, VoiceStepId, VoiceStepState } from "../../../shared/protocol";

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
  parts.push("large-v3-turbo q5_0");
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
