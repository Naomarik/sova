import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { activeModel, modelFileOf, voicePaths, type SelftestResult, type VoicePaths } from "./install";
import { VoiceModels } from "./models";
import { CATALOG, catalogModel, DEFAULT_MODEL, VAD_MODEL } from "./pins";
import type { RuntimeConfig } from "./runtime";
import { readSettings, updateSettings } from "./settings";

const PARAKEET = "parakeet-tdt-0.6b-v2-q8_0";
const Q8 = "ggml-large-v3-turbo-q8_0";

/** A model file of the pinned size, sparse: presence is judged by size, and nothing is read. */
function place(paths: VoicePaths, m: { file: string; bytes: number }) {
  mkdirSync(paths.models, { recursive: true });
  writeFileSync(modelFileOf(paths, m), "");
  truncateSync(modelFileOf(paths, m), m.bytes);
}

function setup(o: { sweep?: boolean; selfTest?: (cfg: RuntimeConfig) => Promise<SelftestResult>; compiler?: string[]; transcribeBin?: string } = {}) {
  const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-models-")));
  const calls: string[] = [];
  const tested: RuntimeConfig[] = [];
  let sweep = o.sweep ?? false;
  const models = new VoiceModels({
    paths: () => paths,
    whisper: () => ({ binary: "/opt/whisper-server", cpu: false }),
    setupRunning: () => false,
    sweepRunning: () => sweep,
    stopRuntime: async () => {
      calls.push("stop");
    },
    resetRuntime: () => {
      calls.push("reset");
    },
    needsCompiler: () => (o.compiler ? { packages: o.compiler, command: `sudo pacman -S --needed ${o.compiler.join(" ")}` } : null),
    transcribeBin: () => o.transcribeBin ?? null,
    selfTest: async (cfg) => {
      tested.push(cfg);
      calls.push(`selftest ${cfg.engine}`);
      return o.selfTest ? o.selfTest(cfg) : { ms: 300, firstMs: 900, text: "Sova worktree type check", gpu: true };
    },
  });
  return { paths, models, calls, tested, setSweep: (v: boolean) => (sweep = v) };
}

const ok = <T,>(r: { ok: true; job?: T } | { ok: false; error: string }): T => {
  if (!r.ok) assert.fail(r.error);
  return (r as { job: T }).job;
};

describe("model states", () => {
  it("every catalog entry is listed; only the default is active and recommended; only whisper is tunable", () => {
    const { models, paths } = setup();
    place(paths, DEFAULT_MODEL);
    const st = models.states();
    assert.deepEqual(st.map((m) => m.id), CATALOG.filter((m) => process.platform === "linux" && process.arch === "x64" ? true : m.engine === "whisper").map((m) => m.id));
    assert.deepEqual(st.filter((m) => m.active).map((m) => m.id), [DEFAULT_MODEL.id]);
    assert.deepEqual(st.filter((m) => m.recommended).map((m) => m.id), [DEFAULT_MODEL.id]);
    for (const m of st) assert.equal(m.tunable, m.engine === "whisper", m.id);
    assert.equal(st.find((m) => m.id === DEFAULT_MODEL.id)!.state, "ready");
    assert.equal(st.find((m) => m.id === Q8)!.state, "absent");
  });

  it("a file of the wrong size isn't ready (a truncated download)", () => {
    const { models, paths } = setup();
    mkdirSync(paths.models, { recursive: true });
    writeFileSync(modelFileOf(paths, catalogModel(Q8)!), "partial");
    assert.equal(models.states().find((m) => m.id === Q8)!.state, "absent");
  });

  it("Parakeet is ready only with its engine as well as its model", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
    const { models, paths } = setup();
    place(paths, catalogModel(PARAKEET)!);
    const row = () => models.states().find((m) => m.id === PARAKEET)!;
    assert.equal(row().state, "absent");
    assert.ok(row().engineBytes! > 0);
    mkdirSync(dirname(paths.transcribeHost), { recursive: true });
    writeFileSync(paths.transcribeHost, "");
    assert.equal(row().state, "ready");
    assert.equal(row().engineBytes, undefined);
  });

  it("no C compiler: Parakeet shows what to install, and its download is refused before fetching anything", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
    const { models, paths } = setup({ compiler: ["gcc"] });
    const row = models.states().find((m) => m.id === PARAKEET)!;
    assert.equal(row.state, "needs-packages");
    assert.deepEqual(row.missing, { packages: ["gcc"], command: "sudo pacman -S --needed gcc" });
    assert.deepEqual(models.download(PARAKEET), { ok: false, error: "Parakeet needs a C compiler to set up transcribe.cpp. Install it, then Check Again." });
    assert.equal(models.job, null);
    assert.equal(existsSync(paths.models), false);
    // whisper models don't need it
    assert.equal(models.states().find((m) => m.id === Q8)!.state, "absent");
  });

  it("a stand-in host (SOVA_VOICE_TRANSCRIBE_BIN) counts as the engine", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
    const { models, paths } = setup({ transcribeBin: "/opt/fake-transcribe", compiler: ["gcc"] });
    place(paths, catalogModel(PARAKEET)!);
    const row = models.states().find((m) => m.id === PARAKEET)!;
    assert.equal(row.state, "ready");
    assert.equal(row.engineBytes, undefined);
  });
});

describe("switching the host's model", () => {
  it("self-tests the new model on a stopped runtime, then makes it active for everyone", async () => {
    const { models, paths, calls, tested } = setup();
    place(paths, DEFAULT_MODEL);
    place(paths, catalogModel(Q8)!);
    place(paths, VAD_MODEL);
    const job = ok(models.use(Q8));
    assert.equal(job.kind, "switch");
    await models.whenDone();
    assert.equal(models.job!.outcome, "ok");
    assert.deepEqual(calls, ["stop", "selftest whisper", "reset"]);
    assert.equal(tested[0]!.model, modelFileOf(paths, catalogModel(Q8)!));
    assert.equal(tested[0]!.vadModel, paths.vadFile);
    assert.equal(activeModel(paths).id, Q8);
    assert.equal(paths.modelFile, modelFileOf(paths, catalogModel(Q8)!));
    const rec = readSettings(paths.settingsFile).models[Q8]!;
    assert.equal(rec.selftestMs, 300);
    assert.equal(rec.selftestText, "Sova worktree type check");
  });

  it("a whisper model without Silero launches without -vm", async () => {
    const { models, paths, tested } = setup();
    place(paths, catalogModel(Q8)!);
    ok(models.use(Q8));
    await models.whenDone();
    assert.equal(tested[0]!.vadModel, undefined);
  });

  it("a failed self-test keeps the old model and says so", async () => {
    const { models, paths } = setup({
      selfTest: async () => {
        throw new Error("The self-test heard “silver work tree”, not the test sentence");
      },
    });
    place(paths, DEFAULT_MODEL);
    place(paths, catalogModel(Q8)!);
    ok(models.use(Q8));
    await models.whenDone();
    assert.equal(models.job!.outcome, "failed");
    assert.equal(models.job!.error, "large-v3-turbo q8_0 didn't pass the self-test (heard “silver work tree”). Still using large-v3-turbo q5_0.");
    assert.equal(activeModel(paths).id, DEFAULT_MODEL.id);
    assert.equal(readSettings(paths.settingsFile).activeModel, undefined);
    const row = models.states().find((m) => m.id === Q8)!;
    assert.equal(row.state, "ready");
    assert.match(row.error ?? "", /didn't pass the self-test/);
  });

  it("a model that doesn't start keeps the old one too", async () => {
    const { models, paths } = setup({
      selfTest: async () => {
        throw new Error("whisper-server exited while loading. invalid model");
      },
    });
    place(paths, catalogModel(Q8)!);
    ok(models.use(Q8));
    await models.whenDone();
    assert.match(models.job!.error!, /^large-v3-turbo q8_0 didn't start: .*invalid model\. Still using large-v3-turbo q5_0\.$/);
    assert.equal(activeModel(paths).id, DEFAULT_MODEL.id);
  });

  it("is refused while a calibration sweep runs, and nothing is stopped", () => {
    const { models, paths, calls } = setup({ sweep: true });
    place(paths, catalogModel(Q8)!);
    const r = models.use(Q8);
    assert.deepEqual(r, { ok: false, error: "Calibration is running. Stop it or wait for it to finish." });
    assert.deepEqual(calls, []);
    assert.equal(activeModel(paths).id, DEFAULT_MODEL.id);
  });

  it("is refused for a model that isn't downloaded, or not in the catalog", () => {
    const { models } = setup();
    assert.deepEqual(models.use(Q8), { ok: false, error: "large-v3-turbo q8_0 isn't downloaded." });
    assert.deepEqual(models.use("ggml-tiny"), { ok: false, error: "No model called ggml-tiny." });
  });

  it("a second job waits: one switch at a time", async () => {
    const { models, paths } = setup({ selfTest: () => new Promise((r) => setTimeout(() => r({ ms: 1, firstMs: 1, text: "sova worktree", gpu: true }), 100)) });
    place(paths, catalogModel(Q8)!);
    place(paths, catalogModel("ggml-large-v3-q5_0")!);
    ok(models.use(Q8));
    assert.deepEqual(models.use("ggml-large-v3-q5_0"), { ok: false, error: "A model switch is running." });
    await models.whenDone();
    assert.equal(activeModel(paths).id, Q8);
  });

  it("to Parakeet and back: each switch launches its own engine and program", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
    const { models, paths, tested, calls } = setup();
    place(paths, DEFAULT_MODEL);
    place(paths, catalogModel(PARAKEET)!);
    place(paths, VAD_MODEL);
    mkdirSync(dirname(paths.transcribeHost), { recursive: true });
    writeFileSync(paths.transcribeHost, "");
    ok(models.use(PARAKEET));
    await models.whenDone();
    assert.equal(activeModel(paths).id, PARAKEET);
    assert.deepEqual({ engine: tested[0]!.engine, binary: tested[0]!.binary, vad: tested[0]!.vadModel }, { engine: "transcribe", binary: paths.transcribeHost, vad: undefined });
    assert.equal(models.states().find((m) => m.id === PARAKEET)!.active, true);
    ok(models.use(DEFAULT_MODEL.id));
    await models.whenDone();
    assert.equal(activeModel(paths).id, DEFAULT_MODEL.id);
    assert.deepEqual({ engine: tested[1]!.engine, binary: tested[1]!.binary, vad: tested[1]!.vadModel }, { engine: "whisper", binary: "/opt/whisper-server", vad: paths.vadFile });
    assert.deepEqual(calls, ["stop", "selftest transcribe", "reset", "stop", "selftest whisper", "reset"]);
  });

  it("a device's settings for a model survive switching away and back", async () => {
    const { models, paths } = setup();
    place(paths, DEFAULT_MODEL);
    place(paths, catalogModel(Q8)!);
    const dev = "3f1c2d4e-0000-4000-8000-00000000000a";
    updateSettings(paths.settingsFile, (s) => {
      s.devices[dev] = { label: "Linux · Chrome", app: false, lastSeenAt: 1, perModel: { [DEFAULT_MODEL.id]: { settings: { beamSize: 5, temperatureInc: 0, prompt: "sentence", vad: false, vadThreshold: 0.5, vadSpeechPadMs: 30 }, source: "calibrated", updatedAt: 1 } } };
    });
    ok(models.use(Q8));
    await models.whenDone();
    ok(models.use(DEFAULT_MODEL.id));
    await models.whenDone();
    assert.equal(readSettings(paths.settingsFile).devices[dev]!.perModel[DEFAULT_MODEL.id]!.settings.beamSize, 5);
  });
});

describe("deleting a model", () => {
  it("is refused for the active model, whichever that is, and the file stays", async () => {
    const { models, paths } = setup();
    place(paths, DEFAULT_MODEL);
    place(paths, catalogModel(Q8)!);
    assert.deepEqual(models.delete(DEFAULT_MODEL.id), { ok: false, error: "Switch to another model first." });
    assert.equal(existsSync(modelFileOf(paths, DEFAULT_MODEL)), true);
    ok(models.use(Q8));
    await models.whenDone();
    assert.deepEqual(models.delete(Q8), { ok: false, error: "Switch to another model first." });
    assert.equal(existsSync(modelFileOf(paths, catalogModel(Q8)!)), true);
    const r = models.delete(DEFAULT_MODEL.id);
    assert.deepEqual(r, { ok: true, freed: DEFAULT_MODEL.bytes });
    assert.equal(existsSync(modelFileOf(paths, DEFAULT_MODEL)), false);
  });

  it("removes the file and its .part, and forgets its self-test but keeps devices' results", () => {
    const { models, paths } = setup();
    const m = catalogModel(Q8)!;
    place(paths, m);
    writeFileSync(`${modelFileOf(paths, m)}.part`, "12345");
    const dev = "3f1c2d4e-0000-4000-8000-00000000000a";
    updateSettings(paths.settingsFile, (s) => {
      s.models[Q8] = { selftestMs: 300 };
      s.devices[dev] = { label: "l", app: false, lastSeenAt: 1, perModel: { [Q8]: { settings: { beamSize: 1, temperatureInc: 0, prompt: "list", vad: false, vadThreshold: 0.5, vadSpeechPadMs: 30 }, source: "calibrated", updatedAt: 1 } } };
    });
    assert.deepEqual(models.delete(Q8), { ok: true, freed: m.bytes + 5 });
    assert.equal(existsSync(modelFileOf(paths, m)), false);
    assert.equal(existsSync(`${modelFileOf(paths, m)}.part`), false);
    const s = readSettings(paths.settingsFile);
    assert.equal(s.models[Q8], undefined);
    assert.ok(s.devices[dev]!.perModel[Q8]);
    assert.equal(models.states().find((x) => x.id === Q8)!.state, "absent");
  });

  it("an unknown id is refused", () => {
    const { models } = setup();
    assert.deepEqual(models.delete("../install.json"), { ok: false, error: "No model called ../install.json." });
  });
});
