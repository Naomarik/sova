// Run: node scripts/run-tests.mjs server/voice/install.integration.test.ts
// The setup job's real self-test step, on a prepared folder: it starts the stand-in binary
// (scripts/fake-whisper-server.mjs) and listens for the test sentence. The job's own rules: install.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_STEPS, readInstall, sourceBinaryName, VoiceInstaller, voicePaths, type StepFn } from "./install";
import { MODEL, WHISPER_SOURCE_DIR } from "./pins";
import type { Probe } from "./platform";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));

const probe = (bins: string[] = ["cmake", "c++", "make", "tar"]): Probe => ({
  platform: "linux",
  arch: "x64",
  exists: () => false,
  readFile: () => "ID=arch\n",
  list: () => [],
  which: (c) => (bins.includes(c) ? `/usr/bin/${c}` : null),
  glibc: () => "2.41",
  run: () => null,
  cores: () => 4,
});

function installer(steps: Partial<Record<string, StepFn>>, bins?: string[]) {
  const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-inst-")));
  const calls: string[] = [];
  const wrapped: Record<string, StepFn> = {};
  for (const id of ["detect", "packages", "source", "build", "model", "selftest", "finish"]) {
    const fn = steps[id] ?? (async () => "done" as const);
    wrapped[id] = async (ctx) => {
      calls.push(id);
      return fn(ctx);
    };
  }
  const inst = new VoiceInstaller({ paths: () => paths, probe: () => probe(bins), steps: wrapped });
  return { inst, paths, calls };
}

const states = (inst: VoiceInstaller) => inst.job!.steps.map((s) => `${s.id}:${s.state}`).join(" ");

describe("the real steps, on a prepared folder", () => {
  it("skips what exists, self-tests the binary it finds, and writes install.json", async () => {
    const { inst, paths } = installer(
      {
        detect: async (ctx) => {
          ctx.plan = { kind: "source", backend: "cpu" };
          ctx.job.backend = "cpu";
          return "done";
        },
        packages: DEFAULT_STEPS.packages,
        source: DEFAULT_STEPS.source,
        build: DEFAULT_STEPS.build,
        model: DEFAULT_STEPS.model,
        selftest: DEFAULT_STEPS.selftest,
        finish: DEFAULT_STEPS.finish,
      },
      ["cmake", "c++", "make", "tar"],
    );
    mkdirSync(join(paths.src, WHISPER_SOURCE_DIR), { recursive: true });
    writeFileSync(join(paths.src, WHISPER_SOURCE_DIR, "CMakeLists.txt"), "");
    mkdirSync(paths.bin, { recursive: true });
    symlinkSync(FAKE, join(paths.bin, sourceBinaryName("cpu")));
    mkdirSync(paths.models, { recursive: true });
    writeFileSync(paths.modelFile, "");
    truncateSync(paths.modelFile, MODEL.bytes); // sparse: the size is what a non-repair checks
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "ok", JSON.stringify(inst.job!.steps));
    assert.equal(states(inst), "detect:done packages:done source:skipped build:skipped model:skipped selftest:done finish:done");
    const rec = readInstall(paths);
    assert.ok(rec);
    assert.equal(rec.backend, "cpu");
    assert.equal(rec.binary, `bin/${sourceBinaryName("cpu")}`);
    assert.equal(rec.selftestText, "Open Sova, and run the type check in the worktree.");
    assert.equal(rec.model, MODEL.id);
    assert.match(inst.job!.steps.find((s) => s.id === "selftest")!.note ?? "", /^\d+\.\d s · CPU$/);
  });

  it("a self-test that hears the wrong words fails the job", async () => {
    const prev = process.env.FAKE_WHISPER_TEXT;
    process.env.FAKE_WHISPER_TEXT = "Thank you.";
    try {
      const { inst, paths } = installer({
        detect: async (ctx) => {
          ctx.plan = { kind: "source", backend: "cpu" };
          return "done";
        },
        selftest: DEFAULT_STEPS.selftest,
      });
      mkdirSync(paths.bin, { recursive: true });
      symlinkSync(FAKE, join(paths.bin, sourceBinaryName("cpu")));
      inst.start();
      await inst.whenDone();
      assert.equal(inst.job!.outcome, "failed");
      assert.equal(inst.job!.steps.find((s) => s.id === "selftest")!.error, "The self-test heard “Thank you.”, not the test sentence");
    } finally {
      if (prev === undefined) delete process.env.FAKE_WHISPER_TEXT;
      else process.env.FAKE_WHISPER_TEXT = prev;
    }
  });
});
