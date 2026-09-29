import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { gpuFromLog, RuntimeError, WhisperRuntime, type RuntimeConfig } from "./runtime";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));
const CLIP = new Uint8Array(readFileSync(fileURLToPath(new URL("./selftest.wav", import.meta.url))));

function runtime(env: Record<string, string> = {}, o: { idleMs?: number; healthTimeoutMs?: number; configured?: boolean; config?: Partial<RuntimeConfig>; fetchImpl?: typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voice-rt-"));
  const log = join(dir, "requests.jsonl");
  const rt = new WhisperRuntime(() => (o.configured === false ? null : { binary: FAKE, model: join(dir, "model.bin"), cpu: false, ...o.config }), {
    fetchImpl: o.fetchImpl,
    logFile: join(dir, "logs", "whisper-server.log"),
    runtimeFile: join(dir, "runtime.json"),
    idleMs: o.idleMs,
    healthTimeoutMs: o.healthTimeoutMs ?? 5000,
    backoffMs: [10, 20, 40],
    env: { ...process.env, FAKE_WHISPER_LOG: log, ...env },
  });
  return { rt, dir, log };
}

const requests = (log: string) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { fields: Record<string, string>; bytes: number; argv?: string[]; contentType?: string })
    : [];

describe("whisper-server supervisor", () => {
  it("nothing runs until asked; the first transcribe spawns it and passes the fields whisper needs", async () => {
    const { rt, log, dir } = runtime();
    assert.equal(rt.status().running, false);
    const out = await rt.transcribe(CLIP, "Sova, pi.");
    assert.equal(out.text.trim(), "Open Sova, and run the type check in the worktree.");
    assert.ok(out.ms >= 0);
    assert.equal(rt.status().running, true);
    const [req] = requests(log);
    assert.deepEqual(req?.fields, { temperature: "0", response_format: "json", prompt: "Sova, pi." });
    assert.equal(req?.bytes, CLIP.byteLength);
    const rec = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number; binary: string };
    assert.equal(rec.binary, FAKE);
    await rt.stop();
    assert.equal(rt.status().running, false);
    assert.equal(existsSync(join(dir, "runtime.json")), false);
  });

  it("warm starts loading at once and the transcribe after it reuses the same process", async () => {
    const { rt, dir } = runtime({ FAKE_WHISPER_LOAD_MS: "300" });
    rt.warm();
    assert.equal(rt.status().starting, true);
    const out = await rt.transcribe(CLIP, "");
    assert.match(out.text, /Sova/);
    const pid1 = (JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number }).pid;
    await rt.transcribe(CLIP, "");
    const pid2 = (JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number }).pid;
    assert.equal(pid1, pid2);
    await rt.stop();
  });

  it("no install: 409", async () => {
    const { rt } = runtime({}, { configured: false });
    await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && e.status === 409);
  });

  it("serializes requests: one in flight plus 2 waiting, the next gets 503", async () => {
    const { rt } = runtime({ FAKE_WHISPER_DELAY_MS: "300" });
    const all = [0, 1, 2, 3].map(() => rt.transcribe(CLIP, "").then(() => "ok", (e: RuntimeError) => e.status));
    const results = await Promise.all(all);
    assert.deepEqual(results, ["ok", "ok", "ok", 503]);
    await rt.stop();
  });

  it("unloads after the idle time and starts again on the next request", async () => {
    const { rt } = runtime({}, { idleMs: 150 });
    await rt.transcribe(CLIP, "");
    assert.equal(rt.status().running, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rt.status().running, false);
    await rt.transcribe(CLIP, "");
    assert.equal(rt.status().running, true);
    await rt.stop();
  });

  it("a crash mid-request is a 503 for that request; three crashes in a minute stop the restarts", async () => {
    const { rt } = runtime({ FAKE_WHISPER_CRASH: "inference" });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && e.status === 503 && /stopped unexpectedly/.test(e.message));
      await new Promise((r) => setTimeout(r, 50)); // the exit event lands
    }
    assert.equal(rt.status().crashedOut, true);
    await assert.rejects(rt.transcribe(CLIP, ""), /stopped 3 times in a minute\. Repair to try again\./);
    rt.reset();
    assert.equal(rt.status().crashedOut, false);
  });

  it("a server that dies while loading is a 503 with its last words", async () => {
    const { rt } = runtime({ FAKE_WHISPER_CRASH: "start" });
    await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && /exited while loading\. .*crashing at start/.test(e.message));
  });

  it("a server that never gets healthy is killed at the timeout", async () => {
    const { rt } = runtime({ FAKE_WHISPER_HANG: "health" }, { healthTimeoutMs: 600 });
    await assert.rejects(rt.transcribe(CLIP, ""), /didn't load the model/);
    assert.equal(rt.status().running, false);
  });

  it("kills a leftover child only when its command line is our binary", async () => {
    const { rt, dir } = runtime();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise((r) => child.once("exit", r));
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ pid: child.pid, binary: FAKE }));
    // Someone else's process with that pid: untouched.
    assert.equal(rt.killOrphan(() => "/usr/bin/something-else"), false);
    assert.equal(child.exitCode, null);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ pid: child.pid, binary: FAKE }));
    assert.equal(rt.killOrphan(() => `node ${FAKE} --port 1`), true);
    await exited;
    assert.equal(existsSync(join(dir, "runtime.json")), false);
  });
});

const pidOf = (dir: string) => (JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pid: number }).pid;
const launchLine = (dir: string) => readFileSync(join(dir, "logs", "whisper-server.log"), "utf8").split("\n")[0]!;

describe("the dictation-first lane", () => {
  it("a dictation clip arriving mid-sweep runs next, ahead of every waiting calibration clip", async () => {
    const { rt, log } = runtime({ FAKE_WHISPER_DELAY_MS: "150" });
    await rt.transcribe(CLIP, "warm");
    const sweep = [1, 2, 3, 4].map((i) => rt.transcribe(CLIP, { fields: { prompt: `s${i}` }, lane: "sweep" }));
    await new Promise((r) => setTimeout(r, 50)); // s1 is in flight
    assert.equal(rt.dictationWaiting(), false);
    const t0 = performance.now();
    const dictation = rt.transcribe(CLIP, { fields: { prompt: "d" } });
    assert.equal(rt.dictationWaiting(), true);
    await dictation;
    const waited = performance.now() - t0;
    assert.equal(rt.dictationWaiting(), false);
    await Promise.all(sweep);
    assert.deepEqual(requests(log).map((r) => r.fields.prompt), ["warm", "s1", "d", "s2", "s3", "s4"]);
    // at most the clip in flight plus its own: well under the ~1 s the plan allows
    assert.ok(waited < 150 * 2 + 200, `dictation waited ${Math.round(waited)} ms`);
    await rt.stop();
  });

  it("calibration clips don't count toward the dictation queue cap", async () => {
    const { rt } = runtime({ FAKE_WHISPER_DELAY_MS: "50" });
    const sweep = Array.from({ length: 8 }, () => rt.transcribe(CLIP, { lane: "sweep" }).then(() => "ok", (e: RuntimeError) => e.status));
    const dictation = [0, 1, 2, 3].map(() => rt.transcribe(CLIP, "").then(() => "ok", (e: RuntimeError) => e.status));
    assert.deepEqual(await Promise.all(dictation), ["ok", "ok", "ok", 503]);
    assert.deepEqual(await Promise.all(sweep), Array(8).fill("ok"));
    await rt.stop();
  });

  it("a calibration clip over its limit restarts the server (not counted as a crash); the next clip gets a fresh one", async () => {
    const { rt, dir } = runtime({ FAKE_WHISPER_DELAY_MS: "600" });
    await rt.transcribe(CLIP, { lane: "sweep", timeoutMs: 2000 });
    const pid1 = pidOf(dir);
    await assert.rejects(rt.transcribe(CLIP, { lane: "sweep", timeoutMs: 200 }), (e: unknown) => e instanceof RuntimeError && e.status === 503 && /didn't answer in time/.test(e.message));
    assert.equal(rt.status().running, false);
    const out = await rt.transcribe(CLIP, "", 2000);
    assert.match(out.text, /Sova/);
    assert.notEqual(pidOf(dir), pid1);
    assert.equal(rt.status().crashedOut, false);
    await rt.stop();
  });

  it("dictation over its limit (the 120 s abort, shortened) is a clean 503 and the server stays up for the next clip", async () => {
    const { rt, dir } = runtime({ FAKE_WHISPER_DELAY_MS: "500" });
    await rt.transcribe(CLIP, "", 2000);
    const pid1 = pidOf(dir);
    await assert.rejects(rt.transcribe(CLIP, "", 150), (e: unknown) => e instanceof RuntimeError && e.status === 503 && e.message === "whisper-server didn't answer in time.");
    assert.equal(rt.status().running, true);
    assert.equal(rt.dictationWaiting(), false, "the aborted clip left the queue");
    await rt.transcribe(CLIP, "", 2000);
    assert.equal(pidOf(dir), pid1);
    await rt.stop();
  });
});

describe("engines", () => {
  it("whisper launches with -vm when Silero is installed, and sends the per-request fields", async () => {
    const { rt, dir, log } = runtime({}, { config: { engine: "whisper", vadModel: "/voice/models/ggml-silero-v6.2.0.bin" } });
    await rt.transcribe(CLIP, { fields: { prompt: "Sova.", beam_size: "5", vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" } });
    assert.match(launchLine(dir), / -vm \/voice\/models\/ggml-silero-v6\.2\.0\.bin( |$)/);
    assert.deepEqual(requests(log)[0]!.fields, { temperature: "0", response_format: "json", prompt: "Sova.", beam_size: "5", vad: "true", vad_threshold: "0.5", vad_speech_pad_ms: "150" });
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
    const spy: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/inference")) sent.push({ url: String(url), type: new Headers(init?.headers).get("content-type"), body: init?.body });
      return fetch(url, init);
    };
    const { rt, dir } = runtime({}, { config: { engine: "transcribe", vadModel: "/voice/models/ggml-silero-v6.2.0.bin" }, fetchImpl: spy });
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

describe("the stand-ins' contract (scripts/fake-whisper-server.mjs)", () => {
  it("whisper started without -vm answers vad with 500, which is a 503 to the caller", async () => {
    const { rt } = runtime();
    await assert.rejects(rt.transcribe(CLIP, { fields: { vad: "true" } }), (e: unknown) => e instanceof RuntimeError && e.status === 503 && /answered 500/.test(e.message));
    // the same server still answers a request without vad
    assert.match((await rt.transcribe(CLIP, "")).text, /Sova/);
    await rt.stop();
  });

  it("the Parakeet host stand-in gets the WAV itself as audio/wav, and answers its own text", async () => {
    const { rt, log } = runtime({ FAKE_WHISPER_ENGINE: "transcribe" }, { config: { engine: "transcribe" } });
    const out = await rt.transcribe(CLIP, { fields: { prompt: "Sova." } });
    assert.equal(out.text.trim(), "Open sofa and run the type check in the work tree.");
    const [req] = requests(log);
    assert.equal(req!.contentType, "audio/wav");
    assert.equal(req!.bytes, CLIP.byteLength);
    assert.deepEqual(req!.fields, {});
    assert.equal(req!.argv!.includes("-vm"), false);
    await rt.stop();
  });

  it("the Parakeet host stand-in refuses whisper's multipart form", async () => {
    const { rt } = runtime({ FAKE_WHISPER_ENGINE: "transcribe" }, { config: { engine: "whisper" } });
    await assert.rejects(rt.transcribe(CLIP, ""), (e: unknown) => e instanceof RuntimeError && /answered 400/.test(e.message));
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
