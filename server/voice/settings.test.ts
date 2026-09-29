import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { VoiceDecodeSettings } from "../../shared/protocol";
import { voicePaths } from "./install";
import { DEFAULT_MODEL, HOTWORDS, PROMPT_SENTENCE } from "./pins";
import { activeModelId, DEFAULT_DECODE, decodeFields, decodeFor, decodeKey, normalizeDecode, readSettings, sameDecode, updateSettings, validDeviceId, writeSettings, type VoiceSettingsFile } from "./settings";

const LAPTOP = "3f1c2d4e-0000-4000-8000-00000000000a";
const PHONE = "9b8a7c6d-0000-4000-8000-00000000000b";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "voice-settings-")), "settings.json");

const tuned = (o: Partial<VoiceDecodeSettings>): VoiceDecodeSettings => ({ ...DEFAULT_DECODE, ...o });

function withDevices(file: string): void {
  updateSettings(file, (s) => {
    s.devices[LAPTOP] = { label: "Linux · Chrome", app: false, lastSeenAt: 1, perModel: { [DEFAULT_MODEL.id]: { settings: tuned({ prompt: "sentence", beamSize: 5, temperatureInc: 0 }), source: "calibrated", updatedAt: 1 } } };
    s.devices[PHONE] = { label: "iPhone · Safari", app: true, lastSeenAt: 2, perModel: { [DEFAULT_MODEL.id]: { settings: tuned({ prompt: "none", vad: true, vadThreshold: 0.5, vadSpeechPadMs: 150 }), source: "calibrated", updatedAt: 2 } } };
  });
}

describe("settings.json", () => {
  it("no file, garbage or another version: the defaults (default model, no devices)", () => {
    const file = tmpFile();
    assert.deepEqual(readSettings(file), { version: 1, models: {}, devices: {} });
    assert.equal(activeModelId(file), DEFAULT_MODEL.id);
    writeFileSync(file, "{not json");
    assert.deepEqual(readSettings(file), { version: 1, models: {}, devices: {} });
    writeFileSync(file, JSON.stringify({ version: 2, activeModel: "ggml-large-v3-q5_0", devices: {} }));
    assert.equal(activeModelId(file), DEFAULT_MODEL.id);
  });

  it("an install from before settings.json runs the default model from the same file", () => {
    const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-old-")));
    assert.equal(existsSync(paths.settingsFile), false);
    assert.equal(paths.modelFile, join(paths.models, "ggml-large-v3-turbo-q5_0.bin"));
  });

  it("writes whole and reads back the same, leaving no temp file", () => {
    const file = tmpFile();
    withDevices(file);
    updateSettings(file, (s) => {
      s.activeModel = "ggml-large-v3-q5_0";
      s.models["ggml-large-v3-q5_0"] = { selftestMs: 410, selftestText: "Sova worktree type check" };
    });
    const back = readSettings(file);
    assert.equal(back.activeModel, "ggml-large-v3-q5_0");
    assert.equal(back.devices[PHONE]!.app, true);
    assert.deepEqual(back.devices[LAPTOP]!.perModel[DEFAULT_MODEL.id]!.settings, tuned({ prompt: "sentence", beamSize: 5, temperatureInc: 0 }));
    assert.equal(activeModelId(file), "ggml-large-v3-q5_0");
    const again = tmpFile();
    writeSettings(again, back);
    assert.deepEqual(readSettings(again), back);
    assert.deepEqual(readdirSync(join(file, "..")), ["settings.json"]);
  });

  it("each update re-reads the file: two writers' changes both survive", () => {
    const file = tmpFile();
    updateSettings(file, (s) => {
      s.activeModel = "ggml-large-v3-turbo-q8_0";
    });
    updateSettings(file, (s) => {
      s.devices[PHONE] = { label: "iPhone · Safari", app: true, lastSeenAt: 5, perModel: {} };
    });
    const s = readSettings(file);
    assert.equal(s.activeModel, "ggml-large-v3-turbo-q8_0");
    assert.ok(s.devices[PHONE]);
  });

  it("drops what it can't trust: an unknown active model or model record, a bad device id, out-of-range settings", () => {
    const file = tmpFile();
    const raw: VoiceSettingsFile & Record<string, unknown> = {
      version: 1,
      activeModel: "ggml-tiny-not-in-catalog",
      models: { "ggml-tiny-not-in-catalog": { selftestMs: 1 }, [DEFAULT_MODEL.id]: { selftestMs: 300 } },
      devices: {
        "../../etc": { label: "evil", app: false, lastSeenAt: 1, perModel: {} },
        short: { label: "too short", app: false, lastSeenAt: 1, perModel: {} },
        [LAPTOP]: {
          label: "x".repeat(200),
          app: "yes" as unknown as boolean,
          lastSeenAt: 3,
          perModel: { [DEFAULT_MODEL.id]: { settings: { beamSize: 99, temperatureInc: -1, prompt: "shout", vad: "true", vadThreshold: 2, vadSpeechPadMs: 99_999 } as unknown as VoiceDecodeSettings, source: "calibrated", updatedAt: 3 } },
        },
      },
    };
    writeFileSync(file, JSON.stringify(raw));
    const s = readSettings(file);
    assert.equal(s.activeModel, undefined);
    assert.deepEqual(Object.keys(s.models), [DEFAULT_MODEL.id]);
    assert.deepEqual(Object.keys(s.devices), [LAPTOP]);
    assert.equal(s.devices[LAPTOP]!.label.length, 80);
    assert.equal(s.devices[LAPTOP]!.app, false);
    assert.deepEqual(s.devices[LAPTOP]!.perModel[DEFAULT_MODEL.id]!.settings, DEFAULT_DECODE);
  });

  it("keeps Revert's previous settings, including null (the defaults)", () => {
    const file = tmpFile();
    updateSettings(file, (s) => {
      s.devices[LAPTOP] = {
        label: "l",
        app: false,
        lastSeenAt: 1,
        perModel: {
          [DEFAULT_MODEL.id]: { settings: tuned({ beamSize: 5 }), previous: null, source: "calibrated", updatedAt: 1 },
          "ggml-large-v3-q5_0": { settings: tuned({ prompt: "none" }), previous: { settings: tuned({ prompt: "sentence" }), source: "chosen", updatedAt: 0 }, source: "calibrated", updatedAt: 1 },
        },
      };
    });
    const pm = readSettings(file).devices[LAPTOP]!.perModel;
    assert.equal(pm[DEFAULT_MODEL.id]!.previous, null);
    assert.equal(pm["ggml-large-v3-q5_0"]!.previous!.settings.prompt, "sentence");
    assert.equal(pm["ggml-large-v3-q5_0"]!.previous!.source, "chosen");
  });
});

describe("device ids", () => {
  it("accepts a randomUUID and nothing that could leave the calibration folder", () => {
    assert.equal(validDeviceId(crypto.randomUUID()), true);
    for (const bad of ["", "abc", "../../../../tmp/x", "a/b-cdefgh", "a".repeat(65), "with space-1234", null, undefined, 12345678]) assert.equal(validDeviceId(bad), false, String(bad));
  });
});

describe("per-device resolution", () => {
  it("no device, an unknown device, or one not calibrated on this model: the defaults", () => {
    const file = tmpFile();
    withDevices(file);
    const s = readSettings(file);
    for (const [dev, model] of [
      [null, DEFAULT_MODEL.id],
      [undefined, DEFAULT_MODEL.id],
      ["00000000-0000-4000-8000-000000000000", DEFAULT_MODEL.id],
      [LAPTOP, "ggml-large-v3-q5_0"],
    ] as const) {
      const got = decodeFor(s, dev, model);
      assert.deepEqual(got.settings, DEFAULT_DECODE, `${dev} on ${model}`);
      assert.equal(got.record, undefined);
    }
  });

  it("the defaults it hands out are a copy: changing one doesn't change the next device's", () => {
    const s = readSettings(tmpFile());
    decodeFor(s, null, DEFAULT_MODEL.id).settings.beamSize = 8;
    assert.equal(decodeFor(s, null, DEFAULT_MODEL.id).settings.beamSize, 1);
    assert.equal(DEFAULT_DECODE.beamSize, 1);
  });

  it("the defaults send what voice sent before calibration: the hotword list, nothing else", () => {
    assert.deepEqual(decodeFields(DEFAULT_DECODE), { prompt: `${HOTWORDS.join(", ")}.` });
    assert.deepEqual(decodeFields(DEFAULT_DECODE, { hint: "sova-voice-calibration", vadModel: true }), { prompt: `${[...HOTWORDS, "sova-voice-calibration"].join(", ")}.` });
  });

  it("two devices on the same host and model get different fields", () => {
    const file = tmpFile();
    withDevices(file);
    const s = readSettings(file);
    const laptop = decodeFields(decodeFor(s, LAPTOP, DEFAULT_MODEL.id).settings, { vadModel: true });
    const phone = decodeFields(decodeFor(s, PHONE, DEFAULT_MODEL.id).settings, { vadModel: true });
    assert.deepEqual(laptop, { prompt: PROMPT_SENTENCE, beam_size: "5", temperature_inc: "0" });
    assert.deepEqual(phone, { vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" });
  });

  it("vad is left out when the host has no Silero model (whisper-server would answer 500)", () => {
    const f = decodeFields(tuned({ vad: true }), { vadModel: false });
    assert.equal("vad" in f || "vad_threshold" in f || "vad_speech_pad_ms" in f, false);
  });

  it("a hint rides on the sentence prompt too; prompt none sends no prompt", () => {
    assert.equal(decodeFields(tuned({ prompt: "sentence" }), { hint: "fold-ai" }).prompt, `${PROMPT_SENTENCE} The folder is fold-ai.`);
    assert.deepEqual(decodeFields(tuned({ prompt: "none" }), { hint: "fold-ai" }), {});
  });
});

describe("decodeKey", () => {
  it("tells apart every field a sweep varies, and equal settings share one key", () => {
    const variants = [
      DEFAULT_DECODE,
      tuned({ prompt: "none" }),
      tuned({ prompt: "sentence" }),
      tuned({ beamSize: 5 }),
      tuned({ temperatureInc: 0 }),
      tuned({ vad: true }),
      tuned({ vad: true, vadThreshold: 0.35 }),
      tuned({ vad: true, vadSpeechPadMs: 150 }),
    ];
    assert.equal(new Set(variants.map(decodeKey)).size, variants.length);
    assert.equal(sameDecode(tuned({ beamSize: 5 }), normalizeDecode({ ...DEFAULT_DECODE, beamSize: 5 })), true);
    // VAD thresholds don't matter while VAD is off.
    assert.equal(sameDecode(DEFAULT_DECODE, tuned({ vadThreshold: 0.35 })), true);
  });
});

describe("normalizeDecode", () => {
  it("keeps valid values and defaults each bad one on its own", () => {
    const good = tuned({ beamSize: 5, temperatureInc: 0, prompt: "none", vad: true, vadThreshold: 0.35, vadSpeechPadMs: 150 });
    assert.deepEqual(normalizeDecode(good), good);
    assert.deepEqual(normalizeDecode({ ...good, beamSize: 0 }), { ...good, beamSize: 1 });
    assert.deepEqual(normalizeDecode({ ...good, prompt: "LIST" }), { ...good, prompt: "list" });
    assert.deepEqual(normalizeDecode(null), DEFAULT_DECODE);
    assert.deepEqual(normalizeDecode("beam 5"), DEFAULT_DECODE);
  });
});
