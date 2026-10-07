// Run: pnpm test -- server/voice/service.test.ts
// Voice through its routes, in-process: the speech server is the in-process stand-in (no child, no
// port). The same routes over a real stand-in child: service.integration.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { Hono } from "hono";
import type { VoiceStatus } from "../../shared/protocol";
import { NeedsPackages, voicePaths } from "./install";
import type { Probe } from "./platform";
import { fakeWhisper } from "./fake-whisper-test-fixtures";
import { registerVoiceRoutes, VoiceService } from "./service";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));
const CLIP = readFileSync(fileURLToPath(new URL("./selftest.wav", import.meta.url)));

const probe = (): Probe => ({
  platform: "linux",
  arch: "x64",
  exists: () => false,
  readFile: () => "ID=arch\nPRETTY_NAME=\"Arch Linux\"\n",
  list: () => [],
  which: () => null,
  glibc: () => "2.41",
  run: () => null,
  cores: () => 4,
});

function app(o: ConstructorParameters<typeof VoiceService>[0] = {}) {
  const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-svc-")));
  // The speech server is the in-process stand-in (fake-whisper-test-fixtures.ts): no child, no port.
  const service = new VoiceService({ paths: () => paths, probe, runtime: fakeWhisper().deps, ...o });
  const a = new Hono();
  registerVoiceRoutes(a, () => service);
  return { a, service, paths };
}

const envBefore = { ...process.env };
after(() => {
  for (const k of ["SOVA_VOICE_WHISPER_BIN", "FAKE_WHISPER_TEXT"]) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

describe("voice routes", () => {
  it("GET /api/voice before any setup: not installed, what a setup would do", async () => {
    const { a } = app();
    const res = await a.request("/api/voice");
    assert.equal(res.status, 200);
    const s = (await res.json()) as VoiceStatus;
    assert.equal(s.state, "not-installed");
    assert.deepEqual(s.platform, { os: "Linux", arch: "x64", distro: "Arch Linux", packageManager: "pacman" });
    assert.equal(s.gpu.backend, "cpu");
    assert.equal(s.cpuPrebuilt, true);
    assert.deepEqual(s.model, { id: "ggml-large-v3-turbo-q5_0", bytes: 574_041_195 });
    assert.equal(s.runtime.running, false);
  });

  it("transcribe and warm without an install: 409", async () => {
    const { a } = app();
    assert.equal((await a.request("/api/voice/warm", { method: "POST" })).status, 409);
    const res = await a.request("/api/voice/transcribe", { method: "POST", body: CLIP, headers: { "Content-Type": "audio/wav" } });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "Voice isn't set up on this host." });
  });

  it("install: 202 and installing; a second press is 409; needs-packages carries the command", async () => {
    // detect runs until the test lets it end, so the second press lands while the job runs.
    let detected!: () => void;
    const detect = new Promise<"done">((r) => (detected = () => r("done")));
    const { a, service } = app({ steps: { packages: async () => new NeedsPackages(["cmake"], "sudo pacman -S --needed cmake"), detect: () => detect } });
    const res = await a.request("/api/voice/install", { method: "POST", body: JSON.stringify({ backend: "gpu" }), headers: { "Content-Type": "application/json" } });
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as VoiceStatus).state, "installing");
    assert.equal((await a.request("/api/voice/install", { method: "POST" })).status, 409);
    detected();
    await service.installer.whenDone();
    const s = (await (await a.request("/api/voice?since=0")).json()) as VoiceStatus;
    assert.equal(s.state, "needs-packages");
    assert.deepEqual(s.missing, { packages: ["cmake"], command: "sudo pacman -S --needed cmake" });
    assert.ok(s.log.lines.length > 0);
    const later = (await (await a.request(`/api/voice?since=${s.log.seq}`)).json()) as VoiceStatus;
    assert.equal(later.log.lines.length, 0);
  });

  it("with a whisper binary: ready, and a clip comes back as clean text", async () => {
    process.env.SOVA_VOICE_WHISPER_BIN = FAKE;
    process.env.FAKE_WHISPER_TEXT = "[BLANK_AUDIO] Open Sova. (music)";
    const { a, service } = app();
    try {
      const s = (await (await a.request("/api/voice")).json()) as VoiceStatus;
      assert.equal(s.state, "ready");
      assert.equal((await a.request("/api/voice/warm", { method: "POST" })).status, 204);
      const res = await a.request("/api/voice/transcribe?hint=my-project", { method: "POST", body: CLIP, headers: { "Content-Type": "audio/wav" } });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { text: string; ms: number; audioSec: number };
      assert.equal(out.text, "Open Sova.");
      assert.ok(out.audioSec > 2);
      const bad = await a.request("/api/voice/transcribe", { method: "POST", body: Buffer.from("RIFF....WAVEjunkjunkjunkjunkjunkjunkjunkjunkjunk"), headers: { "Content-Type": "audio/wav" } });
      assert.equal(bad.status, 400);
      const big = await a.request("/api/voice/transcribe", { method: "POST", body: Buffer.alloc(12 * 1024 * 1024 + 1), headers: { "Content-Type": "audio/wav", "Content-Length": String(12 * 1024 * 1024 + 1) } });
      assert.equal(big.status, 413);
    } finally {
      await service.runtime.stop();
      delete process.env.SOVA_VOICE_WHISPER_BIN;
      delete process.env.FAKE_WHISPER_TEXT;
    }
  });

  it("uninstall removes the folder and reports what it freed; refused while a job runs", async () => {
    const { a, service, paths } = app({ steps: { detect: () => new Promise(() => {}) } });
    service.installer.start();
    assert.equal((await a.request("/api/voice", { method: "DELETE" })).status, 409);
    service.installer.cancel();
    await service.installer.whenDone();
    const res = await a.request("/api/voice", { method: "DELETE" });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { freed: number };
    assert.ok(out.freed >= 0);
    assert.throws(() => readFileSync(join(paths.dir, "logs", "install.log")), /ENOENT/);
    const s = (await (await a.request("/api/voice")).json()) as VoiceStatus;
    assert.equal(s.state, "not-installed");
    assert.equal(s.install, undefined);
  });
});
