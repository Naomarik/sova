import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { VoiceStatus } from "../../../shared/protocol";
import { MIC_START_LIMIT_MS, MicStartTimeout, startCapture, type Recorder } from "./capture";
import { backgroundSentence, clock, etaSentence, jobPercent, languagesWord, micErrorSentence, modelName, percentWer, perClip, readyLine, recordingText, roughTime, settingsWords, stepFigure, unsupportedReason, wordDiff } from "./format";
import { spacedInsert, splice, targetRange, wordCount } from "./insert";
import { keyboardUp, nextTallest } from "./keyboard";
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
});

describe("keyboard", () => {
  it("keeps the tallest height at one width and starts over at a new one", () => {
    let t = nextTallest(null, 412, 823);
    t = nextTallest(t, 412, 473);
    assert.deepEqual(t, { width: 412, height: 823 });
    assert.deepEqual(nextTallest(t, 915, 360), { width: 915, height: 360 });
  });
  it("is up when the viewport is well under its tallest, not for a URL bar", () => {
    const t = { width: 412, height: 823 };
    assert.equal(keyboardUp(t, 473), true, "Fold, keyboard up");
    assert.equal(keyboardUp(t, 823), false);
    assert.equal(keyboardUp(t, 767), false, "URL bar shown");
    assert.equal(keyboardUp({ width: 915, height: 360 }, 150), true, "landscape");
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

describe("the mic's time limit (§chat.voice/capture)", () => {
  /** A promise settled from outside. */
  const held = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const never = <T,>() => new Promise<T>(() => {});
  const realTimeout = setTimeout; // one test stands in for the global
  const tick = (ms = 0) => new Promise((r) => realTimeout(r, ms));
  /** What a pending start has come to, by now: "pending" until it settles. */
  const standing = (p: Promise<Recorder>) => {
    let now: "pending" | "started" | Error = "pending";
    p.then(
      () => (now = "started"),
      (e: Error) => (now = e),
    );
    return () => now;
  };
  const LIMIT = 30;

  class Status extends EventTarget {
    constructor(public state: string) {
      super();
    }
    move(state: string) {
      this.state = state;
      this.dispatchEvent(new Event("change"));
    }
  }
  const stream = () => {
    const stopped = { n: 0 };
    const track = { stop: () => void stopped.n++, addEventListener() {}, removeEventListener() {} };
    return { stopped, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
  };

  const saved = new Map<string, PropertyDescriptor | undefined>();
  const put = (name: string, value: unknown) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  afterEach(() => {
    for (const [name, d] of saved) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    saved.clear();
  });

  /** A browser of stand-ins. `order` is what happened, in order, so a test can say what came first. */
  function browser(o: {
    getUserMedia: () => Promise<MediaStream>;
    permission?: () => Promise<Status>;
    resume?: () => Promise<void>;
    addModule?: () => Promise<void>;
    worklet?: boolean;
  }) {
    const order: string[] = [];
    let closed = 0;
    const ctx = {
      state: "running",
      sampleRate: 48000,
      destination: {},
      resume: o.resume ?? (async () => {}),
      close: async () => void closed++,
      audioWorklet: o.worklet ? { addModule: o.addModule ?? (async () => {}) } : undefined,
      createMediaStreamSource: () => ({ connect() {} }),
      createGain: () => ({ gain: { value: 1 }, connect() {} }),
      createScriptProcessor: () => ({ connect() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    class Ctx {
      constructor() {
        order.push("context");
        return ctx;
      }
    }
    put("window", { AudioContext: Ctx, addEventListener() {}, removeEventListener() {} });
    put("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
    put("AudioWorkletNode", o.worklet ? class { port = { onmessage: null, postMessage() {} }; connect() {} } : undefined);
    put("navigator", {
      mediaDevices: {
        getUserMedia: () => {
          order.push("getUserMedia");
          return o.getUserMedia();
        },
      },
      permissions: o.permission && {
        query: () => {
          order.push("permission");
          return o.permission!();
        },
      },
    });
    return { order, closed: () => closed };
  }
  const events = { onLevel() {}, onInterrupt() {} };

  it("granted and getUserMedia hangs: the named error at the limit, and the context closes", async () => {
    const b = browser({ getUserMedia: never, permission: async () => new Status("granted") });
    const at = Date.now();
    await assert.rejects(startCapture(events, LIMIT), (e: Error) => e instanceof MicStartTimeout && e.name === "MicStartTimeout");
    assert.ok(Date.now() - at >= LIMIT - 5, "not before the limit");
    await tick();
    assert.equal(b.closed(), 1);
  });

  it("the limit a press gets is the one the sentence names, and only a granted mic gets it", async () => {
    const delays: number[] = [];
    const started: ReturnType<typeof setTimeout>[] = [];
    put("setTimeout", (_fn: () => void, ms: number) => {
      delays.push(ms);
      const held = realTimeout(() => {}, 60_000); // never fires in time: only the delay is read here
      started.push(held);
      return held;
    });
    try {
      assert.equal(MIC_START_LIMIT_MS, 10_000);
      browser({ getUserMedia: never, permission: async () => new Status("granted") });
      void startCapture(events);
      await tick();
      assert.deepEqual(delays, [10_000], "granted");
      delays.length = 0;
      browser({ getUserMedia: never, permission: async () => new Status("prompt") });
      void startCapture(events);
      await tick();
      assert.deepEqual(delays, [], "prompt");
    } finally {
      for (const h of started) clearTimeout(h);
    }
  });

  for (const state of ["prompt", "denied"]) {
    it(`${state} and getUserMedia hangs: no error, long past the limit`, async () => {
      browser({ getUserMedia: never, permission: async () => new Status(state) });
      const now = standing(startCapture(events, LIMIT));
      await tick(LIMIT * 4);
      assert.equal(now(), "pending");
    });
  }

  it("the permission can't be read: no limit, whether it refuses or the browser has no such API", async () => {
    browser({ getUserMedia: never, permission: () => Promise.reject(new TypeError("no such permission")) });
    const refused = standing(startCapture(events, LIMIT));
    browser({ getUserMedia: never });
    const missing = standing(startCapture(events, LIMIT));
    await tick(LIMIT * 4);
    assert.equal(refused(), "pending");
    assert.equal(missing(), "pending");
  });

  it("a denied request rejects by itself, with the browser's own error", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    browser({ getUserMedia: () => Promise.reject(denied), permission: async () => new Status("denied") });
    await assert.rejects(startCapture(events, LIMIT), (e) => e === denied);
  });

  it("answered Allow during the question: the limit starts then, however long the question took", async () => {
    const status = new Status("prompt");
    browser({ getUserMedia: never, permission: async () => status });
    const now = standing(startCapture(events, LIMIT));
    await tick(LIMIT * 3); // longer than the limit, on the question
    assert.equal(now(), "pending", "cut off during the question");
    status.move("granted");
    await tick(LIMIT / 3);
    assert.equal(now(), "pending", "the limit started at the answer, not at the press");
    await tick(LIMIT * 2);
    assert.ok(now() instanceof MicStartTimeout, "the hang after Allow still gives up");
  });

  it("a granted mic whose permission goes back to asking: the limit is dropped", async () => {
    const status = new Status("granted");
    browser({ getUserMedia: never, permission: async () => status });
    const now = standing(startCapture(events, LIMIT));
    await tick();
    status.move("prompt");
    await tick(LIMIT * 3);
    assert.equal(now(), "pending");
  });

  it("a stream that arrives after the limit has its tracks stopped; one in time doesn't", async () => {
    const late = held<MediaStream>();
    const s = stream();
    browser({ getUserMedia: () => late.promise, permission: async () => new Status("granted") });
    await assert.rejects(startCapture(events, LIMIT), MicStartTimeout);
    assert.equal(s.stopped.n, 0);
    late.resolve(s.stream);
    await tick();
    assert.equal(s.stopped.n, 1, "the Mac's mic indicator would stay on");

    const ontime = stream();
    browser({ getUserMedia: async () => ontime.stream, permission: async () => new Status("granted") });
    const r = await startCapture(events, LIMIT);
    await tick(LIMIT * 2);
    assert.equal(ontime.stopped.n, 0, "the limit must not touch a recording that started");
    r.cancel();
    assert.equal(ontime.stopped.n, 1);
  });

  it("a slow permission answer after the stream arrived starts no limit", async () => {
    const answer = held<Status>();
    const s = stream();
    browser({ getUserMedia: async () => s.stream, permission: () => answer.promise });
    const r = await startCapture(events, LIMIT);
    answer.resolve(new Status("granted"));
    await tick(LIMIT * 2);
    assert.equal(s.stopped.n, 0);
    r.cancel();
  });

  it("the context and getUserMedia don't wait on the permission: both happen inside the press", () => {
    const b = browser({ getUserMedia: never, permission: never });
    void startCapture(events, LIMIT);
    assert.deepEqual(b.order.slice(0, 2), ["context", "getUserMedia"]);
  });

  for (const hung of ["resume", "addModule"] as const) {
    it(`${hung} hangs after the stream: the error at the limit, whatever the permission, tracks stopped, context closed`, async () => {
      const s = stream();
      const b = browser({ getUserMedia: async () => s.stream, permission: async () => new Status("prompt"), worklet: true, [hung]: never });
      await assert.rejects(startCapture(events, LIMIT), MicStartTimeout);
      assert.equal(s.stopped.n, 1);
      await tick();
      assert.equal(b.closed(), 1);
    });
  }

  it("resume and addModule share one limit, which starts when the stream arrives", async () => {
    const s = stream();
    browser({
      getUserMedia: async () => s.stream,
      resume: async () => void (await tick((LIMIT * 2) / 3)),
      addModule: async () => void (await tick((LIMIT * 2) / 3)),
      worklet: true,
    });
    await assert.rejects(startCapture(events, LIMIT), MicStartTimeout);
  });

  it("the error reads as the strip's sentence", () => {
    assert.equal(micErrorSentence(new MicStartTimeout()), "The microphone didn't start within 10 seconds. Quit and reopen Sova or your browser, then try again.");
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
