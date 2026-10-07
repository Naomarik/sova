// Run: node scripts/run-tests.mjs server/voice/service.integration.test.ts
// Voice through its routes with a real stand-in child (scripts/fake-whisper-server.mjs on a free
// port), end to end. The routes' rules with the in-process stand-in: service.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { Hono } from "hono";
import type { VoiceStatus } from "../../shared/protocol";
import { voicePaths } from "./install";
import type { Probe } from "./platform";
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

const envBefore = { ...process.env };
after(() => {
  for (const k of ["SOVA_VOICE_WHISPER_BIN", "FAKE_WHISPER_TEXT"]) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

it("with a whisper binary: ready, and a clip comes back as clean text from a real child", async () => {
  process.env.SOVA_VOICE_WHISPER_BIN = FAKE;
  process.env.FAKE_WHISPER_TEXT = "[BLANK_AUDIO] Open Sova. (music)";
  const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-svc-")));
  const service = new VoiceService({ paths: () => paths, probe });
  const a = new Hono();
  registerVoiceRoutes(a, () => service);
  try {
    const s = (await (await a.request("/api/voice")).json()) as VoiceStatus;
    assert.equal(s.state, "ready");
    assert.equal((await a.request("/api/voice/warm", { method: "POST" })).status, 204);
    const res = await a.request("/api/voice/transcribe?hint=my-project", { method: "POST", body: CLIP, headers: { "Content-Type": "audio/wav" } });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { text: string; ms: number; audioSec: number };
    assert.equal(out.text, "Open Sova.");
    assert.ok(out.audioSec > 2);
  } finally {
    await service.runtime.stop();
  }
});
