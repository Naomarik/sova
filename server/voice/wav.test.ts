import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SELFTEST_WAV } from "./install";
import { cleanTranscript, hintWord, inspectWav } from "./wav";

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
