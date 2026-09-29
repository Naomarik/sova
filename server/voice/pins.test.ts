import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG, catalogModel, DEFAULT_MODEL, HOTWORDS, MODEL, PROMPT_SENTENCE, TRANSCRIBE_CPP, VAD_MODEL } from "./pins";

// Sizes and sha256 heads/tails as the plan read them from the Hugging Face tree API on 2026-09-29
// (and backend re-read the same day; the plan's large-v3-q5_0 tail "6ad1" was a typo for 8ad1). A pin edited by accident fails here, not at a user's download.
const PLAN: Record<string, { bytes: number; sha: [string, string]; engine: "whisper" | "transcribe" }> = {
  "ggml-large-v3-turbo-q5_0": { bytes: 574_041_195, sha: ["3942", "a7e2"], engine: "whisper" },
  "ggml-large-v3-turbo-q8_0": { bytes: 874_188_075, sha: ["317eb69c", "59a1"], engine: "whisper" },
  "ggml-large-v3-turbo": { bytes: 1_624_555_275, sha: ["1fc70f77", "bc69"], engine: "whisper" },
  "ggml-large-v3-q5_0": { bytes: 1_081_140_203, sha: ["d75795ec", "8ad1"], engine: "whisper" },
  "ggml-distil-large-v3.5": { bytes: 1_519_521_155, sha: ["ec249891", "cf26"], engine: "whisper" },
  "parakeet-tdt-0.6b-v2-q8_0": { bytes: 729_574_912, sha: ["f0d0e99c", "5caa"], engine: "transcribe" },
};

describe("the model catalog", () => {
  it("holds exactly the decided models (5 whisper, Parakeet on transcribe.cpp), each pinned as read", () => {
    assert.deepEqual(CATALOG.map((m) => m.id).sort(), Object.keys(PLAN).sort());
    for (const m of CATALOG) {
      const p = PLAN[m.id]!;
      assert.equal(m.bytes, p.bytes, m.id);
      assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id);
      assert.ok(m.sha256.startsWith(p.sha[0]) && m.sha256.endsWith(p.sha[1]), `${m.id} sha256 ${m.sha256}`);
      assert.equal(m.engine, p.engine, m.id);
    }
  });

  it("every entry has its own id, file and url, on https, with the engine's file type", () => {
    for (const key of ["id", "file", "url", "sha256"] as const) assert.equal(new Set(CATALOG.map((m) => m[key])).size, CATALOG.length, key);
    for (const m of CATALOG) {
      assert.match(m.url, /^https:\/\/huggingface\.co\//, m.id);
      assert.match(m.file, m.engine === "whisper" ? /^ggml-.+\.bin$/ : /\.gguf$/, m.id);
      assert.ok(m.label && m.quant, m.id);
      assert.ok(m.languages === "en" || m.languages === "multi", m.id);
    }
    // distil-large-v3.5's repo calls its file ggml-model.bin: the local name must not be that.
    assert.equal(catalogModel("ggml-distil-large-v3.5")!.file === "ggml-model.bin", false);
  });

  it("one default, turbo q5_0 (what installs today), and MODEL still names it", () => {
    const defaults = CATALOG.filter((m) => m.default);
    assert.equal(defaults.length, 1);
    assert.equal(DEFAULT_MODEL.id, "ggml-large-v3-turbo-q5_0");
    assert.equal(MODEL, DEFAULT_MODEL);
    assert.equal(MODEL.file, "ggml-large-v3-turbo-q5_0.bin");
  });

  it("names read as the draft's catalog table (§app.settings-dialog/voice-models)", () => {
    assert.deepEqual(CATALOG.map((m) => `${m.label} · ${m.quant}`).sort(), [
      "Parakeet TDT 0.6B v2 · q8_0",
      "distil-large-v3.5 · f16",
      "large-v3 · q5_0",
      "large-v3-turbo · f16",
      "large-v3-turbo · q5_0",
      "large-v3-turbo · q8_0",
    ]);
    assert.deepEqual(CATALOG.filter((m) => m.languages === "en").map((m) => m.id).sort(), ["ggml-distil-large-v3.5", "parakeet-tdt-0.6b-v2-q8_0"]);
  });

  it("is listed smallest first", () => {
    const sizes = CATALOG.map((m) => m.bytes);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  });

  it("catalogModel finds by id only", () => {
    assert.equal(catalogModel("ggml-large-v3-q5_0")?.file, "ggml-large-v3-q5_0.bin");
    assert.equal(catalogModel("ggml-large-v3-q5_0.bin"), undefined);
    assert.equal(catalogModel(""), undefined);
  });

  it("the Silero and transcribe.cpp pins are the ones the plan names", () => {
    assert.equal(VAD_MODEL.bytes, 885_098);
    assert.equal(VAD_MODEL.sha256, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987");
    assert.equal(TRANSCRIBE_CPP.bytes, 21_607_373);
    assert.equal(TRANSCRIBE_CPP.sha256, "28b22a523a25b41d59ff91147b6f79f35330663c92c22e483d15d6f4dc0cfc9a");
    assert.equal(TRANSCRIBE_CPP.headerSha256, "288457c5b1d974d164b545609d8483c90fb73c9715e734e8886e7ef0d72d18f8");
    assert.ok(TRANSCRIBE_CPP.url.includes(TRANSCRIBE_CPP.tag.slice(1)) && TRANSCRIBE_CPP.headerUrl.includes(TRANSCRIBE_CPP.tag));
  });
});

describe("the prompts", () => {
  it("the hotwords carry the calibration jargon", () => {
    for (const w of ["Sova", "worktree", "Overseer", "statechart", "subagent"]) assert.ok(HOTWORDS.includes(w), w);
  });

  it("the sentence prompt uses every hotword, spelled the same way", () => {
    for (const w of HOTWORDS) assert.match(PROMPT_SENTENCE, new RegExp(`\\b${w}\\b`), w);
  });
});
