// Run: pnpm test -- server/voice/runtime.test.ts
// The whisper-server supervisor (§chat.voice/runtime), in-process: its child, port and HTTP are the
// test's (fake-whisper-test-fixtures.ts), so every outcome is driven, never waited out: a held
// inference answers when released, a crash or a hang is the child's doing. Real children, the
// stand-in script's own contract and the dictation lane's timing: runtime.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { fakeWhisper, type FakeWhisperOptions } from "./fake-whisper-test-fixtures";
import { gpuFromLog, RuntimeError, WhisperRuntime, type RuntimeConfig } from "./runtime";

const BIN = "/opt/whisper/whisper-server";
const CLIP = new Uint8Array(readFileSync(fileURLToPath(new URL("./selftest.wav", import.meta.url))));

function runtime(fake: FakeWhisperOptions = {}, o: { idleMs?: number; healthTimeoutMs?: number; configured?: boolean; config?: Partial<RuntimeConfig>; spy?: (f: typeof fetch) => typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voice-rt-"));
  const w = fakeWhisper(fake);
  const rt = new WhisperRuntime(() => (o.configured === false ? null : { binary: BIN, model: join(dir, "model.bin"), cpu: false, ...o.config }), {
    ...w.deps,
    fetchImpl: o.spy ? o.spy(w.deps.fetchImpl) : w.deps.fetchImpl,
    logFile: join(dir, "logs", "whisper-server.log"),
    runtimeFile: join(dir, "runtime.json"),
    idleMs: o.idleMs,
    healthTimeoutMs: o.healthTimeoutMs ?? 5000,
    backoffMs: [10, 20, 40],
  });
  return { rt, dir, w };
}

/** Poll with a generous hang guard: never a bound on how fast the supervisor reacts. */
async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pidOf = (dir: string) => (JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number }).pid;
const launchLine = (dir: string) => readFileSync(join(dir, "logs", "whisper-server.log"), "utf8").split("\n")[0]!;

describe("whisper-server supervisor", () => {
  it("nothing runs until asked; the first transcribe spawns it and passes the fields whisper needs", async () => {
    const { rt, dir, w } = runtime();
    assert.equal(rt.status().running, false);
    assert.equal(w.children.length, 0);
    const out = await rt.transcribe(CLIP, "Sova, pi.");
    assert.equal(out.text.trim(), "Open Sova, and run the type check in the worktree.");
    assert.ok(out.ms >= 0);
    assert.equal(rt.status().running, true);
    const [req] = w.requests;
    assert.deepEqual(req?.fields, { temperature: "0", response_format: "json", prompt: "Sova, pi." });
    assert.equal(req?.bytes, CLIP.byteLength);
    const rec = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number; binary: string };
    assert.equal(rec.binary, BIN);
    assert.equal(rec.pid, w.children[0]!.pid);
    await rt.stop();
    assert.equal(rt.status().running, false);
    assert.equal(existsSync(join(dir, "runtime.json")), false);
  });

  it("warm starts loading at once and the transcribe after it reuses the same process", async () => {
    const { rt, dir, w } = runtime({ loadingChecks: 1 });
    rt.warm();
    assert.equal(rt.status().starting, true);
    const out = await rt.transcribe(CLIP, "");
    assert.match(out.text, /Sova/);
    const pid1 = pidOf(dir);
    await rt.transcribe(CLIP, "");
    assert.equal(pidOf(dir), pid1);
    assert.equal(w.children.length, 1);
    await rt.stop();
  });

  it("no install: 409", async () => {
    const { rt } = runtime({}, { configured: false });
    await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && e.status === 409);
  });

  it("serializes requests: one in flight plus 2 waiting, the next gets 503", async () => {
    const { rt, w } = runtime({ held: true });
    const all = [0, 1, 2, 3].map(() => rt.transcribe(CLIP, "").then(() => "ok", (e: RuntimeError) => e.status));
    assert.equal(await all[3], 503, "the fourth is refused at once, while the first is held");
    for (let i = 0; i < 3; i++) {
      await until(`inference ${i + 1} at the server`, () => w.held() === 1);
      w.release();
    }
    assert.deepEqual(await Promise.all(all), ["ok", "ok", "ok", 503]);
    assert.equal(w.requests.length, 3, "one at a time, three in all");
    await rt.stop();
  });

  it("unloads after the idle time and starts again on the next request", async () => {
    const { rt, w } = runtime({}, { idleMs: 50 });
    await rt.transcribe(CLIP, "");
    assert.equal(rt.status().running, true);
    await until("the idle unload", () => !rt.status().running);
    assert.equal(w.children[0]!.alive, false, "its child was stopped");
    await rt.transcribe(CLIP, "");
    assert.equal(rt.status().running, true);
    assert.equal(w.children.length, 2, "a fresh child");
    await rt.stop();
  });

  it("a crash mid-request is a 503 for that request; three crashes in a minute stop the restarts", async () => {
    // Every child crashes on its first inference; its exit lands before its answer fails, so each
    // crash is counted when its request rejects (no wait for the exit event).
    const { rt, w } = runtime({ crash: "inference" });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && e.status === 503 && /stopped unexpectedly/.test(e.message));
    }
    assert.equal(w.children.length, 3, "restarted after each of the first two");
    assert.equal(rt.status().crashedOut, true);
    await assert.rejects(rt.transcribe(CLIP, ""), /stopped 3 times in a minute\. Repair to try again\./);
    rt.reset();
    assert.equal(rt.status().crashedOut, false);
  });

  it("a server that dies while loading is a 503 with its last words", async () => {
    const { rt } = runtime({ crash: "start" });
    await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && /exited while loading\. .*crashing at start/.test(e.message));
  });

  it("a server that never gets healthy is killed at the timeout", async () => {
    const { rt, w } = runtime({ hang: "health" }, { healthTimeoutMs: 100 });
    await assert.rejects(rt.transcribe(CLIP, ""), /didn't load the model/);
    assert.equal(rt.status().running, false);
    await until("the child's end", () => !w.children[0]!.alive);
  });
});

describe("the dictation-first lane", () => {
  it("a dictation clip arriving mid-sweep runs next, ahead of every waiting calibration clip", async () => {
    // The order itself, driven clip by clip (how long dictation waited: the integration file).
    const { rt, w } = runtime({ held: true });
    const warm = rt.transcribe(CLIP, "warm");
    await until("the warm-up clip at the server", () => w.held() === 1);
    w.release();
    await warm;
    const sweep = [1, 2, 3, 4].map((i) => rt.transcribe(CLIP, { fields: { prompt: `s${i}` }, lane: "sweep" }));
    await until("s1 in flight", () => w.held() === 1);
    assert.equal(rt.dictationWaiting(), false);
    const dictation = rt.transcribe(CLIP, { fields: { prompt: "d" } });
    assert.equal(rt.dictationWaiting(), true);
    w.release(); // s1 answers; the next to reach the server must be d
    await until("the next clip at the server", () => w.held() === 1);
    assert.equal(w.requests.at(-1)!.fields.prompt, "d");
    w.release();
    await dictation;
    assert.equal(rt.dictationWaiting(), false);
    for (let i = 0; i < 3; i++) {
      await until("the next sweep clip", () => w.held() === 1);
      w.release();
    }
    await Promise.all(sweep);
    assert.deepEqual(w.requests.map((r) => r.fields.prompt), ["warm", "s1", "d", "s2", "s3", "s4"]);
    await rt.stop();
  });

  it("calibration clips don't count toward the dictation queue cap", async () => {
    const { rt, w } = runtime({ held: true });
    const sweep = Array.from({ length: 8 }, () => rt.transcribe(CLIP, { lane: "sweep" }).then(() => "ok", (e: RuntimeError) => e.status));
    const dictation = [0, 1, 2, 3].map(() => rt.transcribe(CLIP, "").then(() => "ok", (e: RuntimeError) => e.status));
    assert.equal(await dictation[3], 503, "the fourth dictation clip is refused; the eight calibration clips took no place");
    for (let i = 0; i < 11; i++) {
      await until("the next clip at the server", () => w.held() === 1);
      w.release();
    }
    assert.deepEqual(await Promise.all(dictation), ["ok", "ok", "ok", 503]);
    assert.deepEqual(await Promise.all(sweep), Array(8).fill("ok"));
    await rt.stop();
  });

  it("a calibration clip over its limit restarts the server (not counted as a crash); the next clip gets a fresh one", async () => {
    const { rt, dir, w } = runtime({ held: true });
    const first = rt.transcribe(CLIP, { lane: "sweep", timeoutMs: 15_000 });
    await until("the first clip at the server", () => w.held() === 1);
    w.release();
    await first;
    const pid1 = pidOf(dir);
    // Never released: its own limit (short) ends it.
    await assert.rejects(rt.transcribe(CLIP, { lane: "sweep", timeoutMs: 50 }), (e: unknown) => e instanceof RuntimeError && e.status === 503 && /didn't answer in time/.test(e.message));
    assert.equal(rt.status().running, false);
    const next = rt.transcribe(CLIP, "", 15_000);
    await until("the next clip at a fresh server", () => w.held() === 1 && w.children.length === 2);
    w.release();
    assert.match((await next).text, /Sova/);
    assert.notEqual(pidOf(dir), pid1);
    assert.equal(rt.status().crashedOut, false);
    await rt.stop();
  });

  it("dictation over its limit (the 120 s abort, shortened) is a clean 503 and the server stays up for the next clip", async () => {
    const { rt, dir, w } = runtime({ held: true });
    const first = rt.transcribe(CLIP, "", 15_000);
    await until("the first clip at the server", () => w.held() === 1);
    w.release();
    await first;
    const pid1 = pidOf(dir);
    await assert.rejects(rt.transcribe(CLIP, "", 50), (e: unknown) => e instanceof RuntimeError && e.status === 503 && e.message === "whisper-server didn't answer in time.");
    assert.equal(rt.status().running, true);
    assert.equal(rt.dictationWaiting(), false, "the aborted clip left the queue");
    const next = rt.transcribe(CLIP, "", 15_000);
    await until("the next clip at the same server", () => w.held() === 1);
    w.release();
    await next;
    assert.equal(pidOf(dir), pid1);
    await rt.stop();
  });
});

describe("engines", () => {
  it("whisper launches with -vm when Silero is installed, and sends the per-request fields", async () => {
    const { rt, dir, w } = runtime({}, { config: { engine: "whisper", vadModel: "/voice/models/ggml-silero-v6.2.0.bin" } });
    await rt.transcribe(CLIP, { fields: { prompt: "Sova.", beam_size: "5", vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" } });
    assert.match(launchLine(dir), / -vm \/voice\/models\/ggml-silero-v6\.2\.0\.bin( |$)/);
    assert.deepEqual(w.requests[0]!.fields, { temperature: "0", response_format: "json", prompt: "Sova.", beam_size: "5", vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" });
    await rt.stop();
  });

  it("whisper without Silero launches without -vm", async () => {
    const { rt, dir } = runtime();
    await rt.transcribe(CLIP, "");
    assert.doesNotMatch(launchLine(dir), / -vm /);
    await rt.stop();
  });

  it("transcribe.cpp gets the bare WAV: no prompt, beam or VAD reaches it, and no -vm", async () => {
    const sent: { url: string; type: string | null; body: unknown }[] = [];
    const spy = (f: typeof fetch): typeof fetch => async (url, init) => {
      if (String(url).endsWith("/inference")) sent.push({ url: String(url), type: new Headers(init?.headers).get("content-type"), body: init?.body });
      return f(url, init);
    };
    const { rt, dir } = runtime({ engine: "transcribe" }, { config: { engine: "transcribe", vadModel: "/voice/models/ggml-silero-v6.2.0.bin" }, spy });
    assert.equal(rt.engine(), "transcribe");
    await rt.transcribe(CLIP, { fields: { prompt: "Sova.", beam_size: "5", vad: "true" } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, "audio/wav");
    assert.ok(sent[0]!.body instanceof Blob && !(sent[0]!.body instanceof FormData));
    assert.equal((sent[0]!.body as Blob).size, CLIP.byteLength);
    assert.doesNotMatch(launchLine(dir), / -vm /);
    await rt.stop();
  });
});

describe("gpuFromLog", () => {
  it("reads the Vulkan device and whether whisper used the GPU", () => {
    assert.deepEqual(
      gpuFromLog([
        "ggml_vulkan: Found 1 Vulkan devices:",
        "ggml_vulkan: 0 = AMD Radeon 8060S Graphics (RADV STRIX_HALO) (radv) | uma: 1 | fp16: dot2",
        "whisper_init_with_params_no_state: use gpu    = 1",
      ]),
      { device: "AMD Radeon 8060S Graphics", gpu: true },
    );
    assert.deepEqual(gpuFromLog(["whisper_init_with_params_no_state: use gpu    = 0"]), { gpu: false });
  });
});
