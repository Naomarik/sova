import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VoiceStatus } from "../../../shared/protocol";
import { backgroundSentence, clock, etaSentence, jobPercent, languagesWord, micErrorSentence, modelName, percentWer, perClip, readyLine, recordingText, roughTime, settingsWords, stepFigure, unsupportedReason, wordDiff } from "./format";
import { insertsByTyping, spacedInsert, splice, targetRange, wordCount } from "./insert";
import { clickWasTouch, liftedInside, touchPress } from "./press";
import { encodeWav, joinBatches, levelOf, trimTapNoise } from "./wav";

describe("insertion", () => {
  const ins = (value: string, at: number, text: string, end = at) => {
    const r = { start: at, end };
    return splice(value, r, spacedInsert(value, r, text));
  };
  it("spaces itself from words on either side", () => {
    assert.deepEqual(ins("fix thebug", 7, "the "), { value: "fix the the bug", caret: 12 });
    assert.deepEqual(ins("hello", 5, " world"), { value: "hello world", caret: 11 });
    assert.deepEqual(ins("world", 0, "hello"), { value: "hello world", caret: 6 });
    assert.deepEqual(ins("", 0, "  hello  "), { value: "hello", caret: 5 });
  });
  it("adds no space where whitespace already is", () => {
    assert.deepEqual(ins("a \nb", 2, "x"), { value: "a x\nb", caret: 3 });
    assert.deepEqual(ins("line\n", 5, "next"), { value: "line\nnext", caret: 9 });
  });
  it("replaces a selection", () => {
    assert.deepEqual(ins("say OLD now", 4, "new", 7), { value: "say new now", caret: 7 });
  });
  it("an empty transcript inserts nothing", () => {
    assert.equal(spacedInsert("abc", { start: 1, end: 1 }, "   "), "");
  });
  it("target: the live caret when focused, the saved one over unchanged text, else the end", () => {
    const saved = { start: 2, end: 2, focused: true, value: "abcd" };
    assert.deepEqual(targetRange("abcd", { start: 1, end: 3, focused: true }, saved), { start: 1, end: 3 });
    assert.deepEqual(targetRange("abcd", { start: 4, end: 4, focused: false }, saved), { start: 2, end: 2 });
    assert.deepEqual(targetRange("abcdX", { start: 5, end: 5, focused: false }, saved), { start: 5, end: 5 });
    assert.deepEqual(targetRange("abcd", { start: 0, end: 0, focused: false }, { ...saved, focused: false }), { start: 4, end: 4 });
    assert.deepEqual(targetRange("ab", { start: 9, end: 12, focused: true }, null), { start: 2, end: 2 });
  });
  it("counts words", () => {
    assert.equal(wordCount(" Open Sova,  and run it. "), 5);
    assert.equal(wordCount(""), 0);
  });
  it("types only into a focused box no touch press led to", () => {
    assert.equal(insertsByTyping(true, false), true);
    assert.equal(insertsByTyping(true, true), false);
    assert.equal(insertsByTyping(false, false), false);
    assert.equal(insertsByTyping(false, true), false);
  });
});

describe("touch press", () => {
  const box = { left: 10, top: 20, right: 54, bottom: 64 };
  /** A button stand-in: its listeners, by type, and how it was bound. */
  const fake = () => {
    const on = new Map<string, { fn: (e: unknown) => void; opts: unknown }>();
    const el = {
      addEventListener: (type: string, fn: (e: unknown) => void, opts?: unknown) => on.set(type, { fn, opts }),
      removeEventListener: (type: string) => on.delete(type),
      getBoundingClientRect: () => box,
    };
    let cancelled = 0;
    const fire = (type: string, touches: number, at?: { x: number; y: number }) =>
      on.get(type)?.fn({ preventDefault: () => cancelled++, touches: { length: touches }, changedTouches: at ? [{ clientX: at.x, clientY: at.y }] : [] });
    return { el: el as unknown as HTMLElement, on, fire, cancelled: () => cancelled };
  };
  it("lifts inside the box, edges included", () => {
    assert.equal(liftedInside(box, 10, 20), true);
    assert.equal(liftedInside(box, 54, 64), true);
    assert.equal(liftedInside(box, 9, 30), false);
    assert.equal(liftedInside(box, 30, 65), false);
  });
  it("cancels the touch, so no tap, and runs once on a lift inside", () => {
    const f = fake();
    let runs = 0;
    const off = touchPress(f.el, () => runs++);
    assert.deepEqual(f.on.get("touchstart")?.opts, { passive: false });
    assert.deepEqual(f.on.get("touchend")?.opts, { passive: false });
    f.fire("touchstart", 1);
    f.fire("touchend", 0, { x: 30, y: 40 });
    assert.equal(runs, 1);
    assert.equal(f.cancelled(), 2);
    f.fire("touchend", 0, { x: 30, y: 40 }); // no start: nothing
    assert.equal(runs, 1);
    off();
    assert.equal(f.on.size, 0);
  });
  it("ignores a slide off, a second finger and a cancelled touch", () => {
    const f = fake();
    let runs = 0;
    touchPress(f.el, () => runs++);
    f.fire("touchstart", 1);
    f.fire("touchend", 0, { x: 200, y: 40 });
    f.fire("touchstart", 1);
    f.fire("touchstart", 2);
    f.fire("touchend", 1, { x: 30, y: 40 });
    f.fire("touchend", 0, { x: 30, y: 40 });
    f.fire("touchstart", 1);
    f.fire("touchcancel", 0);
    f.fire("touchend", 0, { x: 30, y: 40 });
    assert.equal(runs, 0);
  });
  it("reads a click's pointer type", () => {
    assert.equal(clickWasTouch({ pointerType: "touch" } as unknown as MouseEvent), true);
    assert.equal(clickWasTouch({ pointerType: "mouse" } as unknown as MouseEvent), false);
    assert.equal(clickWasTouch({} as MouseEvent), false);
  });
});

describe("wav", () => {
  it("encodes 16-bit mono 16 kHz with the right header and clamps", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(wav.buffer);
    const s = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    assert.equal(s(0, 4), "RIFF");
    assert.equal(s(8, 4), "WAVE");
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint16(34, true), 16);
    assert.equal(v.getUint32(40, true), 12);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767, -32768, 16383]);
    assert.equal(wav.byteLength, 44 + 12);
  });
  it("joins batches in order", () => {
    assert.deepEqual([...joinBatches([new Float32Array([1, 2]), new Float32Array([3])])], [1, 2, 3]);
  });
  it("level: silence is near 0, speech in the middle, never past 100", () => {
    assert.equal(levelOf(0), 0);
    assert.ok(levelOf(0.001) < 10);
    const speech = levelOf(0.05);
    assert.ok(speech > 30 && speech < 70, `${speech}`);
    assert.equal(levelOf(4), 100);
  });
  describe("trimTapNoise", () => {
    const RATE = 48000;
    const STOP = RATE; // Stop pressed at 1 s, after 0.2 s of quiet and 0.8 s of speech
    /** 1.35 s at 48 kHz: quiet room (±0.003, about −55 dBFS), speech from 0.2 s to `speechEnd` s, then `edit`. */
    const clip = (speechEnd = 1, edit?: (s: Float32Array) => void) => {
      let seed = 1;
      const s = new Float32Array(Math.round(RATE * 1.35));
      for (let i = 0; i < s.length; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s[i] = (seed / 2147483648 - 0.5) * 0.006 + (i >= RATE * 0.2 && i < RATE * speechEnd ? 0.1 * Math.sin(i / 5) : 0);
      }
      edit?.(s);
      return s;
    };
    const knock = (at: number, ms = 30) => (s: Float32Array) => {
      for (let i = 0; i < (RATE * ms) / 1000; i++) s[at + i] = i % 2 ? 0.5 : -0.5;
    };
    it("cuts the clip just before a knock in the post-roll, fading the cut", () => {
      const out = trimTapNoise(clip(1, knock(STOP + RATE * 0.15)), RATE, STOP);
      assert.equal(out.length, STOP + RATE * 0.15);
      assert.equal(Math.abs(out.at(-1)!), 0);
    });
    it("keeps the whole clip when the post-roll is quiet, or holds speech longer than a knock", () => {
      const quiet = clip();
      assert.equal(trimTapNoise(quiet, RATE, STOP), quiet);
      const word = clip(1, (s) => s.forEach((_, i) => i >= STOP + RATE * 0.1 && i < STOP + RATE * 0.3 && (s[i] = 0.1 * Math.sin(i / 5))));
      assert.equal(trimTapNoise(word, RATE, STOP).length, word.length, "a word after Stop stays");
      const lastSyllable = clip(1.2);
      assert.equal(trimTapNoise(lastSyllable, RATE, STOP).length, lastSyllable.length, "speech running past Stop stays");
    });
    it("ignores a burst before the stop moment", () => {
      const early = clip(1, knock(RATE * 0.1));
      assert.equal(trimTapNoise(early, RATE, STOP).length, early.length);
    });
  });
});

describe("voice copy", () => {
  it("clock and the recording strip's countdown", () => {
    assert.equal(clock(7.9), "0:07");
    assert.equal(clock(272), "4:32");
    assert.equal(recordingText(12, 300), "Recording 0:12");
    assert.equal(recordingText(271, 300), "Recording 4:31 · 29 s left");
    assert.equal(backgroundSentence(12.4), "Recording stopped when the app went to the background. Transcribed 0:12.");
  });
  it("unsupported reasons", () => {
    assert.equal(unsupportedReason({ secure: false, getUserMedia: true, audioContext: true }), "Voice needs HTTPS or localhost.");
    assert.equal(unsupportedReason({ secure: true, getUserMedia: false, audioContext: true }), "This browser can't record audio.");
    assert.equal(unsupportedReason({ secure: true, getUserMedia: true, audioContext: true }), null);
  });
  it("mic errors", () => {
    assert.match(micErrorSentence({ name: "NotAllowedError" }), /blocked the microphone/);
    assert.equal(micErrorSentence({ name: "NotFoundError" }), "No microphone found.");
    assert.equal(micErrorSentence(new Error("boom")), "Couldn't start the microphone. boom.");
  });
  it("step figures and the job's percent", () => {
    assert.equal(stepFigure({ id: "model", state: "running", progress: { done: 212e6, total: 574_041_195, unit: "bytes" } }), "212 of 574 MB");
    assert.equal(stepFigure({ id: "build", state: "running", progress: { done: 43, total: 100, unit: "percent" } }), "43%");
    assert.equal(stepFigure({ id: "build", state: "running" }), null);
    const steps = [
      { id: "detect", state: "done" },
      { id: "packages", state: "done" },
      { id: "source", state: "skipped" },
      { id: "build", state: "running", progress: { done: 50, total: 100, unit: "percent" } },
      { id: "model", state: "pending" },
      { id: "selftest", state: "pending" },
      { id: "finish", state: "pending" },
    ] as const;
    assert.equal(jobPercent([...steps]), 50);
  });
  it("ready line", () => {
    const s = {
      installed: { backend: "vulkan", device: "AMD Radeon 8060S Graphics", whisper: "v1.9.4", model: "m", selftestMs: 412, selftestText: "", installedAt: 0 },
      runtime: { running: false, starting: false, crashedOut: false },
      diskBytes: 575e6,
    } as unknown as VoiceStatus;
    // Before the server reports a catalog: the default model, engine named (§design.copy-deck/settings-voice).
    assert.equal(readyLine(s), "Ready · Vulkan · AMD Radeon 8060S Graphics · self-test 0.4 s · whisper.cpp large-v3-turbo q5_0 · 575 MB on disk · Not loaded");
  });
  it("ready line names the active model and its engine", () => {
    const base = {
      installed: { backend: "vulkan", device: "AMD Radeon 8060S Graphics", whisper: "v1.9.4", model: "m", selftestMs: 0, selftestText: "", installedAt: 0 },
      runtime: { running: true, starting: false, crashedOut: false },
      models: [
        { id: "ggml-large-v3-turbo-q5_0", label: "large-v3-turbo", quant: "q5_0", engine: "whisper" },
        { id: "ggml-large-v3-q5_0", label: "large-v3", quant: "q5_0", engine: "whisper" },
        { id: "parakeet-tdt-0.6b-v2-q8_0", label: "Parakeet TDT 0.6B v2", quant: "q8_0", engine: "transcribe" },
      ],
    };
    assert.equal(readyLine({ ...base, activeModel: "ggml-large-v3-q5_0" } as unknown as VoiceStatus), "Ready · Vulkan · AMD Radeon 8060S Graphics · whisper.cpp large-v3 q5_0 · Loaded");
    assert.equal(readyLine({ ...base, activeModel: "parakeet-tdt-0.6b-v2-q8_0" } as unknown as VoiceStatus), "Ready · Vulkan · AMD Radeon 8060S Graphics · transcribe.cpp Parakeet TDT 0.6B v2 · q8_0 · Loaded");
  });
});

describe("model and calibration copy", () => {
  it("model names, languages and figures", () => {
    assert.equal(modelName({ label: "large-v3-turbo", quant: "q8_0" }), "large-v3-turbo · q8_0");
    assert.equal(modelName({ label: "Parakeet TDT 0.6B v2", quant: "q8_0" }), "Parakeet TDT 0.6B v2 · q8_0");
    assert.equal(languagesWord("en"), "English only");
    assert.equal(languagesWord("multi"), "English and 99 more");
    assert.equal(percentWer(0.018), "1.8%");
    assert.equal(percentWer(0), "0.0%");
    assert.equal(percentWer(0.12345), "12.3%");
    assert.equal(perClip(412), "0.41 s");
  });

  it("time left is rounded the way a person says it", () => {
    assert.equal(etaSentence(2), "About 5 s left.");
    assert.equal(etaSentence(41), "About 40 s left.");
    assert.equal(etaSentence(59), "About 60 s left.");
    assert.equal(etaSentence(200), "About 3 min left.");
    assert.equal(roughTime(72), "1 min");
    assert.equal(roughTime(25), "30 s");
    assert.equal(roughTime(3), "10 s");
  });

  it("a setting in words", () => {
    assert.equal(settingsWords({ beamSize: 5, prompt: "sentence", vad: true, vadThreshold: 0.5, vadSpeechPadMs: 150, temperatureInc: 0 }), "beam 5 · hotword sentence · voice detection on · no fallback");
    assert.equal(settingsWords({ beamSize: 1, prompt: "list", vad: false, vadThreshold: 0.5, vadSpeechPadMs: 30, temperatureInc: 0.2 }), "beam 1 · hotword list · voice detection off · fallback");
  });

  it("the per-clip diff marks missed (−) and extra (+) words, ignoring case and punctuation", () => {
    const d = wordDiff("Open a new worktree for the voice branch.", "open a new work tree for the voice branch");
    assert.deepEqual(
      d.map((w) => (w.op === "same" ? w.word : `${w.op === "missed" ? "−" : "+"}${w.word}`)).join(" "),
      "open a new −worktree +work +tree for the voice branch",
    );
    assert.deepEqual(wordDiff("Sova.", ""), [{ word: "Sova.", op: "missed" }]);
    assert.deepEqual(wordDiff("", "um"), [{ word: "um", op: "extra" }]);
    // Only "Sova" is scored by case (as the jargon count is): heard lower or upper case it's a ~ word,
    // not a word error; other jargon in another case, and non-jargon, stay "same".
    const marks = (ref: string, heard: string) => wordDiff(ref, heard).map((w) => (w.op === "same" ? w.word : `${{ missed: "−", extra: "+", case: "~" }[w.op]}${w.word}`)).join(" ");
    assert.equal(marks("Changed in Sova.", "changed in sova."), "changed in ~sova.");
    assert.equal(marks("Changed in Sova.", "Changed in SOVA."), "Changed in ~SOVA.");
    assert.equal(marks("Changed in Sova.", "Changed in Sova."), "Changed in Sova.");
    assert.equal(marks("Ask the Overseer, then the subagent.", "Ask the overseer, then the SUBAGENT."), "Ask the overseer, then the SUBAGENT.");
    assert.equal(marks("Changed in Sova.", "changed in silver."), "changed in −Sova. +silver.");
    // Read one way the diff is the reference, read the other it's what was heard: no word lost or doubled.
    const ref = "Ask the Overseer to review what the subagent changed in Sova.";
    const heard = "Ask the overseer review what a sub agent changed in Silva today";
    const out = wordDiff(ref, heard);
    const lc = (xs: string[]) => xs.map((w) => w.toLowerCase().replace(/\.$/, ""));
    assert.deepEqual(lc(out.filter((w) => w.op !== "extra").map((w) => w.word)), lc(ref.split(" ")));
    assert.deepEqual(lc(out.filter((w) => w.op !== "missed").map((w) => w.word)), lc(heard.split(" ")));
  });
});
