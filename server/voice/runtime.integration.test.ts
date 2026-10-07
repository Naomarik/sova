// Run: node scripts/run-tests.mjs server/voice/runtime.integration.test.ts
// The whisper-server supervisor with real children (§chat.voice/runtime): the stand-in script
// (scripts/fake-whisper-server.mjs) on a real port, its own contract, a leftover child killed by its
// command line, and how long dictation waits when it overtakes a sweep. Everything else, driven
// in-process: runtime.test.ts.
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
  it("a dictation clip arriving mid-sweep runs next, ahead of every waiting calibration clip, and waits only for the clip in flight", async () => {
    // The timing half (the order, driven clip by clip: runtime.test.ts). Each clip takes 500 ms at
    // the real stand-in; behind the three calibration clips it overtook, dictation would wait 2 s more.
    const DELAY = 500;
    const { rt, log } = runtime({ FAKE_WHISPER_DELAY_MS: String(DELAY) });
    await rt.transcribe(CLIP, "warm");
    const sweep = [1, 2, 3, 4].map((i) => rt.transcribe(CLIP, { fields: { prompt: `s${i}` }, lane: "sweep" }));
    const end = Date.now() + 15_000; // s1 reached the server (a hang guard, not a bound)
    while (requests(log).length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.equal(rt.dictationWaiting(), false);
    const t0 = performance.now();
    const dictation = rt.transcribe(CLIP, { fields: { prompt: "d" } });
    assert.equal(rt.dictationWaiting(), true);
    await dictation;
    const waited = performance.now() - t0;
    assert.equal(rt.dictationWaiting(), false);
    await Promise.all(sweep);
    assert.deepEqual(requests(log).map((r) => r.fields.prompt), ["warm", "s1", "d", "s2", "s3", "s4"]);
    // at most the clip in flight plus its own (≤ 2 × DELAY); never the clips it overtook (≥ 4 × DELAY)
    assert.ok(waited < DELAY * 4, `dictation waited ${Math.round(waited)} ms`);
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

