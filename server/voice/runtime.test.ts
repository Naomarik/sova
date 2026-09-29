import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { gpuFromLog, RuntimeError, WhisperRuntime } from "./runtime";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));
const CLIP = new Uint8Array(readFileSync(fileURLToPath(new URL("./selftest.wav", import.meta.url))));

function runtime(env: Record<string, string> = {}, o: { idleMs?: number; healthTimeoutMs?: number; configured?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voice-rt-"));
  const log = join(dir, "requests.jsonl");
  const rt = new WhisperRuntime(() => (o.configured === false ? null : { binary: FAKE, model: join(dir, "model.bin"), cpu: false }), {
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
        .map((l) => JSON.parse(l) as { fields: Record<string, string>; bytes: number })
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
