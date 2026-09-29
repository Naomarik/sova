import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { VoiceCalibrationRow, VoiceDecodeSettings } from "../../shared/protocol";
import { buildGrid, CalibrationError, Calibrator, JARGON, jargonHits, listClips, median, MIN_CLIPS, normalizeWords, rankRows, readRun, SENTENCES, SWEEP_TIMEOUT_MS, wordErrors, type CalibratorOptions } from "./calibration";
import { HOTWORDS, PROMPT_SENTENCE } from "./pins";
import { RuntimeError, type TranscribeRequest } from "./runtime";
import { decodeFor, decodeKey, DEFAULT_DECODE, readSettings, updateSettings } from "./settings";

const A = "3f1c2d4e-0000-4000-8000-00000000000a";
const B = "9b8a7c6d-0000-4000-8000-00000000000b";
const MODEL = "ggml-large-v3-turbo-q5_0";

const tuned = (o: Partial<VoiceDecodeSettings>): VoiceDecodeSettings => ({ ...DEFAULT_DECODE, ...o });

/** A 16 kHz mono clip whose length names its sentence: n × 0.1 s of silence. */
function clip(n: number): Uint8Array {
  const samples = n * 1600;
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
  return new Uint8Array(b);
}
const clipN = (wav: Uint8Array) => (wav.byteLength - 44) / 3200;
const ref = (n: number) => SENTENCES.find((s) => s.n === n)!.text;

/**
 * A stand-in engine with a known answer per setting: the sentence prompt hears every word as
 * written; the list prompt hears "Sova" as "sova" (no word error, a jargon miss); no prompt hears
 * "worktree" as "work tree"; voice detection loses the first word. Beam 5 costs 50 ms; a
 * temperature step of 0 saves 10.
 */
function engine(fields: Record<string, string>, n: number): { text: string; ms: number } {
  let text = ref(n);
  if (!fields.prompt) text = text.replace(/worktree/g, "work tree").replace(/Sova/g, "Silver");
  else if (fields.prompt.startsWith(`${HOTWORDS[0]}, `)) text = text.replace(/Sova/g, "sova");
  else assert.equal(fields.prompt, PROMPT_SENTENCE);
  if (fields.vad === "true") text = text.split(" ").slice(1).join(" ");
  const ms = 100 + (fields.beam_size === "5" ? 50 : 0) - (fields.temperature_inc === "0" ? 10 : 0);
  return { text: ` ${text}\n`, ms };
}

interface Rig {
  cal: Calibrator;
  calls: { n: number; fields: Record<string, string>; lane?: string; timeoutMs?: number }[];
  settingsFile: string;
  dir: string;
  events: string[];
  set(o: Partial<{ engine: "whisper" | "transcribe"; cpu: boolean; vad: boolean; busy: string | null; dictation: boolean }>): void;
}

function rig(o: { transcribe?: (wav: Uint8Array, req: TranscribeRequest) => Promise<{ text: string; ms: number }>; vad?: boolean } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "voice-cal-"));
  const dir = join(root, "calibration");
  const settingsFile = join(root, "settings.json");
  const calls: Rig["calls"] = [];
  const events: string[] = [];
  const st = { engine: "whisper" as "whisper" | "transcribe", cpu: false, vad: o.vad ?? true, busy: null as string | null, dictation: false };
  const opts: CalibratorOptions = {
    calibrationDir: () => dir,
    settingsFile: () => settingsFile,
    active: () => (st.engine === "whisper" ? { id: MODEL, engine: "whisper", label: "large-v3-turbo" } : { id: "parakeet-tdt-0.6b-v2-q8_0", engine: "transcribe", label: "parakeet-tdt-0.6b-v2" }),
    cpu: () => st.cpu,
    ready: () => true,
    busy: () => st.busy,
    ensureVad: async () => {
      events.push("ensureVad");
      st.vad = true;
      return true;
    },
    vadReady: () => st.vad,
    transcribe: async (wav, req) => {
      calls.push({ n: clipN(wav), fields: req.fields ?? {}, lane: req.lane, timeoutMs: req.timeoutMs });
      return o.transcribe ? o.transcribe(wav, req) : engine(req.fields ?? {}, clipN(wav));
    },
    dictationWaiting: () => st.dictation,
    restartEngine: async () => {
      events.push("restartEngine");
    },
  };
  return {
    cal: new Calibrator(opts),
    calls,
    settingsFile,
    dir,
    events,
    set: (p) => Object.assign(st, p),
  };
}

function record(r: Rig, device: string, ns: number[]) {
  for (const n of ns) r.cal.putClip(device, n, clip(n));
}

// ---- scoring ----------------------------------------------------------------------------------

describe("word error", () => {
  it("ignores case and punctuation, and joins a hyphen inside a word", () => {
    assert.deepEqual(wordErrors("Ask the Overseer to review it.", "ask the overseer, to review it"), { errors: 0, words: 6 });
    assert.deepEqual(wordErrors("Spawn a subagent.", "Spawn a sub-agent."), { errors: 0, words: 3 });
    assert.deepEqual(normalizeWords("It's the Overseer’s — idle, recording."), ["its", "the", "overseers", "idle", "recording"]);
  });

  it("counts substitutions, insertions and deletions as words", () => {
    // worktree → work tree: one substitution and one insertion.
    assert.deepEqual(wordErrors("Open a new worktree.", "Open a new work tree."), { errors: 2, words: 4 });
    assert.deepEqual(wordErrors("Open a new worktree.", "Open new worktree."), { errors: 1, words: 4 });
    assert.deepEqual(wordErrors("Open a new worktree.", ""), { errors: 4, words: 4 });
    assert.deepEqual(wordErrors("Open a new worktree.", "Open a new worktree now please."), { errors: 2, words: 4 });
  });
});

describe("jargon hits", () => {
  it("only a capitalized Sova counts; the other terms count in any case", () => {
    const r = "Ask the Overseer to review what the subagent changed in Sova.";
    assert.deepEqual(jargonHits(r, r), { hits: 3, total: 3 });
    assert.deepEqual(jargonHits(r, "Ask the overseer to review what the Subagent changed in sova."), { hits: 2, total: 3 });
    assert.deepEqual(jargonHits(r, "Ask the Overseer to review what the subagent changed in SOVA."), { hits: 2, total: 3 });
    assert.deepEqual(jargonHits(r, "Ask the Overseer to review what the subagent changed in Sova's."), { hits: 3, total: 3 });
  });

  it("a split or hyphenated term is a miss, and repeating a term can't earn more than the reference has", () => {
    const r = "Spawn a subagent to fix the failing TypeScript build in that worktree.";
    assert.deepEqual(jargonHits(r, "Spawn a sub-agent to fix the failing TypeScript build in that work tree."), { hits: 0, total: 2 });
    assert.deepEqual(jargonHits(r, "subagent subagent subagent worktree"), { hits: 2, total: 2 });
  });

  it("the control sentence has no jargon; each other sentence has some", () => {
    for (const s of SENTENCES) {
      const { total } = jargonHits(s.text, s.text);
      if (s.control) assert.equal(total, 0, s.text);
      else assert.ok(total > 0, s.text);
    }
    for (const term of JARGON) assert.ok(SENTENCES.some((s) => s.text.includes(term)), term);
  });
});

describe("the sentences", () => {
  it("are the 7 decided ones: 5 jargon, 1 control, 1 long passage, and a run needs 4", () => {
    assert.deepEqual(SENTENCES.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(SENTENCES.filter((s) => s.control).length, 1);
    assert.equal(SENTENCES.filter((s) => s.long).length, 1);
    assert.equal(MIN_CLIPS, 4);
    assert.ok(!SENTENCES.some((s) => /\d/.test(s.text)), "no digits: normalization could move a score");
  });
});

describe("median", () => {
  it("middle value, the mean of the middle two rounded, 0 for none", () => {
    assert.equal(median([300, 100, 200]), 200);
    assert.equal(median([100, 200, 400, 300]), 250);
    assert.equal(median([]), 0);
  });
});

// ---- ranking ----------------------------------------------------------------------------------

const row = (key: string, o: Partial<VoiceCalibrationRow>): VoiceCalibrationRow => ({
  key,
  settings: DEFAULT_DECODE,
  wer: 0,
  errors: 0,
  words: 100,
  jargonHits: 0,
  jargonTotal: 10,
  medianMs: 100,
  scored: 6,
  current: false,
  applied: false,
  clips: [],
  ...o,
  ...(o.errors !== undefined && o.wer === undefined ? { wer: o.errors / 100 } : {}),
});
const order = (rows: VoiceCalibrationRow[]) => rankRows(rows).map((r) => r.key);

describe("ranking", () => {
  it("fewest word errors first when the rest are more than a word behind, whatever their jargon or speed", () => {
    assert.deepEqual(order([row("jargon", { errors: 4, jargonHits: 10, medianMs: 50 }), row("exact", { errors: 2, jargonHits: 0, medianMs: 900 })]), ["exact", "jargon"]);
  });

  it("within one word of the best, more jargon hits win", () => {
    assert.deepEqual(order([row("exact", { errors: 2, jargonHits: 7 }), row("jargon", { errors: 3, jargonHits: 9 })]), ["jargon", "exact"]);
  });

  it("with jargon tied, fewer word errors win before time", () => {
    assert.deepEqual(order([row("fast", { errors: 3, jargonHits: 9, medianMs: 200 }), row("exact", { errors: 2, jargonHits: 9, medianMs: 400 })]), ["exact", "fast"]);
    // The laptop's e2e run: 2 errors at 343 ms had ranked above 1 error at 358 ms.
    assert.deepEqual(order([row("quick", { errors: 2, jargonHits: 13, medianMs: 343 }), row("vad", { errors: 1, jargonHits: 13, medianMs: 358 })]), ["vad", "quick"]);
  });

  it("then the lower median time", () => {
    assert.deepEqual(order([row("slow", { errors: 1, jargonHits: 5, medianMs: 300 }), row("fast", { errors: 1, jargonHits: 5, medianMs: 299 })]), ["fast", "slow"]);
  });

  it("rows a stopped run left short go after every complete row, however good", () => {
    assert.deepEqual(order([row("short", { scored: 3, errors: 0, jargonHits: 10 }), row("full", { errors: 9 })]), ["full", "short"]);
  });

  it("the order doesn't depend on the input order", () => {
    const rows = [row("a", { errors: 5, jargonHits: 3 }), row("b", { errors: 2, jargonHits: 1 }), row("c", { errors: 3, jargonHits: 4, medianMs: 90 }), row("d", { errors: 3, jargonHits: 4, medianMs: 80 }), row("e", { errors: 2, jargonHits: 4, medianMs: 95 })];
    const want = order(rows);
    assert.deepEqual(want, ["e", "d", "c", "b", "a"]);
    assert.deepEqual(order([...rows].reverse()), want);
  });
});

// ---- the grid ---------------------------------------------------------------------------------

describe("the grid", () => {
  it("GPU: 24 distinct settings, prompt × beam × VAD × fallback, the current ones first", () => {
    const g = buildGrid("full", DEFAULT_DECODE);
    assert.equal(g.length, 24);
    assert.equal(new Set(g.map(decodeKey)).size, 24);
    assert.equal(decodeKey(g[0]!), decodeKey(DEFAULT_DECODE));
    const combos = new Set(g.map((s) => `${s.prompt}/${s.beamSize}/${s.vad}/${s.temperatureInc}`));
    for (const p of ["none", "list", "sentence"]) for (const b of [1, 5]) for (const v of [false, true]) for (const t of [0.2, 0]) assert.ok(combos.has(`${p}/${b}/${v}/${t}`), `${p}/${b}/${v}/${t}`);
    for (const s of g.filter((x) => x.vad)) assert.deepEqual([s.vadThreshold, s.vadSpeechPadMs], [0.5, 150]);
  });

  it("CPU: 8 settings, no voice detection and no prompt-less rows", () => {
    const g = buildGrid("quick", DEFAULT_DECODE);
    assert.equal(g.length, 8);
    assert.equal(new Set(g.map(decodeKey)).size, 8);
    assert.ok(g.every((s) => !s.vad && s.prompt !== "none"));
  });

  it("current settings outside the grid are added first, not dropped", () => {
    const odd = tuned({ beamSize: 2, vad: true, vadThreshold: 0.35, vadSpeechPadMs: 150 });
    const full = buildGrid("full", odd);
    assert.equal(full.length, 25);
    assert.equal(full[0], odd);
    const quick = buildGrid("quick", tuned({ prompt: "sentence", beamSize: 5, temperatureInc: 0 }));
    assert.equal(quick.length, 8);
    assert.equal(decodeKey(quick[0]!), "p=sentence b=5 t=0 v=0");
  });
});

// ---- the sweep --------------------------------------------------------------------------------

describe("a sweep", () => {
  it("scores every setting on every clip, round-robin, the current settings first and again at the end", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A, label: "Linux · Chrome", app: false });
    assert.equal(run.phase, "running");
    assert.equal(run.grid, "full");
    assert.deepEqual(r.cal.running(), { device: A, model: MODEL });
    await r.cal.whenDone();
    assert.equal(run.phase, "done");
    assert.equal(r.calls.length, 24 * 4 + 4);
    assert.ok(r.calls.every((c) => c.lane === "sweep" && c.timeoutMs === SWEEP_TIMEOUT_MS));
    // clip 1 under all 24 settings before clip 2
    assert.deepEqual([...new Set(r.calls.slice(0, 24).map((c) => c.n))], [1]);
    assert.equal(r.calls[24]!.n, 2);
    // the current settings (the defaults: the hotword list) open each clip and close the run
    assert.deepEqual(r.calls[0]!.fields, { prompt: `${HOTWORDS.join(", ")}.` });
    assert.deepEqual(r.calls.slice(-4).map((c) => [c.n, c.fields.prompt?.startsWith("Sova, ")]), [[1, true], [2, true], [3, true], [4, true]]);
    assert.ok(run.rows.every((x) => x.scored === 4));
    assert.equal(run.rows.find((x) => x.current)!.clips.length, 4, "the closing pass times the current row but doesn't score it twice");
  });

  it("ranks, then saves the best row for that device and model; the other device keeps the defaults", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4, 5]);
    record(r, B, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A, label: "Linux · Chrome", app: false });
    await r.cal.whenDone();
    // sentence prompt, greedy, no VAD, no fallback: exact, every jargon word, and fastest
    assert.equal(run.best, "p=sentence b=1 t=0 v=0");
    assert.equal(run.applied, run.best);
    const cur = run.rows.find((x) => x.current)!;
    assert.equal(cur.key, "p=list b=1 t=0.2 v=0");
    assert.equal(cur.errors, 0);
    assert.ok(cur.jargonHits < run.rows[0]!.jargonHits, "lower-case sova costs the list prompt jargon hits");
    const s = readSettings(r.settingsFile);
    const saved = decodeFor(s, A, MODEL);
    assert.equal(decodeKey(saved.settings), "p=sentence b=1 t=0 v=0");
    assert.equal(saved.record!.source, "calibrated");
    assert.equal(saved.record!.previous, null);
    assert.deepEqual({ ...saved.record!.calibration, at: 0 }, { at: 0, model: MODEL, clips: 5, wer: 0, baselineWer: 0, jargonHits: run.rows[0]!.jargonHits, jargonTotal: run.rows[0]!.jargonTotal, medianMs: 90, key: "p=sentence b=1 t=0 v=0" });
    assert.equal(s.devices[A]!.label, "Linux · Chrome");
    assert.deepEqual(decodeFor(s, B, MODEL).settings, DEFAULT_DECODE);
    assert.equal(decodeFor(s, A, "ggml-large-v3-q5_0").record, undefined, "another model stays uncalibrated");
    // the run is kept on disk for the status and a later restart
    assert.equal(readRun(r.dir, A, MODEL)!.best, run.best);
    assert.equal(r.cal.status(A).run!.rows.find((x) => x.applied)!.key, run.best);
  });

  it("the baseline is the device's own saved settings, and when they win nothing is rewritten", async () => {
    const r = rig();
    const mine = tuned({ prompt: "sentence", temperatureInc: 0 });
    updateSettings(r.settingsFile, (s) => {
      s.devices[A] = { label: "l", app: false, lastSeenAt: 1, perModel: { [MODEL]: { settings: mine, source: "chosen", updatedAt: 42 } } };
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.rows.find((x) => x.current)!.key, decodeKey(mine));
    assert.deepEqual(r.calls[0]!.fields, { prompt: PROMPT_SENTENCE, temperature_inc: "0" }, "the device's own settings open the run");
    assert.equal(run.best, decodeKey(mine));
    assert.equal(run.applied, undefined);
    assert.equal(readSettings(r.settingsFile).devices[A]!.perModel[MODEL]!.updatedAt, 42);
  });

  it("a CPU host sweeps the quick grid", async () => {
    const r = rig();
    r.set({ cpu: true });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.grid, "quick");
    assert.equal(run.rows.length, 8);
    assert.ok(r.calls.every((c) => !("vad" in c.fields)));
  });

  it("fetches Silero first when a VAD row needs it, restarts the engine for -vm, then sends vad", async () => {
    const r = rig({ vad: false });
    record(r, A, [1, 2, 3, 4]);
    r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.deepEqual(r.events, ["ensureVad", "restartEngine"]);
    assert.ok(r.calls.some((c) => c.fields.vad === "true" && c.fields.vad_speech_pad_ms === "150"));
  });

  it("a clip over the time limit scores as nothing heard; the run goes on", async () => {
    let first = true;
    const r = rig({
      transcribe: async (wav, req) => {
        if (first) {
          first = false;
          throw new RuntimeError(503, "whisper-server didn't answer in time.");
        }
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.phase, "done");
    const cur = run.rows.find((x) => x.current)!;
    assert.deepEqual(cur.clips[0], { n: 1, heard: "", errors: ref(1).split(" ").length, ms: SWEEP_TIMEOUT_MS });
  });

  it("any other engine failure ends the run as failed, with its rows kept and nothing applied", async () => {
    let n = 0;
    const r = rig({
      transcribe: async (wav, req) => {
        if (++n === 30) throw new RuntimeError(503, "whisper-server stopped unexpectedly.");
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.phase, "failed");
    assert.match(run.error!, /^Calibration stopped at setting \d+ of 24\. whisper-server stopped unexpectedly\.$/);
    assert.equal(run.applied, undefined);
    assert.equal(readSettings(r.settingsFile).devices[A]?.perModel[MODEL], undefined);
    assert.ok(readRun(r.dir, A, MODEL));
  });

  it("Stop keeps the partial results, ranks complete rows first, and applies nothing", async () => {
    let n = 0;
    const stops: boolean[] = [];
    const r: Rig = rig({
      transcribe: async (wav, req) => {
        // Stop while the 30th clip is in flight: its answer arrives after the stop.
        if (++n === 30) stops.push(r.cal.stop(A), r.cal.stop(A));
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.deepEqual(stops, [true, false]);
    assert.equal(n, 30, "nothing is sent after Stop");
    assert.equal(run.phase, "stopped");
    assert.equal(r.cal.running(), null);
    const scored = run.rows.map((x) => x.scored);
    assert.ok(scored.includes(2) && scored.includes(1), `rows partly scored: ${scored.join(",")}`);
    assert.deepEqual(scored, [...scored].sort((a, b) => b - a), "complete rows first");
    assert.equal(run.applied, undefined);
    assert.equal(readSettings(r.settingsFile).devices[A]?.perModel[MODEL], undefined);
    assert.equal(readRun(r.dir, A, MODEL)!.phase, "stopped");
  });

  it("shows 'paused for dictation' while a dictation clip waits, and clears it when the sweep resumes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let resume!: () => void;
    const gate2 = new Promise<void>((res) => (resume = res));
    let n = 0;
    const r = rig({
      transcribe: async (wav, req) => {
        if (++n === 3) await gate;
        if (n === 4) await gate2;
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    while (n < 3) await new Promise((res) => setImmediate(res));
    r.set({ dictation: true });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(run.progress.pausedForDictation, true);
    assert.equal(r.cal.status(A).run!.progress.pausedForDictation, true);
    r.set({ dictation: false });
    // The dictation is over while the sweep still runs: the flag clears at once, not at the end.
    assert.equal(r.cal.status(A).run!.progress.pausedForDictation, false);
    release();
    while (n < 4) await new Promise((res) => setImmediate(res));
    assert.equal(run.phase, "running");
    assert.equal(run.progress.pausedForDictation, false);
    assert.equal(r.cal.status(A).run!.progress.pausedForDictation, false);
    resume();
    await r.cal.whenDone();
    assert.equal(run.progress.pausedForDictation, false);
  });
});

describe("Parakeet (nothing to tune)", () => {
  it("scores one pass of the clips with no fields, and never applies", async () => {
    const r = rig();
    r.set({ engine: "transcribe" });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.grid, "score");
    assert.equal(run.rows.length, 1);
    assert.equal(r.calls.length, 4);
    assert.ok(r.calls.every((c) => Object.keys(c.fields).length === 0));
    assert.equal(run.applied, undefined);
    assert.equal(readSettings(r.settingsFile).devices[A]!.perModel["parakeet-tdt-0.6b-v2-q8_0"], undefined);
    assert.throws(() => r.cal.apply(A, run.rows[0]!.key), (e: unknown) => e instanceof CalibrationError && e.status === 409);
  });

  it("its score shows beside the whisper model's run on the same clips", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    r.set({ engine: "transcribe" });
    r.cal.start({ id: A });
    await r.cal.whenDone();
    r.set({ engine: "whisper" });
    const st = r.cal.status(A);
    assert.deepEqual(st.scores.map((s) => s.model), ["parakeet-tdt-0.6b-v2-q8_0"]);
    assert.equal(st.run, undefined, "no whisper run yet");
  });

  it("only a completed run gives a model its score: a stopped one after a clip shows none", async () => {
    let n = 0;
    let stopAt = 0;
    const r: Rig = rig({
      transcribe: async (wav, req) => {
        if (++n === stopAt) r.cal.stop(A);
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    r.set({ engine: "transcribe" });
    r.cal.start({ id: A });
    await r.cal.whenDone();
    r.set({ engine: "whisper" });
    assert.equal(r.cal.status(A).scores.length, 1);
    r.set({ engine: "transcribe" });
    stopAt = n + 1;
    const again = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(again.phase, "stopped");
    r.set({ engine: "whisper" });
    assert.deepEqual(r.cal.status(A).scores, []);
  });
});

describe("apply and revert", () => {
  it("Use These picks any row (chosen); Revert goes back one step, then to the defaults, then refuses", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    const other = run.rows.find((x) => x.key === "p=list b=5 t=0 v=0")!;
    r.cal.apply(A, other.key);
    let rec = decodeFor(readSettings(r.settingsFile), A, MODEL).record!;
    assert.equal(decodeKey(rec.settings), other.key);
    assert.equal(rec.source, "chosen");
    assert.equal(decodeKey(rec.previous!.settings), run.best);
    assert.equal(readRun(r.dir, A, MODEL)!.applied, other.key);
    r.cal.revert(A);
    rec = decodeFor(readSettings(r.settingsFile), A, MODEL).record!;
    assert.equal(decodeKey(rec.settings), run.best);
    assert.equal(rec.source, "calibrated");
    // the auto-applied record's previous was null (defaults), but it was replaced by the chosen
    // record's copy, which carries no previous: nothing further to revert to.
    assert.throws(() => r.cal.revert(A), /nothing to revert to/);
    assert.equal(readRun(r.dir, A, MODEL)!.applied, undefined);
  });

  it("a row chosen from a stopped run is saved without a calibration summary", async () => {
    let n = 0;
    const r: Rig = rig({
      transcribe: async (wav, req) => {
        if (++n === 30) r.cal.stop(A);
        return engine(req.fields ?? {}, clipN(wav));
      },
    });
    record(r, A, [1, 2, 3, 4]);
    const run = r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.equal(run.phase, "stopped");
    r.cal.apply(A, "p=sentence b=5 t=0.2 v=0");
    const rec = decodeFor(readSettings(r.settingsFile), A, MODEL).record!;
    assert.equal(decodeKey(rec.settings), "p=sentence b=5 t=0.2 v=0");
    assert.equal(rec.source, "chosen");
    assert.equal(rec.calibration, undefined);
  });

  it("Revert right after an auto-apply goes back to the defaults", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    r.cal.start({ id: A });
    await r.cal.whenDone();
    r.cal.revert(A);
    const got = decodeFor(readSettings(r.settingsFile), A, MODEL);
    assert.equal(got.record, undefined);
    assert.deepEqual(got.settings, DEFAULT_DECODE);
  });

  it("an unknown row, or no run, is a 404", async () => {
    const r = rig();
    assert.throws(() => r.cal.apply(A, "p=list b=1 t=0.2 v=0"), (e: unknown) => e instanceof CalibrationError && e.status === 404);
    record(r, A, [1, 2, 3, 4]);
    r.cal.start({ id: A });
    await r.cal.whenDone();
    assert.throws(() => r.cal.apply(A, "p=shout"), (e: unknown) => e instanceof CalibrationError && e.status === 404);
  });
});

describe("clips and starting", () => {
  it("clips belong to one device: B sees none of A's, and Forget removes A's clips, runs and settings", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    assert.deepEqual(listClips(r.dir, A).map((c) => c.n), [1, 2, 3, 4]);
    assert.equal(listClips(r.dir, A)[2]!.sec, 0.3);
    assert.deepEqual(listClips(r.dir, B), []);
    r.cal.start({ id: A });
    await r.cal.whenDone();
    r.cal.forget(A);
    assert.deepEqual(listClips(r.dir, A), []);
    assert.equal(readRun(r.dir, A, MODEL), null);
    assert.equal(readSettings(r.settingsFile).devices[A], undefined);
  });

  it("Delete Clips keeps the device's saved settings", async () => {
    const r = rig();
    record(r, A, [1, 2, 3, 4]);
    r.cal.start({ id: A });
    await r.cal.whenDone();
    r.cal.deleteAll(A);
    assert.equal(existsSync(join(r.dir, A)), false);
    assert.ok(decodeFor(readSettings(r.settingsFile), A, MODEL).record);
  });

  it("a clip must be a 16 kHz WAV for a real sentence from a valid device", () => {
    const r = rig();
    const status = (fn: () => void) => {
      try {
        fn();
        return 0;
      } catch (e) {
        return e instanceof CalibrationError ? e.status : -1;
      }
    };
    assert.equal(status(() => r.cal.putClip(A, 8, clip(1))), 404);
    assert.equal(status(() => r.cal.putClip("../../etc", 1, clip(1))), 400);
    assert.equal(status(() => r.cal.putClip(A, 1, new TextEncoder().encode("not a wav".padEnd(64)))), 400);
    assert.equal(status(() => r.cal.putClip(A, 1, new Uint8Array(3 * 1024 * 1024 + 1))), 413);
    assert.equal(status(() => r.cal.putClip(A, 1, clip(1))), 0);
  });

  it("start needs enough clips, a valid device and a free host; one sweep at a time", async () => {
    const r = rig();
    const status = (fn: () => void) => {
      try {
        fn();
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };
    record(r, A, [1, 2, 3]);
    assert.equal(status(() => r.cal.start({ id: A })), "Calibration needs at least 4 clips; this device has 3.");
    assert.equal(status(() => r.cal.start({ id: "nope" })), "A voice device id is required.");
    record(r, A, [4]);
    record(r, B, [1, 2, 3, 4]);
    r.set({ busy: "A model switch is running." });
    assert.equal(status(() => r.cal.start({ id: A })), "A model switch is running.");
    r.set({ busy: null });
    r.cal.start({ id: A });
    assert.equal(status(() => r.cal.start({ id: A })), "Calibration is already running.");
    assert.equal(status(() => r.cal.start({ id: B })), "Another device is calibrating. Wait for it to finish.");
    assert.equal(status(() => r.cal.putClip(A, 5, clip(5))), "Calibration is running on these clips. Stop it first.");
    assert.equal(status(() => r.cal.putClip(B, 5, clip(5))), "ok", "another device can record meanwhile");
    await r.cal.whenDone();
  });
});
