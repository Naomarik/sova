// Voice calibration (§app.settings-dialog/voice-calibration): a device reads fixed sentences whose
// text is known, its clips are kept under `<voice dir>/calibration/<device id>/`, and a sweep
// decodes every clip under each candidate setting on the active model, through the runtime's
// dictation-first lane. Rows are scored by word error, jargon hits and time; a completed sweep
// saves the best row for that device and model (§chat.voice/decoding).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import type {
  VoiceCalibration,
  VoiceCalibrationClip,
  VoiceCalibrationRow,
  VoiceCalibrationRun,
  VoiceCalibrationSentence,
  VoiceCalibrationSummary,
  VoiceDecodeSettings,
  VoiceDeviceInfo,
  VoiceEngine,
  VoiceModelScore,
} from "../../shared/protocol";
import { RuntimeError, type TranscribeRequest } from "./runtime";
import { decodeFields, decodeFor, decodeKey, DEFAULT_DECODE, readSettings, updateSettings, validDeviceId, type DeviceModelRecord, type VoiceSettingsFile } from "./settings";
import { cleanTranscript, clipProblem, inspectWav } from "./wav";

// ---- the sentences -----------------------------------------------------------------------------

/** Read aloud, one at a time. No digits or times, so normalization can't move a score. */
export const SENTENCES: readonly VoiceCalibrationSentence[] = [
  { n: 1, text: "Open a new worktree for the voice branch and run the tests." },
  { n: 2, text: "Ask the Overseer to review what the subagent changed in Sova." },
  { n: 3, text: "The statechart has three states: idle, recording, and transcribing." },
  { n: 4, text: "Spawn a subagent to fix the failing TypeScript build in that worktree." },
  { n: 5, text: "Sova should keep the draft when the Overseer pauses the session." },
  { n: 6, text: "Move the meeting to Thursday afternoon and tell the rest of the team.", control: true },
  {
    n: 7,
    text: "Before you merge, check the worktree status in Sova. If the statechart test fails, hand it to a subagent and ask the Overseer to decide. Then tell Claude to summarize what changed.",
    long: true,
  },
];

export const MIN_CLIPS = 4;
/** A clip upload's cap: 60 s of 16 kHz 16-bit mono is 1.9 MB. */
export const MAX_CLIP_BYTES = 3 * 1024 * 1024;
/** One sweep inference's limit (a fallback loop can run for seconds). */
export const SWEEP_TIMEOUT_MS = 15_000;

/** The words calibration checks are spelled right. Only "Sova" must be capitalized to count. */
export const JARGON = ["Sova", "worktree", "Overseer", "statechart", "subagent", "TypeScript", "Claude"] as const;
const CASED = new Set(["Sova"]);

// ---- scoring -----------------------------------------------------------------------------------

/** Words for word error: lowercased, a hyphen inside a word joined ("sub-agent" is "subagent"),
    a jargon compound split in two joined ("work tree" is "worktree"), other punctuation and
    apostrophes dropped. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\p{L})-(?=\p{L})/gu, "$1")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\b(work|state|sub|type) (tree|chart|agent|script)(?=s?\b)/g, (m, a: string, b: string) => (COMPOUNDS.has(a + b) ? a + b : m))
    .split(/\s+/)
    .filter(Boolean);
}
const COMPOUNDS = new Set(["worktree", "statechart", "subagent", "typescript"]);

/** A word alignment (Levenshtein): its edit count and the (reference, heard) index pairs it matched. */
function align(r: string[], h: string[]): { errors: number; matched: [number, number][] } {
  const d = r.map(() => [] as number[]).concat([[]]);
  for (let i = 0; i <= r.length; i++)
    for (let j = 0; j <= h.length; j++)
      d[i]![j] = !i || !j ? i + j : Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  const matched: [number, number][] = [];
  for (let i = r.length, j = h.length; i && j; ) {
    if (d[i]![j] === d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)) {
      if (r[--i] === h[--j]) matched.push([i, j]);
    } else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  return { errors: d[r.length]![h.length]!, matched };
}

/** Word-level edit distance (substitutions, deletions, insertions) and the reference's length. */
export function wordErrors(reference: string, heard: string): { errors: number; words: number } {
  const r = normalizeWords(reference);
  return { errors: align(r, normalizeWords(heard)).errors, words: r.length };
}

/** The heard text repeats a run of 6 or more of the prompt's words: whisper echoing its prompt. */
export function echoesPrompt(heard: string, prompt: string | undefined): boolean {
  const p = normalizeWords(prompt ?? "");
  const h = ` ${normalizeWords(heard).join(" ")} `;
  for (let i = 0; i + 6 <= p.length; i++) if (h.includes(` ${p.slice(i, i + 6).join(" ")} `)) return true;
  return false;
}

/** A token as written, its edge punctuation and a possessive "'s" gone. */
const bare = (t: string) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, "");

/** Jargon words in the reference, and how many of them the word alignment matched to the word as
    written (so a jargon word elsewhere in the transcript doesn't count). */
export function jargonHits(reference: string, heard: string): { hits: number; total: number } {
  const r = reference.split(/\s+/).map(bare).filter(Boolean);
  const h = heard.split(/\s+/).map(bare).filter(Boolean);
  const lower = (ts: string[]) => ts.map((t) => t.toLowerCase());
  const term = (t: string) => JARGON.find((w) => w.toLowerCase() === t.toLowerCase());
  const total = r.filter(term).length;
  const hits = align(lower(r), lower(h)).matched.filter(([i, j]) => {
    const w = term(r[i]!);
    return w && (!CASED.has(w) || h[j] === w);
  }).length;
  return { hits, total };
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/**
 * Best first: rows with every clip scored before partial ones; then the fewest word errors, except
 * that among rows within 1 word of the best, more jargon hits win, then fewer word errors, then the
 * shorter median time. The current row stays first unless the best beats it by 3 words or more:
 * on about 100 words a smaller gain is noise.
 */
export function rankRows(rows: VoiceCalibrationRow[]): VoiceCalibrationRow[] {
  const most = Math.max(0, ...rows.map((r) => r.scored));
  const full = rows.filter((r) => r.scored === most && most > 0);
  const partial = rows.filter((r) => !(r.scored === most && most > 0));
  const best = Math.min(...full.map((r) => r.errors));
  const near = (r: VoiceCalibrationRow) => r.errors <= best + 1;
  const cmp = (a: VoiceCalibrationRow, b: VoiceCalibrationRow) => {
    const an = near(a);
    const bn = near(b);
    if (an !== bn) return an ? -1 : 1;
    if (an) return b.jargonHits - a.jargonHits || a.errors - b.errors || a.medianMs - b.medianMs;
    return a.errors - b.errors || b.jargonHits - a.jargonHits || a.medianMs - b.medianMs;
  };
  const byWer = (a: VoiceCalibrationRow, b: VoiceCalibrationRow) => a.wer - b.wer || b.jargonHits - a.jargonHits || a.medianMs - b.medianMs;
  const ranked = full.sort(cmp);
  const cur = ranked.find((r) => r.current);
  if (cur && ranked[0] !== cur && ranked[0]!.errors > cur.errors - MARGIN) ranked.splice(0, 0, ...ranked.splice(ranked.indexOf(cur), 1));
  return [...ranked, ...partial.sort(byWer)];
}

/** Word errors a setting must save over the current one to replace it. */
export const MARGIN = 3;

// ---- the grid ----------------------------------------------------------------------------------

const VAD_ON = { vadThreshold: 0.5, vadSpeechPadMs: 150 };

/**
 * The settings a sweep tries, all with the 0.2 fallback (on short clips it almost never fires).
 * full (GPU): prompt {none, list, sentence} × beam {1, 5} × voice detection {off, on} = 12. quick
 * (CPU): prompt {list, sentence} × beam {1, 5} = 4, voice detection off. The device's current
 * settings come first, added when the grid lacks them.
 */
export function buildGrid(kind: "full" | "quick", current: VoiceDecodeSettings): VoiceDecodeSettings[] {
  const out: VoiceDecodeSettings[] = [];
  const prompts: VoiceDecodeSettings["prompt"][] = kind === "full" ? ["none", "list", "sentence"] : ["list", "sentence"];
  const vads = kind === "full" ? [false, true] : [false];
  for (const prompt of prompts)
    for (const beamSize of [1, 5])
      for (const vad of vads) out.push({ ...DEFAULT_DECODE, prompt, beamSize, vad, ...(vad ? VAD_ON : {}) });
  const key = decodeKey(current);
  return [current, ...out.filter((s) => decodeKey(s) !== key)];
}

// ---- the clip store ----------------------------------------------------------------------------

export const deviceDir = (calibrationDir: string, device: string) => join(calibrationDir, device);
const clipFile = (dir: string, n: number) => join(dir, `clip-${n}.wav`);
const runFile = (dir: string, model: string) => join(dir, "runs", `${model}.json`);

export function listClips(calibrationDir: string, device: string): VoiceCalibrationClip[] {
  const dir = deviceDir(calibrationDir, device);
  const out: VoiceCalibrationClip[] = [];
  for (const s of SENTENCES) {
    const f = clipFile(dir, s.n);
    try {
      const st = statSync(f);
      const info = inspectWav(readFileSync(f));
      if ("error" in info) continue;
      out.push({ n: s.n, sec: Math.round(info.audioSec * 100) / 100, at: st.mtimeMs });
    } catch {
      // not recorded
    }
  }
  return out;
}

export function readRun(calibrationDir: string, device: string, model: string): VoiceCalibrationRun | null {
  try {
    return JSON.parse(readFileSync(runFile(deviceDir(calibrationDir, device), model), "utf8")) as VoiceCalibrationRun;
  } catch {
    return null;
  }
}

function writeRun(calibrationDir: string, device: string, run: VoiceCalibrationRun): void {
  const f = runFile(deviceDir(calibrationDir, device), run.model);
  mkdirSync(join(f, ".."), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(run));
  renameSync(tmp, f);
}

// ---- the service ---------------------------------------------------------------------------------

export class CalibrationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

export interface CalibratorOptions {
  calibrationDir: () => string;
  settingsFile: () => string;
  /** The active model and its engine. */
  active: () => { id: string; engine: VoiceEngine; label: string };
  /** A CPU install: the quick grid. */
  cpu: () => boolean;
  /** Voice is set up and the active model can run. */
  ready: () => boolean;
  /** A model job or setup is running: no sweep starts. */
  busy: () => string | null;
  /** Fetch Silero when missing (import first, verified). Resolves true once it's on disk. */
  ensureVad: (signal: AbortSignal) => Promise<boolean>;
  vadReady: () => boolean;
  /** The folder hint of the device's last dictation, so the sweep decodes as dictation does. */
  hint?: (device: string) => string | null;
  /** The runtime's lane. */
  transcribe: (wav: Uint8Array, req: TranscribeRequest) => Promise<{ text: string; ms: number }>;
  dictationWaiting: () => boolean;
  /** Restart the engine at its next idle moment (after Silero first arrives, for `-vm`). */
  restartEngine: () => Promise<void>;
}

interface Sweep {
  device: string;
  run: VoiceCalibrationRun;
  abort: AbortController;
  done: Promise<void>;
}

export class Calibrator {
  private sweep: Sweep | null = null;

  constructor(private readonly o: CalibratorOptions) {}

  running(): { device: string; model: string } | null {
    return this.sweep && this.sweep.run.phase === "running" ? { device: this.sweep.device, model: this.sweep.run.model } : null;
  }

  whenDone(): Promise<void> {
    return this.sweep?.done ?? Promise.resolve();
  }

  /** This device's calibration for the status: sentences, kept clips, its run on the active model, other models' scores. */
  status(device: string): VoiceCalibration {
    const dir = this.o.calibrationDir();
    const model = this.o.active().id;
    const out: VoiceCalibration = { sentences: [...SENTENCES], clips: listClips(dir, device), minClips: MIN_CLIPS, scores: [] };
    const live = this.sweep && this.sweep.device === device && this.sweep.run.model === model ? this.sweep.run : null;
    const run = live ?? readRun(dir, device, model);
    if (run) {
      out.run = this.withApplied(run, device);
      // Paused is a fact about now: a dictation clip waiting or running while this sweep runs.
      out.run.progress = { ...run.progress, pausedForDictation: run.phase === "running" && this.o.dictationWaiting() };
    }
    try {
      for (const f of readdirSync(join(deviceDir(dir, device), "runs"))) {
        if (!f.endsWith(".json")) continue;
        const other = f.slice(0, -5);
        if (other === model) continue;
        const r = readRun(dir, device, other);
        // Only a completed run speaks for a model: a stopped or failed one may have scored one clip.
        const best = r?.phase === "done" ? r.rows[0] : undefined;
        if (!r || !best) continue;
        out.scores.push({
          model: other,
          at: r.finishedAt ?? r.startedAt,
          wer: best.wer,
          errors: best.errors,
          words: best.words,
          jargonHits: best.jargonHits,
          jargonTotal: best.jargonTotal,
          medianMs: best.medianMs,
        } satisfies VoiceModelScore);
      }
    } catch {
      // no runs yet
    }
    return out;
  }

  /** Mark the row the device dictates with now. */
  private withApplied(run: VoiceCalibrationRun, device: string): VoiceCalibrationRun {
    const now = decodeKey(decodeFor(readSettings(this.o.settingsFile()), device, run.model).settings);
    return { ...run, rows: run.rows.map((r) => ({ ...r, applied: run.engine === "whisper" && r.key === now })) };
  }

  /** Keep the device's label and when it was last seen. */
  touchDevice(info: Partial<VoiceDeviceInfo> & { id: string }): void {
    updateSettings(this.o.settingsFile(), (s) => {
      const d = (s.devices[info.id] ??= { label: "", app: false, lastSeenAt: 0, perModel: {} });
      if (typeof info.label === "string" && info.label) d.label = info.label.slice(0, 80);
      if (typeof info.app === "boolean") d.app = info.app;
      d.lastSeenAt = Date.now();
    });
  }

  putClip(device: string, n: number, wav: Uint8Array): void {
    if (!validDeviceId(device)) throw new CalibrationError(400, "A voice device id is required.");
    if (!SENTENCES.some((s) => s.n === n)) throw new CalibrationError(404, `There is no sentence ${n}.`);
    if (wav.byteLength > MAX_CLIP_BYTES) throw new CalibrationError(413, "The clip is over the 3 MB limit.");
    const info = inspectWav(wav);
    if ("error" in info) throw new CalibrationError(400, info.error);
    const problem = clipProblem(wav, info);
    if (problem) throw new CalibrationError(400, problem);
    if (this.sweep?.device === device && this.sweep.run.phase === "running") throw new CalibrationError(409, "Calibration is running on these clips. Stop it first.");
    const dir = deviceDir(this.o.calibrationDir(), device);
    mkdirSync(dir, { recursive: true });
    const f = clipFile(dir, n);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, wav);
    renameSync(tmp, f);
  }

  deleteClip(device: string, n: number): void {
    if (this.sweep?.device === device && this.sweep.run.phase === "running") throw new CalibrationError(409, "Calibration is running on these clips. Stop it first.");
    rmSync(clipFile(deviceDir(this.o.calibrationDir(), device), n), { force: true });
  }

  /** Delete Clips: the device's clips and its runs (its saved settings stay). */
  deleteAll(device: string): void {
    if (this.sweep?.device === device && this.sweep.run.phase === "running") throw new CalibrationError(409, "Calibration is running on these clips. Stop it first.");
    rmSync(deviceDir(this.o.calibrationDir(), device), { recursive: true, force: true });
  }

  /** Forget: the device's settings, clips and runs. */
  forget(device: string): void {
    if (this.sweep?.device === device && this.sweep.run.phase === "running") throw new CalibrationError(409, "Calibration is running for that device. Stop it first.");
    rmSync(deviceDir(this.o.calibrationDir(), device), { recursive: true, force: true });
    updateSettings(this.o.settingsFile(), (s) => {
      delete s.devices[device];
    });
  }

  /** Start a sweep of this device's clips on the active model. */
  start(info: Partial<VoiceDeviceInfo> & { id: string }): VoiceCalibrationRun {
    const device = info.id;
    if (!validDeviceId(device)) throw new CalibrationError(400, "A voice device id is required.");
    if (!this.o.ready()) throw new CalibrationError(409, "Voice isn't set up on this host.");
    const other = this.running();
    if (other) throw new CalibrationError(409, other.device === device ? "Calibration is already running." : "Another device is calibrating. Wait for it to finish.");
    const busy = this.o.busy();
    if (busy) throw new CalibrationError(409, busy);
    const dir = this.o.calibrationDir();
    const clips = listClips(dir, device);
    if (clips.length < MIN_CLIPS) throw new CalibrationError(409, `Calibration needs at least ${MIN_CLIPS} clips; this device has ${clips.length}.`);
    this.touchDevice(info);
    const active = this.o.active();
    const current = decodeFor(readSettings(this.o.settingsFile()), device, active.id).settings;
    const grid: VoiceCalibrationRun["grid"] = active.engine !== "whisper" ? "score" : this.o.cpu() ? "quick" : "full";
    const settings = grid === "score" ? [{ ...DEFAULT_DECODE }] : buildGrid(grid, current);
    const rows: VoiceCalibrationRow[] = settings.map((s, i) => ({
      key: grid === "score" ? active.id : decodeKey(s),
      settings: s,
      wer: 0,
      errors: 0,
      words: 0,
      jargonHits: 0,
      jargonTotal: 0,
      medianMs: 0,
      scored: 0,
      current: grid !== "score" && i === 0,
      applied: false,
      clips: [],
    }));
    const run: VoiceCalibrationRun = {
      id: randomUUID(),
      model: active.id,
      engine: active.engine,
      grid,
      phase: "running",
      progress: { setting: 0, settings: rows.length, clip: 0, clips: clips.length, done: 0, total: 0, pausedForDictation: false },
      rows,
      startedAt: Date.now(),
    };
    if (hostBusy()) run.hostBusy = true;
    const abort = new AbortController();
    const sweep: Sweep = { device, run, abort, done: Promise.resolve() };
    this.sweep = sweep;
    sweep.done = this.sweepLoop(sweep, clips).catch((err: unknown) => {
      run.phase = "failed";
      run.error = (err as Error).message;
    }).finally(() => {
      run.finishedAt = Date.now();
      if (hostBusy()) run.hostBusy = true;
      delete run.progress.etaSec;
      run.progress.pausedForDictation = false;
      run.rows = rankRows(run.rows);
      if (run.rows[0]?.scored) run.best = run.rows[0].key;
      if (run.phase === "done" && run.grid !== "score") this.autoApply(sweep);
      writeRun(this.o.calibrationDir(), device, run);
    });
    return run;
  }

  stop(device: string): boolean {
    if (!this.sweep || this.sweep.device !== device || this.sweep.run.phase !== "running") return false;
    this.sweep.run.phase = "stopped";
    this.sweep.abort.abort();
    return true;
  }

  private async sweepLoop(sweep: Sweep, clips: VoiceCalibrationClip[]): Promise<void> {
    const { run, abort } = sweep;
    const dir = deviceDir(this.o.calibrationDir(), sweep.device);
    const wavs = new Map(clips.map((c) => [c.n, new Uint8Array(readFileSync(clipFile(dir, c.n)))]));
    const refs = new Map(SENTENCES.map((s) => [s.n, s.text]));
    // Voice detection needs Silero on disk and the engine launched with -vm. Without it the
    // settings that use it are skipped, never decoded without it under their label.
    if (run.rows.some((r) => r.settings.vad) && !this.o.vadReady()) {
      if (await this.o.ensureVad(abort.signal)) await this.o.restartEngine();
      if (abort.signal.aborted) return;
      if (!this.o.vadReady()) {
        const kept = run.rows.filter((r) => !r.settings.vad);
        run.vadSkipped = run.rows.length - kept.length;
        run.rows = kept;
        run.progress.settings = kept.length;
      }
    }
    const vadModel = this.o.vadReady();
    // Round-robin: every setting on clip 1, then every setting on clip 2, … so a slow spell of the
    // GPU hits all settings alike; then the current settings once more on every clip.
    const items: { row: VoiceCalibrationRow; setting: number; clip: VoiceCalibrationClip; again?: true }[] = [];
    for (const clip of clips) run.rows.forEach((row, i) => items.push({ row, setting: i + 1, clip }));
    const cur = run.rows.find((r) => r.current);
    if (cur) for (const clip of clips) items.push({ row: cur, setting: 1, clip, again: true });
    run.progress.total = items.length;
    const times: number[] = [];
    const msByRow = new Map<VoiceCalibrationRow, number[]>();
    for (const item of items) {
      if (abort.signal.aborted) return;
      run.progress.setting = item.setting;
      run.progress.clip = clips.indexOf(item.clip) + 1;
      run.progress.pausedForDictation = this.o.dictationWaiting();
      const ref = refs.get(item.clip.n)!;
      const fields = run.engine === "whisper" ? decodeFields(item.row.settings, { vadModel, hint: this.o.hint?.(sweep.device) }) : {};
      let heard = "";
      let ms: number;
      const tick = setInterval(() => {
        run.progress.pausedForDictation = this.o.dictationWaiting();
      }, 200);
      try {
        const out = await this.o.transcribe(wavs.get(item.clip.n)!, { fields, lane: "sweep", timeoutMs: SWEEP_TIMEOUT_MS });
        heard = cleanTranscript(out.text);
        ms = out.ms;
      } catch (err) {
        if (abort.signal.aborted) return;
        // A clip over the limit scores as nothing heard; anything else ends the run, rows kept.
        if (err instanceof RuntimeError && /didn't answer in time/.test(err.message)) ms = SWEEP_TIMEOUT_MS;
        else throw new Error(`Calibration stopped at setting ${item.setting} of ${run.rows.length}. ${(err as Error).message}`);
      } finally {
        clearInterval(tick);
        // The clip came back, so any dictation ahead of it is done or still queued: say which.
        run.progress.pausedForDictation = this.o.dictationWaiting();
      }
      if (abort.signal.aborted) return;
      times.push(ms);
      const list = msByRow.get(item.row) ?? [];
      list.push(ms);
      msByRow.set(item.row, list);
      item.row.medianMs = median(list);
      if (!item.again) {
        // A transcript echoing its prompt heard nothing: scored as silence.
        const scored = echoesPrompt(heard, fields.prompt) ? "" : heard;
        const e = wordErrors(ref, scored);
        const j = jargonHits(ref, scored);
        item.row.clips.push({ n: item.clip.n, heard, errors: e.errors, ms });
        item.row.errors += e.errors;
        item.row.words += e.words;
        item.row.jargonHits += j.hits;
        item.row.jargonTotal += j.total;
        item.row.scored++;
        item.row.wer = item.row.words ? Math.round((item.row.errors / item.row.words) * 10000) / 10000 : 0;
      }
      run.progress.done++;
      run.progress.etaSec = Math.round((median(times) * (items.length - run.progress.done)) / 1000);
    }
    run.phase = "done";
  }

  /** A completed sweep saves its best row, unless the current settings are the best. */
  private autoApply(sweep: Sweep): void {
    const best = sweep.run.rows[0];
    if (!best || best.current) return;
    this.save(sweep.device, sweep.run, best, "calibrated");
    sweep.run.applied = best.key;
  }

  private save(device: string, run: VoiceCalibrationRun, row: VoiceCalibrationRow, source: DeviceModelRecord["source"]): void {
    const baseline = run.rows.find((r) => r.current);
    const summary: VoiceCalibrationSummary = {
      at: run.finishedAt ?? Date.now(),
      model: run.model,
      clips: row.scored,
      wer: row.wer,
      baselineWer: baseline?.wer ?? row.wer,
      jargonHits: row.jargonHits,
      jargonTotal: row.jargonTotal,
      medianMs: row.medianMs,
      key: row.key,
    };
    updateSettings(this.o.settingsFile(), (s: VoiceSettingsFile) => {
      const d = (s.devices[device] ??= { label: "", app: false, lastSeenAt: Date.now(), perModel: {} });
      const old = d.perModel[run.model];
      const previous = old ? { settings: old.settings, source: old.source, updatedAt: old.updatedAt, ...(old.calibration ? { calibration: old.calibration } : {}) } : null;
      // Only a completed run's scores become the summary: a stopped run's row may rest on one clip.
      d.perModel[run.model] = { settings: row.settings, source, previous, updatedAt: Date.now(), ...(run.phase === "done" ? { calibration: summary } : {}) };
    });
  }

  /** Use These Settings: any row of the device's run on the active model. */
  apply(device: string, key: string): void {
    const model = this.o.active().id;
    const run = this.sweep && this.sweep.device === device && this.sweep.run.model === model ? this.sweep.run : readRun(this.o.calibrationDir(), device, model);
    if (!run) throw new CalibrationError(404, "This device has no calibration results for the active model.");
    if (run.phase === "running") throw new CalibrationError(409, "Calibration is still running.");
    if (run.engine !== "whisper") throw new CalibrationError(409, "This model has no settings to choose.");
    const row = run.rows.find((r) => r.key === key);
    if (!row) throw new CalibrationError(404, "That results row isn't in this device's last run.");
    this.save(device, run, row, "chosen");
    run.applied = row.key;
    writeRun(this.o.calibrationDir(), device, run);
  }

  /** Revert to Previous: the record before the last apply, or the defaults. */
  revert(device: string): void {
    const model = this.o.active().id;
    updateSettings(this.o.settingsFile(), (s) => {
      const d = s.devices[device];
      const rec = d?.perModel[model];
      if (!d || !rec || rec.previous === undefined) throw new CalibrationError(409, "There is nothing to revert to.");
      if (rec.previous === null) delete d.perModel[model];
      else d.perModel[model] = { ...rec.previous };
    });
    const run = readRun(this.o.calibrationDir(), device, model);
    if (run) {
      delete run.applied;
      writeRun(this.o.calibrationDir(), device, run);
    }
  }
}

/** The 1-minute load average above 75% of the cores. */
function hostBusy(): boolean {
  return loadavg()[0]! / Math.max(1, cpus().length) > 0.75;
}

export const clipsExist = (calibrationDir: string, device: string) => existsSync(deviceDir(calibrationDir, device));
