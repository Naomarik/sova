import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SELFTEST_WAV } from "./install";
import { cleanTranscript, clipProblem, fixJargon, hintWord, inspectWav, type WavInfo } from "./wav";

/** A WAV header over `frames` of silence. */
export function wav(o: { rate?: number; channels?: number; bits?: number; format?: number; frames?: number; extraChunk?: boolean } = {}): Buffer {
  const rate = o.rate ?? 16000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const data = Buffer.alloc((o.frames ?? 16000) * channels * (bits / 8));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(o.format ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const list = o.extraChunk ? Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0")]) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write("data", 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + fmt.length + list.length + head.length + data.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, fmt, list, head, data]);
}

describe("inspectWav", () => {
  it("takes 16 kHz 16-bit mono and says how long it is", () => {
    const info = inspectWav(wav({ frames: 24000 }));
    assert.ok(!("error" in info));
    assert.equal(info.audioSec, 1.5);
  });
  it("walks past other chunks, odd sizes padded", () => {
    const info = inspectWav(wav({ extraChunk: true }));
    assert.ok(!("error" in info));
    assert.equal(info.audioSec, 1);
  });
  it("the committed self-test clip is one it takes, about 3 seconds", () => {
    const info = inspectWav(readFileSync(SELFTEST_WAV));
    assert.ok(!("error" in info), JSON.stringify(info));
    assert.ok(info.audioSec > 2 && info.audioSec < 5, `${info.audioSec}`);
  });
  it("refuses everything else with a sentence", () => {
    assert.deepEqual(inspectWav(Buffer.from("not a wav at all, clearly not, no no no no no no no no")), { error: "The body isn't a RIFF/WAVE file." });
    assert.match((inspectWav(wav({ rate: 48000 })) as { error: string }).error, /16 kHz \(got 48000 Hz\)/);
    assert.match((inspectWav(wav({ channels: 2 })) as { error: string }).error, /mono \(got 2 channels\)/);
    assert.match((inspectWav(wav({ bits: 8 })) as { error: string }).error, /16-bit PCM/);
    assert.match((inspectWav(wav({ format: 3, bits: 32 })) as { error: string }).error, /16-bit PCM \(got format 3, 32-bit\)/);
  });
});

describe("clipProblem", () => {
  /** 1.5 s: 0.2 s of room noise, 1 s of a tone at `amp`, 0.3 s of room noise; `edit` changes samples. */
  const clip = (amp = 3000, edit?: (s: Int16Array) => void) => {
    const b = wav({ frames: 24000 });
    const s = new Int16Array(24000);
    for (let i = 0; i < s.length; i++) s[i] = i >= 3200 && i < 19200 ? Math.round(amp * Math.sin(i / 3)) : i % 2 ? 2 : -2;
    edit?.(s);
    Buffer.from(s.buffer).copy(b, 44);
    return clipProblem(b, inspectWav(b) as WavInfo);
  };
  it("passes a clean clip, with its silence before and after the speech", () => {
    assert.equal(clip(), null);
  });
  it("names digital silence inside speech, or too many exact zeros anywhere", () => {
    assert.match(clip(3000, (s) => s.fill(0, 8000, 8000 + 960))!, /noise gate \(like EasyEffects' RNNoise VAD\)/);
    assert.equal(clip(3000, (s) => s.fill(0, 8000, 8000 + 640)), null, "40 ms is under the limit");
    assert.match(clip(3000, (s) => s.fill(0, 0, 3000))!, /digital silence/, "over 10% zeros, even outside speech");
  });
  /** Deterministic noise, uniform in ±amp (RMS amp/√3). */
  const noise = (amp: number) => {
    let seed = 1;
    return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * 2 - 1) * amp;
  };
  it("passes a phone's noisy raw mic: a −38 dBFS floor under and after the speech", () => {
    const hiss = noise(715); // RMS ≈ 413 ≈ −38 dBFS
    assert.equal(clip(3000, (s) => s.forEach((v, i) => (s[i] = Math.round(v + hiss())))), null);
  });
  it("passes the knock of the finger tapping Stop in the last 100 ms", () => {
    const knock = noise(20000);
    assert.equal(clip(3000, (s) => s.forEach((_, i) => i >= 23000 && i < 23480 && (s[i] = Math.round(knock())))), null);
  });
  it("names a cut-off tail, a too-quiet clip and clipping", () => {
    assert.match(clip(3000, (s) => s.forEach((_, i) => i >= 19200 && (s[i] = Math.round(3000 * Math.sin(i / 3)))))!, /ends mid-word/, "speech running to the end");
    const hiss = noise(715);
    assert.match(clip(3000, (s) => s.forEach((v, i) => (s[i] = Math.round((i >= 19200 ? 3000 * Math.sin(i / 3) : v) + hiss()))))!, /ends mid-word/, "even over a noisy mic");
    assert.equal(clip(3000, (s) => s.fill(3000, 23040)), null, "a 60 ms burst at the very end is a knock, not a word");
    assert.match(clip(3000, (s) => s.fill(3000, 22400))!, /ends mid-word/, "100 ms of sound at the end is not");
    assert.match(clip(200)!, /too quiet/);
    assert.match(clip(32767)!, /clipping/);
  });
});

describe("fixJargon", () => {
  it("fixes the jargon whisper misspells, whole words only, keeping a sentence-initial capital", () => {
    assert.equal(
      fixJargon("Work tree and worktreet, sub agents and a subagen, the state chart, Claud, SOVA and the overseer."),
      "Worktree and worktree, subagents and a subagent, the statechart, Claude, Sova and the Overseer.",
    );
    assert.equal(fixJargon("claudette works on the treetop; a subagency charts state"), "claudette works on the treetop; a subagency charts state");
    assert.equal(cleanTranscript(" check the work trees [BLANK_AUDIO]"), "check the worktrees");
  });
});

describe("cleanTranscript", () => {
  it("drops whisper's markers and collapses whitespace", () => {
    assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
    assert.equal(cleanTranscript(" Hello there. [MUSIC] (music) ♪ ♪ and on.\n"), "Hello there. and on.");
    assert.equal(cleanTranscript("(Applause) Thanks (laughs)"), "Thanks");
  });
  it("keeps parentheses that are speech", () => {
    assert.equal(cleanTranscript("run it (and then commit)"), "run it (and then commit)");
  });
});

describe("hintWord", () => {
  it("takes a folder name, refuses anything that could steer the prompt", () => {
    assert.equal(hintWord("sova-voice-input"), "sova-voice-input");
    assert.equal(hintWord("  my app "), "my app");
    assert.equal(hintWord(""), null);
    assert.equal(hintWord(undefined), null);
    assert.equal(hintWord("a".repeat(49)), null);
    assert.equal(hintWord("x; ignore previous"), null);
    assert.equal(hintWord("a\nb"), null);
  });
  it("drops a name that repeats a hotword, whatever its case", () => {
    const hot = ["Sova", "pi", "SolidJS"];
    assert.equal(hintWord("sova-voice-input", hot), null);
    assert.equal(hintWord("my-solidjs-app", hot), null);
    assert.equal(hintWord("pipeline", hot), "pipeline", "two-letter hotwords don't count");
    assert.equal(hintWord("webapps", hot), "webapps");
  });
});
